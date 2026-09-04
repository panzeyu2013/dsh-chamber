/**
 * 未读徽标计数投影（design 19 §3.7）——pure logic, no React/DOM, node:test
 * runnable (see test/badge-count.test.ts).
 *
 * The count is a PROJECTION of the App-owned「完成未读」blue-dot set
 * (`completedBySource`, App.tsx / 06 §4.1) — never a second state machine:
 * the same running→idle arming and reading-disarm rules that drive the
 * in-window dots drive the OS badge, so the two surfaces can never disagree.
 * Semantics mirror OpenChamber's `dockBadgeCount` (chats with unseen
 * activity, not the number of notifications): one unit per unseen session,
 * 0 = clear the badge.
 *
 * RUNNING-SUBAGENT SUPPRESSION (06 §4.5 parity): the App's dot machine arms
 * at the parent's running→idle edge even when the parent round ended only
 * because BACKGROUND subagents still work — the in-window dot is then hidden
 * by the sidebar's state priority (runningSubagents ring outranks the
 * completed dot) and the design-19 §3.2 complete edge is filtered by the same
 * rule. The OS badge must apply the identical suppression instead of
 * projecting the raw armed ledger: pass the source's latest runtime-facts
 * report (`runtimeFacts[sourceId].sessions`), and an armed session whose row
 * still carries `runningSubagents > 0` is NOT counted. Once all subagents
 * finished the armed dot surfaces normally (same moment the sidebar shows the
 * completed dot again); a re-run disarms the dot in the shared state machine
 * and the badge clears with it. A session absent from the latest report or a
 * source without a report snapshot keeps the pre-suppression semantics (no
 * suppression info → no guesswork); callers without the channel may omit the
 * argument.
 */

/**
 * Minimal structural slice of one source's runtime-facts report
 * (InstanceRuntimeReport): only the `runningSubagents` row field matters for
 * suppression. Deliberately NOT imported from the sidebar shared module so
 * this module keeps zero imports and stays runnable anywhere.
 */
export interface BadgeSuppressionFacts {
  sessions?: Record<string, { runningSubagents?: number }>
}

/**
 * 跨来源求「完成未读」会话数：对每个来源的蓝点集里值为 true 的会话计数，
 * 但排除当前事实行仍有运行中子代理（runningSubagents > 0）的会话（06 §4.5
 * 与窗口内运行环压制/complete 通知抑制同规——子代理干活中的会话不是完成）。
 * 0 = 无未读（主进程清除徽标）。空集/缺来源/undefined 均安全返回 0
 * （纯投影对全域 total，任何调用点都不需要自行判空）。
 */
export function projectBadgeCount(
  completedBySource: Record<string, Record<string, boolean>> | undefined,
  runtimeFacts?: Record<string, BadgeSuppressionFacts | undefined>,
): number {
  if (completedBySource === undefined) return 0
  let count = 0
  for (const [sourceId, sessions] of Object.entries(completedBySource)) {
    const facts = runtimeFacts?.[sourceId]
    for (const [sessionId, armed] of Object.entries(sessions)) {
      if (armed !== true) continue
      if ((facts?.sessions?.[sessionId]?.runningSubagents ?? 0) > 0) continue
      count += 1
    }
  }
  return count
}
