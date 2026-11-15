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
4. 子会话结算时，报告回写 `issues.json`（现在统一放在工作区的 `<ws>/.code-studio/issues.json`）。**右侧栏「工作室」页**是三栏：左栏区域目录（点区域即筛下面的 issue 列表）/ 中栏该区域的 issue 列表 / 右栏工作状态图 + 报告，再右边照常是会话区。

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

监听配置：`/code-studio-watch on|off|scan|interval <ms>`，或 `code_studio` 的 `watch` action。台账 `issues.json`/`regions.json` 统一落在**工作区根的 `<ws>/.code-studio/`**（不再散在各仓库 `.codewrite/`）；`watch.json`/`inbox/` 仍在 `<repo>/.codewrite/`。均为运行产物，建议进 `.gitignore`。

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

**双向同步**：`source==='github'` 的 issue 结算后会把处理结果作为评论回写原 issue；建 PR 成功后把 PR 链接评论回去。**不自动关单**（要等 PR 合并，由人在 GitHub 上关，避免误关）。

### 外置 Agent 写入接口（HTTP）

除了让外部程序往 `<repo>/.codewrite/inbox/*.json` 丢文件，插件还在本机起了一个 HTTP 入口，程序化提交 issue：

```
POST http://127.0.0.1:&lt;ds h端口&gt;/code-studio/intake
content-type: application/json
{
  "repo": "C:/path/to/your-repo",   // 或项目名；省略用当前会话 cwd
  "id": "77",                        // 可省，省略自动生成
  "title": "登录 token 过期不刷新",   // 必填（或 body 非空）
  "body": "在 src/auth/login.ts 加判空",
  "folders": ["src/auth"]            // 可省：从 body 抽，抽不到→ unrouted 兜底
}
→ 200 { ok:true, id:"77", status:"READY", unrouted:false, dir, inbox, file }
```

- 落盘走和 inbox 同一条路：规范化后写进该工作区的 `.codewrite/inbox/`，由该工作区 watcher 扫走派单（前提是 `/code-studio-watch on` 且工作区会话活着）。
- 校验：非 POST→405；body 非 JSON→400；缺 id 且无 fallback 时会补一个。
- 鉴权：若 host 的 `connection` 服务提供了 `requestRejection`，会先过它（浏览器来源的 CSRF 保护）；没有就靠本机回环地址。

### 工作区状态目录 `.code-studio`（索引 + 记忆 + 规则）

工作区根下的 `.code-studio/` 放**索引 + 记忆 + 规则 + 工作台账**（`issues.json`/`regions.json` 也在这里，一个工作区的状态集中一处，不东一堆西一堆），不放代码。

```
<工作区根>/.code-studio/
  index.json                     总账：仓库清单 + 各会话绑定
  issues.json                    所有 issue 的台账（选择区域后按 region 过滤展示）
  regions.json                   区域台账：每个区域的文件夹 / 子会话 / 工作树 / issue 列表
  sessions/<sid>/session.json    单会话：绑了哪个仓库 / PR 目的地 / 状态目录
  sessions/<sid>/github.json     本会话绑的 GitHub 源（含 prRepo/prHeadOwner）
  sessions/<sid>/github-token    本会话 PAT（0600，不进版本库）
  sessions/<sid>/memory.md       本会话记忆（只这个会话读）
  sessions/<sid>/agents/<childId>.md   子 Agent 记忆（冷恢复用）
  sessions/<sid>/regions/<slug>.md     某 region 再派单时的记忆
  memory/workspace.md            工作区级记忆（所有会话共享）
  memory/rules.json              工作区规则（可按角色过滤）
  repos/<owner>__<repo>/         需要插件代为 clone 时才用
```

> 旧版本的 `<repo>/.codewrite/issues.json` / `regions.json` 会被自动兼容读取（新位置为空时回退读旧的），新写入一律走 `.code-studio/`。

- **记忆按会话隔离**：除 `memory/workspace.md` 外，所有记忆都在 `sessions/<sid>/` 下，同一工作区的不同会话/子 Agent 不会串记忆。
- **工作区规则**：用户口头提醒技术总监「以后别这样」时，总监用 `code_studio` 的 `rule` action 记下来，全 Agent / 指定角色 / 本会话 三种适用范围：

```
code_studio { action:"rule", op:"add", text:"跑测试前先 pnpm install", scope:"all" }
code_studio { action:"rule", op:"add", text:"审校只看契约不看风格", scope:"reviewer,security" }
code_studio { action:"rule", op:"list" }        // 看当前规则
```
  规则存 `memory/rules.json`（≤200 字/条、同文去重、超 50 条滚动归档），派单时按子 Agent 角色自动拼进 prompt，前台会话按 `tech-lead` 注入。只跟某个会话有关、换项目就不成立的，走会话记忆（`scope:"session"`）；跟角色绑死的固有纪律写进 `presets/code-editor/roles/<role>.md`。

- **自动创建**：不必手动建 `.code-studio`。以下任一操作会自动在**工作区根（会话 cwd）**建好骨架：
  打开工作室面板（`/code-studio-watch init`）· `code_studio submit|dispatch` 派单 · `code_studio action:"rule" op:"add"` 写规则 · `/code-studio-watch on` 开监听 · 绑 GitHub 源。
  纯读账（`issues` / `regions` / `repos` / `code_check` / `code_dispatch`）**不会**创建。要关掉自动创建：在 `cordis.patch.yml` 的 `code-studio` 条目里写 `config: { autoCreate: false }`；也可随时 `/code-studio-watch init` 手动建。

