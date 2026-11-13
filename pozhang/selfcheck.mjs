#!/usr/bin/env node
/**
 * 破障自检：一条命令看清"补丁到底有没有送到模型"。
 *
 * 用法（在插件仓库根目录）：
 *   node pozhang/selfcheck.mjs
 *
 * 判断口径：
 *   - dispatcher.installed = true  → 传输层已挂载（dsh 实际走这条）
 *   - seen > 0                     → 确实抓到了 LLM 请求
 *   - patched > 0 且 log 里有 patch → 补丁已写入 system
 *   - seen = 0                     → 请求没经过我们，需要换接入方式
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import { routeStatus } from './autoroute.js';
import { homedir } from 'node:os';

const PORT = Number(process.env.POZHANG_PORT || 8788);
const LOG = join(homedir(), '.dsh', '.pozhang-intercept.log');
const AGENTS = join(homedir(), '.dsh', 'AGENTS.md');

function get(path, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path, timeout }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(b));
        } catch {
          resolve({ __raw: b });
        }
      });
    });
    req.on('error', (e) => resolve({ __error: e.code || e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ __error: 'timeout' });
    });
  });
}

async function main() {
  console.log('=== 破障自检 ===\n');

  // 1. AGENTS.md 注入块
  if (existsSync(AGENTS)) {
    const text = readFileSync(AGENTS, 'utf8');
    const hasBlock = text.includes('POZHANG-INJECT') || text.includes('破障') || text.includes('中转站保护');
    console.log(`AGENTS.md       : 存在，${text.length} 字符，注入块 ${hasBlock ? '在' : '缺失'}`);
  } else {
    console.log('AGENTS.md       : 不存在');
  }

  // 2. 监控服务
  const health = await get('/_pozhang/health');
  if (health.__error) {
    console.log(`监控服务        : 未响应 (${health.__error}) —— 端口 ${PORT}`);
    console.log('\n结论：插件没有加载，或端口被占用。先看 dsh 启动日志里 pozhang 那一行。');
    return;
  }

  const ic = health.intercept ?? {};
  const dp = ic.dispatcher ?? {};
  const rs = health.stats ?? {};
  console.log(`监控服务        : 运行中（${health.routes?.length ?? 0} 条 provider 路由）`);
  console.log(`中继计数        : 请求 ${rs.requests ?? rs.seen ?? 0}｜补丁 ${rs.patched ?? 0}｜放行 ${rs.passed ?? 0}`);
  const v = health.via;
  const st2 = health.stats ?? {};
  console.log(`降级计数        : 链式 ${st2.chain ?? 0}｜直连 ${st2.direct ?? 0}｜bili 不可达降级 ${st2.viaFallback ?? 0}｜链超时 ${st2.viaTimeout ?? 0}`);
  console.log(`链式压缩        : ${v ? `经 billion-context(:${v.port}${v.lane ? ', lane=' + v.lane : ''})${v.down ? '（已降级直连）' : ''}` : '未启用（直连上游）'}`);
  console.log(`fetch 层        : ${ic.installed ? '已挂载' : '未挂载'}｜被调用 ${ic.seen ?? 0} 次｜补丁 ${ic.patched ?? 0} 次｜放行 ${ic.passed ?? 0} 次`);
  console.log(`传输层 undici   : ${dp.installed ? '已挂载' : `未挂载${dp.error ? '（' + dp.error + '）' : ''}`}｜补丁 ${dp.patched ?? 0} 次｜放行 ${dp.passed ?? 0} 次`);

  // 3. 落盘日志
  if (existsSync(LOG)) {
    const lines = readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
    const patchCount = lines.filter((l) => l.includes('"action":"patch"')).length;
    console.log(`拦截日志        : ${lines.length} 行，其中补丁 ${patchCount} 次`);
    console.log(`最近一条        : ${lines.at(-1)}`);
  } else {
    console.log('拦截日志        : 不存在（说明两层都没抓到请求）');
  }

  // 3.5 出站口接管状态
  try {
    const st = routeStatus({ port: PORT });
    console.log(`出站口接管      : ${st.relayed}/${st.total} 个 provider 经过破障${st.all ? '（全量）' : ''}`);
    for (const r of st.rows.filter((x) => !x.relayed)) console.log(`  未接管: ${r.id} → ${r.baseURL}`);
  } catch (e) {
    console.log('出站口接管      : 读取失败', e.message);
  }

  // 4. 结论
  console.log('\n=== 结论 ===');
  let routeAll = false;
  try { routeAll = routeStatus({ port: PORT }).all; } catch { /* ignore */ }
  const seenTotal = (ic.seen ?? 0) + (dp.seen ?? 0) + (dp.patched ?? 0) + (ic.patched ?? 0) + (ic.passed ?? 0) + (dp.passed ?? 0);
  const patchedTotal = (ic.patched ?? 0) + (dp.patched ?? 0);

  if (routeAll) {
    console.log('所有 provider 都已在破障后面 → 请求必然经过中继，补丁在中继层写入 system。');
    console.log('若模型仍拒绝：看下面「中继」的补丁次数；为 0 说明路由表里没有对应 provider（检查快照文件）。');
  } else if (seenTotal > 0 && patchedTotal > 0) {
    console.log('拦截层抓到了请求且已写入补丁 → 投递成功。');
  } else if (!ic.installed && !dp.installed) {
    console.log('拦截层未挂载，且 provider 未全量接管 → 请执行 node pozhang/route-switch.mjs on 后重启 dsh。');
  } else {
    console.log('拦截层已装但没抓到请求 → dsh 走 Electron 网络进程，进程内拦不到；靠中继接管才可靠。');
  }
}

main().catch((e) => {
  console.error('自检失败:', e.message);
  process.exitCode = 1;
});
