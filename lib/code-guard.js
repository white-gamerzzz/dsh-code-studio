/**
 * 技术总监硬限制：code-editor 预设里的技术总监 Agent 只能「输出工作流 + 派单」，
 * 不能自己把代码写下去。
 *
 * 这是**预设子插件**（挂在 code-editor 的 plugins 数组里），ctx 一定是 scoped 的
 * preset 上下文：`ctx.tools.guard(...)` 只对使用本预设的会话生效，不污染别的 Agent。
 * 子 Agent（架构/实现/审校……）与总监共享同一个 generation，所以 guard 内部必须
 * 按「是不是子 Agent」放行，否则实现 Agent 连 write 都用不了。
 *
 * 用 guard 而不是 `tools.restrict()`：restrict 只能按工具名过滤、且对该作用域链上
 * 的所有 Agent 一刀切，无法区分总监与实现 Agent；guard 每次执行前都能拿到
 * `exec.agent`，据此区分，也才能给出「改走派单」的可操作提示。
 *
 * 硬约束：本文件不要加 `export default`（cordis 的 unwrapExports 会取 exports.default）。
 */

// 必须与 lib/index.js import 同一个路径：ESM 按解析后的绝对路径缓存模块实例，
// 同一 Node 进程内两边拿到的是同一个 Map。复制实现或改路径会让 write_scope 硬化静默失效。
import { writeScopeReason, sessionIdOf, sessionCwdOf, markOf, normalizePath, countChildrenOf } from './session-roles.js';
import { MAX_GROUPS } from './studio-dispatch.js';

/** 记忆目录前缀（相对仓库根）。 */
const EDITOR_MEMORY_PREFIX = '.codewrite/editor/';

/** 插件名。 */
export const name = 'code-studio-guard';

/** 只需要 tools；systemPrompt 是可选增强，用 ctx.get 取，不写进 inject。 */
export const inject = ['tools'];

/** 技术总监被硬限制的工具 -> 拒绝理由（原样回给模型，要能直接照做）。 */
export const DENIED_TOOLS = Object.freeze({
  write: '技术总监不直接写文件。把这次改动写成任务单，用 code_dispatch 交给对应的子 Agent 落地，你只负责工作流与汇总。',
  edit: '技术总监不直接改文件。把要改的内容写进子 Agent 的任务单，由它落地。',
  pwsh: '技术总监不直接执行命令（命令可以改文件、可以跑测试但不该由你落盘）。查代码请用 read / glob / grep；需要落盘就派子 Agent。',
  bash: '技术总监不直接执行命令（命令可以改文件）。查代码请用 read / glob / grep；需要落盘就派子 Agent。',
  subagent: '技术总监不要直接用 subagent：请用 code_dispatch 派单，它才会套用设置页里该角色的模型。',
  subagent_fork: '技术总监不要直接用 subagent_fork：请用 code_dispatch 派单，它才会套用设置页里该角色的模型。',
});

/** 系统提示词里的可读声明：只在 guard 真正生效的总监身上出现，子 Agent 不显示。 */
export const CODE_GUARD_HINT = [
  '## 你是技术总监：默认产出是工作流，不是代码',
  '默认动作 = 先给出一份任务编排（谁做什么、依赖顺序、交付物），再用 code_dispatch 派单；实现、测试、审校、修订都由子 Agent 落地。',
  '你自己只读：read / glob / grep / code_brief / code_state / code_check。',
  `本会话已硬限制这些动作：${[...Object.keys(DENIED_TOOLS)].join(' / ')}。`,
  '唯一例外：`.codewrite/editor/` 下的 `.md`（你的记忆文件）你可以直接写，不用派单。',
  '被拒绝时不要重试、也不要换等价写法绕过；直接改走派单。子 Agent 不受这些限制。',
  '## 不要倾倒代码（你的输出窗口不是仓库）',
  '**严禁把整份文件、整段 diff 复制进你的回复**——需要人看时只给定位（哪个文件、哪一行/哪个函数、什么问题、怎么改）与判据；要全文就派子 Agent 去读，让它交结论而不是原文。',
  '## 按改动大小分档（别把小事拖成大工程）',
  '- 小改（1-2 文件、逻辑直白）：1 个 implementer → code_check → 1 个 reviewer，不要派 planner。',
  '- 中改（多文件/新接口/改数据结构）：planner 一次出「架构取舍+契约+文件改动清单」→ implementer → code_check → reviewer。',
  '- 大改/险改（跨模块/动信任边界）：再加 security / test，方向不定先让 planner 出方案对比。',
  '## 两条交给专门角色的活',
  '机械活（重命名、搬文件、批量改 import、生成 changelog、跑格式化、文档对齐、档案记录）派 `maintenance`，一次把清单列全给它，不要为十件小事派十次单。',
  '## 归因是复核点，不是传声筒',
  '子 Agent 报「工具缺陷 / 平台限制 / 绕不过去」时不要原样转述：先要原始错误码、再要它做过哪一步对照检查、再确认插件有没有现成通道没用。答不上来就退回补证据。',
].join('\n');

