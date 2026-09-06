# 未实现功能记录（docs/progress/todo）

> 本目录只记录**想到但尚未实现**的功能想法（todo），每条一个文件，粒度停留在
> 想法/待设计。设计一旦定稿（形成契约），移入 `docs/design/0X-*.md` 并同步
> `docs/progress/STATUS.md`；已落地 / 明确不做的项直接移出本表，不保留历史记录。

## 目录

| # | 文件 | 主题 | 状态 |
|---|---|---|---|
| 1 | [subagents-in-sidebar.md](subagents-in-sidebar.md) | session 的 subagents 在侧边栏中的显示 | 想法，未设计 / 未排期 |
| 2 | [12-todo-archived-sessions.md](12-todo-archived-sessions.md) | 已归档会话管理（调研记录；「删除已归档内容」已由 design 24 承接定稿：chamber 宿主域插件 + server 行 hover 动作，B 特权层仍冻结） | 已承接，实现未排期（2026-12） |
| 3 | [21-gateway-plugin-parity-plan.md](21-gateway-plugin-parity-plan.md) | gateway 插件能力对齐执行计划（design 21 companion：B→C+共享迁移→A0→A1 写面单元→UI 全闭环→文档归位，逐阶段门禁） | 执行中：Phase 1-5 已实现并通过执行级门禁（零 P0/P1，2026-12）；Phase 6 文档归位收尾 |
| 4 | [windows-v1.md](windows-v1.md) | Windows v1 推进执行台账（design 23 companion：M0 CI 契约腿 → M1 生命周期 → M2a env 门控后台能力 → M3 桌面实机全链 → M4 决策解锁 → M5 发布面 → M6 收口，外部门禁逐项标注） | 执行中：M0–M4 代码项已落地并通过 POSIX 单测（2026-12）；真实 Windows runner/实机矩阵为外部门禁 |
| 5 | [24-archived-session-cleanup-plan.md](24-archived-session-cleanup-plan.md) | 已归档会话清理执行台账（design 24 companion：M0 评审包/决策点 D1–D7、vendor 前置核对记录表、M1–M4 任务与门禁） | 已实现并合入 main（2026-12：design 24 定稿 + 合并 989534a = 3a5bbcf 启用批次 + 8429fee 修复轮）；M4 实机 E2E 仍待验；2026-09 修复轮已闭合评审遗留 |

## 纪律

- 每条 todo 以想法级粒度记录：动机、现状对照（相关设计 / 已落地面 / 宿主覆盖情况）、开放问题。
- 设计定稿 → 移至 `docs/design/0X-*.md`，更新本表并同步 STATUS。
- 落地 / 明确不做 → 从本表移除，结论记入 `docs/progress/STATUS.md`。
