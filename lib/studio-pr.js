/**
 * Studio PR —— 用本机 gh CLI 把某个 issue 的改动提成 Pull Request（「B」这条路）。
 *
 * 设计取舍（ponytail）：插件**不存任何 GitHub 凭据**。登录由用户在本机
 * `gh auth login` 完成，凭据留在 gh 自己的 hosts.yml 里，插件只调用 gh。
 * 所有 git/gh 命令走 runner.runCommand 这一条 shell 窄通道。
 *
 * 不做的事（有意留白，别在这里加）：
 *   - 不自动解冲突、不自动推 main（冲突就让 git push 自己失败，人来看）
 *   - 不写 diff/合并引擎；分支与提交交给 git
 *   - 不解析 gh 的 JSON 输出，PR 链接用正则从 stdout 抓
 */

import { runCommand } from './runner.js';

export const DEFAULT_BASE = 'main';
export const PR_BRANCH_PREFIX = 'issue/';

/** 收尾一行，避免把整段 git 输出糊到报告里。 */
function tail(text, limit = 800) {
  return String(text ?? '').trim().slice(-limit);
}

/** 默认命令通道：在 dir 下跑一条 shell 命令。测试可注入替身。 */
function shell(dir) {
  return (command, opts) => runCommand(command, { cwd: dir, timeoutMs: 180000, ...(opts ?? {}) });
}

/** gh 是否已登录。返回 { ok, text }。 */
export async function ghAuthStatus(run) {
  const r = await run('gh auth status');
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { ok: r.code === 0, text };
}

/**
 * 把 issue 的改动提成 PR。
 * @param {object} opts
 * @param {string} opts.dir      仓库目录
 * @param {object} opts.issue    至少含 { id, title?, body? }
 * @param {string} [opts.base]   目标分支，默认 main
 * @param {string} [opts.title]  PR 标题（缺省用 issue 标题）
 * @param {string} [opts.body]   PR 正文
 * @param {Function} [opts.run]  命令执行器（测试注入）
 * @returns {Promise<{ok:boolean, code?:string, reason?:string, branch?:string, url?:string}>}
 */
