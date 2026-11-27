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
  /* 嵌入宿主时不自己画背景：透出宿主容器的材质/壁纸（BH 的 --bh-global-body-fill
     半透明材质在 .dv-content-container 上），背景跟随的终点是透明。 */
  document.documentElement.setAttribute('data-embed', '');
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
  /* BH 品牌令牌（--bh-accent 等）定义在 .bh-root 作用域（styles.ts:85-106），
     从 body 的 computedStyle 读不到 —— 必须额外从 .bh-root 读并覆盖 body 值。 */
  let bhRootEl = null;
  const copyTokens = () => {
    const grab = (el) => {
      if (!el) return;
      const cs = window.parent.getComputedStyle(el);
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
    grab(src);
    grab(bhRootEl || parentDoc.querySelector('.bh-root'));
  };
  const isDark = () => {
    /* BH（BotHarness）有独立主题系统：标志打在宿主 <html> 的 data-bh-appearance
       （appearance-scope.ts mountAppearance: documentElement.dataset.bhAppearance = mode），
       与 DSH 的 body data-ds-dark-theme 各走各的 —— 有 BH 标志时以 BH 为准。 */
    const bhMode = host.getAttribute('data-bh-appearance');
    if (bhMode === 'dark') return true;
    if (bhMode === 'light') return false;
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
  /* data-bh-appearance 是 BH 主题切换的唯一属性突变（appearance-scope 换的是
     <style> 文本内容，不产生其他属性变化）—— 必须盯它，否则 BH 切主题不重拷。 */
  const OPTS = { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-theme', 'data-bh-appearance', 'class', 'style'] };
  const mo = new MutationObserver(syncTheme);
  mo.observe(src, OPTS);
  if (src !== host) mo.observe(host, OPTS);
  /* .bh-root 是 BH SPA 后渲染出来的，可能晚于 iframe：找到后补挂属性监听（主题切换
     改 .bh-root 的 class/style 时也要重拷），没找到前用一个临时子树 observer 等它。 */
  const findBh = () => {
    const el = parentDoc.querySelector('.bh-root');
    if (el && el !== bhRootEl) { bhRootEl = el; mo.observe(el, OPTS); syncTheme(); }
    return !!el;
  };
  if (!findBh()) {
    const finder = new MutationObserver(() => { if (findBh()) finder.disconnect(); });
    finder.observe(src, { childList: true, subtree: true });
  }
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
window.addEventListener('error', (e) => reportErr(`error: ${e.message || 'unknown'}\n${(e.error && e.error.stack) || ''}`.slice(0, 900)));
window.addEventListener('unhandledrejection', (e) => reportErr(`rejection: ${String(e.reason).slice(0, 200)}`));

createRoot(document.getElementById('root')).render(<App boot={boot} />);
