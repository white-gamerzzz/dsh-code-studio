/**
 * dsh-plugin-code-studio / orchestrator —— 主编侧的编排状态机（纯逻辑，零依赖）。
 *
 * 为什么要有这个模块：主编（Chief Editor）在真实运行里同时背负三件事——
 *   ① 用户插话（「停，别写了」这种抢占必须插到最前面，不能排在三个子任务后面）；
 *   ② 子会话陆续回来（派单是并发的，回来顺序完全不可控）；
 *   ③ 定时清扫（租约过期的任务要收回来，否则任务永远挂在 ASSIGNED）。
 * 这三件事如果都写成「派单时顺手 await 一下」，会立刻退化成串行调度：用户喊停要等
 * 当前子任务跑完才生效，sweeper 要等所有人都回来才跑。所以这里把输入统一成**带优先级的
 * 事件**、把出参统一成**一个 handle() 的状态机**，主编只要 `while` 循环取事件即可。
 *
 * 分层：
 *   - `PriorityInbox` —— 纯数据结构（优先级队列 + 等待者），不含任何业务判断；
 *   - `Orchestrator`  —— 状态机（在飞登记 / 结算 / 抢占 / 清扫 / 派单收口），
 *                        **全部外部能力由构造参数注入**，模块内不出现任何宿主 API。
 * 这样做的收益是可测：注册表、派单器、中断器全都能在测试里换成内存假对象，
 * 不需要起一个真 Host 就能验证「先 claim 再 dispatch」这种关键顺序。
 *
 * 形式约束（刻意如此，改之前先想清楚）：
 *   1. ESM；只用 `node:` 内置模块 —— 实际上本模块**一个 import 都不需要**，
 *      childId 用进程内自增序号生成，不引 `node:crypto`（见 newChildId）。
 *   2. 零第三方依赖。
 *   3. **绝对不写 `export default`** —— 本项目的插件加载器按 `exports.default ?? exports`
 *      取模块，一旦出现 default，本文件其余具名导出会被那个 default 整体顶掉。
 *      说明放在文件末尾。
 */

/* ────────────────────────────── 常量 ────────────────────────────── */

/** 优先级档位。数值越小越先取出，P0 是「用户喊停」这一层。 */
export const PRIORITY = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 });

/** 事件类型。取值即 kind 本身，便于日志里直接读。 */
export const EVENT_KIND = Object.freeze({
  PREEMPT: 'PREEMPT',
  USER_INPUT: 'USER_INPUT',
  TASK_RESULT: 'TASK_RESULT',
  TASK_PROGRESS: 'TASK_PROGRESS',
  TIMER: 'TIMER',
});

/**
 * 事件类型 → 优先级。用一张模块级 Map 建表，而不是写一长串 if/else：
 * 加一种事件只改这一处，且 `priorityOf` 的「未知就抛」由查表天然得到。
 */
const KIND_PRIORITY = new Map([
  [EVENT_KIND.PREEMPT, PRIORITY.P0],
  [EVENT_KIND.USER_INPUT, PRIORITY.P1],
  [EVENT_KIND.TASK_RESULT, PRIORITY.P2],
  [EVENT_KIND.TASK_PROGRESS, PRIORITY.P3],
  [EVENT_KIND.TIMER, PRIORITY.P4],
]);

/**
 * 终态集合。**刻意手写一份而不是从 `./task-registry.js` 导入**：
 * 本模块的形式约束是「不出现非 node: 的 import」（它要能在任何宿主里被单独加载）。
 * 内容与 task-registry 的 `TERMINAL_STATUSES`（= `SETTLE_STATUSES`）逐字对齐：
 * DONE / FAILED / CANCELLED / BLOCKED —— 注意 BLOCKED 在那边是合法终态，
 * 只是不进 `TASK_STATUS` 那个对外枚举。两处若漂移，症状是「已结算的任务被重复结算」。
 */
const TERMINAL_STATUSES = new Set(['DONE', 'FAILED', 'CANCELLED', 'BLOCKED']);

/** 终态判断，兼容假注册表返回的任意形态：非字符串一律当「不是终态」（宁可多试一次 settle）。 */
function isTerminalStatus(status) {
  return typeof status === 'string' && TERMINAL_STATUSES.has(status);
}

