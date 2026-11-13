# dsh-plugin-code-studio · 代码总编工作室

参考 `dsh-plugin-novel`（小说总编工作室）与 SuperAgent 编排插件做的**代码生产**版本。
技术总监不写代码，只输出工作流 + 派单给 6 类角色子 Agent；每张单走 `code_task` 账本、
有 `write_scope` 文件硬边界、过「机器门 `code_check` + 独立审校」两道门。

## 安装

本插件是 profile 内的 bundle 层，靠 `cordis.patch.yml` 插入（与 novel 同构）：

```yaml
- insert:
    - id: code-studio
      name: 'dsh-plugin-code-studio'
    - id: code-studio-agent-models
      name: 'dsh-plugin-code-studio/agent-models'
```

角色 → 模型指派在设置页的 `code-studio-agent-models` 条目里配（`enabled` + `assignments[{role,provider,model,reasoningEffort}]`）；未指派的角色继承技术总监的模型。

## 工具

| 工具 | 用途 |
|---|---|
| `code_roles` | 取某角色卡全文（派单前必读，随提示词一起给子 Agent） |
| `code_brief` | 组装实现任务上下文包（目标 + 相关文件摘录 + 契约 + 约束 + 验收） |
| `code_check` | 自动机器门：按给定命令逐条跑，全过才 PASS（技术总监唯一跑命令的窄通道） |
| `code_state` | 账本视图：任务按状态分组，看下一步该派谁 |
| `code_task` | 任务账：open/claim/renew/settle/release/cancel/pick/get/list/reclaim/events |
| `code_dispatch` | 按角色派单（自动套用设置的模型），立即返回子会话 id，不等；支持 variants 平行版本 |
| `code_eval` | 派单前评估门（对齐 SuperAgent Eval）：按任务单完整度裁 proceed/clarify/reject |
| `code_review` | 静态审校扫描：待办标记 / console.log / debugger / any / 空 catch / 超长函数 / 硬编码密钥 |
| `code_map` | 依赖图：扫各包清单建内部依赖有向图、列外部依赖、找循环依赖 |
| `code_kb` | 代码范例库：按语义（bge-m3 向量，退词法）沉淀/检索「写对了的代码」范例 |
| `code_studio` | 工作区工作室台账：issue 归属 region、派给持久子会话、开关监听收件目录、建 PR（`assign`/`submit`/`issues`/`regions`/`set`/`dispatch`/`watch`/`pr`） |

## 工作室：监听 → 派单 → 报告（多仓库）

按工作区（会话绑的那个文件夹）独立监听，配置落在 `<repo>/.codewrite/watch.json`，不用填路径。

1. 会话绑到某个仓库文件夹后，`code_studio`（或 `/code-studio-watch on`）开启监听。
2. 往 `<repo>/.codewrite/inbox/` 丢一个 `*.json`：`{ "id"?: "12", "title": "修登录", "body": "原文", "folders": ["src/auth"] }`
   —— 轮询器下一轮（默认 60s）把它变成 issue 并派单。folders 可省略，会从 body 里的路径自动抽。
3. **持久子会话按 region 复用**：同一片文件夹的后续 issue 追回同一个子会话串行追加，换片才新建；
   在飞的 region 分组 ≤ 2，子会话不得再派 `tech-lead`。
4. 子会话结算时，报告回写 `issues.json`。**右侧栏「工作室」页**同屏呈现 issue 列表 / 工作状态图 / 报告，左侧照常是会话区。

**打开方式**：点会话右侧栏底部的 `</>` 启动器，打开「工作室」右侧栏页（`sidebar.footer.action` → `sidebarRight.openTab('code-studio')`）。
中间那块是**工作状态图（节点连线图）**：`工作区 → region → issue` 三层节点用连线连起来，直接看哪个 region / 子 Agent 在跑（RUNNING 的 region 和 issue 会黄色高亮脉冲），点 issue 节点切换右侧报告。点「建 PR」对 `DONE` 的 issue 走 gh 建 PR（见下）。

### 前台提交 issue（规范化接口）

前台 Agent 不手搓 prompt/folders，统一用 `code_studio` 的 `submit` action：

```
code_studio { action: "submit", id: "12", title: "修登录", body: "改 src/auth/token.ts", folders?: ["src/auth"] }
```

插件会归一化 folders/status、按 issue 自动组任务正文、按文件夹归 region 并派单记账。三个来源（本地收件 / GitHub issue / 前台 submit）都过同一个规范化入口 `lib/studio-intake.js`，形状统一后再进台账。

### 工作区维护组（自动切到工作室模式）

每个工作区（= 会话绑的那个文件夹）有一个**维护组**：只要满足任一条件，就把**前台会话的 Agent 预设自动切成 `code-editor`（代码总编/技术总监模式）**——

