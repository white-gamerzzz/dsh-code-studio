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
      issueColGraph: '工作状态图 · 区域/子 Agent',
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
      studioPanel: '工作室',
      studioLauncher: '打开工作室',
      treeEmpty: '这个区域还没有文件。',
      treeLoading: '读取中…',
      treeHint: '点文件夹展开',
      issuePr: '建 PR',
      issuePrBusy: '建 PR 中…',
      issueChanged: '改动',
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
      issueColGraph: 'Live graph · region / subagent',
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
      studioPanel: 'Studio',
      studioLauncher: 'Open studio',
      treeEmpty: 'No files in this region yet.',
      treeLoading: 'Loading…',
      treeHint: 'Click a folder to expand',
      issuePr: 'Create PR',
      issuePrBusy: 'Creating…',
      issueChanged: 'changed',
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
      // ---- 工作室：通用按钮 / 胶囊 / 输入 ----
      '.dsh-code-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:26px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer;transition:background .12s,color .12s,border-color .12s}',
      '.dsh-code-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}',
      '.dsh-code-btn:disabled{opacity:.4;cursor:default}',
      '.dsh-code-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsh-code-btn.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}',
      '.dsh-code-btn.primary:hover:enabled{background:var(--dsw-alias-button-primary-hover)}',
      '.dsh-code-chip{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3);font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.dsh-code-chip .dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#999)}',
      '.dsh-code-chip.on{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.dsh-code-chip.on .dot{background:var(--dsw-alias-state-success-primary)}',
      '.dsh-code-count{min-width:18px;height:18px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;display:inline-flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}',
      '.dsh-code-input{height:24px;padding:0 8px;min-width:110px;flex:1 1 110px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px}',
      '.dsh-code-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dsh-code-vr{width:1px;height:16px;background:var(--dsw-alias-border-l3);flex:none}',
      '.dsh-code-iss-tag{padding:1px 7px;border-radius:999px;font-size:10px;line-height:1.5;border:.5px solid currentColor}',
      '.dsh-code-iss-tag.done{color:var(--dsw-alias-state-success-primary)}',
      '.dsh-code-iss-tag.run{color:var(--dsw-alias-state-warn-label)}',
      '.dsh-code-iss-tag.fail{color:var(--dsw-alias-state-error-primary)}',
      // ---- 工作室右侧栏面板 ----
      '.dsh-code-sp{--cs-1:4px;--cs-2:8px;--cs-3:12px;--cs-4:16px;display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:12px}',
      '.dsh-code-sp-top{flex:none;display:flex;flex-direction:column;gap:var(--cs-2);padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1)}',
      '.dsh-code-sp-bar{display:flex;align-items:center;gap:var(--cs-2);min-width:0}',
      '.dsh-code-sp-bar h3{margin:0;font-size:13px;font-weight:600;letter-spacing:.01em;line-height:1.4}',
      '.dsh-code-sp-bar .branddot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:none}',
      '.dsh-code-sp-bar .grow{flex:1 1 auto;min-width:0}',
      '.dsh-code-sp-src{display:flex;align-items:center;gap:var(--cs-2);flex-wrap:wrap;min-width:0}',
      '.dsh-code-src{display:flex;align-items:center;gap:6px;min-width:0;flex:1 1 260px;flex-wrap:wrap}',
      '.dsh-code-src>.lbl{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:none}',
      '.dsh-code-src .val{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;flex:none}',
      '.dsh-code-src .val.on{color:var(--dsw-alias-state-success-primary)}',
      '.dsh-code-src>.dsh-code-input{flex:1 1 150px;min-width:90px}',
      '.dsh-code-src>button{flex:none}',
      '.dsh-code-sp-main{display:grid;grid-template-columns:minmax(180px,240px) minmax(0,1fr);grid-template-rows:minmax(0,1.15fr) minmax(0,1fr);grid-template-areas:"issues tree" "issues report";gap:0;min-height:0;flex:1}',
      '.dsh-code-sp-issues{grid-area:issues;display:flex;flex-direction:column;min-height:0;border-right:.5px solid var(--dsw-alias-border-l3)}',
      '.dsh-code-sp-tree{grid-area:tree;display:flex;flex-direction:column;min-height:0;border-bottom:.5px solid var(--dsw-alias-border-l3)}',
      '.dsh-code-sp-report{grid-area:report;display:flex;flex-direction:column;min-height:0}',
      '.dsh-code-sp-h{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:var(--cs-2);padding:8px 10px;font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-bottom:.5px solid var(--dsw-alias-border-l3)}',
      '.dsh-code-sp-scroll{overflow:auto;min-height:0;flex:1}',
      '.dsh-code-iss-list{padding:6px}',
      '.dsh-code-iss-item{position:relative;display:flex;flex-direction:column;gap:4px;padding:8px 10px 8px 14px;margin-bottom:2px;border:.5px solid transparent;border-radius:var(--dsw-radius-md);cursor:pointer;transition:background .12s,border-color .12s}',
      '.dsh-code-iss-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-code-iss-item.sel{background:var(--dsw-alias-interactive-bg-selected,var(--dsw-alias-interactive-bg-hover));border-color:var(--dsw-alias-border-l2)}',
      '.dsh-code-iss-item::before{content:"";position:absolute;left:5px;top:9px;bottom:9px;width:3px;border-radius:2px;background:var(--dsw-alias-state-idle-primary,#999)}',
      '.dsh-code-iss-item[data-status=done]::before{background:var(--dsw-alias-state-success-primary)}',
      '.dsh-code-iss-item[data-status=run]::before{background:var(--dsw-alias-state-warn-label)}',
      '.dsh-code-iss-item[data-status=fail]::before{background:var(--dsw-alias-state-error-primary)}',
      '.dsh-code-iss-item .id{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;line-height:1.4}',
      '.dsh-code-iss-item .title{font-size:12.5px;font-weight:500;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}',
      '.dsh-code-iss-item .meta{display:flex;gap:6px;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary);min-width:0}',
      '.dsh-code-iss-item .meta .region{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-code-legend{display:flex;gap:10px;margin-left:auto;align-items:center;font-weight:400}',
      '.dsh-code-legend span{display:inline-flex;align-items:center;gap:4px;font-size:10px;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-code-legend i{width:7px;height:7px;border-radius:50%;display:inline-block}',
      '.dsh-code-legend i.done{background:var(--dsw-alias-state-success-primary)}',
      '.dsh-code-legend i.run{background:var(--dsw-alias-state-warn-label)}',
      '.dsh-code-legend i.fail{background:var(--dsw-alias-state-error-primary)}',
      '.dsh-code-sp-meta{display:flex;gap:6px;flex-wrap:wrap;padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary);border-bottom:.5px solid var(--dsw-alias-border-l3)}',
      '.dsh-code-files{display:flex;flex-wrap:wrap;gap:4px;padding:8px 10px}',
      '.dsh-code-files code{font-size:10.5px;padding:1px 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      // 节点连线图（region / 子 Agent 工作状态）
      '.dsh-code-graph{width:100%;height:100%;overflow:auto;padding:6px}',
      '.dsh-code-graph svg{display:block}',
      '.dsh-code-g-edge{fill:none;stroke:var(--dsw-alias-border-l2);stroke-width:1.2;opacity:.75}',
      '.dsh-code-g-node circle{fill:var(--dsw-alias-bg-layer-2);stroke:var(--dsw-alias-border-l2);stroke-width:1;transition:stroke .12s}',
      '.dsh-code-g-node:hover circle{stroke:var(--dsw-alias-brand-primary)}',
      '.dsh-code-g-node.root circle{fill:var(--dsw-alias-interactive-bg-hover);stroke:var(--dsw-alias-border-l2)}',
      '.dsh-code-g-node .dsh-code-g-label{font-size:11px;font-weight:600;fill:var(--dsw-alias-label-primary)}',
      '.dsh-code-g-node .dsh-code-g-sub{font-size:9.5px;fill:var(--dsw-alias-label-tertiary)}',
      '.dsh-code-g-node.issue{cursor:pointer}',
      '.dsh-code-g-node.issue.done circle{fill:var(--dsw-alias-state-success-primary);stroke:var(--dsw-alias-state-success-primary)}',
      '.dsh-code-g-node.issue.run circle{fill:var(--dsw-alias-state-warn-label);stroke:var(--dsw-alias-state-warn-label);stroke-width:2;animation:dsh-code-pulse 1.4s ease-in-out infinite}',
      '.dsh-code-g-node.issue.fail circle{fill:var(--dsw-alias-state-error-primary);stroke:var(--dsw-alias-state-error-primary);stroke-width:2}',
      '.dsh-code-g-node.region circle{fill:var(--dsw-alias-bg-layer-2);stroke:var(--dsw-alias-border-l2);stroke-width:1.5}',
      '.dsh-code-g-node.region.run circle{stroke:var(--dsw-alias-state-warn-label);stroke-width:2.5;animation:dsh-code-pulse 1.4s ease-in-out infinite}',
      '.dsh-code-g-node.sel circle{stroke:var(--dsw-alias-label-primary);stroke-width:2.5}',
      '@keyframes dsh-code-pulse{0%,100%{opacity:1}50%{opacity:.5}}',
      '.dsh-code-sp-actions{display:flex;gap:6px;margin-left:auto}',
      '.dsh-code-sp-rep{padding:12px 14px;white-space:pre-wrap;word-break:break-word;line-height:1.75;color:var(--dsw-alias-label-secondary);font-size:12.5px;max-width:74ch}',
      '.dsh-code-sp-note{padding:18px 14px;color:var(--dsw-alias-label-tertiary);line-height:1.7;font-size:12px;text-align:center}',
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

    //#region studio helpers（共享：读 .codewrite/*.json、PAT 探测、状态标签）
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

    //#endregion

    //#region Studio panel（右侧栏页：issues + 工作状态图 + 报告，同屏）
    /** 截断过长的标签，避免文字溢出到相邻列。 */
    function clip(s, max) {
      const str = String(s ?? '');
      return str.length > max ? str.slice(0, max - 1) + '…' : str;
    }

    /**
     * 工作状态图：工作区(圆点) → region(圆点) → issue(小圆点)，曲线连线。
     * 用来观测哪个 region / 子Agent 在跑、跑到哪一步；不是文件树。
     *
     * 防打架（重叠）的三条几何约束：
     *  1) 分列：每层固定一个 x，同层节点只沿 y 排 → 不会横向压在一起。
     *  2) 垂直带：每个 region 占一条高度=其 issue 数×行距 的带，串行向下排，
     *     带与带之间留 ROW_GAP → region 之间、issue 之间都不重叠。
     *  3) 标签列固定预留 LABEL_W + 截断 → 文字不越界；连线从圆边出发、控制点在
     *     两列中线，走列间空白，不穿节点。整体尺寸按内容算，外层 overflow:auto。
     */
    function buildGraph(issues, regions) {
      const R_ROOT = 13;
      const R_REGION = 10;
      const R_ISSUE = 6;
      const LABEL_W = 132; // 每个圆点右侧给标签预留的宽度
      const COL_GAP = 40;  // 列间水平空白
      const ROW_GAP = 22;  // 同列相邻节点/带的垂直空白
      const PAD = 16;
      const ROW_STEP = R_ISSUE * 2 + ROW_GAP;

      const byRegion = new Map();
      for (const issue of issues) {
        const key = issue.region ? String(issue.region) : '';
        if (!byRegion.has(key)) byRegion.set(key, []);
        byRegion.get(key).push(issue);
      }
      const regionKeys = [...byRegion.keys()].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

      const bandHeights = regionKeys.map((k) => Math.max(1, byRegion.get(k).length) * ROW_STEP);
      const regionsTotalH = bandHeights.reduce((a, b) => a + b, 0) + Math.max(0, regionKeys.length - 1) * ROW_GAP;
      const contentH = Math.max(regionsTotalH, ROW_STEP);
      const totalH = contentH + PAD * 2;

      const col0 = PAD + R_ROOT;
      const col1 = col0 + R_ROOT + LABEL_W + COL_GAP;
      const col2 = col1 + R_REGION + LABEL_W + COL_GAP;
      const width = Math.max(col2 + R_ISSUE + LABEL_W + PAD, PAD * 2 + 3 * LABEL_W);

      const nodes = [];
      const edges = [];
      const rootId = '__root__';
      const rootCy = PAD + contentH / 2;
      nodes.push({ id: rootId, kind: 'root', status: '', cx: col0, cy: rootCy, r: R_ROOT, label: 'workspace', sub: `${regionKeys.length} 区域 · ${issues.length} issue` });

      let bandTop = PAD;
      for (let i = 0; i < regionKeys.length; i++) {
        const rk = regionKeys[i];
        const list = byRegion.get(rk);
        const running = list.some((x) => x.status === 'RUNNING');
        const done = list.filter((x) => x.status === 'DONE').length;
        const total = list.length;
        const bandH = bandHeights[i];
        const regionId = `region:${rk || '__none__'}`;
        const rawLabel = rk ? rk.split('+').slice(0, 2).join('+') : '(未归区)';
        nodes.push({ id: regionId, kind: 'region', status: running ? 'run' : '', cx: col1, cy: bandTop + bandH / 2, r: R_REGION, label: clip(rawLabel, 14), sub: `${done}/${total} 完成` });
        edges.push({ from: rootId, to: regionId });
        // issue 在带内垂直居中排
        const blockH = total * ROW_STEP;
        let iy = bandTop + (bandH - blockH) / 2 + ROW_STEP / 2;
        for (const issue of list) {
          const status = String(issue.status ?? '');
          const tag = status === 'DONE' ? 'done' : (status === 'FAILED' || status === 'BLOCKED' || status === 'CANCELLED') ? 'fail' : status === 'RUNNING' ? 'run' : '';
          const issueId = `issue:${String(issue.id)}`;
          nodes.push({
            id: issueId, kind: 'issue', status: tag, issueId: String(issue.id),
            cx: col2, cy: iy, r: R_ISSUE,
            label: `#${issue.id}`, sub: clip(`${status || 'READY'}${issue.role ? ' · ' + issue.role : ''}`, 18),
          });
          edges.push({ from: regionId, to: issueId });
          iy += ROW_STEP;
        }
        bandTop += bandH + ROW_GAP;
      }
      return { width, height: Math.max(totalH, 120), nodes, edges };
    }

    /** 把 buildGraph 的布局画成 SVG：圆点节点 + 圆边到圆边的贝塞尔连线。 */
    function GraphView({ graph, sel, onPick, t }) {
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      const edgeEls = graph.edges.map((e, idx) => {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (!a || !b) return null;
        const x1 = a.cx + a.r;
        const y1 = a.cy;
        const x2 = b.cx - b.r;
        const y2 = b.cy;
        const mx = (x1 + x2) / 2;
        const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
        return h('path', { key: `e${idx}`, className: 'dsh-code-g-edge', d });
      });
      const nodeEls = graph.nodes.map((n) => {
        const isSel = n.kind === 'issue' && n.issueId === sel;
        const cls = `dsh-code-g-node ${n.kind} ${n.status || ''}${isSel ? ' sel' : ''}`;
        return h('g', {
          key: n.id, className: cls, transform: `translate(${n.cx},${n.cy})`,
          onClick: n.kind === 'issue' ? () => onPick(n.issueId) : undefined,
          style: n.kind === 'issue' ? { cursor: 'pointer' } : undefined,
        },
          h('circle', { r: n.r }),
          h('text', { className: 'dsh-code-g-label', x: n.r + 9, y: n.kind === 'issue' ? 0 : -2 }, n.label),
          h('text', { className: 'dsh-code-g-sub', x: n.r + 9, y: n.kind === 'issue' ? 11 : 11 }, n.sub || ''));
      });
      return h('div', { className: 'dsh-code-graph' },
        h('svg', { width: graph.width, height: graph.height, viewBox: `0 0 ${graph.width} ${graph.height}` },
          ...edgeEls, ...nodeEls));
    }


    /**
     * 右侧栏「工作室」页：同屏四区 —— issue 列表 / 工作树（树状图）/ 报告，
     * 外加顶部的监听·GitHub·PAT 控制条和「建 PR」。只读，点选不烧 token。
     */
    function StudioPanel({ sessionId, remote, t }) {
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
          const issues = Array.isArray(issuesRaw) ? issuesRaw : (Array.isArray(issuesRaw?.issues) ? issuesRaw.issues : []);
          const regions = regionsRaw?.regions ?? {};
          setSnap({ status: issues.length ? 'ready' : 'empty', issues, regions });
          setWatch({ enabled: watchRaw?.enabled === true, known: watchRaw !== undefined });
          setGh({ enabled: ghRaw?.enabled === true, repo: String(ghRaw?.repo ?? ''), known: ghRaw !== undefined });
          setPat({ hasToken: await readStudioPatPresent(remote, sessionId, ac.signal) });
          setSel((cur) => (cur !== undefined && issues.some((i) => String(i.id) === cur)
            ? cur : (issues[0] ? String(issues[0].id) : undefined)));
        })();
        return () => { alive = false; ac.abort(); };
      }, [sessionId, remote, nonce]);

      const selected = snap.issues.find((i) => String(i.id) === sel);

      const runCommand = async (line) => {
        setBusy(true);
        try { await remote.commands.execute(sessionId, line, []); } catch { /* 失败保留旧态 */ }
        setBusy(false);
        setNonce((n) => n + 1);
      };
      const toggleWatch = () => runCommand(watch.enabled ? '/code-studio-watch off' : '/code-studio-watch on');
      const scanNow = () => runCommand('/code-studio-watch scan');
      const bindGithub = () => { const s = ghInput.trim(); if (s) void runCommand(`/code-studio-watch github ${s}`).then(() => setGhInput('')); };
      const unbindGithub = () => runCommand('/code-studio-watch github off');
      const savePat = () => { const tk = patInput.trim(); if (tk) void runCommand(`/code-studio-watch token ${tk}`).then(() => setPatInput('')); };
      const clearPat = () => runCommand('/code-studio-watch token off');
      const createPr = () => { if (selected) void runCommand(`/code-studio-watch pr ${selected.id}`); };

      const watchOn = watch.enabled === true;
      const ghBound = gh.enabled === true && !!gh.repo;

      // 顶部：品牌 + 计数 + 刷新
      const topBar = h('div', { className: 'dsh-code-sp-bar' },
        h('span', { className: 'branddot' }),
        h('h3', null, t('studioPanel')),
        h('span', { className: 'dsh-code-count' }, String(snap.issues.length)),
        h('div', { className: 'grow' }),
        h('button', { className: 'dsh-code-btn', type: 'button', title: t('issueRefresh'), onClick: () => setNonce((n) => n + 1) }, t('issueRefresh')));

      // 数据源：监听 / GitHub / PAT
      const watchChip = h('button', {
        className: `dsh-code-chip${watchOn ? ' on' : ''}`, type: 'button', disabled: busy,
        title: watchOn ? t('issueWatchDisable') : t('issueWatchEnable'), onClick: toggleWatch,
      }, h('span', { className: 'dot' }), watchOn ? t('issueWatchOn') : t('issueWatchOff'));

      const ghSrc = h('div', { className: 'dsh-code-src' },
        h('span', { className: 'lbl' }, t('issueGithub')),
        h('span', { className: `val${ghBound ? ' on' : ''}` }, gh.repo || t('issueGithubNone')),
        h('input', {
          className: 'dsh-code-input', type: 'text', value: ghInput, placeholder: t('issueGithubPlaceholder'),
          disabled: busy, onChange: (ev) => setGhInput(ev.target.value),
        }),
        h('button', { className: 'dsh-code-btn', type: 'button', disabled: busy || !ghInput.trim(), onClick: bindGithub }, t('issueGithubBind')),
        gh.repo ? h('button', { className: 'dsh-code-btn', type: 'button', disabled: busy, onClick: unbindGithub }, t('issueGithubOff')) : null);

      const patSrc = h('div', { className: 'dsh-code-src' },
        h('span', { className: 'lbl' }, t('issuePat')),
        h('span', { className: `val${pat.hasToken ? ' on' : ''}` }, pat.hasToken ? t('issuePatStored') : t('issuePatNone')),
        h('input', {
          className: 'dsh-code-input', type: 'password', value: patInput, placeholder: t('issuePatPlaceholder'),
          disabled: busy, autoComplete: 'off',
          onChange: (ev) => setPatInput(ev.target.value),
          onKeyDown: (ev) => { if (ev.key === 'Enter') savePat(); },
        }),
        h('button', { className: 'dsh-code-btn', type: 'button', disabled: busy || !patInput.trim(), onClick: savePat }, t('issuePatSave')),
        pat.hasToken ? h('button', { className: 'dsh-code-btn', type: 'button', disabled: busy, onClick: clearPat }, t('issuePatClear')) : null);

      const head = h('div', { className: 'dsh-code-sp-top' }, topBar,
        h('div', { className: 'dsh-code-sp-src' }, watchChip, h('span', { className: 'dsh-code-vr' }), ghSrc),
        h('div', { className: 'dsh-code-sp-src' }, patSrc));

      if (snap.status === 'loading') return h('div', { className: 'dsh-code-sp' }, head, h('div', { className: 'dsh-code-sp-note' }, t('issueLoading')));
      if (snap.status === 'empty') return h('div', { className: 'dsh-code-sp' }, head, h('div', { className: 'dsh-code-sp-note' }, t('issueEmpty')));

      const listItems = snap.issues.map((issue) => {
        const id = String(issue.id);
        const tag = issueTagClass(issue.status);
        return h('div', {
          key: id, className: `dsh-code-iss-item${id === sel ? ' sel' : ''}`, 'data-status': tag || '',
          onClick: () => setSel(id),
        },
          h('span', { className: 'id' }, `#${id}`),
          h('span', { className: 'title' }, issue.title || issue.body || '(untitled)'),
          h('span', { className: 'meta' },
            tag ? h('span', { className: `dsh-code-iss-tag ${tag}` }, String(issue.status ?? '')) : null,
            issue.region ? h('span', { className: 'region' }, `@${issue.region}`) : null));
      });

      const region = selected?.region ? snap.regions[selected.region] : undefined;
      const folders = region?.folders ?? (Array.isArray(selected?.folders) ? selected.folders : []);
      const changed = Array.isArray(selected?.changedFiles) ? selected.changedFiles : [];

      const report = selected
        ? (selected.report
          ? h('div', { className: 'dsh-code-sp-rep' }, String(selected.report))
          : h('div', { className: 'dsh-code-sp-note' }, t('issueNoReport')))
        : h('div', { className: 'dsh-code-sp-note' }, t('issuePick'));

      const graph = buildGraph(snap.issues, snap.regions);
      const canPr = selected && selected.status === 'DONE';

      const legend = h('div', { className: 'dsh-code-legend' },
        h('span', null, h('i', { className: 'done' }), 'DONE'),
        h('span', null, h('i', { className: 'run' }), 'RUNNING'),
        h('span', null, h('i', { className: 'fail' }), 'FAILED'));

      const metaLine = selected
        ? h('div', { className: 'dsh-code-sp-meta' },
          h('span', { className: 'dsh-code-chip' }, `${t('issueRegion')} · ${selected.region || '—'}`),
          folders.length ? h('span', { className: 'dsh-code-chip' }, `${t('issueFolders')} · ${folders.join(', ')}`) : null)
        : null;

      return h('div', { className: 'dsh-code-sp' }, head,
        h('div', { className: 'dsh-code-sp-main' },
          h('div', { className: 'dsh-code-sp-issues' },
            h('div', { className: 'dsh-code-sp-h' }, t('issueColIssues')),
            h('div', { className: 'dsh-code-sp-scroll dsh-code-iss-list' }, ...listItems)),
          h('div', { className: 'dsh-code-sp-tree' },
            h('div', { className: 'dsh-code-sp-h' },
              t('issueColGraph'),
              legend,
              h('div', { className: 'dsh-code-sp-actions' },
                h('button', { className: 'dsh-code-btn primary', type: 'button', disabled: busy || !canPr, onClick: createPr },
                  busy ? t('issuePrBusy') : t('issuePr')))),
            metaLine,
            h('div', { className: 'dsh-code-sp-scroll' },
              h(GraphView, { graph, sel, onPick: setSel, t }))),
          h('div', { className: 'dsh-code-sp-report' },
            h('div', { className: 'dsh-code-sp-h' }, t('issueColReport')),
            changed.length ? h('div', { className: 'dsh-code-files' }, ...changed.map((f, ix) => h('code', { key: ix }, String(f)))) : null,
            h('div', { className: 'dsh-code-sp-scroll' }, report))));
    }

    /** 左侧栏底部的启动按钮：打开工作室右侧栏页。 */
    function StudioLauncher({ wide, openWorkspace }) {
      return h('button', {
        type: 'button', title: '打开工作室', 'aria-label': '打开工作室',
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '8px',
          width: wide ? '100%' : 36, minHeight: 36, justifyContent: wide ? 'flex-start' : 'center',
          border: 0, borderRadius: 8, background: 'transparent', color: 'inherit', cursor: 'pointer',
          padding: wide ? '0 10px' : 0,
        },
        onClick: () => openWorkspace?.(),
      }, h('svg', {
        width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
      },
      h('polyline', { points: '16 18 22 12 16 6' }),
      h('polyline', { points: '8 6 2 12 8 18' })),
      wide ? h('span', null, '工作室') : undefined);
    }
    //#endregion

    const inject = ['slots', 'locale', 'remote', 'remote.session', 'remote.workspaceFiles', 'remote.commands', 'configForms', 'sidebarRight', 'sidebarRightTabs'];

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

      // 工作室：改成右侧栏页（不再是 conversation.view 的 Tab）。
      // 三段：左栏底部启动按钮 → 注册一个右侧栏 tab → 注册该 tab 的正文。
      const PANEL_ID = 'code-studio';
      const studioT = () => makeT(locale, zh);
      const renderStudio = (props) => h(StudioPanel, {
        sessionId: props?.sessionId,
        remote: ctx.remote,
        t: studioT(),
      });

      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: PANEL_ID,
        order: 40,
        inject: () => ({ openWorkspace: () => ctx.sidebarRight?.openTab?.(PANEL_ID) }),
      }, StudioLauncher)), `${NS}: studio launcher`);

      ctx.effect(() => {
        const tabs = ctx.sidebarRightTabs;
        if (tabs === undefined || typeof tabs.register !== 'function') {
          // 老宿主回退：左侧面板图标 + main 区。当前宿主有 sidebarRightTabs，
          // 走不到这里。
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist', id: PANEL_ID, order: 20,
            label: () => studioT()('studioPanel'), locale: NS,
          }, StudioLauncher));
          ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, renderStudio));
          return () => undefined;
        }
        return tabs.register({
          id: PANEL_ID,
          kind: 'code-studio',
          keepMounted: true,
          title: () => studioT()('studioPanel'),
        });
      }, `${NS}: studio right tab`);

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: PANEL_ID,
        locale: NS,
      }, renderStudio)), `${NS}: studio right body`);
    }

    const exported = {
      inject,
      apply,
      /** Test hooks. The loader reads only `inject` and `apply`. */
      __ns: { NS, SETTINGS_NS, ROLE_IDS, rowsFromValue, assignmentsFromRows, AgentModelsController, AgentModelsSection, issueTagClass, StudioPanel, StudioLauncher, buildGraph, GraphView },
    };
    return exported;
  },
});