/** 未知 stopReason 的兜底文案里要带原值，这里统一转成可读文本。 */
function show(value) {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    return String(value);
  } catch {
    return '<无法显示的值>';
  }
}

/* ────────────────────────────── 纯函数 ────────────────────────────── */

/**
 * 事件类型 → 优先级档位。
 * @param {string} kind
 * @returns {number} PRIORITY.P0..P4
 * @throws {TypeError} kind 不在 EVENT_KIND 里（消息里带上那个 kind，否则调用方无从排查）
 */
export function priorityOf(kind) {
  const priority = KIND_PRIORITY.get(kind);
  if (priority === undefined) {
    throw new TypeError(`orchestrator.priorityOf: 未知事件类型 ${JSON.stringify(kind)}`);
  }
  return priority;
}

/**
 * 抢占检测的正例前缀表（原样，改动前先想清楚会不会误伤）。
 * 判定用「以该词开头」而不是「包含」：中文里「我停下来想了想」是描述动作，
 * 不是叫停；用包含会把它误判成抢占。
 */
const PREEMPT_LEADS = Object.freeze([
  '停', '停下', '停一下', '停止', '停下来', '先停',
  '取消', '中断', '终止',
  '不做了', '别做了', '不要做了',
  '算了',
  '别写了', '不要写了',
]);

/**
 * 否定优先表。命中即「这不是叫停」——「别停」「不要停」反过来是在催，
 * 「继续」「接着」更是明确要求往下写。必须先于正例判断。
 */
const PREEMPT_NEGATIONS = /别停|不要停|不用停|先别停|别取消|不要取消|继续|接着|接着写/;

/** 尾部标点：判定前剥掉，避免「停。」「算了？」被判成不命中。 */
const TRAILING_PUNCT = /[。！？!?，,.、]+$/;

/** 抢占指令的长度上限：长句里出现「停」几乎都不是在叫停，别误伤。 */
const PREEMPT_MAX_LEN = 24;

/**
 * 判断用户这句话是不是「停 / 取消」类**抢占**指令。
 *
 * 判定的优先级（顺序是刻意的）：
 *   1. 非字符串 / 去空白后为空 → false；
 *   2. 去空白后长度 > 24 → false（先判长度，长句里什么词都可能顺带出现）；
 *   3. 命中否定表 → false（「别停」「继续」是反向指令，必须先于正例）；
 *   4. 去尾部标点后：整句**恰好等于**某个正例词，或**以某个正例词开头** → true。
 * @param {unknown} text 用户原话
 * @returns {boolean}
 */
export function detectPreemption(text) {
  if (typeof text !== 'string') return false;
  const raw = text.trim();
  if (raw === '') return false;
  if (raw.length > PREEMPT_MAX_LEN) return false;
  if (PREEMPT_NEGATIONS.test(raw)) return false;

  const body = raw.replace(TRAILING_PUNCT, '');
  if (body === '') return false;
  if (PREEMPT_LEADS.includes(body)) return true;
  return PREEMPT_LEADS.some((lead) => body.startsWith(lead));
}

/**
 * 子会话的结束原因 → 注册表能接受的终态。
 *
 * 映射依据（`task-registry.js:657` 的 settle 签名 + line 92 的 SETTLE_STATUSES）：
 *   outcome 支持 `{status, result_ref, error, digest, result_digest}`，其中 status 必须
 *   在 SETTLE_STATUSES 里；该集合**包含 'BLOCKED'**（TERMINAL_STATUSES 就是它），
 *   所以 `max-tokens` / `refusal` 这两个「干完了但不太可信」的结局用 BLOCKED 是合法的，
 *   不需要降级成 FAILED —— 降级会丢掉「结果可能不完整」与「真的报错」的区别。
 * @param {unknown} stopReason
 * @returns {{status: string, error?: string}}
 */
export function settleOutcomeFor(stopReason) {
  const reason = stopReason === null || stopReason === undefined ? '' : String(stopReason);
  switch (reason) {
    case '':
    case 'completed':
      return { status: 'DONE' };
    case 'aborted':
      return { status: 'CANCELLED', error: '子会话被中断' };
    case 'error':
      return { status: 'FAILED', error: '子会话执行报错' };
    case 'max-tokens':
      return { status: 'BLOCKED', error: '子会话达到 token 上限，结果可能不完整' };
    case 'refusal':
      return { status: 'BLOCKED', error: '子会话拒绝执行' };
    default:
      return { status: 'FAILED', error: `子会话以未知原因结束：${show(stopReason)}` };
  }
}

