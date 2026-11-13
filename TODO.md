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
