/**
 * Archived-session row shapes shared by the aggregate store and the derive
 * layer. A LEAF on purpose: aggregate-store and derive both need the row type,
 * and importing it across those two modules created a type-level cycle
 * (verify:import-cycles) that made the pair look unsplittable.
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
