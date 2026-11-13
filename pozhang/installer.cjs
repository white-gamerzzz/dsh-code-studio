"use strict";
/*
  跨平台安装引擎（macOS / Linux 用 Node 原生实现）

  产物结构 ——
    · 标记：由 brand.cjs 生成（破障注入开始 / POZHANG-INJECT / POZHANG-CURSOR-INJECT）
      识别时同时匹配旧品牌的标记，保证历史注入能被更新或清除。
    · install-state.json 字段名（previousLine / hadLine / promptHistory / installedSkills …）
    · 提示词占位符展开（__CODEX_HOME__）

  导出：install / uninstall / restoreMemory / sweep，签名 (targetId, opts) => Promise<Result>
  Result = { ok, code, out, timedOut, error }
*/

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const brand = require("./brand.cjs");
const { BRAND } = brand;

const HOME = os.homedir();
const MEM_VERSION = 999999; // 高版本号：WorkBuddy 判 stale_version 时会保留我们这份

// ---------------------------------------------------------------- 基础工具

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function writeText(p, text) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, text, "utf8");
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
   手写递归拷贝，不用 fs.cpSync：
   1) cpSync 在部分受限环境里会直接杀进程（本机实测 exit 127，无报错）；
   2) 自己实现能精确控制符号链接、跳过 .DS_Store 之类的垃圾。
