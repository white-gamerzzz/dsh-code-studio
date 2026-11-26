/**
 * dsh-plugin-code-studio — 代码工作室
 *
 * 子 Agent 团队的协调工具：issue 台账、git worktree 副本、结算回写、合并闸门、
 * 规则/记忆层、web 面板。插件自己不派子 Agent——主 Agent 用 submit 备单后
 * 自己起子会话（来源不限），`code_studio set childId` 登记后结算才会回写台账。
 *
 * 注册层 API 形状抄自 dsh-plugin-novel 的 apply()，不要凭猜测改：
 *   工具 → ctx.tools.register({ name, description, parameters, output, execute })
 * 用到的 ctx 服务必须进 inject，否则 `cannot get property "x" without inject` 会让整个 apply 失败。
 */

import { homedir } from 'node:os';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, isAbsolute, resolve as resolvePath, basename } from 'node:path';

import { unmarkChild, listMarks } from './session-roles.js';
import { concurrent, oneLine } from './toolkit.js';
import { pozhangAnchor, registerHzCommand } from './pozhang-command.js';
import { createWatcher } from './watcher.js';
import { createTools } from './tools.js';
import { createRuntime } from './runtime.js';
import { installPreset } from './preset.js';
import { installWebServer } from './web-server.js';
import { DETACHED_SIGNAL, outputText, stopReasonText } from './dispatch.js';
import { runCommand } from './runner.js';
import { loadIssues, getIssue } from './studio-store.js';
import { appendSessionMemory, appendAgentMemory } from './studio-memory.js';
import { settleIssue, cleanupWorkspace } from './studio-dispatch.js';
import { makeCliExecutor } from './executor.js';
import { writeBackIssue } from './studio-github.js';
import { resolveMemoryRoot } from './studio-workspace.js';
import { parsePorcelain } from './studio-pr.js';

export const name = 'code-studio';

export const description = 'Code studio: multi-role orchestration over a repository with task ledger, write_scope and a machine gate.';

// webServer 必须声明为依赖：apply() 里一次性注册 HTTP 路由（工作室内置网页），
// 而这个服务在 apply 执行时可能还没挂上 —— 排在 inject 里，cordis 会等它就绪再跑 apply，
// 否则 ctx.get('webServer') 返回 undefined，路由整块被跳过 → 右栏 iframe 一片白（404）。
export const inject = ['tools', 'commands', 'webServer'];

