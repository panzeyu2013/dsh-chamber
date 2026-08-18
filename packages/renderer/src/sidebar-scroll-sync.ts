/**
 * Sidebar scroll anchor sync (N-ctx, 2026-08): each N-ctx shell renders its
 * OWN full copy of the chamber multi-source sidebar, and each shell's
 * `.chamberList` scroll container keeps its own independent `scrollTop` — a
 * plain view switch (App.selectView → setActiveView + CSS visibility) swaps
 * in the incoming shell's stale scroll position, so the whole sidebar "jumps"
 * on server switch. This module fixes that WITHOUT touching the bridge:
 *
 * - The outgoing shell's sidebar is tagged (`data-chamber-sidebar-scroll` on
 *   the scroll container, `data-chamber-row` on source headers / workspace
 *   headers / session rows — all in SidebarRoot.tsx). Every shell renders the
 *   SAME projection (chamberBridge publish → shared aggregate store), so row
 *   ids are identical across shells.
 * - `captureSidebarScrollAnchor` reads the outgoing shell's topmost visible
 *   row + its offset from the container's visible top, plus the raw scrollTop
 *   as fallback. GHOST rows are never anchors: a departed blank "New Session"
 *   row kept as a `visibility:hidden` layout slot during the 450ms grace
 *   (SidebarRoot tags it `data-chamber-ghost`) carries full geometry but only
 *   the ARMING shell renders it — anchoring on it would make the incoming
 *   shell retry to the 8s deadline with a stale scroll.
 * - `restoreSidebarScroll` applies that anchor to the INCOMING shell's
 *   container (bounded retry until the container mounts — the incoming shell
 *   may still be booting, or the sidebar may be collapsed to the rail which
 *   unmounts the list and re-creates it on expand — and, for a cold-booted
 *   shell, until the anchored row itself renders): position the anchored row
 *   at the same screen offset, or copy the raw scrollTop when the row never
 *   appears by the deadline. It never applies while the incoming shell is
 *   still `content-visibility:hidden` (checkVisibility gate — the first
 *   attempt runs inside the view-transition apply callback, before the view
 *   flips visible, and Chromium then reports stale/degenerate rects), and a
 *   newer call supersedes an in-flight chain via a generation counter (rapid
 *   A→B→A→B switches must not run several bounded retry chains concurrently).
 *   Either way the same session rows land at the same screen position as
 *   before the switch (a one-row layout difference — e.g. the
 *   active-source-only blank "New Session" row — is absorbed by the anchor).
 *
 * Dependency-free, DOM-only, no React import.
 */

export interface SidebarScrollAnchor {
  /**
   * `data-chamber-row` of the topmost visible row in the outgoing shell's
   * sidebar; null when no row is visible (fallback to scrollTop).
   */
  id: string | null
  /** The row's offset from the container's visible top (px). */
  offset: number
  /** Raw scrollTop captured alongside the anchor (fallback). */
  scrollTop: number
}

const INSTANCE_VIEW_SELECTOR = '.instance-view'
const SCROLL_CONTAINER_SELECTOR = '[data-chamber-sidebar-scroll]'
const ROW_SELECTOR = '[data-chamber-row]'
/** Retry cadence while waiting for the incoming shell's container or anchored row to mount. */
const RETRY_MS = 80

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
  // dataset comparison — row ids contain `/` and other non-selector-safe chars.
  for (const row of container.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    if (row.dataset.chamberRow === id) return row
  }
  return null
}

/**
 * Capture the outgoing (currently displayed) shell's sidebar scroll anchor.
 * Returns null when the shell's sidebar container is not mounted (nothing to
 * sync — the caller simply skips the restore).
 */
export function captureSidebarScrollAnchor(instanceId: string): SidebarScrollAnchor | null {
  const container = findScrollContainer(instanceId)
  if (container === null) return null
  const containerRect = container.getBoundingClientRect()
  const scrollTop = container.scrollTop
  // Row rects are viewport-relative and already account for scrollTop, so the
  // visible top of the viewport is just the container's top edge (adding
  // scrollTop would pick a row ~scrollTop px BELOW the true topmost one and
  // make the offset off by scrollTop → restore lands at ~2·scrollTop).
  const visibleTop = containerRect.top
  // First row (document order) whose bottom reaches the visible top — the
  // topmost visible row (fully scrolled-past rows have bottom < visibleTop).
  for (const row of container.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    // chamber (third-wave review, W1#1/R2-1#1/R2-5#5): skip GHOST rows
    // (data-chamber-ghost — the departed blank "New Session" slot kept as a
    // visibility:hidden layout placeholder during the 450ms grace). They
    // carry data-chamber-row and full layout geometry, but only the ARMING
    // shell renders them — the incoming shell never does, so anchoring on a
    // ghost would make restoreSidebarScroll retry to the deadline with a
    // stale scroll. A ghost is a non-interactive placeholder, never a
    // restore anchor.
    if (row.dataset.chamberGhost !== undefined) continue
    const rect = row.getBoundingClientRect()
    if (rect.bottom >= visibleTop) {
      // offset = the row's content top minus scrollTop (row's viewport top
      // relative to the container's viewport top).
      return { id: row.dataset.chamberRow ?? null, offset: rect.top - containerRect.top, scrollTop }
    }
  }
  return { id: null, offset: 0, scrollTop }
}

