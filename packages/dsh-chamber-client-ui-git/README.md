# @dsh-chamber/dsh-chamber-client-ui-git

每实例 Git worktree 客户端插件（[design 08](../../docs/design/plugins/08-git-worktree-plugin.md)）：官方侧栏壳内的 checkout 行、创建/删除对话框与 `sidebar.workspace.git` 座席；宿主侧由 `dsh-chamber-seed-git-worktree` 配对。

## 契约与边界

- Git 事实与动作全在客户端侧；控制面只分发 host 包并挂行，不经 SSH 执行 Git。
- 删除/清理两段式确认 + 有界重试；失败留在行内，不静默吞。
- 随包客户端插件：注册进复合构建，不新增运行期依赖。

## 主要模块

- `src/client/index.ts` — 插件注册与座席接线。
- `src/client/SidebarWorkspaceGitLine.tsx` / `CreateWorktreeDialog.tsx` / `CheckoutRemoveDialog.tsx` — 行与对话框。
- `src/shared/*` — 快照、saga、轮询、可见性门与错误分类。

开放项/已知限制见 owning design 的「已知限制」段与 [TODO](../../docs/progress/TODO.md)（STATUS 已停用，2026-11-23）。
