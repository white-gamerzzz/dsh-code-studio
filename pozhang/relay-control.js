/**
 * relay 控制层：进程内启停 / 探活 / 配置持久化。
 *
 * 关键决策：中继**跑在 dsh 进程内**（createRelay + listen），不再 spawn 子进程。
 * 原因是 Windows 上 detached 子进程会随父进程的 job 被回收，实测存活几秒即消失；
 * 进程内实现的寿命天然等于 dsh，没有回收、没有孤儿进程、也没有 kill 不到的问题。
 *
 * 资源模型：一个服务、一个端口、所有会话共享；会话只登记元数据，空闲 TTL 淘汰。
 * 配置文件：~/.dsh/.pozhang-relay.json（本插件自己的文件，不碰其它插件）
 */

import http from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRelay } from './relay.js';
import { loadRoutingTable } from './upstream.js';
import { discoverBili } from './bili-discover.js';

const CFG = join(homedir(), '.dsh', '.pozhang-relay.json');
const DEFAULTS = { enabled: false, port: 8788, upstream: 'https://api.deepseek.com', chain: true };

/** 进程内当前实例（模块级单例） */
let current = null;
/** bili 端口会变（lane 派生/被占跳口），定期重新发现，实现“bili 重启后自愈” */
let viaTimer = null;

export function loadRelayConfig() {
  try {
    const raw = existsSync(CFG) ? JSON.parse(readFileSync(CFG, 'utf8')) : {};
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveRelayConfig(patch = {}) {
  const next = { ...loadRelayConfig(), ...patch };
  writeFileSync(CFG, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/** 探活：任何实例（本进程或外部 CLI）都能被看到。 */
export function probeRelay(port = loadRelayConfig().port, timeoutMs = 800) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = http.get({ host: '127.0.0.1', port, path: '/_pozhang/health', timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          done({ running: true, health: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch {
          done({ running: false });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      done({ running: false });
    });
    req.on('error', () => done({ running: false }));
  });
}

/** 启动中继（幂等）。跑在 dsh 进程内。 */
export async function startRelay({ port, upstream, log = () => {} } = {}) {
  const cfg = loadRelayConfig();
  const p = Number(port ?? cfg.port);
  // 转发目标不由用户设置：中继按 /<provider>/... 前缀从路由表里选上游
  const up = String(upstream ?? '');
  saveRelayConfig({ port: p, upstream: up, enabled: true, pid: null });

  if (current && current.port === p) return { ok: true, already: true, port: p, upstream: current.upstream };
  if (current) {
    await current.relay.close();
    current = null;
  }

  // 端口上已有外部实例（例如手动跑的 CLI）→ 不重复起
  const probe = await probeRelay(p);
  if (probe.running) return { ok: true, already: true, port: p, upstream: probe.health?.upstream ?? up };

  // chain=false 时完全不用 bili（等价于强制直连），用于排障或 bili 出问题时的逃生开关
  const bili = cfg.chain === false ? null : await discoverBili().catch(() => null);
  const relay = createRelay({ port: p, upstream: up, via: bili });
  try {
    await relay.listen();
  } catch (e) {
    if (e?.code !== 'EADDRINUSE') {
      return { ok: false, error: String(e?.message ?? e) };
    }
    // 端口被占 → 自动找邻近空位（动态端口），并把实际端口写回配置，
    // 这样上游/前端/自检都从注册表读，不会出现「配置 8788、实际 8791」的错位。
    for (let cand = p + 1; cand <= p + 20; cand += 1) {
      const probe = await probeRelay(cand);
      if (probe.running) continue;
      const alt = createRelay({ port: cand, upstream: up, via: bili });
      try {
        await alt.listen();
      } catch {
        continue;
      }
      current = { relay: alt, port: cand, upstream: up };
      saveRelayConfig({ port: cand, upstream: up, enabled: true, pid: null });
      log(`端口 ${p} 被占用，中继改用 ${cand}`);
      armViaRefresh(bili);
      return { ok: true, started: true, port: cand, upstream: up, shiftedFrom: p };
    }
    return { ok: false, error: `端口 ${p} 及邻近 20 个都被占用` };
  }
  current = { relay, port: p, upstream: up };
  log(`relay 已启动 http://127.0.0.1:${p}`);
  if (bili) log(`链式：请求交给 billion-context(:${bili.port}) 压缩后再出站`);
  armViaRefresh(bili);
  return { ok: true, started: true, port: p, upstream: up };
}

/** bili 端口会变（lane 派生、被占跳口），定期重新发现 = 「bili 重启后自愈」。 */
function armViaRefresh(initial) {
  if (viaTimer) return;
  current?.relay?.setVia?.(initial ?? null);
  viaTimer = setInterval(async () => {
    if (!current) return;
    const v = await discoverBili({ fresh: true }).catch(() => null);
    current.relay.setVia(v);
  }, 30_000);
  viaTimer.unref?.();
}

/** 开关链式压缩：false = 完全直连上游（逃生开关）。 */
export function setChain(enabled) {
  const cfg = loadRelayConfig();
  saveRelayConfig({ ...cfg, chain: enabled !== false });
  if (current?.relay?.setVia) {
    if (enabled === false) current.relay.setVia(null);
  }
  return { chain: enabled !== false };
}

/** 停止：关掉本进程内的实例，并把 enabled 置 false（下次启动不再自动拉起）。 */
export async function stopRelay({ log = () => {} } = {}) {
  const cfg = loadRelayConfig();
  saveRelayConfig({ enabled: false });
  if (!current) {
    const probe = await probeRelay(cfg.port);
    if (probe.running) {
      return { ok: false, error: `127.0.0.1:${cfg.port} 上的中继不是本进程启动的，请在其终端里停止` };
    }
    return { ok: true, already: true };
  }
  await current.relay.close();
  current = null;
  log('relay 已停止');
  return { ok: true, stopped: true };
}

export async function relayStatus() {
  const cfg = loadRelayConfig();
  const probe = await probeRelay(cfg.port);
  return {
    enabled: cfg.enabled,
    running: probe.running,
    inProcess: !!current,
    port: cfg.port,
    upstream: probe.health?.upstream ?? null,
    routes: probe.health?.routes ?? [],
    via: probe.health?.via ?? null,
    panel: `http://127.0.0.1:${cfg.port}/_pozhang/panel`,
    health: probe.health ?? null,
  };
}

/** 插件启动时调用：开启过就自动拉起（幂等）。 */
export async function autoStartRelay({ log = () => {} } = {}) {
  const cfg = loadRelayConfig();
  if (!cfg.enabled) return { ok: true, skipped: 'disabled' };
  return startRelay({ port: cfg.port, upstream: cfg.upstream, log });
}
