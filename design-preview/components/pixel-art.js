// 高清像素节点渲染器：小颗粒网格 + 描边圈 + 左上高光 + 右下阴影 + 可选中心宝石
// 用法：CS.art.orb(svg, cx, cy, r, CS.art.palettes.done, { gem: true })
window.CS = window.CS || {};
CS.art = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const GRID = 3; // 颗粒边长（px）：小颗粒 = 高清

  // 每个状态一套四色像素调色板（描边 / 填充 / 高光 / 阴影）
  // 与统计卡五色一一对应：done=已完成 run=进行中 review=待合并 idle=待派/未达成 fail=异常；live=主干生长段/版本
  const palettes = {
    done:   { edge: '#123b2e', fill: '#34d399', hi: '#b5f4dd', lo: '#159d6c' },
    run:    { edge: '#4a2c07', fill: '#f59e0b', hi: '#fde3a7', lo: '#c27405' },
    review: { edge: '#1e2a4a', fill: '#60a5fa', hi: '#c7ddfd', lo: '#3b6fd4' },
    fail:   { edge: '#4a1518', fill: '#f87171', hi: '#fecaca', lo: '#c24545' },
    live:   { edge: '#10243f', fill: '#3b82f6', hi: '#bfdcff', lo: '#1d5fc4' },
    idle:   { edge: '#20262e', fill: '#565f6e', hi: '#9aa4b2', lo: '#3a4350' },
  };

  function rect(svg, x, y, s, fill){
    const n = document.createElementNS(NS, 'rect');
    n.setAttribute('x', x); n.setAttribute('y', y);
    n.setAttribute('width', s); n.setAttribute('height', s);
    n.setAttribute('fill', fill);
    svg.appendChild(n);
  }

  // 高清像素圆球：r 为物理半径；颗粒边长可用 opts.grid 覆盖（缩小节点时减小 grid，像素块数量不减）
  // 返回包裹所有像素块的 <g>（供生长/变色动画做 transform）；g.recolor(pal) 换状态色重绘
  function orb(svg, cx, cy, r, pal, opts = {}){
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'orb');
    svg.appendChild(g);
    const step = opts.grid || GRID;
    const R = Math.ceil(r / step) * step;
    function draw(p){
      g.replaceChildren();
      for (let gx = -R; gx <= R; gx += step){
        for (let gy = -R; gy <= R; gy += step){
          const d = Math.hypot(gx, gy);
          if (d > r) continue;
          let color = p.fill;
          if (d > r - step * 1.2) color = p.edge;                    // 描边圈
          else if (opts.gem && Math.abs(gx) + Math.abs(gy) <= r * 0.42) color = p.hi; // 中心菱形宝石
          else if (gx < -r * 0.1 && gy < -r * 0.1 && d > r * 0.4) color = p.hi;       // 左上高光带
          else if (gx + gy > r * 0.9) color = p.lo;                  // 右下阴影带
          rect(g, cx + gx - step / 2, cy + gy - step / 2, step, color);
        }
      }
      // 最亮的一粒反光（像素素材的点睛笔）
      rect(g, cx - r * 0.45, cy - r * 0.5, step, '#ffffff');
    }
    draw(pal);
    g.recolor = draw;
    return g;
  }

  return { orb, rect, palettes, GRID };
})();
