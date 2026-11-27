// ③ 统计卡 = 筛选按钮 / ④ issue 列表 / ⑤ 报告大区（三者共享选中与筛选状态）
(() => {
  const ISSUES = [
    {id:11, title:"导出功能：CSV 字段转义补位", st:"RUNNING", report:"## #11 导出功能\n\n- [x] 定位转义缺陷在 csv/escape.ts:42\n- [x] 补齐引号嵌套分支\n- [ ] 回归 3 个样例文件\n\n副本 .code-studio/worktrees/issue-11"},
    {id:12, title:"批量跳转跳题选", st:"DONE", report:"## #12 批量跳转\n\n已完成并合并回主干（v2）。变更 2 文件 +31/−7，测试 12/12 通过。"},
    {id:13, title:"auth/login token 过期刷新逻辑", st:"READY", report:"待派发。预计触碰 src/auth/* 三个文件。"},
  ];
  let sel = null, filter = null;

  document.querySelectorAll('#stats .stat').forEach(el => {
    el.onclick = () => {
      const f = el.dataset.f;
      filter = (filter === f) ? null : f;
      document.querySelectorAll('#stats .stat').forEach(x => x.classList.toggle('on', x.dataset.f === filter));
      renderList();
    };
  });

  function renderList(){
    const q = document.getElementById('search').value.trim().toLowerCase();
    const mode = document.getElementById('sortsel').value;
    const rows = ISSUES.filter(i => (!filter || i.st === filter) && (!q || i.title.toLowerCase().includes(q) || ('#' + i.id).includes(q)));
    rows.sort((a, b) => mode === 'asc' ? a.id - b.id : b.id - a.id);
    document.getElementById('gcount').textContent = rows.length + ' 单';
    document.getElementById('ilist').innerHTML = rows.map(i => `
      <div class="irow ${sel === i.id ? 'sel' : ''}" data-st="${i.st}" data-id="${i.id}">
        <span class="st">${i.st}</span><span class="id">#${i.id}</span><span class="tt">${i.title}</span>
      </div>`).join('') || '<div class="sub">没有匹配的 issue</div>';
    document.querySelectorAll('#ilist .irow').forEach(e => {
      e.onclick = () => { sel = +e.dataset.id; renderList(); renderReport(); };
    });
  }
  document.getElementById('sortsel').onchange = renderList;
  document.getElementById('search').oninput = renderList;

  function renderReport(){
    const it = ISSUES.find(i => i.id === sel);
    document.getElementById('report').innerHTML = it ? `
      <h3>#${it.id} ${it.title}</h3>
      <div class="meta"><span>${it.st}</span><span>副本 .code-studio/worktrees/issue-${it.id}</span></div>
      <div class="ops"><button class="primary">合并</button><button>中止</button></div>
      <pre>${it.report}</pre>` : '<div class="empty">未选中 issue</div>';
  }
  renderList();
})();
