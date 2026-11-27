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
  // 可换宿主的视口表：remount 用例改 getElementById 的返回值；activeHost 决定命中测试的 topmost。
  const viewports: Record<string, FakeElement> = { viewport: host }
  let activeHost: FakeElement = host
  const scrollListeners: Array<(event: Event) => void> = []
  let scrollCapture: boolean | null = null
  const documentRemoved: string[] = []
  const windowAdded: string[] = []
  const windowRemoved: string[] = []
  const activeTimers = new Set<number>()
  const timerDelays: number[] = []
  let eipCalls = 0
  let hitCovered = false
  let overlayQsaCalls = 0
  let overlayCandidates: FakeElement[] = []
  const documents: any = {
    getElementById: (id: string) => {
      const element = viewports[id] ?? null
      if (element !== null) activeHost = element
      return element
    },
    addEventListener: (type: string, listener: (event: Event) => void, capture?: boolean) => { if (type === 'scroll') { scrollListeners.push(listener); scrollCapture = capture === true } },
    removeEventListener: (type: string, listener?: (event: Event) => void) => {
      documentRemoved.push(type)
      if (type === 'scroll' && listener !== undefined) {
        const index = scrollListeners.indexOf(listener as (event: Event) => void)
        if (index >= 0) scrollListeners.splice(index, 1)
      }
    },
    querySelectorAll: () => { overlayQsaCalls += 1; return overlayCandidates },
    elementsFromPoint: () => { eipCalls += 1; return [hitCovered ? foreignOverlay : activeHost] },
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
    timerDelays.push(typeof ms === 'number' ? ms : 0)
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
    createElement: (id: string, containsHost = false) => new FakeElement(id, containsHost),
    setViewport: (id: string, element: FakeElement) => { viewports[id] = element },
    pumpFrame: () => { const queue = frameQueue; frameQueue = []; for (const fn of queue) fn() },
    dispatchScroll: (target: unknown) => { for (const listener of scrollListeners) listener({ target } as unknown as Event) },
    setHitCovered: (covered: boolean) => { hitCovered = covered },
    setOverlayCandidates: (candidates: FakeElement[]) => { overlayCandidates = candidates },
    foreignOverlay,
    stats: () => ({ eipCalls, overlayQsaCalls, scrollCapture, scrollListeners: scrollListeners.length, documentRemoved: [...documentRemoved], windowAdded: [...windowAdded], windowRemoved: [...windowRemoved], activeTimers: activeTimers.size, timerDelays: [...timerDelays] }),
  }
}

/**
 * 可控的 performance.now：把页面时基钉在测试指定的毫秒值，让候选 TTL / 遮挡节流窗口
 * 这类按时间判定的分支可以精确断言（真实 timer 仍由 installFakeDom 记账）。
 */
