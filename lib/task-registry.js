/**
 * dsh-plugin-code-studio / task-registry —— 任务所有权账本（owner / version / lease）。
 *
 * 为什么要有这个模块：宿主只有 `jobs` 的 owner 围栏，没有 `version` 也没有
 * `lease_until`，于是「派出去的任务被另一个子 Agent 抢走」和「租约过期后旧 owner
 * 用过期结果覆盖新结果」这两件事，没有任何一层拦得住。设计文档 §3 / §8 / §9 把
 * 这三件套写成了 Postgres SQL，但插件跑在单 Host 的本地磁盘上，为单进程场景扛一套
 * 数据库不划算，所以这里把 SQL 语义翻译成「进程内互斥 + 原子替换的快照 +
 * append-only 事件日志」。
 *
 * 与 SQL 形态的对应关系（改代码前先读这张表，否则很容易想当然）：
 *   `UPDATE ... WHERE status='READY' AND owner_agent IS NULL RETURNING version`
 *     → `claim()`：整段读-改-写跑在同一个互斥段里。**原子性来自互斥，不是来自
 *       Node 单线程**——两个 `await` 之间的 read-modify-write 照样会交错，这正是
 *       本模块存在的全部理由（文档 §3.6 只说了「writeAtomic 原子」，那只保证文件
 *       不被写坏，不保证「先读后写」这一对动作不被打断）。
 *   `revision`            → 快照落盘序号，每次写入 +1；相当于整个注册表的版本
 *   `tasks.<id>.version`  → 单个任务的所有权版本；与 revision 是**两个不同的东西**，
 *                           租约续约只动 revision 不动 task.version（文档 §3.3）
 *   RLS / workspace_id    → `task.workspace_id` + `list({ workspace_id })` +
 *                           `assertWorkspace()`；受限于约定的方法签名里没有 ws 参数，
 *                           模块无法在每个入口强制它（见文件末尾的取舍说明）
 *
 * 刻意不写 `export default`：插件加载器用 `exports.default ?? exports` 解析，
 * 一旦出现 default，本文件其余具名导出会被那个 default 整体顶掉。
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

/* ────────────────────────────── 常量 ────────────────────────────── */

/**
 * 冻结的「值集合」，同时满足两种用法。
 *
 * 这几个常量在约定里叫「集合」，但集成方很可能按数组用（`.includes(x)`、`for...of`、
 * `JSON.stringify`），也可能按 Set 用（`.has(x)`、`.size`）。猜错哪一边都是运行时
 * 崩溃，而这件事没有理由让调用方去猜，所以返回**冻结数组 + 挂上 `has`/`size`**：
 *   - `.includes()` / `[...s]` / `for...of` / `Array.isArray` / `JSON.stringify` → 数组语义
 *   - `.has()` / `.size` → Set 语义
 * `has`/`size` 设为不可枚举，避免它们混进 `JSON.stringify` 的结果或 `Object.keys`。
 * @param {string[]} values
 */