/**
 * Monotonic generation counter (chamber third-wave, W1#2): rapid A→B→A→B
 * view switches can otherwise run several bounded 8s retry chains
 * concurrently against the same container. Each `restoreSidebarScroll` call
 * bumps the generation and captures it; every attempt of a superseded chain
 * stops immediately (never applies, never reschedules). There is no unmount
 * hook to cancel a chain — the generation is the correct cheap mechanism.
 */
let restoreGeneration = 0

/**
 * Restore the captured anchor on the INCOMING shell's sidebar container.
 * Retries every ~80ms until the container mounts (shell still booting, or
 * sidebar collapsed to rail and re-expanding — a fresh element), and — when
 * the anchor row is not rendered yet (a cold-booted shell's sidebar mounts
 * before its server's rows land in the shared projection) — keeps retrying
 * until the row appears, bounded by `timeoutMs`. One-shot success: once the
 * row is found (or the deadline forces the raw-scrollTop fallback) the
 * position is applied and retrying stops. Gives up silently after `timeoutMs`
 * if the container never mounts. A newer call supersedes this chain (the
 * generation counter above); an attempt never applies while the incoming
 * shell is still `content-visibility:hidden` (checkVisibility gate — the
 * first attempt runs inside the view-transition apply callback, before the
 * view flips visible).
 */
export function restoreSidebarScroll(instanceId: string, anchor: SidebarScrollAnchor, timeoutMs = 8000): void {
  const generation = ++restoreGeneration
  const deadline = Date.now() + timeoutMs
  const attempt = (): void => {
    // A newer restoreSidebarScroll superseded this chain — stop entirely.
    if (generation !== restoreGeneration) return
    const expired = Date.now() > deadline
    const container = findScrollContainer(instanceId)
    if (container === null) {
      if (!expired) window.setTimeout(attempt, RETRY_MS)
      return
    }
    // chamber (third-wave review, R2-5#3): the first restore attempt can run
    // while the incoming shell is still content-visibility:hidden — the App
    // calls restoreSidebarScroll inside the view-transition apply callback
    // and the view flips visible only after it returns — so Chromium can
    // report stale/degenerate rects and the one-shot apply lands at a wrong
    // position (a settled prewarmed shell already has its rows in the DOM, so
    // the retry finds them immediately and applies once with bad geometry).
    // Gate the apply on checkVisibility (present in Electron 43 / Chromium
    // 140; typeof-guarded for safety) and keep rescheduling while hidden,
    // bounded by the existing deadline. At the deadline the raw-scrollTop
    // fallback still covers the terminal case — no rect is trustworthy in the
    // hidden state, so only the anchor's raw scroll is applied.
    if (typeof container.checkVisibility === 'function' && container.checkVisibility() === false) {
      if (!expired) {
        window.setTimeout(attempt, RETRY_MS)
      } else {
        const maxScroll = container.scrollHeight - container.clientHeight
        container.scrollTop = Math.max(0, Math.min(anchor.scrollTop, maxScroll))
      }
      return
    }
    let target = anchor.scrollTop
    if (anchor.id !== null) {
      const row = findRow(container, anchor.id)
      if (row !== null) {
        const containerRect = container.getBoundingClientRect()
        const rowRect = row.getBoundingClientRect()
        // rowRect.top already reflects the incoming container's own scrollTop
        // (a previously-visited shell keeps its stale scrollTop s'), so
        // subtract the anchor offset and add back s' to measure the content
        // offset — algebraically scrolling the incoming container to the
        // outgoing's scrollTop, positioned by the anchor row.
        target = rowRect.top - containerRect.top + container.scrollTop - anchor.offset
      } else if (!expired) {
        // Container mounted but the anchored row is not rendered yet: apply
        // nothing now — falling back to the raw scrollTop would freeze the
        // position wrong once the rows land. Keep retrying; only copy the raw
        // scrollTop at the deadline.
        window.setTimeout(attempt, RETRY_MS)
        return
      }
    }
    const maxScroll = container.scrollHeight - container.clientHeight
    container.scrollTop = Math.max(0, Math.min(target, maxScroll))
  }
  attempt()
}
