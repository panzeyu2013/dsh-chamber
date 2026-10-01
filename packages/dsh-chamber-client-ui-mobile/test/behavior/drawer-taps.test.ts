/**
 * Drawer tap self-heal tests: the pure decisions (the tap/pan discriminator,
 * the heal-target predicate, the real-click clear decision, the
 * late-real-click suppression window) plus the INSTALLER wiring driven through
 * a minimal DOM double (the grace timer, the per-pointerId pending map,
 * installOnce seating). The device acceptance gate stays the end-to-end check
 * (design 17 §18.6).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isStableTap, isHealableDrawerTarget, TAP_SLOP_PX, HEAL_GRACE_MS, HEAL_SUPPRESS_MS,
  HEAL_FORM_SELECTOR, shouldClearPendingHeal, isSuppressedLateClick,
  installDrawerTapHeal,
} from '../../src/client/drawer-taps.ts'

import { ClosestStub } from '../support/closest-stub.ts'

const drawer = () => new ClosestStub({ '[data-mobile-role="sidebar"]': true })

test('isStableTap: within the slop on both axes is a tap', () => {
  assert.equal(isStableTap({ startX: 0, startY: 0, endX: 0, endY: 0 }), true)
  assert.equal(isStableTap({ startX: 0, startY: 0, endX: TAP_SLOP_PX, endY: 0 }), true)
  assert.equal(isStableTap({ startX: 0, startY: 0, endX: 0, endY: -TAP_SLOP_PX }), true)
  assert.equal(isStableTap({ startX: 0, startY: 0, endX: TAP_SLOP_PX, endY: TAP_SLOP_PX }), true)
})

test('isStableTap: beyond the slop is a pan/scroll intent (never healed)', () => {
  assert.equal(isStableTap({ startX: 0, startY: 0, endX: TAP_SLOP_PX + 1, endY: 0 }), false)
  assert.equal(isStableTap({ startX: 0, startY: 0, endX: 0, endY: TAP_SLOP_PX + 1 }), false)
  assert.equal(isStableTap({ startX: 100, startY: 100, endX: 100, endY: 400 }), false)
})

test('heal timing constants stay pinned at the documented values', () => {
  // 常量钉:grace 是「等真实 click 先到」的窗口,抑制窗覆盖 heal 之后的迟到
  // click——两者的「行为」由下方 isSuppressedLateClick 边界测试覆盖
  // (installer 时序为 device-gated,仓库惯例),这里只防意外改值。
  assert.equal(HEAL_GRACE_MS, 120)
  assert.equal(HEAL_SUPPRESS_MS, 150)
})

test('isSuppressedLateClick: only a same-spot click inside the window is suppressed', () => {
  // 窗口内(含两端边界)且距离在 slop 内 → 抑制。
  assert.equal(isSuppressedLateClick(1_000, 1_000, 0, 0), true)
  assert.equal(isSuppressedLateClick(1_000, 1_150, 0, 0), true)
  assert.equal(isSuppressedLateClick(1_000, 1_050, TAP_SLOP_PX, -TAP_SLOP_PX), true)
  // 超窗 / 负时间(时钟回退、异序事件)→ 不抑制。
  assert.equal(isSuppressedLateClick(1_000, 1_151, 0, 0), false)
  assert.equal(isSuppressedLateClick(1_000, 999, 0, 0), false)
  // 超 slop → 是另一处点击,不抑制。
  assert.equal(isSuppressedLateClick(1_000, 1_050, TAP_SLOP_PX + 1, 0), false)
  assert.equal(isSuppressedLateClick(1_000, 1_050, 0, TAP_SLOP_PX + 1), false)
})

test('shouldClearPendingHeal: a click at/inside the tap target clears (delivered real click)', () => {
  // 到达的兼容 click 落在 row 或其子树内:已激活,heal 必须取消。
  assert.equal(shouldClearPendingHeal({ atOrInsideTapTarget: true, ancestorOfTapTarget: false }), true)
})

test('shouldClearPendingHeal: an ANCESTOR click clears too (hover-reveal retargeting)', () => {
  // iOS 把迟到的合成 click 重定向到 down/up 目标的最近共同祖先;hover-reveal
  // 位移后该祖先行在 pointerup 目标之上,click 已沿祖先冒泡激活 row——同样
  // 不得再 heal(否则双激活)。
  assert.equal(shouldClearPendingHeal({ atOrInsideTapTarget: false, ancestorOfTapTarget: true }), true)
})

test('shouldClearPendingHeal: an unrelated click keeps the heal armed', () => {
  // 与 tap 目标无关的 click(其它行/抽屉外)不清除——heal 语义是「该 tap 的
  // 真实 click 到达则零干预」,别的 click 不取消它。
  assert.equal(shouldClearPendingHeal({ atOrInsideTapTarget: false, ancestorOfTapTarget: false }), false)
})

test('isHealableDrawerTarget: rows inside the drawer heal', () => {
  const row = drawer()
  assert.equal(isHealableDrawerTarget(row), true)
})

test('isHealableDrawerTarget: form fields inside the drawer never heal', () => {
  // The predicate asks closest() with the COMBINED form selector — a field
  // inside a drawer matches both the drawer and the form chain.
  const fieldInDrawer = new ClosestStub({
    '[data-mobile-role="sidebar"]': true,
    [HEAL_FORM_SELECTOR]: true,
  })
  assert.equal(isHealableDrawerTarget(fieldInDrawer), false)
  // Any element whose ancestor chain contains the form selector heals
  // nowhere, even without a drawer (form check runs first).
  const fieldOnly = new ClosestStub({ [HEAL_FORM_SELECTOR]: true })
  assert.equal(isHealableDrawerTarget(fieldOnly), false)
})

test('isHealableDrawerTarget: outside the drawer never heals', () => {
  assert.equal(isHealableDrawerTarget(new ClosestStub({})), false)
  assert.equal(isHealableDrawerTarget(null), false)
})

// ---------------------------------------------------------------------------
// The INSTALLER, driven through a minimal DOM double. The pure decisions above
// cannot see the gesture wiring: installOnce seating, the per-pointer grace
// timers, the pending map and the late-click suppression. The installer reads
// the real document/window/Element/Node/MouseEvent globals, so this bench
// installs duck-typed doubles for the duration of one test (the package has no
// DOM environment — that is the point of the doubles).
// ---------------------------------------------------------------------------

const DRAWER_SELECTOR = '[data-mobile-role="sidebar"]'

/** The element face the installer touches: exact-selector closest() answers
 *  (like ClosestStub, with ancestry), contains() and the dispatch record. */
