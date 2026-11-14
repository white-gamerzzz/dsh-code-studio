# 工作区状态目录架构（`.code-studio`）

> 状态：**设计定稿，尚未实现**。本文档只记录设计，代码落地见文末「落地清单」。

## 为什么有这个目录

旧版所有状态都塞在 `<仓库>/.codewrite/`，隐含假设「一个工作区就是一个仓库」。真实情况有两种：

1. 工作区**本身就是一个仓库**（最常见，比如 `default-workspace` 是某个项目的 clone）；
2. 工作区是个**壳**，里面放了好几个仓库（比如 `G:\bot-home` 下有 `astrbot-self`、还有别的项目）。

而且同一个工作区可以开**多个会话**，每个会话可能绑不同的 GitHub 源。所以需要一个**工作区级的、独立于任何单个仓库的**目录来记账和放记忆。

## 两条铁律

1. **`.code-studio/` 只放索引和记忆，不放代码、不重复仓库的工作状态。**
   仓库的工作状态（issues / regions / worktree / inbox）仍在 `<仓库>/.codewrite/`，原样不动。
2. **除 `memory/workspace.md` 外，所有记忆按会话隔离。**
   删掉一个会话目录 = 它的会话记忆、子Agent记忆、region记忆一起干净消失，不污染别的会话。

## 目录树

```
<工作区根>/.code-studio/
├── index.json                        ← 总账：本工作区有哪些仓库、哪些会话、各自指针
├── sessions/
│   └── <sessionId>/                  ← 一个会话一个文件夹，自成一体
│       ├── session.json              ← 本会话绑了谁 / 状态目录在哪 / 派出过哪些子会话
│       ├── memory.md                 ← 会话记忆
│       ├── agents/
│       │   └── <childId>.md          ← 子Agent记忆（只属于本会话，绝不串）
│       └── regions/
│           └── <slug>__<region>.md   ← 本会话在某个 region 做过什么
├── memory/
│   └── workspace.md                  ← 工作区级记忆（唯一跨会话共享的一层）
├── repos/                            ← 绑了 GitHub 但本地没检出时才 clone 到这
│   └── <owner>__<repo>/
└── .gitignore                        ← 忽略 repos/ 与敏感项
```

## `index.json`（唯一权威清单）

```json
{
  "version": 1,
  "workspace": "G:/bot-home",
  "updatedAt": "2026-11-15T01:10:00+08:00",
  "repos": {
    "someone/astrbot": {
      "dir": "G:/bot-home/astrbot-self",
      "kind": "local",
      "remotes": { "origin": "white-gamerzzz/astrbot", "upstream": "someone/astrbot" }
    }
  },
  "sessions": {
    "sess-abc123": {
      "title": "改 astrbot 登录",
      "boundRepo": "someone/astrbot",
      "prRepo": "someone/astrbot",
      "prHeadOwner": "white-gamerzzz",
      "stateDir": "G:/bot-home/astrbot-self/.codewrite",
      "activeRegions": ["auth-api"],
      "updatedAt": "2026-11-15T01:12:00+08:00"
    }
  }
}
```

- **`repos`**：发现到的仓库，`remotes` 存**所有 remote 的完整 URL 集合**（不只看 origin —— fork 的 `upstream` 也认得）。
- **`sessions`**：哪些会话绑了哪个来源、状态文件在哪。前端 Tab 读这一份就够。

## `sessions/<sessionId>/session.json`

```json
{
  "sessionId": "sess-abc123",
  "boundRepo": "someone/astrbot",
  "prRepo": "someone/astrbot",
  "prHeadOwner": "white-gamerzzz",
  "stateDir": "G:/bot-home/astrbot-self/.codewrite",
  "children": { "cs-auth-api-xxxx": "region:auth-api" },
  "createdAt": "…", "updatedAt": "…"
}
```

拆两份的理由：`index.json` 保持精简（Tab 一次读全集），每会话细节（children、指针）按需读。

## 台账共享 vs 记忆隔离

| | 位置 | 作用域 |
|---|---|---|
| **台账** issues.json / regions.json | `<仓库>/.codewrite/` | **按仓库共享**（两个会话绑同一仓库看到同一批 issue，不各记一份） |
| **记忆** memory.md / agents/ / regions/ | `.code-studio/sessions/<sid>/` | **按会话隔离**（A 的经验不自动灌进 B） |
| **工作区记忆** workspace.md | `.code-studio/memory/` | 跨会话共享（唯一共享的一层） |

## 四层记忆

