// lib/runtime.js — 运行时层：任务注册表 / 编排器 / 执行器 / 派合并 / 中止。
// 自 index.js 原样搬出（重构第④⑤步）。结算函数 handleChildEnd 留在 index.js ——
// 它要引用 watcher 的 loadSessionGithub/loadSessionToken，而 watcher 又要本模块的产物，留 index 免循环注入。
// 分层纪律：可碰 ctx 但不注册工具；工具与 watcher 经 createRuntime(env) 拿到这里的产物。
import { readFile } from 'node:fs/promises';
import { TaskRegistry, canonicalWorkspace } from './task-registry.js';
import { Orchestrator } from './orchestrator.js';
import { markChild, unmarkChild } from './session-roles.js';
import { roleCardPath } from './roles.js';
import { pozhangAgentPrefix, pozhangAnchor } from './pozhang-command.js';
import { upsertIssue, getIssue } from './studio-store.js';
import { readAgentMemory } from './studio-memory.js';
import { dispatchIssue, settleIssue } from './studio-dispatch.js';
import { makeCliExecutor, makeDshExecutor } from './executor.js';
import { sessionIdOf, resolveMemoryRoot } from './studio-workspace.js';
import { listCandidateDirs, classifyFolders } from './studio-route.js';

export function createRuntime(env) {
  const { ctx, config } = env;

  // -------------------------------------------------------------------------
  // 任务注册表 + 编排器（与小说插件同构）
  // -------------------------------------------------------------------------

  const REGISTRIES = new Map();
  async function registryFor(dir) {
    const key = canonicalWorkspace(dir);
    let registry = REGISTRIES.get(key);
    if (!registry) {
      registry = new TaskRegistry(key);
      REGISTRIES.set(key, registry);
    }
    await registry.load();
    return { registry, key };
  }

  const ORCHESTRATORS = new Map();

  // 工作室派出的持久子会话 → { dir, issueIds }。一个持久子会话可串行服务多个 issue，
  // 每次 dispatch（新建或 reuse）入队一个 issueId，每次 subagent/end（一次 run 结束）出队一个，
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

  function routeForRole(role) {
    const settings = ctx.get?.('codeStudioAgentModels');
    return typeof settings?.routeFor === 'function' ? settings.routeFor(role) : undefined;
  }

  // 语义初判（只在 folders 抽不出来时跑一次）：请一次模型从仓库目录清单里挑归属。
  // 用一个已配角色的 route（planner → implementer → 任一派单角色），都没有就跳过。
  async function makeSemanticRoute(dir) {
    const llm = ctx.get?.('llm');
    if (typeof llm?.stream !== 'function') return null;
    let route;
    for (const r of ['planner', 'implementer', 'reviewer']) {
      route = routeForRole(r);
      if (route?.provider && route?.model) break;
      route = undefined;
    }
    if (!route?.provider) return null;
    let candidates = [];
    try { candidates = await listCandidateDirs(dir); } catch { return null; }
    if (!candidates.length) return null;
    return async ({ issue }) => classifyFolders({ route, llm, candidates, issue });
  }
  async function orchestratorFor(dir, parent) {
    if (!parent?.id) return { ok: false, reason: '拿不到父 Agent id，无法建立编排器。' };
    const { registry, key: workspaceKey } = await registryFor(dir);
    const key = `${workspaceKey}|${parent.id}`;
    const cached = ORCHESTRATORS.get(key);
    if (cached) return { ok: true, orchestrator: cached };

    const subagents = ctx.get?.('subagents');

    const dispatch = async ({ childId, role, prompt, label, task }) => {
      // 编排器的派单也走执行器：换 CLI 执行器时这一路同样不用改。
      const executor = executorFor(parent);
      if (!executor) throw new Error('没有可用执行器，派不出子会话。');
      const started = await executor.start({
        childId,
        label: label ?? role,
        // 子会话是否继承 AGENTS.md 由运行时决定，不假设——显式前置破障正文
        prompt: pozhangAgentPrefix() + prompt + pozhangAnchor(role),
        route: routeForRole(role),
      });
      const actual = String(started?.childId ?? childId);
      markChild(actual, { role, writeScope: task?.write_scope, taskId: task?.id, label, parentId: parent?.id });
      return { childId: actual };
    };

    const orchestrator = new Orchestrator({
      registry,
      dispatch,
      interruptChild: async (childId) => {
        unmarkChild(childId);
        // 中止也是执行器能力：DSH 转 subagents.interrupt，CLI 是 kill 子进程。
        try { executorFor(parent)?.stop?.(childId); } catch { /* 已结束 */ }
      },
      notify: (event, detail) => {
        const log = ctx.logger ?? console;
        if (event === 'error') log.warn?.(`code-studio orchestrator: ${detail?.error?.message ?? detail?.error ?? 'unknown'}`);
        else log.debug?.(`code-studio orchestrator: ${event}`);
      },
    });
    orchestrator.parentId = parent.id;

    void orchestrator.run().catch(() => {});
    orchestrator.timer = setInterval(() => orchestrator.enqueueTimer(), 15000);
    orchestrator.timer.unref?.();

    ORCHESTRATORS.set(key, orchestrator);
    return { ok: true, orchestrator };
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
  if (CLI_EXECUTOR) CLI_EXECUTOR.onEnd((end) => handleChildEnd(end));

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
  async function spawnMerger({ dir, issue, id, files, exec }) {
    const parent = exec?.agent;
    if (!parent?.id) return { ok: false, reason: '拿不到父 Agent id' };
    // 合并 Agent 也走执行器：换 CLI 执行器时它一样能被派出去解冲突。
    const executor = executorFor(parent);
    if (!executor) return { ok: false, reason: '没有可用执行器，派不出合并 Agent' };
    if (!issue?.worktree) return { ok: false, reason: `issue #${id} 没有副本目录可解冲突` };

    const card = await readFile(roleCardPath('merger'), 'utf8').catch(() => '');
    const prompt = [
      card.trim() || '# 合并 Agent\n你负责在副本里解掉冲突，然后把这一单合并回主干。',
      '',
      '## 任务单',
      `- issue：#${id}${issue.title ? `（${issue.title}）` : ''}`,
      `- 副本目录（你的 cwd，直接改它）：${issue.worktree}`,
      '- 这是 git worktree 副本，直接 git merge。',
      '',
      '## 冲突',
      files.length ? files.join('\n') : '（git 没列出具体文件，先在副本里 git status 看）',
      '',
      `解完后执行 \`code_merge id=${id} rebased=true\`。`,
    ].filter(Boolean).join('\n');

    const label = `merger:issue-${id}`;
    const childId = `cs-merger-${String(id).replace(/[^a-zA-Z0-9._-]+/g, '-')}-${Date.now().toString(36)}`;
    try {
      const started = await executor.start({
        childId,
        label,
        prompt: pozhangAgentPrefix() + prompt + pozhangAnchor('merger'),
        cwd: issue.worktree,
        route: routeForRole('merger'),
      });
      const actual = String(started?.childId ?? childId);
      markChild(actual, { role: 'merger', taskId: undefined, label, parentId: parent.id });
      await upsertIssue(dir, { id, mergeChildId: actual }).catch(() => {});
      return { ok: true, childId: actual };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  // -------------------------------------------------------------------------
  // 规格化操作表（契约在 lib/ops.js，实现只写一次）
  // -------------------------------------------------------------------------
  // 三处入口共用这一份实现：code_op 工具 / code_studio·code_merge 工具 / 网页右栏 HTTP。
  // 外部 Agent（CLI、别的 harness）走 HTTP op=run 也是同一条路，参数表与返回形状完全一致。

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
    registryFor,
    REGISTRIES,
    ORCHESTRATORS,
    STUDIO_CHILDREN,
    trackStudioChild,
    routeForRole,
    makeSemanticRoute,
    orchestratorFor,
    executorFor,
    makeMemoryFor,
    spawnMerger,
    cancelIssue,
  };
}
