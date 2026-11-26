/**
 * Browser half of dsh-plugin-code-studio.
 *
 * Right-sidebar studio panel: launcher button, kanban/issues/regions view,
 * graph, merge button, preset auto-switch. The old「角色模型指派」settings page
 * is gone — the plugin no longer dispatches sub-Agents itself, so there is
 * nothing to pin models to.
 *
 * Everything the page reads and writes goes through the Host:
 *   - `remote.session.*` / workspace state — via the panel's own fetches.
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

    const zh = {
      nav: '代码工作室',
      title: '角色模型指派',
      description: '给代码工作室的每个角色固定 provider 与模型。开启后，技术总监派单时会把这些参数原样传给子 Agent。',
      enabled: '按角色指定子 Agent 模型',
      enabledHint: '关闭时所有角色继承父 Agent 的模型。仅影响新会话：已经开始的会话保持原样。',
      roles: '角色模型指派',
      blockTitle: '子 Agent 模型指派',
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
      summary: '为代码工作室的 7 个角色分别指定模型。',
      promptPreview: '派单提示预览',
      'role.tech-lead': '技术总监',
      'role.planner': '规划',
      'role.implementer': '实现',
      'role.reviewer': '审校',
      'role.security': '安全审计',
      'role.test': '测试工程',
      'role.maintenance': '维护',
      'role.merger': '合并',
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
      issueRegions: '区域目录',
      issueNoRegion: '还没有区域（派单后自动建）。',
      issueAllRegions: '全部',
      issueRegionIssues: '区域 Issues',
      issuePickRegion: '先在左边选一个区域。',
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
      issueCancel: '中止',
      issueChanged: '改动',
      issueMode: '对话模式',
      issueModeStudio: '代码总编工作室',
      issueModeNormal: '普通',
      issueSwitchStudio: '切换到工作室模式',
      issueSwitching: '切换中…',
      issueInheritNew: '新建会话并继承',
      issueInheritBusy: '新建中…',
      issueInheritTitle: '新建一个干净会话，继承当前会话的记忆与工作室绑定（旧会话转只读）',
    };

    const en = {
      nav: 'Code Studio',
      title: 'Role model assignments',
      description: 'Pin a provider and model to each code-studio role. When enabled, the tech lead passes these routes through to subagents.',
      enabled: 'Assign a model per role',
      enabledHint: 'When off, every role inherits the parent Agent model. Only affects new sessions; running sessions keep their own choice.',
      roles: 'Role assignments',
      blockTitle: 'Sub-agent models',
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
      summary: 'Assign a model to each of the 7 studio roles.',
      promptPreview: 'Dispatch prompt preview',
      'role.tech-lead': 'Tech lead',
      'role.planner': 'Planner',
      'role.implementer': 'Implementer',
      'role.reviewer': 'Reviewer',
      'role.security': 'Security',
      'role.test': 'Test',
      'role.maintenance': 'Maintenance',
      'role.merger': 'Merger',
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
      issueRegions: 'Regions',
      issueNoRegion: 'No regions yet (created on dispatch).',
      issueAllRegions: 'All',
      issueRegionIssues: 'Region issues',
      issuePickRegion: 'Pick a region on the left first.',
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
      issueCancel: 'Stop',
      issueChanged: 'changed',
      issueMode: 'Chat mode',
      issueModeStudio: 'Code studio',
      issueModeNormal: 'Normal',
      issueSwitchStudio: 'Switch to studio mode',
      issueSwitching: 'Switching…',
      issueInheritNew: 'New session, inherit',
      issueInheritBusy: 'Creating…',
      issueInheritTitle: 'Create a clean session that inherits this session\'s memory and studio bindings (old session becomes read-only)',
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
      // ---- 工作室：左侧栏启动器（悬停 / 按下 / 选中 / 焦点）----
      '.dsh-code-launcher{display:inline-flex;align-items:center;gap:8px;min-height:36px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .12s,color .12s}',
      '.dsh-code-launcher:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-code-launcher:active{background:var(--dsw-alias-interactive-bg-selected,var(--dsw-alias-interactive-bg-hover))}',
      '.dsh-code-launcher:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsh-code-launcher.on{background:var(--dsw-alias-interactive-bg-selected,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-brand-primary)}',
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
      '.dsh-code-iss-tag.review{color:var(--dsw-alias-brand-primary)}',
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
      '.dsh-code-sp-main{display:flex;flex-direction:column;gap:var(--cs-3);padding:var(--cs-3);overflow:auto;min-height:0;flex:1}',
      '.dsh-code-frame-wrap{display:flex;flex-direction:column;height:100%;min-height:0}',
      '.dsh-code-frame-bar{display:flex;justify-content:flex-end;gap:6px;padding:4px 8px;flex:none}',
      '.dsh-code-frame{flex:1 1 auto;width:100%;min-height:0;border:0;display:block}',
      '.dsh-code-sp-regions{display:flex;flex-direction:column;gap:var(--cs-2);flex:none}',
      '.dsh-code-sp-issues{display:flex;flex-direction:column;gap:var(--cs-2);flex:none}',
      '.dsh-code-sp-tree{display:flex;flex-direction:column;gap:var(--cs-2);flex:none}',
      '.dsh-code-sp-report{display:flex;flex-direction:column;gap:var(--cs-2);flex:none}',
      '.dsh-code-sp-h{display:flex;align-items:center;gap:var(--cs-2);font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary)}',
      '.dsh-code-sp-scroll{min-height:0}',
      '.dsh-code-iss-list{display:flex;flex-direction:column;gap:2px;max-height:32vh;overflow:auto}',
      '.dsh-code-region-list{display:flex;flex-wrap:wrap;gap:6px}',
      '.dsh-code-graph{width:100%;height:200px;overflow:auto}',
      '.dsh-code-sp-rep{font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary);max-height:34vh;overflow:auto}',
      '.dsh-code-iss-item{position:relative;display:flex;flex-direction:column;gap:4px;padding:8px 10px 8px 14px;margin-bottom:2px;border:.5px solid transparent;border-radius:var(--dsw-radius-md);cursor:pointer;transition:background .12s,border-color .12s}',
      '.dsh-code-iss-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-code-iss-item.sel{background:var(--dsw-alias-interactive-bg-selected,var(--dsw-alias-interactive-bg-hover));border-color:var(--dsw-alias-border-l2)}',
      '.dsh-code-iss-item::before{content:"";position:absolute;left:5px;top:9px;bottom:9px;width:3px;border-radius:2px;background:var(--dsw-alias-state-idle-primary,#999)}',
      '.dsh-code-iss-item[data-status=done]::before{background:var(--dsw-alias-state-success-primary)}',
      '.dsh-code-iss-item[data-status=run]::before{background:var(--dsw-alias-state-warn-label)}',
      '.dsh-code-iss-item[data-status=fail]::before{background:var(--dsw-alias-state-error-primary)}',
      '.dsh-code-iss-item[data-status=review]::before{background:var(--dsw-alias-brand-primary)}',
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
      '.dsh-code-legend i.review{background:var(--dsw-alias-brand-primary)}',
      '.dsh-code-sp-meta{display:flex;gap:6px;flex-wrap:wrap;padding:6px 0;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dsh-code-region{position:relative;display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;cursor:pointer;transition:background .12s,border-color .12s;min-width:0}',
      '.dsh-code-region:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-code-region.sel{background:var(--dsw-alias-interactive-bg-selected,var(--dsw-alias-interactive-bg-hover));border-color:var(--dsw-alias-brand-primary)}',
      '.dsh-code-region .nm{font-size:11.5px;font-weight:600;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px}',
      '.dsh-code-region .cnt{font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.dsh-code-region .dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-label);flex:none;animation:dsh-code-pulse 1.4s ease-in-out infinite}',
      '.dsh-code-region .fold{display:none}',
      '.dsh-code-region.allreg{border-color:var(--dsw-alias-border-l2);font-weight:600}',
      '.dsh-code-files{display:flex;flex-wrap:wrap;gap:4px;padding:6px 0}',
      '.dsh-code-files code{font-size:10.5px;padding:1px 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dsh-code-sp-pr{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 0}',
      '.dsh-code-sp-pr a{font-size:11.5px;color:var(--dsw-alias-brand-primary,#3b82f6);text-decoration:none;word-break:break-all}',
      '.dsh-code-sp-pr a:hover{text-decoration:underline}',
      // 节点连线图（region / 子 Agent 工作状态）
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
      '.dsh-code-g-node.issue.review circle{fill:var(--dsw-alias-brand-primary);stroke:var(--dsw-alias-brand-primary);stroke-width:2}',
      '.dsh-code-g-node.repo circle{fill:var(--dsw-alias-bg-layer-2);stroke:var(--dsw-alias-border-l2);stroke-width:1.5}',
      '.dsh-code-g-node.repo.run circle{stroke:var(--dsw-alias-state-warn-label);stroke-width:2.5;animation:dsh-code-pulse 1.4s ease-in-out infinite}',
      '.dsh-code-g-node.sel circle{stroke:var(--dsw-alias-label-primary);stroke-width:2.5}',
      '@keyframes dsh-code-pulse{0%,100%{opacity:1}50%{opacity:.5}}',
      '.dsh-code-sp-actions{display:flex;gap:6px;margin-left:auto}',
      '.dsh-code-sp-rep{padding:0;white-space:pre-wrap;word-break:break-word;line-height:1.7;color:var(--dsw-alias-label-secondary);font-size:12.5px}',
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




    // ---- 工作区维护组 ----
    /** 已请求过建 .code-studio 的会话（打开面板即建一次，幂等）。 */
    const studioInited = new Set();

    /** 打开工作室页时让 Host 建 .code-studio 骨架（幂等；autoCreate 关了也没副作用）。 */
    async function requestStudioInit(remote, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      if (studioInited.has(sessionId)) return;
      studioInited.add(sessionId);
      try {
        const ns = remote?.commands;
        if (!ns || typeof ns.execute !== 'function') return;
        await ns.execute(sessionId, '/code-studio-watch init', []);
      } catch { /* 建目录失败不影响面板展示 */ }
    }

    /** Map an issue status to a CSS class + raw label. */
    function issueTagClass(status) {
      const s = String(status ?? '').toUpperCase();
      if (s === 'DONE') return 'done';
      // REVIEW = 待合并区：写完了但还没进主干，等 code_merge 落地。用品牌蓝区分于「进行中」的橙。
      if (s === 'REVIEW') return 'review';
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
     * 工作状态图：工作区(圆点) → 仓库(圆点) → issue(小圆点)，曲线连线。
     * 用来观测哪个仓库 / 子Agent 在跑、跑到哪一步；不是文件树。
     *
     * 防打架（重叠）的三条几何约束：
     *  1) 分列：每层固定一个 x，同层节点只沿 y 排 → 不会横向压在一起。
     *  2) 垂直带：每个仓库占一条高度=其 issue 数×行距 的带，串行向下排，
     *     带与带之间留 ROW_GAP → 仓库之间、issue 之间都不重叠。
     *  3) 标签列固定预留 LABEL_W + 截断 → 文字不越界；连线从圆边出发、控制点在
     *     两列中线，走列间空白，不穿节点。整体尺寸按内容算，外层 overflow:auto。
     */
    function buildGraph(issues) {
      const R_ROOT = 13;
      const R_REPO = 10;
      const R_ISSUE = 6;
      const LABEL_W = 132; // 每个圆点右侧给标签预留的宽度
      const COL_GAP = 40;  // 列间水平空白
      const ROW_GAP = 22;  // 同列相邻节点/带的垂直空白
      const PAD = 16;
      const ROW_STEP = R_ISSUE * 2 + ROW_GAP;

      const byRepo = new Map();
      for (const issue of issues) {
        const key = issue.repoName ? String(issue.repoName) : '';
        if (!byRepo.has(key)) byRepo.set(key, []);
        byRepo.get(key).push(issue);
      }
      const repoKeys = [...byRepo.keys()].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

      const bandHeights = repoKeys.map((k) => Math.max(1, byRepo.get(k).length) * ROW_STEP);
      const reposTotalH = bandHeights.reduce((a, b) => a + b, 0) + Math.max(0, repoKeys.length - 1) * ROW_GAP;
      const contentH = Math.max(reposTotalH, ROW_STEP);
      const totalH = contentH + PAD * 2;

      const col0 = PAD + R_ROOT;
      const col1 = col0 + R_ROOT + LABEL_W + COL_GAP;
      const col2 = col1 + R_REPO + LABEL_W + COL_GAP;
      const width = Math.max(col2 + R_ISSUE + LABEL_W + PAD, PAD * 2 + 3 * LABEL_W);

      const nodes = [];
      const edges = [];
      const rootId = '__root__';
      const rootCy = PAD + contentH / 2;
      nodes.push({ id: rootId, kind: 'root', status: '', cx: col0, cy: rootCy, r: R_ROOT, label: 'workspace', sub: `${repoKeys.length} 仓库 · ${issues.length} issue` });

      let bandTop = PAD;
      for (let i = 0; i < repoKeys.length; i++) {
        const rk = repoKeys[i];
        const list = byRepo.get(rk);
        const running = list.some((x) => x.status === 'RUNNING');
        const done = list.filter((x) => x.status === 'DONE').length;
        const total = list.length;
        const bandH = bandHeights[i];
        const repoId = `repo:${rk || '__none__'}`;
        const rawLabel = rk || '(未归属)';
        nodes.push({ id: repoId, kind: 'repo', status: running ? 'run' : '', cx: col1, cy: bandTop + bandH / 2, r: R_REPO, label: clip(rawLabel, 14), sub: `${done}/${total} 完成` });
        edges.push({ from: rootId, to: repoId });
        // issue 在带内垂直居中排
        const blockH = total * ROW_STEP;
        let iy = bandTop + (bandH - blockH) / 2 + ROW_STEP / 2;
        for (const issue of list) {
          const status = String(issue.status ?? '');
          const tag = status === 'DONE' ? 'done' : status === 'REVIEW' ? 'review' : (status === 'FAILED' || status === 'BLOCKED' || status === 'CANCELLED') ? 'fail' : status === 'RUNNING' ? 'run' : '';
          const issueId = `issue:${String(issue.id)}`;
          nodes.push({
            id: issueId, kind: 'issue', status: tag, issueId: String(issue.id),
            cx: col2, cy: iy, r: R_ISSUE,
            label: `#${issue.id}`, sub: clip(`${status || 'READY'}${Array.isArray(issue.tags) && issue.tags.length ? ' · ' + issue.tags.join(',') : ''}`, 18),
          });
          edges.push({ from: repoId, to: issueId });
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


    // 读一个会话的 cwd（iframe 的 dir 参数要用，服务端据此定位工作区读台账）。
    function studioCwd(sessions, sessionId) {
      if (!sessions || typeof sessionId !== 'string' || sessionId === '') return '';
      try {
        const snap = typeof sessions.list?.getSnapshot === 'function' ? sessions.list.getSnapshot() : null;
        const row = snap?.byId ? snap.byId[sessionId] : null;
        if (!row) return '';
        if (row.header && typeof row.header.cwd === 'string') return row.header.cwd;
        if (typeof row.cwd === 'string') return row.cwd;
        const pv = row.projectionValues;
        if (pv && typeof pv.cwd === 'string') return pv.cwd;
      } catch { /* ignore */ }
      return '';
    }

    // 工作室 UI = 一张插件自控的独立网页（studio-web.js 里的 HTML/CSS/JS），右侧栏里用 iframe 铺满。
    // React 这层只做三件宿主侧才能做的事：打开即建 .code-studio、空会话自动切工作室模式、一个「换会话继承」按钮
    // （换会话要调客户端 sessions.create / openSession，网页里拿不到这些服务，所以按钮留在这层）。
    function StudioPanel({ sessionId, remote, t, sessions, uiWorkspace, workspaces }) {
      const [inheriting, setInheriting] = React.useState(false);

      React.useEffect(() => {
        void requestStudioInit(remote, sessionId);
      }, [remote, sessionId]);

      const inheritNewSession = async () => {
        if (inheriting) return;
        setInheriting(true);
        try {
          let workspaceId = '';
          try {
            const items = workspaces?.list?.getSnapshot?.()?.items;
            if (Array.isArray(items)) {
              const hit = items.find((it) => Array.isArray(it.sessionIds) && it.sessionIds.includes(sessionId));
              if (hit) workspaceId = hit.workspaceId;
            }
          } catch { /* 拿不到 workspaceId 就按 cwd 建 */ }
          if (!sessions || typeof sessions.create !== 'function') return;
          const opts = {};
          if (workspaceId) opts.workspaceId = workspaceId;
          const created = await sessions.create(opts);
          if (!created) return;
          await remote?.commands?.execute?.(sessionId, '/code-studio-watch inherit ' + created, []);
          uiWorkspace?.openSession?.(created);
        } catch { /* ignore */ } finally {
          setInheriting(false);
        }
      };

      const cwd = studioCwd(sessions, sessionId);
      const theme = (typeof document !== 'undefined' && document.documentElement && document.documentElement.dataset && document.documentElement.dataset.theme === 'dark') ? 'dark' : 'auto';
      const src = '/code-studio/?sid=' + encodeURIComponent(sessionId || '') + '&dir=' + encodeURIComponent(cwd) + '&theme=' + encodeURIComponent(theme);
      const bar = h('div', { className: 'dsh-code-frame-bar' },
        h('button', { className: 'dsh-code-btn', type: 'button', title: t('issueInheritTitle'), disabled: inheriting, onClick: inheritNewSession },
          inheriting ? t('issueInheritBusy') : t('issueInheritNew')));
      return h('div', { className: 'dsh-code-frame-wrap' },
        bar,
        h('iframe', {
          className: 'dsh-code-frame',
          src,
          title: 'Code Studio',
          style: { width: '100%', flex: '1 1 auto', border: '0', display: 'block', background: 'transparent' },
        }));
    }

    /** 订阅「工作室页当前是否打开」——右栏展开且活动 tab 是本插件。 */
    function useStudioOpen(sidebarRight) {
      const read = () => {
        try {
          return !!sidebarRight?.isExpanded?.() && sidebarRight?.active?.()?.kind === 'code-studio';
        } catch { return false; }
      };
      const [open, setOpen] = React.useState(read);
      React.useEffect(() => {
        if (!sidebarRight) return undefined;
        const sync = () => setOpen(read());
        sync();
        const offs = [];
        for (const obs of [sidebarRight.openTabs, sidebarRight.mounted]) {
          if (typeof obs?.subscribe === 'function') {
            try { const off = obs.subscribe(sync); if (typeof off === 'function') offs.push(off); } catch { /* ignore */ }
          }
        }
        return () => { for (const off of offs) { try { off(); } catch { /* ignore */ } } };
      }, [sidebarRight]);
      return open;
    }

    /** 左侧栏底部的启动按钮：打开工作室右侧栏页。 */
    function StudioLauncher({ wide, openWorkspace, sidebarRight }) {
      const open = useStudioOpen(sidebarRight);
      return h('button', {
        type: 'button', title: '打开工作室', 'aria-label': '打开工作室',
        'aria-pressed': open ? 'true' : 'false',
        className: open ? 'dsh-code-launcher on' : 'dsh-code-launcher',
        style: {
          width: wide ? '100%' : 36, justifyContent: wide ? 'flex-start' : 'center',
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

    const inject = ['slots', 'locale', 'remote', 'remote.session', 'remote.workspaceFiles', 'remote.commands', 'sessions', 'uiWorkspace', 'workspaces', 'configForms', 'sidebarRight', 'sidebarRightTabs', 'commandUi'];

    /** Fallback `t` so a missing/!bound locale service degrades to raw keys. */
    function makeT(locale, dictionaries, ns = NS) {
      const bound = typeof locale?.bind === 'function' ? locale.bind(ns) : undefined;
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

    // ---- 排版基线：统一色阶 / 间距 / 对齐，规矩整洁，贴合宿主设置页

    function apply(ctx) {
      const locale = ctx.locale;
      ctx.effect(() => {
        if (locale === undefined || typeof locale.register !== 'function') return () => undefined;
        const disposer = locale.register(NS, { zh, en });
        return typeof disposer === 'function' ? disposer : () => undefined;
      }, `${NS}: dictionaries`);

      // 工作室：改成右侧栏页（不再是 conversation.view 的 Tab）。
      // 三段：左栏底部启动按钮 → 注册一个右侧栏 tab → 注册该 tab 的正文。
      const PANEL_ID = 'code-studio';
      const studioT = () => makeT(locale, zh);
      const renderStudio = (props) => h(StudioPanel, {
        sessionId: props?.sessionId,
        remote: ctx.remote,
        sessions: ctx.sessions,
        uiWorkspace: ctx.get ? ctx.get('uiWorkspace') : undefined,
        workspaces: ctx.get ? ctx.get('workspaces') : undefined,
        t: studioT(),
      });

      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: PANEL_ID,
        order: 40,
        inject: () => ({ openWorkspace: () => ctx.sidebarRight?.openTab?.(PANEL_ID), sidebarRight: ctx.sidebarRight }),
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

      // BotHarness（@botharness/ui）挂载：BH 在同一个客户端 Cordis 树上 provide 了
      // dockPanels 服务（packages/client/src/client/index.ts:533）。服务存在就把面板
      // 注册成 BH 右侧 dock 面板，正文直接复用 /code-studio/ 页面（同源 iframe，
      // 令牌继承与主题跟随由面板自身的 inheritHostTokens/syncTheme 处理）。
      // 没装 BH 时 dockPanels 永远不出现，轮询 20 次自动放弃，宿主零感知。
      ctx.effect(() => {
        if (typeof window === 'undefined') return () => undefined;
        let dock = undefined;
        let tries = 0;
        const timer = setInterval(() => {
          tries += 1;
          if (dock === undefined) {
            const found = ctx.get ? ctx.get('dockPanels') : undefined;
            if (found === undefined || typeof found.register !== 'function') {
              if (tries >= 20) clearInterval(timer);
              return;
            }
            dock = found;
          }
          clearInterval(timer);
          const iframe = (view) => () => h('iframe', {
            src: '/code-studio/' + (view ? '?view=' + view : ''),
            style: { width: '100%', height: '100%', border: '0', display: 'block' },
          });
          /* 单入口：面板列表只留 📁 仓库列表。监控面板懒注册——点仓库才临时
             注册并打开，关掉后 1s 内注销，按钮不会一直占面板列表。 */
          const monitorDef = () => ({
            id: 'code-studio',
            title: 'Code Studio',
            icon: '🛠',
            scope: 'global',
            order: 80,
            defaultPosition: { zone: 'right' },
            component: iframe('monitor'),
          });
          let monOff = undefined;
          const ensureMonitor = () => {
            if (monOff) { try { dock.open('code-studio'); } catch { /* 已开着 */ } return; }
            try { monOff = dock.register(monitorDef()); } catch { /* 重复 id 等意外 */ return; }
            try { dock.open('code-studio'); } catch { /* 打不开就算了 */ }
          };
          const gcTimer = setInterval(() => {
            if (!monOff) return;
            let open = true;
            try { open = dock.isOpen('code-studio'); } catch { open = true; }
            if (!open) { try { monOff(); } catch { /* 已注销 */ } monOff = undefined; }
          }, 1000);
          const onMsg = (ev) => {
            const d = ev && ev.data;
            if (d && d.type === 'cs-open-monitor') ensureMonitor();
          };
          window.addEventListener('message', onMsg);
          const offs = [
            dock.register({
              id: 'code-studio-repos',
              title: '仓库列表',
              icon: '📁',
              scope: 'global',
              order: 81,
              defaultPosition: { zone: 'left' },
              component: iframe('repos'),
            }),
          ];
          return () => {
            clearInterval(gcTimer);
            window.removeEventListener('message', onMsg);
            if (monOff) { try { monOff(); } catch { /* 已注销 */ } }
            for (const off of offs) { try { off(); } catch { /* 已注销 */ } }
          };
        }, 500);
        return () => clearInterval(timer);
      }, `${NS}: botharness dock panel`);

      // /hz 的斜杠快捷菜单：挂一个 popupSelect 装饰器，打 /hz 并回车就弹选项。
      // 装饰器不新增命令——宿主那条 /hz 仍在目录里、参数声明与生命周期日志都不变，
      // 只把「裸执行」换成这个面板；选中后用 remote.commands.execute 把整行提交回去。
      const HZ_OPTIONS = [
        { id: 'on', label: 'on · 立即注入', detail: '补回 AGENTS.md 注入块并清掉关闭哨兵', group: { name: 'inject', label: '注入' } },
        { id: 'off', label: 'off · 卸载还原', detail: '摘块 + 清技能 + 子 Agent 前缀变空，守护不再补回', group: { name: 'inject', label: '注入' } },
        { id: 'pass', label: 'pass · 透传', detail: '拦截器留着但一个字节都不改；块和技能都保留', group: { name: 'inject', label: '注入' } },
        { id: 'inject', label: 'inject · 恢复注入', detail: '从透传切回注入，下一笔请求就补 system 层正文', group: { name: 'inject', label: '注入' } },
        { id: 'chain on', label: 'chain on · 开链式压缩', detail: '请求经 billion-context 中转', group: { name: 'chain', label: '链式压缩' } },
        { id: 'chain off', label: 'chain off · 关链式压缩', detail: '请求直连上游，bili 不再参与', group: { name: 'chain', label: '链式压缩' } },
        { id: 'chain status', label: 'chain status · 看链式状态', detail: '链式/直连/降级计数', group: { name: 'chain', label: '链式压缩' } },
        { id: 'relay on', label: 'relay on · 启动中继', detail: '默认端口 8788，带面板与自启动', group: { name: 'relay', label: '转发中继' } },
        { id: 'relay off', label: 'relay off · 停止中继', detail: '下次启动 dsh 不再自动拉起', group: { name: 'relay', label: '转发中继' } },
        { id: 'relay status', label: 'relay status · 看中继状态', detail: '端口/上游/活跃会话/补丁计数', group: { name: 'relay', label: '转发中继' } },
      ];
      ctx.effect(() => {
        const commandUi = ctx.commandUi;
        if (commandUi === undefined || typeof commandUi.decorate !== 'function') return () => undefined;
        const off = commandUi.decorate({
          name: 'hz',
          // 宿主没装破障插件时命令本身会报「未安装」，面板照常弹，让用户看见原因。
          available: () => true,
          ui: {
            kind: 'popupSelect',
            searchMode: 'substring',
            searchLabels: () => ({ placeholder: '搜索破甲命令…', empty: '没有可用选项', noResults: '没有匹配的选项' }),
            options: async () => HZ_OPTIONS,
            onSelect: async (option, session) => {
              const line = `/hz ${option.id}`;
              // 优先走 session 自己的 command()（与 /permission 同一路径），
              // 拿不到会话面就退回 remote.commands.execute。
              const live = ctx.sessions?.binding?.(session.sessionId)?.session;
              if (live !== undefined && typeof live.command === 'function') {
                const result = await live.command(line);
                if (!result?.ok) throw new Error(`破甲命令执行失败：${result?.error?.code ?? 'unknown'}`);
                return;
              }
              const result = await ctx.remote.commands.execute(session.sessionId, line, []);
              if (!result?.ok) throw new Error(`破甲命令执行失败：${result?.error?.code ?? 'unknown'}`);
            },
          },
        });
        return typeof off === 'function' ? off : () => undefined;
      }, `${NS}: /hz popup`);
    }

    const exported = {
      inject,
      apply,
      /** Test hooks. The loader reads only `inject` and `apply`. */
      __ns: { NS, issueTagClass, StudioPanel, StudioLauncher, buildGraph, GraphView },
    };
    return exported;
  },
});