function installFakeClock(t: { after: (fn: () => void) => void }) {
  const saved = (globalThis as any).performance
  let nowMs = 0
  ;(globalThis as any).performance = { now: () => nowMs }
  t.after(() => { (globalThis as any).performance = saved })
  return { set: (value: number) => { nowMs = value } }
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
  const baseGbcr = dom.host.gbcrCalls
  dom.setHitCovered(true)
  dom.dispatchScroll(dom.unrelated)
  dom.pumpFrame()
  assert.equal(dom.host.gbcrCalls, baseGbcr, 'an unrelated scroll must not measure geometry')
  assert.equal(reports.at(-1)?.visible, true, 'an unrelated scroll must not report')
  await new Promise((resolve) => setTimeout(resolve, OCCLUSION_CHECK_INTERVAL_MS + 40))
  dom.pumpFrame()
  // trailing 复检必须补一次占位几何测量：命中判定翻转之外，native guest 的 rect 也靠它刷新。
  assert.equal(dom.host.gbcrCalls, baseGbcr + 1, 'the trailing check must re-measure the placeholder geometry')
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

test('E: a non-due flush arms the trailing check for the remaining interval, not immediately', async (t) => {
  const dom = installFakeDom(t)
  const clock = installFakeClock(t)
  clock.set(1000)
  const presentation = new NativeGuestPresentation({ report: () => {}, hidden: () => {} }, 'tab-1')
  presentation.mount('viewport')
  dom.pumpFrame() // 首个 due 检查：lastOcclusionAt=1000，候选缓存也落在 1000
  const baseEip = dom.stats().eipCalls
  const baseQsa = dom.stats().overlayQsaCalls
  clock.set(1040) // due 检查后第 40ms
  dom.dispatchScroll(dom.ancestor)
  dom.pumpFrame()
  assert.equal(dom.stats().eipCalls, baseEip, 'a non-due flush must not hit-test')
  assert.equal(dom.stats().overlayQsaCalls, baseQsa, 'a non-due flush must not query candidates')
  assert.equal(dom.stats().activeTimers, 1, 'the non-due flush arms exactly one trailing timer')
  clock.set(1100) // 到达 due 时刻；trailing 在真实 60ms 后触发
  // 真实 60ms 之前来一帧：trailing 不得提前命中测试/刷候选（delay=0 的变异在这里红）。
  await new Promise((resolve) => setTimeout(resolve, 20))
  dom.pumpFrame()
  assert.equal(dom.stats().eipCalls, baseEip, 'no hit test may run before the remaining interval elapses')
  assert.equal(dom.stats().overlayQsaCalls, baseQsa, 'no candidate refresh may run before the due moment')
  // 延迟必须是「剩余间隔」而不是 0：否则动画期命中测试回到 rAF 频率，≤10Hz 的上界失效。
  assert.equal(dom.stats().timerDelays[0], OCCLUSION_CHECK_INTERVAL_MS - 40, 'the trailing delay is the remaining interval')
  await new Promise((resolve) => setTimeout(resolve, 100))
  dom.pumpFrame()
  assert.equal(dom.stats().eipCalls - baseEip, 9, 'the trailing check lands exactly one 9-point hit test')
  assert.equal(dom.stats().overlayQsaCalls - baseQsa, 1, 'the trailing due check refreshes candidates once')
  presentation.dispose()
})

test('M1: a mount inside the first 100ms still refreshes overlay candidates on the first due check', (t) => {
  const dom = installFakeDom(t)
  const clock = installFakeClock(t)
  clock.set(50) // 页面时基 < 候选 TTL：初始挂载首帧的边界（壳文档 time origin 后 <100ms）
  // pointer-events:none 浮层：rect 与占位相交，但永远赢不了 9 点命中测试。
  dom.setOverlayCandidates([dom.foreignOverlay])
  const reports: Array<{ visible: boolean; occluded: boolean }> = []
  const presentation = new NativeGuestPresentation({ report: (r) => reports.push({ visible: r.visible, occluded: r.occluded }), hidden: () => {} }, 'tab-1')
  presentation.mount('viewport')
  dom.pumpFrame()
  assert.equal(dom.stats().overlayQsaCalls, 1, 'the first due check must not reuse the never-refreshed candidate cache')
  assert.equal(dom.stats().eipCalls, 0, 'a covering candidate short-circuits before the point hit test')
  assert.equal(reports.at(-1)?.visible, false, 'the pointer-events:none overlay must hide the guest on the first frame')
  assert.equal(reports.at(-1)?.occluded, true)
  assert.equal(dom.stats().activeTimers, 0, 'the forced first check must not leave a trailing timer as the only recovery')
  presentation.dispose()
})

test('W1: a remount re-runs the hit test and refreshes candidates instead of reusing the old host state', (t) => {
  const dom = installFakeDom(t)
  const clock = installFakeClock(t)
  const reports: Array<{ visible: boolean; occluded: boolean }> = []
  const presentation = new NativeGuestPresentation({ report: (r) => reports.push({ visible: r.visible, occluded: r.occluded }), hidden: () => {} }, 'tab-1')
  clock.set(0)
  const cleanup = presentation.mount('viewport')
  dom.pumpFrame()
  assert.equal(reports.at(-1)?.visible, true)
  // 旧宿主在 due 检查里判定 covered=true，并把 lastOcclusionAt/候选缓存时钟推到 150ms。
  dom.setHitCovered(true)
  clock.set(150)
  dom.dispatchScroll(dom.ancestor)
  dom.pumpFrame()
  assert.equal(reports.at(-1)?.occluded, true)
  const eipBeforeRemount = dom.stats().eipCalls
  const qsaBeforeRemount = dom.stats().overlayQsaCalls
  dom.setHitCovered(false)
  clock.set(160) // 距旧 due 检查只有 10ms：未重置的实现会走「非 due 复用旧判定」分支
  cleanup()
  const secondHost = dom.createElement('viewport-2')
  dom.setViewport('viewport-2', secondHost)
  presentation.mount('viewport-2')
  dom.pumpFrame()
  assert.equal(secondHost.gbcrCalls, 1, 'the remount first flush must measure the new host')
  assert.equal(dom.stats().eipCalls - eipBeforeRemount, 9, 'the remount first flush must re-run the hit test')
  assert.equal(dom.stats().overlayQsaCalls - qsaBeforeRemount, 1, 'the remount first flush must refresh candidates')
  assert.equal(reports.at(-1)?.visible, true, 'the new host must not inherit the previous covered verdict')
  assert.equal(secondHost.dataset.chamberBrowserTab, 'tab-1')
  presentation.dispose()
})

test('W1: repeated non-due frames arm a single trailing timer', (t) => {
  const dom = installFakeDom(t)
  const clock = installFakeClock(t)
  clock.set(1000)
  const presentation = new NativeGuestPresentation({ report: () => {}, hidden: () => {} }, 'tab-1')
  presentation.mount('viewport')
  dom.pumpFrame()
  const baseEip = dom.stats().eipCalls
  clock.set(1040)
  for (let frame = 0; frame < 3; frame += 1) {
    dom.dispatchScroll(dom.ancestor)
    dom.pumpFrame()
  }
  assert.equal(dom.stats().eipCalls, baseEip, 'three non-due frames must not hit-test')
  assert.deepEqual(dom.stats().timerDelays, [OCCLUSION_CHECK_INTERVAL_MS - 40], 'the deduplicated timer keeps the remaining interval')
  assert.equal(dom.stats().activeTimers, 1, 'three non-due frames must arm exactly one trailing timer')
  presentation.dispose()
  assert.equal(dom.stats().activeTimers, 0, 'dispose must clear the deduplicated timer')
})

test('W1: dispose drops an rAF flush that was already queued', (t) => {
  const dom = installFakeDom(t)
  const reports: unknown[] = []
  const hiddenCalls: number[] = []
  const presentation = new NativeGuestPresentation({ report: (r) => { reports.push(r) }, hidden: () => { hiddenCalls.push(1) } }, 'tab-1')
  presentation.mount('viewport')
  dom.pumpFrame()
  assert.equal(reports.length, 1)
  presentation.setOccluded(true) // 只排 rAF、不 pump：dispose 之后该帧不得再跑
  presentation.dispose()
  dom.pumpFrame()
  assert.equal(reports.length, 1, 'a flush queued before dispose must not report')
  assert.equal(hiddenCalls.length, 0, 'a flush queued before dispose must not emit hidden')
})
