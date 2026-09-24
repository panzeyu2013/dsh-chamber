/**
 * Sidebar scroll anchor sync (N-ctx): a plain view switch swaps in the incoming
 * shell's stale `scrollTop`, so the whole sidebar resets to the top, then jumps
 * on server switch. Fix without touching the bridge: rows/containers are tagged
 * in the DOM (identical projection ⇒ identical row ids), the outgoing shell's
 * topmost visible row + offset + raw scrollTop are captured, then applied to the
 * incoming shell.
 *
 * Restore is two-phase with a generation counter (a newer call supersedes an
 * in-flight chain): PARK copies the raw scrollTop before any visibility gate (the
 * transition snapshot / skeleton→content reveal then captures the parked
 * position); REFINE, gated on checkVisibility, puts the anchored row at the same
 * screen offset once rects are trustworthy. GHOST rows are never anchors.
 *
 * Dependency-free, DOM-only, no React import.
 */

export interface SidebarScrollAnchor {
  /** `data-chamber-row` of the topmost visible row; null = fallback to scrollTop. */
  id: string | null
  /** The row's offset from the container's visible top (px). */
  offset: number
  /** Raw scrollTop captured alongside the anchor (fallback). */
  scrollTop: number
}

const INSTANCE_VIEW_SELECTOR = '.instance-view'
const SCROLL_CONTAINER_SELECTOR = '[data-chamber-sidebar-scroll]'
const ROW_SELECTOR = '[data-chamber-row]'
/** Attribute name behind {@link ROW_SELECTOR} (single-lookup row resolution). */
const ROW_ATTRIBUTE = 'data-chamber-row'
/** Timer fallback cadence when rAF is unavailable or the document is hidden. */
const RETRY_MS = 80
/**
 * Frame-tight (rAF) retry budget for a restore chain: parking within a frame of
 * the container mounting matters, but a per-frame DOM walk through the whole boot
 * window runs while the chamber mounts every shell. After this budget the chain
 * drops to the {@link RETRY_MS} timer cadence (12x fewer attempts/s), which
 * measures the same settled content the REFINE phase wants.
 */
const FRAME_TIGHT_BUDGET_MS = 200

function findInstanceView(instanceId: string): HTMLElement | null {
  // Iterate instead of building a selector from the id — registry ids are not
  // guaranteed selector-safe, and the view count is small.
  for (const view of document.querySelectorAll<HTMLElement>(INSTANCE_VIEW_SELECTOR)) {
    if (view.dataset.instance === instanceId) return view
  }
  return null
}

function findScrollContainer(instanceId: string): HTMLElement | null {
  const view = findInstanceView(instanceId)
  if (view === null) return null
  return view.querySelector<HTMLElement>(SCROLL_CONTAINER_SELECTOR)
}

function findRow(container: HTMLElement, id: string): HTMLElement | null {
  // Row ids contain non-selector-safe chars, so the attribute value is escaped.
  // One lookup avoids a per-frame scan during the boot window; the plain scan
  // stays as the fallback (identical semantics: first match, dataset compare).
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return container.querySelector<HTMLElement>(`[${ROW_ATTRIBUTE}="${CSS.escape(id)}"]`)
  }
  for (const row of container.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    if (row.dataset.chamberRow === id) return row
  }
  return null
}

/**
 * Capture the outgoing (currently displayed) shell's sidebar scroll anchor; null
 * when its container is not mounted (nothing to sync — the caller skips restore).
 */
export function captureSidebarScrollAnchor(instanceId: string): SidebarScrollAnchor | null {
  const container = findScrollContainer(instanceId)
  if (container === null) return null
  const containerRect = container.getBoundingClientRect()
  const scrollTop = container.scrollTop
  // Row rects are viewport-relative and already account for scrollTop: the visible
  // top is the container's top edge (adding scrollTop would pick a row ~scrollTop
  // px BELOW the true topmost one and make restore land at ~2·scrollTop).
  const visibleTop = containerRect.top
  // First row (document order) whose bottom reaches the visible top.
  for (const row of container.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    // Skip GHOST rows (data-chamber-ghost — the departed blank "New Session" slot
    // kept as a visibility:hidden placeholder during the 450ms grace): they carry
    // full geometry but only the ARMING shell renders them, so anchoring on one
    // would make restoreSidebarScroll retry to the deadline with a stale scroll.
    if (row.dataset.chamberGhost !== undefined) continue
    const rect = row.getBoundingClientRect()
    if (rect.bottom >= visibleTop) {
      // offset = the row's viewport top relative to the container's viewport top.
      return { id: row.dataset.chamberRow ?? null, offset: rect.top - containerRect.top, scrollTop }
    }
  }
  return { id: null, offset: 0, scrollTop }
}

