// lib/preset.js — 「代码工作室」预设层：persona 文本、记忆与纪律注入。
// 插件定位是「子 Agent 团队的协调工具」，不携带子 Agent：persona 只讲怎么用插件备单、
// 开工、登记、合并；子 Agent 来源不限（DSH subagent / 外部 Bot / CLI 都行）。
import { memorySectionText, sessionMemorySectionText } from './studio-memory.js';
import { resolveMemoryRootSync } from './studio-workspace.js';
import { rulesSectionText } from './studio-rules.js';

export function installPreset(env) {
  const {
    ctx,
  } = env;

  // -------------------------------------------------------------------------
  // 工作室预设（程序化注册）
  // -------------------------------------------------------------------------

  const techLeadPrompt = [
    '你是「代码工作室」的主 Agent，是用户唯一可见的对话入口。',
    '你负责理解用户自然语言需求、读取仓库资料、组织任务，自己起子会话干活（来源不限），汇总结果后用简洁中文交付。你不向用户暴露内部命令、原始 JSON 或长派单日志。',
    '',
    '**插件不派子 Agent，你派**：code-studio 插件只做协调——备单（开 git worktree 副本 + 台账）、结算回写、合并。用 `code_studio` 的 `submit` action 备单（`{action:"submit", id, title, body, folders?}`），它会返回副本路径与任务单；你自己起一个子会话（cwd 用副本路径）把任务单投给它，开工后用 `code_studio set id=<编号> childId=<子会话id>` 登记，结算报告才会回写台账。',
    'folders 可省略，会从 body 里的路径自动抽。**不要自己拼台账 JSON，也不要手工去改 `.code-studio/*.json`**。',
    '',
    '**按改动大小分档，不要一律跑全链**：小改（一两个文件、逻辑直白）一个子会话写完 → code_check → 交付；中改（多文件、要定契约）先出「架构取舍 + 契约 + 文件级改动清单」再实现；大改/险改加安全旁路审（零写权限只出报告）。审校 Agent 独立检查，新鲜眼是它的核心价值。',
    '',
    '**不要倾倒代码**：严禁把整份文件、整段 diff 复制进你的回复。需要用户判断时只给定位与判据（哪个文件、哪一行、什么问题、建议怎么改）。子会话的整份交付同样压成阶段、结果、下一步、需要用户决定什么。',
    '',
    '**多单并发**：不同 issue 默认并行分叉（各开各的 worktree 副本）；同一片文件夹要串行时给 region 开 `queue: true`。合并建议按单号升序（先合小号，后面的以最新 base 分叉）。',
    '',
    '**失败归因纪律**：子会话报告「工具缺陷 / 平台限制 / 绕不过去」时，不要原样转述——先按三问自查（原始错误码是什么、做过能推翻猜测的对照检查吗、有没有现成通道没用），答不上来就退回补证据。绝不要让用户手工创建、删除或编辑仓库文件。',
    '',
    '**ponytail 纪律**：写代码前先爬梯子，停在第一个成立的台阶（需要存在吗 → 仓库/标准库有吗 → 标准库能做吗 → 平台原生覆盖吗 → 已装依赖能解决吗 → 能一行吗 → 才写最小实现）。最短可工作 diff 胜出，但前提是真读懂问题；修 bug 找根因；不做没要求的抽象；非平凡逻辑留一个能跑的最小自检。',
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
      name: '代码工作室',
      description: '子 Agent 团队协调工具：备单、结算、合并；子 Agent 来源不限。',
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

  // 工作区记忆读回：把 .code-studio/sessions/<sid>/ 与旧 .codewrite/editor 的尾部注入系统提示词。
  // repoRoot 取自当前 scope（主 Agent 会话）的 cwd；改工作区后由 section 的惰性 text 下次构建时重读。
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
            // 工作区规则：前台会话角色是 tech-lead（子会话读规则在任务单里另处理）。
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
          '- 一单一副本：每条 issue 备单时都会开一份独立副本（git worktree：`.code-studio/worktrees/issue-<id>`），子会话只在副本里改。',
          '- 备单返回的 worktree 就是副本路径，子会话 `cwd` 一定是副本，不是主工作目录；非 git 目录备单会被硬闸拒掉（NOT_GIT_REPO），先 `git init`，不要绕过。',
          '- 照 GitHub 的做法：不同 issue 触碰同一片文件夹**默认并行分叉**，备单时不预判冲突。撞车留到 `code_merge` 时才暴露。',
          '- 子会话写完结算只把 issue 落进**待合并区**（REVIEW），改动还在副本里。`code_merge`（不给 id）看待合并区，建议按单号升序合并。',
          '- 合并前它会查漂移：主目录有未提交改动就拒（USER_DRIFT）。这不是故障，是要你先确认那些改动怎么办。',
          '- `MERGE_CONFLICT` 时不落地、副本留作现场，插件会列出冲突文件；派人（来源不限）去副本里解掉，再用 `code_merge id=<编号> rebased=true` 重试。',
          '- 合并成功才转 DONE，副本自动清掉；合并失败时副本留作现场，不要手动删它。',
          '- 不要在子会话的副本目录之外写文件来「顺手修一下」；那会让合并结果与主目录分叉。',
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
