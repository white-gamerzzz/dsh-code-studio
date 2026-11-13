/**
 * dsh-plugin-code-studio — 代码总编工作室
 *
 * 与 dsh-plugin-novel（小说总编工作室）同构：技术总监不写代码，只输出工作流 +
 * 派单给 13 个角色子 Agent；每张单钉死角色模型、进 code_task 账（owner/version/租约）、
 * 有 write_scope 文件 glob（越界当场拒绝），过「自动机器门 code_check + 独立人工审校」两道门。
 *
 * 复用而非重写（ponytail）：task-registry / orchestrator / dispatch / session-roles
 * 四份模块由小说插件逐字搬来，只改了根目录前缀常量与工具名。本文件只写注册层。
 *
 * 注册层 API 形状抄自 dsh-plugin-novel 的 apply()，不要凭猜测改：
 *   工具 → ctx.tools.register({ name, description, parameters, output, execute })
 * 用到的 ctx 服务必须进 inject，否则 `cannot get property "x" without inject` 会让整个 apply 失败。
 */

import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, isAbsolute, resolve as resolvePath, basename } from 'node:path';

import { SETTLE_STATUSES, TaskRegistry, TASK_ERRORS, canonicalWorkspace, workspaceMatches } from './task-registry.js';
import { Orchestrator, detectPreemption } from './orchestrator.js';
import { markChild, unmarkChild, markOf } from './session-roles.js';
import {
  DISPATCH_TOOL, DETACHED_SIGNAL, SPAWN_PROVIDER, buildContinuableActivation, buildDispatchRequest,
  buildOneShotActivation, canDispatchContinuable, describeRoute, outputText, renderDispatched,
  stopReasonText, withDepthCap,
} from './dispatch.js';
import { buildPacket } from './packet.js';
import { runChecks, tail } from './runner.js';
import * as kb from './kb.js';
import { renderMap } from './map.js';
import { renderReview } from './review.js';
import { assessDispatch, renderEval } from './eval.js';
import { loadIssues, loadRegions, saveIssues, saveRegions, upsertIssue, upsertRegion, planRegion, getIssue } from './studio-store.js';
import { memorySectionText, appendRegionMemory, appendWorkspaceMemory } from './studio-memory.js';
import { dispatchIssue, settleIssue, MAX_GROUPS } from './studio-dispatch.js';
import { loadWatch, saveWatch, scanInbox, normalizeWatch, inboxDir } from './studio-watch.js';
import { loadGithub, saveGithub, syncGithub, normalizeGithub, parseRepoSlug } from './studio-github.js';
import { createPr } from './studio-pr.js';

export const name = 'code-studio';

export const description = 'Code studio: multi-role orchestration over a repository with task ledger, write_scope and a machine gate.';

export const inject = ['tools', 'commands'];

const textResult = (text) => [{ type: 'text', text }];
const reportOutput = (render) => ({ schema: { type: 'object', additionalProperties: true }, render });
const concurrent = (definition) => ({ ...definition, isConcurrencySafe: () => true });
/** 报告压成一行（去换行/多余空白，超长截断），给记忆文件当一条 ≤5 行结论用。 */
const oneLine = (text, max = 200) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

