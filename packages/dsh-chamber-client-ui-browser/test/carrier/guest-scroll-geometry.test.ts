/**
 * M4 修复的行为锁：右栏 Browser guest 的滚动几何 flush（design 28 §4.1）。
 *  - F：只有文档/占位祖先容器的滚动才 schedule；无关 scroller（chat 等）零 GBCR/零命中。
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
} from '../../src/client/browser/guest-geometry.ts'
import { NativeGuestPresentation } from '../../src/client/view/NativeGuestPresentation.ts'

function installFakeDom(t: { after: (fn: () => void) => void }) {
  const saved = {
    document: (globalThis as any).document,
    window: (globalThis as any).window,
    Element: (globalThis as any).Element,
    ResizeObserver: (globalThis as any).ResizeObserver,
    raf: (globalThis as any).requestAnimationFrame,
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
  const windowListeners: string[] = []
  let eipCalls = 0
  let hitCovered = false
  let overlayQsaCalls = 0
  const documents: any = {
    getElementById: (id: string) => (id === 'viewport' ? host : null),
    addEventListener: (type: string, listener: (event: Event) => void) => { if (type === 'scroll') scrollListeners.push(listener) },
    removeEventListener: () => {},
    querySelectorAll: () => { overlayQsaCalls += 1; return [] },
    elementsFromPoint: () => { eipCalls += 1; return [hitCovered ? foreignOverlay : host] },
  }
  const windows: any = {
    visualViewport: undefined,
    addEventListener: (type: string) => { windowListeners.push(type) },
    removeEventListener: () => {},
  }
  ;(globalThis as any).document = documents
  ;(globalThis as any).window = windows
  ;(globalThis as any).Element = FakeElement
  ;(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} }
  ;(globalThis as any).requestAnimationFrame = (fn: () => void) => { frameQueue.push(fn); return frameQueue.length }
  t.after(() => {
    ;(globalThis as any).document = saved.document
    ;(globalThis as any).window = saved.window
    ;(globalThis as any).Element = saved.Element
    ;(globalThis as any).ResizeObserver = saved.ResizeObserver
    ;(globalThis as any).requestAnimationFrame = saved.raf
  })
  return {
    host, unrelated, ancestor, documents,
    pumpFrame: () => { const queue = frameQueue; frameQueue = []; for (const fn of queue) fn() },
    dispatchScroll: (target: unknown) => { for (const listener of scrollListeners) listener({ target } as unknown as Event) },
    setHitCovered: (covered: boolean) => { hitCovered = covered },
    stats: () => ({ eipCalls, overlayQsaCalls, windowListeners: [...windowListeners] }),
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