# @deepseek-ai/dsh-api-gateway

上游 `@deepseek-ai/dsh-api-gateway` 客户端半的仓内 fork（[design 14](../../docs/design/runtime/14-sleep-background.md) §D4；registry `fork.dsh-api-gateway`，偏差 G43）：按 entry 把 `/api/remote.mux` 落到每实例反代前缀，并叠加载体补丁（节流重开、开帧守卫、open 期限、journal 静默看门狗）。

## 契约与边界

- 只 fork 客户端半；host-only 依赖与 `stream-server.ts` / `index.ts` 不复制，exports 只保留 `.`、`./client`、`./package.json`（上游的 `./types`、`./src/*`、`./stream-protocol`、`./locale/*.json` 不镜像）。
- 运行期只做载体与重试语义；会话事实与 UI 归 renderer / 宿主。
- pin 升级按 fork 重放：diff 上游、逐补丁核对锚点（`test/patch-lock/`），不得直接覆盖。

## 主要模块

- `src/client/stream-client.ts` / `remote-stream.ts` / `journal-stream.ts` — 逻辑流、远端流与 journal 载体。
- `src/client/remote-retry-policy.ts` / `stream-stall-policy.ts` / `stream-carrier-fact.ts` — 重试、停滞与载体事实。
- `src/stream-protocol.ts` / `src/remote-error-codes.ts` — 线协议与错误码。

开放项见 [STATUS](../../docs/progress/STATUS.md)。
