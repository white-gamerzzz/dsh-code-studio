/**
 * 自动接管出站口：把 dsh 所有 provider 的 Base URL 指到本机破障中继。
 *
 * 目的：不管链路上叠了什么（上下文压缩插件、本地网关、反代），
 * dsh 的每一个模型请求都先到破障（补记忆/约定到 system 层），再由破障发往真实上游。
 *
 * 设计约束：
 *   - 幂等：已指向中继的跳过，不重复改写
 *   - 可回退：改写前备份 cordis.patch.yml；原始上游存 ~/.dsh/.pozhang-routes.json
 *   - 不猜上游：上游只从用户自己的 provider 配置里读，不从任何第三方插件推断
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const DSH = join(HOME, '.dsh');
const PROFILES = join(DSH, 'profiles');
export const ROUTES_FILE = join(DSH, '.pozhang-routes.json');

/** 与 upstream.js 一致的 provider 扫描，额外返回行号以便原地改写。 */
export function scanProviders(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inProv = false;
  let provIndent = -1;
  let cur = null;
  let curIndent = -1;
  lines.forEach((raw, i) => {
    if (!raw.trim() || raw.trim().startsWith('#')) return;
    const ind = raw.match(/^\s*/)[0].length;
    const trimmed = raw.trim();
    if (/^providers:\s*$/.test(trimmed)) { inProv = true; provIndent = ind; cur = null; return; }
    if (!inProv) return;
    if (ind <= provIndent) { inProv = false; cur = null; return; }
    const key = /^([A-Za-z0-9_.-]+):\s*$/.exec(trimmed);
    if (key && (cur === null || ind <= curIndent)) { cur = key[1]; curIndent = ind; return; }
    const b = /^(\s*baseURL:\s*['"]?)([^'"\s#]+)(['"]?\s*(?:#.*)?)$/.exec(raw);
    if (b && cur && ind > curIndent) out.push({ id: cur, baseURL: b[2], lineIndex: i, indent: b[1], tail: b[3] });
  });
  return out;
}

export function profileFiles() {
  const out = [];
  try {
    for (const d of readdirSync(PROFILES, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = join(PROFILES, d.name, 'cordis.patch.yml');
      if (existsSync(f)) out.push(f);
    }
  } catch { /* 无 profiles */ }
  return out;
}

export function loadSnapshot() {
  try { return JSON.parse(readFileSync(ROUTES_FILE, 'utf8')); } catch { return {}; }
}
function saveSnapshot(obj) {
  writeFileSync(ROUTES_FILE, JSON.stringify(obj, null, 2) + '\n');
}

const isRelay = (url, port) => new RegExp('^https?://(?:127\\.0\\.0\\.1|localhost):' + port + '(?:/|$)').test(String(url || ''));

/**
 * 是否是「已被破障接管」的地址形态：http://127.0.0.1:<任意端口>/<providerId>(/...)
 * 用形状而不是端口来认，这样端口从 8788 漂到 8789 时不会把旧地址误当成真实上游写进快照。
 */
function isRelayedForm(url, id) {
  const re = new RegExp('^http://(?:127\\.0\\.0\\.1|localhost):\\d+/' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:/|$)');
  return re.test(String(url || ''));
}

/**
 * 确保所有 provider 都经中继。返回 { changed, skipped, files }。
 * only 为空 = 全部接管（默认，符合"所有请求都经过破甲"的要求）。
 */
export function ensureRouted({ port, only = null, dryRun = false } = {}) {
  const p = Number(port);
  if (!p) throw new Error('缺少中继端口');
  const snap = loadSnapshot();
  const changed = [];
  const skipped = [];
  const files = [];

  for (const file of profileFiles()) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    const items = scanProviders(text);
    const targets = items.filter((x) => (only ? only.includes(x.id) : true));
    // 目标：把所有 provider 变成 http://127.0.0.1:<当前端口>/<id>...
    // 已是当前端口的算完成；旧端口/直连的都要改。
    const todo = targets.filter((x) => !isRelay(x.baseURL, p));
    for (const x of targets) {
      if (isRelay(x.baseURL, p)) skipped.push({ id: x.id, file });
    }
    if (!todo.length) continue;

    // 顺序不能反：先把真实上游记进快照，否则中继路由表会解析到中继自己（自环）。
    // 已经被接管过的地址不写快照（那不是真实上游）。
    for (const t of todo) {
      if (!isRelayedForm(t.baseURL, t.id)) snap[t.id] = t.baseURL;
    }

    const lines = text.split(/\r?\n/);
    for (const t of todo) {
      const u = new URL(t.baseURL);
      // 已经是接管形态（旧端口）时先剥掉 '/<id>' 段，否则会变成 /id/id/...
      let path = u.pathname;
      if (isRelayedForm(t.baseURL, t.id)) {
        path = path.replace(new RegExp('^/' + t.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '') || '/';
      }
      const suffix = path && path !== '/' ? path.replace(/\/+$/, '') : '';
      lines[t.lineIndex] = `${t.indent}http://127.0.0.1:${p}/${t.id}${suffix}${t.tail}`;
      changed.push({ id: t.id, from: t.baseURL, to: `http://127.0.0.1:${p}/${t.id}${suffix}`, file });
    }
    if (!dryRun) {
      // 只在首次接管时备份：否则备份的会是“已接管版”，回退就退不回去了。
      const dir = join(file, '..');
      const hasBak = readdirSync(dir).some((n) => n.startsWith('cordis.patch.yml.bak-pozhang-'));
      if (!hasBak) {
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        copyFileSync(file, `${file}.bak-pozhang-${stamp}`);
      }
      writeFileSync(file, lines.join('\n'));
    }
    files.push(file);
  }

  if (!dryRun && changed.length) saveSnapshot(snap);
  return { changed, skipped, files, port: p };
}

/** 从最近一次备份还原所有 profile 配置。 */
export function restoreRouted() {
  const restored = [];
  for (const file of profileFiles()) {
    const dir = join(file, '..');
    let baks = [];
    try {
      baks = readdirSync(dir).filter((n) => n.startsWith('cordis.patch.yml.bak-pozhang-')).sort();
    } catch { continue; }
    if (!baks.length) continue;
    // 取最早那份 = 首次接管前的原始配置
    copyFileSync(join(dir, baks[0]), file);
    restored.push({ file, from: baks[0] });
  }
  return restored;
}

/** 当前接管状态：哪些 provider 已在中继后面。 */
export function routeStatus({ port }) {
  const p = Number(port);
  const rows = [];
  for (const file of profileFiles()) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const x of scanProviders(text)) {
      rows.push({ id: x.id, baseURL: x.baseURL, relayed: isRelay(x.baseURL, p) || isRelayedForm(x.baseURL, x.id), file });
    }
  }
  const total = rows.length;
  const relayed = rows.filter((r) => r.relayed).length;
  return { rows, total, relayed, all: total > 0 && relayed === total };
}
