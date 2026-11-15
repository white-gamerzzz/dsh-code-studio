/**
 * 工作室「内置网页」—— 独立页面，由 Host 的 webServer 挂在 /code-studio/，
 * 右侧栏用 <iframe> 内嵌。页面本体是 React + heroUI（Vite 打包，见 web/）。
 *
 * 产物整体**内联进一份 HTML**（CSS 进 <style>、JS 进 <script type="module">）：
 * 宿主对 /code-studio/studio.js 这类带扩展名的子路径会先被静态中间件拦成 404，
 * 多一次请求就多一个失败点，干脆一个 200 页面全带上。
 *
 * 页面只做展示 + 调 /code-studio/api/*；真实逻辑仍在 index.js。
 */

import { readFileSync } from 'node:fs';

export const PAGE_PATH = '/code-studio/';
export const API_STATE = '/code-studio/api/state';
export const API_ACTION = '/code-studio/api/action';

const DIST = new URL('./web-dist/', import.meta.url);

let _cache = null;
/** 读打包产物（进程内缓存，dev 时改完重启会话即可）。 */
function assets() {
  if (_cache) return _cache;
  const css = readFileSync(new URL('studio.css', DIST), 'utf8');
  const js = readFileSync(new URL('studio.js', DIST), 'utf8');
  _cache = { css, js };
  return _cache;
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

/** 把 </script 打断，避免 bundle 里的字符串提前闭合标签。 */
function safeJs(js) {
  return js.replace(/<\/script/gi, '<\\/script');
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
  const { css, js } = assets();
  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>工作室</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>window.__STUDIO__ = ${json};</script>
<script type="module">${safeJs(js)}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('studio-web.js')) {
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } };
  const html = renderStudioHtml({ sid: 's', dir: 'd', theme: { glass: true, bgType: 'image', bgImage: 'https://x/y.png', blur: 20 }, presets: { a: 1 } });
  assert(html.includes('<div id="root">'), 'root mount present');
  assert(html.includes('<style>') && html.includes('--background'), 'css inlined');
  assert(html.includes('<script type="module">'), 'js inlined');
  assert(!/<script[^>]*src=/.test(html), 'no external script ref');
  assert(html.includes('window.__STUDIO__'), 'boot data injected');
  assert(html.includes('"blur":20') && html.includes('"bgType":"image"'), 'theme fields serialized');
  assert(JSON.parse(html.match(/window\.__STUDIO__ = (.*?);<\/script>/)[1]).sid === 's', 'boot parses');
  assert(html.length > 100000, 'bundle looks inlined (' + html.length + ' bytes)');
  console.log('studio-web: demo OK');
}
