// 生长树：轮次区间 + 细线 S 弯 + 高清像素节点（五色状态，无回弯曲线）+ 状态流转动画
// 状态全部用节点颜色表达，与五种统计卡一一对应：
//   灰=待派 READY → 橙=进行中 RUNNING → 蓝=待合并 REVIEW → 绿=已完成 DONE；红=异常 FAILED
// 曲线只表示「从主干分出」，中性色；一轮全部 DONE = 轮末版本节点亮起
(() => {
  const svg = document.getElementById('tree');
  const NS = 'http://www.w3.org/2000/svg';
  const { orb, rect, palettes, GRID } = CS.art;
  const T = 110; // 主干 y
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ---- 场景：三轮（轮 1 全完成出 v1；轮 2 有蓝有橙；轮 3 有红） ----
  const ROUNDS = [
    { label: '第 1 轮 · 2/2 合并', x0: 40, x1: 320, items: [
      { id: 11, x: 120, y: 50,  st: 'DONE' },
      { id: 12, x: 230, y: 170, st: 'DONE' },
    ], version: { x: 300, pal: 'done', label: 'v1' } },
    { label: '第 2 轮 · 1/3 合并', x0: 320, x1: 600, items: [
      { id: 13, x: 370, y: 50,  st: 'DONE' },
      { id: 14, x: 455, y: 170, st: 'REVIEW' },
      { id: 15, x: 540, y: 50,  st: 'RUNNING' },
    ], version: { x: 580, pal: 'idle', label: 'v2' } },
    { label: '第 3 轮 · 0/2 合并', x0: 600, x1: 880, items: [
      { id: 16, x: 680, y: 50,  st: 'RUNNING' },
      { id: 17, x: 790, y: 170, st: 'FAILED' },
    ], version: { x: 850, pal: 'idle', label: 'v3' } },
  ];
  // 状态 → 调色板
  const PAL = { READY: 'idle', RUNNING: 'run', REVIEW: 'review', DONE: 'done', FAILED: 'fail' };

  // ---- 静态主干：像素块四层（厚 12），v1 之后为生长中段（蓝） ----
  function trunk(x, color){ for (let i = 0; i < 4; i++) rect(svg, x, T - 6 + i * GRID, GRID, color); }
  for (let x = 30; x <= 870; x += GRID) trunk(x, palettes.idle.lo);
  for (let x = 300; x <= 850; x += GRID) trunk(x, palettes.live.fill);

  // ---- 工厂 ----
  function curve(x0, y0, x1, y1){
    const d = Math.max(30, Math.abs(x1 - x0) * 0.45);
    const n = document.createElementNS(NS, 'path');
    n.setAttribute('d', `M${x0} ${y0} C${x0 + d} ${y0} ${x1 - d} ${y1} ${x1} ${y1}`);
    n.setAttribute('stroke', palettes.idle.lo); n.setAttribute('stroke-width', 1.5);
    n.setAttribute('fill', 'none'); n.setAttribute('stroke-linecap', 'round');
    n.setAttribute('class', 'gpath');
    svg.appendChild(n);
    return n;
  }
  function txt(x, y, s, fill){
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', x); t.setAttribute('y', y); t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', 'tlabel');
    if (fill) t.setAttribute('fill', fill);
    t.textContent = s; svg.appendChild(t);
    return t;
  }
  function roundLine(x){
    const n = document.createElementNS(NS, 'line');
    n.setAttribute('x1', x); n.setAttribute('x2', x);
    n.setAttribute('y1', 26); n.setAttribute('y2', 196);
    n.setAttribute('stroke', '#2a313b'); n.setAttribute('stroke-dasharray', '3 4');
    n.setAttribute('class', 'tlabel');
    svg.appendChild(n);
    return n;
  }

  // ---- 建场景（节点初始灰色=待派；播放时按状态机变色） ----
  const rounds = ROUNDS.map(r => ({
    ...r,
    labelEl: txt((r.x0 + r.x1) / 2, 14, r.label, '#8b93a1'),
    sepEl: r.x0 > 40 ? roundLine(r.x0) : null,
    nodes: r.items.map(it => ({
      ...it,
      out: curve(it.x - 55, T, it.x, it.y),
      orb: orb(svg, it.x, it.y, 12, palettes.idle, { grid: 2 }),
      text: txt(it.x, it.y < T ? it.y - 24 : it.y + 30, '#' + it.id),
    })),
    vnode: {
      ...r.version,
      orb: orb(svg, r.version.x, T, 14, palettes.idle, { gem: true, grid: 2 }),
      text: txt(r.version.x, T + 34, r.version.label, palettes[r.version.pal].fill),
    },
  }));
  // 分出点交点小方块（静态）
  for (const r of rounds) for (const n of r.nodes){
    rect(svg, n.x - 55 - GRID, T - GRID, GRID * 2, palettes.idle.fill);
  }

  // ---- 动画 ----
  const paths = rounds.flatMap(r => r.nodes.map(n => n.out));
  const orbs = rounds.flatMap(r => [...r.nodes.map(n => n.orb), r.vnode.orb]);
  const labels = rounds.flatMap(r => [r.labelEl, r.sepEl, ...r.nodes.map(n => n.text), r.vnode.text].filter(Boolean));

  function reset(){
    svg.classList.add('noanim');
    for (const p of paths){
      const len = p.getTotalLength();
      p.style.strokeDasharray = String(len);
      p.style.strokeDashoffset = String(len);
    }
    for (const g of orbs){
      g.classList.remove('pulse'); g.classList.add('hidden');
      if (g.recolor) g.recolor(palettes.idle);
    }
    for (const t of labels) t.style.opacity = '0';
    void svg.getBoundingClientRect();
    svg.classList.remove('noanim');
  }
  const grow = (p) => { p.style.strokeDashoffset = '0'; };
  const pop = (g, t) => { g.classList.remove('hidden'); if (t) t.style.opacity = '1'; };
  const show = (t) => { if (t) t.style.opacity = '1'; };
  function setState(n, st, pulse){
    n.orb.recolor(palettes[PAL[st]]);
    if (pulse){
      n.orb.classList.add('pulse');
      setTimeout(() => n.orb.classList.remove('pulse'), 400);
    }
  }

  let runId = 0;
  async function play(){
    const id = ++runId;
    const alive = () => id === runId;
    reset();
    await sleep(150); if (!alive()) return;
    for (const r of rounds){
      show(r.labelEl); show(r.sepEl);
      for (const n of r.nodes) grow(n.out);                        // 轮内并行分出
      await sleep(950); if (!alive()) return;
      for (const n of r.nodes) pop(n.orb, n.text);                 // 弹出：灰=待派
      await sleep(500); if (!alive()) return;
      for (const n of r.nodes) if (n.st !== 'READY') setState(n, 'RUNNING'); // 开跑：橙
      await sleep(600); if (!alive()) return;
      for (const n of r.nodes) if (n.st === 'DONE' || n.st === 'REVIEW') setState(n, 'REVIEW'); // 待合并：蓝
      await sleep(600); if (!alive()) return;
      for (const n of r.nodes){
        if (n.st === 'DONE') setState(n, 'DONE', true);            // 完成：绿 + 脉冲
        if (n.st === 'FAILED') setState(n, 'FAILED', true);        // 异常：红 + 脉冲
      }
      await sleep(500); if (!alive()) return;
      const allDone = r.nodes.every(n => n.st === 'DONE');
      r.vnode.orb.recolor(allDone ? palettes.done : palettes.idle); // 版本：全完成才亮绿
      pop(r.vnode.orb, r.vnode.text);
      await sleep(500); if (!alive()) return;
    }
  }

  document.getElementById('treplay').addEventListener('click', play);
  play();
})();
