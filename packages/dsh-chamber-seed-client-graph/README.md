# @dsh-chamber/dsh-chamber-seed-client-graph

实例内只读 boot graph 网关（[design 09](../../docs/design/client/09-client-plugin-runtime-loading.md)）：经 `clientGraph/graph` 把该实例的 `dsh.client` 启动图交给 chamber 前端。

## 契约与边界

- 只读：不写 profile、不启停插件、不执行命令。
- 形状以宿主 `clientModules.graph()` 为准，不在本包重解释。
- 随包 seed：本地与远端（ready-time 分发）同一份包；宿主不提供 `clientModules` 服务时该行因 `static inject` 未满足而不装载，页面拿不到图。

## 主要模块

- `src/index.ts` — host 服务与 `clientGraph/graph` 端点。

开放项/已知限制见 owning design 的「已知限制」段与 [TODO](../../docs/progress/TODO.md)（STATUS 已停用，2026-11-23）。
