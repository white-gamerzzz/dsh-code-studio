/**
 * dsh-plugin-code-studio / dispatch —— 把「角色 → 模型」设置真正接到派单动作上。
 *
 * 历史缺口：设置页能写能存能预览，值只流向系统提示词里的一段文字
 * （`用户已在设置里为以下角色指定模型，派单时必须原样传参`），
 * 而 `subagent` 工具的 parameters 里没有 provider/model ——
 * 总编写了传不出去，那段话是空指令（`routeFor()` 定义在
 * agent-models.js:82 却从未被生产代码调用）。
 *
 * 本模块补齐这段线：读 `novelAgentModels` 的指派，用 `ctx.subagents.startActivation`
 * 直接派生一个钉死 provider/model 的子 Agent。
 * 之所以自己调 subagents 而不是复用 `dsh-tool-subagent`：那个包的 Config 是
 * 静态的，而设置值随时可改；自己调可以在每次派单时现读，改动立刻生效。
 *
 * 这里的语义逐条对齐 dsh-tool-subagent/lib/index.js，不要凭猜测改：
 *   - `SubagentActivationSpec`（dsh-subagent/lib/typert.host.js）：
 *     { provider: string, label: string, childId?: SessionId,
 *       request: SubagentStartRequest, signal: AbortSignal,
 *       delivery: 'parent' | 'caller' }
 *   - `SubagentStartRequest`：
 *     { label?, prompt: ContentBlock[], parent: Agent, signal: AbortSignal,
 *       agentOptions?, outputSchema?, maxDepth?, toolFilter?, persona? }
 *   - `SubagentActivation` = { childId, messageId?, result: Promise<SubagentResult>, dispose() }
 *   - `outputValueText`（:272-274）只取 type==='text' 且 text 为字符串的块
 *   - `stopReasonError`（:287-296）把非 completed 的 stopReason 翻成中文可读原因
 *   - 钉死模型必须走 `spawn` provider：base patch 里 fork 版明确
 *     "Fork omits model selection so provider/model stay equal to the parent"
 *
 * ⚠️ 宿主 44.7.0 起，`SubagentRuntime` 上已没有 `start(provider, request)` 与
 * `startContinuable(spec)` 这对旧方法，两者合并成唯一的 `startActivation(spec)`：
 * 传 `spec.childId` 且 provider 有 `prepareContinuable` 就是常驻子会话
 * （本地后端），否则由 runtime 走 external 一次性后端。所以「常驻 vs 一次性」
 * 现在由 spec 形状决定，不再由调哪个方法决定。
 */

/** 派单用的 provider 名。fork 会强制继承父模型，换不了，所以只能是 spawn。 */
export const SPAWN_PROVIDER = 'spawn';

/** 工具名。一个带 role 参数的入口，避免给模型塞七个几乎相同的 schema。 */
export const DISPATCH_TOOL = 'code_dispatch';

/**
 * 永不中止的 signal，专供常驻派单使用。
 *
 * 为什么必须显式传、且必须是这个：
 *   - 传 `undefined` 会炸 —— `startActivation` 内部一开始就
 *     `spec.signal.throwIfAborted()`，读 undefined 的属性直接
 *     `TypeError: Cannot read properties of undefined (reading 'throwIfAborted')`。
 *     （`buildDispatchRequest` 里那个 `?? new AbortController().signal` 兜底的是
 *     **request.signal**，救不了外层 `spec.signal`，这是两个不同的字段。）
 *   - 传 `exec.signal` 会「一停全停」——那是主编这次工具调用的 signal，
 *     工具返回后它就被 abort，子 Agent 会跟着被取消。常驻子会话的意义是
 *     派单动作结束、子 Agent 继续跑，所以两者必须脱钩。
 * 这个 controller 的 `abort()` 永远不会有人调，signal 因此恒为「未中止」。
 */
export const DETACHED_SIGNAL = new AbortController().signal;

/**
 * 一次性（external）后端专用的 signal。
 *
 * `delivery: 'caller'` 的一次性 run 是「派完就等结果」的，返回值要被这一轮
 * 工具调用消费；但它仍然不能绑 `exec.signal` —— 若绑上，工具调用一结束就被
 * abort，我们连 `await run.result` 都等不到。所以同样用 DETACHED_SIGNAL，
 * 只额外把 `delivery` 标成 `'caller'` 让宿主不往父对话里塞结算通知。
 */

/**
 * 把子 Agent 的 ContentBlock[] 压成纯文本。
 * 照抄 dsh-tool-subagent 的 outputValueText：只认文本块，
 * 不 JSON.stringify 任意值（否则工具调用块会把一大坨内部结构漏给模型）。
 * @param {unknown} blocks 子 Agent 的 output（应为 ContentBlock[]）
 * @returns {string} 拼好的文本，形状不对时返回空串
 */
