# @dsh-chamber/dsh-runtime

**宿主无关**的 dsh 运行时版本管理核心（设计 [18](../../docs/design/18-dsh-runtime-version.md)）：解析 → 下载 → 安装 → 验证 → 激活/回滚，全部策略都在这里，由 desktop 主进程与 gateway 各自适配注入（两者从不共享运行时状态）。

## 契约与边界

- **纯 Node**：不 import Electron、不碰 control-plane、不依赖 IPC；进程执行器由宿主经 `deps.node` 注入（desktop 注入 Electron-as-node，gateway 用纯 node）。
- **单一来源**：版本经 registry 解析（域名白名单 + 重定向门 + 流式 SRI 校验），顶层 tarball 交给 pnpm 作为本地 tarball，避免 check→install 之间被重新解析。
- **事务化激活**：staging 安装 → 探针门 → 指针切换 → 判定/回滚；`activation-journal.json`、`snapshots/`、`pre-rollback/`、`restore-in-progress` 构成可恢复链；`known-good` = 探针通过 + 24h 连续健康。
- **失败即留证**：失败场景写 `<version>.failed`；元数据损坏进入 FATAL 块（`journal-corrupt` / `current-corrupt` / `override-corrupt` / `journal-mismatch`）而不是猜测修复。
- **安装子进程环境是白名单**：只有 `PATH` 与代理变量过界（`INSTALL_ENV_WHITELIST`），其余一律剔除；HOME/XDG/`NPM_CONFIG_USERCONFIG` 指向私有目录。

## 主要模块

`runtime-installer.ts`（下载/安装/发布）、`runtime-startup.ts`（启动期应用链）、`dsh-runtime-store.ts`（布局与版本树）、`snapshot-store.ts`（快照与恢复标记）、`activation-gate.ts` / `apply-phase.ts` / `rollback-facts.ts`（激活与回滚判定）、`runtime-probes.ts`（激活探针集）、`runtime-metadata-recovery.ts`（元数据恢复）、`known-good-monitor.ts`、`allow-builds.mjs`（ALLOW/DENY 单一来源，构建期与运行期共用）。

## 测试

`pnpm run test:runtime`（含 Windows 语义 `test:win32`）。剩余实机门禁（打包 `.app`、Linux server、gateway 重启重连窗口等）以 [`docs/progress/STATUS.md`](../../docs/progress/STATUS.md) 为准。
