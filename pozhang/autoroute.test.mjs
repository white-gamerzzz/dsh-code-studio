#!/usr/bin/env node
/**
 * 出站口自动接管的回归测试。
 * 关键场景：全量接管、幂等、中继端口漂移后不产生 /id/id 重复段、可回退。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'pz-route-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const YML = `agent:
  providers:
    alpha:
      baseURL: https://alpha.example.com/v1
      apiKeyEnv: A_KEY
    beta:
      baseURL: http://127.0.0.1:57894/v1
      apiKeyEnv: B_KEY
    gamma:
      baseURL: https://gamma.example.com
      apiKeyEnv: C_KEY
`;
mkdirSync(join(HOME, '.dsh', 'profiles', 'desktop'), { recursive: true });
const file = join(HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
writeFileSync(file, YML);

const { ensureRouted, restoreRouted, routeStatus, loadSnapshot } = await import('./autoroute.js');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log(`  ✓ ${name}`); } catch (e) { fail += 1; console.log(`  ✗ ${name} — ${e.message}`); }
}
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m ?? ''} 期望 ${b}，实际 ${a}`); };
const ok = (c, m) => { if (!c) throw new Error(m ?? '断言失败'); };

const r1 = ensureRouted({ port: 8788 });
t('全量接管三个 provider', () => eq(r1.changed.length, 3));
t('带 /v1 的保留路径后缀', () => ok(readFileSync(file, 'utf8').includes('http://127.0.0.1:8788/alpha/v1')));
t('本机网关也被接管', () => ok(readFileSync(file, 'utf8').includes('http://127.0.0.1:8788/beta/v1')));
t('无路径的不加后缀', () => ok(readFileSync(file, 'utf8').includes('http://127.0.0.1:8788/gamma\n')));

t('快照记录的是真实上游，不是中继自己', () => {
  const s = loadSnapshot();
  eq(s.alpha, 'https://alpha.example.com/v1');
  eq(s.beta, 'http://127.0.0.1:57894/v1');
  eq(s.gamma, 'https://gamma.example.com');
});

t('幂等：再跑一次不产生改动', () => {
  const r2 = ensureRouted({ port: 8788 });
  eq(r2.changed.length, 0);
  eq(r2.skipped.length, 3);
});

t('端口漂移：8788 → 8789 只换端口，不出现 /id/id', () => {
  ensureRouted({ port: 8789 });
  const text = readFileSync(file, 'utf8');
  ok(text.includes('http://127.0.0.1:8789/alpha/v1'), '未换到新端口');
  ok(!text.includes('/alpha/alpha'), '出现了重复 id 段');
  ok(!text.includes('8788'), '仍残留旧端口');
});

t('端口漂移时不污染快照', () => {
  const s = loadSnapshot();
  eq(s.alpha, 'https://alpha.example.com/v1', '快照被中继地址覆盖');
});

t('状态统计为全量接管', () => {
  const st = routeStatus({ port: 8789 });
  eq(st.total, 3);
  eq(st.relayed, 3);
  ok(st.all === true);
});

t('回退后还原为原始配置', () => {
  restoreRouted();
  const text = readFileSync(file, 'utf8');
  ok(text.includes('https://alpha.example.com/v1'));
  ok(text.includes('http://127.0.0.1:57894/v1'));
  ok(!text.includes('8789'));
});

t('备份文件已生成', () => {
  const baks = readdirSync(join(HOME, '.dsh', 'profiles', 'desktop')).filter((n) => n.includes('.bak-pozhang-'));
  ok(baks.length >= 1);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
rmSync(HOME, { recursive: true, force: true });
process.exitCode = fail ? 1 : 0;
