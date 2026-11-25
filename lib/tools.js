// lib/tools.js — 14 个 DSH 工具的构建与注册（code_task/dispatch/merge/studio/op/memory + qa 组）。
// 自 index.js 原样搬出（重构第③步）。分层纪律：只读注入的 env，不直接注册到 ctx（注册由 index 做）；
// 宿主服务与 index 内部助手（executorFor/orchestratorFor/workDir/watcher 全家）一律经 createTools(env) 注入。
import { SETTLE_STATUSES, workspaceMatches } from './task-registry.js';
import { markChild, unmarkChild } from './session-roles.js';
import { ROLE_IDS, buildRolesTool } from './roles.js';
import { textResult, reportOutput, notManagedLine } from './toolkit.js';
import { pozhangAgentPrefix, pozhangAnchor } from './pozhang-command.js';
import { DISPATCH_TOOL, DETACHED_SIGNAL, SPAWN_PROVIDER, buildDispatchRequest, buildOneShotActivation, describeRoute, outputText, stopReasonText, withDepthCap } from './dispatch.js';
import { buildPacket } from './packet.js';
import { runChecks, runCommand } from './runner.js';
import { renderMap } from './map.js';
import { renderReview } from './review.js';
import { assessDispatch, renderEval } from './eval.js';
import { loadIssues, loadRegions, upsertIssue, upsertRegion, planRegion, getIssue } from './studio-store.js';
import { dispatchIssue, settleIssue, cleanupWorkspace, mergeWorkspace, regionSettled, pendingMerges } from './studio-dispatch.js';
import { restoreShadow, detectDrift } from './studio-shadow.js';
import { loadWatch, saveWatch, normalizeWatch } from './studio-watch.js';
import { parseRepoSlug, writeBackIssue, saveGithubTo } from './studio-github.js';
import { sessionIdOf } from './studio-workspace.js';
import { addRule, removeRule, listRules } from './studio-rules.js';
import { createPr, resolvePrDir } from './studio-pr.js';
import { normalizeIssue } from './studio-intake.js';
import { memoryIndexExecute, MEMORY_TIERS } from './studio-memory-index.js';
import { genericSchema, unionSchema, createOpRegistry, describeOps, canonicalOp } from './ops.js';
import { prDestination, enrichRemotes } from './studio-repo.js';

