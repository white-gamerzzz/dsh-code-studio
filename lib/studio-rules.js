/**
 * dsh-plugin-code-studio / studio-rules —— 工作区规则层（.code-studio/memory/rules.json）。
 *
 * 与「记忆」的区别：记忆是流水（这次干了什么），规则是**长期约束**（以后都得这么做）。
 * 场景：用户在对话里提醒技术总监「别再长时间卡住」，总监用 code_studio action=rule 把它
 * 写进这里；之后同一个工作区里所有（或指定角色的）Agent 开局都按 scope 过滤读回。
 *
 * 一条规则形状：
 *   { id, text, scope:{kind:'all'|'roles'|'session', roles?:string[]}, tags:string[],
 *     createdBy:string, createdAt:string, source:string }
 *   - kind='all'     全 Agent 生效
 *   - kind='roles'   仅 scope.roles 里列出的角色（tech-lead/planner/implementer/reviewer/security/test/maintenance/merger）
 *   - kind='session' 不进 rules.json（写进该会话自己的 memory.md，见 studio-memory）；这里只是识别
 *   角色固有纪律（跟角色绑死、跨项目都成立）应写进 presets/code-editor/roles/<role>.md，不是这里。
 *
 * 限制：单条 ≤200 字；同文去重；超过 MAX_RULES 条时最老的滚进 rules.archive.json。
 *
 * 硬约束：不加 `export default`（cordis unwrapExports 会取 exports.default）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CODE_STUDIO_DIR, MEMORY_DIR } from './studio-workspace.js';

export const RULES_FILE = 'rules.json';
export const RULES_SCHEMA = 1;
export const MAX_TEXT = 200;
export const MAX_RULES = 50;

export function rulesPath(workspaceRoot) {
  return join(workspaceRoot, CODE_STUDIO_DIR, MEMORY_DIR, RULES_FILE);
}
export function archivePath(workspaceRoot) {
  return join(workspaceRoot, CODE_STUDIO_DIR, MEMORY_DIR, 'rules.archive.json');
}

const ALL_ROLES = ['tech-lead', 'planner', 'implementer', 'reviewer', 'security', 'test', 'maintenance', 'merger'];

function emptyDoc() {
  return { version: RULES_SCHEMA, rules: [], updatedAt: '' };
}

function readJson(file, fallback) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  try {
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 忽略 */ }
    throw error;
  }
}

/** 读 rules.json（缺/坏 → 空）。 */
export function loadRules(workspaceRoot) {
  const doc = readJson(rulesPath(workspaceRoot), emptyDoc());
  return {
    version: Number(doc.version) || RULES_SCHEMA,
    rules: Array.isArray(doc.rules) ? doc.rules.filter((r) => r && typeof r.text === 'string') : [],
    updatedAt: String(doc.updatedAt ?? ''),
  };
}

/** 归一化 scope 入参：'all' | 'tech-lead,reviewer' | {kind,roles} */
export function normalizeScope(scope) {
  if (scope && typeof scope === 'object') {
    const kind = String(scope.kind ?? 'all');
    if (kind === 'roles') {
      const roles = (Array.isArray(scope.roles) ? scope.roles : []).map((r) => String(r).trim()).filter((r) => ALL_ROLES.includes(r));
      return roles.length ? { kind: 'roles', roles: Array.from(new Set(roles)) } : { kind: 'all' };
    }
    if (kind === 'session') return { kind: 'session' };
    return { kind: 'all' };
  }
  const s = String(scope ?? '').trim().toLowerCase();
  if (!s || s === 'all') return { kind: 'all' };
  if (s === 'session') return { kind: 'session' };
  const roles = s.split(/[,，\s]+/).map((r) => r.trim()).filter((r) => ALL_ROLES.includes(r));
  return roles.length ? { kind: 'roles', roles: Array.from(new Set(roles)) } : { kind: 'all' };
}

function normText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}
/** 去重键：比对时不看空白差异（中文里多一个空格不该算两条）。 */
function dedupeKey(text) {
  return normText(text).replace(/\s+/g, '').toLowerCase();
}
function normTags(tags) {
  if (!tags) return [];
  const arr = Array.isArray(tags) ? tags : String(tags).split(/[,，\s]+/);
  return Array.from(new Set(arr.map((t) => String(t).trim()).filter(Boolean))).slice(0, 6);
}

