/**
 * Browser half of dsh-plugin-code-studio.
 *
 * One settings page: 「代码工作室 · 角色模型」. It lets you pin a provider + model
 * (and reasoning effort) to each of the thirteen studio roles, so the tech-lead
 * Agent can hand those routes to `code_dispatch` when it dispatches — 这样每个子
 * Agent 用你指定的模型跑，而不是统统继承父 Agent 的模型。
 *
 * Everything the page reads and writes goes through the Host:
 *   - `configForms.get('code-studio-agent-models')` — the settings section owned
 *     by this package's `./agent-models` entry (read via the describe mirror,
 *     written through `remote.settings.mutate`).
 *   - `remote.session.modelCatalog()` — the deployment's provider/model catalog.
 *
 * The namespace string is spelled out rather than imported: a client bundle must
 * not depend on a Host package.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-code-studio',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace of this bundle's copy. */
    const NS = 'codeStudio.agentModels';
    /** Settings entry id: the `id:` of the `code-studio-agent-models` row in cordis.patch.yml. */
    const SETTINGS_NS = 'code-studio-agent-models';
    /** Must match ROLE_IDS in lib/index.js and lib/agent-models.js. */
    const ROLE_IDS = [
      'tech-lead', 'architect', 'contract', 'design', 'impact',
      'implementer', 'reviewer', 'security', 'test', 'fixer', 'archivist',
      'gopher', 'librarian',
    ];

    const zh = {
      nav: '代码角色模型',
      title: '角色模型指派',
      description: '给代码工作室的每个角色固定 provider 与模型。开启后，技术总监派单时会把这些参数原样传给子 Agent。',
      enabled: '按角色指定子 Agent 模型',
      enabledHint: '关闭时所有角色继承父 Agent 的模型。仅影响新会话：已经开始的会话保持原样。',
      roles: '角色模型指派',
      rolesHint: '留空 = 该角色继承父 Agent。只填 provider 与 model 是必填项。',
      provider: '提供方',
      model: '模型',
      effort: '推理强度',
      inherit: '继承父 Agent',
      clear: '清除',
      loading: '正在读取模型目录…',
      loadFailed: '模型目录读取失败。',
      partial: '部分提供方读取失败，列表可能不完整。',
      retry: '重试',
      unavailable: '这个插件当前未加载，暂时无法配置。',
      readOnly: '当前部署以只读方式保存设置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '部署没有接受这些值，请修正后重试。',
      discard: '放弃修改',
      conflict: '设置已在其他位置更新。请放弃修改后重试。',
      saved: '已保存。',
      summary: '为代码工作室的十三个角色分别指定模型。',
      promptPreview: '派单提示预览',
      'role.tech-lead': '技术总监',
      'role.architect': '架构',
      'role.contract': '契约',
      'role.design': '设计',
      'role.impact': '影响推演',
      'role.implementer': '实现',
      'role.reviewer': '审校',
      'role.security': '安全审计',
      'role.test': '测试工程',
      'role.fixer': '修复',
      'role.archivist': '档案',
      'role.gopher': '杂役',
      'role.librarian': '文档同步员',
      issueTab: '工作室',
      issueColIssues: 'Issues',
      issueColReport: '报告',
      issueColTree: '工作树',
      issueLoading: '正在读取 .codewrite…',
      issueEmpty: '这个工作区还没有 issue。',
      issuePick: '点左边一条 issue 看报告与工作树。',
      issueNoReport: '这条还没有报告（还没跑到或没产出）。',
      issueRefresh: '刷新',
      issueRegion: '区域',
      issueFolders: '文件夹',
      issueStatus: '状态',
      issueWatchOn: '监听：开',
      issueWatchOff: '监听：关',
      issueWatchEnable: '开启监听',
      issueWatchDisable: '关闭监听',
      issueWatchScan: '扫描收件',
      issueGithub: 'GitHub 源',
      issueGithubNone: '未绑定',
      issueGithubEnabled: '已绑定',
      issueGithubPlaceholder: 'owner/repo 或 GitHub URL',
      issueGithubBind: '绑定',
      issueGithubOff: '解绑',
      issuePat: 'PAT',
      issuePatPlaceholder: 'ghp_… 粘贴后回车保存',
      issuePatSave: '保存 PAT',
      issuePatClear: '清除',
      issuePatStored: '已存',
      issuePatNone: '未存',
    };

    const en = {
      nav: 'Code role models',
      title: 'Role model assignments',
      description: 'Pin a provider and model to each code-studio role. When enabled, the tech lead passes these routes through to subagents.',
      enabled: 'Assign a model per role',
      enabledHint: 'When off, every role inherits the parent Agent model. Only affects new sessions; running sessions keep their own choice.',
      roles: 'Role assignments',
      rolesHint: 'Leave a role empty to inherit the parent Agent. Provider and model are both required.',
      provider: 'Provider',
      model: 'Model',
      effort: 'Reasoning effort',
      inherit: 'Inherit from parent',
      clear: 'Clear',
      loading: 'Loading the model catalog…',
      loadFailed: 'Could not load the model catalog.',
      partial: 'Some providers failed to load; the list may be incomplete.',
      retry: 'Retry',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      discard: 'Discard',
      conflict: 'Settings changed elsewhere. Discard your edits and try again.',
      saved: 'Saved.',
      summary: 'Assign a model to each of the thirteen studio roles.',
      promptPreview: 'Dispatch prompt preview',
      'role.tech-lead': 'Tech lead',
      'role.architect': 'Architect',
      'role.contract': 'Contract',
      'role.design': 'Design',
      'role.impact': 'Impact',
      'role.implementer': 'Implementer',
      'role.reviewer': 'Reviewer',
      'role.security': 'Security',
      'role.test': 'Test',
      'role.fixer': 'Fixer',
      'role.archivist': 'Archivist',
      'role.gopher': 'Gopher',
      'role.librarian': 'Librarian',
      issueTab: 'Studio',
      issueColIssues: 'Issues',
      issueColReport: 'Report',
      issueColTree: 'Tree',
      issueLoading: 'Reading .codewrite…',
      issueEmpty: 'No issues in this workspace yet.',
      issuePick: 'Pick an issue on the left to see its report and working tree.',
      issueNoReport: 'No report yet (not run, or produced nothing).',
      issueRefresh: 'Refresh',
      issueRegion: 'Region',
      issueFolders: 'Folders',
      issueStatus: 'Status',
      issueWatchOn: 'Watch: on',
      issueWatchOff: 'Watch: off',
      issueWatchEnable: 'Enable watch',
      issueWatchDisable: 'Disable watch',
      issueWatchScan: 'Scan inbox',
      issueGithub: 'GitHub source',
      issueGithubNone: 'not bound',
      issueGithubEnabled: 'bound',
      issueGithubPlaceholder: 'owner/repo or GitHub URL',
      issueGithubBind: 'Bind',
      issueGithubOff: 'Unbind',
      issuePat: 'PAT',
      issuePatPlaceholder: 'ghp_… paste and press Enter',
      issuePatSave: 'Save PAT',
      issuePatClear: 'Clear',
      issuePatStored: 'saved',
      issuePatNone: 'not set',
    };

    /** Role display names, keyed by role id. */
    const ROLE_LABELS = {
      zh: {
        'tech-lead': '技术总监',
        architect: '架构',
        contract: '契约',
        design: '设计',
        impact: '影响推演',
        implementer: '实现',
        reviewer: '审校',
        security: '安全审计',
        test: '测试工程',
        fixer: '修复',
        archivist: '档案',
        gopher: '杂役',
        librarian: '文档同步员',
      },
      en: {
        'tech-lead': 'Tech lead',
        architect: 'Architect',
        contract: 'Contract',
        design: 'Design',
        impact: 'Impact',
        implementer: 'Implementer',
        reviewer: 'Reviewer',
        security: 'Security',
        test: 'Test',
        fixer: 'Fixer',
        archivist: 'Archivist',
        gopher: 'Gopher',
        librarian: 'Librarian',
      },
    };

    //#region styles
    const css = [
      '.dsh-code-am-root{display:flex;flex-direction:column;gap:16px;min-width:0;padding:4px 0 16px}',
      '.dsh-code-am-head{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dsh-code-am-title{color:var(--dsw-alias-label-primary);margin:0;font-size:15px;font-weight:600;line-height:1.5}',
      '.dsh-code-am-desc{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px;line-height:1.6}',
      '.dsh-code-am-card{border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);display:flex;flex-direction:column;gap:12px;padding:12px 14px}',
      '.dsh-code-am-toggle{display:flex;align-items:flex-start;gap:10px}',
      '.dsh-code-am-toggle input{margin-top:3px;flex:none}',
      '.dsh-code-am-toggle span{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.dsh-code-am-toggle strong{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500}',
      '.dsh-code-am-toggle em{color:var(--dsw-alias-label-tertiary);font-size:12px;font-style:normal;line-height:1.6}',
      '.dsh-code-am-sub{color:var(--dsw-alias-label-primary);margin:0;font-size:13px;font-weight:600}',
      '.dsh-code-am-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.6}',
      '.dsh-code-am-rows{display:flex;flex-direction:column;gap:8px;min-width:0}',
      '.dsh-code-am-row{display:grid;grid-template-columns:96px minmax(0,1fr) minmax(0,1fr) minmax(0,150px) 54px;gap:8px;align-items:center;min-width:0}',
      '.dsh-code-am-role{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}',
      '.dsh-code-am-select{height:32px;min-width:0;width:100%;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary);font-size:13px;padding:0 8px}',
      '.dsh-code-am-select:disabled{opacity:.4;cursor:default}',
      '.dsh-code-am-clear{height:28px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;padding:0 8px;cursor:pointer}',
      '.dsh-code-am-clear:hover:enabled{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-code-am-clear:disabled{opacity:.35;cursor:default}',
      '.dsh-code-am-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dsh-code-am-btn{height:36px;border-radius:var(--dsw-radius-md);border:none;padding:0 14px;font-size:14px;cursor:pointer}',
      '.dsh-code-am-btn.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dsh-code-am-btn.primary:hover:enabled{background:var(--dsw-alias-button-primary-hover)}',
      '.dsh-code-am-btn.ghost{background:transparent;color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l3)}',
      '.dsh-code-am-btn:disabled{opacity:.4;cursor:default}',
      '.dsh-code-am-status{font-size:12px;line-height:1.6}',
      '.dsh-code-am-status.ok{color:var(--dsw-alias-state-success-primary)}',
      '.dsh-code-am-status.err{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-code-am-status.warn{color:var(--dsw-alias-state-warn-label)}',
      '.dsh-code-am-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.6;margin:0}',
      '.dsh-code-am-preview{margin:0;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7;font-family:inherit}',
      // ---- Issue tab（会话视图三栏）----
      '.dsh-code-iss-root{display:flex;flex-direction:column;height:100%;min-height:0;gap:0;color:var(--dsw-alias-label-primary)}',
      '.dsh-code-iss-bar{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none}',
      '.dsh-code-iss-bar h3{margin:0;font-size:14px;font-weight:600}',
      '.dsh-code-iss-bar .dsh-code-iss-count{color:var(--dsw-alias-label-tertiary);font-size:12px}',
      '.dsh-code-iss-bar button{height:28px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}',
      '.dsh-code-iss-bar button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-code-iss-watch{margin-left:auto;display:flex;align-items:center;gap:8px}',
      '.dsh-code-iss-watch .state{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-code-iss-watch .state.on{color:var(--dsw-alias-state-success-primary)}',
      '.dsh-code-iss-watch button{margin-left:0}',
      '.dsh-code-iss-gh{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;font-size:12px}',
      '.dsh-code-iss-gh b{font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.dsh-code-iss-gh .repo{color:var(--dsw-alias-label-tertiary)}',
      '.dsh-code-iss-gh .repo.on{color:var(--dsw-alias-state-success-primary)}',
      '.dsh-code-iss-gh input{flex:1;min-width:120px;height:26px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px}',
      '.dsh-code-iss-gh button{height:26px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;margin-left:0}',
      '.dsh-code-iss-gh button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-code-iss-pat{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;font-size:12px}',
      '.dsh-code-iss-pat b{font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.dsh-code-iss-pat .state{color:var(--dsw-alias-label-tertiary)}',
      '.dsh-code-iss-pat .state.on{color:var(--dsw-alias-state-success-primary)}',
      '.dsh-code-iss-pat input{flex:1;min-width:120px;height:26px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px}',
      '.dsh-code-iss-pat button{height:26px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;margin-left:0}',
      '.dsh-code-iss-pat button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-code-iss-cols{display:grid;grid-template-columns:260px minmax(0,1fr) minmax(0,320px);min-height:0;flex:1}',
      '.dsh-code-iss-col{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:auto}',
      '.dsh-code-iss-col + .dsh-code-iss-col{border-left:.5px solid var(--dsw-alias-border-l3)}',
      '.dsh-code-iss-head{position:sticky;top:0;padding:8px 12px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-settings-card-fill);border-bottom:.5px solid var(--dsw-alias-border-l3);z-index:1}',
      '.dsh-code-iss-list{display:flex;flex-direction:column}',
      '.dsh-code-iss-item{padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);cursor:pointer;display:flex;flex-direction:column;gap:3px}',
      '.dsh-code-iss-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-code-iss-item.sel{background:var(--dsw-alias-interactive-bg-selected, var(--dsw-alias-interactive-bg-hover))}',
      '.dsh-code-iss-item .id{font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.dsh-code-iss-item .title{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-code-iss-item .meta{display:flex;gap:6px;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-code-iss-tag{padding:1px 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3);font-size:10px}',
      '.dsh-code-iss-tag.done{color:var(--dsw-alias-state-success-primary)}',
      '.dsh-code-iss-tag.run{color:var(--dsw-alias-state-warn-label)}',
      '.dsh-code-iss-tag.fail{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-code-iss-body{padding:10px 12px;font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary)}',
      '.dsh-code-iss-sub{padding:8px 12px 2px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-code-iss-kv{padding:2px 12px;font-size:12px;display:flex;gap:8px}',
      '.dsh-code-iss-kv b{font-weight:500;color:var(--dsw-alias-label-tertiary);min-width:56px}',
      '.dsh-code-iss-empty{padding:16px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.7}',
    ].join('');
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-plugin-code-studio/agent-models"]') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-plugin-code-studio';
      tag.dataset.pluginCss = 'dsh-plugin-code-studio/agent-models';
      tag.textContent = css;
      document.head.appendChild(tag);
    }
    //#endregion

    //#region helpers
    const sameRoute = (a, b) => (a?.provider ?? '') === (b?.provider ?? '')
      && (a?.model ?? '') === (b?.model ?? '')
      && (a?.reasoningEffort ?? '') === (b?.reasoningEffort ?? '');

    /** Read `{ role: route }` out of a settings value, dropping unusable rows. */
    function rowsFromValue(value) {
      const rows = {};
      for (const raw of Array.isArray(value?.assignments) ? value.assignments : []) {
        const role = typeof raw?.role === 'string' ? raw.role : '';
        if (!ROLE_IDS.includes(role)) continue;
        const provider = typeof raw?.provider === 'string' ? raw.provider : '';
        const model = typeof raw?.model === 'string' ? raw.model : '';
        if (!provider || !model) continue;
        const reasoningEffort = typeof raw?.reasoningEffort === 'string' ? raw.reasoningEffort : '';
        rows[role] = { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
      }
      return rows;
    }

    /** Serialize draft rows back into the wire shape, in canonical role order. */
    function assignmentsFromRows(enabled, rows) {
      if (!enabled) return [];
      const out = [];
      for (const role of ROLE_IDS) {
        const row = rows[role];
        if (!row?.provider || !row?.model) continue;
        out.push({
          role,
          provider: row.provider,
          model: row.model,
          ...(row.reasoningEffort ? { reasoningEffort: row.reasoningEffort } : {}),
        });
      }
      return out;
    }
    //#endregion

    //#region controller
    /**
     * Draft state for the role-model form. Owns the catalog fetch, the staged
     * rows, and the revision fence the save carries.
     */
    class AgentModelsController {
      constructor(scope, ctx) {
        this.scope = scope;
        this.ctx = ctx;
        this.listeners = new Set();
        this.disposed = false;
        this.catalogStatus = 'idle';
        this.catalogGroups = [];
        this.catalogPartial = false;
        this.enabledDraft = false;
        this.rows = {};
        this.baseRevision = undefined;
        this.dirty = false;
        this.saving = false;
        this.failed = false;
        this.conflicted = false;
        this.justSaved = false;
        const snapshot = scope.getSnapshot();
        if (snapshot?.status === 'ready') this.adopt(snapshot);
        this.unsubscribe = scope.subscribe(() => {
          const next = scope.getSnapshot();
          if (next?.status !== 'ready') {
            this.emit();
            return;
          }
          if (this.dirty && next.revision !== this.baseRevision) this.conflicted = true;
          if (!this.dirty) this.adopt(next);
          this.emit();
        });
      }

      /** Take the Host value as the new draft baseline. */
      adopt(snapshot) {
        this.enabledDraft = snapshot.value?.enabled === true;
        this.rows = rowsFromValue(snapshot.value);
        this.baseRevision = snapshot.revision;
        this.dirty = false;
        this.conflicted = false;
        this.justSaved = false;
        // A form that mounts already enabled still needs the provider catalog.
        if (this.enabledDraft && this.catalogStatus === 'idle') void this.loadCatalog();
      }

      subscribe(listener) {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      }

      emit() {
        for (const listener of [...this.listeners]) listener();
      }

      snapshot() {
        const host = this.scope.getSnapshot();
        const ready = host?.status === 'ready';
        const writable = ready && host.writable === true;
        const assignedCount = Object.keys(rowsFromValue({ assignments: assignmentsFromRows(this.enabledDraft, this.rows) })).length;
        return {
          status: host?.status ?? 'unavailable',
          writable,
          enabled: this.enabledDraft,
          rows: this.rows,
          dirty: this.dirty || this.justSaved,
          invalid: this.enabledDraft && assignedCount === 0,
          saving: this.saving,
          failed: this.failed,
          conflicted: this.conflicted,
          justSaved: this.justSaved,
          catalogStatus: this.catalogStatus,
          catalogGroups: this.catalogGroups,
          catalogPartial: this.catalogPartial,
          assignedCount,
        };
      }

      /** Look up a role's staged route. */
      route(role) {
        return this.rows[role];
      }

      setEnabled(next) {
        this.enabledDraft = next === true;
        this.touch();
      }

      setRoute(role, patch) {
        const current = this.rows[role];
        const merged = { ...(current ?? {}), ...patch };
        // Changing the provider invalidates the model (and the effort) below it.
        if ('provider' in patch && patch.provider !== current?.provider) {
          merged.model = '';
          merged.reasoningEffort = '';
        }
        if ('model' in patch && patch.model !== current?.model) merged.reasoningEffort = '';
        // Keep half-filled rows: a provider picked before its model must stay
        // selectable, otherwise the dropdown snaps back to 继承 and the click
        // looks ignored. `assignmentsFromRows` drops incomplete rows on save.
        if (!merged.provider && !merged.model) {
          delete this.rows[role];
        } else {
          this.rows[role] = merged;
        }
        this.touch();
      }

      clearRoute(role) {
        delete this.rows[role];
        this.touch();
      }

      /** Mark the draft dirty and subscribe the catalog once the form is live. */
      touch() {
        this.dirty = true;
        this.failed = false;
        this.justSaved = false;
        if (this.enabledDraft && this.catalogStatus === 'idle') void this.loadCatalog();
        this.emit();
      }

      async loadCatalog() {
        if (this.disposed || this.catalogStatus === 'loading') return;
        this.catalogStatus = 'loading';
        this.emit();
        try {
          const response = await this.ctx.remote.session.modelCatalog();
          if (this.disposed) return;
          if (response?.ok) {
            this.catalogGroups = Array.isArray(response.value?.groups) ? response.value.groups : [];
            this.catalogPartial = (response.value?.failures?.length ?? 0) > 0;
            this.catalogStatus = 'ready';
          } else {
            this.catalogStatus = 'error';
          }
        } catch {
          if (!this.disposed) this.catalogStatus = 'error';
        }
        this.emit();
      }

      retryCatalog() {
        this.catalogStatus = 'idle';
        void this.loadCatalog();
      }

      discard() {
        const snapshot = this.scope.getSnapshot();
        if (snapshot?.status === 'ready') this.adopt(snapshot);
        else {
          this.rows = {};
          this.enabledDraft = false;
          this.dirty = false;
        }
        this.failed = false;
        this.emit();
      }

      async save() {
        const host = this.scope.getSnapshot();
        if (host?.status !== 'ready' || host.writable !== true || this.saving) return;
        if (!this.dirty) return;
        const assignments = assignmentsFromRows(this.enabledDraft, this.rows);
        if (this.enabledDraft && assignments.length === 0) return;
        if (host.revision !== this.baseRevision) {
          this.conflicted = true;
          this.emit();
          return;
        }
        this.saving = true;
        this.failed = false;
        this.emit();
        try {
          const response = await this.scope.mutate([
            { op: 'set', path: ['enabled'], value: this.enabledDraft === true },
            { op: 'set', path: ['assignments'], value: assignments },
          ], this.baseRevision);
          if (this.disposed) return;
          this.saving = false;
          if (response === false) {
            this.failed = true;
          } else {
            const after = this.scope.getSnapshot();
            if (after?.status === 'ready') this.adopt(after);
            this.justSaved = true;
          }
        } catch {
          if (!this.disposed) {
            this.saving = false;
            this.failed = true;
          }
        }
        this.emit();
      }

      dispose() {
        this.disposed = true;
        this.unsubscribe?.();
        this.listeners.clear();
      }
    }
    //#endregion

    //#region view
    /** Every model of one provider group. */
    function groupModels(group) {
      return Array.isArray(group?.models) ? group.models : [];
    }

    /** The catalog entry backing a provider/model pair, when it still exists. */
    function findModel(groups, provider, model) {
      const group = groups.find((candidate) => candidate?.id === provider);
      return group === undefined ? undefined : groupModels(group).find((candidate) => candidate?.id === model);
    }

    function ProviderSelect({ t, groups, value, disabled, onChange }) {
      const options = [h('option', { key: '', value: '' }, t('inherit'))];
      for (const group of groups) {
        options.push(h('option', { key: group.id, value: group.id }, group.name ?? group.id));
      }
      return h('select', {
        className: 'dsh-code-am-select',
        value: value ?? '',
        disabled,
        'aria-label': t('provider'),
        onChange: (event) => onChange(event.target.value),
      }, options);
    }

    function ModelSelect({ t, models, value, disabled, onChange }) {
      const options = [h('option', { key: '', value: '' }, t('inherit'))];
      for (const model of models) {
        options.push(h('option', { key: model.id, value: model.id }, model.name ?? model.id));
      }
      return h('select', {
        className: 'dsh-code-am-select',
        value: value ?? '',
        disabled,
        'aria-label': t('model'),
        onChange: (event) => onChange(event.target.value),
      }, options);
    }

    function EffortSelect({ t, efforts, value, disabled, onChange }) {
      const options = [h('option', { key: '', value: '' }, t('inherit'))];
      for (const effort of efforts) {
        options.push(h('option', { key: effort.id, value: effort.id }, effort.name ?? effort.id));
      }
      return h('select', {
        className: 'dsh-code-am-select',
        value: value ?? '',
        disabled,
        'aria-label': t('effort'),
        onChange: (event) => onChange(event.target.value),
      }, options);
    }

    function AgentModelsSection(props) {
      const { controller, t, locale } = props;
      const useSnapshot = () => {
        const [, bump] = React.useState(0);
        React.useEffect(() => {
          let alive = true;
          const off = controller.subscribe(() => {
            if (alive) bump((n) => n + 1);
          });
          return () => {
            alive = false;
            off();
          };
        }, []);
        return controller.snapshot();
      };
      const state = useSnapshot();
      const labels = ROLE_LABELS[locale] ?? ROLE_LABELS.zh;

      const toggle = h('div', { className: 'dsh-code-am-toggle' },
        h('input', {
          type: 'checkbox',
          id: 'dsh-code-am-enabled',
          checked: state.enabled,
          disabled: !state.writable,
          onChange: (event) => controller.setEnabled(event.target.checked),
        }),
        h('span', null,
          h('label', { htmlFor: 'dsh-code-am-enabled' }, h('strong', null, t('enabled'))),
          h('em', null, t('enabledHint'))));

      let catalogNote = null;
      if (state.enabled) {
        if (state.catalogStatus === 'loading') {
          catalogNote = h('p', { className: 'dsh-code-am-hint' }, t('loading'));
        } else if (state.catalogStatus === 'error') {
          catalogNote = h('p', { className: 'dsh-code-am-status err' },
            t('loadFailed'), ' ',
            h('button', {
              type: 'button',
              className: 'dsh-code-am-clear',
              onClick: () => controller.retryCatalog(),
            }, t('retry')));
        } else if (state.catalogPartial) {
          catalogNote = h('p', { className: 'dsh-code-am-status warn' }, t('partial'));
        }
      }

      const rows = state.enabled
        ? h('div', { className: 'dsh-code-am-rows' }, ROLE_IDS.map((role) => {
          const route = state.rows[role] ?? {};
          const group = state.catalogGroups.find((candidate) => candidate?.id === route.provider);
          const models = group === undefined ? [] : groupModels(group);
          const info = findModel(state.catalogGroups, route.provider, route.model);
          const efforts = Array.isArray(info?.reasoning?.efforts) ? info.reasoning.efforts : [];
          const lock = !state.writable;
          return h('div', { className: 'dsh-code-am-row', key: role, 'data-code-role': role },
            h('span', { className: 'dsh-code-am-role' }, labels[role] ?? role),
            h(ProviderSelect, {
              t,
              groups: state.catalogGroups,
              value: route.provider ?? '',
              disabled: lock,
              onChange: (provider) => controller.setRoute(role, { provider }),
            }),
            h(ModelSelect, {
              t,
              models,
              value: route.model ?? '',
              disabled: lock || !route.provider,
              onChange: (model) => controller.setRoute(role, { model }),
            }),
            h(EffortSelect, {
              t,
              efforts,
              value: route.reasoningEffort ?? '',
              disabled: lock || efforts.length === 0,
              onChange: (reasoningEffort) => controller.setRoute(role, { reasoningEffort }),
            }),
            h('button', {
              type: 'button',
              className: 'dsh-code-am-clear',
              disabled: lock || route.provider === undefined,
              'data-code-clear': role,
              onClick: () => controller.clearRoute(role),
            }, t('clear')));
        }))
        : h('p', { className: 'dsh-code-am-hint' }, t('rolesHint'));

      const preview = !state.enabled || state.assignedCount === 0
        ? null
        : h('div', null,
          h('p', { className: 'dsh-code-am-sub' }, t('promptPreview')),
          h('pre', { className: 'dsh-code-am-preview' },
            ['用户已在设置里为以下角色指定模型，派单时必须原样传参：']
              .concat(ROLE_IDS
                .map((role) => ({ role, route: state.rows[role] }))
                .filter((row) => row.route?.provider && row.route?.model)
                .map((row) => {
                  const effort = row.route.reasoningEffort ? `，reasoning_effort=${row.route.reasoningEffort}` : '';
                  return `- ${row.role}：provider=${row.route.provider}，model=${row.route.model}${effort}`;
                }))
              .join('\n')));

      let status = null;
      if (state.justSaved) status = h('span', { className: 'dsh-code-am-status ok' }, t('saved'));
      else if (state.failed) status = h('span', { className: 'dsh-code-am-status err' }, t('saveFailed'));
      else if (state.conflicted) status = h('span', { className: 'dsh-code-am-status err' }, t('conflict'));
      else if (state.invalid) status = h('span', { className: 'dsh-code-am-status warn' }, t('rolesHint'));

      const canSave = state.writable && state.dirty && !state.invalid && !state.saving && !state.conflicted;

      return h('div', { className: 'dsh-code-am-root' },
        h('div', { className: 'dsh-code-am-head' },
          h('h2', { className: 'dsh-code-am-title' }, t('title')),
          h('p', { className: 'dsh-code-am-desc' }, t('description'))),
        state.status !== 'ready'
          ? h('p', { className: 'dsh-code-am-empty' }, t('unavailable'))
          : h('div', { className: 'dsh-code-am-card' },
            toggle,
            !state.writable ? h('p', { className: 'dsh-code-am-status warn' }, t('readOnly')) : null,
            catalogNote,
            h('div', null,
              h('p', { className: 'dsh-code-am-sub' }, t('roles')),
              rows),
            preview),
        h('div', { className: 'dsh-code-am-foot' },
          h('button', {
            type: 'button',
            className: 'dsh-code-am-btn primary',
            disabled: !canSave,
            'data-code-save': 'true',
            onClick: () => void controller.save(),
          }, state.saving ? t('saving') : t('save')),
          h('button', {
            type: 'button',
            className: 'dsh-code-am-btn ghost',
            disabled: !state.dirty || state.saving,
            'data-code-discard': 'true',
            onClick: () => controller.discard(),
          }, t('discard')),
          status));
    }
    //#endregion

    //#region Issue tab（conversation.view，三栏：issue 列表 / 报告 / 工作树）
    /**
     * Client-side data dir. Mirrors STUDIO_DIR in lib/studio-store.js; repeated
     * here because a client bundle must not import a Host module.
     */
    const CW_DIR = '.codewrite';

    /**
     * Read one workspace-relative JSON file for the authorizing session, or
     * undefined when absent/unreadable/bad JSON. A missing file surfaces as a
     * thrown lookup failure in some hosts and a result code in others; both
     * mean "absent" here.
     */
    async function readStudioJson(remote, sessionId, path, signal) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined;
      let result;
      try {
        result = await remote.workspaceFiles.readBytes(sessionId, path, {}, signal);
      } catch {
        return undefined;
      }
      if (result?.ok !== true) return undefined;
      try {
        return JSON.parse(new TextDecoder('utf-8').decode(result.value.data));
      } catch {
        return undefined;
      }
    }

    /**
     * Whether a GitHub PAT is stored: checks for `<repo>/.codewrite/github-token`
     * via a directory listing (the client cannot read outside the workspace file
     * tree, but `.codewrite` is inside it, so list works and the plaintext token
     * is never fetched). Absence = not stored.
     */
    async function readStudioPatPresent(remote, sessionId, signal) {
      if (typeof sessionId !== 'string' || sessionId === '') return false;
      try {
        const listing = await remote.workspaceFiles.list(sessionId, `${CW_DIR}/github-token`, signal);
        const entries = listing?.value?.entries;
        if (Array.isArray(entries) && entries.length > 0) return true;
      } catch { /* not found → absent */ }
      // Some hosts list the parent dir with contents instead; fall back to a dir scan.
      try {
        const listing = await remote.workspaceFiles.list(sessionId, CW_DIR, signal);
        const entries = listing?.value?.entries;
        if (Array.isArray(entries)) return entries.some((e) => String(e?.name ?? '') === 'github-token');
      } catch { /* absent */ }
      return false;
    }

    /** Map an issue status to a CSS class + raw label. */
    function issueTagClass(status) {
      const s = String(status ?? '').toUpperCase();
      if (s === 'DONE') return 'done';
      if (s === 'FAILED' || s === 'BLOCKED' || s === 'CANCELLED') return 'fail';
      if (s === '') return '';
      return 'run'; // READY / ASSIGNED / RUNNING / PENDING …
    }

    /**
     * The 工作室 tab: read `<repo>/.codewrite/{issues,regions}.json` through the
     * read-only workspace-files Remote and lay them out in three columns. Read
     * only — clicking an issue never asks a model; it just shows what the ledger
     * already recorded.
     */
    function IssueTab({ sessionId, remote, t }) {
      const [snap, setSnap] = React.useState({ status: 'loading', issues: [], regions: {} });
      const [sel, setSel] = React.useState(undefined);
      const [nonce, setNonce] = React.useState(0);
      const [watch, setWatch] = React.useState({ enabled: false, known: false });
      const [gh, setGh] = React.useState({ enabled: false, repo: '', known: false });
      const [ghInput, setGhInput] = React.useState('');
      const [pat, setPat] = React.useState({ hasToken: false });
      const [patInput, setPatInput] = React.useState('');
      const [busy, setBusy] = React.useState(false);

      React.useEffect(() => {
        let alive = true;
        const ac = new AbortController();
        void (async () => {
          const [issuesRaw, regionsRaw, watchRaw, ghRaw] = await Promise.all([
            readStudioJson(remote, sessionId, `${CW_DIR}/issues.json`, ac.signal),
            readStudioJson(remote, sessionId, `${CW_DIR}/regions.json`, ac.signal),
            readStudioJson(remote, sessionId, `${CW_DIR}/watch.json`, ac.signal),
            readStudioJson(remote, sessionId, `${CW_DIR}/github.json`, ac.signal),
          ]);
          if (!alive) return;
          const issues = Array.isArray(issuesRaw)
            ? issuesRaw
            : (Array.isArray(issuesRaw?.issues) ? issuesRaw.issues : []);
          const regions = regionsRaw?.regions ?? {};
          setSnap({ status: issues.length ? 'ready' : 'empty', issues, regions });
          setWatch({ enabled: watchRaw?.enabled === true, known: watchRaw !== undefined });
          setGh({ enabled: ghRaw?.enabled === true, repo: String(ghRaw?.repo ?? ''), known: ghRaw !== undefined });
          setPat({ hasToken: await readStudioPatPresent(remote, sessionId, ac.signal) });
          setSel((cur) => (cur !== undefined && issues.some((i) => String(i.id) === cur)
            ? cur
            : (issues[0] ? String(issues[0].id) : undefined)));
        })();
        return () => { alive = false; ac.abort(); };
      }, [sessionId, remote, nonce]);

      const selected = snap.issues.find((i) => String(i.id) === sel);

      // 监听开关走 Host 命令（客户端只能读、不能写文件）。命令成功后刷新台账。
      const runCommand = async (line) => {
        setBusy(true);
        try {
          await remote.commands.execute(sessionId, line, []);
        } catch { /* 命令失败：保持旧状态，用户可重试 */ }
        setBusy(false);
        setNonce((n) => n + 1);
      };
      const toggleWatch = () => runCommand(watch.enabled ? '/code-studio-watch off' : '/code-studio-watch on');
      const scanNow = () => runCommand('/code-studio-watch scan');
      const bindGithub = () => {
        const slug = ghInput.trim();
        if (!slug) return;
        void runCommand(`/code-studio-watch github ${slug}`).then(() => setGhInput(''));
      };
      const unbindGithub = () => runCommand('/code-studio-watch github off');
      const savePat = () => {
        const tk = patInput.trim();
        if (!tk) return;
        void runCommand(`/code-studio-watch token ${tk}`).then(() => setPatInput(''));
      };
      const clearPat = () => runCommand('/code-studio-watch token off');

      const bar = h('div', { className: 'dsh-code-iss-bar' },
        h('h3', null, t('issueTab')),
        h('span', { className: 'dsh-code-iss-count' }, String(snap.issues.length)),
        h('div', { className: 'dsh-code-iss-watch' },
          h('span', { className: `state${watch.enabled ? ' on' : ''}` },
            watch.known ? (watch.enabled ? t('issueWatchOn') : t('issueWatchOff')) : t('issueWatchOff')),
          h('button', { type: 'button', disabled: busy, onClick: toggleWatch },
            watch.enabled ? t('issueWatchDisable') : t('issueWatchEnable')),
          h('button', { type: 'button', disabled: busy, onClick: scanNow }, t('issueWatchScan')),
          h('button', { type: 'button', onClick: () => setNonce((n) => n + 1) }, t('issueRefresh'))));

      // GitHub 源一栏：已绑就显示仓库名 + 解绑；未绑显示输入框 + 绑定。
      const ghBar = h('div', { className: 'dsh-code-iss-gh' },
        h('b', null, t('issueGithub')),
        h('span', { className: `repo${gh.enabled ? ' on' : ''}` },
          gh.repo ? `${gh.repo} · ${gh.enabled ? t('issueGithubEnabled') : t('issueGithubNone')}` : t('issueGithubNone')),
        h('input', {
          type: 'text', value: ghInput, placeholder: t('issueGithubPlaceholder'), disabled: busy,
          onChange: (ev) => setGhInput(ev.target.value),
        }),
        h('button', { type: 'button', disabled: busy || !ghInput.trim(), onClick: bindGithub }, t('issueGithubBind')),
        gh.repo ? h('button', { type: 'button', disabled: busy, onClick: unbindGithub }, t('issueGithubOff')) : null);

      // PAT 一栏：type=password，明文只在输入框里，保存后立即清空；显示已存/未存。
      const patBar = h('div', { className: 'dsh-code-iss-pat' },
        h('b', null, t('issuePat')),
        h('span', { className: `state${pat.hasToken ? ' on' : ''}` },
          pat.hasToken ? t('issuePatStored') : t('issuePatNone')),
        h('input', {
          type: 'password', value: patInput, placeholder: t('issuePatPlaceholder'), disabled: busy,
          autoComplete: 'off',
          onChange: (ev) => setPatInput(ev.target.value),
          onKeyDown: (ev) => { if (ev.key === 'Enter') savePat(); },
        }),
        h('button', { type: 'button', disabled: busy || !patInput.trim(), onClick: savePat }, t('issuePatSave')),
        pat.hasToken ? h('button', { type: 'button', disabled: busy, onClick: clearPat }, t('issuePatClear')) : null);

      const head = h('div', null, bar, ghBar, patBar);

      if (snap.status === 'loading') {
        return h('div', { className: 'dsh-code-iss-root' }, head,
          h('div', { className: 'dsh-code-iss-empty' }, t('issueLoading')));
      }
      if (snap.status === 'empty') {
        return h('div', { className: 'dsh-code-iss-root' }, head,
          h('div', { className: 'dsh-code-iss-empty' }, t('issueEmpty')));
      }

      const listItems = snap.issues.map((issue) => {
        const id = String(issue.id);
        const tag = issueTagClass(issue.status);
        return h('div', {
          key: id,
          className: `dsh-code-iss-item${id === sel ? ' sel' : ''}`,
          onClick: () => setSel(id),
        },
          h('span', { className: 'id' }, `#${id}`),
          h('span', { className: 'title' }, issue.title || issue.body || '(untitled)'),
          h('span', { className: 'meta' },
            tag ? h('span', { className: `dsh-code-iss-tag ${tag}` }, String(issue.status ?? '')) : null,
            issue.region ? h('span', null, `@${issue.region}`) : null));
      });

      const report = selected
        ? (selected.report
          ? h('div', { className: 'dsh-code-iss-body' }, String(selected.report))
          : h('div', { className: 'dsh-code-iss-empty' }, t('issueNoReport')))
        : h('div', { className: 'dsh-code-iss-empty' }, t('issuePick'));

      const region = selected?.region ? snap.regions[selected.region] : undefined;
      const folders = region?.folders ?? (Array.isArray(selected?.folders) ? selected.folders : []);
      const changed = Array.isArray(selected?.changedFiles) ? selected.changedFiles : [];
      const tree = selected
        ? h('div', null,
          h('div', { className: 'dsh-code-iss-kv' }, h('b', null, t('issueStatus')), h('span', null, String(selected.status ?? '—'))),
          h('div', { className: 'dsh-code-iss-kv' }, h('b', null, t('issueRegion')), h('span', null, selected.region || '—')),
          folders.length
            ? h('div', null,
              h('div', { className: 'dsh-code-iss-sub' }, t('issueFolders')),
              ...folders.map((f, i) => h('div', { key: `f${i}`, className: 'dsh-code-iss-body' }, String(f))))
            : null,
          changed.length
            ? h('div', null,
              h('div', { className: 'dsh-code-iss-sub' }, 'changed'),
              ...changed.map((f, i) => h('div', { key: `c${i}`, className: 'dsh-code-iss-body' }, String(f))))
            : null)
        : h('div', { className: 'dsh-code-iss-empty' }, t('issuePick'));

      return h('div', { className: 'dsh-code-iss-root' }, head,
        h('div', { className: 'dsh-code-iss-cols' },
          h('div', { className: 'dsh-code-iss-col' },
            h('div', { className: 'dsh-code-iss-head' }, t('issueColIssues')),
            h('div', { className: 'dsh-code-iss-list' }, ...listItems)),
          h('div', { className: 'dsh-code-iss-col' },
            h('div', { className: 'dsh-code-iss-head' }, t('issueColReport')),
            report),
          h('div', { className: 'dsh-code-iss-col' },
            h('div', { className: 'dsh-code-iss-head' }, t('issueColTree')),
            tree)));
    }
    //#endregion

    const inject = ['slots', 'locale', 'remote', 'remote.session', 'remote.workspaceFiles', 'remote.commands', 'configForms'];

    /** Fallback `t` so a missing/!bound locale service degrades to raw keys. */
    function makeT(locale, dictionaries) {
      const bound = typeof locale?.bind === 'function' ? locale.bind(NS) : undefined;
      if (typeof bound === 'function') {
        return (key) => {
          const text = bound(key);
          return typeof text === 'string' && text.length > 0 && text !== key ? text : (dictionaries[key] ?? key);
        };
      }
      return (key) => dictionaries[key] ?? key;
    }

    /**
     * Read the active locale off the locale service. `getLocale()` is the
     * documented read path and returns `{ active, locales, revision }`; the
     * older shapes are kept as fallbacks so a drifted service still resolves.
     */
    function resolveLocale(locale) {
      let value;
      if (typeof locale?.getLocale === 'function') value = locale.getLocale();
      else if (typeof locale?.getSnapshot === 'function') value = locale.getSnapshot();
      else if (typeof locale?.current === 'function') value = locale.current();
      else value = locale?.current;
      const id = typeof value === 'string' ? value : value?.active ?? value?.id ?? value?.locale;
      return typeof id === 'string' && id.toLowerCase().startsWith('en') ? 'en' : 'zh';
    }

    function apply(ctx) {
      const locale = ctx.locale;
      ctx.effect(() => {
        if (locale === undefined || typeof locale.register !== 'function') return () => undefined;
        const disposer = locale.register(NS, { zh, en });
        return typeof disposer === 'function' ? disposer : () => undefined;
      }, `${NS}: dictionaries`);

      const t = makeT(locale, zh);
      const controller = new AgentModelsController(ctx.configForms.get(SETTINGS_NS), ctx);
      ctx.effect(() => () => controller.dispose(), `${NS}: form`);

      ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => {
        controller.catalogStatus = 'idle';
        void controller.loadCatalog();
      }), `${NS}: adapter invalidations`);

      ctx.effect(() => ctx.remote.$on('settings/document-updated', () => {
        if (!controller.dirty && controller.snapshot().enabled && controller.snapshot().catalogStatus === 'idle') {
          void controller.loadCatalog();
        }
      }), `${NS}: settings invalidations`);

      ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SETTINGS_NS,
        order: 60,
        label: () => makeT(locale, zh)('nav'),
        locale: NS,
      }, (props) => h(AgentModelsSection, {
        ...props,
        controller,
        t: makeT(locale, zh),
        locale: resolveLocale(locale),
      })))), `${NS}: page`);

      // Issue tab: one more Conversation target View per session. Read-only
      // view over `.codewrite/{issues,regions}.json` already on disk.
      ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'code-studio-issues',
        order: 40,
        label: () => makeT(locale, zh)('issueTab'),
        locale: NS,
        inject: (sessionId) => ({ sessionId, remote: ctx.remote, t: makeT(locale, zh) }),
      }, IssueTab)), `${NS}: issue tab`);
    }

    const exported = {
      inject,
      apply,
      /** Test hooks. The loader reads only `inject` and `apply`. */
      __ns: { NS, SETTINGS_NS, ROLE_IDS, rowsFromValue, assignmentsFromRows, AgentModelsController, AgentModelsSection, IssueTab, issueTagClass },
    };
    return exported;
  },
});