export function createTools(env) {
  const {
    ctx,
    executorFor,
    makeMemoryFor,
    trackStudioChild,
    routeForRole,
    makeSemanticRoute,
    STUDIO_CHILDREN,
    spawnMerger,
    cancelIssue,
    orchestratorFor,
    registryFor,
    workDir,
    buildIssuePrompt,
    rulesForRole,
    resolveIssueDir,
    listRepos,
    ensureStudio,
    sessionStudioDir,
    loadSessionGithub,
    loadSessionToken,
    saveSessionGithub,
    runScan,
    runGithubSync,
    ensureWatcher,
    summarizeScan,
    formatGithubResults,
  } = env;

  function workspaceGate(dir, workspaceId) {    if (workspaceId === undefined || workspaceId === null || String(workspaceId).trim() === '') return null;
    return workspaceMatches(String(workspaceId), dir)
      ? null
      : `工作区不匹配（403）：本次调用带 workspace_id=「${workspaceId}」，目标仓库目录是「${canonicalWorkspace(dir)}」。任务注册表按仓库目录物理隔离。`;
  }

  const stamp = (value) => (Number.isFinite(Number(value)) && value !== null && value !== undefined
    ? new Date(Number(value)).toISOString()
    : '无');
  const scopeText = (task) => (Array.isArray(task?.write_scope) && task.write_scope.length ? task.write_scope.join(', ') : '（无）');
  const currentText = (task) => `当前：status=${task?.status ?? '?'}，version=${task?.version ?? '?'}，owner=${task?.owner_agent ?? '无主'}。`;
  const rejected = (action, result, id) => `${action} 被拒绝（${result?.code ?? 'UNKNOWN'}）：${result?.reason ?? `详见任务 ${id} 当前状态`}。${currentText(result?.task)}`;

  // -------------------------------------------------------------------------
  // code_task
  // -------------------------------------------------------------------------

  function buildTaskTool() {
    return {
      name: 'code_task',
      description:
        '任务注册表：把「谁在做哪一步」变成带 owner / version / 租约的可查记录。'
        + '技术总监派单前先 open 一个任务，子 Agent 结算后 settle；租约过期的任务由 reclaim 收回。'
        + 'action 取 open|claim|renew|settle|release|cancel|pick|get|list|reclaim|events。'
        + '每一条写操作都要带对的 agent_id 与 version —— 版本不对就是拒绝，不会静默覆盖别人的成果。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['open', 'claim', 'renew', 'settle', 'release', 'cancel', 'pick', 'get', 'list', 'reclaim', 'events'], description: '要执行的操作' },
          work: { type: 'string', description: '仓库名或目录；省略时用会话工作区' },
          id: { type: 'string', description: '任务 id（open 时可省略，会自动生成）' },
          goal: { type: 'string', description: 'open：这一步要达成什么（非空）' },
          parent_id: { type: 'string', description: 'open：父任务 id' },
          agent_id: { type: 'string', description: 'claim/renew/settle/release：认领者的 agent id' },
          version: { type: 'number', description: 'renew/settle/release/cancel：手里的任务版本' },
          status: {
            type: 'string',
            enum: ['READY', 'ASSIGNED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED', 'BLOCKED'],
            description: 'settle：终态，只接受 DONE/FAILED/CANCELLED/BLOCKED；list：按状态过滤',
          },
          priority: { type: 'number', description: 'open：0-4，默认 2' },
          write_scope: { type: 'array', items: { type: 'string' }, description: 'open：这一步允许写哪些路径（文件 glob）' },
          owner_agent: { type: 'string', description: 'open：直接指派所有者；list：按所有者过滤' },
          result_ref: { type: 'string', description: 'settle：产物引用（路径或 commit id）' },
          digest: { type: 'string', description: 'settle：结果摘要，用来识别重复提交' },
          error: { type: 'string', description: 'settle：失败原因' },
          reason: { type: 'string', description: 'cancel：取消原因' },
          child_id: { type: 'string', description: 'pick：选中的那个平行版本的子会话 id' },
          lease_ms: { type: 'number', description: 'claim/renew：租约毫秒数，默认 30000' },
          reclaim_expired: { type: 'boolean', description: 'claim：顺便回收同一任务的过期租约' },
          workspace_id: { type: 'string', description: '工作区标识；给了就必须与目标仓库目录一致，否则拒绝' },
        },
        required: ['action'],
      },
      output: reportOutput((_args, value) => textResult(value.report)),
      execute: (args, exec) => (async () => {
        const action = String(args.action ?? '');
        const dir = workDir(args.work, exec);
        const denied = workspaceGate(dir, args.workspace_id);
        if (denied) return { report: denied };
        const { registry } = await registryFor(dir);
        const id = args.id === undefined || args.id === null ? '' : String(args.id).trim();

        try {
          if (action === 'open') {
            const result = await registry.open({
              ...(id ? { id } : {}),
              goal: args.goal, parent_id: args.parent_id, priority: args.priority,
              write_scope: args.write_scope, owner_agent: args.owner_agent,
            });
            if (!result.ok) return { report: rejected('open', result, id) };
            const task = result.task;
            return { report: `已建任务 ${task.id}（status=${task.status}，version=${task.version}，priority=${task.priority}，parent=${task.parent_id ?? '无'}）。\nwrite_scope=${scopeText(task)}` };
          }
          if (action === 'claim') {
            const result = await registry.claim(id, args.agent_id, { leaseMs: args.lease_ms, reclaimExpired: args.reclaim_expired === true });
            if (result.ok) return { report: `已认领 ${result.task.id}（owner=${result.task.owner_agent}，version=${result.task.version}，租约至 ${stamp(result.task.lease_until)}）。` };
            return { report: rejected('claim', result, id) };
          }
          if (action === 'renew') {
            const result = await registry.renewLease(id, args.agent_id, args.version, { leaseMs: args.lease_ms });
            if (result.ok) return { report: `已续约 ${result.task.id}（version=${result.task.version}，租约至 ${stamp(result.task.lease_until)}）。` };
            return { report: rejected('renew', result, id) };
          }
          if (action === 'settle') {
            const result = await registry.settle(id, args.agent_id, args.version, {
              status: args.status, result_ref: args.result_ref, digest: args.digest, error: args.error,
            });
            if (result.ok) return { report: `已结算 ${result.task.id} → ${result.task.status}（version=${result.task.version}）。` };
            return { report: rejected('settle', result, id) };
          }
          if (action === 'release') {
            const result = await registry.release(id, args.agent_id, args.version);
            if (result.ok) return { report: `已释放 ${result.task.id}（退回 READY）。` };
            return { report: rejected('release', result, id) };
          }
          if (action === 'cancel') {
            const result = await registry.cancel(id, args.agent_id, { reason: args.reason });
            if (result.ok) return { report: `已取消 ${result.task.id}。` };
            return { report: rejected('cancel', result, id) };
          }
          if (action === 'get') {
            const task = registry.get(id);
            if (!task) return { report: `任务 ${id} 不存在。` };
            return { report: [`任务 ${task.id}`, `status=${task.status} version=${task.version} owner=${task.owner_agent ?? '无主'}`, `goal=${task.goal ?? ''}`, `write_scope=${scopeText(task)}`, `parent=${task.parent_id ?? '无'}`, `lease=${stamp(task.lease_until)}`].join('\n') };
          }
          if (action === 'list') {
            const filter = {};
            if (args.status) filter.status = args.status;
            if (args.owner_agent) filter.owner_agent = args.owner_agent;
            if (args.parent_id) filter.parent_id = args.parent_id;
            const tasks = registry.list(filter);
            if (!tasks.length) return { report: '没有符合条件的任务。' };
            const lines = [`共 ${tasks.length} 笔任务：`];
            for (const t of tasks) lines.push(`- ${t.id} [${t.status}] owner=${t.owner_agent ?? '无主'} scope=${scopeText(t)}｜${t.goal ?? ''}`);
            return { report: lines.join('\n') };
          }
          if (action === 'reclaim') {
            const result = await registry.reclaim();
            const reclaimed = Array.isArray(result?.reclaimed) ? result.reclaimed : [];
            const quarantined = Array.isArray(result?.quarantined) ? result.quarantined : [];
            return { report: `已回收 ${reclaimed.length} 笔过期租约任务${quarantined.length ? `；${quarantined.length} 笔状态自相矛盾未回收（${quarantined.join('、')}）` : ''}。` };
          }
          if (action === 'events') {
            const events = registry.events(id);
            return { report: `任务 ${id} 的事件（${events.length} 条）：\n` + events.map((e) => `- ${e.type}`).join('\n') };
          }
          if (action === 'pick') {
            const groupId = id;
            const childId = String(args.child_id ?? '').trim();
            if (!groupId || !childId) return { report: 'pick 需要 id（父任务）与 child_id（选中的子会话）。' };
            const siblings = registry.list({ parent_id: groupId });
            const chosen = siblings.find((t) => String(t.owner_agent) === childId);
            if (!chosen) return { report: `父任务 ${groupId} 下没有 owner=${childId} 的子任务。` };
            // 先结算父分组任务（纯记账，不改文件）：用固定审计名让「谁选的」可查。
            const picker = 'tech-lead-pick';
            const parentTask = registry.get(groupId);
            if (parentTask && !SETTLE_STATUSES.includes(String(parentTask.status))) {
              const claimed = await registry.claim(groupId, picker, {});
              if (claimed.ok) await registry.settle(groupId, picker, claimed.task.version, { status: 'DONE', result_ref: chosen.id, digest: `picked:${chosen.id}` });
            }
            const dropped = [];
            for (const task of siblings) {
              if (String(task.id) === String(chosen.id)) continue;
              if (SETTLE_STATUSES.includes(String(task.status))) { dropped.push(`${task.id}(已${task.status})`); continue; }
              const ownerId = String(task.owner_agent ?? '');
              if (ownerId && exec?.agent) {
                try { executorFor(exec.agent)?.stop?.(ownerId); } catch { /* 已结束 */ }
              }
              unmarkChild(ownerId);
              await registry.cancel(task.id, task.owner_agent ?? undefined, { reason: `已选定 ${chosen.id}，其余平行版本作废` });
              dropped.push(`${task.id}(已作废)`);
            }
            return { report: `已选定 ${chosen.id}（owner=${childId}）。其余版本：${dropped.length ? dropped.join('、') : '无'}。\n下一步：派 implementer 或 maintenance 把选定版本落成正式文件。` };
          }
          return { report: `未知 action「${action}」。` };
        } catch (error) {
          return { report: `任务注册表操作失败：${error instanceof Error ? error.message : String(error)}` };
        }
      })(),
    };
  }

  // -------------------------------------------------------------------------
  // code_dispatch
  // -------------------------------------------------------------------------

  function buildDispatchTool() {
    return {
      name: DISPATCH_TOOL,
      description:
        '按代码工作室角色派单：从设置页的「角色 → 模型」指派里取出该角色的 provider/model，'
        + '用这个模型起一个常驻子会话，**立即返回子会话 id，不等它跑完**。'
        + '子 Agent 结算时，宿主的结算消息会自己进入你的对话；在那之前你可以继续和用户对话、继续派单。'
        + '默认会自动开一个任务账再派单，可用 task_id 指定已有任务；派单后**不要等**。'
        + 'role 取 ' + ROLE_IDS.join('|') + '；prompt 必须自带该角色的角色卡全文与本次任务单。'
        + '未在设置里指派的角色会继承你（技术总监）的模型。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          role: { type: 'string', enum: ROLE_IDS.filter((r) => r !== 'tech-lead'), description: '目标角色 id（不含 tech-lead：子会话不得再派技术总监）' },
          prompt: { type: 'string', description: '子 Agent 的完整提示词（角色卡全文 + 任务单 + 相关代码资料）' },
          label: { type: 'string', description: '这一步做什么，用于进度显示（3-5 个词）' },
          work: { type: 'string', description: '仓库名或仓库目录；省略时用会话工作区' },
          task_id: { type: 'string', description: '已用 code_task 开好的任务 id；省略时本次派单会自动开一个任务' },
          parent_id: { type: 'string', description: '自动开任务时挂到哪个父任务下' },
          write_scope: { type: 'array', items: { type: 'string' }, description: '自动开任务时允许写哪些路径（文件 glob）；用 variants 时把版本位写成 {v}，例如 src/api.{v}.ts' },
          variants: {
            type: 'array',
            items: { type: 'string' },
            description:
              '平行版本：给 2-5 个**互不相同的侧重**（例如 ["最小改动","重构清晰","防御式"]），'
              + '为每个侧重各开一笔带独立 write_scope 的任务、同时派出多个同角色子会话。'
              + 'write_scope 里的 {v} 会被替换成各自的名字。每版只出粗实现，供用户自己先挑一版。',
          },
          eval_mode: { type: 'string', enum: ['off', 'observe', 'auto'], description: '派单前评估门：默认 observe 只警告；auto 时缺 objective/source_paths/acceptance 直接拒绝派单' },
          objective: { type: 'string', description: '这一步要达成什么（评估门用）' },
          source_paths: { type: 'array', items: { type: 'string' }, description: '要读/改的路径（评估门用）' },
          acceptance: { type: 'array', items: { type: 'string' }, description: '验收判据（评估门用）' },
          stage: { type: 'string', description: '当前阶段（评估门用）' },
        },
        required: ['role', 'prompt'],
      },
      output: reportOutput((_args, value) => textResult(value.report)),
      execute: (args, exec) => (async () => {
        const role = String(args.role ?? '').trim();
        const prompt = String(args.prompt ?? '').trim();
        if (!ROLE_IDS.includes(role)) return { report: `未知角色「${role}」，可用：${ROLE_IDS.join(' / ')}。` };
        if (!prompt) return { report: 'prompt 不能为空：请把角色卡全文与本次任务单一起传进来。' };

        const parent = exec?.agent;
        if (!parent) return { report: '派单失败：拿不到调用方 Agent（exec.agent 未定义）。' };
        const executor = executorFor(parent);
        const subagents = ctx.get?.('subagents');
        if (!executor && typeof subagents?.start !== 'function') {
          return { report: '派单失败：既没有可用执行器，subagents 服务也不可用，请改用 subagent 工具（本次将继承父 Agent 的模型）。' };
        }

        const route = routeForRole(role);
        const modelLine = route ? describeRoute(role, route) : `${role} · 未指派模型（继承父 Agent）`;

        // 派单前评估门（真的会拦，不再只是 code_eval 装饰）：默认 observe 只警告；
        // 传 eval_mode:'auto' 且缺 objective/source_paths/acceptance 时直接拒绝派单。
        let evalNote = '';
        try {
          const evalMode = ['off', 'observe', 'auto'].includes(String(args.eval_mode ?? '')) ? String(args.eval_mode) : 'observe';
          if (evalMode !== 'off') {
            const evalReport = assessDispatch({
              role,
              objective: args.objective,
              source_paths: args.source_paths,
              acceptance: args.acceptance,
              write_scope: args.write_scope,
              stage: args.stage,
              contracts: args.contracts,
              constraints: args.constraints,
              deliverable: args.deliverable,
            }, { mode: evalMode });
            if (evalMode === 'auto' && evalReport.verdict === 'reject') {
              return { report: `派单被评估门拒绝（缺 ${evalReport.missing.join('、')}）。补全后重试，或传 eval_mode:'observe' 只警告。\n\n${renderEval(evalReport)}` };
            }
            if (evalReport.verdict !== 'proceed' || evalReport.warnings.length) evalNote = `\n\n---\n${renderEval(evalReport)}`;
          }
        } catch { /* 评估门出错不挡派单 */ }

        // 平行版本
        const variantList = Array.isArray(args.variants)
          ? args.variants.map((item) => String(item ?? '').trim()).filter((item) => item !== '').slice(0, 5)
          : [];
        if (variantList.length > 0) {
          if (variantList.length < 2) return { report: 'variants 至少要给两个互不相同的侧重；只有一个就直接派单。' };
          if (!executor) return { report: 'variants 需要能派常驻子会话的执行器，当前没有可用执行器，请逐个派单。' };
          const dir = workDir(args.work, exec);
          const ready = await orchestratorFor(dir, parent);
          if (!ready.ok) return { report: `派单失败：${ready.reason}` };
          const orchestrator = ready.orchestrator;
          const registry = orchestrator.registry;
          const scopeTemplate = Array.isArray(args.write_scope) ? args.write_scope.map((item) => String(item ?? '')).filter((item) => item.trim() !== '') : [];
          const shared = scopeTemplate.filter((item) => !item.includes('{v}'));
          if (shared.length > 0) {
            return { report: `variants 的 write_scope **每一条**都必须含 {v}：没有 {v} 的「${shared.join('、')}」是所有版本共享目标，会互相覆盖。` };
          }
          const groupLabel = String(args.label ?? '').trim() || `${role}：${variantList.length} 个版本`;
          const group = await registry.open({
            goal: `${groupLabel}（平行版本，待选定）`, parent_id: args.parent_id,
            write_scope: scopeTemplate.map((item) => item.replace(/\{v\}/g, '*')),
          });
          if (!group?.ok) return { report: `派单失败：开分组任务被拒（${group?.code ?? '未知'}）。` };
          const lines = [`## ${variantList.length} 个平行版本（${modelLine}）`, '', `分组任务：${group.task.id}`, ''];
          let dispatched = 0;
          for (const variant of variantList) {
            const scope = scopeTemplate.map((item) => item.replace(/\{v\}/g, variant));
            const opened = await registry.open({ goal: `${groupLabel} · ${variant}`, parent_id: group.task.id, write_scope: scope });
            if (!opened?.ok) { lines.push(`- ${variant}：开任务被拒（${opened?.code ?? '未知'}）`); continue; }
            let result;
            try {
              result = await orchestrator.dispatchTask({
                taskId: opened.task.id, role, label: `${groupLabel} · ${variant}`,
                prompt: `${prompt}\n\n## 本版本唯一的侧重：${variant}\n`
                  + '这是同时生成的几个平行版本之一。**只在这一件事上做出与其它版本明显的差别**，其余按任务单来，不要写成折中稿。\n',
              });
            } catch (error) {
              result = { ok: false, code: error instanceof Error ? error.message : String(error) };
            }
            if (result?.ok) { dispatched += 1; lines.push(`- ${variant}：子会话 ${result.childId}（任务 ${opened.task.id}）`); }
            else lines.push(`- ${variant}：派发失败（${result?.code ?? '未知'}）`);
          }
          lines.push('', `已派出 ${dispatched}/${variantList.length} 个版本，全部在跑。**不要在这里等**：它们陆续结算后会回到你的对话。`,
            `收齐后让用户先挑：把每版侧重与它写了什么摆给他，不要替他挑。选定后派 implementer/maintenance 落稿，其余用 code_task(action:"pick") 作废。`);
          return { report: lines.join('\n') + evalNote };
        }

        // 单路派单：首选常驻
        if (executor) {
          const dir = workDir(args.work, exec);
          const ready = await orchestratorFor(dir, parent);
          if (!ready.ok) return { report: `派单失败：${ready.reason}` };
          const orchestrator = ready.orchestrator;
          const registry = orchestrator.registry;
          let taskId = String(args.task_id ?? '').trim();
          if (!taskId) {
            const opened = await registry.open({ goal: String(args.label ?? '').trim() || `${role}：一步`, parent_id: args.parent_id, write_scope: args.write_scope });
            if (!opened?.ok) return { report: `派单失败：开任务被拒（${opened?.code ?? '未知'}）。` };
            taskId = opened.task.id;
          }
          let result;
          try {
            result = await orchestrator.dispatchTask({ taskId, role, prompt, label: args.label ?? role });
          } catch (error) {
            return { report: `派单失败（${modelLine}）：${error instanceof Error ? error.message : String(error)}` };
          }
          if (!result?.ok) return { report: `派单失败（${modelLine}）：任务 ${taskId} 无法派发（${result?.code ?? '未知'}）。` };
          return { report: `${renderDispatched({ modelLine, childId: result.childId, role, label: args.label ?? role })}\n\n账本：任务 ${taskId} 已认领并派发（owner=${result.childId}）。子 Agent 结算时宿主会把结果送你，编排器会自动 settle。` + evalNote };
        }

        // 回退：one-shot，阻塞等结果
        const request = withDepthCap(buildDispatchRequest({
          label: args.label ?? role, prompt: pozhangAgentPrefix() + prompt + pozhangAnchor(role), parent, signal: DETACHED_SIGNAL, route,
        }), subagents);
        let run;
        try {
          run = typeof subagents?.startActivation === 'function'
            ? await subagents.startActivation(buildOneShotActivation({ label: args.label ?? role, request }))
            : await subagents.start(SPAWN_PROVIDER, request);
        } catch (error) {
          return { report: `派单失败（${modelLine}）：${error instanceof Error ? error.message : String(error)}` };
        }
        try {
          const result = await run.result;
          const text = outputText(result?.output);
          const failure = stopReasonText(result?.stopReason);
          if (failure) return { report: `## ${modelLine}\n\n${failure}。${text ? `\n\n已产出：\n\n${text}` : ''}` + evalNote };
          return { report: `## ${modelLine}\n\n${text || '（子 Agent 没有产出文本）'}` + evalNote };
        } catch (error) {
          return { report: `## ${modelLine}\n\n子 Agent 执行失败：${error instanceof Error ? error.message : String(error)}` };
        } finally {
          await run.dispose().catch(() => {});
        }
      })(),
    };
  }

  // -------------------------------------------------------------------------
  // code_brief —— 组装实现任务上下文包
  // -------------------------------------------------------------------------

  function buildBriefTool() {
    return {
      name: 'code_brief',
      description:
        '组装实现 Agent 的任务上下文包并原样返回：目标、相关文件内容摘录、契约、约束、验收标准。'
        + '把返回的 packet 完整交给实现 Agent，它就能开工不必自己再猜要读哪些文件。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          work: { type: 'string', description: '仓库名或目录；省略时用会话工作区' },
          objective: { type: 'string', description: '这一步要达成什么' },
          source_paths: { type: 'array', items: { type: 'string' }, description: '需要参考/修改的路径（会摘录内容）' },
          contracts: { type: 'array', items: { type: 'string' }, description: '契约/接口边界说明' },
          constraints: { type: 'array', items: { type: 'string' }, description: '约束（不许做什么）' },
          acceptance: { type: 'array', items: { type: 'string' }, description: '验收标准（人工判据）' },
          notes: { type: 'array', items: { type: 'string' }, description: '其它说明' },
        },
        required: [],
      },
      output: reportOutput((_args, value) => textResult(value.packet)),
      execute: (args, exec) => (async () => {
        const dir = workDir(args.work, exec);
        const packet = await buildPacket({
          dir,
          objective: args.objective,
          sourcePaths: args.source_paths,
          contracts: args.contracts,
          constraints: args.constraints,
          acceptance: args.acceptance,
          notes: args.notes,
        });
        return { packet };
      })(),
    };
  }

  // -------------------------------------------------------------------------
  // code_check —— 自动机器门
  // -------------------------------------------------------------------------

  function buildCheckTool() {
    return {
      name: 'code_check',
      description:
        '自动机器门：按给定命令逐条跑（fmt/lint/typecheck/build/test…），返回每条的 exit code 与输出尾部。'
        + '全部成功才算 PASS。技术总监被禁了 shell，这是唯一跑命令的窄通道——命令由你按仓库实际情况给出，'
        + '只读回执、不改文件。VERIFY 阶段先跑它，通过后才派 reviewer。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          work: { type: 'string', description: '仓库名或目录；省略时用会话工作区' },
          commands: { type: 'array', items: { type: 'string' }, description: '验收命令列表，例如 ["npm run lint","npm test"]' },
          timeout_ms: { type: 'number', description: '每条命令超时（毫秒），默认 600000' },
        },
        required: ['commands'],
      },
      output: reportOutput((_args, value) => textResult(value.report)),
      execute: (args, exec) => (async () => {
        const commands = Array.isArray(args.commands) ? args.commands.map((c) => String(c ?? '').trim()).filter(Boolean) : [];
        if (!commands.length) return { report: 'commands 为空：至少给一条验收命令。' };
        const dir = workDir(args.work, exec);
        const { passed, results } = await runChecks(commands, { cwd: dir, timeoutMs: Number(args.timeout_ms) || 600000 });
        const lines = [`## 机器门：${passed ? 'PASS ✅' : 'FAIL ❌'}`, '', `仓库：${dir}`, ''];
        for (const r of results) {
          const status = r.timedOut ? 'TIMEOUT' : (r.code === 0 ? 'ok' : `exit ${r.code}`);
          lines.push(`### \`${r.command}\` → ${status}`, '');
          const out = tail(`${r.stdout ?? ''}${r.stderr ? `\n${r.stderr}` : ''}`, 3000).trim();
          if (out) lines.push('```', out, '```', '');
        }
        return { report: lines.join('\n') };
      })(),
    };
  }

  // -------------------------------------------------------------------------
  // code_state —— 账本视图
  // -------------------------------------------------------------------------

  function buildStateTool() {
    return {
      name: 'code_state',
      description: '账本视图：列出该仓库的任务按状态分组，以及未结算（READY/ASSIGNED/RUNNING）的任务，用来判断下一步该派谁。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { work: { type: 'string', description: '仓库名或目录；省略时用会话工作区' } },
        required: [],
      },
      output: reportOutput((_args, value) => textResult(value.report)),
      execute: (args, exec) => (async () => {
        const dir = workDir(args.work, exec);
        const { registry } = await registryFor(dir);
        const tasks = registry.list({});
        if (!tasks.length) return { report: `仓库 ${dir} 尚无任务。` };
        const byStatus = {};
        for (const t of tasks) (byStatus[t.status] ??= []).push(t);
        const lines = [`## 账本 · ${basename(dir)}`, '', `共 ${tasks.length} 笔任务`, ''];
        for (const status of ['READY', 'ASSIGNED', 'RUNNING', 'DONE', 'FAILED', 'BLOCKED', 'CANCELLED']) {
          const group = byStatus[status];
          if (!group?.length) continue;
          lines.push(`### ${status}（${group.length}）`);
          for (const t of group) lines.push(`- ${t.id} owner=${t.owner_agent ?? '无主'}｜${t.goal ?? ''}｜scope=${scopeText(t)}`);
          lines.push('');
        }
        return { report: lines.join('\n') };
      })(),
    };
  }

  // -------------------------------------------------------------------------
  // code_merge —— 把某条 issue 的副本合并回主工作目录
  // -------------------------------------------------------------------------

  /**
   * 派一个**专门的合并 Agent**去副本里解冲突（用户定调：冲突交给专门负责的子 Agent）。
   *
   * 它和派单子会话的关键差别：**不登记进 STUDIO_CHILDREN**。
   * 登记了，它这一轮结束就会触发 `subagent/end` → `settleIssue(ok:true)` →
   * 把刚合完的 DONE 又打回 REVIEW。合并 Agent 的产出是「副本里解掉的冲突」，
   * 不是「这一单写完」，所以只 markChild 记角色，不接结算。
   * @returns {Promise<{ok:boolean, childId?:string, reason?:string}>}
   */
  function buildMergeTool() {
    return {
      name: 'code_merge',
      description:
        '待合并区的操作入口。子会话写完只把 issue 落成 REVIEW（改动还在副本里），真合并回主干才转 DONE。'
        + 'git 仓库走 `git merge issue-<id>`；非 git 目录走影子仓库（read-tree 落地）。两条路径都先查漂移：'
        + '主工作树有未提交改动就拒（除非 allowDrift）。冲突一律不落地、派回副本拥有者去解，副本留作现场。'
        + 'action：pending 看待合并区（不给 id 时的默认）/ status 只看能不能合（不写文件）/ merge 真合 / '
        + 'restore 用备份把主目录还原回合并前（仅影子仓库）。',
      parameters: (() => {
        // 与 code_op 同一张操作表：action 枚举与字段都从 lib/ops.js 生成。
        const schema = unionSchema(['pending', 'status', 'merge', 'restore'], { required: false });
        schema.properties.action.description = '默认：有 id 时 merge，无 id 时 pending';
        return schema;
      })(),
      output: reportOutput((_args, value) => textResult(value.report)),
      execute: (args, exec) => (async () => {
        const dir = workDir(args.work, exec);
        const id = String(args?.id ?? '').trim();
        const action = args?.action ?? (id ? 'merge' : 'pending');

        // 待合并区（GitHub 的 open PR 列表）：写完没合的都在这。
        if (action === 'pending' || !id) {
          const pending = await pendingMerges(dir);
          if (!pending.length) return { report: `待合并区是空的（${dir}）：没有已写完但还没合回主干的 issue。` };
          const lines = ['## 待合并区', ''];
          for (const item of pending) {
            const files = Array.isArray(item.changedFiles) && item.changedFiles.length
              ? `，改动 ${item.changedFiles.length} 个文件` : '';
            lines.push(`- #${String(item.id).replace(/^#/, '')} ${item.title ?? ''}${item.region ? ` → region:${item.region}` : ''}${files}`);
          }
          lines.push('', '用 code_merge id=<编号> 合并回主干；撞车会派回子会话去解。');
          return { report: lines.join('\n') };
        }

        const issue = await getIssue(dir, id);
        if (!issue) return { report: `找不到 issue ${id}（${dir}）。` };
        const label = `issue ${id}`;

        if (action === 'restore') {
          if (!issue.shadow?.root) return { report: `${label} 不是影子仓库副本，没有可还原的备份引用。` };
          const res = await restoreShadow(issue.shadow, runCommand);
          return {
            report: res.ok
              ? `${label}：主目录已还原到合并前的备份（tree ${res.restored}）。`
              : `${label}：还原失败（${res.code ?? 'UNKNOWN'}）——${res.reason ?? ''}`,
          };
        }

        if (action === 'status') {
          const drift = issue.shadow?.root
            ? await detectDrift(issue.shadow, runCommand)
            : null;
          const dirty = await runCommand('git status --porcelain', { cwd: dir, timeoutMs: 30000 });
          const dirtyLines = String(dirty?.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean).filter(notManagedLine);
          const driftLines = drift?.changed ?? dirtyLines;
          const lines = [`## ${label} 合并前检查`, ''];
          lines.push(`- 副本：${issue.worktree ?? '（无）'}${issue.shadow?.root ? '（影子仓库）' : ''}`);
          if (issue.shadow?.root) lines.push(`- 基准：${issue.shadow.baseCommit?.slice(0, 8) ?? '?'}`);
          lines.push(driftLines.length
            ? `- 漂移：主目录有 ${driftLines.length} 处改动（${driftLines.slice(0, 5).join('、')}）→ 合并会被拒`
            : '- 漂移：无，可以合并');
          lines.push('');
          lines.push(driftLines.length ? '确认这些改动可以覆盖后，用 allowDrift=true 再合。' : '直接 action=merge 即可。');
          return { report: lines.join('\n') };
        }

        const res = await mergeWorkspace({
          issue, dir, runCommand, allowDrift: args?.allowDrift === true, rebased: args?.rebased === true,
        });
        if (res.ok) {
          // 真落地了才出待合并区：转 DONE，再把副本拆掉（树已经没用了）。
          await settleIssue(dir, id, { ok: true, merged: true });
          await cleanupWorkspace({ issue, dir, runCommand }).catch(() => {});
          const tail = res.mergedTree ? `（tree ${res.mergedTree.slice(0, 8)}，备份引用 ${res.backup ?? '无'}）` : `（分支 ${res.branch ?? ''}）`;
          return { report: `${label}：已合并回主目录，转 DONE，副本已拆${tail}。` };
        }
        const extra = Array.isArray(res.conflicts) && res.conflicts.length
          ? `\n冲突文件：${res.conflicts.slice(0, 10).join('、')}`
          : '';
        // 冲突交给专门的合并 Agent（用户定调：不替你解，但派专人指挥合并）。
        // 它只在副本里改，解完用 rebased=true 再合一次；这里不动主目录、不删副本。
        if (res.code === 'MERGE_CONFLICT') {
          const files = (Array.isArray(res.conflicts) ? res.conflicts : []).filter((l) => /^(CONFLICT|Auto-merging)/.test(l));
          const spawned = await spawnMerger({
            dir, issue, id, files, exec,
          });
          if (spawned.ok) {
            return {
              report: `${label}：合并冲突，未落地。已派合并 Agent（${spawned.childId}）去副本里解，`
                + `副本留作现场：${issue.worktree}${extra}\n它解完会自己用 code_merge id=${id} rebased=true 重试。`,
            };
          }
          return { report: `${label}：合并冲突，未落地，且派合并 Agent 失败（${spawned.reason}）${extra}` };
        }
        return { report: `${label}：合并未完成（${res.code ?? 'UNKNOWN'}）——${res.reason ?? ''}${extra}` };
      })(),
    };
  }

  // -------------------------------------------------------------------------
  // code_kb —— 代码范例库（写代码前按语义挑「活人怎么写」的范例注入上下文）
  // -------------------------------------------------------------------------

  function buildKbTool() {
    return {
      name: 'code_kb',
      description:
        '代码范例库：把「写对了的代码」沉淀成可检索范例，写代码前按语义（ollama 向量，失败退词法）'
        + '挑出最贴近的几条注入上下文。action：status 看库统计 / add 新增一条 / fill 补齐缺失向量 / '
        + 'search 检索（给定 query）。范例存 <repo>/.codewrite/kb/index.json。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          work: { type: 'string', description: '仓库名或目录；省略时用会话工作区' },
          action: { type: 'string', enum: ['status', 'add', 'fill', 'search'], description: '要执行的操作' },
          text: { type: 'string', description: 'add：范例代码正文' },
          tags: { type: 'array', items: { type: 'string' }, description: 'add：用途标签，如 ["retry","idempotent"]' },
          source: { type: 'string', description: 'add：来源（文件路径或说明）' },
          query: { type: 'string', description: 'search：用一段目标代码/意图去检索相似范例' },
          limit: { type: 'number', description: 'search：返回几条，默认 3' },
        },
        required: ['action'],
      },
      output: reportOutput((_args, value) => textResult(value.report)),
      execute: (args, exec) => (async () => {
        const dir = workDir(args.work, exec);
        const action = String(args.action ?? 'status');
        if (action === 'add') {
          const entry = await kb.add(dir, { text: args.text, tags: args.tags ?? [], source: args.source ?? '' });
          return { report: `已入库：${entry.id}${entry.vec ? '（已向量化）' : '（未向量化，检索走词法）'}。\n库：${kb.kbDir(dir)}` };
        }
        if (action === 'fill') {
          const r = await kb.fill(dir);
          return { report: `补齐向量：成功 ${r.embedded}，失败 ${r.failed}，共 ${r.total} 条。` };
        }
        if (action === 'search') {
          const query = String(args.query ?? '').trim();
          if (!query) return { report: 'search 需要给 query。' };
          const { mode, hits } = await kb.search(dir, query, { limit: Number(args.limit) || 3 });
          if (!hits.length) return { report: `未命中范例（mode=${mode}）。库：${kb.kbDir(dir)}` };
          const lines = [`## 代码范例（mode=${mode}）`, ''];
          for (const { entry, score } of hits) {
            lines.push(`### ${entry.id} · score=${score.toFixed(3)}${entry.tags?.length ? ` · ${entry.tags.join(',')}` : ''}`);
            if (entry.source) lines.push(`来源：${entry.source}`);
            lines.push('```', entry.text, '```', '');
          }
          return { report: lines.join('\n') };
        }
        const s = await kb.status(dir);
        const lines = [`## 代码范例库 · ${s.dir}`, '', `共 ${s.total} 条，已向量化 ${s.withVec} 条。`];
        if (s.tags.length) lines.push(`标签：${s.tags.join('、')}`);
        return { report: lines.join('\n') };
      })(),
    };
  }

  // -------------------------------------------------------------------------
  // code_map —— 跨仓/跨包依赖图 + 循环依赖检测
  // -------------------------------------------------------------------------

  function buildMapTool() {
    return {
      name: 'code_map',
      description:
        '依赖图：扫描工作区内各包清单（package.json / go.mod / Cargo.toml / pyproject.toml / '
        + 'requirements.txt / pom.xml），建内部依赖有向图、列外部依赖、找循环依赖。改一处前先看会牵动谁，'
        + '或在切分/合并包前检查有没有环。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          work: { type: 'string', description: '仓库根目录（会递归找各子包）；省略时用会话工作区' },
          max_depth: { type: 'number', description: '递归搜索深度上限，默认 5' },
        },
        required: [],
      },
      output: reportOutput((_args, value) => textResult(value.report)),
      execute: (args, exec) => (async () => {
        const dir = workDir(args.work, exec);
        const { report } = await renderMap(dir, { maxDepth: Number(args.max_depth) || 5 });
        return { report };
      })(),
    };
  }

  // -------------------------------------------------------------------------
  // code_review —— 机器可判的静态审校扫描
  // -------------------------------------------------------------------------

  function buildReviewTool() {
    return {
      name: 'code_review',
      description:
        '静态审校：把 reviewer 十二项检查里「能机器判」的项自动扫一遍——待办标记、调试输出残留、'
        + 'debugger、显式 any、空 catch、超长文件/函数、硬编码密钥正则。派 reviewer 子 Agent 前先跑它，'
        + '廉价问题就地暴露，让人工审校专注语义级判断。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          work: { type: 'string', description: '仓库名或目录；省略时用会话工作区' },
        },
        required: [],
      },
      output: reportOutput((_args, value) => textResult(value.report)),
      execute: (args, exec) => (async () => {
        const dir = workDir(args.work, exec);
        const { report } = await renderReview(dir);
        return { report };
      })(),
    };
  }

  // -------------------------------------------------------------------------
  // code_eval —— 派单前评估门（对齐 SuperAgent 的 Eval 阶段）
  // -------------------------------------------------------------------------

  function buildEvalTool() {
    return {
      name: 'code_eval',
      description:
        '派单前评估门（对齐 SuperAgent 主链的 Eval 阶段）：不调 LLM、零依赖，只按任务单字面完整度与'
        + '角色匹配度给出 proceed / clarify / reject 三态裁决，列出缺哪些关键字段。把设计里'
        + '「缺 objective/source_paths/acceptance 不得派出」落成可执行的门——派出前先 eval 一次。'
        + 'mode：off 不评 / observe（默认）只警告 / auto 缺关键字段即拦。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          role: { type: 'string', description: '要派的角色 id' },
          objective: { type: 'string', description: '这一步要达成什么' },
          source_paths: { type: 'array', items: { type: 'string' }, description: '要读/改的路径' },
          acceptance: { type: 'array', items: { type: 'string' }, description: '验收判据' },
          write_scope: { type: 'array', items: { type: 'string' }, description: '允许写的文件 glob' },
          stage: { type: 'string', description: '当前阶段' },
          deliverable: { type: 'string', description: '交付物形态' },
          round: { type: 'number', description: '第几轮' },
          mode: { type: 'string', enum: ['off', 'observe', 'auto'], description: '评估模式，默认 observe' },
        },
        required: [],
      },
      output: reportOutput((_args, value) => textResult(value.report)),
      execute: (args) => (async () => {
        const report = assessDispatch(args ?? {}, { mode: args?.mode });
        return { report: renderEval(report) };
      })(),
    };
  }

  // -------------------------------------------------------------------------
  // code_studio —— 工作区工作室：region 台账 + issue 记录（供 Issue Tab 读）
  // -------------------------------------------------------------------------
  // 只落库、不起会话：真正的监听/派单是后续的「后台调度」（独立 Host 服务）。
  // 先把「issue → 归属哪个 region」这条决策做成可调用、可单测的一刀。
  function buildStudioTool() {
    return {
      name: 'code_studio',
      description:
        '工作区工作室台账：给进来的 issue 记录归属 region，读/写 <repo>/.codewrite 下的 issues.json 与 '
        + 'regions.json（Issue Tab 就渲染这两份）。action：assign 归一个 issue 到 region（命中就复用、'
        + '否则按文件夹首单新建，默认不调 LLM）/ issues 列全部 issue / regions 列全部 region / '
        + 'set 直接写一条 issue 的字段（status/report/region/write_scope…）/ '
        + 'submit 规范化提交（前台只管把 id/title/body/folders 提上来，插件归一化 folders/status、按 issue 组 prompt、'
        + '归 region 并派单；folders 省略时会从 body 里的路径自动抽）/ '
        + 'dispatch 同 submit 但要求自带 prompt / '
        + 'watch 开关监听、改轮询间隔或立即扫收件目录（<repo>/.codewrite/inbox/*.json 丢一条即派单）；'
        + 'watch 也带 github/token 参数把 GitHub 仓库的 open issues 当来源（owner/repo 或 URL）/ '
        + 'pr 用本机 gh CLI 把这条 issue 的改动提成 PR（插件不存任何凭据，凭据在 gh 自己那儿）。',
      parameters: (() => {
        // 参数表从操作表（lib/ops.js）生成，不再手抄字段：加 op 只改一处。
        const schema = unionSchema(['assign', 'submit', 'issues', 'regions', 'repos', 'set', 'dispatch', 'watch', 'pr', 'rule']);
        schema.properties.action.description = '要执行的操作（rule=工作区规则；repos=发现工作区里的 git 仓库）';
        // 老写法把 rule 的子操作写在 op 上（现在规范名是 ruleOp）；留成弃用别名，别让既有调用撞 additionalProperties。
        schema.properties.op = { type: 'string', enum: ['add', 'list', 'remove'], description: '（弃用，改用 ruleOp）rule：add / list / remove' };
        return schema;
      })(),
      output: reportOutput((_args, value) => textResult(value.report)),
      execute: (args, exec) => (async () => {
        const dir = workDir(args.work, exec);
        const action = String(args.action ?? 'issues');
        // rule：工作区规则层（.code-studio/memory/rules.json）
        if (action === 'rule') {
          // 走 code_op 时字段叫 ruleOp（op 已被操作名占用）；直接调 code_studio 时老写法 args.op 仍认。
          const op = String(args.ruleOp ?? args.op ?? 'list').trim();
          if (op === 'add') {
            await ensureStudio(dir, exec?.agent);
            const res = addRule(dir, {
              text: args.text,
              scope: args.scope,
              tags: args.tags,
              createdBy: 'tech-lead',
              source: 'chat',
            });
            if (!res.ok) return { report: `规则未写入：${res.error}` };
            const scopeNote = res.rule.scope.kind === 'roles' ? `仅 ${res.rule.scope.roles.join('/')}` : '全 Agent';
            return { report: `${res.duplicate ? '规则已存在，已更新其范围' : '规则已写入'}（${scopeNote}）：${res.rule.text}` };
          }
          if (op === 'remove') {
            const res = removeRule(dir, args.text ?? args.id);
            return { report: res.ok ? `已删 ${res.removed} 条规则。` : `未删：${res.error}` };
          }
          const listed = listRules(dir, { role: args.role });
          if (!listed.rules.length) return { report: '尚无工作区规则。' };
          const lines = ['## 工作区规则', ''];
          for (const r of listed.rules) {
            const scopeNote = r.scope?.kind === 'roles' ? `（仅 ${r.scope.roles.join('/')}）` : '（全 Agent）';
            lines.push(`- [${r.id}] ${r.text}${scopeNote}`);
          }
          return { report: lines.join('\n') };
        }
        if (action === 'issues') {
          const { issues } = await loadIssues(dir);
          if (!issues.length) return { report: `尚无 issue 记录（${dir}/.codewrite/issues.json）。` };
          const lines = ['## Issue 台账', ''];
          for (const item of issues) {
            lines.push(`- #${String(item.id).replace(/^#/, '')} [${item.status ?? 'READY'}] ${item.title ?? ''}${item.region ? ` → region:${item.region}` : ''}`);
          }
          return { report: lines.join('\n') };
        }
        if (action === 'regions') {
          const { regions } = await loadRegions(dir);
          const names = Object.keys(regions);
          if (!names.length) return { report: `尚无 region 记录（${dir}/.codewrite/regions.json）。` };
          const lines = ['## Region 台账', ''];
          for (const name of names) {
            const region = regions[name];
            lines.push(`- **${name}** 文件夹：${(region.folders ?? []).join('、') || '（无）'}，issue：${(region.issues ?? []).join(',') || '（无）'}${region.childId ? `，会话：${region.childId}` : ''}${region.queue === true ? '，**串行（queue）**' : '，并行'}`);
          }
          return { report: lines.join('\n') };
        }
        if (action === 'repos') {
          const repos = listRepos(dir);
          if (!repos.length) return { report: `工作区「${dir}」里没发现 git 仓库（有 .git 的子目录才算）。单仓库工作区或非 git 目录直接用工作区根即可。` };
          const lines = ['## 工作区里的 git 仓库', '', `工作区根：${dir}`, ''];
          for (const r of repos) {
            const rem = r.remotes?.all?.length ? `remote: ${r.remotes.all.join(' / ')}` : 'remote: （无）';
            lines.push(`- **${r.name}** — ${r.dir}（${rem}）`);
          }
          return { report: lines.join('\n') };
        }
        // set：直接写一条 issue 的字段
        if (action === 'set') {
          const id = String(args.id ?? '').trim();
          if (!id) return { report: 'set 需要 id。' };
          const patch = { id };
          for (const key of ['title', 'repo', 'body', 'status', 'report', 'region', 'childId', 'prUrl', 'prBranch']) {
            if (args[key] !== undefined) patch[key] = args[key];
          }
          if (args.folders !== undefined) patch.folders = args.folders;
          const saved = await upsertIssue(dir, patch);
          return { report: `已更新 issue #${id}：status=${saved.status ?? 'READY'}。` };
        }
        // pr：用本机 gh CLI 把这条 issue 的改动提成 PR（不给插件存任何凭据）
        if (action === 'pr') {
          const id = String(args.id ?? '').trim();
          if (!id) return { report: 'pr 需要 id。' };
          const { issues } = await loadIssues(dir);
          const issue = (Array.isArray(issues) ? issues : []).find((it) => String(it.id) === id) ?? { id };
          let regions = {};
          try { regions = (await loadRegions(dir)).regions ?? {}; } catch { /* 忽略 */ }
          const prDir = resolvePrDir({ dir, issue, regions });
          // fork 场景：显式 prRepo/prHeadOwner 优先；否则看 prDir 的 remote 自动判（upstream 存在=本地是 fork，PR 提上游）
          let prDest = { prRepo: args.prRepo ?? issue.prRepo ?? '', prHeadOwner: args.prHeadOwner ?? issue.prHeadOwner ?? '' };
          if (!prDest.prRepo || !prDest.prHeadOwner) {
            try {
              const found = await enrichRemotes(listRepos(prDir).map((r) => r), runCommand);
              const fRepo = found.find((r) => r.dir === prDir) ?? found[0];
              const auto = prDestination(fRepo ?? { remotes: { all: [] } }, prDest);
              prDest = { prRepo: prDest.prRepo || auto.prRepo, prHeadOwner: prDest.prHeadOwner || auto.prHeadOwner };
            } catch { /* 自动判定失败就用显式值 */ }
          }
          let res;
          try {
            res = await createPr({
              dir: prDir,
              issue: { id, title: args.title ?? issue.title, body: args.body ?? issue.body },
              base: args.base ?? issue.base,
              prRepo: prDest.prRepo || undefined,
              prHeadOwner: prDest.prHeadOwner || undefined,
            });
          } catch (error) {
            return { report: `建 PR 失败：${error instanceof Error ? error.message : String(error)}` };
          }
          if (!res.ok) {
            const hint = res.code === 'GH_NOT_AUTHED'
              ? '\n先在终端跑 `gh auth login`（选 github.com，勾 git 凭据），再回来重试。'
              : '';
            return { report: `建 PR 被拒（${res.code}）：${res.reason ?? ''}${hint}` };
          }
          // 回写台账，Tab 才能显示 PR 链接
          await upsertIssue(dir, { id, prUrl: res.url, prBranch: res.branch });
          // GitHub 双向同步：来源是 GitHub 的 issue 建完 PR 后回写评论（带 PR 链接），不自动关单。
          try {
            const ghCur = await getIssue(dir, id);
            if (ghCur?.source === 'github' || ghCur?.githubNumber) {
              const ghCfg = await loadSessionGithub(dir, exec?.agent);
              const ghTok = await loadSessionToken(dir, exec?.agent);
              if (ghCfg?.repo) await writeBackIssue({ repoRoot: dir, cfg: ghCfg, issue: ghCur, close: false, token: ghTok });
            }
          } catch { /* 回写 GitHub 失败不影响 PR 结果 */ }
          // PR 建完，该 region 无在飞 issue → 拆 worktree
          try {
            const { issues: allIssues } = await loadIssues(dir);
            const cur2 = await getIssue(dir, id);
            if (cur2?.worktree && cur2?.region && regionSettled(allIssues, cur2.region)) {
              await cleanupWorkspace({ issue: cur2, dir, runCommand });
            }
          } catch { /* 清理失败不影响 PR 结果 */ }
          return { report: `已建 PR：${res.url}\n分支 ${res.branch}。` };
        }
        // watch：开关 / 改间隔 / 立即扫 / 绑 GitHub 源（本地配置落 watch.json，GitHub 落 github.json）
        if (action === 'watch') {
          const parent = exec?.agent;
          const touched = ['enabled', 'intervalMs', 'scan', 'github', 'token'].some((k) => args[k] !== undefined);
          if (!touched) {
            const cfg = await loadWatch(dir);
            const gh = await loadSessionGithub(dir, parent);
            const watchText = cfg ? `本地：${cfg.enabled ? '开' : '关'}；间隔 ${Math.round(cfg.intervalMs / 1000)}s；收件 ${inboxDir(dir, cfg)}` : '本地：未配置';
            const ghText = gh ? `GitHub：${gh.enabled ? '开' : '关'}；仓库 ${gh.repo || '（无）'}；每 ${Math.round(gh.intervalMs / 1000)}s；PAT ${gh.hasToken ? '已存' : '未存'}` : 'GitHub：未配置';
            return { report: `${watchText}\n${ghText}` };
          }
          let cfg = (await loadWatch(dir)) ?? normalizeWatch({});
          if (args.enabled !== undefined) cfg = await saveWatch(dir, { enabled: args.enabled === true });
          if (args.intervalMs !== undefined) cfg = await saveWatch(dir, { intervalMs: Number(args.intervalMs) });
          if (args.github !== undefined) {
            const target = String(args.github ?? '').trim().toLowerCase();
            if (target === 'off' || target === '') await saveSessionGithub(dir, parent, { enabled: false });
            else {
              const slug = parseRepoSlug(args.github);
              if (!slug) return { report: `github 需要 owner/repo 或 GitHub URL，收到「${args.github}」。` };
              await saveSessionGithub(dir, parent, { repo: slug.slug, enabled: true });
            }
          }
          if (args.token !== undefined) {
            const tk = String(args.token ?? '').trim();
            const clear = tk.toLowerCase() === 'off' || tk.toLowerCase() === 'clear';
            const sdir = await sessionStudioDir(dir, parent);
            await saveGithubTo(sdir, { token: clear ? '' : tk });
          }
          if (parent) await ensureWatcher(dir, parent);
          if (args.scan === true) {
            const results = await runScan(dir, parent, cfg);
            const gh = await loadSessionGithub(dir, parent);
            let ghText = '';
            if (gh?.enabled) {
              const res = await runGithubSync(dir, parent, gh);
              ghText = res?.ok ? `\nGitHub：${formatGithubResults(res)}` : `\nGitHub：失败（${res?.code}）${res?.reason ?? ''}`;
            }
            return { report: `监听${cfg.enabled ? '开' : '关'}（间隔 ${Math.round(cfg.intervalMs / 1000)}s）。${summarizeScan(results)}${ghText}` };
          }
          const gh = await loadSessionGithub(dir, parent);
          const ghPart = gh?.enabled ? `；GitHub ${gh.repo} 每 ${Math.round(gh.intervalMs / 1000)}s` : '';
          return { report: `本地监听已${cfg.enabled ? '开' : '关'}：每 ${Math.round(cfg.intervalMs / 1000)}s 扫 ${inboxDir(dir, cfg)}（收件丢 *.json 即派单）${ghPart}。` };
        }
        // dispatch / submit：把 issue 派给它该去的持久子会话。
        // submit = 规范化接口：前台只管把 id/title/body/folders 提上来，插件负责归一化 + 组 prompt + 派单。
        if (action === 'dispatch' || action === 'submit') {
          const norm = normalizeIssue(
            { id: args.id, title: args.title, body: args.body, repo: args.repo, folders: args.folders, status: args.status },
            { idFallback: args.id },
          );
          if (!norm.ok) {
            return { report: `${action} 缺少必填字段：${norm.missing.join('、')}（folders 可从 body 里的路径自动抽，也能由语义初判兜底，但 id/title 得给）。` };
          }
          const issue = norm.issue;
          const id = issue.id;
          await ensureStudio(dir, exec?.agent);
          const role = String(args.role ?? '').trim() || 'implementer';
          const prompt = String(args.prompt ?? '').trim() || buildIssuePrompt(issue);
          const parent = exec?.agent;
          if (!parent) return { report: `${action} 失败：拿不到调用方 Agent（exec.agent 未定义）。` };
          const executor = executorFor(parent);
          if (!executor) {
            return { report: `${action} 失败：没有可用执行器（DSH 需要 subagents.startActivation；换成 CLI 执行器也能派单）。` };
          }
          let result;
          const targetDir = resolveIssueDir(dir, issue);
          try {
            result = await dispatchIssue({
              dir: targetDir, issue, role, prompt, parent, executor: executorFor(parent),
              worktrees: ctx.get?.('worktrees'), workingDirectory: ctx.get?.('workingDirectory'), route: routeForRole(role), runCommand,
              promptPrefix: rulesForRole(targetDir, role) + pozhangAgentPrefix(), promptAnchor: pozhangAnchor(role), semanticRoute: await makeSemanticRoute(targetDir),
              memoryFor: makeMemoryFor(targetDir, parent),
            });
          } catch (error) {
            return { report: `${action} 失败：${error instanceof Error ? error.message : String(error)}` };
          }
          if (!result.ok) return { report: `${action} 被拒（${result.code}）：${result.reason}` };
          if (result.mode === 'create') {
            markChild(result.childId, { role, parentId: parent.id, label: `region:${result.region}` });
          }
          trackStudioChild(result.childId, targetDir, id, sessionIdOf(parent));
          const verb = result.mode === 'reuse' ? '追回已有子会话（串行追加）' : '新建持久子会话';
          const wtText = result.worktree ? `，工作树 ${result.worktree}` : '（未建独立工作树，直接改原目录）';
          return { report: `issue #${id} → region「${result.region}」${verb}：子会话 ${result.childId}${wtText}。账本已记 RUNNING；子会话结算时报告会回写 issues.json。` };
        }
        // assign：归一个 issue 到 region
        const id = String(args.id ?? '').trim();
        const folders = Array.isArray(args.folders) ? args.folders : [];
        if (!id) return { report: 'assign 需要 id。' };
        if (!folders.length) return { report: 'assign 需要 folders（issue 触碰的文件夹）。' };
        const { regions } = await loadRegions(dir);
        const plan = planRegion(regions, folders);
        const name = String(args.region ?? '').trim() || plan.name;
        await upsertRegion(dir, name, { folders: plan.folders, issues: [id], ...(args.childId ? { childId: args.childId } : {}), ...(args.queue !== undefined ? { queue: args.queue === true } : {}) });
        await upsertIssue(dir, {
          id, region: name, folders: plan.folders,
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.repo !== undefined ? { repo: args.repo } : {}),
          ...(args.body !== undefined ? { body: args.body } : {}),
          status: args.status ?? 'READY',
        });
        return { report: `issue #${id} → region「${name}」${plan.isNew ? '（新建区域）' : '（命中已有区域，追加）'}；文件夹：${plan.folders.join('、')}。` };
      })(),
    };
  }

  // -------------------------------------------------------------------------
  // code_memory —— 工作室记忆索引（分层只读清单，按角色过滤）
  // -------------------------------------------------------------------------

  function buildMemoryTool() {
    return {
      name: 'code_memory',
      description:
        '工作室记忆索引：把 .code-studio 下的记忆文件按层列成清单（workspace 跨会话 / session 本会话 / '
        + 'agent 子 Agent / region 区域 / legacy 旧 .codewrite），每条给路径、摘要、行数、更新时间。'
        + '只读，不读正文 —— 想看正文再用 read 打开那条路径。'
        + 'scope.kinds 只列某几层；role 按角色过滤（子 Agent 只该看到自己有权限的那几层）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          work: { type: 'string', description: '工作区根目录；省略时用会话工作区' },
          kinds: { type: 'array', items: { type: 'string', enum: MEMORY_TIERS }, description: '只列这几层（默认全部）' },
          role: { type: 'string', description: '按角色过滤（省略则不过滤，全部可见）' },
        },
        required: [],
      },
      output: reportOutput((_args, value) => textResult(value.report)),
      execute: (args, exec) => (async () => {
        const dir = workDir(args.work, exec);
        const kinds = Array.isArray(args.kinds) ? args.kinds.filter(Boolean) : undefined;
        const role = String(args.role ?? '').trim() || undefined;
        const res = memoryIndexExecute({ ws: dir, scope: kinds?.length ? { kinds } : undefined, role });
        if (!res.ok) return { report: `记忆索引扫描失败（${res.error ?? 'UNKNOWN'}）。` };
        const entries = res.entries ?? [];
        if (!entries.length) {
          return { report: `## 工作室记忆索引\n\n${dir} 下还没有记忆文件。派单结算后会自动写入。` };
        }
        const byTier = new Map();
        for (const e of entries) {
          if (!byTier.has(e.tier)) byTier.set(e.tier, []);
          byTier.get(e.tier).push(e);
        }
        const lines = [`## 工作室记忆索引 · ${basename(dir)}`, '', `共 ${entries.length} 条${res.dropped ? `（角色过滤掉 ${res.dropped} 条）` : ''}`, ''];
        for (const tier of MEMORY_TIERS) {
          const group = byTier.get(tier);
          if (!group?.length) continue;
          lines.push(`### ${tier}（${group.length}）`);
          for (const e of group) {
            const when = new Date(e.mtimeMs).toISOString().slice(0, 16).replace('T', ' ');
            lines.push(`- ${e.path}｜${e.lines} 行｜${when}｜${e.summary}`);
          }
          lines.push('');
        }
        return { report: lines.join('\n') };
      })(),
    };
  }

  // -------------------------------------------------------------------------
  // 规格化操作表（契约在 lib/ops.js，实现只写一次）
  // -------------------------------------------------------------------------
  // 三处入口共用这一份实现：code_op 工具 / code_studio·code_merge 工具 / 网页右栏 HTTP。
  // 外部 Agent（CLI、别的 harness）走 HTTP op=run 也是同一条路，参数表与返回形状完全一致。

  /** 中止一条 issue：打断子会话 → 账本落 FAILED。工具层与 HTTP 层共用。 */
  // 工具实例先建出来：注册表要拿它们的 execute 当实现，tools 数组也要注册同一批实例。
  const studioTool = buildStudioTool();
  const mergeTool = buildMergeTool();

  /** 把工具实现当 op 实现用：工具 execute 返回 { report }，这里统一成 { ok, text }。 */
  const viaTool = (tool, action) => async (args, context) => {
    const out = await tool.execute(
      { ...args, ...(action ? { action } : {}) },
      context.exec ?? { agent: context.agent },
    );
    return { ok: true, text: String(out?.report ?? '') };
  };

  const opRegistry = createOpRegistry();
  opRegistry
    .register('dispatch', viaTool(studioTool, 'dispatch'))
    .register('pending', viaTool(mergeTool, 'pending'))
    .register('merge', viaTool(mergeTool, 'merge'))
    .register('mergeStatus', viaTool(mergeTool, 'status'))
    .register('restore', viaTool(mergeTool, 'restore'))
    .register('issues', viaTool(studioTool, 'issues'))
    .register('regions', viaTool(studioTool, 'regions'))
    .register('repos', viaTool(studioTool, 'repos'))
    .register('assign', viaTool(studioTool, 'assign'))
    .register('set', viaTool(studioTool, 'set'))
    .register('pr', viaTool(studioTool, 'pr'))
    .register('rule', viaTool(studioTool, 'rule'))
    .register('watch', viaTool(studioTool, 'watch'))
    .register('cancel', (args, context) => cancelIssue(context.dir, String(args.id ?? '').trim(), context.agent));

  function buildOpTool() {
    return {
      name: 'code_op',
      description:
        '工作室的规格化操作入口（唯一契约）。派单 / 合并 / 中止 / 台账这批操作在这里用同一份参数表调用，'
        + '与网页右栏、外部 Agent 走 HTTP 时完全一致 —— 换执行器（DSH 子 Agent 或本机 CLI）也不改契约。'
        + '缺必填参数会被逐条点出来；op 不认识时列出全部可用操作。\n\n' + describeOps(),
      parameters: genericSchema(),
      output: reportOutput((_args, value) => textResult(value.report)),
      execute: (args, exec) => (async () => {
        const name = canonicalOp(args?.op);
        if (!name) return { report: `未知操作：${args?.op ?? '（空）'}。可用：${OPS.map((o) => o.name).join('、')}` };
        const dir = workDir(args.work, exec);
        const res = await opRegistry.run(name, { ...args, work: dir }, { dir, exec, agent: exec?.agent });
        return { report: res.text };
      })(),
    };
  }

  // -------------------------------------------------------------------------
  // 注册
  // -------------------------------------------------------------------------

  const tools = [
    buildRolesTool(), buildBriefTool(), buildCheckTool(), buildStateTool(), buildTaskTool(), buildDispatchTool(),
    buildKbTool(), buildMapTool(), buildReviewTool(), buildEvalTool(), studioTool, mergeTool,
    buildMemoryTool(), buildOpTool(),
  ];

  return {
    tools,
    studioTool,
    mergeTool,
    opRegistry,
    buildTaskTool,
    buildDispatchTool,
    buildBriefTool,
    buildCheckTool,
    buildStateTool,
    buildMergeTool,
    buildKbTool,
    buildMapTool,
    buildReviewTool,
    buildEvalTool,
    buildStudioTool,
    buildMemoryTool,
    buildOpTool,
  };
}
