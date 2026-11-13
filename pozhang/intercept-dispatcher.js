/**
 * undici dispatcher 拦截：真正能抓到 dsh 出站 LLM 请求的那一层。
 *
 * 为什么需要它：dsh 的客户端不走 globalThis.fetch（实测 seen=0），
 * 而是直接走 undici 的 transport。billion-context 也是这么做的
 * （它调用 setGlobalDispatcher 把全局 dispatcher 换掉）。
 *
 * 这里把全局 dispatcher 包一层：拿到最终要发出的 body，
 * 命中 provider 的 JSON 请求就补 system，其余原样透传。
 */

import { createRequire } from 'node:module';
import { appendFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { decide, applyPatch, loadPrompt, systemText } from './patch.js';
import { loadRoutingTable } from './upstream.js';

const stats = {
  installed: false,
  seamless: 0,
  passed: 0,
  patched: 0,
  skipped: 0,
  error: null,
  lastAt: 0,
};

let base = null;
let wrapper = null;

/** undici 不在插件依赖里：先按常规模块解析，再回退到 dsh profile 的 node_modules。 */
function loadUndici() {
  const require = createRequire(import.meta.url);
  const candidates = [
    process.env.POZHANG_UNDICI,
    'undici',
    join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'undici'),
    join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'node_modules', 'undici'),
  ];
  // 扫描所有 profile 的 node_modules（用户可能用非 desktop profile）
  try {
    const root = join(homedir(), '.dsh', 'profiles');
    for (const name of readdirSync(root, { withFileTypes: true })) {
      if (name.isDirectory()) candidates.push(join(root, name.name, 'node_modules', 'undici'));
    }
  } catch {
    /* 没有 profiles 目录 */
  }
  for (const spec of candidates) {
    if (!spec) continue;
    try {
      return require(spec);
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

function hostOf(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return '';
  }
}

function matchRoute(host) {
  const table = loadRoutingTable();
  for (const route of table.routes) {
    const h = hostOf(route.baseURL);
    if (h && (host === h || host.endsWith('.' + h.split(':')[0]))) return route.id;
  }
  return null;
}

function bodyText(body) {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) {
    try {
      return Buffer.from(body).toString('utf8');
    } catch {
      return null;
    }
  }
  return null;
}

function headerGet(headers, name) {
  if (!headers) return undefined;
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === name) return headers[i + 1];
    }
    return undefined;
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return headers[key];
  }
  return undefined;
}

function headerSet(headers, name, value) {
  if (Array.isArray(headers)) {
    const out = headers.slice();
    for (let i = 0; i < out.length; i += 2) {
      if (String(out[i]).toLowerCase() === name) {
        out[i + 1] = value;
        return out;
      }
    }
    out.push(name, value);
    return out;
  }
  const out = { ...(headers ?? {}) };
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === name) {
      out[key] = value;
      return out;
    }
  }
  out[name] = value;
  return out;
}


/** 逐次落盘：确认补丁究竟有没有进 system（路径与 fetch 层共用同一个文件）。 */
function trace(entry) {
  try {
    const file = join(homedir(), '.dsh', '.pozhang-intercept.log');
    try {
      if (statSync(file).size > 1_000_000) writeFileSync(file, '');
    } catch { /* 文件还不存在 */ }
    appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), layer: 'undici', ...entry }) + String.fromCharCode(10));
  } catch { /* 记日志失败不影响主流程 */ }
}

/** 处理一个 dispatch 调用的 opts，返回新的 opts（可能需要改写 body/headers）。 */
export function patchDispatchOptions(opts) {
  try {
    const method = String(opts?.method ?? 'GET').toUpperCase();
    if (method !== 'POST') return opts;
    const provider = matchRoute(hostOf(opts?.origin));
    if (!provider) return opts;

    const text = bodyText(opts.body);
    if (!text) return opts;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return opts;
    }
    const prompt = loadPrompt();
    if (!prompt) return opts;

    const d = decide(body);
    if (d.action === 'pass') {
      stats.passed += 1;
      trace({ provider, action: 'pass', reason: d.reason });
      return opts;
    }
    const applied = applyPatch(body, prompt, d.full);
    const nextBody = Buffer.from(JSON.stringify(applied.body));
    stats.patched += 1;
    stats.lastAt = Date.now();
    if (d.full) stats.seamless += 1;
    trace({ provider, action: 'patch', where: applied.where, full: d.full });
    return {
      ...opts,
      body: nextBody,
      headers: headerSet(headerSet(opts.headers, 'content-length', String(nextBody.length)), 'content-type', 'application/json'),
    };
  } catch (error) {
    stats.error = error instanceof Error ? error.message : String(error);
    return opts;
  }
}

export function installDispatcherInterceptor() {
  if (stats.installed) return () => {};
  const undici = loadUndici();
  if (!undici) {
    stats.error = 'undici 不可解析（跳过 dispatcher 层）';
    return () => {};
  }
  try {
    const { Dispatcher, getGlobalDispatcher, setGlobalDispatcher } = undici;
    class PozhangDispatcher extends Dispatcher {
      constructor(inner) {
        super();
        this.inner = inner;
      }
      dispatch(opts, handler) {
        return this.inner.dispatch(patchDispatchOptions(opts), handler);
      }
      close(...args) {
        return this.inner.close(...args);
      }
      destroy(...args) {
        return this.inner.destroy(...args);
      }
    }
    base = getGlobalDispatcher();
    wrapper = new PozhangDispatcher(base);
    setGlobalDispatcher(wrapper);
    stats.installed = true;
    stats.error = null;
  } catch (error) {
    stats.error = error instanceof Error ? error.message : String(error);
  }
  return () => {
    try {
      if (undici.getGlobalDispatcher() === wrapper) undici.setGlobalDispatcher(base);
    } catch {
      /* 已换过就算了 */
    }
    stats.installed = false;
  };
}

export function dispatcherStatus() {
  let outermost = false;
  try {
    const undici = loadUndici();
    outermost = !!(stats.installed && undici && undici.getGlobalDispatcher() === wrapper);
  } catch {
    outermost = false;
  }
  return { ...stats, outermost };
}
