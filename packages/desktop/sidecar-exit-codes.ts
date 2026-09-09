/**
 * sidecar 退出码分级（design 25 §3.3(4)/B7）。
 *
 * 单独成模块：`sidecar-entry.ts` 顶层会解析 argv 并启动控制面，直接 import
 * 会执行 boot——常量必须可被测试与 Swift 侧文档安全引用（2026-09 三审 #7）。
 *
 *   0  EXIT_GRACEFUL        优雅停止（SIGTERM/SIGINT/stdin EOF）
 *   1  EXIT_RUNTIME_CRASH   运行期崩溃（uncaughtException/unhandledRejection）
 *                           → Swift Supervisor 按崩溃退避重启
 *   3  EXIT_LOCK_CONFLICT   目录锁被另一 flavor/实例占用（fatal，不重启）
 *   70 EXIT_STARTUP_FAILURE 启动失败（控制面启动 / boot 装配，fatal，不重启）
 *
 * Swift 侧对应 `SidecarSupervisor.handleTermination` 的 0/3/70/其它分级。
 */
export const EXIT_GRACEFUL = 0
export const EXIT_RUNTIME_CRASH = 1
export const EXIT_LOCK_CONFLICT = 3
export const EXIT_STARTUP_FAILURE = 70
