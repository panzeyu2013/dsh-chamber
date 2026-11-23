# @dsh-chamber/dsh-chamber-seed-archive-cleanup

实例内归档会话内容清理域（[design 24](../../docs/design/plugins/24-archived-session-cleanup.md)）：`archiveCleanup/{probe,purge}` 在权威 workspaceRegistry / agents 状态上探测与清理。

## 契约与边界

- 只清已归档会话内容；保护边界与维护期 force 语义以 design 24 为准。
- 事实权威在宿主：本包不建第二份会话索引。
- wire 名称与参数表单源在 `@dsh-chamber/dsh-chamber-wire`。

## 主要模块

- `src/index.ts` / `src/binding.ts` — 服务绑定与端点。
- `src/core.ts` — 探测/清理核心。

开放项/已知限制见 owning design 的「已知限制」段与 [TODO](../../docs/progress/TODO.md)（STATUS 已停用，2026-11-23）。
