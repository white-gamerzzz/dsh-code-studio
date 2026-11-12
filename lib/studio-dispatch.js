/**
 * 后台派单（第三刀的核心逻辑，纯函数 + 可注入服务，模块内不直接碰宿主）。
 *
 * 设计（用户 m00360 拍板）：**持久子会话按 region 复用**，不按 issue 新开枝杈。
 *   - 同一片文件夹的后续 issue → `sendMessage` 追回同一个持久子会话（串行追加）。
 *   - 换一片文件夹 → 新建 region + 新持久子会话。
 *   - 跨 region 并行，但同时在飞的分组 ≤ MAX_GROUPS；同 region 永远串行。
 *
 * 「谁是父 Agent」：子会话必须有 parent（SubagentStartRequest.parent: Agent）。
 * 本模块不自己造父 —— parent 由调用方传入（前台工作区 Agent）。模块只负责
 * 「该新建还是该追回、账本怎么写、闸门怎么卡」这几件事，因此能用假服务完整自测。
 *
 * 硬约束：不加 `export default`（cordis unwrapExports 会取 default）。
 */

import { loadRegions, loadIssues, upsertRegion, upsertIssue, planRegion, normalizeFolder } from './studio-store.js';
import {
  DETACHED_SIGNAL, buildContinuableActivation, buildDispatchRequest, withDepthCap,
} from './dispatch.js';

/** 同时在飞的 region 分组上限（用户定的「最多 2 组子Agent」）。 */
export const MAX_GROUPS = 2;

/** 子会话不得再派这个角色（子技术总监不许再叫技术总监）。 */
export const FORBIDDEN_CHILD_ROLE = 'tech-lead';

