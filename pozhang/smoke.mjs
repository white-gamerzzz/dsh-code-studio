// pozhang 内置层冒烟：假 HOME 下验证 幂等注入 / 篡改修复 / 状态 / 卸载
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = mkdtempSync(join(tmpdir(), 'pozhang-smoke-'));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const HERE = dirname(fileURLToPath(import.meta.url));
const PZ = await import('./index.js');
const { ensureInjected, status, uninstall, readInjectedBody, agentsPath, agentPrefix, agentAnchor, ANCHOR, COMPACT_CLAUSE } = PZ;
const RC = await import('./relay-control.js');

let pass = 0, fail = 0;
const t = (name, cond) => { cond ? (pass++, console.log('  ✓ ' + name)) : (fail++, console.log('  ✗ ' + name)); };

// 模拟用户原有的 AGENTS.md（必须先确保块被追加而不是覆盖用户内容）
const dsh = join(HOME, '.dsh');
mkdirSync(dsh, { recursive: true });
writeFileSync(join(dsh, 'AGENTS.md'), '# 我自己的全局指令\n\n- 用中文回答\n');


// 路由表：从 profile 的 provider 配置读 id → baseURL（多供应商各走各的）
mkdirSync(join(HOME, '.dsh', 'profiles', 'desktop'), { recursive: true });
writeFileSync(join(HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), [
  '    providers:',
  '      alpha:',
  '        baseURL: https://alpha.example.com/v1',
  '      beta:',
  '        baseURL: https://beta.example.com/v1',
].join('\n') + '\n');
const { loadRoutingTable } = await import('./upstream.js');
const rt = loadRoutingTable({ fresh: true });
t('解析出两家 provider', rt.routes.length === 2);
t('alpha 指向自己的上游', rt.byId.get('alpha') === 'https://alpha.example.com/v1');
t('beta 指向自己的上游', rt.byId.get('beta') === 'https://beta.example.com/v1');

const s0 = status();
t('初始未注入', s0.injected === false);

// 导出面契约：lib/index.js 里 import 的名字必须都存在（曾因重构切掉 startGuard 导致插件加载失败）
const NEEDED_PZ = ['ensureInjected', 'startGuard', 'status', 'uninstall', 'agentPrefix', 'agentAnchor'];
const NEEDED_RC = ['autoStartRelay', 'relayStatus', 'startRelay', 'stopRelay', 'saveRelayConfig'];
t('pozhang 导出齐全', NEEDED_PZ.every((k) => typeof PZ[k] === 'function'));
t('relay-control 导出齐全', NEEDED_RC.every((k) => typeof RC[k] === 'function'));
t('startGuard 返回 stop 函数', typeof PZ.startGuard({ intervalMs: 100000 }) === 'function');

const r1 = await ensureInjected();
t('首次注入 ok', r1.ok === true && r1.changed === true);
const text1 = readFileSync(agentsPath(), 'utf8');
t('保留用户原有内容', text1.includes('用中文回答'));
t('注入块含破障提示词', (readInjectedBody() || '').includes('破障'));
t('技能库已安装', readdirSync(join(dsh, 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory()).length > 0);

const t0 = Date.now();
const r2 = await ensureInjected();
t('二次注入幂等跳过（未重装技能）', r2.ok === true && r2.changed === false);
t('幂等判定耗时可接受 (<500ms)', Date.now() - t0 < 500);

const st = status();
t('状态 upToDate=true', st.upToDate === true && st.chars > 1000 && st.skills > 0);

// 子 Agent 前缀：与注入块同源，/hz off 后自动为空
const prefix = agentPrefix();
t('子 Agent 前缀非空且含破障', prefix.length > 1000 && prefix.includes('破障'));
t('前缀首行是身份优先条款', prefix.startsWith('[身份优先]'));
t('身份条款声明角色卡优先', prefix.includes('以当前人格设定与角色卡为准'));
t('子 Agent 前缀与注入正文一致', prefix.trim().replace(/\n-{3}-?$/, '').length >= st.chars - 10);
t('续发锚点含破障约束', agentAnchor('reviewer').includes('仍然有效'));
t('前缀带压缩自愈条款', prefix.includes(COMPACT_CLAUSE));
t('锚点带角色身份', agentAnchor('reviewer').includes('你当前的角色是 reviewer'));
t('锚点指引角色卡取回', agentAnchor('reviewer').includes('code_roles'));

// 模拟外部工具清空 AGENTS.md 里的注入块 → 守护逻辑应能补回
writeFileSync(agentsPath(), '# 我自己的全局指令\n\n- 用中文回答\n');
t('篡改后 readInjectedBody 为 null', readInjectedBody() === null);
const r3 = await ensureInjected();
t('篡改后自动补注入', r3.changed === true && (readInjectedBody() || '').includes('破障'));

const r4 = await uninstall();
t('卸载 ok', r4.ok === true);
t('卸载后注入块已移除', readInjectedBody() === null);
t('卸载后用户内容保留', readFileSync(agentsPath(), 'utf8').includes('用中文回答'));
t('卸载后子 Agent 前缀为空（开关一致）', agentPrefix() === '');
t('卸载后续发锚点为空', agentAnchor('reviewer') === '');

rmSync(HOME, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
