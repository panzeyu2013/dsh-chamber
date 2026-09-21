/**
 * Sidebar collapse geometry and pointer-followed scrollbars (extracted
 * verbatim from SidebarRoot, 2026-12 split): the wide-content settle timer,
 * the frozen-width fade refs and the cached column-rect linger machine.
 */

import { useEffect, useRef, useState } from 'react'

/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
const COLLAPSE_SETTLE_MS = 150

/**
 * How long the column's scrollbars stay drawn after the pointer leaves it.
 * The bar is a pointer affordance here, and hiding it on the leave event
 * itself makes it blink out while the pointer is only crossing the column's
 * edge — on the way to the conversation, or around a portalled menu.
 */
const SCROLLBAR_LINGER_MS = 2000

export function useSidebarCollapse(collapsed: boolean, width: number) {
  // Wide content stays mounted while the collapse animates (fading via
  // .collapsed .wide), unmounts at settle, and remounts right away on expand.
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (!collapsed) { setSettled(false); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])
  const wide = !collapsed || !settled

  // Freeze the content at its expanded width while it fades out (collapsed
  // && wide): the sliding column then clips it instead of reflowing it. The
  // rail layout (.collapsed styles) only applies once the fade settles.
  const lastWideWidth = useRef(width)
  if (!collapsed) lastWideWidth.current = width

  // Rail-in only crossfades a live collapse: a refresh straight into the
  // collapsed state renders the rail statically (no delay-hidden icons).
  const everWide = useRef(!collapsed)
  if (!collapsed) everWide.current = true

  // Scrollbars in the column follow the pointer (.quietBars rebinds them
  // away): drawn while it is inside, and for SCROLLBAR_LINGER_MS after it
  // leaves. A pointer that returns within that window cancels the pending
  // hide rather than restarting from a hidden bar.
  const column = useRef<HTMLDivElement>(null)
  const [pointerInside, setPointerInside] = useState(false)
  const lingerTimer = useRef<number | undefined>(undefined)
  const armLinger = (): void => {
    if (lingerTimer.current !== undefined) return
    lingerTimer.current = window.setTimeout(() => {
      lingerTimer.current = undefined
      setPointerInside(false)
    }, SCROLLBAR_LINGER_MS)
  }
  const cancelLinger = (): void => {
    window.clearTimeout(lingerTimer.current)
    lingerTimer.current = undefined
  }
  // Leaving is decided by the column's BOX, not by DOM containment, and only
  // while the bars are drawn. ui-settings renders its full-viewport panel as a
  // fixed-position DESCENDANT of this column, so a pointer moved onto that
  // panel — or onto the conversation once it closes — fires no `pointerleave`
  // here, and the bars would stay drawn over a column nobody is pointing at.
  // The element's own leave stays as the one signal geometry cannot give: a
  // pointer that leaves the window emits no further moves.
  //
  // The box is measured into a CACHED ref, never per pointermove: each
  // getBoundingClientRect() is a forced synchronous layout read, and the
  // pointer stream delivers far more events than the box changes. The column's
  // rect only changes on collapse/expand (width prop / collapsed flag — the
  // effect re-runs and re-measures) and window resize (a rAF-throttled
  // re-measure refreshes it at most once per frame while the pointer moves,
  // one frame of staleness is invisible to a 2s linger timer).
  const columnRect = useRef<DOMRect | null>(null)
  useEffect(() => {
    if (!pointerInside) return
    const measure = (): void => {
      raf = 0
      columnRect.current = column.current?.getBoundingClientRect() ?? null
    }
    let raf = 0
    measure()
    const onMove = (event: PointerEvent): void => {
      // Throttle the re-measure to one per frame; the decision below uses the
      // cached rect (at most one frame stale — imperceptible for a 2s linger).
      if (raf === 0) raf = requestAnimationFrame(measure)
      const rect = columnRect.current
      if (rect === null) return
      const inside = event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom
      if (inside) cancelLinger()
      else armLinger()
    }
    document.addEventListener('pointermove', onMove)
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf)
      document.removeEventListener('pointermove', onMove)
      cancelLinger()
    }
  }, [pointerInside, width, collapsed])
  return { wide, column, lastWideWidth, everWide, pointerInside, setPointerInside, cancelLinger, armLinger }
}
