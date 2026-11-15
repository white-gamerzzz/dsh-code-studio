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

/** 完整页面 HTML。`sid` 由客户端用 ?sid= 传进来（当前会话），`theme` 为 'light'|'dark'。 */
export function renderStudioHtml(opts = {}) {
  const sid = typeof opts.sid === 'string' ? opts.sid : '';
  const dir = typeof opts.dir === 'string' ? opts.dir : '';
  const theme = opts.theme === 'dark' ? 'dark' : opts.theme === 'light' ? 'light' : 'auto';
  return `<!doctype html>
<html lang="zh-CN" data-theme="${theme}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>工作室</title>
<style>${CSS}</style>
</head>
<body>
<div id="app" class="app">
  <header class="top">
    <div class="ttl"><span class="dot"></span><h1>工作室</h1><span id="count" class="pill">—</span></div>
    <div class="bar">
      <button id="refresh" class="btn ghost" title="立即刷新">刷新</button>
    </div>
  </header>
  <section class="src">
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
      <div id="regions" class="chips"></div>
      <div class="secttl" id="issTtl">Issues</div>
      <div id="issues" class="list"></div>
    </aside>
    <section class="col right">
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
  <div id="toast" class="toast"></div>
</div>
<script>
const SID = ${JSON.stringify(sid)};
const DIR = ${JSON.stringify(dir)};
const $ = (id) => document.getElementById(id);
const state = { snap: null, sel: undefined, region: '' };

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

  const names = Object.keys(regions);
  $('regCount').textContent = names.length;
  const rc = $('regions'); rc.innerHTML = '';
  const all = el('button', 'chip' + (state.region === '' ? ' sel' : ''));
  all.appendChild(el('span', 'nm', '全部')); all.appendChild(el('b', 'n', String(issues.length)));
  all.onclick = () => { state.region = ''; state.sel = issues[0] && String(issues[0].id); render(); };
  rc.appendChild(all);
  for (const name of names) {
    const r = regions[name] || {}; const ris = issues.filter((i) => String(i.region || '') === name);
    const running = ris.some((i) => i.status === 'RUNNING');
    const b = el('button', 'chip' + (state.region === name ? ' sel' : ''));
    if (running) b.appendChild(el('span', 'rdot'));
    b.appendChild(el('span', 'nm', name || '—')); b.appendChild(el('b', 'n', String(ris.length)));
    b.onclick = () => { state.region = state.region === name ? '' : name;
      const pool = state.region ? issues.filter((i) => String(i.region || '') === state.region) : issues;
      state.sel = pool[0] && String(pool[0].id); render(); };
    rc.appendChild(b);
  }

  const shown = state.region ? issues.filter((i) => String(i.region || '') === state.region) : issues;
  $('issTtl').textContent = state.region ? ('Issues · ' + state.region) : 'Issues';
  const list = $('issues'); list.innerHTML = '';
  if (!shown.length) list.appendChild(el('div', 'empty', state.region ? '这个区域还没有 issue' : '还没有 issue'));
  for (const it of shown) {
    const id = String(it.id); const tg = tagOf(it.status);
    const card = el('div', 'card' + (id === state.sel ? ' sel' : '')); card.dataset.st = tg;
    const h = el('div', 'row1'); h.appendChild(el('span', 'id', '#' + id));
    h.appendChild(el('span', 'title', it.title || it.body || '(untitled)'));
    card.appendChild(h);
    const m = el('div', 'row2');
    if (it.status) m.appendChild(el('span', 'tag ' + tg, it.status));
    if (!state.region && it.region) m.appendChild(el('span', 'sub', '@' + it.region));
    if (it.changedFiles && it.changedFiles.length) m.appendChild(el('span', 'sub', it.changedFiles.length + ' 文件'));
    card.appendChild(m);
    card.onclick = () => { state.sel = id; render(); };
    list.appendChild(card);
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
  const W = Math.max(box.clientWidth || 520, 320), H = 190;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('width', '100%'); svg.setAttribute('height', H);
  const names = Object.keys(regions);
  const rootX = 34, regX = Math.min(150, W * 0.32), issX = Math.max(regX + 120, W - 120);
  const rootY = H / 2;
  const add = (tag, attrs) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) n.setAttribute(k, attrs[k]); svg.appendChild(n); return n; };
  const line = (x1, y1, x2, y2) => add('path', { d: 'M' + x1 + ' ' + y1 + ' C' + ((x1 + x2) / 2) + ' ' + y1 + ' ' + ((x1 + x2) / 2) + ' ' + y2 + ' ' + x2 + ' ' + y2, class: 'edge' });
  const node = (cx, cy, r, cls, label, sub) => {
    add('circle', { cx, cy, r, class: 'node ' + cls });
    if (label) add('text', { x: cx + r + 6, y: cy + 1, class: 'nlabel' }).textContent = label;
    if (sub) add('text', { x: cx + r + 6, y: cy + 13, class: 'nsub' }).textContent = sub;
  };
  if (!names.length) { add('text', { x: 12, y: H / 2, class: 'nsub' }).textContent = '还没有区域，派单后自动建'; box.appendChild(svg); return; }
  const band = H / names.length;
  node(rootX, rootY, 9, 'root', 'workspace', issues.length + ' issue');
  names.forEach((name, i) => {
    const ris = issues.filter((x) => String(x.region || '') === name);
    const ry = band * i + band / 2;
    line(rootX + 9, rootY, regX - 8, ry);
    const running = ris.some((x) => x.status === 'RUNNING');
    node(regX, ry, 7, 'reg' + (running ? ' run' : ''), name || '—', ris.length + '');
    const span = Math.min(band * 0.8, ris.length * 22);
    ris.forEach((it, k) => {
      const iy = ris.length === 1 ? ry : ry - span / 2 + (span / (ris.length - 1)) * k;
      line(regX + 7, ry, issX - 5, iy);
      node(issX, iy, 4, 'iss ' + tagOf(it.status), '#' + it.id, '');
    });
  });
  box.appendChild(svg);
}

async function act(op, extra) {
  try { const r = await api(${JSON.stringify(API_ACTION)}, Object.assign({ op }, extra || {})); if (r && r.text) toast(r.text, r.ok === false); await load(); }
  catch (e) { toast(e.message, true); }
}
$('refresh').onclick = () => act('scan');
$('watch').onclick = () => act(state.snap && state.snap.watch && state.snap.watch.enabled ? 'watchOff' : 'watchOn');
$('ghBind').onclick = () => { const v = $('ghInput').value.trim(); if (!v) return toast('填 owner/repo', true); act('github', { repo: v }); };
$('ghOff').onclick = () => act('githubOff');
$('patSave').onclick = () => { const v = $('patInput').value.trim(); if (!v) return toast('粘贴 PAT', true); $('patInput').value = ''; act('token', { token: v }); };
$('patClear').onclick = () => act('tokenOff');
$('pr').onclick = () => { if (state.sel) act('pr', { id: state.sel }); };
$('cancel').onclick = () => { if (state.sel) act('cancel', { id: state.sel }); };

load();
setInterval(load, 6000);
window.addEventListener('resize', () => { if (state.snap) drawGraph(state.snap.issues || [], state.snap.regions || {}); });
document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'auto'
  ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : document.documentElement.dataset.theme;
</script>
</body>
</html>`;
}

