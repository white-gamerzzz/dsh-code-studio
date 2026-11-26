/**
 * 后台派单（纯函数 + 可注入服务，模块内不直接碰宿主）。
 *
 * 设计（用户 m18382 拍板 region 退役）：**一条 issue 一根分支一个副本**，默认并行分叉、
 * 派单时不预判冲突（照 GitHub 的做法，撞车留到合并时暴露）。
 *   - 同一条 issue 再派 → 追回它自己的持久子会话（= 往同一个 PR 推新提交）。
 *   - 另一条 issue → 新开子会话 + 新副本，互不等待。
 *   - 在飞的（RUNNING）单数 ≤ MAX_GROUPS。
 *   - 仓库级 `queue: true`（issues.json wrapper）= 整仓串行：有在飞单就不接新单。
 *
 * 归属轴是「仓库」（多仓工作区由调用方解析出 dir），不再有 region。
 *
 * 「谁是父 Agent」：子会话必须有 parent（SubagentStartRequest.parent: Agent）。
 * 本模块不自己造父 —— parent 由调用方传入（前台工作区 Agent）。
 *
 * 硬约束：不加 `export default`（cordis unwrapExports 会取 default）。
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadIssues, upsertIssue, normalizeFolder, loadQueue } from './studio-store.js';
import { executorProblem } from './executor.js';
import { notManagedLine } from './toolkit.js';

/** 同时在飞（RUNNING）的单数上限。 */
export const MAX_GROUPS = 2;

/** 进程内自增，保证同一进程内新铸的 childId 不撞。 */
let seq = 0;
function mintChildId(issueId) {
  seq += 1;
  const slug = String(issueId ?? 'issue').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40) || 'issue';
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
 * 纯决策：这条 issue 该「追回」还是「新建」。
 *
 * 追回的判据是「同一条 issue 自己的子会话」（issue 行的 childId 还活着）。
 * 跨单不复用 —— 默认并行分叉；仓库级串行由 dispatchIssue 的 queue 闸负责，不在这层。
 *
 * @param {object[]} issues  issues.json 全部 issue（用来判在飞）
 * @param {(childId:string)=>boolean} [isLive] 判断某个 childId 当前是否仍有活会话
 * @param {object} [issue] 本单（有 childId 就说明这单派过）
 * @returns {{mode:'reuse'|'create', childId:string|null, sameIssue:boolean}}
 */
export function decideDispatch(issues, isLive, issue) {
  const live = (id) => id !== null && (typeof isLive !== 'function' || isLive(id));
  // 同一条 issue 再派 → 追回它自己的子会话（= 往同一个 PR 推新提交）。
  const own = issue?.childId ? String(issue.childId) : null;
  if (live(own)) return { mode: 'reuse', childId: own, sameIssue: true };
  return { mode: 'create', childId: null, sameIssue: false };
}

/** 在飞单数 = RUNNING 状态的 issue 数。 */
export function runningCount(issues) {
  return (Array.isArray(issues) ? issues : [])
    .filter((item) => String(item?.status ?? '').toUpperCase() === 'RUNNING').length;
}

/**
 * 开（或重建）一份副本：`git worktree add`（同仓库分支，几乎零成本）。
 * 路径残留（上次异常没拆干净）会卡 worktree add：先清残留，尽力而为。
 * 分支已存在（同 issue 重派）→ 直接 checkout；不存在 → -b 新建。
 * 走纯 git 命令（-C 指定仓库），不依赖宿主 worktrees 服务。
 */
export async function ensureWorktree(dir, issueId, runCommand) {
  if (typeof runCommand !== 'function') {
    return { ok: false, code: 'NO_RUN_COMMAND', reason: '建 worktree 副本需要 runCommand。' };
  }
  const wtPath = join(dir, '.code-studio', 'worktrees', `issue-${issueId}`);
  if (existsSync(wtPath)) {
    await runCommand(`git worktree remove --force "${wtPath}"`, { cwd: dir, timeoutMs: 60000 }).catch(() => {});
    try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* 删不掉交给 add 报错 */ }
  }
  const hasBranch = await runCommand(`git rev-parse --verify --quiet "issue-${issueId}"`, { cwd: dir, timeoutMs: 15000 });
  const addCmd = hasBranch?.code === 0
    ? `git worktree add "${wtPath}" "issue-${issueId}"`
    : `git worktree add -b "issue-${issueId}" "${wtPath}"`;
  const add = await runCommand(addCmd, { cwd: dir, timeoutMs: 60000 });
  if (add?.code !== 0) {
    return { ok: false, code: 'WORKTREE_FAILED', reason: `建 worktree 失败：${String(add?.stderr ?? '').slice(0, 300)}` };
  }
  return { ok: true, worktree: wtPath };
}

/**
 * git 硬闸：非 git 目录没有分支与合并，派单/备单都无从谈起。
 * proposeGitInit=true 且还没问过 → 返回 GIT_INIT_PROPOSE（交互式入口问一次）；
 * 其余一律 NOT_GIT_REPO。返回 null 表示放行。
 */
export async function gitGate(dir, issueId, runCommand, proposeGitInit, asked) {
  const gitOk = await isGitWorkTree(dir, runCommand);
  if (gitOk) return null;
  if (proposeGitInit && !asked) {
    return {
      code: 'GIT_INIT_PROPOSE',
      reason: [
        `「${dir}」还不是 git 仓库，无法派单（派单需要开 worktree 副本，worktree 依赖 git）。`,
        '建议先 `git init`（最好再补一个初始提交）再派——之后每单都是独立分支，可回滚、可 review。',
        `请先跟用户确认：回复「init」就先建仓库再派单；不建仓库就无法派单（issue #${issueId} 已记 gitInitAsked，不会再问第二次）。`,
      ].join('\n'),
    };
  }
  return {
    code: 'NOT_GIT_REPO',
    reason: `「${dir}」不是 git 仓库，无法派单。先 git init（或对该目录回复过 git-init 询问后仍拒绝）——没有副本就没有安全的派单方式。`,
  };
}

