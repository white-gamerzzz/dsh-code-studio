/**
 * 子会话身份登记表 + `write_scope` 硬化（代码工作室版）。
 *
 * 两件事共用一个模块，因为它们服务同一个问题：**「这次工具调用是谁在打、他有权写哪里」**。
 *
 * ## 为什么要 `write_scope` 硬化
 *
 * `write_scope` 在改造前是**装饰性的** —— 只在 `novel_task` 的参数说明、任务的字段、
 * 以及给人看的回执里出现，全库没有任何一处**检查**它。于是三个并行的写作 Agent 各自
 * 「允许写 `正文/第05章.md`」时，谁后写谁赢，而账本上三笔都显示成功：并行出多版本会
 * 静默互相覆盖。
 *
 * 硬化用**登记表**而不是 `tools.restrict()`：`restrict` 只能按**工具名**过滤
 * （`dsh-tools/lib/index.js:2895`），不能按参数里的**路径**过滤；而且它只过滤该作用域
 * 继承来的工具，本层注册的不在其列。所以只能在 `guard` 里按「这次调用的目标路径」判。
 *
 * ## 为什么登记表按 sessionId 存
 *
 * guard 拿到的是 `exec.agent`，从它能稳定取到的是 `agent.session.header.id`。
 * 登记表把「派单时决定的 write_scope」与「运行期的写入目标」连起来，结算时清掉。
 *
 * ## 共享的前提（改错会静默失效）
 *
 * `lib/index.js`（主插件，写登记表）与 `lib/editor-guard.js`（预设子插件，读登记表）
 * 必须 `import` **同一个** `./session-roles.js`。ESM 按解析后的绝对路径缓存模块实例，
 * 同一 Node 进程内两边拿到的是**同一个 Map**；把实现复制一份、或改其中一边的路径，
 * 硬化就会静默失效（写入不再被拦，但也没有任何报错）。
 *
 * 硬约束：本文件不要加 `export default`（cordis 的 `unwrapExports` 会取 `exports.default`）。
 */

/** 会写文件、且目标路径能静态取到的工具 → 从参数里取路径的键。 */
const PATH_TOOLS = Object.freeze({
  write: 'file_path',
  edit: 'file_path',
});

/** 记忆白名单的前缀（记忆文件是主编唯一被允许自己写的东西）。 */
export const EDITOR_MEMORY_DIR = '/.codewrite/editor/';

/** sessionId → { role, writeScope, taskId, label }。进程内、易失；冷恢复后为空。 */
const MARKS = new Map();

