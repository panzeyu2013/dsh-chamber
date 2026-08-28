/**
 * Local declaration for the sidebar view-prefs shared face
 * (packages/dsh-chamber-client-ui-sidebar/src/shared/view-prefs.ts): the
 * page-wide view preferences this fork's store seeds from / writes back to
 * (design 06 — sidebar width sharing). This package resolves the specifier to
 * THIS file via tsconfig paths — the sidebar package's own sources are never
 * compiled here; at runtime the vite shared chunk keeps one view-prefs module
 * instance across every boot, and the real shape is typechecked in the
 * sidebar package's own project.
 *
 * MIRROR WARNING: keep in sync with the REAL view-prefs.ts surface — this
 * package only reads/writes the sidebarWidth preference, so just that field
 * plus the read/write/subscribe entry points are mirrored.
 */

/** Page-wide sidebar view preferences (mirror of the real face — the
 *  optional fields below match view-prefs.ts exactly; 2026 review T5). */
export interface ChamberSidebarViewPrefs {
  v: 1
  folded: Record<string, boolean>
  ungroupedOrder: Record<string, string[]>
  orderBy?: Record<string, 'manual' | 'updated'>
  /** Updated-mode session order accounts (design 06 §3.1, mirror of
   *  view-prefs.ts): key = the `${sourceId}/${workspaceId}` account key,
   *  value = the updated-mode display order; absent for sources that never
   *  entered updated mode. */
  updatedOrder?: Record<string, string[]>
  /** Updated-mode activity bookkeeping (account key → sessionId → updatedAt). */
  sessionUpdatedAtByAccount?: Record<string, Record<string, number>>
  /** Source-level fold: sourceId → its workspace LIST is collapsed. */
  sourceFolded?: Record<string, boolean>
  /** Source display order (server drag-sort); absent = projection order. */
  serverOrder?: string[]
  /** Page-wide sidebar width preference in px; absent = never dragged. */
  sidebarWidth?: number
  seenSources: string[]
}

/** The shared prefs (lazily loaded + cached for the page lifetime). */
export function getViewPrefs(): ChamberSidebarViewPrefs

/** Subscribe to shared-prefs changes (any boot's write); returns the unsubscribe. */
export function subscribeViewPrefs(listener: () => void): () => void

/** Write through the shared store: persist + notify every subscriber. */
export function updateViewPrefs(
  mutator: (prev: ChamberSidebarViewPrefs) => ChamberSidebarViewPrefs,
): void
