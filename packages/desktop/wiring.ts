/**
 * Wiring-assembly shared pieces for the main.ts → ipc-*.ts split (A1): the
 * pure decision functions extracted from main.ts's drain queues / close-to-
 * tray gating / quit state machine, plus the drain-queue budget. Electron-
 * free by construction (no runtime electron import), so the decision
 * functions are unit-testable with plain node:test (see wiring.test.ts).
 *
 * The electron side effects (BrowserWindow / webContents.send / dialogs)
 * stay in main.ts and the ipc-*.ts wiring modules; only the decisions that
 * can be pure live here.
 */

/** Bounded queue push (drain-queue budget, design 16 §4.2 / 19 §3.3):
 *  append the item and drop the OLDEST when the cap is exceeded — the queue
 *  never grows unbounded (window long unloadable → drop oldest, never leak).
 *  Returns the new queue (immutable-style: the caller reassigns its holder). */
export function enqueueBounded<T>(queue: readonly T[], item: T, max: number): T[] {
  const next = [...queue, item]
  return next.length > max ? next.slice(next.length - max) : next
}

/** 深链 seen-set 去重 + 上限（design 16 §4.2）：同 URL 去重（macOS open-url 与
 *  argv 双触发同一 URL）；超过 cap 条整体清空（非 LRU——清空后同 URL 可重放，
 *  打开 VS Code 幂等，无害；security-review P2-4 注释与实现语义对齐）。
 *  返回该 URL 是否应继续处理（未见过 = true；重复 = false）。 */
export function recordDeepLinkSeen(seen: Set<string>, url: string, cap: number): boolean {
  if (seen.has(url)) return false
  seen.add(url)
  if (seen.size > cap) seen.clear()
  return true
}

/** 通知打开 drain 的放行条件（design 19 §3.3）：窗口存在、已完成加载、未崩溃
 *  且 renderer 已注册 onOpen 监听（notifications-ready 置位）。任一条件不满足
 *  → 重新入队，did-finish-load / ready IPC 后再补发（窗口关闭期间点击通知不丢
 *  事件）。 */
export function shouldDrainNotificationOpen(input: {
  windowAlive: boolean
  isLoading: boolean
  isCrashed: boolean
  rendererReady: boolean
}): boolean {
  return input.windowAlive && !input.isLoading && !input.isCrashed && input.rendererReady
}

/** 本地实例「运行中/在途」状态（design 14 D2，2026-08 修订）：进程存活
 *  （ready/degraded）或 spawn/重启在途（starting/restarting）——退出会中断
 *  它们，需确认。stopped / error / restart-exhausted 无进程可中断，不触发
 *  确认。**2026-08 二次修订**：状态字符串不是存活事实——restart 序列里
 *  `restarting` 期间新进程可能尚未 spawn（backoff 1s→60s），死亡进程在下次
 *  探活前也可能滞留在 ready/degraded；退出确认必须同时要求**实际有存活进程**
 *  （localProcessAlive），否则"本地明明没有实例在运行"也会误弹确认。注意
 *  `starting` 全程 child 尚未赋值（spawn 解析后才挂到连接上），配合 AND 门
 *  实际不参与确认——spawn 在途由控制面的 epoch/stopping 守卫在 stop() 时终止
 *  （绝不孤儿化），故「无进程则不确认」是安全的。 */
export const LOCAL_RUNNING_STATES: ReadonlySet<string> = new Set(['starting', 'ready', 'degraded', 'restarting'])

/** The before-quit local-running gate: state machine says running AND the
 *  control plane actually has a live local process. */
export function isLocalProcessRunning(connectionState: string, localProcessAlive: boolean): boolean {
  return LOCAL_RUNNING_STATES.has(connectionState) && localProcessAlive
}

/** 更新已下载待装（design 11 autoInstallOnAppQuit，用户已确认过「更新」并被告知
 *  「退出时安装」）→ before-quit 免确认（design 14 D2 豁免）。 */
export function isUpdateDownloadReady(
  updateState: { phase: string; installBlockedReason: string | null } | undefined,
): boolean {
  return updateState !== undefined
    && updateState.phase === 'downloaded'
    && updateState.installBlockedReason === null
}

/** The drain-queue budget shared by the deep-link seen-set and the
 *  notification-open queue (64 entries; both were hardcoded 64 in main.ts). */
export const DRAIN_QUEUE_LIMIT = 64
