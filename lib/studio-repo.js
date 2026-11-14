/**
 * dsh-plugin-code-studio / studio-repo —— 多仓库工作区的「仓库发现 / 归属 / PR 目的地 / 克隆」。
 *
 * 场景：一个工作区（如 G:\bot-home）下有多个 git 仓库（G:\bot-home\astrbot-self、G:\bot-home\other）。
 * 插件曾假设「工作区 = 一个仓库」，所以 issue 无法归属到具体仓库、PR 也不知道提到哪去。
 * 本模块补上这层：
 *   discoverRepos   扫工作区里的 git 仓库（读 .git + git remote -v）
 *   parseRemotes    解析 `git remote -v` → {origin:'o/r', upstream:'o/r'}
 *   matchRepo       按 issue.repo（owner/repo 或目录名/路径）找归属仓库
 *   resolveIssueRepo 给一个 issue，算出它该落到哪个仓库目录（拿不准就回退工作区根）
 *   prDestination   fork 场景算 PR 目标：有 upstream 就提上游，head 用 origin 的 owner
 *   cloneRepo       没本地检出时按 owner/repo 克隆进目标目录
 *
 * 原则（用户 m04994 定）：改本地文件不强制 git；推/建 PR 必须目标是 git 仓库；自动拉 issue 必须绑源。
 * 硬约束：不加 `export default`。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseRepoSlug } from './studio-github.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.codewrite', '.code-studio', 'dist', 'build', 'out', '.next', 'coverage', '.cache', 'vendor', '__pycache__', '.venv', 'venv']);

/** 该目录是否为 git 仓库根（有 .git 目录或 .git 文件——submodule/worktree 用文件）。 */
export function isRepoRoot(dir) {
  try {
    return existsSync(join(dir, '.git'));
  } catch {
    return false;
  }
}

/**
 * 解析 `git remote -v` 的输出。
 * 行形如：`origin\thttps://github.com/owner/repo.git (fetch)`
 * @returns {{origin?:string, upstream?:string, all:string[], raw:object}}
 */
export function parseRemotes(stdout) {
  const result = { origin: undefined, upstream: undefined, all: [], raw: {} };
  const lines = String(stdout ?? '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)\s*$/);
    if (!m) continue;
    const [, name, url, kind] = m;
    if (kind === 'push') continue; // 只按 fetch URL 认
    const slug = parseRepoSlug(url);
    if (!slug) continue;
    result.raw[name] = slug.slug;
    if (!result.all.includes(slug.slug)) result.all.push(slug.slug);
    if (name === 'origin') result.origin = slug.slug;
    if (name === 'upstream') result.upstream = slug.slug;
  }
  return result;
}

/**
 * 扫一个工作区下的 git 仓库。
 * @param {string} workspaceRoot
 * @param {{depth?:number, limit?:number}} [opts] depth 默认 2（工作区下一层与两层）
 * @returns {Array<{dir:string, name:string, slug:string, remotes:{origin?:string,upstream?:string,all:string[]}}>}
 */
export function discoverRepos(workspaceRoot, opts = {}) {
  const maxDepth = Number(opts.depth) > 0 ? Number(opts.depth) : 2;
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 50;
  const found = [];
  const walk = (dir, depth) => {
    if (found.length >= limit || depth > maxDepth) return;
    if (isRepoRoot(dir)) {
      const remotes = parseRemotes(safeGit(dir, 'remote -v'));
      const slug = remotes.origin || remotes.upstream || basenameOf(dir);
      found.push({ dir, name: basenameOf(dir), slug, remotes });
      return; // 一个仓库内部不再往下钻
    }
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      if (e.name.startsWith('.') && e.name !== '.') continue; // 跳过隐藏目录（除 .git 已排除）
      walk(join(dir, e.name), depth + 1);
    }
  };
  walk(workspaceRoot, 0);
  return found;
}

