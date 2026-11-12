/**
 * review.js — 静态审校扫描（把 reviewer 角色卡的检查清单里「能机器判的」项自动化）
 *
 * 只做有把握的机械判定：TODO/FIXME、console.log 残留、显式 any、空 catch、
 * 超长文件/函数、硬编码密钥正则、调试语句、被注释掉的代码块。
 * 语义级判断（因果、边界、命名是否贴切）仍留给 reviewer 子 Agent，这里不做。
 *
 * 纯文本扫描，不调编译器、不引依赖。ponytail：正则命中即有，宁可少报不误报关键项。
 */

import { join, relative, extname } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

const IGNORE_DIRS = new Set(['node_modules', '.git', '.codewrite', 'dist', 'build', 'target', '.next', 'coverage', 'vendor']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.rs', '.py', '.java', '.rb', '.php', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.kt', '.swift', '.scala']);
const MAX_FILE_BYTES = 1024 * 512;
const LONG_FILE_LINES = 800;
const LONG_FUNC_LINES = 80;

/** 收集工作区内代码文件（限深度、跳过忽略目录与超大文件）。 */
export async function collectFiles(root, { maxDepth = 6 } = {}) {
  const files = [];
  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(p, depth + 1);
      } else if (e.isFile() && CODE_EXT.has(extname(e.name))) {
        try {
          const s = await stat(p);
          if (s.size <= MAX_FILE_BYTES) files.push(p);
        } catch {}
      }
    }
  }
  await walk(root, 0);
  return files;
}

const SECRET_PATTERNS = [
  { name: 'AWS Access Key', re: /AKIA[0-9A-Z]{16}/ },
  { name: '私钥块', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: '硬编码密码', re: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"\s]{6,}['"]/i },
  { name: '疑似 API Key', re: /(?:api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i },
  { name: 'GitHub Token', re: /gh[pous]_[A-Za-z0-9]{36}/ },
];

/** 扫描单个文件，返回 findings 数组。 */
export function scanText(relPath, text) {
  const findings = [];
  const lines = text.split('\n');
  const push = (rule, line, detail) => findings.push({ rule, file: relPath, line, detail });

  lines.forEach((line, i) => {
    const n = i + 1;
    if (/\b(TODO|FIXME|XXX|HACK)\b/.test(line)) push('待办标记', n, line.trim().slice(0, 120));
    if (/\bconsole\.(log|debug|dir|trace)\s*\(/.test(line)) push('调试输出残留', n, line.trim().slice(0, 120));
    if (/\bdebugger\s*;/.test(line)) push('debugger 残留', n, line.trim());
    if (/:\s*any\b|<any>|\bas any\b/.test(line)) push('显式 any', n, line.trim().slice(0, 120));
    if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) push('空 catch（吞异常）', n, line.trim());
    for (const sp of SECRET_PATTERNS) if (sp.re.test(line)) push(`疑似密钥：${sp.name}`, n, '（已隐去原文）');
  });

  if (lines.length > LONG_FILE_LINES) push('超长文件', 0, `${lines.length} 行 > ${LONG_FILE_LINES}`);
  return findings;
}

/** 粗测超长函数：按「缩进为 0 且以 function/def/func/fn/class 起头」或箭头赋值粗略分段。 */
export function scanLongFunctions(relPath, text) {
  const findings = [];
  const lines = text.split('\n');
  let start = -1;
  let depth = 0;
  let started = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!started && /^\s*(export\s+)?(async\s+)?(function|def|func|fn|class)\s/.test(line)) {
      start = i + 1;
      depth = 0;
      started = true;
    }
    if (started) {
      for (const ch of line) {
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
      }
      if (depth <= 0 && i > start && /^\}/.test(line.trim())) {
        const len = i - start + 2;
        if (len > LONG_FUNC_LINES) findings.push({ rule: '超长函数', file: relPath, line: start, detail: `${len} 行 > ${LONG_FUNC_LINES}` });
        started = false;
        start = -1;
      }
    }
  }
  return findings;
}

/** 全仓扫描，返回 {files, findings, byRule}。 */
export async function reviewRepo(root) {
  const files = await collectFiles(root);
  const findings = [];
  for (const f of files) {
    let text;
    try {
      text = await readFile(f, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(root, f) || f;
    findings.push(...scanText(rel, text));
    findings.push(...scanLongFunctions(rel, text));
  }
  const byRule = {};
  for (const f of findings) (byRule[f.rule] ??= []).push(f);
  return { root, files: files.length, findings, byRule };
}

/** 渲染报告。 */
export async function renderReview(root) {
  const r = await reviewRepo(root);
  const lines = [`## 静态审校 · ${r.root}`, '', `扫描 ${r.files} 个代码文件，命中 ${r.findings.length} 条。`, ''];
  if (!r.findings.length) {
    lines.push('未发现机械可判的问题 ✅（语义级审校仍需 reviewer 子 Agent）');
    return { report: lines.join('\n'), result: r };
  }
  const order = ['疑似密钥', '空 catch（吞异常）', 'debugger 残留', '调试输出残留', '显式 any', '超长函数', '超长文件', '待办标记'];
  const rules = Object.keys(r.byRule).sort((a, b) => {
    const ai = order.findIndex((o) => a.startsWith(o));
    const bi = order.findIndex((o) => b.startsWith(o));
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  for (const rule of rules) {
    const group = r.byRule[rule];
    lines.push(`### ${rule}（${group.length}）`);
    for (const f of group.slice(0, 30)) lines.push(`- \`${f.file}${f.line ? `:${f.line}` : ''}\` ${f.detail}`);
    if (group.length > 30) lines.push(`- …… 另 ${group.length - 30} 条`);
    lines.push('');
  }
  return { report: lines.join('\n'), result: r };
}