| 层 | 文件 | 谁写 | 谁读（注入时机） |
|---|---|---|---|
| 工作区 | `memory/workspace.md` | issue 结算时追加稳定事实 | **所有**会话开场都注入尾部 |
| 会话 | `sessions/<sid>/memory.md` | 本会话往来/结算追加 | 本会话自己的 systemPrompt |
| 子Agent | `sessions/<sid>/agents/<childId>.md` | 该持久子会话结算时追加 | 该子会话冷恢复时注入 |
| region | `sessions/<sid>/regions/<slug>__<region>.md` | 本会话该 region 的 issue 结算时追加 | 本会话该 region 再派单时注入 |

读回统一走 `systemPrompt.section`：根从「会话 cwd」换成 `.code-studio/`，按层拼接、各取尾部 ≤40 行防撑爆（照旧用现有的滚动/归档机制）。

## 工作区规则（rules）—— 可运行时增改、按对象生效

> 用户口述一句「今天技术总监调工具卡了很久」，Agent 就该把它记成**一条规则**，写进工作区；之后**适用的 Agent** 干活时自动读到它。这比「往 memory.md 追加一行」更进一步：规则带**适用对象**，不同角色读到的规则不同。

### 存放与结构

`<工作区根>/.code-studio/memory/rules.json`（结构化，便于按对象过滤；不塞进 workspace.md 那种纯文本）。

```json
{
  "version": 1,
  "rules": [
    {
      "id": "r-001",
      "text": "连续调用工具超过约 20 次或单步卡超过 2 分钟，先停下来汇报进度，不要闷头刷",
      "scope": { "kind": "role", "role": "tech-lead" },
      "tags": ["工具", "停滞", "效率"],
      "createdBy": "tech-lead",
      "createdAt": "2026-11-15T01:30:00+08:00",
      "source": "用户口述：技术总监调工具长时间停滞"
    },
    {
      "id": "r-002",
      "text": "提交信息用 feat/fix(scope): 格式；禁止 as any",
      "scope": { "kind": "all" },
      "tags": ["约定", "提交"],
      "createdBy": "tech-lead",
      "createdAt": "2026-11-15T01:31:00+08:00",
      "source": "用户口述"
    }
  ]
}
```

### `scope.kind` 三种（正好对应用户说的「全 Agent / 仅某个 Agent / 角色提示词」）

| kind | 含义 | 存哪 |
|---|---|---|
| `all` | **全 Agent**（前台 + 所有子Agent）都注入 | `rules.json` |
| `role` / `roles` | **仅某（几）个角色**（如只对 `reviewer`） | `rules.json` |
| （不入库） | **角色固有纪律**：跟角色绑死、不随工作区变 | `presets/code-editor/roles/<role>.md` |

第四条隐藏层级：**`scope.kind:"session"`** = 只本会话——等价于写进 `sessions/<sid>/memory.md`，不进 `rules.json`（不污染别的会话）。

**边界判定**：这条规则是「换个人/换个项目就不成立了」→ 会话记忆；「跟这个角色天生该做的事绑死」→ 角色提示词（改插件）；「对这个项目长期成立、且可能只该某些角色守」→ `rules.json`。

### Agent 自己写（工具入口）

扩 `code_studio` 工具，加 `action:"rule"`：

- `code_studio action=rule op=add text="…" scope=all|tech-lead,reviewer tags=工具,停滞`
- `code_studio action=rule op=list [scope=…]`
- `code_studio action=rule op=remove id=r-001`

写入前做轻规范化：压成一行、限长（≤200 字）、去重（同 text 已存在不重复加）、scope 解析成结构化对象。返回 `{ok,id,scope}`。这全是纯数据操作，可单测。

### 读回（谁能读到什么）

`systemPrompt.section` 注入时按**当前 Agent 的 role** 过滤：

- 前台会话（code-editor 预设）role = `tech-lead`
- 子Agent 的 role 从 `session-roles.js` 的 MARKS 取（`markOf(sessionId).role`）

过滤规则：`scope.kind==='all'` **或** `scope.kind==='role' && role===当前role` **或** `scope.roles.includes(当前role)`。命中的规则按标签分组、拼成一段「## 工作区规则（必守）」注入。取全部（规则不该太多，超 50 条滚动归档到 `rules.archive.json`）。

### 和四层记忆的关系

| 东西 | 位置 | 谁写 | 形态 |
|---|---|---|---|
| 工作区**事实**记忆 | `memory/workspace.md` | 结算时自动追加 | 纯文本、尾部注入 |
| 工作区**规则** | `memory/rules.json` | **Agent 主动 + 用户口述触发** | 结构化、按 role 过滤注入 |
| 会话记忆 | `sessions/<sid>/memory.md` | 本会话追加 | 纯文本 |
| 子Agent/region 记忆 | `sessions/<sid>/{agents,regions}/` | 子会话结算追加 | 纯文本 |

一句话：**workspace.md 记「这个项目长什么样」，rules.json 记「在这个项目里该怎么干活、谁必须守」**。