class TapElement {
  readonly chain: Record<string, TapElement | null>
  connected = true
  readonly containsNodes: unknown[] = []
  readonly clicks: Array<Record<string, unknown>> = []
  constructor(chain: Record<string, TapElement | null> = {}) { this.chain = chain }
  get isConnected(): boolean { return this.connected }
  closest(selector: string): TapElement | null { return this.chain[selector] ?? null }
  contains(node: unknown): boolean { return node === this || this.containsNodes.includes(node) }
  dispatchEvent(event: unknown): boolean {
    this.clicks.push(event as Record<string, unknown>)
    return true
  }
}

/** The real MouseEvent constructor is absent in plain node; the installer
 *  builds the heal through the global, so the double carries its init. */
class MouseEventDouble extends Event {
  readonly clientX: number
  readonly clientY: number
  readonly view: unknown
  constructor(
    type: string,
    init: { bubbles?: boolean; cancelable?: boolean; view?: unknown; clientX?: number; clientY?: number } = {},
  ) {
    super(type, init)
    this.clientX = init.clientX ?? 0
    this.clientY = init.clientY ?? 0
    this.view = init.view
  }
}

class DocumentDouble {
  private readonly listeners = new Map<string, Array<(event: never) => void>>()
  addEventListener(type: string, handler: (event: never) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }
  removeEventListener(type: string, handler: (event: never) => void): void {
    const list = this.listeners.get(type) ?? []
    const index = list.indexOf(handler)
    if (index !== -1) list.splice(index, 1)
  }
  dispatch(type: string, event: unknown): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event as never)
  }
  listenerCount(type: string): number { return (this.listeners.get(type) ?? []).length }
}

/** One pointer gesture as the capture-phase listeners receive it. */
interface TapGesture {
  pointerId: number
  pointerType: string
  clientX: number
  clientY: number
  target: TapElement
}