/**
 * Monotonic generation counter: rapid A→B→A→B switches can otherwise run several
 * bounded retry chains against one container. Every attempt of a superseded chain
 * stops immediately; there is no unmount hook, so this is the cheap mechanism.
 */
let restoreGeneration = 0

/**
 * Restore the captured anchor on the INCOMING shell's sidebar container.
 * PARK copies the raw `anchor.scrollTop` before any visibility gate (no rects
 * needed — safe while hidden, and the reveal cannot flicker); REFINE, gated on
 * checkVisibility, puts the anchored row at the same screen offset once rects
 * are trustworthy, or falls back to the raw scrollTop at the deadline. Retry
 * cadence is phase-split (rAF only while the container is missing, then timer);
 * bounded by `timeoutMs`, one-shot, superseded by a newer call.
 */
export function restoreSidebarScroll(instanceId: string, anchor: SidebarScrollAnchor, timeoutMs = 8000): void {
  const generation = ++restoreGeneration
  const deadline = Date.now() + timeoutMs
  // Frame-tight retry only while the container is missing: the first park after
  // mounting must land within a frame. The timer fallback covers hidden documents
  // (rAF stops) and old environments.
  const chainStartedAt = Date.now()
  const rafRetry = (): void => {
    const frameTight = Date.now() - chainStartedAt < FRAME_TIGHT_BUDGET_MS
    if (frameTight && typeof requestAnimationFrame === 'function' && document.visibilityState !== 'hidden') {
      requestAnimationFrame(attempt)
    } else {
      window.setTimeout(attempt, RETRY_MS)
    }
  }
  // Timer cadence once the container exists: re-parks self-correct as content
  // grows, and the rect-based REFINE must measure SETTLED content — rects read
  // before the projection re-publish re-renders would stick one row off.
  const timerRetry = (): void => {
    window.setTimeout(attempt, RETRY_MS)
  }
  const attempt = (): void => {
    // A newer restoreSidebarScroll superseded this chain — stop entirely.
    if (generation !== restoreGeneration) return
    const expired = Date.now() > deadline
    const container = findScrollContainer(instanceId)
    if (container === null) {
      if (!expired) rafRetry()
      return
    }
    const maxScroll = (): number => container.scrollHeight - container.clientHeight
    // PARK: raw scroll, no rects — runs synchronously on the first attempt (inside
    // the view-transition apply callback for a settled shell), so the incoming
    // shell's first painted frame is already at the anchored position.
    container.scrollTop = Math.max(0, Math.min(anchor.scrollTop, maxScroll()))
    // REFINE: rect-based, only trustworthy once the shell is actually rendered.
    if (typeof container.checkVisibility === 'function' && container.checkVisibility() === false) {
      if (!expired) timerRetry()
      return
    }
    let target = anchor.scrollTop
    if (anchor.id !== null) {
      const row = findRow(container, anchor.id)
      if (row !== null) {
        const containerRect = container.getBoundingClientRect()
        const rowRect = row.getBoundingClientRect()
        // rowRect.top reflects the incoming container's own stale scrollTop, so
        // subtract the anchor offset and add back the container's scrollTop —
        // algebraically scrolling to the outgoing's scrollTop, positioned by the row.
        target = rowRect.top - containerRect.top + container.scrollTop - anchor.offset
      } else if (!expired) {
        // Container mounted but the row is not rendered yet: the park above holds
        // the position; only copy the raw scrollTop refinement at the deadline.
        timerRetry()
        return
      }
    }
    container.scrollTop = Math.max(0, Math.min(target, maxScroll()))
  }
  attempt()
}
