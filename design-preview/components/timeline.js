// ① 像素进度条 = 时间轴滑块（一体化：直接在条上按住拖动）
(() => {
  const bar = document.getElementById('pxbar');
  let dragging = false;
  function setPct(clientX){
    const r = bar.getBoundingClientRect();
    const v = Math.max(0, Math.min(100, Math.round((clientX - r.left) / r.width * 100)));
    document.getElementById('pxfill').style.width = v + '%';
    document.getElementById('pxcursor').style.left = `calc(${v}% - 5px)`;
    document.getElementById('pxread').textContent = '区间 ' + v + '%';
  }
  bar.addEventListener('pointerdown', e => { dragging = true; bar.setPointerCapture(e.pointerId); setPct(e.clientX); });
  bar.addEventListener('pointermove', e => { if (dragging) setPct(e.clientX); });
  bar.addEventListener('pointerup', () => dragging = false);
  const r = bar.getBoundingClientRect();
  setPct(r.left + r.width * 0.4);
})();
