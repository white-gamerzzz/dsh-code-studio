"use strict";
/*
  brand.cjs —— 品牌常量中心（唯一真相源）

  换名字 / 换主色 / 换激活词：只改这个文件。
  前端通过 tool:state 的 brand 字段拿到这些值，不需要重新编译。

  LEGACY 里的旧品牌只用于「识别并清理历史注入」，永远不要用它写入。
*/

const BRAND = {
  name: "破障",
  nameEn: "POZHANG",
  version: "1.2.0",
  slogan: "本机注入 · 不联网",
  accent: "#10B981",
  accentSoft: "#34D399",
  accentDim: "#059669",
  // 注入后用户要对 AI 念的词
  activationWord: "破障",
};

/** 旧品牌：迁移用，不参与写入。 */
const LEGACY = {
  name: "寒霜破甲",
  shortName: "寒霜",
  nameEn: "HANSHUANG",
};

// ---------------------------------------------------------------- 提示词清单

/**
 * 随包提示词，顺序即界面展示顺序。
 * file 必须与 payload/ 下的实际文件名一致。
 */
const PROMPTS = [
  { file: `${BRAND.name}v5.md`, tag: "V5" },
  { file: `${BRAND.name}v4.md`, tag: "V4" },
  { file: `${BRAND.name}v3.md`, tag: "V3" },
  { file: `${BRAND.name}v1.2.md`, tag: "V2" },
  { file: `${BRAND.name}-变体B-v3-英文.md`, tag: "v1" },
];

/** Claude Code 专用（正文与 v4 同源，单独一份便于分别迭代）。 */
const CLAUDE_PROMPT = `${BRAND.name}v4-claude.md`;

const PROMPT_FILES = PROMPTS.map((x) => x.file);

/** 界面上显示的版本标签，如「破障 V5」。 */
const PROMPT_LABEL = Object.fromEntries(PROMPTS.map((x) => [x.file, `${BRAND.name} ${x.tag}`]));
PROMPT_LABEL[CLAUDE_PROMPT] = `${BRAND.name} V4 · Claude`;

/**
 * 旧版文件名。仅用于两件事：
 *   1. 判断「用户之前装的是不是我们（旧品牌）的提示词」→ 显示"已安装"
 *   2. 卸载时把旧文件一并清掉
 */
const LEGACY_PROMPT_FILES = [
  `${LEGACY.shortName}v5.md`,
  `${LEGACY.shortName}v4.md`,
  `${LEGACY.shortName}v3.md`,
  `${LEGACY.shortName}v1.2.md`,
  `${LEGACY.shortName}-变体B-v3-英文.md`,
  `${LEGACY.shortName}v4-claude.md`,
];

/** 识别用的全集：新 + 旧。写入只用 PROMPT_FILES。 */
const ALL_PROMPT_FILES = [...PROMPT_FILES, ...LEGACY_PROMPT_FILES];

/** 旧标签，用于把旧版安装状态映射回新标签。 */
const LEGACY_PROMPT_LABEL = {
  [`${LEGACY.shortName}v5.md`]: PROMPT_LABEL[PROMPT_FILES[0]],
  [`${LEGACY.shortName}v4.md`]: PROMPT_LABEL[PROMPT_FILES[1]],
  [`${LEGACY.shortName}v3.md`]: PROMPT_LABEL[PROMPT_FILES[2]],
  [`${LEGACY.shortName}v1.2.md`]: PROMPT_LABEL[PROMPT_FILES[3]],
  [`${LEGACY.shortName}-变体B-v3-英文.md`]: PROMPT_LABEL[PROMPT_FILES[4]],
  [`${LEGACY.shortName}v4-claude.md`]: PROMPT_LABEL[CLAUDE_PROMPT],
};

/** 任意文件名（新或旧）→ 显示标签；不认识返回 null。 */
function labelOf(file) {
  return PROMPT_LABEL[file] || LEGACY_PROMPT_LABEL[file] || null;
}

/**
 * 旧文件名 → 对应的新文件名。
 * 用户之前装的是旧品牌版本时，界面上应该显示为已安装「当前版本」，
 * 点重装即可自动完成迁移。
 */
const LEGACY_TO_CURRENT = Object.fromEntries(
  LEGACY_PROMPT_FILES.map((f, i) => [f, [...PROMPT_FILES, CLAUDE_PROMPT][i]])
);
function currentNameOf(file) {
  return LEGACY_TO_CURRENT[file] || file;
}

