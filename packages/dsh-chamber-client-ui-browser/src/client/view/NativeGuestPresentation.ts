/**
 * Native guest presentation: placeholder geometry + occlusion reporting.
 *
 * The guest lives in a native layer above the shell webView; this presentation
 * owns only the placeholder measurement. It observes `ResizeObserver` +
 * capture-phase scroll + `visualViewport`/`resize` and coalesces through
 * `requestAnimationFrame`, reporting only a ≥1px change or a visibility flip
 * (design 28 §4.1). Travel shape = top-level `frame:{x,y,w,h}` + `visible` +
 * `occluded` (§3:85).
 *
 * Occlusion: the native layer cannot be covered by DOM, so a v2 multi-point hit
 * test (centre + four inset corners + four edge midpoints) hides the guest as soon
 * as ONE sample is won by a foreign layer; `setOccluded` stays the explicit seam
 * for overlay sources we cannot see (native modals, hover layers outside the DOM,
 * partially transparent scrims — see the FW2 report blind spots).
 */
import type { BrowserPresentation } from './BrowserPresentation.ts'
import {
  hiddenGuestFrame,
  isGuestOccludedByTopmost,
  normalizeGuestReport,
  occlusionSampleCoordinates,
  overlayCandidatesCover,
  shouldReportGuestFrame,
  OVERLAY_SELECTOR,
  type GuestFrameMeasurement,
} from '../browser/guest-geometry.ts'
import type { BrowserFrameReport } from '../browser/BrowserBridge.ts'

/** Receives the placeholder report; the carrier sends it to main. */
export interface NativeGuestPresentationEvents {
  readonly report: (report: BrowserFrameReport) => void
  /** The placeholder left the document (tab hidden/collapsed): hide the guest. */
  readonly hidden: () => void
}

/** Owns the placeholder measurement; navigation lives in NativeGuestImpl. */
export class NativeGuestPresentation implements BrowserPresentation {
  private readonly events: NativeGuestPresentationEvents
  private readonly tabId: string
  private host: HTMLElement | undefined
  private readonly observers: { disconnect(): void }[] = []
  private readonly listeners: { target: EventTarget; type: string; listener: EventListener; capture: boolean }[] = []
  private frame: BrowserFrameReport | undefined
  private pending = false
  private occluded = false
  /** Overlay-candidate cache: the DOM is queried at most every 250 ms (RT-04). */
  private overlayCandidates: Element[] = []
  private overlayCandidatesAt = 0
  private disposed = false

  /**
   * @param events - geometry/visibility callbacks.
   * @param tabId - tab occurrence key; exposed as `data-chamber-browser-tab` so the
   *   page-level `browser.input` replay can target this tab's element.
   */
  constructor(events: NativeGuestPresentationEvents, tabId: string) {
    this.events = events
    this.tabId = tabId
  }

  /** @param viewportId - placeholder element id inside the mounted tab body. */
  mount(viewportId: string): () => void {
    if (this.disposed) return () => undefined
    const host = document.getElementById(viewportId)
    if (host === null) throw new Error('native guest presentation: viewport is not mounted')
    this.host = host
    host.dataset.chamberBrowserTab = this.tabId
    const schedule = (): void => { this.schedule() }
    const resizeObserver = new ResizeObserver(schedule)
    resizeObserver.observe(host)
    this.observers.push(resizeObserver)
    this.listen(document, 'scroll', schedule, true)
    this.listen(window, 'resize', schedule, false)
    const visualViewport = window.visualViewport
    if (visualViewport !== null && visualViewport !== undefined) {
      this.listen(visualViewport, 'resize', schedule, false)
      this.listen(visualViewport, 'scroll', schedule, false)
    }
    this.schedule()
    return () => {
      if (this.host !== host) return
      this.teardown()
      this.host = undefined
      // Only a previously VISIBLE guest needs an explicit hide; a mount that never
      // reported (never acquired) must not emit a spurious hidden report.
      if (this.frame?.visible === true) {
        this.frame = hiddenGuestFrame(this.frame)
        this.events.hidden()
      }
    }
  }

  /** @param occluded - a DOM/native layer may cover the panel; hide the native layer. */
  setOccluded(occluded: boolean): void {
    if (this.occluded === occluded) return
    this.occluded = occluded
    this.schedule()
  }

  /** Stop observing and drop the retained report. */
  dispose(): void {
    this.disposed = true
    this.teardown()
    this.host = undefined
    this.frame = undefined
  }

  private listen(target: EventTarget, type: string, listener: EventListener, capture: boolean): void {
    target.addEventListener(type, listener, capture)
    this.listeners.push({ target, type, listener, capture })
  }

  private teardown(): void {
    for (const observer of this.observers.splice(0)) observer.disconnect()
    for (const entry of this.listeners.splice(0)) entry.target.removeEventListener(entry.type, entry.listener, entry.capture)
  }

  private schedule(): void {
    if (this.pending || this.disposed) return
    this.pending = true
    const flush = (): void => {
      this.pending = false
      this.flush()
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush)
    else setTimeout(flush, 0)
  }

  /** Overlay candidates, refreshed at most every 250 ms (RT-04). */
  private overlays(): Element[] {
    const now = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
    if (now - this.overlayCandidatesAt < 250) return this.overlayCandidates
    this.overlayCandidatesAt = now
    try { this.overlayCandidates = [...document.querySelectorAll(OVERLAY_SELECTOR)] } catch { this.overlayCandidates = [] }
    return this.overlayCandidates
  }

  /**
   * RT-04 occlusion: multi-point hit test (centre, four inset corners, four edge
   * midpoints) PLUS an overlay-candidate rect intersection, so `pointer-events:none`
   * scrims/toasts hide the guest even though they never win the hit test.
   */
  private coveredByDomOverlay(host: HTMLElement, rect: DOMRect): boolean {
    if (rect.width <= 0 || rect.height <= 0) return false
    // Overlay rects first: a pointer-events:none toast/scrim covers but never hits.
    const overlayRects = this.overlays()
      .filter(element => element !== host && !host.contains(element) && element.isConnected)
      .map(element => element.getBoundingClientRect())
    if (overlayCandidatesCover(rect, overlayRects)) return true
    if (typeof document.elementsFromPoint !== 'function') return false
    for (const [x, y] of occlusionSampleCoordinates(rect)) {
      const topmost = document.elementsFromPoint(x, y)[0]
      if (topmost === undefined) continue
      const element = topmost instanceof Element ? topmost : null
      if (isGuestOccludedByTopmost(
        element !== null && element === host,
        element !== null && host.contains(element),
        element !== null && element.contains(host),
      )) return true
    }
    return false
  }

  private flush(): void {
    if (this.disposed) return
    const host = this.host
    if (host === undefined || !host.isConnected) {
      const next = hiddenGuestFrame(this.frame)
      if (shouldReportGuestFrame(this.frame, next)) {
        this.frame = next
        this.events.hidden()
      }
      return
    }
    const rect = host.getBoundingClientRect()
    const covered = this.occluded || this.coveredByDomOverlay(host, rect)
    const measurement: GuestFrameMeasurement = {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      visible: host.isConnected && rect.width > 0 && rect.height > 0 && !covered,
      occluded: covered,
    }
    const next = normalizeGuestReport(measurement)
    if (!shouldReportGuestFrame(this.frame, next)) return
    this.frame = next
    this.events.report(next)
  }
}