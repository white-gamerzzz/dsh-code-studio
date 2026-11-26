import React from 'react';
import { createRoot } from 'react-dom/client';
import '../studio.css';
import App from './App.jsx';

const boot = window.__STUDIO__ || {};

/* 令牌继承：iframe 是独立 document，CSS 变量跨不过文档边界 —— 宿主页面上的
   --dsw-alias-*（设计平台那 132 个）我们天然拿不到。这里借同源优势在启动时把
   宿主根元素上所有 --dsw- 开头的自定义属性拷到自己的 <html> 上，studio.css 的
   var(--dsw-alias-*, fallback) 才会真的吃到宿主值；同时跟随宿主深浅模式。
   跨域/独立打开时静默失败，留在 fallback。 */
function inheritHostTokens() {
  let parentDoc;
  try { parentDoc = window.parent?.document; } catch { return; }
  if (!parentDoc || parentDoc === document) return;
  const host = parentDoc.documentElement;
  /* 深色标志打在宿主 body 上（dsh-client-ui-theme: body.toggleAttribute(
     'data-ds-dark-theme')），深色别名值也在 body 作用域生效——
     令牌必须从 body 的 computed style 读，从 html 读永远是浅色值。 */
  const src = parentDoc.body || host;
  /* 面板实际消费的宿主别名清单（定点拷，不依赖 computedStyle 迭代——
     部分引擎的迭代不含自定义属性，光 for...of 会静默拷不到） */
  const NEED = [
    '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
    '--dsw-alias-bg-overlay', '--dsw-alias-interactive-bg-hover',
    '--dsw-alias-border-hairline', '--dsw-alias-text-primary', '--dsw-alias-label-secondary',
    '--dsw-alias-state-business-primary', '--dsw-alias-state-success-primary',
    '--dsw-alias-state-warn-primary', '--dsw-alias-state-error-primary',
    '--dsw-font-family-default', '--dsw-font-family-mono',
    /* BH（BotHarness）主题令牌：styles.ts :root 定义的 --bh-* 多数是 alias 的再包装，
       拷过来后 studio.css 的 var(--bh-accent, …) 才能吃到 BH 侧的主题色 */
    '--bh-accent', '--bh-hover', '--bh-selected', '--bh-surface-selected',
  ];
  const root = document.documentElement.style;
  const copyTokens = () => {
    const cs = window.parent.getComputedStyle(src);
    for (const name of NEED) {
      const v = cs.getPropertyValue(name).trim();
      if (v) root.setProperty(name, v);
    }
    for (const name of cs) {
      if (name.startsWith('--dsw-') || name.startsWith('--bh-')) {
        const v = cs.getPropertyValue(name).trim();
        if (v) root.setProperty(name, v);
      }
    }
  };
  const isDark = () => {
    for (const el of [host, parentDoc.body]) {
      if (!el) continue;
      if (el.hasAttribute('data-ds-dark-theme')) return true;
      if ((el.getAttribute('data-theme') || '').includes('dark')) return true;
      if (el.classList && el.classList.contains('dark')) return true;
    }
    return false;
  };
  const syncTheme = () => {
    copyTokens();
    if (isDark()) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  };
  syncTheme();
  const mo = new MutationObserver(syncTheme);
  mo.observe(src, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-theme', 'class', 'style'] });
  if (src !== host) mo.observe(host, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-theme', 'class', 'style'] });
}

try { inheritHostTokens(); } catch { /* 独立打开：用 fallback */ }

/* 面板诊断：任何 JS 报错（含 React 渲染崩）回传服务端日志，白屏不再哑掉 */
const reportErr = (msg) => {
  try {
    fetch('/code-studio/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'panelLog', msg: `${msg} @view=${new URLSearchParams(location.search).get('view') ?? ''}` }),
    }).catch(() => { /* 尽力而为 */ });
  } catch { /* 尽力而为 */ }
};
window.addEventListener('error', (e) => reportErr(`error: ${e.message || 'unknown'}`));
window.addEventListener('unhandledrejection', (e) => reportErr(`rejection: ${String(e.reason).slice(0, 200)}`));

createRoot(document.getElementById('root')).render(<App boot={boot} />);
