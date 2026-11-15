import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Chip } from '@heroui/react/chip';
import { Card } from '@heroui/react/card';
import { Switch } from '@heroui/react/switch';
import { Slider } from '@heroui/react/slider';
import { Input } from '@heroui/react/input';
import { SearchField } from '@heroui/react/search-field';
import { Tooltip } from '@heroui/react/tooltip';

const SID = () => (window.__STUDIO__ && window.__STUDIO__.sid) || '';
const DIR = () => (window.__STUDIO__ && window.__STUDIO__.dir) || '';

async function api(path, body) {
  const q = 'sid=' + encodeURIComponent(SID()) + '&dir=' + encodeURIComponent(DIR());
  const r = await fetch(path + (path.includes('?') ? '&' : '?') + q, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : { method: 'GET' });
  let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
  if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
  return j;
}

const tagOf = (s) => (s === 'DONE' ? 'done'
  : (s === 'FAILED' || s === 'BLOCKED' || s === 'CANCELLED') ? 'fail'
  : (s === 'RUNNING' || s === 'READY') ? 'run' : '');

const hexToRgb = (h) => {
  const x = String(h || '').replace('#', '');
  const f = x.length === 3 ? x.split('').map((c) => c + c).join('') : x;
  const n = parseInt(f, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const THEME_FIELDS = ['accent', 'radius', 'density', 'mode', 'bgType', 'bgColor', 'bgImage',
  'glass', 'blur', 'saturation', 'grad', 'gradA', 'gradB', 'panelColor', 'panelOpacity'];

function applyTheme(t) {
  const root = document.documentElement;
  const rgb = hexToRgb(t.accent);
  root.style.setProperty('--accent', t.accent);
  root.style.setProperty('--accent-weak', 'rgba(' + rgb.join(',') + ',0.15)');
  root.style.setProperty('--accent-line', 'rgba(' + rgb.join(',') + ',0.45)');
  root.style.setProperty('--radius', t.radius + 'px');
  document.body.style.setProperty('font-size', t.density === 'compact' ? '12px' : '13px', 'important');
  const want = t.mode === 'auto'
    ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : t.mode;
  root.dataset.theme = want;
  root.classList.toggle('dark', want === 'dark');
  const k = t.grad / 100;
  const dark = want === 'dark';
  let base = 'var(--bg)';
  if (t.bgType === 'color') base = t.bgColor;
  else if (t.bgType === 'image' && t.bgImage) base = 'url("' + String(t.bgImage).replace(/"/g, '') + '") center/cover no-repeat fixed';
  const layers = [];
  if (dark && t.grad > 0) {
    const A = hexToRgb(t.gradA).join(','); const B = hexToRgb(t.gradB).join(',');
    layers.push('radial-gradient(500px 500px at 8% -6%,rgba(' + A + ',' + (0.75 * k).toFixed(3) + '),rgba(' + A + ',0) 70%)');
    layers.push('radial-gradient(400px 400px at 104% 22%,rgba(' + B + ',' + (0.55 * k).toFixed(3) + '),rgba(' + B + ',0) 70%)');
    layers.push('radial-gradient(600px 600px at 26% 108%,rgba(249,168,212,' + (0.4 * k).toFixed(3) + '),rgba(249,168,212,0) 70%)');
    if (t.bgType === 'theme') base = 'linear-gradient(135deg,#111827,#1f2937 52%,#111827)';
  }
  if (t.bgType === 'image' && t.bgImage) layers.push('linear-gradient(rgba(10,12,18,.62),rgba(10,12,18,.72))');
  layers.push(base);
  document.body.style.setProperty('background', layers.join(','), 'important');
  const pbg = t.panelColor
    ? 'rgba(' + hexToRgb(t.panelColor).join(',') + ',' + (t.panelOpacity / 100).toFixed(2) + ')'
    : 'color-mix(in srgb,var(--card) ' + t.panelOpacity + '%,transparent)';
  document.querySelectorAll('.grid').forEach((n) => n.style.setProperty('background', pbg, 'important'));
  document.body.classList.toggle('glass-on', !!t.glass);
  const pgf = 'blur(' + (t.glass ? t.blur : 24) + 'px) saturate(' + (t.glass ? t.saturation : 160) + '%)';
  document.querySelectorAll('.grid').forEach((n) => { n.style.backdropFilter = pgf; n.style.webkitBackdropFilter = pgf; });
  const gf = t.glass ? 'blur(' + t.blur + 'px) saturate(' + t.saturation + '%)' : '';
  document.querySelectorAll('.src,.tcard,.card,.report,.graph,.mcard').forEach((n) => { n.style.backdropFilter = gf; n.style.webkitBackdropFilter = gf; });
}

// ---- 工作状态图 ----
function Graph({ issues, regions }) {
  const boxRef = useRef(null);
  return (
    <div className="graph" ref={boxRef}>
      <GraphSvg boxRef={boxRef} issues={issues} regions={regions} />
    </div>
  );
}
function GraphSvg({ boxRef, issues, regions }) {
  const [W, setW] = useState(520);
  useEffect(() => {
    const read = () => { if (boxRef.current) setW(Math.max(boxRef.current.clientWidth || 520, 320)); };
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, [boxRef]);
  const H = 178;
  const names = Object.keys(regions);
  if (!names.length) return <svg viewBox={'0 0 ' + W + ' ' + H} width="100%" height={H}><text x="14" y={H / 2} className="nsub">还没有区域，派单后自动建</text></svg>;
  const rootX = 40, regX = Math.min(170, W * 0.34), issX = Math.max(regX + 130, W - 120);
  const rootY = H / 2, topPad = 20, band = H / names.length;
  const line = (x1, y1, x2, y2) => <path key={'l' + x1 + y1 + x2 + y2} d={'M' + x1 + ' ' + y1 + ' C' + ((x1 + x2) / 2) + ' ' + y1 + ' ' + ((x1 + x2) / 2) + ' ' + y2 + ' ' + x2 + ' ' + y2} className="edge" />;
  const nodes = [];
  const edges = [];
  const circles = [];
  const texts = [];
  circles.push(<circle key="root" cx={rootX} cy={rootY} r={12} className="node root" />);
  texts.push(<text key="roott" x={rootX} y={rootY - 19} className="nlabel" textAnchor="middle">workspace</text>);
  texts.push(<text key="roots" x={rootX} y={rootY + 25} className="nsub" textAnchor="middle">{issues.length + ' issue'}</text>);
  names.forEach((name, i) => {
    const ris = issues.filter((x) => String(x.region || '') === name);
    const ry = topPad + ((H - topPad * 2) / names.length) * (i + 0.5);
    edges.push(line(rootX + 12, rootY, regX - 9, ry));
    const running = ris.some((x) => x.status === 'RUNNING');
    circles.push(<circle key={'r' + name} cx={regX} cy={ry} r={9} className={'node reg' + (running ? ' run' : '')} />);
    texts.push(<text key={'rt' + name} x={regX} y={ry - 16} className="nlabel" textAnchor="middle">{name || '—'}</text>);
    texts.push(<text key={'rs' + name} x={regX} y={ry + 22} className="nsub" textAnchor="middle">{ris.length + ' 个 issue'}</text>);
    const span = Math.min(band * 0.82, Math.max(ris.length - 1, 1) * 26);
    ris.forEach((it, k) => {
      const iy = ris.length === 1 ? ry : ry - span / 2 + (span / (ris.length - 1)) * k;
      edges.push(line(regX + 9, ry, issX - 6, iy));
      circles.push(<circle key={'i' + it.id} cx={issX} cy={iy} r={5.5} className={'node iss ' + tagOf(it.status)} />);
      texts.push(<text key={'it' + it.id} x={issX - 12.5} y={iy + 3.5} className="nlabel" textAnchor="end">{'#' + it.id}</text>);
    });
  });
  return <svg viewBox={'0 0 ' + W + ' ' + H} width="100%" height={H}>{edges}{circles}{texts}</svg>;
}

const RAIL = [
  { id: 'rRegion', icon: '▤', title: '区域列表', nav: true },
  { id: 'rStatus', icon: '◔', title: '工作状态', nav: true },
  { id: 'rReport', icon: '▦', title: '报告', nav: true },
];
const RAIL_BOT = [
  { id: 'rSrc', icon: '⇄', title: '数据源' },
  { id: 'rTheme', icon: '⚙', title: '外观设置' },
  { id: 'rRefresh', icon: '⟳', title: '刷新' },
];

export default function App({ boot }) {
  const [snap, setSnap] = useState(null);
  const [sel, setSel] = useState(undefined);
  const [expanded, setExpanded] = useState({});
  const [q, setQ] = useState('');
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [srcOpen, setSrcOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState(null);
  const [theme, setTheme] = useState(() => {
    const b = (boot && boot.theme) || {};
    const out = {}; for (const k of THEME_FIELDS) out[k] = b[k];
    if (!out.accent) out.accent = '#6b93ff';
    if (out.radius == null) out.radius = 12;
    if (!out.density) out.density = 'comfy';
    if (!out.mode) out.mode = 'auto';
    if (!out.bgType) out.bgType = 'theme';
    if (!out.bgColor) out.bgColor = '#0e1015';
    if (out.bgImage == null) out.bgImage = '';
    if (out.glass == null) out.glass = false;
    if (out.blur == null) out.blur = 16;
    if (out.saturation == null) out.saturation = 140;
    if (out.grad == null) out.grad = 55;
    if (!out.gradA) out.gradA = '#8b5cf6';
    if (!out.gradB) out.gradB = '#2b6cff';
    if (out.panelColor == null) out.panelColor = '';
    if (out.panelOpacity == null) out.panelOpacity = 62;
    return out;
  });
  const presets = (boot && boot.presets) || {};
  const themeSet = useRef(false);

  const toast = useCallback((msg, bad) => {
    setToastMsg({ msg, bad });
    clearTimeout(toast._t);
    toast._t = setTimeout(() => setToastMsg(null), 2600);
  }, []);

  const load = useCallback(async () => {
    try { setSnap(await api('/code-studio/api/state')); }
    catch (e) { toast('读取失败：' + e.message, true); }
  }, [toast]);

  useEffect(() => {
    applyTheme(theme);
    if (!themeSet.current) { themeSet.current = true; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);
  useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, [load]);

  const act = useCallback(async (op, extra) => {
    try {
      const r = await api('/code-studio/api/action', Object.assign({ op }, extra || {}));
      if (r && r.text) toast(r.text, r.ok === false);
      await load();
      return r;
    } catch (e) { toast(e.message, true); return null; }
  }, [load, toast]);

  const saveTheme = useCallback(async (patch) => {
    const next = Object.assign({}, theme, patch);
    setTheme(next);
    try {
      const t = {}; for (const k of THEME_FIELDS) t[k] = next[k];
      await api('/code-studio/api/action', { op: 'theme', theme: t });
    } catch (e) { toast(e.message, true); }
  }, [theme, toast]);

  const issues = (snap && snap.issues) || [];
  const regions = (snap && snap.regions) || {};

  const groups = useMemo(() => {
    const names = Object.keys(regions);
    let gs = names.map((name) => ({ name, issues: issues.filter((i) => String(i.region || '') === name) }));
    const orphans = issues.filter((i) => !i.region || !regions[i.region]);
    if (orphans.length) gs.push({ name: '未归区', issues: orphans, orphan: true });
    const qq = String(q || '').trim().toLowerCase();
    if (qq) {
      const m = (s) => String(s == null ? '' : s).toLowerCase().includes(qq);
      gs = gs.map((g) => ({ ...g, issues: g.issues.filter((i) => m(i.title) || m(i.id) || m(g.name)) }))
             .filter((g) => g.issues.length || m(g.name));
    }
    return gs;
  }, [issues, regions, q]);

  const cRun = issues.filter((i) => i.status === 'RUNNING').length;
  const cDone = issues.filter((i) => i.status === 'DONE').length;
  const cFail = issues.filter((i) => ['FAILED', 'BLOCKED', 'CANCELLED'].includes(i.status)).length;
  const cQueue = issues.filter((i) => !i.status || i.status === 'READY' || i.status === 'PENDING').length;
  const srcName = snap && snap.github && snap.github.enabled ? 'GitHub' : (snap && snap.watch && snap.watch.enabled ? '收件箱' : '本地');

  const selIssue = issues.find((i) => String(i.id) === sel);

  const scrollTo = (id) => { const n = document.getElementById(id); if (n) n.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  const railClick = (id) => {
    if (id === 'rRegion') { setSideCollapsed((v) => !v); return; }
    if (id === 'rSrc') { setSrcOpen((v) => !v); return; }
    if (id === 'rTheme') { setCardOpen((v) => !v); return; }
    if (id === 'rRefresh') { act('scan'); return; }
    if (id === 'rStatus') { scrollTo('graph'); return; }
    if (id === 'rReport') { scrollTo('report'); return; }
  };
  const railOn = (id) => (id === 'rRegion' ? !sideCollapsed : id === 'rSrc' ? srcOpen : false);

  const watchOn = !!(snap && snap.watch && snap.watch.enabled);
  const gh = (snap && snap.github) || {};

  return (
    <div className={'app' + (sideCollapsed ? ' side-collapsed' : '')}>
      <aside className="rail">
        <div className="brand" title="代码总编工作室"><span className="bico" /></div>
        <nav className="railnav">
          {RAIL.map((r) => (
            <Tooltip key={r.id} content={r.title}>
              <Button isIconOnly variant="light" className={'rbtn' + (railOn(r.id) ? ' on' : '')} onPress={() => railClick(r.id)}>
                <i>{r.icon}</i>
              </Button>
            </Tooltip>
          ))}
        </nav>
        <div className="railbot">
          {RAIL_BOT.map((r) => (
            <Tooltip key={r.id} content={r.title}>
              <Button isIconOnly variant="light" className={'rbtn' + (railOn(r.id) ? ' on' : '')} onPress={() => railClick(r.id)}>
                <i>{r.icon}</i>
              </Button>
            </Tooltip>
          ))}
        </div>
      </aside>

      <div className="main">
        <header className="top">
          <div className="ttl">
            <span className="dot" />
            <div className="ttlwrap">
              <h1>工作室</h1>
              <span className="sub2">代码总编 · 按区域派单</span>
            </div>
            <Chip size="sm" variant="flat" className="pill">{issues.length + ' 个 issue'}</Chip>
          </div>
        </header>

        {srcOpen && (
          <section className="src" id="srcbar">
            <Button size="sm" variant="flat" className={'chip' + (watchOn ? ' on' : '')} onPress={() => act(watchOn ? 'watchOff' : 'watchOn')}>
              监听 <b>{watchOn ? '开' : '关'}</b>
            </Button>
            <span className="sep" />
            <span className="lbl">GitHub</span><b className={'val' + (gh.enabled ? ' ok' : '')}>{gh.repo || '未绑定'}</b>
            <GhBind act={act} toast={toast} />
            <Button size="sm" variant="light" onPress={() => act('githubOff')}>解绑</Button>
            <span className="sep" />
            <span className="lbl">PAT</span><b className={'val' + (snap && snap.hasToken ? ' ok' : '')}>{snap && snap.hasToken ? '已存' : '未存'}</b>
            <PatSave act={act} toast={toast} />
            <Button size="sm" variant="light" onPress={() => act('tokenOff')}>清除</Button>
          </section>
        )}

        <main className="grid">
          <aside className="col left">
            <SearchField className="search" aria-label="搜索" value={q} onChange={setQ}>
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder="搜索 issue / 区域" />
              </SearchField.Group>
            </SearchField>
            <div className="secttl">区域 <Chip size="sm" variant="flat" className="pill sm">{Object.keys(regions).length}</Chip></div>
            <div className="tree">
              {!groups.length && <div className="empty">还没有区域（派单后自动建）</div>}
              {groups.map((g) => {
                const key = g.orphan ? '\u0000orphan' : g.name;
                const running = g.issues.some((i) => i.status === 'RUNNING');
                const open = key in expanded ? !!expanded[key] : running;
                return (
                  <div key={key}>
                    <div className={'tgroup-head' + (open ? ' open' : '') + (running ? ' running' : '')}
                         onClick={() => { setExpanded((e) => ({ ...e, [key]: !open })); if (!open && g.issues[0]) setSel(String(g.issues[0].id)); }}>
                      <span className="caret">{open ? '▾' : '▸'}</span>
                      {running && <span className="rdot" />}
                      <span className="tname">{g.orphan ? '未归区' : (g.name || '—')}</span>
                      <b className="tcount">{g.issues.length}</b>
                    </div>
                    {open && (
                      <div className="tgroup-kids">
                        {!g.issues.length && <div className="empty sm">这个区域还没有 issue</div>}
                        {g.issues.map((it) => {
                          const id = String(it.id);
                          return (
                            <div key={id} className={'issrow' + (id === sel ? ' sel' : '')} data-st={tagOf(it.status)} onClick={() => setSel(id)}>
                              <span className="iav"><i>{'#' + id}</i></span>
                              <div className="imid">
                                <div className="ittl">{it.title || it.body || '(untitled)'}</div>
                                <div className="isub"><span className="ist">{it.status || '待派'}</span>{it.region && <span className="ireg">{'· ' + it.region}</span>}</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </aside>

          <section className="col right">
            <section className="mon">
              <Mc b={cRun} label="进行中" /><Mc b={cQueue} label="待派" /><Mc b={cDone} label="已完成" />
              <Mc b={cFail} label="异常" /><Mc b={Object.keys(regions).length} label="区域" /><Mc b={srcName} label="数据源" />
            </section>
            <div className="secttl">工作状态
              <span className="legend"><i className="d" />完成 <i className="r" />进行 <i className="f" />失败</span>
            </div>
            <Graph issues={issues} regions={regions} />
            <div className="secttl">报告
              <span className="acts">
                <Button size="sm" color="primary" isDisabled={!(selIssue && selIssue.status === 'DONE')} onPress={() => sel && act('pr', { id: sel })}>建 PR</Button>
                <Button size="sm" variant="flat" isDisabled={!(selIssue && selIssue.status === 'RUNNING')} onPress={() => sel && act('cancel', { id: sel })}>中止</Button>
              </span>
            </div>
            <Report issue={selIssue} regions={regions} />
          </section>
        </main>
      </div>

      {cardOpen && <ThemeCard theme={theme} presets={presets} saveTheme={saveTheme} toast={toast} onClose={() => setCardOpen(false)} />}
      {toastMsg && <div className={'toast show' + (toastMsg.bad ? ' bad' : '')}>{toastMsg.msg}</div>}
    </div>
  );
}

function Mc({ b, label }) {
  return <Card className="mcard" shadow="none"><b>{b}</b><span>{label}</span></Card>;
}

function GhBind({ act, toast }) {
  const [v, setV] = useState('');
  return (
    <>
      <Input size="sm" className="input" placeholder="owner/repo" value={v} onValueChange={setV} />
      <Button size="sm" variant="flat" onPress={() => { const s = v.trim(); if (!s) return toast('填 owner/repo', true); act('github', { repo: s }); }}>绑定</Button>
    </>
  );
}
function PatSave({ act, toast }) {
  const [v, setV] = useState('');
  return (
    <>
      <Input size="sm" type="password" className="input" placeholder="ghp_…" value={v} onValueChange={setV} />
      <Button size="sm" variant="flat" onPress={() => { const s = v.trim(); if (!s) return toast('粘贴 PAT', true); setV(''); act('token', { token: s }); }}>保存</Button>
    </>
  );
}

function Report({ issue, regions }) {
  if (!issue) return <div className="report empty">选一个 issue 看报告</div>;
  const fold = ((regions[issue.region] || {}).folders) || issue.folders || [];
  return (
    <div className="report">
      <div className="meta">
        {issue.region && <span className="chip sm">区域 · {issue.region}</span>}
        {fold.length > 0 && <span className="chip sm">{fold.join(', ')}</span>}
      </div>
      {issue.prUrl && <a className="prlink" href={issue.prUrl} target="_blank" rel="noreferrer">{issue.prUrl}</a>}
      {issue.changedFiles && issue.changedFiles.length > 0 && (
        <div className="files">{issue.changedFiles.map((f) => <code key={String(f)}>{String(f)}</code>)}</div>
      )}
      <div className="body">{issue.report || (issue.status === 'FAILED' ? ('失败：' + (issue.error || '')) : '还没有报告')}</div>
    </div>
  );
}

function ThemeCard({ theme, presets, saveTheme, toast, onClose }) {
  const [pos, setPos] = useState({ left: null, top: 64 });
  const drag = useRef(null);
  const onDown = (e) => {
    if (e.target.closest('button')) return;
    drag.current = { sx: e.clientX, sy: e.clientY, ox: e.currentTarget.parentElement.offsetLeft, oy: e.currentTarget.parentElement.offsetTop };
    e.preventDefault();
  };
  useEffect(() => {
    const mv = (e) => {
      if (!drag.current) return;
      const p = drag.current;
      setPos({ left: Math.max(0, p.ox + e.clientX - p.sx), top: Math.max(0, p.oy + e.clientY - p.sy) });
    };
    const up = () => { drag.current = null; };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
  }, []);
  const style = { top: pos.top + 'px' };
  if (pos.left != null) { style.left = pos.left + 'px'; style.right = 'auto'; }
  const S = (patch) => saveTheme(patch);
  return (
    <div className="tcard" style={style}>
      <div className="tcard-hd" onMouseDown={onDown}>
        <span className="tcard-ttl">外观设置</span>
        <Button isIconOnly size="sm" variant="light" className="btn ghost icon" onPress={onClose}>✕</Button>
      </div>
      <div className="tcard-bd">
        <div className="trow"><span className="lbl">预设</span><span className="presets">
          {Object.keys(presets).map((k) => (
            <button key={k} className={'swatch' + (presets[k].accent === theme.accent ? ' on' : '')} title={presets[k].label}
                    style={{ background: presets[k].accent }} onClick={() => S({ accent: presets[k].accent })} />
          ))}
        </span></div>
        <div className="trow">
          <span className="lbl">强调色</span>
          <input className="color" type="color" value={theme.accent} onChange={(e) => S({ accent: e.target.value })} />
          <Input size="sm" className="input hexin" value={theme.accent} onValueChange={(v) => { if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v)) S({ accent: v }); }} />
        </div>
        <div className="trow">
          <span className="lbl">背景</span>
          <Button size="sm" variant={theme.bgType === 'theme' ? 'flat' : 'light'} onPress={() => S({ bgType: 'theme' })}>跟随主题</Button>
          <Button size="sm" variant={theme.bgType === 'color' ? 'flat' : 'light'} onPress={() => S({ bgType: 'color' })}>纯色</Button>
          <Button size="sm" variant={theme.bgType === 'image' ? 'flat' : 'light'} onPress={() => S({ bgType: 'image' })}>图片</Button>
        </div>
        {theme.bgType === 'color' && (
          <div className="trow"><span className="lbl" /><input className="color" type="color" value={theme.bgColor} onChange={(e) => S({ bgColor: e.target.value })} /><span className="hint">给整页铺一个纯色底</span></div>
        )}
        {theme.bgType === 'image' && (
          <div className="trow"><span className="lbl" /><Input size="sm" className="input growin" placeholder="图片 URL（https://… 或 data:image/…）" defaultValue={theme.bgImage}
            onValueChange={(v) => { const s = v.trim(); const ok = !s || s.indexOf('http://') === 0 || s.indexOf('https://') === 0 || s.indexOf('data:image/') === 0; if (ok) S({ bgImage: s }); else toast('图片地址要以 http(s):// 或 data:image/ 开头', true); }} /></div>
        )}
        <div className="trow">
          <span className="lbl">渐变</span>
          <input className="color" type="color" value={theme.gradA} onChange={(e) => S({ gradA: e.target.value })} />
          <input className="color" type="color" value={theme.gradB} onChange={(e) => S({ gradB: e.target.value })} />
          <input className="range growin" type="range" min="0" max="100" step="5" value={theme.grad} onChange={(e) => S({ grad: +e.target.value })} />
          <b className="pill sm">{theme.grad}</b>
        </div>
        <div className="trow">
          <span className="lbl">面板色</span>
          <input className="color" type="color" value={theme.panelColor || '#12141d'} onChange={(e) => S({ panelColor: e.target.value })} />
          <Button size="sm" variant="light" onPress={() => S({ panelColor: '' })}>跟随</Button>
          <span className="lbl">不透明</span>
          <input className="range growin" type="range" min="0" max="100" step="2" value={theme.panelOpacity} onChange={(e) => S({ panelOpacity: +e.target.value })} />
          <b className="pill sm">{theme.panelOpacity}</b>
        </div>
        <div className="trow">
          <span className="lbl">玻璃</span>
          <Switch isSelected={theme.glass} onValueChange={(v) => S({ glass: v })} />
          <span className="lbl">模糊</span>
          <input className="range" type="range" min="0" max="30" step="1" value={theme.blur} onChange={(e) => S({ blur: +e.target.value })} />
          <span className="lbl">饱和</span>
          <input className="range" type="range" min="0" max="200" step="5" value={theme.saturation} onChange={(e) => S({ saturation: +e.target.value })} />
        </div>
        <div className="trow">
          <span className="lbl">圆角</span>
          <input className="range" type="range" min="0" max="20" step="1" value={theme.radius} onChange={(e) => S({ radius: +e.target.value })} />
          <b className="pill sm">{theme.radius}</b>
          <span className="lbl">密度</span>
          <Button size="sm" variant={theme.density === 'comfy' ? 'flat' : 'light'} onPress={() => S({ density: 'comfy' })}>舒适</Button>
          <Button size="sm" variant={theme.density === 'compact' ? 'flat' : 'light'} onPress={() => S({ density: 'compact' })}>紧凑</Button>
        </div>
        <div className="trow">
          <span className="lbl">模式</span>
          <Button size="sm" variant={theme.mode === 'auto' ? 'flat' : 'light'} onPress={() => S({ mode: 'auto' })}>跟随</Button>
          <Button size="sm" variant={theme.mode === 'light' ? 'flat' : 'light'} onPress={() => S({ mode: 'light' })}>亮色</Button>
          <Button size="sm" variant={theme.mode === 'dark' ? 'flat' : 'light'} onPress={() => S({ mode: 'dark' })}>深色</Button>
          <span className="sep" />
          <Button size="sm" variant="light" onPress={() => S({ accent: '#6b93ff', radius: 12, density: 'comfy', mode: 'auto', bgType: 'theme', bgColor: '#0e1015', bgImage: '', glass: false, blur: 16, saturation: 140, grad: 55, gradA: '#8b5cf6', gradB: '#2b6cff', panelColor: '', panelOpacity: 62 })}>恢复默认</Button>
        </div>
      </div>
    </div>
  );
}