export function outputText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((value) => typeof value === 'object' && value !== null && !Array.isArray(value))
    .filter((value) => value.type === 'text' && typeof value.text === 'string')
    .map((value) => value.text)
    .join('');
}

/**
 * 把 stopReason 翻成「非空即失败」的中文原因。
 * 与上游 stopReasonError 保持同一组取值，但返回 undefined 表示正常完成，
 * 调用方只需 `if (reason)`。
 * @param {unknown} stopReason 子 Agent 的 stopReason
 * @returns {string|undefined} 失败原因；completed 时 undefined
 */
export function stopReasonText(stopReason) {
  switch (stopReason) {
    case 'completed': return undefined;
    case 'aborted': return '子 Agent 的 run 被取消';
    case 'error': return '子 Agent 的 run 失败了';
    case 'max-tokens': return '子 Agent 在写完之前撞上了 token 上限';
    case 'refusal': return '子 Agent 拒绝了这个任务';
    default: return `子 Agent 的 run 非正常结束（stopReason=${String(stopReason)}）`;
  }
}

/**
 * 组装 SubagentStartRequest。
 * signal 缺失时补一个永不过期的 signal —— 上游把它当必填（readonly signal），
 * 传 undefined 会在 driver 的 addEventListener 处炸掉。
 *
 * 注意这里补的是 **request.signal**（子 Agent 自己看到的中止信号），
 * 与 `startActivation` 外层那个 `spec.signal` 是两个字段，后者必须由调用方
 * 显式传 `DETACHED_SIGNAL`，不能指望这里的兜底。
 * @param {{label?: string, prompt: string, parent: unknown, signal?: AbortSignal, route: {provider: string, model: string, reasoningEffort?: string}, cwd?: string}} spec
 * @returns {object} 可直接作为 `startActivation({ request })` 的 request
 */
export function buildDispatchRequest(spec) {
  const route = spec.route ?? {};
  const provider = String(route.provider ?? '');
  const model = String(route.model ?? '');
  const request = {
    label: spec.label,
    prompt: [{ type: 'text', text: String(spec.prompt ?? '') }],
    parent: spec.parent,
    signal: spec.signal ?? DETACHED_SIGNAL,
  };
  // 钉工作目录：给了 cwd（region 的独立 worktree）就让子会话在那个目录里干活，
  // 不碰真实工作区。缺省则不传，子会话继承父的目录。
  if (typeof spec.cwd === 'string' && spec.cwd.trim()) request.cwd = spec.cwd.trim();
  // 没有指派就完全不传 agentOptions —— 让子 Agent 走父 Agent 的模型，
  // 而不是传一对空字符串：上游 requestedAgentOptions 会做非空断言，
  // 空值比「不传」错得更远。
  if (provider && model) {
    const agentOptions = { provider, model };
    if (route.reasoningEffort) agentOptions.reasoningEffort = String(route.reasoningEffort);
    request.agentOptions = agentOptions;
  }
  return request;
}

/**
 * 把部署设定的子 Agent 递归上限带上。
 *
 * 上游 `dsh-tool-subagent` 每次都调 `subagents.resolveMaxDepth(config.maxDepth)`
 * 再传给请求；我们直接调 `startActivation`，如果什么都不传，
 * `resolveChildDepth(parent, undefined)` 就不设上限 —— 等于悄悄绕过了用户
 * 在设置里配的 `subagent maxDepth`。工作室会层层往下派单，这个上限必须尊重。
 * @param {object} request 已组装的 SubagentStartRequest
 * @param {{resolveMaxDepth?: (configured?: number|string) => number|undefined}} subagents
 *   SubagentRuntime（方法缺席时原样返回）
 * @returns {object} 带 maxDepth 的请求（无上限时原样返回）
 */
export function withDepthCap(request, subagents) {
  if (typeof subagents?.resolveMaxDepth !== 'function') return request;
  const maxDepth = subagents.resolveMaxDepth(undefined);
  return maxDepth === undefined ? request : { ...request, maxDepth };
}

/**
 * 角色行展示用：「planner · work-buddy/deepseek-v4.1-flash（effort=high）」。
 * 让汇报里能看出这一单真的走了哪个模型，而不是只能信提示词。
 */
export function describeRoute(role, route) {
  const effort = route?.reasoningEffort ? `（reasoning_effort=${route.reasoningEffort}）` : '';
  return `${role} · ${route?.provider}/${route?.model}${effort}`;
}

