/** Sidebar collapse geometry and pointer-followed scrollbars: the wide-content
 *  settle timer, the frozen-width fade refs and the cached column-rect linger machine. */

import { useEffect, useRef, useState } from 'react'

/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
const COLLAPSE_SETTLE_MS = 150

/**
 * Scrollbars stay drawn this long after the pointer leaves the column: hiding on
 * the leave event itself makes them blink out while the pointer only crosses the edge.
 */
const SCROLLBAR_LINGER_MS = 2000

export function useSidebarCollapse(collapsed: boolean, width: number) {
  // Wide content stays mounted while the collapse animates (fading via .collapsed .wide), unmounts at settle, remounts right away on expand.
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (!collapsed) { setSettled(false); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])
  const wide = !collapsed || !settled

  // Freeze the content at its expanded width while it fades out (collapsed &&
  // wide): the sliding column then clips it instead of reflowing it; rail layout applies at settle.
  const lastWideWidth = useRef(width)
  if (!collapsed) lastWideWidth.current = width

  // Rail-in only crossfades a live collapse: a refresh straight into the collapsed state renders the rail statically.
  const everWide = useRef(!collapsed)
  if (!collapsed) everWide.current = true

  // Scrollbars in the column follow the pointer (.quietBars rebinds them away):
  // drawn while it is inside, and for SCROLLBAR_LINGER_MS after it leaves; a pointer returning within that window cancels the pending hide.
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
  // Leaving is decided by the column's BOX, not DOM containment, and only while
  // the bars are drawn: ui-settings renders its full-viewport panel as a fixed
  // DESCENDANT of this column, so moving onto it fires no `pointerleave` here and
  // the bars would stay drawn over a column nobody points at; the element's own
  // leave stays the one signal geometry cannot give (a pointer leaving the window
  // emits no further moves). The box is measured into a CACHED ref, never per
  // pointermove: each getBoundingClientRect() forces a synchronous layout read, and
  // the rect only changes on collapse/expand (the effect re-runs) and window resize
  // (rAF-throttled, at most one frame stale — invisible to a 2s linger).
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
