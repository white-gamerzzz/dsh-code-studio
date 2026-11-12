/**
 * dsh-plugin-code-studio / studio-store —— 工作室落盘数据：region 台账 + issue 记录。
 *
 * 只做「读写 + region 归属匹配」，不含任何监听/派单/LLM 逻辑（那些在各自的模块里）。
 * 落位固定为 <repo>/.codewrite/ 下两个文件：
 *   issues.json   一条 issue 一行记录（原文/状态/报告/改动文件/worktree）
 *   regions.json  一个 region 一项（自带 folders、持久子会话 childId、worktree）
 *
 * 为什么是「region」而不是「issue」做持久子会话的键：同一片文件夹的多个 issue 要追回
 * 同一个持久子会话继续改，而不是每个 issue 新开一枝杈。region = issue 触碰的文件夹簇。
 *
 * 硬约束：本文件不要加 `export default`（cordis 的 unwrapExports 会取 exports.default）。
 */
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

/** 数据目录（相对仓库根）。与 task-registry 的 .codewrite/agents 并列。 */
export const STUDIO_DIR = '.codewrite';
export const ISSUES_FILE = 'issues.json';
export const REGIONS_FILE = 'regions.json';

const ISSUES_SCHEMA = 1;
const REGIONS_SCHEMA = 1;

