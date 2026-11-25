import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_LINES,
  workspaceMemoryFilePath,
  sessionMemoryPath,
  sessionAgentsDir,
  sessionRegionsDir,
  agentMemoryPath,
  sessionRegionMemoryPath,
  memoryPath,
  regionsDir,
  regionMemoryPath,
  editorDir,
  readLayer,
} from './studio-memory.js';
import {
  sessionsRoot,
  sessionDir,
  sessionJsonPath,
  hasWorkspaceDir,
} from './studio-workspace.js';
import { ruleAppliesTo, listRules } from './studio-rules.js';

// 工作室角色全集（与 lib/index.js 的 ROLE_IDS 同值，用于 summary 标注）
const ALL_ROLES = ['tech-lead', 'planner', 'implementer', 'reviewer', 'security', 'test', 'maintenance', 'merger'];

// 记忆分层：workspace（跨会话共享）/ session / agent / region / legacy（旧 .codewrite 结构）
export const MEMORY_TIERS = ['workspace', 'session', 'agent', 'region', 'legacy'];

const SUMMARY_LEN = 80;

// 读目录里的 .md 文件名（目录不存在返回空数组，读失败不抛）
function listMd(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'));
}

// 取摘要：front-matter title，否则正文首非空行，截 80；空文件/读失败兜底
function summarize(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return '(读取失败)';
  }
  if (text.trim() === '') return '(空文件)';
  // 只认头部那段 front-matter，再在里面找 title：title 可以就是第一行键，
  // 原先「\ntitle:」要求 title 前面必须有换行，导致 title 打头时必然匹配失败。
  const fmBlock = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const fmTitle = fmBlock ? /^title:[ \t]*([^\r\n]+)$/m.exec(fmBlock[1]) : null;
  const raw = fmTitle ? fmTitle[1].trim() : firstNonEmptyLine(text);
  return raw.length > SUMMARY_LEN ? raw.slice(0, SUMMARY_LEN) : raw;
}

function firstNonEmptyLine(text) {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() !== '') return line.trim();
  }
  return '';
}

function fileLines(file) {
  try {
    const { text } = readLayer(file, 1_000_000);
    return text === '' ? 0 : text.split(/\r?\n/).length;
  } catch {
    return 0;
  }
}

function entryFor(ws, file, tier) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null; // 文件不存在则跳过（不整体失败）
  }
  const rel = path.relative(ws, file).split(path.sep).join('/');
  return {
    path: rel,
    tier,
    summary: summarize(file),
    lines: fileLines(file),
    mtimeMs: st.mtimeMs,
  };
}

// 会话已注册角色（session.json 的 roles 数组），无则 null
function sessionRoles(ws, sid) {
  try {
    const raw = fs.readFileSync(sessionJsonPath(ws, sid), 'utf8');
    const sess = JSON.parse(raw);
    const roles = sess?.roles;
    return Array.isArray(roles) && roles.length ? roles : null;
  } catch {
    return null;
  }
}

// 角色可见性：workspace/legacy 恒可见；session/agent/region 按会话已注册角色，
// 无则退化为 ruleAppliesTo 同构白名单，再无角色信息默认可见（供 summary 注明）。
function canSee(role, tier, roles, rules) {
  if (!role) return true;
  if (tier === 'workspace' || tier === 'legacy') return true;
  if (roles && roles.length) return roles.includes(role);
  if (rules && rules.length) return rules.some((r) => ruleAppliesTo(r, role));
  return true;
}

/**
 * 扫描工作区记忆，产出分层条目清单（纯函数，便于 demo 自测）。
 * @param {string} ws 工作区根目录
 * @param {{kinds?: string[], role?: string}} opts
 * @returns {{ok:boolean, entries:Array, dropped?:number, error?:string}}
 */
