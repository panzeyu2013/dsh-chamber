/**
 * sidecar 退出码分级：0 优雅停止（SIGTERM/SIGINT/stdin EOF）、1 运行期崩溃
 * （Swift Supervisor 按崩溃退避重启）、3 目录锁冲突、70 启动失败；3/70 fatal
 * 均不重启。Swift 侧 `SidecarSupervisor.handleTermination` 按 0/3/70/其它分级。
 *
 * 单独成模块：`sidecar-entry.ts` 顶层解析 argv 并启动控制面，直接 import 会
 * 执行 boot——常量必须能在不触发 boot 的前提下被引用。
 */
export const EXIT_GRACEFUL = 0
export const EXIT_RUNTIME_CRASH = 1
export const EXIT_LOCK_CONFLICT = 3
export const EXIT_STARTUP_FAILURE = 70
