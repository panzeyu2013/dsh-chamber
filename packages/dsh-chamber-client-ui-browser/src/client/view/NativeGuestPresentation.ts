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
 *
 * Lease identity (design 28 v3 §3:89): the live guest lease is mirrored onto the
 * placeholder as `data-chamber-browser-lease`, so the page-level `browser.input`
 * replay can synthesize the key event on the element that owns the focused guest.
 * The tab id dataset stays for the older-shim compatibility arm. Both are cleared
 * on unmount/release; the lease is attribution only, never a credential.
 */
import type { BrowserPresentation } from './BrowserPresentation.ts'
import {
  hiddenGuestFrame,
  isGuestOccludedByTopmost,
  normalizeGuestReport,
  occlusionSampleCoordinates,
  overlayCandidatesCover,
  shouldReportGuestFrame,
  classifyScrollTarget,
  shouldMeasureOnScroll,
  shouldCheckOcclusion,
  OCCLUSION_CHECK_INTERVAL_MS,
  OVERLAY_CANDIDATE_TTL_MS,
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
  /** Current guest lease (data-chamber-browser-lease); undefined before acquire/release. */
  private lease: string | undefined
  private pending = false
  private occluded = false
  /** Overlay-candidate cache: the DOM is queried at most once per occlusion interval (RT-04). */
  private overlayCandidates: Element[] = []
  /**
   * 候选缓存时钟初值 -Infinity：页面时基 < TTL（壳文档 time origin 后 <100ms 的 mount
   * 首帧）时，首个 due 检查也必须刷新候选，而不是把「还没查过」当成「刚刚查过」（M1）。
   */
  private overlayCandidatesAt = Number.NEGATIVE_INFINITY
  /** E: 遮挡命中测试节流（几何每帧，命中 ≤10Hz + trailing 兜底）。 */
  private lastOcclusionAt = Number.NEGATIVE_INFINITY
  private lastCovered = false
  private forceOcclusionCheck = false
  private occlusionTimer: ReturnType<typeof setTimeout> | undefined
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
    // 重挂载重置遮挡节流态：上一次 mount 的判定/时钟不得让新宿主在 <100ms 内沿用旧遮挡。
    this.lastOcclusionAt = Number.NEGATIVE_INFINITY
    this.lastCovered = false
    this.forceOcclusionCheck = true
    // 候选缓存同样按 mount 重置：否则重挂载后的首个 due 检查可能复用上一个宿主的候选列表
    //（页面时基 <TTL 时连 QSA 都不会发生），浮层漏判窗口会随重挂载延续。
    this.overlayCandidates = []
    this.overlayCandidatesAt = Number.NEGATIVE_INFINITY
    host.dataset.chamberBrowserTab = this.tabId
    this.writeLease()
    const schedule = (): void => { this.schedule() }
    const resizeObserver = new ResizeObserver(schedule)
    resizeObserver.observe(host)
    this.observers.push(resizeObserver)
    // F: 只有文档/占位祖先容器的滚动才可能改变占位 rect；聊天等无关 scroller 物理上
    // 挪不动占位（祖先链 overflow:hidden|clip），跳过它们的每帧几何/命中空转。
    const onScroll = (event: Event): void => {
      const target = event.target
      const isElement = typeof Element !== 'undefined' && target instanceof Element
      const kind = classifyScrollTarget({
        targetIsDocument: target === document,
        targetIsElement: isElement,
        targetContainsHost: isElement && (target as Element).contains(host),
      })
      // 无关 scroller 不可能移动占位 rect；但浮层/遮挡仍可能随交互变化，只丢掉几何测量，
      // 仍安排一次遮挡 trailing 复检（否则 guest 可见时弹 Modal 后再无任何遮挡复检）。
      if (shouldMeasureOnScroll(kind)) this.schedule()
      else if (!this.occluded) this.scheduleOcclusionTrailingCheck()
    }
    this.listen(document, 'scroll', onScroll as EventListener, true)
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
      delete host.dataset.chamberBrowserLease
      this.host = undefined
      // Only a previously VISIBLE guest needs an explicit hide; a mount that never
      // reported (never acquired) must not emit a spurious hidden report.
      if (this.frame?.visible === true) {
        this.frame = hiddenGuestFrame(this.frame)
        this.events.hidden()
      }
    }
  }

  /**
   * Mirror the live guest lease onto the placeholder (design 28 v3 §3:89).
   *
   * @param lease - the lease adopted by this tab occurrence, or undefined when the
   *   lease is released/disposed. The tab id dataset remains the compatibility arm
   *   for an older shim whose input push carries no lease.
   */
  setLease(lease: string | undefined): void {
    if (this.lease === lease) return
    this.lease = lease
    this.writeLease()
  }

  /** @param occluded - a DOM/native layer may cover the panel; hide the native layer. */
  setOccluded(occluded: boolean): void {
    if (this.occluded === occluded) return
    this.occluded = occluded
    this.forceOcclusionCheck = true
    this.schedule()
  }

  /** Stop observing and drop the retained report. */
  dispose(): void {
    this.disposed = true
    this.teardown()
    const host = this.host
    if (host !== undefined) delete host.dataset.chamberBrowserLease
    this.host = undefined
    this.frame = undefined
  }

  /** Write/clear the lease dataset on the current placeholder. */
  private writeLease(): void {
    const host = this.host
    if (host === undefined) return
    if (this.lease === undefined) delete host.dataset.chamberBrowserLease
    else host.dataset.chamberBrowserLease = this.lease
  }

  private listen(target: EventTarget, type: string, listener: EventListener, capture: boolean): void {
    target.addEventListener(type, listener, capture)
    this.listeners.push({ target, type, listener, capture })
  }

  private teardown(): void {
    if (this.occlusionTimer !== undefined) { clearTimeout(this.occlusionTimer); this.occlusionTimer = undefined }
    for (const observer of this.observers.splice(0)) observer.disconnect()
    for (const entry of this.listeners.splice(0)) entry.target.removeEventListener(entry.type, entry.listener, entry.capture)
    // Both datasets are mount-scoped: a released/disposed presentation must not keep
    // a tab target on the placeholder (the shim's input replay would still find it).
    if (this.host !== undefined) delete this.host.dataset.chamberBrowserTab
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

  /** 几何在跑但遮挡命中被节流时，安排一次 trailing 检查（≤100ms 内补齐遮挡判定）。 */
  private scheduleOcclusionTrailingCheck(): void {
    if (this.disposed || this.occlusionTimer !== undefined) return
    const delay = Math.max(0, OCCLUSION_CHECK_INTERVAL_MS - (this.nowMs() - this.lastOcclusionAt))
    this.occlusionTimer = setTimeout(() => {
      this.occlusionTimer = undefined
      this.forceOcclusionCheck = true
      this.schedule()
    }, delay)
  }

  private nowMs(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
  }

  /** Overlay candidates, refreshed at most once per occlusion interval (RT-04). */
  private overlays(): Element[] {
    const now = typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
    if (now - this.overlayCandidatesAt < OVERLAY_CANDIDATE_TTL_MS) return this.overlayCandidates
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
    // E: 几何（rect/上报）每帧都跑；只有遮挡命中/候选 GBCR 按 ≤10Hz + trailing 节流。
    const now = this.nowMs()
    const due = this.forceOcclusionCheck || shouldCheckOcclusion({ now, lastCheckAt: this.lastOcclusionAt, forced: false })
    this.forceOcclusionCheck = false
    let covered: boolean
    if (due) {
      this.lastOcclusionAt = now
      covered = this.occluded || this.coveredByDomOverlay(host, rect)
      this.lastCovered = covered
    } else {
      covered = this.occluded || this.lastCovered
      if (!this.occluded) this.scheduleOcclusionTrailingCheck()
    }
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