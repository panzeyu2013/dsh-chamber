# @dsh-chamber/dsh-chamber-seed-git-worktree

实例内 Git worktree 宿主域（[design 08](../../docs/design/plugins/08-git-worktree-plugin.md)）：`gitWorktree/*` 的保守本地操作——快照、分支候选、创建/删除与安全校验。

## 契约与边界

- 只在源仓库内 `.agents/worktrees` 池操作；不推送/拉取、不改远端。
- 动作 fail-closed：路径/参数校验失败即拒绝。
- 不成为控制面/桌面的执行面：只分发与挂行。

## 主要模块

- `src/core.ts` / `core-ops-create.ts` / `core-git-runner.ts` — 操作编排与 git 调用。
- `src/core-validation.ts` / `core-parse.ts` / `core-errors.ts` — 校验、解析与错误分类。

开放项/已知限制见 owning design 的「已知限制」段与 [TODO](../../docs/progress/TODO.md)（STATUS 已停用，2026-11-23）。
