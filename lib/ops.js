/**
 * code-studio 操作契约（规格化接口）
 *
 * 问题：派单/合并/中止/台账这批操作原本散在三处各写一遍 ——
 *   DSH 工具（code_studio / code_merge 各自的 parameters）、
 *   网页右栏的 HTTP op 分支、以及 tools 数组里的独立工具。
 * 三处参数名与返回形状不一致，外部 Agent 没法按同一契约调用。
 *
 * 这里把它们收成**一张表**：op → { summary, params, required }。
 *   - 工具层：code_op 直接用 genericSchema() 生成参数；code_studio / code_merge 用 opSchema() 取同一份字段。
 *   - HTTP 层：右栏 `op: 'run'` 传 { name, args } 走同一个 runOp()。
 *   - 外部 Agent（CLI / 别的 harness）：同样按 genericSchema() 组装参数，走 HTTP。
 *
 * 本模块**不 import 任何实现**：只放契约 + 注册表。实现由 lib/index.js 在 apply() 里 register()。
 * 这样它保持纯函数、可单测、不碰宿主（与 studio-dispatch.js 同一条纪律）。
 *
 * 硬约束：不要加 `export default`（cordis 的 unwrapExports 取 exports.default，会让插件静默失效）。
 */

/** 共用字段（多处复用的参数只定义一次，避免三处写法漂移）。 */
const P = {
  work: { type: 'string', description: '仓库名或目录；省略时用会话工作区' },
  id: { type: 'string', description: 'issue 编号，如 "12" 或 "#12"' },
  title: { type: 'string', description: 'issue 标题' },
  body: { type: 'string', description: 'issue 原文' },
  repo: { type: 'string', description: '来源仓库，如 o/n' },
  folders: { type: 'array', items: { type: 'string' }, description: 'issue 触碰的文件夹（可从 body 里的路径自动抽）' },
  role: { type: 'string', description: '子会话用途标签（规则过滤/记忆分层用），默认 worker' },
  prompt: { type: 'string', description: '投给子会话的任务正文（省略则按 issue 自动组）' },
  status: { type: 'string', description: 'issue 状态，如 DONE/RUNNING/READY/FAILED/REVIEW' },
  report: { type: 'string', description: '处理结果报告' },
  childId: { type: 'string', description: '持久子会话 id（已知时传入）' },
  allowDrift: { type: 'boolean', description: '主工作树有手改也覆盖（会先备份）' },
  rebased: { type: 'boolean', description: '合并 Agent 解完冲突后重试时置 true：声明冲突已在副本里解掉' },
  queue: { type: 'boolean', description: '仓库级串行开关（set 不带 id 时生效）：true = 有在飞单不接新单。默认关 = 并行分叉' },
  // 注意：rule 的子操作叫 ruleOp，不叫 op —— op 已经是「操作名」字段，同名字段会被覆盖。
  ruleOp: { type: 'string', enum: ['add', 'list', 'remove'], description: 'rule：add 加规则 / list 列出 / remove 删除' },
  text: { type: 'string', description: 'rule：规则正文（≤200 字）；remove 时可指定要删的规则文本' },
  scope: { type: 'string', description: 'rule：适用对象 all（全 Agent，默认）/ 逗号分隔的角色名' },
  tags: { type: 'array', items: { type: 'string' }, description: 'rule：标签' },
  enabled: { type: 'boolean', description: 'watch：开/关本地收件监听' },
  intervalMs: { type: 'number', description: 'watch：本地轮询间隔（毫秒）' },
  scan: { type: 'boolean', description: 'watch：立即扫一遍（本地收件 + GitHub）' },
  github: { type: 'string', description: 'watch：绑 GitHub 源（owner/repo 或 URL；传 "off" 关闭）' },
  token: { type: 'string', description: 'watch：GitHub PAT（传 "off" 清除）。存 .codewrite/github-token，不进版本库' },
  base: { type: 'string', description: 'pr：目标分支，默认 main' },
  prRepo: { type: 'string', description: 'pr：PR 目标仓库（owner/repo；fork 场景填上游）' },
  prHeadOwner: { type: 'string', description: 'pr：从谁的 fork 提' },
};