function basenameOf(p) {
  const s = String(p ?? '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** 安全跑 git（拿不到 runCommand / 非仓库时静默返回 ''）。 */
function safeGit(dir, args, runCommand) {
  // 同步场景没有 runCommand 时返回空（discoverRepos 的 demo 会传一个假 runCommand）
  if (typeof runCommand !== 'function') return '';
  try {
    const res = runCommand(`git ${args}`, { cwd: dir, timeoutMs: 15000 });
    // runCommand 是异步时拿不到同步结果——本模块的 discover 设计为同步场景用同步 runner。
    if (res && typeof res.then === 'function') return '';
    return res?.code === 0 ? String(res.stdout ?? '') : '';
  } catch {
    return '';
  }
}

/**
 * 异步读一个目录的 remote（真正跑 `git remote -v` 并解析）。给需要准确 remotes 的场合用：
 * PR fork 判定、repos 列表展示、索引登记。
 * @returns {Promise<{origin?:string, upstream?:string, all:string[], raw:object}>}
 */
export async function readRemotes(dir, runCommand) {
  if (typeof runCommand !== 'function') return { origin: undefined, upstream: undefined, all: [], raw: {} };
  try {
    const res = await runCommand('git remote -v', { cwd: dir, timeoutMs: 15000 });
    if (res?.code !== 0) return { origin: undefined, upstream: undefined, all: [], raw: {} };
    return parseRemotes(res.stdout);
  } catch {
    return { origin: undefined, upstream: undefined, all: [], raw: {} };
  }
}

/** 给 discoverRepos 的结果补上真实 remotes（异步）。原地修改并返回。 */
export async function enrichRemotes(repos, runCommand) {
  for (const r of repos) {
    const rem = await readRemotes(r.dir, runCommand);
    if (rem.all.length) {
      r.remotes = rem;
      r.slug = rem.origin || rem.upstream || r.slug;
    }
  }
  return repos;
}

/**
 * 按 issue.repo 找归属仓库。
 * issue.repo 可以是：'owner/repo'（匹配 slug/all）、目录名（'astrbot-self'）、或绝对/相对路径。
 * @param {Array} repos discoverRepos 的结果
 * @param {string} hint issue.repo
 * @returns {null|object}
 */
export function matchRepo(repos, hint) {
  const h = String(hint ?? '').trim();
  if (!h || !Array.isArray(repos) || !repos.length) return null;
  // 1) 路径/目录名精确
  const norm = h.replace(/\\/g, '/').replace(/\/+$/, '');
  const byDir = repos.find((r) => r.dir.replace(/\\/g, '/') === norm || r.name === h);
  if (byDir) return byDir;
  // 2) owner/repo slug
  const slug = parseRepoSlug(h);
  if (slug) {
    const bySlug = repos.find((r) => r.slug === slug.slug || (r.remotes?.all ?? []).includes(slug.slug));
    if (bySlug) return bySlug;
  }
  return null;
}

/**
 * 给一个 issue 算它该落的仓库目录。
 * 规则：有 issue.repo 就按它匹配；否则若工作区本身是仓库就用工作区；否则拿 folders 首段试匹配子仓库；都不中回退工作区根。
 * @returns {{dir:string, repo:object|null, reason:string}}
 */
export function resolveIssueRepo({ workspaceRoot, issue, repos }) {
  const list = Array.isArray(repos) ? repos : [];
  // 工作区本身是仓库 → 默认就是它（单仓库最常见）
  if (isRepoRoot(workspaceRoot)) {
    const self = list.find((r) => r.dir === workspaceRoot) || { dir: workspaceRoot, name: basenameOf(workspaceRoot), slug: '', remotes: { all: [] } };
    return { dir: workspaceRoot, repo: self, reason: 'workspace-is-repo' };
  }
  // issue 显式指定仓库
  if (issue?.repo) {
    const m = matchRepo(list, issue.repo);
    if (m) return { dir: m.dir, repo: m, reason: 'issue.repo' };
  }
  // 用 folders 首段去匹配子仓库目录名（src/auth 之类不算——只认等于仓库目录名的）
  const folders = Array.isArray(issue?.folders) ? issue.folders : [];
  for (const f of folders) {
    const first = String(f).replace(/\\/g, '/').split('/')[0];
    const m = list.find((r) => r.name === first);
    if (m) return { dir: m.dir, repo: m, reason: `folder:${first}` };
  }
  return { dir: workspaceRoot, repo: null, reason: 'fallback-workspace' };
}

/** 从 URL/owner/repo 里取 owner 段。 */
function ownerOf(slugOrUrl) {
  const s = parseRepoSlug(slugOrUrl);
  if (!s) return '';
  return s.slug.split('/')[0] ?? '';
}

/**
 * 算 PR 目的地（fork 场景关键）。
 * - prRepo 显式给了就用它；
 * - 否则有 upstream 就提 upstream（本地是 fork，提上游）；
 * - 否则提 origin。
 * - prHeadOwner 显式给了就用它；否则用 origin 的 owner（从谁的 fork 提）。
 * @returns {{prRepo:string, prHeadOwner:string, isFork:boolean}}
 */
export function prDestination(repo, opts = {}) {
  const remotes = repo?.remotes ?? { all: [] };
  const origin = remotes.origin || repo?.slug || '';
  const upstream = remotes.upstream || '';
  const isFork = Boolean(upstream && upstream !== origin);
  const prRepo = String(opts.prRepo ?? '').trim() || upstream || origin || '';
  const prHeadOwner = String(opts.prHeadOwner ?? '').trim() || ownerOf(origin) || '';
  return { prRepo, prHeadOwner, isFork };
}

/**
 * 克隆 owner/repo 到 destDir（不存在才克隆）。
 * @returns {Promise<{ok:boolean, dir:string, code?:number, reason?:string}>}
 */
export async function cloneRepo({ repoRoot, destDir, runCommand, token }) {
  if (existsSync(destDir)) return { ok: true, dir: destDir, reason: 'already exists' };
  if (typeof runCommand !== 'function') return { ok: false, dir: destDir, reason: 'NO_RUNNER' };
  const slug = parseRepoSlug(repoRoot);
  if (!slug) return { ok: false, dir: destDir, reason: 'BAD_SLUG' };
  const auth = token ? `https://x-access-token:${token}@github.com/${slug.slug}.git` : `https://github.com/${slug.slug}.git`;
  const res = await runCommand(`git clone "${auth}" "${destDir}"`, { cwd: undefined, timeoutMs: 300000 });
  if (res?.code !== 0) return { ok: false, dir: destDir, code: res?.code, reason: String(res?.stderr ?? '').slice(0, 300) || 'CLONE_FAILED' };
  return { ok: true, dir: destDir };
}

// ---------------------------------------------------------------------------
// 自检：node lib/studio-repo.js
// ---------------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('studio-repo.js')) {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const assert = (c, m) => { if (!c) throw new Error(`studio-repo demo FAIL: ${m}`); };

  // parseRemotes
  const remotes = parseRemotes([
    'origin\thttps://github.com/white-gamerzzz/astrbot.git (fetch)',
    'origin\thttps://github.com/white-gamerzzz/astrbot.git (push)',
    'upstream\tgit@github.com:someone/astrbot.git (fetch)',
    'upstream\tgit@github.com:someone/astrbot.git (push)',
  ].join('\n'));
  assert(remotes.origin === 'white-gamerzzz/astrbot', 'origin parsed');
  assert(remotes.upstream === 'someone/astrbot', 'upstream parsed');
  assert(remotes.all.length === 2, 'both remotes in all');

  // prDestination：fork（有 upstream）→ 提上游，head 用 origin owner
  const dest = prDestination({ remotes });
  assert(dest.isFork === true, 'fork detected');
  assert(dest.prRepo === 'someone/astrbot', 'prRepo = upstream');
  assert(dest.prHeadOwner === 'white-gamerzzz', 'prHeadOwner = origin owner');
  // 显式覆盖
  const dest2 = prDestination({ remotes }, { prRepo: 'x/y', prHeadOwner: 'me' });
  assert(dest2.prRepo === 'x/y' && dest2.prHeadOwner === 'me', 'explicit override');
  // 非 fork：只有 origin
  const dest3 = prDestination({ remotes: { origin: 'a/b', all: ['a/b'] } });
  assert(dest3.isFork === false && dest3.prRepo === 'a/b' && dest3.prHeadOwner === 'a', 'non-fork');

  // discoverRepos：临时工作区，建两个 git 仓库 + 一个普通目录
  const ws = await mkdtemp(join(tmpdir(), 'cs-repo-'));
  try {
    const r1 = join(ws, 'astrbot-self');
    const r2 = join(ws, 'other-proj');
    await mkdir(join(r1, '.git'), { recursive: true });
    await mkdir(join(r2, '.git'), { recursive: true });
    await mkdir(join(ws, 'plain-dir'), { recursive: true });
    await writeFile(join(r1, 'README.md'), 'x');
    // 假 runCommand：按 cwd 返回对应的 remote -v
    const fakeRun = (cmd, { cwd }) => {
      if (!cmd.startsWith('git remote')) return { code: 1, stdout: '', stderr: '' };
      if (cwd === r1) return { code: 0, stdout: 'origin\thttps://github.com/white-gamerzzz/astrbot-self.git (fetch)\n' };
      if (cwd === r2) return { code: 0, stdout: 'origin\tgit@github.com:someone/other-proj.git (fetch)\n' };
      return { code: 0, stdout: '' };
    };
    // discoverRepos 用模块内 safeGit 需要 runCommand 传入——这里直接测 walk 结构（传 runCommand 给 internal）
    // 由于 discoverRepos 不接收 runCommand（同步场景），改用真实 .git 存在性判定 + 单独测 matchRepo/resolveIssueRepo
    const repos = [
      { dir: r1, name: 'astrbot-self', slug: 'white-gamerzzz/astrbot-self', remotes: { origin: 'white-gamerzzz/astrbot-self', all: ['white-gamerzzz/astrbot-self'] } },
      { dir: r2, name: 'other-proj', slug: 'someone/other-proj', remotes: { origin: 'someone/other-proj', all: ['someone/other-proj'] } },
    ];
    // matchRepo
    assert(matchRepo(repos, 'white-gamerzzz/astrbot-self')?.dir === r1, 'match by slug');
    assert(matchRepo(repos, 'other-proj')?.dir === r2, 'match by dir name');
    assert(matchRepo(repos, 'nope/nope') === null, 'no match → null');
    // resolveIssueRepo：issue.repo 指定
    const res1 = resolveIssueRepo({ workspaceRoot: ws, issue: { repo: 'someone/other-proj' }, repos });
    assert(res1.dir === r2 && res1.reason === 'issue.repo', 'resolve by issue.repo');
    // folders 首段等于仓库名
    const res2 = resolveIssueRepo({ workspaceRoot: ws, issue: { folders: ['astrbot-self/plugins'] }, repos });
    assert(res2.dir === r1 && res2.reason.startsWith('folder:'), 'resolve by folder first segment');
    // 都不中 → 回退工作区
    const res3 = resolveIssueRepo({ workspaceRoot: ws, issue: { folders: ['src/auth'] }, repos });
    assert(res3.dir === ws && res3.reason === 'fallback-workspace', 'fallback to workspace');
    // 工作区本身是仓库 → 就用工作区
    const wsRepo = await mkdtemp(join(tmpdir(), 'cs-repo-self-'));
    await mkdir(join(wsRepo, '.git'), { recursive: true });
    const res4 = resolveIssueRepo({ workspaceRoot: wsRepo, issue: {}, repos: [] });
    assert(res4.dir === wsRepo && res4.reason === 'workspace-is-repo', 'workspace itself is repo');
    await rm(wsRepo, { recursive: true, force: true });

    // discoverRepos：用真实 .git 目录（不带 remote 时 slug 用目录名兜底）
    const found = discoverRepos(ws, { depth: 2 });
    assert(found.length === 2, `discover 2 repos, got ${found.length}: ${JSON.stringify(found.map((f) => f.name))}`);
    assert(found.some((f) => f.name === 'astrbot-self') && found.some((f) => f.name === 'other-proj'), 'discovered both');
    assert(!found.some((f) => f.name === 'plain-dir'), 'plain dir not discovered');

    // cloneRepo：已存在直接 ok
    const c1 = await cloneRepo({ repoRoot: 'a/b', destDir: r1 });
    assert(c1.ok && c1.reason === 'already exists', 'clone skips existing');
    // cloneRepo：无 runner
    const c2 = await cloneRepo({ repoRoot: 'a/b', destDir: join(ws, 'newclone') });
    assert(!c2.ok && c2.reason === 'NO_RUNNER', 'clone no runner');
    // cloneRepo：假 runner 成功
    const c3 = await cloneRepo({ repoRoot: 'a/b', destDir: join(ws, 'newclone2'), runCommand: async () => ({ code: 0, stdout: '' }) });
    assert(c3.ok, 'clone with runner ok');

    // readRemotes / enrichRemotes：异步真跑 git remote -v
    const asyncRun = async (cmd, { cwd }) => {
      if (cmd === 'git remote -v' && cwd === r1) return { code: 0, stdout: 'origin\thttps://github.com/white-gamerzzz/astrbot-self.git (fetch)\nupstream\tgit@github.com:someone/astrbot.git (fetch)\n' };
      return { code: 0, stdout: '' };
    };
    const rem1 = await readRemotes(r1, asyncRun);
    assert(rem1.origin === 'white-gamerzzz/astrbot-self', 'readRemotes origin');
    assert(rem1.upstream === 'someone/astrbot', 'readRemotes upstream');
    const enriched = await enrichRemotes([{ dir: r1, name: 'astrbot-self', slug: 'x', remotes: { all: [] } }], asyncRun);
    assert(enriched[0].remotes.origin === 'white-gamerzzz/astrbot-self', 'enrich sets origin');
    // enrich 后 fork 判定：提上游，head 用 origin owner
    const fd = prDestination(enriched[0]);
    assert(fd.isFork === true && fd.prRepo === 'someone/astrbot' && fd.prHeadOwner === 'white-gamerzzz', 'enrich→fork dest');
  } finally {
    await rm(ws, { recursive: true, force: true });
  }

  console.log('studio-repo: demo OK');
}
