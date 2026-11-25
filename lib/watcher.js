// lib/watcher.js — 收件目录轮询 / GitHub 同步 / 会话绑定 / /code-studio-watch 命令。
// 自 index.js 原样搬出（重构第②步）。分层纪律：可碰 ctx（注册命令），但不注册工具；
// 宿主服务与 index 内部助手一律经 createWatcher(env) 注入，模块自身不感知 DSH。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalWorkspace } from './task-registry.js';
import { loadIssues, loadRegions, upsertIssue, getIssue } from './studio-store.js';
import { settleIssue, dispatchIssue, cleanupWorkspace, regionSettled } from './studio-dispatch.js';
import { scanInbox, loadWatch, saveWatch, inboxDir, normalizeWatch } from './studio-watch.js';
import { loadGithub, syncGithub, loadGithubFrom, saveGithubTo, loadTokenFrom, parseRepoSlug, writeBackIssue } from './studio-github.js';
import { createPr, resolvePrDir } from './studio-pr.js';
import { runCommand } from './runner.js';
import { ensureWorkspaceDir, upsertRepo, upsertSession, sessionDir, resolveMemoryRoot, linkInherit, unlinkInherit, sessionIdOf } from './studio-workspace.js';
import { discoverRepos, resolveIssueRepo, enrichRemotes } from './studio-repo.js';
import { rulesSectionText } from './studio-rules.js';
import { pozhangAgentPrefix, pozhangAnchor } from './pozhang-command.js';

// -------------------------------------------------------------------------
// 会话级 GitHub 源 / PAT（纯逻辑，不碰 ctx）：GitHub 源与 PAT 跟人走（按会话），
// 存 <ws>/.code-studio/sessions/<rootSid>/ 下；rootSid 沿 inheritFrom 指针解析，
// 所以「换会话继承」不复制文件，直接指回旧会话那份。
// 拿不到会话概念时退回工作区根（老行为）。web-server 也用，故导出。
// -------------------------------------------------------------------------
export async function sessionStudioDir(wsRoot, agentOrSid) {
  const sid = typeof agentOrSid === 'string' ? String(agentOrSid).trim() : sessionIdOf(agentOrSid);
  if (!sid) return wsRoot;
  try {
    await ensureWorkspaceDir(wsRoot);
    const r = await resolveMemoryRoot(wsRoot, sid);
    return sessionDir(wsRoot, r.rootSessionId);
  } catch { return sessionDir(wsRoot, sid); }
}

/** 读当前会话的 GitHub 源；会话无配置则回退旧 <ws>/.codewrite/github.json（老工作区免迁移）。 */
export async function loadSessionGithub(wsRoot, agentOrSid) {
  const sdir = await sessionStudioDir(wsRoot, agentOrSid);
  const sessionCfg = await loadGithubFrom(sdir, wsRoot).catch(() => null);
  if (sessionCfg) return sessionCfg;
  return await loadGithub(wsRoot).catch(() => null);
}

/** 写当前会话的 GitHub 源；首次写且工作区级有旧配置时，把它搬进会话（一次性继承），避免切到会话级后丢源。 */
export async function saveSessionGithub(wsRoot, agent, patch) {
  const sdir = await sessionStudioDir(wsRoot, agent);
  const existing = await loadGithubFrom(sdir, wsRoot).catch(() => null);
  if (!existing) {
    const legacy = await loadGithub(wsRoot).catch(() => null);
    if (legacy?.repo) {
      await saveGithubTo(sdir, { repo: legacy.repo, labels: legacy.labels, assignee: legacy.assignee, intervalMs: legacy.intervalMs, enabled: legacy.enabled }).catch(() => {});
    }
  }
  return saveGithubTo(sdir, patch);
}

export async function loadSessionToken(wsRoot, agent) {
  const sdir = await sessionStudioDir(wsRoot, agent);
  return loadTokenFrom(sdir, wsRoot).catch(() => '');
}

