// 规范化 issue 入口：本地收件（inbox/*.json）、GitHub issue、前台 Agent 手动提 ——
// 三个来源都先过这里，落成同一种 issue 形状再进台账，避免三处各写一套解析。
//
// 规范形状（就是 issues.json 里那一条）：
//   { id, title, body, repo, folders: string[], status }
//
// 规则（懒，但边界清楚）：
//   - id 必填；缺省用 idFallback（文件名 / gh 编号），去前导 #
//   - folders 统一 normalizeFolder（正斜杠、无 ./、无尾 /），去重，≤12
//   - folders 为空且给了 body → 试着从正文里抽（inferFolders）
//   - status 缺省 'READY'
//   - 返回 { ok, missing[], issue }；missing 非空 = 还不能派单（调用方决定跳过/留原地）
import { normalizeFolder } from './studio-store.js';
import { inferFolders } from './studio-github.js';

export const MAX_FOLDERS = 12;

function asString(value) {
  return value == null ? '' : String(value);
}

/**
 * 把任意来源的一条 issue 原始记录规范成统一形状。
 * @param {object} raw 原始记录（来自收件 json / gh issue / 前台 Agent）
 * @param {{ idFallback?: string, maxFolders?: number }} [opts]
 * @returns {{ ok: boolean, missing: string[], issue: { id:string, title:string, body:string, repo:string, folders:string[], status:string } }}
 */
export function normalizeIssue(raw, opts = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const id = asString(src.id ?? opts.idFallback).trim().replace(/^#/, '');
  const title = asString(src.title).trim();
  const body = asString(src.body);
  const repo = asString(src.repo).trim();
  const status = asString(src.status).trim().toUpperCase() || 'READY';

  // folders：先归一化给定的，空了再从正文抽。
  let folders = (Array.isArray(src.folders) ? src.folders : [])
    .map((f) => normalizeFolder(asString(f)))
    .filter(Boolean);
  if (!folders.length && body) {
    folders = inferFolders(body).map((f) => normalizeFolder(f)).filter(Boolean);
  }
  folders = [...new Set(folders)].slice(0, opts.maxFolders ?? MAX_FOLDERS);

  const missing = [];
  if (!id) missing.push('id');
  if (!folders.length) missing.push('folders');

  return { ok: missing.length === 0, missing, issue: { id, title, body, repo, folders, status } };
}

// ---- 自检 ----
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('studio-intake.js')) {
  const assert = (cond, msg) => { if (!cond) throw new Error(`studio-intake demo FAIL: ${msg}`); };

  // 全字段 + folders 归一化/去重/斜杠
  {
    const r = normalizeIssue({ id: '#12', title: ' 修登录 ', folders: ['./src/auth/', 'src\\auth', 'src/api'] });
    assert(r.ok, 'full record ok');
    assert(r.issue.id === '12', 'strip leading #');
    assert(r.issue.title === '修登录', 'trim title');
    assert(r.issue.status === 'READY', 'default status READY');
    assert(JSON.stringify(r.issue.folders) === JSON.stringify(['src/auth', 'src/api']), `folders normalized+deduped, got ${JSON.stringify(r.issue.folders)}`);
  }
  // id 缺省取 idFallback（文件名）
  {
    const r = normalizeIssue({ title: 't', folders: ['src/x'] }, { idFallback: 'gh-99.json' });
    assert(r.ok && r.issue.id === 'gh-99.json', 'id from fallback');
  }
  // folders 为空 + 正文抽路径
  {
    const r = normalizeIssue({ id: '3', body: '改 src/auth/token.ts 和 src/api/user.ts' });
    assert(r.ok, 'infer folders from body ok');
    assert(r.issue.folders.includes('src/auth') && r.issue.folders.includes('src/api'), `inferred src/auth+src/api, got ${JSON.stringify(r.issue.folders)}`);
  }
  // 缺 id 且无 fallback → missing id
  {
    const r = normalizeIssue({ title: 't', folders: ['src/x'] });
    assert(!r.ok && r.missing.includes('id'), 'missing id flagged');
  }
  // 缺 folders 且正文抽不出 → missing folders
  {
    const r = normalizeIssue({ id: '7', body: '就一句话没有路径' });
    assert(!r.ok && r.missing.includes('folders'), `missing folders flagged, got ${JSON.stringify(r.missing)}`);
  }
  // 非对象输入不抛
  {
    const r = normalizeIssue(null, { idFallback: 'x' });
    assert(!r.ok && r.issue.id === 'x', 'null raw tolerated');
  }
  console.log('studio-intake: demo OK');
}
