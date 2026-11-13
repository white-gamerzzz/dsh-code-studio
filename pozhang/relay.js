#!/usr/bin/env node
/**
 * pozhang relay — 拦截转发式破障
 *
 * 两种用法：
 *   1) 插件内嵌（推荐）：index.js 调 createRelay() 在 dsh 进程里起一个 HTTP 服务，
 *      生命周期天然等于 dsh，不用 spawn、没有子进程被回收的问题。
 *   2) 独立进程：node pozhang/relay.js --listen 8788 --upstream ...（调试/外部托管用）
 *
 * 资源模型（与 billion-context 一致）：一个服务、一个端口、所有会话共享；
 * 会话只登记元数据，空闲 TTL 淘汰，无会话级常驻资源。
 *
 * 每个 POST：解析 → 判定破障正文 + 角色锚点是否存在 → 缺则补到 system 层 → 转发；
 * 齐全则原样透传。管理面：/_pozhang/health、/_pozhang/panel（不回传上游）。
 */

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { argv, exit } from 'node:process';
import { loadRoutingTable } from './upstream.js';
import { loadPrompt, decide, applyPatch, resolveTarget, pickRoute } from './patch.js';
import { interceptStatus } from './intercept.js';

export { IDENTITY, ROLE_HINT, loadPrompt, decide, applyPatch } from './patch.js';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decode(raw, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(raw);
    if (encoding === 'deflate') return zlib.inflateSync(raw);
    if (encoding === 'br') return zlib.brotliDecompressSync(raw);
  } catch {
    /* 解不开按原文 */
  }
  return raw;
}

function sessionKey(req, body) {
  const h = req.headers;
  const fromHeader = h['x-acp-session'] || h['x-dsh-session'] || h['x-session-id'] || h['x-conversation-id'];
  if (fromHeader) return String(fromHeader);
  if (body && typeof body === 'object') {
    const cand = body.session_id || body.sessionId || body.metadata?.session_id || body.metadata?.user_id;
    if (cand) return String(cand);
  }
  return 'ip:' + (req.socket.remoteAddress || 'unknown');
}

function panelHtml(sessionTtlMs) {
  return `<!doctype html><html lang="zh"><meta charset="utf-8">
<title>破障中继</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#0b1210;color:#d7e4de;font:14px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif}
header{padding:16px 22px;border-bottom:1px solid #1e2f2a;display:flex;gap:14px;align-items:baseline}
h1{font-size:17px;margin:0;color:#34d399;font-weight:600}
.meta{color:#7d968e;font-size:12px}
main{padding:18px 22px;display:grid;gap:16px}
.cards{display:flex;gap:12px;flex-wrap:wrap}
.card{background:#121c19;border:1px solid #1e2f2a;border-radius:10px;padding:12px 16px;min-width:120px}
.card b{display:block;font-size:22px;color:#34d399;font-weight:600;line-height:1.2}
.card span{font-size:12px;color:#7d968e}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #1a2724}
th{color:#7d968e;font-weight:500;font-size:12px}
code{background:#0e1916;padding:1px 6px;border-radius:4px;color:#8fd3b8}
footer{padding:0 22px 22px;color:#5f736c;font-size:12px}
</style>
<header><h1>破障中继</h1><span class="meta" id="meta">连接中…</span></header>
<main>
  <div class="cards">
    <div class="card"><b id="sessions">0</b><span>活跃会话</span></div>
    <div class="card"><b id="patched">0</b><span>补丁次数</span></div>
    <div class="card"><b id="passed">0</b><span>原样放行</span></div>
    <div class="card"><b id="uptime">0m</b><span>运行时长</span></div>
  </div>
  <table><thead><tr><th>会话</th><th>请求</th><th>补丁</th><th>放行</th><th>最后活动</th></tr></thead>
  <tbody id="rows"><tr><td colspan="5" style="color:#5f736c">暂无会话</td></tr></tbody></table>
</main>
<footer>单进程共享一个端口；会话表只记录元数据，空闲 ${Math.round(sessionTtlMs / 60000)} 分钟后自动淘汰。</footer>
<script>
const fmt=(ms)=>ms<60000?Math.round(ms/1000)+'s':ms<3600000?Math.round(ms/60000)+'m':Math.round(ms/3600000)+'h';
async function tick(){
  try{
    const r=await fetch('/_pozhang/health');const d=await r.json();
    document.getElementById('meta').textContent=d.prompt?('上游 '+d.upstream+' · 正文 '+d.promptChars+' 字符 · 端口 '+d.port):'未找到破障正文';
    document.getElementById('sessions').textContent=d.activeSessions;
    document.getElementById('patched').textContent=d.stats.patched;
    document.getElementById('passed').textContent=d.stats.pass;
    document.getElementById('uptime').textContent=fmt(d.uptimeMs);
    const rows=d.sessions.map(s=>'<tr><td><code>'+s.key.slice(0,26)+'</code></td><td>'+s.requests+'</td><td>'+s.patched+'</td><td>'+(s.requests-s.patched)+'</td><td>'+fmt(Date.now()-s.lastSeen)+'前</td></tr>').join('');
    document.getElementById('rows').innerHTML=rows||'<tr><td colspan="5" style="color:#5f736c">暂无会话</td></tr>';
  }catch(e){document.getElementById('meta').textContent='中继未响应';}
}
tick();setInterval(tick,3000);
</script></html>`;
}

