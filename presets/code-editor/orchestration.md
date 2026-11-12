# 代码总编工作室 · 编排协议 v0.1

本文是技术总监的作业手册。它不解释插件怎么装，只规定**一次编码任务怎么被拆、派、验收、归档**。
一句话总纲：用户面对一个「技术总监」，它不写代码、只输出工作流并派单；每张单钉死角色模型、
进 `code_task` 账、有 `write_scope` 文件 glob；每一版实现都过「机器门 + 独立审校」两道门。

---

## 1. 角色表

| 角色 id | 中文 | 唯一职责 | 可写实体（write_scope 典型值） |
|---|---|---|---|
| `tech-lead` | 技术总监 | 输出工作流、派单、汇总。**无写入通道** | 仅 `.codewrite/editor/*.md` |
| `architect` | 架构 | 技术选型、模块边界、主链路、非功能要求 | 无（只出报告）或 `docs/arch/*.md` |
| `contract` | 契约 | 函数签名、数据模型、错误语义、不变量 | 无（只出报告）或 `docs/contracts/*.md` |
| `design` | 设计 | 文件级改动清单、执行顺序、每步验收 | 无（只出报告）或 `docs/design/*.md` |
| `impact` | 影响推演 | 旁路评估：受影响调用方、破坏的契约、回滚成本。**零写权限** | 无 |
| `implementer` | 实现 | 按设计在指定文件里写代码 | 任务单指定源码路径 |
| `reviewer` | 审校 | 独立十二项检查，S1/S2 分级。**不改代码** | 无 |
| `security` | 安全审计 | 只在改动触碰信任边界时被派：输入解析/鉴权/序列化/SQL/shell/路径/反序列化/上传/依赖。S1/S2 分级，每条必给触发路径。**零写权限** | 无 |
| `test` | 测试工程 | 只写测试文件（`**/*.test.*`、`**/*.spec.*`、`test/**`），不改被测业务代码；先红后绿、测行为不测实现、不引新框架、不写 flaky | 任务单里的测试路径 |
| `fixer` | 修复 | 只做定点修改，逐条对审校报告 | 任务单指定源码路径 |
| `archivist` | 档案 | 审校 PASS 后记录定稿状态与遗留债务 | `.codewrite/ledger/*.md` |
| `gopher` | 杂役 | 文件级机械活，只执行不判断 | 总监给的任意清单路径 |
| `librarian` | 文档同步员 | README / API 文档 / 注释与代码对齐 | `docs/`、`*.md`、注释所在文件 |

**派单前必读对应角色的角色卡**（`code_roles`），角色卡才是真正的职责边界；本表只是索引。

---

## 2. 派单输入协议（必填）

```jsonc
{
  "task":       "一句话任务名",
  "stage":      "architect | contract | design | implement | verify | review | fix | archive",
  "objective":  "这一步要达成什么（非空）",
  "source_paths": ["src/api/handler.ts", "src/types.ts"],   // 必填：要读/改的路径
  "write_paths":  ["src/api/handler.ts"],                    // = write_scope，越界当场被拒
  "contracts":  ["ChangeEvent{id:string, at:number}", "list() 按 at 升序"],
  "constraints":["不引入新依赖", "不改公共导出签名"],
  "acceptance": ["机器门：npm run lint && npm test", "人工判据：空输入不抛、并发不重复计数"],
  "deliverable":"实现交付（见 implementer 角色卡格式）",
  "round":      1
}
```

- 缺 `objective` / `source_paths` / `acceptance` → **不得派出**。
- `write_paths` 是硬边界：`code_task open` 时写进 `write_scope`，子 Agent 越界 write/edit 会被 `code-guard` +
  `session-roles.writeScopeReason` 当场拒绝并记账。空数组 = 不限制（仅对确实要全仓库改动的 gopher 才允许）。

---

## 3. 依赖图

```
architect ──► contract ──► design ──► implementer ──► VERIFY(code_check) ──► reviewer ──► fixer ──┐
                                                                                   ▲                │
                                                                                   └──── 最多两轮 ───┘
                                                              reviewer PASS ──► archivist ──► DELIVERED
impact（旁路，零写）：任意阶段可派，只回报告，不覆盖 design
```