/**
 * 操作表 —— 唯一真相源。
 * 每个 op：summary（一句话，给人和 Agent 看）、params（JSON Schema properties）、required。
 * `run` 不在这里：实现由 index.js register()，本模块只管契约。
 */
export const OPS = [
  {
    name: 'submit',
    summary: '备单：git 闸 → worktree 副本 → READY 台账，不开会话；主 Agent 自己起子会话后用 set 登记 childId。',
    params: ['work', 'id', 'title', 'body', 'repo', 'folders', 'status'],
    required: [],
  },
  {
    name: 'dispatch',
    summary: '派单（watch 预授权路径）：建副本并直接起子会话。手动流程请用 submit + set childId。',
    params: ['work', 'id', 'title', 'body', 'repo', 'folders', 'role', 'prompt', 'status'],
    required: [],
  },
  {
    name: 'pending',
    summary: '待合并区：列出已写完（REVIEW）但还没合回主干的 issue。',
    params: ['work'],
    required: [],
  },
  {
    name: 'merge',
    summary: '合并：把某条 issue 的副本合回主干。冲突不落地、副本留作现场，解完 rebased=true 重试。',
    params: ['work', 'id', 'allowDrift', 'rebased'],
    required: ['id'],
  },
  {
    name: 'mergeStatus',
    summary: '合并前检查（只读）：主目录有没有漂移。',
    params: ['work', 'id'],
    required: ['id'],
  },
  {
    name: 'cancel',
    summary: '中止：打断该 issue 的子会话，账本落 FAILED（人工中止）。',
    params: ['work', 'id'],
    required: ['id'],
  },
  {
    name: 'issues',
    summary: '列 issue 台账（status / tags / 标题）。',
    params: ['work'],
    required: [],
  },
  {
    name: 'set',
    summary: '直接写一条 issue 的字段（status / report / childId / tags / title…）；不带 id 传 queue=true|false 切仓库级串行。',
    params: ['work', 'id', 'title', 'repo', 'body', 'status', 'report', 'childId', 'folders', 'tags', 'queue'],
    required: [],
  },
  {
    name: 'repos',
    summary: '发现工作区里的 git 仓库（有 .git 的子目录才算）。',
    params: ['work'],
    required: [],
  },
  {
    name: 'pr',
    summary: '用本机 gh CLI 把这条 issue 的改动提成 PR（插件不存凭据）。',
    params: ['work', 'id', 'base', 'prRepo', 'prHeadOwner'],
    required: ['id'],
  },
  {
    name: 'rule',
    summary: '工作区规则层：add / list / remove。',
    params: ['work', 'ruleOp', 'text', 'scope', 'tags', 'role'],
    required: [],
  },
  {
    name: 'watch',
    summary: '本地收件监听 + GitHub 轮询：开关、改间隔、立即扫、绑仓库、存 PAT。',
    params: ['work', 'enabled', 'intervalMs', 'scan', 'github', 'token'],
    required: [],
  },
];

/** 别名：status 是 mergeStatus 的短名。 */
export const OP_ALIASES = { status: 'mergeStatus' };

const BY_NAME = new Map(OPS.map((op) => [op.name, op]));
for (const alias of Object.keys(OP_ALIASES)) {
  const target = BY_NAME.get(OP_ALIASES[alias]);
  if (target) BY_NAME.set(alias, { ...target, name: alias });
}

/** 解析别名，返回规范 op 名；未知返回 null。 */
export function canonicalOp(name) {
  const key = String(name ?? '').trim();
  if (!key) return null;
  if (OP_ALIASES[key]) return OP_ALIASES[key];
  return BY_NAME.has(key) ? key : null;
}

/** 单个 op 的元数据（含别名）；未知返回 null。 */
export function getOp(name) {
  return BY_NAME.get(String(name ?? '').trim()) ?? null;
}

