/**
 * 执行器接口（用户 m14694 拍板：「我不想让我们这套工作方式捆绑我们自己的 Agent」）。
 *
 * 派单/结算曾经直接焊在 DSH 上：`subagents.startActivation` + `buildContinuableActivation`
 * 派单、`ctx.on('subagent/end')` 结算。于是 region/issue/副本/待合并区这一整套工作方式
 * 只能服务 DSH 自己的子 Agent。本模块把那四个焊点收成一个对象：
 *
 *   start({ childId, label, prompt, cwd, route, signal }) -> { childId }
 *   send({ childId, text, signal })                       -> void
 *   list({ signal })                                      -> [{ id, mode?, depth? }]
 *   isLive(childId)                                       -> boolean
 *   onEnd(handler)                                        -> unsubscribe   （可选，但结算必需）
 *
 * 谁实现它，谁就能挂进同一套流程：DSH 子 Agent（makeDshExecutor）、本机任意 CLI
 * （makeCliExecutor：claude / codex / 自写脚本都行）。上层 dispatchIssue / settleIssue
 * 只认这个接口，不再 import 任何宿主 API。
 *
 * 硬约束：不加 `export default`（cordis unwrapExports 会取 default）。
 */

/** 执行器必须实现的方法（onEnd 单独判，因为只读执行器不需要结算）。 */
export const EXECUTOR_METHODS = ['start', 'send', 'list', 'isLive'];

/**
 * 校验一个对象够不够当执行器。缺方法时返回中文原因，够了返回 null。
 * @param {object} ex
 * @param {{needEnd?:boolean}} [opts] needEnd=true 时还要求 onEnd（要结算就必须有）
 * @returns {string|null}
 */
export function executorProblem(ex, opts = {}) {
  if (!ex || typeof ex !== 'object') return '执行器不是一个对象。';
  const missing = EXECUTOR_METHODS.filter((name) => typeof ex[name] !== 'function');
  if (missing.length) return `执行器缺少方法：${missing.join('、')}。`;
  if (opts.needEnd && typeof ex.onEnd !== 'function') return '执行器缺少 onEnd，无法把结算结果写回台账。';
  return null;
}

/** 把子 Agent 的结束信息规整成结算要的两段文本。 */
export function normalizeEnd(info = {}) {
  return { childId: String(info?.childId ?? info?.id ?? ''), lastAssistantMessage: info?.lastAssistantMessage, stopReason: info?.stopReason };
}

/**
 * DSH 子 Agent 执行器：把 ctx 的 subagents / agents 包成接口。
 * 结束事件由宿主喂进来（`ex.emitEnd(info)`），因为 DSH 的 end 事件从 ctx 发，不从 subagents 发。
 *
 * @param {object} spec
 * @param {object} spec.subagents   ctx.get('subagents')
 * @param {object} [spec.agents]    ctx.get('agents')，只用于 isLive 的「进程内还活着」判据
 * @param {object} spec.parent      派单的父 Agent（DSH 要求每个子会话有 parent）
 * @param {object} [spec.route]     角色 → provider/model 的路由
 * @param {AbortSignal} [spec.signal]
 * @returns {object} 执行器
 */