/**
 * 派一个 issue 到它该去的持久子会话。
 *
 * @param {object} opts
 * @param {string} opts.dir            仓库目录（台账所在）
 * @param {{id:string,title?:string,folders?:string[],tags?:string[]}} opts.issue
 * @param {string} opts.prompt         本次投给子会话的任务正文
 * @param {object} opts.parent         父 Agent（前台工作区会话）
 * @param {object} [opts.executor]     执行器（lib/executor.js）：派单只认它的 start/send/list/isLive，
 *                                     于是 DSH 子 Agent、本机 CLI、别的 Agent 都能挂进同一套流程
 * @param {object} [opts.subagents]    host subagents 服务（没给 executor 时用它兜一个 DSH 执行器）
 * @param {object} [opts.agents]       host agents 服务（判 childId 是否还活）
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.maxGroups]
 * @param {(childId:string)=>Promise<string>|string} [opts.memoryFor] 读该子会话上次落盘的结论（冷恢复用）
 * @returns {Promise<{ok:true, mode:string, childId:string, worktree?:string, tags?:string[]}
 *                 | {ok:false, code:string, reason:string}>}
 */
export async function dispatchIssue({
  dir, issue, prompt, parent, executor, subagents, agents, signal, route, maxGroups = MAX_GROUPS,
  promptPrefix = '', promptAnchor = '', semanticRoute = null, runCommand = null, memoryFor = null, proposeGitInit = false,
}) {
  const issueId = normalizeIssueId(issue?.id);
  if (!issueId) return { ok: false, code: 'NO_ISSUE_ID', reason: 'issue.id 不能为空。' };
  if (!parent?.id) return { ok: false, code: 'NO_PARENT', reason: '拿不到父 Agent，无法派子会话。' };
  const outgoing = String(prompt ?? '').trim();
  if (!outgoing) return { ok: false, code: 'EMPTY_PROMPT', reason: 'prompt 不能为空。' };
  let folders = (Array.isArray(issue?.folders) ? issue.folders : [])
    .map(normalizeFolder).filter(Boolean);
  // 口语化 issue 抽不出路径 → 请 semanticRoute（一次 llm.stream 语义初判）试着归类出 folders/tags。
  if (!folders.length && typeof semanticRoute === 'function') {
    try {
      const picked = await semanticRoute({ issue });
      folders = (Array.isArray(picked) ? picked : []).map(normalizeFolder).filter(Boolean);
    } catch { /* 初判失败不阻塞派单 */ }
  }
  // tags：显式给的优先，否则 folders 自动转（软分类，纯展示/过滤用）。
  const tags = [...new Set((Array.isArray(issue?.tags) && issue.tags.length ? issue.tags : folders)
    .map((t) => String(t ?? '').trim()).filter(Boolean))];

  const data = await loadIssues(dir);
  const issues = data.issues;

  // 「这条 issue 记录的 childId 还能不能追回」的判据。
  // 旧实现只看 `agents.get(childId)` —— 子会话干完一单进入 idle 后会从「活 Agent 注册表」
  // 消失，于是永远判成 create，新铸 childId 另开枝杈，持久复用形同虚设（用户 m04482 报的 bug）。
  // 正确判据：执行器的「持久子会话目录」里有它，或它当前仍活着。
  // 谁来答这个问题由执行器决定（DSH 子 Agent / 本机 CLI / 别的 Agent 各有一套），
  // 本模块只认 ex.isLive —— 于是这套工作方式不再捆绑 DSH（用户 m14694）。
  let ex = executor;
  if (!ex) {
    // 兼容回退：调用方只给了 subagents 时，现场兜一个 DSH 执行器。
    if (typeof subagents?.startActivation !== 'function') {
      return { ok: false, code: 'NO_EXECUTOR', reason: '既没给 executor，也没有可用的 subagents 服务，无法派单。' };
    }
    try {
      const { makeDshExecutor } = await import('./executor.js');
      ex = makeDshExecutor({ subagents, agents, parent, route, signal });
    } catch (error) {
      return { ok: false, code: 'NO_EXECUTOR', reason: `执行器初始化失败：${error instanceof Error ? error.message : String(error)}。` };
    }
  }
  const exProblem = executorProblem(ex);
  if (exProblem) return { ok: false, code: 'BAD_EXECUTOR', reason: exProblem };

  // 先把目录探一次（异步），再让同步的 isLive 用这份快照。
  try { await ex.list({ signal }); } catch { /* 目录不可用时执行器自己会保守判活 */ }
  const isLive = (id) => {
    try { return ex.isLive(String(id)) !== false; } catch { return true; }
  };
  // childId 落在 issues.json 的 issue 行上，不在调用方传进来的那个对象里 —— 必须从台账取。
  const known = (Array.isArray(issues) ? issues : []).find((i) => String(i?.id) === issueId) ?? null;
  const plan = decideDispatch(issues, isLive, known);

  // 仓库级串行闸：queue 开着且另有在飞单 → 不接新单（同一条 issue 追回自己不受限）。
  if (data.queue === true && plan.mode === 'create' && runningCount(issues) >= 1) {
    return {
      ok: false, code: 'REPO_QUEUED',
      reason: `仓库开了串行（queue:true）且还有 ${runningCount(issues)} 单在飞，等它结算再派。`,
    };
  }

  let childId;
  let mode = plan.mode;
  // 副本（用户定的「一单一副本」）：子会话永远钉在副本上改，绝不碰真实工作目录。
  // 复用时沿用本单 issue 行记的副本；create 时新建一份并记到 issue 行。
  let worktree = plan.mode === 'reuse' ? (known?.worktree ?? null) : null;

  // 目标目录必须是 git 仓库：没 git 就没有分支与合并，派单无从谈起。
  const gate = await gitGate(dir, issueId, runCommand, proposeGitInit, Boolean(issue?.gitInitAsked));
  if (gate) {
    if (gate.code === 'GIT_INIT_PROPOSE') {
      try { await upsertIssue(dir, { id: issueId, gitInitAsked: true }); } catch { /* 记不上也问一次无妨 */ }
    }
    return { ok: false, code: gate.code, reason: gate.reason };
  }

  // 开一份新副本：`git worktree add`（同仓库分支，几乎零成本）。
  // create 分支用它；reuse 分支在「上一轮结算把副本清掉了」时也用它 ——
  // 一单一副本下，结算必然删副本（PR 建成 / FAILED 都走 cleanupWorkspace），
  // 而 issue 行的 childId 还留着，于是下一单会判成 reuse 却拿到一个已删除的路径。
  // 这里重建副本、仍把消息发给老子会话，上下文复用不受影响。
  const makeWorkspace = () => ensureWorktree(dir, issueId, runCommand);

  // 把子 Agent 自己上次的结论读回来垫在指令前面。冷恢复（换进程 / 追回 idle 子会话）时，
  // 子会话的对话上下文已经没了，只剩这份落盘记忆 —— 不读回来等于白记。
  // 读取由调用方注入（本模块不直接碰记忆层），读不到就当没有。
  const withMemory = async (id, text) => {
    if (typeof memoryFor !== 'function') return text;
    try {
      const mem = await memoryFor(id);
      const body = typeof mem === 'string' ? mem.trim() : '';
      return body ? `## 你上次的结论（本会话记忆）\n${body}\n\n${text}` : text;
    } catch { return text; }
  };

  if (plan.mode === 'reuse') {
    // 同一条 issue：追回同一个持久子会话（串行追加，不新开枝杈）。
    childId = plan.childId;
    // 副本被人删了 / 上一轮结算时清了 / 机器重启清空 → 子会话 cwd 指向不存在目录。
    // 重建一份（不是退回仓库根：那等于在真实工作树上就地改）。
    if (!worktree || !existsSync(worktree)) {
      const again = await makeWorkspace();
      if (!again.ok) {
        return {
          ok: false, code: again.code,
          reason: `追回的子会话副本已不存在，重建失败（${again.code}）：${again.reason}`,
        };
      }
      worktree = again.worktree;
    }
    try {
      const text = await withMemory(childId, outgoing + promptAnchor);
      await ex.send({ childId, text, signal });
    } catch (error) {
      // 目录/冷恢复都失败（子会话真没了、或执行器拒绝该地址）→ 报出来，别静默吞掉让 issue 卡住。
      return {
        ok: false, code: error?.code === 'NO_SEND_MESSAGE' ? 'NO_SEND_MESSAGE' : 'REUSE_FAILED',
        reason: `追回子会话 ${childId} 失败：${error instanceof Error ? error.message : String(error)}。可先 settleIssue 收尾该单再重派。`,
      };
    }
  } else {
    // 新建受「在飞 ≤ maxGroups」约束；追回自己不受限（那是串行续做）。
    if (runningCount(issues) >= maxGroups) {
      return {
        ok: false, code: 'TOO_MANY_GROUPS',
        reason: `在飞的单已有 ${runningCount(issues)} 个（${issues.filter((i) => String(i?.status ?? '').toUpperCase() === 'RUNNING').map((i) => '#' + i.id).join('、')}），上限 ${maxGroups}。等其中一单结算再派。`,
      };
    }
    const made = await makeWorkspace();
    if (!made.ok) return { ok: false, code: made.code, reason: made.reason };
    worktree = made.worktree;
    childId = mintChildId(issueId);
    const started = await ex.start({
      childId, label: `issue:${issueId}`, prompt: promptPrefix + outgoing + promptAnchor, cwd: worktree, route, signal,
    });
    childId = String(started?.childId ?? childId);
    mode = 'create';
  }

  if (!worktree) {
    // 副本没了（reuse 时被清掉且未重建）→ 宁可不派，也不让子会话在主工作树上就地改。
    return {
      ok: false, code: 'NO_WORKSPACE',
      reason: `issue #${issueId} 没有可用副本（${plan.mode === 'reuse' ? '追回的子会话副本已不存在' : '未能创建副本'}）。请重新派单让它新建副本。`,
    };
  }

  // 副本记到 issue 行（一条 issue 一根分支一个副本）。
  await upsertIssue(dir, {
    id: issueId, folders, tags, childId, status: 'RUNNING',
    worktree,
    ...(issue?.title ? { title: issue.title } : {}),
  });
  return { ok: true, mode, childId, worktree, tags };
}

