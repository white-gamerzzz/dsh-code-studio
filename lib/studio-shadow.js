/**
 * dsh-plugin-code-studio / studio-shadow —— 非 git 目录的「影子仓库」。
 *
 * 问题：用户要求「一单一副本，复制一份去改，改完合并」，但目录不在 git 工作树里时
 * 没有分支可开。往用户目录里塞 `.git` 会污染它（还可能把 node_modules 全塞进首次提交）。
 *
 * 解法：在 `<dir>/.code-studio/shadow/repo.git` 建**一个共享的 bare 仓库**，各单的副本
 * 是它下面的分支。布局：
 *   repo.git/              共享仓库（refs: base / issue-<id> / backup-<id>）
 *   issue-12/work/         #12 的副本（子会话在这里改）
 *   issue-12/idx.*         #12 的三份独立 index
 *   issue-14/work/         #14 的副本，与 #12 并行，同一个 base 分叉
 *
 * 共享仓库是「像 GitHub 那样并行分叉、合并时才发现冲突」的前提：一单一个仓库时，
 * 两份副本各有一套 base，`git merge-tree` 跨仓库根本跑不了。
 *
 * 用 `--git-dir` + `--work-tree` 指向不同工作树，每次命令用独立 `GIT_INDEX_FILE`，
 * 所以「用户目录的 index」和「各副本的 index」互不干扰。
 *
 * 落地必须用 `read-tree -u --reset`，不能用 `checkout-index -a -f`：后者不会删除
 * 已从 index 移除的文件（子会话删掉的文件会在用户目录复活，实测踩过）。
 *
 * 安全六道闸（用户 m12248 要求「一定要确保用户的文件安全」）：
 *   1. 快照只读：`add -A` 读用户目录，不写、不改、不建 `.git`。
 *   2. 副本物理隔离：子会话 cwd 钉在 `<shadow>/work`，碰不到用户目录。
 *   3. 落地前漂移检测：用户目录当前树 ≠ base 树 → 拒绝落地（有人手改过）。
 *   4. 落地前自动备份：把当前树打成一个 `backup-<issueId>` 引用（零拷贝，可还原）。
 *   5. 冲突不落地：`merge-tree` 报冲突就停，副本留着当现场。
 *   6. 体积上限：超过 500MB 直接拒（拷一份太贵），200MB 提醒用户改开 git 仓库。
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 影子仓库根（相对仓库目录）。放在 .code-studio 下，属于插件自己的地盘。 */
export const SHADOW_DIR = '.code-studio/shadow';
/** 提醒用户「改开 git 仓库」的阈值。 */
export const SIZE_WARN = 200 * 1024 * 1024;
/** 硬上限：超过就拒绝建副本。 */
export const SIZE_LIMIT = 500 * 1024 * 1024;
/** 复制副本时跳过的目录（不跳 node_modules 会拷几万个文件，且它们本来就不该进版本库）。 */
export const COPY_EXCLUDE = new Set([
  '.git', '.code-studio', '.codewrite', 'node_modules', 'dist', 'build', 'target',
  '.next', '.cache', '.turbo', '.venv', 'venv', '__pycache__', '.pytest_cache',
]);

function fwd(p) { return String(p).replace(/\\/g, '/'); }

/**
 * 递归复制目录，跳过 COPY_EXCLUDE 里的名字以及 `skipAbs` 这个绝对路径。
 *
 * 不能用 `fs.cp`：影子仓库就住在用户目录里面，`fs.cp(dir, dir/.code-studio/shadow/...)`
 * 会被 Node 直接判 EINVAL（「cannot copy ... to a subdirectory of self」）。
 */