1. 对话一开始就用「代码总编工作室」预设发起（`code-editor`）；
2. 手动打开工作室右侧栏页（此时若当前会话还是空会话、没开始对话，会自动切）。

规则：
- 只对**空会话**（还没发过消息）自动切，不打断进行中的普通对话；
- 每个会话每页面生命周期只尝试一次，不反复抢；
- 面板顶部有**模式 chip**：显示「代码总编工作室 / 普通」；非工作室模式时右侧出现「切换到工作室模式」按钮，随时一键切。

底层走 `remote.agentPresets.select(sessionId, 'code-editor')`，没有全局副作用，只作用于当前会话。

监听配置：`/code-studio-watch on|off|scan|interval <ms>`，或 `code_studio` 的 `watch` action。仓库根出现 `.codewrite/`：`issues.json`、`regions.json`、`watch.json`、`inbox/`、`editor/`（工作区记忆）——均为运行产物，建议进 `.gitignore`。

### 建 PR（走本机 gh CLI，插件不留 key）

对某个 `DONE` 的 issue，`/code-studio-watch pr <issueId>`（或 `code_studio` 的 `pr` action / 工作室页「建 PR」按钮）会：

1. 校验目标目录是 git 仓库；
2. `gh auth status` 校验已登录（未登录会提示 `gh auth login`）；
3. 切到 `issue/<id>` 分支 → 有改动则 `add + commit` → `git push -u origin issue/<id>`；
4. `gh pr create --base main --head issue/<id> --title … --body …`，返回 PR 链接。

**前提**：装 `gh`（`winget install --id GitHub.cli -e`）并 `gh auth login -h github.com` 一次。凭据存在 gh 自己的 `hosts.yml`，插件**不保存任何 GitHub 凭据**。只建 PR，**不自动合并、不自动推 main**；冲突留给人处理。

### GitHub 源（从 GitHub Issues 拉单）

除了本地收件目录，也能直接绑一个 GitHub 仓库，把它的 open issues 当来源；配置落 `<repo>/.codewrite/github.json`。

- 会话里 `/code-studio-watch github owner/repo`（也接受完整 GitHub URL）→ 开；`github off` → 关。
- 私有仓库或想提额度：**手动存 PAT**。会话里 `/code-studio-watch token <pat>`，或在「工作室」页顶部的 **PAT** 一栏粘贴（password 输入框）点保存；`/code-studio-watch token off`（或点清除）删掉。
- PAT 单独存 `<repo>/.codewrite/github-token`（纯文本，仅本机），**不进 `github.json`、不进版本库**；`github.json` 里只记 `enabled/repo/labels/assignee/intervalMs`，面板只显示「已存/未存」，永远读不到明文。
- 也可在「工作室」页顶部的 **GitHub 源** 一栏填 `owner/repo` 点绑定。
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
              studio-store.js studio-memory.js studio-dispatch.js studio-watch.js
              studio-github.js studio-pr.js studio-intake.js