/** 深拷贝一份记录，避免把内部 Map 里的对象引用漏给调用方。 */
function copyRecord(record) {
  return record === undefined ? undefined : { ...record };
}

/* ────────────────────────────── PriorityInbox ────────────────────────────── */

/**
 * 按优先级取出的队列，同优先级严格 FIFO（稳定）。
 *
 * 实现上是 5 个子队列（下标即优先级），不排序、不复用「堆」：
 * 优先级只有 5 档，而 FIFO 稳定性靠 `push`/`shift` 天然得到；
 * 用二叉堆反而要为「同优先级稳定」额外挂序号，得不偿失。
 *
 * 溢出策略：队列满时丢**优先级数值最大的那一档里最老的一条**——即损失最小的事件。
 * 新来的那条如果本身就是最差档里唯一（= 最老）的一条，那被丢的就是它自己。
 * `snapshot()` / `drain()` 都按「取出顺序」返回，前者不动队列。
 */
export class PriorityInbox {
  /** @param {{maxSize?: number}} [options] maxSize：队列容量上限，默认 512 */
  constructor({ maxSize = 512 } = {}) {
    const limit = Number(maxSize);
    if (!Number.isFinite(limit) || limit < 1 || Math.trunc(limit) !== limit) {
      throw new RangeError(`PriorityInbox: maxSize 必须是 ≥1 的整数，实际 ${show(maxSize)}`);
    }
    this.maxSize = limit;
    /** 丢过多少条（宿主用它判断「是不是该降压」）。 */
    this.dropped = 0;
    /** 5 档子队列，下标即优先级数值。 */
    this._queues = [[], [], [], [], []];
    this._count = 0;
    /** 等待者：每次 push 一次性唤醒全部（按注册顺序）。 */
    this._waiters = [];
    this._disposed = false;
  }

  /**
   * 入队。
   * @param {{kind: string, priority?: number}} event 非 null 对象；priority 缺省由 kind 推导
   * @returns {number} 入队（并可能淘汰一条）后的总深度
   * @throws {TypeError} event 不是对象 / kind 未知且没有显式 priority
   * @throws {RangeError} priority 不是 0..4 的整数
   * @throws {Error} 已 dispose
   */
  push(event) {
    if (this._disposed) throw new Error('PriorityInbox 已释放');
    if (event === null || typeof event !== 'object') {
      throw new TypeError('PriorityInbox.push: event 必须是非 null 对象');
    }
    const priority = event.priority === undefined || event.priority === null
      ? priorityOf(event.kind)
      : Number(event.priority);
    if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
      throw new RangeError(`PriorityInbox.push: priority 必须是 0..4 的整数，实际 ${show(event.priority)}`);
    }

    this._queues[priority].push(event);
    this._count += 1;

    if (this._count > this.maxSize) {
      // 从最差的一档往下找第一条非空队列，丢它的队首（最老的一条）。
      for (let level = 4; level >= 0; level -= 1) {
        if (this._queues[level].length === 0) continue;
        this._queues[level].shift();
        this._count -= 1;
        this.dropped += 1;
        break;
      }
    }

    // 有等待者就把「下一条」直接交给它们，**不再留在队列里**：
    // 否则 run() 循环会「waitForEvent 拿到一条 + 下一轮 tryPop 又拿到同一条」处理两遍。
    if (this._waiters.length > 0) {
      const next = this._takeNext();
      if (next !== undefined) {
        const waiters = this._waiters;
        this._waiters = [];
        for (const resolve of waiters) resolve(next);
      }
    }

