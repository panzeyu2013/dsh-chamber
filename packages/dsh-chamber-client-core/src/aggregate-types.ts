/**
 * Row shapes shared by the aggregate store and the derive
 * layer (archived rows, workspace rows). A LEAF on purpose: aggregate-store and
 * derive both need the row types, and importing them across those two modules
 * created a type-level cycle (verify:import-cycles) that made the pair look unsplittable.
 */
/** Archived-session metadata row carried to archive-manager surfaces
 *  (design 24 revision: the manager lists WHAT is archived; rows carry their
 *  workspace attribution for the grouped collapsible listing). */
export interface ArchivedSessionMetaRow {
  sessionId: string
  /** Title projection when the session has one (untitled sessions omit it). */
  title?: string
  /** Canonical working directory (project label source). */
  cwd?: string
  /** Epoch ms of last activity; absent on the wire when unknown. */
  updatedAt?: number
  /** Workspace attribution: the host workspace whose
   *  registry membership contains this session — or, failing that, whose
   *  path equals the session's canonical cwd. Absent = the session is not
   *  accounted by any live workspace (deleted-workspace orphans etc.); the
   *  manager lists it in the trailing ungrouped bucket. */
  workspace?: { id: string; title: string }
}

/**
 * One workspace group in the sidebar projection (computed by shared/derive.ts).
 * The synthetic trailing ungrouped bucket carries `ungrouped: true` and the
 * shared UNGROUPED_WORKSPACE_ID as its id.
 */
export interface ChamberServerWorkspace {
  id: string
  title: string
  /** Wire display path: the hover card's middle line and its click-to-copy text. */
  path?: string
  /** `Date.parse` epoch ms for the card; SPARSE (missing/unparseable ⇒ absent, never NaN). */
  createdAt?: number
  /** True only for the synthetic trailing ungrouped bucket. */
  ungrouped?: boolean
  /**
   * True only for the fallback's cwd-derived groups (`__cwd__:` ids, fetchInstanceSnapshot).
   * Display-only: the host does not know these ids, so the sidebar must disable every
   * workspace-scoped mutation on them (ungrouped-bucket parity).
   */
  synthetic?: boolean
  sessions: {
    id: string
    /** Durable title projection — '' when the session has none. Rename/fork copy uses THIS. */
    title: string
    /**
     * Official display label (I3): `title ?? basename(cwd) ?? id`, resolved by
     * `derive.ts sessionDisplayTitle` and NEVER empty. This is what row labels,
     * hover copy, aria names and todo rows render — a session whose title the
     * host could not read shows its project directory name, never
     * 「未命名会话」.
     */
    displayTitle: string
    running?: boolean
    updatedAt?: number
    blank?: boolean
    /**
     * The session owns at least one active
     * schedule — projected from the session's `schedule` projection
     * (`derive.ts hasActiveScheduleOf`, upstream ui-schedule SessionScheduleMark)
     * so the row can render the official active-Schedule marker. Sparse: absent
     * means no active schedule.
     */
    hasActiveSchedule?: boolean
    /**
     * 归档行标记（稀疏）：show/only 筛选下归档行进入导航投影时携带；置灰、不可开、
     * 不可拖、pin 面消失、归档钮翻转为「恢复」由侧栏消费（design 06 §3.4）。
     */
    archived?: boolean
    /**
     * 上游 `SessionNode.pinned` 的置顶标记，由 derive 在渲染时从快照的置顶集求得
     * （集合未知或行已归档时不出现）。稀疏：只有真置顶的行携带它。
     */
    pinned?: boolean
  }[]
  /**
   * Official reuse-or-create resolution for this workspace's "+" (I2), computed
   * by `derive.ts findReusableBlankSession` over the RAW snapshot: a blank,
   * non-archived member session in the workspace's own directory that upstream
   * `connectWorkspace` would reopen instead of creating another one. Absent
   * means "create" — either no such row, or the archive set is unknown
   * (unary fallback), where create is the honest degradation.
   */
  reusableBlankSessionId?: string
}