interface TapEnvironment {
  readonly document: DocumentDouble
  pointer(type: 'pointerdown' | 'pointerup' | 'pointercancel', event: TapGesture): void
  click(target: unknown, init?: { isTrusted?: boolean; clientX?: number; clientY?: number }): { stopped: number }
  listenerCount(type: string): number
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** One tap past the grace window: enough for the heal timer to have fired. */
const AFTER_GRACE_MS = HEAL_GRACE_MS + 60

async function withTapDom(run: (env: TapEnvironment) => Promise<void>): Promise<void> {
  const document = new DocumentDouble()
  const globals = globalThis as unknown as Record<string, unknown>
  const names = ['document', 'window', 'Element', 'Node', 'MouseEvent'] as const
  const previous = names.map(name => [name, globals[name]] as const)
  globals.document = document
  globals.window = {}
  globals.Element = TapElement
  globals.Node = TapElement
  globals.MouseEvent = MouseEventDouble
  try {
    await run({
      document,
      pointer: (type, event) => document.dispatch(type, event),
      click: (target, init = {}) => {
        const state = { stopped: 0 }
        document.dispatch('click', {
          target,
          isTrusted: init.isTrusted ?? true,
          clientX: init.clientX ?? 0,
          clientY: init.clientY ?? 0,
          stopPropagation: () => { state.stopped += 1 },
        })
        return state
      },
      listenerCount: type => document.listenerCount(type),
    })
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete globals[name]
      else globals[name] = value
    }
  }
}

/** The production target shape: a row inside the drawer, not a form control. */
function drawerRow(drawer: TapElement): TapElement {
  return new TapElement({ [DRAWER_SELECTOR]: drawer, [HEAL_FORM_SELECTOR]: null })
}

test('installDrawerTapHeal: a suppressed drawer tap heals once after the grace, and a double install seats ONE listener', async () => {
  await withTapDom(async env => {
    const drawer = new TapElement()
    const row = drawerRow(drawer)
    const first = installDrawerTapHeal(() => true)
    const second = installDrawerTapHeal(() => true)
    try {
      assert.equal(env.listenerCount('pointerup'), 1, 'installOnce: the second install must not register a second heal seat')
      env.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 120, target: row })
      env.pointer('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 41, clientY: 121, target: row })
      assert.equal(row.clicks.length, 0, 'the heal waits out the grace window')
      await delay(AFTER_GRACE_MS)
      assert.equal(row.clicks.length, 1, 'exactly one synthesized activation')
      const click = row.clicks[0]
      assert.equal(click?.type, 'click')
      assert.equal(click?.bubbles, true, 'React listens at the root container: the heal must bubble')
      assert.equal(click?.isTrusted, false, 'the heal is untrusted by definition')
      // The no-op second disposer must not release the live seat.
      second()
      assert.equal(env.listenerCount('pointerup'), 1)
      first()
      assert.equal(env.listenerCount('pointerup'), 0, 'the real disposer removes the seat')
      assert.equal(env.listenerCount('click'), 0)
    } finally {
      second()
      first()
    }
  })
})

test('installDrawerTapHeal: a delivered compatibility click cancels the pending heal in both relations', async () => {
  await withTapDom(async env => {
    const drawer = new TapElement()
    const row = drawerRow(drawer)
    // iOS retargets the delayed click to the common down/up ancestor: the
    // drawer contains the row here.
    drawer.containsNodes.push(row)
    const dispose = installDrawerTapHeal(() => true)
    try {
      // The click lands ON the pointerup target.
      env.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 120, target: row })
      env.pointer('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 41, clientY: 121, target: row })
      env.click(row)
      await delay(AFTER_GRACE_MS)
      assert.equal(row.clicks.length, 0, 'an already-activated row must never be re-healed')

      // The click is retargeted to the shared ANCESTOR (iOS): it already
      // bubbled through the row's delegated activation.
      env.pointer('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 40, clientY: 120, target: row })
      env.pointer('pointerup', { pointerId: 2, pointerType: 'touch', clientX: 41, clientY: 121, target: row })
      env.click(drawer)
      await delay(AFTER_GRACE_MS)
      assert.equal(row.clicks.length, 0, 'an ancestor click clears the pending heal too')
    } finally {
      dispose()
    }
  })
})

test('installDrawerTapHeal: two simultaneous finger taps each heal their own row (per-pointerId pending)', async () => {
  await withTapDom(async env => {
    const drawer = new TapElement()
    const rowA = drawerRow(drawer)
    const rowB = drawerRow(drawer)
    const dispose = installDrawerTapHeal(() => true)
    try {
      // Both gestures complete inside the same grace window: the second tap
      // must not cancel the first one's heal.
      env.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 120, target: rowA })
      env.pointer('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 120, target: rowA })
      env.pointer('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 40, clientY: 200, target: rowB })
      env.pointer('pointerup', { pointerId: 2, pointerType: 'touch', clientX: 41, clientY: 201, target: rowB })
      await delay(AFTER_GRACE_MS)
      assert.equal(rowA.clicks.length, 1, 'the first finger\'s row is healed')
      assert.equal(rowB.clicks.length, 1, 'the second finger\'s row is healed')
    } finally {
      dispose()
    }
  })
})

