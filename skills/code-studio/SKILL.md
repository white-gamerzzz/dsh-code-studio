---
name: code-studio
description: 多子 Agent 团队与多项目并行开工的协调工具（code-studio 插件操作手册）。凡是要改代码/改仓库、活儿够大值得开副本隔离、要并行多单、或要把改动合并回主目录时使用。单文件小改不要用本流程。
---

# code-studio：子 Agent 团队协调手册

插件不派子 Agent——**你派**，来源不限（DSH subagent / subagent_fork / 外部 Bot / CLI 执行器都行）。插件只管四件事：备单（开 git worktree 副本 + 台账）、结算回写、合并闸门、GitHub/收件箱同步。

## 何时用 / 何时不用

**用**：多文件改动、要定契约的重构、多单并行、需要隔离现场防把主目录改脏、改动要审校后落地。
**不用**：单文件小改直接编辑交付；只读问答；改插件自管目录（`.code-studio/`、`.codewrite/`）本身。

## 标准工作流

1. **备单**：`code_studio` 工具 `{action:"submit", id, title, body, folders?}`。
   - 它会：git 闸检查（非 git 目录直接拒 `NOT_GIT_REPO`，先让用户 `git init`，别绕过）→ 开副本 `.code-studio/worktrees/issue-<id>` → 台账落 `READY`。
   - `folders` 可省略，从 body 里的路径自动抽；返回值里有副本路径与任务单。**不要手工改 `.code-studio/*.json`，不要自己拼台账。**
2. **开工**：自己起一个子会话，`cwd` 必须是返回的副本路径，把任务单投给它。任务单六要素：objective、source_paths、write_paths、contracts、constraints、acceptance（机器门命令 + 人工判据）。缺 objective / source_paths / acceptance 不许派出。
3. **登记**：开工后 `code_studio` `{action:"set", id:"<编号>", childId:"<子会话id>"}`。登记后子会话结算报告自动回写台账、落 `REVIEW`。跨会话恢复时插件靠这张登记表对号。
4. **验收**：子会话写完先跑 `code_check`（fmt/lint/typecheck/test，按仓库实际给命令），全绿才算完。
5. **合并**：`code_merge`（不给 id 先看待合并区，按**单号升序**合——先合小号，后面的以最新 base 分叉）。合并前插件查漂移：主目录有未提交改动会拒（`USER_DRIFT`，先确认那些手改怎么办），副本有未提交改动会先提交。
6. **冲突**：`MERGE_CONFLICT` 时不落地、副本留作现场，插件列冲突文件。派会话去**副本里**解掉，然后 `code_merge id=<编号> rebased=true` 重试。别在副本外「顺手修一下」——那会让合并结果与主目录分叉。

## 多单并发

- 不同 issue 默认并行分叉，各开各的副本，不预判冲突；撞车留给合并时暴露（照 GitHub 的做法）。
- 同一片文件夹必须串行时，给 region 开 `queue:true`（`code_studio` `{action:"set", region:"<名>", queue:true}`）。
- 派单前先 `code_state` 看台账：REVIEW 的等合并、RUNNING 的别再派、FAILED 的看报告归因。

## 失败归因纪律

子会话报「工具缺陷 / 平台限制 / 绕不过去」时不要原样转述——先三问自查：原始错误码是什么？做过能推翻猜测的对照检查吗？插件有没有现成通道没用？答不上来退回补证据。绝不接受「新建 v2 文件绕开一次本可修复的失败」，绝不甩给用户手工改仓库文件。

## 硬边界

- 主会话（你）不直接 write/edit/pwsh 到仓库代码路径——改动手艺活全在副本里的子会话干。
- 副本目录 `.code-studio/worktrees/issue-<id>` 合并成功才自动清；合并失败留着当现场，不要手动删。
- 中止一单用 `code_studio` `{action:"cancel", id}`（落 FAILED），不要假装它没存在过。