const CSS = `
*{box-sizing:border-box}
:root{
  --bg:#fff;--panel:#f7f8fa;--card:#fff;--line:#e6e8ec;--text:#1f2328;--muted:#6b7280;
  --accent:#4f46e5;--accent-weak:#eef0ff;--done:#16a34a;--run:#d97706;--fail:#dc2626;
  --radius:10px;
}
html[data-theme=dark]{
  --bg:#15171c;--panel:#1b1e25;--card:#1f232b;--line:#2b303a;--text:#e6e8eb;--muted:#98a0ab;
  --accent:#8b93f8;--accent-weak:#252a45;--done:#34d399;--run:#fbbf24;--fail:#f87171;
}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);
  font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.app{display:flex;flex-direction:column;height:100vh;overflow:hidden}
.top{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px 8px}
.ttl{display:flex;align-items:center;gap:8px;min-width:0}
.ttl .dot{width:9px;height:9px;border-radius:50%;background:var(--accent);flex:none}
.ttl h1{margin:0;font-size:14px;font-weight:650;letter-spacing:.01em}
.pill{font-size:11px;color:var(--muted);background:var(--panel);border:.5px solid var(--line);border-radius:999px;padding:1px 9px}
.pill.sm{padding:0 7px;font-size:10px}
.bar{display:flex;gap:8px}
.src{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 16px 12px;border-bottom:1px solid var(--line)}
.src .lbl{font-size:11px;color:var(--muted)}
.src .val{font-size:11.5px;color:var(--muted);max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.src .val.ok{color:var(--done)}
.src .sep{width:1px;height:16px;background:var(--line);margin:0 2px}
.input{font:inherit;font-size:11.5px;padding:4px 9px;border:.5px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);min-width:110px;outline:none}
.input:focus{border-color:var(--accent)}
.btn{font:inherit;font-size:11.5px;padding:4px 12px;border:.5px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);cursor:pointer;transition:.12s}
.btn:hover:enabled{border-color:var(--accent);color:var(--accent)}
.btn:disabled{opacity:.45;cursor:default}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.ghost{background:transparent}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.chip{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:11.5px;padding:3px 10px;border:.5px solid var(--line);border-radius:999px;background:var(--card);color:var(--text);cursor:pointer;transition:.12s;max-width:100%}
.chip:hover{border-color:var(--accent)}
.chip.on{border-color:var(--accent);color:var(--accent)}
.chip.sel{background:var(--accent-weak);border-color:var(--accent);color:var(--accent)}
.chip .n{font-size:10.5px;color:var(--muted);font-variant-numeric:tabular-nums}
.chip .rdot{width:6px;height:6px;border-radius:50%;background:var(--run);animation:pulse 1.4s infinite}
.chip .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
.chip.sm{font-size:10.5px;padding:2px 8px;cursor:default}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.grid{display:grid;grid-template-columns:minmax(230px,300px) minmax(0,1fr);gap:0;flex:1;min-height:0}
.col{display:flex;flex-direction:column;min-height:0;padding:12px 16px;gap:8px}
.col.left{border-right:1px solid var(--line)}
.secttl{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;letter-spacing:.03em;color:var(--muted);text-transform:uppercase}
.secttl .acts{margin-left:auto;display:flex;gap:6px;text-transform:none}
.legend{margin-left:auto;display:flex;gap:10px;font-size:10px;font-weight:400;color:var(--muted);text-transform:none}
.legend i{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:3px;vertical-align:middle}
.legend i.d{background:var(--done)}.legend i.r{background:var(--run)}.legend i.f{background:var(--fail)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.list{display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0;flex:1;padding-right:2px}
.card{border:.5px solid var(--line);border-radius:var(--radius);background:var(--card);padding:8px 11px 8px 13px;cursor:pointer;position:relative;transition:.12s}
.card:hover{border-color:var(--accent)}
.card.sel{border-color:var(--accent);background:var(--accent-weak)}
.card::before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:3px;background:var(--line)}
.card[data-st=done]::before{background:var(--done)}.card[data-st=run]::before{background:var(--run)}.card[data-st=fail]::before{background:var(--fail)}
.card .row1{display:flex;gap:7px;align-items:baseline}
.card .id{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;flex:none}
.card .title{font-size:12.5px;font-weight:500;line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.card .row2{display:flex;gap:6px;align-items:center;margin-top:4px;flex-wrap:wrap}
.tag{font-size:10px;font-weight:600;padding:0 6px;border-radius:5px;border:.5px solid currentColor}
.tag.done{color:var(--done)}.tag.run{color:var(--run)}.tag.fail{color:var(--fail)}
.sub{font-size:10.5px;color:var(--muted)}
.empty{font-size:12px;color:var(--muted);padding:10px 2px}
.graph{flex:none;border:.5px solid var(--line);border-radius:var(--radius);background:var(--panel);overflow:hidden}
.graph svg{display:block}
.edge{fill:none;stroke:var(--line);stroke-width:1.3}
.node{stroke:var(--line);stroke-width:1;fill:var(--card)}
.node.root{fill:var(--accent-weak);stroke:var(--accent)}
.node.reg{fill:var(--card);stroke:var(--line);stroke-width:1.5}
.node.reg.run{stroke:var(--run);stroke-width:2.5;animation:pulse 1.4s infinite}
.node.iss.done{fill:var(--done);stroke:var(--done)}
.node.iss.run{fill:var(--run);stroke:var(--run)}
.node.iss.fail{fill:var(--fail);stroke:var(--fail)}
.nlabel{font-size:10.5px;font-weight:600;fill:var(--text)}
.nsub{font-size:9.5px;fill:var(--muted)}
.report{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px}
.report.empty{align-items:center;justify-content:center;color:var(--muted);font-size:12px}
.report .meta{display:flex;gap:6px;flex-wrap:wrap}
.report .body{font-size:12.5px;line-height:1.75;white-space:pre-wrap;word-break:break-word;color:var(--text)}
.report .prlink{font-size:11.5px;color:var(--accent);word-break:break-all;text-decoration:none}
.report .prlink:hover{text-decoration:underline}
.report .files{display:flex;flex-wrap:wrap;gap:4px}
.report .files code{font-size:10.5px;padding:1px 6px;border-radius:5px;background:var(--panel);border:.5px solid var(--line);color:var(--muted)}
.toast{position:fixed;left:50%;bottom:16px;transform:translate(-50%,16px);opacity:0;pointer-events:none;background:#1f2328;color:#fff;font-size:12px;padding:7px 14px;border-radius:9px;transition:.2s;max-width:80vw}
html[data-theme=dark] .toast{background:#e6e8eb;color:#15171c}
.toast.show{opacity:1;transform:translate(-50%,0)}
.toast.bad{background:var(--fail)}
@media(max-width:620px){.grid{grid-template-columns:1fr}.col.left{border-right:0;border-bottom:1px solid var(--line)}}
`;
