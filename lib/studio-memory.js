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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const STUDIO_DIR = '.codewrite';
export const EDITOR_DIR = 'editor';
export const MEMORY_FILE = 'MEMORY.md';
export const REGIONS_DIR = 'regions';

/** 注入行数上限：只喂最近 ~40 行，历史靠文件里的 issue id 去 grep。 */
export const MAX_LINES = 40;

export function editorDir(repoRoot) { return join(repoRoot, STUDIO_DIR, EDITOR_DIR); }
export function memoryPath(repoRoot) { return join(editorDir(repoRoot), MEMORY_FILE); }
export function regionsDir(repoRoot) { return join(editorDir(repoRoot), REGIONS_DIR); }

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
 * @param {{maxLines?:number, includeRegions?:boolean}} [opts]
 */
export function memorySectionText(repoRoot, opts = {}) {
  const maxLines = Number(opts.maxLines) > 0 ? Number(opts.maxLines) : MAX_LINES;
  if (!repoRoot || !existsSync(editorDir(repoRoot))) return '';

  const blocks = [];
  const ws = readLayer(memoryPath(repoRoot), maxLines);
  if (ws.text) {
    blocks.push(['### 工作区记忆（MEMORY.md）', ws.dropped ? `（更早已归档 ${ws.dropped} 行，需要时 grep 文件）` : '', ws.text].filter(Boolean).join('\n'));
  }

  // region 记忆默认不注入（数量不定，逐条注入会撑爆提示词）；需要时由持久子会话按需读。
  if (opts.includeRegions) {
    const dir = regionsDir(repoRoot);
    if (existsSync(dir)) {
      let names = [];
      try { names = readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { names = []; }
      for (const name of names.sort()) {
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

    console.log('studio-memory: demo OK');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith('studio-memory.js')) {
  demo().catch((error) => { console.error(error); process.exitCode = 1; });
}
