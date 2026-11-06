/**
 * 未读徽标计数投影（design 19 §3.7）——pure logic, no React/DOM, zero imports,
 * node:test runnable (see test/aggregate/badge-count.test.ts).
 *
 * The count is a PROJECTION of the merged completion set — the vendor's official
 * completion-unread bit (channel rows, memory-only in the owning ctx) ∪ the
 * App-owned N-ctx correction arm (\`correctionArms\`, App.tsx / 06 §4.1) — never a
 * second state machine: the same official arming/clearing rules that drive the
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
 *    count is NOT "still working"). Only \`running\` suppresses here; \`unknown\`
 *    stays neutral, so this module never re-checks staleness itself.
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
 *
 * ARCHIVED-ROW EXCLUSION (design 06 §3.4 / §8.1, design 19 §3.7): an archived
 * session is NEVER presented as completed-unread by any in-window face — the
 * list row leaves its state slot empty (`ServerSectionRows`), search-hit rows
 * do the same, the hover card filters the completed status line, the todo strip
 * excludes archived rows outright, and an archived row is not openable, so the
 * user could never clear it by reading it. Counting such a row in the OS badge
 * therefore leaves a number that no visible unread content corresponds to and
 * that cannot be cleared — the exact phantom-unread the todo strip already
 * refuses. The caller passes the archived ids of the SAME provenance the
 * rendering projection hides rows by (the authoritative archive set — including
 * the remembered set a degraded source still carries — plus this page's archive
 * echo). The set is derived from the projection, so a source with NO projection
 * right now (disconnected / aggregate not ready) carries no ids: the frozen-arm
 * boundary in design 19 §3.7 then applies unchanged (the badge may keep showing
 * such unread until reconnect restores the projection; it drops to 0 then).
 */

/**
 * Structural slice of one source's runtime-facts report (InstanceRuntimeReport
 * sessions rows) as the badge consumes it: the suppression dimensions are the
 * subagent activity tri-state (stale-guarded by the caller) plus the
 * precomputed goal gate. The sibling field merged rows carry (\`completed\`) is
 * the official channel bit plus the App's N-ctx correction arm applied at merge
 * time, so the same shape accepts merged integration rows. Deliberately NOT
 * imported from the sidebar shared module so this module keeps zero imports and
 * stays runnable anywhere.
 */
export interface BadgeSuppressionFacts {
  sessions?: Record<string, {
    completed?: boolean
    /**
     * 归一后的子代理活动（sidebar subagentActivityOf 的输出；stale 的 running
     * 已降 unknown）。只有 running 压制；unknown/none 中性。
     */
    subagentActivity?: 'none' | 'running' | 'unknown'
    /**
     * goal 呈现门的**预计算**结果（sidebar goalSuppressesPresentation(row.goal)）：
     * active 相位（含 activation unknown）期间已武装的完成不计入徽标。
     */
    goalActive?: boolean
  }>
}

/** 子代理压制：只有归一后的 running 压制（unknown/none 中性；stale 已在调用方降为 unknown）。 */
function subagentSuppressesBadge(
  row: NonNullable<BadgeSuppressionFacts['sessions']>[string] | undefined,
): boolean {
  return row?.subagentActivity === 'running'
}

/**
 * 跨来源求「完成未读」会话数——输入是官方位所在的**合并投影** + App 的 N-ctx 修正臂：
 * 官方 \`row.completed\` 走通道（\`mergeRuntimeFacts\` 只追加修正臂），\`correctionArms\`
 * 是有壳隐藏来源 current 行 ∪ 无壳（facts-only provenance，design 06 §4.1/§4.2）来源
 * 逐行 host 运行边沿的内存补臂（按行、不扫描）。两个析取 ≡ mergeRuntimeFacts 的
 * 合并结果，与侧栏行尾蓝点/待办区的权威完全一致，因此不会出现「点/待办有、徽标无」的诚实分叉。
 *
 * 仍排除：①当前事实行归一为在跑的子代理（三值 running；06 §4.5 与窗口内运行环压制、
 * complete 通知抑制同规——子代理干活中的会话不是完成；stale/unknown 已由调用方降级、
 * 中性不压制）；②goal 相位 active 的已武装完成（v5 §4 的呈现门）。0 = 无未读（主进程清除徽标）。
 * 空集/缺来源/undefined 均安全返回 0（纯投影对全域 total，任何调用点都不需要
 * 自行判空）。
 */