export function scanMemoryIndex(ws, opts = {}) {
  const kinds = Array.isArray(opts.kinds) && opts.kinds.length
    ? opts.kinds
    : MEMORY_TIERS.slice();
  for (const k of kinds) {
    if (!MEMORY_TIERS.includes(k)) return { ok: false, error: 'bad-scope' };
  }
  const role = typeof opts.role === 'string' && opts.role ? opts.role : null;

  const newMem = hasWorkspaceDir(ws);
  const legacyDir = editorDir(ws);
  let legacyOk = false;
  try {
    legacyOk = fs.statSync(legacyDir).isDirectory();
  } catch {
    legacyOk = false;
  }
  if (!newMem && !legacyOk) return { ok: false, error: 'no-workspace' };

  // 全量规则只取一次，供无角色信息时的 ruleAppliesTo 白名单。
  // 注意取 .rules 而不是整个返回体：listRules 返回 { ok, rules, total }，
  // 直接把它当数组用会让 canSee 里的 rules.length / rules.some 恒假 → 角色过滤静默失效。
  // 也不能传 role 让 listRules 先筛：这里要的是全集，逐条按 role 判。
  let rules = null;
  try {
    rules = listRules(ws).rules;
  } catch {
    rules = null;
  }

  const entries = [];
  let dropped = 0;

  const want = (t) => kinds.includes(t);

  if (want('workspace')) {
    const e = entryFor(ws, workspaceMemoryFilePath(ws), 'workspace');
    if (e) entries.push(e);
  }

  if (want('session') || want('agent') || want('region')) {
    // 遍历 .code-studio/sessions/<sid>
    let sids = [];
    try {
      sids = fs.statSync(sessionsRoot(ws)).isDirectory() ? fs.readdirSync(sessionsRoot(ws)) : [];
    } catch {
      sids = [];
    }
    for (const sid of sids) {
      const sdir = sessionDir(ws, sid);
      const roles = sessionRoles(ws, sid);

      if (want('session')) {
        const e = entryFor(ws, sessionMemoryPath(ws, sid), 'session');
        if (e && canSee(role, 'session', roles, rules)) entries.push(e);
        else if (e) dropped += 1;
      }
      if (want('agent')) {
        for (const child of listMd(sessionAgentsDir(ws, sid))) {
          const e = entryFor(ws, agentMemoryPath(ws, sid, child.replace(/\.md$/i, '')), 'agent');
          if (e && canSee(role, 'agent', roles, rules)) entries.push(e);
          else if (e) dropped += 1;
        }
      }
      if (want('region')) {
        for (const reg of listMd(sessionRegionsDir(ws, sid))) {
          const e = entryFor(ws, sessionRegionMemoryPath(ws, sid, reg.replace(/\.md$/i, '')), 'region');
          if (e && canSee(role, 'region', roles, rules)) entries.push(e);
          else if (e) dropped += 1;
        }
      }
      void sdir;
    }
  }

  if (want('legacy')) {
    const mem = entryFor(ws, memoryPath(ws), 'legacy');
    if (mem) entries.push(mem);
    for (const reg of listMd(regionsDir(ws))) {
      const e = entryFor(ws, regionMemoryPath(ws, reg.replace(/\.md$/i, '')), 'legacy');
      if (e) entries.push(e);
    }
  }

  return { ok: true, entries, dropped: dropped || undefined };
}

// 工具入口：execute({scope?:{kinds?}, role?})，全只读。
export function memoryIndexExecute({ ws, scope, role }) {
  const result = scanMemoryIndex(ws, { kinds: scope?.kinds, role });
  if (!result.ok) return result;
  return { ok: true, entries: result.entries, dropped: result.dropped };
}

if (process.argv[1] && process.argv[1].endsWith('studio-memory-index.js')) {
  await demo();
}

