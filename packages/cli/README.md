# @dsh-chamber/cli

控制面（设计 [05 §7.2](../../docs/design/05-connection-manager.md)、端点形状见设计 [04](../../docs/design/04-control-plane-api-data.md)）的**瘦客户端**：不导入 `@dsh-chamber/control-plane`，只经 loopback REST 读取/操作运行中的控制面。

## 命令与边界

- `serve [--port N] [--state-dir DIR] [--dsh-path PATH]` — 前台启动控制面（内嵌 `createControlPlane`），SIGINT/SIGTERM 优雅退出。
- `status [--url URL]` — 控制面与实例概览。
- `connections list|add|rename|remove|writers|reclaim` — 目录读写，以及写者静默诊断（`writers`）与接管（`reclaim`）。
- `host status` / `host logs [--limit N] [--follow]` — 宿主状态与日志。
- 除 `serve` 外全部命令消费控制面 REST；`--json` 给出机器可读输出。

## 契约

- **只读优先**：只有 `serve` 触碰文件系统（状态目录、日志）；凭据与宿主状态留在控制面一侧，CLI 不读私有状态目录。
- **入口只有参数与环境变量**：`DSH_CHAMBER_URL`（控制面 URL）、`DSH_CHAMBER_STATE`（状态目录）、`DSH_CHAMBER_DSH_PATH`（dsh 工作区路径）；CLI 不猜端口。
- **失败出口单一**：错误经 `fail()` 写 stderr 并非零退出，脚本可依赖退出码。

测试：`pnpm run test:cli`。开放项与剩余验收以 [`docs/progress/STATUS.md`](../../docs/progress/STATUS.md) 为准。