/**
 * 加一条规则。同文（归一化后相同）去重：已存在则只更新 scope/tags，不重复加。
 * @returns {{ok:boolean, rule?:object, duplicate?:boolean, error?:string, rotated?:number}}
 */
export function addRule(workspaceRoot, input = {}) {
  const text = normText(input.text);
  if (!text) return { ok: false, error: '规则内容为空' };
  const scope = normalizeScope(input.scope);
  if (scope.kind === 'session') {
    // session 级不该进 rules.json —— 调用方应改写 sessions/<sid>/memory.md。
    return { ok: false, error: "scope=session 的规则请写进会话记忆（appendSessionMemory），不进 rules.json" };
  }
  const doc = loadRules(workspaceRoot);
  const key = dedupeKey(text);
  const existed = doc.rules.find((r) => dedupeKey(r.text) === key);
  if (existed) {
    existed.scope = scope;
    if (input.tags !== undefined) existed.tags = normTags(input.tags);
    doc.updatedAt = new Date().toISOString();
    writeJsonAtomic(rulesPath(workspaceRoot), doc);
    return { ok: true, rule: existed, duplicate: true };
  }
  const rule = {
    id: `r-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
    text,
    scope,
    tags: normTags(input.tags),
    createdBy: String(input.createdBy ?? ''),
    createdAt: new Date().toISOString(),
    source: String(input.source ?? ''),
  };
  doc.rules.push(rule);
  // 超限：最老的（按 createdAt）滚进 archive
  let rotated = 0;
  if (doc.rules.length > MAX_RULES) {
    doc.rules.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const overflow = doc.rules.splice(0, doc.rules.length - MAX_RULES);
    rotated = overflow.length;
    const arc = readJson(archivePath(workspaceRoot), { version: RULES_SCHEMA, rules: [] });
    arc.rules = Array.isArray(arc.rules) ? arc.rules : [];
    arc.rules.push(...overflow);
    arc.updatedAt = new Date().toISOString();
    writeJsonAtomic(archivePath(workspaceRoot), arc);
  }
  doc.updatedAt = new Date().toISOString();
  writeJsonAtomic(rulesPath(workspaceRoot), doc);
  return { ok: true, rule, rotated };
}

/** 删一条：按 id 或按文本（归一化后相同）。 */
export function removeRule(workspaceRoot, idOrText) {
  const doc = loadRules(workspaceRoot);
  const needle = String(idOrText ?? '').trim();
  if (!needle) return { ok: false, error: '需要 id 或规则文本' };
  const before = doc.rules.length;
  const key = dedupeKey(needle);
  doc.rules = doc.rules.filter((r) => r.id !== needle && dedupeKey(r.text) !== key);
  if (doc.rules.length === before) return { ok: false, error: '没找到匹配的规则' };
  doc.updatedAt = new Date().toISOString();
  writeJsonAtomic(rulesPath(workspaceRoot), doc);
  return { ok: true, removed: before - doc.rules.length };
}

/** 列规则；role 给了就只列对该角色生效的（all + roles 含 role）。 */
export function listRules(workspaceRoot, opts = {}) {
  const doc = loadRules(workspaceRoot);
  const role = String(opts.role ?? '').trim();
  const rules = !role ? doc.rules : doc.rules.filter((r) => ruleAppliesTo(r, role));
  return { ok: true, rules, total: doc.rules.length };
}

/** 一条规则对某角色是否生效。 */
export function ruleAppliesTo(rule, role) {
  const scope = rule?.scope ?? { kind: 'all' };
  if (scope.kind === 'all') return true;
  if (scope.kind === 'roles') return Array.isArray(scope.roles) && scope.roles.includes(role);
  return false;
}

/**
 * 组装要注入系统提示词的规则块（纯函数）。role 提供时按 scope 过滤。
 * @param {string} workspaceRoot
 * @param {{role?:string, maxRules?:number}} [opts]
 * @returns {string}
 */
export function rulesSectionText(workspaceRoot, opts = {}) {
  const role = String(opts.role ?? '').trim();
  const doc = loadRules(workspaceRoot);
  let rules = role ? doc.rules.filter((r) => ruleAppliesTo(r, role)) : doc.rules;
  if (!rules.length) return '';
  const max = Number(opts.maxRules) > 0 ? Number(opts.maxRules) : MAX_RULES;
  const shown = rules.slice(-max);
  const lines = shown.map((r) => {
    const tag = r.tags?.length ? ` [${r.tags.join(',')}]` : '';
    const scopeNote = r.scope?.kind === 'roles' ? `（仅 ${r.scope.roles.join('/')}）` : '';
    return `- ${r.text}${tag}${scopeNote}`;
  });
  return [
    '## 工作区规则（.code-studio/memory/rules.json）',
    '以下是本工作区的长期纪律，必须遵守；与当前代码/指令冲突时以本条为准并向用户确认。',
    '',
    ...lines,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 自检：node lib/studio-rules.js
// ---------------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('studio-rules.js')) {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const assert = (c, m) => { if (!c) throw new Error(`studio-rules demo FAIL: ${m}`); };
  const ws = await mkdtemp(join(tmpdir(), 'cs-rules-'));
  try {
    // 空
    assert(listRules(ws).total === 0, 'empty rules');
    assert(rulesSectionText(ws) === '', 'empty section text');

    // 加 all 规则
    const a = addRule(ws, { text: '不要长时间卡在一个工具调用上，超过 3 分钟先回报', scope: 'all', tags: ['纪律'], createdBy: 'tech-lead' });
    assert(a.ok && !a.duplicate, 'add all rule');
    assert(listRules(ws).total === 1, 'one rule');

    // 同文去重（只更新 scope）
    const a2 = addRule(ws, { text: '  不要长时间卡在一个工具调用上，超过  3 分钟先回报  ', scope: 'tech-lead,reviewer' });
    assert(a2.duplicate === true, 'dedupe same text');
    assert(listRules(ws).total === 1, 'still one rule');
    assert(a2.rule.scope.kind === 'roles' && a2.rule.scope.roles.includes('reviewer'), 'scope updated on dedupe');

    // 角色过滤
    addRule(ws, { text: '提交前必须跑 node --check', scope: 'implementer,test' });
    const forReviewer = listRules(ws, { role: 'reviewer' });
    const forImplementer = listRules(ws, { role: 'implementer' });
    assert(forReviewer.rules.every((r) => ruleAppliesTo(r, 'reviewer')), 'reviewer filtered');
    assert(forImplementer.rules.some((r) => r.text.includes('node --check')), 'implementer sees own rule');
    assert(!forReviewer.rules.some((r) => r.text.includes('node --check')), 'reviewer does NOT see implementer rule');

    // 注入文本按 role 过滤
    const secImpl = rulesSectionText(ws, { role: 'implementer' });
    assert(secImpl.includes('node --check') && secImpl.includes('工作区规则'), 'section text for implementer');
    const secSec = rulesSectionText(ws, { role: 'security' });
    assert(!secSec.includes('node --check'), 'security does not see implementer-only rule');

    // session 级拒绝进 rules.json
    const s = addRule(ws, { text: '这次只改登录', scope: 'session' });
    assert(!s.ok, 'session scope rejected from rules.json');

    // 空文本拒绝
    assert(!addRule(ws, { text: '   ' }).ok, 'empty text rejected');

    // 超长截断
    const longAdd = addRule(ws, { text: 'x'.repeat(500) });
    assert(longAdd.rule.text.length === MAX_TEXT, 'text truncated to MAX_TEXT');

    // 删除
    const del = removeRule(ws, '提交前必须跑 node --check');
    assert(del.ok && del.removed === 1, 'remove by text');
    assert(!listRules(ws).rules.some((r) => r.text.includes('node --check')), 'removed rule gone');

    // 超过 MAX_RULES 滚动归档
    const ws2 = await mkdtemp(join(tmpdir(), 'cs-rules2-'));
    for (let i = 0; i < MAX_RULES + 5; i++) addRule(ws2, { text: `规则 ${i}` });
    const doc2 = loadRules(ws2);
    assert(doc2.rules.length === MAX_RULES, `capped at ${MAX_RULES}`);
    assert(existsSync(archivePath(ws2)), 'archive written when overflow');
    const arc = readJson(archivePath(ws2), { rules: [] });
    assert(arc.rules.length === 5, 'overflow 5 archived');
    await rm(ws2, { recursive: true, force: true });

    console.log('studio-rules: demo OK');
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}
