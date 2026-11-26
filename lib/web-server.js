// lib/web-server.js — 工作室网页与 HTTP 层：intake 收件 + page/state/action 三条路由。
// 自 index.js 原样搬出（重构第⑥步）。路径解析助手（projectsRootDir/isWorkDir/sessionCwd）与 opRegistry
// 由 index 注入；merge/cancel/run 收口走 opRegistry（契约在 lib/ops.js）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, basename, isAbsolute, resolve as resolvePath } from 'node:path';
import { loadIssues } from './studio-store.js';
import { loadWatch, saveWatch, normalizeWatch, inboxDir } from './studio-watch.js';
import { parseRepoSlug, githubPublic, saveGithubTo } from './studio-github.js';
import { loadSessionGithub, loadSessionToken } from './watcher.js';
import { normalizeIssue } from './studio-intake.js';
import { PAGE_PATH, API_STATE, API_ACTION, renderStudioHtml } from './studio-web.js';
import { loadTheme, saveTheme, PRESETS } from './studio-theme.js';
import { canonicalOp, OPS } from './ops.js';
import { loadWorkspaces, authorizeWorkspace, unauthorizeWorkspace } from './studio-workspaces.js';

export function installWebServer(env) {
  const {
    ctx,
    projectsRootDir,
    isWorkDir,
    sessionCwd,
    opRegistry,
    config,
    listRepos,
    runScan,
    runGithubSync,
    ensureWatcher,
    summarizeScan,
    formatGithubResults,
    sessionStudioDir,
    saveSessionGithub,
  } = env;

  // 外置 Agent 的 HTTP 写入接口：POST /code-studio/intake
  // 让外部程序（不只丢文件）把 issue 提进某个工作区。落盘走和 inbox 同一条路：
  // 规范化后写 `<repo>/.codewrite/inbox/*.json`，由该工作区的 watcher 扫走派单。
  // 可选依赖 webServer：没有就跳过（不硬依赖 Host 版本）。
  {
    const webServer = ctx.webServer ?? ctx.get?.('webServer');
    if (webServer?.register) {
      const MAX_BODY = 64 * 1024;
      const readBody = (req) => new Promise((resolve) => {
        let buf = '';
        let over = false;
        req.on('data', (chunk) => {
          if (over) return;
          buf += chunk;
          if (buf.length > MAX_BODY) { over = true; try { req.destroy(); } catch { /* 忽略 */ } }
        });
        req.on('end', () => resolve(over ? undefined : buf));
        req.on('error', () => resolve(undefined));
      });
      const sendJson = (res, status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      const resolveRepoDir = (repo) => {
        const trimmed = typeof repo === 'string' ? repo.trim() : '';
        if (!trimmed) return sessionCwd() ?? process.cwd();
        if (isAbsolute(trimmed)) return trimmed;
        if (trimmed.includes('/') || trimmed.includes('\\')) return resolvePath(projectsRootDir(), trimmed);
        const underRoot = join(projectsRootDir(), trimmed);
        if (isWorkDir(underRoot)) return underRoot;
        return resolvePath(process.cwd(), trimmed);
      };
      const release = webServer.register({
        kind: 'prefix',
        path: '/code-studio/intake',
        handler: async (req, res) => {
          try {
            const rejection = ctx.get?.('connection')?.requestRejection?.(req);
            if (rejection) { sendJson(res, rejection.status ?? 403, { ok: false, error: rejection.message ?? 'forbidden' }); return; }
            if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: '只接受 POST' }); return; }
            const raw = await readBody(req);
            if (raw === undefined) { sendJson(res, 413, { ok: false, error: '请求体过大或读取失败' }); return; }
            let payload;
            try { payload = JSON.parse(raw || '{}'); } catch { sendJson(res, 400, { ok: false, error: 'body 不是合法 JSON' }); return; }
            const norm = normalizeIssue(payload, { idFallback: `http-${Date.now().toString(36)}` });
            if (!norm.ok) { sendJson(res, 400, { ok: false, error: '缺少必填字段', missing: norm.missing }); return; }
            const dir = resolveRepoDir(payload.repo);
            const cfg = await loadWatch(dir).catch(() => null);
            const inbox = inboxDir(dir, cfg ?? normalizeWatch({}));
            try { mkdirSync(inbox, { recursive: true }); } catch { /* 已存在 */ }
            const file = join(inbox, `http-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`);
            writeFileSync(file, JSON.stringify(norm.issue, null, 2), 'utf8');
            sendJson(res, 200, { ok: true, id: norm.issue.id, status: norm.issue.status, unrouted: norm.unrouted === true, dir, inbox, file });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      });
      if (typeof ctx.effect === 'function') ctx.effect(() => () => { try { release?.(); } catch { /* 忽略 */ } }, 'code-studio: intake endpoint');
    }
  }

  // 工作室内置网页：右侧栏 iframe 里跑的一张独立页面，样式/布局完全由插件自己控制（不吃宿主 slot 的挤压）。
  // 三条路由：GET 页面 / GET 状态 / POST 动作。同样把 webServer 当可选依赖。
  {
    const webServer = ctx.webServer ?? ctx.get?.('webServer');
    if (webServer?.register) {
      const MAX_BODY = 64 * 1024;
      const readBody = (req) => new Promise((resolve) => {
        let buf = '';
        let over = false;
        req.on('data', (chunk) => {
          if (over) return;
          buf += chunk;
          if (buf.length > MAX_BODY) { over = true; try { req.destroy(); } catch { /* 忽略 */ } }
        });
        req.on('end', () => resolve(over ? undefined : buf));
        req.on('error', () => resolve(undefined));
      });
      const sendJson = (res, status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      // 解析这次请求对应的工作区目录：优先 query.dir（iframe 会带 cwd），否则按 sid 找活 Agent 的 cwd。
      const resolveDir = (sid, dirQuery) => {
        const d = typeof dirQuery === 'string' ? dirQuery.trim() : '';
        if (d) return d;
        const agent = sid ? ctx.get?.('agents')?.get?.(sid) : undefined;
        return sessionCwd({ agent }) ?? process.cwd();
      };
      const liveAgent = (sid) => (sid ? ctx.get?.('agents')?.get?.(sid) : undefined);

      const releasePage = webServer.register({
        kind: 'prefix',
        path: PAGE_PATH,
        handler: (req, res) => {
          const rejection = ctx.get?.('connection')?.requestRejection?.(req);
          if (rejection) { sendJson(res, rejection.status ?? 403, { ok: false, error: rejection.message ?? 'forbidden' }); return; }
          const u = new URL(req.url ?? PAGE_PATH, 'http://localhost');
          const sidQ = u.searchParams.get('sid') ?? '';
          const dirQ = u.searchParams.get('dir') ?? '';
          let th = {};
          try { th = loadTheme(resolveDir(sidQ, dirQ)); } catch { /* 忽略 */ }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(renderStudioHtml({ sid: sidQ, dir: dirQ, theme: th, presets: PRESETS }));
        },
      });

      const releaseState = webServer.register({
        kind: 'prefix',
        path: API_STATE,
        handler: async (req, res) => {
          try {
            const rejection = ctx.get?.('connection')?.requestRejection?.(req);
            if (rejection) { sendJson(res, rejection.status ?? 403, { ok: false, error: rejection.message ?? 'forbidden' }); return; }
            const u = new URL(req.url ?? API_STATE, 'http://localhost');
            const sid = u.searchParams.get('sid') ?? '';
            const dir = resolveDir(sid, u.searchParams.get('dir'));
            // 多仓聚合：仓库清单 = 会话工作区（自身 + depth 2 子仓库）+ 全局授权工作区
            // （BH 场景下面板不捆绑工作区，仓库来自 ~/.dsh/code-studio/workspaces.json）。
            // 零 issue 的仓库也进 repos（仓库列表视图要有东西可点），每条 issue 带 __dir 供动作回传。
            const seen = new Set();
            const repoDirs = [];
            const repoNames = new Map();
            const addRepo = (d, name) => {
              if (typeof d !== 'string' || !d) return;
              const key = resolvePath(d).toLowerCase();
              if (seen.has(key)) return;
              seen.add(key);
              repoDirs.push(d);
              repoNames.set(key, name || basename(d));
            };
            addRepo(dir, basename(dir));
            if (typeof listRepos === 'function') {
              for (const repo of listRepos(dir)) {
                const d = typeof repo === 'string' ? repo : repo?.dir;
                addRepo(d, (typeof repo === 'object' && repo?.name) || undefined);
              }
            }
            const workspaces = loadWorkspaces();
            for (const wsRoot of workspaces) {
              addRepo(wsRoot, basename(wsRoot));
              if (typeof listRepos === 'function') {
                for (const repo of listRepos(wsRoot)) {
                  const d = typeof repo === 'string' ? repo : repo?.dir;
                  addRepo(d, (typeof repo === 'object' && repo?.name) || undefined);
                }
              }
            }
            const aggregated = [];
            const reposOut = [];
            for (const d of repoDirs) {
              const key = resolvePath(d).toLowerCase();
              const name = repoNames.get(key) || basename(d);
              const own = (await loadIssues(d).catch(() => ({ issues: [] }))).issues ?? [];
              reposOut.push({ dir: d, name, count: own.length });
              aggregated.push(...own.map((i) => ({ ...i, __dir: d, repoName: name })));
            }
            const watch = await loadWatch(dir).catch(() => null);
            const gh = await loadSessionGithub(dir, sid).catch(() => null);
            const token = await loadSessionToken(dir, sid).catch(() => '');
            sendJson(res, 200, { ok: true, dir, issues: aggregated, repos: reposOut, workspaces, watch, github: gh ? githubPublic(gh) : null, hasToken: !!token });
          } catch (error) {
            sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      });

      const releaseAction = webServer.register({
        kind: 'prefix',
        path: API_ACTION,
        handler: async (req, res) => {
          try {
            const rejection = ctx.get?.('connection')?.requestRejection?.(req);
            if (rejection) { sendJson(res, rejection.status ?? 403, { ok: false, error: rejection.message ?? 'forbidden' }); return; }
            if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: '只接受 POST' }); return; }
            const raw = await readBody(req);
            if (raw === undefined) { sendJson(res, 413, { ok: false, error: '请求体过大或读取失败' }); return; }
            let body;
            try { body = JSON.parse(raw || '{}'); } catch { sendJson(res, 400, { ok: false, error: 'body 不是合法 JSON' }); return; }
            const op = String(body.op ?? '').trim();
            const sid = String(body.sid ?? '').trim();
            const dir = resolveDir(sid, body.dir);
            const agent = liveAgent(sid);
            const needAgent = () => {
              if (!agent) { sendJson(res, 409, { ok: false, error: '该会话当前不活跃，派单/扫描需要一个活着的会话。请先在对话里说句话再试。' }); return true; }
              return false;
            };
            if (op === 'theme') {
              const next = saveTheme(dir, body.theme ?? {});
              sendJson(res, 200, { ok: true, text: '配色已保存', theme: next });
            } else if (op === 'authorize') {
              const r = authorizeWorkspace(body.wsDir);
              sendJson(res, r.ok ? 200 : 400, r.ok
                ? { ok: true, text: `已授权工作区 ${r.dir}`, dir: r.dir }
                : { ok: false, error: r.error ?? '授权失败' });
            } else if (op === 'unauthorize') {
              const r = unauthorizeWorkspace(body.wsDir);
              sendJson(res, 200, { ok: true, text: `已移除工作区 ${r.dir}`, dir: r.dir });
            } else if (op === 'scan') {
              if (needAgent()) return;
              const cfg = normalizeWatch((await loadWatch(dir)) ?? {});
              const results = await runScan(dir, agent, cfg);
              const gh = await loadSessionGithub(dir, agent);
              let ghText = '';
              if (gh?.enabled) { const r = await runGithubSync(dir, agent, gh); ghText = r?.ok ? `；GitHub：${formatGithubResults(r)}` : `；GitHub 失败（${r?.code}）`; }
              sendJson(res, 200, { ok: true, text: summarizeScan(results) + ghText });
            } else if (op === 'watchOn' || op === 'watchOff') {
              await saveWatch(dir, { enabled: op === 'watchOn' });
              if (agent) await ensureWatcher(dir, agent);
              sendJson(res, 200, { ok: true, text: op === 'watchOn' ? '本地收件监听已开。' : '本地收件监听已关。' });
            } else if (op === 'github') {
              const slug = String(body.repo ?? '').trim();
              const parsed = parseRepoSlug(slug);
              if (!parsed) { sendJson(res, 400, { ok: false, error: '仓库格式应为 owner/repo。' }); return; }
              if (!agent) { sendJson(res, 409, { ok: false, error: '需要会话活跃才能绑定。' }); return; }
              await saveSessionGithub(dir, agent, { repo: parsed, enabled: true });
              await ensureWatcher(dir, agent);
              sendJson(res, 200, { ok: true, text: `已绑定 ${parsed}，GitHub 轮询已开。` });
            } else if (op === 'githubOff') {
              if (agent) await saveSessionGithub(dir, agent, { enabled: false });
              if (agent) await ensureWatcher(dir, agent);
              sendJson(res, 200, { ok: true, text: '已关闭 GitHub 轮询。' });
            } else if (op === 'token') {
              const tok = String(body.token ?? '').trim();
              if (!tok) { sendJson(res, 400, { ok: false, error: 'PAT 为空。' }); return; }
              const sdir = await sessionStudioDir(dir, sid || agent);
              await saveGithubTo(sdir, { token: tok });
              sendJson(res, 200, { ok: true, text: 'PAT 已存（只在本机会话目录，不进版本库）。' });
            } else if (op === 'tokenOff') {
              const sdir = await sessionStudioDir(dir, sid || agent);
              await saveGithubTo(sdir, { token: '' });
              sendJson(res, 200, { ok: true, text: 'PAT 已清除。' });
            } else if (op === 'pr') {
              // 与 code_op / code_studio 同一张操作表（lib/ops.js），不再自实现。
              const id = String(body.id ?? '').trim();
              if (!id) { sendJson(res, 400, { ok: false, error: '缺少 issue id。' }); return; }
              const work = String(body.dir ?? '').trim() || dir;
              const r = await opRegistry.run('pr', { work, id, prRepo: body.prRepo, prHeadOwner: body.prHeadOwner },
                { dir: work, agent, exec: { agent } });
              sendJson(res, 200, { ok: r.ok, text: r.text });
            } else if (op === 'merge') {
              // 待合并区的手动落地：走同一张操作表（跟 code_op / code_merge 一份实现）。
              const id = String(body.id ?? '').trim();
              if (!id) { sendJson(res, 400, { ok: false, error: '缺少 issue id。' }); return; }
              const work = String(body.dir ?? '').trim() || dir;
              const r = await opRegistry.run('merge', { work, id, allowDrift: body.allowDrift === true, rebased: body.rebased === true },
                { dir: work, agent, exec: { agent } });
              sendJson(res, r.ok ? 200 : 200, { ok: r.ok, text: r.text, ...(r.ok ? {} : { error: r.text }) });
            } else if (op === 'cancel') {
              const id = String(body.id ?? '').trim();
              if (!id) { sendJson(res, 400, { ok: false, error: '缺少 issue id。' }); return; }
              const work = String(body.dir ?? '').trim() || dir;
              const r = await opRegistry.run('cancel', { work, id }, { dir: work, agent, exec: { agent } });
              sendJson(res, 200, { ok: r.ok, text: r.text });
            } else if (op === 'run') {
              // 规格化入口：外部 Agent（CLI / 别的 harness）按同一份契约调这一条。
              const name = canonicalOp(body.name ?? body.action);
              if (!name) {
                sendJson(res, 400, { ok: false, error: `未知操作：${body.name ?? '（空）'}。可用：${OPS.map((o) => o.name).join('、')}` });
                return;
              }
              const r = await opRegistry.run(name, { ...(body.args ?? {}), work: body.args?.work ?? dir }, { dir, agent, exec: { agent } });
              sendJson(res, 200, { ok: r.ok, text: r.text, ...(r.data !== undefined ? { data: r.data } : {}) });
            } else {
              sendJson(res, 400, { ok: false, error: `未知操作：${op}` });
            }
          } catch (error) {
            sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        },
      });

      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          try { releasePage?.(); } catch { /* 忽略 */ }
          try { releaseState?.(); } catch { /* 忽略 */ }
          try { releaseAction?.(); } catch { /* 忽略 */ }
        }, 'code-studio: web panel routes');
      }
    }
  }
}
