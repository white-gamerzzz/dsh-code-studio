/**
 * provider 路由表：从 dsh 的 profile 配置里读「provider id → baseURL」。
 *
 * 为什么不是"全局一个上游"：用户完全可能把 gpt / claude / 国产模型分别配在不同网关，
 * 取多数票会静默把请求送到错误的上游。正确做法是像 billion-context 那样**按路由分发**：
 * 请求带 provider 前缀（/qg/v1/...）就按该 provider 的上游转发。
 *
 * 只读解析 cordis.patch.yml，不写任何 dsh 配置。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DSH = join(homedir(), '.dsh');

/**
 * 轻量 YAML 扫描：抓 providers 块里的 `id:` 与紧随其后的 `baseURL:`。
 * 不引 yaml 依赖——只认这两个键，且以缩进回退作为块结束。
 */
export function parseProviders(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let inProviders = false;
  let providersIndent = -1;
  let current = null;
  let currentIndent = -1;

  const indentOf = (l) => l.match(/^\s*/)[0].length;

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const ind = indentOf(raw);
    const trimmed = raw.trim();

    if (/^providers:\s*$/.test(trimmed)) {
      inProviders = true;
      providersIndent = ind;
      current = null;
      continue;
    }
    if (!inProviders) continue;
    if (ind <= providersIndent) {
      // 出了 providers 块
      inProviders = false;
      current = null;
      continue;
    }

    const keyMatch = /^([A-Za-z0-9_.-]+):\s*$/.exec(trimmed);
    if (keyMatch && (current === null || ind <= currentIndent)) {
      current = keyMatch[1];
      currentIndent = ind;
      continue;
    }

    const baseMatch = /^baseURL:\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/.exec(trimmed);
    if (baseMatch && current && ind > currentIndent) {
      const url = baseMatch[1].replace(/\/+$/, '');
      if (/^https?:\/\//i.test(url)) out.push({ id: current, baseURL: url });
    }
  }
  return out;
}

function profileDirs() {
  const root = join(DSH, 'profiles');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(root, d.name, 'cordis.patch.yml'))
    .filter((f) => existsSync(f));
}

let cache = { at: 0, table: null };

/**
 * @param {{fresh?: boolean}} [opts]
 * @returns {{routes: {id: string, baseURL: string}[], byId: Map<string,string>, primary: string|null}}
 */
/** 切换过一次的原始上游快照：{ providerId: baseURL }。 */
export function readSavedRoutes() {
  try {
    const f = join(DSH, '.pozhang-routes.json');
    if (!existsSync(f)) return {};
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

export function loadRoutingTable({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cache.table && now - cache.at < 5000) return cache.table;

  // 用户把 provider 的 Base URL 指到本机中继后，配置文件里的地址就变成了中继自己。
  // 真实上游另存在 ~/.dsh/.pozhang-routes.json（切换时的快照），这里优先用它，
  // 否则会出现「中继转发给自己」的死循环。
  const saved = readSavedRoutes();
  const selfRe = new RegExp('^https?://(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):' + (process.env.POZHANG_PORT || 8788) + '(?:/|$)');
  const isSelf = (url) => selfRe.test(String(url || ''));

  const files = [join(DSH, 'cordis.patch.yml'), ...profileDirs()].filter((f) => existsSync(f));
  const byId = new Map();
  const routes = [];
  for (const file of files) {
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const item of parseProviders(text)) {
      if (byId.has(item.id)) continue;
      const real = saved[item.id] && saved[item.id] !== item.baseURL ? saved[item.id] : item.baseURL;
      if (isSelf(item.baseURL) && !saved[item.id]) continue; // 指到中继但不知原始上游，跳过
      byId.set(item.id, real);
      routes.push({ id: item.id, baseURL: real });
    }
  }
  const primary = routes[0]?.baseURL ?? null;
  const table = { routes, byId, primary };
  cache = { at: now, table };
  return table;
}

/** 兼容旧调用：返回单一上游（多供应商时返回第一个，仅作兜底）。 */
export function detectUpstream() {
  const t = loadRoutingTable();
  return { upstream: t.primary, candidates: t.routes.map((r) => ({ url: r.baseURL, count: 1, source: r.id })) };
}

/** 文件变更了就失效（供 mtime 检查用，暂未启用）。 */
export function touchedRecently() {
  try {
    return statSync(join(DSH, 'profiles')).mtimeMs;
  } catch {
    return 0;
  }
}
