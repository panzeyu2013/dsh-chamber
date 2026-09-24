/**
 * 未读徽标计数投影（design 19 §3.7）——pure logic, no React/DOM, zero imports,
 * node:test runnable (see test/aggregate/badge-count.test.ts).
 *
 * The count is a PROJECTION of the App-owned「完成未读」blue-dot set
 * (\`completedBySource\`, App.tsx / 06 §4.1) — never a second state machine:
 * the same running→idle arming and reading-disarm rules that drive the
 * in-window dots drive the OS badge, so the two surfaces can never disagree.
 * Semantics mirror OpenChamber's \`dockBadgeCount\` (chats with unseen
 * activity, not the number of notifications): one unit per unseen session,
 * 0 = clear the badge.
 *
 * ROW-LEVEL SUPPRESSION — both dimensions mirror the sidebar's single
 * priority source (session-row-state.ts) so the badge matches the six faces
 * (INV7):
 *
 *  - RUNNING-SUBAGENT SUPPRESSION (06 §4.5 parity): the App's dot machine arms
 *    at the parent's running→idle edge even when the parent round ended only
 *    because BACKGROUND subagents still work — the in-window dot is then hidden
 *    by the sidebar's state priority (runningSubagents ring outranks the
 *    completed dot).
 *    The caller that owns the merged runtime (use-badge-count) passes the
 *    tri-state \`subagentActivity\` it computed through the sidebar's
 *    \`subagentActivityOf\` (the stale guard included: a stale source's residual
 *    count is NOT "still working"). Legacy callers may still pass the sparse
 *    \`runningSubagents\` count; the same stale guard applies here, so a stale
 *    report never suppresses.
 *
 *  - ACTIVE-GOAL SUPPRESSION (design 19 §3.2.1/§3.2.5): an armed
 *    completion whose session has an ACTIVE goal is not presented as a
 *    completion (presentation gate = phase, activation unknown included), so
 *    the badge must not count it either — otherwise the Dock lights a red
 *    bubble for a dot the user cannot see. The caller precomputes the boolean
 *    with the sidebar's zero-dependency leaf predicate
 *    (\`goalSuppressesPresentation\`) and passes \`goalActive\`; this module keeps
 *    ZERO imports by construction (只消费谓词的结果，不 import 谓词本身).
 *
 * A session absent from the latest report or a source without a report
 * snapshot keeps the pre-suppression semantics (no suppression info → no
 * guesswork); callers without the channel may omit the argument.
 */

/**
 * Structural slice of one source's runtime-facts report (InstanceRuntimeReport
 * sessions rows) as the badge consumes it: the suppression dimensions are the
 * subagent activity tri-state (stale-guarded) plus the precomputed goal gate.
 * The sibling fields real rows carry (\`running\`, \`completed\`, \`pending\`) are
 * part of the shape so realistic row literals typecheck without casts.
 * Deliberately NOT imported from the sidebar shared module so this module
 * keeps zero imports and stays runnable anywhere.
 */
export interface BadgeSuppressionFacts {
  /** 断连来源的只读事实：其中的 runningSubagents 不是「正在干活」的证据。 */
  stale?: boolean
  sessions?: Record<string, {
    running?: boolean
    completed?: boolean
    pending?: 'approval' | 'plan-review' | 'question'
    /** Running subagent descendants; absent = 0 (sparse count shape). */
    runningSubagents?: number
    /**
     * 归一后的子代理活动（sidebar subagentActivityOf 的输出；stale 的 running
     * 已降 unknown）。给出时优先于 sparse count。
     */
    subagentActivity?: 'none' | 'running' | 'unknown'
    /**
     * goal 呈现门的**预计算**结果（sidebar goalSuppressesPresentation(row.goal)）：
     * active 相位（含 activation unknown）期间已武装的完成不计入徽标。
     */
    goalActive?: boolean
  }>
}

/** 子代理压制：declared 三值优先；sparse count 带 stale 守卫（与 sessionRowState 同拍）。 */
function subagentSuppressesBadge(
  row: NonNullable<BadgeSuppressionFacts['sessions']>[string] | undefined,
  stale: boolean,
): boolean {
  const activity = row?.subagentActivity
  if (activity !== undefined) return activity === 'running'
  if ((row?.runningSubagents ?? 0) <= 0) return false
  return stale !== true
}

/**
 * 跨来源求「完成未读」会话数——输入是 App 的**合并投影**，不是账本本身：
 * 一个会话计入当且仅当 \`completedBySource[source][session] === true\`（chamber
 * 边沿账本）**或** \`runtimeFacts[source].sessions[session].completed === true\`
 * （vendor 自武装）。这与侧栏行尾蓝点/待办区的权威完全一致（\`derive.ts\` 的
 * \`mergeRuntimeFacts\` 就是这两者的并集），因此不会出现「点/待办有、徽标无」
 * 的诚实分叉。
 *
 * 仍排除：①当前事实行确认在跑的子代理（06 §4.5 与窗口内运行环压制、complete
 * 通知抑制同规——子代理干活中的会话不是完成；stale 来源不算确认）；②goal 相位
 * active 的已武装完成（v5 §4 的呈现门）。0 = 无未读（主进程清除徽标）。
 * 空集/缺来源/undefined 均安全返回 0（纯投影对全域 total，任何调用点都不需要
 * 自行判空）。
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
    const stale = facts?.stale === true
    const sessions = new Set<string>([
      ...Object.keys(ledger ?? {}),
      ...Object.keys(facts?.sessions ?? {}),
    ])
    for (const sessionId of sessions) {
      const row = facts?.sessions?.[sessionId]
      const armed = ledger?.[sessionId] === true || row?.completed === true
      if (!armed) continue
      if (row?.goalActive === true) continue
      if (subagentSuppressesBadge(row, stale)) continue
      count += 1
    }
  }
  return count
}
