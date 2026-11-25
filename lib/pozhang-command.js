/**
 * 破障（pozhang）命令层：/hz 命令 + @whitegamerzzz/dsh-plugin-pozhang 的可选加载 shim。
 *
 * 分层纪律：本模块是唯一 import pozhang 包的地方；其余模块（index.js 的 prompt 前缀、
 * watcher 的锚点注入）只经这里导出的 agentPrefix/agentAnchor 两个纯函数取值。
 * 缺失时全部降级为安全空值 —— 工作室照常启动、不崩、不 warn，只是没有破障能力。
 *
 * 硬约束：不要加 `export default`（cordis 的 unwrapExports 取 exports.default，会让插件静默失效）。
 */

// 破障子系统已拆成独立包 @whitegamerzzz/dsh-plugin-pozhang（契约见规划）。
let PZ = null;
try { PZ = await import('@whitegamerzzz/dsh-plugin-pozhang'); } catch { PZ = null; }
export const PZ_OK = !!PZ;

// 注入/状态/卸载：缺失时 no-op，不崩不 warn。（守护与驱动块已随破障第二阶段移交新包 apply()）
const pozhangEnsure = (opts) => (PZ_OK ? PZ.ensureInjected(opts) : Promise.resolve({ ok: false, changed: false, degraded: true }));
const pozhangStatus = () => (PZ_OK ? PZ.status() : { injected: false, upToDate: false, chars: 0, skills: 0, off: false, agentsPath: '' });
const pozhangUninstall = (opts) => (PZ_OK ? PZ.uninstall(opts) : Promise.resolve({ ok: false, degraded: true }));
// 注入/透传模式：缺失时永远报「注入」，命令不崩。
const pozhangReadMode = () => (PZ_OK ? PZ.readMode() : 'inject');
const pozhangSetMode = (mode) => (PZ_OK ? PZ.setMode(mode) : 'inject');
// 子 Agent 前缀/锚点：缺失返回空串（拼进 prompt 等于无变化，零影响）。
export const pozhangAgentPrefix = (...a) => (PZ_OK ? PZ.agentPrefix(...a) : '');
export const pozhangAnchor = (...a) => (PZ_OK ? PZ.agentAnchor(...a) : '');

// 中继：缺失时 relayStart 降级 warn、状态/停止返回安全空值，只是没有 /_pozhang/panel。
const relayStatusOf = (opts) => (PZ_OK ? PZ.relayStatus(opts) : Promise.resolve({ running: false, enabled: false, port: 0, upstream: null, via: null, panel: null, health: null }));
const relayStart = (opts) => {
  if (!PZ_OK) {
    (opts?.log ?? (() => {}))('pozhang: 破障插件未安装，中继未启动');
    return Promise.resolve({ ok: false, degraded: true, error: '破障插件未安装' });
  }
  return PZ.startRelay(opts);
};
const relayStop = (opts) => (PZ_OK ? PZ.stopRelay(opts) : Promise.resolve({ ok: true, already: true, degraded: true }));
const relaySetChain = (enabled) => (PZ_OK ? PZ.setChain(enabled) : { chain: false, degraded: true });