export function apply(ctx, rawConfig = {}) {
  const config = {
    projectsRoot: rawConfig.projectsRoot ?? 'code',
    // 进入「工作室语境」时自动建 .code-studio（打开面板/派单/写规则/开监听）。默认开，可关。
    autoCreate: rawConfig.autoCreate !== false,
    // 派单执行器：不给 = DSH 子 Agent；给 {command, args?, cwdOf?} = 本机 CLI（claude / codex / 自写脚本）。
    // 两条路共用 region / issue / 副本 / 待合并区整套流程。
    executor: rawConfig.executor ?? null,
  };

  // -------------------------------------------------------------------------
  // 压缩守望 + /hz 命令（/hz 本体在 lib/pozhang-command.js）
  // -------------------------------------------------------------------------

  // 压缩守望：dsh-compaction 摘要后子会话可能丢掉头部约定。
  // 只做低成本检测（会话日志缩水 >35%）+ 5 分钟冷却，命中就给该子会话追发一句锚点。
  const childSizes = new Map();
  const lastNudge = new Map();
  const findSessionLog = (childId) => {
    const root = join(homedir(), '.dsh', 'sessions');
    let dirs = [];
    try {
      dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return null;
    }
    for (const ws of dirs) {
      const log = join(root, ws, `session-${childId}`, 'session.v4.jsonl.zstd');
      if (existsSync(log)) return log;
    }
    return null;
  };
  const watchCompaction = () => {
    const subagents = ctx.get?.('subagents');
    const agents = ctx.get?.('agents');
    if (typeof subagents?.sendMessage !== 'function') return;
    for (const [childId, mark] of listMarks()) {
      const log = findSessionLog(childId);
      if (!log) continue;
      let size = 0;
      try {
        size = statSync(log).size;
      } catch {
        continue;
      }
      const prev = childSizes.get(childId);
      childSizes.set(childId, size);
      if (!prev || size >= prev * 0.65) continue;
      if (Date.now() - (lastNudge.get(childId) ?? 0) < 5 * 60_000) continue;
      const parent = mark?.parentId && typeof agents?.get === 'function' ? agents.get(mark.parentId) : undefined;
      if (!parent) continue;
      const anchor = pozhangAnchor();
      if (!anchor) continue;
      Promise.resolve(subagents.sendMessage(parent, childId, [{ type: 'text', text: anchor.trim() }], { signal: DETACHED_SIGNAL }))
        .then(() => {
          lastNudge.set(childId, Date.now());
          ctx.logger?.info?.(`pozhang: 子会话 ${childId} 会话日志缩水，疑似被压缩，已追发锚点`);
        })
        .catch(() => {});
    }
  };
  const compactTimer = setInterval(watchCompaction, 20_000);
  compactTimer.unref?.();
  if (typeof ctx.effect === 'function') ctx.effect(() => () => clearInterval(compactTimer));

  registerHzCommand(ctx);

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

  /** 判定一个目录是不是「代码工作区」：有 .git / .codewrite / .code-studio 就算。 */
  function isWorkDir(dir) {
    return existsSync(join(dir, '.git')) || existsSync(join(dir, '.codewrite')) || existsSync(join(dir, '.code-studio'));
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
  // 运行时层 —— 已搬 lib/runtime.js：子会话登记 / 执行器 / 记忆 / 中止。
  // 结算函数 handleChildEnd 留在本文件：它引用 watcher 的 GitHub 会话配置，watcher 又要本层产物。
  // -------------------------------------------------------------------------
  const {
    STUDIO_CHILDREN, trackStudioChild, makeSemanticRoute, executorFor, makeMemoryFor, cancelIssue,
  } = createRuntime({ ctx, config, onChildEnd: (end) => handleChildEnd(end) });


  // 结算：把「子会话结束一次 run」的结果落进 issues.json。
  // 入参是**中立**的结束信息（childId / lastAssistantMessage / stopReason）——
  // 谁来喂它由执行器决定：DSH 从 ctx 的 subagent/end 喂（见下），
  // CLI 执行器从进程退出喂（makeCliExecutor 的 onEnd）。结算逻辑本身不认宿主（用户 m14694）。
  function handleChildEnd(info) {
    const childId = String(info?.childId ?? info?.id ?? '');
    if (!childId) return;
    // 一个持久子会话可串行服务多个 issue，按入队顺序 FIFO 出队。旁路：不 await、失败静默。
    void (async () => {
      try {
        const entry = STUDIO_CHILDREN.get(childId);
        if (!entry) return;
        const issueId = entry.issueIds.shift();
        if (entry.issueIds.length === 0) STUDIO_CHILDREN.delete(childId);
        if (!issueId) return;
          const report = outputText(info?.lastAssistantMessage);
          const failure = stopReasonText(info?.stopReason);
          // 改动文件：成功时在 issue 所在 worktree 里跑 git status --porcelain 抽出来，
          // 之前运行时永远没传过 changedFiles（只有 demo 传），Tab 的「改动文件」一直空。
          let changedFiles;
          if (!failure) {
            try {
              const cur = await getIssue(entry.dir, issueId);
              const gitDir = cur?.worktree || entry.dir;
              const g = await runCommand('git status --porcelain', { cwd: gitDir, timeoutMs: 30000 });
              if (g.code === 0) changedFiles = parsePorcelain(g.stdout);
            } catch { /* 抓不到改动文件不影响结算 */ }
          }
          await settleIssue(entry.dir, issueId, failure
            ? { ok: false, error: failure }
            : { ok: true, report, ...(Array.isArray(changedFiles) && changedFiles.length ? { changedFiles } : {}) });
          // GitHub 双向同步：来源是 GitHub 的 issue 结算后回写一条评论（DONE 只评论不关单，等 PR 合并再关）。
          if (!failure) {
            try {
              const settledGh = await getIssue(entry.dir, issueId);
              if (settledGh?.source === 'github' || settledGh?.githubNumber) {
                const ghCfg = await loadSessionGithub(entry.dir, entry.sessionId);
                const ghTok = await loadSessionToken(entry.dir, entry.sessionId);
                if (ghCfg?.repo) await writeBackIssue({ repoRoot: entry.dir, cfg: ghCfg, issue: settledGh, close: false, token: ghTok });
              }
            } catch { /* 回写 GitHub 失败不挡结算 */ }
          }
          // 工作区记忆写回：按会话隔离写进 .code-studio/sessions/<sid>/（region 记忆 + 本会话记忆），
          // 不再写公共 .codewrite/editor/MEMORY.md —— 那里同工作区所有会话共用，会串记忆。
          // 失败静默，不打断结算链路。
          if (!failure && report) {
            try {
              const settled = await getIssue(entry.dir, issueId);
              const block = `- #${issueId}${settled?.title ? ` ${settled.title}` : ''}：${oneLine(report, 220)}`;
              const sid = entry.sessionId;
              if (sid) {
                // 继承关系里旧会话已转只读：只读不写（写入会串到接手会话那份，语义上不允许）。
                const mem = await resolveMemoryRoot(entry.dir, sid).catch(() => ({ rootSessionId: sid, readonly: false }));
                if (mem.readonly) { /* 只读继承源，跳过写入 */ } else {
                  const wsid = mem.rootSessionId || sid;
                  await appendSessionMemory(entry.dir, wsid, block);
                  // 子 Agent 自己也留一份（冷恢复 / 同子会话后续指令用）
                  await appendAgentMemory(entry.dir, wsid, childId, block);
                }
              }
            } catch { /* 记忆写回失败不挡结算 */ }
          }
          // 副本清理：只有失败才拆。
          // 成功落在 REVIEW（待合并区）——改动还在副本里、还没进主干，副本必须留着等 code_merge；
          // 真合并后由 code_merge 自己拆（转 DONE + cleanupWorkspace）。
          try {
            if (failure) {
              const settled = await getIssue(entry.dir, issueId);
              if (settled?.worktree) {
                await cleanupWorkspace({ issue: settled, dir: entry.dir, runCommand });
              }
            }
          } catch { /* 清理失败不挡结算 */ }
        } catch { /* 回写失败不打断结算链路 */ }
        unmarkChild(childId);
      })();
  }

  if (typeof ctx.on === 'function') {
    // DSH 只是执行器之一：它把 subagent/end 喂给同一个 handleChildEnd。
    ctx.on('subagent/end', (info) => handleChildEnd({ childId: info?.id, lastAssistantMessage: info?.lastAssistantMessage, stopReason: info?.stopReason }));
  }


  // -------------------------------------------------------------------------
  // 监听轮询器 / GitHub 同步 / 会话绑定 —— 已搬 lib/watcher.js（重构第②步）。
  // -------------------------------------------------------------------------
  const {
    buildIssuePrompt, rulesForRole, resolveIssueDir, listRepos, runScan,
    ensureStudio, recordSessionBinding, sessionStudioDir, loadSessionGithub,
    saveSessionGithub, loadSessionToken, runGithubSync, ensureWatcher,
    summarizeScan, formatGithubResults,
  } = createWatcher({ ctx, config, executorFor, makeMemoryFor, trackStudioChild,
    makeSemanticRoute, sessionCwd, STUDIO_CHILDREN });

  // -------------------------------------------------------------------------
  // 工具层 —— 已搬 lib/tools.js（重构第③步）。注入宿主依赖，取回工具实例与注册表。
  // -------------------------------------------------------------------------
  const {
    tools, studioTool, mergeTool, opRegistry,
  } = createTools({
    ctx, executorFor, makeMemoryFor, trackStudioChild, makeSemanticRoute,
    STUDIO_CHILDREN, cancelIssue, workDir,
    buildIssuePrompt, rulesForRole, resolveIssueDir, listRepos,
    ensureStudio, sessionStudioDir, loadSessionGithub, loadSessionToken, saveSessionGithub,
    runScan, runGithubSync, ensureWatcher, summarizeScan, formatGithubResults,
  });
  for (const tool of tools) ctx.tools.register(concurrent(tool));

  // -------------------------------------------------------------------------
  // 注入层 —— lib/preset.js：工作区记忆读回 + 副本纪律两段系统提示（不注册主 Agent 预设）。
  // -------------------------------------------------------------------------
  installPreset({ ctx });

  // -------------------------------------------------------------------------
  // Web 层 —— 已搬 lib/web-server.js（重构第⑥步）：intake 收件 + 右栏三条路由。
  // -------------------------------------------------------------------------
  installWebServer({ ctx, projectsRootDir, isWorkDir, sessionCwd, opRegistry, config, listRepos });
}

// 不要在这里加 `export default`：cordis 的 unwrapExports 用 `exports.default ?? exports`，
// 一旦有 default，顶层的 inject/name/description 全部作废，apply 静默失效。
