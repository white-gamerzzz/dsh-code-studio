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

import { existsSync } from 'node:fs';
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
 * 判断目录是不是本机 git 工作树。
 * 先看 `.git`（零成本）；没有再用 `git rev-parse --is-inside-work-tree` 兜（能认出子目录）。
 * 拿不到 runCommand 时只信 `.git` 的存在性。
 * @param {string} dir
 * @param {Function|null} runCommand
 * @returns {Promise<boolean>}
 */
export async function isGitWorkTree(dir, runCommand) {
  if (!dir) return false;
  try {
    if (existsSync(`${dir}/.git`) || existsSync(`${dir}\\.git`)) return true;
  } catch { /* 忽略 */ }
  if (typeof runCommand !== 'function') return false;
  try {
    const r = await runCommand('git rev-parse --is-inside-work-tree', { cwd: dir, timeoutMs: 15000 });
    return r?.code === 0 && String(r?.stdout ?? '').trim() === 'true';
  } catch {
    return false;
  }
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

/** 某 region 是否已全部收尾（该 region 下没有 RUNNING 的 issue）。 */
export function regionSettled(issues, region) {
  const name = String(region ?? '');
  if (!name) return false;
  return !(Array.isArray(issues) ? issues : []).some(
    (item) => String(item?.region ?? '') === name && String(item?.status ?? '').toUpperCase() === 'RUNNING',
  );
}

/** 两个文件夹是否重叠（相等或互为前缀，按 / 分段比较，避免 src/a 撞 src/ab）。 */
function folderOverlap(a, b) {
  const x = normalizeFolder(a);
  const y = normalizeFolder(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
}

/**
 * 派单前的文件夹交集检查：这条 issue 要去的 region（candidateRegion）若与**另一个在飞
 * region** 的文件夹重叠，两个 worktree 会改同一批文件 → 拒绝，等那边结算再派。
 *
 * 同一 region 不算冲突（那是串行复用，本就该等前面那条做完）。
 *
 * @param {Record<string,{folders:string[]}>} regions
 * @param {string[]} issues 全部 issue（用来求在飞 region）
 * @param {string} candidateRegion 本单要去的 region
 * @param {string[]} folders 本单文件夹
 * @returns {{region:string, folder:string}|null}
 */
export function folderConflict(regions, issues, candidateRegion, folders) {
  const want = (Array.isArray(folders) ? folders : []).map(normalizeFolder).filter(Boolean);
  if (!want.length) return null;
  for (const other of inFlightGroups(issues)) {
    if (other === candidateRegion) continue;
    const otherFolders = (regions?.[other]?.folders ?? []).map(normalizeFolder).filter(Boolean);
    for (const a of want) {
      for (const b of otherFolders) {
        if (folderOverlap(a, b)) return { region: other, folder: a };
      }
    }
  }
  return null;
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
 * @param {object} [opts.worktrees]    host worktrees 服务（可选：给了就为每个 region 建独立 worktree）
 * @param {object} [opts.workingDirectory] host workingDirectory 服务（建完 worktree 把 parent 目录还原）
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.maxGroups]
 * @returns {Promise<{ok:true, mode:string, region:string, childId:string, worktree?:string}
 *                 | {ok:false, code:string, reason:string}>}
 */
export async function dispatchIssue({
  dir, issue, role, prompt, parent, subagents, agents, worktrees, workingDirectory, signal, route, maxGroups = MAX_GROUPS,
  promptPrefix = '', promptAnchor = '', semanticRoute = null, runCommand = null,
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
  let folders = (Array.isArray(issue?.folders) ? issue.folders : [])
    .map(normalizeFolder).filter(Boolean);
  // 口语化 issue 抽不出路径 → 请 semanticRoute（一次 llm.stream 语义初判）试着归类。
  // 判不出来就留空，planRegion 会兜进 unrouted 区串行处理（不再拒单）。
  if (!folders.length && typeof semanticRoute === 'function') {
    try {
      const picked = await semanticRoute({ issue });
      folders = (Array.isArray(picked) ? picked : []).map(normalizeFolder).filter(Boolean);
    } catch { /* 初判失败不阻塞派单 */ }
  }

  const { regions } = await loadRegions(dir);
  const { issues } = await loadIssues(dir);

  // 「这个 region 记录的 childId 还能不能追回」的判据。
  // 旧实现只看 `agents.get(childId)` —— 子会话干完一单进入 idle 后会从「活 Agent 注册表」
  // 消失，于是永远判成 create，新铸 childId 另开枝杈，持久复用形同虚设（用户 m04482 报的 bug）。
  // 正确判据：宿主「持久直接子目录」里有这个 continuable 子会话，或它当前仍活着。
  // 宿主 API 是 listDescendants(rootSessionId, signal)：返回每个子会话的 mode/activity，
  // 只收持久（continuable）的直接子会话；sendMessage 对 absent 的直接子会话会从持久化冷恢复，
  // 所以「不在活列表」不等于「追不回」。
  let durableChildren = null; // Set<string> | null（null = 查询不可用 → 退回信任台账）
  if (typeof subagents?.listDescendants === 'function' && parent?.id) {
    try {
      const kids = await subagents.listDescendants(parent.id, signal);
      const set = new Set();
      for (const kid of Array.isArray(kids) ? kids : []) {
        if (!kid?.id || kid.mode !== 'continuable') continue;
        // 只取直接子会话（depth===1）；其下游由各自 region 自己管。
        if (kid.depth !== undefined && Number(kid.depth) !== 1) continue;
        set.add(String(kid.id));
      }
      durableChildren = set;
    } catch { durableChildren = null; }
  }
  const isLive = (id) => {
    const key = String(id);
    if (typeof agents?.get === 'function' && agents.get(id) !== undefined) return true;
    if (durableChildren === null) return true; // 目录不可用：信任台账，交给 sendMessage 冷恢复/降级
    return durableChildren.has(key);
  };
  const plan = decideDispatch(regions, folders, isLive);

  // 派单前文件夹交集检查：本单要去的 region 与「另一个在飞 region」文件夹重叠 → 拒，
  // 否则两个 worktree 会改同一批文件。同一 region 不算（那是串行复用，等前面那条做完即可）。
  const conflict = folderConflict(regions, issues, plan.region, folders);
  if (conflict) {
    return {
      ok: false, code: 'FOLDER_CONFLICT',
      reason: `文件夹「${conflict.folder}」与在飞 region「${conflict.region}」重叠，等那边结算再派（避免两个 worktree 改同一批文件）。`,
    };
  }

  let childId;
  let mode = plan.mode;
  // worktree：每个 region 一棵独立工作树，子会话钉在上面改，绝不碰真实工作目录。
  // reuse 时沿用 region 已记录的那棵；create 时新建并记进 region 台账。
  let worktree = plan.mode === 'reuse' ? (regions?.[plan.region]?.worktree ?? null) : null;

  // 目标目录是不是 git 仓库？不是就跳过 worktree，直接把子会话 cwd 指向 dir（就地改）。
  // 用户定的边界：改本地文件不需要 git、不需要绑 GitHub；只有推/建 PR 才要求是 git 仓库。
  const gitOk = await isGitWorkTree(dir, runCommand);

  if (plan.mode === 'reuse') {
    // 同一片文件夹：追回同一个持久子会话（串行追加，不新开枝杈）。
    childId = plan.childId;
    if (typeof subagents?.sendMessage !== 'function') {
      return { ok: false, code: 'NO_SEND_MESSAGE', reason: 'subagents.sendMessage 不可用，无法追回已有子会话。' };
    }
    // worktree 被人删了/机器重启清空 → 子会话 cwd 指向不存在目录。校验一下，失效就退回仓库根并报警，
    // 不清 region 台账（下次 create 会重记）。
    if (worktree && !existsSync(worktree)) {
      worktree = null;
      await upsertRegion(dir, plan.region, { folders: plan.folders }).catch(() => {});
    }
    try {
      await subagents.sendMessage(parent, childId, [{ type: 'text', text: outgoing + promptAnchor }], { signal: signal ?? DETACHED_SIGNAL });
    } catch (error) {
      // 目录/冷恢复都失败（子会话真没了、或宿主拒绝该地址）→ 报出来，别静默吞掉让 issue 卡住。
      return {
        ok: false, code: 'REUSE_FAILED',
        reason: `追回子会话 ${childId} 失败：${error instanceof Error ? error.message : String(error)}。可先 settleIssue 收尾该 region 再重派。`,
      };
    }
  } else {
    // 新分组才受「在飞 ≤ maxGroups」约束；追回同组不受限（那是串行）。
    const inFlight = inFlightGroups(issues);
    if (!inFlight.has(plan.region) && inFlight.size >= maxGroups) {
      return {
        ok: false, code: 'TOO_MANY_GROUPS',
        reason: `在飞分组已有 ${inFlight.size} 个（${[...inFlight].join('、')}），上限 ${maxGroups}。等其中一组结算再派。`,
      };
    }
    // 只有「是 git 仓库」且「有 worktrees 服务」才建独立工作树；非 git 目录跳过 worktree，
    // 子会话 cwd 直接指向 dir（就地改）。缺 worktrees 服务时也退回就地改。
    if (gitOk && worktrees && typeof worktrees.create === 'function') {
      try {
        // worktrees.create 会把**调用者（parent）**的 cwd 切进新 worktree。parent 是前台会话，
        // 它的目录不能被偷走 —— 建完立刻用 workingDirectory.set 还原回仓库根 dir。
        const created = await worktrees.create(parent, { name: `issue-${issueId}` });
        worktree = created?.path ?? null;
        if (worktree && workingDirectory && typeof workingDirectory.set === 'function') {
          try { await workingDirectory.set(parent, dir); } catch { /* 还原失败不挡派单 */ }
        }
      } catch (error) {
        return {
          ok: false, code: 'WORKTREE_FAILED',
          reason: `建 worktree 失败：${error instanceof Error ? error.message : String(error)}。`,
        };
      }
    }
    childId = mintChildId(plan.region);
    const request = withDepthCap(buildDispatchRequest({
      label: `region:${plan.region}`, prompt: promptPrefix + outgoing + promptAnchor, parent, signal: signal ?? DETACHED_SIGNAL, route, cwd: worktree || dir,
    }), subagents);
    const started = await subagents.startActivation(buildContinuableActivation({
      childId, label: `region:${plan.region}`, request,
    }));
    childId = String(started?.childId ?? childId);
    mode = 'create';
  }

  await upsertRegion(dir, plan.region, { folders: plan.folders, issues: [issueId], childId, ...(worktree ? { worktree } : {}) });
  await upsertIssue(dir, {
    id: issueId, region: plan.region, folders: plan.folders, childId, status: 'RUNNING',
    ...(worktree ? { worktree } : {}),
    ...(issue?.title ? { title: issue.title } : {}),
  });
  return { ok: true, mode, region: plan.region, childId, ...(worktree ? { worktree } : {}) };
}

/**
 * 清理一棵 worktree：`git worktree remove --force` + `git branch -D`（尽力而为，失败不抛）。
 * worktrees 服务只有 create 没有 remove，所以走 git 命令。repoRoot 用于执行 git。
 * 只在该 region 的活都收尾（PR 已建 / 全部终结）后调用，别在建 PR 前删。
 *
 * @param {{worktree?:string, branch?:string, repoRoot?:string, runCommand?:Function}} opts
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function removeWorktree({ worktree, branch, repoRoot, runCommand }) {
  if (!worktree || typeof runCommand !== 'function') return { ok: false, reason: '缺少 worktree 或 runCommand' };
  if (!existsSync(worktree)) return { ok: true, reason: 'already gone' };
  const cwd = repoRoot || worktree;
  try {
    const r = await runCommand(`git worktree remove --force "${worktree}"`, { cwd, timeoutMs: 60000 });
    if (branch) {
      try { await runCommand(`git branch -D "${branch}"`, { cwd, timeoutMs: 30000 }); } catch { /* 分支删不掉不挡 */ }
    }
    return { ok: r?.code === 0, reason: r?.code === 0 ? undefined : (r?.stderr ?? '').slice(0, 200) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
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

  // 口语化 issue（无 folders）+ semanticRoute 挑中 src/docs → 归到 docs 而不是拒单
  const dirSR = await mkdtemp(join(tmpdir(), 'cs-sr-'));
  const srCalls = { picked: 0 };
  const r6 = await dispatchIssue({
    dir: dirSR, issue: { id: '17', title: '文档按钮点了没反应', body: '点了没反应' }, role: 'implementer', prompt: 'p', parent, subagents, agents,
    semanticRoute: async () => { srCalls.picked += 1; return ['docs']; },
  });
  assert(r6.ok && r6.region === 'docs', 'semantic route → docs region, got ' + JSON.stringify(r6));
  assert(srCalls.picked === 1, 'semanticRoute invoked once');
  // 口语化 issue + 无 semanticRoute → 不拒单，进 unrouted
  const r7 = await dispatchIssue({ dir: dirSR, issue: { id: '18', title: '随便修修' }, role: 'implementer', prompt: 'p', parent, subagents, agents });
  assert(r7.ok && r7.region === 'unrouted', 'no folders no semantic → unrouted, got ' + JSON.stringify(r7));
  // 已有 folders 时不调用 semanticRoute（省一次模型调用）
  let srCalled = false;
  await dispatchIssue({ dir: dirSR, issue: { id: '19', folders: ['src/q'] }, role: 'implementer', prompt: 'p', parent, subagents, agents,
    semanticRoute: async () => { srCalled = true; return ['src/q']; } });
  assert(srCalled === false, 'semanticRoute skipped when folders present');

  // folderConflict 纯函数
  const cRegions = { api: { folders: ['src/api'] }, web: { folders: ['src/web'] } };
  const cIssues = [{ id: '1', status: 'RUNNING', region: 'api' }];
  assert(folderConflict(cRegions, cIssues, 'other', ['src/api/v2'])?.region === 'api', 'overlap across regions detected');
  assert(folderConflict(cRegions, cIssues, 'other', ['src/api'])?.region === 'api', 'exact folder overlap');
  assert(folderConflict(cRegions, cIssues, 'api', ['src/api/v2']) === null, 'same region not a conflict');
  assert(folderConflict(cRegions, cIssues, 'other', ['src/db']) === null, 'no overlap → null');
  assert(folderConflict(cRegions, cIssues, 'other', ['src/ab']) === null, 'src/ab must not match src/api prefix');

  // 派单级冲突：歧义重叠 → planRegion 新建 region，但新 region 文件夹与在飞 region 重叠 → FOLDER_CONFLICT
  {
    const { mkdtemp: mk2 } = await import('node:fs/promises');
    const dir2 = await mk2(join(tmpdir(), 'cs-conflict-'));
    const live2 = new Set();
    const sub2 = {
      resolveMaxDepth: () => undefined,
      startActivation: async (spec) => { live2.add(spec.childId); return { childId: spec.childId }; },
      sendMessage: async () => 'm', getProvider: () => ({ prepareContinuable: () => ({}) }),
    };
    const ag2 = { get: (id) => (live2.has(id) ? { id } : undefined) };
    // A = {src/a,src/b} 在飞
    const a = await dispatchIssue({ dir: dir2, issue: { id: '100', folders: ['src/a', 'src/b'] }, role: 'implementer', prompt: 'p', parent, subagents: sub2, agents: ag2 });
    assert(a.ok, 'conflict setup: region A created');
    // 再来一个 {src/a,src/c}：与 A 不相等也不被包含，且有另一无关 region 时才歧义；这里 A 唯一重叠 → 会被并进 A?
    // 构造第二个独立 region B={src/c,src/d} 让它变成歧义
    await dispatchIssue({ dir: dir2, issue: { id: '101', folders: ['src/c', 'src/d'] }, role: 'implementer', prompt: 'p', parent, subagents: sub2, agents: ag2 });
    // 现在 want={src/a,src/c}：A 含 src/a、B 含 src/c，两个候选 → 歧义 → planRegion 新建 'a+c'，
    // 而 'a+c' 的 src/a 与在飞 A 重叠 → 拒
    const conf = await dispatchIssue({ dir: dir2, issue: { id: '102', folders: ['src/a', 'src/c'] }, role: 'implementer', prompt: 'p', parent, subagents: sub2, agents: ag2 });
    assert(!conf.ok && conf.code === 'FOLDER_CONFLICT', 'cross-region folder conflict rejected: ' + JSON.stringify(conf));
  }

  // worktree：给了 worktrees.create 就为 create 建树并记进 region + issue
  {
    const { mkdtemp: mk3 } = await import('node:fs/promises');
    const dir3 = await mk3(join(tmpdir(), 'cs-wt-'));
    const wtCalls = [];
    const sub3 = {
      resolveMaxDepth: () => undefined,
      startActivation: async (spec) => { assert(spec.request.cwd === '/tmp/wt-issue-200', 'child request pinned to worktree cwd, got ' + spec.request.cwd); return { childId: spec.childId }; },
      sendMessage: async () => 'm', getProvider: () => ({ prepareContinuable: () => ({}) }),
    };
    const wt = { create: async (agent, req) => { wtCalls.push(req); return { path: '/tmp/wt-issue-200', branch: 'issue-200', baseCommit: 'abc', repositoryRoot: dir3 }; } };
    // runCommand 让 isGitWorkTree 认成 git 仓库（假目录没 .git）
    const gitRun = async () => ({ code: 0, stdout: 'true\n', stderr: '' });
    const rw = await dispatchIssue({ dir: dir3, issue: { id: '200', folders: ['src/z'] }, role: 'implementer', prompt: 'p', parent, subagents: sub3, worktrees: wt, runCommand: gitRun });
    assert(rw.ok && rw.worktree === '/tmp/wt-issue-200', 'worktree path returned');
    assert(wtCalls.length === 1 && wtCalls[0].name === 'issue-200', 'worktrees.create called with name');
    const rg = (await loadRegions(dir3)).regions['z'];
    assert(rg.worktree === '/tmp/wt-issue-200', 'worktree persisted on region');
    const isu = (await loadIssues(dir3)).issues.find((i) => i.id === '200');
    assert(isu.worktree === '/tmp/wt-issue-200', 'worktree persisted on issue');
  }

  // C1：非 git 目录派单 → 不建 worktree，子会话 cwd 直接指向 dir（就地改）
  {
    const { mkdtemp: mkNg } = await import('node:fs/promises');
    const dirNg = await mkNg(join(tmpdir(), 'cs-nogit-'));
    let wtCallsNg = 0;
    let pinnedCwd = null;
    const subNg = {
      resolveMaxDepth: () => undefined,
      startActivation: async (spec) => { pinnedCwd = spec.request.cwd; return { childId: spec.childId }; },
      sendMessage: async () => 'm', getProvider: () => ({ prepareContinuable: () => ({}) }),
    };
    const wtNg = { create: async () => { wtCallsNg += 1; return { path: '/tmp/should-not-happen' }; } };
    // runCommand 让 rev-parse 报「不是 git 仓库」
    const nonGitRun = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' });
    const rn = await dispatchIssue({ dir: dirNg, issue: { id: '250', folders: ['src/plain'] }, role: 'implementer', prompt: 'p', parent, subagents: subNg, worktrees: wtNg, runCommand: nonGitRun });
    assert(rn.ok && !rn.worktree, 'non-git dir: no worktree, got ' + JSON.stringify(rn));
    assert(wtCallsNg === 0, 'non-git dir: worktrees.create never called');
    assert(pinnedCwd === dirNg, 'non-git dir: child cwd pinned to dir, got ' + pinnedCwd);
  }

  // 持久复用（用户 m04482 报的 bug）：子会话 idle 后 agents.get 返回 undefined，
  // 但只要 listDescendants 的持久目录里还有这个 continuable 子会话，就必须 reuse 同一 childId。
  {
    const { mkdtemp: mk5 } = await import('node:fs/promises');
    const dir5 = await mk5(join(tmpdir(), 'cs-reuse-'));
    let catalog = null;          // 模拟持久子目录（创建后填入真实 childId）
    const start5 = [];
    const sub5 = {
      resolveMaxDepth: () => undefined,
      startActivation: async (spec) => { const id = 'durable-' + (start5.length + 1); start5.push(id); catalog = [{ id, mode: 'continuable', activity: 'inactive', parentId: parent.id, depth: 1, label: 'region:auth' }]; return { childId: id }; },
      sendMessage: async () => 'm', getProvider: () => ({ prepareContinuable: () => ({}) }),
      listDescendants: async () => (catalog ?? []),
    };
    const ag5 = { get: () => undefined }; // 关键：活注册表里永远查不到（模拟 idle）
    const ra = await dispatchIssue({ dir: dir5, issue: { id: '300', folders: ['src/auth'] }, role: 'implementer', prompt: 'p', parent, subagents: sub5, agents: ag5 });
    assert(ra.ok && ra.mode === 'create' && ra.childId === 'durable-1', 'first create, real childId from startActivation');
    const rb = await dispatchIssue({ dir: dir5, issue: { id: '301', folders: ['src/auth'] }, role: 'implementer', prompt: 'p', parent, subagents: sub5, agents: ag5 });
    assert(rb.ok && rb.mode === 'reuse' && rb.childId === 'durable-1', 'idle child still reused via durable catalog, got ' + JSON.stringify(rb));
    assert(start5.length === 1, 'no new startActivation on reuse while idle');
    // 目录里没有它（真被清理了）→ 必须 create，而不是硬发 sendMessage 撞墙
    catalog = [];
    const rc = await dispatchIssue({ dir: dir5, issue: { id: '302', folders: ['src/auth'] }, role: 'implementer', prompt: 'p', parent, subagents: sub5, agents: ag5 });
    assert(rc.ok && rc.mode === 'create' && rc.childId === 'durable-2', 'gone child → create new, got ' + JSON.stringify(rc));
  }

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

  // regionSettled：该 region 下无 RUNNING issue 才算完结
  assert(regionSettled([{ id: 'x', region: 'z', status: 'RUNNING' }], 'z') === false, 'regionSettled false while RUNNING');
  assert(regionSettled([{ id: 'x', region: 'z', status: 'DONE' }], 'z') === true, 'regionSettled true when settled');
  assert(regionSettled([], 'z') === true, 'regionSettled true for empty');

  // removeWorktree：清理失败不抛，返回 {ok:false}
  {
    const { mkdtemp: mk4 } = await import('node:fs/promises');
    const wtDir = await mk4(join(tmpdir(), 'cs-rmwt-'));
    const calls = [];
    const fakeRun = async (cmd, opts) => { calls.push({ cmd, cwd: opts && opts.cwd }); return { code: 0, stdout: '', stderr: '' }; };
    const okRes = await removeWorktree({ worktree: wtDir, branch: 'issue-9', repoRoot: '/repo', runCommand: fakeRun });
    assert(okRes.ok === true, 'removeWorktree ok on success');
    assert(calls.length === 2 && /worktree remove/.test(calls[0].cmd) && /branch -D/.test(calls[1].cmd), 'removeWorktree runs remove + branch -D');
    const badRes = await removeWorktree({ worktree: wtDir, repoRoot: '/repo', runCommand: async () => ({ code: 1, stdout: '', stderr: 'nope' }) });
    assert(badRes.ok === false, 'removeWorktree reports failure without throwing');
  }

  console.log('studio-dispatch: demo OK');
}

if (process.argv[1] && process.argv[1].endsWith('studio-dispatch.js')) {
  demo().catch((error) => { console.error(error); process.exit(1); });
}
