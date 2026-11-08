---
name: chamber-code-review
description: Use when reviewing a dsh-chamber pull request; establishes the owning-design-first order, the blocking checks (Rejected-alternatives, test semantics, docs-STATUS-TODO-design sync, upstream registry touchpoints, evidence quality), and the review-only duties a green gate does not prove.
---

# chamber-code-review

这是评审流程，不是全量风格清单：目标是找出真实缺陷，宁可一条有证据的 blocker，也不要一页 nit。

## 先建立判据

1. 读根 `AGENTS.md`（Purpose / Hard Facts / 执行流）与改动路径映射到的 owning 文档：契约 → `docs/design/0X-*.md`；进度 → `docs/progress/STATUS.md`；文档规则 → `docs/AGENTS.md`；checklist → `docs/checklists/`；包契约 → `packages/*/README.md`。先读判据再看 diff。
2. 拿 `.github/PULL_REQUEST_TEMPLATE.md` 核对：Intent / Non-goals / Affected surfaces / Repository guidance / Validation / Risks。

## 阻断项

- 契约类改动（design 契约、跨包边界、已发货行为）未在 owning design 补「被否方案」短节。
- 测试语义变更没有解释旧行为为何过时；或只改实现不同步测试 / 只改测试不改实现。
- `docs/progress/STATUS.md` 未同批同步：新 open 项进 STATUS 并带判据与指针；落地项从 STATUS 删除（基线留 git / `CHANGELOG.md` / design）；未排期想法进 `TODO.md`。
- 上游触点改动未登记 `scripts/upstream/registry/registry.json` 或未重生成 GENERATED 块（CI C1/C3 硬失败；手改生成块 `verify:registry` 硬失败）。
- 文档与代码不是同一事实：命令、默认值、错误文案与源码 / 运行时不符；或文档声明的门禁跑法已过期。
- 新 prose 有推理过程、历史叙述、手抄目录、过期状态词（按 `docs/AGENTS.md` 第 2 / 4 节）。
- Validation 只写命令名无结果，或把静态检查当作运行时 / 平台正确性证据。
- 凭据与连接密钥进入 renderer、日志或持久层。

## 评审要点

- 先读 diff 对应的 design 与源码，再读 diff；不要凭记忆判断规则。
- 追溯契约两侧：错误、取消、所有权、清理、回滚。
- 边界：新增导出 / 公共方法是否有当前消费者；跨包依赖是否走既有 seam；包职责是否仍与 `AGENTS.md` 的 Runtime Boundaries 一致。
- 运行时与并发：异步取消、teardown、dispose 到静止；新增测试在回归时是否真会变红（负向对照）。
- 平台：macOS / Swift 行为改动不能只用 linux 证据；Windows/Linux 桌面腿随 Electron 冻结归档（见 `docs/progress/electron-frozen.md`）。
- 文档：纯文档 PR 也要看 md-links、i18n、registry 三项证据与改动面选门。

## review-only（脚本绿 ≠ 满足）

五项 review-only 义务（被否方案、跨包边界、新 prose 语义、双语译文、文档与代码同一事实）的单源是 `docs/AGENTS.md` §6 与 PR 模板，本 skill 不复述；评审顺序、证据要求与报告格式才是本文件的职责。

## 报告

- 每条写：缺陷 + 位置（`path:line`）+ 影响 + 证据；blocker 与建议分开；已由绿门禁覆盖的不重复。
- 给出可执行的修法；对评审意见逐条评估，可技术性反驳，不做表演性同意。
- 收尾说明：复跑了哪些命令、结果、未验证什么。