presets/code-editor/
              preset.yml agent.cordis.yml orchestration.md roles/*.md(7)
```

每个 `studio-*.js` 都是可独立自测的纯逻辑模块（`node lib/studio-store.js` 等自带 demo）。

## 复用说明（ponytail）

`task-registry.js` / `orchestrator.js` / `dispatch.js` / `session-roles.js` 四份从 novel 插件逐字搬来，只改了状态目录前缀（`.codewrite/`）与工具名（`code_dispatch`）。不为一个常量复制整份模块，也不重造已有的编排逻辑。

## 破甲内置层（pozhang/）

插件**自带破甲**，装上重启 dsh 即生效，无需另开注入程序：

- 启动时在 `apply()` 里幂等写入 `~/.dsh/AGENTS.md` 的标记块（内容一致则跳过，不重装技能）
- 同时把技能库装到 `~/.dsh/skills/`（与破障桌面版同一套 `codex-skills-v4`）
- 插件进程活着 = 守护活着：每 30s 校验标记块，被编辑/覆盖自动补回
- **子 Agent 同样覆盖**：dsh 是否把 AGENTS.md 传给子会话是运行时行为，不能假设——派单时把破甲正文**显式前置**到子会话初始 prompt（三条派单路径全部覆盖：`code_dispatch` 常驻/一次性、`code_studio dispatch`、收件/GitHub 监听自动派单）；追回已有子会话时补一句锚点，防上下文压缩后约束漂移
- **压缩三层防御**（`dsh-compaction` 摘要会把早期消息吃掉，头部注入最先受损）：
  1. 正文末尾带**自愈条款**——约定不可见时模型自行读取 `~/.dsh/AGENTS.md` 恢复，不依赖运行时事件
  2. **压缩守望**：每 20s 检查已登记子会话的会话日志，日志缩水 >35% 判定为压缩，给该子会话追发锚点（5 分钟冷却，`subagents.sendMessage`）
  3. 追回既有子会话时每次都带锚点，保证"最近一条消息"里始终有约束（压缩摘要优先保留近期消息）
- **身份不被压缩吃掉**：压缩最先吃掉会话开头（角色卡所在处），所以每次派单/追发都在消息**末尾**追加角色感知锚点：`你当前的角色是 <role>；角色卡若已不可见，先调用 code_roles 取回`。锚点落在压缩的"最近消息"保护窗口内
- **不碰任何其它插件**：不使用 dsh-prompt-inject 之类的第三方配置通道；状态只落在 `~/.dsh/AGENTS.md` 的标记块、`~/.dsh/.pozhang-state.json` 与本插件目录内
- 资源全部内置：`pozhang/assets/破障v4.md`（提示词正文）、`pozhang/assets/codex-skills-v4/`

```bash
/hz              # 查看状态（注入是否最新、字符数、技能数）
/hz on           # 立即重新注入
/hz off          # 卸载：摘掉 AGENTS.md 注入块并清理本插件装的技能
```

### 两种生效方式

**① 进程内拦截（默认，推荐）**

学 billion-context：插件在 dsh 进程内接管出站 `fetch`。请求 URL 里就是该 provider 的上游，所以**会话选了哪家 provider，请求就流向哪家**——不需要改任何 Base URL，也不需要按前缀分流。

- 只处理命中路由表主机的 JSON 请求，下载/插件市场等流量完全不碰
- 缺破障就补进 `system` / `instructions`，齐全则字节级原样放行
- 计数与会话表在设置页可见（已处理 / 补丁 / 放行 / 按 provider 分列）

**② HTTP 中继（备选，供非 fetch 通道）**


dsh **设置 → 代码工作室** 一页两块：**破障中继在上、角色模型指派在下**。两块共用同一套排版基线（1px 明显边框、面板底色、等宽数值对齐、表头大写小字），风格与宿主统一：

- 开关 / 端口（保存后约 5 秒收敛到中继进程，开关是自启动的唯一权威）
- **按 provider 路由（不是全局一个上游）**：中继从 dsh 的 `profiles/*/cordis.patch.yml` 读出 `provider → baseURL` 路由表，请求路径带前缀就按该 provider 转发：`/<provider>/v1/...`。多家供应商各走各的，不会串流；多 provider 但请求没带前缀时返回 400 并列出可用前缀，不猜
- 实时卡片：运行状态、活跃会话、补丁次数、原样放行、运行时长
- 会话表：标识 / 请求数 / 补丁数 / 最后活动
- 面板直达链接 `http://127.0.0.1:<port>/_pozhang/panel`

工作原理：出站请求先过中继，检查 body 里破障正文与角色锚点是否齐全——齐全原样透传，缺失就补到 **system/instructions 层**再转发。system 层不参与上下文折叠，所以压缩动不了它。

- **中继跑在插件进程内**（不是子进程）：Windows 上 detached 子进程会随父进程 job 被回收（实测存活数秒即消失），进程内实现的寿命天然等于 dsh，无孤儿进程
- **一个服务、一个端口、所有会话共享**：会话只登记元数据，空闲 10 分钟淘汰，无会话级常驻资源
- 零依赖；SSE 流式透传；`gzip/deflate/br` 自动解码
- 仍需手动一步：把 dsh 模型设置里该 provider 的 **Base URL** 指到 `http://127.0.0.1:<port>`（API Key 原样透传）。这是 dsh 自身设置，插件无法代改

命令行等价操作：`/hz relay on [端口] [上游]`、`/hz relay off`、`/hz relay`（看状态）。

改提示词只改 `pozhang/assets/破障v4.md`（或 `pozhang/index.js` 的 `DEFAULT_PROMPT`），重启 dsh 后下次启动自动升级。卸载/升级不会动用户自己在 `AGENTS.md` 里写的其它内容。

> 生效时机：AGENTS.md 只在**会话启动时**读取，注入完成后需重启 dsh 或开新会话。

## 仓库侧状态

跑起来后仓库根会出现 `.codewrite/`：`agents/`（任务账 registry.json + 事件 .jsonl + orphaned/）、`editor/`（总监记忆 + `regions/` 分区记忆）、`ledger/`（档案交接）、`issues.json`/`regions.json`/`watch.json`/`github.json`/`inbox/`（工作室台账与监听来源）。这是运行产物，建议进 `.gitignore`（本仓库已默认忽略）。

## 许可

MIT。见 [LICENSE](./LICENSE)。
