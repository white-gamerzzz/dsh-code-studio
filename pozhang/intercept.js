/**
 * 进程内拦截：直接接管 dsh 进程的出站 fetch（billion-context 用的就是这条路子）。
 *
 * 为什么不用 HTTP 代理：
 *   - 代理要求用户改每个 provider 的 Base URL，还要按前缀手工分流；
 *   - 进程内拦截天然知道"这次请求要发给谁"（URL 里就是该 provider 的上游），
 *     会话选哪个模型/哪家 provider，请求就流向哪家，不需要任何配置。
 *
 * 做的事很小：检查请求体里有没有破障正文与角色锚点，缺就补到 system/instructions 层，
 * 齐全就原样放行。不缓存、不改响应、不碰非 LLM 请求（只处理命中路由表主机的 JSON）。
 */

import { appendFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { decide, applyPatch, loadPrompt, systemText } from './patch.js';
import { loadRoutingTable } from './upstream.js';
import { installDispatcherInterceptor, dispatcherStatus } from './intercept-dispatcher.js';

/** 每次拦截写一行到 ~/.dsh/.pozhang-intercept.log，便于确认到底有没有补进 system。 */
function trace(entry) {
  try {
    const file = join(homedir(), '.dsh', '.pozhang-intercept.log');
    try {
      if (statSync(file).size > 1_000_000) writeFileSync(file, '');
    } catch {
      /* 文件还不存在 */
    }
    appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    /* 记日志失败不影响主流程 */
  }
}

const stats = {
  seen: 0,
  patched: 0,
  passed: 0,
  skipped: 0,
  lastAt: 0,
  byProvider: new Map(),
  installed: false,
  error: null,
};

let uninstall = null;

/** 当前被我们包住的那层 fetch（可能是 billion-context 的包装），可能被外部换成新的。 */
let deepBase = null;
let nextLayer = null;
let inFlight = 0;
/** 我们装上去的那层，用于判断自己是否还在最外层。 */
let installedFetch = null;
let reassertTimer = null;
let reasserts = 0;

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** 只处理"命中路由表主机"的请求：避免去改无关的 fetch（下载、插件市场等）。 */
function isLlmHost(host) {
  if (!host) return false;
  const table = loadRoutingTable();
  for (const route of table.routes) {
    const h = hostOf(route.baseURL);
    if (h && (host === h || host.endsWith('.' + h.split(':')[0]))) return true;
  }
  return false;
}

function providerOf(host) {
  const table = loadRoutingTable();
  for (const route of table.routes) {
    const h = hostOf(route.baseURL);
    if (h && (host === h || host.endsWith('.' + h.split(':')[0]))) return route.id;
  }
  return host;
}

function bodyToText(body) {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) {
    try {
      return new TextDecoder().decode(body);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 安装拦截器（幂等）。返回卸载函数。
 * @param {{onEvent?: (kind: string, detail: any) => void}} [opts]
 */
/**
 * 把自己放回 fetch 链的最外层：
 * 发现 globalThis.fetch 已被别人换掉，就把当前那层当作新的 base（不叠层），
 * 再把我们这层重新挂上去。这样无论谁后装，最终最外层都是破障。
 */
export function ensureOutermost() {
  if (!stats.installed || !installedFetch) return false;
  if (globalThis.fetch === installedFetch) return false;
  const next = globalThis.fetch;
  if (typeof next !== 'function' || next === installedFetch) return false;
  nextLayer = next;
  globalThis.fetch = installedFetch;
  reasserts += 1;
  return true;
}

export function installInterceptor({ onEvent } = {}) {
  if (stats.installed && uninstall) return uninstall;
  if (typeof globalThis.fetch !== 'function') {
    stats.error = 'globalThis.fetch 不可用';
    return () => {};
  }
  deepBase = globalThis.fetch;
  nextLayer = deepBase;

  const patched = async function fetchPatched(input, init) {
    // 别人（如 billion-context）的包装会回调“旧的那层”，也就是同一个函数。
    // 重入时直接落到最初的 fetch，否则会成环。
    if (inFlight > 0) return await deepBase.call(this, input, init);
    inFlight += 1;
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? '';
      const host = hostOf(url);
      const method = String(init?.method ?? (typeof input === 'object' && input?.method) ?? 'GET').toUpperCase();
      if (!isLlmHost(host) || method !== 'POST') return await nextLayer.call(this, input, init);

      // 两种入参形态都要能读：fetch(url, init) 的 init.body，以及 fetch(new Request(...))。
      // billion-context 之类在链条外层时会把 Request 直接递进来，只读 init.body 会静默失效。
      let text = init?.body == null ? null : bodyToText(init.body);
      let carrier = input;
      let carrierInit = init;
      if (text == null && typeof Request !== 'undefined' && input instanceof Request) {
        try {
          text = await input.clone().text();
          carrier = new Request(input);
          carrierInit = {};
        } catch {
          text = null;
        }
      }
      if (text == null) {
        stats.skipped += 1;
        return await nextLayer.call(this, input, init);
      }

      let body;
      try {
        body = JSON.parse(text);
      } catch {
        stats.skipped += 1;
        return await nextLayer.call(this, input, init);
      }

      stats.seen += 1;
      stats.lastAt = Date.now();
      const provider = providerOf(host);
      const row = stats.byProvider.get(provider) ?? { provider, seen: 0, patched: 0 };
      row.seen += 1;

      const prompt = loadPrompt();
      const d = prompt ? decide(body) : { action: 'pass' };
      let outText = null;
      if (prompt && d.action !== 'pass') {
        const applied = applyPatch(body, prompt, d.full);
        outText = JSON.stringify(applied.body);
        stats.patched += 1;
        row.patched += 1;
        trace({ provider, action: 'patch', where: applied.where, full: d.full, systemChars: systemText(body).length });
        onEvent?.('patch', { provider, where: applied.where, reason: d.reason });
      } else {
        stats.passed += 1;
      }
      stats.byProvider.set(provider, row);

      if (outText == null) return await nextLayer.call(this, carrier, carrierInit);

      if (typeof Request !== 'undefined' && carrier instanceof Request) {
        const headers = new Headers(carrierInit.headers ?? carrier.headers ?? {});
        headers.delete('content-length');
        headers.set('content-type', 'application/json');
        const next = new Request(carrier, { body: outText, headers });
        return await nextLayer.call(this, next, carrierInit);
      }
      const headers = new Headers(carrierInit?.headers ?? {});
      headers.delete('content-length');
      headers.set('content-type', 'application/json');
      return await nextLayer.call(this, carrier, { ...carrierInit, body: outText, headers });
    } catch (error) {
      stats.error = error instanceof Error ? error.message : String(error);
      return await (nextLayer ?? deepBase).call(this, input, init);
    } finally {
      inFlight -= 1;
    }
  };
;

  try {
    globalThis.fetch = patched;
    installedFetch = patched;
    stats.installed = true;
    stats.error = null;

    // 自愈式最外层：别人（如 billion-context）后装把 fetch 换成新的包装时，
    // 我们把自己的 base 指过去、再把自己放回最外层——保证破障先看到请求体、
    // 补完再交给下一层，不依赖插件加载顺序。
    reassertTimer = setInterval(ensureOutermost, 5000);
    reassertTimer.unref?.();
  } catch (error) {
    stats.error = error instanceof Error ? error.message : String(error);
  }

  // 第二层：undici dispatcher（dsh 实际走这条，fetch 层常常抓不到）
  const offDispatcher = installDispatcherInterceptor();

  uninstall = () => {
    if (reassertTimer) clearInterval(reassertTimer);
    reassertTimer = null;
    if (globalThis.fetch === patched) globalThis.fetch = nextLayer ?? deepBase;
    installedFetch = null;
    try { offDispatcher?.(); } catch { /* 已还原 */ }
    stats.installed = false;
    uninstall = null;
  };
  return uninstall;
}

export function uninstallInterceptor() {
  if (uninstall) uninstall();
}

export function interceptStatus() {
  return {
    installed: stats.installed,
    outermost: stats.installed && globalThis.fetch === installedFetch,
    reasserts,
    seen: stats.seen,
    patched: stats.patched,
    passed: stats.passed,
    skipped: stats.skipped,
    lastAt: stats.lastAt,
    error: stats.error,
    dispatcher: dispatcherStatus(),
    providers: [...stats.byProvider.values()].sort((a, b) => b.seen - a.seen),
  };
}