/**
 * 判断一个 Agent 是否为委派出来的子 Agent。
 * 持久化 session header 是权威来源（`origin: 'subagent'` / `delegationDepth`），
 * runtime options 只能加深，不能降。
 */
export function isSubAgent(agent) {
  const header = agent?.session?.header;
  if (header?.origin === 'subagent') return true;
  const persisted = Number(header?.delegationDepth);
  const runtime = Number(agent?.options?.subagentDepth);
  const depth = Math.max(Number.isFinite(persisted) ? persisted : 0, Number.isFinite(runtime) ? runtime : 0);
  return depth > 0;
}

/**
 * guard 本体：同步检查，返回字符串即拒绝该次执行。
 */
export function codeGuardReason(exec) {
  const agent = exec?.agent;
  if (agent === undefined) return undefined;

  // 子 Agent 是代码的生产者，必须放行 —— 但**先按它这一步的 write_scope 卡边界**。
  // 顺序不能反：先放行就永远走不到越界检查，并行出稿会静默互相覆盖。
  if (isSubAgent(agent)) {
    // 深度闸：子 Agent 只能经由 code_studio dispatch（按 region 复用）落地，
    // 不许用裸 code_dispatch 另开一条一次性枝杈 —— 那会绕过 region 持久化，且不受分组闸约束。
    // 分组闸的权威在 studio-dispatch.dispatchIssue（按 region 在飞数）；这里只补两条通用禁区。
    if (exec?.name === 'code_dispatch') {
      if (String(exec?.arguments?.role ?? '') === 'tech-lead') {
        return '子 Agent 不得再派 tech-lead（子技术总监不许再叫子技术总监）。改用 code_studio dispatch。';
      }
      if (countChildrenOf(sessionIdOf(agent)) >= MAX_GROUPS) {
        return `在飞子会话已达 ${MAX_GROUPS} 组，等其中一组结算再派。改用 code_studio dispatch 可自动复用已有持久子会话。`;
      }
      return '子 Agent 不要用 code_dispatch 另开一次性枝杈：请用 code_studio dispatch，它按 region 复用同一持久子会话。';
    }
    return writeScopeReason(exec);
  }

  const tool = exec?.name;

  if (tool === 'write' || tool === 'edit') {
    return isEditorMemoryPath(exec?.arguments?.file_path, sessionCwdOf(agent))
      ? undefined
      : DENIED_TOOLS[tool];
  }
  if (typeof tool !== 'string') return undefined;
  return Object.prototype.hasOwnProperty.call(DENIED_TOOLS, tool) ? DENIED_TOOLS[tool] : undefined;
}

/**
 * 总监的记忆文件白名单：`.codewrite/editor/` 下的 `.md`，且必须在仓库目录内。
 * 判据用**路径形状**而不是绝对路径：仓库目录随会话变。
 */
export function isEditorMemoryPath(value, cwd = '') {
  if (value === undefined || value === null) return false;
  const raw = String(value).trim();
  if (!raw) return false;
  const path = normalizePath(raw);
  const base = cwd ? normalizePath(cwd) : '';
  const relative = base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
  if (relative.startsWith('/') || /^[A-Za-z]:\//.test(relative)) return false;   // 仓库目录外
  if (!relative.startsWith(EDITOR_MEMORY_PREFIX)) return false;
  return relative.slice(EDITOR_MEMORY_PREFIX.length).length > 0 && relative.endsWith('.md');
}

/** 取当前子会话手里的任务信息，供拒绝文案与诊断使用。 */
export function currentMark(agent) {
  return markOf(sessionIdOf(agent));
}

/**
 * 挂载：一条 guard + 一段只对总监显示的系统提示词。
 */
export function apply(ctx) {
  ctx.effect(() => {
    if (typeof ctx.tools?.guard !== 'function') {
      ctx.logger?.warn?.('dsh-plugin-code-studio: tools.guard() 不可用，总监硬限制未生效（需要较新的 dsh-tools）');
      return () => {};
    }
    return ctx.tools.guard(codeGuardReason);
  }, 'code-studio: editor guard');

  ctx.effect(() => {
    const prompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined;
    if (typeof prompt?.section !== 'function') return () => {};
    const base = prompt.getSectionOrder?.('TOOL_SUBAGENT');
    const order = Number.isFinite(base) ? base - 70 : 3000;
    return prompt.section({
      name: 'code-studio: editor guard',
      order,
      text: (context) => {
        const scope = context?.scope;
        if (scope === undefined || isSubAgent(scope)) return '';
        return CODE_GUARD_HINT;
      },
    });
  }, 'code-studio: editor guard prompt');
}
