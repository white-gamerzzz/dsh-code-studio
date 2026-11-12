/**
 * eval.js — 派单前评估门（对齐 SuperAgent 的 Eval 阶段）
 *
 * SuperAgent 的主链是 Source→Trigger→**Eval**→Mandate→Ticket→Assignment→Executor。
 * Eval 决定「这条请求值不值得开一张 Ticket」。本工作室照此加一道廉价、确定性的
 * 派单前评估：不调 LLM、零依赖，只按任务单的字面完整度与角色匹配度给出
 * proceed / clarify / reject 三态裁决，并列出缺哪些字段。
 *
 * 目的不是拦人，而是把设计里那条「缺 objective/source_paths/acceptance 不得派出」
 * 从一句口号变成可执行的门：技术总监派出前先 eval 一次，缺东西当场补齐再派。
 *
 * 三种模式对齐 SuperAgent 的 eval.mode：
 *   - off：不评估，直接 proceed（只做留痕）。
 *   - observe：评但只警告，不阻断（默认）。
 *   - auto：缺关键字段即判 clarify/reject，建议先补。
 */

export const EVAL_MODES = ['off', 'observe', 'auto'];
const REQUIRED = ['objective', 'source_paths', 'acceptance'];
const NICE = ['stage', 'write_scope', 'contracts', 'constraints', 'deliverable', 'round'];

/** 角色 → 它「应该」有写权限的粗略画像，用来提示 write_scope 是否与角色匹配。 */
const WRITE_EXPECT = {
  'tech-lead': false, impact: false, reviewer: false, security: false, archivist: false,
  architect: true, contract: true, design: true, implementer: true, test: true,
  fixer: true, gopher: true, librarian: true,
};

function present(v) {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  return String(v).trim() !== '';
}

/**
 * 评估一张任务单。
 * @param {{role?:string, objective?:string, source_paths?:string[]|string, acceptance?:string[]|string,
 *          write_scope?:string[]|string, stage?:string, contracts?:any, constraints?:any,
 *          deliverable?:string, round?:number}} spec
 * @param {{mode?: 'off'|'observe'|'auto'}} [opts]
 * @returns {{verdict:'proceed'|'clarify'|'reject', mode:string, score:number, missing:string[], warnings:string[], notes:string[]}}
 */
export function assessDispatch(spec, opts = {}) {
  const mode = EVAL_MODES.includes(opts.mode) ? opts.mode : 'observe';
  const s = spec ?? {};
  const missing = REQUIRED.filter((k) => !present(s[k]));
  const missingNice = NICE.filter((k) => !present(s[k]));
  const warnings = [];
  const notes = [];

  // 角色合法性
  const role = String(s.role ?? '').trim();
  if (role && role in WRITE_EXPECT) {
    const hasScope = present(s.write_scope);
    if (WRITE_EXPECT[role] === false && hasScope) {
      warnings.push(`角色 ${role} 设计为零写权限，但给了 write_scope；确认这单真的要写文件。`);
    }
    if (WRITE_EXPECT[role] === true && !hasScope) {
      warnings.push(`角色 ${role} 需要写文件，但没有 write_scope（将放行全部路径）。建议显式限定。`);
    }
  } else if (role) {
    notes.push(`未知角色「${role}」——不在已知角色表内，请核对。`);
  }

  // 空泛的验收
  const acc = Array.isArray(s.acceptance) ? s.acceptance.join(' ') : String(s.acceptance ?? '');
  if (present(acc) && acc.replace(/\s/g, '').length < 6) {
    warnings.push('acceptance 过短，可能无法作为判据；补上机器门命令或人工判据。');
  }

  const score = Math.round(((REQUIRED.length - missing.length) / REQUIRED.length) * 100);
  let verdict;
  if (mode === 'off') verdict = 'proceed';
  else if (missing.length === 0) verdict = 'proceed';
  else if (mode === 'auto') verdict = missing.length === REQUIRED.length ? 'reject' : 'clarify';
  else verdict = 'proceed'; // observe：不缺就 proceed，缺也只警告

  if (mode === 'observe' && missing.length) {
    warnings.push(`缺少关键字段：${missing.join('、')}（observe 模式不阻断，但建议补齐再派）。`);
  }

  return { verdict, mode, score, missing, missingNice, warnings, notes };
}

/** 渲染成 Markdown。 */
export function renderEval(report) {
  const icon = report.verdict === 'proceed' ? '✅' : report.verdict === 'clarify' ? '⚠️' : '⛔';
  const lines = [`## 派单评估门：${report.verdict.toUpperCase()} ${icon}`, '', `模式 ${report.mode} · 完整度 ${report.score}/100`, ''];
  if (report.missing.length) {
    lines.push(`### 缺关键字段（必须补）`, ...report.missing.map((k) => `- ${k}`), '');
  }
  if (report.missingNice?.length) {
    lines.push(`### 缺建议字段`, ...report.missingNice.map((k) => `- ${k}`), '');
  }
  if (report.warnings.length) {
    lines.push('### 警告', ...report.warnings.map((w) => `- ${w}`), '');
  }
  if (report.notes.length) {
    lines.push('### 备注', ...report.notes.map((w) => `- ${w}`), '');
  }
  if (!report.missing.length && !report.warnings.length) lines.push('任务单完整，可以派单。');
  return lines.join('\n');
}