/** 归一化路径：反斜杠转正斜杠、折叠重复斜杠、去掉结尾斜杠、去掉开头的 `./`。 */
export function normalizePath(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/** 是否是绝对路径（盘符式或根式）。 */
function isAbsolutePath(path) {
  return /^[A-Za-z]:\//.test(path) || path.startsWith('/');
}

/**
 * 把路径折算成「相对作品目录」的形式，好与 `write_scope` 里的相对路径比较。
 * 已经在作品目录内的绝对路径会被剥掉前缀；不在其中的绝对路径**原样保留**，
 * 于是它不可能匹配任何相对 scope —— 这正是我们想要的（写到作品目录外 = 越界）。
 * @param value 原始路径
 * @param cwd 会话工作目录（子会话继承父 cwd，所以就是作品目录）
 */
export function relativeTo(value, cwd) {
  const path = normalizePath(value);
  if (!isAbsolutePath(path)) return path;
  const base = normalizePath(cwd);
  if (base && (path === base || path.startsWith(`${base}/`))) {
    return path.slice(base.length + 1);
  }
  return path;
}

/**
 * 把含 `*` 的 scope 编译成**段内通配**的正则：`*` 只匹配任意非 `/` 字符，不跨目录层级。
 *
 * 为什么不是简单的「以 `*` 结尾 ⇒ startsWith」：`write_scope` 里的 `*` 出现在中间才是常态
 * （`正文/第05章.*.md`、`正文/第05章.v*.md`），前缀匹配对这种形状**永远返回 false** ——
 * 而同一份 scope 在别处（`novel_dispatch` 的 `variants` 分组任务）正是这么生成的，
 * 写成前缀匹配的话，那条 scope 会静默变成「什么都不允许」。
 */
function scopePattern(scope) {
  const body = scope
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${body}$`);
}

/**
 * 目标路径是否落在 write_scope 内。
 *
 * 规则（按顺序）：
 *   - `write_scope` 为空/未设置 ⇒ **不限制**（向后兼容：手工派单没开账时全放开）。
 *   - 完全相等 ⇒ 允许。
 *   - scope 是目录（`正文` / `正文/`）⇒ 其下任意层级允许。
 *   - scope 含 `*` ⇒ **段内通配**（`正文/第05章.*.md`、`正文/第05章.v*.md`），`*` 不跨 `/`。
 *   - scope 以 `*` 结尾 ⇒ 额外按前缀匹配（允许 `*` 跨目录层级，向后兼容）。
 *   - 其余一律拒绝。
 */
export function allowedByScope(target, writeScope, cwd) {
  const scopes = Array.isArray(writeScope) ? writeScope.filter((item) => String(item ?? '').trim() !== '') : [];
  if (scopes.length === 0) return true;
  const path = relativeTo(target, cwd);
  if (!path) return true;
  for (const raw of scopes) {
    const scope = relativeTo(raw, cwd);
    if (!scope) continue;
    if (path === scope) return true;
    if (path.startsWith(`${scope}/`)) return true;
    if (scope.includes('*') && scopePattern(scope).test(path)) return true;
    if (scope.endsWith('*') && path.startsWith(scope.slice(0, -1))) return true;
  }
  return false;
}

/**
 * 登记一个子会话（派单时调用，**必须在子会话真的开始跑之前**）。
 * @param sessionId 子会话 id（= 编排器自造并交给 `startActivation({ childId })` 的那个）
 * @param info `{ role, writeScope, taskId, label }`
 */
export function markChild(sessionId, info = {}) {
  const id = String(sessionId ?? '').trim();
  if (!id) return undefined;
  const mark = {
    role: String(info.role ?? '').trim(),
    writeScope: Array.isArray(info.writeScope)
      ? info.writeScope.map((item) => String(item)).filter((item) => item.trim() !== '')
      : [],
    taskId: info.taskId === undefined || info.taskId === null ? '' : String(info.taskId),
    label: String(info.label ?? '').trim(),
    parentId: info.parentId === undefined || info.parentId === null ? '' : String(info.parentId),
  };
  MARKS.set(id, mark);
  return mark;
}

/** 统计某个父会话当前在飞（已派未结算）的直接子会话数。深度闸用，同步。 */
export function countChildrenOf(parentId) {
  const want = String(parentId ?? '').trim();
  if (!want) return 0;
  let n = 0;
  for (const mark of MARKS.values()) if (mark.parentId === want) n += 1;
  return n;
}

/** 撤销登记（结算 / 中断时调用）。 */
export function unmarkChild(sessionId) {
  const id = String(sessionId ?? '').trim();
  return id ? MARKS.delete(id) : false;
}

/** 读登记（返回副本，避免调用方改坏内部状态）。 */
export function markOf(sessionId) {
  const id = String(sessionId ?? '').trim();
  if (!id) return undefined;
  const mark = MARKS.get(id);
  return mark === undefined ? undefined : { ...mark, writeScope: [...mark.writeScope] };
}

/** 只取 write_scope（书写路径检查用）。 */
export function writeScopeOf(sessionId) {
  return markOf(sessionId)?.writeScope ?? [];
}

/** 清空全部登记。只给测试用 —— 生产代码里登记与结算必须一一对应。 */
export function clearMarks() {
  MARKS.clear();
}

/** 当前登记条数。只给测试与诊断用。 */
export function markCount() {
  return MARKS.size;
}

/** 从 `exec.agent` 取会话 id（子会话与主编都能取到）。 */
export function sessionIdOf(agent) {
  const id = agent?.session?.header?.id ?? agent?.session?.id ?? agent?.id;
  return id === undefined || id === null ? '' : String(id);
}

/** 从 `exec.agent` 取会话工作目录（子会话继承父 cwd，所以就是作品目录）。 */
export function sessionCwdOf(agent) {
  return agent?.session?.header?.cwd ?? '';
}

/**
 * guard 用的写入路径检查。
 *
 * **只检查 `PATH_TOOLS` 里的工具**（`write` / `edit`）—— 它们的 `file_path` 是静态可取的。
 * `pwsh` / `bash` 的命令串无法静态判定目标，所以不在这里检查：并发出文必须走
 * `write`/`edit`，这是「角色卡 + 派单提示词」要交代的纪律，不能靠 guard 兜。
 *
 * @param exec 工具执行事实（`name` / `arguments` / `agent`）
 * @returns 拒绝理由字符串，或 undefined 表示放行
 */
export function writeScopeReason(exec) {
  const key = PATH_TOOLS[exec?.name];
  if (key === undefined) return undefined;
  const agent = exec?.agent;
  if (agent === undefined) return undefined;
  const sessionId = sessionIdOf(agent);
  const scope = writeScopeOf(sessionId);
  if (scope.length === 0) return undefined;
  const target = exec?.arguments?.[key];
  if (target === undefined || target === null || String(target).trim() === '') return undefined;
  if (allowedByScope(target, scope, sessionCwdOf(agent))) return undefined;
  const mark = markOf(sessionId);
  return `写入越界：你这一步的 write_scope 是 ${scope.map((item) => `\`${item}\``).join(' / ')}，`
    + `而目标是 \`${String(target)}\`。${mark?.taskId ? `（任务 ${mark.taskId}）` : ''}`
    + '并行出稿时多个版本写同一个文件会互相覆盖，且账本上每一笔都会显示成功。'
    + '改回自己 scope 内的文件，或让主编重开一笔带正确 write_scope 的任务。';
}
