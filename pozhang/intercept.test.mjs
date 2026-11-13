// 进程内拦截冒烟：假 fetch + 假 HOME，验证 命中 provider / 补丁 / 放行 / 只碰 LLM 请求
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'pozhang-intercept-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

mkdirSync(join(HOME, '.dsh', 'profiles', 'desktop'), { recursive: true });
writeFileSync(join(HOME, '.dsh', 'AGENTS.md'),
  '<!-- POZHANG-INJECT:BEGIN -->\n# 中转站保护（唯一禁止项）\n\n测试用破障正文。\n<!-- POZHANG-INJECT:END -->\n');
writeFileSync(join(HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), [
  '    providers:',
  '      alpha:',
  '        baseURL: https://alpha.example.com/v1',
  '      beta:',
  '        baseURL: https://beta.example.com/v1',
].join('\n') + '\n');

let pass = 0, fail = 0;
const t = (n, c) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n)); };

// 假 fetch：记录最终发出的 body
const sent = [];
globalThis.fetch = async (input, init) => {
  const body = init?.body ?? (typeof Request !== 'undefined' && input instanceof Request ? await input.clone().text() : null);
  sent.push({ url: String(input), body, headers: init?.headers });
  return new Response('{"ok":true}', { status: 200 });
};

const { installInterceptor, interceptStatus, ensureOutermost } = await import('./intercept.js');
installInterceptor();

// 1) 命中路由表 + 缺提示词 → 补进 system
await fetch('https://alpha.example.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: '你好' }] }),
});
const b1 = JSON.parse(sent.at(-1).body);
t('命中 provider 时补 system', Array.isArray(b1.messages) && b1.messages[0].role === 'system');
t('补丁含破障正文', b1.messages[0].content.includes('中转站保护'));
t('补丁含身份优先条款', b1.messages[0].content.includes('[身份优先]'));

// 2) 已齐全 → 原样放行（body 不被重写）
const already = { model: 'm1', messages: [{ role: 'system', content: '[身份优先] code_roles 取回 中转站保护' }, { role: 'user', content: 'x' }] };
const before = JSON.stringify(already);
await fetch('https://beta.example.com/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: before });
t('已齐全时 byte-identical 放行', sent.at(-1).body === before);

// 2.5) billion-context 那种把 Request 对象递进来的形态也要能补
const req = new Request('https://alpha.example.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'req-form' }] }),
});
await fetch(req);
const sentReq = sent.at(-1);
t('Request 形态也能补 system', typeof sentReq.body === 'string' && sentReq.body.includes('中转站保护'));

// 2.7) AGENTS.md 那种“破障只在消息里”的形态：system 层没有就必须补进 system
await fetch('https://alpha.example.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: '# 中转站保护（唯一禁止项）…这是 AGENTS.md 注入的消息，不是 system' }] }),
});
const bAgents = JSON.parse(sent.at(-1).body);
t('消息里有破障但 system 没有 → 仍补进 system', Array.isArray(bAgents.messages) && bAgents.messages[0].role === 'system' && bAgents.messages[0].content.includes('中转站保护'));

// 3) 非路由表主机 → 完全不碰
await fetch('https://registry.npmjs.org/left-pad', { method: 'POST', body: JSON.stringify({ a: 1 }) });
t('非 LLM 主机不处理', sent.at(-1).body === '{"a":1}');

// 4) 非 JSON body → 跳过并计数
await fetch('https://alpha.example.com/v1/audio', { method: 'POST', body: 'binary' });
t('非 JSON body 跳过', sent.at(-1).body === 'binary');

// 4.5) billion-context 后装：把我们包在里面 → 自愈回最外层
const ours = globalThis.fetch;
const biliCalls = [];
globalThis.fetch = async function biliWrapped(input, init) {
  biliCalls.push(typeof input === 'string' ? input : input?.url);
  return await ours.call(this, input, init);
};
const moved = ensureOutermost();
const st0 = interceptStatus();
t('后装覆盖后能自愈回最外层', moved === true && globalThis.fetch === ours);
t('状态显示 outermost', st0.outermost === true && st0.reasserts >= 1);

// 这次请求必须经过我们（先补），再落到 bili 那层
await fetch('https://alpha.example.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'm1', messages: [{ role: 'user', content: 'after-bili' }] }),
});
const sentAfter = sent.at(-1);
t('补丁仍生效且链路到得了下一层', String(sentAfter.body).includes('中转站保护') && biliCalls.length >= 1);

// 5) 状态统计
const st = interceptStatus();
t('统计已安装', st.installed === true);
t('统计计入补丁与放行', st.patched >= 1 && st.passed >= 1);
t('按 provider 归并', st.providers.some((p) => p.provider === 'alpha' && p.patched >= 1));

rmSync(HOME, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