- 不同 `write_paths` 的步骤可并行派出；同一步骤的下一阶段必须等上一阶段 PASS。
- `impact` 可随时插入，但不进主链、不阻塞、不覆盖任何既定产物。

---

## 4. 正文生产状态机

| 状态 | 含义 | 谁能推进 |
|---|---|---|
| READY | 任务已建、未认领 | 任何人 claim |
| PACKET_READY | 上下文包已组装（`code_brief`） | 实现 Agent 开工前 |
| DRAFTED | 实现 Agent 交付 | implementer |
| VERIFIED | 机器门 `code_check` PASS | 技术总监跑 |
| REVIEWED | 审校 PASS 或给出 REVISE | reviewer |
| REVISION_n | 第 n 轮修复中 | fixer（n≤2） |
| ARCHIVED | 档案记录完成 | archivist |
| DELIVERED | 交付给用户 | 技术总监 |
| BLOCK | 冲突无法解决，上报 | 任何角色 |

- `DRAFTED → VERIFIED` 是**代码特有**的机器门：fmt / lint / typecheck / build / test 全过才允许进审校。机器门不过不许派 reviewer（省一次昂贵的模型审查）。
- `REVIEWED(REVISE) → REVISION_n → VERIFIED → REVIEWED`，最多两轮；第二轮仍 REVISE 就转 BLOCK 交用户裁决。

---

## 5. 两道门

### 5.1 自动机器门 `code_check`
技术总监被禁 shell，`code_check` 是唯一跑命令的窄通道。命令由总监按仓库实际给出，逐条跑，返回 exit code 与输出尾部。
- 典型：`npm run lint` / `npm run typecheck` / `npm run build` / `npm test` / `cargo clippy` / `go vet ./...`
- 全部 `code===0` 且非超时才 PASS。任一失败 → 回 implementer，不进审校。
- 只读回执，不改文件；需要格式化（会改文件）就派 gopher 跑，不要用 `code_check` 落盘。

### 5.2 人工审校门 `reviewer`
独立、不改代码、十二项检查（正确性 / 契约 / 安全 / 性能 / 可读性 / 过度设计 / 重复造轮子 / 测试充分性 / 根因 / 破坏性变更 / 交付说明 / 回滚性）。
- 只报 S1（阻断）/ S2（建议）/ PASS。
- 硬规则：**结构性问题（信息密度、重复、可读性）只能做减法或改结构，不许用「补充细节」掩盖。**
- 派 reviewer 前先跑 `code_review`（机器可判的廉价项：待办标记 / console.log / debugger / any / 空 catch /
  超长文件函数 / 硬编码密钥正则），把廉价问题就地清掉，让人工审校只专注语义级判断。

### 5.3 派单前评估门 `code_eval`（对齐 SuperAgent 的 Eval 阶段）
零依赖、不调 LLM，只按任务单字面完整度与角色匹配度裁决 `proceed / clarify / reject`：
- 缺 `objective` / `source_paths` / `acceptance` → 在 `auto` 模式下 `clarify` 或 `reject`；`observe`（默认）只警告。
- 零写角色（tech-lead / impact / reviewer / security / archivist）却给了 `write_scope` → 报警提醒确认。
- 需要写文件的角色却没给 `write_scope` → 提醒显式限定（否则等于放行全部路径）。
- 用法：派出前 `code_eval {role, objective, source_paths, acceptance, write_scope, mode:"auto"}`，`clarify`/`reject` 就补齐再派。

### 5.4 辅助扫描：`code_map` 与 `code_kb`
- `code_map`：递归读各包清单（package.json / go.mod / Cargo.toml / pyproject.toml / requirements.txt / pom.xml），
  建内部依赖有向图、列外部依赖、找**循环依赖**。改一处前看会牵动谁，或切分/合并包前查有没有环。
- `code_kb`：代码范例库。把「写对了的代码」按语义（ollama bge-m3 向量，不可用退词法）沉淀可检索范例，
  写代码前 `code_kb search` 挑最贴近的几条注入上下文。存 `<repo>/.codewrite/kb/index.json`。

---

## 6. 账本（code_task）