// ---------------------------------------------------------------- 注入标记

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 品牌名候选：新名 + 旧名（旧的全称和简称都要，历史版本写法不统一）。 */
const BRAND_ALT = [BRAND.name, LEGACY.name, LEGACY.shortName].map(esc).join("|");
/** 标记前缀候选：新英文名 + 旧英文名。 */
const MARK_ALT = [BRAND.nameEn, LEGACY.nameEn].map(esc).join("|");

/**
 * 写入用的标记文本。
 * Codex / AGENTS.md 走 HTML 注释；Claude / DSH 走带英文前缀的注释；
 * Cursor 是单行锚点。
 */
const text = {
  codexBlock: (promptName, body) =>
    `<!-- ${BRAND.name}注入开始 · ${promptName} -->\n${body}\n<!-- ${BRAND.name}注入结束 -->`,
  injectBlock: (promptName, body) =>
    `<!-- ${BRAND.nameEn}-INJECT:BEGIN prompt=${promptName} -->\n${body}\n<!-- ${BRAND.nameEn}-INJECT:END -->`,
  injectBlockBare: (body) => `<!-- ${BRAND.nameEn}-INJECT:BEGIN -->\n${body}\n<!-- ${BRAND.nameEn}-INJECT:END -->`,
  cursorAnchor: `<!-- ${BRAND.nameEn}-CURSOR-INJECT -->`,
  cursorFile: `${BRAND.name}注入.mdc`,
  memoryHeading: `## ${BRAND.name}注入`,
};

/**
 * 识别用的正则。每个都同时匹配新旧品牌 —— 这样老用户升级后
 * 注入块能被正确定位、替换成新标记，卸载时也能清干净。
 */
const RE = {
  codexBegin: new RegExp(`<!--[^\\n]*(?:${BRAND_ALT})[^\\n]*注入开始[^\\n]*-->`),
  codexEnd: new RegExp(`<!--[^\\n]*(?:${BRAND_ALT})[^\\n]*注入结束[^\\n]*-->`),
  injectBegin: new RegExp(`<!--[^\\n]*(?:${MARK_ALT})-INJECT:BEGIN[^\\n]*-->`),
  injectEnd: new RegExp(`<!--[^\\n]*(?:${MARK_ALT})-INJECT:END[^\\n]*-->`),
  cursor: new RegExp(`<!-- ?(?:${MARK_ALT})-CURSOR-INJECT ?-->`),
  memoryHeading: new RegExp(`^## [^\\n]*(?:${BRAND_ALT})注入[^\\n]*$`, "m"),
  /**
   * 整段（标题 + 正文直到下一个 ## 或文件末尾）。
   * 原实现用了 `\z` —— JS 没有这个转义，会退化成匹配字母 z，
   * 导致"记忆段是文件最后一段"时删不掉。这里改用 `(?![\s\S])` 表示绝对末尾。
   */
  memorySection: new RegExp(`^## [^\\n]*(?:${BRAND_ALT})注入[^\\n]*\\n[\\s\\S]*?(?=^## |(?![\\s\\S]))`, "gm"),
};

/** Cursor 规则文件名候选（新的在前）。 */
const CURSOR_RULE_FILES = [text.cursorFile, `${LEGACY.shortName}注入.mdc`];

/**
 * 状态文件名，新的在前。
 * 读取时按顺序找，写入只用第一个 —— 老用户升级后状态能接上，并自动迁到新名。
 */
const STATE_FILES = [`.${BRAND.nameEn.toLowerCase()}-state.json`, `.${LEGACY.nameEn.toLowerCase()}-state.json`];

/** 给前端/渲染进程用的品牌快照。 */
function snapshot() {
  return {
    name: BRAND.name,
    nameEn: BRAND.nameEn,
    version: BRAND.version,
    slogan: BRAND.slogan,
    accent: BRAND.accent,
    accentSoft: BRAND.accentSoft,
    accentDim: BRAND.accentDim,
    activationWord: BRAND.activationWord,
  };
}

module.exports = {
  BRAND,
  LEGACY,
  PROMPTS,
  CLAUDE_PROMPT,
  PROMPT_FILES,
  ALL_PROMPT_FILES,
  LEGACY_PROMPT_FILES,
  PROMPT_LABEL,
  LEGACY_PROMPT_LABEL,
  labelOf,
  currentNameOf,
  LEGACY_TO_CURRENT,
  text,
  RE,
  CURSOR_RULE_FILES,
  STATE_FILES,
  snapshot,
};
