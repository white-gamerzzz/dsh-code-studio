/**
 * 工作室「内置网页」—— 独立页面，由 Host 的 webServer 挂在 /code-studio/，
 * 右侧栏用 <iframe> 内嵌。页面本体是 React + heroUI（Vite 打包，见 web/），
 * 产物在 lib/web-dist/：studio.js（含 React/heroUI 全部依赖）+ studio.css。
 *
 * 页面只做展示 + 调 /code-studio/api/*；真实逻辑仍在 index.js。
 */

import { readFileSync, existsSync } from 'node:fs';

export const PAGE_PATH = '/code-studio/';
export const API_STATE = '/code-studio/api/state';
export const API_ACTION = '/code-studio/api/action';

const DIST = new URL('./web-dist/', import.meta.url);

/** 静态产物表：路径后缀 → { file, type }。index.js 的页面路由按后缀直接吐文件。 */
export const ASSETS = {
  'studio.js': { file: new URL('studio.js', DIST), type: 'text/javascript; charset=utf-8' },
  'studio.css': { file: new URL('studio.css', DIST), type: 'text/css; charset=utf-8' },
};

export function readAsset(name) {
  const a = ASSETS[name];
  if (!a) return null;
  const p = a.file instanceof URL ? a.file : new URL(a.file, DIST);
  if (!existsSync(p)) return null;
  return { body: readFileSync(p, 'utf8'), type: a.type };
}

function pickTheme(opts) {
  const t = {};
  const src = opts.theme && typeof opts.theme === 'object' ? opts.theme : {};
  for (const k of ['accent', 'radius', 'density', 'mode', 'bgType', 'bgColor', 'bgImage',
    'glass', 'blur', 'saturation', 'grad', 'gradA', 'gradB', 'panelColor', 'panelOpacity']) {
    if (src[k] !== undefined) t[k] = src[k];
  }
  return t;
}

/** 完整页面 HTML。`sid` 由客户端用 ?sid= 传进来。 */
export function renderStudioHtml(opts = {}) {
  const boot = {
    sid: typeof opts.sid === 'string' ? opts.sid : '',
    dir: typeof opts.dir === 'string' ? opts.dir : '',
    theme: pickTheme(opts),
    presets: opts.presets && typeof opts.presets === 'object' ? opts.presets : {},
  };
  const json = JSON.stringify(boot).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>工作室</title>
<link rel="stylesheet" href="studio.css" />
</head>
<body>
<div id="root"></div>
<script>window.__STUDIO__ = ${json};</script>
<script type="module" src="studio.js"></script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('studio-web.js')) {
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } };
  const html = renderStudioHtml({ sid: 's', dir: 'd', theme: { glass: true, bgType: 'image', bgImage: 'https://x/y.png', blur: 20 }, presets: { a: 1 } });
  assert(html.includes('<div id="root">'), 'root mount present');
  assert(html.includes('href="studio.css"'), 'css link');
  assert(html.includes('src="studio.js"'), 'js module');
  assert(html.includes('window.__STUDIO__'), 'boot data injected');
  assert(html.includes('"blur":20') && html.includes('"bgType":"image"'), 'theme fields serialized');
  assert(JSON.parse(html.match(/window\.__STUDIO__ = (.*?);<\/script>/)[1]).sid === 's', 'boot parses');
  // 产物必须存在（先跑 npm run build:web）
  const js = readAsset('studio.js'); const css = readAsset('studio.css');
  assert(js && js.body.length > 1000, 'studio.js built');
  assert(css && css.body.includes('--heroui') || (css && css.body.length > 1000), 'studio.css built');
  console.log('studio-web: demo OK');
}
