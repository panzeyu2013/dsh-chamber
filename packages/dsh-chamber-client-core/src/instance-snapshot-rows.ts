/**
 * Snapshot row shapes: the two row types every snapshot producer and the sidebar
 * projection share. A LEAF on purpose — relocated VERBATIM out of instance-api.ts
 * (no shape change) so that file could stay inside the file-budget ratchet while
 * the unrelated pin landing added its set fields there. Pin-unrelated by
 * construction: the pin fact lives on the snapshot (`pinnedSessionIds`/
 * `pinSetKnown`), never on a row. instance-api.ts re-exports both names, so every
 * existing import site stays valid.
 */
/** One workspace row (WorkspaceView wire shape). */
export interface WorkspaceRow {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
  /**
   * True ONLY for the fallback's cwd-derived groups (`__cwd__:<path>`), which
   * carry no host workspace identity: every workspace-scoped mutation on them
   * fails fail-closed with `workspace/not-found`, so the sidebar must disable
   * those affordances (ungrouped-bucket parity).
   */
  synthetic?: boolean
}

/** One session row (SessionSummary wire shape; title rides projections.values.title). */
export interface SessionRow {
  sessionId: string
  /**
   * Epoch ms of last activity, set only when the wire provides a number — never
   * coerced to 0 (which would render "54y ago"). The UI hides the time cell
   * when this is undefined OR 0.
   */
  updatedAt?: number
  running: boolean
  blank: boolean
  /**
   * The official display label resolved at BUILD time (`title ?? basename(cwd)
   * ?? id` via sessionDisplayTitle), never empty. Kept separate from `title`
   * so rename/fork copy and the archive manager never treat a directory-name
   * fallback as a durable name; the derive re-applies the ladder when absent.
   */
  displayTitle?: string
  /**
   * The session owns at least one ACTIVE schedule (upstream
   * `SessionNode.hasActiveSchedule`, derived from `projectionValues.schedule`).
   * SPARSE: present only when true, so the snapshot signature stays
   * byte-identical for schedule-less sessions.
   */
  hasActiveSchedule?: boolean
  /**
   * 投影块的序列空间（上游 `SessionProjectionHints.kind`）。`sequenced` = 宿主 live
   * registry 为已连接会话产出，`asOfSeq` 可与同一连接的 baseline/帧比较；`cached` =
   * 纯列表从**持久化投影缓存**读到的块，`asOfSeq` 是那条存储记录自己的水位，
   * **不得**与已连接会话的值比较。缺省 = 线上没给（老宿主/自定义形状）。
   */
  projectionKind?: 'cached' | 'sequenced'
  /**
   * 该块在 `projectionKind` 序列空间里的水位（上游 `SessionProjectionHints.asOfSeq`）。
   * 单独读没有意义：比较前必须先看 `projectionKind === 'sequenced'`。
   */
  projectionAsOfSeq?: number
  /** Coarse durable origin (wire: absent or 'subagent'); subagent rows never surface in navigation. */
  origin?: 'subagent'
  cwd?: string
  title?: string
  parentSessionId?: string
}