async function demo() {
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-idx-'));
  const ws = tmp;
  fs.mkdirSync(path.dirname(workspaceMemoryFilePath(ws)), { recursive: true });
  fs.writeFileSync(workspaceMemoryFilePath(ws), '---\ntitle: 跨会话工作区记忆\n---\n正文。\n');
  fs.mkdirSync(sessionDir(ws, 's1'), { recursive: true });
  fs.writeFileSync(sessionMemoryPath(ws, 's1'), '会话一记忆\n');
  fs.mkdirSync(sessionAgentsDir(ws, 's1'), { recursive: true });
  fs.writeFileSync(agentMemoryPath(ws, 's1', 'a1'), '# agent a1\n');
  fs.mkdirSync(sessionRegionsDir(ws, 's1'), { recursive: true });
  fs.writeFileSync(sessionRegionMemoryPath(ws, 's1', 'r1'), '区域一\n');
  fs.mkdirSync(editorDir(ws), { recursive: true });
  fs.writeFileSync(memoryPath(ws), '旧 MEMORY\n');

  const all = scanMemoryIndex(ws);
  assert(all.ok, '全量扫描 ok');
  const tiers = new Set(all.entries.map((e) => e.tier));
  assert(tiers.has('workspace') && tiers.has('session') && tiers.has('agent') && tiers.has('region') && tiers.has('legacy'), '五层齐全');
  assert(all.entries.length === 5, `五层各一条（实际 ${all.entries.length}）`);

  // 非法 scope
  const bad = scanMemoryIndex(ws, { kinds: ['nope'] });
  assert(bad.ok === false && bad.error === 'bad-scope', '非法 kinds -> bad-scope');

  // 角色过滤：给 s1 挂 roles，外部角色看不到
  fs.writeFileSync(path.join(sessionDir(ws, 's1'), 'session.json'), JSON.stringify({ roles: ['implementer'] }));
  const impl = scanMemoryIndex(ws, { role: 'implementer' });
  assert(impl.ok && impl.entries.some((e) => e.tier === 'session'), 'implementer 可见 session');
  const outsider = scanMemoryIndex(ws, { role: 'reviewer' });
  assert(outsider.ok && !outsider.entries.some((e) => e.tier === 'session'), 'reviewer 不可见该 session');
  assert(outsider.entries.some((e) => e.tier === 'workspace'), 'workspace 对任意角色恒可见');

  // 无角色信息默认可见
  const noRoles = scanMemoryIndex(ws, { role: 'planner' });
  assert(noRoles.ok, '无角色信息默认可见不崩');

  // 回归：front-matter 的 title 就是第一行键时也必须取到（原先正则要求 title 前有换行 → 恒失败）
  const wsEntry = all.entries.find((e) => e.tier === 'workspace');
  assert(wsEntry.summary === '跨会话工作区记忆', `front-matter title 取到（实际 ${JSON.stringify(wsEntry?.summary)}）`);

  // 回归：session.json 没有 roles 时，退化到 rules 白名单（原先 listRules 返回对象被当数组 → 恒可见）
  const tmpSess = path.join(sessionDir(ws, 's2'), 'session.json');
  fs.mkdirSync(path.dirname(tmpSess), { recursive: true });
  fs.writeFileSync(tmpSess, JSON.stringify({ sessionId: 's2' }));
  fs.writeFileSync(sessionMemoryPath(ws, 's2'), '会话二记忆\n');
  const { addRule } = await import('./studio-rules.js');
  addRule(ws, { text: '只让 implementer 看到的规则', scope: { kind: 'roles', roles: ['implementer'] } });
  const byRule = scanMemoryIndex(ws, { role: 'implementer' });
  assert(byRule.entries.some((e) => e.path.includes('sessions/s2/')), 'rules 白名单命中时 implementer 可见 s2');
  const byRuleOut = scanMemoryIndex(ws, { role: 'reviewer' });
  assert(!byRuleOut.entries.some((e) => e.path.includes('sessions/s2/')), 'rules 白名单未命中时 reviewer 不可见 s2');

  // summary 截断
  const long = scanMemoryIndex(ws);
  assert(long.entries.every((e) => e.summary.length <= SUMMARY_LEN), '摘要<=80');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('studio-memory-index: demo OK');
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assert failed: ${msg}`);
}

export { ALL_ROLES };
