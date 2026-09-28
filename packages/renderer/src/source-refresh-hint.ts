/**
 * 行刷新提示的纯判定：watcher 的 session-added/removed/changed 只发提示，
 * 行权威仍在聚合 unary（App.refreshAggregate），提示只为把「新行/新状态 ≤1 次往返」做实。
 * 四拒：未连接、事实无法确认（unverified）、该来源已有在途拉取、页面不可见（visible === false；
 * 隐藏期不发起拉取，恢复可见由聚合 watchdog 的 visibilitychange 补偿）；外加 1s floor
 * 压掉高频 delta 风暴。
 */

export const SOURCE_REFRESH_HINT_FLOOR_MS = 1_000

export interface SourceRefreshHintInput {
  connected: boolean
  /** 该来源已被判「事实无法确认」（App.tsx 的 unverified 集合 / 90s 界限）。 */
  unverified: boolean
  inFlight: boolean
  /** 页面可见性（`document.visibilityState === 'visible'`）：`false` ⇒ 拒绝。
   *  调用方必须传；缺省（undefined）按 true 保守。 */
  visible?: boolean
  lastHintAt: number | undefined
  now: number
}

export function shouldDispatchRefreshHint(
  input: SourceRefreshHintInput,
  floorMs: number = SOURCE_REFRESH_HINT_FLOOR_MS,
): boolean {
  if (input.visible === false || !input.connected || input.unverified || input.inFlight) return false
  if (input.lastHintAt === undefined) return true
  return input.now - input.lastHintAt >= floorMs
}
