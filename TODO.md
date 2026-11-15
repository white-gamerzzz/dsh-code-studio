# 未做清单（启动工程前先拍板）

> 全部结论按代码实测核对（2026-11-13），带 `文件:行号` 锚点。按「会不会真出事」排序。
> ✅ 1-9 已修；10 定为「够用不做」；11-13 属运营/工程化。

## 🔴 会真出事（干活链路断）—— ✅ 已修

### 1. ✅ 「中止」按钮点了没用 —— cancel 子命令不存在
- 客户端发命令：`lib/client.js` → `/code-studio-watch cancel <id>`
- 修法：handler 加 `sub === 'cancel' || 'stop'` 分支，`subagents.interrupt(childId,{kind:'ancestor',agent})` + FIFO 队列摘除 + `settleIssue(dir,id,{ok:false,error:'人工中止'})`
- 探针：`_probe/cancel-check.mjs`（无 id 报用法 / 正常中止指向对 childId / 标 FAILED / 无 childId 报错）

### 2. ✅ 建 PR 在仓库根跑，不在 worktree 跑
- 新增 `resolvePrDir({dir,issue,regions})`（`studio-pr.js`）：issue.worktree → region.worktree → 仓库根
- 命令入口与工具入口 createPr 都用它算 prDir；探针覆盖

### 3. ✅ changedFiles 运行时永远为空
- 结算时在 issue 的 worktree（退回仓库根）跑 `git status --porcelain`，`parsePorcelain()` 解析后传给 `settleIssue`
- `parsePorcelain` demo 覆盖

### 4. ✅ PR 建好后不回写台账
- 两处 createPr 成功后 `upsertIssue(dir,{id,prUrl,prBranch})`
- 客户端报告区渲染 PR 链接（`.dsh-code-sp-pr`）


## 🟡 体验/正确性打折 —— ✅ 已修（5-9）

### 5. ✅ region 级记忆「只写不读」
- 修法：`memorySectionText(repoRoot,{includeRegions:true})`；按 **mtime 取最近 `regionLimit`(默认3) 个** region 记忆注入，不全量。`lib/index.js:1537` 调用改传 `{includeRegions:true}`。`ponytail:` 注释写明「按 mtime 取最近 N 个够用；要精确按会话 region 定向需改子会话 cwd」。
- demo 断言：写 4 个 region 记忆，`regionLimit:1` 只注入 1 个。

### 6. ✅ worktree 从不清理
- 修法：`studio-dispatch.js` 新增 `removeWorktree({worktree,branch,repoRoot,runCommand})`（`git worktree remove --force` + `git branch -D`，失败不抛）与 `regionSettled(issues,region)`（该 region 无 RUNNING → true）。
- 触发点：结算为 failure 且 region 已 settled 时拆树；PR 建成后若 region 已 settled 拆树。DONE 但还没建 PR 的不拆（PR 还要用这棵树）。
- demo 断言：removeWorktree 成功跑两条命令、失败返回 `{ok:false}` 不抛；regionSettled 三态。

### 7. ✅ code_eval 仍是纯装饰
- 修法：`buildDispatchTool` 在派单前调 `assessDispatch(...,{mode:args.eval_mode})`（默认 observe）。`auto` 且 verdict=reject → 直接拒绝派单不派子会话；observe 且有缺/警告 → 报告尾部附评估区块。`code_dispatch` schema 加 `eval_mode/objective/source_paths/acceptance/stage` 参数。
- 探针：`_probe/eval-gate-check.mjs`（auto 缺字段拒且不启动 / auto 齐全放过 / observe 缺字段照派但带评估块）。

### 8. ✅ `code_dispatch` 的 role enum 含 tech-lead
- 修法：`lib/index.js:796` `enum: ROLE_IDS.filter(r => r !== 'tech-lead')`，description 注明不含 tech-lead。roles 工具（只读列出）保留 13 个。

### 9. ✅ 同 region 复用时不校验 worktree 是否还在
- 修法：`studio-dispatch.js` reuse 分支 `sendMessage` 前 `existsSync(worktree)`，不在则置 null 并 `upsertRegion` 清掉 worktree（退回仓库根）。

### 10. ⏸️ 监听是轮询，不是秒级（决定：够用不做）
- 本地默认 60s（`studio-watch.js DEFAULT_INTERVAL_MS=60000`）、GitHub 120s；`fs.watch` 有意跳过（`ponytail:` 注释留升级位）。
- 要秒级再上 `ctx.get('fs').watch`。

## 🟡 路由机制（用户 m04601「路由机制够完善吗」→ m04629「都改」）—— ✅ 已修

### 14. ✅ matchRegion 只认精确文件夹，子目录会碎成新 region
- `studio-store.js` 的 `matchRegion` 加方向覆盖 `covers(r,f)`：`['src/auth']` 的 region 现在能命中 `['src/auth/sub']`、`['src/auth/x/y']`；父/子双向都认。

### 15. ✅ 抽不出 folders 就拒单
- `studio-intake.js` `normalizeIssue` 不再把 folders 空记入 `missing`，改返回 `unrouted:true`；`planRegion` 把无文件夹的 issue 统一兜进 `unrouted` 区（同区串行），不再拒单、也不各自乱开 region。

### 16. ✅ 无语义归类（口语化 issue 派不出去）
- 新增 `lib/studio-route.js`：`listCandidateDirs`（扫仓库目录）+ `classifyFolders`（一次 `ctx.llm.stream` 从目录清单里挑 1~3 个）+ `parsePickedFolders`。
- `dispatchIssue` 加 `semanticRoute` 钩子：仅当 folders 抽空时调用一次；判不出就 `[]` → 走 unrouted 兜底。`index.js` 三处派单入口都接 `makeSemanticRoute(dir)`（用已配角色 route，无 llm 则跳过）。

