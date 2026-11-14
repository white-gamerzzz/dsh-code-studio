/**
 * dsh-plugin-code-studio / studio-memory —— 工作区记忆的读回。
 *
 * 记忆分两层，落在 <repo>/.codewrite/editor/ 下：
 *   MEMORY.md            工作区级（构建/测试命令、仓库约定）
 *   regions/<name>.md    region 级（一片文件夹的历次改动结论）
 *
 * 本模块只做「把记忆读成一段可注入系统提示词的文本」。写入由总监/子 Agent 直接写
 * `.codewrite/editor/` 下的 .md（code-guard 已对总监放行该目录），不需要这里另开写口。
 *
 * 为什么要读回：旧版插件只把 editor/*.md 当「可写目录」白名单，写进去的结论从不加载，
 * 等于没记忆。这里用 systemPrompt.section 把它的尾部注入上下文，补上这条缺口。
 *
 * 硬约束：本文件不要加 `export default`（cordis 的 unwrapExports 会取 exports.default）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODE_STUDIO_DIR, SESSIONS_DIR, MEMORY_DIR, WORKSPACE_MEMORY_FILE, sessionDir } from './studio-workspace.js';

export const STUDIO_DIR = '.codewrite';
export const EDITOR_DIR = 'editor';
export const MEMORY_FILE = 'MEMORY.md';
export const REGIONS_DIR = 'regions';

/** 注入行数上限：只喂最近 ~40 行，历史靠文件里的 issue id 去 grep。 */
export const MAX_LINES = 40;

/** 记忆文件超过这么多行就把老内容轮转进 .1，只留最近 KEEP_AFTER 行。 */
export const ARCHIVE_AFTER = 200;
export const KEEP_AFTER = 120;

export function editorDir(repoRoot) { return join(repoRoot, STUDIO_DIR, EDITOR_DIR); }
export function memoryPath(repoRoot) { return join(editorDir(repoRoot), MEMORY_FILE); }
export function regionsDir(repoRoot) { return join(editorDir(repoRoot), REGIONS_DIR); }

/** region 记忆文件路径：regions/<slug>.md（slug 归一化，防目录穿越）。 */
export function regionMemoryPath(repoRoot, region) {
  const slug = String(region ?? 'region').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'region';
  return join(regionsDir(repoRoot), `${slug}.md`);
}

/**
 * 往一个记忆文件追加一段结论（≤5 行，首行带 issue id 便于 grep）。
 * 文件超过 ARCHIVE_AFTER 行时把老内容轮转进 <file>.1，只保留最近 KEEP_AFTER 行，
 * 与「注入只喂末 40 行」的读侧对齐。
 *
 * @param {string} file 目标 .md
 * @param {string} block 要追加的文本（多行）
 */
export function appendMemory(file, block) {
  const text = String(block ?? '').trim();
  if (!text) return false;
  mkdirSync(join(file, '..'), { recursive: true });
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : '';
  let all = prev.trim() ? `${prev.replace(/\s+$/, '')}\n${text}\n` : `${text}\n`;
  const lines = all.split(/\r?\n/).filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
  if (lines.length > ARCHIVE_AFTER) {
    try { writeFileSync(`${file}.1`, lines.slice(0, lines.length - KEEP_AFTER).join('\n') + '\n', 'utf8'); } catch { /* 归档失败不挡写入 */ }
    all = lines.slice(-KEEP_AFTER).join('\n') + '\n';
  }
  writeFileSync(file, all, 'utf8');
  return true;
}

/** 追加到工作区级 MEMORY.md。 */
export function appendWorkspaceMemory(repoRoot, block) {
  return appendMemory(memoryPath(repoRoot), block);
}

/** 追加到 region 级记忆。 */
export function appendRegionMemory(repoRoot, region, block) {
  return appendMemory(regionMemoryPath(repoRoot, region), block);
}

