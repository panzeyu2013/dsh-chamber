---
name: chamber-doc
description: Use when creating, editing, moving, restructuring, or auditing dsh-chamber Markdown documentation (README, DEVELOPMENT, design, checklists, progress, deploy, package READMEs), including bilingual pairs and GENERATED blocks; gives the ordered edit-then-validate flow whose rules live in docs/AGENTS.md.
---

# chamber-doc

本 skill 是执行流程；规则本体在 [`docs/AGENTS.md`](../../../docs/AGENTS.md)，冲突时以它和根 `AGENTS.md` 为准。

## 何时用

- 新建 / 移动 / 删除 / 合并文档；
- 改标题或章节导致 `#anchor` 失效；
- 只改双语对的一侧（中文主档 ↔ `docs/*.en-US.md`）；
- 改 design / checklists / progress / deploy 中带规则性的内容；
- 清理重复规则、历史叙述、手抄目录、过期状态词；
- PR 只改文档时选验证。

## 流程

1. 读 `docs/AGENTS.md` 第 1 节，给这条事实找唯一家。找不到就 grep 现有 owner：`grep -rn "<特征短语>" docs packages`。
2. 只改 owner：design / 单源 / 脚本 → 生成块 → 引用页。不要从引用页反向改 owner。
3. 写作规则（一段一行 / 链接代替复述 / 禁手抄目录 / 当前版本值单源）与双语结构要求以 [`docs/AGENTS.md`](../../../docs/AGENTS.md) §2 为准，本 skill 不复述。
4. 移动 / 改名时按 [`docs/AGENTS.md`](../../../docs/AGENTS.md) §5 第 3 步同批修相对链接与锚点（锚点用 GitHub slug 或显式 `<a id>`）。
5. 验证（只读、可离线）：

```bash
node scripts/gates/checks/verify-md-links.mjs          # 相对链接与锚点，退出 0
node scripts/upstream/registry/registry-views.mjs --check # GENERATED 块与 registry.json 一致
pnpm run verify:i18n                             # 双语结构/哈希差异（改了对才跑）
node scripts/gates/runners/run-checks.mjs static --list  # 该模式还要跑哪些门
```

6. 重录双语记录用 `pnpm run verify:i18n -- --write`（该门只支持整份记录重录，没有按对写入）；并行批次若约定由协调者统一重录 `docs/i18n-record.json`，不要抢同一次写。

## 陷阱

- `verify-md-links` 扫 `docs/`、`packages/`、`scripts/`、`.github/`、`.agents/skills/` 与根 Markdown；`.agents/` 的其它运行时目录不扫。
- 两个 chamber-frozen 上游 README（`packages/dsh-client-connection/README*.md`）被该门禁豁免，不要为了变绿改它们。
- 纯文档 PR 不等于零验证：md-links、registry、i18n 与「按改动面选门」仍要跑。
- 写完报告改了哪一层、跑了哪些命令与输出、未验证什么；不要用「文档已同步」代替命令证据。