/**
 * 备单（手动路径：不派子会话，只把工位准备好）。
 *
 * 插件定位是「子 Agent 团队的协调工具」，不携带、不指定子 Agent 来源——
 * 主 Agent 自己起会话（DSH subagent / 外部 Bot / CLI 都行），插件只负责：
 *   git 硬闸 → 仓库串行闸 → 开 worktree 副本 → 台账落 READY。
 * 子会话起好后由主 Agent 用 `code_studio set childId=...` 登记，结算才对得上号。
 *
 * @param {object} opts
 * @param {string} opts.dir
 * @param {object} opts.issue            至少 {id, folders?}
 * @param {string[]} [opts.semanticRoute] folders 缺省时的兜底路由（watcher 提供）
 * @param {Function} [opts.runCommand]
 * @param {boolean} [opts.proposeGitInit] 交互式入口问一次 git-init
 * @returns {Promise<{ok:boolean, code?:string, reason?:string, folders?:string[], tags?:string[], worktree?:string}>}
 */
export async function prepareIssue({ dir, issue, semanticRoute, runCommand, proposeGitInit = false } = {}) {
  const id = normalizeIssueId(issue?.id);
  if (!id) return { ok: false, code: 'NO_ISSUE_ID', reason: 'issue.id 不能为空。' };
  let folders = (Array.isArray(issue?.folders) && issue.folders.length ? issue.folders : semanticRoute) ?? [];
  folders = folders.map(normalizeFolder).filter(Boolean);
  const tags = [...new Set((Array.isArray(issue?.tags) && issue.tags.length ? issue.tags : folders)
    .map((t) => String(t ?? '').trim()).filter(Boolean))];

  const data = await loadIssues(dir);
  const issues = data.issues;

  // 仓库串行闸：queue 开着且已有在飞单 → 先等（GitHub 的 Require-branches-to-be-up-to-date）。
  if (data.queue === true && runningCount(issues) >= 1) {
    return {
      ok: false, code: 'REPO_QUEUED',
      reason: `仓库开了串行（queue:true）且还有在飞的单，等它结算再备下一单。`,
    };
  }

  const gate = await gitGate(dir, id, runCommand, proposeGitInit, Boolean(issue?.gitInitAsked));
  if (gate) {
    if (gate.code === 'GIT_INIT_PROPOSE') {
      try { await upsertIssue(dir, { id, gitInitAsked: true }); } catch { /* 同上 */ }
    }
    return { ok: false, code: gate.code, reason: gate.reason };
  }

  const made = await ensureWorktree(dir, id, runCommand);
  if (!made.ok) return { ok: false, code: made.code, reason: made.reason };

  // 副本记到 issue 行；READY 表示「工位已备好，等子会话开工」。
  // 不写 childId（那是主 Agent 登记的）；已 RUNNING 的单重复备单也不改状态。
  const current = issues.find((item) => normalizeIssueId(item?.id) === id);
  const nextStatus = String(current?.status ?? '').toUpperCase() === 'RUNNING' ? 'RUNNING' : 'READY';
  await upsertIssue(dir, {
    id, folders, tags, worktree: made.worktree, status: nextStatus,
    ...(issue?.title ? { title: issue.title } : {}),
  });
  return { ok: true, mode: 'prepare', folders, tags, worktree: made.worktree };
}

