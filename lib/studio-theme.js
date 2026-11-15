/**
 * 工作室配色 / 观感自定义 —— 存在 `<workspace>/.code-studio/theme.json`。
 *
 * 只允许改「少量安全的旋钮」：强调色、圆角、密度、明暗模式。
 * 背景/文字等仍由亮暗两套基色决定，用户改强调色时自动派生出 -weak / -line，
 * 所以任何颜色都不会把界面搞成不可读。
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const THEME_FILE = 'theme.json';
const WS_DIR = '.code-studio';

export const PRESETS = {
  default: { label: '默认蓝', accent: '#6b93ff' },
  napcat: { label: 'NapCat 青', accent: '#3ec9d6' },
  violet: { label: '霓虹紫', accent: '#a78bfa' },
  forest: { label: '森绿', accent: '#4ade80' },
  amber: { label: '琥珀', accent: '#fbbf24' },
  ocean: { label: '海洋', accent: '#38bdf8' },
  rose: { label: '玫瑰', accent: '#fb7185' },
};

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

/** 由强调色派生 -weak（12% 透明）与 -line（45% 透明），保证各处对比一致。 */
export function deriveAccent(accent) {
  const { r, g, b } = hexToRgb(accent);
  return {
    accent,
    accentWeak: `rgba(${r},${g},${b},0.15)`,
    accentLine: `rgba(${r},${g},${b},0.45)`,
  };
}

/** 规范化。非法值一律回落默认，不给用户把界面搞崩的机会。 */
export function normalizeTheme(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  let accent = typeof o.accent === 'string' && HEX.test(o.accent.trim()) ? o.accent.trim() : '#6b93ff';
  const preset = typeof o.preset === 'string' && PRESETS[o.preset] ? o.preset : '';
  if (preset) accent = PRESETS[preset].accent;
  const radius = clamp(Number.isFinite(+o.radius) ? +o.radius : 12, 0, 20);
  const density = o.density === 'compact' ? 'compact' : 'comfy';
  const mode = o.mode === 'light' || o.mode === 'dark' ? o.mode : 'auto';
  return { preset, accent, radius, density, mode };
}

function themePath(wsRoot) { return join(wsRoot, WS_DIR, THEME_FILE); }

export function loadTheme(wsRoot) {
  try {
    const text = readFileSync(themePath(wsRoot), 'utf8').replace(/^\uFEFF/, ''); // 防 PowerShell 写出的 BOM
    return normalizeTheme(JSON.parse(text));
  } catch {
    return normalizeTheme({});
  }
}

export function saveTheme(wsRoot, patch) {
  const next = normalizeTheme({ ...loadTheme(wsRoot), ...(patch && typeof patch === 'object' ? patch : {}) });
  const file = themePath(wsRoot);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, ...next }, null, 2), 'utf8'); // 不写 BOM
  try { renameSync(tmp, file); } catch { writeFileSync(file, JSON.stringify({ version: 1, ...next }, null, 2), 'utf8'); }
  return next;
}

/** 给页面注入用的 CSS 变量串（只含用户可改的部分）。 */
export function themeCssVars(theme) {
  const t = normalizeTheme(theme);
  const a = deriveAccent(t.accent);
  return `:root{--accent:${a.accent};--accent-weak:${a.accentWeak};--accent-line:${a.accentLine};--radius:${t.radius}px;}` +
    `html[data-theme=dark]{--accent:${a.accent};--accent-weak:${a.accentWeak};--accent-line:${a.accentLine};}` +
    (t.density === 'compact' ? 'body{font-size:12px}' : '');
}

// ---------------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('studio-theme.js')) {
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } };
  assert(normalizeTheme({}).accent === '#6b93ff', 'default accent');
  assert(normalizeTheme({ accent: 'red' }).accent === '#6b93ff', 'bad hex falls back');
  assert(normalizeTheme({ accent: '#abc' }).accent === '#abc', '3-digit hex ok');
  assert(normalizeTheme({ preset: 'napcat' }).accent === PRESETS.napcat.accent, 'preset wins');
  assert(normalizeTheme({ radius: 99 }).radius === 20, 'radius clamps high');
  assert(normalizeTheme({ radius: -3 }).radius === 0, 'radius clamps low');
  const d = deriveAccent('#3ec9d6');
  assert(d.accentWeak === 'rgba(62,201,214,0.15)', 'derive weak: ' + d.accentWeak);
  const vars = themeCssVars({ accent: '#fbbf24', radius: 6 });
  assert(vars.includes('--accent:#fbbf24') && vars.includes('--radius:6px'), 'css vars');
  assert(themeCssVars({ density: 'compact' }).includes('font-size:12px'), 'compact density');
  console.log('studio-theme: demo OK');
}