### 17. ⏸️ 第二层「子会话自报 / 重路由」仍未做（决定：先不做）
- 现在判错最多进 unrouted 兜底串行，不会丢单；真要子会话在代码里确认后回改 region，属后续增强。

## ⚪ 工程化/验证

### 11. 没在真 GUI 里点过
- 全程靠探针（`_probe/*.mjs`）+ headless Edge 预览图验证
- 未在真实 Host 会话里点过「开监听 / 扫收件 / 建 PR / 切模式 / 中止」全链路
- 建议：Host 手动刷新插件后，拿一个真仓库走一遍

### 12. live 工具 schema 是旧版
- Host 进程内存里 `code_studio` 可能还是旧 schema（无 `submit`/`pr`），需**手动按一次插件刷新**
- 这是运营动作，不是代码缺陷

### 13. 无正式测试框架
- 只有内建 demo + `_probe/*.mjs` 断言（ponytail 允许的最小检查），没有 vitest/jest
- 决定：够用就不加；要 CI 再上

## ✅ 已确认不是缺口的
- 「工作区绑模型」是记错的，原始需求是「工作区维护组」= 自动切 code-editor 预设，已做（`1fd68e1`）
- 手动建 issue 的表单——用户明确不要，改前台 `code_studio submit` 规范化接口，已做（`f06a16d`）
- 三个真 bug（建 worktree / folders 交集检查 / 记忆写回）已修（`f68d6de`）
- gh CLI 已登录有效（white-gamerzzz），建 PR 链路通

## ✅ 审查后 7 步整改（2026-11-15，全部完成）
> 审查发现「架构层 `.code-studio` 完全没落地、记忆不分会话会串、非 git 派单必挂、无仓库发现、PR 无 --repo、中文乱码」。
> 按 1→7 依次做，每步自检全绿后 push。

### C1 ✅ 非 git 目录派单（`319dbd5`）
- `studio-dispatch.js` 加 `isGitWorkTree(dir,runCommand)`；`dispatchIssue` 加 `runCommand`，非 git 时跳过 worktree、`cwd` 钉仓库目录就地改。

### C3 ✅ PR fork 场景（`d176c4f`）
- `createPr` 支持 `prRepo`/`prHeadOwner` → `gh pr create --repo <prRepo> --head <owner>:<branch>`；命令/工具/issue 字段全接上。

### A ✅ 索引层 `lib/studio-workspace.js`（`39794b5`）
- `.code-studio/index.json` + `sessions/<sid>/session.json` 读写；`upsertRepo/upsertSession/loadSession/removeSession/ensureWorkspaceDir`；GitHub 绑定/解绑时落会话绑定。

### B ✅ 记忆会话隔离（`2f0ac1d`）
- `studio-memory.js` 新增 `.code-studio/sessions/<sid>/{memory.md,agents/,regions/}` 四层读写与会话隔离注入；结算回写改会话级，不再写公共 `.codewrite/editor/MEMORY.md`（旧路径只读兼容）。

### A ✅ 规则层 `lib/studio-rules.js`（`9e65413`）
- `memory/rules.json`：`addRule/removeRule/listRules/ruleAppliesTo/rulesSectionText`；scope=all|角色表|session（session 转会话记忆）；超 50 条滚动 `rules.archive.json`；`code_studio action=rule`；派单 prompt 与前台 systemPrompt 都按角色注入。

### C2 ✅ 仓库发现 `lib/studio-repo.js`（`c249c57`）
- `discoverRepos`（扫 .git 子目录）/`parseRemotes`（解析 git remote -v，含 upstream）/`readRemotes`+`enrichRemotes`（异步补真实 remote）/`matchRepo`/`resolveIssueRepo`/`prDestination`（有 upstream 即判 fork、PR 提上游、head 用 origin owner）/`cloneRepo`。
- index.js：三处派单先 `resolveIssueDir`（按 issue.repo / folders 首段归属到子仓库）；PR 分支自动认 fork 目的地；`recordSessionBinding` 把发现的仓库登进索引；新增 `code_studio action=repos` 列出工作区 git 仓库。

### D ✅ 中文乱码 —— 复核为误报
- 逐字节核验：`lib/index.js`、`lib/client.js`、`README.md`、`TODO.md`、`ARCHITECTURE.md`、所有 lib/*.js 均 **U+FFFD=0、无 mojibake**。此前的「乱码」是 PowerShell `Get-Content` 把 UTF-8 当 GBK 显示的假象。
- 仅 `pozhang/assets/codex-skills-v4/.../burpsuite-mcp-guide.md`（第三方 vendored 附件）确有 GBK 双重编码，且为不可逆的部分损坏；它不属于插件源码、不影响运行，保留原样（要重下上游即可）。

## ✅ 自动创建 `.code-studio`
- 触发点（任一）：打开工作室面板（`/code-studio-watch init`）· `code_studio submit|dispatch` · `code_studio action=rule op=add` · `/code-studio-watch on` · 绑 GitHub 源。
- 纯读账（`issues`/`regions`/`repos`/`code_check`/`code_dispatch`）不建。
- 建在**工作区根（会话 cwd）**一处；`ensureStudio(wsRoot,agent,patch)` 幂等（`ensureWorkspaceDir` + `upsertRepo`×N + `upsertSession`），全程 try/catch 静默，建目录失败不影响主流程。
- 开关：`apply(ctx,{autoCreate:false})`（`cordis.patch.yml` 里 `config: {autoCreate:false}`）可关；面板打开时客户端每会话请求一次 `/code-studio-watch init`。