/** 单个 op 的参数 JSON Schema（直接给工具层当 parameters 用）。 */
export function opSchema(name) {
  const op = getOp(name);
  if (!op) return { type: 'object', additionalProperties: false, properties: {}, required: [] };
  const properties = {};
  for (const key of op.params) if (P[key]) properties[key] = P[key];
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: (op.required ?? []).filter((key) => properties[key]),
  };
}

/**
 * 通用 schema：`code_op` 工具与 HTTP 外部调用共用。
 * op 是枚举 + 所有 op 的字段并集（同名参数含义一致，合并无冲突）。
 */
export function genericSchema() {
  const properties = { op: { type: 'string', enum: OPS.map((op) => op.name), description: '要执行的操作' } };
  for (const def of Object.values(P)) {
    const key = Object.keys(P).find((k) => P[k] === def);
    if (key && key !== 'op') properties[key] = def;
  }
  // 不设 required：不同 op 的必填项不同，由 run() 逐条校验并给出人话提示。
  return { type: 'object', additionalProperties: false, properties, required: ['op'] };
}

/**
 * 组合 schema：给「一个工具承载多个 op」用（code_studio 承载 11 个、code_merge 承载 4 个）。
 * 参数表与 opSchema 同源，工具描述里的 action 枚举也由 OPS 生成，不会三处漂移。
 * @param {string[]} names 该工具承载的 op 名（可含别名）
 * @param {{actionField?:string, required?:boolean}} [opts] 枚举字段名（默认 'action'）、该字段是否必填（默认 true）
 */
export function unionSchema(names, opts = {}) {
  const field = opts.actionField ?? 'action';
  // 枚举保留调用方给的名字（别名如 status 原样留下），只按 getOp 校验存在，避免工具里的分支判据失效。
  const list = [];
  for (const name of names) {
    const op = getOp(name);
    if (op && !list.includes(op.name)) list.push(op.name);
  }
  const properties = { [field]: { type: 'string', enum: list, description: '要执行的操作' } };
  for (const name of list) {
    for (const key of getOp(name)?.params ?? []) {
      if (key !== field && P[key] && !properties[key]) properties[key] = P[key];
    }
  }
  return { type: 'object', additionalProperties: false, properties, required: opts.required === false ? [] : [field] };
}

/** 给人看的操作清单（Markdown）。 */
export function describeOps() {
  const lines = ['## code-studio 操作表', '', '按同一份契约调用：工具 code_op，或 HTTP POST 到动作路由（{ "op": "run", "name": "...", "args": {...} }）。', ''];
  for (const op of OPS) {
    const req = (op.required ?? []).length ? `｜必填：${op.required.join('、')}` : '';
    lines.push(`- **${op.name}** — ${op.summary}${req}`);
  }
  const aliases = Object.keys(OP_ALIASES);
  if (aliases.length) lines.push('', `别名：${aliases.map((a) => `${a} → ${OP_ALIASES[a]}`).join('、')}`);
  return lines.join('\n');
}

/**
 * 注册表：契约在本模块，实现在调用方。
 * run 签名统一为 `async (args, ctx) => ({ ok, text, data? })`，
 * ctx 由调用方决定（工具层给 {dir, exec}，HTTP 层给 {dir, agent, sid}）。
 */
