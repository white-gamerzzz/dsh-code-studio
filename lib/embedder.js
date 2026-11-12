/**
 * embedder — bge-m3 文本向量（走本机 ollama，Node 原生 fetch，零依赖）
 *
 * 从 dsh-plugin-novel 逐字复用：代码范例库需要同一套语义检索能力，
 * 与其另引 transformers/onnx，不如复用这台机器上已经跑着的 ollama + bge-m3。
 *
 * 为什么是 ollama + bge-m3：
 *   知识库要按语义（而非字面）检索范例，得把句子向量化。本机已装 ollama 并拉了
 *   bge-m3（1024 维，中文区分度实测 OK：骂街vs骂街=0.525，骂街vs官腔=0.445）。
 *   接口极简：POST /api/embeddings {model,prompt} → {embedding:[1024]}。
 *
 * 容错纪律：embed 单条失败会重试一次；批量里某条最终仍失败就返回 null 占位，
 *   不抛——向量化是增强项，一条挂了不能让整批入库跟着崩。
 *
 * 纯 ESM、Node 原生 fetch，无第三方依赖。
 */

const DEFAULT_MODEL = 'bge-m3';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434/api/embeddings';
const DEFAULT_TIMEOUT = 15000;

/**
 * 单条文本 → 向量（1024 维）。
 * @param {string} text
 * @param {{model?:string, endpoint?:string, timeoutMs?:number}} [opts]
 * @returns {Promise<number[]>} 失败会抛（由 embedBatch 捕获重试）
 */
export async function embed(text, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: String(text ?? '') }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('embed HTTP ' + res.status);
    const data = await res.json();
    const vec = data && data.embedding;
    if (!Array.isArray(vec) || !vec.length) throw new Error('embed 返回无 embedding');
    return vec;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 余弦相似度。非等长/含 null/全零向量 → 0（安全退避，不抛）。
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 批量向量化（串行，够用且不打爆本机模型）。每条失败重试一次；最终仍失败 → null 占位。
 * @param {string[]} texts
 * @param {object} [opts]
 * @returns {Promise<Array<number[]|null>>}
 */
export async function embedBatch(texts, opts = {}) {
  const list = Array.isArray(texts) ? texts : [];
  const out = [];
  for (const t of list) {
    let vec = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        vec = await embed(t, opts);
        break;
      } catch {
        if (attempt === 1) vec = null; // 重试后仍失败 → null
      }
    }
    out.push(vec);
  }
  return out;
}
