/**
 * dsh-plugin-code-studio / runner —— 自动门的执行器（唯一跑命令的地方）。
 *
 * 为什么单独一个模块：技术总监被 code-guard 禁掉了 pwsh / bash（命令可以改文件），
 * 但「代码写完必须过机器检查」是这套架构的硬门。所以留一条**窄通道**：
 * code_check 只按仓库声明的验收命令逐条跑，返回结构化结果，不让模型发任意 shell。
 * 这不是绕过 guard —— 它比 pwsh 更窄：命令来自 `.codewrite/checks.json` 或任务单，
 * 不是模型临时编的；而且只读回执、不落盘。
 */

import { spawn } from 'node:child_process';

/**
 * 跑一条命令，收 exit code 与输出尾部。
 * @param {string} command 要跑的 shell 命令
 * @param {{cwd?: string, timeoutMs?: number, env?: object}} opts
 * @returns {Promise<{command: string, code: number|null, signal: string|null, timedOut: boolean, stdout: string, stderr: string}>}
 */
export function runCommand(command, opts = {}) {
  const { cwd, timeoutMs = 600000, env } = opts;
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ command, code, signal, timedOut, stdout: out, stderr: err });
    };
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(command, { cwd, shell: true, windowsHide: true, env: { ...process.env, ...(env ?? {}) } });
    } catch (error) {
      err = error instanceof Error ? error.message : String(error);
      settled = true;
      resolve({ command, code: null, signal: null, timedOut: false, stdout: '', stderr: err });
      return;
    }
    const timer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, timeoutMs)
      : null;
    child.stdout?.on('data', (chunk) => { out += chunk; });
    child.stderr?.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      err += (err ? '\n' : '') + (error instanceof Error ? error.message : String(error));
      finish(null, null);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      finish(code, signal);
    });
  });
}

/** 保留输出尾部若干字符（失败时最有用的是最后一屏）。 */
export function tail(text, limit = 4000) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `…（前 ${value.length - limit} 字符省略）…\n${value.slice(-limit)}`;
}

/**
 * 按清单逐条跑验收命令。
 * 全部 exit code===0 且无超时才算通过。
 * @param {string[]} commands 验收命令
 * @param {{cwd?: string, timeoutMs?: number}} opts
 * @returns {Promise<{passed: boolean, results: object[]}>}
 */
export async function runChecks(commands, opts = {}) {
  const results = [];
  for (const command of commands) {
    const result = await runCommand(command, opts);
    results.push(result);
  }
  const passed = results.length > 0 && results.every((r) => r.code === 0 && !r.timedOut);
  return { passed, results };
}