    return this._count;
  }

  /** 立即取下一条（按 P0→P4、同档 FIFO），空则 undefined。 */
  tryPop() {
    return this._takeNext();
  }

  /** 按取出顺序返回数组，**不修改队列**。 */
  snapshot() {
    const out = [];
    for (let level = 0; level <= 4; level += 1) out.push(...this._queues[level]);
    return out;
  }

  /** 按取出顺序取出并清空。 */
  drain() {
    const out = this.snapshot();
    this._queues = [[], [], [], [], []];
    this._count = 0;
    return out;
  }

  /** 当前总深度。 */
  size() {
    return this._count;
  }

  /** 某一档的深度。 */
  depthOf(priority) {
    const level = Number(priority);
    if (!Number.isInteger(level) || level < 0 || level > 4) {
      throw new RangeError(`PriorityInbox.depthOf: priority 必须是 0..4 的整数，实际 ${show(priority)}`);
    }
    return this._queues[level].length;
  }

  isEmpty() {
    return this._count === 0;
  }

  /**
   * 等下一次 push。**同一时刻允许多个等待者**，一次 push 会把它们全部唤醒
   * （按注册顺序），都拿到同一条事件——「一次派单多个观察者」是真实场景，
   * 但没有做「一人一条」的分配：那需要的事件数量和等待者数量持平，属另一套语义。
   * dispose() 过（或之后才注册）的等待者一律立刻拿到 undefined，让 run() 能退出。
   *
   * 队列非空时**先吐队首**（同步 resolve），不等下一次 push：否则调用方
   * 「tryPop 拿到空 → 别的路径刚 push 进来 → 再 waitForEvent」这条时序会永久挂住
   * （唤醒事件已经落在队列里，而等待者只认未来的 push）。这一条对 run() 的活性是必需的。
   * @returns {Promise<object|undefined>}
   */
  waitForEvent() {
    if (this._disposed) return Promise.resolve(undefined);
    const queued = this._takeNext();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this._waiters.push(resolve);
    });
  }

  /**
   * 释放：清空、唤醒全部等待者（resolve undefined），此后 push 抛错。
   * 幂等——主编的 stop() 可能被调两次。
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._queues = [[], [], [], [], []];
    this._count = 0;
    const waiters = this._waiters;
    this._waiters = [];
    for (const resolve of waiters) resolve(undefined);
  }

  /** 是否已释放。 */
  isDisposed() {
    return this._disposed;
  }

  /** 按取出顺序摘掉一条并递减计数；空则 undefined。 */
  _takeNext() {
    for (let level = 0; level <= 4; level += 1) {
      const queue = this._queues[level];
      if (queue.length === 0) continue;
      const event = queue.shift();
      this._count -= 1;
      return event;
    }
    return undefined;
  }
}

/* ────────────────────────────── Orchestrator ────────────────────────────── */

/** 进程内自增，保证同一个进程里生成的 childId 不重复。 */
let childSeq = 0;

/**
 * 生成 childId。
 *
 * 为什么不 `randomUUID()`：本模块的形式约束是「零 import」（见文件头），
 * 而 childId 只需要**在主编这一个进程内唯一**（它是 inFlight 的键），
 * 时间戳 + 进程内自增序号就足以保证不撞，不需要密码学随机。
 * 也刻意不向 registry 借 id：账本 id 与子会话 id 是两套命名空间，
 * 混用会让「谁认领了谁」在日志里变得不可读。
 * @returns {string} 形如 `c-<base36 时间戳>-<base36 序号>`
 */
function newChildId() {
  childSeq += 1;
  return `c-${Date.now().toString(36)}-${childSeq.toString(36)}`;
}

/**
 * 主编侧编排状态机。
 *
 * 全部外部能力通过构造参数注入，模块内**不出现任何宿主 API**：
 *   - registry        TaskRegistry 实例（测试里是同形假对象）
 *   - dispatch        async ({childId, taskId, role, prompt, label, task}) => ({childId})
 *   - interruptChild  async (childId, reason) => void
 *   - now             () => number（默认 Date.now）
 *   - notify          (event, detail) => void（默认空函数，用于把编排事件吐给宿主日志）
 *   - leaseMs         数字，默认 30000（本模块自身不用它做计时，转交给派单方）
 */
