/**
 * 行刷新提示的纯判定（主计划 §3.3-4 / R9；蓝图 §2-接线 4）。
 *
 * watcher 的 session-added/removed/changed 只发**提示**：行权威仍在聚合 unary
 * （App.refreshAggregate），提示只为把「新行/新状态 ≤1 次往返」做实。
 * 三拒（R20）：未连接、事实无法确认（unverified）、该来源已有在途拉取；
 * 外加 1s floor 压掉高频 delta 风暴（既有并发波 AGGREGATE_POLL_CONCURRENCY 兜底）。
 * 隐藏期由调用方丢弃（与既有后台相位门一致，恢复可见由 visibilitychange 补偿）。
 */

export const SOURCE_REFRESH_HINT_FLOOR_MS = 1_000

export interface SourceRefreshHintInput {
  connected: boolean
  /** 该来源已被判「事实无法确认」（App.tsx 的 unverified 集合 / 90s 界限）。 */
  unverified: boolean
  /** 该来源已有在途 pull（refreshAggregate 的 ownership 表）。 */
  inFlight: boolean
  /** 上一次因提示触发的拉取时刻（ms epoch；缺省 = 从未）。 */
  lastHintAt: number | undefined
  now: number
}

export function shouldDispatchRefreshHint(
  input: SourceRefreshHintInput,
  floorMs: number = SOURCE_REFRESH_HINT_FLOOR_MS,
): boolean {
  if (!input.connected || input.unverified || input.inFlight) return false
  if (input.lastHintAt === undefined) return true
  return input.now - input.lastHintAt >= floorMs
}
