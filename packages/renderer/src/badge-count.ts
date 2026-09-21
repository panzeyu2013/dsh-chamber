/**
 * 未读徽标计数投影（design 19 §3.7）——pure logic, no React/DOM, node:test
 * runnable (see test/aggregate/badge-count.test.ts).
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
 * Structural slice of one source's runtime-facts report (InstanceRuntimeReport
 * sessions rows): suppression reads only the `runningSubagents` row field, but
 * the sibling fields real rows carry (`running`, `completed`, `pending`) are
 * part of the shape so realistic row literals typecheck without casts.
 * Deliberately NOT imported from the sidebar shared module so this module
 * keeps zero imports and stays runnable anywhere.
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
 * 跨来源求「完成未读」会话数——输入是 App 的**合并投影**，不是账本本身：
 * 一个会话计入当且仅当 `completedBySource[source][session] === true`（chamber
 * 边沿账本）**或** `runtimeFacts[source].sessions[session].completed === true`
 * （vendor 自武装）。这与侧栏行尾蓝点/待办区的权威完全一致（`derive.ts` 的
 * `mergeRuntimeFacts` 就是这两者的并集），因此不会再出现「点/待办有、徽标无」
 * 的诚实分叉（plan §3.3-7 裁决 14）。
 *
 * 仍排除当前事实行 `runningSubagents > 0` 的会话（06 §4.5 与窗口内运行环压制、
 * complete 通知抑制同规——子代理干活中的会话不是完成）。0 = 无未读（主进程清
 * 除徽标）。空集/缺来源/undefined 均安全返回 0（纯投影对全域 total，任何调用点
 * 都不需要自行判空）。
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
