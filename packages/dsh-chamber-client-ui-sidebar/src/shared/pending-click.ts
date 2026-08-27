/**
 * Global double-click-rename pending slot (design 05 deviation P2-11, 2026-08
 * revision — now aligned with OpenChamber's immediate-open + double-click
 * rename model).
 *
 * OpenChamber (the external project this N-ctx design drew from,
 * `packages/ui/src/components/session/sidebar/SessionNodeItem.tsx`) opens a
 * session on the row's SINGLE click with ZERO delay and enters inline rename
 * on the second click of a double click. This shell previously paid
 * DOUBLE_CLICK_WINDOW_MS of latency on EVERY single click (a setTimeout
 * disambiguated single vs double click before opening). The row single click
 * now opens IMMEDIATELY; the pending below only records "a row click happened
 * just now" so a SECOND click on the SAME session within the window enters
 * inline rename instead of re-opening. openSession is idempotent
 * (chamberBridge.requestOpenSession → the App layer's selectView skip +
 * runtime sessions.open no-op on the already-open session), so a misjudged
 * slow double click only causes an idempotent re-open and can NEVER
 * accidentally rename — strictly safer than the old timer model, where a
 * misjudged double click cancelled the pending open and renamed.
 *
 * The pending MUST be global across N-ctx shells: every server boot mounts its
 * own SidebarRoot React tree (each with its own component state), and a
 * CROSS-SOURCE double-click — click1 on a row of a NON-ACTIVE server, which
 * switches the visible shell BETWEEN click1 and click2 — would land click2 in
 * a DIFFERENT React tree. A per-tree ref would never see click1, so the second
 * click would re-open instead of renaming. This module rides the same vite
 * shared chunk as chamberBridge / view-prefs (see singleton.ts), so every
 * shell shares ONE pending slot.
 *
 * Keyed by sessionId (NOT a DOM node): session rows render
 * `data-session-id={session.id}`, and the document-level click-outside
 * cancellation matches that attribute (closest()) instead of holding a row
 * reference — the pending row may live in a different shell's DOM by the time
 * an outside click arrives, and DOM identity is meaningless across trees.
 *
 * INVARIANT (2026-08 review fix): any control that STOPS the click's
 * propagation MUST clear the pending itself (clearPendingClick). React's
 * stopPropagation also stops the native event, so the document-level listener
 * never sees those clicks — a surviving pending would make a later click on
 * the same session within the window spuriously enter rename. This applies to
 * every row-internal button (fold / new-session / kebabs / archive) AND the
 * source-header action buttons (sort / add-workspace / search).
 */
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('pending-click')

/**
 * Max gap between two clicks on the SAME session that still reads as
 * "double click → rename".
 *
 * This is a LATENCY-FREE RENAME GAP, not the OS double-click interval: the
 * row opens on the FIRST click with zero delay, and only a second click
 * within this window enters inline rename. macOS's default double-click
 * interval is ~500ms — a deliberate slower double click (>350ms) falls back
 * to an idempotent re-open instead of renaming, and the kebab menu's rename
 * stays as the a11y fallback. 350ms also stays under the 450ms blank-row
 * ghost grace (derive.ts), so a second click that IS within the window can
 * never land on a shifted list.
 */
export const DOUBLE_CLICK_WINDOW_MS = 350

interface PendingClick {
  /** The row's OWNING source (server id), not the tree that recorded it:
   *  a cross-source double-click switches shells between click1 and click2,
   *  so both clicks must key on the row's server to keep matching. */
  sourceId: string
  sessionId: string
  /** Click time on the MONOTONIC clock (performance.now()); the window is a gap between clicks, not an absolute deadline. */
  at: number
}

/** One shared pending slot — a fresh click always supersedes the older one. */
let pending: PendingClick | null = null

/**
 * Note a session-row click and answer whether it is the SECOND click of a
 * deliberate double click on the SAME session of the SAME source:
 * - first click (or a click on a different session/source): records the
 *   pending and returns FALSE — the caller opens the session IMMEDIATELY
 *   (zero delay);
 * - second click on the same (source, session) within DOUBLE_CLICK_WINDOW_MS:
 *   consumes the pending and returns TRUE — the caller enters inline rename.
 *
 * Keyed by (sourceId, sessionId) — 2026 audit L2: cloned instances can carry
 * the SAME session UUID, and a bare sessionId key would let click1 on source
 * A's clone row match click2 on source B's clone row (spurious rename).
 *
 * The window is intentionally one-sided (a slow/misjudged second click just
 * re-opens idempotently, never renames) — see the header comment.
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
 * Whether the given event target lies inside the pending session row. The row
 * renders `data-session-id={session.id}` inside its source section, which
 * renders `data-chamber-section={server.id}`; containment is matched by those
 * attributes via closest(), so it works across shells (the pending row may
 * have been rendered by a different SidebarRoot tree than the one whose
 * document listener runs — DOM ancestry still resolves) and never holds a
 * stale row reference. A click on another source's row is "outside" (L2:
 * source-scoped pending).
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

/** Test-only: clear the shared pending (node tests have no DOM). */
export function __resetPendingClickForTests(): void {
  pending = null
}
