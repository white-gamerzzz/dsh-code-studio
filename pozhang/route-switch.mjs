#!/usr/bin/env node
/**
 * 出站口接管 CLI（与插件启动时自动执行的是同一套逻辑）。
 *
 *   node pozhang/route-switch.mjs status      # 看哪些 provider 已经过破障
 *   node pozhang/route-switch.mjs on          # 全部接管（幂等）
 *   node pozhang/route-switch.mjs on a,b      # 只接管指定 provider
 *   node pozhang/route-switch.mjs off         # 还原为接管前的配置
 */
import { ensureRouted, restoreRouted, routeStatus } from './autoroute.js';

const PORT = Number(process.env.POZHANG_PORT || 8788);
const [action, arg] = process.argv.slice(2);
const only = arg ? arg.split(',').map((s) => s.trim()).filter(Boolean) : null;

if (action === 'on') {
  const r = ensureRouted({ port: PORT, only });
  if (r.changed.length) {
    console.log(`已接管 ${r.changed.length} 个 provider（端口 ${PORT}）：`);
    for (const c of r.changed) console.log(`  ${c.id.padEnd(14)} ${c.from}  →  ${c.to}`);
  } else {
    console.log(`无需改动：${r.skipped.length} 个 provider 已在新端口 ${PORT} 后面。`);
  }
  console.log('重启 dsh 生效。');
} else if (action === 'off') {
  const restored = restoreRouted();
  if (!restored.length) console.log('没有找到接管前的备份，未改动。');
  else {
    for (const r of restored) console.log(`已还原 ${r.file}  ←  ${r.from}`);
    console.log('重启 dsh 生效。');
  }
} else {
  const st = routeStatus({ port: PORT });
  console.log(`中继端口 ${PORT}｜provider ${st.total} 个，已接管 ${st.relayed} 个${st.all ? '（全量）' : ''}\n`);
  for (const r of st.rows) console.log(`  ${r.relayed ? '→ 破障' : '  直连'}  ${r.id.padEnd(14)} ${r.baseURL}`);
  if (!st.all) console.log('\n仍有 provider 直连，执行 node pozhang/route-switch.mjs on 可全部接管。');
}
