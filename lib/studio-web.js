/**
 * 工作室「内置网页」—— 独立 HTML 页面，由 Host 的 webServer 挂在 /code-studio/，
 * 右侧栏用 <iframe> 内嵌。这样界面完全由插件自己控制（不受宿主 slot 的样式/宽度挤压），
 * 也不依赖 React 组件树，改样式就是改这一份 CSS。
 *
 * 页面只做展示 + 调 /code-studio/api/*；所有真实逻辑仍在 index.js（读台账、派单、建 PR…）。
 */

export const PAGE_PATH = '/code-studio/';
export const API_STATE = '/code-studio/api/state';
export const API_ACTION = '/code-studio/api/action';

/** 完整页面 HTML。`sid` 由客户端用 ?sid= 传进来（当前会话），`theme` 为 'light'|'dark'|'auto'。
 *  `themeCss` 是用户自定义配色派生出来的 CSS 变量串（见 studio-theme.js），可空。 */
export function renderStudioHtml(opts = {}) {
  const sid = typeof opts.sid === 'string' ? opts.sid : '';
  const dir = typeof opts.dir === 'string' ? opts.dir : '';
  const theme = opts.theme === 'dark' ? 'dark' : opts.theme === 'light' ? 'light' : 'auto';
  const themeCss = typeof opts.themeCss === 'string' ? opts.themeCss : '';
  const accent = typeof opts.accent === 'string' ? opts.accent : '#6b93ff';
  const radius = Number.isFinite(opts.radius) ? opts.radius : 12;
  const density = opts.density === 'compact' ? 'compact' : 'comfy';
  const bgType = opts.bgType === 'color' || opts.bgType === 'image' ? opts.bgType : 'theme';
  const bgColor = typeof opts.bgColor === 'string' ? opts.bgColor : '#0e1015';
  const bgImage = typeof opts.bgImage === 'string' ? opts.bgImage : '';
  const glass = !!opts.glass;
  const blur = Number.isFinite(opts.blur) ? opts.blur : 16;
  const saturation = Number.isFinite(opts.saturation) ? opts.saturation : 140;
  const grad = Number.isFinite(opts.grad) ? opts.grad : 55;
  const gradA = typeof opts.gradA === 'string' ? opts.gradA : '#8b5cf6';
  const gradB = typeof opts.gradB === 'string' ? opts.gradB : '#2b6cff';
  const panelColor = typeof opts.panelColor === 'string' ? opts.panelColor : '#12141d';
  const panelOpacity = Number.isFinite(opts.panelOpacity) ? opts.panelOpacity : 62;
  return `<!doctype html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>工作室</title>
<style>${CSS}</style>
<style>${themeCss}</style>
</head>
<body class="${glass ? 'glass-on' : ''}">
<div id="app" class="app">
  <aside class="rail">
    <div class="brand" title="代码总编工作室"><span class="bico"></span></div>
    <nav class="railnav">
      <button class="rbtn on" id="rRegion" title="区域列表"><i>▤</i></button>
      <button class="rbtn" id="rStatus" title="工作状态"><i>◔</i></button>
      <button class="rbtn" id="rReport" title="报告"><i>▦</i></button>
    </nav>
    <div class="railbot">
      <button class="rbtn" id="rSrc" title="数据源"><i>⇄</i></button>
      <button class="rbtn" id="rTheme" title="外观设置"><i>⚙</i></button>
      <button class="rbtn" id="rRefresh" title="刷新"><i>⟳</i></button>
    </div>
  </aside>
  <div class="main">
  <header class="top">
    <div class="ttl">
      <span class="dot"></span>
      <div class="ttlwrap">
        <h1>工作室</h1>
        <span class="sub2">代码总编 · 按区域派单</span>
      </div>
      <span id="count" class="pill">—</span>
    </div>
  </header>

  <section class="src" id="srcbar" hidden>
    <button id="watch" class="chip" title="点一下开/关监听">监听 <b id="watchState">—</b></button>
    <span class="sep"></span>
    <span class="lbl">GitHub</span><b id="ghRepo" class="val">—</b>
    <input id="ghInput" class="input" placeholder="owner/repo" />
    <button id="ghBind" class="btn">绑定</button>
    <button id="ghOff" class="btn ghost">解绑</button>
    <span class="sep"></span>
    <span class="lbl">PAT</span><b id="patState" class="val">—</b>
    <input id="patInput" class="input" type="password" placeholder="ghp_…" />
    <button id="patSave" class="btn">保存</button>
    <button id="patClear" class="btn ghost">清除</button>
  </section>
  <main class="grid">
    <aside class="col left">
      <div class="secttl">区域 <span id="regCount" class="pill sm">0</span></div>
      <div id="tree" class="tree"></div>
    </aside>
    <section class="col right">
      <!-- 监控面板（工作室流程状态，非系统资源） -->
      <section class="mon">
        <div class="mcard"><b id="mRun">0</b><span>进行中</span></div>
        <div class="mcard"><b id="mQueue">0</b><span>待派</span></div>
        <div class="mcard"><b id="mDone">0</b><span>已完成</span></div>
        <div class="mcard"><b id="mFail">0</b><span>异常</span></div>
        <div class="mcard"><b id="mReg">0</b><span>区域</span></div>
        <div class="mcard"><b id="mSrc">—</b><span>数据源</span></div>
      </section>
      <div class="secttl">工作状态
        <span class="legend"><i class="d"></i>完成 <i class="r"></i>进行 <i class="f"></i>失败</span>
      </div>
      <div id="graph" class="graph"></div>
      <div class="secttl">报告
        <span class="acts">
          <button id="pr" class="btn primary" disabled>建 PR</button>
          <button id="cancel" class="btn" disabled>中止</button>
        </span>
      </div>
      <div id="report" class="report empty">选一个 issue 看报告</div>
    </section>
  </main>
  </div><!-- /.main -->
  <div id="toast" class="toast"></div>

  <!-- 悬浮外观卡片 -->
  <div id="tcard" class="tcard" hidden>
    <div class="tcard-hd" id="tcardHd">
      <span class="tcard-ttl">外观设置</span>
      <button id="tcardClose" class="btn ghost icon" title="关闭">✕</button>
    </div>
    <div class="tcard-bd">
      <div class="trow"><span class="lbl">预设</span><span id="presets" class="presets"></span></div>
      <div class="trow">
        <span class="lbl">强调色</span>
        <input id="accentColor" class="color" type="color" value="${accent}" />
        <input id="accentHex" class="input hexin" value="${accent}" spellcheck="false" />
      </div>
      <div class="trow">
        <span class="lbl">背景</span>
        <button id="bgTheme" class="btn ghost">跟随主题</button>
        <button id="bgColorBtn" class="btn ghost">纯色</button>
        <button id="bgImageBtn" class="btn ghost">图片</button>
      </div>
      <div class="trow" id="bgColorRow" hidden>
        <span class="lbl"></span>
        <input id="bgColorInput" class="color" type="color" value="#0e1015" />
        <span class="hint">给整页铺一个纯色底</span>
      </div>
      <div class="trow" id="bgImageRow" hidden>
        <span class="lbl"></span>
        <input id="bgImageInput" class="input growin" placeholder="图片 URL（https://… 或 data:image/…）" spellcheck="false" />
      </div>
      <div class="trow">
        <span class="lbl">渐变</span>
        <input id="gradA" class="color" type="color" value="#8b5cf6" />
        <input id="gradB" class="color" type="color" value="#2b6cff" />
        <input id="gradR" class="range growin" type="range" min="0" max="100" step="5" value="55" />
        <b id="gradV" class="pill sm">55</b>
      </div>
      <div class="trow">
        <span class="lbl">右栏</span>
        <input id="panelColor" class="color" type="color" value="#12141d" />
        <button id="panelReset" class="btn ghost" title="底色跟随主题">跟随</button>
        <span class="lbl">不透明</span>
        <input id="panelR" class="range growin" type="range" min="0" max="100" step="2" value="62" />
        <b id="panelV" class="pill sm">62</b>
      </div>
      <div class="trow">
        <span class="lbl">玻璃</span>
        <button id="glassToggle" class="btn ghost">关闭</button>
        <span class="lbl">模糊</span>
        <input id="blurR" class="range" type="range" min="0" max="30" step="1" value="16" />
        <b id="blurV" class="pill sm">16</b>
        <span class="lbl">饱和</span>
        <input id="satR" class="range" type="range" min="0" max="200" step="5" value="140" />
        <b id="satV" class="pill sm">140</b>
      </div>
      <div class="trow">
        <span class="lbl">圆角</span>
        <input id="radiusR" class="range" type="range" min="0" max="20" step="1" value="${radius}" />
        <b id="radiusV" class="pill sm">${radius}</b>
        <span class="lbl">密度</span>
        <button id="densComfy" class="btn ghost">舒适</button>
        <button id="densCompact" class="btn ghost">紧凑</button>
      </div>
      <div class="trow">
        <span class="lbl">模式</span>
        <button id="modeAuto" class="btn ghost">跟随</button>
        <button id="modeLight" class="btn ghost">亮色</button>
        <button id="modeDark" class="btn ghost">深色</button>
        <span class="sep"></span>
        <button id="themeReset" class="btn ghost">恢复默认</button>
        <b id="themeMsg" class="val"></b>
      </div>
    </div>
  </div>
</div>
<script>
const SID = ${JSON.stringify(sid)};
const DIR = ${JSON.stringify(dir)};
const PRESETS = ${JSON.stringify(opts.presets || {})};
const THEME = ${JSON.stringify({ accent, radius, density, mode: theme, bgType, bgColor, bgImage, glass, blur, saturation, grad, gradA, gradB, panelColor, panelOpacity })};
const $ = (id) => document.getElementById(id);
const state = { snap: null, sel: undefined, expanded: {} };

function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(t._t); t._t = setTimeout(() => { t.className = 'toast'; }, 2600);
}
async function api(path, body) {
  const q = 'sid=' + encodeURIComponent(SID) + '&dir=' + encodeURIComponent(DIR);
  const r = await fetch(path + (path.includes('?') ? '&' : '?') + q, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : { method: 'GET' });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
  return j;
}
async function load() {
  try { state.snap = await api(${JSON.stringify(API_STATE)}); render(); }
  catch (e) { toast('读取失败：' + e.message, true); }
}
const tagOf = (s) => (s === 'DONE' ? 'done' : (s === 'FAILED' || s === 'BLOCKED' || s === 'CANCELLED') ? 'fail' : (s === 'RUNNING' || s === 'READY') ? 'run' : '');

function render() {
  const s = state.snap; if (!s) return;
  const issues = s.issues || []; const regions = s.regions || {};
  $('count').textContent = issues.length + ' 个 issue';
  $('watchState').textContent = s.watch && s.watch.enabled ? '开' : '关';
  $('watch').classList.toggle('on', !!(s.watch && s.watch.enabled));
  $('ghRepo').textContent = (s.github && s.github.repo) || '未绑定';
  $('ghRepo').classList.toggle('ok', !!(s.github && s.github.enabled));
  $('patState').textContent = s.hasToken ? '已存' : '未存';
  $('patState').classList.toggle('ok', !!s.hasToken);

  // 监控卡：工作室流程状态（不是系统资源）
  const cRun = issues.filter((i) => i.status === 'RUNNING').length;
  const cDone = issues.filter((i) => i.status === 'DONE').length;
  const cFail = issues.filter((i) => ['FAILED', 'BLOCKED', 'CANCELLED'].includes(i.status)).length;
  const cQueue = issues.filter((i) => !i.status || i.status === 'READY' || i.status === 'PENDING').length;
  $('mRun').textContent = cRun; $('mQueue').textContent = cQueue; $('mDone').textContent = cDone;
  $('mFail').textContent = cFail; $('mReg').textContent = Object.keys(regions).length;
  $('mSrc').textContent = s.github && s.github.enabled ? 'GitHub' : (s.watch && s.watch.enabled ? '收件箱' : '本地');

  const names = Object.keys(regions);
  $('regCount').textContent = names.length;
  // 按区域分组的折叠树：每个区域一个可展开节点，子节点是它的 issue
  const groups = names.map((name) => ({ name, issues: issues.filter((i) => String(i.region || '') === name) }));
  const orphans = issues.filter((i) => !i.region || !regions[i.region]);
  if (orphans.length) groups.push({ name: '未归区', issues: orphans, orphan: true });
  const tree = $('tree'); tree.innerHTML = '';
  if (!groups.length) tree.appendChild(el('div', 'empty', '还没有区域（派单后自动建）'));
  for (const g of groups) {
    const key = g.orphan ? '\u0000orphan' : g.name;
    const running = g.issues.some((i) => i.status === 'RUNNING');
    // 默认展开正在跑的区域，其余折叠；用户点过之后按用户的
    const open = key in state.expanded ? !!state.expanded[key] : running;
    const head = el('div', 'tgroup-head' + (open ? ' open' : '') + (running ? ' running' : ''));
    head.appendChild(el('span', 'caret', open ? '▾' : '▸'));
    if (running) head.appendChild(el('span', 'rdot'));
    head.appendChild(el('span', 'tname', g.orphan ? '未归区' : (g.name || '—')));
    head.appendChild(el('b', 'tcount', String(g.issues.length)));
    head.onclick = () => {
      state.expanded[key] = !state.expanded[key];
      if (state.expanded[key] && g.issues[0]) state.sel = String(g.issues[0].id);
      render();
    };
    tree.appendChild(head);
    if (!open) continue;
    const kids = el('div', 'tgroup-kids');
    if (!g.issues.length) kids.appendChild(el('div', 'empty sm', '这个区域还没有 issue'));
    for (const it of g.issues) {
      const id = String(it.id); const tg = tagOf(it.status);
      const row = el('div', 'issrow' + (id === state.sel ? ' sel' : '')); row.dataset.st = tg;
      const av = el('span', 'iav'); av.appendChild(el('i', '', '#' + id));
      row.appendChild(av);
      const mid = el('div', 'imid');
      mid.appendChild(el('div', 'ittl', it.title || it.body || '(untitled)'));
      const sub = el('div', 'isub');
      sub.appendChild(el('span', 'ist', it.status || '待派'));
      if (it.region) sub.appendChild(el('span', 'ireg', '· ' + it.region));
      mid.appendChild(sub);
      row.appendChild(mid);
      row.onclick = () => { state.sel = id; render(); };
      kids.appendChild(row);
    }
    tree.appendChild(kids);
  }

  const sel = issues.find((i) => String(i.id) === state.sel);
  drawGraph(issues, regions);
  const rep = $('report');
  if (!sel) { rep.className = 'report empty'; rep.textContent = '选一个 issue 看报告'; }
  else {
    rep.className = 'report'; rep.innerHTML = '';
    const meta = el('div', 'meta');
    if (sel.region) meta.appendChild(el('span', 'chip sm', '区域 · ' + sel.region));
    const fold = (regions[sel.region] || {}).folders || sel.folders || [];
    if (fold.length) meta.appendChild(el('span', 'chip sm', fold.join(', ')));
    rep.appendChild(meta);
    if (sel.prUrl) { const a = el('a', 'prlink', sel.prUrl); a.href = sel.prUrl; a.target = '_blank'; a.rel = 'noreferrer'; rep.appendChild(a); }
    if (sel.changedFiles && sel.changedFiles.length) {
      const fl = el('div', 'files'); sel.changedFiles.forEach((f) => fl.appendChild(el('code', '', String(f)))); rep.appendChild(fl);
    }
    rep.appendChild(el('div', 'body', sel.report || (sel.status === 'FAILED' ? ('失败：' + (sel.error || '')) : '还没有报告')));
  }
  $('pr').disabled = !(sel && sel.status === 'DONE');
  $('cancel').disabled = !(sel && sel.status === 'RUNNING');
}

function drawGraph(issues, regions) {
  const box = $('graph'); box.innerHTML = '';
  const W = Math.max(box.clientWidth || 520, 320), H = 178;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('width', '100%'); svg.setAttribute('height', H);
  const names = Object.keys(regions);
  const rootX = 40, regX = Math.min(170, W * 0.34), issX = Math.max(regX + 130, W - 120);
  const rootY = H / 2;
  const add = (tag, attrs) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) n.setAttribute(k, attrs[k]); svg.appendChild(n); return n; };
  const line = (x1, y1, x2, y2) => add('path', { d: 'M' + x1 + ' ' + y1 + ' C' + ((x1 + x2) / 2) + ' ' + y1 + ' ' + ((x1 + x2) / 2) + ' ' + y2 + ' ' + x2 + ' ' + y2, class: 'edge' });
  const node = (cx, cy, r, cls, label, sub) => {
    add('circle', { cx, cy, r, class: 'node ' + cls });
    // 主干节点（root/reg）标签放上方居中，避免与右侧连线打架；issue 叶节点标签放右。
    if (cls.indexOf('iss') === 0) {
      if (label) add('text', { x: cx - r - 7, y: cy + 3.5, class: 'nlabel', 'text-anchor': 'end' }).textContent = label;
      return;
    }
    if (label) add('text', { x: cx, y: cy - r - 7, class: 'nlabel', 'text-anchor': 'middle' }).textContent = label;
    if (sub) add('text', { x: cx, y: cy + r + 13, class: 'nsub', 'text-anchor': 'middle' }).textContent = sub;
  };
  if (!names.length) { add('text', { x: 14, y: H / 2, class: 'nsub' }).textContent = '还没有区域，派单后自动建'; box.appendChild(svg); return; }
  const band = H / names.length;
  const topPad = 20;
  node(rootX, rootY, 12, 'root', 'workspace', issues.length + ' issue');
  names.forEach((name, i) => {
    const ris = issues.filter((x) => String(x.region || '') === name);
    const ry = topPad + ((H - topPad * 2) / names.length) * (i + 0.5);
    line(rootX + 12, rootY, regX - 9, ry);
    const running = ris.some((x) => x.status === 'RUNNING');
    node(regX, ry, 9, 'reg' + (running ? ' run' : ''), name || '—', ris.length + ' 个 issue');
    const span = Math.min(band * 0.82, Math.max(ris.length - 1, 1) * 26);
    ris.forEach((it, k) => {
      const iy = ris.length === 1 ? ry : ry - span / 2 + (span / (ris.length - 1)) * k;
      line(regX + 9, ry, issX - 6, iy);
      node(issX, iy, 5.5, 'iss ' + tagOf(it.status), '#' + it.id, '');
    });
  });
  box.appendChild(svg);
}

async function act(op, extra) {
  try { const r = await api(${JSON.stringify(API_ACTION)}, Object.assign({ op }, extra || {})); if (r && r.text) toast(r.text, r.ok === false); await load(); }
  catch (e) { toast(e.message, true); }
}
$('rRefresh').onclick = () => act('scan');
$('rSrc').onclick = () => { const b = $('srcbar'); b.hidden = !b.hidden; $('rSrc').classList.toggle('on', !b.hidden); };
$('rStatus').onclick = () => $('graph')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
$('rReport').onclick = () => $('report')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
$('watch').onclick = () => act(state.snap && state.snap.watch && state.snap.watch.enabled ? 'watchOff' : 'watchOn');
$('ghBind').onclick = () => { const v = $('ghInput').value.trim(); if (!v) return toast('填 owner/repo', true); act('github', { repo: v }); };
$('ghOff').onclick = () => act('githubOff');
$('patSave').onclick = () => { const v = $('patInput').value.trim(); if (!v) return toast('粘贴 PAT', true); $('patInput').value = ''; act('token', { token: v }); };
$('patClear').onclick = () => act('tokenOff');
$('pr').onclick = () => { if (state.sel) act('pr', { id: state.sel }); };
$('cancel').onclick = () => { if (state.sel) act('cancel', { id: state.sel }); };

// —— 侧栏收起 ——
const toggleSide = () => {
  const app = $('app'); const on = app.classList.toggle('side-collapsed');
  $('rRegion').classList.toggle('on', on);
  setTimeout(() => { if (state.snap) drawGraph(state.snap.issues || [], state.snap.regions || {}); }, 200);
};
$('rRegion').onclick = toggleSide;

// —— 外观设置（悬浮卡片） ——
const tstate = {
  accent: THEME.accent, radius: THEME.radius, density: THEME.density, mode: THEME.mode,
  bgType: THEME.bgType, bgColor: THEME.bgColor, bgImage: THEME.bgImage,
  glass: THEME.glass, blur: THEME.blur, saturation: THEME.saturation,
  grad: THEME.grad, gradA: THEME.gradA, gradB: THEME.gradB,
  panelColor: THEME.panelColor, panelOpacity: THEME.panelOpacity,
};
function hexToRgb(h) {
  const x = String(h || '').replace('#', ''); const f = x.length === 3 ? x.split('').map(c => c + c).join('') : x;
  const n = parseInt(f, 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function applyThemeLocal() {
  const el = document.documentElement;
  const a = tstate.accent;
  const rgb = hexToRgb(a);
  const root = document.documentElement.style;
  root.setProperty('--accent', a);
  root.setProperty('--accent-weak', 'rgba(' + rgb.join(',') + ',0.15)');
  root.setProperty('--accent-line', 'rgba(' + rgb.join(',') + ',0.45)');
  root.setProperty('--radius', tstate.radius + 'px');
  document.body.style.setProperty('font-size', tstate.density === 'compact' ? '12px' : '13px', 'important');
  const want = tstate.mode === 'auto'
    ? ((window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light')
    : tstate.mode;
  el.dataset.theme = want;
  // 背景：底色 + 双色渐变叠加
  const bd = document.body.style;
  let base = 'var(--bg)';
  if (tstate.bgType === 'color') base = tstate.bgColor;
  else if (tstate.bgType === 'image' && tstate.bgImage) base = 'url("' + tstate.bgImage.replace(/"/g, '') + '") center/cover no-repeat fixed';
  const layers = [];
  if (tstate.grad > 0) {
    const al = (tstate.grad / 100 * 0.55).toFixed(3);
    layers.push('linear-gradient(150deg,rgba(' + hexToRgb(tstate.gradA).join(',') + ',' + al + '),rgba(' + hexToRgb(tstate.gradB).join(',') + ',' + al + ') 60%,transparent)');
  }
  if (tstate.bgType === 'image' && tstate.bgImage) layers.push('linear-gradient(rgba(10,12,18,.62),rgba(10,12,18,.72))');
  layers.push(base);
  // 注意：themeCssVars 注入的 body/.col.right 都带 !important，内联必须同样带 important 才能即时预览
  bd.setProperty('background', layers.join(','), 'important');
  // 左右两栏悬浮面板：底色 + 不透明度（未指定底色则跟随主题卡片色）
  const pbg = tstate.panelColor
    ? 'rgba(' + hexToRgb(tstate.panelColor).join(',') + ',' + (tstate.panelOpacity / 100).toFixed(2) + ')'
    : 'color-mix(in srgb,var(--card) ' + tstate.panelOpacity + '%,transparent)';
  document.querySelectorAll('.col.left,.col.right').forEach((n) => n.style.setProperty('background', pbg, 'important'));
  // 玻璃
  document.body.classList.toggle('glass-on', !!tstate.glass);
  const gf = tstate.glass ? 'blur(' + tstate.blur + 'px) saturate(' + tstate.saturation + '%)' : '';
  document.querySelectorAll('.col.left,.col.right,.src,.tcard,.card,.report .body,.graph,.mcard').forEach((n) => { n.style.backdropFilter = gf; n.style.webkitBackdropFilter = gf; });
  // 高亮当前按钮
  for (const id of ['densComfy', 'densCompact', 'modeAuto', 'modeLight', 'modeDark', 'bgTheme', 'bgColorBtn', 'bgImageBtn', 'glassToggle']) { const b = $(id); if (b) b.classList.remove('on'); }
  $(tstate.density === 'compact' ? 'densCompact' : 'densComfy')?.classList.add('on');
  $('mode' + (tstate.mode === 'auto' ? 'Auto' : tstate.mode === 'light' ? 'Light' : 'Dark'))?.classList.add('on');
  $('bg' + (tstate.bgType === 'color' ? 'ColorBtn' : tstate.bgType === 'image' ? 'ImageBtn' : 'Theme'))?.classList.add('on');
  $('bgColorRow').hidden = tstate.bgType !== 'color';
  $('bgImageRow').hidden = tstate.bgType !== 'image';
  $('glassToggle').textContent = tstate.glass ? '开启' : '关闭';
  $('glassToggle').classList.toggle('on', !!tstate.glass);
  $('accentHex').value = a;
  if ($('accentColor')) $('accentColor').value = a;
  if ($('bgColorInput')) $('bgColorInput').value = tstate.bgColor;
  if ($('bgImageInput') && document.activeElement !== $('bgImageInput')) $('bgImageInput').value = tstate.bgImage;
  if ($('gradA')) $('gradA').value = tstate.gradA;
  if ($('gradB')) $('gradB').value = tstate.gradB;
  if ($('gradR')) $('gradR').value = tstate.grad;
  if ($('gradV')) $('gradV').textContent = tstate.grad;
  if ($('panelColor')) $('panelColor').value = tstate.panelColor || '#12141d';
  if ($('panelR')) $('panelR').value = tstate.panelOpacity;
  if ($('panelV')) $('panelV').textContent = tstate.panelOpacity;
  $('radiusV').textContent = tstate.radius; $('blurV').textContent = tstate.blur; $('satV').textContent = tstate.saturation;
  if ($('blurR')) $('blurR').value = tstate.blur; if ($('satR')) $('satR').value = tstate.saturation;
  document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s.dataset.accent === a));
}
async function saveTheme(patch) {
  Object.assign(tstate, patch);
  applyThemeLocal();
  try {
    const theme = {
      accent: tstate.accent, radius: tstate.radius, density: tstate.density, mode: tstate.mode,
      bgType: tstate.bgType, bgColor: tstate.bgColor, bgImage: tstate.bgImage,
      glass: tstate.glass, blur: tstate.blur, saturation: tstate.saturation,
      grad: tstate.grad, gradA: tstate.gradA, gradB: tstate.gradB,
      panelColor: tstate.panelColor, panelOpacity: tstate.panelOpacity,
    };
    const r = await api(${JSON.stringify(API_ACTION)}, { op: 'theme', theme });
    if ($('themeMsg')) { $('themeMsg').textContent = r && r.ok ? '已保存' : '保存失败'; setTimeout(() => { if ($('themeMsg')) $('themeMsg').textContent = ''; }, 1600); }
  } catch (e) { toast(e.message, true); }
}
(function initThemePanel() {
  const wrap = $('presets');
  for (const key of Object.keys(PRESETS)) {
    const p = PRESETS[key];
    const b = document.createElement('button'); b.className = 'swatch'; b.title = p.label; b.dataset.accent = p.accent;
    b.style.background = p.accent; b.onclick = () => saveTheme({ accent: p.accent });
    wrap.appendChild(b);
  }
  const openCard = (on) => { $('tcard').hidden = !on; };
  $('rTheme').onclick = () => openCard($('tcard').hidden);
  $('tcardClose').onclick = () => openCard(false);
  // 拖拽悬浮卡片
  (function drag() {
    const card = $('tcard'), hd = $('tcardHd'); let sx = 0, sy = 0, ox = 0, oy = 0, on = false;
    hd.addEventListener('mousedown', (e) => { if (e.target.closest('button')) return; on = true; const r = card.getBoundingClientRect(); sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top; card.style.right = 'auto'; card.style.bottom = 'auto'; card.style.left = ox + 'px'; card.style.top = oy + 'px'; e.preventDefault(); });
    window.addEventListener('mousemove', (e) => { if (!on) return; card.style.left = Math.max(0, ox + e.clientX - sx) + 'px'; card.style.top = Math.max(0, oy + e.clientY - sy) + 'px'; });
    window.addEventListener('mouseup', () => { on = false; });
  })();
  $('accentColor').oninput = () => { tstate.accent = $('accentColor').value; applyThemeLocal(); };
  $('accentColor').onchange = () => saveTheme({ accent: $('accentColor').value });
  $('accentHex').onchange = () => { const v = $('accentHex').value.trim(); if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) saveTheme({ accent: v }); else toast('颜色要写成 #rgb 或 #rrggbb', true); };
  $('bgTheme').onclick = () => saveTheme({ bgType: 'theme' });
  $('bgColorBtn').onclick = () => saveTheme({ bgType: 'color' });
  $('bgImageBtn').onclick = () => saveTheme({ bgType: 'image' });
  $('bgColorInput').onchange = () => saveTheme({ bgColor: $('bgColorInput').value });
  $('bgImageInput').onchange = () => { const v = $('bgImageInput').value.trim(); const ok = !v || v.indexOf('http://') === 0 || v.indexOf('https://') === 0 || v.indexOf('data:image/') === 0; if (ok) saveTheme({ bgImage: v }); else toast('图片地址要以 http(s):// 或 data:image/ 开头', true); };
  $('glassToggle').onclick = () => saveTheme({ glass: !tstate.glass });
  $('blurR').oninput = () => { tstate.blur = +$('blurR').value; applyThemeLocal(); };
  $('blurR').onchange = () => saveTheme({ blur: +$('blurR').value });
  $('satR').oninput = () => { tstate.saturation = +$('satR').value; applyThemeLocal(); };
  $('satR').onchange = () => saveTheme({ saturation: +$('satR').value });
  $('gradA').oninput = () => { tstate.gradA = $('gradA').value; applyThemeLocal(); };
  $('gradA').onchange = () => saveTheme({ gradA: $('gradA').value });
  $('gradB').oninput = () => { tstate.gradB = $('gradB').value; applyThemeLocal(); };
  $('gradB').onchange = () => saveTheme({ gradB: $('gradB').value });
  $('gradR').oninput = () => { tstate.grad = +$('gradR').value; applyThemeLocal(); };
  $('gradR').onchange = () => saveTheme({ grad: +$('gradR').value });
  $('panelColor').oninput = () => { tstate.panelColor = $('panelColor').value; applyThemeLocal(); };
  $('panelColor').onchange = () => saveTheme({ panelColor: $('panelColor').value });
  $('panelReset').onclick = () => saveTheme({ panelColor: '' });
  $('panelR').oninput = () => { tstate.panelOpacity = +$('panelR').value; applyThemeLocal(); };
  $('panelR').onchange = () => saveTheme({ panelOpacity: +$('panelR').value });
  $('radiusR').oninput = () => { tstate.radius = +$('radiusR').value; applyThemeLocal(); };
  $('radiusR').onchange = () => saveTheme({ radius: +$('radiusR').value });
  $('densComfy').onclick = () => saveTheme({ density: 'comfy' });
  $('densCompact').onclick = () => saveTheme({ density: 'compact' });
  $('modeAuto').onclick = () => saveTheme({ mode: 'auto' });
  $('modeLight').onclick = () => saveTheme({ mode: 'light' });
  $('modeDark').onclick = () => saveTheme({ mode: 'dark' });
  $('themeReset').onclick = () => saveTheme({ accent: '#6b93ff', radius: 12, density: 'comfy', mode: 'auto', bgType: 'theme', bgColor: '#0e1015', bgImage: '', glass: false, blur: 16, saturation: 140, grad: 55, gradA: '#8b5cf6', gradB: '#2b6cff', panelColor: '', panelOpacity: 62 });
  applyThemeLocal();
})();

load();
setInterval(load, 6000);
window.addEventListener('resize', () => { if (state.snap) drawGraph(state.snap.issues || [], state.snap.regions || {}); });
</script>
</body>
</html>`;
}

