/**
 * dsh-plugin-code-studio / studio-github —— 从 GitHub Issues 拉单（Source）。
 *
 * 与 studio-watch 同构：都是「把外部来的东西变成 issue 丢进派单管线」。
 *   - studio-watch：本地收件目录 <repo>/.codewrite/inbox/*.json
 *   - studio-github：GitHub 仓库的 open issues（按工作区绑定）
 *
 * PAT 单独存 <repo>/.codewrite/github-token（纯文本一行），**不进 github.json、
 * 不进版本库**（.codewrite/ 已 gitignore）。client 的 Tab 只读 github.json 里的
 * hasToken 布尔，永远拿不到明文。
 *
 * 格式（github.json）：
 *   {
 *     "enabled": true,
 *     "repo": "owner/name",     // 也接受完整 URL
 *     "labels": "",             // 可选：只拉带这些标签的 issue（逗号分隔）
 *     "assignee": "",           // 可选：只拉指派给某人的
 *     "intervalMs": 120000
 *   }
 * 是否已存 token 由 github-token 文件是否存在决定（loadGithub 返回 hasToken）。
 *
 * 硬约束：不加 `export default`（cordis unwrapExports 取 default）。
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const STUDIO_DIR = '.codewrite';
export const GITHUB_FILE = 'github.json';
export const TOKEN_FILE = 'github-token';
export const DEFAULT_INTERVAL_MS = 120000;
export const MIN_INTERVAL_MS = 30000;
export const API_BASE = 'https://api.github.com';

function githubPath(repoRoot) { return join(repoRoot, STUDIO_DIR, GITHUB_FILE); }
function tokenPath(repoRoot) { return join(repoRoot, STUDIO_DIR, TOKEN_FILE); }

/** 从 "owner/name"、"https://github.com/owner/name" 或 "git@github.com:owner/name.git" 里取 owner/repo。 */
export function parseRepoSlug(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const s = raw
    .replace(/^git@github\.com:/i, '')
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/);
  return m ? { owner: m[1], repo: m[2], slug: `${m[1]}/${m[2]}` } : null;
}

/** 把任意输入规整成合法配置（不含 token —— token 单独存 github-token 文件）。 */
export function normalizeGithub(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  let intervalMs = Number(input.intervalMs);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) intervalMs = DEFAULT_INTERVAL_MS;
  if (intervalMs < MIN_INTERVAL_MS) intervalMs = MIN_INTERVAL_MS;
  const parsed = parseRepoSlug(input.repo);
  return {
    enabled: input.enabled === true && !!parsed,
    repo: parsed ? parsed.slug : '',
    labels: String(input.labels ?? '').trim(),
    assignee: String(input.assignee ?? '').trim(),
    intervalMs,
  };
}

/** 读 PAT（无则空串）。 */
export async function loadGithubToken(repoRoot) {
  try {
    const text = (await readFile(tokenPath(repoRoot), 'utf8')).trim();
    return text || '';
  } catch { return ''; }
}

/** 存/清 PAT（空串 = 删除）。返回写入后的值。 */
export async function saveGithubToken(repoRoot, token) {
  const file = tokenPath(repoRoot);
  const value = String(token ?? '').trim();
  if (!value) { await unlink(file).catch(() => {}); return ''; }
  await mkdir(dirname(file), { recursive: true });
  try { await writeFile(file, value, { encoding: 'utf8', mode: 0o600 }); }
  catch { await writeFile(file, value, 'utf8'); } // 某些 FS 不支持 mode，退回普通写
  return value;
}

/** 读配置；不存在/坏 → null。带 hasToken（不返回明文）。 */
export async function loadGithub(repoRoot) {
  let text;
  try { text = await readFile(githubPath(repoRoot), 'utf8'); } catch { return null; }
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  const cfg = normalizeGithub(obj);
  return { ...cfg, hasToken: !!(await loadGithubToken(repoRoot)) };
}

/**
 * 写配置（原子 tmp+rename），返回规整后的值（含 hasToken）。
 * patch.token 若给 → 写进 github-token 文件，**不写进 github.json**。
 */
