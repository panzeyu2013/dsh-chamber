# @dsh-chamber/gateway

**显式启动的 server 部署形态**（设计 [17](../../docs/design/17-server-side-gateway.md)）：同一个本地宿主管理器，放在**默认开启认证**的公网请求边界之后。

## 契约与边界

- **不被自动启动、不被控制面 import**：desktop 控制面从不拉起它；它也不对 dsh 事实取得权威（`AGENTS.md` Purpose）。
- **认证默认开启**：浏览器会话（cookie）+ 可选 Bearer token；`--no-auth` 是需二次确认、带安全警告的**有界例外**，不是静默默认。
- **只代理单个本地 dsh**：`gateway-proxy.ts` 是单目标全量透传；它不承担多来源连接管理（那是控制面）。
- **职责面**：认证壳 + 代理 + 运行时管理（`runtime-manager.ts`）+ 凭据面板 + 种子注册表 + 第三方插件写入面（`plugins-exec.ts` / `plugins-tasks.ts`）；业务/会话面一律不下沉。
- **凭据从不出现在投影里**：只经 write-only 表输入；日志与任务投影使用与 desktop 同族的 `sanitize-error` 家族清洗（设计 21 §6.3）。

## 运行与交付

`pnpm run build:gateway` 构建；CLI 入口 `node packages/gateway/src/cli.ts serve|auth status|reset-password|clear`。分发走 GitHub Release 的 `.tgz`（**不发布到 npm**）。测试：`pnpm run test:gateway`。

未完成门禁（重连窗口、运维页缺 `recover-metadata` / `cleanup-version` / `restore-pre-rollback` 等）以 [`docs/progress/STATUS.md`](../../docs/progress/STATUS.md) 为准。