test('installDrawerTapHeal: a pan, a non-drawer endpoint, a form field, a detached row and a flipped tier never heal', async () => {
  await withTapDom(async env => {
    const drawer = new TapElement()
    const row = drawerRow(drawer)
    const outside = new TapElement({ [DRAWER_SELECTOR]: null, [HEAL_FORM_SELECTOR]: null })
    const field = new TapElement({ [DRAWER_SELECTOR]: drawer })
    field.chain[HEAL_FORM_SELECTOR] = field
    let active = true
    const dispose = installDrawerTapHeal(() => active)
    try {
      // A pan is scroll intent: 60px of travel is far past the slop.
      env.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 120, target: row })
      env.pointer('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 180, target: row })
      // A gesture that started outside the drawer must not heal over the
      // backdrop's own close.
      env.pointer('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 40, clientY: 120, target: outside })
      env.pointer('pointerup', { pointerId: 2, pointerType: 'touch', clientX: 40, clientY: 120, target: row })
      // A form field owns its own activation.
      env.pointer('pointerdown', { pointerId: 3, pointerType: 'touch', clientX: 40, clientY: 120, target: field })
      env.pointer('pointerup', { pointerId: 3, pointerType: 'touch', clientX: 40, clientY: 120, target: field })
      // The tier flipped between the tap and the grace: a stale heal is dropped.
      env.pointer('pointerdown', { pointerId: 4, pointerType: 'touch', clientX: 40, clientY: 120, target: row })
      env.pointer('pointerup', { pointerId: 4, pointerType: 'touch', clientX: 40, clientY: 120, target: row })
      active = false
      await delay(AFTER_GRACE_MS)
      assert.equal(row.clicks.length, 0)
      assert.equal(field.clicks.length, 0)
      assert.equal(outside.clicks.length, 0)

      // A row detached inside the grace window is dropped as well.
      active = true
      env.pointer('pointerdown', { pointerId: 5, pointerType: 'touch', clientX: 40, clientY: 120, target: row })
      env.pointer('pointerup', { pointerId: 5, pointerType: 'touch', clientX: 40, clientY: 120, target: row })
      row.connected = false
      await delay(AFTER_GRACE_MS)
      assert.equal(row.clicks.length, 0, 'a detached target is never dispatched to')
    } finally {
      dispose()
    }
  })
})

test('installDrawerTapHeal: a trusted late click at the healed spot is swallowed once, a far click is not', async () => {
  await withTapDom(async env => {
    const drawer = new TapElement()
    const row = drawerRow(drawer)
    const dispose = installDrawerTapHeal(() => true)
    try {
      env.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 120, target: row })
      env.pointer('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 41, clientY: 121, target: row })
      await delay(AFTER_GRACE_MS)
      assert.equal(row.clicks.length, 1)
      // The delayed real (or ghost) click arrives at the healed coordinates:
      // the heal already ran the activation, so it must not reach React.
      assert.equal(env.click(row, { clientX: 43, clientY: 123 }).stopped, 1)
      // The suppression is single-shot: the NEXT click is delivered (it is a
      // deliberate new activation, not the delivered/ghost one).
      assert.equal(env.click(row, { clientX: 43, clientY: 123 }).stopped, 0)

      // A trusted click far from a fresh heal is somebody else's activation.
      env.pointer('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 40, clientY: 220, target: row })
      env.pointer('pointerup', { pointerId: 2, pointerType: 'touch', clientX: 40, clientY: 220, target: row })
      await delay(AFTER_GRACE_MS)
      assert.equal(row.clicks.length, 2)
      assert.equal(env.click(row, { clientX: 40 + TAP_SLOP_PX + 20, clientY: 220 }).stopped, 0)
    } finally {
      dispose()
    }
  })
})

test('installDrawerTapHeal: dispose removes every listener and drops the pending grace', async () => {
  await withTapDom(async env => {
    const drawer = new TapElement()
    const row = drawerRow(drawer)
    const dispose = installDrawerTapHeal(() => true)
    env.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 120, target: row })
    env.pointer('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 40, clientY: 120, target: row })
    dispose()
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click']) {
      assert.equal(env.listenerCount(type), 0, type + ' listener must die with the disposer')
    }
    await delay(AFTER_GRACE_MS)
    assert.equal(row.clicks.length, 0, 'the cancelled grace never heals')
  })
})
