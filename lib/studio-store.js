/**
 * dsh-plugin-code-studio / studio-store —— 工作室落盘数据：issue 台账（含仓库级串行开关）。
 *
 * 只做「读写」，不含任何监听/派单/LLM 逻辑（那些在各自的模块里）。
 * 落位固定为 <repo>/.code-studio/issues.json：
 *   { version, queue?, issues: [...] }  —— queue 是仓库级串行开关（一次只跑一单）。
 *
 * 硬约束：本文件不要加 `export default`（cordis 的 unwrapExports 会取 exports.default）。
 */
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

/** 台账目录（相对仓库根）：统一收在 .code-studio 下，不再散落在 .codewrite。 */
export const STUDIO_DIR = '.code-studio';
/** 旧台账目录：只读兼容（新位置无文件时回退读这里）。 */
export const LEGACY_STUDIO_DIR = '.codewrite';
export const ISSUES_FILE = 'issues.json';

const ISSUES_SCHEMA = 1;

/** 归一化文件夹路径：反斜杠转正斜杠、去结尾斜杠、去开头 ./ */
export function normalizeFolder(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function issuesPath(repoRoot) { return join(repoRoot, STUDIO_DIR, ISSUES_FILE); }
// 旧位置（只读兼容）：老工作区台账还在 .codewrite/，新位置没有文件时回退读它。
function legacyIssuesPath(repoRoot) { return join(repoRoot, LEGACY_STUDIO_DIR, ISSUES_FILE); }

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
    // 去 BOM：PowerShell 的 Set-Content/Out-File 默认写 UTF-8 BOM，JSON.parse 会直接炸。
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    // 坏文件不静默覆盖：返回空壳，但调用方下次 save 会把它整个换掉。
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

/**
 * 读全部 issue 记录（保持文件顺序）。
 * 返回 { version, queue, issues } —— queue 是仓库级串行开关（默认 false = 并行分叉）。
 * 文件不存在返回空表。
 */
export async function loadIssues(repoRoot) {
  let raw = await readJson(issuesPath(repoRoot), undefined);
  if (raw === undefined) raw = await readJson(legacyIssuesPath(repoRoot), undefined); // 旧 .codewrite 兼容读
  if (raw === undefined) return { version: ISSUES_SCHEMA, queue: false, issues: [] };
  // 容忍裸数组（手写/早期格式）与 {issues:[]} 两种形状。
  if (Array.isArray(raw)) return { version: ISSUES_SCHEMA, queue: false, issues: raw };
  return {
    version: raw.version ?? ISSUES_SCHEMA,
    queue: raw.queue === true,
    issues: Array.isArray(raw.issues) ? raw.issues : [],
  };
}

/** 写全部 issue 记录（queue 开关随 wrapper 一起落盘）。 */
export async function saveIssues(repoRoot, data) {
  const body = { version: ISSUES_SCHEMA, queue: data.queue === true, issues: data.issues ?? [] };
  await writeAtomic(issuesPath(repoRoot), JSON.stringify(body, null, 2));
  return body;
}

/** 读仓库级串行开关（一次只跑一单，对应 GitHub 的 Require branches to be up to date）。 */
export async function loadQueue(repoRoot) {
  return (await loadIssues(repoRoot)).queue === true;
}

/** 写仓库级串行开关。 */
export async function saveQueue(repoRoot, queue) {
  const data = await loadIssues(repoRoot);
  data.queue = queue === true;
  await saveIssues(repoRoot, data);
  return data.queue;
}

/**
 * 插入或按 id 更新一条 issue（id 用源码里的 issue 编号字符串，如 "12"/"gh-12"）。
 * 已存在的记录做浅合并：调用方只传要改的字段即可（状态、report、tags…）。
 */
export async function upsertIssue(repoRoot, patch) {
  const id = String(patch?.id ?? '').trim();
  if (!id) throw new TypeError('upsertIssue: id 必填');
  const body = {
    ...patch,
    ...(Array.isArray(patch?.folders) ? { folders: patch.folders.map(normalizeFolder).filter(Boolean) } : {}),
  };
  const data = await loadIssues(repoRoot);
  const now = new Date().toISOString();
  const index = data.issues.findIndex((item) => String(item.id) === id);
  if (index === -1) {
    data.issues.push({ ...body, id, createdAt: patch.createdAt ?? now, updatedAt: now });
  } else {
    data.issues[index] = { ...data.issues[index], ...body, id, updatedAt: now };
  }
  await saveIssues(repoRoot, data);
  return data.issues.find((item) => String(item.id) === id);
}

export async function getIssue(repoRoot, id) {
  const data = await loadIssues(repoRoot);
  return data.issues.find((item) => String(item.id) === String(id));
}

// ---------------------------------------------------------------------------
// 自检：node lib/studio-store.js  （ponytail：一个能跑的最小检查，坏逻辑即失败）
// ---------------------------------------------------------------------------
async function demo() {
  const assert = (cond, msg) => { if (!cond) throw new Error(`demo failed: ${msg}`); };

  // IO：写到临时仓库根，读写一致
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'studio-store-'));
  try {
    await upsertIssue(root, { id: '12', title: '修登录', repo: 'o/n', body: '...', folders: ['src\\auth', 'src/api/'] });
    await upsertIssue(root, { id: '12', status: 'DONE', report: '改好了' });
    const one = await getIssue(root, '12');
    assert(one.status === 'DONE' && one.report === '改好了' && one.title === '修登录', 'issue merge keeps fields');
    assert(one.folders.join(',') === 'src/auth,src/api', 'folders normalized on write');
    assert((await loadIssues(root)).issues.length === 1, 'no duplicate issue');
    // queue 开关：默认关，开了随 wrapper 落盘，写 issue 不丢。
    assert((await loadQueue(root)) === false, 'queue default off');
    await saveQueue(root, true);
    assert((await loadQueue(root)) === true, 'queue persisted');
    await upsertIssue(root, { id: '13', title: '再加一单' });
    assert((await loadQueue(root)) === true, 'queue survives upsertIssue');
    const all = await loadIssues(root);
    assert(all.queue === true && all.issues.length === 2, 'wrapper roundtrip');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log('studio-store: demo OK');
}

// 仅在直接执行时跑 demo（被 import 时不跑）。
if (process.argv[1] && normalize(process.argv[1]).endsWith('studio-store.js')) {
  demo().catch((error) => { console.error(error); process.exitCode = 1; });
}
