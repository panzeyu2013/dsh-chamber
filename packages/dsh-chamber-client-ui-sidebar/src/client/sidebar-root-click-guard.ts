/** Document-wide pending-click guard: a click outside the pending renamable row
 *  drops the module-global double-click pending. */

import { useEffect } from 'react'
import { clearPendingClick, isClickInsidePendingRow } from '@dsh-chamber/dsh-chamber-client-core/pending-click'

export function useSidebarClickGuard(): void {
  // Single click opens IMMEDIATELY (zero delay); double-click-to-rename is detected by click
  // timestamps on the SAME session id, so no timer delays an open. DOUBLE_CLICK_WINDOW_MS is
  // only a RENAME guard: openSession is idempotent, so a misjudged slow second click only
  // re-opens and can NEVER accidentally rename. The pending stays MODULE-level and
  // sessionId-keyed (not a per-tree ref or DOM node): each boot mounts its own SidebarRoot
  // tree, so click1 can switch shells between clicks and click2 would land in a different
  // one. Rows render `data-session-id`, matched via closest() on outside clicks, so
  // cancellation works even when the pending row lives in another shell's DOM. Only outside
  // clicks reach the listener (the row's onClick replaces the pending first); a button that
  // stopPropagation must clear the pending itself, and `suppressClickRef` is honored too.
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