export async function createPr(opts) {
  const dir = opts?.dir;
  const issue = opts?.issue ?? {};
  const id = String(issue.id ?? '').trim();
  const run = opts?.run ?? shell(dir);
  const base = String(opts?.base ?? DEFAULT_BASE).trim() || DEFAULT_BASE;
  const branch = `${PR_BRANCH_PREFIX}${id}`;

  if (!id) return { ok: false, code: 'NO_ISSUE_ID', reason: 'createPr 需要 issue.id。' };
  if (!dir) return { ok: false, code: 'NO_DIR', reason: 'createPr 需要仓库目录。' };

  // 1) 必须是 git 仓库
  const inside = await run('git rev-parse --is-inside-work-tree');
  if (inside.code !== 0) return { ok: false, code: 'NOT_A_REPO', reason: `不是 git 仓库：${tail(inside.stderr ?? inside.stdout)}` };

  // 2) gh 必须已登录（凭据在 gh 自己那儿，插件不碰）
  const auth = await ghAuthStatus(run);
  if (!auth.ok) {
    return { ok: false, code: 'GH_NOT_AUTHED', reason: 'gh 未登录。请先在本机运行 `gh auth login`（选 github.com，勾选 git 凭据）。', text: auth.text };
  }

  // 3) 在 issue 分支上。当前在 base 就建分支；在别的分支就切到 issue 分支（不存在则建）。
  const cur = (await run('git rev-parse --abbrev-ref HEAD')).stdout?.trim() ?? '';
  if (cur !== branch) {
    const co = cur === base || cur === ''
      ? await run(`git checkout -b ${branch}`)
      : await run(`git checkout -B ${branch}`);
    if (co.code !== 0) return { ok: false, code: 'CHECKOUT_FAILED', reason: tail(co.stderr ?? co.stdout) };
  }

  // 4) 有改动就提交
  const st = await run('git status --porcelain');
  if (String(st.stdout ?? '').trim()) {
    await run('git add -A');
    const msg = String(opts?.title ?? issue.title ?? `issue #${id}`).replace(/"/g, '\\"');
    const cm = await run(`git commit -m "${msg}"`);
    if (cm.code !== 0) return { ok: false, code: 'COMMIT_FAILED', reason: tail(cm.stderr ?? cm.stdout) };
  }

  // 5) 推分支
  const push = await run(`git push -u origin ${branch}`);
  if (push.code !== 0) return { ok: false, code: 'PUSH_FAILED', reason: tail(push.stderr ?? push.stdout) };

  // 6) 建 PR。--fill 用提交信息兜底标题/正文；显式给了就用显式的。
  const prTitle = String(opts?.title ?? issue.title ?? `issue #${id}`).replace(/"/g, '\\"');
  const prBody = String(opts?.body ?? issue.body ?? `自动为 issue #${id} 生成的 PR。`).replace(/"/g, '\\"');
  const pr = await run(`gh pr create --base ${base} --head ${branch} --title "${prTitle}" --body "${prBody}"`);
  if (pr.code !== 0) return { ok: false, code: 'PR_FAILED', reason: tail(pr.stderr ?? pr.stdout) };

  const url = (String(pr.stdout ?? '').match(/https?:\/\/\S+/) ?? [])[0];
  return { ok: true, branch, url: url || String(pr.stdout ?? '').trim() };
}

// ---------------------------------------------------------------------------
// 自检：注入假 run，覆盖各种失败与 happy path，不触碰真 git/gh。
// ---------------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('studio-pr.js')) {
  const assert = (cond, msg) => { if (!cond) throw new Error(`studio-pr demo FAIL: ${msg}`); };

  const makeRun = (map) => async (command) => {
    for (const [needle, res] of map) if (command.includes(needle)) return { code: 0, stdout: '', stderr: '', ...res };
    return { code: 0, stdout: '', stderr: '' };
  };

  // 缺 id
  {
    const r = await createPr({ dir: '/x', issue: {}, run: makeRun([]) });
    assert(r.code === 'NO_ISSUE_ID', '缺 id 应返回 NO_ISSUE_ID');
  }
  // 不是 git 仓库
  {
    const r = await createPr({ dir: '/x', issue: { id: 7 }, run: makeRun([['rev-parse --is-inside-work-tree', { code: 128, stderr: 'not a git repo' }]]) });
    assert(r.code === 'NOT_A_REPO', '非仓库应 NOT_A_REPO');
  }
  // gh 未登录
  {
    const r = await createPr({ dir: '/x', issue: { id: 7 }, run: makeRun([
      ['rev-parse --is-inside-work-tree', { code: 0, stdout: 'true' }],
      ['gh auth status', { code: 1, stderr: 'not logged in' }],
    ]) });
    assert(r.code === 'GH_NOT_AUTHED', 'gh 未登录应 GH_NOT_AUTHED');
  }
  // happy path：在 main 上、有改动、推送成功、PR 返回链接
  {
    const r = await createPr({ dir: '/x', issue: { id: 12, title: '修登录' }, run: makeRun([
      ['rev-parse --is-inside-work-tree', { code: 0, stdout: 'true' }],
      ['gh auth status', { code: 0, stdout: 'Logged in' }],
      ['rev-parse --abbrev-ref HEAD', { code: 0, stdout: 'main\n' }],
      ['checkout -b', { code: 0 }],
      ['status --porcelain', { code: 0, stdout: ' M src/auth/login.ts\n' }],
      ['commit -m', { code: 0 }],
      ['push -u origin', { code: 0 }],
      ['gh pr create', { code: 0, stdout: 'https://github.com/o/n/pull/42\n' }],
    ]) });
    assert(r.ok === true, 'happy path 应 ok');
    assert(r.branch === 'issue/12', '分支名应为 issue/12');
    assert(r.url === 'https://github.com/o/n/pull/42', '应抓到 PR 链接');
  }
  // 推送失败
  {
    const r = await createPr({ dir: '/x', issue: { id: 9 }, run: makeRun([
      ['rev-parse --is-inside-work-tree', { code: 0, stdout: 'true' }],
      ['gh auth status', { code: 0 }],
      ['rev-parse --abbrev-ref HEAD', { code: 0, stdout: 'main\n' }],
      ['checkout -b', { code: 0 }],
      ['status --porcelain', { code: 0, stdout: '' }],
      ['push -u origin', { code: 1, stderr: 'rejected' }],
    ]) });
    assert(r.code === 'PUSH_FAILED', '推送失败应 PUSH_FAILED');
  }

  console.log('studio-pr: demo OK');
}
