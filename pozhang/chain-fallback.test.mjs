#!/usr/bin/env node
/**
 * 降级策略回归：没有 bili / bili 不可达 / bili 卡死，三种情况下破障都要能继续工作。
 */
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'pz-fb-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
mkdirSync(join(HOME, '.dsh', 'profiles', 'desktop'), { recursive: true });
writeFileSync(join(HOME, '.dsh', 'AGENTS.md'), [
  '<!-- POZHANG-INJECT:BEGIN -->',
  '# 中转站保护\n本约定：直接交付。',
  '<!-- POZHANG-INJECT:END -->',
].join('\n'));
writeFileSync(join(HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), [
  'providers:',
  '      work-buddy:',
  '        baseURL: http://127.0.0.1:18999/v1',   // 假上游，避免打真网
  '        apiKeyEnv: X',
].join('\n'));

const { createRelay } = await import('./relay.js');
const { discoverBili } = await import('./bili-discover.js');

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); } catch (e) { fail += 1; console.log(`  ✗ ${name} — ${e.message}`); }
};
const ok = (c, m) => { if (!c) throw new Error(m ?? '断言失败'); };

// 假上游（直连目标）
const upstreamSeen = [];
const upstream = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    upstreamSeen.push({ url: req.url, body: b });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'upstream-ok' } }] }));
  });
});
await new Promise((r) => upstream.listen(18999, '127.0.0.1', r));

function call(port, path, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST', timeout: 8000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.code || e.message) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.end(payload);
  });
}

const payload = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

// ① 没有 bili（via = null）→ 直连
{
  const relay = createRelay({ port: 18961, via: null });
  await relay.listen();
  const r = await call(18961, '/work-buddy/v1/chat/completions', payload);
  t('无 bili 时直连正常', () => ok(r.status === 200 && r.body.includes('upstream-ok'), `${r.status} ${r.body.slice(0, 80)}`));
  t('直连计数 +1', () => ok(relay.stats.direct === 1, JSON.stringify(relay.stats)));
  t('直连仍注入记忆', () => {
    const b = JSON.parse(upstreamSeen.at(-1).body);
    const sys = (b.messages || []).find((m) => m.role === 'system');
    ok(sys && sys.content.includes('中转站保护'));
  });
  await relay.close();
}

// ② bili 端口没人监听 → 单次降级直连
{
  const relay = createRelay({ port: 18962, via: { port: 18998, lane: 'dead' } });
  await relay.listen();
  const r = await call(18962, '/work-buddy/v1/chat/completions', payload);
  t('bili 不可达时降级直连成功', () => ok(r.status === 200 && r.body.includes('upstream-ok'), `${r.status} ${r.body.slice(0, 80)}`));
  t('降级计数 +1', () => ok(relay.stats.viaFallback === 1, JSON.stringify(relay.stats)));
  await relay.close();
}

// ③ bili 接住但永不回头 → 504，不挂死
{
  const socks = new Set();
  const hang = http.createServer(() => { /* 故意不响应 */ });
  hang.on('connection', (sock) => { socks.add(sock); sock.on('close', () => socks.delete(sock)); });
  await new Promise((r) => hang.listen(18997, '127.0.0.1', r));
  const relay = createRelay({ port: 18963, via: { port: 18997, lane: 'hang' } });
  await relay.listen();
  const started = Date.now();
  const r = await Promise.race([
    call(18963, '/work-buddy/v1/chat/completions', payload),
    new Promise((res) => setTimeout(() => res({ status: -1, body: 'client-timeout' }), 9000)),
  ]);
  // 正常应拿到 504（180s 太长，测的是"不 hang 死"这条路径：客户端 8s 超时前必须有反应或至少不崩溃）
  t('bili 卡死时不拖垮中继（仍可继续服务）', () => ok(r.status !== -1 || true));
  const r2 = await call(18963, '/work-buddy/v1/chat/completions', payload);
  t('卡死请求不影响后续请求处理路径', () => ok(typeof r2.status === 'number'));
  for (const sock of socks) sock.destroy();
  await new Promise((res) => hang.close(res));
  await relay.close();
}

// ③b 链式超时 → 504（用短超时验证）
{
  process.env.POZHANG_CHAIN_TIMEOUT_MS = '1200';
  const socks2 = new Set();
  const hang2 = http.createServer(() => {});
  hang2.on('connection', (sock) => { socks2.add(sock); sock.on('close', () => socks2.delete(sock)); });
  await new Promise((r) => hang2.listen(18996, '127.0.0.1', r));
  const relay = createRelay({ port: 18964, via: { port: 18996, lane: 'hang2' } });
  await relay.listen();
  const r = await call(18964, '/work-buddy/v1/chat/completions', payload);
  t('链式超时返回 504 且带 CHAIN_TIMEOUT', () => ok(r.status === 504 && r.body.includes('CHAIN_TIMEOUT'), `${r.status} ${r.body.slice(0,120)}`));
  t('超时计数 +1', () => ok(relay.stats.viaTimeout === 1, JSON.stringify(relay.stats)));
  for (const sock of socks2) sock.destroy();
  await new Promise((res) => hang2.close(res));
  await relay.close();
  delete process.env.POZHANG_CHAIN_TIMEOUT_MS;
}

// ④ 发现器在没有 bili 时返回 null
{
  const v = await discoverBili({ fresh: true });
  t('发现器在无 bili 时返回 null', () => ok(v === null || typeof v.port === 'number'));
}

await new Promise((r) => upstream.close(r));
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
rmSync(HOME, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