export function makeDshExecutor({ subagents, agents, parent, route, signal } = {}) {
  if (typeof subagents?.startActivation !== 'function') {
    throw new TypeError('makeDshExecutor: 缺少 subagents.startActivation。');
  }
  if (!parent?.id) throw new TypeError('makeDshExecutor: 缺少 parent.id。');

  const endHandlers = new Set();
  // DSH 的 listDescendants 是异步的，而 isLive 被 decideDispatch 同步调用 →
  // 先探一次缓存住，list() 再刷新。缓存为空时按「活着」处理（宁可不新建，也不重复开）。
  let durable = null;

  async function refreshDurable() {
    if (typeof subagents.listDescendants !== 'function') return null;
    try {
      const kids = await subagents.listDescendants(parent.id, signal);
      const set = new Set();
      for (const kid of Array.isArray(kids) ? kids : []) {
        if (kid?.mode !== 'continuable') continue;
        if (Number(kid?.depth) !== 1) continue;
        set.add(String(kid.id));
      }
      durable = set;
      return set;
    } catch {
      durable = null;
      return null;
    }
  }

  return {
    kind: 'dsh',
    async list(opts = {}) {
      if (!durable) await refreshDurable();
      return [...(durable ?? [])].map((id) => ({ id }));
    },
    isLive(childId) {
      const key = String(childId ?? '');
      if (!key) return false;
      if (typeof agents?.get === 'function' && agents.get(key) !== undefined) return true;
      // 没探到目录（服务缺失/报错）时保守认为活着：重复开子会话比追回一个空的更贵。
      if (durable === null) return true;
      return durable.has(key);
    },
    async start({ childId, label, prompt, cwd, route: routeOverride, signal: sig } = {}) {
      const { buildContinuableActivation, buildDispatchRequest, withDepthCap } = await import('./dispatch.js');
      const request = withDepthCap(buildDispatchRequest({
        label,
        prompt,
        parent,
        signal: sig ?? signal,
        route: routeOverride ?? route,
        cwd,
      }), subagents);
      const started = await subagents.startActivation(buildContinuableActivation({ childId, label, request }));
      return { childId: String(started?.childId ?? childId ?? '') };
    },
    async send({ childId, text, signal: sig } = {}) {
      if (typeof subagents.sendMessage !== 'function') {
        const err = new Error('执行器不支持 sendMessage（宿主没提供）。');
        err.code = 'NO_SEND_MESSAGE';
        throw err;
      }
      await subagents.sendMessage(parent, String(childId), [{ type: 'text', text: String(text ?? '') }], { signal: sig ?? signal });
    },
    onEnd(handler) {
      if (typeof handler !== 'function') return () => {};
      endHandlers.add(handler);
      return () => endHandlers.delete(handler);
    },
    /** 宿主把 subagent/end 原样喂进来。 */
    emitEnd(info) {
      const end = normalizeEnd(info);
      if (!end.childId) return;
      for (const handler of [...endHandlers]) {
        try { handler(end); } catch { /* 一个订阅者炸了不影响别人 */ }
      }
    },
    /** 中止一个子会话（可选能力；CLI 执行器是 kill 进程，这里转宿主 interrupt）。 */
    stop(childId) {
      if (typeof subagents.interrupt !== 'function') return;
      subagents.interrupt(String(childId), { kind: 'ancestor', agent: parent });
    },
  };
}

/**
 * 本机 CLI 执行器：每条 issue 起一个进程，stdout 当报告、退出码当成败。
 * 这是「外部 Agent 也能挂进来」的实证 —— claude / codex / 任何读 stdin 写 stdout 的脚本都行。
 *
 * @param {object} spec
 * @param {string} spec.command       可执行文件（如 'node'、'claude'）
 * @param {string[]|Function} spec.args 固定参数数组，或 (ctx) => string[]
 * @param {Function} [spec.cwdOf]      (ctx) => cwd，默认 ctx.cwd
 * @param {number} [spec.timeoutMs]    默认 30 分钟
 * @param {Function} [spec.spawnFn]    注入用（测试里换成假 spawn）
 * @returns {object} 执行器
 */
