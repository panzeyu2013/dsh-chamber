/**
 * The two live-ctx store baselines {@link projectInstanceSnapshot} consumes.
 * A LEAF on purpose — moved out of derive.ts's inline parameter lists so that file
 * could stay inside the file-budget ratchet; the shapes are unchanged apart from
 * the OPTIONAL `pinnedSessionIds` the pin landing added (absent = unknown set).
 */
export interface ProjectionWorkspaceBaseline {
  items?: readonly {
    workspaceId: string
    path: string
    title: string
    sessionIds: readonly string[]
    createdAt: string
    updatedAt: string
  }[]
  archivedSessionIds?: readonly string[]
  /** 宿主 `WorkspaceBaseline.pinnedSessionIds`（最新置顶在前）；缺字段（老宿主 / 手搓快照）
   *  = 宿主没给该面，投影层不得把它当成"真无置顶"（见 `InstanceSnapshot.pinSetKnown`）。 */
  pinnedSessionIds?: readonly string[]
  state?: string
  phase?: string
  error?: unknown
}

export interface ProjectionSessionBaseline {
  ids?: readonly string[]
  byId?: Record<string, {
    id: string
    title?: string
    /** The mounted vendor store resolves the official display label itself —
     *  carried verbatim into the snapshot row. */
    displayTitle?: string
    cwd?: string
    parentId?: string
    origin?: 'subagent'
    running?: boolean
    blank?: boolean
    updatedAt?: number
    /** The row's projection bag; read for the active-Schedule fact only. */
    projectionValues?: Readonly<Record<string, unknown>>
  }>
  phase?: string
}
