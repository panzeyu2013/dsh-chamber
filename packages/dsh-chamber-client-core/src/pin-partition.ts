/**
 * 置顶行的**渲染分区**（design 06 §3.4/§5，Phase 4 选项1）——上游 ui-workspace
 * `sectionMembers` 的逐字语义：blank 占位行 → 置顶行（非归档）→ 其余，两个分区
 * 各自保持传入顺序。本仓只做分区，不做账号写入（选项1）：
 *  - manual 模式传入宿主的「最近置顶在前」序（`pinOrder`），块内顺序与上游 pin 写入
 *    账号序后的可见结果一致；
 *  - updated 模式不传 `pinOrder`，块内保持该模式自己的序（本仓 updatedOrder）；
 *  - 集合未知（`pinSetKnown !== true`）时省略 `pinnedIds`：无置顶块、无标记，但 blank
 *    占位行仍按上游 `sectionMembers` 无条件提前（本函数始终被调用）。
 * PURE：无 store、无 DOM，行只按 id/blank/archived 读取。
 */

export interface PinnedPartitionOptions {
  /** 宿主置顶集（非归档成员在调用侧已由行自己的 archived 位过滤）。 */
  pinnedIds?: ReadonlySet<string>
  /** 「最近置顶在前」的宿主数组序；省略 = 块内保持传入顺序。 */
  pinOrder?: readonly string[]
}

/**
 * Partition rows as upstream `sectionMembers` does: the blank placeholder first,
 * then pinned non-archived rows, then everything else — each partition keeping
 * the caller's order. `pinOrder` re-ranks the pinned partition only.
 */
export function partitionPinnedSessions<T extends { id: string; blank?: boolean; archived?: boolean }>(
  rows: readonly T[],
  options: PinnedPartitionOptions = {},
): T[] {
  const pinned = options.pinnedIds
  const placeholders: T[] = []
  const pinnedRows: T[] = []
  const rest: T[] = []
  for (const row of rows) {
    if (row.blank === true) placeholders.push(row)
    else if (pinned !== undefined && row.archived !== true && pinned.has(row.id)) pinnedRows.push(row)
    else rest.push(row)
  }
  // 集合未知 = 不宣称任何置顶（无置顶块），但 blank 占位行照上游 sectionMembers **无条件提前**
  // （集合已知但为空同理）；未知集不能因此丢掉占位行分区（design 06 §3.4）。
  if (pinned === undefined) return [...placeholders, ...rest]
  if (options.pinOrder !== undefined && pinnedRows.length > 1) {
    const rank = new Map(options.pinOrder.map((id, index) => [id, index]))
    // Stable sort: an id missing from pinOrder keeps its relative position after ranked ones.
    pinnedRows.sort((a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER))
  }
  return [...placeholders, ...pinnedRows, ...rest]
}
