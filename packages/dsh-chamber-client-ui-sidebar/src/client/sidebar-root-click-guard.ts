/**
 * The document-wide pending-click guard (extracted verbatim from
 * SidebarRoot, 2026-12 split): a click outside the pending renamable row
 * drops the module-global double-click pending.
 */

import { useEffect } from 'react'
import { clearPendingClick, isClickInsidePendingRow } from '../shared/pending-click.ts'

export function useSidebarClickGuard(): void {
  // chamber (06): the session row's single click opens the session IMMEDIATELY
  // (zero delay); double-click-to-rename is detected by click timestamps on
  // the SAME session id — no timer ever delays an open (the OpenChamber row
  // behavior this N-ctx design drew from). The DOUBLE_CLICK_WINDOW_MS window
  // is kept only as a RENAME guard: the pending is a module-global
  // { sessionId, at } slot, a second click within the window on the same
  // session enters inline rename, and every other click opens right away.
  // openSession is idempotent, so a misjudged slow second click only re-opens
  // (no-op) and can NEVER accidentally rename.
  // The pending lives in a MODULE-level singleton (shared/pending-click.ts,
  // vite shared chunk) shared by every N-ctx shell: each server boot mounts
  // its own SidebarRoot React tree, and a CROSS-SOURCE double-click (click1 on
  // a row of a non-active server switches the visible shell BETWEEN click1 and
  // click2) would land click2 in a DIFFERENT tree — a per-tree ref would never
  // see click1 and the second click would re-open instead of renaming. Keyed
  // by sessionId (NOT a DOM node): session rows render data-session-id, and
  // the outside-click cancellation matches that attribute via closest(), so it
  // works even when the pending row lives in another shell's DOM.
  // The document-wide click listener only guards the rename window: a click
  // anywhere OUTSIDE the pending row
  // drops the pending — the row's own onClick runs before this listener and
  // consumes/replaces the pending itself, so only outside clicks reach here.
  // suppressClickRef (drag-end trailing click) is honored on the way in;
  // row-internal buttons (fold toggle / new-session / the row kebab menus —
  // 2026-09-11 upstream-alignment T2a: the session kebab now carries archive,
  // there is no dedicated archive button left) AND
  // the source-header action buttons (sort / add-workspace / search /
  // archive-cleanup manager — design 24 revision) clear the pending in their own
  // handlers (stopPropagation + clearPendingClick) —
  // React's stopPropagation also stops the native event, so the document
  // listener never sees those clicks and a surviving pending would make a
  // later click on the same session spuriously enter rename.
  useEffect(() => {
    const onDocumentClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) return
      if (isClickInsidePendingRow(event.target)) return
      clearPendingClick()
    }
    document.addEventListener('click', onDocumentClick)
    return () => { document.removeEventListener('click', onDocumentClick) }
  }, [])
}