export class Orchestrator {
  constructor({
    registry,
    dispatch,
    interruptChild,
    now,
    notify,
    leaseMs = 30000,
  } = {}) {
    if (!registry || typeof registry.get !== 'function') {
      throw new TypeError('Orchestrator: 需要一个 registry（至少实现 get/settle/cancel/claim/release/reclaim）');
    }
    if (typeof dispatch !== 'function') {
      throw new TypeError('Orchestrator: 需要一个 dispatch 函数（真派单的入口）');
    }
    /** 任务账本。 */
    this.registry = registry;
    /** 真派单。 */
    this.dispatch = dispatch;
    /** 中断一个子会话；缺省时退化成「只做账面上的取消」。 */
    this.interruptChild = typeof interruptChild === 'function' ? interruptChild : async () => {};
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.notify = typeof notify === 'function' ? notify : () => {};
    this.leaseMs = Number.isFinite(Number(leaseMs)) && Number(leaseMs) > 0 ? Number(leaseMs) : 30000;

    /** 事件入口。 */
    this.inbox = new PriorityInbox();
    /** childId → { taskId, role, label, dispatchedAt }。 */
    this.inFlight = new Map();
    /** taskId → childId（反向映射，保证「取消任务」时找得到要中断谁）。 */
    this.byTask = new Map();
    /** 计数，宿主与测试都读它。 */
    this.stats = {
      dispatched: 0,
      settled: 0,
      preempted: 0,
      swept: 0,
      settleRejected: 0,
      dropped: 0,
    };
  }

  /* ── 在飞登记 ── */