const CSS = `
*{box-sizing:border-box}
:root{
  --bg:#f4f5f8;--panel:#eceef3;--card:#fff;--card-2:#f7f8fb;--line:#e3e6ec;--line-soft:#eef0f4;
  --text:#171a21;--muted:#6b7280;
  --accent:#4f6ef7;--accent-weak:#eaeefe;--accent-line:rgba(79,110,247,.35);
  --done:#16a34a;--run:#d97706;--fail:#dc2626;
  --radius:12px;
  --shadow:0 1px 2px rgba(16,24,40,.06),0 2px 8px rgba(16,24,40,.05);
  --shadow-lg:0 6px 22px rgba(16,24,40,.10);
  --glow:0 0 0 1px var(--accent-line);
}
html[data-theme=dark]{
  --bg:#0a0b11;--panel:#14111c;--card:#11131b;--card-2:#191c26;
  --line:rgba(255,255,255,.07);--line-soft:rgba(255,255,255,.04);
  --text:#e9eaf2;--muted:#8b8fa3;
  --accent:#6b93ff;--accent-weak:rgba(107,147,255,.14);--accent-line:rgba(107,147,255,.42);
  --done:#3ddc97;--run:#ffb64d;--fail:#ff6b6b;
  --shadow:0 1px 2px rgba(0,0,0,.40),0 4px 14px rgba(0,0,0,.26);
  --shadow-lg:0 14px 40px rgba(0,0,0,.46);
}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);
  font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased}
html[data-theme=dark] body{
  background:
    radial-gradient(1100px 520px at 88% -10%, rgba(107,147,255,.10), transparent 60%),
    radial-gradient(760px 460px at 0% 106%, rgba(150,90,220,.09), transparent 62%),
    var(--bg);
}
.app{display:flex;flex-direction:row;height:100vh;overflow:hidden;gap:0}
/* —— 左侧图标窄栏 —— */
.rail{flex:none;width:66px;display:flex;flex-direction:column;align-items:center;gap:6px;padding:14px 0;
  background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,0));
  border-right:.5px solid var(--line-soft)}
.rail .brand{width:36px;height:36px;border-radius:12px;display:flex;align-items:center;justify-content:center;margin-bottom:12px;
  background:linear-gradient(150deg,var(--accent),color-mix(in srgb,var(--accent) 50%,#12081f));box-shadow:0 6px 20px var(--accent-line)}
.rail .brand .bico{width:14px;height:14px;border-radius:4px;background:#fff;box-shadow:0 0 0 3px rgba(255,255,255,.22)}
.railnav,.railbot{display:flex;flex-direction:column;gap:6px;align-items:center}
.railbot{margin-top:auto}
.rbtn{width:42px;height:42px;border:0;border-radius:13px;background:transparent;color:var(--muted);font-size:17px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;transition:.15s;position:relative}
.rbtn i{font-style:normal;line-height:1}
.rbtn:hover{background:var(--card-2);color:var(--text)}
.rbtn.on,.rbtn:active{background:var(--accent-weak);color:var(--accent)}
.rbtn.on::before{content:"";position:absolute;left:-14px;top:50%;transform:translateY(-50%);width:3px;height:20px;border-radius:3px;background:var(--accent)}
.main{flex:1;min-width:0;display:flex;flex-direction:column;height:100vh;overflow:hidden}
.top{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 20px 8px}
.ttl{display:flex;align-items:center;gap:9px;min-width:0}
.ttlwrap{display:flex;flex-direction:column;line-height:1.15;min-width:0}
.ttl .sub2{font-size:10.5px;color:var(--muted);font-weight:500;letter-spacing:.02em}
.ttl .dot{width:9px;height:9px;border-radius:50%;background:var(--accent);flex:none;
  box-shadow:0 0 0 4px var(--accent-weak)}
.ttl h1{margin:0;font-size:14.5px;font-weight:700;letter-spacing:.01em}
.pill{font-size:11px;color:var(--muted);background:var(--card-2);border:.5px solid var(--line);border-radius:999px;padding:1px 9px;font-variant-numeric:tabular-nums}
.pill.sm{padding:0 7px;font-size:10px}
.bar{display:flex;gap:8px}
.src{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 14px;margin:2px 20px 4px;border:.5px solid var(--line-soft);border-radius:13px;background:var(--card-2)}
.src[hidden]{display:none}
.src .lbl{font-size:11px;color:var(--muted)}
.src .val{font-size:11.5px;color:var(--muted);max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.src .val.ok{color:var(--done)}
.src .sep{width:1px;height:16px;background:var(--line);margin:0 2px}
.input{font:inherit;font-size:11.5px;padding:6px 11px;border:.5px solid var(--line);border-radius:10px;background:var(--card);color:var(--text);min-width:110px;outline:none;transition:.14s}
.input:focus{border-color:var(--accent);box-shadow:var(--glow)}
.btn{font:inherit;font-size:11.5px;padding:6px 14px;border:.5px solid var(--line);border-radius:10px;background:var(--card);color:var(--text);cursor:pointer;transition:.14s}
.btn:hover:enabled{border-color:var(--accent);color:var(--accent);background:var(--accent-weak)}
.btn:active:enabled{transform:none}
.btn:disabled{opacity:.42;cursor:default}
.btn.primary{background:linear-gradient(180deg,var(--accent),color-mix(in srgb,var(--accent) 82%,#000));border-color:transparent;color:#fff;box-shadow:0 6px 18px var(--accent-line)}
.btn.primary:hover:enabled{color:#fff;filter:brightness(1.07);background:linear-gradient(180deg,var(--accent),color-mix(in srgb,var(--accent) 82%,#000))}
.btn.ghost{background:transparent}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.chip{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:11.5px;padding:4px 11px;border:.5px solid var(--line);border-radius:999px;background:var(--card-2);color:var(--text);cursor:pointer;transition:.14s;max-width:100%}
.chip:hover{border-color:var(--accent);transform:translateY(-.5px)}
.chip.on{border-color:var(--accent);color:var(--accent);background:var(--accent-weak)}
.chip.sel{background:var(--accent-weak);border-color:var(--accent);color:var(--accent)}
.chip .n{font-size:10.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.chip .rdot{width:6px;height:6px;border-radius:50%;background:var(--run);animation:pulse 1.4s infinite;box-shadow:0 0 0 3px color-mix(in srgb,var(--run) 25%,transparent)}
.chip .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
.chip.sm{font-size:10.5px;padding:2px 8px;cursor:default}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.grid{display:grid;grid-template-columns:minmax(230px,296px) minmax(0,1fr);gap:14px;flex:1;min-height:0;margin:6px 20px 18px;background:transparent;overflow:hidden}
.col{display:flex;flex-direction:column;min-height:0;padding:4px 0;gap:12px}
.col.left{min-width:0}
.col.right{min-width:0}
.secttl{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--muted);text-transform:uppercase}
.secttl .acts{margin-left:auto;display:flex;gap:6px;text-transform:none}
.legend{margin-left:auto;display:flex;gap:10px;font-size:10px;font-weight:400;color:var(--muted);text-transform:none}
.legend i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:3px;vertical-align:middle}
.legend i.d{background:var(--done);box-shadow:0 0 6px color-mix(in srgb,var(--done) 60%,transparent)}
.legend i.r{background:var(--run);box-shadow:0 0 6px color-mix(in srgb,var(--run) 60%,transparent)}
.legend i.f{background:var(--fail);box-shadow:0 0 6px color-mix(in srgb,var(--fail) 60%,transparent)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.list{display:flex;flex-direction:column;gap:7px;overflow:auto;min-height:0;flex:1;padding-right:3px}
/* —— 区域折叠树 —— */
.tree{display:flex;flex-direction:column;gap:3px;overflow:auto;min-height:0;flex:1;padding-right:3px}
.tgroup-head{display:flex;align-items:center;gap:9px;padding:9px 11px;border-radius:12px;cursor:pointer;user-select:none;transition:.14s;border:0}
.tgroup-head:hover{background:var(--card-2)}
.tgroup-head.open{background:var(--card-2)}
.tgroup-head .caret{width:12px;font-size:10px;color:var(--muted);flex:none;text-align:center;transition:transform .14s}
.tgroup-head.open .caret{color:var(--accent)}
.tgroup-head .tname{font-size:12.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.tgroup-head .tcount{font-size:10.5px;font-weight:700;color:var(--muted);background:var(--card);border:.5px solid var(--line);border-radius:999px;padding:0 8px;flex:none;font-variant-numeric:tabular-nums}
.tgroup-head.running .tname{color:var(--run)}
.tgroup-head .rdot{width:6px;height:6px;border-radius:50%;background:var(--run);flex:none;animation:pulse 1.4s infinite;box-shadow:0 0 0 3px color-mix(in srgb,var(--run) 22%,transparent)}
.tgroup-kids{display:flex;flex-direction:column;gap:2px;padding:2px 0 6px 6px}
.issrow{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:13px;cursor:pointer;position:relative;transition:.13s;border:0}
.issrow:hover{background:var(--card-2)}
.issrow.sel{background:var(--accent-weak)}
.issrow.sel::after{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:3px;background:var(--accent)}
.iav{flex:none;width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:750;color:var(--muted);background:var(--card-2);border:.5px solid var(--line-soft);font-variant-numeric:tabular-nums}
.issrow[data-st=done] .iav{color:var(--done);border-color:color-mix(in srgb,var(--done) 35%,transparent);background:color-mix(in srgb,var(--done) 12%,transparent)}
.issrow[data-st=run] .iav{color:var(--run);border-color:color-mix(in srgb,var(--run) 35%,transparent);background:color-mix(in srgb,var(--run) 12%,transparent)}
.issrow[data-st=fail] .iav{color:var(--fail);border-color:color-mix(in srgb,var(--fail) 35%,transparent);background:color-mix(in srgb,var(--fail) 12%,transparent)}
.imid{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.ittl{font-size:12.5px;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.isub{display:flex;gap:6px;align-items:center;font-size:10.5px;color:var(--muted);overflow:hidden;white-space:nowrap}
.ist{font-weight:600}
.issrow[data-st=done] .ist{color:var(--done)}
.issrow[data-st=run] .ist{color:var(--run)}
.issrow[data-st=fail] .ist{color:var(--fail)}
.ireg{opacity:.75}
.issrow[data-st=done]::before{background:var(--done);box-shadow:0 0 6px color-mix(in srgb,var(--done) 55%,transparent)}
.issrow[data-st=run]::before{background:var(--run);animation:pulse 1.4s infinite;box-shadow:0 0 6px color-mix(in srgb,var(--run) 55%,transparent)}
.issrow[data-st=fail]::before{background:var(--fail);box-shadow:0 0 6px color-mix(in srgb,var(--fail) 55%,transparent)}
.issrow .id{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;flex:none}
.issrow .ttl{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.issrow .tag{margin-left:auto}
.empty.sm{font-size:11px;padding:5px 9px}
.card{border:.5px solid var(--line);border-radius:var(--radius);background:var(--card);padding:10px 12px 10px 14px;cursor:pointer;position:relative;transition:.16s;box-shadow:var(--shadow)}
.card:hover{border-color:var(--accent);transform:translateY(-1px);box-shadow:var(--shadow-lg)}
.card.sel{border-color:var(--accent);background:var(--accent-weak);box-shadow:var(--shadow-lg)}
.card::before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:3px;border-radius:3px;background:var(--line)}
.card[data-st=done]::before{background:var(--done)}
.card[data-st=run]::before{background:var(--run);animation:pulse 1.4s infinite}
.card[data-st=fail]::before{background:var(--fail)}
.card .row1{display:flex;gap:7px;align-items:baseline}
.card .id{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;flex:none}
.card .title{font-size:12.5px;font-weight:550;line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.card .row2{display:flex;gap:6px;align-items:center;margin-top:5px;flex-wrap:wrap}
.tag{font-size:10px;font-weight:700;padding:1px 7px;border-radius:6px;border:.5px solid currentColor;letter-spacing:.02em}
.tag.done{color:var(--done);background:color-mix(in srgb,var(--done) 12%,transparent)}
.tag.run{color:var(--run);background:color-mix(in srgb,var(--run) 12%,transparent)}
.tag.fail{color:var(--fail);background:color-mix(in srgb,var(--fail) 12%,transparent)}
.sub{font-size:10.5px;color:var(--muted)}
.empty{font-size:12px;color:var(--muted);padding:12px 2px}
.graph{flex:none;border:.5px solid var(--line-soft);border-radius:14px;background:var(--card-2);overflow:hidden}
.graph svg{display:block}
.edge{fill:none;stroke:var(--line);stroke-width:1.4}
.node{stroke:var(--line);stroke-width:1;fill:var(--card);transition:.14s}
.node.root{fill:var(--accent-weak);stroke:var(--accent);stroke-width:1.6}
.node.reg{fill:var(--card);stroke:var(--line);stroke-width:1.6}
.node.reg.run{stroke:var(--run);stroke-width:2.6;animation:pulse 1.4s infinite;filter:drop-shadow(0 0 5px color-mix(in srgb,var(--run) 55%,transparent))}
.node.iss.done{fill:var(--done);stroke:var(--done)}
.node.iss.run{fill:var(--run);stroke:var(--run);filter:drop-shadow(0 0 5px color-mix(in srgb,var(--run) 60%,transparent))}
.node.iss.fail{fill:var(--fail);stroke:var(--fail)}
.nlabel{font-size:10.5px;font-weight:650;fill:var(--text)}
.nsub{font-size:9.5px;fill:var(--muted)}
.report{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px}
.report.empty{align-items:center;justify-content:center;color:var(--muted);font-size:12px}
.report .meta{display:flex;gap:6px;flex-wrap:wrap}
.report .body{font-size:12.5px;line-height:1.82;white-space:pre-wrap;word-break:break-word;color:var(--text);
  background:var(--card-2);border:.5px solid var(--line-soft);border-radius:14px;padding:14px 16px}
.report .prlink{font-size:11.5px;color:var(--accent);word-break:break-all;text-decoration:none}
.report .prlink:hover{text-decoration:underline}
.report .files{display:flex;flex-wrap:wrap;gap:5px}
.report .files code{font-size:10.5px;padding:2px 7px;border-radius:6px;background:var(--card);border:.5px solid var(--line);color:var(--muted)}
.toast{position:fixed;left:50%;bottom:18px;transform:translate(-50%,16px);opacity:0;pointer-events:none;background:#1f2328;color:#fff;font-size:12px;padding:8px 16px;border-radius:10px;transition:.2s;max-width:80vw;box-shadow:var(--shadow-lg)}
html[data-theme=dark] .toast{background:#e8eaf1;color:#0e1015}
.toast.show{opacity:1;transform:translate(-50%,0)}
.toast.bad{background:var(--fail);color:#fff}
/* —— 配色面板 —— */
.theme-bar{display:flex;flex-direction:column;gap:8px;margin:0 16px 4px;padding:12px 14px;border:.5px solid var(--line);border-radius:12px;background:var(--card-2);box-shadow:var(--shadow)}
.theme-bar[hidden]{display:none}
.trow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.trow .lbl{font-size:11px;color:var(--muted);min-width:34px}
.presets{display:flex;gap:7px;flex-wrap:wrap}
.swatch{width:24px;height:24px;border-radius:8px;border:2px solid transparent;cursor:pointer;padding:0;box-shadow:var(--shadow);transition:.14s;position:relative}
.swatch:hover{transform:translateY(-1px)}
.swatch.on{border-color:var(--text);box-shadow:0 0 0 2px var(--bg),0 0 0 3px var(--accent)}
.color{width:34px;height:28px;padding:0;border:.5px solid var(--line);border-radius:8px;background:var(--card);cursor:pointer}
.hexin{width:96px;min-width:0;font-family:ui-monospace,Menlo,Consolas,monospace;letter-spacing:.03em}
.range{width:120px;accent-color:var(--accent)}
.btn.on{border-color:var(--accent);color:var(--accent);background:var(--accent-weak)}
.btn.icon{padding:3px 9px;font-size:13px;line-height:1}
/* —— 监控面板（工作室流程状态） —— */
.mon{display:grid;grid-template-columns:repeat(6,1fr);gap:9px;margin:0 0 10px;flex:none}
.mcard{display:flex;flex-direction:column;gap:1px;padding:9px 12px;border:.5px solid var(--line-soft);border-radius:13px;background:var(--card-2)}
.mcard b{font-size:17px;font-weight:750;line-height:1.1;font-variant-numeric:tabular-nums}
.mcard span{font-size:10px;color:var(--muted);letter-spacing:.02em}
/* —— 侧栏收起 —— */
.app.side-collapsed .col.left{display:none}
.app.side-collapsed .grid{grid-template-columns:minmax(0,1fr)}
/* —— 悬浮外观卡片 —— */
.tcard{position:fixed;right:22px;top:64px;width:340px;max-height:calc(100vh - 90px);overflow:auto;z-index:50;
  border:.5px solid var(--line);border-radius:16px;background:var(--card);box-shadow:0 18px 50px rgba(0,0,0,.38);}
.tcard[hidden]{display:none}
.tcard-hd{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:.5px solid var(--line);position:sticky;top:0;background:var(--card);z-index:1;cursor:move}
.tcard-ttl{font-size:12.5px;font-weight:700}
.tcard-bd{display:flex;flex-direction:column;gap:9px;padding:12px 14px}
.tcard .trow{gap:7px}
.tcard .lbl{min-width:38px}
.growin{flex:1;min-width:0}
.hint{font-size:10px;color:var(--muted)}
@media(max-width:620px){.rail{width:52px}.grid{grid-template-columns:1fr;margin:6px 12px 12px}.col.left{border-right:0;border-bottom:.5px solid var(--line-soft);padding-right:0;padding-bottom:12px}.col.right{padding-left:0}.src{margin:2px 12px 4px}.top{padding:12px 12px 8px}.mon{grid-template-columns:repeat(3,1fr);margin:2px 12px 6px}.tcard{right:10px;left:10px;width:auto}}
`;

