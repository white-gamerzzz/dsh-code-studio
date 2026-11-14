// 语义初判：当一条 issue 的 folders 抽不出来（口语化描述，正则里没有路径），
// 先请一次模型，从仓库顶层目录清单里挑出这条 issue 最可能落在哪几个文件夹。
// 只做「归类」不做「准入」，判错也不阻塞——挑不出来就返回 []，交给 unrouted 兜底。
//
// 懒点：只用一次 ctx.llm.stream 纯函数调用（不是 Agent、不是会话），
// 提示词里塞目录清单，要求只回 JSON 数组；拿不到合规 JSON 就当没判断出来。
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_CANDIDATE_DIRS = 200;
export const MAX_PICK = 3;

/** 扫仓库里的候选目录（深度 2，跳过噪音目录），给模型当选项。 */
export async function listCandidateDirs(repoRoot, { maxDepth = 2, limit = MAX_CANDIDATE_DIRS } = {}) {
  const SKIP = new Set(['node_modules', '.git', '.codewrite', 'dist', 'build', 'out', '.next', 'coverage', '.cache', 'vendor', '__pycache__']);
  const out = [];
  async function walk(abs, rel, depth) {
    if (out.length >= limit || depth > maxDepth) return;
    let entries;
    try { entries = await readdir(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      out.push(childRel);
      await walk(join(abs, e.name), childRel, depth + 1);
    }
  }
  try { await walk(repoRoot, '', 1); } catch { /* 目录不可读就当没有候选 */ }
  return out;
}

/** 从模型输出里抠出第一个 JSON 数组，做基本清洗（必须是候选里的、≤MAX_PICK）。 */
export function parsePickedFolders(text, candidates) {
  const allowed = new Set(candidates);
  const s = String(text ?? '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let arr;
  try { arr = JSON.parse(s.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const picked = arr.map((x) => String(x ?? '').trim()).filter((x) => allowed.has(x));
  return [...new Set(picked)].slice(0, MAX_PICK);
}

/**
 * 用一次 llm.stream 调用把 issue 归类到候选目录。
 * @param {object} o
 * @param {{provider:string,model:string,reasoningEffort?:string}} o.route 必填（provider+model）
 * @param {object} o.llm ctx.get('llm')，需有 stream
 * @param {string[]} o.candidates 候选目录
 * @param {{id?:string,title?:string,body?:string}} o.issue
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<string[]>} 挑中的目录（可能为空）
 */
export async function classifyFolders({ route, llm, candidates, issue, signal }) {
  if (!route?.provider || !route?.model || typeof llm?.stream !== 'function') return [];
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const system = [
    '你在给一条代码 issue 做「归属初判」：从给定目录清单里挑出这条 issue 最可能要改的 1~3 个目录。',
    '只输出一个 JSON 字符串数组，元素必须严格来自清单，例如 ["src/auth"]。判断不了就输出 []。',
    '不要解释、不要代码块、不要多余文字。',
  ].join('\n');
  const user = [
    `目录清单：\n${candidates.join('\n')}`,
    '',
    `issue #${issue?.id ?? ''}${issue?.title ? `：${issue.title}` : ''}`,
    issue?.body ? `原文：\n${String(issue.body).slice(0, 2000)}` : '',
  ].join('\n');
  let text = '';
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens: 200,
      temperature: 0,
      ...(signal ? { signal } : {}),
    });
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') text += chunk.text ?? '';
      else if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) break;
    }
  } catch {
    return [];
  }
  return parsePickedFolders(text, candidates);
}

// ---- 自检 ----
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('studio-route.js')) {
  const assert = (cond, msg) => { if (!cond) throw new Error(`studio-route demo FAIL: ${msg}`); };
  const cands = ['src', 'src/auth', 'src/api', 'docs'];

  // parsePickedFolders：正常 / 带赘述 / 非法项剔除 / 超量截断
  assert(JSON.stringify(parsePickedFolders('["src/auth"]', cands)) === '["src/auth"]', 'plain array');
  assert(JSON.stringify(parsePickedFolders('好的： ["src/api","src/auth"]', cands)) === '["src/api","src/auth"]', 'chatter around');
  assert(JSON.stringify(parsePickedFolders('["src/auth","bogus"]', cands)) === '["src/auth"]', 'drop unknown');
  assert(JSON.stringify(parsePickedFolders('[]', cands)) === '[]', 'empty');
  assert(JSON.stringify(parsePickedFolders('no json here', cands)) === '[]', 'no json');
  assert(parsePickedFolders('["src","src/auth","src/api","docs"]', cands).length === MAX_PICK, 'cap at MAX_PICK');

  // classifyFolders：假 llm 流式返回文本
  const fakeLlm = (reply) => ({
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: reply.slice(0, 8) };
        yield { type: 'text-delta', text: reply.slice(8) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  });
  (async () => {
    const route = { provider: 'p', model: 'm' };
    const picked = await classifyFolders({ route, llm: fakeLlm('["src/auth"]'), candidates: cands, issue: { id: '1', body: '登录刷新' } });
    assert(JSON.stringify(picked) === '["src/auth"]', 'classify picked');
    // 缺 route / 缺 llm / 空候选 → 一律 []
    assert((await classifyFolders({ route: null, llm: fakeLlm('["src/auth"]'), candidates: cands, issue: {} })).length === 0, 'no route → []');
    assert((await classifyFolders({ route, llm: null, candidates: cands, issue: {} })).length === 0, 'no llm → []');
    assert((await classifyFolders({ route, llm: fakeLlm('["x"]'), candidates: [], issue: {} })).length === 0, 'no candidates → []');
    // llm 抛错 → []
    const boom = { stream() { throw new Error('boom'); } };
    assert((await classifyFolders({ route, llm: boom, candidates: cands, issue: {} })).length === 0, 'llm throw → []');
    console.log('studio-route: demo OK');
  })().catch((e) => { console.error(e); process.exitCode = 1; });
}
