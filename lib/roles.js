/**
 * 角色层：角色清单、角色卡路径解析、code_roles 工具。
 *
 * 分层纪律（本文件属于「tools/ 之外的角色共享层」）：
 *  - 角色常量与路径解析是纯函数，可单测、不碰宿主；
 *  - buildRolesTool 只依赖传入的壳层助手（textResult/reportOutput），不碰 ctx。
 *
 * 硬约束：不要加 `export default`（cordis 的 unwrapExports 取 exports.default，会让插件静默失效）。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { reportOutput, textResult } from './toolkit.js';

/** 角色清单（顺序即依赖顺序）。与 lib/agent-models.js 的 ROLE_IDS 一致。
 *  13 → 7：architect/contract/design/impact 合并为 planner；fixer 并入 implementer；
 *  gopher/librarian/archivist 合并为 maintenance。只保留真正需要独立新鲜眼的 reviewer/security/test。 */
export const ROLE_IDS = [
  'tech-lead', 'planner', 'implementer', 'reviewer', 'security', 'test', 'maintenance', 'merger',
];

export const ROLE_NAMES = {
  'tech-lead': '技术总监',
  planner: '规划',
  implementer: '实现',
  reviewer: '审校',
  security: '安全审计',
  test: '测试工程',
  maintenance: '维护',
  merger: '合并',
};

export const roleList = () => ROLE_IDS.map((role) => `${role}（${ROLE_NAMES[role]}）`).join('、');

/** 所有角色卡共用的失败报告纪律：唯一的统一副本，避免 7 份漂移。 */
export const ROLE_DISCIPLINE = [
  '',
  '## 失败报告纪律（所有角色通用，优先于本卡的交付格式）',
  '',
  '报告失败、阻塞或怀疑碰到工具/平台缺陷前，先回答三问并写出答案：',
  '1. **原始错误文本与错误码**：原样贴出，不要转述。',
  '2. **你做过哪一步能推翻自己猜测的检查**：没做过对照检查的猜测只能作为待验证假设。',
  '3. **有没有现成的正确通道没用**：例如改文件前先 read、用包管理器的命令而不是手改 lockfile。',
  '',
  '硬性禁则：三问答不上来，结论只能是 BLOCK（写「已尝试 X，得到错误 Y，未确认原因」）；',
  '不得宣称「工具缺陷 / 平台限制 / 绕不过去」；不得新建 xxx-v2 分支或文件去绕开一个本可修复的失败。',
  '',
  '## ponytail 纪律（本工作室所有角色通用）',
  '',
  '写代码前先爬梯子，停在第一个成立的台阶：',
  '1. 这东西需要存在吗？不需要就一行说明跳过（YAGNI）。',
  '2. 仓库/标准库里已经有了吗？先 grep 复用，别重造。',
  '3. 标准库能做吗？4. 平台原生能力覆盖吗（DB 约束 > 应用代码，CSS > JS）？',
  '5. 已装的依赖能解决吗？6. 能一行写完吗？7. 只有以上都不成立，才写能跑通的最小实现。',
  '最短的可工作 diff 胜出——但前提是真的读懂了问题：先读完要改的每个文件、追完真实调用链，再动手。',
  '修 bug 找根因不修症状：改一个共享函数里的守卫，比在每个调用点加守卫更小；先 grep 全部调用方。',
  '不做没要求的抽象：只有一个实现的接口、只有一个产品用的工厂、永不变的值做配置——都不要。',
  '非平凡逻辑（分支/循环/解析/钱与安全路径）留一个能跑的最小自检（assert 的 demo() 或一个 test_*）。',
].join('\n');

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

export function rolesDir() {
  return join(fileURLToPath(new URL('.', import.meta.url)), '..', 'presets', 'code-editor', 'roles');
}

export function overrideRoleDirs() {
  const dirs = [];
  const dshHome = process.env.DSH_HOME;
  if (dshHome && String(dshHome).trim()) dirs.push(join(resolve(String(dshHome).trim()), 'code-roles'));
  dirs.push(join(homedir(), '.dsh', 'code-roles'));
  return dirs;
}

export function roleCardPath(role) {
  for (const dir of overrideRoleDirs()) {
    const candidate = join(dir, `${role}.md`);
    if (existsSync(candidate)) return candidate;
  }
  return join(rolesDir(), `${role}.md`);
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** code_roles：返回角色卡全文（附统一纪律）。 */
export function buildRolesTool() {
  return {
    name: 'code_roles',
    description:
      '返回代码工作室子 Agent 的角色卡全文。派单前先调用本工具取得对应角色的完整职责、交付格式与禁则，'
      + '把返回内容作为子 Agent 提示词的一部分传入。角色：' + roleList() + '。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { role: { type: 'string', enum: ROLE_IDS, description: '角色 id' } },
      required: ['role'],
    },
    output: reportOutput((_args, value) => textResult(value.card)),
    execute: (args) => (async () => {
      const role = String(args.role ?? '');
      if (!ROLE_IDS.includes(role)) return { card: `未知角色 ${role}。可用：${ROLE_IDS.join('、')}。` };
      const card = await readFile(roleCardPath(role), 'utf8').catch(() => '');
      if (!card) return { card: `角色卡 ${role}.md 读取失败。请检查插件 presets 目录与外部覆盖目录。` };
      return { card: `${card.trimEnd()}\n${ROLE_DISCIPLINE}\n` };
    })(),
  };
}
