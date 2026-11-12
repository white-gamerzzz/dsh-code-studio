/**
 * kb.js — 代码范例库（把「活人怎么写」沉淀成可检索的范例，写代码时按语义注入）
 *
 * 与小说插件的文风知识库同源，但换成代码语境：一条范例 = 一段「写对了的代码」
 * 加它的用途标签。检索优先走向量（ollama + bge-m3，复用 embedder.js），
 * 向量服务不可用时自动退回词法打分（TF 重叠），所以离线也能用。
 *
 * 存储：<repo>/.codewrite/kb/index.json（单文件，原子写）。零第三方依赖。
 * ponytail：先单文件全量读写；范例破千、单文件写放大成瓶颈时再换 sqlite。
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { embed, cosine } from './embedder.js';

export const KB_DIR = '.codewrite/kb';
const INDEX_FILE = 'index.json';

export function kbDir(workDir) {
  return join(workDir, KB_DIR);
}

async function loadIndex(workDir) {
  const file = join(kbDir(workDir), INDEX_FILE);
  if (!existsSync(file)) return { version: 1, entries: [] };
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    return { version: raw.version ?? 1, entries: Array.isArray(raw.entries) ? raw.entries : [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

async function saveIndex(workDir, index) {
  const dir = kbDir(workDir);
  await mkdir(dir, { recursive: true });
  const file = join(dir, INDEX_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(index, null, 2), 'utf8');
  await rename(tmp, file);
}

/** 词法切分：按非字母数字断开，再把 camelCase / snake_case 拆开，统一小写。 */
function tokenize(text) {
  const words = String(text ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9_\u4e00-\u9fff]+/)
    .filter((w) => w && w.length > 1);
  return words;
}

/** 词法重叠加分（Jaccard 变体）：查询词命中范例词的比例。向量不可用时的退路。 */
function lexicalScore(query, entry) {
  const q = new Set(tokenize(query));
  if (!q.size) return 0;
  const hay = new Set(tokenize(`${entry.text ?? ''} ${(entry.tags ?? []).join(' ')}`));
  let hit = 0;
  for (const w of q) if (hay.has(w)) hit += 1;
  return hit / q.size;
}

export async function status(workDir) {
  const { entries } = await loadIndex(workDir);
  return {
    dir: kbDir(workDir),
    total: entries.length,
    withVec: entries.filter((e) => Array.isArray(e.vec) && e.vec.length).length,
    tags: [...new Set(entries.flatMap((e) => e.tags ?? []))],
  };
}

/** 新增一条范例：立刻尝试向量化，失败也不挡入库（vec=null，检索走词法）。 */
export async function add(workDir, { text, tags = [], source = '' }) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('范例正文为空');
  const index = await loadIndex(workDir);
  let vec = null;
  try {
    vec = await embed(body);
  } catch {
    vec = null;
  }
  const entry = {
    id: randomUUID(),
    text: body,
    tags: Array.isArray(tags) ? tags.map(String) : [],
    source: String(source ?? ''),
    vec,
    usedCount: 0,
    addedAt: new Date().toISOString(),
  };
  index.entries.push(entry);
  await saveIndex(workDir, index);
  return entry;
}

/** 补齐缺失向量（ollama 恢复后把之前 vec=null 的条目补上）。返回 {embedded, failed}。 */
export async function fill(workDir) {
  const index = await loadIndex(workDir);
  let embedded = 0;
  let failed = 0;
  for (const entry of index.entries) {
    if (Array.isArray(entry.vec) && entry.vec.length) continue;
    try {
      entry.vec = await embed(entry.text);
      embedded += 1;
    } catch {
      failed += 1;
    }
  }
  await saveIndex(workDir, index);
  return { embedded, failed, total: index.entries.length };
}

/**
 * 检索：优先向量余弦，向量不可用（无 vec 或 embed 挂了）退回词法。
 * @returns {Promise<{mode:'vector'|'lexical', hits:Array}>}
 */
export async function search(workDir, query, { limit = 3 } = {}) {
  const index = await loadIndex(workDir);
  if (!index.entries.length) return { mode: 'lexical', hits: [] };

  let queryVec = null;
  try {
    queryVec = await embed(query);
  } catch {
    queryVec = null;
  }

  let mode = 'lexical';
  const scored = index.entries.map((entry) => {
    let score;
    if (queryVec && Array.isArray(entry.vec) && entry.vec.length) {
      mode = 'vector';
      score = cosine(queryVec, entry.vec) + 0.01 * (entry.usedCount ?? 0);
    } else {
      score = lexicalScore(query, entry) + 0.01 * (entry.usedCount ?? 0);
    }
    return { entry, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, Math.max(1, limit)).filter((s) => s.score > 0);
  return { mode, hits };
}

/** 记一次命中（检索被采纳后调用，用于给高频范例加权）。 */
export async function bumpUsed(workDir, id) {
  const index = await loadIndex(workDir);
  const entry = index.entries.find((e) => e.id === id);
  if (!entry) return false;
  entry.usedCount = (entry.usedCount ?? 0) + 1;
  await saveIndex(workDir, index);
  return true;
}