export function createWatcher(env) {
  const { ctx, config, executorFor, makeMemoryFor, trackStudioChild, routeForRole, makeSemanticRoute, sessionCwd, STUDIO_CHILDREN } = env;

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

  /** 子 Agent 开工前读工作区规则（按它的角色过滤），拼到 prompt 前面。没有规则就返回 ''。 */
  function rulesForRole(dir, role) {
    try { return rulesSectionText(dir, { role }); } catch { return ''; }
  }
  /**
   * 多仓库工作区：给一个 issue 算出它该落到哪个仓库目录。
   * 单仓库/非 git 时原样返回工作区根；只有 issue.repo 或 folders 首段命中某个子仓库、且该子仓库确实存在时才切走。
   * ponytail: 目录名匹配（sync、不依赖 git remote），够用；要按 remote slug 精确归属需异步 discoverRepos。
   */
  function resolveIssueDir(wsRoot, issue) {
    try {
      const repos = discoverRepos(wsRoot, { depth: 2 });
      if (!repos.length) return wsRoot;
      const r = resolveIssueRepo({ workspaceRoot: wsRoot, issue, repos });
      if (r.dir && r.dir !== wsRoot && existsSync(r.dir)) return r.dir;
    } catch { /* 发现失败按单仓库处理 */ }
    return wsRoot;
  }

  /** 列出工作区里发现的 git 仓库（给 code_studio action=repos）。 */
  function listRepos(wsRoot) {
    try { return discoverRepos(wsRoot, { depth: 2 }); } catch { return []; }
  }

  async function runScan(dir, parent, cfg) {
    const subagents = ctx.get?.('subagents');
    if (typeof subagents?.startActivation !== 'function') return [];
    await ensureStudio(dir, parent);
    const role = 'implementer';
    const semanticRoute = await makeSemanticRoute(dir);
    return scanInbox({
      repoRoot: dir,
      cfg,
      listIssues: async () => (await loadIssues(dir)).issues,
      dispatchIssueFn: (issue) => {
        const targetDir = resolveIssueDir(dir, issue);
        const role2 = role;
        return dispatchIssue({
          dir: targetDir, issue, role: role2, prompt: buildIssuePrompt(issue), parent, executor: executorFor(parent),
          worktrees: ctx.get?.('worktrees'), workingDirectory: ctx.get?.('workingDirectory'), route: routeForRole(role2), runCommand,
          promptPrefix: rulesForRole(targetDir, role2) + pozhangAgentPrefix(), promptAnchor: pozhangAnchor(role2), semanticRoute,
          memoryFor: makeMemoryFor(targetDir, parent),
        });
      },
      onDispatched: (issue, outcome) => { trackStudioChild(outcome?.childId, resolveIssueDir(dir, issue), issue.id, sessionIdOf(parent)); },
    });
  }

  /**
   * 进入「工作室语境」的幂等入口：自动建 .code-studio 骨架（index.json + memory/ + sessions/<sid>/ + .gitignore），
   * 把发现的 git 仓库登进索引，并 upsert 当前会话绑定。
   * 触发点：打开面板 / 派单(submit,dispatch) / 写规则 / 开监听 / 绑 GitHub。纯读账不调它。
   * config.autoCreate=false 时整个函数不做事（退回「只在绑 GitHub 时建」）。
   */
  async function ensureStudio(wsRoot, agent, patch = {}) {
    if (!config.autoCreate) return;
    if (!wsRoot) return;
    try {
      await ensureWorkspaceDir(wsRoot);
      const sid = sessionIdOf(agent) || 'unknown';
      const repos = await enrichRemotes(listRepos(wsRoot), runCommand).catch(() => []);
      for (const r of repos) {
        const slug = r.remotes?.origin || r.remotes?.upstream || r.name;
        await upsertRepo(wsRoot, slug, { dir: r.dir, kind: 'local', remotes: r.remotes?.raw ?? {} }).catch(() => {});
      }
      await upsertSession(wsRoot, sid, { stateDir: join(wsRoot, '.codewrite'), repos: repos.map((r) => r.name), ...patch });
    } catch { /* 索引层失败不影响主流程 */ }
  }

  /**
   * 把一个「会话 ↔ GitHub 源」绑定记进工作区级 .code-studio 索引。
   * wsRoot = 会话 cwd（工作区根）；多仓库工作区的仓库发现由 studio-repo 负责。
   */
  async function recordSessionBinding(wsRoot, agent, gh) {
    try {
      if (gh?.repo && config.autoCreate) {
        await ensureWorkspaceDir(wsRoot);
        await upsertRepo(wsRoot, gh.repo, { dir: wsRoot, kind: 'local', remotes: { origin: gh.repo } });
      }
      await ensureStudio(wsRoot, agent, { boundRepo: gh?.enabled ? (gh.repo ?? '') : '' });
    } catch { /* 索引层失败不影响监听本身 */ }
  }

  async function runGithubSync(dir, parent, gh) {
    const subagents = ctx.get?.('subagents');
    if (typeof subagents?.startActivation !== 'function') return null;
    await ensureStudio(dir, parent, { boundRepo: gh?.repo ?? '' });
    const key = canonicalWorkspace(dir) + '::' + (sessionIdOf(parent) || 'nosid');
    const role = 'implementer';
    const semanticRoute = await makeSemanticRoute(dir);
    const token = await loadSessionToken(dir, parent).catch(() => '');
    return syncGithub({
      repoRoot: dir,
      cfg: gh,
      token,
      etag: GH_ETAG.get(key),
      listIssues: async () => (await loadIssues(dir)).issues,
      dispatchIssueFn: (issue) => {
        const targetDir = resolveIssueDir(dir, issue);
        return dispatchIssue({
          dir: targetDir, issue, role, prompt: buildIssuePrompt(issue), parent, executor: executorFor(parent),
          worktrees: ctx.get?.('worktrees'), workingDirectory: ctx.get?.('workingDirectory'), route: routeForRole(role), runCommand,
          promptPrefix: rulesForRole(targetDir, role) + pozhangAgentPrefix(), promptAnchor: pozhangAnchor(role), semanticRoute,
          memoryFor: makeMemoryFor(targetDir, parent),
        });
      },
      onDispatched: (issue, outcome) => { trackStudioChild(outcome?.childId, resolveIssueDir(dir, issue), issue.id, sessionIdOf(parent)); },
    }).then((res) => {
      if (res?.etag) GH_ETAG.set(key, res.etag);
      return res;
    });
  }

  /** 依配置重装轮询表。只要「本地收件」或「GitHub」任一开着就转；都不开或拿不到父 → 停机。
   * GitHub 源按会话隔离，所以轮询器 key 是 dir::sid，每个会话各转各的。 */
  async function ensureWatcher(dir, parent, _cfg) {
    const key = canonicalWorkspace(dir) + '::' + (sessionIdOf(parent) || 'nosid');
    const existing = WATCHERS.get(key);
    if (existing?.timer !== undefined) clearInterval(existing.timer);
    const watch = await loadWatch(dir);
    const gh = await loadSessionGithub(dir, parent);
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
        const liveGh = await loadSessionGithub(dir, entry.parent);
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
      description: '工作室监听：on 全开 / off 全关 / init 建 .code-studio 骨架 / scan 立即扫（本地收件+GitHub）/ interval <ms> 本地间隔 / '
        + 'github <owner/repo> 绑 GitHub 源（仅本会话）/ github off / token <token>（仅本会话）/ pr <issueId> 用 gh 建 PR / cancel <issueId> 中止正在跑的子会话 / '
        + 'inherit <newSid> [fromSid] 让新会话继承旧会话记忆与绑定（不复制文件）/ 无参看状态。',
      input: { hint: 'on | off | init | scan | interval <ms> | github <owner/repo> | github off | token <t> | pr <issueId> | cancel <issueId> | inherit <newSid> [fromSid]' },
      recordInput: false,
      handler: async ({ agent, rawInput }) => {
        const dir = sessionCwd({ agent });
        if (!dir) return { kind: 'error', text: '拿不到当前工作区目录。' };
        const args = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean);
        const sub = (args[0] ?? '').toLowerCase();
        if (sub === 'on') {
          const cfg = await saveWatch(dir, { enabled: true });
          await ensureStudio(dir, agent);
          await ensureWatcher(dir, agent);
          return { kind: 'success', text: `本地监听已开：每 ${Math.round(cfg.intervalMs / 1000)}s 扫 ${inboxDir(dir, cfg)}。` };
        }
        if (sub === 'init') {
          // 打开工作室页时调：只建 .code-studio 骨架 + 登记会话，不改变监听状态。
          if (!config.autoCreate) return { kind: 'success', text: '自动建 .code-studio 已关闭（autoCreate=false）。' };
          await ensureStudio(dir, agent);
          return { kind: 'success', text: `.code-studio 已就绪（${join(dir, '.code-studio')}）。` };
        }
        if (sub === 'off') {
          await saveWatch(dir, { enabled: false });
          await saveSessionGithub(dir, agent, { enabled: false });
          await recordSessionBinding(dir, agent, { enabled: false });
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
            await saveSessionGithub(dir, agent, { enabled: false });
            await recordSessionBinding(dir, agent, { enabled: false });
            await ensureWatcher(dir, agent);
            return { kind: 'success', text: 'GitHub 源已关。' };
          }
          const slug = parseRepoSlug(args[1] ?? '');
          if (!slug) return { kind: 'error', text: '用法：/code-studio-watch github owner/repo（或完整 GitHub URL）。' };
          const cfg = await saveSessionGithub(dir, agent, { repo: slug.slug, enabled: true });
          await recordSessionBinding(dir, agent, cfg);
          await ensureWatcher(dir, agent);
          return { kind: 'success', text: `GitHub 源已开（仅本会话）：${cfg.repo}，每 ${Math.round(cfg.intervalMs / 1000)}s 拉 open issues${cfg.hasToken ? '' : '（未存 PAT，私有仓库或高额度请 /code-studio-watch token <pat>）'}。` };
        }
        if (sub === 'token') {
          const raw = String(args.slice(1).join(' ') ?? '').trim();
          if (raw.toLowerCase() === 'off' || raw.toLowerCase() === 'clear') {
            const sdir = await sessionStudioDir(dir, agent);
            const cfg = await saveGithubTo(sdir, { token: '' });
            return { kind: 'success', text: `已清除本会话 GitHub PAT（${cfg.repo || '尚未绑定仓库'}）。` };
          }
          if (!raw) return { kind: 'error', text: '用法：/code-studio-watch token <pat>，或 token off 清除。' };
          const sdir = await sessionStudioDir(dir, agent);
          const cfg = await saveGithubTo(sdir, { token: raw });
          return { kind: 'success', text: `已存本会话 GitHub PAT（${cfg.repo || '尚未绑定仓库'}）。它单独存 .code-studio/sessions/<sid>/github-token，不进版本库。` };
        }
        if (sub === 'cancel' || sub === 'stop') {
          const id = String(args[1] ?? '').trim();
          if (!id) return { kind: 'error', text: '用法：/code-studio-watch cancel <issueId>（中止该 issue 正在跑的子会话）。' };
          // 找到这条 issue 挂的持久子会话 childId（从 issues.json 读，比 STUDIO_CHILDREN 更稳）
          const cur = await getIssue(dir, id);
          const childId = cur?.childId;
          if (!childId) return { kind: 'error', text: `issue #${id} 没有关联的子会话（可能还没派单或已结算）。` };
          let interrupted = false;
          try {
            const ex = executorFor(agent);
            if (typeof ex?.stop === 'function') {
              ex.stop(childId);
              interrupted = true;
            }
          } catch { /* 中断失败也把台账标 FAILED，别让状态卡在 RUNNING */ }
          // 从 FIFO 队列里摘掉这条，避免真正结束时再重复结算
          const q = STUDIO_CHILDREN.get(childId);
          if (q) {
            const idx = q.issueIds.indexOf(String(id));
            if (idx >= 0) q.issueIds.splice(idx, 1);
            if (q.issueIds.length === 0) STUDIO_CHILDREN.delete(childId);
          }
          await settleIssue(dir, id, { ok: false, error: '人工中止' });
          return { kind: 'success', text: `已中止 issue #${id}${interrupted ? '' : '（子会话中断服务不可用，已标 FAILED）'}。` };
        }
        if (sub === 'pr') {
          const id = String(args[1] ?? '').trim();
          if (!id) return { kind: 'error', text: '用法：/code-studio-watch pr <issueId>（用本机 gh 建 PR，需先 gh auth login）。' };
          const { issues } = await loadIssues(dir);
          const issue = (Array.isArray(issues) ? issues : []).find((it) => String(it.id) === id) ?? { id };
          let regions = {};
          try { regions = (await loadRegions(dir)).regions ?? {}; } catch { /* 忽略 */ }
          const prDir = resolvePrDir({ dir, issue, regions });
          const res = await createPr({ dir: prDir, issue: { id, title: issue.title, body: issue.body, prRepo: issue.prRepo, prHeadOwner: issue.prHeadOwner } });
          if (!res.ok) {
            const hint = res.code === 'GH_NOT_AUTHED' ? ' 先在终端跑 `gh auth login`（选 github.com，勾 git 凭据），再重试。' : '';
            return { kind: 'error', text: `建 PR 被拒（${res.code}）：${res.reason ?? ''}${hint}` };
          }
          // 回写台账，Tab 才看得到 PR 链接
          await upsertIssue(dir, { id, prUrl: res.url, prBranch: res.branch });
          // GitHub 双向同步:来源是 GitHub 的 issue 建完 PR 后回写评论（带 PR 链接）,不自动关单（等 PR 合并）。
          try {
            const ghCur = await getIssue(dir, id);
            if (ghCur?.source === 'github' || ghCur?.githubNumber) {
              const ghCfg = await loadSessionGithub(dir, agent);
              const ghTok = await loadSessionToken(dir, agent);
              if (ghCfg?.repo) await writeBackIssue({ repoRoot: dir, cfg: ghCfg, issue: ghCur, close: false, token: ghTok });
            }
          } catch { /* 回写 GitHub 失败不影响 PR 结果 */ }
          // PR 建完，若该 region 已无在飞 issue → 拆掉 worktree（树的任务完成了）。
          try {
            const { issues: allIssues } = await loadIssues(dir);
            const cur2 = await getIssue(dir, id);
            if (cur2?.worktree && cur2?.region && regionSettled(allIssues, cur2.region)) {
              await cleanupWorkspace({ issue: cur2, dir, runCommand });
            }
          } catch { /* 清理失败不影响 PR 结果 */ }
          return { kind: 'success', text: `已建 PR：${res.url}（分支 ${res.branch}）。` };
        }
        if (sub === 'scan') {
          const cfg = normalizeWatch((await loadWatch(dir)) ?? {});
          const results = await runScan(dir, agent, cfg);
          const gh = await loadSessionGithub(dir, agent);
          let ghText = '';
          if (gh?.enabled) {
            const res = await runGithubSync(dir, agent, gh);
            ghText = res?.ok ? `\nGitHub：${formatGithubResults(res)}` : `\nGitHub：失败（${res?.code}）${res?.reason ?? ''}`;
          }
          return { kind: 'success', text: summarizeScan(results) + ghText };
        }
        if (sub === 'inherit') {
          // 快速换会话：把当前会话的记忆/绑定「定向」给目标新会话，不复制文件。
          // 用法：inherit <newSid>  或  inherit <fromSid> <newSid>
          const hasSid = String(sessionIdOf(agent) ?? '').trim() !== '';
          const a1 = String(args[1] ?? '').trim();
          const a2 = String(args[2] ?? '').trim();
          const fromSid = a2 ? a1 : sessionIdOf(agent);
          const newSid = a2 ? a2 : a1;
          if (!newSid) return { kind: 'error', text: '用法：/code-studio-watch inherit <newSid>（从当前会话继承）或 inherit <fromSid> <newSid>。' };
          if (!fromSid || !hasSid && !a2) return { kind: 'error', text: '拿不到当前会话 id，请用 inherit <fromSid> <newSid> 显式指定。' };
          await ensureWorkspaceDir(dir);
          const res = await linkInherit(dir, newSid, fromSid, { stateDir: join(dir, '.codewrite') });
          if (!res?.ok) return { kind: 'error', text: `继承失败：${res?.error ?? '未知原因'}` };
          // 接管在跑的子 Agent：把「结算归属会话」从旧会话改挂到新会话。
          // 台账（issues.json）本来就是按仓库共享的，但 STUDIO_CHILDREN 的 entry.sessionId 决定
          // 结算时的记忆写回落到哪个会话目录；旧会话已转只读，不重挂的话这些在跑任务的记忆会被丢弃。
          let adopted = 0;
          try {
            for (const [, entry] of STUDIO_CHILDREN) {
              if (entry && entry.sessionId && String(entry.sessionId) === String(fromSid)) {
                entry.sessionId = newSid; adopted += 1;
              }
            }
          } catch { /* 重挂失败不影响继承关系本身 */ }
          const adoptText = adopted > 0
            ? ` 已接管 ${adopted} 个子会话（在跑的任务结算后会写进新会话记忆）。`
            : '';
          return { kind: 'success', text: `已让会话 ${newSid} 继承 ${fromSid} 的记忆与工作室绑定（不复制文件，指向同一份）。旧会话 ${fromSid} 转只读，新会话 ${newSid} 可读写。${adoptText}` };
        }
        if (sub === 'unlink') {
          // 取消继承：删掉本会话的 inheritFrom 指针，并把源会话恢复为可写。
          const self = String(sessionIdOf(agent) ?? '').trim();
          const target = String(args[1] ?? '').trim() || self;
          if (!target) return { kind: 'error', text: '用法：/code-studio-watch unlink [sid]（默认本会话）。' };
          const res = await unlinkInherit(dir, target);
          if (!res?.ok) return { kind: 'error', text: `取消继承失败：${res?.error ?? '未知原因'}` };
          return { kind: 'success', text: `已取消会话 ${target} 的继承关系，源会话恢复可写。` };
        }
        const cfg = await loadWatch(dir);
        const gh = await loadSessionGithub(dir, agent);
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

  return {
    buildIssuePrompt,
    rulesForRole,
    resolveIssueDir,
    listRepos,
    runScan,
    ensureStudio,
    recordSessionBinding,
    sessionStudioDir,
    loadSessionGithub,
    saveSessionGithub,
    loadSessionToken,
    runGithubSync,
    ensureWatcher,
    summarizeScan,
    formatGithubResults,
  };
}
