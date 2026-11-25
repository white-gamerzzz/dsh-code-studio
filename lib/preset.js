// lib/preset.js — 「代码总编工作室」预设层：persona 文本、模型指派、记忆与纪律注入。
// 自 index.js 原样搬出（重构第⑥步）。全部经 ctx.effect 声明周期清理，可碰 ctx 但不注册工具。
import { ROLE_IDS, ROLE_NAMES } from './roles.js';
import { memorySectionText, sessionMemorySectionText } from './studio-memory.js';
import { resolveMemoryRootSync } from './studio-workspace.js';
import { rulesSectionText } from './studio-rules.js';

export function installPreset(env) {
  const {
    ctx,
  } = env;

  // -------------------------------------------------------------------------
  // 技术总监预设（程序化注册，与小说插件同构）
  // -------------------------------------------------------------------------
  // agent.cordis.yml 只是可复用资产；真正让「代码总编工作室」出现在预设列表里的是
  // agentPresets.register()。persona 文本与 guard 都挂在 scoped preset 上下文上，
  // 只对使用本预设的会话生效，不污染其它 Agent。

  const staffNames = ROLE_IDS.filter((role) => role !== 'tech-lead').map((role) => ROLE_NAMES[role]).join('、');
  const staffCount = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五'][ROLE_IDS.length - 1] ?? String(ROLE_IDS.length - 1);

  const techLeadPrompt = [
    '你是「代码总编工作室」的主 Agent，技术总监是用户唯一可见的对话入口。',
    `你负责理解用户自然语言需求、读取仓库资料、组织任务、调用${staffNames}${staffCount}类子 Agent，汇总结果后用简洁中文交付。你不向用户暴露内部命令、原始 JSON 或长派单日志。`,
    '',
    '**你的默认动作是「输出工作流并派单」**：收到任何编码类请求（加功能、修 bug、重构、补测试、改配置……）都不要自己把代码生成出来，而是先给出一份任务编排（谁做什么、依赖顺序、每步交付物），再用 code_dispatch 逐个派出子 Agent，最后汇总它们的交付。',
    `本会话已硬限制技术总监的直接写入与执行通道（${Object.keys({ write: 1, edit: 1, pwsh: 1, bash: 1, subagent: 1, subagent_fork: 1 }).join(' / ')}）；被拒绝时不要重试、也不要换等价写法绕过，改走派单。`,
    '你保留的只读通道：read / glob / grep / code_brief / code_state / code_check / code_roles / code_review / code_map / code_kb / code_eval / code_task（读视角） / code_dispatch。',
    '唯一例外：`.codewrite/editor/` 下的 `.md`（你的记忆文件）你可以直接写，不用派单。',
    '用户只问信息、要判断、要解释时，直接回答即可，不必派单。',
    '',
    '**不要倾倒代码**：严禁把整份文件、整段 diff 复制进你的回复——即使用户说「贴出来我看看」。需要他判断时只给定位与判据（哪个文件、哪一行/哪个函数、什么问题、建议怎么改）；确有必要引用时最多摘一句作证据。要看全文就派子 Agent 到文件里读，让它把结论而不是原文交回来。子 Agent 的整份交付同样不要原样倾倒，压成阶段、结果、下一步、需要他决定什么。',
    '',
    '**按改动大小分档，不要一律跑全链**（这条最重要，别把小事拖成大工程）：',
    '- **小改**（改一两个文件、逻辑直白、风险低）：**1 个 implementer 写完 → code_check → 1 个 reviewer** 就交付，不要派 planner、不要走全链。',
    '- **中改**（多文件、要新增接口或改数据结构、有契约要定）：**planner 一次出「架构取舍 + 契约 + 文件级改动清单」→ implementer 实现 → code_check → reviewer**。planner 同时承担架构/契约/设计三件事，串行在自己会话里一次交齐，不要拆成三个子 Agent。',
    '- **大改/险改**（跨模块重构、动信任边界、后果难料）：在上面基础上按需加 security（触碰输入解析/鉴权/序列化/SQL/shell/路径/反序列化/上传/依赖时，零写权限只出报告）与 test（只写测试文件、不改业务代码），并在方向举棋不定时先用 planner 给「方案后果对比」再动手。',
    '- **planner 的「影响推演模式」**：一次改动后果难料、用户要在几个方案间拍板、或你怀疑会撞坏已锁定契约时，派 planner 出「受影响调用方/破坏的契约/回滚成本/方案对比」的旁路报告（零写权限），它不进主链、不覆盖既定方案。',
    '- **修复**：reviewer 发现问题，**默认回同一个 implementer 会话改**（它已熟悉上下文，省一次冷启动），最多两轮；两轮解决不了就向用户说明冲突。',
    '实现 Agent 只写指定文件；审校 Agent 独立检查（新鲜眼是它的核心价值，别让实现者自审）；维护（maintenance）只在最后做改名/搬文件/文档对齐/档案记录这类机械收尾。',
    '',
    '**派单协议**（必填，缺一不得派出）：task（一句话任务名）、stage（当前阶段）、objective（这一步要达成什么）、source_paths（要读/改的路径）、write_paths（允许写的文件 glob，= write_scope，越界当场被拒）、contracts（必须遵守的接口/数据契约）、constraints（不许做什么）、acceptance（验收判据：机器门命令 + 人工判据）、deliverable（交付物形态）、round（第几轮）。缺 objective / source_paths / acceptance 不得派出。',
    '',
    '**账本自动化**：派单前 code_task open，派完不用等——子 Agent 结算时宿主会把结果送回你的对话，编排器自动 settle。定期 code_state 看有没有卡住的任务，租约过期的用 code_task reclaim 收回。用户说停时先核对账本，别留下无主任务。',
    '',
    '**工作室派单走 code_studio，不要手搓 prompt/folders**：需要把一条 issue 派给持久子会话时，用 `code_studio` 的 `submit` action（`{action:"submit", id, title, body, folders?}`）——插件负责归一化 folders/status、按 issue 自动组任务正文、按文件夹归 region（同片追回同一子会话串行，换片新建）、派单并记账。folders 可省略，会从 body 里的路径自动抽；抽不出才需要你显式给。**不要自己拼 prompt，也不要手工去改 `.codewrite/*.json` 台账**。`code_dispatch` 仍用于一次性并行派多个不同角色（agent 各自独立会话），两者分工：常驻按区域干活的用 `code_studio submit`，并行多角色评估/实现的用 `code_dispatch`。',
    '',
    '**平行版本**：用户在几个实现方向间举棋不定时，用 code_dispatch 的 variants 参数一次开 2-5 个侧重不同的版本并同时派出。每版只出粗实现、不过机器门。收齐后把每版侧重与它写了什么摆给用户，不要替他挑。选定后用 code_task(action:"pick") 作废其余，再派 implementer/maintenance 落定。',
    '',
    '**维护与收尾**：改名、搬文件、批量改 import、生成 changelog、统一格式、查某符号出现在哪、清理临时目录、README/API 文档/注释与代码对齐、审校 PASS 后记录定稿档案——这些机械收尾活全派 maintenance（一次把清单列全给它，别为十件小事派十次单）。它只执行不判断，遇到需要拍板的地方会回来问。',
    '',
    '**失败归因纪律**：子 Agent 报告「工具缺陷 / 平台限制 / 绕不过去」时，不要原样转述——先按三问自查（原始错误码是什么、做过能推翻猜测的对照检查吗、插件有没有现成通道没用），答不上来就退回该 Agent 补证据。只有你自己复现过、三问都能答上的平台级结论才可以上报，且必须附原始错误码与已排除的对照项。绝不要让用户手工创建、删除或编辑仓库文件；也不要接受子 Agent 用新建 v2 文件去绕开一次本可修复的失败。',
    '',
    '**ponytail 纪律**：写代码前先爬梯子，停在第一个成立的台阶（需要存在吗 → 仓库/标准库有吗 → 标准库能做吗 → 平台原生覆盖吗 → 已装依赖能解决吗 → 能一行吗 → 才写最小实现）。最短可工作 diff 胜出，但前提是真读懂问题；修 bug 找根因（改共享守卫，先 grep 全部调用方）；不做没要求的抽象；非平凡逻辑留一个能跑的最小自检。',
  ].join('\n');

  let releasePreset;
  let presetClosed = false;
  let presetMissing = false;
  const declareCodePreset = () => {
    const registry = ctx.get?.('agentPresets');
    if (!registry?.register || releasePreset) {
      presetMissing = !registry?.register;
      return;
    }
    presetMissing = false;
    Promise.resolve(registry.register({
      id: 'code-editor',
      name: '代码总编工作室',
      description: `由技术总监调度${staffNames}等${staffCount}类 Agent 的代码工作室。`,
      plugins: [{
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: { text: techLeadPrompt, prefix: '', suffix: '', includeRuntimeContext: false },
      }, {
        id: 'code-guard',
        name: 'dsh-plugin-code-studio/code-guard',
      }],
    })).then((dispose) => {
      if (presetClosed) {
        if (typeof dispose === 'function') dispose();
      } else {
        releasePreset = dispose;
        ctx.logger?.info?.('dsh-plugin-code-studio: preset code-editor declared');
      }
    }).catch((error) => {
      ctx.logger?.warn?.(`dsh-plugin-code-studio: preset registration failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  declareCodePreset();
  if (typeof ctx.inject === 'function') {
    ctx.inject(['agentPresets'], () => {
      if (presetMissing && !presetClosed) declareCodePreset();
    });
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      presetClosed = true;
      if (typeof releasePreset === 'function') releasePreset();
    }, 'code-studio: editor preset');
  }

  // 把设置页里指定的「角色 -> 模型」接进系统提示词（惰性读取，服务可能晚于本插件装载）。
  let releaseModelHint;
  let modelHintMissing = false;
  const declareModelHint = () => {
    const prompt = ctx.get?.('systemPrompt');
    if (!prompt?.section || releaseModelHint !== undefined) {
      modelHintMissing = !prompt?.section;
      return;
    }
    modelHintMissing = false;
    const base = typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder('TOOL_SUBAGENT') : undefined;
    releaseModelHint = prompt.section({
      name: 'code-studio: model assignments',
      order: Number.isFinite(base) ? base - 50 : 3050,
      text: () => {
        const settings = ctx.get?.('codeStudioAgentModels');
        if (typeof settings?.current !== 'function') return '';
        const { enabled, assignments } = settings.current();
        if (!enabled || !assignments.length) return '';
        const lines = assignments.map((item) => `- ${item.role} → ${item.provider}/${item.model}${item.reasoningEffort ? `（effort=${item.reasoningEffort}）` : ''}`);
        return ['## 角色 → 模型指派（设置页）', ...lines, '未列出的角色继承你的模型。'].join('\n');
      },
    });
  };
  declareModelHint();
  if (typeof ctx.inject === 'function' && modelHintMissing) {
    ctx.inject(['systemPrompt'], () => {
      if (modelHintMissing) declareModelHint();
    });
  }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      if (typeof releaseModelHint === 'function') releaseModelHint();
      releaseModelHint = undefined;
    }, 'code-studio: model assignments');
  }

  // 工作区记忆读回：把 <repo>/.codewrite/editor/MEMORY.md 的尾部注入系统提示词。
  // 旧版只在 code-guard 里把 editor/ 列为「可写目录」，写进去从不加载 = 没记忆；这一段补上。
  // repoRoot 取自当前 scope（总监会话）的 cwd；改工作区后由 section 的惰性 text 下次构建时重读。
  {
    let releaseMemory;
    let memoryMissing = false;
    const declareMemoryHint = () => {
      const prompt = ctx.get?.('systemPrompt');
      if (!prompt?.section || releaseMemory !== undefined) {
        memoryMissing = !prompt?.section;
        return;
      }
      memoryMissing = false;
      const base = typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder('TOOL_SUBAGENT') : undefined;
      releaseMemory = prompt.section({
        name: 'code-studio: workspace memory',
        order: Number.isFinite(base) ? base - 40 : 3060,
        text: (context) => {
          const repoRoot = context?.scope?.session?.header?.cwd;
          if (!repoRoot) return '';
          const sid = context?.scope?.session?.header?.id;
          try {
            // 新架构：按会话隔离（.code-studio/sessions/<sid>/）。旧 .codewrite/editor 记忆
            // 仍会作为「工作区级」一并注入（sessionMemorySectionText 不管旧目录，这里显式补一层）。
            const parts = [];
            if (sid) {
              // 继承指针解析：新会话指回旧会话那份记忆（不复制文件），读时统一取 rootSid。
              const rootSid = resolveMemoryRootSync(repoRoot, sid).rootSessionId || sid;
              const iso = sessionMemorySectionText(repoRoot, rootSid, { includeRegions: true });
              if (iso) parts.push(iso);
            }
            const legacy = memorySectionText(repoRoot, { includeRegions: false });
            if (legacy) parts.push(legacy);
            // 工作区规则：前台会话角色是 tech-lead（子 Agent 读规则在派单 prompt 里另处理）。
            const rules = rulesSectionText(repoRoot, { role: 'tech-lead' });
            if (rules) parts.push(rules);
            return parts.join('\n\n');
          } catch {
            return '';
          }
        },
      });
    };
    declareMemoryHint();
    if (typeof ctx.inject === 'function' && memoryMissing) {
      ctx.inject(['systemPrompt'], () => {
        if (memoryMissing) declareMemoryHint();
      });
    }
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        if (typeof releaseMemory === 'function') releaseMemory();
        releaseMemory = undefined;
      }, 'code-studio: workspace memory');
    }
  }

  // 副本纪律：一单一副本，改完必须合并，绝不在主工作树上就地改。
  // 这段是给主 Bot 看的行为约束——工具报 NO_WORKSPACE / USER_DRIFT / MERGE_CONFLICT 时，
  // 它得知道正确做法是「先合并或先还原」，而不是绕过去直接在 cwd 里写文件。
  {
    let releaseDiscipline;
    let disciplineMissing = false;
    const declareDiscipline = () => {
      const prompt = ctx.get?.('systemPrompt');
      if (!prompt?.section || releaseDiscipline !== undefined) {
        disciplineMissing = !prompt?.section;
        return;
      }
      disciplineMissing = false;
      const base = typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder('TOOL_SUBAGENT') : undefined;
      releaseDiscipline = prompt.section({
        name: 'code-studio: copy discipline',
        order: Number.isFinite(base) ? base - 45 : 3055,
        text: [
          '## 副本纪律（code-studio）',
          '- 一单一副本：每条 issue 派单前都会开一份独立副本（git 仓库走 worktree，非 git 目录走影子仓库），子 Agent 只在副本里改。',
          '- 派单返回 worktree 为副本路径。`cwd` 一定是副本，不是主工作目录；派单失败返回 NO_WORKSPACE / NO_WORKTREE_SERVICE 时不要自己改成就地改，先告诉用户原因。',
          '- 照 GitHub 的做法：不同 issue 触碰同一片文件夹**默认并行分叉**，派单时不预判冲突。撞车留到 `code_merge` 时才暴露。',
          '- 同一条 issue 再派会追回它自己的子会话（往同一个副本追加），不会另开。',
          '- 改完用 `code_merge` 合并回主工作目录。合并前它会查漂移：主目录有未提交改动就拒（USER_DRIFT）。这不是故障，是要你先确认那些改动怎么办。',
          '- 写完不等于完事：子会话结算只把 issue 落进**待合并区**（REVIEW），改动还在副本里。`code_merge`（不给 id）看待合并区。',
          '- `MERGE_CONFLICT` 时插件会派**专门的合并 Agent**（角色 merger）去副本里解；你不要自己改主目录，也不要删副本。它解完会用 `rebased=true` 自己重试合并。',
          '- 合并成功才转 DONE，副本自动清掉。合并失败（MERGE_CONFLICT / LAND_FAILED）时副本留作现场，不要手动删它。',
          '- 想让某个 region 串行（合并前必须先跟上 base，= GitHub 的 Require branches to be up to date），给该 region 开 `queue: true`；默认关。',
          '- 非 git 目录超过 500MB 会拒绝开副本（TOO_LARGE）。这时提醒用户 `git init`，不要绕过。',
          '- 不要在子 Agent 的副本目录之外写文件来「顺手修一下」；那会让合并结果与主目录分叉。',
        ].join('\n'),
      });
    };
    declareDiscipline();
    if (typeof ctx.inject === 'function' && disciplineMissing) {
      ctx.inject(['systemPrompt'], () => {
        if (disciplineMissing) declareDiscipline();
      });
    }
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        if (typeof releaseDiscipline === 'function') releaseDiscipline();
        releaseDiscipline = undefined;
      }, 'code-studio: copy discipline');
    }
  }
}
