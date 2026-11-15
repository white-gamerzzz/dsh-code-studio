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
  // 背景：跟随主题 / 纯色 / 图片。图片只接受 http(s) 或 data:，其余丢弃（防注入 javascript:）。
  const bgType = o.bgType === 'color' || o.bgType === 'image' ? o.bgType : 'theme';
  const bgColor = typeof o.bgColor === 'string' && HEX.test(o.bgColor.trim()) ? o.bgColor.trim() : '#0e1015';
  let bgImage = '';
  if (typeof o.bgImage === 'string') {
    const s = o.bgImage.trim();
    if (/^https?:\/\//i.test(s) || /^data:image\//i.test(s)) bgImage = s.slice(0, 2000);
  }
  // 玻璃：开关 + 模糊半径(0-30) + 饱和度(0-200%)
  const glass = !!o.glass;
  const blur = clamp(Number.isFinite(+o.blur) ? Math.round(+o.blur) : 16, 0, 30);
  const saturation = clamp(Number.isFinite(+o.saturation) ? Math.round(+o.saturation) : 140, 0, 200);
  // 背景渐变（整页，不只是左栏）：强度 0-100 + 两个色
  const grad = clamp(Number.isFinite(+o.grad) ? Math.round(+o.grad) : 55, 0, 100);
  const gradA = typeof o.gradA === 'string' && HEX.test(o.gradA.trim()) ? o.gradA.trim() : '#8b5cf6';
  const gradB = typeof o.gradB === 'string' && HEX.test(o.gradB.trim()) ? o.gradB.trim() : '#2b6cff';
  // 右侧内容面板（悬浮玻璃）：底色 + 不透明度。空串 = 跟随主题卡片色（亮/暗都好看）
  const panelColor = typeof o.panelColor === 'string' && HEX.test(o.panelColor.trim()) ? o.panelColor.trim() : '';
  const panelOpacity = clamp(Number.isFinite(+o.panelOpacity) ? Math.round(+o.panelOpacity) : 62, 0, 100);
  return { preset, accent, radius, density, mode, bgType, bgColor, bgImage, glass, blur, saturation, grad, gradA, gradB, panelColor, panelOpacity };
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
  const rgb = (hex) => { const h = hex.replace('#', ''); const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h; const n = parseInt(f, 16); return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`; };
  let css = `:root{--accent:${a.accent};--accent-weak:${a.accentWeak};--accent-line:${a.accentLine};--radius:${t.radius}px;}` +
    `html[data-theme=dark]{--accent:${a.accent};--accent-weak:${a.accentWeak};--accent-line:${a.accentLine};}` +
    (t.density === 'compact' ? 'body{font-size:12px}' : '');
  // 整页背景：底色（主题 / 纯色 / 图片）+ 三团模糊色斑叠在上面（强度 0-100）
  // 抄自 NapCat WebUI(index-Cc6JnptV.css / index-1uVwnAOV.js)：
  //   bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900
  //   + 三团固定尺寸模糊圆：500px@8%/-6%(primary) 400px@104%/22%(secondary) 600px@26%/108%(pink-200/30)
  // 必须用显式 px 尺寸；closest-side 在贴边位置半径会算得很小、光斑整个跑到视口外
  const G900 = '#111827', G800 = '#1f2937';
  const k = t.grad / 100;
  const blobs = [];
  if (t.grad > 0) {
    blobs.push(`radial-gradient(500px 500px at 8% -6%,rgba(${rgb(t.gradA)},${(0.75 * k).toFixed(3)}),rgba(${rgb(t.gradA)},0) 70%)`);
    blobs.push(`radial-gradient(400px 400px at 104% 22%,rgba(${rgb(t.gradB)},${(0.55 * k).toFixed(3)}),rgba(${rgb(t.gradB)},0) 70%)`);
    blobs.push(`radial-gradient(600px 600px at 26% 108%,rgba(249,168,212,${(0.40 * k).toFixed(3)}),rgba(249,168,212,0) 70%)`);
  }
  let base = 'var(--bg)';
  if (t.bgType === 'color') base = t.bgColor;
  else if (t.bgType === 'image' && t.bgImage) base = `url("${t.bgImage}") center/cover no-repeat fixed`;
  const lightLayers = [];
  const darkLayers = blobs.slice();
  if (t.bgType === 'image' && t.bgImage) { lightLayers.push('linear-gradient(rgba(10,12,18,.62),rgba(10,12,18,.72))'); darkLayers.push('linear-gradient(rgba(10,12,18,.62),rgba(10,12,18,.72))'); }
  lightLayers.push(base);
  // 色斑与 NapCat 的 from-gray-900 via-gray-800 to-gray-900 斜向底只给深色模式；浅色用 --bg，否则浅色也会被糊成一片紫
  darkLayers.push(t.grad > 0 && t.bgType === 'theme' ? `linear-gradient(135deg,${G900},${G800} 52%,${G900})` : base);
  css += `body{background:${lightLayers.join(',')} !important;}`;
  if (t.grad > 0 && t.bgType === 'theme') css += `html[data-theme=dark] body{background:${darkLayers.join(',')} !important;}`;
  // 左右两栏合成「一整块」悬浮面板（贴合用户要求：左右一体、统一圆角、四边留等距、悬空）
  // 抄 NapCat 卡片：bg-background/80 backdrop-blur-xl border-default-200 shadow-2xl rounded-2xl
  css += `.grid{background:${t.panelColor ? `rgba(${rgb(t.panelColor)},${(t.panelOpacity / 100).toFixed(2)})` : `color-mix(in srgb,var(--card) ${t.panelOpacity}%,transparent)`} !important;` +
    `border:1px solid color-mix(in srgb,var(--line) 70%,transparent) !important;border-radius:16px !important;` +
    `box-shadow:0 25px 50px -12px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.06) !important;` +
    // NapCat 卡片本身就是 backdrop-blur-xl（24px），恒开才有毛玻璃感，与 glass 开关无关
    `backdrop-filter:blur(24px) saturate(160%);-webkit-backdrop-filter:blur(24px) saturate(160%);}`;
  // 玻璃：半透明 + 背景模糊（面板与卡片一起，模糊才有"毛玻璃"感）
  if (t.glass) {
    css += `.glass-on .grid,.glass-on .src,.glass-on .tcard,.glass-on .card,.glass-on .report,.glass-on .graph,.glass-on .mcard{` +
      `backdrop-filter:blur(${t.blur}px) saturate(${t.saturation}%);` +
      `-webkit-backdrop-filter:blur(${t.blur}px) saturate(${t.saturation}%);}`;
  }
  return css;
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
  assert(normalizeTheme({ bgType: 'image', bgImage: 'javascript:alert(1)' }).bgImage === '', 'bgImage rejects javascript:');
  assert(normalizeTheme({ bgImage: 'https://x/y.png' }).bgImage === 'https://x/y.png', 'bgImage accepts https');
  assert(themeCssVars({ bgType: 'color', bgColor: '#123456' }).includes('#123456'), 'bgColor in css');
  assert(normalizeTheme({ glass: 1, blur: 99, saturation: -5 }).blur === 30, 'blur clamps');
  assert(themeCssVars({ glass: true }).includes('backdrop-filter'), 'glass css emitted');
  assert(normalizeTheme({ grad: 999 }).grad === 100 && normalizeTheme({ grad: -5 }).grad === 0, 'grad clamps');
  assert(normalizeTheme({ gradA: 'zzz' }).gradA === '#8b5cf6', 'gradA falls back');
  assert(normalizeTheme({ panelOpacity: 500 }).panelOpacity === 100, 'panelOpacity clamps');
  assert(normalizeTheme({ panelColor: 'blue' }).panelColor === '', 'panelColor falls back to theme');
  const g = themeCssVars({ grad: 60, gradA: '#ff0000', gradB: '#0000ff' });
  assert(g.includes('rgba(255,0,0,') && g.includes('rgba(0,0,255,'), 'grad colors in css');
  assert(g.includes('linear-gradient(135deg,#111827,#1f2937 52%,#111827)'), 'grad base = NapCat gray-900 gradient');
  assert(g.includes('radial-gradient(500px 500px at 8% -6%'), 'grad = fixed-size blurred blobs');
  assert(g.includes('rgba(249,168,212,'), 'third blob is pink');
  assert(themeCssVars({ panelColor: '#000000', panelOpacity: 50 }).includes('.grid{background:rgba(0,0,0,0.50)'), 'panel css');
  assert(themeCssVars({ panelOpacity: 70 }).includes('color-mix(in srgb,var(--card) 70%,transparent)'), 'panel follows theme card');
  assert(themeCssVars({ glass: true, blur: 18 }).includes('.glass-on .grid'), 'glass covers panel');
  assert(themeCssVars({ grad: 0 }).includes('body{background:var(--bg)'), 'grad 0 -> plain bg');
  console.log('studio-theme: demo OK');
}