- 派单前 `code_task open {goal, parent_id?, write_scope}` → 拿 task id。
- `code_dispatch` 会自动 claim 再派；子 Agent 结算时宿主把结果送回总监对话，编排器自动 settle。
- 租约默认 30s；长任务由编排器定时 `renewLease`，人不必手动。
- 过期任务：`code_task reclaim` 收回（返回 `{reclaimed, quarantined}`；quarantined 是「有租约状态却没有 lease_until」的自相矛盾任务，不自动回收，需人看）。
- 版本号挡静默覆盖：settle 必须带对 `version`，不对就是 `VERSION_CONFLICT`，绝不覆盖别人的成果。

---

## 7. 平行版本（variants）

用户举棋不定时，用 `code_dispatch` 的 `variants: ["最小改动","重构清晰","防御式"]`：
- 每个侧重各开一笔独立 `write_scope` 任务（模板里 `{v}` 替换成侧重名，**每条 scope 必须含 `{v}`**，否则共享目标互相覆盖，当场拒绝）。
- 只出粗实现，**不过机器门、不过审校**——省 token，先把「往哪个方向做」摆给用户挑。
- 收齐后把每版侧重与改动摆给用户，不替他挑；选定后 `code_task(action:"pick", id:父任务, child_id:选中子会话)`
  作废其余、结算父任务，再派 fixer/gopher 把选定版落成正式文件、进机器门与审校。

---

## 8. 失败处理：三问纪律

任何角色报「工具缺陷 / 平台限制 / 绕不过去」前，必须回答：
1. **原始错误文本与错误码**是什么（原样贴）。
2. 做过哪一步**能推翻自己猜测的对照检查**。
3. 有没有**现成的正确通道**没用（改文件前先 read、用包管理器命令而非手改 lockfile…）。

三问答不上来只能是 BLOCK（「已尝试 X，得到错误 Y，未确认原因」），**不得**宣称平台缺陷、不得新建 `xxx-v2` 文件绕开、不得让用户手工改文件。
技术总监收到这类报告先要证据，不原样转述；只有自己复现过、三问都答上的结论才可上报。

---

## 9. ponytail 纪律（贯穿全工作室）

写任何代码前先爬梯子，停在第一个成立的台阶：
1. 这东西需要存在吗？不需要就一行说明跳过（YAGNI）。
2. 仓库/标准库已经有吗？先 grep 复用，别重造。
3. 标准库能做吗？4. 平台原生能力覆盖吗？5. 已装依赖能解决吗？6. 能一行写完吗？
7. 只有以上都不成立，才写能跑通的最小实现。

- 最短可工作 diff 胜出，但前提是真读懂问题：先读完要改的每个文件、追完调用链再动手。
- 修 bug 找根因：改共享函数里的守卫，比在每个调用点加守卫更小；动手前 grep 全部调用方。
- 不做没要求的抽象：单实现的接口、单产品的工厂、永不变的值做配置——都删。
- 非平凡逻辑（分支/循环/解析/钱与安全路径）留一个能跑的最小自检；不铺框架、不写夹具。
- 审校的「过度设计」项就是专门抓违反本节的代码，抓到一个点一个。

---

## 10. 与 SuperAgent 的接线（Layer B，可选，已给现成资产）

SuperAgent 的主链是 Source→Trigger→**Eval**→Mandate→Ticket→Assignment→Executor→Channel；它的每个
Executor Session 用 `WORKER_PRESET` 建、用 `initializeRoleModel` 钉角色模型。本工作室对这两点各接一半：

- **Eval 阶段** →`code_eval` 工具（见 §5.3）。派单前先评一次，把「缺字段不得派」落成可执行的门。
- **Executor 预设** → `presets/code-editor/superagent-worker.override.yml`。
  SuperAgent 在 `src/app/sessions.ts:48` 把 `WORKER_PRESET='dsh-superagent-worker'` 写死成常量，建 Session 时
  直接取它；要让执行器换预设，唯一不 fork 源码的办法是**覆盖同 id 的 preset 行**（`dsh-superagent-worker-preset`），
  在其 persona 里注入代码工作室纪律、工具集与 5 秒前台 shell 原样保留。把那份 override 整行 merge 进 profile 的
  `cordis.patch.yml` 即可（config 整体替换、不深 merge，故该文件已把 worker 所需插件重述完整）。
- Layer A（本文，对话式、人在环）与 Layer B（SuperAgent 事件驱动）共用同一批角色卡与 `code_task` 账，不重复定义。
  13 个角色、一本账（`code_task`）、两道门在任何一边都成立。
