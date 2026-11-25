// lib/runtime.js — 运行时层：子会话登记 / 执行器 / 记忆 / 中止。
// 插件定位是「子 Agent 团队的协调工具」，不携带子 Agent —— 编排器/任务注册表/角色路由已砍，
// 只留 watch 路径需要的执行器（收件箱/GitHub 轮询 = 预授权自动化）与登记/结算的簿记。
// 分层纪律：可碰 ctx 但不注册工具；工具与 watcher 经 createRuntime(env) 拿到这里的产物。
import { getIssue } from './studio-store.js';
import { readAgentMemory } from './studio-memory.js';
import { settleIssue } from './studio-dispatch.js';
import { makeCliExecutor, makeDshExecutor } from './executor.js';
import { sessionIdOf, resolveMemoryRoot } from './studio-workspace.js';

export function createRuntime(env) {
  const { ctx, config } = env;

  // 工作室派出的持久子会话 → { dir, issueIds }。一个持久子会话可串行服务多个 issue，
  // 每次 dispatch/登记入队一个 issueId，每次 subagent/end（一次 run 结束）出队一个，
  // 据此把报告写回那棵树 issues.json 里**对应的那一条**。
  const STUDIO_CHILDREN = new Map();

  function trackStudioChild(childId, dir, issueId, sessionId) {
    if (!childId) return;
    const entry = STUDIO_CHILDREN.get(childId) ?? { dir, issueIds: [] };
    entry.dir = dir;
    if (sessionId) entry.sessionId = sessionId;
    if (issueId) entry.issueIds.push(String(issueId));
    STUDIO_CHILDREN.set(childId, entry);
  }

  // 语义初判（只在 folders 抽不出来时跑一次）：向模型问一次归属。插件不再携带角色
  // 模型指派（codeStudioAgentModels 已砍）→ 没有可用的 route，直接跳过，
  // folders 兜底为空（用户在 issue 里自己写路径）。
  async function makeSemanticRoute() {
    return null;
  }

  /**
   * 给一个父 Agent 取 DSH 执行器（按 parent.id 缓存）。
   * 派单/追回/判活全走 lib/executor.js 的接口 —— DSH 只是其中一种实现，
   * 换成本机 CLI 执行器（makeCliExecutor）时这套 region/issue/副本/待合并流程一行都不用改。
   * 结束事件仍由 ctx 的 subagent/end 喂给 handleChildEnd（DSH 的 end 从 ctx 发，不从 subagents 发）。
   */
  const EXECUTORS = new Map();
  // config.executor = { command, args?, cwdOf? } 时改用本机 CLI 执行器（claude / codex / 自写脚本）。
  // 不给就走 DSH 子 Agent —— 两种执行器共用同一套 region/issue/副本/待合并流程。
  const CLI_EXECUTOR = config.executor?.command ? makeCliExecutor(config.executor) : null;
  function executorFor(parent) {
    if (CLI_EXECUTOR) return CLI_EXECUTOR;
    const subagents = ctx.get?.('subagents');
    if (typeof subagents?.startActivation !== 'function' || !parent?.id) return null;
    const key = String(parent.id);
    const cached = EXECUTORS.get(key);
    if (cached) return cached;
    try {
      const ex = makeDshExecutor({ subagents, agents: ctx.get?.('agents'), parent });
      EXECUTORS.set(key, ex);
      return ex;
    } catch { return null; }
  }
  // CLI 执行器的结束从子进程退出发，不是从 ctx —— 接同一个结算入口。
  if (CLI_EXECUTOR) CLI_EXECUTOR.onEnd((end) => env.onChildEnd?.(end));

  /**
   * 造一个「读某子会话上次落盘结论」的取值函数，交给 dispatchIssue 垫在指令前面。
   * 冷恢复（换进程 / 追回 idle 子会话）时子会话的对话上下文已经没了，只剩
   * `sessions/<rootSid>/agents/<childId>.md` 这份 —— 不读回来等于白记。读不到返回 ''。
   */
  function makeMemoryFor(dir, parent) {
    const sid = sessionIdOf(parent) || '';
    return async (childId) => {
      if (!sid || !childId) return '';
      try {
        const root = await resolveMemoryRoot(dir, sid).catch(() => ({ rootSessionId: sid }));
        return readAgentMemory(dir, root.rootSessionId || sid, childId);
      } catch { return ''; }
    };
  }

  /** 中止一条 issue：打断子会话 → 账本落 FAILED。工具层与 HTTP 层共用。 */
  async function cancelIssue(dir, id, agent) {
    const issue = await getIssue(dir, id).catch(() => null);
    if (!issue) return { ok: false, text: `没有 issue #${id}` };
    if (issue.childId) {
      const executor = executorFor(agent);
      try {
        if (executor?.stop) await executor.stop(issue.childId);
        else await ctx.get('subagents')?.interrupt?.(issue.childId, { kind: 'ancestor', agent });
      } catch { /* 已不在跑也不拦着落账 */ }
      const entry = STUDIO_CHILDREN.get(String(issue.childId));
      if (entry) {
        entry.issueIds = (entry.issueIds ?? []).filter((iid) => iid !== String(id));
        if (!entry.issueIds.length) STUDIO_CHILDREN.delete(String(issue.childId));
      }
    }
    await settleIssue(dir, id, { ok: false, error: '人工中止' }).catch(() => {});
    return { ok: true, text: `已中止 issue #${id}。` };
  }

  return {
    STUDIO_CHILDREN,
    trackStudioChild,
    makeSemanticRoute,
    executorFor,
    makeMemoryFor,
    cancelIssue,
  };
}
