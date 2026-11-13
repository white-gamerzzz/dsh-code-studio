# 未做清单（启动工程前先拍板）

> 全部结论按代码实测核对（2026-11-13），带 `文件:行号` 锚点。按「会不会真出事」排序。
> ✅ 1-4 已修（本轮）；5-13 未做。

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


## 🟡 体验/正确性打折

### 5. region 级记忆「只写不读」
- 写：结算时 `appendRegionMemory` 已落盘（`lib/studio-memory.js` `editor/regions/*.md`）
- 读：`memorySectionText(repoRoot)` 调用**没传 `includeRegions`**（`lib/index.js:1489`），而该开关默认关（`studio-memory.js:126`）
- 后果：region 记忆写了从来不注入系统提示；只有工作区级 `MEMORY.md` 真正生效
- 修法：决定是否默认注入（region 多会撑提示词）；建议改成「当前会话所在 region 才注入」——按 `session.header.cwd` 的 region 定向取，而非全量

### 6. worktree 从不清理
- 全仓 `worktrees.remove/delete/prune` **0 处**
- 后果：每建一个 region 就多一棵 worktree，做完/废弃了也一直在磁盘堆着
- 修法：issue 结算 DONE+PR 后，或 region 无在飞 issue 时，`worktrees.remove`；先确认契约名

### 7. code_eval 仍是纯装饰
- `assessDispatch` 只在 `buildEvalTool`（`lib/index.js:1123`）里被调；`code_dispatch` / `code_studio dispatch` 路径不调、不拦
- 后果：设了「缺字段不得派出」也没人执行
- 修法：要么在 dispatch 前调一次 `assessDispatch(...,{mode:'auto'})` 拦，要么删掉 code_eval 省得误以为有门

### 8. `code_dispatch` 的 role enum 含 tech-lead
- `lib/index.js:730` `enum: ROLE_IDS`（13 个含 tech-lead）
- code-guard 有运行时拦截（子 Agent 派 tech-lead 拒），但工具 schema 本身没排除，总监仍可直接派 tech-lead
- 修法：enum 改 `ROLE_IDS.filter(r => r !== 'tech-lead')`

### 9. 同 region 复用时不校验 worktree 是否还在
- reuse 分支直接沿用 `regions[region].worktree`（`studio-dispatch.js`），没 `existsSync` 检查
- 后果：worktree 被人删了/机器重启清空，子会话 cwd 指向不存在目录
- 修法：reuse 前 `existsSync(worktree)`，不在就重建或退回仓库根并报警

### 10. 监听是轮询，不是秒级
- 本地默认 60s（`studio-watch.js DEFAULT_INTERVAL_MS=60000`）、GitHub 120s
- `fs.watch` 有意跳过（`ponytail:` 注释留了升级位）
- 后果：issue 提上来最多延迟一分钟才派
- 决定：够用就不做；要秒级再上 `ctx.get('fs').watch`

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