*/
function copyTree(src, dst) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) {
    ensureDir(path.dirname(dst));
    try {
      fs.unlinkSync(dst);
    } catch {}
    fs.symlinkSync(fs.readlinkSync(src), dst);
    return;
  }
  if (st.isDirectory()) {
    ensureDir(dst);
    for (const name of fs.readdirSync(src)) {
      if (name === ".DS_Store") continue;
      copyTree(path.join(src, name), path.join(dst, name));
    }
    return;
  }
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function norm(s) {
  return String(s || "").replace(/\r\n/g, "\n").trim();
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

/** 列出带 SKILL.md 的一级子目录（= 一个技能）。 */
function listSkillDirs(src) {
  if (!exists(src)) return [];
  return fs
    .readdirSync(src, { withFileTypes: true })
    .filter((d) => d.isDirectory() && exists(path.join(src, d.name, "SKILL.md")))
    .map((d) => d.name)
    .sort();
}

// ---------------------------------------------------------------- 块注入

/** 用 begin/end 标记替换块；没有旧块返回 found:false。 */
function replaceBlock(text, beginRe, endRe, block) {
  const b = text.match(beginRe);
  if (!b) return { found: false, text };
  const start = b.index;
  const after = text.slice(start + b[0].length);
  const e = after.match(endRe);
  if (!e) return { found: false, text };
  const end = start + b[0].length + e.index + e[0].length;
  return { found: true, text: text.slice(0, start) + block + text.slice(end) };
}

/** 摘除块（含块内内容），保留块外用户内容。 */
function removeBlock(text, beginRe, endRe) {
  const b = text.match(beginRe);
  if (!b) return { found: false, text };
  const start = b.index;
  const after = text.slice(start + b[0].length);
  const e = after.match(endRe);
  if (!e) return { found: false, text };
  const end = start + b[0].length + e.index + e[0].length;
  return { found: true, text: (text.slice(0, start) + text.slice(end)).replace(/\n{3,}/g, "\n\n") };
}

// 各家的标记由 brand.cjs 统一生成；识别正则同时匹配新旧品牌
const RE = brand.RE;

// ---------------------------------------------------------------- 路径解析

const CODEX_PROMPT_NAMES = brand.PROMPT_FILES;
/** 识别用（含旧品牌文件名），写入时不用。 */
const ALL_CODEX_PROMPT_NAMES = brand.ALL_PROMPT_FILES;

function codexHome() {
  if (process.env.CODEX_HOME && exists(process.env.CODEX_HOME)) return process.env.CODEX_HOME;
  return path.join(HOME, ".codex");
}

function workbuddyDir(cn) {
  // 国内版固定 ~/.workbuddy；国际版优先 ~/.workbuddy-ai
  if (cn) return path.join(HOME, ".workbuddy");
  const ai = path.join(HOME, ".workbuddy-ai");
  if (exists(ai)) return ai;
  return exists(path.join(HOME, ".workbuddy")) ? path.join(HOME, ".workbuddy") : ai;
}

function cursorRuleDirs() {
  const dirs = [
    path.join(HOME, ".cursor", "rules"),
    path.join(HOME, "Library", "Application Support", "Cursor", "User", "rules"),
    path.join(HOME, "Library", "Application Support", "Cursor", "rules"),
  ];
  return dirs;
}

// ---------------------------------------------------------------- 日志收集

function makeCtx(opts) {
  const lines = [];
  const log = (t) => {
    const s = String(t);
    lines.push(s);
    opts.log(s);
  };
  return { ...opts, log, lines, out: () => lines.join("\n") };
}

// ---------------------------------------------------------------- Codex

function codexPaths() {
  const home = codexHome();
  return {
    home,
    managed: path.join(home, "managed-prompts"),
    state: path.join(home, "managed-prompts", "install-state.json"),
    config: path.join(home, "config.toml"),
    agents: path.join(home, "AGENTS.md"),
    skills: path.join(home, "skills"),
  };
}

function readState(p) {
  const t = readText(p);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function writeState(p, obj) {
  writeText(p, JSON.stringify(obj, null, 2) + "\n");
}

/** 从 config.toml 解析被禁用的 skill 目录名。 */
function readDisabledSkills(configText) {
  const disabled = new Set();
  if (!configText) return disabled;
  const blocks = configText.split(/^\[\[skills\.config\]\]\s*$/m);
  for (const blk of blocks.slice(1)) {
    const mp = blk.match(/^\s*path\s*=\s*"([^"]+)"/m);
    if (!mp) continue;
    const me = blk.match(/^\s*enabled\s*=\s*(true|false)/m);
    if (me && me[1] !== "false") continue;
    if (!me) continue;
    const parts = mp[1].replace(/\\/g, "/").split("/");
    const name = parts[parts.length - 2];
    if (name) disabled.add(name);
  }
  return disabled;
}

/**
   摘掉所有 [[skills\.config]] 段。
   不能用 `^\[\[skills\.config\]\][\s\S]*?(?=^\[\[|$)`：`$` 在 m 模式下匹配行尾，
   懒惰量词会立刻在表头后停下，结果只删表头、把 path/enabled 留在文件里（实测踩过）。
   按段头切分后整段丢弃才是对的。
*/
function stripSkillBlocks(text) {
  const parts = text.split(/(?=^\[\[skills\.config\]\])/m);
  return parts.filter((p) => !p.startsWith("[[skills.config]]")).join("");
}

/** 重写 config.toml 里的 [[skills.config]] 条目。 */
function writeDisabledSkills(configPath, skillsDir, disabled) {
  let text = readText(configPath);
  if (text == null) return;
  text = stripSkillBlocks(text);
  text = text.replace(/\s+$/, "") + "\n";
  for (const name of [...disabled].sort()) {
    const sk = path.join(skillsDir, name, "SKILL.md").replace(/\\/g, "/");
    text += `\n[[skills.config]]\npath = "${sk}"\nenabled = false\n`;
  }
  writeText(configPath, text);
}

async function installCodex(opts) {
  const ctx = makeCtx(opts);
  const P = codexPaths();
  const promptPath = opts.promptPath;
  const promptName = path.basename(promptPath);
  const prev = readState(P.state) || {};

  ensureDir(P.managed);

  // 1) 提示词落盘
  const targetPrompt = path.join(P.managed, promptName);
  const raw = readText(promptPath);
  if (raw == null) throw new Error("提示词读取失败: " + promptPath);
  // __CODEX_HOME__ 展开成本机真实路径（Windows 版也是这么做的，否则换机会指到打包者机器）
  const expanded = raw.includes("__CODEX_HOME__")
    ? raw.split("__CODEX_HOME__").join(P.home.replace(/\\/g, "/"))
    : raw;
  writeText(targetPrompt, expanded);
  ctx.log("OK: 提示词 -> " + targetPrompt);
  if (expanded !== raw) ctx.log("Prompt paths   : __CODEX_HOME__ -> " + P.home.replace(/\\/g, "/"));

  // 2) config.toml 指向模型指令文件
  let configText = readText(P.config) || "";
  const hadLine = /^\s*model_instructions_file\s*=/m.test(configText);
  const prevLineMatch = configText.match(/^\s*model_instructions_file\s*=\s*[^\n]*/m);
  const previousLine = prevLineMatch ? prevLineMatch[0] : null;
  const newLine = 'model_instructions_file = "' + targetPrompt.replace(/\\/g, "/").replace(/"/g, '\\"') + '"';
  if (hadLine) {
    configText = configText.replace(/^\s*model_instructions_file\s*=\s*[^\n]*/m, newLine);
  } else {
    configText = newLine + "\n" + configText;
  }
  writeText(P.config, configText.replace(/\s+$/, "") + "\n");
  ctx.log("OK: config.toml -> model_instructions_file");

  // 3) AGENTS.md 注入块
  const body = expanded.replace(/\s+$/, "");
  const block = brand.text.codexBlock(promptName, body);
  let existing = readText(P.agents) || "";
  const blk = replaceBlock(existing, RE.codexBegin, RE.codexEnd, block);
  if (blk.found) {
    writeText(P.agents, blk.text.replace(/\s+$/, "") + "\n");
    ctx.log("Injected into AGENTS.md: updated -> " + P.agents);
  } else if (!norm(existing)) {
    writeText(P.agents, block + "\n");
    ctx.log("Injected into AGENTS.md: created -> " + P.agents);
  } else if (opts.knownPrompts && opts.knownPrompts.some((k) => norm(readText(k) || "") === norm(existing))) {
    writeText(P.agents, block + "\n");
    ctx.log("Injected into AGENTS.md: replaced-manual -> " + P.agents);
  } else {
    const bak = P.agents + ".backup-" + stamp();
    fs.copyFileSync(P.agents, bak);
    writeText(P.agents, existing.replace(/\s+$/, "") + "\n\n" + block + "\n");
    ctx.log("Injected into AGENTS.md: appended (备份 " + path.basename(bak) + ")");
  }

  // 4) 技能库
  const prevSkills = Array.isArray(prev.installedSkills) ? prev.installedSkills : [];
  const prevBundles = Array.isArray(prev.installedBundles) ? prev.installedBundles : [];
  let installedSkills = [];
  if (!opts.noSkills) {
    const src = path.join(opts.payloadDir, opts.skillsSource || "codex-skills-v4");
    const names = listSkillDirs(src);
    if (names.length) {
      ensureDir(P.skills);
      for (const n of names) copyTree(path.join(src, n), path.join(P.skills, n));
      installedSkills = names;
      ctx.log(`Installed skills: ${names.length} 个`);
    } else {
      ctx.log("跳过技能库：随包目录为空 " + src);
    }
  }

  // 5) 随附包（breaker-kit 这类不在 skills/ 树内的支持目录）
  const installedBundles = [];
  const bundleSrc = path.join(opts.payloadDir, "codex-bundle-v5");
  if (!opts.noSkills && exists(bundleSrc)) {
    for (const d of fs.readdirSync(bundleSrc, { withFileTypes: true }).filter((x) => x.isDirectory())) {
      const dest = path.join(P.home, d.name);
      if (exists(dest) && !prevBundles.includes(d.name)) {
        const bak = dest + ".bak-" + stamp();
        fs.renameSync(dest, bak);
        ctx.log("Backed up existing " + d.name + " -> " + path.basename(bak));
      }
      copyTree(path.join(bundleSrc, d.name), dest);
      installedBundles.push(d.name);
    }
  }

  // 6) 禁用非本工具技能（记录安装前的状态，卸载时还原）
  const cfgBefore = readText(P.config) || "";
  const prevDisabled = [...readDisabledSkills(cfgBefore)];
  const allSkills = listSkillDirs(P.skills);
  const toDisable = allSkills.filter((n) => !installedSkills.includes(n));
  if (toDisable.length) {
    const cfg = readText(P.config) || "";
    writeDisabledSkills(P.config, P.skills, new Set(toDisable));
    ctx.log("Disabled non-managed skills: " + toDisable.join(", "));
  }

  // 7) 状态
  const history = Array.isArray(prev.promptHistory)
    ? prev.promptHistory.slice()
    : prev.targetPrompt
      ? [prev.targetPrompt]
      : [];
  if (!history.includes(targetPrompt)) history.push(targetPrompt);
  for (const old of history) {
    if (old !== targetPrompt && exists(old)) {
      fs.rmSync(old, { force: true });
      ctx.log("Removed previous prompt: " + path.basename(old));
    }
  }
  writeState(P.state, {
    installedAt: new Date().toISOString(),
    targetPrompt,
    promptHistory: history,
    hadLine,
    previousLine,
    installedSkills,
    installedBundles,
    previousDisabledSkills: prevDisabled,
  });
  return { ok: true, code: 0, out: ctx.out() };
}

async function uninstallCodex(opts, restoreOnly) {
  const ctx = makeCtx(opts);
  const P = codexPaths();
  const st = readState(P.state) || {};

  // config.toml：还原 model_instructions_file 行
  if (exists(P.config)) {
    let text = readText(P.config) || "";
    const isOwnPrev = !!(st.previousLine && String(st.previousLine).includes("managed-prompts"));
    if (st.hadLine && st.previousLine && !isOwnPrev) {
      text = text.replace(/^\s*model_instructions_file\s*=\s*[^\n]*(?:\n|$)/m, String(st.previousLine) + "\n");
    } else {
      text = text.replace(/^\s*model_instructions_file\s*=\s*[^\n]*(?:\n|$)/m, "");
    }
    writeText(P.config, text.replace(/\s+$/, "") + "\n");
    ctx.log("Restored config.toml");
  }

  // 提示词文件
  const files = new Set([...(st.promptHistory || []), st.targetPrompt].filter(Boolean));
  for (const f of files) {
    if (exists(f)) {
      fs.rmSync(f, { force: true });
      ctx.log("Removed prompt: " + path.basename(f));
    }
  }

  // AGENTS.md 摘块
  const agents = readText(P.agents);
  if (agents != null) {
    const r = removeBlock(agents, RE.codexBegin, RE.codexEnd);
    if (r.found) {
      if (!r.text.trim()) {
        fs.rmSync(P.agents, { force: true });
        ctx.log("Removed injected AGENTS.md (it only held the prompt)");
      } else {
        writeText(P.agents, r.text.replace(/\s+$/, "") + "\n");
        ctx.log("Removed injected block from AGENTS.md");
      }
    }
  }

  if (!restoreOnly) {
    if (st.installedSkills) {
      for (const n of st.installedSkills) rmrf(path.join(P.skills, n));
      ctx.log("Removed managed skills: " + st.installedSkills.join(", "));
    }
    if (st.installedBundles) {
      for (const n of st.installedBundles) rmrf(path.join(P.home, n));
      ctx.log("Removed managed bundles: " + st.installedBundles.join(", "));
    }
    if (exists(P.state)) fs.rmSync(P.state, { force: true });
    if (exists(P.managed) && fs.readdirSync(P.managed).length === 0) rmrf(P.managed);
  } else {
    ctx.log("Restore-memory: managed skills, bundles and install-state.json kept");
  }

  // 记忆注入段清理
  const mem = path.join(P.home, "memories", "memory_summary.md");
  const memText = readText(mem);
  if (memText != null) {
    const next = memText.replace(brand.RE.memorySection, "").replace(/\n{3,}/g, "\n\n");
    if (next.trim() !== memText.trim()) {
      writeText(mem, next.replace(/\s+$/, "") + "\n");
      ctx.log("Removed injected Codex memory blocks");
    }
  }

  // 技能启用状态还原
  const cfg = readText(P.config) || "";
  const restore = Array.isArray(st.previousDisabledSkills) ? st.previousDisabledSkills : [];
  writeDisabledSkills(P.config, P.skills, new Set(restore));
  ctx.log(restore.length ? "Restored previous disabled skills: " + restore.join(", ") : "All non-managed skills re-enabled");

  return { ok: true, code: 0, out: ctx.out() };
}

// ---------------------------------------------------------------- Claude Code

async function installClaude(opts) {
  const ctx = makeCtx(opts);
  const home = path.join(HOME, ".claude");
  const md = path.join(home, "CLAUDE.md");
  const managed = path.join(home, "managed-prompts");
  const skillsDir = path.join(home, "skills");
  const statePath = path.join(managed, "install-state.json");
  const promptName = path.basename(opts.promptPath);

  ensureDir(managed);
  const body = (readText(opts.promptPath) || "").replace(/\s+$/, "");
  const block = brand.text.injectBlock(promptName, body);

  const existing = readText(md) || "";
  const replaced = replaceBlock(existing, RE.injectBegin, RE.injectEnd, block);
  if (replaced.found) {
    writeText(md, replaced.text.replace(/\s+$/, "") + "\n");
    ctx.log("Updated injected block in CLAUDE.md (user content kept)");
  } else if (!norm(existing)) {
    writeText(md, block + "\n");
    ctx.log("Injected prompt -> " + md);
  } else {
    // 用户自己的内容：首次备份后追加
    const bak = path.join(managed, "CLAUDE.md.bak");
    if (!exists(bak)) {
      fs.copyFileSync(md, bak);
      ctx.log("Backed up original CLAUDE.md");
    }
    writeText(md, existing.replace(/\s+$/, "") + "\n\n" + block + "\n");
    ctx.log("Appended injected block -> " + md + " (original content kept)");
  }

  // 技能
  const prev = readState(statePath) || {};
  const src = path.join(opts.payloadDir, opts.skillsSource || "codex-skills-v4");
  const names = listSkillDirs(src);
  if (names.length) {
    ensureDir(skillsDir);
    for (const n of names) copyTree(path.join(src, n), path.join(skillsDir, n));
    ctx.log(`Installed skills: ${names.length} 个`);
  }
  // 清理上一版遗留
  const stale = (prev.installedSkills || []).filter((n) => !names.includes(n));
  for (const n of stale) rmrf(path.join(skillsDir, n));
  if (stale.length) ctx.log("Pruned stale skills: " + stale.join(", "));

  writeState(statePath, { installedAt: new Date().toISOString(), installedSkills: names });
  return { ok: true, code: 0, out: ctx.out() };
}

async function uninstallClaude(opts, restoreOnly) {
  const ctx = makeCtx(opts);
  const home = path.join(HOME, ".claude");
  const md = path.join(home, "CLAUDE.md");
  const managed = path.join(home, "managed-prompts");
  const statePath = path.join(managed, "install-state.json");
  const bak = path.join(managed, "CLAUDE.md.bak");
  const st = readState(statePath) || {};

  const existing = readText(md);
  if (existing != null) {
    const r = removeBlock(existing, RE.injectBegin, RE.injectEnd);
    if (r.found) {
      if (!r.text.trim() && exists(bak)) {
        writeText(md, readText(bak));
        ctx.log("Restored original CLAUDE.md from CLAUDE.md.bak");
      } else if (!r.text.trim()) {
        fs.rmSync(md, { force: true });
        ctx.log("Removed injected CLAUDE.md");
      } else {
        writeText(md, r.text.replace(/\s+$/, "") + "\n");
        ctx.log("Removed injected block from CLAUDE.md (user content kept)");
      }
    }
  }

  if (!restoreOnly) {
    for (const n of st.installedSkills || []) rmrf(path.join(home, "skills", n));
    if (exists(statePath)) fs.rmSync(statePath, { force: true });
    rmrf(managed);
  } else {
    ctx.log("Restore-memory: skills kept");
  }
  return { ok: true, code: 0, out: ctx.out() };
}

// ---------------------------------------------------------------- Cursor

function cursorMdc(body) {
  return (
    "---\n" +
    `description: ${BRAND.name}工作规范（自动注入 · 全局生效）\n` +
    'globs: "**/*"\n' +
    "alwaysApply: true\n" +
    "---\n\n" +
    brand.text.cursorAnchor + "\n" +
    body.replace(/\s+$/, "") +
    "\n"
  );
}

async function installCursor(opts) {
  const ctx = makeCtx(opts);
  const body = readText(opts.promptPath);
  if (body == null) throw new Error("提示词读取失败: " + opts.promptPath);
  const content = cursorMdc(body);
  const written = [];
  for (const dir of cursorRuleDirs()) {
    const target = path.join(dir, brand.text.cursorFile);
    ensureDir(dir);
    const cur = readText(target);
    if (cur != null && !RE.cursor.test(cur)) fs.copyFileSync(target, target + ".bak");
    writeText(target, content);
    written.push(target);
    ctx.log("OK: " + target);
  }
  const statePath = path.join(HOME, "Library", "Application Support", "Cursor", "hs-install-state.json");
  writeState(statePath, { installedAt: new Date().toISOString(), writtenPaths: written });
  return { ok: true, code: 0, out: ctx.out() };
}

async function uninstallCursor(opts) {
  const ctx = makeCtx(opts);
  const statePath = path.join(HOME, "Library", "Application Support", "Cursor", "hs-install-state.json");
  const st = readState(statePath) || {};
  const targets = new Set(st.writtenPaths || []);
  // 新旧品牌文件名都要清（历史版本写的是旧名）
  for (const dir of cursorRuleDirs()) for (const f of brand.CURSOR_RULE_FILES) targets.add(path.join(dir, f));
  for (const t of targets) {
    if (exists(t)) {
      fs.rmSync(t, { force: true });
      ctx.log("Removed " + t);
    }
  }
  if (exists(statePath)) fs.rmSync(statePath, { force: true });
  return { ok: true, code: 0, out: ctx.out() };
}

// ---------------------------------------------------------------- WorkBuddy

function workbuddyTarget(cn) {
  const dir = workbuddyDir(cn);
  return {
    dir,
    memory: path.join(dir, "memory"),
    fileMem: path.join(dir, "MEMORY.md"),
    // 记忆总闸：generateMemoryEnabled=false 时客户端整条记忆注入链路直接 skip
    appConfig: path.join(dir, "app", "app-config.json"),
    settings: path.join(dir, "settings.json"),
    stateFile: path.join(dir, brand.STATE_FILES[0]),
    // 旧品牌留下的状态文件：读要能认，删要一并清
    legacyStateFiles: brand.STATE_FILES.slice(1).map((f) => path.join(dir, f)),
  };
}

/** 读 WorkBuddy 状态：先新名，再旧名（升级迁移）。 */
function readWbState(T) {
  const own = readState(T.stateFile);
  if (own) return own;
  for (const f of T.legacyStateFiles || []) {
    const st = readState(f);
    if (st) return st;
  }
  return {};
}

/** 列出全部 <uid>_memory.md（排除备份），按修改时间倒序 —— 最近登录的账号排最前（与原版一致）。 */
function listArchives(memDir) {
  if (!exists(memDir)) return [];
  return fs
    .readdirSync(memDir)
    .filter((n) => n.endsWith("_memory.md") && !n.includes(".bak"))
    .map((n) => {
      const f = path.join(memDir, n);
      let m = 0;
      try {
        m = fs.statSync(f).mtimeMs;
      } catch {}
      return { f, m };
    })
    .sort((a, b) => b.m - a.m)
    .map((x) => x.f);
}

function readJsonSafe(p) {
  try {
    return JSON.parse(readText(p) || "");
  } catch {
    return null;
  }
}

/** uid 解析：最近档案文件名 > settings.json 的 claw.legacyOwnerUid（与原版 Resolve-Uid 对齐）。 */
function resolveUid(memDir, settingsPath) {
  const archives = listArchives(memDir);
  if (archives.length) return path.basename(archives[0]).replace(/_memory\.md$/, "");
  const s = settingsPath ? readJsonSafe(settingsPath) : null;
  if (s && s.claw && s.claw.legacyOwnerUid) return s.claw.legacyOwnerUid;
  return null;
}

/** 记忆总闸：不假设原文件结构，对象就合并，异常就重建（与原版 Set-AppConfigFlags 同策略）。 */
function writeAppConfigFlags(cfgPath, patch) {
  const cfg = readJsonSafe(cfgPath);
  const merged = {};
  if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) Object.assign(merged, cfg);
  for (const k of Object.keys(patch)) merged[k] = patch[k];
  if (!("locale" in merged)) merged.locale = "zh-CN";
  ensureDir(path.dirname(cfgPath));
  writeText(cfgPath, JSON.stringify(merged, null, 2) + "\n");
}

/** 读档案里当前 Memory Block 正文，用于判断是否已注入过（避免备份自己的注入）。 */
function readMemoryBlock(file) {
  const m = /## Memory Block\r?\n\r?\n([\s\S]*?)\r?\n\r?\n---/.exec(readText(file) || "");
  return m ? m[1].trim() : null;
}

function memoryArchive(uid, blockText) {
  const now = new Date().toISOString();
  const raw = JSON.stringify(
    { uid, memoryBlock: blockText, updatedAt: now, version: MEM_VERSION },
    null,
    2,
  );
  return (
    "# User Memory Profile\n" +
    "> Last updated: " + now + "\n" +
    "> Version: " + MEM_VERSION + "\n\n" +
    "## Memory Block\n\n" +
    blockText + "\n\n---\n\n" +
    "<!-- RAW_JSON_START\n" + raw + "\nRAW_JSON_END -->\n"
  );
}

async function installWorkbuddy(opts) {
  const ctx = makeCtx(opts);
  const T = workbuddyTarget(opts.cn);
  const body = readText(opts.promptPath);
  if (body == null) throw new Error("提示词读取失败: " + opts.promptPath);
  const text = body.replace(/\s+$/, "");

  ensureDir(T.memory);
  const prevState = readWbState(T) || {};
  const archives = listArchives(T.memory);
  const uid = opts.uid || resolveUid(T.memory, T.settings);

  // 1) 账号级云记忆档案：全部 <uid>_memory.md 都注入（多账号/换号场景，与原版一致）
  if (!archives.length) {
    ctx.log("未执行：找不到云记忆档案（" + T.memory + "/<uid>_memory.md）——先在 WorkBuddy 里发一句话生成记忆后重装");
  } else {
    const prevArchives = Array.isArray(prevState.archives) ? prevState.archives : [];
    for (const af of archives) {
      if (exists(af) && !prevArchives.includes(af) && readMemoryBlock(af) !== text) {
        const bak = path.join(T.memory, "backup", path.basename(af) + ".bak-" + stamp());
        ensureDir(path.dirname(bak));
        fs.copyFileSync(af, bak);
        ctx.log("Backed up archive -> " + path.basename(bak));
      }
      try {
        fs.chmodSync(af, 0o644);
      } catch {}
      writeText(af, memoryArchive(path.basename(af).replace(/_memory\.md$/, ""), text));
      try {
        // 只读锁：Windows 上能挡住客户端回写；macOS 客户端走 tmp+rename 可绕过，
        // 真正兜底是 WorkBuddyGuard 45s 重注入
        fs.chmodSync(af, 0o444);
      } catch {}
      ctx.log("OK: 云记忆 -> " + path.basename(af));
    }
    ctx.log("注入档案数          : " + archives.length + "（uid=" + (uid || "?") + "，Version " + MEM_VERSION + "）");
  }

  // 2) 用户级 MEMORY.md（每轮提醒 AI 主动读，兜底）
  if (exists(T.fileMem) && !prevState.fileMemBackup) {
    const bak = path.join(T.dir, "MEMORY.md.bak-" + stamp());
    fs.copyFileSync(T.fileMem, bak);
    ctx.log("Backed up MEMORY.md -> " + path.basename(bak));
    prevState.fileMemBackup = bak;
  }
  writeText(T.fileMem, text + "\n");
  ctx.log("OK: MEMORY.md -> " + T.fileMem);

  // 3) 记忆总闸：generateMemoryEnabled=false 时客户端整条链路 skip，注入必不生效
  let appCfgBackup = prevState.appConfigBackup || null;
  if (!appCfgBackup && exists(T.appConfig)) {
    appCfgBackup = T.appConfig + ".bak-pozhang-" + stamp();
    fs.copyFileSync(T.appConfig, appCfgBackup);
    ctx.log("Backed up app-config.json -> " + path.basename(appCfgBackup));
  }
  const cfgPrev = readJsonSafe(T.appConfig);
  const genBefore = cfgPrev && typeof cfgPrev === "object" ? cfgPrev.generateMemoryEnabled : "(新建)";
  writeAppConfigFlags(T.appConfig, { generateMemoryEnabled: true, localMemoryEnabled: true });
  ctx.log("OK: app-config.json -> generateMemoryEnabled: true（原值 " + genBefore + "）");

  // 4) 技能库
  const src = path.join(opts.payloadDir, opts.skillsSource || "codex-skills-v4");
  const names = listSkillDirs(src);
  if (names.length) {
    const sd = path.join(T.dir, "skills");
    ensureDir(sd);
    for (const n of names) copyTree(path.join(src, n), path.join(sd, n));
    ctx.log(`Installed skills: ${names.length} 个 -> ${sd}`);
  }

  // 5) 状态：prompt / uid / version 是 WorkBuddyGuard 的输入，缺一个守护就空转
  writeState(T.stateFile, {
    installedAt: new Date().toISOString(),
    prompt: path.basename(opts.promptPath),
    promptPath: opts.promptPath,
    promptName: path.basename(opts.promptPath),
    configDir: T.dir,
    uid: uid || "",
    version: MEM_VERSION,
    memoryDir: T.memory,
    archives,
    archive: archives[0] || "",
    fileMem: T.fileMem,
    memoryFile: T.fileMem,
    appConfig: T.appConfig,
    appConfigBackup: appCfgBackup,
    fileMemBackup: prevState.fileMemBackup || null,
    installedSkills: names,
  });
  return { ok: true, code: 0, out: ctx.out() };
}

async function uninstallWorkbuddy(opts, restoreOnly) {
  const ctx = makeCtx(opts);
  const T = workbuddyTarget(opts.cn);
  const st = readWbState(T) || {};

  // 云记忆档案：有备份就还原，否则只清掉我们写的那段
  for (const af of st.archives || []) {
    if (!exists(af)) continue;
    try {
      fs.chmodSync(af, 0o644);
    } catch {}
    const bakDir = path.join(T.memory, "backup");
    const cand = exists(bakDir)
      ? fs
          .readdirSync(bakDir)
          .filter((n) => n.startsWith(path.basename(af) + ".bak-"))
          .sort()
          .pop()
      : null;
    if (cand) {
      fs.copyFileSync(path.join(bakDir, cand), af);
      ctx.log("Restored memory archive from " + cand);
    } else {
      const md = readText(af) || "";
      const next = md.replace(/^## Memory Block\n\n[\s\S]*?\n\n---/m, "## Memory Block\n\n\n\n---");
      writeText(af, next);
      ctx.log("Cleared memory block in " + path.basename(af));
    }
  }

  // MEMORY.md
  if (exists(T.fileMem)) {
    const latestBak = exists(T.dir)
      ? fs
          .readdirSync(T.dir)
          .filter((n) => n.startsWith("MEMORY.md.bak-"))
          .sort()
          .pop()
      : null;
    if (latestBak) {
      fs.copyFileSync(path.join(T.dir, latestBak), T.fileMem);
      ctx.log("Restored MEMORY.md from " + latestBak);
    } else {
      fs.rmSync(T.fileMem, { force: true });
      ctx.log("Removed MEMORY.md");
    }
  }

  // 记忆总闸：有备份还原备份；无备份且非「装回原始记忆」则置 false（与原版一致）
  if (exists(T.appConfig)) {
    let cfgRestored = false;
    if (st.appConfigBackup && exists(st.appConfigBackup)) {
      fs.copyFileSync(st.appConfigBackup, T.appConfig);
      ctx.log("Restored app-config.json from " + path.basename(st.appConfigBackup));
      cfgRestored = true;
    }
    if (!cfgRestored) {
      if (restoreOnly) {
        ctx.log("app-config.json 未改动（记忆开关保持开启，装回的原始记忆才会被读进去）");
      } else {
        const cfg = readJsonSafe(T.appConfig);
        if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
          cfg.generateMemoryEnabled = false;
          cfg.localMemoryEnabled = false;
          writeText(T.appConfig, JSON.stringify(cfg, null, 2) + "\n");
          ctx.log("app-config.json 记忆开关已置 false");
        }
      }
    }
  }

  if (!restoreOnly) {
    for (const n of st.installedSkills || []) rmrf(path.join(T.dir, "skills", n));
    for (const f of [T.stateFile, ...(T.legacyStateFiles || [])]) {
      if (exists(f)) fs.rmSync(f, { force: true });
    }
  } else {
    ctx.log("Restore-memory: 技能库保留，守护已停止重注入");
  }
  return { ok: true, code: 0, out: ctx.out() };
}

// ---------------------------------------------------------------- DeepSeek Harness

async function installDsh(opts) {
  const ctx = makeCtx(opts);
  const home = path.join(HOME, ".dsh");
  const agents = path.join(home, "AGENTS.md");
  const managed = path.join(home, "managed-prompts");
  const statePath = path.join(managed, "install-state.json");
  const skillsDir = path.join(home, "skills");

  ensureDir(managed);
  const body = (readText(opts.promptPath) || "").replace(/\s+$/, "");
  const block = brand.text.injectBlockBare(body);

  const existing = readText(agents) || "";
  if (exists(agents) && !exists(path.join(managed, "AGENTS.md.bak"))) {
    fs.copyFileSync(agents, path.join(managed, "AGENTS.md.bak"));
  }
  const r = replaceBlock(existing, RE.injectBegin, RE.injectEnd, block);
  writeText(agents, (r.found ? r.text : existing ? existing.replace(/\s+$/, "") + "\n\n" + block : block).replace(/\s+$/, "") + "\n");
  ctx.log("OK: AGENTS.md -> " + agents);

  const src = path.join(opts.payloadDir, opts.skillsSource || "codex-skills-v4");
  const names = listSkillDirs(src);
  if (names.length) {
    ensureDir(skillsDir);
    for (const n of names) copyTree(path.join(src, n), path.join(skillsDir, n));
    ctx.log(`Installed skills: ${names.length} 个`);
  }
  writeState(statePath, { installedAt: new Date().toISOString(), installedSkills: names });
  return { ok: true, code: 0, out: ctx.out() };
}

async function uninstallDsh(opts, restoreOnly) {
  const ctx = makeCtx(opts);
  const home = path.join(HOME, ".dsh");
  const agents = path.join(home, "AGENTS.md");
  const managed = path.join(home, "managed-prompts");
  const statePath = path.join(managed, "install-state.json");
  const st = readState(statePath) || {};

  const existing = readText(agents);
  if (existing != null) {
    const r = removeBlock(existing, RE.injectBegin, RE.injectEnd);
    if (r.found) {
      const bak = path.join(managed, "AGENTS.md.bak");
      if (!r.text.trim() && exists(bak)) {
        writeText(agents, readText(bak));
        ctx.log("Restored AGENTS.md from backup");
      } else if (!r.text.trim()) {
        fs.rmSync(agents, { force: true });
        ctx.log("Removed injected AGENTS.md");
      } else {
        writeText(agents, r.text.replace(/\s+$/, "") + "\n");
        ctx.log("Removed injected block from AGENTS.md");
      }
    }
  }
  if (!restoreOnly) {
    for (const n of st.installedSkills || []) rmrf(path.join(home, "skills", n));
    if (exists(statePath)) fs.rmSync(statePath, { force: true });
    rmrf(managed);
  }
  return { ok: true, code: 0, out: ctx.out() };
}

// ---------------------------------------------------------------- ZCode

async function installZcode(opts) {
  const ctx = makeCtx(opts);
  const home = path.join(HOME, ".zcode");
  const agents = path.join(home, "AGENTS.md");
  ensureDir(home);
  const body = (readText(opts.promptPath) || "").replace(/\s+$/, "");
  const block = brand.text.injectBlockBare(body);
  const existing = readText(agents) || "";
  if (exists(agents) && !exists(path.join(home, "managed-prompts", "AGENTS.md.bak"))) {
    ensureDir(path.join(home, "managed-prompts"));
    fs.copyFileSync(agents, path.join(home, "managed-prompts", "AGENTS.md.bak"));
  }
  const r = replaceBlock(existing, RE.injectBegin, RE.injectEnd, block);
  writeText(agents, (r.found ? r.text : existing ? existing.replace(/\s+$/, "") + "\n\n" + block : block).replace(/\s+$/, "") + "\n");
  ctx.log("OK: AGENTS.md -> " + agents);
  ctx.log("未执行：ZCode 客户端本体（resources/glm/zcode.cjs）系统提示词补丁 —— macOS 上无该二进制");
  writeState(path.join(home, "install-state.json"), { installedAt: new Date().toISOString() });
  return { ok: true, code: 0, out: ctx.out() };
}

async function uninstallZcode(opts) {
  const ctx = makeCtx(opts);
  const home = path.join(HOME, ".zcode");
  const agents = path.join(home, "AGENTS.md");
  const existing = readText(agents);
  if (existing != null) {
    const r = removeBlock(existing, RE.injectBegin, RE.injectEnd);
    if (r.found) {
      const bak = path.join(home, "managed-prompts", "AGENTS.md.bak");
      if (!r.text.trim() && exists(bak)) {
        writeText(agents, readText(bak));
        ctx.log("Restored AGENTS.md from backup");
      } else if (!r.text.trim()) {
        fs.rmSync(agents, { force: true });
        ctx.log("Removed injected AGENTS.md");
      } else {
        writeText(agents, r.text.replace(/\s+$/, "") + "\n");
        ctx.log("Removed injected block from AGENTS.md");
      }
    }
  }
  const sp = path.join(home, "install-state.json");
  if (exists(sp)) fs.rmSync(sp, { force: true });
  return { ok: true, code: 0, out: ctx.out() };
}

// ---------------------------------------------------------------- 兜底清扫

/** 对应 scripts\clear-injected-prompts.ps1：只清提示词与副产物，不动用户内容。 */
async function sweep(opts) {
  const ctx = makeCtx(opts);
  const t = opts.targetId === "workbuddy-cn" ? "workbuddy" : opts.targetId;

  if (t === "codex" || t === "claude" || t === "dsh" || t === "zcode") {
    const roots =
      t === "codex"
        ? { home: codexHome(), managed: path.join(codexHome(), "managed-prompts"), doc: path.join(codexHome(), "AGENTS.md") }
        : t === "claude"
          ? { home: path.join(HOME, ".claude"), managed: path.join(HOME, ".claude", "managed-prompts"), doc: path.join(HOME, ".claude", "CLAUDE.md") }
          : t === "dsh"
            ? { home: path.join(HOME, ".dsh"), managed: path.join(HOME, ".dsh", "managed-prompts"), doc: path.join(HOME, ".dsh", "AGENTS.md") }
            : { home: path.join(HOME, ".zcode"), managed: path.join(HOME, ".zcode", "managed-prompts"), doc: path.join(HOME, ".zcode", "AGENTS.md") };

    // 1) 注入块
    const doc = readText(roots.doc);
    if (doc != null) {
      const re = t === "claude" ? [RE.injectBegin, RE.injectEnd] : t === "codex" ? [RE.codexBegin, RE.codexEnd] : [RE.injectBegin, RE.injectEnd];
      const r = removeBlock(doc, re[0], re[1]);
      if (r.found) {
        if (!r.text.trim()) fs.rmSync(roots.doc, { force: true });
        else writeText(roots.doc, r.text.replace(/\s+$/, "") + "\n");
        ctx.log("sweep: 摘除注入块 " + roots.doc);
      }
    }
    // 2) managed-prompts 下的提示词
    if (exists(roots.managed)) {
      for (const f of fs.readdirSync(roots.managed)) {
        if (!f.endsWith(".md") || f.endsWith(".bak")) continue;
        fs.rmSync(path.join(roots.managed, f), { force: true });
        ctx.log("sweep: 删除残留提示词 " + f);
      }
    }
  }

  if (t === "cursor") {
    for (const dir of cursorRuleDirs()) {
      for (const name of brand.CURSOR_RULE_FILES) {
        const f = path.join(dir, name);
        if (exists(f)) {
          fs.rmSync(f, { force: true });
          ctx.log("sweep: 删除 " + f);
        }
      }
    }
  }

  if (t === "workbuddy") {
    for (const cn of [false, true]) {
      const T = workbuddyTarget(cn);
      for (const af of [T.fileMem, T.stateFile, ...(T.legacyStateFiles || [])]) {
        if (exists(af)) {
          try {
            fs.chmodSync(af, 0o644);
          } catch {}
          fs.rmSync(af, { force: true });
          ctx.log("sweep: 删除 " + af);
        }
      }
      if (exists(T.memory)) {
        for (const f of fs.readdirSync(T.memory)) {
          if (!f.endsWith("_memory.md")) continue;
          const af = path.join(T.memory, f);
          try {
            fs.chmodSync(af, 0o644);
          } catch {}
          const md = readText(af) || "";
          if (md.includes("## Memory Block")) {
            writeText(af, md.replace(/^## Memory Block\n\n[\s\S]*?\n\n---/m, "## Memory Block\n\n\n\n---"));
            ctx.log("sweep: 清空 " + f + " 的 Memory Block");
          }
        }
      }
    }
  }

  if (t === "doubao") ctx.log("sweep: 豆包为 Windows 客户端，macOS 无需清理");
  return { ok: true, code: 0, out: ctx.out() };
}

// ---------------------------------------------------------------- 调度

const HANDLERS = {
  codex: { install: installCodex, uninstall: (o) => uninstallCodex(o, false), restore: (o) => uninstallCodex(o, true) },
  claude: { install: installClaude, uninstall: (o) => uninstallClaude(o, false), restore: (o) => uninstallClaude(o, true) },
  cursor: { install: installCursor, uninstall: uninstallCursor, restore: uninstallCursor },
  workbuddy: {
    install: installWorkbuddy,
    uninstall: (o) => uninstallWorkbuddy(o, false),
    restore: (o) => uninstallWorkbuddy(o, true),
  },
  "workbuddy-cn": {
    install: (o) => installWorkbuddy({ ...o, cn: true }),
    uninstall: (o) => uninstallWorkbuddy({ ...o, cn: true }, false),
    restore: (o) => uninstallWorkbuddy({ ...o, cn: true }, true),
  },
  dsh: { install: installDsh, uninstall: (o) => uninstallDsh(o, false), restore: (o) => uninstallDsh(o, true) },
  zcode: { install: installZcode, uninstall: uninstallZcode, restore: uninstallZcode },
};

async function run(kind, targetId, opts) {
  const h = HANDLERS[targetId];
  if (!h) {
    const msg = targetId === "doubao" ? "豆包破甲依赖 Windows 客户端（CDP 调试端口），macOS 版不支持该目标" : "未知目标: " + targetId;
    return { ok: false, code: -1, out: msg, error: msg };
  }
  const fn = h[kind];
  try {
    const r = await fn(opts);
    return r || { ok: true, code: 0, out: "" };
  } catch (e) {
    const msg = String((e && e.message) || e);
    return { ok: false, code: -1, out: msg, error: msg };
  }
}

module.exports = {
  run,
  sweep,
  paths: { codexHome, workbuddyDir, cursorRuleDirs },
  CODEX_PROMPT_NAMES,
};