/**
 * 把一条 issue 的副本合并回主工作目录（git worktree）：
 * 先查主工作树脏不脏，再提交副本改动、`git merge --no-ff issue-<id>`。冲突一律不落地。
 *
 * @param {{issue?:object, dir?:string, runCommand?:Function, allowDrift?:boolean, rebased?:boolean}} opts
 *        rebased=true 表示冲突已在副本里解掉了（merger 干完活），合并提交据此再走一次
 * @returns {Promise<{ok:boolean, code?:string, reason?:string, mergedTree?:string, backup?:string, conflicts?:string[]}>}
 */
export async function mergeWorkspace({ issue, dir, runCommand, allowDrift = false, rebased = false } = {}) {
  if (!issue?.id) return { ok: false, code: 'NO_ISSUE_ID', reason: 'issue.id 不能为空。' };
  if (typeof runCommand !== 'function') return { ok: false, code: 'NO_RUN_COMMAND', reason: '合并需要 runCommand。' };
  const id = normalizeIssueId(issue.id);
  void rebased; // git merge 自身就是一次真合并，rebased 只保留参数兼容 code_merge 契约

  if (!issue.worktree) {
    return { ok: false, code: 'NO_WORKSPACE', reason: `issue #${id} 没有副本可合并。` };
  }
  if (!existsSync(issue.worktree)) {
    return { ok: false, code: 'NO_WORKSPACE', reason: `issue #${id} 的副本目录已不存在：${issue.worktree}` };
  }
  const branch = `issue-${id}`;
  // 漂移：主工作树有未提交改动就拒（除非调用方显式允许）。
  const dirty = await runCommand('git status --porcelain', { cwd: dir, timeoutMs: 30000 });
  const dirtyLines = String(dirty?.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean).filter(notManagedLine);
  if (dirtyLines.length > 0 && allowDrift !== true) {
    return {
      ok: false, code: 'USER_DRIFT',
      reason: `主工作树有未提交改动（${dirtyLines.slice(0, 5).join('、')}），拒绝合并覆盖。先提交/暂存，或显式允许覆盖。`,
      conflicts: dirtyLines,
    };
  }
  // 副本改动先提交到 issue 分支，否则 merge 拿不到。
  const commit = await runCommand(
    `git -C "${issue.worktree}" add -A && git -C "${issue.worktree}" -c user.name=code-studio -c user.email=code-studio@local commit -m "issue-${id} work"`,
    { cwd: dir, timeoutMs: 60000 },
  );
  // 没有改动时 commit 退出码非 0（nothing to commit），不算失败。
  if (commit?.code !== 0 && !/nothing to commit|no changes added/i.test(`${commit?.stdout ?? ''}${commit?.stderr ?? ''}`)) {
    return { ok: false, code: 'COMMIT_FAILED', reason: String(commit?.stderr ?? '').slice(0, 300) || '提交副本改动失败' };
  }
  if (dirtyLines.length > 0 && allowDrift === true) {
    // 显式允许覆盖：先把主工作树的改动 stash 备份，让 merge 能快进/合并。
    await runCommand(`git -C "${dir}" stash push -u -m "code-studio backup before issue-${id}"`, { cwd: dir, timeoutMs: 60000 });
  }
  const merged = await runCommand(`git -C "${dir}" -c user.name=code-studio -c user.email=code-studio@local merge --no-ff -m "merge issue-${id}" "${branch}"`, { cwd: dir, timeoutMs: 120000 });
  if (merged?.code !== 0) {
    const conflicts = String(merged?.stdout ?? '').split('\n').filter((l) => /^CONFLICT|^Auto-merging/.test(l));
    return {
      ok: false, code: 'MERGE_CONFLICT',
      reason: `合并冲突，未落地。主工作树可能需要 git merge --abort。${String(merged?.stderr ?? '').slice(0, 200)}`,
      conflicts,
    };
  }
  return { ok: true, branch };
}

/**
 * 拆掉一条 issue 的副本：`git worktree remove` + `git branch -D issue-<id>`（尽力而为，失败不抛）。
 *
 * @param {{issue?:object, dir?:string, runCommand?:Function}} opts
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function cleanupWorkspace({ issue, dir, runCommand } = {}) {
  return removeWorktree({
    worktree: issue?.worktree,
    branch: issue?.id ? `issue-${normalizeIssueId(issue.id)}` : undefined,
    repoRoot: dir,
    runCommand,
  });
}

/**
 * 清理一棵 worktree：`git worktree remove --force` + `git branch -D`（尽力而为，失败不抛）。
 * worktrees 服务只有 create 没有 remove，所以走 git 命令。repoRoot 用于执行 git。
 * 只在该单收尾（PR 已建 / 全部终结）后调用，别在建 PR 前删。
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
  // 子会话写完 ≠ 完事：改动还在副本里，没进主干。所以成功先落「待合并区」（REVIEW），
  // 等 code_merge 真落地了才转 DONE —— 这就是 GitHub 的 PR 待合并态。
  const status = outcome.ok ? (outcome.merged === true ? 'DONE' : 'REVIEW') : 'FAILED';
  await upsertIssue(dir, {
    id,
    status,
    ...(report ? { report } : {}),
    ...(Array.isArray(outcome.changedFiles) ? { changedFiles: outcome.changedFiles } : {}),
    ...(outcome.ok ? {} : { error: String(outcome.error ?? '子会话非正常结束').trim() }),
  });
  return { ok: true, status };
}

/** 待合并区：已经写完、但还没合回主干的 issue（GitHub 的 open PR 列表）。 */
export async function pendingMerges(dir) {
  const { issues } = await loadIssues(dir);
  return (Array.isArray(issues) ? issues : []).filter(
    (item) => String(item?.status ?? '').toUpperCase() === 'REVIEW' && item?.worktree,
  );
}

/* ────────────────────────────── 自检 demo ────────────────────────────── */

