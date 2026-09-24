/**
 * Global double-click-rename pending slot（对齐 OpenChamber immediate-open +
 * 双击改名模型）: a row opens on the SINGLE click with zero delay and enters
 * inline rename on a second click. openSession is idempotent, so a misjudged
 * slow double click only re-opens and can NEVER accidentally rename.
 * MUST be global across N-ctx shells (a cross-source double click lands click2
 * in a different SidebarRoot tree) and keyed by (sourceId, sessionId) — NOT a
 * DOM node — since cloned instances can carry the same session UUID.
 * INVARIANT: a control that STOPS the click's propagation MUST call
 * clearPendingClick itself (React's stopPropagation also stops the native
 * event), or a surviving pending would spuriously rename a later click.
 */
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('pending-click')

/**
 * Max gap between two clicks on the SAME session that still reads as
 * "double click → rename" (latency-free rename gap, not the OS double-click
 * interval). 350ms is deliberately slower than macOS's ~500ms default (a slower
 * double click falls back to an idempotent re-open; the kebab rename is the a11y
 * fallback) and stays under the 450ms blank-row ghost grace (derive.ts), so a
 * second click can never land on a shifted list.
 */
export const DOUBLE_CLICK_WINDOW_MS = 350

interface PendingClick {
  /** The row's OWNING source (not the tree that recorded it) — a cross-source double click switches shells between clicks. */
  sourceId: string
  sessionId: string
  /** Click time on the MONOTONIC clock (performance.now()); the window is a gap between clicks, not an absolute deadline. */
  at: number
}

/** One shared pending slot — a fresh click always supersedes the older one. */
let pending: PendingClick | null = null

/**
 * Note a session-row click and answer whether it is the SECOND click of a
 * deliberate double click on the SAME (sourceId, sessionId): false = record and
 * open immediately (zero delay); true = consume and enter inline rename. The
 * window is one-sided: a slow/misjudged second click re-opens, never renames.
 */
export function noteSessionRowClick(sourceId: string, sessionId: string, now = performance.now()): boolean {
  if (pending !== null && pending.sourceId === sourceId && pending.sessionId === sessionId && now - pending.at <= DOUBLE_CLICK_WINDOW_MS) {
    pending = null
    return true
  }
  pending = { sourceId, sessionId, at: now }
  return false
}

/** Drop the pending (inner row buttons, outside clicks). */
export function clearPendingClick(): void {
  pending = null
}

/**
 * Whether the event target lies inside the pending session row, matched by the
 * `data-session-id` / `data-chamber-section` attributes via closest() so it works
 * across shells and never holds a stale row reference. Another source's row is
 * "outside" (source-scoped pending).
 */
export function isClickInsidePendingRow(target: unknown): boolean {
  if (pending === null) return false
  if (typeof target !== 'object' || target === null) return false
  const node = target as {
    closest?: (selector: string) => Element | null
    parentElement?: { closest?: (selector: string) => Element | null } | null
  }
  const walker = typeof node.closest === 'function' ? node : (node.parentElement ?? null)
  if (walker === null || typeof walker.closest !== 'function') return false
  const section = walker.closest('[data-chamber-section]')
  if (section === null || section.getAttribute('data-chamber-section') !== pending.sourceId) return false
  const row = walker.closest('[data-session-id]')
  return row !== null && row.getAttribute('data-session-id') === pending.sessionId
}

/** Test-only reset of the shared pending. */
export function __resetPendingClickForTests(): void {
  pending = null
}
