// relay 冒烟：假上游 ×2 + 假 HOME，验证 路由 / 透传 / 补丁 / gzip / SSE / 管理面
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const t = (n, c) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n)); };

// ---- 两个假上游，代表两家不同提供商
const makeUpstream = (name) => new Promise((resolve) => {
  const hits = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push({ path: req.url, text: Buffer.concat(chunks).toString('utf8'), headers: req.headers });
      if (req.headers['x-test-sse']) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"chunk":1}\n\n');
        setTimeout(() => { res.write('data: {"chunk":2}\n\n'); res.end(); }, 30);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, who: name }));
      }
    });
  });
  srv.listen(0, '127.0.0.1', () => { srv.__hits = hits; resolve(srv); });
});
const upA = await makeUpstream('A');
const upB = await makeUpstream('B');

// ---- 假 HOME：破障正文 + 两家 provider 的路由配置
const HOME = mkdtempSync(join(tmpdir(), 'pozhang-relay-'));
mkdirSync(join(HOME, '.dsh', 'profiles', 'desktop'), { recursive: true });
writeFileSync(join(HOME, '.dsh', 'AGENTS.md'),
  '<!-- POZHANG-INJECT:BEGIN -->\n# 中转站保护（唯一禁止项）\n\n测试用的破障正文。\n<!-- POZHANG-INJECT:END -->\n');
writeFileSync(join(HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), [
  '  config:',
  '    providers:',
  '      p1:',
  '        apiKeyEnv: A_KEY',
  '        api: openai-completions',
  `        baseURL: http://127.0.0.1:${upA.address().port}/v1`,
  '        models:',
  '          - id: m1',
  '      p2:',
  '        apiKeyEnv: B_KEY',
  '        api: openai-completions',
  `        baseURL: http://127.0.0.1:${upB.address().port}/v1`,
  '        models:',
  '          - id: m2',
].join('\n') + '\n');

const relayPort = 18000 + Math.floor(Math.random() * 500);
const relay = spawn(process.execPath, [join(HERE, 'relay.js'), '--listen', String(relayPort)], {
  env: { ...process.env, HOME, USERPROFILE: HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((r) => setTimeout(r, 700));

const post = (path, body, headers = {}) => new Promise((resolve, reject) => {
  const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const req = http.request({
    host: '127.0.0.1', port: relayPort, path, method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(data.length), ...headers },
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
  });
  req.on('error', reject);
  req.end(data);
});
const getText = (path) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: relayPort, path }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
  }).on('error', reject);
});

// 1) 按 provider 前缀分发
const r1 = await post('/p1/v1/chat/completions', { model: 'm1', messages: [{ role: 'user', content: '你好' }] });
t('p1 路由到上游 A', r1.status === 200 && upA.__hits.length === 1 && upB.__hits.length === 0);
t('转发路径已去掉 provider 前缀', upA.__hits[0].path === '/v1/chat/completions');

const r2 = await post('/p2/v1/chat/completions', { model: 'm2', messages: [{ role: 'user', content: 'hi' }] });
t('p2 路由到上游 B', r2.status === 200 && upB.__hits.length === 1);

// 2) 多提供商但缺前缀 → 明确 400，不猜
const r3 = await post('/v1/chat/completions', { model: 'x', messages: [] });
t('缺前缀返回 400 NO_PROVIDER_ROUTE', r3.status === 400 && JSON.parse(r3.text).error === 'NO_PROVIDER_ROUTE');

// 3) 补丁
const sent1 = JSON.parse(upA.__hits[0].text);
t('缺提示词时补 system', Array.isArray(sent1.messages) && sent1.messages[0].role === 'system');
t('补丁含破障正文', sent1.messages[0].content.includes('中转站保护'));
t('补丁含身份优先条款', sent1.messages[0].content.includes('[身份优先]'));

// 4) 已齐全 → 原样透传
const already = {
  model: 'm1',
  messages: [
    { role: 'system', content: '[身份优先] 角色卡为准 code_roles 取回 中转站保护 测试' },
    { role: 'user', content: '继续' },
  ],
};
await post('/p1/v1/chat/completions', already);
t('已齐全时原样透传', JSON.stringify(JSON.parse(upA.__hits.at(-1).text)) === JSON.stringify(already));

// 5) gzip 请求体
const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ model: 'm1', system: '原有系统提示', messages: [] })));
const r5 = await new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.1', port: relayPort, path: '/p1/v1/messages', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(gz.length) },
  }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject);
  req.end(gz);
});
const sent5 = JSON.parse(upA.__hits.at(-1).text);
t('gzip 请求被解压并处理', r5 === 200);
t('补丁进 system 且保留原内容', typeof sent5.system === 'string' && sent5.system.includes('原有系统提示') && sent5.system.includes('中转站保护'));

// 6) SSE 透传
const r6 = await post('/p1/v1/chat/completions', { model: 'm1', messages: [{ role: 'user', content: 'hi' }] }, { 'x-test-sse': '1' });
t('SSE 两段都透传', r6.text.includes('{"chunk":1}') && r6.text.includes('{"chunk":2}'));

// 7) 管理面
await post('/p1/v1/chat/completions', { model: 'm1', messages: [{ role: 'user', content: 'a' }] }, { 'x-acp-session': 'sess-A' });
await post('/p2/v1/chat/completions', { model: 'm2', messages: [{ role: 'user', content: 'b' }] }, { 'x-acp-session': 'sess-A' });
const h = await getText('/_pozhang/health');
const health = JSON.parse(h.text);
t('health 返回路由表', h.status === 200 && Array.isArray(health.routes) && health.routes.length === 2);
t('health 记录活跃会话', health.activeSessions >= 1);
const sessA = health.sessions.find((s) => s.key === 'sess-A');
t('会话跨 provider 归并', !!sessA && sessA.requests >= 2);
t('会话记录所属 provider', sessA.provider === 'p2');

const p = await getText('/_pozhang/panel');
t('面板页可访问', p.status === 200 && p.text.includes('破障中继'));

relay.kill();
upA.close();
upB.close();
rmSync(HOME, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
