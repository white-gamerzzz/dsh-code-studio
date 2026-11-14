/**
 * dsh-plugin-code-studio / studio-workspace —— 工作区级状态目录 `.code-studio/` 的读写。
 *
 * 只做「索引 + 会话绑定的落盘与读取」，不含监听/派单/记忆逻辑。
 * 目录形态（见 ARCHITECTURE.md）：
 *   <工作区根>/.code-studio/index.json                     ← 总账：仓库清单 + 会话指针
 *   <工作区根>/.code-studio/sessions/<sid>/session.json    ← 单会话：绑了谁 / 状态目录 / 子会话
 *   <工作区根>/.code-studio/memory/workspace.md            ← 工作区记忆（由 studio-memory 写）
 *   <工作区根>/.code-studio/sessions/<sid>/{memory.md,agents/,regions/}
 *
 * 两条铁律：①只放索引+记忆，不重复仓库工作状态（issues/regions 仍在 <repo>/.codewrite）
 *          ②除 memory/workspace.md 外所有记忆按会话隔离。
 *
 * 兼容：`.code-studio` 是新增的；老工作区没有它时，loadIndex 返回空壳，调用方按需创建。
 * 硬约束：不加 `export default`（cordis unwrapExports 会取 exports.default）。
 */
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';

export const CODE_STUDIO_DIR = '.code-studio';
export const INDEX_FILE = 'index.json';
export const SESSIONS_DIR = 'sessions';
export const MEMORY_DIR = 'memory';
export const WORKSPACE_MEMORY_FILE = 'workspace.md';
export const REPOS_DIR = 'repos';
const INDEX_SCHEMA = 1;

/** .code-studio 根目录 */
export function rootDir(workspaceRoot) {
  return join(workspaceRoot, CODE_STUDIO_DIR);
}
export function indexPath(workspaceRoot) {
  return join(rootDir(workspaceRoot), INDEX_FILE);
}
export function sessionsRoot(workspaceRoot) {
  return join(rootDir(workspaceRoot), SESSIONS_DIR);
}
export function sessionDir(workspaceRoot, sessionId) {
  return join(sessionsRoot(workspaceRoot), sanitizeId(sessionId));
}
export function sessionJsonPath(workspaceRoot, sessionId) {
  return join(sessionDir(workspaceRoot, sessionId), 'session.json');
}
export function workspaceMemoryPath(workspaceRoot) {
  return join(rootDir(workspaceRoot), MEMORY_DIR, WORKSPACE_MEMORY_FILE);
}
export function reposRoot(workspaceRoot) {
  return join(rootDir(workspaceRoot), REPOS_DIR);
}