## 仓库发现与身份匹配（`lib/studio-repo.js`）

发现顺序：

1. 工作区根目录**本身是 git 仓库**（有 `.git`）→ 就是它（单仓库模式，行为与旧版完全一致）。
2. 否则扫工作区下一层的子目录，凡是含 `.git` 的收集起来（不递归太深，默认 2 层内）。

身份匹配**不看文件夹名、不只看 origin**：

- 对每个候选仓库跑 `git remote -v`，把**每个** remote 的 URL `parseRepoSlug` 成 `owner/repo`，得到 slug 集合。
- 绑定 `someone/astrbot` 时，slug 集合里命中即算（`origin` 是 fork、`upstream` 是上游，两者都认）。
- 命中多个仓库（撞车）→ **报出来让用户选**，不自动挑。
- 一个都没命中 → clone 到 `.code-studio/repos/<owner>__<repo>/`（`kind:"cloned"`）。

PR 目的地独立于 issue 来源：

- `repo` = issue 从哪拉
- `prRepo` = PR 提到哪（默认 = repo；fork contribute 时填上游）
- `prHeadOwner` = 从谁的分支提（默认空 = 用 origin；fork 时填自己）

建 PR 时拼：`gh pr create --repo <prRepo> --head <prHeadOwner||origin>:issue/<id> --base main`。

## 三档能力与前置条件

| 想干的事 | 前置条件 | 不需要 |
|---|---|---|
| **改本地文件** | 有文件夹即可 | 不用 git、不用绑 GitHub |
| **推 / 建 PR** | 目标目录是 git 仓库且能 push | 不一定要绑 GitHub（有 origin 就够） |
| **自动拉 issue 处理** | **必须绑 GitHub 源** | — |

实现落点：

- `dispatchIssue`：先探目标目录是不是 git 仓库。是 → 建 worktree 隔离；不是 → **跳过 worktree，就地改目录**（子会话 cwd 指向该目录）。
- `studio-pr.js`：保持 `git rev-parse --is-inside-work-tree` 校验，错误话术改人话。
- `ensureWatcher`：**只在绑了 GitHub（`sessions[sid].boundRepo` 有值）时才自动轮询**；本地 inbox 保留给手动 `/code-studio-watch scan`。

## 一次绑定发生什么

```
用户: /code-studio-watch github someone/astrbot --pr someone/astrbot --head white-gamerzzz
  ↓ studio-repo 发现仓库（工作区本身 or 子目录扫描；按 remotes→slug 匹配，多义报错）
  ↓ 本地没有 → clone 到 .code-studio/repos/someone__astrbot/  (kind:"cloned")
  ↓ 写 sessions/<sid>/session.json + index.json.sessions[sid]
  ↓ 开轮询（只有绑了 GitHub 才自动跑）
返回: 绑定成功，状态目录 = …/astrbot-self/.codewrite
```

## 兼容 & 迁移

- 工作区本身就是单仓库的场景**行为完全不变**：`.code-studio/` 只是额外多一份索引+记忆，台账仍在 `.codewrite/`。
- 旧路径 `<仓库>/.codewrite/editor/` 的记忆**保留只读兼容**（读回时旧路径也扫，新写入一律进 `.code-studio/sessions/<sid>/`）。
- `.code-studio/.gitignore` 默认忽略 `repos/` 与 token 类文件。

## 落地清单（尚未做）

- [ ] `lib/studio-workspace.js`：读写 `.code-studio/index.json` + `sessions/<sid>/session.json`，原子写。
- [ ] `lib/studio-repo.js`：发现仓库（本体/子目录）、`git remote -v` 收集所有 slug、按 slug 匹配、缺失 clone、解析 issue 归属、算 PR 目的地。
- [ ] `lib/studio-rules.js`：读写 `memory/rules.json`、`addRule/listRules/removeRule` 纯函数、`rulesForRole(rules, role)` 过滤、归一化+去重+超限归档。
- [ ] `code_studio` 工具加 `action:"rule"`（op=add/list/remove，带 scope/tags）。
- [ ] 记忆四层迁到 `.code-studio`（`studio-memory.js` 扩展根路径 + 分层注入；旧 `.codewrite/editor` 只读兼容）；规则段也在这里注入（按 `markOf` 的 role 过滤）。
- [ ] `dispatchIssue` 探 git → 非仓库就地改、不做 worktree。
- [ ] `ensureWatcher` 只在绑了 GitHub 时自动轮询。
- [ ] `studio-pr.js` 按 `prRepo/prHeadOwner` 拼 `gh pr create`。
- [ ] 绑定命令扩展 `--pr` / `--head` 参数。
- [ ] 全量自检（node --check + demo + 探针）+ commit + push。