export function apply(ctx, rawConfig = {}) {
  const config = {
    projectsRoot: rawConfig.projectsRoot ?? 'code',
  };

  /** 角色清单（顺序即依赖顺序）。与 lib/agent-models.js 的 ROLE_IDS 一致。 */
  const ROLE_IDS = [
    'tech-lead', 'architect', 'contract', 'design', 'impact',
    'implementer', 'reviewer', 'security', 'test', 'fixer', 'archivist',
    'gopher', 'librarian',
  ];
  const ROLE_NAMES = {
    'tech-lead': '技术总监',
    architect: '架构',
    contract: '契约',
    design: '设计',
    impact: '影响推演',
    implementer: '实现',
    reviewer: '审校',
    security: '安全审计',
    test: '测试工程',
    fixer: '修复',
    archivist: '档案',
    gopher: '杂役',
    librarian: '文档同步员',
  };
  const roleList = () => ROLE_IDS.map((role) => `${role}（${ROLE_NAMES[role]}）`).join('、');

  /** 所有角色卡共用的失败报告纪律：唯一的统一副本，避免 11 份漂移。 */
  const ROLE_DISCIPLINE = [
    '',
    '## 失败报告纪律（所有角色通用，优先于本卡的交付格式）',
    '',
    '报告失败、阻塞或怀疑碰到工具/平台缺陷前，先回答三问并写出答案：',
    '1. **原始错误文本与错误码**：原样贴出，不要转述。',
    '2. **你做过哪一步能推翻自己猜测的检查**：没做过对照检查的猜测只能作为待验证假设。',
    '3. **有没有现成的正确通道没用**：例如改文件前先 read、用包管理器的命令而不是手改 lockfile。',
    '',
    '硬性禁则：三问答不上来，结论只能是 BLOCK（写「已尝试 X，得到错误 Y，未确认原因」）；',
    '不得宣称「工具缺陷 / 平台限制 / 绕不过去」；不得新建 xxx-v2 分支或文件去绕开一个本可修复的失败。',
    '',
    '## ponytail 纪律（本工作室所有角色通用）',
    '',
    '写代码前先爬梯子，停在第一个成立的台阶：',
    '1. 这东西需要存在吗？不需要就一行说明跳过（YAGNI）。',
    '2. 仓库/标准库里已经有了吗？先 grep 复用，别重造。',
    '3. 标准库能做吗？4. 平台原生能力覆盖吗（DB 约束 > 应用代码，CSS > JS）？',
    '5. 已装的依赖能解决吗？6. 能一行写完吗？7. 只有以上都不成立，才写能跑通的最小实现。',
    '最短的可工作 diff 胜出——但前提是真的读懂了问题：先读完要改的每个文件、追完真实调用链，再动手。',
    '修 bug 找根因不修症状：改一个共享函数里的守卫，比在每个调用点加守卫更小；先 grep 全部调用方。',
    '不做没要求的抽象：只有一个实现的接口、只有一个产品用的工厂、永不变的值做配置——都不要。',
    '非平凡逻辑（分支/循环/解析/钱与安全路径）留一个能跑的最小自检（assert 的 demo() 或一个 test_*）。',
  ].join('\n');

  // -------------------------------------------------------------------------
  // 路径解析
  // -------------------------------------------------------------------------

  function sessionCwd(exec) {
    return exec?.agent?.session?.header?.cwd;
  }

  function projectsRootDir(exec) {
    if (isAbsolute(config.projectsRoot)) return config.projectsRoot;
    const base = sessionCwd(exec) ?? process.cwd();
    return resolvePath(base, config.projectsRoot);
  }

  /** 判定一个目录是不是「代码工作区」：有 .git 或 .codewrite 就算。 */
  function isWorkDir(dir) {
    return existsSync(join(dir, '.git')) || existsSync(join(dir, '.codewrite'));
  }

  /**
   * 解析仓库目录。name 三种形态：
   * 1. 仓库名 → projectsRoot 下查找；
   * 2. 目录绝对/相对路径 → 直接用；
   * 3. 省略且会话 cwd 本身就是仓库 → 就地解析。
   */
  function workDir(nameArg, exec) {
    const root = projectsRootDir(exec);
    const cwd = sessionCwd(exec) ?? process.cwd();
    if (isWorkDir(cwd) && (!nameArg || !nameArg.trim() || nameArg.trim() === '.' || nameArg.trim() === basename(cwd))) {
      return cwd;
    }
    if (nameArg && nameArg.trim()) {
      const trimmed = nameArg.trim();
      if (isAbsolute(trimmed)) return trimmed;
      if (trimmed.includes('/') || trimmed.includes('\\')) return resolvePath(root, trimmed);
      const underRoot = join(root, trimmed);
      if (isWorkDir(underRoot)) return underRoot;
      const asCwdPath = resolvePath(cwd, trimmed);
      if (isWorkDir(asCwdPath)) return asCwdPath;
      return underRoot;
    }
    return root;
  }

  // -------------------------------------------------------------------------
  // 角色卡
  // -------------------------------------------------------------------------

  function rolesDir() {
    return join(fileURLToPath(new URL('.', import.meta.url)), '..', 'presets', 'code-editor', 'roles');
  }

  function overrideRoleDirs() {
    const dirs = [];
    const dshHome = process.env.DSH_HOME;
    if (dshHome && String(dshHome).trim()) dirs.push(join(resolvePath(String(dshHome).trim()), 'code-roles'));
    dirs.push(join(homedir(), '.dsh', 'code-roles'));
    return dirs;
  }

  function roleCardPath(role) {
    for (const dir of overrideRoleDirs()) {
      const candidate = join(dir, `${role}.md`);
      if (existsSync(candidate)) return candidate;
    }
    return join(rolesDir(), `${role}.md`);
  }

  function buildRolesTool() {
    return {
      name: 'code_roles',
      description:
        '返回代码工作室子 Agent 的角色卡全文。派单前先调用本工具取得对应角色的完整职责、交付格式与禁则，'
        + '把返回内容作为子 Agent 提示词的一部分传入。角色：' + roleList() + '。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { role: { type: 'string', enum: ROLE_IDS, description: '角色 id' } },
        required: ['role'],
      },
      output: reportOutput((_args, value) => textResult(value.card)),
      execute: (args) => (async () => {
        const role = String(args.role ?? '');
        if (!ROLE_IDS.includes(role)) return { card: `未知角色 ${role}。可用：${ROLE_IDS.join('、')}。` };
        const card = await readFile(roleCardPath(role), 'utf8').catch(() => '');
        if (!card) return { card: `角色卡 ${role}.md 读取失败。请检查插件 presets 目录与外部覆盖目录。` };
        return { card: `${card.trimEnd()}\n${ROLE_DISCIPLINE}\n` };
      })(),
    };
  }

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

  function trackStudioChild(childId, dir, issueId) {
    if (!childId) return;
    const entry = STUDIO_CHILDREN.get(childId) ?? { dir, issueIds: [] };
    entry.dir = dir;
    if (issueId) entry.issueIds.push(String(issueId));
    STUDIO_CHILDREN.set(childId, entry);
  }

  function routeForRole(role) {
    const settings = ctx.get?.('codeStudioAgentModels');
    return typeof settings?.routeFor === 'function' ? settings.routeFor(role) : undefined;
  }

  async function orchestratorFor(dir, parent) {
    if (!parent?.id) return { ok: false, reason: '拿不到父 Agent id，无法建立编排器。' };
    const { registry, key: workspaceKey } = await registryFor(dir);
    const key = `${workspaceKey}|${parent.id}`;
    const cached = ORCHESTRATORS.get(key);
    if (cached) return { ok: true, orchestrator: cached };

    const subagents = ctx.get?.('subagents');

    const dispatch = async ({ childId, role, prompt, label, task }) => {
      const route = routeForRole(role);
      const request = withDepthCap(buildDispatchRequest({
        label: label ?? role, prompt, parent, signal: DETACHED_SIGNAL, route,
      }), subagents);
      const started = await subagents.startActivation(buildContinuableActivation({
        childId, label: label ?? role, request,
      }));
      const actual = String(started?.childId ?? childId);
      markChild(actual, { role, writeScope: task?.write_scope, taskId: task?.id, label, parentId: parent?.id });
      return { childId: actual };
    };

    const orchestrator = new Orchestrator({
      registry,
      dispatch,
      interruptChild: async (childId) => {
        unmarkChild(childId);
        if (typeof subagents?.interrupt === 'function') {
          // 第二个参数必须形如 { kind:'ancestor', agent }；直接传 Agent 对象会抛错。
          subagents.interrupt(childId, { kind: 'ancestor', agent: parent });
        }
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

  if (typeof ctx.on === 'function') {
    ctx.on('subagent/end', (info) => {
      const childId = String(info?.id ?? '');
      if (!childId) return;
      // 结算回写：工作室派出的持久子会话结束一次 run 时，把结果落进 issues.json 对应该条
      // （一个持久子会话可串行服务多个 issue，按入队顺序 FIFO 出队）。旁路：不 await、失败静默。
      void (async () => {
        try {
          const entry = STUDIO_CHILDREN.get(childId);
          if (!entry) return;
          const issueId = entry.issueIds.shift();
          if (entry.issueIds.length === 0) STUDIO_CHILDREN.delete(childId);
          if (!issueId) return;
          const report = outputText(info?.lastAssistantMessage);
          const failure = stopReasonText(info?.stopReason);
          await settleIssue(entry.dir, issueId, failure ? { ok: false, error: failure } : { ok: true, report });
          // 工作区记忆写回：这一单的结论追加进 region 记忆 + 工作区 MEMORY.md（≤5 行，带 issue id 可 grep）。
          // 之前只有读没有写，等于没记忆；这里补上写侧。失败静默，不打断结算链路。
          if (!failure && report) {
            try {
              const settled = await getIssue(entry.dir, issueId);
              const block = `- #${issueId}${settled?.title ? ` ${settled.title}` : ''}：${oneLine(report, 220)}`;
              if (settled?.region) await appendRegionMemory(entry.dir, settled.region, block);
              await appendWorkspaceMemory(entry.dir, block);
            } catch { /* 记忆写回失败不挡结算 */ }
          }
        } catch { /* 回写失败不打断结算链路 */ }
      })();
      unmarkChild(childId);
      for (const orchestrator of ORCHESTRATORS.values()) {
        if (orchestrator.inFlight.has(childId)) {
          orchestrator.enqueueSubagentEnd({ id: childId, stopReason: info?.stopReason, lastAssistantMessage: info?.lastAssistantMessage });
          return;
        }
      }
    });

    ctx.on('agent/inbox/inserted', ({ agent, message } = {}) => {
      if (!agent?.id) return;
      if (message?.source?.kind !== 'user') return;
      const text = (message.content ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => String(block.text ?? ''))
        .join('\n')
        .trim();
      if (!text || !detectPreemption(text)) return;
      for (const orchestrator of ORCHESTRATORS.values()) {
        if (orchestrator.parentId !== agent.id) continue;
        orchestrator.enqueueUserInput({ agentId: agent.id, text });
      }
    });
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const orchestrator of ORCHESTRATORS.values()) {
        if (orchestrator.timer !== undefined) clearInterval(orchestrator.timer);
        orchestrator.stop();
      }
      ORCHESTRATORS.clear();
    }, 'code-studio: orchestrators');
  }

  // -------------------------------------------------------------------------
  // 监听轮询器：每工作区（按 cwd 目录键）一条。按 <repo>/.codewrite/watch.json 的
  // intervalMs 扫收件目录，逐条派单；派成功/重复即归档，被拒留到下一轮重试。
  // 开关与间隔都存 watch.json，天然按工作区隔离，不搞全局仓库清单。
  // ponytail: 轮询而非 fs.watch（跨平台稳、可单测）；watching 频率高或想秒级响应时再换 fs.watch。
  // -------------------------------------------------------------------------
  const WATCHERS = new Map(); // dirKey -> { dir, parent, timer, busy, intervalMs }
  const GH_ETAG = new Map(); // dirKey -> etag（省 GitHub 额度，配 304）

  function buildIssuePrompt(issue) {
    const parts = [`处理 issue #${issue.id}${issue.title ? `：${issue.title}` : ''}。`];
    if (Array.isArray(issue.folders) && issue.folders.length) parts.push(`涉及文件夹：${issue.folders.join('、')}。`);
    if (issue.body) parts.push(`\n原文：\n${issue.body}`);
    return parts.join('\n');
  }

  async function runScan(dir, parent, cfg) {
    const subagents = ctx.get?.('subagents');
    if (typeof subagents?.startActivation !== 'function') return [];
    const role = 'implementer';
    return scanInbox({
      repoRoot: dir,
      cfg,
      listIssues: async () => (await loadIssues(dir)).issues,
      dispatchIssueFn: (issue) => dispatchIssue({
        dir, issue, role, prompt: buildIssuePrompt(issue), parent, subagents,
        agents: ctx.get?.('agents'), worktrees: ctx.get?.('worktrees'), workingDirectory: ctx.get?.('workingDirectory'), route: routeForRole(role),
      }),
      onDispatched: (issue, outcome) => { trackStudioChild(outcome?.childId, dir, issue.id); },
    });
  }

  async function runGithubSync(dir, parent, gh) {
    const subagents = ctx.get?.('subagents');
    if (typeof subagents?.startActivation !== 'function') return null;
    const key = canonicalWorkspace(dir);
    const role = 'implementer';
    return syncGithub({
      repoRoot: dir,
      cfg: gh,
      etag: GH_ETAG.get(key),
      listIssues: async () => (await loadIssues(dir)).issues,
      dispatchIssueFn: (issue) => dispatchIssue({
        dir, issue, role, prompt: buildIssuePrompt(issue), parent, subagents,
        agents: ctx.get?.('agents'), worktrees: ctx.get?.('worktrees'), workingDirectory: ctx.get?.('workingDirectory'), route: routeForRole(role),
      }),
      onDispatched: (issue, outcome) => { trackStudioChild(outcome?.childId, dir, issue.id); },
    }).then((res) => {
      if (res?.etag) GH_ETAG.set(key, res.etag);
      return res;
    });
  }

  /** 依配置重装轮询表。只要「本地收件」或「GitHub」任一开着就转；都不开或拿不到父 → 停机。 */
  async function ensureWatcher(dir, parent, _cfg) {
    const key = canonicalWorkspace(dir);
    const existing = WATCHERS.get(key);
    if (existing?.timer !== undefined) clearInterval(existing.timer);
    const watch = await loadWatch(dir);
    const gh = await loadGithub(dir);
    if ((!watch?.enabled && !gh?.enabled) || !parent?.id) { WATCHERS.delete(key); return; }
    // 轮询节拍取两者里较快的那档（各自另有 intervalMs 决定实际频率）。
    const intervals = [watch?.enabled ? watch.intervalMs : Infinity, gh?.enabled ? gh.intervalMs : Infinity].filter(Number.isFinite);
    const tickMs = Math.max(10000, Math.min(...intervals));
    const entry = { dir, parent, timer: undefined, busy: false, intervalMs: tickMs, ghLast: 0 };
    const tick = async () => {
      if (entry.busy) return;
      entry.busy = true;
      try {
        const liveWatch = await loadWatch(dir);
        if (liveWatch?.enabled) await runScan(dir, entry.parent, liveWatch);
        const liveGh = await loadGithub(dir);
        if (liveGh?.enabled && Date.now() - entry.ghLast >= liveGh.intervalMs) {
          entry.ghLast = Date.now();
          await runGithubSync(dir, entry.parent, liveGh);
        }
      } catch { /* 单次失败不打断轮询 */ }
      entry.busy = false;
    };
    entry.timer = setInterval(tick, tickMs);
    entry.timer.unref?.();
    WATCHERS.set(key, entry);
  }

  function summarizeScan(results) {
    if (!Array.isArray(results) || results.length === 0) return '收件目录为空。';
    const tally = {};
    for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
    const parts = Object.entries(tally).map(([k, n]) => `${k}=${n}`);
    const rejected = results.filter((r) => r.status === 'pending' && r.reason).map((r) => `#${r.id}: ${r.reason}`);
    return `扫描完成：${parts.join('，')}。${rejected.length ? `\n未派成：${rejected.join('；')}` : ''}`;
  }

  function formatGithubResults(res) {
    if (!res) return '无结果。';
    if (res.status === 'not-modified') return '无变化（304）。';
    const rows = Array.isArray(res.results) ? res.results : [];
    if (rows.length === 0) return '没有 open issues。';
    const tally = {};
    for (const r of rows) tally[r.status] = (tally[r.status] ?? 0) + 1;
    const parts = Object.entries(tally).map(([k, n]) => `${k}=${n}`);
    const pend = rows.filter((r) => r.status === 'pending' && r.reason).map((r) => `#${r.id}: ${r.reason}`);
    return `${parts.join('，')}${pend.length ? `；未派成：${pend.join('；')}` : ''}`;
  }

  if (typeof ctx.commands?.register === 'function') {
    const disposeCommand = ctx.commands.register({
      definitionId: 'code-studio-watch',
      name: 'code-studio-watch',
      description: '工作室监听：on 全开 / off 全关 / scan 立即扫（本地收件+GitHub）/ interval <ms> 本地间隔 / '
        + 'github <owner/repo> 绑 GitHub 源 / github off / token <token> / pr <issueId> 用 gh 建 PR / 无参看状态。',
      input: { hint: 'on | off | scan | interval <ms> | github <owner/repo> | github off | token <t> | pr <issueId>' },
      recordInput: false,
      handler: async ({ agent, rawInput }) => {
        const dir = sessionCwd({ agent });
        if (!dir) return { kind: 'error', text: '拿不到当前工作区目录。' };
        const args = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean);
        const sub = (args[0] ?? '').toLowerCase();
        if (sub === 'on') {
          const cfg = await saveWatch(dir, { enabled: true });
          await ensureWatcher(dir, agent);
          return { kind: 'success', text: `本地监听已开：每 ${Math.round(cfg.intervalMs / 1000)}s 扫 ${inboxDir(dir, cfg)}。` };
        }
        if (sub === 'off') {
          await saveWatch(dir, { enabled: false });
          await saveGithub(dir, { enabled: false });
          await ensureWatcher(dir, agent);
          return { kind: 'success', text: '监听已全关（本地收件 + GitHub）。' };
        }
        if (sub === 'interval') {
          const cfg = await saveWatch(dir, { intervalMs: Number(args[1]) });
          await ensureWatcher(dir, agent);
          return { kind: 'success', text: `本地轮询间隔已设为 ${Math.round(cfg.intervalMs / 1000)}s${cfg.enabled ? '' : '（本地监听当前关着）'}。` };
        }
        if (sub === 'github') {
          const target = (args[1] ?? '').toLowerCase();
          if (target === 'off') {
            await saveGithub(dir, { enabled: false });
            await ensureWatcher(dir, agent);
            return { kind: 'success', text: 'GitHub 源已关。' };
          }
          const slug = parseRepoSlug(args[1] ?? '');
          if (!slug) return { kind: 'error', text: '用法：/code-studio-watch github owner/repo（或完整 GitHub URL）。' };
          const cfg = await saveGithub(dir, { repo: slug.slug, enabled: true });
          await ensureWatcher(dir, agent);
          return { kind: 'success', text: `GitHub 源已开：${cfg.repo}，每 ${Math.round(cfg.intervalMs / 1000)}s 拉 open issues${cfg.hasToken ? '' : '（未存 PAT，私有仓库或高额度请 /code-studio-watch token <pat>）'}。` };
        }
        if (sub === 'token') {
          const raw = String(args.slice(1).join(' ') ?? '').trim();
          if (raw.toLowerCase() === 'off' || raw.toLowerCase() === 'clear') {
            const cfg = await saveGithub(dir, { token: '' });
            return { kind: 'success', text: `已清除 GitHub PAT（${cfg.repo || '尚未绑定仓库'}）。` };
          }
          if (!raw) return { kind: 'error', text: '用法：/code-studio-watch token <pat>，或 token off 清除。' };
          const cfg = await saveGithub(dir, { token: raw });
          return { kind: 'success', text: `已存 GitHub PAT（${cfg.repo || '尚未绑定仓库'}）。它单独存 .codewrite/github-token，不进 github.json、不进版本库。` };
        }
        if (sub === 'pr') {
          const id = String(args[1] ?? '').trim();
          if (!id) return { kind: 'error', text: '用法：/code-studio-watch pr <issueId>（用本机 gh 建 PR，需先 gh auth login）。' };
          const { issues } = await loadIssues(dir);
          const issue = (Array.isArray(issues) ? issues : []).find((it) => String(it.id) === id) ?? { id };
          const res = await createPr({ dir, issue: { id, title: issue.title, body: issue.body } });
          if (!res.ok) {
            const hint = res.code === 'GH_NOT_AUTHED' ? ' 先在终端跑 `gh auth login`（选 github.com，勾 git 凭据），再重试。' : '';
            return { kind: 'error', text: `建 PR 被拒（${res.code}）：${res.reason ?? ''}${hint}` };
          }
          return { kind: 'success', text: `已建 PR：${res.url}（分支 ${res.branch}）。` };
        }
        if (sub === 'scan') {
          const cfg = normalizeWatch((await loadWatch(dir)) ?? {});
          const results = await runScan(dir, agent, cfg);
          const gh = await loadGithub(dir);
          let ghText = '';
          if (gh?.enabled) {
            const res = await runGithubSync(dir, agent, gh);
            ghText = res?.ok ? `\nGitHub：${formatGithubResults(res)}` : `\nGitHub：失败（${res?.code}）${res?.reason ?? ''}`;
          }
          return { kind: 'success', text: summarizeScan(results) + ghText };
        }
        const cfg = await loadWatch(dir);
        const gh = await loadGithub(dir);
        const watchText = cfg ? `本地：${cfg.enabled ? '开' : '关'}；间隔 ${Math.round(cfg.intervalMs / 1000)}s；收件 ${inboxDir(dir, cfg)}` : '本地：未配置';
        const ghText = gh ? `GitHub：${gh.enabled ? '开' : '关'}；仓库 ${gh.repo || '（无）'}；每 ${Math.round(gh.intervalMs / 1000)}s；PAT ${gh.hasToken ? '已存' : '未存'}` : 'GitHub：未配置';
        return { kind: 'success', text: `${watchText}\n${ghText}` };
      },
    });
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        if (typeof disposeCommand === 'function') disposeCommand();
        for (const entry of WATCHERS.values()) if (entry.timer !== undefined) clearInterval(entry.timer);
        WATCHERS.clear();
      }, 'code-studio: watchers');
    }
  }

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
            const subagents = ctx.get?.('subagents');
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
              if (ownerId && exec?.agent && typeof subagents?.interrupt === 'function') {
                try { subagents.interrupt(ownerId, { kind: 'ancestor', agent: exec.agent }); } catch { /* 已结束 */ }
              }
              unmarkChild(ownerId);
              await registry.cancel(task.id, task.owner_agent ?? undefined, { reason: `已选定 ${chosen.id}，其余平行版本作废` });
              dropped.push(`${task.id}(已作废)`);
            }
            return { report: `已选定 ${chosen.id}（owner=${childId}）。其余版本：${dropped.length ? dropped.join('、') : '无'}。\n下一步：派 gopher 或 fixer 把选定版本落成正式文件。` };
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
          role: { type: 'string', enum: ROLE_IDS, description: '目标角色 id' },
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
        const subagents = ctx.get?.('subagents');
        const startActivation = typeof subagents?.startActivation === 'function';
        if (!startActivation && typeof subagents?.start !== 'function') {
          return { report: '派单失败：subagents 服务不可用，请改用 subagent 工具（本次将继承父 Agent 的模型）。' };
        }

        const route = routeForRole(role);
        const modelLine = route ? describeRoute(role, route) : `${role} · 未指派模型（继承父 Agent）`;

        // 平行版本
        const variantList = Array.isArray(args.variants)
          ? args.variants.map((item) => String(item ?? '').trim()).filter((item) => item !== '').slice(0, 5)
          : [];
        if (variantList.length > 0) {
          if (variantList.length < 2) return { report: 'variants 至少要给两个互不相同的侧重；只有一个就直接派单。' };
          if (!canDispatchContinuable(subagents)) return { report: 'variants 需要常驻子会话通路，本宿主只装了 one-shot provider，请逐个派单。' };
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
            `收齐后让用户先挑：把每版侧重与它写了什么摆给他，不要替他挑。选定后派 fixer/gopher 落稿，其余用 code_task(action:"pick") 作废。`);
          return { report: lines.join('\n') };
        }

        // 单路派单：首选常驻
        if (canDispatchContinuable(subagents)) {
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
          return { report: `${renderDispatched({ modelLine, childId: result.childId, role, label: args.label ?? role })}\n\n账本：任务 ${taskId} 已认领并派发（owner=${result.childId}）。子 Agent 结算时宿主会把结果送你，编排器会自动 settle。` };
        }

        // 回退：one-shot，阻塞等结果
        const request = withDepthCap(buildDispatchRequest({
          label: args.label ?? role, prompt, parent, signal: DETACHED_SIGNAL, route,
        }), subagents);
        let run;
        try {
          run = startActivation
            ? await subagents.startActivation(buildOneShotActivation({ label: args.label ?? role, request }))
            : await subagents.start(SPAWN_PROVIDER, request);
        } catch (error) {
          return { report: `派单失败（${modelLine}）：${error instanceof Error ? error.message : String(error)}` };
        }
        try {
          const result = await run.result;
          const text = outputText(result?.output);
          const failure = stopReasonText(result?.stopReason);
          if (failure) return { report: `## ${modelLine}\n\n${failure}。${text ? `\n\n已产出：\n\n${text}` : ''}` };
          return { report: `## ${modelLine}\n\n${text || '（子 Agent 没有产出文本）'}` };
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
        + 'set 直接写一条 issue 的字段（status/report/region/write_scope…）/ dispatch 把 issue 派给它该去的'
        + '持久子会话（同片文件夹追回同一子会话串行追加，换片新建；在飞分组 ≤' + MAX_GROUPS + '，禁派 tech-lead）/ '
        + 'watch 开关监听、改轮询间隔或立即扫收件目录（<repo>/.codewrite/inbox/*.json 丢一条即派单）；'
        + 'watch 也带 github/token 参数把 GitHub 仓库的 open issues 当来源（owner/repo 或 URL）/ '
        + 'pr 用本机 gh CLI 把这条 issue 的改动提成 PR（插件不存任何凭据，凭据在 gh 自己那儿）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          work: { type: 'string', description: '仓库名或目录；省略时用会话工作区' },
          action: { type: 'string', enum: ['assign', 'issues', 'regions', 'set', 'dispatch', 'watch', 'pr'], description: '要执行的操作' },
          id: { type: 'string', description: 'issue 编号，如 "12" 或 "gh-12"' },
          folders: { type: 'array', items: { type: 'string' }, description: 'assign：issue 触碰的文件夹' },
          region: { type: 'string', description: 'assign/set：强制指定 region（省略则自动匹配）' },
          title: { type: 'string', description: 'assign/set：issue 标题' },
          repo: { type: 'string', description: 'assign/set：来源仓库，如 o/n' },
          body: { type: 'string', description: 'assign/set：issue 原文' },
          status: { type: 'string', description: 'set：任务状态，如 DONE/RUNNING/READY/FAILED' },
          report: { type: 'string', description: 'set：处理结果报告' },
          childId: { type: 'string', description: 'assign：持久子会话 id（已知时传入，如 ta:ws:auth-api）' },
          role: { type: 'string', description: 'dispatch：子会话角色（禁止 tech-lead）' },
          prompt: { type: 'string', description: 'dispatch：本次投给子会话的任务正文' },
          enabled: { type: 'boolean', description: 'watch：开/关本地收件监听' },
          intervalMs: { type: 'number', description: 'watch：本地轮询间隔（毫秒）' },
          scan: { type: 'boolean', description: 'watch：立即扫一遍（本地收件 + GitHub）' },
          github: { type: 'string', description: 'watch：绑 GitHub 源（owner/repo 或完整 URL；传 "off" 关闭）' },
          token: { type: 'string', description: 'watch：GitHub PAT（私有仓库/提额度才需要；传 "off" 清除）。单独存 .codewrite/github-token，不进版本库' },
          base: { type: 'string', description: 'pr：目标分支，默认 main' },
        },
        required: ['action'],
      },
      output: reportOutput((_args, value) => textResult(value.report)),
      execute: (args, exec) => (async () => {
        const dir = workDir(args.work, exec);
        const action = String(args.action ?? 'issues');
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
            lines.push(`- **${name}** 文件夹：${(region.folders ?? []).join('、') || '（无）'}，issue：${(region.issues ?? []).join(',') || '（无）'}${region.childId ? `，会话：${region.childId}` : ''}`);
          }
          return { report: lines.join('\n') };
        }
        // set：直接写一条 issue 的字段
        if (action === 'set') {
          const id = String(args.id ?? '').trim();
          if (!id) return { report: 'set 需要 id。' };
          const patch = { id };
          for (const key of ['title', 'repo', 'body', 'status', 'report', 'region', 'childId']) {
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
          let res;
          try {
            res = await createPr({
              dir,
              issue: { id, title: args.title ?? issue.title, body: args.body ?? issue.body },
              base: args.base,
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
          return { report: `已建 PR：${res.url}\n分支 ${res.branch}。` };
        }
        // watch：开关 / 改间隔 / 立即扫 / 绑 GitHub 源（本地配置落 watch.json，GitHub 落 github.json）
        if (action === 'watch') {
          const parent = exec?.agent;
          const touched = ['enabled', 'intervalMs', 'scan', 'github', 'token'].some((k) => args[k] !== undefined);
          if (!touched) {
            const cfg = await loadWatch(dir);
            const gh = await loadGithub(dir);
            const watchText = cfg ? `本地：${cfg.enabled ? '开' : '关'}；间隔 ${Math.round(cfg.intervalMs / 1000)}s；收件 ${inboxDir(dir, cfg)}` : '本地：未配置';
            const ghText = gh ? `GitHub：${gh.enabled ? '开' : '关'}；仓库 ${gh.repo || '（无）'}；每 ${Math.round(gh.intervalMs / 1000)}s；PAT ${gh.hasToken ? '已存' : '未存'}` : 'GitHub：未配置';
            return { report: `${watchText}\n${ghText}` };
          }
          let cfg = (await loadWatch(dir)) ?? normalizeWatch({});
          if (args.enabled !== undefined) cfg = await saveWatch(dir, { enabled: args.enabled === true });
          if (args.intervalMs !== undefined) cfg = await saveWatch(dir, { intervalMs: Number(args.intervalMs) });
          if (args.github !== undefined) {
            const target = String(args.github ?? '').trim().toLowerCase();
            if (target === 'off' || target === '') await saveGithub(dir, { enabled: false });
            else {
              const slug = parseRepoSlug(args.github);
              if (!slug) return { report: `github 需要 owner/repo 或 GitHub URL，收到「${args.github}」。` };
              await saveGithub(dir, { repo: slug.slug, enabled: true });
            }
          }
          if (args.token !== undefined) {
            const tk = String(args.token ?? '').trim();
            const clear = tk.toLowerCase() === 'off' || tk.toLowerCase() === 'clear';
            await saveGithub(dir, { token: clear ? '' : tk });
          }
          if (parent) await ensureWatcher(dir, parent);
          if (args.scan === true) {
            const results = await runScan(dir, parent, cfg);
            const gh = await loadGithub(dir);
            let ghText = '';
            if (gh?.enabled) {
              const res = await runGithubSync(dir, parent, gh);
              ghText = res?.ok ? `\nGitHub：${formatGithubResults(res)}` : `\nGitHub：失败（${res?.code}）${res?.reason ?? ''}`;
            }
            return { report: `监听${cfg.enabled ? '开' : '关'}（间隔 ${Math.round(cfg.intervalMs / 1000)}s）。${summarizeScan(results)}${ghText}` };
          }
          const gh = await loadGithub(dir);
          const ghPart = gh?.enabled ? `；GitHub ${gh.repo} 每 ${Math.round(gh.intervalMs / 1000)}s` : '';
          return { report: `本地监听已${cfg.enabled ? '开' : '关'}：每 ${Math.round(cfg.intervalMs / 1000)}s 扫 ${inboxDir(dir, cfg)}（收件丢 *.json 即派单）${ghPart}。` };
        }
        // dispatch：把 issue 派给它该去的持久子会话
        if (action === 'dispatch') {
          const id = String(args.id ?? '').trim();
          if (!id) return { report: 'dispatch 需要 id。' };
          const role = String(args.role ?? '').trim() || 'implementer';
          const prompt = String(args.prompt ?? '').trim();
          if (!prompt) return { report: 'dispatch 需要 prompt（投给子会话的任务正文）。' };
          const parent = exec?.agent;
          if (!parent) return { report: 'dispatch 失败：拿不到调用方 Agent（exec.agent 未定义）。' };
          const subagents = ctx.get?.('subagents');
          if (typeof subagents?.startActivation !== 'function') {
            return { report: 'dispatch 失败：subagents.startActivation 不可用（需要常驻子会话通路）。' };
          }
          const folders = Array.isArray(args.folders) ? args.folders.map((item) => String(item ?? '')).filter(Boolean) : [];
          const title = String(args.title ?? '').trim();
          let result;
          try {
            result = await dispatchIssue({
              dir, issue: { id, folders, ...(title ? { title } : {}) }, role, prompt, parent, subagents,
              agents: ctx.get?.('agents'), worktrees: ctx.get?.('worktrees'), workingDirectory: ctx.get?.('workingDirectory'), route: routeForRole(role),
            });
          } catch (error) {
            return { report: `dispatch 失败：${error instanceof Error ? error.message : String(error)}` };
          }
          if (!result.ok) return { report: `dispatch 被拒（${result.code}）：${result.reason}` };
          if (result.mode === 'create') {
            markChild(result.childId, { role, parentId: parent.id, label: `region:${result.region}` });
          }
          trackStudioChild(result.childId, dir, id);
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
        await upsertRegion(dir, name, { folders: plan.folders, issues: [id], ...(args.childId ? { childId: args.childId } : {}) });
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
  // 注册
  // -------------------------------------------------------------------------

  const tools = [
    buildRolesTool(), buildBriefTool(), buildCheckTool(), buildStateTool(), buildTaskTool(), buildDispatchTool(),
    buildKbTool(), buildMapTool(), buildReviewTool(), buildEvalTool(), buildStudioTool(),
  ];
  for (const tool of tools) ctx.tools.register(concurrent(tool));

  // -------------------------------------------------------------------------
  // 技术总监预设（程序化注册，与小说插件同构）
  // -------------------------------------------------------------------------
  // agent.cordis.yml 只是可复用资产；真正让「代码总编工作室」出现在预设列表里的是
  // agentPresets.register()。persona 文本与 guard 都挂在 scoped preset 上下文上，
  // 只对使用本预设的会话生效，不污染其它 Agent。

  const staffNames = ROLE_IDS.filter((role) => role !== 'tech-lead').map((role) => ROLE_NAMES[role]).join('、');
  const staffCount = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五'][ROLE_IDS.length - 1] ?? String(ROLE_IDS.length - 1);

  const techLeadPrompt = [
    '你是「代码总编工作室」的主 Agent，技术总监是用户唯一可见的对话入口。',
    `你负责理解用户自然语言需求、读取仓库资料、组织任务、调用${staffNames}${staffCount}类子 Agent，汇总结果后用简洁中文交付。你不向用户暴露内部命令、原始 JSON 或长派单日志。`,
    '',
    '**你的默认动作是「输出工作流并派单」**：收到任何编码类请求（加功能、修 bug、重构、补测试、改配置……）都不要自己把代码生成出来，而是先给出一份任务编排（谁做什么、依赖顺序、每步交付物），再用 code_dispatch 逐个派出子 Agent，最后汇总它们的交付。',
    `本会话已硬限制技术总监的直接写入与执行通道（${Object.keys({ write: 1, edit: 1, pwsh: 1, bash: 1, subagent: 1, subagent_fork: 1 }).join(' / ')}）；被拒绝时不要重试、也不要换等价写法绕过，改走派单。`,
    '你保留的只读通道：read / glob / grep / code_brief / code_state / code_check / code_roles / code_review / code_map / code_kb / code_eval / code_task（读视角） / code_dispatch。',
    '唯一例外：`.codewrite/editor/` 下的 `.md`（你的记忆文件）你可以直接写，不用派单。',
    '用户只问信息、要判断、要解释时，直接回答即可，不必派单。',
    '',
    '**不要倾倒代码**：严禁把整份文件、整段 diff 复制进你的回复——即使用户说「贴出来我看看」。需要他判断时只给定位与判据（哪个文件、哪一行/哪个函数、什么问题、建议怎么改）；确有必要引用时最多摘一句作证据。要看全文就派子 Agent 到文件里读，让它把结论而不是原文交回来。子 Agent 的整份交付同样不要原样倾倒，压成阶段、结果、下一步、需要他决定什么。',
    '',
    '**依赖顺序**：架构 -> 契约 -> 设计 -> 实现 -> 机器门（code_check） -> 审校 -> 修复（需要时回审校） -> 档案。测试工程（test）通常跟在实现之后、机器门前或与审校并行，它只写测试文件、不改业务代码，发现 bug 交 fixer。安全审计（security）在改动触碰信任边界（输入解析、鉴权、序列化、SQL/shell、路径、反序列化、上传、依赖）时按需插入，零写权限、只出报告。实现 Agent 只写指定文件；审校 Agent 独立检查；修复 Agent 只做定点修改；档案 Agent 只在审校 PASS 后接手，读定稿产出交接记录，不改代码、只能报告冲突。影响推演（impact）是旁路：一次改动后果难料、用户要在几个方案间拍板、或你怀疑会撞坏已锁定契约时才派它，它只回评估报告、零写权限，采不采由你和用户决定。所有任务最多两轮修复，无法解决就向用户说明冲突。',
    '',
    '**派单协议**（必填，缺一不得派出）：task（一句话任务名）、stage（当前阶段）、objective（这一步要达成什么）、source_paths（要读/改的路径）、write_paths（允许写的文件 glob，= write_scope，越界当场被拒）、contracts（必须遵守的接口/数据契约）、constraints（不许做什么）、acceptance（验收判据：机器门命令 + 人工判据）、deliverable（交付物形态）、round（第几轮）。缺 objective / source_paths / acceptance 不得派出。',
    '',
    '**账本自动化**：派单前 code_task open，派完不用等——子 Agent 结算时宿主会把结果送回你的对话，编排器自动 settle。定期 code_state 看有没有卡住的任务，租约过期的用 code_task reclaim 收回。用户说停时先核对账本，别留下无主任务。',
    '',
    '**平行版本**：用户在几个实现方向间举棋不定时，用 code_dispatch 的 variants 参数一次开 2-5 个侧重不同的版本并同时派出。每版只出粗实现、不过机器门。收齐后把每版侧重与它写了什么摆给用户，不要替他挑。选定后用 code_task(action:"pick") 作废其余，再派 fixer/gopher 落定。',
    '',
    '**杂役与文档同步员**：改名、搬文件、批量改 import、生成 changelog、统一格式、查某符号出现在哪、清理临时目录这类机械活派 gopher（一次把清单列全给它，别为十件小事派十次单）；README / API 文档 / 注释与代码对齐派 librarian。',
    '',
    '**失败归因纪律**：子 Agent 报告「工具缺陷 / 平台限制 / 绕不过去」时，不要原样转述——先按三问自查（原始错误码是什么、做过能推翻猜测的对照检查吗、插件有没有现成通道没用），答不上来就退回该 Agent 补证据。只有你自己复现过、三问都能答上的平台级结论才可以上报，且必须附原始错误码与已排除的对照项。绝不要让用户手工创建、删除或编辑仓库文件；也不要接受子 Agent 用新建 v2 文件去绕开一次本可修复的失败。',
    '',
    '**ponytail 纪律**：写代码前先爬梯子，停在第一个成立的台阶（需要存在吗 → 仓库/标准库有吗 → 标准库能做吗 → 平台原生覆盖吗 → 已装依赖能解决吗 → 能一行吗 → 才写最小实现）。最短可工作 diff 胜出，但前提是真读懂问题；修 bug 找根因（改共享守卫，先 grep 全部调用方）；不做没要求的抽象；非平凡逻辑留一个能跑的最小自检。',
  ].join('\n');

  let releasePreset;
  let presetClosed = false;
  let presetMissing = false;
  const declareCodePreset = () => {
    const registry = ctx.get?.('agentPresets');
    if (!registry?.register || releasePreset) {
      presetMissing = !registry?.register;
      return;
    }
    presetMissing = false;
    Promise.resolve(registry.register({
      id: 'code-editor',
      name: '代码总编工作室',
      description: `由技术总监调度${staffNames}等${staffCount}类 Agent 的代码工作室。`,
      plugins: [{
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: { text: techLeadPrompt, prefix: '', suffix: '', includeRuntimeContext: false },
      }, {
        id: 'code-guard',
        name: 'dsh-plugin-code-studio/code-guard',
      }],
    })).then((dispose) => {
      if (presetClosed) {
        if (typeof dispose === 'function') dispose();
      } else {
        releasePreset = dispose;
        ctx.logger?.info?.('dsh-plugin-code-studio: preset code-editor declared');
      }
    }).catch((error) => {
      ctx.logger?.warn?.(`dsh-plugin-code-studio: preset registration failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  declareCodePreset();
  if (typeof ctx.inject === 'function') {
    ctx.inject(['agentPresets'], () => {
      if (presetMissing && !presetClosed) declareCodePreset();
    });
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      presetClosed = true;
      if (typeof releasePreset === 'function') releasePreset();
    }, 'code-studio: editor preset');
  }

  // 把设置页里指定的「角色 -> 模型」接进系统提示词（惰性读取，服务可能晚于本插件装载）。
  let releaseModelHint;
  let modelHintMissing = false;
  const declareModelHint = () => {
    const prompt = ctx.get?.('systemPrompt');
    if (!prompt?.section || releaseModelHint !== undefined) {
      modelHintMissing = !prompt?.section;
      return;
    }
    modelHintMissing = false;
    const base = typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder('TOOL_SUBAGENT') : undefined;
    releaseModelHint = prompt.section({
      name: 'code-studio: model assignments',
      order: Number.isFinite(base) ? base - 50 : 3050,
      text: () => {
        const settings = ctx.get?.('codeStudioAgentModels');
        if (typeof settings?.current !== 'function') return '';
        const { enabled, assignments } = settings.current();
        if (!enabled || !assignments.length) return '';
        const lines = assignments.map((item) => `- ${item.role} → ${item.provider}/${item.model}${item.reasoningEffort ? `（effort=${item.reasoningEffort}）` : ''}`);
        return ['## 角色 → 模型指派（设置页）', ...lines, '未列出的角色继承你的模型。'].join('\n');
      },
    });
  };
  declareModelHint();
  if (typeof ctx.inject === 'function' && modelHintMissing) {
    ctx.inject(['systemPrompt'], () => {
      if (modelHintMissing) declareModelHint();
    });
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      if (typeof releaseModelHint === 'function') releaseModelHint();
      releaseModelHint = undefined;
    }, 'code-studio: model assignments');
  }

  // 工作区记忆读回：把 <repo>/.codewrite/editor/MEMORY.md 的尾部注入系统提示词。
  // 旧版只在 code-guard 里把 editor/ 列为「可写目录」，写进去从不加载 = 没记忆；这一段补上。
  // repoRoot 取自当前 scope（总监会话）的 cwd；改工作区后由 section 的惰性 text 下次构建时重读。
  {
    let releaseMemory;
    let memoryMissing = false;
    const declareMemoryHint = () => {
      const prompt = ctx.get?.('systemPrompt');
      if (!prompt?.section || releaseMemory !== undefined) {
        memoryMissing = !prompt?.section;
        return;
      }
      memoryMissing = false;
      const base = typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder('TOOL_SUBAGENT') : undefined;
      releaseMemory = prompt.section({
        name: 'code-studio: workspace memory',
        order: Number.isFinite(base) ? base - 40 : 3060,
        text: (context) => {
          const repoRoot = context?.scope?.session?.header?.cwd;
          if (!repoRoot) return '';
          try {
            return memorySectionText(repoRoot);
          } catch {
            return '';
          }
        },
      });
    };
    declareMemoryHint();
    if (typeof ctx.inject === 'function' && memoryMissing) {
      ctx.inject(['systemPrompt'], () => {
        if (memoryMissing) declareMemoryHint();
      });
    }
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        if (typeof releaseMemory === 'function') releaseMemory();
        releaseMemory = undefined;
      }, 'code-studio: workspace memory');
    }
  }
}

// 不要在这里加 `export default`：cordis 的 unwrapExports 用 `exports.default ?? exports`，
// 一旦有 default，顶层的 inject/name/description 全部作废，apply 静默失效。