export function makeCliExecutor({ command, args = [], cwdOf = null, timeoutMs = 30 * 60 * 1000, spawnFn = null } = {}) {
  if (!command) throw new TypeError('makeCliExecutor: 缺少 command。');

  const runs = new Map();     // childId -> { child, timer }
  const endHandlers = new Set();

  async function resolveSpawn() {
    if (typeof spawnFn === 'function') return spawnFn;
    const { spawn } = await import('node:child_process');
    return spawn;
  }

  function emit(end) {
    for (const handler of [...endHandlers]) {
      try { handler(end); } catch { /* 同上 */ }
    }
  }

  return {
    kind: 'cli',
    async list() {
      return [...runs.keys()].map((id) => ({ id }));
    },
    isLive(childId) {
      return runs.has(String(childId ?? ''));
    },
    async start({ childId, label, prompt, cwd, signal } = {}) {
      const id = String(childId ?? `cli-${Date.now().toString(36)}`);
      const spawn = await resolveSpawn();
      const argv = typeof args === 'function' ? (args({ childId: id, label, prompt, cwd }) ?? []) : args;
      const child = spawn(command, argv, {
        cwd: (typeof cwdOf === 'function' ? cwdOf({ childId: id, cwd }) : cwd) || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let err = '';
      child.stdout?.on('data', (chunk) => { out += String(chunk); });
      child.stderr?.on('data', (chunk) => { err += String(chunk); });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, timeoutMs);
      timer.unref?.();
      const finish = (stopReason) => {
        clearTimeout(timer);
        runs.delete(id);
        emit({
          childId: id,
          stopReason,
          lastAssistantMessage: [{ type: 'text', text: (out || err).trim() }],
        });
      };
      child.on('error', () => finish('error'));
      child.on('close', (code) => finish(code === 0 ? 'completed' : 'error'));
      if (signal?.aborted) { try { child.kill(); } catch { /* 忽略 */ } }
      runs.set(id, { child, timer });
      // 任务正文走 stdin：不经过命令行，免掉引号与长度上限两个坑。
      try { child.stdin?.end(String(prompt ?? '')); } catch { /* 子进程可能已退出 */ }
      return { childId: id };
    },
    async send({ childId, text } = {}) {
      const run = runs.get(String(childId ?? ''));
      if (!run) {
        const err = new Error(`CLI 执行器里没有在跑的子会话 ${childId}。`);
        err.code = 'NO_SEND_MESSAGE';
        throw err;
      }
      try { run.child.stdin?.write(`${String(text ?? '')}\n`); } catch { /* 已关闭 */ }
    },
    onEnd(handler) {
      if (typeof handler !== 'function') return () => {};
      endHandlers.add(handler);
      return () => endHandlers.delete(handler);
    },
    stop(childId) {
      const run = runs.get(String(childId ?? ''));
      if (!run) return false;
      try { run.child.kill(); } catch { /* 忽略 */ }
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// 自检：一个假执行器跑通 dispatchIssue，一个真 CLI 执行器跑通 start → 结束事件
// ---------------------------------------------------------------------------

async function demo() {
  const assert = (cond, msg) => { if (!cond) throw new Error(`FAIL: ${msg}`); };
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { dispatchIssue, settleIssue } = await import('./studio-dispatch.js');

  // ① 接口校验
  assert(executorProblem(null) !== null, 'null 不是执行器');
  assert(executorProblem({ start() {}, send() {}, list() {}, isLive() {} }) === null, '四方法齐就够');
  assert(executorProblem({ start() {} }, { needEnd: true }) !== null, '缺 onEnd 要报');

  // ② 假执行器：dispatchIssue 全程不碰 DSH（目录须是真 git 仓库 → worktree 副本）
  const dir = await mkdtemp(join(tmpdir(), 'cs-exec-'));
  try {
    await writeFile(join(dir, 'a.txt'), 'A\n');
    const gitRun = async (cmd, opts = {}) => {
      const { exec } = await import('node:child_process');
      return await new Promise((resolve) => {
        exec(cmd, { cwd: opts.cwd ?? dir }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr }));
      });
    };
    await gitRun('git init -q', { timeoutMs: 30000 });
    await gitRun('git -c user.name=t -c user.email=t@t commit --allow-empty -q -m init', { timeoutMs: 30000 });
    const calls = { start: [], send: [] };
    const fake = {
      kind: 'fake',
      async list() { return []; },
      isLive() { return false; },
      async start({ childId, prompt, cwd }) { calls.start.push({ childId, prompt, cwd }); return { childId }; },
      async send({ childId, text }) { calls.send.push({ childId, text }); },
      onEnd() { return () => {}; },
    };
    const runCommand = async (cmd, opts = {}) => {
      const { exec } = await import('node:child_process');
      return await new Promise((resolve) => {
        exec(cmd, { cwd: opts.cwd ?? dir }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, stdout, stderr }));
      });
    };
    const first = await dispatchIssue({
      dir, issue: { id: '1', folders: ['src'] }, role: 'implementer', prompt: '干活',
      parent: { id: 'p1' }, executor: fake, runCommand,
    });
    assert(first.ok && first.mode === 'create', 'create via fake executor: ' + JSON.stringify(first));
    assert(calls.start.length === 1, 'fake executor got exactly one start');
    assert(calls.start[0].prompt.includes('干活'), 'prompt reached the executor');

    const settled = await settleIssue(dir, '1', { ok: true, report: '写完了' });
    assert(settled.status === 'REVIEW', 'settle goes to REVIEW');

    // ③ 真 CLI 执行器：node 读 stdin 回一行，走完 start → onEnd
    const cli = makeCliExecutor({ command: process.execPath, args: ['-e', 'process.stdin.on("data", d => process.stdout.write("got:" + String(d).trim()))'] });
    const ended = new Promise((resolve) => { cli.onEnd(resolve); });
    const started = await cli.start({ childId: 'cli-1', prompt: 'hello', cwd: dir });
    assert(started.childId === 'cli-1', 'cli keeps given childId');
    assert(cli.isLive('cli-1') === true, 'cli run is live while running');
    const end = await ended;
    assert(end.childId === 'cli-1', 'cli end carries childId: ' + JSON.stringify(end));
    assert(end.stopReason === 'completed', 'cli exit 0 → completed');
    assert(String(end.lastAssistantMessage?.[0]?.text ?? '').includes('got:hello'), 'cli stdout became the report');
    assert(cli.isLive('cli-1') === false, 'cli run gone after exit');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  console.log('executor: demo OK');
}

if (process.argv[1]?.endsWith('executor.js')) demo().catch((error) => { console.error(error); process.exitCode = 1; });