export function createOpRegistry() {
  const impls = new Map();
  return {
    /** 注册一个 op 的实现；未知 op 名直接拒绝（防止拼错静默失效）。 */
    register(name, run) {
      const canonical = canonicalOp(name);
      if (!canonical) throw new Error(`未知操作：${name}`);
      if (typeof run !== 'function') throw new Error(`操作 ${canonical} 的实现必须是函数`);
      impls.set(canonical, run);
      // 别名一并指向同一实现：注册 dispatch 时 submit 也要能用（只按注册名登记会漏）。
      for (const [alias, target] of Object.entries(OP_ALIASES)) {
        if (target === canonical) impls.set(alias, run);
      }
      return this;
    },
    has(name) {
      return impls.has(String(name ?? '').trim());
    },
    /** 缺哪些实现（apply 末尾自检用）。 */
    missing() {
      const need = OPS.map((op) => op.name).filter((name) => !impls.has(name));
      return need;
    },
    async run(name, args, ctx = {}) {
      const key = String(name ?? '').trim();
      const runFn = impls.get(key);
      if (!runFn) return { ok: false, text: `未知操作：${key || '（空）'}。可用：${OPS.map((op) => op.name).join('、')}` };
      const meta = getOp(key);
      for (const need of meta?.required ?? []) {
        const value = args?.[need];
        if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) {
          return { ok: false, text: `${key} 缺少必填参数：${need}。` };
        }
      }
      try {
        const out = await runFn(args ?? {}, ctx);
        if (typeof out === 'string') return { ok: true, text: out };
        return { ok: out?.ok !== false, text: String(out?.text ?? ''), data: out?.data };
      } catch (error) {
        return { ok: false, text: `${key} 失败：${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

export async function demo() {
  // 契约完整性：每个 op 的 params 都必须在共用字段表里有定义，否则 schema 会静默少字段。
  for (const op of OPS) {
    for (const key of op.params) assert(P[key], `op ${op.name} 引用了未定义的参数 ${key}`);
  }
  for (const op of OPS) {
    for (const key of op.required ?? []) assert(op.params.includes(key), `op ${op.name} 的必填项 ${key} 不在 params 里`);
  }

  // 别名解析
  assert(canonicalOp('status') === 'mergeStatus', 'status 应归一到 mergeStatus');
  assert(canonicalOp('merge') === 'merge', 'merge 应解析为自身');
  assert(canonicalOp('nope') === null, '未知 op 应返回 null');

  // opSchema 只含本 op 的字段
  const mergeSchema = opSchema('merge');
  assert(mergeSchema.properties.id && mergeSchema.properties.allowDrift, 'merge schema 应有 id/allowDrift');
  assert(!mergeSchema.properties.title, 'merge schema 不该有 title');
  assert(mergeSchema.required.includes('id'), 'merge 的 id 必填');

  // 通用 schema 含全部 op 与并集字段
  const generic = genericSchema();
  assert(generic.properties.op.enum.length === OPS.length, '通用 schema 的 op 枚举应覆盖全部操作');
  assert(generic.properties.op.enum.length === new Set(generic.properties.op.enum).size, 'op 枚举不应重复');
  for (const op of OPS) assert(generic.properties.op.enum.includes(op.name), `通用 schema 缺 ${op.name}`);

  // 注册表：注册 / 别名 / 必填校验 / 未知 op / 抛错兜底
  const reg = createOpRegistry();
  const calls = [];
  for (const op of OPS) reg.register(op.name, async (args) => { calls.push([op.name, args]); return { ok: true, text: `did ${op.name}` }; });
  assert(reg.missing().length === 0, `不应有未注册的操作，缺：${reg.missing().join(',')}`);

  const ok = await reg.run('merge', { id: '12' });
  assert(ok.ok && ok.text === 'did merge', 'merge 应跑通');
  assert(calls.at(-1)[1].id === '12', 'merge 应收到 id');

  const direct = await reg.run('submit', { id: '13' });
  assert(direct.ok && direct.text === 'did submit', 'submit 应作为独立 op 跑通');

  const missingArg = await reg.run('merge', {});
  assert(!missingArg.ok && /缺少必填参数：id/.test(missingArg.text), `缺 id 应被拒，得到：${missingArg.text}`);

  const unknown = await reg.run('nope', {});
  assert(!unknown.ok && /未知操作/.test(unknown.text), '未知 op 应被拒');

  reg.register('cancel', async () => { throw new Error('boom'); });
  const thrown = await reg.run('cancel', { id: '1' });
  assert(!thrown.ok && /cancel 失败：boom/.test(thrown.text), `抛错应被兜成 ok:false，得到：${thrown.text}`);

  // 描述清单
  const text = describeOps();
  for (const op of OPS) assert(text.includes(op.name), `清单应含 ${op.name}`);

  console.log('ops: demo OK');
}

if (process.argv[1]?.endsWith('ops.js')) await demo();