async function copyTree(src, dest, skipAbs) {
  const skip = fwd(skipAbs).toLowerCase();
  await mkdir(dest, { recursive: true });
  const walk = async (from, to) => {
    let entries;
    try { entries = await readdir(from, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (COPY_EXCLUDE.has(entry.name)) continue;
      const srcPath = join(from, entry.name);
      if (fwd(srcPath).toLowerCase() === skip) continue; // 别把影子仓库自己拷进副本
      const destPath = join(to, entry.name);
      if (entry.isDirectory()) { await mkdir(destPath, { recursive: true }); await walk(srcPath, destPath); continue; }
      if (!entry.isFile()) continue;                     // 符号链接/设备文件跳过（副本里没意义）
      try { await copyFile(srcPath, destPath); } catch { /* 单文件失败不挡整体 */ }
    }
  };
  await walk(src, dest);
}
/** 给 git 参数加引号：`-m base snapshot for issue-12` 不加引号会被 shell 拆成多个参数，
 *  commit-tree 收到多个 tree 直接报 `fatal: must give exactly one tree`（踩过）。
 *  `^` 与 `{}` 不算安全字符：Windows 上 shell 是 cmd，`^` 是转义符，
 *  `backup-12^{tree}` 不加引号会被吃成 `backup-12{tree}` → fatal: ambiguous argument（踩过）。 */
function q(value) {
  const s = String(value);
  if (s.startsWith('-')) return s;                       // 选项原样
  return /^[A-Za-z0-9_./:@~-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
}

/** 某条 issue 的副本路径集合。仓库是共享的，只有副本与索引按 issue 分。 */
export function shadowPaths(dir, issueId) {
  const sharedRoot = join(dir, SHADOW_DIR);
  const root = join(sharedRoot, `issue-${issueId}`);   // 这一单的副本目录（discard 只删它）
  return {
    root,
    sharedRoot,
    gitDir: join(sharedRoot, 'repo.git'),              // 全目录共用一个 bare 仓库
    workDir: join(root, 'work'),
    indexBase: join(root, 'idx.base'),
    indexWork: join(root, 'idx.work'),
    indexDrift: join(root, 'idx.drift'),
    baseBranch: 'base',
    workBranch: `issue-${issueId}`,
    backupBranch: `backup-${issueId}`,
  };
}

/** 读当前 base 引用指向的 commit 与 tree。仓库或 base 不存在时返回 null。 */
async function readBase(gitDir, runCommand) {
  const commit = await git(runCommand, gitDir, ['rev-parse', '--verify', '--quiet', 'refs/heads/base']);
  if (!commit.ok || !commit.out) return null;
  const tree = await git(runCommand, gitDir, ['rev-parse', `${commit.out}^{tree}`]);
  if (!tree.ok || !tree.out) return null;
  return { commit: commit.out, tree: tree.out };
}

/**
 * 量目录体积（跳过 COPY_EXCLUDE）。用于 200MB 提醒 / 500MB 拒绝。
 * 单线程递归；只读元数据，不读文件内容。
 */
export async function measureSize(dir) {
  let total = 0;
  const walk = async (current) => {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (COPY_EXCLUDE.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      try { total += (await stat(full)).size; } catch { /* 读不到就跳过 */ }
    }
  };
  await walk(dir);
  return total;
}

/** 跑一条 git 命令；`env` 用来隔离 index。返回 {ok, out, code}。 */
async function git(runCommand, gitDir, args, { workTree, indexFile, cwd, timeoutMs = 120000 } = {}) {
  const parts = [`git --git-dir="${fwd(gitDir)}"`];
  if (workTree) parts.push(`--work-tree="${fwd(workTree)}"`);
  for (const arg of args) parts.push(q(arg));
  const res = await runCommand(parts.join(' '), {
    cwd: cwd ?? workTree ?? fwd(gitDir),
    timeoutMs,
    ...(indexFile ? { env: { GIT_INDEX_FILE: fwd(indexFile) } } : {}),
  });
  return { ok: res?.code === 0, out: String(res?.stdout ?? '').trim(), err: String(res?.stderr ?? '').trim(), code: res?.code };
}

/**
 * 建副本：确保共享仓库与 base 存在，再把 base 检出到这一单的 work 目录。
 *
 * 共享仓库是「像 GitHub 那样分叉」的关键：所有副本都从**当前** base 分叉，
 * 合并时才由 merge-tree 判冲突，派单时不预判。
 *
 * @param {string} dir 用户目录（非 git 仓库根）
 * @param {string} issueId
 * @param {Function} runCommand
 * @returns {Promise<{ok:true, shadow:object, bytes:number, warn:boolean}
 *                 | {ok:false, code:string, reason:string, bytes?:number}>}
 */
export async function createShadow(dir, issueId, runCommand) {
  if (typeof runCommand !== 'function') return { ok: false, code: 'NO_RUN_COMMAND', reason: '缺少 runCommand，无法建影子仓库。' };
  if (!dir || !existsSync(dir)) return { ok: false, code: 'NO_DIR', reason: `目录不存在：${dir}` };

  const bytes = await measureSize(dir);
  if (bytes > SIZE_LIMIT) {
    return {
      ok: false, code: 'TOO_LARGE', bytes,
      reason: `目录 ${(bytes / 1048576).toFixed(0)}MB 超过 ${SIZE_LIMIT / 1048576}MB 上限，拷一份副本太贵。请先 git init 让副本走 worktree（几乎零成本）。`,
    };
  }

  const shadow = shadowPaths(dir, issueId);
  // 只清这一单的副本目录；共享仓库里别的分支不能动（可能有并行副本在跑）。
  await rm(shadow.root, { recursive: true, force: true }).catch(() => {});
  await mkdir(shadow.workDir, { recursive: true });

  const hadRepo = existsSync(join(shadow.gitDir, 'HEAD'));
  if (!hadRepo) {
    // cwd 必须给一个**已存在**的目录：bare 仓库此刻还没建出来，拿 gitDir 当 cwd 会 ENOENT。
    const init = await git(runCommand, shadow.gitDir, ['init', '--bare', '--quiet', fwd(shadow.gitDir)], { cwd: dir });
    if (!init.ok) return { ok: false, code: 'SHADOW_INIT_FAILED', reason: init.err || 'git init 失败' };

    // 影子仓库自己就住在用户目录里（.code-studio/shadow/…），不排除会被 `add -A` 快照进去，
    // 越滚越大而且会和自己打架。bare 仓库的 info/exclude 对 --work-tree 同样生效。
    try {
      await mkdir(join(shadow.gitDir, 'info'), { recursive: true });
      await writeFile(join(shadow.gitDir, 'info', 'exclude'), [
        '.code-studio/', '.codewrite/', 'node_modules/', 'dist/', 'build/',
        'target/', '.next/', '.cache/', '.turbo/', '.venv/', 'venv/',
        '__pycache__/', '.pytest_cache/', '.git/',
      ].join('\n') + '\n', 'utf8');
    } catch { /* 写不进去只影响快照干净度，不挡建仓 */ }
  }

  // base 不存在（首次 / 被清过）→ 快照用户目录作为分叉点。全程只读用户目录。
  let base = await readBase(shadow.gitDir, runCommand);
  if (!base) {
    const snap = await git(runCommand, shadow.gitDir, ['add', '-A'], { workTree: dir, indexFile: shadow.indexBase });
    if (!snap.ok) return { ok: false, code: 'SNAPSHOT_FAILED', reason: snap.err || '快照用户目录失败' };
    const tree = await git(runCommand, shadow.gitDir, ['write-tree'], { indexFile: shadow.indexBase });
    if (!tree.ok || !tree.out) return { ok: false, code: 'SNAPSHOT_FAILED', reason: tree.err || 'write-tree 失败' };
    const baseCommit = await git(runCommand, shadow.gitDir,
      ['-c', 'user.name=code-studio', '-c', 'user.email=code-studio@local', 'commit-tree', tree.out, '-m', `base snapshot for issue-${issueId}`]);
    if (!baseCommit.ok) return { ok: false, code: 'SNAPSHOT_FAILED', reason: baseCommit.err || 'commit-tree 失败' };
    const ref = await git(runCommand, shadow.gitDir, ['update-ref', `refs/heads/${shadow.baseBranch}`, baseCommit.out]);
    if (!ref.ok) return { ok: false, code: 'SNAPSHOT_FAILED', reason: ref.err || 'update-ref base 失败' };
    base = { commit: baseCommit.out, tree: tree.out };
  }

  // 把 base 检出到副本。用 git 自己拷，不写 fs 递归复制：既快，又天然与 base 逐字节一致
  // （`fs.cp` 还会因为副本住在用户目录里被判 EINVAL，见早前踩坑）。
  const checkout = await git(runCommand, shadow.gitDir, ['read-tree', '-u', '--reset', shadow.baseBranch],
    { workTree: shadow.workDir, indexFile: shadow.indexWork });
  if (!checkout.ok) return { ok: false, code: 'CHECKOUT_FAILED', reason: checkout.err || '检出 base 到副本失败' };

  return {
    ok: true,
    bytes,
    warn: bytes > SIZE_WARN,
    shadow: {
      ...shadow,
      dir,
      issueId,
      baseCommit: base.commit,
      baseTree: base.tree,
    },
  };
}

/**
 * 把子会话在副本上的改动提交到 issue 分支。
 * 没改动就返回 ok + empty:true（不建空提交）。
 *
 * 父提交默认是**分叉点**（建副本那一刻的 base），这样 merge-tree 才能像 GitHub 一样
 * 用三方合并暴露并行撞车。若子会话已经解完冲突（opts.base 给了当前 base），
 * 就把这一笔提交成「base 合进分支」的合并提交 —— 两个父，于是再合并时是快进。
 *
 * @param {object} shadow
 * @param {Function} runCommand
 * @param {{base?:string}} [opts] base: 已解冲突时要把当前 base 记为父
 */
export async function commitShadowWork(shadow, runCommand, opts = {}) {
  const add = await git(runCommand, shadow.gitDir, ['add', '-A'], { workTree: shadow.workDir, indexFile: shadow.indexWork });
  if (!add.ok) return { ok: false, code: 'ADD_FAILED', reason: add.err || 'add -A 失败' };
  const tree = await git(runCommand, shadow.gitDir, ['write-tree'], { indexFile: shadow.indexWork });
  if (!tree.ok) return { ok: false, code: 'WRITE_TREE_FAILED', reason: tree.err || 'write-tree 失败' };
  if (tree.out === shadow.baseTree && !opts.base) return { ok: true, empty: true, tree: tree.out };

  const parents = opts.base && opts.base !== shadow.baseCommit
    ? ['-p', opts.base, '-p', shadow.baseCommit]
    : ['-p', shadow.baseCommit];
  const commit = await git(runCommand, shadow.gitDir,
    ['-c', 'user.name=code-studio', '-c', 'user.email=code-studio@local',
      'commit-tree', tree.out, ...parents, '-m', `issue-${shadow.issueId} work`]);
  if (!commit.ok) return { ok: false, code: 'COMMIT_FAILED', reason: commit.err || 'commit-tree 失败' };
  await git(runCommand, shadow.gitDir, ['update-ref', `refs/heads/${shadow.workBranch}`, commit.out]);
  return { ok: true, empty: false, tree: tree.out, commit: commit.out, base: shadow.baseCommit };
}

/**
 * 用户目录有没有被手改过（相对**当前** base 分支的树）。
 * 用独立 index 快照当前工作树，再和 base 树比。
 *
 * 基准取当前 refs/heads/base 而不是建副本时的快照：并行分叉下别的单落地后 base 会前进，
 * 若仍比旧快照，那些已落地的改动会被当成「用户手改」→ 假 USER_DRIFT 拒绝合并。
 * @returns {Promise<{drift:boolean, changed:string[], currentTree?:string, reason?:string}>}
 */
export async function detectDrift(shadow, runCommand) {
  const add = await git(runCommand, shadow.gitDir, ['add', '-A'], { workTree: shadow.dir, indexFile: shadow.indexDrift });
  if (!add.ok) return { drift: true, changed: [], reason: add.err || '快照当前工作树失败' };
  const tree = await git(runCommand, shadow.gitDir, ['write-tree'], { indexFile: shadow.indexDrift });
  if (!tree.ok) return { drift: true, changed: [], reason: tree.err || 'write-tree 失败' };

  const base = await readBase(shadow.gitDir, runCommand);
  const baseTree = base?.tree ?? shadow.baseTree;
  if (tree.out === baseTree) return { drift: false, changed: [], currentTree: tree.out };
  const diff = await git(runCommand, shadow.gitDir, ['diff-tree', '--no-commit-id', '--name-only', '-r', baseTree, tree.out]);
  return {
    drift: true,
    changed: diff.out ? diff.out.split('\n').filter(Boolean) : [],
    currentTree: tree.out,
  };
}

/**
 * 合并副本回用户目录。安全闸在这里：
 *   漂移 → 拒；冲突 → 拒（副本留现场）；成功 → 先打 backup 引用再落地。
 *
 * @param {object} shadow createShadow 返回的 shadow 对象
 * @param {Function} runCommand
 * @param {{allowDrift?:boolean, rebased?:boolean}} [opts] allowDrift=true 时手改也覆盖（调用方必须已确认）；
 *        rebased=true 表示子会话已在副本里把当前 base 解进来（冲突已解），本次提交按合并提交记两个父
 * @returns {Promise<{ok:boolean, code?:string, reason?:string, conflicts?:string[], mergedTree?:string, backup?:string}>}
 */
export async function mergeShadow(shadow, runCommand, opts = {}) {
  const current = await readBase(shadow.gitDir, runCommand);
  const committed = await commitShadowWork(shadow, runCommand,
    opts.rebased && current ? { base: current.commit } : {});
  if (!committed.ok) return committed;
  if (committed.empty) return { ok: true, code: 'NO_CHANGES', reason: '副本没有任何改动。' };

  const drift = await detectDrift(shadow, runCommand);
  if (drift.drift && opts.allowDrift !== true) {
    return {
      ok: false, code: 'USER_DRIFT',
      reason: `用户目录在派单后被改过（${drift.changed.slice(0, 5).join('、') || drift.reason || '未知文件'}），拒绝覆盖。请先确认这些改动，或显式允许覆盖。`,
      conflicts: drift.changed,
    };
  }

  // 合并计算。并行分叉下这里才第一次判冲突 —— 派单时不预判，跟 GitHub 一样。
  // git 有冲突时 merge-tree 退出码非 0（老版本可能仍返回 0，所以两处都判）。
  const merge = await git(runCommand, shadow.gitDir, ['merge-tree', '--write-tree', shadow.baseBranch, shadow.workBranch]);
  const lines = merge.out ? merge.out.split('\n').filter(Boolean) : [];
  const mergedTree = lines[0] ?? '';
  const conflictLines = lines.slice(1);
  if (!merge.ok || conflictLines.length > 0) {
    return {
      ok: false, code: 'MERGE_CONFLICT',
      reason: '副本与用户目录冲突，未落地。副本保留在 ' + shadow.workDir + ' 作为现场。',
      conflicts: conflictLines,
      mergedTree,
    };
  }

  // 落地前备份：把用户目录当前树打成引用（零拷贝，可 read-tree 还原）。
  const base = await readBase(shadow.gitDir, runCommand);
  const baseCommit = base?.commit ?? shadow.baseCommit;
  const backupCommit = await git(runCommand, shadow.gitDir,
    ['-c', 'user.name=code-studio', '-c', 'user.email=code-studio@local',
      'commit-tree', drift.currentTree ?? base?.tree ?? shadow.baseTree, '-p', baseCommit, '-m', `backup before issue-${shadow.issueId}`]);
  if (backupCommit.ok) {
    await git(runCommand, shadow.gitDir, ['update-ref', `refs/heads/${shadow.backupBranch}`, backupCommit.out]);
  }

  // 落地：read-tree -u --reset 才会传播删除（checkout-index 不会）。
  const land = await git(runCommand, shadow.gitDir, ['read-tree', '-u', '--reset', mergedTree], { workTree: shadow.dir, indexFile: shadow.indexBase });
  if (!land.ok) {
    return { ok: false, code: 'LAND_FAILED', reason: land.err || 'read-tree 落地失败', mergedTree };
  }
  // 落地后 base 前进到合并结果；两个父是「当前 base」与「这一单的提交」，这样并行分叉的
  // 历史才是真的 merge 而不是线性覆盖。别的并行副本下次合并会自动以新 base 为基准。
  const landed = await git(runCommand, shadow.gitDir,
    ['-c', 'user.name=code-studio', '-c', 'user.email=code-studio@local',
      'commit-tree', mergedTree, '-p', baseCommit, '-p', committed.commit ?? baseCommit, '-m', `merge issue-${shadow.issueId}`]);
  if (landed.ok) {
    await git(runCommand, shadow.gitDir, ['update-ref', `refs/heads/${shadow.baseBranch}`, landed.out]);
    shadow.baseCommit = landed.out;
    shadow.baseTree = mergedTree;
  }
  return { ok: true, mergedTree, backup: backupCommit.ok ? backupCommit.out : undefined };
}

/**
 * 把用户目录还原到某个备份引用（合并后不满意时用）。
 * @param {object} shadow
 * @param {Function} runCommand
 * @param {string} [ref] 默认 backup 分支
 */
export async function restoreShadow(shadow, runCommand, ref) {
  const target = ref || shadow.backupBranch;
  const tree = await git(runCommand, shadow.gitDir, ['rev-parse', `${target}^{tree}`]);
  if (!tree.ok || !tree.out) return { ok: false, code: 'NO_BACKUP', reason: `找不到备份引用 ${target}` };
  const land = await git(runCommand, shadow.gitDir, ['read-tree', '-u', '--reset', tree.out], { workTree: shadow.dir, indexFile: shadow.indexBase });
  return land.ok ? { ok: true, restored: tree.out } : { ok: false, code: 'RESTORE_FAILED', reason: land.err };
}

/** 丢掉整个影子仓库（合并成功后 / 放弃时）。用户目录不动。 */
export async function discardShadow(shadow) {
  if (!shadow?.root) return { ok: false, reason: '缺少 shadow.root' };
  try {
    await rm(shadow.root, { recursive: true, force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------------ */
/* 自检：真跑一遍 git，覆盖快照 / 副本改动 / 冲突 / 落地 / 删除传播 / 漂移 */
/* ------------------------------------------------------------------ */

async function demo() {
  const assert = (await import('node:assert/strict')).default;
  const { mkdtemp, writeFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { runCommand } = await import('./runner.js');

  const dir = await mkdtemp(join(tmpdir(), 'cs-shadow-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.txt'), 'line1\nline2\nline3\n');
  await writeFile(join(dir, 'src', 'del.txt'), 'to be deleted\n');

  const created = await createShadow(dir, '12', runCommand);
  assert(created.ok, 'createShadow ok: ' + JSON.stringify(created));
  assert(!existsSync(join(dir, '.git')), 'user dir must NOT get a .git');
  assert(created.shadow.workDir !== dir, 'copy is a separate dir');
  assert(existsSync(join(created.shadow.workDir, 'src', 'a.txt')), 'copy has user files');

  // 子会话在副本上改：改一行 + 删一个文件 + 加一个文件
  const s = created.shadow;
  await writeFile(join(s.workDir, 'src', 'a.txt'), 'line1\nCHILD\nline3\n');
  await writeFile(join(s.workDir, 'src', 'c.txt'), 'new file\n');
  await rm(join(s.workDir, 'src', 'del.txt'));

  const merged = await mergeShadow(s, runCommand);
  assert(merged.ok, 'merge ok: ' + JSON.stringify(merged));
  assert((await readFile(join(dir, 'src', 'a.txt'), 'utf8')).includes('CHILD'), 'change landed');
  assert(existsSync(join(dir, 'src', 'c.txt')), 'new file landed');
  assert(!existsSync(join(dir, 'src', 'del.txt')), 'deletion propagated (checkout-index would resurrect it)');
  assert(!existsSync(join(dir, '.git')), 'still no .git after landing');
  assert(merged.backup, 'backup ref created');

  // 备份可还原：回到合并前（del.txt 复活、c.txt 消失、a.txt 是 line2）
  const restored = await restoreShadow(s, runCommand);
  assert(restored.ok, 'restore ok');
  assert((await readFile(join(dir, 'src', 'a.txt'), 'utf8')).includes('line2'), 'restore brought back old content');
  assert(existsSync(join(dir, 'src', 'del.txt')), 'restore brought back deleted file');

  // 漂移检测：用户手改 → 拒绝落地
  await createShadow(dir, '13', runCommand);
  const s2 = shadowPaths(dir, '13');
  const c2 = await createShadow(dir, '13', runCommand);
  assert(c2.ok, 'second shadow ok');
  await writeFile(join(c2.shadow.workDir, 'src', 'a.txt'), 'line1\nCHILD2\nline3\n');
  await writeFile(join(dir, 'src', 'a.txt'), 'line1\nUSER-EDIT\nline3\n');
  const drifted = await mergeShadow(c2.shadow, runCommand);
  assert(!drifted.ok && drifted.code === 'USER_DRIFT', 'drift rejected, got ' + JSON.stringify(drifted));
  assert((await readFile(join(dir, 'src', 'a.txt'), 'utf8')).includes('USER-EDIT'), 'drift means user edit untouched');

  // 显式 allowDrift：调用方已确认覆盖，副本内容落地（用户手改被覆盖）。
  await createShadow(dir, '14', runCommand);
  const c3 = await createShadow(dir, '14', runCommand);
  assert(c3.ok, 'third shadow ok');
  await writeFile(join(c3.shadow.workDir, 'src', 'a.txt'), 'line1\nCHILD3\nline3\n');
  await writeFile(join(dir, 'src', 'a.txt'), 'line1\nUSER3\nline3\n');
  const forced = await mergeShadow(c3.shadow, runCommand, { allowDrift: true });
  assert(forced.ok, 'allowDrift lands: ' + JSON.stringify(forced));
  assert((await readFile(join(dir, 'src', 'a.txt'), 'utf8')).includes('CHILD3'), 'allowDrift overwrites user edit');

  // 无改动 → NO_CHANGES，不打空提交
  const c4 = await createShadow(dir, '15', runCommand);
  const noop = await mergeShadow(c4.shadow, runCommand);
  assert(noop.ok && noop.code === 'NO_CHANGES', 'no changes detected');

  // 体积闸
  assert(created.bytes >= 0 && created.warn === false, 'small dir does not warn');

  /* ---- 并行分叉：两个副本从同一 base 分叉，后合并的那个撞冲突（GitHub 模型） ---- */
  const pdir = await mkdtemp(join(tmpdir(), 'cs-fork-'));
  await mkdir(join(pdir, 'src'), { recursive: true });
  await writeFile(join(pdir, 'src', 'x.txt'), 'BASE\n');
  await writeFile(join(pdir, 'src', 'other.txt'), 'BASE\n');

  const fa = await createShadow(pdir, '21', runCommand);
  const fb = await createShadow(pdir, '22', runCommand);
  assert(fa.ok && fb.ok, 'two parallel copies from same base');
  assert(fa.shadow.baseCommit === fb.shadow.baseCommit, 'both forked from the same base');
  assert(fa.shadow.workDir !== fb.shadow.workDir, 'each issue has its own copy');

  // A 改别的文件 → 先合，成功且 base 前进
  await writeFile(join(fa.shadow.workDir, 'src', 'other.txt'), 'A-ONLY\n');
  const mergedA = await mergeShadow(fa.shadow, runCommand);
  assert(mergedA.ok, 'A merges cleanly: ' + JSON.stringify(mergedA));
  assert((await readFile(join(pdir, 'src', 'other.txt'), 'utf8')).includes('A-ONLY'), 'A landed');

  // B 还在跑，它的 baseTree 已过期；但 detectDrift 用当前 base → 不该报假漂移
  const driftB = await detectDrift(fb.shadow, runCommand);
  assert(!driftB.drift, 'stale baseTree must NOT count as user drift: ' + JSON.stringify(driftB));

  // B 改同一个文件 → 合并撞冲突，且不落地
  await writeFile(join(fb.shadow.workDir, 'src', 'x.txt'), 'B-VERSION\n');
  await writeFile(join(fb.shadow.workDir, 'src', 'other.txt'), 'B-VERSION\n');
  const mergedB = await mergeShadow(fb.shadow, runCommand);
  assert(!mergedB.ok && mergedB.code === 'MERGE_CONFLICT', 'B conflicts, got ' + JSON.stringify(mergedB));
  assert((await readFile(join(pdir, 'src', 'other.txt'), 'utf8')).includes('A-ONLY'), 'conflict must not land B');

  // B 在副本里解冲突（把当前 base 读进来重放自己的改动）→ 再合就通
  await git(runCommand, fb.shadow.gitDir, ['read-tree', '-u', '--reset', 'base'],
    { workTree: fb.shadow.workDir, indexFile: fb.shadow.indexWork });
  await writeFile(join(fb.shadow.workDir, 'src', 'other.txt'), 'A-ONLY\nB-ALSO\n');
  await writeFile(join(fb.shadow.workDir, 'src', 'x.txt'), 'B-VERSION\n');
  const retried = await mergeShadow(fb.shadow, runCommand, { rebased: true });
  assert(retried.ok, 'B merges after resolving: ' + JSON.stringify(retried));
  assert((await readFile(join(pdir, 'src', 'other.txt'), 'utf8')).includes('B-ALSO'), 'B resolution landed');

  // 共享仓库只有一个，副本各自一个目录
  assert(existsSync(join(pdir, SHADOW_DIR, 'repo.git')), 'one shared bare repo');
  assert(existsSync(join(pdir, SHADOW_DIR, 'issue-21')) && existsSync(join(pdir, SHADOW_DIR, 'issue-22')), 'two copy dirs');
  await discardShadow(fa.shadow);
  assert(!existsSync(fa.shadow.root) && existsSync(join(pdir, SHADOW_DIR, 'repo.git')), 'discard keeps shared repo');

  await discardShadow(s);
  await discardShadow(c2.shadow);
  await discardShadow(c3.shadow);
  await discardShadow(c4.shadow);
  await discardShadow(fb.shadow);
  assert(!existsSync(s.root), 'discard removes shadow root');

  console.log('studio-shadow: demo OK');
}

if (process.argv[1] && process.argv[1].endsWith('studio-shadow.js')) {
  demo().catch((error) => { console.error(error); process.exit(1); });
}
