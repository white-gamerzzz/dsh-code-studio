/**
 * dsh-plugin-code-studio / studio-watch —— 监听配置 + 收件目录扫描。
 *
 * 监听是**按工作区**的，不搞全局仓库清单：工作区（会话）绑的那个文件夹就是仓库根，
 * 配置就落在 <repo>/.codewrite/watch.json，天然按工作区隔离，不用填路径。
 *
 * 格式（watch.json）：
 *   {
 *     "enabled": true,              // 开关
 *     "repo": "",                   // 可选：仓库是 cwd 的子目录时填相对路径，一般空
 *     "inbox": ".codewrite/inbox",  // 收件目录（相对 cwd）
 *     "intervalMs": 60000           // 轮询间隔
 *   }
 *
 * 收件目录里丢一个 *.json 就是一条新 issue：
 *   { "id"?: "12", "title": "修登录", "body": "原文…", "folders": ["src/auth"] }
 * id 省略时用文件名（去 .json）。
 *
 * 本文件只做「配置读写 + 收件扫描 + 归档」，不碰 ledger、不派单、不调模型
 * （那些在 index.js / studio-dispatch.js 里，需要 ctx 服务）。
 *
 * 硬约束：不要加 `export default`（cordis 的 unwrapExports 取 exports.default）。
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

export const STUDIO_DIR = '.codewrite';
export const WATCH_FILE = 'watch.json';
export const DEFAULT_INBOX = '.codewrite/inbox';
export const DEFAULT_INTERVAL_MS = 60000;
export const MIN_INTERVAL_MS = 10000;

function watchPath(repoRoot) { return join(repoRoot, STUDIO_DIR, WATCH_FILE); }

/** 把任意输入规整成合法配置（缺字段补默认、间隔夹到下限、路径转正斜杠）。 */
export function normalizeWatch(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  let intervalMs = Number(input.intervalMs);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) intervalMs = DEFAULT_INTERVAL_MS;
  if (intervalMs < MIN_INTERVAL_MS) intervalMs = MIN_INTERVAL_MS;
  const inbox = String(input.inbox ?? '').trim() || DEFAULT_INBOX;
  const repo = String(input.repo ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return { enabled: input.enabled === true, repo, inbox: inbox.replace(/\\/g, '/'), intervalMs };
}

/** 读配置；文件不存在或坏 → null（区别于「存在但 enabled:false」）。 */
export async function loadWatch(repoRoot) {
  let text;
  try { text = await readFile(watchPath(repoRoot), 'utf8'); } catch { return null; }
  try { return normalizeWatch(JSON.parse(text)); } catch { return null; }
}

/** 写配置（原子 tmp+rename）。返回写入后的规整值。 */
export async function saveWatch(repoRoot, patch) {
  const file = watchPath(repoRoot);
  const next = normalizeWatch({ ...(await loadWatch(repoRoot)) ?? {}, ...(patch ?? {}) });
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  try { await rename(tmp, file); } catch (error) { await unlink(tmp).catch(() => {}); throw error; }
  return next;
}

/** 收件目录绝对路径（repo 覆盖了子目录时叠在 cwd 上）。 */
export function inboxDir(repoRoot, cfg) {
  const base = cfg?.repo ? join(repoRoot, cfg.repo) : repoRoot;
  return join(base, cfg?.inbox || DEFAULT_INBOX);
}

/** 列出收件目录里的 *.json（跳过归档子目录）。目录不存在 → 空。 */
export async function listInboxFiles(dir) {
  let names;
  try { names = await readdir(dir); } catch { return []; }
  return names.filter((n) => n.toLowerCase().endsWith('.json')).sort();
}

/** 读一条收件文件 → issue 记录；坏文件返回 null。id 缺省用文件名。 */
export async function readInboxIssue(dir, filename) {
  let text;
  try { text = await readFile(join(dir, filename), 'utf8'); } catch { return null; }
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const id = String(obj.id ?? filename.replace(/\.json$/i, '')).trim();
  if (!id) return null;
  const folders = Array.isArray(obj.folders) ? obj.folders.map((f) => String(f ?? '')).filter(Boolean) : [];
  return {
    id,
    ...(obj.title !== undefined ? { title: String(obj.title) } : {}),
    ...(obj.body !== undefined ? { body: String(obj.body) } : {}),
    ...(obj.repo !== undefined ? { repo: String(obj.repo) } : {}),
    folders,
  };
}

/** 把处理完的收件文件移进 <inbox>/.done/，避免重复处理。 */
export async function archiveInboxFile(dir, filename) {
  const done = join(dir, '.done');
  await mkdir(done, { recursive: true });
  try { await rename(join(dir, filename), join(done, filename)); } catch { /* 已被移走就算了 */ }
}

/**
 * 扫一遍收件目录并逐条处理（可注入 dispatch，故能脱离宿主自测）。
 *
 * 规则：
 *   - 坏 JSON → 留在原地（下次还报 bad，人工处理），不归档。
 *   - 台账里已有同 id → 归档为 dup（防跨轮重复派单）。
 *   - 派单成功 → 归档 dispatched。
 *   - 派单被拒（如 TOO_MANY_GROUPS）→ **不归档**，留到下一轮自动重试。
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {object} opts.cfg         normalizeWatch 的产物
 * @param {() => Promise<Array<{id:any}>>} opts.listIssues  读当前台账
 * @param {(issue:object) => Promise<{ok:boolean, code?:string, reason?:string, mode?:string, childId?:string}>} opts.dispatchIssueFn
 * @param {(issue:object, outcome:object) => void} [opts.onDispatched]
 * @returns {Promise<Array<object>>} 每条文件的处理结果
 */
