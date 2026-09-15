# @dsh-chamber/control-plane

连接管理器核心（设计 [02](../../docs/design/02-host-management-deployment.md)、[03](../../docs/design/03-connections-proxy.md)、[04](../../docs/design/04-control-plane-api-data.md)）：本地 dsh 宿主的生命周期（spawn / 就绪探针 / reaper / 健康监控 / 日志）、管理 REST、**每实例同源反代**（HTTP/WS/SSE）与前端静态服务。

## 契约与边界

- **不做执行面**：控制面只"接入与服务"——不消费宿主帧、不建会话索引、不参与聊天/审批；目标/任务/终端/设置/插件清单全部属于各实例自己的 dsh 宿主与其前端（`AGENTS.md` Purpose）。
- **单帧单源**：官方前端要求同源 `/api`，所以每个实例经 `/api/i/<id>/*` 反代；实例 id 形如 `local` / `dsh-<id>` / `gateway-<id>`（`instance-proxy.ts`）。
- **v1 匿名且 loopback-only**：非 loopback 绑定必须由组合者显式提供 CORS/中间件，否则构造即抛错；Host/Origin 围栏在路由与 upgrade 之前生效（设计 04 §3）。
- **受保护插件集**：`protected-plugins.ts` 决定哪些插件行可被增删（P = B₀∪S∪F），并保证 profile 族一致（设计 13 / C11）。
- **写入者静默门**：无法证明写入者已静默时，本地面以 `409 connection_busy` 拒绝并保持闩锁（设计 02 §3.4）——粘滞状态只在进程重启后解除。

## 主要模块

- `index.ts` — `createControlPlane()`：服务器装配、REST 分发、reaper/闩锁接线、安全头与 CSP。
- `spawn-dsh.ts` — `dsh --profile web` 的 spawn、端口递增重试、pid 记录、`resolveNodeExecutable`。
- `local-connection.ts` — 健康/重启状态机（30s 探测、1s→60s 退避、窗口内重启上限）。
- `proxy-forward.ts` — 与 gateway 共用的转发核心：上限、白名单、长 RPC 豁免、WS 心跳。
- `host-logs.ts` / `catalog.ts` / `json-store.ts` / `private-file.ts` — 滚动日志、连接目录、原子 JSON、私有文件原语。

## 测试

`pnpm run test:control-plane` → `scripts/test.mjs` 的文件清单（每文件一个 `node` 子进程）；Windows 语义在 `pnpm --filter @dsh-chamber/control-plane run test:win32`。测试清单是权威集合：删/改名会失败；新增测试文件必须登记（`pnpm run verify:test-wiring`）。开放项与剩余验收以 [`docs/progress/STATUS.md`](../../docs/progress/STATUS.md) 为准。
