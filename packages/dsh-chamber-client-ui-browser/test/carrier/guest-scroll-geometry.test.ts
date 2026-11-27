/**
 * 右栏 Browser guest 的滚动几何 flush 行为锁（design 28 §4.1）。
 *  - F：只有文档/占位祖先容器的滚动才 schedule；无关 scroller 的事件本身零 GBCR/零命中，
 *    但它的 trailing 复检会补测一次几何（≤10Hz）。
 *  - E：几何每帧读/上报；遮挡命中（候选 GBCR + 9 点）≤10Hz + trailing 补齐；setOccluded 强制。
 * 负控：去掉 F 的分类（恒 schedule）或去掉 E 的节流（每帧命中）时，对应用例必须红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyScrollTarget,
  shouldMeasureOnScroll,
  shouldCheckOcclusion,
  OCCLUSION_CHECK_INTERVAL_MS,
  OVERLAY_CANDIDATE_TTL_MS,
} from '../../src/client/browser/guest-geometry.ts'
import { NativeGuestPresentation } from '../../src/client/view/NativeGuestPresentation.ts'

function installFakeDom(t: { after: (fn: () => void) => void }) {
  const saved = {
    document: (globalThis as any).document,
    window: (globalThis as any).window,
    Element: (globalThis as any).Element,
    ResizeObserver: (globalThis as any).ResizeObserver,
    raf: (globalThis as any).requestAnimationFrame,
    setTimeout: (globalThis as any).setTimeout,
    clearTimeout: (globalThis as any).clearTimeout,
  }
  let frameQueue: Array<() => void> = []
  class FakeElement {
    dataset: Record<string, string> = {}
    isConnected = true
    gbcrCalls = 0
    containsCalls = 0
    readonly id: string
    readonly containsHost: boolean
    constructor(id: string, containsHost = false) { this.id = id; this.containsHost = containsHost }
    contains(_node: unknown): boolean { this.containsCalls += 1; return this.containsHost }
    getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
      this.gbcrCalls += 1
      return { left: 10, top: 20, width: 300, height: 200 }
    }
    addEventListener(): void {}
    removeEventListener(): void {}
  }
  const host = new FakeElement('viewport')
  const foreignOverlay = new FakeElement('foreign-overlay', false)
  const unrelated = new FakeElement('chat-scroller', false)
  const ancestor = new FakeElement('tab-body', true)
  const scrollListeners: Array<(event: Event) => void> = []
  let scrollCapture: boolean | null = null
  const documentRemoved: string[] = []
  const windowAdded: string[] = []
  const windowRemoved: string[] = []
  const activeTimers = new Set<number>()
  let eipCalls = 0
  let hitCovered = false
  let overlayQsaCalls = 0
  let overlayCandidates: FakeElement[] = []
  const documents: any = {
    getElementById: (id: string) => (id === 'viewport' ? host : null),
    addEventListener: (type: string, listener: (event: Event) => void, capture?: boolean) => { if (type === 'scroll') { scrollListeners.push(listener); scrollCapture = capture === true } },
    removeEventListener: (type: string, listener?: (event: Event) => void) => {
      documentRemoved.push(type)
      if (type === 'scroll' && listener !== undefined) {
        const index = scrollListeners.indexOf(listener as (event: Event) => void)
        if (index >= 0) scrollListeners.splice(index, 1)
      }
    },
    querySelectorAll: () => { overlayQsaCalls += 1; return overlayCandidates },
    elementsFromPoint: () => { eipCalls += 1; return [hitCovered ? foreignOverlay : host] },
  }
  const windows: any = {
    visualViewport: undefined,
    addEventListener: (type: string) => { windowAdded.push(type) },
    removeEventListener: (type: string) => { windowRemoved.push(type) },
  }
  ;(globalThis as any).document = documents
  ;(globalThis as any).window = windows
  ;(globalThis as any).Element = FakeElement
  ;(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} }
  ;(globalThis as any).requestAnimationFrame = (fn: () => void) => { frameQueue.push(fn); return frameQueue.length }
  ;(globalThis as any).setTimeout = (fn: () => void, ms?: number) => {
    const id = saved.setTimeout(() => { activeTimers.delete(id); fn() }, ms) as number
    activeTimers.add(id)
    return id
  }
  ;(globalThis as any).clearTimeout = (id: number) => { activeTimers.delete(id); saved.clearTimeout(id) }
  t.after(() => {
    ;(globalThis as any).document = saved.document
    ;(globalThis as any).window = saved.window
    ;(globalThis as any).Element = saved.Element
    ;(globalThis as any).ResizeObserver = saved.ResizeObserver
    ;(globalThis as any).requestAnimationFrame = saved.raf
    ;(globalThis as any).setTimeout = saved.setTimeout
    ;(globalThis as any).clearTimeout = saved.clearTimeout
  })
  return {
    host, unrelated, ancestor, documents,
    pumpFrame: () => { const queue = frameQueue; frameQueue = []; for (const fn of queue) fn() },
    dispatchScroll: (target: unknown) => { for (const listener of scrollListeners) listener({ target } as unknown as Event) },
    setHitCovered: (covered: boolean) => { hitCovered = covered },
    setOverlayCandidates: (candidates: FakeElement[]) => { overlayCandidates = candidates },
    foreignOverlay,
    stats: () => ({ eipCalls, overlayQsaCalls, scrollCapture, scrollListeners: scrollListeners.length, documentRemoved: [...documentRemoved], windowAdded: [...windowAdded], windowRemoved: [...windowRemoved], activeTimers: activeTimers.size }),
  }
}

test('classifyScrollTarget: unrelated scrollers are the only skippable class', () => {
  assert.equal(classifyScrollTarget({ targetIsDocument: true, targetIsElement: false, targetContainsHost: false }), 'document')
  assert.equal(classifyScrollTarget({ targetIsDocument: false, targetIsElement: true, targetContainsHost: true }), 'ancestor')
  assert.equal(classifyScrollTarget({ targetIsDocument: false, targetIsElement: true, targetContainsHost: false }), 'unrelated')
  assert.equal(classifyScrollTarget({ targetIsDocument: false, targetIsElement: false, targetContainsHost: false }), 'unknown')
  assert.equal(shouldMeasureOnScroll('unrelated'), false)
  assert.equal(shouldMeasureOnScroll('ancestor'), true)
  assert.equal(shouldMeasureOnScroll('document'), true)
  assert.equal(shouldMeasureOnScroll('unknown'), true)
})

test('shouldCheckOcclusion: first check, forced check, or 100ms interval', () => {
  assert.equal(OCCLUSION_CHECK_INTERVAL_MS, 100)
  assert.equal(shouldCheckOcclusion({ now: 1, lastCheckAt: Number.NEGATIVE_INFINITY, forced: false }), true)
  assert.equal(shouldCheckOcclusion({ now: 150, lastCheckAt: 100, forced: false }), false)
  assert.equal(shouldCheckOcclusion({ now: 200, lastCheckAt: 100, forced: false }), true)
  assert.equal(shouldCheckOcclusion({ now: 150, lastCheckAt: 100, forced: true }), true)
})

test('F: an unrelated scroller never measures the placeholder', (t) => {
  const dom = installFakeDom(t)
  const reports: unknown[] = []
  const presentation = new NativeGuestPresentation({ report: (r) => reports.push(r), hidden: () => {} }, 'tab-1')
  presentation.mount('viewport')
  dom.pumpFrame()
  const baseGbcr = dom.host.gbcrCalls
  const baseReports = reports.length
  dom.dispatchScroll(dom.unrelated)
  dom.pumpFrame()
  assert.equal(dom.host.gbcrCalls, baseGbcr, 'unrelated scroll must not measure the placeholder')
  assert.equal(reports.length, baseReports, 'unrelated scroll must not report')
  presentation.dispose()
})

test('F: an ancestor scroller measures once per rAF frame', (t) => {
  const dom = installFakeDom(t)
  let reports = 0
  const presentation = new NativeGuestPresentation({ report: () => { reports += 1 }, hidden: () => {} }, 'tab-1')
  presentation.mount('viewport')
  dom.pumpFrame()
  const baseGbcr = dom.host.gbcrCalls
  dom.dispatchScroll(dom.ancestor)
  dom.dispatchScroll(dom.ancestor)
  dom.dispatchScroll(dom.ancestor)
  dom.pumpFrame()
  assert.equal(dom.host.gbcrCalls, baseGbcr + 1, 'coalesced through rAF')
  // rect 未变时按「只在变化时发」契约不上报，故这里锁测量次数而非上报次数。
  presentation.dispose()
})

test('E: occlusion hit test is throttled to <=10Hz but a trailing check lands', async (t) => {
  const dom = installFakeDom(t)
  const presentation = new NativeGuestPresentation({ report: () => {}, hidden: () => {} }, 'tab-1')
  presentation.mount('viewport')
  dom.pumpFrame()
  const baseEip = dom.stats().eipCalls
  const baseGbcr = dom.host.gbcrCalls
  for (let i = 0; i < 10; i += 1) { dom.dispatchScroll(dom.ancestor); dom.pumpFrame() }
  const afterBurst = dom.stats().eipCalls - baseEip
  // 几何承诺：遮挡命中被节流时，占位 rect 仍每帧测量（10 frames -> 10 GBCR）。
  assert.equal(dom.host.gbcrCalls - baseGbcr, 10, 'geometry must run every frame while occlusion is throttled')
  // A 10-frame burst must not hit-test every frame; allow at most the one 9-point
  // check that may become due if the burst straddles the 100ms interval.
  assert.ok(afterBurst <= 2, 'burst must not hit-test every frame (got ' + afterBurst + ')')
  await new Promise((resolve) => setTimeout(resolve, OCCLUSION_CHECK_INTERVAL_MS + 40))
  dom.pumpFrame()
  const afterTrailing = dom.stats().eipCalls - baseEip
  // 一次 9 点命中 = 9 次 elementsFromPoint（外加候选 rect）；上限按点数量级而非 flush 次数。
  assert.ok(afterTrailing >= 1 && afterTrailing <= afterBurst + 12, 'trailing check must land once')
  presentation.dispose()
})

test('E: setOccluded(false) re-runs the hit test inside the throttle window', async (t) => {
  const dom = installFakeDom(t)
  const reports: Array<{ visible: boolean; occluded: boolean }> = []
  const presentation = new NativeGuestPresentation({ report: (r) => reports.push({ visible: r.visible, occluded: r.occluded }), hidden: () => {} }, 'tab-1')
  presentation.mount('viewport')
  dom.pumpFrame()
  assert.equal(reports.at(-1)?.visible, true)
  // 让一次真实命中判定得到 covered=true（写进 lastCovered），再在节流窗口内解除遮挡：
  // 没有 forceOcclusionCheck 时 lastCovered 会继续把它当遮挡，guest 永远不会恢复。
  dom.setHitCovered(true)
  await new Promise((resolve) => setTimeout(resolve, OCCLUSION_CHECK_INTERVAL_MS + 40))
  dom.dispatchScroll(dom.ancestor)
  dom.pumpFrame()
  assert.equal(reports.at(-1)?.occluded, true)
  dom.setHitCovered(false)
  presentation.setOccluded(true)
  dom.pumpFrame()
  presentation.setOccluded(false)
  dom.pumpFrame()
  assert.equal(reports.at(-1)?.visible, true, 'setOccluded(false) must re-run the hit test immediately')
  presentation.dispose()
})

test('setOccluded forces an immediate hidden report and dispose drops the timer', (t) => {
  const dom = installFakeDom(t)
  const reports: Array<{ visible: boolean; occluded: boolean }> = []
  const presentation = new NativeGuestPresentation({ report: (r) => reports.push({ visible: r.visible, occluded: r.occluded }), hidden: () => {} }, 'tab-1')
  presentation.mount('viewport')
  dom.pumpFrame()
  assert.equal(reports.at(-1)?.visible, true)
  presentation.setOccluded(true)
  dom.pumpFrame()
  assert.equal(reports.at(-1)?.visible, false)
  assert.equal(reports.at(-1)?.occluded, true)
  // 同一节流窗口内解除遮挡必须强制重判（否则 lastCovered 会把它继续当作遮挡）。
  presentation.setOccluded(false)
  dom.pumpFrame()
  assert.equal(reports.at(-1)?.visible, true, 'setOccluded(false) must re-run the hit test immediately')
  presentation.dispose()
})
test('the document scroll listener uses the capture phase and is removed on dispose', (t) => {
  const dom = installFakeDom(t)
  const presentation = new NativeGuestPresentation({ report: () => {}, hidden: () => {} }, 'tab-1')
  presentation.mount('viewport')
  assert.equal(dom.stats().scrollCapture, true, 'scroll must be captured before unrelated scrollers')
  assert.ok(dom.stats().scrollListeners > 0)
  presentation.dispose()
  assert.equal(dom.stats().scrollListeners, 0, 'document scroll listener must be removed on dispose')
  assert.ok(dom.stats().documentRemoved.includes('scroll'))
  assert.ok(dom.stats().windowRemoved.includes('resize'), 'window resize listener must be removed on dispose')
  assert.equal(dom.host.dataset.chamberBrowserTab, undefined, 'the tab dataset must be cleared with the lease/listeners')
})

test('a cached occlusion verdict is reused inside the throttle window, then refreshed', async (t) => {
  const dom = installFakeDom(t)
  const reports: Array<{ visible: boolean; occluded: boolean }> = []
  const presentation = new NativeGuestPresentation({ report: (r) => reports.push({ visible: r.visible, occluded: r.occluded }), hidden: () => {} }, 'tab-1')
  presentation.mount('viewport')
  dom.pumpFrame()
  dom.setHitCovered(true)
  await new Promise((resolve) => setTimeout(resolve, OCCLUSION_CHECK_INTERVAL_MS + 40))
  const beforeEip = dom.stats().eipCalls
  dom.dispatchScroll(dom.ancestor)
  dom.pumpFrame()
  const coveredEip = dom.stats().eipCalls
  assert.ok(coveredEip > beforeEip, 'a due check must hit-test')
  assert.equal(reports.at(-1)?.occluded, true)
  dom.setHitCovered(false)
  dom.dispatchScroll(dom.ancestor)
  dom.pumpFrame()
  assert.equal(dom.stats().eipCalls, coveredEip, 'inside the throttle window the cached verdict must be reused')
  assert.equal(reports.at(-1)?.occluded, true, 'cached verdict keeps the guest hidden until the trailing check')
  await new Promise((resolve) => setTimeout(resolve, OCCLUSION_CHECK_INTERVAL_MS + 40))
  dom.pumpFrame()
  assert.equal(reports.at(-1)?.occluded, false, 'the trailing check must refresh the cached verdict')
  presentation.dispose()
})

test('n2: an occluded guest skips the unrelated-scroll trailing arm until released', (t) => {
  const dom = installFakeDom(t)
  const presentation = new NativeGuestPresentation({ report: () => {}, hidden: () => {} }, 'tab-1')
  presentation.mount('viewport')
  dom.pumpFrame()
  presentation.setOccluded(true)
  dom.pumpFrame()
  dom.dispatchScroll(dom.unrelated)
  dom.pumpFrame()
  assert.equal(dom.stats().activeTimers, 0, 'occluded guest must not arm a trailing geometry check')
  presentation.setOccluded(false)
  dom.pumpFrame()
  dom.dispatchScroll(dom.unrelated)
  dom.pumpFrame()
  assert.ok(dom.stats().activeTimers >= 1, 'after release, unrelated scroll arms the trailing check again')
  presentation.dispose()
})

test('n3: the mount cleanup clears both placeholder datasets', (t) => {
  const dom = installFakeDom(t)
  const presentation = new NativeGuestPresentation({ report: () => {}, hidden: () => {} }, 'tab-1')
  const cleanup = presentation.mount('viewport')
  dom.pumpFrame()
  assert.equal(dom.host.dataset.chamberBrowserTab, 'tab-1')
  cleanup()
  assert.equal(dom.host.dataset.chamberBrowserTab, undefined)
  assert.equal(dom.host.dataset.chamberBrowserLease, undefined)
})

test('dispose clears the pending occlusion timer', (t) => {
  const dom = installFakeDom(t)
  const presentation = new NativeGuestPresentation({ report: () => {}, hidden: () => {} }, 'tab-1')
  presentation.mount('viewport')
  dom.pumpFrame()
  for (let i = 0; i < 10; i += 1) { dom.dispatchScroll(dom.ancestor); dom.pumpFrame() }
  assert.ok(dom.stats().activeTimers >= 1, 'a throttled frame must arm a trailing timer')
  presentation.dispose()
  assert.equal(dom.stats().activeTimers, 0, 'dispose must clear the trailing timer')
})

test('B1: an unrelated scroll still arms a trailing occlusion check', async (t) => {
  const dom = installFakeDom(t)
  const reports: Array<{ visible: boolean; occluded: boolean }> = []
  const presentation = new NativeGuestPresentation({ report: (r) => reports.push({ visible: r.visible, occluded: r.occluded }), hidden: () => {} }, 'tab-1')
  presentation.mount('viewport')
  dom.pumpFrame()
  assert.equal(reports.at(-1)?.visible, true)
  dom.setHitCovered(true)
  dom.dispatchScroll(dom.unrelated)
  dom.pumpFrame()
  assert.equal(reports.at(-1)?.visible, true, 'an unrelated scroll must not measure geometry')
  await new Promise((resolve) => setTimeout(resolve, OCCLUSION_CHECK_INTERVAL_MS + 40))
  dom.pumpFrame()
  assert.equal(reports.at(-1)?.occluded, true, 'the trailing occlusion check must still run')
  presentation.dispose()
})

test('B2: a due hit test refreshes a stale overlay candidate list', async (t) => {
  assert.equal(OVERLAY_CANDIDATE_TTL_MS, OCCLUSION_CHECK_INTERVAL_MS)
  const dom = installFakeDom(t)
  const reports: Array<{ visible: boolean; occluded: boolean }> = []
  const presentation = new NativeGuestPresentation({ report: (r) => reports.push({ visible: r.visible, occluded: r.occluded }), hidden: () => {} }, 'tab-1')
  presentation.mount('viewport')
  dom.pumpFrame()
  assert.equal(reports.at(-1)?.visible, true)
  const qsaAtMount = dom.stats().overlayQsaCalls
  dom.setOverlayCandidates([dom.foreignOverlay])
  dom.dispatchScroll(dom.ancestor)
  dom.pumpFrame()
  assert.equal(reports.at(-1)?.visible, true, 'inside the interval the cached empty candidate list is reused')
  assert.equal(dom.stats().overlayQsaCalls, qsaAtMount, 'a non-due geometry flush must not query candidates')
  await new Promise((resolve) => setTimeout(resolve, OCCLUSION_CHECK_INTERVAL_MS + 40))
  dom.dispatchScroll(dom.ancestor)
  dom.pumpFrame()
  assert.equal(dom.stats().overlayQsaCalls, qsaAtMount + 1, 'one due check refreshes candidates at most once')
  assert.equal(reports.at(-1)?.occluded, true, 'a due check must see the new candidate')
  presentation.dispose()
})