/** 进程内自增，保证同一进程内新 region 的 childId 不撞。 */
let seq = 0;
function mintChildId(region) {
  seq += 1;
  const slug = String(region ?? 'region').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40) || 'region';
  return `cs-${slug}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

/** 归一化 issue 编号（去掉前缀 #）。 */
export function normalizeIssueId(id) {
  return String(id ?? '').trim().replace(/^#/, '');
}

/**
 * 纯决策：这批文件夹该「追回」还是「新建」。
 * @param {object} regions  regions.json 的 regions 表
 * @param {string[]} folders issue 触碰的文件夹
 * @param {(childId:string)=>boolean} [isLive] 判断某个 childId 当前是否仍有活会话
 * @returns {{mode:'reuse'|'create', region:string, childId:string|null, folders:string[], isNew:boolean}}
 */
export function decideDispatch(regions, folders, isLive) {
  const plan = planRegion(regions, folders);
  const existing = regions?.[plan.name];
  const stored = existing?.childId ? String(existing.childId) : null;
  const live = stored !== null && (typeof isLive !== 'function' || isLive(stored));
  if (live) {
    return { mode: 'reuse', region: plan.name, childId: stored, folders: plan.folders, isNew: plan.isNew };
  }
  return { mode: 'create', region: plan.name, childId: null, folders: plan.folders, isNew: plan.isNew };
}

/** 在飞分组 = 有 RUNNING 状态 issue 的 region 集合。 */
export function inFlightGroups(issues) {
  const set = new Set();
  for (const item of Array.isArray(issues) ? issues : []) {
    if (String(item?.status ?? '').toUpperCase() === 'RUNNING' && item.region) set.add(String(item.region));
  }
  return set;
}

/**
 * 派一个 issue 到它该去的持久子会话。
 *
 * @param {object} opts
 * @param {string} opts.dir            仓库目录（.codewrite 所在）
 * @param {{id:string,title?:string,folders?:string[]}} opts.issue
 * @param {string} opts.role           子会话角色
 * @param {string} opts.prompt         本次投给子会话的任务正文
 * @param {object} opts.parent         父 Agent（前台工作区会话）
 * @param {object} opts.subagents      host subagents 服务
 * @param {object} [opts.agents]       host agents 服务（判 childId 是否还活）
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.maxGroups]
 * @returns {Promise<{ok:true, mode:string, region:string, childId:string}
 *                 | {ok:false, code:string, reason:string}>}
 */
export async function dispatchIssue({
  dir, issue, role, prompt, parent, subagents, agents, signal, route, maxGroups = MAX_GROUPS,
}) {
  const issueId = normalizeIssueId(issue?.id);
  if (!issueId) return { ok: false, code: 'NO_ISSUE_ID', reason: 'issue.id 不能为空。' };
  if (!parent?.id) return { ok: false, code: 'NO_PARENT', reason: '拿不到父 Agent，无法派子会话。' };
  const outgoing = String(prompt ?? '').trim();
  if (!outgoing) return { ok: false, code: 'EMPTY_PROMPT', reason: 'prompt 不能为空。' };
  if (String(role ?? '') === FORBIDDEN_CHILD_ROLE) {
    return {
      ok: false, code: 'FORBIDDEN_ROLE',
      reason: '子会话不得再派 tech-lead：子技术总监不许再叫子技术总监。',
    };
  }
  const folders = (Array.isArray(issue?.folders) ? issue.folders : [])
    .map(normalizeFolder).filter(Boolean);

  const { regions } = await loadRegions(dir);
  const { issues } = await loadIssues(dir);
  const isLive = (id) => (typeof agents?.get === 'function' ? agents.get(id) !== undefined : false);
  const plan = decideDispatch(regions, folders, isLive);

  let childId;
  let mode = plan.mode;

  if (plan.mode === 'reuse') {
    // 同一片文件夹：追回同一个持久子会话（串行追加，不新开枝杈）。
    childId = plan.childId;
    if (typeof subagents?.sendMessage !== 'function') {
      return { ok: false, code: 'NO_SEND_MESSAGE', reason: 'subagents.sendMessage 不可用，无法追回已有子会话。' };
    }
    await subagents.sendMessage(parent, childId, [{ type: 'text', text: outgoing }], { signal: signal ?? DETACHED_SIGNAL });
  } else {
    // 新分组才受「在飞 ≤ maxGroups」约束；追回同组不受限（那是串行）。
    const inFlight = inFlightGroups(issues);
    if (!inFlight.has(plan.region) && inFlight.size >= maxGroups) {
      return {
        ok: false, code: 'TOO_MANY_GROUPS',
        reason: `在飞分组已有 ${inFlight.size} 个（${[...inFlight].join('、')}），上限 ${maxGroups}。等其中一组结算再派。`,
      };
    }
    childId = mintChildId(plan.region);
    const request = withDepthCap(buildDispatchRequest({
      label: `region:${plan.region}`, prompt: outgoing, parent, signal: signal ?? DETACHED_SIGNAL, route,
    }), subagents);
    const started = await subagents.startActivation(buildContinuableActivation({
      childId, label: `region:${plan.region}`, request,
    }));
    childId = String(started?.childId ?? childId);
    mode = 'create';
  }

  await upsertRegion(dir, plan.region, { folders: plan.folders, issues: [issueId], childId });
  await upsertIssue(dir, {
    id: issueId, region: plan.region, folders: plan.folders, childId, status: 'RUNNING',
    ...(issue?.title ? { title: issue.title } : {}),
  });
  return { ok: true, mode, region: plan.region, childId };
}

/**
 * 子会话结算后的回写：把报告落进 issues.json，Tab 下次读文件就自动刷新。
 * ok=true → status DONE；否则 FAILED，并把原因写进 error。
 *
 * @param {string} dir 仓库目录
 * @param {string} issueId issue 编号
 * @param {{ok:boolean, report?:string, error?:string, changedFiles?:string[]}} outcome
 * @returns {Promise<{ok:true, status:string}>}
 */
export async function settleIssue(dir, issueId, outcome = {}) {
  const id = normalizeIssueId(issueId);
  if (!id) return { ok: false, code: 'NO_ISSUE_ID', reason: 'issue.id 不能为空。' };
  const report = String(outcome.report ?? '').trim();
  const status = outcome.ok ? 'DONE' : 'FAILED';
  await upsertIssue(dir, {
    id,
    status,
    ...(report ? { report } : {}),
    ...(Array.isArray(outcome.changedFiles) ? { changedFiles: outcome.changedFiles } : {}),
    ...(outcome.ok ? {} : { error: String(outcome.error ?? '子会话非正常结束').trim() }),
  });
  return { ok: true, status };
}

/* ────────────────────────────── 自检 demo ────────────────────────────── */

async function demo() {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); };

  const dir = await mkdtemp(join(tmpdir(), 'cs-dispatch-'));
  const parent = { id: 'fg-ws-1' };
  const calls = { start: [], send: [] };
  const live = new Set();
  const subagents = {
    resolveMaxDepth: () => undefined,
    startActivation: async (spec) => { calls.start.push(spec); live.add(spec.childId); return { childId: spec.childId }; },
    sendMessage: async (sender, targetId, content, options) => { calls.send.push({ sender, targetId, content, options }); return 'm-1'; },
    getProvider: () => ({ prepareContinuable: () => ({}) }),
  };
  const agents = { get: (id) => (live.has(id) ? { id } : undefined) };

  // 纯决策
  assert(decideDispatch({}, ['src/auth', 'src/api'], () => false).mode === 'create', 'empty → create');

  // 第一单：新建 region + startActivation
  const r1 = await dispatchIssue({ dir, issue: { id: '#12', title: '修登录', folders: ['src/auth', 'src/api'] }, role: 'implementer', prompt: 'do #12', parent, subagents, agents });
  assert(r1.ok && r1.mode === 'create', 'first is create: ' + JSON.stringify(r1));
  assert(calls.start.length === 1, 'startActivation called once');
  assert(r1.region === 'api+auth', 'region name api+auth, got ' + r1.region);

  // 第二单：同一片文件夹（顺序不同）→ 追回同一子会话，不发新 start
  const r2 = await dispatchIssue({ dir, issue: { id: '13', title: '再改登录', folders: ['src/api', 'src/auth'] }, role: 'implementer', prompt: 'do #13', parent, subagents, agents });
  assert(r2.ok && r2.mode === 'reuse', 'second is reuse: ' + JSON.stringify(r2));
  assert(r2.childId === r1.childId, 'reuse same childId');
  assert(calls.start.length === 1, 'no new start on reuse');
  assert(calls.send.length === 1, 'sendMessage called on reuse');

  // 换一片文件夹：新 region
  const r3 = await dispatchIssue({ dir, issue: { id: '14', folders: ['src/export'] }, role: 'implementer', prompt: 'do #14', parent, subagents, agents });
  assert(r3.ok && r3.mode === 'create' && r3.region === 'export', 'new region export');
  assert(calls.start.length === 2, 'second start for new region');

  // 闸门：第三组新 region 应被拒（已有 2 组在飞）
  const r4 = await dispatchIssue({ dir, issue: { id: '15', folders: ['src/billing'] }, role: 'implementer', prompt: 'do #15', parent, subagents, agents });
  assert(!r4.ok && r4.code === 'TOO_MANY_GROUPS', 'third group rejected: ' + JSON.stringify(r4));

  // tech-lead 禁止
  const r5 = await dispatchIssue({ dir, issue: { id: '16', folders: ['src/x'] }, role: 'tech-lead', prompt: 'x', parent, subagents, agents });
  assert(!r5.ok && r5.code === 'FORBIDDEN_ROLE', 'tech-lead forbidden');

  // 账本落地
  const { regions } = await loadRegions(dir);
  assert(regions['api+auth'] && regions['api+auth'].childId === r1.childId, 'regions persisted with childId');
  const { issues } = await loadIssues(dir);
  assert(issues.find((i) => i.id === '12')?.status === 'RUNNING', 'issue 12 RUNNING');
  assert(issues.find((i) => i.id === '13')?.childId === r1.childId, 'issue 13 shares childId');

  // 结算回写：成功 → DONE + report；失败 → FAILED + error
  await settleIssue(dir, '12', { ok: true, report: '改好了：auth 走 token 刷新。', changedFiles: ['src/auth/login.js'] });
  await settleIssue(dir, '13', { ok: false, error: '测试没通过' });
  const after = (await loadIssues(dir)).issues;
  const i12 = after.find((i) => i.id === '12');
  assert(i12.status === 'DONE' && i12.report.includes('token'), 'issue 12 DONE with report');
  assert(Array.isArray(i12.changedFiles) && i12.changedFiles[0] === 'src/auth/login.js', 'changedFiles persisted');
  const i13 = after.find((i) => i.id === '13');
  assert(i13.status === 'FAILED' && i13.error === '测试没通过', 'issue 13 FAILED with error');

  console.log('studio-dispatch: demo OK');
}

if (process.argv[1] && process.argv[1].endsWith('studio-dispatch.js')) {
  demo().catch((error) => { console.error(error); process.exit(1); });
}