function frozenSet(values) {
  // 顺序要紧：`Object.freeze()` 之后数组就不能再挂新属性了（会抛 TypeError），
  // 所以先把 Set 风格的两个成员定义好，最后才冻结。
  const list = [...new Set(values)];
  Object.defineProperty(list, 'has', {
    value: (value) => list.includes(value),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(list, 'size', {
    get: () => list.length,
    enumerable: false,
    configurable: false,
  });
  return Object.freeze(list);
}

/** 任务状态。取值与文档 §3.1 的 CHECK 对齐，只少一个 BLOCKED（见下方 SETTLE_STATUSES）。 */
export const TASK_STATUS = Object.freeze({
  READY: 'READY', ASSIGNED: 'ASSIGNED', RUNNING: 'RUNNING',
  DONE: 'DONE', FAILED: 'FAILED', CANCELLED: 'CANCELLED',
});

/**
 * 未结算（还有可能被推进）的状态集合。
 *
 * 注意这里包含 READY：`reclaim()` 实际只处理 ASSIGNED/RUNNING（见 LEASED_STATUSES），
 * 但「未结算」的严格含义就是「不在 TERMINAL_STATUSES 里」，判 sweeper 该不该看的任务
 * 用 LEASED_STATUSES，判「这个任务还有没有救」用 OPEN_STATUSES，两者别混。
 */
export const OPEN_STATUSES = frozenSet([
  TASK_STATUS.READY, TASK_STATUS.ASSIGNED, TASK_STATUS.RUNNING,
]);

/** 持有租约、需要被 sweeper 盯着的状态。回收只针对这两个（文档 §3.5）。 */
export const LEASED_STATUSES = frozenSet([TASK_STATUS.ASSIGNED, TASK_STATUS.RUNNING]);

/**
 * 可以写进 `settle` 的终态。
 *
 * 这里比 `TASK_STATUS` 多一个 `'BLOCKED'`，是照着文档加的：§9 要求「多子任务冲突
 * 时不自动合并，报 BLOCKED 让人决定」，§4 的 TaskResult 也把 BLOCKED 列为合法
 * status，但对外约定的 TASK_STATUS 里没有它。取舍是：**结算允许 BLOCKED，但它不进
 * TASK_STATUS**——TASK_STATUS 是调用方会遍历的稳定枚举，擅自加值更危险。
 */
export const SETTLE_STATUSES = frozenSet([
  TASK_STATUS.DONE, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED, 'BLOCKED',
]);

/** 终态 = 已经结算、owner 不能再推进的状态。用同一个集合，避免两处漂移。 */
export const TERMINAL_STATUSES = SETTLE_STATUSES;

/** 默认租约。子 Agent 每 10s 续约（文档 §4.1），30s 给了两次丢失机会。 */
export const DEFAULT_LEASE_MS = 30000;

/** 注册表目录，相对 workDir。 */
export const REGISTRY_DIR = '.codewrite/agents';

/** 整份快照的文件名。 */
export const SNAPSHOT_FILE = 'registry.json';

/** 过期结果留证目录，相对注册表目录。 */
export const ORPHAN_DIR = 'orphaned';

/** 单任务事件日志后缀（append-only，一行一个 JSON）。 */
export const EVENT_SUFFIX = '.jsonl';

/**
 * 全部错误码。返回值里出现 `code` 时只会是这些值之一，
 * 集成方可以直接 `switch` 而不用管人类可读的 `reason`。
 */
export const TASK_ERRORS = Object.freeze({
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_CLAIMED: 'ALREADY_CLAIMED',
  NOT_OWNER: 'NOT_OWNER',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  LEASE_EXPIRED: 'LEASE_EXPIRED',
  BAD_STATE: 'BAD_STATE',
  DUPLICATE_ID: 'DUPLICATE_ID',
  DUPLICATE_RESULT: 'DUPLICATE_RESULT',
  /** 文档 §12 要求的跨工作区拒绝；不在最初约定的八个码里，属本模块补充。 */
  WORKSPACE_MISMATCH: 'WORKSPACE_MISMATCH',
});

/**
 * 事件日志里允许携带 `task` 快照的类型白名单。
 *
 * 为什么要有白名单：`appendEvent()` 是唯一对非 owner 开放的写入口（文档 §8.4
 * 的 TaskSuggestion 走这条路），而重放恢复会信任事件里的 `task` 快照。若不设限，
 * 一个不守规矩的调用方就能凭一条自造事件在下次 `load()` 时篡改任务状态。
 * 只有本模块自己产生的事件类型才有资格参与重放。
 */
const STATE_EVENT_TYPES = new Set([
  'task/opened', 'task/claimed', 'task/renewed', 'task/settled',
  'task/released', 'task/cancelled', 'lease/expired',
]);

/* ────────────────────────────── 纯函数 ────────────────────────────── */

/**
 * 生成新 task id：短、可读、无冲突。
 *
 * 32 位随机（8 hex）叠加毫秒时间戳：同一毫秒内要撞出同一个 id 需要 2^32 分之一的
 * 巧合，而任务创建速率以「每个派单一次」计，这个余量足够。刻意不带进程号/序号：
 * 序号在重启后会从头开始，跨进程反而更容易撞。
 * @returns {string} 形如 `t-<base36 时间戳>-<8 位 hex>`
 */
export function taskId() {
  return `t-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/**
 * 结果指纹，用于幂等去重（同一 digest 只允许结算成功一次）。
 *
 * 注意语义边界：这里 hash 的是**传进来的那个值本身**。文档 §9 说
 * `result_digest = sha256(内容)`，而调用方拿到手的常常只是一个路径 ref——
 * 路径相同不代表内容相同，内容变了路径可能没变。所以：
 *   - 想让 digest 反映内容，就把内容传进来（`resultDigest(text)`）；
 *   - 只有路径时，传 `{ ref, mtime, size }`（本函数会做键排序后 hash），
 *     比裸路径强：内容一变 mtime/size 就变。
 * 本函数保持同步纯函数：不做任何 I/O，读文件是调用方的事。
 *
 * 字符串与 Buffer 视为「字节内容」（内容相同的两者得同一个 digest，方便同文本在
 * 两条路径上传递）；其余类型按 `类型:值` 加前缀，避免 `null` 撞上 `'null'` 导致
 * 一份真实新结果被误判成重复提交。细节见 canonicalBytes。
 * @param {unknown} resultRef 字符串 / Buffer / 可 JSON 序列化的对象
 * @returns {string} 64 位小写 hex
 */
export function resultDigest(resultRef) {
  return createHash('sha256').update(canonicalBytes(resultRef)).digest('hex');
}

/**
 * 把工作区标识规范成绝对路径。
 *
 * 文档 §12.2 明确要求 workspace_id 是 canonical cwd 而不是另造的 uuid，否则会
 * 出现「同一目录两个 workspace_id」的分裂。目录还不存在时退回 `resolve()`：
 * realpath 对不存在的路径会抛，而创建注册表目录之前就要先算出 workspace_id。
 * @param {string} workDir 工作目录
 * @returns {string} 规范化的绝对路径
 */
export function canonicalWorkspace(workDir) {
  const abs = resolve(String(workDir ?? ''));
  try {
    if (existsSync(abs)) return realpathSync.native(abs);
  } catch {
    // realpath 在某些 Windows 路径上会抛（长路径/权限）；规范化的收益不值得让它失败
  }
  return abs;
}

/**
 * 比较两个 workspace 标识是否是同一个工作区。
 * Windows 的路径大小写不敏感，逐字符比较会把 `C:\Ws` 和 `C:\ws` 判成两个区。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function workspaceMatches(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const norm = (value) => {
    let text = String(value).replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    if (process.platform === 'win32') text = text.toLowerCase();
    return text;
  };
  return norm(a) === norm(b);
}

/* ────────────────────────────── 内部工具 ────────────────────────────── */

/** 深拷贝。返回值必须是副本：注册表是所有权账本，外部拿到引用就能绕过校验改状态。 */
function clone(value) {
  if (value === null || value === undefined) return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/** JSON 安全化：留证失败不能反过来把主流程带崩（循环引用、BigInt、函数值）。 */
function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return { unserializable: String(value) };
  }
}

/**
 * 稳定序列化：对象键排序，让 `{a:1,b:2}` 与 `{b:2,a:1}` 得到同一个 digest。
 *
 * 非内容型入参带一个类型前缀，否则会撞：`null` 与字符串 `'null'`、
 * 对象 `{a:1}` 与字符串 `'{"a":1}'` 都会序列化成同样的字节，而它们在语义上是
 * 两件不同的事（「没有结果」vs「结果文本恰好是 null」）。撞了就会把一份真实的
 * 新结果误判成重复提交（DUPLICATE_RESULT）悄悄丢掉。
 * string / Buffer 是「内容本身」，按文档 §9 的 `sha256(内容)` 不加前缀，两者同内容
 * 得同一个 digest。
 */
function canonicalBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  if (value === undefined) return Buffer.from('undefined:undefined', 'utf8');
  if (value === null) return Buffer.from('null:null', 'utf8');
  if (typeof value === 'object') {
    const walk = (node) => {
      if (Array.isArray(node)) return node.map(walk);
      if (node && typeof node === 'object') {
        const out = {};
        for (const key of Object.keys(node).sort()) out[key] = walk(node[key]);
        return out;
      }
      return node;
    };
    return Buffer.from(`json:${JSON.stringify(walk(value)) ?? 'null'}`, 'utf8');
  }
  return Buffer.from(`${typeof value}:${String(value)}`, 'utf8');
}

/** 归一化 agent 标识：空串/非字符串一律当「没有身份」。 */
function normAgent(agentId) {
  return typeof agentId === 'string' && agentId.trim() ? agentId.trim() : null;
}

/** 归一化 digest：只有非空字符串才算数，其余视为「这次提交不做幂等判断」。 */
function normDigest(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 空快照。 */
function emptyState(workspaceId) {
  return { revision: 0, updatedAt: null, workspace_id: workspaceId, tasks: {} };
}

/** 补齐从磁盘读回来的 task 字段，避免旧格式/手工改坏的文件让调用方读到 undefined。 */
function normalizeTask(task, workspaceId) {
  const out = { ...(task && typeof task === 'object' ? task : {}) };
  out.parent_id = out.parent_id ?? null;
  out.status = typeof out.status === 'string' ? out.status : TASK_STATUS.READY;
  out.owner_agent = out.owner_agent ?? null;
  out.version = Number.isFinite(Number(out.version)) ? Number(out.version) : 1;
  out.lease_until = out.lease_until ?? null;
  out.priority = Number.isFinite(Number(out.priority)) ? Number(out.priority) : 2;
  out.write_scope = Array.isArray(out.write_scope) ? out.write_scope : [];
  out.result_ref = out.result_ref ?? null;
  out.result_digest = out.result_digest ?? null;
  out.error = out.error ?? null;
  out.workspace_id = out.workspace_id ?? workspaceId;
  return out;
}

/**
 * 进程内互斥。
 *
 * 为什么必须有：`claim()` 是「读快照 → 判断 READY → 写快照」，中间隔着 await。
 * 十个并发 claim 会在同一个 await 点交错，全部读到 READY，全部写回 ASSIGNED，
 * 最后一个人赢——「有且只有一个成功」直接破功。文件原子替换（tmp+rename）救不了
 * 这个，它只保证单个文件不被写坏。
 *
 * 锁按**注册表目录**共享（见 lockFor），不按实例：同一个 workDir 上的两个
 * TaskRegistry 实例（主编持一个、子 Agent 持一个）必须抢同一把锁。
 * 真要多进程时这把锁失效，届时应换成 O_EXCL 锁文件或 Postgres，协议不变。
 */
class Mutex {
  constructor() {
    this._tail = Promise.resolve();
  }

  /** 串行执行 fn；失败只抛给调用方，不毒化后续排队者。 */
  run(fn) {
    const result = this._tail.then(() => fn());
    this._tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** 目录 → 锁。同一进程内同一目录共锁；不同目录互不影响（不同作品真的可以并行）。 */
const LOCKS = new Map();
function lockFor(dir) {
  let lock = LOCKS.get(dir);
  if (lock === undefined) {
    lock = new Mutex();
    LOCKS.set(dir, lock);
  }
  return lock;
}

/* ────────────────────────────── TaskRegistry ────────────────────────────── */

/**
 * 任务注册表。一个实例绑定一个工作目录，所有方法都是 async（写入要落盘）。
 *
 * 读方法（header/snapshot/get/list/events/assertWorkspace）是同步的，返回深拷贝，
 * 对所有 Agent 开放；写方法走互斥 + 乐观锁，非 owner 会被拒。
 */
export class TaskRegistry {
  /**
   * @param {string} workDir 工作目录（作品目录）。会被规范化成 workspace_id。
   * @param {{ clock?: () => number, leaseMs?: number }} [options]
   *        clock：注入时钟，测试用它模拟租约过期，避免真的 sleep 30 秒
   *        leaseMs：默认租约毫秒数
   */
  constructor(workDir, options = {}) {
    if (typeof workDir !== 'string' || workDir.trim() === '') {
      throw new TypeError('task-registry: workDir 必须是非空字符串（绝对路径或可解析的路径）');
    }
    /** 规范化绝对路径，同时也是 workspace_id（文档 §12.2）。 */
    this.workspaceId = canonicalWorkspace(workDir);
    this.workDir = this.workspaceId;
    /** 注册表目录：<workDir>/.deepwrite/agents */
    this.dir = join(this.workspaceId, ...REGISTRY_DIR.split('/'));
    /** 过期结果留证目录。 */
    this.orphanDir = join(this.dir, ORPHAN_DIR);
    /** 快照路径。 */
    this.snapshotPath = join(this.dir, SNAPSHOT_FILE);
    this.leaseMs = Number.isFinite(options.leaseMs) && options.leaseMs > 0
      ? Number(options.leaseMs)
      : DEFAULT_LEASE_MS;
    this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
    this._state = emptyState(this.workspaceId);
    /** taskId → 事件数组（内存视图，按写入序）。 */
    this._events = new Map();
    /** 事件日志是否已经从磁盘读过（见 _withState 的惰性加载）。 */
    this._eventsLoaded = false;
    this._lock = lockFor(this.dir);
    this._tmpSeq = 0;
    /** 已经为「无租约的 ASSIGNED」报过警的任务，避免 sweeper 每轮重复写日志。 */
    this._reportedQuarantine = new Set();
  }

  /* ── 加载与持久化 ── */

  /**
   * 读快照 + 回放事件日志。幂等：重复调用只是重新读一遍盘。
   *
   * 回放的意义：快照是「整份覆盖写」，一旦最后一次落盘丢失或写坏，磁盘上就没有
   * 别的状态来源了；而事务性事件里的 `task` 快照带着当时的 revision，能把它捞回来。
   * 只信任白名单事件类型（STATE_EVENT_TYPES）带的状态，理由见那里的注释。
   * @returns {Promise<{revision: number, tasks: number}>}
   */
  async load() {
    await mkdir(this.dir, { recursive: true });
    const state = (await this._readSnapshotFromDisk()) ?? emptyState(this.workspaceId);
    const events = await this._readEventLogs();
    for (const [id, list] of events) {
      const newest = [...list].reverse().find(
        (event) => event && STATE_EVENT_TYPES.has(event.type) && event.task && typeof event.task === 'object',
      );
      if (newest === undefined) continue;
      const revision = Number(newest.revision);
      // 只有日志比快照新才回放：事件里的快照是「那次写入之后」的状态，
      // revision 更小说明它已经被更晚的快照覆盖了。
      if (Number.isFinite(revision) && revision > Number(state.revision)) {
        state.tasks[id] = normalizeTask(newest.task, this.workspaceId);
        state.revision = revision;
        state.updatedAt = newest.at ?? state.updatedAt;
      } else if (state.tasks[id] === undefined && !existsSync(this.snapshotPath)) {
        // 快照整个不见了：日志就是唯一真源，无条件按最后一条状态事件恢复
        state.tasks[id] = normalizeTask(newest.task, this.workspaceId);
        if (Number.isFinite(revision) && revision > Number(state.revision)) state.revision = revision;
      }
    }
    this._state = state;
    this._events = events;
    this._eventsLoaded = true;
    return { revision: Number(state.revision) || 0, tasks: Object.keys(state.tasks).length };
  }

  /** 快照头：{ revision, updatedAt }。 */
  header() {
    return { revision: Number(this._state.revision) || 0, updatedAt: this._state.updatedAt ?? null };
  }

  /** 全量快照（深拷贝），tasks 为数组。读操作，任何 Agent 可调。 */
  snapshot() {
    return {
      revision: Number(this._state.revision) || 0,
      updatedAt: this._state.updatedAt ?? null,
      workspace_id: this._state.workspace_id ?? this.workspaceId,
      tasks: Object.values(this._state.tasks).map((task) => clone(task)),
    };
  }

  /**
   * 单个任务（深拷贝）或 undefined。
   * 可选第二参数 workspaceId：给了就顺便做跨工作区判定，不符返回 undefined
   * （返回值形态不变，所以旧调用不受影响）。
   * @param {string} id
   * @param {string} [workspaceId]
   */
  get(id, workspaceId) {
    const task = this._state.tasks[id];
    if (task === undefined) return undefined;
    if (workspaceId !== undefined && !workspaceMatches(task.workspace_id, workspaceId)) return undefined;
    return clone(task);
  }

  /**
   * 过滤列表（深拷贝数组）。
   * filter: { status, owner_agent, parent_id, workspace_id }
   * 只对**显式传入**的键做过滤，所以 `{ owner_agent: null }` 是有效的
   * ——它表示「找无主任务」，而 `{}` 表示不筛 owner。这个区别是刻意的：
   * 派单器需要前者。
   * @param {{status?: string, owner_agent?: string|null, parent_id?: string|null, workspace_id?: string}} [filter]
   */
  list(filter = {}) {
    const keys = ['status', 'owner_agent', 'parent_id', 'workspace_id'];
    const active = keys.filter((key) => Object.prototype.hasOwnProperty.call(filter ?? {}, key));
    return Object.values(this._state.tasks)
      .filter((task) => active.every((key) => {
        if (key === 'workspace_id') return workspaceMatches(task.workspace_id, filter[key]);
        return (task[key] ?? null) === (filter[key] ?? null);
      }))
      .map((task) => clone(task));
  }

  /** 该 task 的事件数组（按写入序，深拷贝）。读操作，任何 Agent 可调。 */
  events(id) {
    return (this._events.get(id) ?? []).map((event) => clone(event));
  }

  /**
   * 工作区校验辅助（文档 §12.2 要求每个入口先过这道门）。
   * 同步读内存快照，所以调用前应先 `load()`。
   * @param {string} id
   * @param {string} workspaceId
   * @returns {{ok: true, task: object} | {ok: false, code: string}}
   */
  assertWorkspace(id, workspaceId) {
    const task = this._state.tasks[id];
    if (task === undefined) return { ok: false, code: TASK_ERRORS.NOT_FOUND };
    if (!workspaceMatches(task.workspace_id, workspaceId)) {
      return { ok: false, code: TASK_ERRORS.WORKSPACE_MISMATCH };
    }
    return { ok: true, task: clone(task) };
  }

  /* ── 写操作 ── */

  /**
   * 创建任务。
   * spec: { id?, parent_id?, goal, priority?, write_scope?, owner_agent? }
   * status 默认 READY、version 从 1 起；给了 owner_agent 就直接落 ASSIGNED + 租约
   * （否则会出现「状态 READY 却有 owner」这种谁也不敢认领的僵尸任务）。
   * @returns {Promise<{ok: true, task: object} | {ok: false, code: string, reason?: string}>}
   */
  async open(spec = {}) {
    const source = spec && typeof spec === 'object' ? spec : {};
    const goal = typeof source.goal === 'string' ? source.goal.trim() : '';
    if (goal === '') {
      return { ok: false, code: TASK_ERRORS.BAD_STATE, reason: 'open 需要一个非空 goal' };
    }
    const id = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : taskId();
    const parentId = source.parent_id === null || source.parent_id === undefined
      ? null
      : String(source.parent_id);
    if (parentId === id) {
      return { ok: false, code: TASK_ERRORS.BAD_STATE, reason: 'parent_id 不能等于自身 id' };
    }
    const owner = normAgent(source.owner_agent);
    const priority = Number.isFinite(Number(source.priority))
      ? Math.min(4, Math.max(0, Math.trunc(Number(source.priority))))
      : 2;
    const writeScope = Array.isArray(source.write_scope)
      ? source.write_scope.map(String)
      : (typeof source.write_scope === 'string' && source.write_scope ? [source.write_scope] : []);

    return this._withState(async (state) => {
      if (state.tasks[id] !== undefined) {
        return { ok: false, code: TASK_ERRORS.DUPLICATE_ID, task: clone(state.tasks[id]) };
      }
      const at = this._now();
      const task = {
        id,
        parent_id: parentId,
        goal,
        status: owner ? TASK_STATUS.ASSIGNED : TASK_STATUS.READY,
        owner_agent: owner,
        version: 1,
        lease_until: owner ? at + this.leaseMs : null,
        priority,
        write_scope: writeScope,
        result_ref: null,
        result_digest: null,
        error: null,
        workspace_id: this.workspaceId,
        created_at: at,
        updated_at: at,
      };
      state.tasks[id] = task;
      await this._commit(state, [{ task_id: id, event: { type: 'task/opened', agent_id: owner, task: clone(task) } }]);
      return { ok: true, task: clone(task) };
    });
  }

  /**
   * 原子认领。只有 `status==='READY' && owner_agent===null` 才成功。
   *
   * N 个并发 claim 同一 task 时，有且只有一个 `ok:true`——由 `_withState` 的互斥
   * 保证（整段读-改-写不可分割），不是靠运气。
   *
   * `opts.reclaimExpired`：默认 false。文档把「租约过期 → 退回 READY」明确交给
   * sweeper（`reclaim()`），认领顺手抢别人的过期任务会让「谁在什么时候把任务收回去」
   * 变得不可追踪。需要省掉这次 sweeper 轮询时可以显式传 true，语义等价于
   * 「先 reclaim 再 claim」，两步仍在同一个互斥段里，不会出现中间态被别的认领插队。
   * @param {string} id
   * @param {string} agentId
   * @param {{ leaseMs?: number, reclaimExpired?: boolean }} [opts]
   */
  async claim(id, agentId, opts = {}) {
    const agent = normAgent(agentId);
    if (agent === null) {
      return { ok: false, code: TASK_ERRORS.BAD_STATE, reason: 'claim 需要 agentId（文档 §12：消息必须带 agent_id）' };
    }
    const options = opts && typeof opts === 'object' ? opts : {};
    const leaseMs = Number.isFinite(options.leaseMs) && options.leaseMs > 0
      ? Number(options.leaseMs)
      : this.leaseMs;

    return this._withState(async (state) => {
      const task = state.tasks[id];
      if (task === undefined) return { ok: false, code: TASK_ERRORS.NOT_FOUND };
      const pending = [];
      if (options.reclaimExpired === true && this._leaseExpired(task)) {
        pending.push({ task_id: id, event: this._reclaimTask(task, 'claim(reclaimExpired) 前回收过期租约') });
      }
      if (task.owner_agent !== null && task.owner_agent !== undefined) {
        // 注意这里的**顺序**：owner 判定必须在 status 判定之前。
        // 一个已被认领的任务处于 ASSIGNED（有的实现会推进到 RUNNING），若先判
        // status 就会得到 BAD_STATE，而「重复认领」的约定错误码是 ALREADY_CLAIMED。
        // 同样不区分「是不是自己再认领一次」：任何 owner 已存在的认领都必须失败，
        // 否则「只有一个 ok:true」这条不变式会被同一个 agent 的重复调用破掉。
        return { ok: false, code: TASK_ERRORS.ALREADY_CLAIMED, task: clone(task) };
      }
      if (task.status !== TASK_STATUS.READY) {
        return { ok: false, code: TASK_ERRORS.BAD_STATE, task: clone(task), reason: `status=${task.status} 不可认领` };
      }
      const at = this._now();
      task.owner_agent = agent;
      task.status = TASK_STATUS.ASSIGNED;
      task.version = Number(task.version) + 1;
      task.lease_until = at + leaseMs;
      task.updated_at = at;
      pending.push({
        task_id: id,
        event: { type: 'task/claimed', agent_id: agent, lease_until: task.lease_until, task: clone(task) },
      });
      await this._commit(state, pending);
      return { ok: true, task: clone(task) };
    });
  }

  /**
   * 心跳续约。owner + version 都对、且租约尚未过期时才成功。
   * **不改 task.version**（文档 §3.3）：续约不是状态推进，动了版本会让 owner
   * 手里刚拿到的 version 立刻作废，等于逼人每 10 秒重读一次快照。
   * @param {string} id
   * @param {string} agentId
   * @param {number} version 期望版本
   * @param {{ leaseMs?: number }} [opts]
   */
  async renewLease(id, agentId, version, opts = {}) {
    const agent = normAgent(agentId);
    if (agent === null) return { ok: false, code: TASK_ERRORS.BAD_STATE, reason: 'renewLease 需要 agentId' };
    const options = opts && typeof opts === 'object' ? opts : {};
    const leaseMs = Number.isFinite(options.leaseMs) && options.leaseMs > 0
      ? Number(options.leaseMs)
      : this.leaseMs;

    return this._withState(async (state) => {
      const task = state.tasks[id];
      if (task === undefined) return { ok: false, code: TASK_ERRORS.NOT_FOUND };
      if (task.owner_agent !== agent) return { ok: false, code: TASK_ERRORS.NOT_OWNER, task: clone(task) };
      if (Number(task.version) !== Number(version)) return { ok: false, code: TASK_ERRORS.VERSION_CONFLICT, task: clone(task) };
      if (!LEASED_STATUSES.has(task.status)) {
        return { ok: false, code: TASK_ERRORS.BAD_STATE, task: clone(task), reason: `status=${task.status} 没有租约可续` };
      }
      if (this._leaseExpired(task)) {
        // 过期就是过期：放过它等于让一个已经不负责的 owner 把自己续回来，
        // 而它这期间写的任何东西都没有人再校验过。
        return { ok: false, code: TASK_ERRORS.LEASE_EXPIRED, task: clone(task) };
      }
      const at = this._now();
      task.lease_until = at + leaseMs;
      task.updated_at = at;
      await this._commit(state, [{
        task_id: id,
        event: { type: 'task/renewed', agent_id: agent, lease_until: task.lease_until, task: clone(task) },
      }]);
      return { ok: true, task: clone(task) };
    });
  }

  /**
   * 乐观锁结算：owner 与 version 都必须对得上。
   *
   * 失败判定的顺序是刻意排的（文档 §3.4 的四分表 + §13 验收第 6/7 条）：
   *   1. NOT_FOUND
   *   2. BAD_STATE         —— outcome.status 不是合法终态
   *   3. LEASE_EXPIRED     —— owner 已空/已换人**且 version 已推进**
   *                            （= 被回收或被重派，旧结果一律作废并留证）
   *   4. NOT_OWNER         —— owner 不匹配且版本没推进（从没拥有过这个任务）
   *   5. DUPLICATE_RESULT  —— 同一 digest 已经结算成功过（必须排在版本检查之前：
   *                            第一次成功的 settle 已经把 version 推进了，
   *                            若先查 version，第二次提交会得到 VERSION_CONFLICT，
   *                            「重复提交返回 DUPLICATE_RESULT」就直接失效）
   *   6. VERSION_CONFLICT  —— owner 对、版本错
   *   7. BAD_STATE         —— owner 对、版本对，但任务已结算（不能改终态任务）
   *   8. LEASE_EXPIRED     —— owner 对、版本对，但租约已过期且还没被 sweeper 回收
   * 任何失败分支都**不改任务**（连 version 都不动），只可能往 orphaned/ 写留证文件。
   * @param {string} id
   * @param {string} agentId
   * @param {number} expectedVersion
   * @param {{status: string, result_ref?: string|null, error?: string|null, digest?: string|null, result_digest?: string|null}} outcome
   */
  async settle(id, agentId, expectedVersion, outcome = {}) {
    const agent = normAgent(agentId);
    if (agent === null) return { ok: false, code: TASK_ERRORS.BAD_STATE, reason: 'settle 需要 agentId' };
    const detail = outcome && typeof outcome === 'object' ? outcome : {};
    const status = detail.status;
    if (!SETTLE_STATUSES.has(status)) {
      return { ok: false, code: TASK_ERRORS.BAD_STATE, reason: `settle 不接受 status=${String(status)}` };
    }
    const version = Number(expectedVersion);
    if (!Number.isFinite(version)) {
      return { ok: false, code: TASK_ERRORS.VERSION_CONFLICT, reason: 'expectedVersion 必须是数字' };
    }
    const digest = normDigest(detail.digest ?? detail.result_digest);

    return this._withState(async (state) => {
      const task = state.tasks[id];
      if (task === undefined) return { ok: false, code: TASK_ERRORS.NOT_FOUND };

      if (task.owner_agent !== agent) {
        if (Number(task.version) > version) {
          await this._quarantineLocked(state, task, { agent_id: agent, expected_version: version, ...detail }, TASK_ERRORS.LEASE_EXPIRED);
          return { ok: false, code: TASK_ERRORS.LEASE_EXPIRED, task: clone(task) };
        }
        return { ok: false, code: TASK_ERRORS.NOT_OWNER, task: clone(task) };
      }
      if (digest !== null && normDigest(task.result_digest) === digest) {
        return { ok: false, code: TASK_ERRORS.DUPLICATE_RESULT, task: clone(task) };
      }
      if (Number(task.version) !== version) {
        return { ok: false, code: TASK_ERRORS.VERSION_CONFLICT, task: clone(task) };
      }
      if (TERMINAL_STATUSES.has(task.status)) {
        return { ok: false, code: TASK_ERRORS.BAD_STATE, task: clone(task), reason: `任务已结算（status=${task.status}）` };
      }
      if (this._leaseExpired(task)) {
        await this._quarantineLocked(state, task, { agent_id: agent, expected_version: version, ...detail }, TASK_ERRORS.LEASE_EXPIRED);
        return { ok: false, code: TASK_ERRORS.LEASE_EXPIRED, task: clone(task) };
      }

      const at = this._now();
      task.status = status;
      task.result_ref = detail.result_ref ?? null;
      task.error = detail.error ?? null;
      if (digest !== null) task.result_digest = digest;
      task.version = Number(task.version) + 1;
      // 清租约但不移交 ownership：owner_agent 留作审计（谁交的），
      // 而「无主」只由 release()/reclaim() 产生，这两条路径的语义才不会混。
      task.lease_until = null;
      task.updated_at = at;
      await this._commit(state, [{
        task_id: id,
        event: { type: 'task/settled', agent_id: agent, status, result_ref: task.result_ref, result_digest: task.result_digest, task: clone(task) },
      }]);
      return { ok: true, task: clone(task) };
    });
  }

  /**
   * 主动交还任务（不结算）：退回 READY、清 owner、version+1。
   * 只允许当前 owner 做，且必须带对版本。
   * @param {string} id
   * @param {string} agentId
   * @param {number} version
   */
  async release(id, agentId, version) {
    const agent = normAgent(agentId);
    if (agent === null) return { ok: false, code: TASK_ERRORS.BAD_STATE, reason: 'release 需要 agentId' };
    return this._withState(async (state) => {
      const task = state.tasks[id];
      if (task === undefined) return { ok: false, code: TASK_ERRORS.NOT_FOUND };
      if (task.owner_agent !== agent) return { ok: false, code: TASK_ERRORS.NOT_OWNER, task: clone(task) };
      if (Number(task.version) !== Number(version)) return { ok: false, code: TASK_ERRORS.VERSION_CONFLICT, task: clone(task) };
      if (TERMINAL_STATUSES.has(task.status)) {
        return { ok: false, code: TASK_ERRORS.BAD_STATE, task: clone(task), reason: `任务已结算（status=${task.status}）` };
      }
      const at = this._now();
      task.owner_agent = null;
      task.status = TASK_STATUS.READY;
      task.version = Number(task.version) + 1;
      task.lease_until = null;
      task.updated_at = at;
      await this._commit(state, [{
        task_id: id,
        event: { type: 'task/released', agent_id: agent, task: clone(task) },
      }]);
      return { ok: true, task: clone(task) };
    });
  }

  /**
   * 取消任务（用户说「停」/ 主编抢占）。
   *
   * 与 settle/renewLease/release 不同，**不要求调用方是 owner**：取消是主编/用户
   * 层级的权力，子 Agent 无权拒绝自己被取消（文档 §7 第一类插话走的就是这条）。
   * agentId 允许为空，表示「系统/主编代取消」，会记进事件里。
   * 版本校验走 opts.expectedVersion：给了就严格比对，没给就按当前版本直接取消。
   * @param {string} id
   * @param {string} [agentId]
   * @param {{ expectedVersion?: number, reason?: string }} [opts]
   */
  async cancel(id, agentId, opts = {}) {
    const agent = normAgent(agentId);
    const options = opts && typeof opts === 'object' ? opts : {};
    return this._withState(async (state) => {
      const task = state.tasks[id];
      if (task === undefined) return { ok: false, code: TASK_ERRORS.NOT_FOUND };
      if (options.expectedVersion !== undefined && options.expectedVersion !== null
        && Number(options.expectedVersion) !== Number(task.version)) {
        return { ok: false, code: TASK_ERRORS.VERSION_CONFLICT, task: clone(task) };
      }
      if (TERMINAL_STATUSES.has(task.status)) {
        return { ok: false, code: TASK_ERRORS.BAD_STATE, task: clone(task), reason: `任务已结算（status=${task.status}），取消不再有意义` };
      }
      const at = this._now();
      task.status = TASK_STATUS.CANCELLED;
      task.version = Number(task.version) + 1;
      task.lease_until = null;
      task.error = typeof options.reason === 'string' && options.reason ? options.reason : (task.error ?? 'cancelled');
      task.updated_at = at;
      await this._commit(state, [{
        task_id: id,
        event: { type: 'task/cancelled', agent_id: agent, reason: task.error, task: clone(task) },
      }]);
      return { ok: true, task: clone(task) };
    });
  }

  /**
   * 回收过期租约（sweeper 调）。
   *
   * 回收必须 `version+1`（文档 §3.5）：否则旧 owner 拿着旧 version 还能 settle 成功，
   * 防插手等于没有。
   *
   * 返回值里的 `quarantined` 指**状态自相矛盾、因此不敢自动回收**的任务：
   * 处于 ASSIGNED/RUNNING 却没有租约。这种任务按「过期」处理会凭空剥夺一个可能
   * 正在干活的 owner（它的 lease_until 是被谁弄丢的说不清），所以只留证 + 报出来
   * 给人决定。正常的过期租约一律进 `reclaimed`。
   * （文档没有定义这个字段的语义，这是本模块的约定。）
   * @returns {Promise<{ok: true, reclaimed: string[], quarantined: string[]}>}
   */
  async reclaim() {
    return this._withState(async (state) => {
      const now = this._now();
      const reclaimed = [];
      const quarantined = [];
      const pending = [];
      for (const task of Object.values(state.tasks)) {
        if (!LEASED_STATUSES.has(task.status)) continue;
        if (task.lease_until === null || task.lease_until === undefined) {
          quarantined.push(task.id);
          // 同一个任务每个 sweeper 周期都报一次会淹掉事件日志；报过一次就够了。
          // 用实例内的 Set 而不是查日志：sweeper 每 5s 跑一次（文档 §5），
          // 而重读全部 .jsonl 只为了去重太贵。
          if (!this._reportedQuarantine.has(task.id)) {
            this._reportedQuarantine.add(task.id);
            pending.push({
              task_id: task.id,
              event: { type: 'task/quarantined', reason: 'ASSIGNED/RUNNING 却没有 lease_until，状态自相矛盾，不自动回收' },
            });
          }
          continue;
        }
        if (Number(task.lease_until) > now) continue;
        pending.push({ task_id: task.id, event: this._reclaimTask(task, '租约过期') });
        reclaimed.push(task.id);
      }
      if (pending.length > 0) await this._commit(state, pending);
      return { ok: true, reclaimed, quarantined };
    });
  }

  /**
   * 追加一条事件（append-only，不碰任务字段）。
   *
   * 这是**唯一对非 owner 开放的写入口**，对应文档 §8.4 的 TaskSuggestion：
   * 其他子 Agent 可以留言/报进度，但不能改别人的任务。事件里的 `task` 字段会被
   * 剥掉——否则一条自造事件就能在下次 load() 重放时篡改状态。
   * @param {string} id
   * @param {{type?: string} & Record<string, unknown>} event
   */
  async appendEvent(id, event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return { ok: false, code: TASK_ERRORS.BAD_STATE, reason: 'event 必须是对象' };
    }
    const { task: _dropped, seq: _seq, revision: _revision, task_id: _taskId, ...rest } = event;
    return this._withState(async (state) => {
      if (state.tasks[id] === undefined) return { ok: false, code: TASK_ERRORS.NOT_FOUND };
      const record = await this._recordEvent(id, { revision: Number(state.revision) || 0, ...rest });
      return { ok: true, event: clone(record) };
    });
  }

  /**
   * 显式留证：把一份「当前事实证明有问题的结果」写进 orphaned/ 并记一条事件。
   * 主编在收到过期 settlement 时可以主动调它（文档 §5 的 `registry.quarantine`）。
   * 无论调多少次，**任务字段一个字节都不会变**。
   * @param {string} id
   * @param {Record<string, unknown>} [payload] 要留证的内容
   * @param {string} [reason] 留证原因
   */
  async quarantine(id, payload = {}, reason = 'stale-result') {
    return this._withState(async (state) => {
      const task = state.tasks[id];
      if (task === undefined) return { ok: false, code: TASK_ERRORS.NOT_FOUND };
      const record = await this._quarantineLocked(state, task, payload, reason);
      return { ok: true, task: clone(task), orphan: record };
    });
  }

  /* ── 内部实现 ── */

  _now() {
    const value = Number(this.clock());
    return Number.isFinite(value) ? value : Date.now();
  }

  _leaseExpired(task) {
    if (task.lease_until === null || task.lease_until === undefined) return false;
    return Number(task.lease_until) <= this._now();
  }

  /**
   * 互斥段：取当前权威状态 → 交给 fn → fn 自己决定要不要 _commit。
   * 每次进入都重读磁盘（而不是只信内存），这样同一目录上的两个实例
   * （主编一个、子 Agent 一个）不会各自拿一份过期快照互相覆盖。
   */
  _withState(fn) {
    return this._lock.run(async () => {
      await mkdir(this.dir, { recursive: true });
      const state = await this._currentState();
      // 事件日志的重载时机，两种情况：
      //   1. 还没读过盘（新实例直接写、没调 load()）——不读就会从 seq=1 开始编号，
      //      和文件里已有的记录撞号；
      //   2. 磁盘 revision **严格大于**内存，说明别的实例写过这个目录。此时不重载，
      //      本实例的 events() 就看不到别人写的 task/claimed 之类的关键记录
      //      （而「谁认领了」正是集成方最需要看到的东西）。
      //      比 revision 而不是比对象引用：`_currentState()` 每次都重新解析磁盘，
      //      即使内容一模一样也是新对象，比引用会让这里每次都白读一遍全部日志。
      // 正常单实例路径下磁盘与内存同版本，因此不产生任何额外 I/O。
      if (!this._eventsLoaded || Number(state.revision) > Number(this._state.revision)) {
        this._events = await this._readEventLogs();
        this._eventsLoaded = true;
      }
      return fn(state);
    });
  }

  /**
   * 谁是权威状态：磁盘比内存新就用磁盘（别人写过），否则用内存。
   * 「内存更新」只发生在快照落盘失败之后——那种情况磁盘是旧的，用磁盘会把
   * 刚才那次写入回滚掉，所以内存优先。
   */
  async _currentState() {
    const disk = await this._readSnapshotFromDisk();
    if (disk !== null && Number(disk.revision) >= Number(this._state.revision)) return disk;
    return this._state;
  }

  /** 读并解析快照。不存在返回 null；解析失败则把坏文件挪进 orphaned/ 并返回 null。 */
  async _readSnapshotFromDisk() {
    let raw;
    try {
      raw = await readFile(this.snapshotPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('快照顶层不是对象');
      }
      const tasks = {};
      const source = parsed.tasks && typeof parsed.tasks === 'object' ? parsed.tasks : {};
      for (const [key, value] of Object.entries(source)) {
        tasks[key] = normalizeTask(value, this.workspaceId);
      }
      return {
        revision: Number(parsed.revision) || 0,
        updatedAt: parsed.updatedAt ?? null,
        workspace_id: parsed.workspace_id ?? this.workspaceId,
        tasks,
      };
    } catch (error) {
      // 快照坏了不能当没发生过就直接覆盖写：先把残骸留证，再让事件日志顶上
      await this._quarantineFile(this.snapshotPath, `快照解析失败：${error.message}`);
      return null;
    }
  }

  /** 读全部 <taskId>.jsonl。行解析失败只跳过那一行（append-only 语义下一行就是一条记录）。 */
  async _readEventLogs() {
    const logs = new Map();
    let names = [];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if (error?.code === 'ENOENT') return logs;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith(EVENT_SUFFIX) || name.startsWith('.')) continue;
      const id = name.slice(0, -EVENT_SUFFIX.length);
      let raw = '';
      try {
        raw = await readFile(join(this.dir, name), 'utf8');
      } catch {
        continue;
      }
      const list = [];
      for (const line of raw.split('\n')) {
        const text = line.trim();
        if (text === '') continue;
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object') list.push(parsed);
        } catch {
          // 半行（进程被杀在 write 中间）跳过即可，下一行仍是一条完整记录
        }
      }
      logs.set(id, list);
    }
    return logs;
  }

  /**
   * 落盘一次变更。
   *
   * 顺序：先追加事件日志，再原子替换快照。反过来做的话，快照写成功而事件丢失，
   * 记录就断了；按现在这个顺序，即使快照写失败，事件日志里的 task 快照
   * （带 revision）也能在下次 load() 时把状态重放回来。
   */
  async _commit(state, pending = []) {
    state.revision = (Number(state.revision) || 0) + 1;
    state.updatedAt = this._now();
    for (const item of pending) {
      await this._recordEvent(item.task_id, { revision: state.revision, ...item.event });
    }
    await this._writeSnapshotAtomic(state);
    this._state = state;
    return state;
  }

  /** 原子替换快照：同目录 tmp + rename（rename 在 Windows 上也是替换语义）。 */
  async _writeSnapshotAtomic(state) {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `.${SNAPSHOT_FILE}.${process.pid}.${++this._tmpSeq}.tmp`);
    const payload = JSON.stringify({
      revision: state.revision,
      updatedAt: state.updatedAt,
      workspace_id: state.workspace_id ?? this.workspaceId,
      tasks: state.tasks,
    }, null, 2);
    await writeFile(tmp, payload, 'utf8');
    try {
      await rename(tmp, this.snapshotPath);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }

  /** 追加一条事件：内存视图 + 文件，两处都写，保证 load() 后 events() 一致。 */
  async _recordEvent(taskIdValue, event) {
    const {
      seq: _ignoredSeq, task_id: _ignoredId, revision: wantedRevision, at: wantedAt, ...rest
    } = event ?? {};
    const list = this._events.get(taskIdValue) ?? [];
    const record = {
      revision: Number.isFinite(Number(wantedRevision)) ? Number(wantedRevision) : (Number(this._state.revision) || 0),
      seq: list.length + 1,
      at: Number.isFinite(Number(wantedAt)) ? Number(wantedAt) : this._now(),
      type: 'event',
      ...rest,
      task_id: taskIdValue,
    };
    list.push(record);
    this._events.set(taskIdValue, list);
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, `${taskIdValue}${EVENT_SUFFIX}`), `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  /**
   * 把一个任务退回 READY 并推进版本。只改字段、返回事件，落盘交给调用方的 _commit，
   * 这样 reclaim() 一次扫到的 N 个任务共享一次 revision（同一次清扫 = 一个批次）。
   *
   * 事件类型写死 `lease/expired`，不是自造名：集成方与测试会按这个名字找
   * 「这个任务是被租约回收的」这条记录（文档 §3.4 的处置表以它作为判据）。
   */
  _reclaimTask(task, note) {
    const previousOwner = task.owner_agent;
    task.owner_agent = null;
    task.status = TASK_STATUS.READY;
    task.version = Number(task.version) + 1;
    task.lease_until = null;
    task.updated_at = this._now();
    return {
      type: 'lease/expired',
      agent_id: previousOwner,
      reason: note,
      previous_version: Number(task.version) - 1,
      task: clone(task),
    };
  }

  /**
   * 过期结果留证。写 `orphaned/<taskId>.json`（已存在就加时间戳+随机后缀，不覆盖旧证据），
   * 并在事件日志里记一条 result/orphaned。**绝不碰任务字段，也不写快照。**
   */
  async _quarantineLocked(state, task, payload, reason) {
    await mkdir(this.orphanDir, { recursive: true });
    const at = this._now();
    let file = join(this.orphanDir, `${task.id}.json`);
    if (existsSync(file)) {
      file = join(this.orphanDir, `${task.id}-${at}-${randomBytes(2).toString('hex')}.json`);
    }
    const record = {
      task_id: task.id,
      workspace_id: task.workspace_id,
      reason,
      at,
      task_version: task.version,
      task_status: task.status,
      current_owner: task.owner_agent ?? null,
      lease_until: task.lease_until ?? null,
      rejected: safeJson(payload),
    };
    await writeFile(file, JSON.stringify(record, null, 2), 'utf8');
    await this._recordEvent(task.id, {
      revision: Number(state?.revision) || 0,
      at,
      type: 'result/orphaned',
      reason,
      file,
    });
    return { file, at, reason };
  }

  /** 把坏文件挪进 orphaned/ 留证（快照解析失败时用）。留证失败不影响主流程。 */
  async _quarantineFile(file, reason) {
    try {
      await mkdir(this.orphanDir, { recursive: true });
      const dest = join(
        this.orphanDir,
        `corrupt-${basename(file)}-${this._now()}-${randomBytes(2).toString('hex')}.txt`,
      );
      await rename(file, dest);
      return dest;
    } catch {
      return null;
    }
  }
}
