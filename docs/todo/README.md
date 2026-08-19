# 未实现功能记录（docs/todo）

> 本目录记录**想到但尚未实现**的功能想法（todo），每条一个文件，粒度停留在
> 想法/待设计。设计一旦定稿（形成契约），移入 `docs/design/0X-*.md` 并同步
> 本表与 `docs/progress/STATUS.md`；进度追踪仍以 `docs/progress/STATUS.md`
> 为唯一记录。

## 目录

| # | 文件 | 主题 | 状态 |
|---|---|---|---|
| 1 | [subagents-in-sidebar.md](subagents-in-sidebar.md) | session 的 subagents 在侧边栏中的显示 | 想法，未设计 / 未排期 |
| 2 | [server-drag-sort.md](server-drag-sort.md) | server 之间的拖拽排序 | 想法，未设计 / 未排期 |
| 3 | [08-todo-git-worktree-plugin.md](08-todo-git-worktree-plugin.md) | Git worktree 独立插件 | 设计定稿，实现未排期（2026-08-16 自 `docs/design/` 移入；"08" 编号沿用历史引用） |
| 4 | [10-todo-event-driven-aggregation.md](10-todo-event-driven-aggregation.md) | 侧边栏聚合改事件驱动（各来源 ctx 推投影取代 10s 轮询） | 设计待评审，实现未排期（2026-08） |
| 5 | [12-todo-archived-sessions.md](12-todo-archived-sessions.md) | 已归档会话管理（归档单向且不可见；A 前端浏览区先行 + C 上游 wire 根治，B 特权层冻结） | 设计待评审，实现未排期（2026-08） |

> 已实现并移入 `docs/design/`：设计 14（睡眠/后台常驻）、设计 15（Chamber 设置页）。

## 纪律

- 每条 todo 以想法级粒度记录：动机、现状对照（相关设计 / 已落地面 / 宿主覆盖情况）、开放问题。
- 设计定稿 → 移至 `docs/design/0X-*.md`，更新本表并同步 STATUS。
- 落地 / 明确不做 → 从本表移除，结论记入 `docs/progress/STATUS.md`。