/** slug 化一个 id（防路径穿越）：只留字母数字 . _ - */
export function sanitizeId(id) {
  return String(id ?? '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'default';
}

/**
 * 从 Agent 取稳定的会话 id。跟 session-roles.js 的来源保持一致，避免两套 id。
 * @param {object} agent
 * @returns {string}
 */
export function sessionIdOf(agent) {
  const id = agent?.session?.header?.id ?? agent?.session?.id ?? agent?.id;
  return String(id ?? '').trim();
}

function emptyIndex(workspaceRoot) {
  return { version: INDEX_SCHEMA, workspace: String(workspaceRoot ?? ''), updatedAt: '', repos: {}, sessions: {} };
}

async function writeAtomic(file, text) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, 'utf8');
  try {
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

async function readJson(file, fallback) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 读 index.json。缺文件/坏文件 → 返回带默认骨架的空索引（版本、空 repos/sessions）。
 * @param {string} workspaceRoot
 * @returns {Promise<{version:number,workspace:string,updatedAt:string,repos:object,sessions:object}>}
 */
export async function loadIndex(workspaceRoot) {
  const base = emptyIndex(workspaceRoot);
  const data = await readJson(indexPath(workspaceRoot), base);
  return {
    version: Number(data.version) || INDEX_SCHEMA,
    workspace: String(data.workspace ?? workspaceRoot ?? ''),
    updatedAt: String(data.updatedAt ?? ''),
    repos: data.repos && typeof data.repos === 'object' ? data.repos : {},
    sessions: data.sessions && typeof data.sessions === 'object' ? data.sessions : {},
  };
}

/** 深合并写 index（只覆盖给定键，其余保留） */
export async function saveIndex(workspaceRoot, patch = {}) {
  const cur = await loadIndex(workspaceRoot);
  const next = {
    ...cur,
    ...patch,
    repos: { ...cur.repos, ...(patch.repos ?? {}) },
    sessions: { ...cur.sessions, ...(patch.sessions ?? {}) },
    updatedAt: new Date().toISOString(),
  };
  await writeAtomic(indexPath(workspaceRoot), JSON.stringify(next, null, 2));
  return next;
}

/**
 * 登记/更新一个仓库。slug 形如 `owner/repo`。
 * @param {string} workspaceRoot
 * @param {string} slug
 * @param {{dir:string, kind?:'local'|'cloned', remotes?:object}} info
 */
export async function upsertRepo(workspaceRoot, slug, info = {}) {
  const key = String(slug ?? '').trim();
  if (!key) throw new Error('upsertRepo 需要 slug（owner/repo）');
  const idx = await loadIndex(workspaceRoot);
  const prev = idx.repos[key] ?? {};
  idx.repos[key] = {
    ...prev,
    dir: info.dir ?? prev.dir ?? '',
    kind: info.kind ?? prev.kind ?? 'local',
    remotes: { ...(prev.remotes ?? {}), ...(info.remotes ?? {}) },
  };
  return saveIndex(workspaceRoot, { repos: idx.repos });
}

/**
 * 登记/更新一个会话绑定。sessionId 由 sessionIdOf(agent) 给。
 * @param {string} workspaceRoot
 * @param {string} sessionId
 * @param {object} patch  { title?, boundRepo?, prRepo?, prHeadOwner?, stateDir?, activeRegions? }
 */
export async function upsertSession(workspaceRoot, sessionId, patch = {}) {
  const sid = sanitizeId(sessionId);
  if (!sid) throw new Error('upsertSession 需要 sessionId');
  const idx = await loadIndex(workspaceRoot);
  const prev = idx.sessions[sid] ?? {};
  const next = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  idx.sessions[sid] = next;
  // 同时写单独的 session.json（Tab/子会话可只读这一份）
  await writeAtomic(sessionJsonPath(workspaceRoot, sid), JSON.stringify({ sessionId: sid, ...next }, null, 2));
  return saveIndex(workspaceRoot, { sessions: idx.sessions });
}

/** 读单会话 session.json；没有就回退 index.sessions[sid]；都没有 → null */
export async function loadSession(workspaceRoot, sessionId) {
  const sid = sanitizeId(sessionId);
  const direct = await readJson(sessionJsonPath(workspaceRoot, sid), null);
  if (direct && typeof direct === 'object') return direct;
  const idx = await loadIndex(workspaceRoot);
  return idx.sessions[sid] ?? null;
}

/** 删一个会话目录（含它的会话/子Agent/region 记忆与绑定）——隔离删除，不碰别的会话 */
export async function removeSession(workspaceRoot, sessionId) {
  const sid = sanitizeId(sessionId);
  const idx = await loadIndex(workspaceRoot);
  if (idx.sessions[sid]) {
    // saveIndex 是深合并，删 key 必须整份写回，不能用 patch 合并。
    delete idx.sessions[sid];
    idx.updatedAt = new Date().toISOString();
    await writeAtomic(indexPath(workspaceRoot), JSON.stringify(idx, null, 2));
  }
  const dir = sessionDir(workspaceRoot, sid);
  try {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  } catch { /* 目录不存在不挡 */ }
  return { ok: true, sessionId: sid };
}

/** .code-studio/.gitignore 默认内容（忽略 clone 下来的仓库与本地凭据类文件） */
const DEFAULT_GITIGNORE = ['repos/', '*.tmp', '**/github-token', ''].join('\n');

/** 确保 .code-studio 骨架存在（index.json + .gitignore），已存在则不动。幂等。 */
export async function ensureWorkspaceDir(workspaceRoot) {
  const root = rootDir(workspaceRoot);
  await mkdir(join(root, MEMORY_DIR), { recursive: true });
  await mkdir(sessionsRoot(workspaceRoot), { recursive: true });
  const gi = join(root, '.gitignore');
  if (!existsSync(gi)) await writeFile(gi, DEFAULT_GITIGNORE, 'utf8').catch(() => {});
  if (!existsSync(indexPath(workspaceRoot))) {
    await saveIndex(workspaceRoot, {});
  }
  return { root };
}

/** 同步判断是否已有 .code-studio（给同步场景用） */
export function hasWorkspaceDir(workspaceRoot) {
  try { return existsSync(indexPath(workspaceRoot)); } catch { return false; }
}

// ---------------------------------------------------------------------------
// 自检：用临时目录跑一遍读写/合并/隔离删除，不碰真实工作区。
// ---------------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('studio-workspace.js')) {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const assert = (cond, msg) => { if (!cond) throw new Error(`studio-workspace demo FAIL: ${msg}`); };

  const ws = await mkdtemp(join(tmpdir(), 'cs-ws-'));

  // 空工作区
  const empty = await loadIndex(ws);
  assert(empty.version === 1 && Object.keys(empty.repos).length === 0, 'empty index shape');
  assert(hasWorkspaceDir(ws) === false, 'no dir yet');

  // ensure 建骨架
  await ensureWorkspaceDir(ws);
  assert(hasWorkspaceDir(ws) === true, 'dir created');
  assert(existsSync(workspaceMemoryPath(ws)) === false, 'workspace.md not auto-created');
  assert(existsSync(join(rootDir(ws), '.gitignore')) === true, '.gitignore created');

  // 仓库登记 + 合并更新 remotes
  await upsertRepo(ws, 'someone/astrbot', { dir: 'G:/bot-home/astrbot-self', kind: 'local', remotes: { origin: 'white-gamerzzz/astrbot' } });
  await upsertRepo(ws, 'someone/astrbot', { remotes: { upstream: 'someone/astrbot' } });
  let idx = await loadIndex(ws);
  assert(idx.repos['someone/astrbot'].remotes.origin === 'white-gamerzzz/astrbot', 'remote origin kept');
  assert(idx.repos['someone/astrbot'].remotes.upstream === 'someone/astrbot', 'remote upstream merged');
  assert(idx.repos['someone/astrbot'].dir === 'G:/bot-home/astrbot-self', 'dir kept');

  // 会话绑定：写 index + session.json
  await upsertSession(ws, 'sess-abc', { boundRepo: 'someone/astrbot', prRepo: 'someone/astrbot', prHeadOwner: 'white-gamerzzz', stateDir: 'G:/bot-home/astrbot-self/.codewrite' });
  idx = await loadIndex(ws);
  assert(idx.sessions['sess-abc'].boundRepo === 'someone/astrbot', 'session in index');
  const s = await loadSession(ws, 'sess-abc');
  assert(s && s.prHeadOwner === 'white-gamerzzz', 'session.json direct read');

  // 更新会话只改给定字段，不丢别的
  await upsertSession(ws, 'sess-abc', { activeRegions: ['auth-api'] });
  const s2 = await loadSession(ws, 'sess-abc');
  assert(s2.boundRepo === 'someone/astrbot' && s2.activeRegions[0] === 'auth-api', 'session partial update merges');

  // 会话隔离：两个会话，删一个不影响另一个
  await upsertSession(ws, 'sess-xyz', { boundRepo: 'other/repo' });
  await removeSession(ws, 'sess-abc');
  idx = await loadIndex(ws);
  assert(!idx.sessions['sess-abc'], 'removed session gone from index');
  assert(idx.sessions['sess-xyz'], 'other session survives');
  assert(existsSync(sessionDir(ws, 'sess-abc')) === false, 'removed session dir gone');

  // sanitizeId 防穿越
  assert(sanitizeId('../../etc') === 'etc' || !sanitizeId('../../etc').includes('/'), 'sanitizeId blocks traversal');
  assert(sessionIdOf({ session: { header: { id: 'S1' } } }) === 'S1', 'sessionIdOf header.id');
  assert(sessionIdOf({ id: 'A1' }) === 'A1', 'sessionIdOf fallback agent.id');

  console.log('studio-workspace: demo OK');
}
