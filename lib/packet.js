/**
 * dsh-plugin-code-studio / packet —— 组装「实现 Agent 的任务上下文包」。
 *
 * 与小说版 packet 的对应关系：那边给的是上一章结尾、该推进的伏笔、风格锚点；
 * 这边给的是目标、要动的文件（含内容摘录）、契约、约束、验收标准、账本现状。
 * 目的相同：让实现 Agent 只看这一个包就能开工，不必自己再猜要读哪些文件。
 *
 * 只做「读文件 + 拼 Markdown」，不做任何判断。文件按 head 截断，避免把整个仓库
 * 塞进上下文 —— 需要全文时实现 Agent 自己 read。
 */

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

/** 每个文件塞进上下文的最大字符数（超出部分截断，末尾提示按需自读）。 */
const FILE_HEAD_LIMIT = 6000;

async function readHead(dir, relPath) {
  const abs = isAbsolute(relPath) ? relPath : join(dir, relPath);
  try {
    const info = await stat(abs);
    if (!info.isFile()) return `\`${relPath}\`——不是文件，跳过。`;
    const body = await readFile(abs, 'utf8').catch(() => null);
    if (body === null) return `\`${relPath}\`——读不到（可能不是文本）。`;
    const label = isAbsolute(relPath) ? relative(dir, abs) || abs : relPath;
    if (body.length <= FILE_HEAD_LIMIT) {
      return `### ${label}\n\n\`\`\`\n${body.trimEnd()}\n\`\`\``;
    }
    return `### ${label}（已截断，共 ${body.length} 字）\n\n\`\`\`\n${body.slice(0, FILE_HEAD_LIMIT).trimEnd()}\n…（截断）…\n\`\`\``;
  } catch (error) {
    return `\`${relPath}\`——读取失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * 组装上下文包。
 * @param {object} spec
 * @param {string} spec.dir 仓库根目录（绝对路径）
 * @param {string} [spec.objective] 这一步要达成什么
 * @param {string[]} [spec.sourcePaths] 需要实现 Agent 参考/修改的路径
 * @param {string[]} [spec.contracts] 契约/接口说明（纯文本条目）
 * @param {string[]} [spec.constraints] 约束（不许做什么）
 * @param {string[]} [spec.acceptance] 验收标准（人可读；机器门由 code_check 跑）
 * @param {string[]} [spec.notes] 其它附加说明
 * @returns {Promise<string>} Markdown 上下文包
 */
export async function buildPacket(spec = {}) {
  const dir = String(spec.dir ?? '');
  const lines = ['# 任务上下文包', ''];
  if (spec.objective) lines.push('## 目标', '', String(spec.objective).trim(), '');

  const sourcePaths = (spec.sourcePaths ?? []).map((item) => String(item ?? '').trim()).filter(Boolean);
  if (sourcePaths.length) {
    lines.push('## 相关文件（内容摘录，需要全文请自行 read）', '');
    for (const relPath of sourcePaths) {
      lines.push(await readHead(dir, relPath), '');
    }
  } else {
    lines.push('## 相关文件', '', '（未提供 source_paths——实现 Agent 需自行 glob/grep 定位。）', '');
  }

  const section = (title, values) => {
    const items = (values ?? []).map((item) => String(item ?? '').trim()).filter(Boolean);
    if (!items.length) return;
    lines.push(`## ${title}`, '');
    for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  };
  section('契约 / 接口边界', spec.contracts);
  section('约束（不许做什么）', spec.constraints);
  section('验收标准（人工判据）', spec.acceptance);
  section('其它说明', spec.notes);

  return lines.join('\n').trimEnd() + '\n';
}
