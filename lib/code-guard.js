/**
 * 主 Agent 硬限制：code-editor 预设里的主 Agent 只做「备单 + 组织 + 合并」，
 * 不在主工作树里写代码。插件不派子 Agent——起子会话由主 Agent 自己来，来源不限。
 *
 * 这是**预设子插件**（挂在 code-editor 的 plugins 数组里），ctx 一定是 scoped 的
 * preset 上下文：`ctx.tools.guard(...)` 只对使用本预设的会话生效，不污染别的 Agent。
 * 子会话与主 Agent 共享同一个 generation，所以 guard 内部必须
 * 按「是不是子会话」放行，否则干活的一方连 write 都用不了。
 *
 * 用 guard 而不是 `tools.restrict()`：restrict 只能按工具名过滤、且对该作用域链上
 * 的所有 Agent 一刀切；guard 每次执行前都能拿到 `exec.agent`，据此区分。
 *
 * 硬约束：本文件不要加 `export default`（cordis 的 unwrapExports 会取 exports.default）。
 */

// 必须与 lib/index.js import 同一个路径：ESM 按解析后的绝对路径缓存模块实例，
// 同一 Node 进程内两边拿到的是同一个 Map。复制实现或改路径会让 write_scope 硬化静默失效。
import { writeScopeReason, sessionIdOf, sessionCwdOf, markOf, normalizePath } from './session-roles.js';

/** 记忆目录前缀（相对仓库根）。 */
const EDITOR_MEMORY_PREFIX = '.codewrite/editor/';

/** 插件名。 */
export const name = 'code-studio-guard';

/** 只需要 tools；systemPrompt 是可选增强，用 ctx.get 取，不写进 inject。 */
export const inject = ['tools'];

/** 主 Agent 被硬限制的工具 -> 拒绝理由（原样回给模型，要能直接照做）。 */
export const DENIED_TOOLS = Object.freeze({
  write: '主 Agent 不在主工作树里写文件。用 code_studio submit 备单（开副本）后，把任务单投给你自己起的子会话，让它在副本里落地。',
  edit: '主 Agent 不在主工作树里改文件。把要改的内容写进任务单（submit 备单），由子会话在副本里落地。',
  pwsh: '主 Agent 不在主工作树里执行命令（命令可以改文件）。查代码请用 read / glob / grep；需要落盘的活交给子会话在副本里做。',
  bash: '主 Agent 不在主工作树里执行命令（命令可以改文件）。查代码请用 read / glob / grep；需要落盘的活交给子会话在副本里做。',
});

/** 系统提示词里的可读声明：只在 guard 真正生效的主 Agent 身上出现，子会话不显示。 */
export const CODE_GUARD_HINT = [
  '## 你的默认产出是工作流，不是代码',
  '默认动作 = 用 code_studio submit 备单 → 自己起一个子会话（cwd 用返回的副本路径）投任务单 → code_studio set childId 登记 → 结算后 code_merge 合并。实现、测试、审校都由子会话落地，来源不限。',
  '你自己只读：read / glob / grep / code_brief / code_state / code_check。',
  `本会话已硬限制这些动作：${[...Object.keys(DENIED_TOOLS)].join(' / ')}。`,
  '唯一例外：`.codewrite/editor/` 下的 `.md`（你的记忆文件）你可以直接写。',
  '被拒绝时不要重试、也不要换等价写法绕过；直接走备单流程。子会话不受这些限制。',
  '## 不要倾倒代码（你的输出窗口不是仓库）',
  '**严禁把整份文件、整段 diff 复制进你的回复**——需要人看时只给定位（哪个文件、哪一行/哪个函数、什么问题、怎么改）与判据；要全文就让子会话去读，让它交结论而不是原文。',
  '## 按改动大小分档（别把小事拖成大工程）',
  '- 小改（1-2 文件、逻辑直白）：一个子会话写完 → code_check → 交付。',
  '- 中改（多文件/新接口/改数据结构）：先出「架构取舍+契约+文件改动清单」再实现。',
  '- 大改/险改（跨模块/动信任边界）：另派一个零写权限的旁路子会话只出审校报告。',
  '## 归因是复核点，不是传声筒',
  '子会话报「工具缺陷 / 平台限制 / 绕不过去」时不要原样转述：先要原始错误码、再要它做过哪一步对照检查、再确认插件有没有现成通道没用。答不上来就退回补证据。',
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

  // 子会话是代码的生产者，必须放行 —— 但**先按它这一步的 write_scope 卡边界**。
  // 顺序不能反：先放行就永远走不到越界检查，并行出稿会静默互相覆盖。
  if (isSubAgent(agent)) {
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
 * 主 Agent 的记忆文件白名单：`.codewrite/editor/` 下的 `.md`，且必须在仓库目录内。
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
 * 挂载：一条 guard + 一段只对主 Agent 显示的系统提示词。
 */
export function apply(ctx) {
  ctx.effect(() => {
    if (typeof ctx.tools?.guard !== 'function') {
      ctx.logger?.warn?.('dsh-plugin-code-studio: tools.guard() 不可用，主 Agent 硬限制未生效（需要较新的 dsh-tools）');
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
