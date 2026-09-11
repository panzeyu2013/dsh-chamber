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
| 4 | [settings-surface-upstream-contributions.md](settings-surface-upstream-contributions.md) | 设置面的上游声明式贡献通道（T3 提案：`dsh.client.contributes.settings` / 设置面服务契约 / descriptor 上线通道）；chamber 侧图驱动设置面已落地（design 05 §5 / 09 §5，2026-12） | 上游提案，未排期 |
| 5 | [open-in-ownership-and-enhancements.md](open-in-ownership-and-enhancements.md) | open-in **实机验收与超集分批**（fork & supersede 已落地，契约见 design 20）：真机验收九项、`ctx.subprocess` 旧 runtime 探针等开放项、分批结论（S1/S2 待排期；S3 收窄为「复制路径」；S4 不做）+ §5 附录留档的完整形态 | 实施已完成；本表剩真机 + S1/S2 + 可选小批次 |

## 纪律

- 每条 todo 以想法级粒度记录：动机、现状对照（相关设计 / 已落地面 / 宿主覆盖情况）、开放问题。
- 设计定稿 → 移至 `docs/design/0X-*.md`，更新本表并同步 STATUS。
- 落地 / 明确不做 → 从本表移除，结论记入 `docs/progress/STATUS.md`。