async function demo() {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const assert = (c, m) => { if (!c) throw new Error('FAIL: ' + m); };
  // demo 里派单用的目录必须是真 git 仓库（worktree 副本依赖 git），需要真 runCommand。
  const { runCommand: rc } = await import('./runner.js');
  const dispatch = (opts) => dispatchIssue({ runCommand: rc, ...opts });

  const dir = await mkdtemp(join(tmpdir(), 'cs-dispatch-'));
  await rc(`git -C "${dir}" init -q`, { timeoutMs: 30000 });
  await rc(`git -C "${dir}" -c user.name=t -c user.email=t@t commit --allow-empty -q -m init`, { timeoutMs: 30000 });
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

  // 纯决策：没有 childId → create
  assert(decideDispatch([], () => false, null).mode === 'create', 'no childId → create');
  assert(decideDispatch([], () => true, { childId: 'c1' }).mode === 'reuse', 'live own childId → reuse');
  assert(decideDispatch([], () => false, { childId: 'c1' }).mode === 'create', 'dead own childId → create');

  // 第一单：新建子会话 + 副本
  const r1 = await dispatch({ dir, issue: { id: '#12', title: '修登录', folders: ['src/auth', 'src/api'] }, prompt: 'do #12', parent, subagents, agents });
  assert(r1.ok && r1.mode === 'create', 'first is create: ' + JSON.stringify(r1));
  assert(calls.start.length === 1, 'startActivation called once');
  assert(Array.isArray(r1.tags) && r1.tags.join(',') === 'src/auth,src/api', 'folders → tags: ' + JSON.stringify(r1.tags));

  // 第二单：另一条 issue → 照 GitHub 的做法并行分叉，另开子会话+副本
  const r2 = await dispatch({ dir, issue: { id: '13', title: '再改登录', folders: ['src/api', 'src/auth'] }, prompt: 'do #13', parent, subagents, agents });
  assert(r2.ok && r2.mode === 'create', 'different issue forks (create): ' + JSON.stringify(r2));
  assert(r2.childId !== r1.childId, 'parallel fork gets its own childId');
  assert(r2.worktree !== r1.worktree, 'parallel fork gets its own copy');
  assert(calls.start.length === 2, 'fork starts a second child');

  // 同一条 issue 再派（补一轮）→ 追回它自己的子会话，不发新 start
  const r2c = await dispatch({ dir, issue: { id: '13', title: '再改登录', folders: ['src/auth', 'src/api'] }, prompt: 'continue #13', parent, subagents, agents });
  assert(r2c.ok && r2c.mode === 'reuse', 'same issue reuses its own child: ' + JSON.stringify(r2c));
  assert(r2c.childId === r2.childId, 'same issue → same childId');
  assert(r2c.worktree === r2.worktree, 'same issue → same copy');
  assert(calls.start.length === 2, 'no new start on same-issue reuse');

  // 回归：副本被清掉之后，同一条 issue 再来一单必须「重建副本 + 复用同一子会话」，
  // 而不是报 NO_WORKSPACE（一单一副本 + 结算即清副本 这两条一起踩出来的坑）。
  await cleanupWorkspace({ issue: { id: '13', worktree: r2.worktree }, dir, runCommand: rc });
  assert(!existsSync(r2.worktree), 'cleanup 之后副本已删');
  const r2b = await dispatch({ dir, issue: { id: '13', title: '再来一单', folders: ['src/auth', 'src/api'] }, prompt: 'do 13b', parent, subagents, agents });
  assert(r2b.ok && r2b.mode === 'reuse', '副本被清后仍 reuse: ' + JSON.stringify(r2b));
  assert(r2b.childId === r2.childId, '副本被清后仍复用同一 childId');
  assert(existsSync(r2b.worktree), '副本被清后重建了新副本');
  assert(calls.start.length === 2, '重建副本不发新 startActivation');

  // 闸门：第三单应被拒（已有 2 单在飞 = 上限 2）
  const r3 = await dispatch({ dir, issue: { id: '14', folders: ['src/export'] }, prompt: 'do #14', parent, subagents, agents });
  assert(!r3.ok && r3.code === 'TOO_MANY_GROUPS', 'over-limit rejected: ' + JSON.stringify(r3));

  // 仓库级串行闸：queue:true + 有在飞单 → 新单拒，同单追回不受限
  await (await import('./studio-store.js')).saveQueue(dir, true);
  const rq = await dispatch({ dir, issue: { id: '15q', folders: ['src/billing'] }, prompt: 'q', parent, subagents, agents });
  assert(!rq.ok && rq.code === 'REPO_QUEUED', 'repo queue blocks new issue: ' + JSON.stringify(rq));
  const rq2 = await dispatch({ dir, issue: { id: '13', folders: ['src/auth'] }, prompt: 'continue 13', parent, subagents, agents });
  assert(rq2.ok && rq2.mode === 'reuse', 'repo queue still allows same-issue reuse');
  await (await import('./studio-store.js')).saveQueue(dir, false);

  // 口语化 issue（无 folders）+ semanticRoute 挑中 docs → folders/tags 落 docs
  const dirSR = await mkdtemp(join(tmpdir(), 'cs-sr-'));
  await rc(`git -C "${dirSR}" init -q`, { timeoutMs: 30000 });
  await rc(`git -C "${dirSR}" -c user.name=t -c user.email=t@t commit --allow-empty -q -m init`, { timeoutMs: 30000 });
  const srCalls = { picked: 0 };
  const r6 = await dispatch({
    dir: dirSR, issue: { id: '17', title: '文档按钮点了没反应', body: '点了没反应' }, prompt: 'p', parent, subagents, agents,
    semanticRoute: async () => { srCalls.picked += 1; return ['docs']; },
  });
  assert(r6.ok && r6.tags?.join(',') === 'docs', 'semantic route → tags docs, got ' + JSON.stringify(r6));
  assert(srCalls.picked === 1, 'semanticRoute invoked once');
  // 口语化 issue + 无 semanticRoute → 不拒单，无 tags
  const r7 = await dispatch({ dir: dirSR, issue: { id: '18', title: '随便修修' }, prompt: 'p', parent, subagents, agents });
  assert(r7.ok && Array.isArray(r7.tags) && r7.tags.length === 0, 'no folders no semantic → no tags, got ' + JSON.stringify(r7));
  // 已有 folders 时不调用 semanticRoute（省一次模型调用）
  let srCalled = false;
  await dispatch({ dir: dirSR, issue: { id: '19', folders: ['src/q'] }, prompt: 'p', parent, subagents, agents,
    semanticRoute: async () => { srCalled = true; return ['src/q']; } });
  assert(srCalled === false, 'semanticRoute skipped when folders present');

  // worktree 副本：真 git 仓库 → `git worktree add` 建副本并记进 issue 行
  {
    const { mkdtemp: mk3, writeFile: wf3 } = await import('node:fs/promises');
    const dir3 = await mk3(join(tmpdir(), 'cs-wt-'));
    await rc(`git -C "${dir3}" init -q`, { timeoutMs: 30000 });
    await rc(`git -C "${dir3}" -c user.name=t -c user.email=t@t commit --allow-empty -q -m init`, { timeoutMs: 30000 });
    await wf3(join(dir3, 'f.txt'), 'BASE\n');
    await rc(`git -C "${dir3}" add -A`, { timeoutMs: 30000 });
    await rc(`git -C "${dir3}" -c user.name=t -c user.email=t@t commit -q -m base`, { timeoutMs: 30000 });
    const sub3 = {
      resolveMaxDepth: () => undefined,
      startActivation: async (spec) => {
        assert(spec.cwd === join(dir3, '.code-studio', 'worktrees', 'issue-200'), 'child request pinned to worktree cwd, got ' + spec.cwd);
        return { childId: spec.childId };
      },
      sendMessage: async () => 'm', getProvider: () => ({ prepareContinuable: () => ({}) }),
    };
    const rw = await dispatch({ dir: dir3, issue: { id: '200', folders: ['src/z'] }, prompt: 'p', parent, subagents: sub3 });
    assert(rw.ok && rw.worktree === join(dir3, '.code-studio', 'worktrees', 'issue-200'), 'worktree path returned: ' + JSON.stringify(rw));
    assert(existsSync(join(rw.worktree, 'f.txt')), 'worktree copy has user files');
    const isu = (await loadIssues(dir3)).issues.find((i) => i.id === '200');
    assert(isu.worktree === rw.worktree, 'worktree persisted on issue');
    // 重建回归：副本被清后同 issue 再派 → 分支已存在也能重建（checkout 路径，不 -b）
    await cleanupWorkspace({ issue: { id: '200', worktree: rw.worktree }, dir: dir3, runCommand: rc });
    const rw2 = await dispatch({ dir: dir3, issue: { id: '200', folders: ['src/z'] }, prompt: 'p2', parent, subagents: sub3 });
    assert(rw2.ok && existsSync(rw2.worktree), 'worktree rebuilt after cleanup (branch exists)');
  }

  // 非 git 目录 → 硬闸：交互式首派问一次（GIT_INIT_PROPOSE + 记 gitInitAsked），之后一律 NOT_GIT_REPO
  {
    const { mkdtemp: mkNg, writeFile: wfNg } = await import('node:fs/promises');
    const dirNg = await mkNg(join(tmpdir(), 'cs-nogit-'));
    await wfNg(join(dirNg, 'plain.txt'), 'hello\n');
    const subNg = {
      resolveMaxDepth: () => undefined,
      startActivation: async () => { throw new Error('must not start a child for a non-git dir'); },
      sendMessage: async () => 'm', getProvider: () => ({ prepareContinuable: () => ({}) }),
    };
    const rq3 = await dispatchIssue({ dir: dirNg, issue: { id: '252', folders: ['src/plain'] }, prompt: 'p', parent, subagents: subNg, runCommand: rc, proposeGitInit: true });
    assert(!rq3.ok && rq3.code === 'GIT_INIT_PROPOSE', 'non-git interactive dispatch proposes git init: ' + JSON.stringify(rq3));
    const { issues: i252 } = await loadIssues(dirNg);
    assert(i252.find((i) => i.id === '252')?.gitInitAsked === true, 'gitInitAsked persisted on issue row');
    // 拒绝之后（含后台派单，不问）→ 一律 NOT_GIT_REPO，无第三条路
    const rq4 = await dispatchIssue({ dir: dirNg, issue: { id: '252', folders: ['src/plain'] }, prompt: 'p', parent, subagents: subNg, runCommand: rc });
    assert(!rq4.ok && rq4.code === 'NOT_GIT_REPO', 'non-git after proposal is a hard gate: ' + JSON.stringify(rq4));
    const rn2 = await dispatchIssue({ dir: dirNg, issue: { id: '253', folders: ['src/plain'] }, prompt: 'p', parent, subagents: subNg });
    assert(!rn2.ok && rn2.code === 'NOT_GIT_REPO', 'non-git background dispatch rejected too: ' + JSON.stringify(rn2));
    assert(!existsSync(join(dirNg, '.git')), 'no .git written into user dir');
  }

  // 持久复用（用户 m04482 报的 bug）：子会话 idle 后 agents.get 返回 undefined，
  // 但只要 listDescendants 的持久目录里还有这个 continuable 子会话，就必须 reuse 同一 childId。
  {
    const { mkdtemp: mk5 } = await import('node:fs/promises');
    const dir5 = await mk5(join(tmpdir(), 'cs-reuse-'));
    await rc(`git -C "${dir5}" init -q`, { timeoutMs: 30000 });
    await rc(`git -C "${dir5}" -c user.name=t -c user.email=t@t commit --allow-empty -q -m init`, { timeoutMs: 30000 });
    let catalog = null;          // 模拟持久子目录（创建后填入真实 childId）
    const start5 = [];
    const sub5 = {
      resolveMaxDepth: () => undefined,
      startActivation: async (spec) => { const id = 'durable-' + (start5.length + 1); start5.push(id); catalog = [{ id, mode: 'continuable', activity: 'inactive', parentId: parent.id, depth: 1, label: 'issue:300' }]; return { childId: id }; },
      sendMessage: async () => 'm', getProvider: () => ({ prepareContinuable: () => ({}) }),
      listDescendants: async () => (catalog ?? []),
    };
    const ag5 = { get: () => undefined }; // 关键：活注册表里永远查不到（模拟 idle）
    const ra = await dispatch({ dir: dir5, issue: { id: '300', folders: ['src/auth'] }, prompt: 'p', parent, subagents: sub5, agents: ag5 });
    assert(ra.ok && ra.mode === 'create' && ra.childId === 'durable-1', 'first create, real childId from startActivation');
    // 同一条 issue 再派：活注册表查不到，但持久目录里有 → 仍必须追回，不发新 start
    const rb = await dispatch({ dir: dir5, issue: { id: '300', folders: ['src/auth'] }, prompt: 'p', parent, subagents: sub5, agents: ag5 });
    assert(rb.ok && rb.mode === 'reuse' && rb.childId === 'durable-1', 'idle child still reused via durable catalog, got ' + JSON.stringify(rb));
    assert(start5.length === 1, 'no new startActivation on reuse while idle');
    // 目录里没有它（真被清理了）→ 必须 create，而不是硬发 sendMessage 撞墙
    catalog = [];
    const rc2 = await dispatch({ dir: dir5, issue: { id: '300', folders: ['src/auth'] }, prompt: 'p', parent, subagents: sub5, agents: ag5 });
    assert(rc2.ok && rc2.mode === 'create' && rc2.childId === 'durable-2', 'gone child → create new, got ' + JSON.stringify(rc2));
  }

  // 账本落地：childId/worktree/tags 全在 issue 行
  const { issues } = await loadIssues(dir);
  assert(issues.find((i) => i.id === '12')?.status === 'RUNNING', 'issue 12 RUNNING');
  assert(issues.find((i) => i.id === '12')?.childId === r1.childId, 'issue 12 keeps its own childId');
  assert(issues.find((i) => i.id === '13')?.childId === r2.childId, 'issue 13 has its own childId (parallel fork)');
  assert(Array.isArray(issues.find((i) => i.id === '12')?.tags), 'issue 12 has tags');

  // 结算回写：成功 → REVIEW（待合并区，改动还在副本里）+ report；失败 → FAILED + error
  await settleIssue(dir, '12', { ok: true, report: '改好了：auth 走 token 刷新。', changedFiles: ['src/auth/login.js'] });
  await settleIssue(dir, '13', { ok: false, error: '测试没通过' });
  const after = (await loadIssues(dir)).issues;
  const i12 = after.find((i) => i.id === '12');
  assert(i12.status === 'REVIEW' && i12.report.includes('token'), 'issue 12 REVIEW (pending merge) with report');
  assert(Array.isArray(i12.changedFiles) && i12.changedFiles[0] === 'src/auth/login.js', 'changedFiles persisted');
  // 待合并区里能看到它；真合并后才转 DONE
  assert((await pendingMerges(dir)).some((i) => i.id === '12'), 'issue 12 listed in pending merges');
  await settleIssue(dir, '12', { ok: true, merged: true });
  assert((await loadIssues(dir)).issues.find((i) => i.id === '12').status === 'DONE', 'merged → DONE');
  assert(!(await pendingMerges(dir)).some((i) => i.id === '12'), 'merged leaves pending merges');
  const i13 = after.find((i) => i.id === '13');
  assert(i13.status === 'FAILED' && i13.error === '测试没通过', 'issue 13 FAILED with error');

  // removeWorktree：清理失败不抛，返回 {ok:false}
  {
    const { mkdtemp: mk4 } = await import('node:fs/promises');
    const wtDir = await mk4(join(tmpdir(), 'cs-rmwt-'));
    const calls2 = [];
    const fakeRun = async (cmd, opts) => { calls2.push({ cmd, cwd: opts && opts.cwd }); return { code: 0, stdout: '', stderr: '' }; };
    const okRes = await removeWorktree({ worktree: wtDir, branch: 'issue-9', repoRoot: '/repo', runCommand: fakeRun });
    assert(okRes.ok === true, 'removeWorktree ok on success');
    assert(calls2.length === 2 && /worktree remove/.test(calls2[0].cmd) && /branch -D/.test(calls2[1].cmd), 'removeWorktree runs remove + branch -D');
    const badRes = await removeWorktree({ worktree: wtDir, repoRoot: '/repo', runCommand: async () => ({ code: 1, stdout: '', stderr: 'nope' }) });
    assert(badRes.ok === false, 'removeWorktree reports failure without throwing');
  }

  // mergeWorkspace / cleanupWorkspace：真 git 仓库整条往返（派单 → 副本改 → 合并落地 → 漂移拒 → 拆副本）
  {
    const { mkdtemp: mk5, writeFile: wf5, readFile: rf5, mkdir: mkdir5 } = await import('node:fs/promises');
    const repo = await mk5(join(tmpdir(), 'cs-merge-'));
    const g = (cmd) => rc(`git -C "${repo}" ${cmd}`, { timeoutMs: 60000 });
    await g('init -q');
    await g('-c user.name=t -c user.email=t@t commit --allow-empty -q -m init');
    await mkdir5(join(repo, 'src'), { recursive: true });
    await wf5(join(repo, 'src', 'a.txt'), 'ORIGINAL\n');
    await g('add -A');
    await g('-c user.name=t -c user.email=t@t commit -q -m base');

    const mergeParent = { id: 'merge-parent', session: { header: { id: 'merge-parent' } } };
    const fakeSub = () => ({
      listDescendants: async () => [],
      startActivation: async (req) => ({ childId: 'cs-merge-1' }),
      sendMessage: async () => ({ ok: true }),
    });
    const r = await dispatch({
      dir: repo, issue: { id: '77', title: 'merge test' },
      prompt: '改点东西', parent: mergeParent, subagents: fakeSub(), agents: {}, runCommand: rc,
    });
    assert(r.ok === true && r.worktree, 'dispatch created git worktree copy: ' + JSON.stringify(r));

    // 副本里改文件
    await wf5(join(r.worktree, 'src', 'a.txt'), 'CHANGED BY CHILD\n');
    await wf5(join(r.worktree, 'src', 'b.txt'), 'NEW FILE\n');

    const { issues: beforeMerge } = await loadIssues(repo);
    const i77 = beforeMerge.find((i) => i.id === '77');
    assert(i77.worktree === r.worktree, 'issue row records worktree');

    const merged = await mergeWorkspace({ issue: i77, dir: repo, runCommand: rc });
    assert(merged.ok === true, 'mergeWorkspace ok on clean tree: ' + JSON.stringify(merged));
    assert((await rf5(join(repo, 'src', 'a.txt'), 'utf8')).includes('CHANGED BY CHILD'), 'change landed in user dir');
    assert((await rf5(join(repo, 'src', 'b.txt'), 'utf8')).includes('NEW FILE'), 'new file landed in user dir');

    // 漂移拒绝：用户手改 + 副本再改 → USER_DRIFT，用户文件不动
    await wf5(join(r.worktree, 'src', 'a.txt'), 'CHILD AGAIN\n');
    await wf5(join(repo, 'src', 'a.txt'), 'USER EDIT\n');
    const drift = await mergeWorkspace({ issue: i77, dir: repo, runCommand: rc });
    assert(drift.ok === false && drift.code === 'USER_DRIFT', 'mergeWorkspace rejects user drift');
    assert((await rf5(join(repo, 'src', 'a.txt'), 'utf8')).includes('USER EDIT'), 'user file untouched on drift');

    // 拆副本：worktree 目录消失，分支删掉，用户目录活着
    const cleaned = await cleanupWorkspace({ issue: i77, dir: repo, runCommand: rc });
    assert(cleaned.ok === true, 'cleanupWorkspace ok for worktree');
    assert(!existsSync(r.worktree), 'worktree dir removed');
    const branches = await g('branch --list issue-77');
    assert(String(branches.stdout ?? '').trim() === '', 'issue-77 branch deleted');
    assert(existsSync(join(repo, 'src', 'a.txt')), 'user dir survives cleanup');
  }

  // mergeWorkspace 的 git 路径：手动建 worktree，worktree 里改，合回主工作树
  {
    const { mkdtemp: mk6, writeFile: wf6, readFile: rf6 } = await import('node:fs/promises');
    const repo = await mk6(join(tmpdir(), 'cs-gitmerge-'));
    const g = (cmd) => rc(`git -C "${repo}" ${cmd}`, { timeoutMs: 60000 });
    await g('init -q');
    await g('-c user.name=t -c user.email=t@t commit --allow-empty -q -m init');
    await wf6(join(repo, 'f.txt'), 'BASE\n');
    await g('add -A');
    await g('-c user.name=t -c user.email=t@t commit -q -m base');

    const wt = join(repo, '..', `${repo.split(/[\\/]/).pop()}-wt`);
    await g(`worktree add -q -b issue-88 "${wt}"`);
    await wf6(join(wt, 'f.txt'), 'FROM WORKTREE\n');

    // 主工作树干净 → 可以合
    const okMerge = await mergeWorkspace({
      issue: { id: '88', worktree: wt }, dir: repo, runCommand: rc,
    });
    assert(okMerge.ok === true, 'git mergeWorkspace ok on clean tree');
    assert((await rf6(join(repo, 'f.txt'), 'utf8')).includes('FROM WORKTREE'), 'git change landed in main tree');

    // 主工作树脏 → 拒（USER_DRIFT），且脏文件不动
    await wf6(join(wt, 'f.txt'), 'SECOND\n');
    await wf6(join(repo, 'f.txt'), 'USER DIRTY\n');
    const dirtyMerge = await mergeWorkspace({
      issue: { id: '88', worktree: wt }, dir: repo, runCommand: rc,
    });
    assert(dirtyMerge.ok === false && dirtyMerge.code === 'USER_DRIFT', 'git mergeWorkspace rejects dirty tree');
    assert((await rf6(join(repo, 'f.txt'), 'utf8')).includes('USER DIRTY'), 'dirty file untouched');

    // cleanupWorkspace 的 git 路径：副本目录消失 + 分支被删
    const cl = await cleanupWorkspace({ issue: { id: '88', worktree: wt }, dir: repo, runCommand: rc });
    assert(cl.ok === true, 'cleanupWorkspace ok for worktree');
    assert(!existsSync(wt), 'worktree dir removed');
    const branches = await g('branch --list issue-88');
    assert(String(branches.stdout ?? '').trim() === '', 'issue-88 branch deleted');
  }

  // ---- prepareIssue：备单（不开会话）——READY / worktree / 不写 childId / RUNNING 保持 ----
  {
    const { mkdtemp: mkP, writeFile: wfP } = await import('node:fs/promises');
    const dirP = await mkP(join(tmpdir(), 'cs-prepare-'));
    const gp = (cmd) => rc(`git -C "${dirP}" ${cmd}`, { timeoutMs: 60000 });
    await gp('init -q');
    await wfP(join(dirP, 'a.txt'), 'x\n');
    await gp('add .');
    await gp('-c user.name=t -c user.email=t@l commit -q -m base');
    const issue = { id: '900', title: 't', body: '改 a.txt 里的东西' };
    const p = await prepareIssue({ dir: dirP, issue, semanticRoute: ['docs'], runCommand: rc });
    assert(p.ok === true && p.mode === 'prepare' && p.worktree, 'prepareIssue ok');
    assert(existsSync(p.worktree), 'prepareIssue worktree exists');
    const stored = (await loadIssues(dirP)).issues.find((i) => i.id === '900');
    assert(stored?.status === 'READY', 'prepareIssue marks READY');
    assert(stored?.childId === undefined, 'prepareIssue leaves childId alone');
    assert(stored?.tags?.join(',') === 'docs', 'prepareIssue semanticRoute → tags');
    // 主 Agent 登记子会话（set childId → RUNNING），再备一次单：状态与 childId 都保持
    await upsertIssue(dirP, { id: '900', status: 'RUNNING', childId: 'child-1' });
    const p2 = await prepareIssue({ dir: dirP, issue, runCommand: rc });
    assert(p2.ok === true, 'prepareIssue re-prepare ok');
    const stored2 = (await loadIssues(dirP)).issues.find((i) => i.id === '900');
    assert(stored2?.status === 'RUNNING' && stored2?.childId === 'child-1', 'prepareIssue keeps RUNNING/childId');
    // 非 git 目录 → 硬闸
    const nogit = await mkP(join(tmpdir(), 'cs-prep-nogit-'));
    const p3 = await prepareIssue({ dir: nogit, issue: { id: '901', title: 't', body: '' }, runCommand: rc });
    assert(p3.ok === false && p3.code === 'NOT_GIT_REPO', 'prepareIssue hard-gates non-git dir');
    // 仓库串行闸：queue + 在飞单 → 拒备单
    await (await import('./studio-store.js')).saveQueue(dirP, true);
    const p4 = await prepareIssue({ dir: dirP, issue: { id: '902', title: 't', body: '' }, runCommand: rc });
    assert(p4.ok === false && p4.code === 'REPO_QUEUED', 'prepareIssue respects repo queue: ' + JSON.stringify(p4));
  }

  console.log('studio-dispatch: demo OK');
}

if (process.argv[1] && process.argv[1].endsWith('studio-dispatch.js')) {
  demo().catch((error) => { console.error(error); process.exit(1); });
}