export async function scanInbox({ repoRoot, cfg, listIssues, dispatchIssueFn, onDispatched }) {
  const dir = inboxDir(repoRoot, cfg);
  const files = await listInboxFiles(dir);
  const results = [];
  if (files.length === 0) return results;
  const seen = new Set((await listIssues()).map((item) => String(item?.id ?? '')));
  for (const filename of files) {
    const issue = await readInboxIssue(dir, filename);
    if (!issue) { results.push({ filename, status: 'bad' }); continue; }
    const issueId = String(issue.id);
    if (seen.has(issueId)) { await archiveInboxFile(dir, filename); results.push({ filename, id: issueId, status: 'dup' }); continue; }
    const outcome = await dispatchIssueFn(issue).catch((error) => ({ ok: false, code: 'THROW', reason: String(error?.message ?? error) }));
    if (outcome?.ok) {
      seen.add(issueId);
      await archiveInboxFile(dir, filename);
      if (typeof onDispatched === 'function') { try { onDispatched(issue, outcome); } catch { /* 回调失败不影响归档 */ } }
      results.push({ filename, id: issueId, status: 'dispatched', mode: outcome.mode });
    } else {
      results.push({ filename, id: issueId, status: 'pending', code: outcome?.code, reason: outcome?.reason });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 自检：node lib/studio-watch.js
// ---------------------------------------------------------------------------
async function demo() {
  const assert = (c, m) => { if (!c) throw new Error(`demo failed: ${m}`); };
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'studio-watch-'));
  try {
    // 缺省值 + 间隔夹下限
    const d = normalizeWatch({});
    assert(d.enabled === false && d.inbox === DEFAULT_INBOX && d.intervalMs === DEFAULT_INTERVAL_MS, 'defaults');
    assert(normalizeWatch({ intervalMs: 5 }).intervalMs === MIN_INTERVAL_MS, 'interval clamped');
    assert(normalizeWatch({ repo: 'sub\\dir\\' }).repo === 'sub/dir', 'repo normalized');

    // 不存在 → null；写入后可读回
    assert((await loadWatch(root)) === null, 'absent → null');
    const saved = await saveWatch(root, { enabled: true, intervalMs: 20000 });
    assert(saved.enabled === true && saved.intervalMs === 20000, 'save returns normalized');
    const back = await loadWatch(root);
    assert(back.enabled === true && back.intervalMs === 20000, 'load roundtrip');

    // 收件目录：两条 json，读一条，归档后剩一条
    const dir = inboxDir(root, back);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.json'), JSON.stringify({ title: 'A', folders: ['src/auth'] }), 'utf8');
    await writeFile(join(dir, 'b.json'), '{ not json', 'utf8');
    let files = await listInboxFiles(dir);
    assert(files.join(',') === 'a.json,b.json', 'list inbox');
    const a = await readInboxIssue(dir, 'a.json');
    assert(a.id === 'a' && a.title === 'A' && a.folders[0] === 'src/auth', 'read inbox issue, id from filename');
    assert((await readInboxIssue(dir, 'b.json')) === null, 'bad json → null');
    await archiveInboxFile(dir, 'a.json');
    files = await listInboxFiles(dir);
    assert(files.join(',') === 'b.json', 'archived file leaves inbox');

    // scanInbox：dup 归档、成功归档、被拒保留、坏文件共处
    await writeFile(join(dir, 'c.json'), JSON.stringify({ id: 'c', folders: ['src/x'] }), 'utf8');
    await writeFile(join(dir, 'd.json'), JSON.stringify({ id: 'a', folders: ['src/y'] }), 'utf8'); // 与台账重复
    const dispatched = [];
    const results = await scanInbox({
      repoRoot: root,
      cfg: { ...back, inbox: '.codewrite/inbox' },
      // 台账里已有 'a'（模拟上一轮已派过）
      listIssues: async () => [{ id: 'a' }],
      dispatchIssueFn: async (issue) => {
        if (issue.id === 'c') return { ok: true, mode: 'create', childId: 'cs-1' };
        if (issue.id === 'e') return { ok: false, code: 'TOO_MANY_GROUPS' };
        return { ok: true, mode: 'create' };
      },
      onDispatched: (issue, outcome) => dispatched.push({ id: issue.id, mode: outcome.mode }),
    });
    const byName = Object.fromEntries(results.map((r) => [r.filename, r]));
    assert(byName['b.json']?.status === 'bad', 'bad json stays bad');
    assert(byName['c.json']?.status === 'dispatched' && byName['c.json'].mode === 'create', 'c dispatched');
    assert(byName['d.json']?.status === 'dup', 'duplicate id archived as dup');
    assert(dispatched.length === 1 && dispatched[0].id === 'c', 'onDispatched fired once');
    files = await listInboxFiles(dir);
    assert(files.join(',') === 'b.json', 'only bad file remains after scan');

    // 被拒（TOO_MANY_GROUPS）不归档，下一轮还能重试
    await writeFile(join(dir, 'e.json'), JSON.stringify({ id: 'e', folders: ['src/z'] }), 'utf8');
    const r2 = await scanInbox({
      repoRoot: root, cfg: { ...back, inbox: '.codewrite/inbox' },
      listIssues: async () => [], dispatchIssueFn: async () => ({ ok: false, code: 'TOO_MANY_GROUPS' }),
    });
    assert(r2.find((r) => r.filename === 'e.json')?.status === 'pending', 'rejected stays pending');
    assert((await listInboxFiles(dir)).includes('e.json'), 'rejected file not archived');

    console.log('studio-watch: demo OK');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && normalize(process.argv[1]).endsWith('studio-watch.js')) {
  demo().catch((error) => { console.error(error); process.exitCode = 1; });
}
