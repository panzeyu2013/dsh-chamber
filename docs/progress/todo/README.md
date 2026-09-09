# 未实现功能记录（docs/progress/todo）

> 本目录只记录**想到但尚未实现**的功能想法（todo）与仍需执行的外部门禁，每条一个
> 文件，粒度停留在想法/待设计。设计一旦定稿（形成契约），移入 `docs/design/0X-*.md`
> 并同步 `docs/progress/STATUS.md`；已落地 / 明确不做的项直接移出本表，不保留历史
> 记录（已执行计划的台账随实施完毕从本目录删除——留存于 git 历史）。

## 目录

| # | 文件 | 主题 | 状态 |
|---|---|---|---|
| 1 | [subagents-in-sidebar.md](subagents-in-sidebar.md) | session 的 subagents 在侧边栏中的显示 | 想法，未设计 / 未排期 |
| 2 | [12-todo-archived-sessions.md](12-todo-archived-sessions.md) | 已归档会话管理剩余面：「已归档」浏览区（A，design 24 可选后续，未排期）；特权层直删（B，冻结）；上游 wire 草案（C，上游落地前不发明） | A 未排期；B 冻结；C 待上游 |
| 3 | [windows-v1.md](windows-v1.md) | Windows v1 剩余外部门禁与取舍（design 23 companion；代码项已就绪） | 外部门禁待真实 runner/实机 |
| 4 | [branch-plan-v0.1.3-alpha1.md](branch-plan-v0.1.3-alpha1.md) | v0.1.3-alpha1 分支执行计划 T1–T4：追踪 alpha.2 / 命名统一 / fork 重锚 / open-in 统一 / 上游触点清单（方案已定稿，用户批准） | 执行中：**Batch 0（T1）✅ + Batch 0.5（T4）✅ + Batch 1（T2）✅ + Batch 2（fork 重锚）✅ 已完成**（记录见 STATUS）；Batch 3（T3）待推进（绿门见文内 §8） |

## 纪律

- 每条 todo 以想法级粒度记录：动机、现状对照（相关设计 / 已落地面 / 宿主覆盖情况）、开放问题。
- 设计定稿 → 移至 `docs/design/0X-*.md`，更新本表并同步 STATUS。
- 落地 / 明确不做 → 从本表移除，结论记入 `docs/progress/STATUS.md`。
