// lib/tools.js — 14 个 DSH 工具的构建与注册（code_task/dispatch/merge/studio/op/memory + qa 组）。
// 自 index.js 原样搬出（重构第③步）。分层纪律：只读注入的 env，不直接注册到 ctx（注册由 index 做）；
// 宿主服务与 index 内部助手（executorFor/orchestratorFor/workDir/watcher 全家）一律经 createTools(env) 注入。
import { markChild, unmarkChild } from './session-roles.js';
import { textResult, reportOutput, notManagedLine } from './toolkit.js';
import { pozhangAgentPrefix, pozhangAnchor } from './pozhang-command.js';
import { buildPacket } from './packet.js';
import { runChecks, runCommand } from './runner.js';
import { renderMap } from './map.js';
import { renderReview } from './review.js';
import { loadIssues, loadRegions, upsertIssue, upsertRegion, planRegion, getIssue } from './studio-store.js';
import { dispatchIssue, prepareIssue, settleIssue, cleanupWorkspace, mergeWorkspace, regionSettled, pendingMerges } from './studio-dispatch.js';
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
    makeSemanticRoute,
    STUDIO_CHILDREN,
    cancelIssue,
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
      description: '账本视图：列出该仓库的 issue 按状态分组（REVIEW/RUNNING/READY/FAILED/DONE），用来判断下一步该派谁、该合谁。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { work: { type: 'string', description: '仓库名或目录；省略时用会话工作区' } },
        required: [],
      },
      output: reportOutput((_args, value) => textResult(value.report)),
      execute: (args, exec) => (async () => {
        const dir = workDir(args.work, exec);
        const { issues } = await loadIssues(dir);
        const { regions } = await loadRegions(dir);
        const list = Array.isArray(issues) ? issues : [];
        if (!list.length) return { report: `仓库 ${dir} 尚无 issue。` };
        const byStatus = {};
        for (const t of list) (byStatus[String(t.status ?? 'READY').toUpperCase()] ??= []).push(t);
        const lines = [`## Issue 台账 · ${basename(dir)}`, '', `共 ${list.length} 单`, ''];
        for (const status of ['REVIEW', 'RUNNING', 'READY', 'FAILED', 'DONE']) {
          const group = byStatus[status];
          if (!group?.length) continue;
          lines.push(`### ${status}（${group.length}）`);
          for (const t of group.sort((a, b) => (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0))) {
            const wt = t.worktree ? `｜副本 ${t.worktree}` : '';
            const ch = t.childId ? `｜会话 ${t.childId}` : '';
            const q = regions?.[t.region]?.queue === true ? '｜串行' : '';
            lines.push(`- #${t.id} ${t.title ?? ''}｜region:${t.region ?? '?'}${ch}${wt}${q}`);
          }
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
        + '副本是 git worktree（`git merge --no-ff issue-<id>`），非 git 目录派单时会被硬闸拒掉。'
        + '合并前先查漂移：主工作树有未提交改动就拒（除非 allowDrift）。冲突一律不落地、派回副本拥有者去解，副本留作现场。'
        + 'action：pending 看待合并区（不给 id 时的默认）/ status 只看能不能合（不写文件）/ merge 真合。',
      parameters: (() => {
        // 与 code_op 同一张操作表：action 枚举与字段都从 lib/ops.js 生成。
        const schema = unionSchema(['pending', 'status', 'merge'], { required: false });
        schema.properties.action.description = '默认：有 id 时 merge，无 id 时 pending';
        return schema;
      })(),
      output: reportOutput((_args, value) => textResult(value.report)),
      execute: (args, exec) => (async () => {
        const dir = workDir(args.work, exec);
        const id = String(args?.id ?? '').trim();
        const action = args?.action ?? (id ? 'merge' : 'pending');

        // 待合并区（GitHub 的 open PR 列表）：写完没合的都在这，按单号升序给出合并建议。
        if (action === 'pending' || !id) {
          const pending = await pendingMerges(dir);
          if (!pending.length) return { report: `待合并区是空的（${dir}）：没有已写完但还没合回主干的 issue。` };
          const sorted = [...pending].sort((a, b) => (parseInt(String(a.id).replace(/^#/, ''), 10) || 0) - (parseInt(String(b.id).replace(/^#/, ''), 10) || 0));
          const lines = ['## 待合并区', ''];
          for (const item of sorted) {
            const files = Array.isArray(item.changedFiles) && item.changedFiles.length
              ? `，改动 ${item.changedFiles.length} 个文件` : '';
            lines.push(`- #${String(item.id).replace(/^#/, '')} ${item.title ?? ''}${item.region ? ` → region:${item.region}` : ''}${files}`);
          }
          lines.push('', '建议按单号升序合并（先合小号，后面的单以最新 base 分叉）；多单改了同一批文件时后合的可能撞车。用 code_merge id=<编号> 逐条合。');
          return { report: lines.join('\n') };
        }

        const issue = await getIssue(dir, id);
        if (!issue) return { ok: false, report: `找不到 issue ${id}（${dir}）。` };
        const label = `issue ${id}`;

        if (action === 'status') {
          const dirty = await runCommand('git status --porcelain', { cwd: dir, timeoutMs: 30000 });
          const dirtyLines = String(dirty?.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean).filter(notManagedLine);
          const driftLines = dirtyLines;
          const lines = [`## ${label} 合并前检查`, ''];
          lines.push(`- 副本：${issue.worktree ?? '（无）'}`);
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
        // 冲突不替你解（GitHub 的做法）：把冲突文件列出来，主 Agent 派人（任何来源的子会话）
        // 去副本里解掉，再用 rebased=true 重试合并。这里不动主目录、不删副本。
        if (res.code === 'MERGE_CONFLICT') {
          const files = (Array.isArray(res.conflicts) ? res.conflicts : []).filter((l) => /^(CONFLICT|Auto-merging)/.test(l));
          return {
            ok: false,
            report: [
              `${label}：合并冲突，未落地。副本留作现场：${issue.worktree}`,
              files.length ? `冲突文件：\n${files.map((f) => `- ${f}`).join('\n')}` : '',
              `派一个子会话（来源不限）到副本里解完冲突后，用 code_merge id=${id} rebased=true 重试。`,
            ].filter(Boolean).join('\n'),
          };
        }
        return { ok: false, report: `${label}：合并未完成（${res.code ?? 'UNKNOWN'}）——${res.reason ?? ''}${extra}` };
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
        // set：直接写一条 issue 的字段；登记 childId 时顺带接上结算（主 Agent 起的子会话
        // 只有登了记，它的结束事件才会回写这条 issue 的台账）。
        if (action === 'set') {
          const id = String(args.id ?? '').trim();
          if (!id) return { report: 'set 需要 id。' };
          const patch = { id };
          for (const key of ['title', 'repo', 'body', 'status', 'report', 'region', 'childId', 'prUrl', 'prBranch']) {
            if (args[key] !== undefined) patch[key] = args[key];
          }
          if (args.folders !== undefined) patch.folders = args.folders;
          const saved = await upsertIssue(dir, patch);
          if (patch.childId) {
            trackStudioChild(String(patch.childId), dir, id, sessionIdOf(exec?.agent));
            await upsertRegion(dir, saved?.region ?? String(args.region ?? ''), { issues: [id], childId: patch.childId }).catch(() => {});
          }
          return { report: `已更新 issue #${id}：status=${saved.status ?? 'READY'}${patch.childId ? `，子会话 ${patch.childId} 已登记（结算报告会回写台账）` : ''}。` };
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
            return { ok: false, report: `建 PR 失败：${error instanceof Error ? error.message : String(error)}` };
          }
          if (!res.ok) {
            const hint = res.code === 'GH_NOT_AUTHED'
              ? '\n先在终端跑 `gh auth login`（选 github.com，勾 git 凭据），再回来重试。'
              : '';
            return { ok: false, report: `建 PR 被拒（${res.code}）：${res.reason ?? ''}${hint}` };
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
        // submit：备单（不派子会话）。插件只协调，不携带子 Agent ——
        // 主 Agent 自己起子会话（DSH / 外部 Bot / CLI 都行），开工前用 set childId 登记。
        // dispatch：watch 路径专用（收件箱/GitHub 轮询 = 预授权自动化，才允许插件自己 start）。
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
          const parent = exec?.agent;
          if (!parent) return { report: `${action} 失败：拿不到调用方 Agent（exec.agent 未定义）。` };
          const targetDir = resolveIssueDir(dir, issue);
          const semanticRoute = await makeSemanticRoute(targetDir);

          if (action === 'submit') {
            let result;
            try {
              result = await prepareIssue({
                dir: targetDir, issue, semanticRoute, runCommand, proposeGitInit: true,
              });
            } catch (error) {
              return { report: `submit 失败：${error instanceof Error ? error.message : String(error)}` };
            }
            if (!result.ok) {
              if (result.code === 'GIT_INIT_PROPOSE') return { report: result.reason };
              return { report: `submit 被拒（${result.code}）：${result.reason}` };
            }
            const prompt = String(args.prompt ?? '').trim() || buildIssuePrompt(issue);
            return {
              report: [
                `issue #${id} 备单完成 → region「${result.region}」，副本 ${result.worktree}，台账 READY。`,
                '插件不派子 Agent：自己起一个子会话（cwd 用上面的副本路径），把下面的任务单投给它：',
                '---',
                prompt,
                '---',
                `开工后把子会话 id 登记进来（code_studio set id=${id} childId=<子会话id>），结算报告才能回写台账。`,
              ].join('\n'),
            };
          }

          // dispatch（watch 路径）
          const role = String(args.role ?? '').trim() || 'worker';
          const prompt = String(args.prompt ?? '').trim() || buildIssuePrompt(issue);
          const executor = executorFor(parent);
          if (!executor) {
            return { report: `${action} 失败：没有可用执行器（DSH 需要 subagents.startActivation；换成 CLI 执行器也能派单）。` };
          }
          let result;
          try {
            result = await dispatchIssue({
              dir: targetDir, issue, role, prompt, parent, executor,
              runCommand,
              promptPrefix: rulesForRole(targetDir, role) + pozhangAgentPrefix(), promptAnchor: pozhangAnchor(role),
              semanticRoute,
              memoryFor: makeMemoryFor(targetDir, parent),
            });
          } catch (error) {
            return { report: `${action} 失败：${error instanceof Error ? error.message : String(error)}` };
          }
          if (!result.ok) {
            return { report: `${action} 被拒（${result.code}）：${result.reason}` };
          }
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

  /** 把工具实现当 op 实现用：工具 execute 返回 { report }，这里统一成 { ok, text }。
      工具实现可以在 report 同时带 ok:false（失败分支），网页按钮据此显示失败态。 */
  const viaTool = (tool, action) => async (args, context) => {
    const out = await tool.execute(
      { ...args, ...(action ? { action } : {}) },
      context.exec ?? { agent: context.agent },
    );
    return { ok: out?.ok !== false, text: String(out?.report ?? '') };
  };

  const opRegistry = createOpRegistry();
  opRegistry
    .register('dispatch', viaTool(studioTool, 'dispatch'))
    .register('pending', viaTool(mergeTool, 'pending'))
    .register('merge', viaTool(mergeTool, 'merge'))
    .register('mergeStatus', viaTool(mergeTool, 'status'))
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
    buildBriefTool(), buildCheckTool(), buildStateTool(),
    buildKbTool(), buildMapTool(), buildReviewTool(), studioTool, mergeTool,
    buildMemoryTool(), buildOpTool(),
  ];

  return {
    tools,
    studioTool,
    mergeTool,
    opRegistry,
    buildBriefTool,
    buildCheckTool,
    buildStateTool,
    buildMergeTool,
    buildKbTool,
    buildMapTool,
    buildReviewTool,
    buildStudioTool,
    buildMemoryTool,
    buildOpTool,
  };
}