// ---------------------------------------------------------------------------
// 会话隔离记忆（新架构 .code-studio/sessions/<sid>/）
// 旧 .codewrite/editor/ 保留只读兼容，但写入侧今后走这里，避免同工作区不同会话串记忆。
// 布局：
//   <工作区>/.code-studio/memory/workspace.md          工作区级（唯一跨会话共享）
//   <工作区>/.code-studio/sessions/<sid>/memory.md     本会话
//   <工作区>/.code-studio/sessions/<sid>/agents/<childId>.md   子 Agent
//   <工作区>/.code-studio/sessions/<sid>/regions/<region>.md   region 再派单
// ---------------------------------------------------------------------------

export function sessionMemoryPath(workspaceRoot, sessionId) {
  return join(sessionDir(workspaceRoot, sessionId), 'memory.md');
}
export function sessionAgentsDir(workspaceRoot, sessionId) {
  return join(sessionDir(workspaceRoot, sessionId), 'agents');
}
export function sessionRegionsDir(workspaceRoot, sessionId) {
  return join(sessionDir(workspaceRoot, sessionId), 'regions');
}
export function agentMemoryPath(workspaceRoot, sessionId, childId) {
  return join(sessionAgentsDir(workspaceRoot, sessionId), `${slugify(childId)}.md`);
}
export function sessionRegionMemoryPath(workspaceRoot, sessionId, region) {
  return join(sessionRegionsDir(workspaceRoot, sessionId), `${slugify(region)}.md`);
}
export function workspaceMemoryFilePath(workspaceRoot) {
  return join(workspaceRoot, CODE_STUDIO_DIR, MEMORY_DIR, WORKSPACE_MEMORY_FILE);
}