/**
 * 创建中继服务（不自动 listen）。
 * @returns {{ server: import('node:http').Server, listen: Function, close: Function, stats: object, sessions: Map }}
 */
/** 证书链不完整的主机（Electron 宽松、Node 严格），降级一次后记住。 */
const tlsLoose = new Set();

export function createRelay({ port = 8788, upstream = 'https://api.deepseek.com', verbose = false, dryRun = false, sessionTtlMs = 10 * 60 * 1000, via: viaArg = null } = {}) {
  // via = 本机 billion-context 代理 {port, lane}：有它就把请求交给它做上下文压缩。
  const chainTimeoutMs = Number(process.env.POZHANG_CHAIN_TIMEOUT_MS || 180_000);
  let via = viaArg;
  let viaDown = false;
  const sessions = new Map();
  // viaFallback：bili 不可达而降级直连的次数；viaTimeout：bili 接住但没回头的次数
  const stats = { pass: 0, patched: 0, nonJson: 0, viaFallback: 0, viaTimeout: 0, chain: 0, direct: 0 };
  const startedAt = Date.now();

  const sweep = () => {
    const now = Date.now();
    for (const [k, s] of sessions) if (now - s.lastSeen > sessionTtlMs) sessions.delete(k);
  };
  const touch = (key) => {
    const now = Date.now();
    const s = sessions.get(key) || { key, firstSeen: now, requests: 0, patched: 0, passed: 0, lastSeen: now };
    s.lastSeen = now;
    s.requests += 1;
    sessions.set(key, s);
    return s;
  };

  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';

    if (url === '/_pozhang/health') {
      sweep();
      const prompt = loadPrompt();
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        // 设置页在 dsh 客户端里跨端口读状态，需要 CORS（仅本机回环监听）
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify({
        ok: true,
        port,
        upstream: loadRoutingTable().primary,
        routes: loadRoutingTable().routes,
        prompt: !!prompt,
        promptChars: prompt ? prompt.length : 0,
        uptimeMs: Date.now() - startedAt,
        via: via ? { port: Number(via.port), lane: via.lane ?? null, version: via.version ?? null, down: viaDown } : null,
        intercept: interceptStatus(),
        activeSessions: sessions.size,
        stats,
        sessionTtlMs,
        sessions: [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 30),
      }));
      return;
    }
    if (url === '/_pozhang/panel') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' });
      res.end(panelHtml(sessionTtlMs));
      return;
    }

    const table = loadRoutingTable();
    const route = pickRoute(url, table);
    if (!route) {
      res.writeHead(400, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify({
        error: 'NO_PROVIDER_ROUTE',
        message: '请求路径没有带 provider 前缀，且当前配置了多个提供商，无法判断该转发到哪一家。',
        hint: '/<provider>/v1/... ，例如 /qg/v1/chat/completions',
        routes: table.routes,
      }));
      return;
    }
    const headers = { ...req.headers };
    let bodyOut = null;

    if (req.method === 'POST') {
      const raw = await readBody(req);
      const decoded = decode(raw, String(req.headers['content-encoding'] || '').toLowerCase());
      let body = null;
      try {
        body = JSON.parse(decoded.toString('utf8'));
      } catch {
        stats.nonJson++;
      }
      const prompt = loadPrompt();
      bodyOut = decoded;
      if (body && prompt) {
        const s = touch(sessionKey(req, body));
        s.provider = route.provider;
        const d = decide(body);
        if (d.action === 'pass') {
          stats.pass++;
          s.passed += 1;
        } else {
          const r = applyPatch(body, prompt, d.full);
          bodyOut = Buffer.from(JSON.stringify(r.body));
          stats.patched++;
          s.patched += 1;
          if (verbose) console.log(`[patch] ${d.reason} -> ${r.where} (session ${s.key.slice(0, 16)})`);
        }
        if (dryRun) {
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end(JSON.stringify({ dryRun: true, decision: d.action, reason: d.reason, stats }));
          return;
        }
      }
      delete headers['content-encoding'];
      delete headers['content-length'];
      if (body) headers['content-type'] = 'application/json';
    }

    const target = resolveTarget(route.path, route.base);
    // 兜底：转发目标指回自己 = 无限自环。宁可 502 也不让请求原地打转。
    if (Number(target.port || (target.protocol === 'https:' ? 443 : 80)) === Number(port)
      && /^(127\.0\.0\.1|localhost)$/.test(target.hostname)) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: 'SELF_LOOP',
        message: '转发目标解析到了中继自己，已阻断以免无限循环。',
        hint: '检查 ~/.dsh/.pozhang-routes.json 是否记录了真实上游；或执行 node pozhang/route-switch.mjs off 回退。',
        provider: route.provider,
      }));
      return;
    }
    const isHttps = target.protocol === 'https:';
    const mod = isHttps ? https : http;
    const upstreamHeaders = { ...headers, host: target.host };
    if (bodyOut) upstreamHeaders['content-length'] = String(bodyOut.length);

    // mode: 'chain' 走 bili（absolute-form）、'direct' 直连、'insecure' 直连且跳过证书校验
    const buildReq = (mode) => {
      if (mode === 'chain' && via) {
        const r = http.request({
          host: '127.0.0.1',
          port: Number(via.port),
          method: req.method,
          path: target.href, // absolute-form：让 bili 认出真实上游
          headers: upstreamHeaders,
        }, (upRes) => {
          stats.chain += 1;
          res.writeHead(upRes.statusCode || 502, upRes.headers);
          upRes.pipe(res);
        });
        // bili 接住但永不回头 → 504，不让客户端无限等待（不重试，避免重复生成）
        r.setTimeout(chainTimeoutMs, () => {
          stats.viaTimeout += 1;
          if (!res.headersSent) {
            res.writeHead(504, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'CHAIN_TIMEOUT', message: `billion-context ${Math.round(chainTimeoutMs / 1000)} 秒无响应，已终止本次请求。`, hint: '在设置页关闭「链式压缩」或 /hz chain off 可直连上游。' }));
          }
          r.destroy();
        });
        return r;
      }
      return mod.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method: req.method,
        headers: upstreamHeaders,
        ...(mode === 'insecure' ? { rejectUnauthorized: false } : {}),
      }, (upRes) => {
        if (mode === 'direct' || mode === 'insecure') stats.direct += 1;
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      });
    };

    const isCertError = (e) => /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|unable to verify|altnames/i.test(String(e?.code ?? '') + ' ' + String(e?.message ?? ''));
    const isConnError = (e) => /ECONNREFUSED|ECONNRESET|EPIPE|EHOSTUNREACH/i.test(String(e?.code ?? ''));
    let attempts = 0;

    const attach = (upReq, mode) => {
      upReq.on('error', (e) => {
        // bili 不可用 → 直连兜底一次（连接阶段失败，请求体还没发出去，重试安全）
        if (mode === 'chain' && bodyOut && attempts === 0 && isConnError(e)) {
          attempts += 1;
          viaDown = true;
          stats.viaFallback += 1;
          verbose && console.warn('[relay] bili 不可达，本次降级直连:', via?.port);
          const retry = buildReq('direct');
          attach(retry, 'direct');
          retry.end(bodyOut);
          return;
        }
        if (mode === 'direct' && bodyOut && attempts === 0 && isHttps && isCertError(e)) {
          attempts += 1;
          tlsLoose.add(target.hostname);
          verbose && console.warn('[relay] 证书链不完整，降级宽松校验:', target.hostname);
          const retry = buildReq('insecure');
          attach(retry, 'insecure');
          retry.end(bodyOut);
          return;
        }
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'relay upstream failed',
          detail: String(e && e.message),
          via: mode === 'chain' ? 'bili' : 'direct',
        }));
      });
    };

    const mode = via && !viaDown ? 'chain' : (tlsLoose.has(target.hostname) ? 'insecure' : 'direct');
    const upReq = buildReq(mode);
    attach(upReq, mode);
    if (bodyOut) upReq.end(bodyOut);
    else req.pipe(upReq);
  });

  const listen = () => new Promise((resolve, reject) => {
    const onError = (e) => reject(e);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve({ port, upstream });
    });
  });

  const close = () => new Promise((resolve) => {
    server.close(() => resolve(true));
    // 已升级的长连接不会自动断，给个上限
    setTimeout(() => resolve(true), 800).unref?.();
  });

  return { server, listen, close, stats, sessions, setVia(v) { via = v; viaDown = false; }, getVia: () => ({ via, viaDown }) };
}

// ---------------------------------------------------------------- CLI
const isCli = argv[1] && argv[1].replace(/\\/g, '/').endsWith('/pozhang/relay.js');
if (isCli) {
  const args = argv.slice(2);
  const getArg = (name, dflt) => {
    const i = args.indexOf('--' + name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const relay = createRelay({
    port: Number(getArg('listen', 8788)),
    upstream: getArg('upstream', 'https://api.deepseek.com'),
    verbose: args.includes('--verbose'),
    dryRun: args.includes('--dry-run'),
  });
  relay.listen().then(({ port }) => {
    const p = loadPrompt();
    console.log(`[relay] http://127.0.0.1:${port}`);
    console.log(`[relay] 面板 http://127.0.0.1:${port}/_pozhang/panel`);
    console.log(`[relay] 正文 ${p ? p.length + ' 字符' : '未找到（~/.dsh/AGENTS.md 无破障块）'}`);
  }).catch((e) => {
    console.error('[relay] 启动失败:', e.code === 'EADDRINUSE' ? '端口已被占用' : String(e.message));
    exit(1);
  });
  process.on('SIGINT', () => {
    console.log(`\n[relay] 退出 pass=${relay.stats.pass} patched=${relay.stats.patched}`);
    exit(0);
  });
}
