# dsh-plugin-code-studio · 代码总编工作室

参考 `dsh-plugin-novel`（小说总编工作室）与 SuperAgent 编排插件做的**代码生产**版本。
技术总监不写代码，只输出工作流 + 派单给 13 个角色子 Agent；每张单进 `code_task` 账、
有 `write_scope` 文件硬边界、过「机器门 `code_check` + 独立审校」两道门。

## 装

本插件是 profile 内的 bundle 层，靠 `cordis.patch.yml` 插入（与 novel 同构）：

```yaml
- insert:
    - id: code-studio
      name: 'dsh-plugin-code-studio'
    - id: code-studio-agent-models
      name: 'dsh-plugin-code-studio/agent-models'
```

角色 → 模型指派在设置页的 `code-studio-agent-models` 条目里配（`enabled` + `assignments[{role,provider,model,reasoningEffort}]`）。
未指派的角色继承技术总监的模型。

## 工具

| 工具 | 用途 |
|---|---|
| `code_roles` | 取某角色卡全文（派单前必读，随提示词一起给子 Agent） |
| `code_brief` | 组装实现任务上下文包（目标 + 相关文件摘录 + 契约 + 约束 + 验收） |
| `code_check` | 自动机器门：按给定命令逐条跑，全过才 PASS（技术总监唯一跑命令的窄通道） |
| `code_state` | 账本视图：任务按状态分组，看下一步该派谁 |
| `code_task` | 任务账：open/claim/renew/settle/release/cancel/pick/get/list/reclaim/events |
| `code_dispatch` | 按角色派单（自动套用设置的模型），立即返回子会话 id，不等；支持 variants 平行版本 |
| `code_eval` | 派单前评估门（对齐 SuperAgent Eval）：按任务单完整度裁决 proceed/clarify/reject |
| `code_review` | 静态审校扫描：待办标记 / console.log / debugger / any / 空 catch / 超长函数 / 硬编码密钥 |
| `code_map` | 依赖图：扫各包清单建内部依赖有向图、列外部依赖、找循环依赖 |
| `code_kb` | 代码范例库：按语义（bge-m3 向量，退词法）沉淀/检索「写对了的代码」范例 |
| `code_studio` | 工作区工作室台账：issue 归属 region、派给持久子会话、开关监听收件目录、建 PR（`assign`/`issues`/`regions`/`set`/`dispatch`/`watch`/`pr`） |

## 工作室：监听 → 派单 → 报告（多仓库）

按工作区（会话绑的那个文件夹）独立监听，配置落在 `<repo>/.codewrite/watch.json`，不用填路径：

1. 会话绑到某个仓库文件夹后，`code_studio`（或 `/code-studio-watch on`）开启监听。
2. 往 `<repo>/.codewrite/inbox/` 丢一个 `*.json`：`{ "id"?: "12", "title": "修登录", "body": "原文", "folders": ["src/auth"] }`
   —— 轮询器下一轮（默认 60s）把它变成 issue 并派单。
3. **持久子会话按 region 复用**：同一片文件夹的后续 issue 追回同一个子会话串行追加，换片才新建；
   在飞的 region 分组 ≤ 2，子会话不得再派 `tech-lead`。
4. 子会话结算时，报告回写 `issues.json`；**右侧栏「工作室」页**同屏四区（issue 列表 / 工作树树状图 / 报告 / 工作区）直接渲染。

**打开方式**：点会话右侧栏底部的 🧰 启动器，打开「工作室」右侧栏页（`sidebar.footer.action` → `sidebarRight.openTab('code-studio')`）。
工作树按选中 issue 的 region 文件夹逐层懒加载渲染成树；点「建 PR」对 `DONE` 的 issue 走 gh 建 PR（见下）。

监听配置：`/code-studio-watch on|off|scan|interval <ms>`，或 `code_studio` 的 `watch` action。
仓库根出现 `.codewrite/`：`issues.json`、`regions.json`、`watch.json`、`inbox/`、`editor/`（工作区记忆）
—— 均为运行产物，建议进 `.gitignore`。

### 建 PR（走本机 gh CLI，插件不留 key）