/** 归一化文件夹路径：反斜杠转正斜杠、去结尾斜杠、去开头 ./ */
export function normalizeFolder(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function issuesPath(repoRoot) { return join(repoRoot, STUDIO_DIR, ISSUES_FILE); }
function regionsPath(repoRoot) { return join(repoRoot, STUDIO_DIR, REGIONS_FILE); }

/** 原子写：同目录 tmp + rename（rename 在 Windows 上也是替换语义）。 */
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
    return JSON.parse(text);
  } catch {
    // 坏文件不静默覆盖：返回空壳，但调用方下次 save 会把它整个换掉。
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

/** 读全部 issue 记录（保持文件顺序）。文件不存在返回空表。 */
export async function loadIssues(repoRoot) {
  const raw = await readJson(issuesPath(repoRoot), undefined);
  if (raw === undefined) return { version: ISSUES_SCHEMA, issues: [] };
  // 容忍裸数组（手写/早期格式）与 {issues:[]} 两种形状。
  if (Array.isArray(raw)) return { version: ISSUES_SCHEMA, issues: raw };
  return { version: raw.version ?? ISSUES_SCHEMA, issues: Array.isArray(raw.issues) ? raw.issues : [] };
}

/** 写全部 issue 记录。 */
export async function saveIssues(repoRoot, data) {
  await writeAtomic(issuesPath(repoRoot), JSON.stringify({ version: ISSUES_SCHEMA, issues: data.issues ?? [] }, null, 2));
  return data;
}

/**
 * 插入或按 id 更新一条 issue（id 用源码里的 issue 编号字符串，如 "12"/"gh-12"）。
 * 已存在的记录做浅合并：调用方只传要改的字段即可（状态、report、region…）。
 */
export async function upsertIssue(repoRoot, patch) {
  const id = String(patch?.id ?? '').trim();
  if (!id) throw new TypeError('upsertIssue: id 必填');
  const data = await loadIssues(repoRoot);
  const now = new Date().toISOString();
  const index = data.issues.findIndex((item) => String(item.id) === id);
  if (index === -1) {
    data.issues.push({ ...patch, id, createdAt: patch.createdAt ?? now, updatedAt: now });
  } else {
    data.issues[index] = { ...data.issues[index], ...patch, id, updatedAt: now };
  }
  await saveIssues(repoRoot, data);
  return data.issues.find((item) => String(item.id) === id);
}

export async function getIssue(repoRoot, id) {
  const data = await loadIssues(repoRoot);
  return data.issues.find((item) => String(item.id) === String(id));
}

// ---------------------------------------------------------------------------
// regions
// ---------------------------------------------------------------------------

/** 读 region 台账。返回 { version, regions: { [name]: {folders, childId, worktree, issues} } }。 */
export async function loadRegions(repoRoot) {
  const raw = await readJson(regionsPath(repoRoot), undefined);
  if (raw === undefined) return { version: REGIONS_SCHEMA, regions: {} };
  return { version: raw.version ?? REGIONS_SCHEMA, regions: raw.regions ?? {} };
}

export async function saveRegions(repoRoot, data) {
  await writeAtomic(regionsPath(repoRoot), JSON.stringify({ version: REGIONS_SCHEMA, regions: data.regions ?? {} }, null, 2));
  return data;
}

/**
 * 给 region 追加一个 issue 编号（去重），可选更新 childId / worktree。
 * 只在 region 已存在时合并；不存在则用 folders 新建。
 */
export async function upsertRegion(repoRoot, name, patch = {}) {
  const key = String(name ?? '').trim();
  if (!key) throw new TypeError('upsertRegion: name 必填');
  const data = await loadRegions(repoRoot);
  const now = new Date().toISOString();
  const prev = data.regions[key] ?? { folders: [], issues: [] };
  const next = {
    ...prev,
    ...patch,
    folders: (patch.folders ?? prev.folders ?? []).map(normalizeFolder).filter(Boolean),
    issues: Array.from(new Set([...(prev.issues ?? []), ...((patch.issues ?? []).map(String))])),
    updatedAt: now,
  };
  data.regions[key] = next;
  await saveRegions(repoRoot, data);
  return next;
}

// ---------------------------------------------------------------------------
// region 归属匹配（纯函数，无 IO —— 单测/演示都只测这个）
// ---------------------------------------------------------------------------

/**
 * 给定一条 issue 触碰的文件夹集，从现有 region 台账里挑一个来追。
 *
 * 规则（按优先级）：
 *   1. 完全相同        → 命中（同一个区域）。
 *   2. issue 是某 region 的子集 → 复用那个更大的 region（它本来就管着这些文件夹）。
 *   3. 有交集且无歧义（唯一一个候选）→ 命中（顺手并进来）。
 *   4. 都不满足 / 有多个同等候选无法判定 → 返回 null，交给下一层（前台兜底或首单自报）。
 *
 * @param {Record<string,{folders:string[]}>} regions region 台账
 * @param {string[]} folders issue 触碰的文件夹（会被归一化）
 * @returns {string|null} 命中的 region 名，或 null
 */
export function matchRegion(regions, folders) {
  const want = new Set(folders.map(normalizeFolder).filter(Boolean));
  if (want.size === 0) return null;
  const entries = Object.entries(regions ?? {});
  const sets = entries.map(([name, region]) => ({
    name,
    set: new Set((region?.folders ?? []).map(normalizeFolder).filter(Boolean)),
  })).filter((item) => item.set.size > 0);

  // 1. 完全相同
  for (const item of sets) {
    if (item.set.size === want.size && [...want].every((f) => item.set.has(f))) return item.name;
  }
  // 2. issue 是 region 的子集（region 覆盖了 issue 全部文件夹）
  const supersets = sets.filter((item) => [...want].every((f) => item.set.has(f)));
  if (supersets.length === 1) return supersets[0].name;
  if (supersets.length > 1) {
    // 有多个覆盖者时取最小（最贴合）的那个；仍并列则放弃。
    supersets.sort((a, b) => a.set.size - b.set.size);
    if (supersets[0].set.size < supersets[1].set.size) return supersets[0].name;
    return null;
  }
  // 3. 有交集且唯一
  const overlapping = sets.filter((item) => [...want].some((f) => item.set.has(f)));
  if (overlapping.length === 1) return overlapping[0].name;
  return null;
}

/**
 * 给一条 issue 决定它该归到哪个 region（纯函数）。
 *
 * 有匹配 → 复用那个 region；没匹配 → 用第一个文件夹的名当新 region 名（首单自报的懒版，
 * 不调 LLM）。这一段就是 code_studio 的 issue_assign 全部分支逻辑，抽成纯函数好单测。
 *
 * @param {Record<string,{folders:string[]}>} regions
 * @param {string[]} folders issue 触碰的文件夹
 * @returns {{name:string, folders:string[], isNew:boolean}}
 */
export function planRegion(regions, folders) {
  const norm = (folders ?? []).map(normalizeFolder).filter(Boolean);
  const hit = matchRegion(regions, norm);
  if (hit) return { name: hit, folders: norm, isNew: false };
  // 名字要与文件夹顺序无关，否则 ['src/api','src/auth'] 与 ['src/auth','src/api'] 会各起一个 region。
  const tails = [...new Set(norm.map((f) => f.split('/').pop()).filter(Boolean))].sort();
  return { name: tails.length ? tails.join('+') : 'region', folders: norm, isNew: true };
}

// ---------------------------------------------------------------------------
// 自检：node lib/studio-store.js  （ponytail：一个能跑的最小检查，坏逻辑即失败）
// ---------------------------------------------------------------------------
async function demo() {
  const assert = (cond, msg) => { if (!cond) throw new Error(`demo failed: ${msg}`); };

  // matchRegion：完全命中 / 子集 / 交集唯一 / 无交集
  const regions = {
    'auth-api': { folders: ['src/auth', 'src/api'] },
    ui: { folders: ['src/ui'] },
  };
  assert(matchRegion(regions, ['src/auth', 'src/api']) === 'auth-api', 'exact match');
  assert(matchRegion(regions, ['src/auth']) === 'auth-api', 'subset → superset region');
  assert(matchRegion(regions, ['src/ui', 'src/ui/widgets']) === 'ui', 'subset under ui');
  assert(matchRegion(regions, ['docs']) === null, 'no overlap → null');
  assert(matchRegion(regions, []) === null, 'empty folders → null');
  // 反斜杠归一化
  assert(matchRegion({ r: { folders: ['src/a'] } }, ['src\\a']) === 'r', 'backslash normalized');

  // planRegion：命中复用 / 未命中新建（名字取末段、去重、排序，与顺序无关）
  const p1 = planRegion(regions, ['src/auth']);
  assert(p1.name === 'auth-api' && p1.isNew === false, 'planRegion reuse');
  const p2 = planRegion(regions, ['src\\billing', 'src/invoice']);
  assert(p2.name === 'billing+invoice' && p2.isNew === true && p2.folders.join(',') === 'src/billing,src/invoice', 'planRegion new');
  const p3 = planRegion({}, ['src/api', 'src/auth']);
  const p4 = planRegion({}, ['src/auth', 'src/api']);
  assert(p3.name === p4.name, 'planRegion name order-independent');

  // IO：写到临时仓库根，读写一致
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'studio-store-'));
  try {
    await upsertIssue(root, { id: '12', title: '修登录', repo: 'o/n', body: '...' });
    await upsertIssue(root, { id: '12', status: 'DONE', report: '改好了' });
    const one = await getIssue(root, '12');
    assert(one.status === 'DONE' && one.report === '改好了' && one.title === '修登录', 'issue merge keeps fields');
    assert((await loadIssues(root)).issues.length === 1, 'no duplicate issue');
    await upsertRegion(root, 'auth-api', { folders: ['src\\auth', 'src/api'], childId: 'ta:ws:auth-api' });
    await upsertRegion(root, 'auth-api', { issues: ['12'] });
    await upsertRegion(root, 'auth-api', { issues: ['12'] }); // 去重
    const reg = (await loadRegions(root)).regions['auth-api'];
    assert(reg.folders.join(',') === 'src/auth,src/api', 'folders normalized');
    assert(reg.issues.length === 1 && reg.issues[0] === '12', 'issues deduped');
    assert(reg.childId === 'ta:ws:auth-api', 'childId kept across merge');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log('studio-store: demo OK');
}

// 仅在直接执行时跑 demo（被 import 时不跑）。
if (process.argv[1] && normalize(process.argv[1]).endsWith('studio-store.js')) {
  demo().catch((error) => { console.error(error); process.exitCode = 1; });
}
