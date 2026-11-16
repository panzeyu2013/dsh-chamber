# @dsh-chamber/dsh-chamber-wire

宿主与客户端共享的中性 wire 契约（[design 24](../../docs/design/plugins/24-archived-session-cleanup.md) 的 `archiveCleanup`、[design 26](../../docs/design/client/26-page-channel.md) 的 page-channel、P1-A 的 `./session-state` / `./json-guards` / `./mux-frame`）：域名与方法名、参数表、帧形状与预算常量。零运行期依赖、无 I/O，源码由 seed 与客户端 bundle 内联。

## 契约与边界

- 只放双方必须逐字一致的字面量与类型；UI、状态机与执行面不进本包。
- 消费面以 `package.json` 的 exports 为准（`./forward`、`./page-channel`、`./plugin-manifest`、`./plugin-row`、`./runtime-status`、`./mux-frame`、`./json-guards`、`./session-state`）；`archive-cleanup.ts` 与 `net-budget.ts` 只经根入口 re-export，消费方禁止深路径。
- 不新增运行期依赖，不引入 DOM / Node 专属 API。

## 主要模块

- `src/index.ts` — 汇总入口与跨域常量。
- `src/session-state.ts` / `mux-frame.ts` / `json-guards.ts` — 会话状态、mux 帧与 JSON 守卫的单源。
- `archive-cleanup.ts` / `forward.ts` / `page-channel.ts` / `plugin-manifest.ts` / `plugin-row.ts` / `runtime-status.ts` / `net-budget.ts` — 各宿主域形状与预算推导。

开放项见 [STATUS](../../docs/progress/STATUS.md)。