/**
 * 宿主是否支持「派完就返回」的常驻子 Agent。
 *
 * 宿主 44.7.0 起只有 `startActivation(spec)`，旧的两个入口
 * （`start(provider, request)` / `startContinuable(spec)`）已经不存在。
 * 「常驻」不再由方法区分，而是由 spec 形状决定：
 *   - 传了 `spec.childId` + provider 有 `prepareContinuable` → runtime 走
 *     `startLocal`，子会话被持久化，形成常驻子会话；
 *   - 否则 runtime 走 `startExternal`，是一次性 run。
 * 前者在「初始 prompt 被 inbox 接收」时 resolve，返回 `{ childId, messageId }`，
 * 之后可以继续 `send_message` / `interrupt_agent`，结算时由宿主把 settlement
 * 消息投回父 Agent 的对话。
 *
 * 判据不能只看 `startActivation` 是不是个函数：它在 runtime 服务类上是无条件
 * 的方法，真正的能力在 **provider** 上。上游 `dsh-tool-subagent` 判的也是
 * 同一件事（`subagentProvider.prepareContinuable === void 0` 就报不支持），这里照抄。
 * @param {{startActivation?: Function, getProvider?: Function}} subagents SubagentRuntime
 * @param {string} [provider] provider 名，默认 spawn
 * @returns {boolean} 可用时 true
 */
export function canDispatchContinuable(subagents, provider = SPAWN_PROVIDER) {
  if (typeof subagents?.startActivation !== 'function') return false;
  const lookup = subagents.getProvider;
  // 拿不到 getProvider 时（例如测试桩）退回存在性判断。
  if (typeof lookup !== 'function') return true;
  const spec = lookup.call(subagents, provider);
  if (spec === undefined) return false;
  return spec.prepareContinuable !== undefined;
}

/**
 * 组装常驻派单的 `SubagentActivationSpec`。
 *
 * `childId` 一定要带上：它既让账本 owner 等于真实子会话 id，也是 runtime
 * 判断「走本地常驻后端」的依据。`delivery: 'parent'` 让宿主在子 Agent 结算时
 * 把结算消息投回父 Agent 的对话 —— 这正是「不要等它」能成立的前提。
 * @param {{childId: string, label: string, request: object}} spec
 * @returns {object} 可直接交给 ctx.subagents.startActivation 的 spec
 */
export function buildContinuableActivation(spec) {
  return {
    provider: SPAWN_PROVIDER,
    label: spec.label,
    childId: spec.childId,
    request: spec.request,
    signal: DETACHED_SIGNAL,
    delivery: 'parent',
  };
}

/**
 * 组装一次性派单的 `SubagentActivationSpec`（阻塞回退用）。
 *
 * 不带 `childId`：带了就必须有 `prepareContinuable`，而这条路径存在的意义
 * 恰恰是 provider 不支持常驻。`delivery: 'caller'` 让宿主不往父对话里塞
 * 结算通知 —— 结果由我们 `await activation.result` 自己消费。
 * @param {{label: string, request: object}} spec
 * @returns {object} 可直接交给 ctx.subagents.startActivation 的 spec
 */
export function buildOneShotActivation(spec) {
  return {
    provider: SPAWN_PROVIDER,
    label: spec.label,
    request: spec.request,
    signal: DETACHED_SIGNAL,
    delivery: 'caller',
  };
}

/**
 * 非阻塞派单的回执。
 *
 * 这段文字是给**模型**读的，不是给人看的装饰：旧版工具描述写「并等它返回结果」，
 * 模型就会在派完单后主动干等或立刻轮询 `list_agents`。回执必须把新契约说死：
 * 不要等、结果会自己回来、等待期间有哪些正当动作。
 * @param {{modelLine: string, childId: string, role: string, label?: string}} spec
 * @returns {string} Markdown 回执
 */
export function renderDispatched(spec) {
  const label = spec.label ? `，label：${spec.label}` : '';
  return [
    `## ${spec.modelLine}`,
    '',
    `已派出子会话 \`${spec.childId}\`（角色 ${spec.role}${label}）。`,
    '',
    '这一单已经在后台跑起来了，**不要等它，也不要轮询它**。把它交给宿主：',
    '子 Agent 结算时，宿主的结算消息会自己进入你的对话，你到那时再接手结果。',
    '',
    '等待期间你可以：',
    '- 继续和用户对话、回答他的插话；',
    '- 继续派下一单（互不依赖的角色可以同时跑，例如审校与档案）；',
    '- 用 `list_agents` 看它是否还在运行；',
    '- 用 `send_message` 给它追加约束或修正；',
    '- 用 `interrupt_agent` 让它停下。',
  ].join('\n');
}
