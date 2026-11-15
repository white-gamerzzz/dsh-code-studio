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
    <div class="ttl">
      <span class="dot"></span>
      <div class="ttlwrap">
        <h1>工作室</h1>
        <span class="sub2">代码总编 · 按区域派单</span>
      </div>
      <span id="count" class="pill">—</span>
    </div>
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
      <div id="tree" class="tree"></div>
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
      row.appendChild(el('span', 'id', '#' + id));
      row.appendChild(el('span', 'ttl', it.title || it.body || '(untitled)'));
      if (it.status) row.appendChild(el('span', 'tag ' + tg, it.status));
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
  --bg:#0e1015;--panel:#14171f;--card:#191d27;--card-2:#20242f;
  --line:rgba(255,255,255,.08);--line-soft:rgba(255,255,255,.045);
  --text:#e8eaf1;--muted:#8b93a7;
  --accent:#6b93ff;--accent-weak:rgba(107,147,255,.15);--accent-line:rgba(107,147,255,.45);
  --done:#3ddc97;--run:#ffb64d;--fail:#ff6b6b;
  --shadow:0 1px 2px rgba(0,0,0,.45),0 4px 14px rgba(0,0,0,.30);
  --shadow-lg:0 10px 30px rgba(0,0,0,.48);
}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);
  font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased}
html[data-theme=dark] body{
  background:
    radial-gradient(900px 420px at 82% -8%, rgba(107,147,255,.10), transparent 62%),
    radial-gradient(680px 380px at 6% 104%, rgba(61,220,151,.06), transparent 60%),
    var(--bg);
}
.app{display:flex;flex-direction:column;height:100vh;overflow:hidden}
.top{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 18px 10px}
.ttl{display:flex;align-items:center;gap:9px;min-width:0}
.ttlwrap{display:flex;flex-direction:column;line-height:1.15;min-width:0}
.ttl .sub2{font-size:10.5px;color:var(--muted);font-weight:500;letter-spacing:.02em}
.ttl .dot{width:9px;height:9px;border-radius:50%;background:var(--accent);flex:none;
  box-shadow:0 0 0 4px var(--accent-weak)}
.ttl h1{margin:0;font-size:14.5px;font-weight:700;letter-spacing:.01em}
.pill{font-size:11px;color:var(--muted);background:var(--card-2);border:.5px solid var(--line);border-radius:999px;padding:1px 9px;font-variant-numeric:tabular-nums}
.pill.sm{padding:0 7px;font-size:10px}
.bar{display:flex;gap:8px}
.src{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px;margin:0 16px 4px;border:.5px solid var(--line);border-radius:12px;background:var(--card-2);box-shadow:var(--shadow)}
.src .lbl{font-size:11px;color:var(--muted)}
.src .val{font-size:11.5px;color:var(--muted);max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.src .val.ok{color:var(--done)}
.src .sep{width:1px;height:16px;background:var(--line);margin:0 2px}
.input{font:inherit;font-size:11.5px;padding:5px 10px;border:.5px solid var(--line);border-radius:9px;background:var(--card);color:var(--text);min-width:110px;outline:none;transition:.14s}
.input:focus{border-color:var(--accent);box-shadow:var(--glow)}
.btn{font:inherit;font-size:11.5px;padding:5px 13px;border:.5px solid var(--line);border-radius:9px;background:var(--card);color:var(--text);cursor:pointer;transition:.14s;box-shadow:var(--shadow)}
.btn:hover:enabled{border-color:var(--accent);color:var(--accent);transform:translateY(-.5px)}
.btn:active:enabled{transform:none}
.btn:disabled{opacity:.45;cursor:default;box-shadow:none}
.btn.primary{background:linear-gradient(180deg,var(--accent),color-mix(in srgb,var(--accent) 82%,#000));border-color:transparent;color:#fff;box-shadow:0 4px 14px var(--accent-line)}
.btn.primary:hover:enabled{color:#fff;filter:brightness(1.06)}
.btn.ghost{background:transparent;box-shadow:none}
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
.grid{display:grid;grid-template-columns:minmax(240px,310px) minmax(0,1fr);gap:0;flex:1;min-height:0;margin:10px 16px 16px;border:.5px solid var(--line);border-radius:14px;background:var(--card);overflow:hidden;box-shadow:var(--shadow-lg)}
.col{display:flex;flex-direction:column;min-height:0;padding:14px 16px;gap:10px}
.col.left{border-right:1px solid var(--line);background:var(--panel)}
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
.tgroup-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;cursor:pointer;user-select:none;transition:.14s;border:.5px solid transparent}
.tgroup-head:hover{background:var(--card-2);border-color:var(--line)}
.tgroup-head.open{background:var(--card-2);border-color:var(--line)}
.tgroup-head .caret{width:12px;font-size:10px;color:var(--muted);flex:none;text-align:center;transition:transform .14s}
.tgroup-head.open .caret{color:var(--accent)}
.tgroup-head .tname{font-size:12.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.tgroup-head .tcount{font-size:10.5px;font-weight:700;color:var(--muted);background:var(--card);border:.5px solid var(--line);border-radius:999px;padding:0 7px;flex:none;font-variant-numeric:tabular-nums}
.tgroup-head.running .tname{color:var(--run)}
.tgroup-head .rdot{width:6px;height:6px;border-radius:50%;background:var(--run);flex:none;animation:pulse 1.4s infinite;box-shadow:0 0 0 3px color-mix(in srgb,var(--run) 22%,transparent)}
.tgroup-kids{display:flex;flex-direction:column;gap:3px;padding:3px 0 8px 18px;position:relative}
.tgroup-kids::before{content:"";position:absolute;left:9px;top:2px;bottom:8px;width:1px;background:var(--line)}
.issrow{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:9px;cursor:pointer;position:relative;transition:.14s;border:.5px solid transparent}
.issrow:hover{background:var(--card-2);border-color:var(--line)}
.issrow.sel{background:var(--accent-weak);border-color:var(--accent);box-shadow:var(--glow)}
.issrow::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--line);flex:none}
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
.graph{flex:none;border:.5px solid var(--line);border-radius:var(--radius);background:var(--card-2);overflow:hidden;box-shadow:var(--shadow)}
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
.report .body{font-size:12.5px;line-height:1.8;white-space:pre-wrap;word-break:break-word;color:var(--text);
  background:var(--card);border:.5px solid var(--line);border-radius:var(--radius);padding:12px 14px;box-shadow:var(--shadow)}
.report .prlink{font-size:11.5px;color:var(--accent);word-break:break-all;text-decoration:none}
.report .prlink:hover{text-decoration:underline}
.report .files{display:flex;flex-wrap:wrap;gap:5px}
.report .files code{font-size:10.5px;padding:2px 7px;border-radius:6px;background:var(--card);border:.5px solid var(--line);color:var(--muted)}
.toast{position:fixed;left:50%;bottom:18px;transform:translate(-50%,16px);opacity:0;pointer-events:none;background:#1f2328;color:#fff;font-size:12px;padding:8px 16px;border-radius:10px;transition:.2s;max-width:80vw;box-shadow:var(--shadow-lg)}
html[data-theme=dark] .toast{background:#e8eaf1;color:#0e1015}
.toast.show{opacity:1;transform:translate(-50%,0)}
.toast.bad{background:var(--fail);color:#fff}
@media(max-width:620px){.grid{grid-template-columns:1fr;margin:8px 10px 12px}.col.left{border-right:0;border-bottom:1px solid var(--line)}.src{margin:0 10px 4px}.top{padding:12px 12px 8px}}
`;
