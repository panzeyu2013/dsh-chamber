/**
 * 未读徽标计数投影（pure logic, no React/DOM）。
 *
 * The count is a PROJECTION of the App-owned「完成未读」blue-dot set (`completedBySource`),
 * never a second state machine: the same running→idle arming and reading-disarm rules drive
 * the in-window dots and the OS badge. Mirror of OpenChamber's `dockBadgeCount`: one unit per
 * unseen session, 0 = clear the badge.
 *
 * RUNNING-SUBAGENT SUPPRESSION: an armed session whose latest runtime-facts row still carries
 * `runningSubagents > 0` is NOT counted (same rule as the sidebar ring / complete notification);
 * a session absent from the latest report, or a source without a snapshot, keeps the
 * pre-suppression semantics (no suppression info → no guesswork).
 */

/**
 * Structural slice of a runtime-facts report: suppression reads only the `runningSubagents` row
 * field; sibling fields are part of the shape so realistic row literals typecheck without casts.
 * Deliberately not imported from client-core so this module keeps zero imports.
 */
export interface BadgeSuppressionFacts {
  sessions?: Record<string, {
    running?: boolean
    completed?: boolean
    pending?: 'approval' | 'plan-review' | 'question'
    /** Running subagent descendants; absent = 0. */
    runningSubagents?: number
  }>
}

/**
 * 跨来源求「完成未读」会话数——输入是 App 的**合并投影**，不是账本本身：一个会话计入当且仅当
 * `completedBySource[source][session] === true` **或** `runtimeFacts[source].sessions[session].completed === true`
 * （与侧栏蓝点/待办区的权威一致），仍排除 `runningSubagents > 0` 的会话（子代理干活中不算完成）。
 * 0 = 无未读（主进程清除徽标）；空集/缺来源/undefined 均安全返回 0。
 */
export function projectBadgeCount(
  completedBySource: Record<string, Record<string, boolean>> | undefined,
  runtimeFacts?: Record<string, BadgeSuppressionFacts | undefined>,
): number {
  if (completedBySource === undefined && runtimeFacts === undefined) return 0
  const sources = new Set<string>([
    ...Object.keys(completedBySource ?? {}),
    ...Object.keys(runtimeFacts ?? {}),
  ])
  let count = 0
  for (const sourceId of sources) {
    const ledger = completedBySource?.[sourceId]
    const facts = runtimeFacts?.[sourceId]
    const sessions = new Set<string>([
      ...Object.keys(ledger ?? {}),
      ...Object.keys(facts?.sessions ?? {}),
    ])
    for (const sessionId of sessions) {
      const armed = ledger?.[sessionId] === true
        || facts?.sessions?.[sessionId]?.completed === true
      if (!armed) continue
      if ((facts?.sessions?.[sessionId]?.runningSubagents ?? 0) > 0) continue
      count += 1
    }
  }
  return count
}
