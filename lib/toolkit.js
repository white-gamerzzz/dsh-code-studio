/**
 * 工具壳层小工具：所有 build*Tool 共用的 output/textResult 包装。
 * 分模块后每个工具文件都要用，收在这里避免十处各抄一份。
 */

/** 工具输出的文本块。 */
export const textResult = (text) => [{ type: 'text', text }];

/** 工具的 output 声明：schema 透传、render 只管把 value 变成 text 块。 */
export const reportOutput = (render) => ({ schema: { type: 'object', additionalProperties: true }, render });

/** concurrent 包装：工具声明并发安全。 */
export const concurrent = (definition) => ({ ...definition, isConcurrencySafe: () => true });

// 插件自己管理的目录永远不算「用户漂移」（台账/收件箱/worktree 元数据都是我们写的）。
// porcelain 行形如 `?? .code-studio/`、` M src/x.js`——只按路径部分判断。
export const MANAGED_DIRS = ['.code-studio/', '.codewrite/', '.agents/'];
export const notManagedLine = (line) => {
  const path = line.replace(/^..\s*/, '');
  return !MANAGED_DIRS.some((d) => path === d || path.startsWith(d) || path === d.replace(/\/$/, '') || path.startsWith(d.replace(/\/$/, '') + '/'));
};

/** 报告压成一行（去换行/多余空白，超长截断），给记忆文件当一条 ≤5 行结论用。 */
export const oneLine = (text, max = 200) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};