  /**
   * 双向登记一个「刚派出去」的子会话。
   * @param {{taskId: string, childId: string, role?: string, label?: string}} spec
   * @returns {object} 记下来的那条记录
   * @throws {TypeError} childId / taskId 为空
   * @throws {Error} 同一个 childId 已经挂着别的任务（一个子会话只能干一件事）
   */
  noteDispatch({ taskId, childId, role, label } = {}) {
    if (typeof childId !== 'string' || childId.trim() === '') {
      throw new TypeError('Orchestrator.noteDispatch: childId 必须是非空字符串');
    }
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw new TypeError('Orchestrator.noteDispatch: taskId 必须是非空字符串');
    }
    if (this.inFlight.has(childId)) {
      throw new Error(`Orchestrator.noteDispatch: 子会话 ${childId} 已经挂着任务 ${this.inFlight.get(childId).taskId}`);
    }
    const record = {
      taskId,
      role: role ?? null,
      label: label ?? null,
      dispatchedAt: this.now(),
    };
    this.inFlight.set(childId, record);
    this.byTask.set(taskId, childId);
    return { childId, ...record };
  }

  /** childId → 在飞记录（副本）。 */
  taskFor(childId) {
    return copyRecord(this.inFlight.get(childId));
  }

  /** taskId → childId。 */
  childFor(taskId) {
    return this.byTask.get(taskId);
  }

  /**
   * 忘掉一个子会话（结算完 / 任务已不在注册表时调用）。
   * 同时清掉 byTask 里的反向映射，否则「任务 → 子会话」会指向一个已经不存在的孩子。
   * @returns {object|undefined} 被删掉的记录
   */
  forget(childId) {
    const record = this.inFlight.get(childId);
    if (record === undefined) return undefined;
    this.inFlight.delete(childId);
    // 只有反向映射确实指向自己时才删：同一个 taskId 可能已被重派给新的 childId，
    // 那时删掉会把新孩子的映射一起抹掉。
    if (this.byTask.get(record.taskId) === childId) this.byTask.delete(record.taskId);
    return copyRecord(record);
  }

  /* ── 入队 ── */

  /**
   * 用户说话。命中抢占词表就进 P0，否则只是普通插话（P1）。
   * @returns {object} 入队的事件对象
   */
  enqueueUserInput({ agentId, text } = {}) {
    const preempt = detectPreemption(text);
    const kind = preempt ? EVENT_KIND.PREEMPT : EVENT_KIND.USER_INPUT;
    const event = { kind, priority: priorityOf(kind), payload: { agentId, text } };
    this.inbox.push(event);
    return event;
  }

  /**
   * 子会话结束通知。
   * **只受理自己派出去的**：`inFlight` 里没有的一律忽略——主编可能同时挂在别的
   * 会话（甚至别的作品）上，不能凭一条 `subagent_end` 就去动注册表。
   * @returns {boolean} 是否受理
   */
  enqueueSubagentEnd({ id, stopReason, lastAssistantMessage } = {}) {
    if (!this.inFlight.has(id)) return false;
    this.inbox.push({
      kind: EVENT_KIND.TASK_RESULT,
      priority: priorityOf(EVENT_KIND.TASK_RESULT),
      payload: { childId: id, stopReason, lastAssistantMessage },
    });
    return true;
  }

  /** 子会话报进度（P3）。不校验是否在飞：进度是「只读信息」，宁可多收不可漏收。 */
  enqueueProgress({ childId, progress, note } = {}) {
    const event = {
      kind: EVENT_KIND.TASK_PROGRESS,
      priority: priorityOf(EVENT_KIND.TASK_PROGRESS),
      payload: { childId, progress, note },
    };
    this.inbox.push(event);
    return event;
  }

  /** 定时器（P4，sweeper 用）。 */
  enqueueTimer() {
    const event = { kind: EVENT_KIND.TIMER, priority: priorityOf(EVENT_KIND.TIMER), payload: {} };
    this.inbox.push(event);
    return event;
  }

  /* ── 状态机 ── */

  /**
   * 处理一条事件，返回「发生了什么」的普通对象。
   *
   * **不吞异常**：注册表/中断器的异常一律往外抛，由 `run()` 统一捕获并 notify。
   * 理由：`handle` 是可单测的纯状态迁移，它自己吞掉异常会让「循环没崩」和
   * 「这条事件其实失败了」两件事混在一起，调用方再也分不出来。
   *
   * kind 未在册 → TypeError（消息里带 kind）。
   * @param {{kind: string, payload?: object}} event
   * @returns {Promise<object>}
   */
  async handle(event) {
    if (event === null || typeof event !== 'object') {
      throw new TypeError('Orchestrator.handle: event 必须是非 null 对象');
    }
    const kind = event.kind;
    // payload 缺省时退回事件顶层：宿主/测试直接手搓事件对象时不必再包一层。
    const payload = event.payload !== null && typeof event.payload === 'object' ? event.payload : event;

    switch (kind) {
      case EVENT_KIND.TASK_RESULT:
        return this._handleTaskResult(payload, event);
      case EVENT_KIND.PREEMPT: {
        const result = await this.cancelAll({ reason: '用户要求停止' });
        this.stats.preempted += 1;
        return { action: 'preempted', ...result };
      }
      case EVENT_KIND.USER_INPUT:
        // 编排器不管插话本身：那是主编（对话方）的职责，这里只保证它排在了队里的正确位置。
        return { action: 'user-input' };
      case EVENT_KIND.TASK_PROGRESS:
        this.notify('progress', payload);
        return { action: 'progress' };
      case EVENT_KIND.TIMER: {
        const result = await this.registry.reclaim();
        this.stats.swept += 1;
        // 真实 reclaim() 返回的是 id 数组（`{ok, reclaimed: string[], quarantined: string[]}`），
        // 对外给数量更有用，原始对象留在 detail 里备查。
        return {
          action: 'swept',
          reclaimed: countOf(result?.reclaimed),
          quarantined: countOf(result?.quarantined),
          detail: result,
        };
      }
      default:
        throw new TypeError(`Orchestrator.handle: 未知事件类型 ${JSON.stringify(kind)}`);
    }
  }

  /**
   * TASK_RESULT 的六步迁移，顺序是刻意的：
   *   在飞吗 → 任务还在吗 → 已经结算了吗（幂等）→ 结算 → 被拒了吗 → 记账。
   * 「已经结算」必须排在真结算之前，否则重复的 subagent_end 会让第二次 settle
   * 拿到 BAD_STATE 并计进 settleRejected，把一个正常幂等场景染成错误。
   */
  async _handleTaskResult(payload) {
    const childId = payload.childId ?? payload.id;
    const stopReason = payload.stopReason;

    // ① 不是自己派的
    const record = this.taskFor(childId);
    if (record === undefined) {
      this.stats.dropped += 1;
      return { action: 'dropped', reason: 'inFlight 里没有这个子会话' };
    }

    // ② 任务不在注册表（被别处删了 / 换了工作区）
    const task = this.registry.get(record.taskId);
    if (task === undefined || task === null) {
      this.forget(childId);
      return { action: 'dropped', reason: '任务不在注册表' };
    }

    // ③ 幂等：终态任务不再结算（BLOCKED 也是终态）
    if (isTerminalStatus(task.status)) {
      this.forget(childId);
      return { action: 'already-settled', status: task.status };
    }

    // ④ 真结算。owner 与 version 都取注册表里那一份，**不信任本地记录**：
    //    任务可能已被 sweeper 回收或被重派，本地那份已经过期。
    const taskId = record.taskId;
    const outcome = settleOutcomeFor(stopReason);
    const result = await this.registry.settle(taskId, task.owner_agent, task.version, outcome);

    // ⑤ 被拒（版本冲突 / 租约过期 / 已被别人结算…）：**不能 forget**，
    //    留着重试或人工介入的余地。
    if (!result || result.ok !== true) {
      this.stats.settleRejected += 1;
      return { action: 'settle-rejected', code: result?.code, taskId };
    }

    // ⑥ 成功
    this.forget(childId);
    this.stats.settled += 1;
    return {
      action: 'settled',
      taskId,
      status: result.task?.status ?? outcome.status,
      version: result.task?.version ?? null,
    };
  }

  /**
   * 抢占：中断全部在飞子会话，并取消它们的任务。
   *
   * 两轮分开走（先全部中断，再全部取消），不是「一个子会话中断+取消完再到下一个」：
   * 中断是唯一的止损动作，必须尽快全部发出去；取消是记账，晚几十毫秒无所谓。
   *
   * **单个失败不影响其余**：中断器抛错只记进 `failed`，循环继续；
   * 注册表里找不到任务或找不到 owner 的记进 `skipped`。
   * @returns {Promise<{interrupted: string[], cancelled: string[], failed: string[], skipped: string[], failureDetails: {childId: string, error: string}[]}>}
   */
  async cancelAll({ reason } = {}) {
    const entries = [...this.inFlight.entries()];
    const interrupted = [];
    const cancelled = [];
    const failed = [];
    const skipped = [];
    const failureDetails = [];

    for (const [childId] of entries) {
      try {
        await this.interruptChild(childId, reason);
        interrupted.push(childId);
      } catch (error) {
        failed.push(childId);
        failureDetails.push({ childId, error: show(error?.message ?? error) });
      }
    }

    for (const [childId, record] of entries) {
      const task = this.registry.get(record.taskId);
      if (task === undefined || task === null) {
        skipped.push(record.taskId);
        continue;
      }
      const owner = task.owner_agent;
      if (owner === null || owner === undefined || owner === '') {
        // owner 取不到就没法按签名调 cancel 的所有权语义，交给人工/sweeper
        skipped.push(record.taskId);
        continue;
      }
      try {
        // 真实签名：cancel(id, agentId, opts) —— 版本走 opts.expectedVersion，这里不传，
        // 表示「按当前版本直接取消」（用户喊停是主编层级权力，不该被版本号挡住）。
        const result = await this.registry.cancel(record.taskId, owner, { reason });
        if (result && result.ok === true) cancelled.push(record.taskId);
        else skipped.push(record.taskId);
      } catch (error) {
        failed.push(childId);
        failureDetails.push({ childId, error: show(error?.message ?? error) });
      }
    }

    // 账面上清空：抢占之后这些子会话一律不再受理（它们的 subagent_end 会被当陌生事件丢掉）。
    this.inFlight.clear();
    this.byTask.clear();

    return { interrupted, cancelled, failed, skipped, failureDetails };
  }

  /**
   * 主编派单的**唯一收口**。关键顺序：先 claim、再真派单。
   *
   * 为什么不能反过来：反过来会留一个「已经派出去了，但账上还是 READY」的窗口，
   * 别的 Agent 在这个窗口里能合法地把同一个任务认领走，于是同一份活被两个子 Agent
   * 同时干，结算时一个成功一个变成过期结果。先 claim 的话，派单失败还能回滚，
   * 而「派了没记账」是无法回滚的。
   *
   * @param {{taskId?: string, role?: string, prompt?: string, label?: string}} spec
   * @returns {Promise<{ok: true, childId: string, taskId?: string} | {ok: false, code: string, status?: string}>}
   * @throws 派单本身抛出的异常（已经 claim 成功时会先尝试回滚再抛出）
   */
  async dispatchTask({ taskId, role, prompt, label } = {}) {
    let task;
    if (taskId !== undefined && taskId !== null && taskId !== '') {
      task = this.registry.get(taskId);
      if (task === undefined || task === null) return { ok: false, code: 'NOT_FOUND' };
      // 只有「READY 且无主」才是能派的：ASSIGNED/RUNNING 已经有主，
      // 终态任务派了也没人认领。用 owner_agent 判而不是只看 status，
      // 是因为「READY 却有 owner」这种僵尸任务真的会出现在被手工改坏的账本里。
      if (task.status !== 'READY' || task.owner_agent !== null && task.owner_agent !== undefined) {
        return { ok: false, code: 'BAD_STATE', status: task.status };
      }
    }

    const childId = newChildId();
    let claimed = false;
    let claimVersion = null;
    if (task !== undefined) {
      const claimedResult = await this.registry.claim(taskId, childId, {});
      if (!claimedResult || claimedResult.ok !== true) {
        return { ok: false, code: claimedResult?.code ?? 'BAD_STATE' };
      }
      claimed = true;
      // 认领后的版本号（claim 会 version+1）。拿不到时按「认领前 +1」推，两者等价。
      claimVersion = Number(claimedResult.task?.version ?? Number(task.version) + 1);
      // 给派单方的是**认领后**的那份：它带着 owner_agent 与新鲜 version，
      // 子会话要把这些写进自己的租约续约里。
      task = claimedResult.task ?? task;
    }

    let actual = childId;
    try {
      const started = await this.dispatch({ childId, taskId, role, prompt, label, task });
      actual = started?.childId ?? childId;
    } catch (error) {
      // 派单失败必须把任务放回 READY，否则这个任务永远挂在 ASSIGNED 上，
      // 只有等 30 秒租约过期才被 sweeper 收回来。原始异常继续往外抛。
      if (claimed) await this._rollbackClaim(taskId, childId, claimVersion);
      throw error;
    }

    if (task !== undefined) this.noteDispatch({ taskId, childId: actual, role, label });
    this.stats.dispatched += 1;
    return { ok: true, childId: actual, taskId };
  }

  /**
   * 派单失败后的回滚：优先 release（退回 READY、清 owner，语义最准），
   * release 不成功（版本被别人推进过 / 任务已被结算）再退而求其次 cancel。
   * 两步都失败就认了：租约到期后 sweeper 会兜住，绝不能在这里再抛异常
   * ——那会把真正的派单异常顶掉。
   * @returns {Promise<boolean>} 是否至少成功一步
   */
  async _rollbackClaim(taskId, childId, version) {
    try {
      const released = await this.registry.release(taskId, childId, version);
      if (released && released.ok === true) return true;
    } catch {
      // 落到 cancel
    }
    try {
      const cancelled = await this.registry.cancel(taskId, childId, { reason: '派单失败，回滚认领' });
      return Boolean(cancelled && cancelled.ok === true);
    } catch {
      return false;
    }
  }

  /**
   * 事件循环。空转时阻塞在 `waitForEvent()` 上；`stop()`（dispose）后立即退出。
   * **一条事件的异常绝不能让整个主编停摆**：捕获后 notify('error', ...)，继续下一条。
   */
  async run() {
    for (;;) {
      let event = this.inbox.tryPop();
      if (event === undefined) event = await this.inbox.waitForEvent();
      if (event === undefined) break; // 已 dispose
      try {
        await this.handle(event);
      } catch (error) {
        try {
          this.notify('error', { event, error });
        } catch {
          // notify 自己也抛就只能放弃了：报错通道挂掉不能反过来把主循环带走
        }
      }
    }
  }

  /** 让 run() 退出（幂等）。 */
  stop() {
    this.inbox.dispose();
  }

  /** 当前编排状态快照。 */
  status() {
    return {
      inFlight: [...this.inFlight.entries()].map(([childId, record]) => ({ childId, ...record })),
      waiting: this.inbox.size(),
      stats: { ...this.stats },
    };
  }
}

/** 数量归一化：真实 reclaim 返回 id 数组，假对象可能直接给数字。 */
function countOf(value) {
  if (Array.isArray(value)) return value.length;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

// 刻意不写 `export default`：插件加载器按 `exports.default ?? exports` 解析本模块，
// 一旦出现 default，上面这些具名导出会被那个 default 整体顶掉。