/** 注册 /hz 斜杠命令。服务未就绪时跳过（与 apply() 的 register 分支同判）。 */
export function registerHzCommand(ctx) {
  if (typeof ctx.commands?.register !== 'function') return;
  const pozhangLog = (line) => ctx.logger?.debug?.(`pozhang: ${line}`);
  ctx.commands.register({
    definitionId: 'pozhang',
    name: 'hz',
    description: '破甲：无参看状态 / on 立即注入 / off 卸载还原 / pass 透传（拦截器留着但不改请求）/ inject 恢复注入 / relay [on|off|status] 拦截转发中继（面板 + 自启动）',
    input: { hint: 'on | off | pass | inject | chain on|off|status | relay on [端口] | relay off | relay status' },
    recordInput: false,
    handler: async ({ rawInput }) => {
      const arg = String(rawInput ?? '').trim().toLowerCase();
      if (!PZ_OK) return { kind: 'error', text: '破障插件未安装' };
      if (arg === 'off') {
        const res = await pozhangUninstall({ log: pozhangLog });
        return {
          kind: res.ok ? 'success' : 'error',
          text: res.ok
            ? '破甲已关闭（注入块与技能已清理，system 层不再注入，守护不会再补回）。用 /hz on 恢复。'
            : `卸载失败：${res.error ?? ''}`,
        };
      }
      // 模式切换：拦截器一直装着，只决定它改不改请求。
      // 和 /hz off 的区别——off 是整套拆掉（摘块、清技能、子 Agent 前缀变空），
      // pass 只让 HTTP 层闭嘴，块和技能都留着，一条命令就切回来。
      if (arg === 'pass' || arg === 'passthrough' || arg === 'inject' || arg === 'mode') {
        const want = arg === 'inject' ? 'inject' : arg === 'mode' ? pozhangReadMode() : 'passthrough';
        const now = pozhangSetMode(want);
        const st = pozhangStatus();
        if (want === 'passthrough') {
          return {
            kind: 'success',
            text: [
              '已切到透传模式：拦截器仍装着，但请求一个字节都不改（system 层不再补破障正文）。',
              `AGENTS.md 注入块保留（${st.chars} 字符），子 Agent 前缀照旧。`,
              '用 /hz inject 恢复注入。',
            ].join('\n'),
          };
        }
        return {
          kind: 'success',
          text: [
            `已切到注入模式（当前：${now}）。`,
            st.off ? '注意：关闭哨兵还在，注入块是空的——先 /hz on。' : '下一笔请求就会补上 system 层正文。',
          ].join('\n'),
        };
      }
      if (arg.startsWith('chain')) {
        const sub = arg.split(/\s+/)[1] || '';
        if (sub === 'off') {
          relaySetChain(false);
          await relayStop({ log: () => {} }).catch(() => {});
          const r = await relayStart({ log: pozhangLog });
          return {
            kind: r.ok ? 'success' : 'error',
            text: r.ok
              ? '链式压缩已关闭：请求直连上游，bili 不再参与。\n（bili 的上下文压缩同时失效，破障的记忆注入不受影响）'
              : `已关闭链式，但中继重启失败：${r.error ?? ''}`,
          };
        }
        if (sub === 'on') {
          relaySetChain(true);
          await relayStop({ log: () => {} }).catch(() => {});
          const r = await relayStart({ log: pozhangLog });
          const v = (await relayStatusOf()).via;
          return {
            kind: r.ok ? 'success' : 'error',
            text: r.ok
              ? `链式压缩已开启：${v ? `经 billion-context(:${v.port})` : '但当前没发现 bili，暂为直连（它会自己再发现）'}`
              : `已开启链式，但中继重启失败：${r.error ?? ''}`,
          };
        }
        const st = await relayStatusOf();
        const h = st.health ?? {};
        const s = h.stats ?? {};
        return {
          kind: 'success',
          text: [
            `链式压缩：${st.via ? `经 billion-context(:${st.via.port}${st.via.lane ? ', lane=' + st.via.lane : ''})` : '未启用（直连上游）'}`,
            `本进程计数：链式 ${s.chain ?? 0}｜直连 ${s.direct ?? 0}｜降级 ${s.viaFallback ?? 0}｜链超时 ${s.viaTimeout ?? 0}`,
            '开关：/hz chain on | /hz chain off',
          ].join('\n'),
        };
      }
      if (arg.startsWith('relay')) {
        const sub = arg.split(/\s+/)[1] || '';
        if (sub === 'off') {
          const r = await relayStop({ log: pozhangLog });
          return { kind: r.ok ? 'success' : 'error', text: r.ok ? '中继已停止（下次启动 dsh 不会再自动拉起）。' : `停止失败：${r.error ?? ''}` };
        }
        if (sub === 'on') {
          const parts = String(rawInput ?? '').trim().split(/\s+/);
          const portArg = parts[2] ? Number(parts[2]) : undefined;
          const upstreamArg = parts[3];
          const r = await relayStart({ port: portArg, upstream: upstreamArg, log: pozhangLog });
          return {
            kind: r.ok ? 'success' : 'error',
            text: r.ok
              ? `中继已运行：http://127.0.0.1:${r.port}\n面板：http://127.0.0.1:${r.port}/_pozhang/panel\n`
                + `上游：${r.upstream}\n把 dsh 该 provider 的 Base URL 指到这个地址即可（API Key 原样透传）。`
              : `启动失败：${r.error ?? ''}`,
          };
        }
        const st = await relayStatusOf();
        return {
          kind: 'success',
          text: [
            `中继：${st.running ? '运行中' : '未运行'}${st.enabled ? '（已设自启动）' : '（未设自启动）'}`,
            `端口：${st.port}｜上游：${st.upstream}`,
            st.running ? `面板：${st.panel}` : '用 /hz relay on 启动',
            st.health ? `活跃会话：${st.health.activeSessions}｜补丁：${st.health.stats.patched}｜放行：${st.health.stats.pass}` : '',
          ].filter(Boolean).join('\n'),
        };
      }
      if (arg === 'on') {
        const res = await pozhangEnsure({ log: pozhangLog, force: true });
        const st = pozhangStatus();
        return {
          kind: res.ok ? 'success' : 'error',
          text: [
            res.changed ? '已重新注入（关闭哨兵已清除）。' : '注入块已是最新（关闭哨兵已清除）。',
            `AGENTS.md：${st.agentsPath}`,
            `正文字符：${st.chars}｜技能：${st.skills} 个｜与提示词一致：${st.upToDate ? '是' : '否'}`,
            '重启 dsh 后新会话生效。',
          ].filter(Boolean).join('\n'),
        };
      }
      const res = await pozhangEnsure({ log: pozhangLog });
      const st = pozhangStatus();
      const head = st.off
        ? '注入已关闭（哨兵在，守护不会补回）。用 /hz on 恢复。'
        : res.changed ? '已重新注入。' : st.injected ? '注入块已是最新。' : '注入块缺失。';
      return {
        kind: res.ok ? 'success' : 'error',
        text: [
          head,
          `AGENTS.md：${st.agentsPath}`,
          `正文字符：${st.chars}｜技能：${st.skills} 个｜与提示词一致：${st.upToDate ? '是' : '否'}`,
          res.changed ? '重启 dsh 后新会话生效。' : '',
        ].filter(Boolean).join('\n'),
      };
    },
  });
}
