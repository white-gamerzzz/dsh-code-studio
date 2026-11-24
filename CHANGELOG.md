# Changelog

## [Unreleased]

### Changed
- 破障（pozhang）子系统拆为独立包 `@whitegamerzzz/dsh-plugin-pozhang`。
  - 迁出：原仓 `pozhang/` 整目录（含 `assets/破障v4.md`、`assets/codex-skills-v4/` 63 个 skill）与 `lib/pozhang-settings.js` 全部移入新包。
  - 工作室（`dsh-plugin-code-studio`）对破障改为**可选加载 + 降级**：`lib/index.js` 顶层 `try { await import('@whitegamerzzz/dsh-plugin-pozhang') } catch {}`，破障缺失时各符号降级为无害 stub（`agentPrefix`/`agentAnchor` 返 `''`，注入/拦截/中继为 no-op 或空集），`/hz` 报「破障插件未安装」；`import` 仍 EXIT 0，不崩。
  - `cordis.patch.yml`：工作室只剩 `code-studio` + `code-studio-agent-models` 两块；破障设置页 patch（`id: code-studio-pozhang`，服务名 `pozhangSettings`）由新包自带。
