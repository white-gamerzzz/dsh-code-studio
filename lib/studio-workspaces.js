/**
 * dsh-plugin-code-studio / studio-workspaces —— 全局授权工作区清单。
 *
 * BH（BotHarness）场景下面板不捆绑任何工作区：仓库列表来自「授权工作区」
 * （`~/.dsh/code-studio/workspaces.json`，数组存绝对路径）。用户把目录粘贴进
 * 面板（或让 bot 调 code_studio authorize）后，该目录（及其子仓库）进入面板。
 *
 * 硬约束：不加 `export default`（cordis unwrapExports 会取 exports.default）。
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

export function workspacesFile() {
  return join(homedir(), '.dsh', 'code-studio', 'workspaces.json');
}

/** 归一化一个工作区路径：必须绝对路径，去尾分隔符 */
export function normalizeWorkspace(dir) {
  const raw = String(dir ?? '').trim();
  if (!raw || !isAbsolute(raw)) return '';
  let out = raw.replace(/[\\/]+$/, '');
  try { out = resolve(out); } catch { /* 保留原样 */ }
  return out;
}

/** 读清单（缺文件/坏文件 → 空数组，保序去重） */
export function loadWorkspaces() {
  let list;
  try {
    list = JSON.parse(readFileSync(workspacesFile(), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const dir = normalizeWorkspace(item);
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out;
}

function saveWorkspaces(list) {
  const file = workspacesFile();
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  try {
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* noop */ }
    throw error;
  }
}

/**
 * 授权一个工作区目录（必须真实存在且是目录）。已存在则原样返回。
 * @returns {{ok:boolean, dir:string, error?:string}}
 */
export function authorizeWorkspace(dir) {
  const norm = normalizeWorkspace(dir);
  if (!norm) {
    const raw = String(dir ?? '').trim();
    return { ok: false, dir: '', error: raw ? '需要绝对路径' : '需要目录路径' };
  }
  try {
    if (!statSync(norm).isDirectory()) return { ok: false, dir: norm, error: `${norm} 不是目录` };
  } catch {
    return { ok: false, dir: norm, error: `目录不存在：${norm}` };
  }
  const list = loadWorkspaces();
  if (!list.includes(norm)) {
    list.push(norm);
    saveWorkspaces(list);
  }
  return { ok: true, dir: norm };
}

/** 撤销授权（路径按归一化匹配；不存在也算成功）。 */
export function unauthorizeWorkspace(dir) {
  const norm = normalizeWorkspace(dir);
  if (!norm) return { ok: false, dir: '', error: '需要目录路径' };
  const list = loadWorkspaces();
  const next = list.filter((d) => d !== norm);
  if (next.length !== list.length) saveWorkspaces(next);
  return { ok: true, dir: norm };
}

// ---------------------------------------------------------------------------
// 自检：临时目录跑一遍授权/去重/撤销，不碰真实 ~/.dsh。
// ---------------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('studio-workspaces.js')) {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const assert = (cond, msg) => { if (!cond) throw new Error(`studio-workspaces demo FAIL: ${msg}`); };

  const home = await mkdtemp(join(tmpdir(), 'cs-wsfile-'));
  const realHome = process.env.USERPROFILE || process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    // 空清单
    assert(loadWorkspaces().length === 0, 'empty list');

    // 授权：不存在 → 拒
    const bad = authorizeWorkspace(join(home, 'nope'));
    assert(bad.ok === false && bad.error.includes('不存在'), 'missing dir rejected');

    // 授权：真目录 → ok；重复授权幂等
    const wsA = await mkdtemp(join(home, 'ws-'));
    const a1 = authorizeWorkspace(wsA);
    assert(a1.ok === true && a1.dir === normalizeWorkspace(wsA), 'authorize ok');
    const a2 = authorizeWorkspace(wsA + '/');
    assert(a2.ok === true && loadWorkspaces().length === 1, 'dedupe via trailing separator');

    // 再授权一个
    const wsB = await mkdtemp(join(home, 'ws-'));
    authorizeWorkspace(wsB);
    assert(loadWorkspaces().length === 2, 'two workspaces');

    // 相对路径拒绝（面板/bot 都该给绝对路径）
    const rel = authorizeWorkspace('.');
    assert(rel.ok === false && rel.error.includes('绝对'), 'relative path rejected');

    // 撤销
    const rm = unauthorizeWorkspace(wsA);
    assert(rm.ok === true && loadWorkspaces().length === 1, 'unauthorize removes one');
    const rm2 = unauthorizeWorkspace(wsA);
    assert(rm2.ok === true && loadWorkspaces().length === 1, 'unauthorize idempotent');

    console.log('studio-workspaces: demo OK');
  } finally {
    process.env.USERPROFILE = realHome;
    process.env.HOME = realHome;
  }
}