export function projectBadgeCount(
  correctionArms: Record<string, Record<string, boolean>> | undefined,
  runtimeFacts?: Record<string, BadgeSuppressionFacts | undefined>,
  /**
   * sourceId → session ids the in-window faces never present as unread
   * (archived rows: every face blanks them, and an archived row cannot be
   * opened, so such an arm/bit could never be cleared by reading). Omitted or
   * an empty set keeps the pre-exclusion semantics; a source with no projection
   * right now (disconnected / aggregate not ready) carries no ids here and the
   * design 19 §3.7 frozen-arm boundary applies.
   */
  archivedSessions?: Record<string, ReadonlySet<string>>,
): number {
  if (correctionArms === undefined && runtimeFacts === undefined) return 0
  const sources = new Set<string>([
    ...Object.keys(correctionArms ?? {}),
    ...Object.keys(runtimeFacts ?? {}),
  ])
  let count = 0
  for (const sourceId of sources) {
    const ledger = correctionArms?.[sourceId]
    const facts = runtimeFacts?.[sourceId]
    const archived = archivedSessions?.[sourceId]
    const sessions = new Set<string>([
      ...Object.keys(ledger ?? {}),
      ...Object.keys(facts?.sessions ?? {}),
    ])
    for (const sessionId of sessions) {
      // 归档行在任何窗口内呈现面上都不呈现「完成未读」（状态槽留空 / 待办排除 /
      // 不可打开）——计入 Dock 只会留下无法通过查看清掉、也没有可见对应物的数字。
      if (archived?.has(sessionId) === true) continue
      const row = facts?.sessions?.[sessionId]
      const armed = ledger?.[sessionId] === true || row?.completed === true
      if (!armed) continue
      if (row?.goalActive === true) continue
      if (subagentSuppressesBadge(row)) continue
      count += 1
    }
  }
  return count
}

/**
 * 徽标计数的归档行排除集（design 06 §3.4/§8.1、design 19 §3.7）。纯函数、零 import：
 * 归档行在窗口内任何呈现面上都不呈现「完成未读」（列表/搜索/悬停状态槽留空、待办区
 * 显式排除），且归档行不可打开——用户无法通过查看清除它；计入 Dock 只会留下一个没有
 * 可见对应物也清不掉的数字。集合与渲染投影**同源**：来源连接且聚合就绪时取权威归档集
 * （含降级来源记住的权威集，投影同规则隐藏其行）∪ 本页归档回声（`withPendingArchives`
 * 隐藏的行）；来源当前无投影（断连/未就绪）时排除集不可得——角标按 design 19 §3.7 的
 * 断连边界处理（冻结臂可继续计数，重连后随投影恢复归零）。
 *
 * 入参刻意写成结构切片而不是 client-core 类型，保证本模块零 import。
 */
export interface BadgeArchivedSource {
  id: string
  archivedSessions?: readonly { sessionId: string }[]
}

export function projectArchivedSessionIds(
  servers: readonly BadgeArchivedSource[],
  /** 本页归档回声账本（PendingArchive 的结构切片；`at` 是租约锚，本函数不读）。 */
  archiveEcho?: Readonly<Record<string, readonly { sessionId: string; at?: number }[]>>,
): Record<string, ReadonlySet<string>> {
  const record: Record<string, ReadonlySet<string>> = {}
  for (const server of servers) {
    const ids = new Set<string>()
    for (const row of server.archivedSessions ?? []) ids.add(String(row.sessionId))
    for (const pending of archiveEcho?.[server.id] ?? []) ids.add(pending.sessionId)
    if (ids.size > 0) record[server.id] = ids
  }
  return record
}