对某个 `DONE` 的 issue，`/code-studio-watch pr <issueId>`（或 `code_studio` 的 `pr` action / 工作室页「建 PR」按钮）会：

1. 校验目标目录是 git 仓库；
2. `gh auth status` 校验已登录（未登录会提示 `gh auth login`）；
3. 切到 `issue/<id>` 分支 → 有改动则 `add + commit` → `git push -u origin issue/<id>`；
4. `gh pr create --base main --head issue/<id> --title … --body …`，返回 PR 链接。

**前提**：装 `gh`（`winget install --id GitHub.cli -e`）并 `gh auth login -h github.com` 一次。
凭据存在 gh 自己的 `hosts.yml`，插件**不保存任何 GitHub 凭据**。只建 PR、**不自动合并、不自动推 main**；冲突留给人处理。

### GitHub 源（从 GitHub Issues 拉单）

除了本地收件目录，也能直接绑一个 GitHub 仓库，把它的 open issues 当来源；配置落 `<repo>/.codewrite/github.json`：

- 会话里 `/code-studio-watch github owner/repo`（也接受完整 GitHub URL）→ 开；`github off` → 关。
- 私有仓库或想提额度：**手动存 PAT**。会话里 `/code-studio-watch token <pat>`，或在「工作室」Tab 顶部的 **PAT** 一栏粘贴（password 输入框）点保存；`/code-studio-watch token off`（或 Tab 里点清除）删掉。
- PAT 单独存 `<repo>/.codewrite/github-token`（纯文本，仅本机），**不进 `github.json`、不进版本库**；`github.json` 里只记 `enabled/repo/labels/assignee/intervalMs`，Tab 只显示「已存/未存」，永远读不到明文。
- 也可在「工作室」Tab 顶部的 **GitHub 源** 一栏填 `owner/repo` 点绑定。
- 拉取规则：只要 `state=open`、排除 PR；issue 正文里写 `folders: src/a, src/b` 或出现像路径的 token，会自动抽成 region 的文件夹。
- 轮询带 ETag（304 不重拉），默认 120s；`/code-studio-watch scan` 立即拉一次。
- 已派过的 issue 编号记在 `issues.json`，重复拉取不会重派。

## 硬限制（code-guard）

挂在 `presets/code-editor/agent.cordis.yml` 的预设子插件，只对使用本预设的总监会话生效：
- 封：`write` / `edit` / `pwsh` / `bash` / `subagent` / `subagent_fork`。
- 放行只读：`read` / `glob` / `grep` / `code_brief` / `code_state` / `code_check`。
- 写白名单：`.codewrite/editor/*.md`（总监的记忆文件）。
- 子 Agent 不受限制（guard 按 `origin:'subagent'` / `delegationDepth` 放行），但先校验 `write_scope`。

## 目录

```
lib/          index.js(注册) code-guard.js dispatch.js orchestrator.js task-registry.js
              session-roles.js packet.js runner.js agent-models.js
              studio-store.js studio-memory.js studio-dispatch.js studio-watch.js studio-github.js studio-pr.js
presets/code-editor/
              preset.yml agent.cordis.yml orchestration.md roles/*.md(13)
```

每个 `studio-*.js` 都是可独立自测的纯逻辑模块（`node lib/studio-store.js` 等自带 demo）。

## 复用说明（ponytail）

`task-registry.js` / `orchestrator.js` / `dispatch.js` / `session-roles.js` 四份由 novel 插件逐字搬来，
只改了状态目录前缀（`.codewrite/`）与工具名（`code_dispatch`）。不为一个常量复制整份模块，也不重造已有的编排逻辑。

## 仓库侧状态

跑起来后仓库根会出现 `.codewrite/`：`agents/`（任务账 registry.json + 事件 .jsonl + orphaned/）、
`editor/`（总监记忆）、`ledger/`（档案交接）、`issues.json`/`regions.json`/`watch.json`/`github.json`/`inbox/`（工作室台账与监听来源）。
这是运行产物，建议进 `.gitignore`（本仓库已默认忽略）。

## 许可

MIT。见 [LICENSE](./LICENSE)。