// ---------------------------------------------------------------------------
// 自检：渲染出的页面必须带上关键控件，且注入的字段不丢失。
if (process.argv[1] && process.argv[1].endsWith('studio-web.js')) {
  const assert = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } };
  const html = renderStudioHtml({ sid: 's', dir: 'd', glass: true, bgType: 'image', bgImage: 'https://x/y.png', blur: 20, presets: {} });
  assert(html.includes('<div id="tcard"'), 'floating card present');
  assert(html.includes('id="rTheme"') && html.includes('id="rRegion"'), 'icon rail present');
  assert(html.includes('id="mRun"') && html.includes('id="mSrc"'), 'monitor cards present');
  assert(html.includes('class="glass-on"'), 'glass class on body');
  assert(html.includes('id="bgImageRow"'), 'bg image row present');
  assert(html.includes('"blur":20') && html.includes('"bgType":"image"'), 'theme fields serialized');
  // themeCss 里 body/.col.right 带 !important，内联必须同样重要才能即时预览（否则改面板无反应）
  assert(html.includes("setProperty('background', layers.join(','), 'important')"), 'inline bg important');
  assert(html.includes("'important');"), 'inline panel important');
  const plain = renderStudioHtml({ presets: {} });
  assert(!plain.includes('class="glass-on"'), 'no glass by default');
  console.log('studio-web: demo OK');
}