function slugify(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/** 追加到工作区级记忆（.code-studio/memory/workspace.md，所有会话共享）。 */
export function appendWorkspaceRuleMemory(workspaceRoot, block) {
  return appendMemory(workspaceMemoryFilePath(workspaceRoot), block);
}
/** 追加到本会话记忆（.code-studio/sessions/<sid>/memory.md）。 */
export function appendSessionMemory(workspaceRoot, sessionId, block) {
  return appendMemory(sessionMemoryPath(workspaceRoot, sessionId), block);
}
/** 追加到某子 Agent 记忆（.code-studio/sessions/<sid>/agents/<childId>.md）。 */
export function appendAgentMemory(workspaceRoot, sessionId, childId, block) {
  return appendMemory(agentMemoryPath(workspaceRoot, sessionId, childId), block);
}
/** 追加到会话内某 region 记忆（.code-studio/sessions/<sid>/regions/<region>.md）。 */
export function appendSessionRegionMemory(workspaceRoot, sessionId, region, block) {
  return appendMemory(sessionRegionMemoryPath(workspaceRoot, sessionId, region), block);
}

/**
 * 组装会话隔离记忆块（纯函数）。按会话取，绝不跨会话。
 * @param {string} workspaceRoot 工作区根
 * @param {string} sessionId
 * @param {{maxLines?:number, includeRegions?:boolean, regionLimit?:number, includeAgents?:boolean}} [opts]
 * @returns {string}
 */
export function sessionMemorySectionText(workspaceRoot, sessionId, opts = {}) {
  if (!workspaceRoot || !sessionId) return '';
  const maxLines = Number(opts.maxLines) > 0 ? Number(opts.maxLines) : MAX_LINES;
  const blocks = [];

  // 1) 工作区级（跨会话共享）
  const ws = readLayer(workspaceMemoryFilePath(workspaceRoot), maxLines);
  if (ws.text) {
    blocks.push(['### 工作区记忆', ws.dropped ? `（更早已归档 ${ws.dropped} 行）` : '', ws.text].filter(Boolean).join('\n'));
  }

  // 2) 本会话
  const ses = readLayer(sessionMemoryPath(workspaceRoot, sessionId), maxLines);
  if (ses.text) {
    blocks.push(['### 本会话记忆', ses.dropped ? `（更早已归档 ${ses.dropped} 行）` : '', ses.text].filter(Boolean).join('\n'));
  }

  // 3) 本会话内若干 region（按 mtime 取最近 N 个）
  if (opts.includeRegions) {
    const dir = sessionRegionsDir(workspaceRoot, sessionId);
    if (existsSync(dir)) {
      let names = [];
      try { names = readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { names = []; }
      const limit = Number(opts.regionLimit) > 0 ? Number(opts.regionLimit) : 3;
      const picked = names.map((n) => {
        let t = 0;
        try { t = statSync(join(dir, n)).mtimeMs; } catch { t = 0; }
        return { n, t };
      }).sort((a, b) => b.t - a.t).slice(0, limit).map((x) => x.n);
      for (const name of picked.sort()) {
        const r = readLayer(join(dir, name), maxLines);
        if (r.text) blocks.push([`### region 记忆（${name.replace(/\.md$/, '')}）`, r.text].join('\n'));
      }
    }
  }

  // 4) 本会话内子 Agent 记忆（仅当被某个子 Agent 读取时——默认不注入，避免主会话被灌）
  if (opts.includeAgents) {
    const dir = sessionAgentsDir(workspaceRoot, sessionId);
    if (existsSync(dir)) {
      let names = [];
      try { names = readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { names = []; }
      for (const name of names.sort()) {
        const r = readLayer(join(dir, name), maxLines);
        if (r.text) blocks.push([`### 子 Agent 记忆（${name.replace(/\.md$/, '')}）`, r.text].join('\n'));
      }
    }
  }

  if (!blocks.length) return '';
  return [
    '## 工作室记忆（.code-studio，按会话隔离）',
    '以下是本会话此前的结论，直接沿用、不要重复踩坑；与当前代码冲突时以代码为准。',
    '',
    ...blocks,
  ].join('\n');
}

/** 读某子 Agent 自己的记忆（给子 Agent 冷恢复时用）。 */
export function readAgentMemory(workspaceRoot, sessionId, childId, maxLines = MAX_LINES) {
  return readLayer(agentMemoryPath(workspaceRoot, sessionId, childId), maxLines).text;
}

/** 读一个文本文件的尾部 N 行；不存在/读不了返回 ''。 */
function tailLines(file, maxLines) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  const lines = text.split(/\r?\n/);
  // 去掉尾部空行再截尾
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (!lines.length) return '';
  return lines.slice(-maxLines).join('\n').trim();
}

/**
 * 把一层记忆文件读成一段（带滚动归档标记：被截掉的部分提示去 grep）。
 * @returns {{text:string, dropped:number}} dropped = 本次没注入的行数
 */
export function readLayer(file, maxLines = MAX_LINES) {
  let all;
  try {
    all = readFileSync(file, 'utf8');
  } catch {
    return { text: '', dropped: 0 };
  }
  const lines = all.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (!lines.length) return { text: '', dropped: 0 };
  const kept = lines.slice(-maxLines);
  const dropped = lines.length - kept.length;
  return { text: kept.join('\n').trim(), dropped };
}

/**
 * 组装要注入系统提示词的工作区记忆块（纯函数，可单测）。
 * 没有记忆文件 → 返回 ''（不污染提示词）。
 *
 * @param {string} repoRoot 仓库根目录
 * @param {{maxLines?:number, includeRegions?:boolean, regionLimit?:number}} [opts]
 *   includeRegions=true 时按 mtime 注入最近 regionLimit（默认 3）个 region 记忆，
 *   不全量注入（region 数量不定，全量会撑爆提示词）。
 *   ponytail: 按 mtime 取最近 N 个，够用；要精确按会话所在 region 定向，需改子会话 cwd 指向
 *   仓库根（现在子会话 cwd=worktree，.codewrite 不在那儿），那是另一笔改动。
 */
export function memorySectionText(repoRoot, opts = {}) {
  const maxLines = Number(opts.maxLines) > 0 ? Number(opts.maxLines) : MAX_LINES;
  if (!repoRoot || !existsSync(editorDir(repoRoot))) return '';

  const blocks = [];
  const ws = readLayer(memoryPath(repoRoot), maxLines);
  if (ws.text) {
    blocks.push(['### 工作区记忆（MEMORY.md）', ws.dropped ? `（更早已归档 ${ws.dropped} 行，需要时 grep 文件）` : '', ws.text].filter(Boolean).join('\n'));
  }

  // region 记忆默认不注入；开启时只注入最近改动的几个，避免撑爆提示词。
  if (opts.includeRegions) {
    const dir = regionsDir(repoRoot);
    if (existsSync(dir)) {
      let names = [];
      try { names = readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { names = []; }
      const limit = Number(opts.regionLimit) > 0 ? Number(opts.regionLimit) : 3;
      const picked = names.map((n) => {
        let t = 0;
        try { t = statSync(join(dir, n)).mtimeMs; } catch { t = 0; }
        return { n, t };
      }).sort((a, b) => b.t - a.t).slice(0, limit).map((x) => x.n);
      for (const name of picked.sort()) {
        const r = readLayer(join(dir, name), maxLines);
        if (r.text) blocks.push([`### region 记忆（${name.replace(/\.md$/, '')}）`, r.text].join('\n'));
      }
    }
  }

  if (!blocks.length) return '';
  return [
    '## 工作区记忆（.codewrite/editor）',
    '以下是本仓库此前的结论，直接沿用、不要重复踩坑；与当前代码冲突时以代码为准。',
    '',
    ...blocks,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 自检：node lib/studio-memory.js
// ---------------------------------------------------------------------------
async function demo() {
  const assert = (c, m) => { if (!c) throw new Error(`demo failed: ${m}`); };
  const { mkdtemp, rm, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'studio-mem-'));
  try {
    // 无记忆目录 → 空串
    assert(memorySectionText(root) === '', 'no editor dir → empty');

    await mkdir(editorDir(root), { recursive: true });
    // 空 MEMORY.md → 空串
    await writeFile(memoryPath(root), '\n\n', 'utf8');
    assert(memorySectionText(root) === '', 'empty memory → empty');

    // 正常 MEMORY.md → 注入
    await writeFile(memoryPath(root), '测试命令 npm test\n构建 pnpm build\n', 'utf8');
    const s = memorySectionText(root);
    assert(s.includes('npm test') && s.includes('MEMORY.md'), 'injects memory');

    // 超长文件只注入尾部 MAX_LINES 行，并标出归档行数
    const many = Array.from({ length: MAX_LINES + 15 }, (_, i) => `line ${i + 1}`).join('\n');
    await writeFile(memoryPath(root), many, 'utf8');
    const s2 = memorySectionText(root, { maxLines: 10 });
    assert(s2.includes('line 55') && !s2.includes('line 1\n') && s2.includes('归档'), 'tail truncation + archive note');

    // includeRegions 打开才注入 region 记忆
    await mkdir(regionsDir(root), { recursive: true });
    await writeFile(join(regionsDir(root), 'auth.md'), '登录改动结论\n', 'utf8');
    assert(!memorySectionText(root).includes('登录改动结论'), 'regions off by default');
    assert(memorySectionText(root, { includeRegions: true }).includes('登录改动结论'), 'regions on when asked');

    // regionLimit：多写几个 region，只注入最近修改的 N 个
    await writeFile(join(regionsDir(root), 'b.md'), 'B区结论\n', 'utf8');
    await writeFile(join(regionsDir(root), 'c.md'), 'C区结论\n', 'utf8');
    await writeFile(join(regionsDir(root), 'd.md'), 'D区结论\n', 'utf8');
    const limited = memorySectionText(root, { includeRegions: true, regionLimit: 1 });
    const hitCount = ['auth', 'B区', 'C区', 'D区'].filter((k) => limited.includes(k === 'auth' ? '登录改动结论' : k + '结论')).length;
    assert(hitCount === 1, `regionLimit=1 injects exactly 1 region, got ${hitCount}`);

    // 写入侧：appendRegionMemory / appendWorkspaceMemory 落地且能被读回
    const { rm: rm2 } = await import('node:fs/promises');
    await rm2(regionsDir(root), { recursive: true, force: true });
    appendRegionMemory(root, 'auth/api', '#12 登录改动：token 校验抽到 middleware\n');
    assert(existsSync(regionMemoryPath(root, 'auth/api')), 'region memory file created');
    assert(memorySectionText(root, { includeRegions: true }).includes('token 校验抽到'), 'region memory readback');
    // slug 归一化：'auth/api' → 'auth-api.md'
    assert(existsSync(join(regionsDir(root), 'auth-api.md')), 'region slug normalized');
    // 多次追加不覆盖
    appendRegionMemory(root, 'auth', '#13 追加一条\n');
    assert(readFileSync(regionMemoryPath(root, 'auth'), 'utf8').includes('#13'), 'append keeps old');
    // 工作区级写入
    appendWorkspaceMemory(root, '构建 pnpm build\n');
    assert(memorySectionText(root).includes('pnpm build'), 'workspace memory write');
    // 超 ARCHIVE_AFTER 轮转，只留最近 KEEP_AFTER 行
    const bulk = Array.from({ length: ARCHIVE_AFTER + 20 }, (_, i) => `L${i + 1}`).join('\n');
    writeFileSync(memoryPath(root), bulk + '\n', 'utf8');
    appendWorkspaceMemory(root, 'tail-marker');
    const after = readFileSync(memoryPath(root), 'utf8').trim().split(/\r?\n/);
    assert(after.length <= KEEP_AFTER, `rotated to ≤${KEEP_AFTER} lines, got ${after.length}`);
    assert(after[after.length - 1] === 'tail-marker', 'append survives rotation');
    assert(existsSync(memoryPath(root) + '.1'), 'archive .1 written');

    // ---- 会话隔离记忆 ----
    const assertIso = (c, m) => { if (!c) throw new Error(`demo failed (session): ${m}`); };
    appendWorkspaceRuleMemory(root, '- [测试] 工作区通用：用 pnpm\n');
    appendSessionMemory(root, 'sessA', '- [约定] 会话A：auth 用 middleware\n');
    appendSessionMemory(root, 'sessB', '- [约定] 会话B：导出用 worker\n');
    appendSessionRegionMemory(root, 'sessA', 'auth/api', '#12 会话A的 auth 结论\n');
    appendAgentMemory(root, 'sessA', 'cs-auth-1', '子Agent结论：改了 login.ts\n');

    const secA = sessionMemorySectionText(root, 'sessA', { includeRegions: true });
    const secB = sessionMemorySectionText(root, 'sessB', { includeRegions: true });
    assertIso(secA.includes('会话A：auth 用 middleware'), 'sessA own memory visible');
    assertIso(!secA.includes('会话B：导出用 worker'), 'sessA must NOT see sessB memory');
    assertIso(secB.includes('会话B：导出用 worker'), 'sessB own memory visible');
    assertIso(!secB.includes('会话A：auth 用 middleware'), 'sessB must NOT see sessA memory');
    assertIso(secA.includes('工作区通用：用 pnpm') && secB.includes('工作区通用：用 pnpm'), 'workspace memory shared across sessions');
    assertIso(secA.includes('会话A的 auth 结论'), 'sessA region memory visible');
    assertIso(!secB.includes('会话A的 auth 结论'), 'sessB must NOT see sessA region');
    assertIso(!secA.includes('子Agent结论'), 'agent memory not injected by default');
    assertIso(sessionMemorySectionText(root, 'sessA', { includeAgents: true }).includes('子Agent结论'), 'agent memory injected when asked');
    assertIso(readAgentMemory(root, 'sessA', 'cs-auth-1').includes('login.ts'), 'readAgentMemory direct');
    assertIso(sessionMemorySectionText(root, 'sessNone') === '' || !sessionMemorySectionText(root, 'sessNone').includes('会话A'), 'unknown session sees no per-session memory');
    // 路径落在 .code-studio 下
    assertIso(sessionMemoryPath(root, 'sessA').includes('.code-studio'), 'session memory under .code-studio');
    assertIso(!sessionMemoryPath(root, 'sessA').includes('.codewrite'), 'session memory not under old dir');

    console.log('studio-memory: demo OK');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith('studio-memory.js')) {
  demo().catch((error) => { console.error(error); process.exitCode = 1; });
}