export async function saveGithub(repoRoot, patch = {}) {
  const { token, ...rest } = patch && typeof patch === 'object' ? patch : {};
  if (token !== undefined) await saveGithubToken(repoRoot, token);
  const prev = await loadGithub(repoRoot);
  const base = prev ? { ...prev } : {};
  delete base.hasToken;
  const next = normalizeGithub({ ...base, ...rest });
  const file = githubPath(repoRoot);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  try { await rename(tmp, file); } catch (error) { await unlink(tmp).catch(() => {}); throw error; }
  return { ...next, hasToken: !!(await loadGithubToken(repoRoot)) };
}

/**
 * 从 issue 正文/标签里抽文件夹（懒启发式，够了）：
 *   - 显式 `folders: src/a, src/b` 或 `<!-- folders: src/a, src/b -->`
 *   - 正文里像路径的 token（含 `/`），文件取所在目录
 * @returns {string[]}
 */
export function inferFolders(text) {
  const body = String(text ?? '');
  const explicit = body.match(/(?:<!--\s*)?folders?\s*[:：]\s*([^\n>]+)/i);
  const out = new Set();
  if (explicit) {
    for (const part of explicit[1].split(/[,，、\s]+/)) {
      const f = part.replace(/[`'"[\]]/g, '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim();
      if (f) out.add(f);
    }
  }
  const tokens = body.match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\/?/g) ?? [];
  for (const tok of tokens) {
    const clean = tok.replace(/\/+$/, '');
    const segs = clean.split('/');
    const last = segs[segs.length - 1] ?? '';
    const folder = last.includes('.') ? segs.slice(0, -1).join('/') : clean;
    if (folder && folder.includes('/')) out.add(folder);
  }
  return [...out].slice(0, 12);
}

/** 只看 github.json 里的字段（不含 hasToken）——给只能读文件的客户端用。 */
export function githubPublic(config) {
  const raw = config && typeof config === 'object' ? config : {};
  return {
    enabled: raw.enabled === true,
    repo: String(raw.repo ?? ''),
    labels: String(raw.labels ?? ''),
    assignee: String(raw.assignee ?? ''),
    intervalMs: Number(raw.intervalMs) || DEFAULT_INTERVAL_MS,
  };
}

/**
 * 拉一页 open issues（默认 50 条）。注入 fetchImpl 便于单测。
 * @param {object} cfg normalizeGithub 的产物
 * @param {Function} [fetchImpl]
 * @param {{etag?:string, token?:string}} [opts]
 * @returns {Promise<{ok:true, issues:object[], etag?:string, notModified?:boolean}
 *                 | {ok:false, code:string, reason:string}>}
 */
export async function fetchOpenIssues(cfg, fetchImpl, opts = {}) {
  const parsed = parseRepoSlug(cfg?.repo);
  if (!parsed) return { ok: false, code: 'NO_REPO', reason: '没有配置仓库（owner/name）。' };
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!doFetch) return { ok: false, code: 'NO_FETCH', reason: '当前 Node 没有全局 fetch，无法拉 GitHub。' };

  const params = new URLSearchParams({ state: 'open', per_page: '50', sort: 'created', direction: 'asc' });
  if (cfg.labels) params.set('labels', cfg.labels);
  if (cfg.assignee) params.set('assignee', cfg.assignee);
  const url = `${API_BASE}/repos/${parsed.owner}/${parsed.repo}/issues?${params.toString()}`;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-plugin-code-studio' };
  const token = String(opts.token ?? cfg?.token ?? '').trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.etag) headers['If-None-Match'] = opts.etag;

  let res;
  try { res = await doFetch(url, { headers }); }
  catch (error) { return { ok: false, code: 'NETWORK', reason: String(error?.message ?? error) }; }
  if (res?.status === 304) return { ok: true, issues: [], notModified: true, etag: opts.etag };
  if (res?.status === 401 || res?.status === 403) {
    return { ok: false, code: 'AUTH', reason: `GitHub ${res.status}：token 无效或额度/权限不足。` };
  }
  if (res?.status === 404) return { ok: false, code: 'NOT_FOUND', reason: `仓库 ${parsed.slug} 不存在或无权访问。` };
  if (!res?.ok) return { ok: false, code: 'HTTP', reason: `GitHub 返回 ${res?.status ?? '?'}。` };

  let data;
  try { data = await res.json(); } catch (error) { return { ok: false, code: 'BAD_JSON', reason: String(error?.message ?? error) }; }
  if (!Array.isArray(data)) return { ok: false, code: 'BAD_SHAPE', reason: 'GitHub 返回不是数组。' };

  const issues = data
    .filter((it) => it && !it.pull_request) // PR 也会出现在 issues 接口，排除
    .map((it) => {
      const body = String(it.body ?? '');
      const labelNames = Array.isArray(it.labels) ? it.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean) : [];
      return {
        id: String(it.number),
        title: String(it.title ?? ''),
        body,
        url: String(it.html_url ?? ''),
        labels: labelNames,
        folders: inferFolders(`${body}\n${labelNames.join(' ')}`),
      };
    });
  const etag = res.headers?.get?.('etag') ?? undefined;
  return { ok: true, issues, etag };
}

/**
 * 一轮同步：拉 open issues → 台账里没见过的逐条派单。
 * 已见过的跳过；派成功调 onDispatched；被拒的下一轮再试。PAT 自行从 github-token 读。
 */
export async function syncGithub({ repoRoot, cfg, listIssues, dispatchIssueFn, onDispatched, fetchImpl, etag }) {
  const token = repoRoot ? await loadGithubToken(repoRoot) : '';
  const fetched = await fetchOpenIssues(cfg, fetchImpl, { etag, token });
  if (!fetched.ok) return { ok: false, code: fetched.code, reason: fetched.reason };
  if (fetched.notModified) return { ok: true, status: 'not-modified', results: [], etag: fetched.etag };

  const seen = new Set((await listIssues()).map((item) => String(item?.id ?? '')));
  const results = [];
  for (const issue of fetched.issues) {
    const issueId = String(issue.id);
    if (seen.has(issueId)) { results.push({ id: issueId, status: 'dup' }); continue; }
    const outcome = await dispatchIssueFn(issue).catch((error) => ({ ok: false, code: 'THROW', reason: String(error?.message ?? error) }));
    if (outcome?.ok) {
      seen.add(issueId);
      if (typeof onDispatched === 'function') { try { onDispatched(issue, outcome); } catch { /* 忽略回调异常 */ } }
      results.push({ id: issueId, status: 'dispatched', mode: outcome.mode, title: issue.title });
    } else {
      results.push({ id: issueId, status: 'pending', code: outcome?.code, reason: outcome?.reason, title: issue.title });
    }
  }
  return { ok: true, status: 'synced', results, etag: fetched.etag };
}

/* ────────────────────────────── 自检 demo ────────────────────────────── */

async function demo() {
  const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); };
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'studio-github-'));
  try {
    // parseRepoSlug
    assert(parseRepoSlug('o/n').slug === 'o/n', 'slug plain');
    assert(parseRepoSlug('https://github.com/o/n').slug === 'o/n', 'slug url');
    assert(parseRepoSlug('git@github.com:o/n.git').slug === 'o/n', 'slug ssh');
    assert(parseRepoSlug('') === null, 'slug empty');

    // normalize / persist（token 不进 json）
    const d = normalizeGithub({});
    assert(d.enabled === false && d.repo === '' && d.intervalMs === DEFAULT_INTERVAL_MS, 'defaults');
    assert(!('token' in d), 'normalize has no token field');
    assert((await loadGithub(root)) === null, 'absent null');
    const saved = await saveGithub(root, { enabled: true, repo: 'acme/app', token: 'ghp_secret' });
    assert(saved.enabled === true && saved.repo === 'acme/app', 'save normalized');
    assert(saved.hasToken === true, 'save reports hasToken');
    const rawJson = await readFile(join(root, '.codewrite', 'github.json'), 'utf8');
    assert(!rawJson.includes('ghp_secret'), 'token NOT in github.json');
    assert((await loadGithubToken(root)) === 'ghp_secret', 'token file roundtrip');
    assert((await loadGithub(root)).hasToken === true, 'loadGithub hasToken true');
    const t2 = await saveGithub(root, { token: 'ghp_new' });
    assert(t2.repo === 'acme/app' && t2.hasToken === true, 'token-only patch keeps repo');
    assert((await loadGithubToken(root)) === 'ghp_new', 'token overwritten');
    await saveGithub(root, { token: '' });
    assert((await loadGithubToken(root)) === '', 'token cleared');
    assert((await loadGithub(root)).hasToken === false, 'hasToken false after clear');
    assert(normalizeGithub({ enabled: true, repo: '' }).enabled === false, 'enabled requires repo');
    assert(normalizeGithub({ repo: 'a/b', intervalMs: 5 }).intervalMs === MIN_INTERVAL_MS, 'interval clamped');

    // githubPublic：只暴露 json 字段（不含 hasToken）
    const pub = githubPublic({ enabled: true, repo: 'a/b', labels: 'bug', assignee: '', intervalMs: 120000, hasToken: true });
    assert(pub.enabled === true && pub.repo === 'a/b' && pub.labels === 'bug', 'public passthrough');
    assert(!('hasToken' in pub), 'public drops hasToken');

    // inferFolders
    assert(inferFolders('folders: src/auth, src/api').join(',') === 'src/auth,src/api', 'explicit folders');
    const f2 = inferFolders('改 `src/auth/login.js` 和 src/api/user.ts 的校验');
    assert(f2.includes('src/auth') && f2.includes('src/api'), 'inferred folders from paths: ' + f2.join(','));

    // fetchOpenIssues（假 fetch）：成功 + 排除 PR + 抽 folders + 带 token
    let seenAuth = '';
    const fakeFetch = async (url, init) => {
      seenAuth = init.headers.Authorization ?? '';
      return {
        ok: true, status: 200,
        headers: { get: (k) => (k.toLowerCase() === 'etag' ? '"e1"' : undefined) },
        json: async () => ([
          { number: 12, title: '修登录', body: 'folders: src/auth', labels: [{ name: 'bug' }], html_url: 'u12' },
          { number: 13, title: 'PR', body: '', labels: [], pull_request: { url: 'x' } },
        ]),
      };
    };
    const got = await fetchOpenIssues({ repo: 'acme/app' }, fakeFetch, { token: 'ghp_x' });
    assert(got.ok && got.issues.length === 1 && got.issues[0].id === '12', 'fetch filters PR');
    assert(got.issues[0].folders.includes('src/auth'), 'fetch infers folders');
    assert(got.etag === '"e1"', 'etag captured');
    assert(seenAuth === 'Bearer ghp_x', 'token sent in Authorization header');

    // 304 / 401
    const f304 = async () => ({ status: 304, ok: false, headers: { get: () => undefined } });
    const r304 = await fetchOpenIssues({ repo: 'acme/app' }, f304, { etag: '"e1"' });
    assert(r304.ok && r304.notModified === true, '304 notModified');
    const f401 = async () => ({ status: 401, ok: false, headers: { get: () => undefined } });
    const r401 = await fetchOpenIssues({ repo: 'acme/app' }, f401);
    assert(!r401.ok && r401.code === 'AUTH', '401 auth');

    // syncGithub：dup 跳过、成功派单、被拒 pending；token 从 github-token 读
    await saveGithub(root, { repo: 'acme/app', enabled: true, token: 'ghp_sync' });
    let syncAuth = '';
    const dispatched = [];
    const sync = await syncGithub({
      repoRoot: root,
      cfg: { repo: 'acme/app' },
      listIssues: async () => [{ id: '12' }],
      dispatchIssueFn: async (issue) => (issue.id === '14' ? { ok: true, mode: 'create', childId: 'c1' } : { ok: false, code: 'TOO_MANY_GROUPS' }),
      onDispatched: (issue, o) => dispatched.push(issue.id),
      fetchImpl: async (url, init) => {
        syncAuth = init.headers.Authorization ?? '';
        return {
          ok: true, status: 200, headers: { get: () => undefined },
          json: async () => ([
            { number: 12, title: 'old', body: '' },
            { number: 14, title: 'new', body: 'src/export' },
            { number: 15, title: 'rejected', body: 'src/billing' },
          ]),
        };
      },
    });
    assert(sync.ok, 'sync ok');
    assert(syncAuth === 'Bearer ghp_sync', 'sync uses stored token');
    const byId = Object.fromEntries(sync.results.map((r) => [r.id, r]));
    assert(byId['12'].status === 'dup', 'dup skipped');
    assert(byId['14'].status === 'dispatched' && dispatched[0] === '14', 'dispatched');
    assert(byId['15'].status === 'pending' && byId['15'].code === 'TOO_MANY_GROUPS', 'rejected pending');

    console.log('studio-github: demo OK');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && (await import('node:path')).normalize(process.argv[1]).endsWith('studio-github.js')) {
  demo().catch((error) => { console.error(error); process.exitCode = 1; });
}