### 多仓库工作区（一个工作区里有多个 git 仓库）

一个工作区（如 `G:\bot-home`）下可能有多个仓库（`G:\bot-home\astrbot-self`、`G:\bot-home\other`）。插件不再假设「工作区 = 一个仓库」：

- `code_studio { action:"repos" }` 列出工作区里发现的 git 仓库（有 `.git` 的子目录）。
- 派单时按 `issue.repo`（`owner/repo` 或目录名）或 `folders` 首段自动归属到某个子仓库；归属不到的留在工作区根。
- **PR fork 自动识别**：`git remote -v` 里同时有 `origin`（你的 fork）和 `upstream`（原仓库）时，PR 自动提上游、`--head` 用 origin 的 owner；也可用 `prRepo` / `prHeadOwner` 显式覆盖。
- 非 git 目录也能派单（跳过 worktree、就地改）；只有「建 PR」要求目录是 git 仓库。

### 会话级 GitHub 源 + 快速换会话继承

- **GitHub 源跟会话走，台账跟仓库走**：`/code-studio-watch github owner/repo`、`token <pat>` 现在写进 `sessions/<sid>/github.json` 与 `sessions/<sid>/github-token`（不再写工作区共享的 `.codewrite/github.json`）。同一工作区不同会话可各绑各的仓库/PAT，互不干扰。会话目录没有配置时回退读旧 `<workspace>/.codewrite/github.json`，老工作区免迁移。
- **快速换会话、继承记忆与绑定**：面板顶部「新建会话并继承」按钮（或命令 `/code-studio-watch inherit <newSid> [fromSid]`）会新建一个**干净会话**（带 `code-editor` 预设直接进入工作室模式），然后用 `inheritFrom` 指针把它的记忆/规则/GitHub 源/PAT **指向**旧会话目录 —— **不复制任何文件**，只新建一条会话记录。
- **在跑的任务一并接管**：继承时会把正在跑的子 Agent（`STUDIO_CHILDREN` 里归属旧会话的那些）重挂到新会话，它们结算后的记忆照常写进新会话（否则旧会话已只读、这些记忆会丢）。
- **一份记忆只给一个可写会话**：一旦继承，旧会话自动标 `readonly`（只读不写），新会话可读可写。这样同一份会话记忆不会被两个会话同时写乱。取消继承：`/code-studio-watch unlink`（或直接删 `index.json` 里那条 `inheritFrom`）。
- **面板「区域目录」**：左侧 issue 列表下方列出所有区域（名称 / 状态点 / issue 数 / 文件夹），点一下选中该区域第一条 issue —— 面板上一眼看清这个工作区拆成了哪几个区、各自在干什么。

### 面板外观（悬浮卡片 / 自定义背景 / 玻璃 / 折叠侧栏 / 监控条）

工作室内置网页右上角 **「⚙ 外观」** 打开一张可拖拽的悬浮卡片（拖标题栏移动，`✕` 关闭），改动即时生效并写进 `<工作区>/.code-studio/theme.json`：

- **强调色**：7 个预设色板（默认蓝 / NapCat 青 / 霓虹紫 / 森绿 / 琥珀 / 海洋 / 玫瑰）或取色器任选；自动派生 `-weak`（15% 透明底）与 `-line`（45% 描边），换任何颜色都不会把字配色到看不见。
- **背景**：三选 —— 跟随主题 / 纯色（任意 HEX）/ 图片。图片只接受 `http(s)://` 或 `data:image/`（其它协议直接丢弃，防 `javascript:` 注入），铺在整页并自动叠一层暗色蒙版保证可读。
- **整页渐变**：两枚色点 + 强度滑杆（0–100）。渐变铺满整页（不再只有左栏一条），强度调到 0 就是纯底色。
- **右栏悬浮玻璃**：右内容面板单独一块，可选底色 + 不透明度（0–100），底色留空即跟随主题卡片色；配合下面的玻璃开关，就是浮在背景上的一块磨砂板。
- **玻璃**：开关 + 模糊半径（0–30px）+ 饱和度（0–200%）。开启后数据源条 / 报告 / 图 / 监控卡 / 外观卡都走 `backdrop-filter` 磨砂。
- **圆角 / 密度（舒适·紧凑）/ 模式（跟随·亮·暗）**，一键恢复默认。
- **侧栏可收起**：标题左侧 `‹/›` 按钮把左侧「区域树」折叠，右侧工作区自动占满。
- **监控条**：六张卡片显示**工作室流程状态**（进行中 / 待派 / 已完成 / 异常 / 区域数 / 当前数据源），不是系统 CPU/内存这类资源占用。

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
              studio-github.js studio-pr.js studio-intake.js studio-route.js
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

跑起来后仓库根会出现 `.codewrite/`：`agents/`（任务账 registry.json + 事件 .jsonl + orphaned/）、`editor/`（旧版总监记忆，新装的走 `.code-studio/`）、`ledger/`（档案交接）、`watch.json`/`inbox/`（监听来源）；而 `issues.json`/`regions.json` 已迁到工作区根的 `.code-studio/`。都是运行产物，建议进 `.gitignore`（本仓库已默认忽略）。

## 许可

MIT。见 [LICENSE](./LICENSE)。
