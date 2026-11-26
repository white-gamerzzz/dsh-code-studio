import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@heroui/react/button';
import { Chip } from '@heroui/react/chip';
import { Card } from '@heroui/react/card';
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
  : s === 'REVIEW' ? 'review'
  : (s === 'FAILED' || s === 'BLOCKED' || s === 'CANCELLED') ? 'fail'
  : (s === 'RUNNING' || s === 'READY') ? 'run' : '');

/* 主题已交还宿主：颜色/深浅色全部走 studio.css 的 --dsw-alias 令牌 +
   main.jsx 的 syncTheme 跟随，不再有面板自绘背景/玻璃/渐变。 */

// ---- 工作状态图 ----
function Graph({ issues }) {
  const boxRef = useRef(null);
  return (
    <div className="graph" ref={boxRef}>
      <GraphSvg boxRef={boxRef} issues={issues} />
    </div>
  );
}
function GraphSvg({ boxRef, issues }) {
  const [W, setW] = useState(520);
  useEffect(() => {
    const read = () => { if (boxRef.current) setW(Math.max(boxRef.current.clientWidth || 520, 320)); };
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, [boxRef]);
  const H = 178;
  const repos = [];
  for (const it of issues) {
    const name = String(it.repoName || (it.__dir ? it.__dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '')) || '(未归属)';
    let g = repos.find((r) => r.name === name);
    if (!g) { g = { name, issues: [] }; repos.push(g); }
    g.issues.push(it);
  }
  if (!repos.length) return <svg viewBox={'0 0 ' + W + ' ' + H} width="100%" height={H}><text x="14" y={H / 2} className="nsub">还没有 issue，备单后出现在这里</text></svg>;
  const rootX = 40, regX = Math.min(170, W * 0.34), issX = Math.max(regX + 130, W - 120);
  const rootY = H / 2, topPad = 20, band = H / repos.length;
  const line = (x1, y1, x2, y2) => <path key={'l' + x1 + y1 + x2 + y2} d={'M' + x1 + ' ' + y1 + ' C' + ((x1 + x2) / 2) + ' ' + y1 + ' ' + ((x1 + x2) / 2) + ' ' + y2 + ' ' + x2 + ' ' + y2} className="edge" />;
  const nodes = [];
  const edges = [];
  const circles = [];
  const texts = [];
  circles.push(<circle key="root" cx={rootX} cy={rootY} r={12} className="node root" />);
  texts.push(<text key="roott" x={rootX} y={rootY - 19} className="nlabel" textAnchor="middle">workspace</text>);
  texts.push(<text key="roots" x={rootX} y={rootY + 25} className="nsub" textAnchor="middle">{issues.length + ' issue'}</text>);
  repos.forEach((g, i) => {
    const ris = g.issues;
    const ry = topPad + ((H - topPad * 2) / repos.length) * (i + 0.5);
    edges.push(line(rootX + 12, rootY, regX - 9, ry));
    const running = ris.some((x) => x.status === 'RUNNING');
    circles.push(<circle key={'r' + g.name} cx={regX} cy={ry} r={9} className={'node reg' + (running ? ' run' : '')} />);
    texts.push(<text key={'rt' + g.name} x={regX} y={ry - 16} className="nlabel" textAnchor="middle">{g.name}</text>);
    texts.push(<text key={'rs' + g.name} x={regX} y={ry + 22} className="nsub" textAnchor="middle">{ris.length + ' 个 issue'}</text>);
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
  { id: 'rRegion', icon: '▤', title: '折叠 / 展开左栏', nav: true },
];
const RAIL_BOT = [
  { id: 'rSrc', icon: '⇄', title: '数据源' },
  { id: 'rRefresh', icon: '⟳', title: '刷新' },
];

export default function App({ boot }) {
  const [snap, setSnap] = useState(null);
  const [sel, setSel] = useState(undefined);
  const [expanded, setExpanded] = useState({});
  const [q, setQ] = useState('');
  /* 窄面板（DSH 右栏）默认分体：一次只显示一个窗格，rail 的窗格按钮切换 */
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [srcOpen, setSrcOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const lastErrRef = useRef(null);

  const toast = useCallback((msg, bad) => {
    setToastMsg({ msg, bad });
    clearTimeout(toast._t);
    toast._t = setTimeout(() => setToastMsg(null), 2600);
  }, []);

  const load = useCallback(async () => {
    try { setSnap(await api('/code-studio/api/state')); setLoadErr(null); }
    catch (e) { const m = String((e && e.message) || e); setLoadErr(m); if (m !== lastErrRef.current) toast('读取失败：' + m, true); lastErrRef.current = m; }
  }, [toast]);

  useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, [load]);

  const act = useCallback(async (op, extra) => {
    try {
      const r = await api('/code-studio/api/action', Object.assign({ op }, extra || {}));
      if (r && r.text) toast(r.text, r.ok === false);
      await load();
      return r;
    } catch (e) { toast(e.message, true); return null; }
  }, [load, toast]);

  const issues = (snap && snap.issues) || [];

  const repoKey = (it) => String(it.repoName || (it.__dir ? it.__dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '')) || '(未归属)';

  const groups = useMemo(() => {
    const byRepo = new Map();
    for (const it of issues) {
      const name = repoKey(it);
      if (!byRepo.has(name)) byRepo.set(name, []);
      byRepo.get(name).push(it);
    }
    let gs = [...byRepo.keys()].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')).map((name) => ({ name, issues: byRepo.get(name) }));
    const qq = String(q || '').trim().toLowerCase();
    if (qq) {
      const m = (s) => String(s == null ? '' : s).toLowerCase().includes(qq);
      gs = gs.map((g) => ({ ...g, issues: g.issues.filter((i) => m(i.title) || m(i.id) || m(g.name)) }))
             .filter((g) => g.issues.length || m(g.name));
    }
    return gs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issues, q]);

  const cRun = issues.filter((i) => i.status === 'RUNNING').length;
  const cReview = issues.filter((i) => i.status === 'REVIEW').length;
  const cDone = issues.filter((i) => i.status === 'DONE').length;
  const cFail = issues.filter((i) => ['FAILED', 'BLOCKED', 'CANCELLED'].includes(i.status)).length;
  const cQueue = issues.filter((i) => !i.status || i.status === 'READY' || i.status === 'PENDING').length;
  const srcName = snap && snap.github && snap.github.enabled ? 'GitHub' : (snap && snap.watch && snap.watch.enabled ? '收件箱' : '本地');

  const selIssue = issues.find((i) => String(i.id) === sel);

  const railClick = (id) => {
    if (id === 'rRegion') { setSideCollapsed((v) => !v); return; }
    if (id === 'rSrc') { setSrcOpen((v) => !v); return; }
    if (id === 'rRefresh') { act('scan'); return; }
  };
  const railOn = (id) => (id === 'rRegion' ? !sideCollapsed : id === 'rSrc' ? srcOpen : false);

  const watchOn = !!(snap && snap.watch && snap.watch.enabled);
  const gh = (snap && snap.github) || {};

  return (
    <div className={'app' + (sideCollapsed ? ' side-collapsed' : '')}>
      <aside className="rail">
        <div className="brand" title="代码总编工作室">
          <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8.5 7.5 4.5 12l4 4.5M15.5 7.5 19.5 12l-4 4.5" />
          </svg>
        </div>
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
              <span className="sub2">代码总编 · 按仓库派单</span>
            </div>
            <Chip size="sm" variant="flat" className="pill">{issues.length + ' 个 issue'}</Chip>
          </div>
        </header>

        {loadErr && <div className="errbanner">读取失败：{loadErr}</div>}

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
                <SearchField.Input placeholder="搜索 issue / 仓库" />
              </SearchField.Group>
            </SearchField>
            <div className="secttl">仓库 <Chip size="sm" variant="flat" className="pill sm">{groups.length}</Chip></div>
            <div className="tree">
              {!groups.length && <div className="empty">还没有 issue（备单后出现在这里）</div>}
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
                      <span className="tname">{g.name}</span>
                      <b className="tcount">{g.issues.length}</b>
                    </div>
                    {open && (
                      <div className="tgroup-kids">
                        {!g.issues.length && <div className="empty sm">这个仓库还没有 issue</div>}
                        {g.issues.map((it) => {
                          const id = String(it.id);
                          return (
                            <div key={id} className={'issrow' + (id === sel ? ' sel' : '')} data-st={tagOf(it.status)} onClick={() => setSel(id)}>
                              <span className="iav"><i>{'#' + id}</i></span>
                              <div className="imid">
                                <div className="ittl">{it.title || it.body || '(untitled)'}</div>
                                <div className="isub"><span className="ist">{it.status || '待派'}</span>{Array.isArray(it.tags) && it.tags.length > 0 && <span className="ireg">{'· ' + it.tags.join(',')}</span>}</div>
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
              <Mc b={cRun} label="进行中" /><Mc b={cReview} label="待合并" /><Mc b={cQueue} label="待派" /><Mc b={cDone} label="已完成" />
              <Mc b={cFail} label="异常" /><Mc b={groups.length} label="仓库" /><Mc b={srcName} label="数据源" />
            </section>
            <div className="secttl">工作状态
              <span className="legend"><i className="d" />完成 <i className="v" />待合并 <i className="r" />进行 <i className="f" />失败</span>
            </div>
            <Graph issues={issues} />
            <div className="secttl">报告
              <span className="acts">
                <Button size="sm" color="success" isDisabled={!(selIssue && selIssue.status === 'REVIEW')} onPress={() => sel && act('merge', { id: sel, dir: selIssue.__dir })}>合并</Button>
                <Button size="sm" variant="flat" isDisabled={!(selIssue && selIssue.status === 'RUNNING')} onPress={() => sel && act('cancel', { id: sel, dir: selIssue.__dir })}>中止</Button>
              </span>
            </div>
            <Report issue={selIssue} />
          </section>
        </main>
      </div>

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

function Report({ issue }) {
  if (!issue) return <div className="report empty">选一个 issue 看报告</div>;
  const fold = issue.folders || [];
  return (
    <div className="report">
      <div className="meta">
        {issue.repoName && <span className="chip sm">仓库 · {issue.repoName}</span>}
        {fold.length > 0 && <span className="chip sm">{fold.join(', ')}</span>}
        {Array.isArray(issue.tags) && issue.tags.length > 0 && <span className="chip sm">{issue.tags.join(', ')}</span>}
      </div>
      {issue.prUrl && <a className="prlink" href={issue.prUrl} target="_blank" rel="noreferrer">{issue.prUrl}</a>}
      {issue.changedFiles && issue.changedFiles.length > 0 && (
        <div className="files">{issue.changedFiles.map((f) => <code key={String(f)}>{String(f)}</code>)}</div>
      )}
      <div className="body">{issue.report || (issue.status === 'FAILED' ? ('失败：' + (issue.error || '')) : '还没有报告')}</div>
    </div>
  );
}
