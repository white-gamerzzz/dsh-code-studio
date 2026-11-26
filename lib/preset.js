// lib/preset.js — 工作室注入层：工作区记忆读回 + 副本纪律两段系统提示。
// 不再注册主 Agent 预设（persona / code-guard 已随「插件不携带子 Agent」定稿移除）：
// 插件是纯协调工具，装上就能用，谁当主 Agent 都一样；操作手册见 skills/code-studio/SKILL.md。
import { memorySectionText, sessionMemorySectionText } from './studio-memory.js';
import { resolveMemoryRootSync } from './studio-workspace.js';
import { rulesSectionText } from './studio-rules.js';

export function installPreset(env) {
  const {
    ctx,
  } = env;

  // 工作区记忆读回：把 .code-studio/sessions/<sid>/ 与旧 .codewrite/editor 的尾部注入系统提示词。
  // repoRoot 取自当前 scope（主 Agent 会话）的 cwd；改工作区后由 section 的惰性 text 下次构建时重读。
  {
    let releaseMemory;
    let memoryMissing = false;
    const declareMemoryHint = () => {
      const prompt = ctx.get?.('systemPrompt');
      if (!prompt?.section || releaseMemory !== undefined) {
        memoryMissing = !prompt?.section;
        return;
      }
      memoryMissing = false;
      const base = typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder('TOOL_SUBAGENT') : undefined;
      releaseMemory = prompt.section({
        name: 'code-studio: workspace memory',
        order: Number.isFinite(base) ? base - 40 : 3060,
        text: (context) => {
          const repoRoot = context?.scope?.session?.header?.cwd;
          if (!repoRoot) return '';
          const sid = context?.scope?.session?.header?.id;
          try {
            // 新架构：按会话隔离（.code-studio/sessions/<sid>/）。旧 .codewrite/editor 记忆
            // 仍会作为「工作区级」一并注入（sessionMemorySectionText 不管旧目录，这里显式补一层）。
            const parts = [];
            if (sid) {
              // 继承指针解析：新会话指回旧会话那份记忆（不复制文件），读时统一取 rootSid。
              const rootSid = resolveMemoryRootSync(repoRoot, sid).rootSessionId || sid;
              const iso = sessionMemorySectionText(repoRoot, rootSid, { includeRegions: true });
              if (iso) parts.push(iso);
            }
            const legacy = memorySectionText(repoRoot, { includeRegions: false });
            if (legacy) parts.push(legacy);
            // 工作区规则：前台会话角色是 tech-lead（子会话读规则在任务单里另处理）。
            const rules = rulesSectionText(repoRoot, { role: 'tech-lead' });
            if (rules) parts.push(rules);
            return parts.join('\n\n');
          } catch {
            return '';
          }
        },
      });
    };
    declareMemoryHint();
    if (typeof ctx.inject === 'function' && memoryMissing) {
      ctx.inject(['systemPrompt'], () => {
        if (memoryMissing) declareMemoryHint();
      });
    }
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        if (typeof releaseMemory === 'function') releaseMemory();
        releaseMemory = undefined;
      }, 'code-studio: workspace memory');
    }
  }

  // 副本纪律：一单一副本，改完必须合并，绝不在主工作树上就地改。
  // 这段是给主 Bot 看的行为约束——工具报 NO_WORKSPACE / USER_DRIFT / MERGE_CONFLICT 时，
  // 它得知道正确做法是「先合并或先还原」，而不是绕过去直接在 cwd 里写文件。
  {
    let releaseDiscipline;
    let disciplineMissing = false;
    const declareDiscipline = () => {
      const prompt = ctx.get?.('systemPrompt');
      if (!prompt?.section || releaseDiscipline !== undefined) {
        disciplineMissing = !prompt?.section;
        return;
      }
      disciplineMissing = false;
      const base = typeof prompt.getSectionOrder === 'function' ? prompt.getSectionOrder('TOOL_SUBAGENT') : undefined;
      releaseDiscipline = prompt.section({
        name: 'code-studio: copy discipline',
        order: Number.isFinite(base) ? base - 45 : 3055,
        text: [
          '## 副本纪律（code-studio）',
          '- 一单一副本：每条 issue 备单时都会开一份独立副本（git worktree：`.code-studio/worktrees/issue-<id>`），子会话只在副本里改。',
          '- 备单返回的 worktree 就是副本路径，子会话 `cwd` 一定是副本，不是主工作目录；非 git 目录备单会被硬闸拒掉（NOT_GIT_REPO），先 `git init`，不要绕过。',
          '- 照 GitHub 的做法：不同 issue 触碰同一片文件夹**默认并行分叉**，备单时不预判冲突。撞车留到 `code_merge` 时才暴露。',
          '- 子会话写完结算只把 issue 落进**待合并区**（REVIEW），改动还在副本里。`code_merge`（不给 id）看待合并区，建议按单号升序合并。',
          '- 合并前它会查漂移：主目录有未提交改动就拒（USER_DRIFT）。这不是故障，是要你先确认那些改动怎么办。',
          '- `MERGE_CONFLICT` 时不落地、副本留作现场，插件会列出冲突文件；派人（来源不限）去副本里解掉，再用 `code_merge id=<编号> rebased=true` 重试。',
          '- 合并成功才转 DONE，副本自动清掉；合并失败时副本留作现场，不要手动删它。',
          '- 不要在子会话的副本目录之外写文件来「顺手修一下」；那会让合并结果与主目录分叉。',
        ].join('\n'),
      });
    };
    declareDiscipline();
    if (typeof ctx.inject === 'function' && disciplineMissing) {
      ctx.inject(['systemPrompt'], () => {
        if (disciplineMissing) declareDiscipline();
      });
    }
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        if (typeof releaseDiscipline === 'function') releaseDiscipline();
        releaseDiscipline = undefined;
      }, 'code-studio: copy discipline');
    }
  }
}
