---
name: chamber-pre-push
description: Use before pushing, opening or updating a pull request, or claiming checks pass on a dsh-chamber branch, to select the smallest evidence covering the outgoing diff from the gate-surfaces modes (static/tests/typecheck/full) instead of running the whole suite or recalling a command list from CI YAML.
---

# chamber-pre-push

## 单源与模式

- 门清单单一来源：`scripts/gates/gate-surfaces.json`（门 id、所属 `modes`、`surfaces.local/ci/release`、门所在 workflow 步）。根 `package.json` 只是命令入口，不是清单。
- 查看计划（不执行）：`node scripts/gates/run-checks.mjs <mode> --list`。
- 模式：`static` = 静态 / 政策门（含 i18n、md-links、styles 等；i18n 也在 CI 的 pre-install 生成块里跑，md-links/styles 仅本地）；`tests` = 全部包测试（与 ci.yml 同源）；`typecheck` = 客户端插件与宿主包类型检查；`full` = static + typecheck + tests（派生，不落盘）。
- 平台门：gate registry 过滤 `platform: darwin`；linux 的模式里没有 macOS / Swift 腿，那不等于它们通过。
- 模式之外的门见 `docs/progress/STATUS.md` §1.6（手写 host typecheck、macOS-only job、C8 重建、远端态验收、notices diff、gateway pack smoke、renderer SVG scoper、Windows manifests）。

## 按改动面选证据

- 文档 / design / checklists / progress / 包 README：`pnpm run check:static` 或至少 `node scripts/gates/verify-md-links.mjs` + `pnpm run verify:i18n` + `node scripts/upstream/registry-views.mjs --check`；纯文档 PR 不需要 install / 构建。
- 包源码 / 行为：`pnpm run check:tests`（全部包测试，与 CI 同源）或该包 `pnpm --filter <pkg> run test`；新测试文件必须登记，否则 `verify:test-wiring`（static）红。
- 类型 / 公共导出：`pnpm run check:typecheck`；改桶导出或公共 API 先看 `verify:no-dead-exports`。
- 跨包边界 / 依赖：`verify:package-boundaries`、`verify:import-cycles`、`verify:file-budgets`（static）。
- 上游触点（新增 `@deepseek-ai/*` 深导入、改 fork 副本、镜像 wire、新增再生物）：先登记 `scripts/upstream/registry.json`，再 `node scripts/upstream/registry-views.mjs --write`，并跑 `verify-upstream-touchpoints.mjs`；漏登 = CI C1/C3 硬失败。
- 运行时 / 认证 / 协议 / 桌面壳：静态检查不能证明运行时正确；补聚焦测试，或说明未验证什么。
- 发布相关（版本、workflow、打包）：先读 `docs/checklists/release-checklist.md` 与 `docs/checklists/packaging-closure-checklist.md`；发布证明链不在本地模式内。

## 纪律

- 不重复跑刚通过的门；不为「全绿」跑 `full`（除非改动跨多个面或在诊断 CI）。
- 不把跳过说成通过：报告写实际命令与结果，区分 SKIP / 未跑 / 失败。
- linux 的绿不能替代 macOS / Swift / Windows 腿；这些必须在对应平台跑。
- 详见 `CONTRIBUTING.md` 的「测试」「提交前验证」。
