# @dsh-chamber/dsh-chamber-client-ui-open-in

每实例 open-in 客户端插件（design [16](../../docs/design/desktop/16-vscode-deeplink.md)、[20](../../docs/design/desktop/20-open-in-registry.md)）：页级机器目录（应用与真实图标）+ 该来源的启动载体；同时承载会话流健康座席（[design 14](../../docs/design/runtime/14-sleep-background.md) §D4）。

## 契约与边界

- 只在 renderer 发意图与呈现；探测/启动经宿主或桌面边沿。
- 本地目录走 seed host 域，远端 SSH 目标走桌面 provider，两条载体不混。
- 健康座席只做证据门控的 resync 与停留提示，不改上游会话契约。

## 主要模块

- `src/client/index.ts` / `OpenInButton.tsx` — 头部入口与菜单。
- `src/client/machine-catalog.ts` / `source-adapter.ts` — 目录与来源适配。
- `src/client/session-stream-health*.ts` / `*.tsx` — 健康探针、芯片与座席。

开放项/已知限制见 owning design 的「已知限制」段与 [TODO](../../docs/progress/TODO.md)（STATUS 已停用，2026-11-23）。
