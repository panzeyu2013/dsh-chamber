/**
 * Composer behavior tests: the pure decision functions (keyboard heuristic,
 * the self-heal clock, IME gesture classification, visibility-guard geometry,
 * caret reveal, viewport-token surgery), the load-bearing source contracts,
 * and the installer behavior of the two document-level effects (self-heal and
 * the IME ladder) — the latter driven by an inline minimal DOM double plus a
 * controlled clock, the same pattern test/dom/session-stall.test.ts uses.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  isKeyboardOpen, BUSY_STUCK_MS, TOUCH_TIER_QUERY, PHONE_TIER_QUERY,
  isNavigationGestureTarget, NAV_QUERY, classifyImeGesture, shouldDropImeRefocus,
  IME_KEYBOARD_INTENT_MS, IME_NAV_DROP_WINDOW_MS, installImeLadder, installComposerSelfHeal,
  installEditabilityRecovery, installEnterToNewline,
  kbdLiftTarget, nextKbdOffset, isAtScrollEnd, caretRevealDelta,
  KBD_ARM_PX, KBD_DISARM_PX, KBD_VERIFY_SLACK_PX, KBD_MAX_VERIFY_STEPS,
  MOBILE_KBD_ATTR, MOBILE_KBD_VAR, MOBILE_KBD_STATE_ATTR, MOBILE_KBD_SPACER_ATTR,
  KBD_EDITABLE_FOCUS_GRACE_MS, KBD_OFFSET_QUANTUM_PX,
  isEditableComposer, isEditabilityFlipToEditable, lockClock, shouldRecoverStuckComposer,
  isComposerSubmitBusy, BUSY_COMPOSER_PHASES, isOfficiallyDisabled,
  EDITABILITY_MUTATION_OPTIONS, SELF_HEAL_MUTATION_OPTIONS,
} from '../../src/client/composer.ts'

import { ClosestStub } from '../support/closest-stub.ts'

test('keyboard heuristic: >120px AND >20% of layout height', () => {
  // 812 layout, 812 visual → closed
  assert.equal(isKeyboardOpen(812, 812), false)
  // 812 → 700 (112px gap): below the 120px threshold → closed
  assert.equal(isKeyboardOpen(812, 700), false)
  // 812 → 680 (132px gap, 16.3%): over 120px but under 20% → closed
  assert.equal(isKeyboardOpen(812, 680), false)
  // 812 → 640 (172px gap, 21.2%): over both thresholds → open
  assert.equal(isKeyboardOpen(812, 640), true)
  // Small screens: 667 → 500 (167px, 25%) → open
  assert.equal(isKeyboardOpen(667, 500), true)
})

test('composer stuck threshold is pinned at 30 s (recovery fires only on a genuine stuck state)', () => {
  // 常量钉:值本身是防意外改值的回归钉;「30s 后 blur→恢复→refocus」的时序
  // 行为属 device-gated installer（仓库惯例），不在单测范围。
  assert.equal(BUSY_STUCK_MS, 30_000)
})

test('touch tier query is the single source (shared with layout source and CSS)', () => {
  assert.equal(TOUCH_TIER_QUERY, '(max-width: 1023px) and (pointer: coarse)')
})

test('layer-1 navigation-gesture selector covers drawer and session header', () => {
  assert.ok(NAV_QUERY.includes('[data-mobile-role="sidebar"]'))
  assert.ok(NAV_QUERY.includes('[data-slot="conversation.session.header"]'))
})

test('isNavigationGestureTarget: drawer/header gestures are navigation', () => {
  // The predicate asks closest() with the COMBINED nav selector — a drawer
  // row or a header crumb matches it (single closest call).
  const drawerRow = new ClosestStub({ [NAV_QUERY]: true })
  assert.equal(isNavigationGestureTarget(drawerRow), true)
  const crumb = new ClosestStub({ [NAV_QUERY]: true })
  assert.equal(isNavigationGestureTarget(crumb), true)
  const noMatch = new ClosestStub({})
  assert.equal(isNavigationGestureTarget(noMatch), false)
})

test('isNavigationGestureTarget: non-navigation gestures are typing intent', () => {
  // Composer seat, portaled picker menus, message area — none navigates. The
  // bare-{} (non-nav) shape is already pinned in the test above; only the null
  // target adds a distinct input here.
  assert.equal(isNavigationGestureTarget(null), false)
})

test('kbdLiftTarget: hysteresis (arm >96px, hold >72px) over the measured overlap', () => {
  // Nothing covered → never lift. The overlap is measured off the scrollport
  // box (layout coordinates), not inferred from innerHeight.
  assert.equal(kbdLiftTarget(0, false), 0)
  assert.equal(kbdLiftTarget(-336, false), 0)
  // Below the arm threshold the guard stays idle: browser chrome / a bottom
  // bar / a 60px overlap must not micro-lift the seat (measured: idle at 60).
  assert.equal(kbdLiftTarget(60, false), 0)
  assert.equal(kbdLiftTarget(KBD_ARM_PX, false), 0)
  // Keyboard-scale overlap arms, quantized so the seat never lands under the
  // keyboard top (336 + 8 headroom → ceil(344/16) = 22 steps → 352).
  assert.equal(kbdLiftTarget(336, false), 352)
  assert.equal(kbdLiftTarget(KBD_ARM_PX + 1, false), 112)
  // HYSTERESIS: while armed the lift is HELD through the band between the two
  // thresholds — a sliding keyboard cannot flap the seat.
  assert.equal(kbdLiftTarget(80, true), 96)
  assert.equal(kbdLiftTarget(KBD_DISARM_PX + 1, true), 96)
  // ...and releases only once the overlap is effectively gone.
  assert.equal(kbdLiftTarget(KBD_DISARM_PX, true), 0)
  assert.equal(kbdLiftTarget(0, true), 0)
  assert.ok(KBD_ARM_PX > KBD_DISARM_PX, 'hysteresis band must be positive')
})

test('nextKbdOffset: ceil quantization with headroom, zero when uncovered', () => {
  // Nothing covered → never arm.
  assert.equal(nextKbdOffset(0), 0)
  // 300 covered + 8 headroom → ceil(308/16)=20 → 320 (never under the top).
  assert.equal(nextKbdOffset(300), 320)
  // Small covered heights still get the minimal non-zero lift.
  assert.equal(nextKbdOffset(5), 16)
  // Explicit quantum/headroom for readability.
  assert.equal(nextKbdOffset(100, 16, 8), 112)
  assert.equal(nextKbdOffset(47, 16, 8), 64)
  assert.equal(nextKbdOffset(-1), 0)
  // The default step stays small enough that the dead band above the keyboard
  // cannot grow past ~23px (cross-check: 48px left 8-55px).
  assert.ok(KBD_OFFSET_QUANTUM_PX <= 16)
})

test('isAtScrollEnd: pinned-to-end detection with slack', () => {
  // Empty / non-scrollable containers are trivially at the end.
  assert.equal(isAtScrollEnd(0, 100, 200), true)
  assert.equal(isAtScrollEnd(0, 0, 0), true)
  // Mid-history is not at the end.
  assert.equal(isAtScrollEnd(500, 5000, 1000), false)
  // Exactly at the end (max = scrollHeight - clientHeight).
  assert.equal(isAtScrollEnd(4000, 5000, 1000), true)
  // Within the slack of the end.
  assert.equal(isAtScrollEnd(3995, 5000, 1000), true)
  // Beyond the end (post-clamp transient) is still end-pinned.
  assert.equal(isAtScrollEnd(4100, 5000, 1000), true)
})

test('caretRevealDelta: signed scroll delta to bring the caret into the host viewport', () => {
  // Caret fully visible → no scroll.
  assert.equal(caretRevealDelta(100, 120, 0, 200), 0)
  // Caret below the fold → scroll down by overflow + margin.
  assert.equal(caretRevealDelta(190, 210, 0, 200), 18)
  // Caret above the viewport → scroll up by overflow + margin.
  assert.equal(caretRevealDelta(-20, 0, 0, 200), -28)
  // Bottom edge flush with the fold but inside → no scroll.
  assert.equal(caretRevealDelta(180, 200, 0, 200), 0)
  // Custom margin.
  assert.equal(caretRevealDelta(190, 210, 0, 200, 2), 12)
})

test('the guard\'s contract constants: bounded verification, no unbounded ramp', () => {
  // The post-write acceptance tolerance must stay well inside the smallest
  // quantized lift, and the correction count must stay bounded: an engine
  // that ignores the sticky inset is REPORTED (data-mobile-kbd-state =
  // still-covered), never chased with a growing offset.
  assert.ok(KBD_VERIFY_SLACK_PX > 0 && KBD_VERIFY_SLACK_PX < KBD_OFFSET_QUANTUM_PX * 2)
  assert.ok(KBD_MAX_VERIFY_STEPS >= 1 && KBD_MAX_VERIFY_STEPS <= 2)
  // The carrier names are the plugin\'s own (never an official attribute).
  for (const name of [MOBILE_KBD_ATTR, MOBILE_KBD_STATE_ATTR, MOBILE_KBD_SPACER_ATTR]) {
    assert.match(name, /^data-mobile-/)
  }
  assert.ok(MOBILE_KBD_VAR.startsWith('--'))
})

test('phone tier query is shared with the stylesheet and distinct from the touch tier', () => {
  assert.equal(PHONE_TIER_QUERY, '(max-width: 768px) and (pointer: coarse)')
  assert.notEqual(PHONE_TIER_QUERY, TOUCH_TIER_QUERY)
  // The grace window must outlast a keyboard-close animation (~250ms) and
  // stay short enough not to hold a stale offset after the user leaves.
  assert.ok(KBD_EDITABLE_FOCUS_GRACE_MS >= 500 && KBD_EDITABLE_FOCUS_GRACE_MS <= 2_000)
})

test('isEditableComposer: only the real editor is intercepted (no-workspace picker stays live)', () => {
  // The no-workspace state binds editor=null, so the
  // resident div renders contenteditable="false" while still carrying
  // [data-composer-input], tabIndex=0 and the official onKeyDown that opens
  // the workspace picker. Intercepting Enter there swallowed that activation.
  assert.equal(isEditableComposer({ contentEditable: 'true' }), true)
  assert.equal(isEditableComposer({ contentEditable: 'false' }), false)
  assert.equal(isEditableComposer({ contentEditable: 'inherit' }), false)
  assert.equal(isEditableComposer({}), false)
  assert.equal(isEditableComposer(null), false)
  assert.equal(isEditableComposer(undefined), false)
})

test('isEditabilityFlipToEditable: fires on a real false→true flip, never on a seed', () => {
  // The genuine flip: old value observed on the attribute, editor focused.
  assert.equal(isEditabilityFlipToEditable(true, true, true, ['false']), true)
  // Not focused → the IME is not the composer's business.
  assert.equal(isEditabilityFlipToEditable(true, false, true, ['false']), false)
  assert.equal(isEditabilityFlipToEditable(true, true, true, []), false)
  // A composer that mounts editable must not be "recovered" by its own seed.
  assert.equal(isEditabilityFlipToEditable(true, true, null, [null]), false)
  // Locking (true→false) never triggers the recovery.
  assert.equal(isEditabilityFlipToEditable(false, true, true, ['true']), false)
  // The tracked-state fallback covers engines that report no oldValue.
  assert.equal(isEditabilityFlipToEditable(true, true, false, []), true)
})

test('lockClock: only a non-editable composer INSIDE an unblocked submit window is timed', () => {
  // Editable → no clock, whatever else is true.
  assert.equal(lockClock(true, false, false, 1_000, 5_000), 0)
  assert.equal(lockClock(true, true, false, 1_000, 5_000), 0)
  // A legitimately locked composer (no submit in flight: blocked / parent
  // offline / no-session picker node) is NOT a stuck submit — no clock, so
  // the recovery can never fight the official block.
  assert.equal(lockClock(false, false, false, 5_000, 9_000), 0)
  // OFFICIALLY DISABLED during a submission window (an owner block or an
  // offline parent arriving mid-flight) is still a legitimate lock: the phase
  // alone cannot see it, `aria-disabled` can.
  assert.equal(lockClock(false, true, true, 5_000, 9_000), 0)
  // The state the recovery exists for: non-editable + submitting + unlocked.
  assert.equal(lockClock(false, true, false, 0, 5_000), 5_000)
  // ...timed from the FIRST sighting, so BUSY_STUCK_MS is actually reachable.
  assert.equal(lockClock(false, true, false, 5_000, 9_000), 5_000)
})

test('shouldRecoverStuckComposer: the 30s boundary is exclusive below, inclusive at', () => {
  const base = { editable: false, busy: true, disabled: false }
  assert.equal(shouldRecoverStuckComposer({ ...base, elapsedMs: BUSY_STUCK_MS - 1 }), false)
  assert.equal(shouldRecoverStuckComposer({ ...base, elapsedMs: BUSY_STUCK_MS }), true)
  assert.equal(shouldRecoverStuckComposer({ ...base, elapsedMs: BUSY_STUCK_MS + 1 }), true)
  // Every negative: editable, not busy, officially disabled.
  assert.equal(shouldRecoverStuckComposer({ ...base, editable: true, elapsedMs: 60_000 }), false)
  assert.equal(shouldRecoverStuckComposer({ ...base, busy: false, elapsedMs: 60_000 }), false)
  assert.equal(shouldRecoverStuckComposer({ ...base, disabled: true, elapsedMs: 60_000 }), false)
})

test('isComposerSubmitBusy: only the official in-flight phases count', () => {
  // The input machine publishes 'adjudicating' | 'submitting' while a
  // submission transaction is open; 'plain' / 'inert' / 'claimed' are steady.
  assert.equal(isComposerSubmitBusy('adjudicating'), true)
  assert.equal(isComposerSubmitBusy('submitting'), true)
  assert.equal(isComposerSubmitBusy('plain'), false)
  assert.equal(isComposerSubmitBusy('claimed'), false)
  assert.equal(isComposerSubmitBusy('inert'), false)
  assert.equal(isComposerSubmitBusy(undefined), false)
  assert.equal(isComposerSubmitBusy(null), false)
  assert.equal(isComposerSubmitBusy(''), false)
  assert.deepEqual([...BUSY_COMPOSER_PHASES], ['adjudicating', 'submitting'])
})

test('isOfficiallyDisabled reads the official lock marker, not a guess', () => {
  const face = (value: string | null): { getAttribute(name: string): string | null } => ({
    getAttribute: name => (name === 'aria-disabled' ? value : null),
  })
  assert.equal(isOfficiallyDisabled(face('true')), true)
  assert.equal(isOfficiallyDisabled(face(null)), false)
  // Anything else is not the marker (React omits it when disabled is false).
  assert.equal(isOfficiallyDisabled(face('false')), false)
})

test('the observer channels keep their load-bearing options', () => {
  // attributeOldValue is what makes the false->true flip visible for a
  // composer the observer never saw mount; without it layer 2 is silently
  // dead. The self-heal needs all three attributes: a stuck submit is
  // editability + phase + the official disabled marker together.
  assert.equal(EDITABILITY_MUTATION_OPTIONS.attributeOldValue, true)
  assert.equal(EDITABILITY_MUTATION_OPTIONS.attributes, true)
  assert.equal(EDITABILITY_MUTATION_OPTIONS.subtree, true)
  assert.deepEqual(EDITABILITY_MUTATION_OPTIONS.attributeFilter ?? [], ['contenteditable'])
  assert.deepEqual(
    SELF_HEAL_MUTATION_OPTIONS.attributeFilter ?? [],
    ['contenteditable', 'data-phase', 'aria-disabled'],
  )
  assert.equal(SELF_HEAL_MUTATION_OPTIONS.attributes, true)
  assert.equal(SELF_HEAL_MUTATION_OPTIONS.subtree, true)
})
test('editability recovery only trusts the composer\'s OWN attribute flip (source lock)', () => {
  // The observer watches the whole document subtree, so a nested Lexical
  // decorator flipping its own contenteditable would otherwise satisfy
  // isEditabilityFlipToEditable and blur+refocus the composer MID-TYPING. The
  // predicate itself stays pure; the caller must narrow the
  // batch to records whose target IS the composer input.
  const source = readFileSync(fileURLToPath(new URL('../../src/client/composer.ts', import.meta.url)), 'utf8')
  assert.match(
    source,
    /records\.filter\(record => record\.target === input\)\.map\(record => record\.oldValue\)/,
    'the editability observer must ignore foreign contenteditable flips',
  )
})
test('the guard keeps its full trigger set wired (source lock)', () => {
  // The visualViewport/window listeners, the visibilitychange handler and the
  // [data-phase] observer each need pinned coverage: deleting any one of them
  // would leave every package test green, while design 17 §18.4.4 makes
  // "触发面完整" an invariant. Pin the registrations (and the attribute filter)
  // so a dropped trigger is a red test, not a silent field regression.
  const source = readFileSync(fileURLToPath(new URL('../../src/client/composer.ts', import.meta.url)), 'utf8')
  for (const needle of [
    "window.visualViewport?.addEventListener('resize', onViewportChange)",
    "window.visualViewport?.addEventListener('scroll', onViewportChange)",
    "window.addEventListener('resize', onViewportChange)",
    "document.addEventListener('visibilitychange', onVisibility)",
    "document.addEventListener('focusin', onFocusIn, true)",
    "document.addEventListener('focusout', onFocusOut, true)",
    "document.addEventListener('pointerdown', onPointerDown, true)",
    "attributeFilter: ['data-phase']",
  ]) assert.ok(source.includes(needle), `trigger registration must stay wired: ${needle}`)
})

test('the guard keeps ONE actuator, never pads the scrollport (source lock)', () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/client/composer.ts', import.meta.url)), 'utf8')
  // Measured double-lift defect: the conversation scrollport is ALSO the
  // seat's sticky containing block, so padding it raises the sticky threshold
  // and the same offset lands twice (seat 368px above the keyboard top on a
  // 390x844 rig). The guard must never write a padding style.
  assert.equal(/paddingBottom/.test(source), false, 'the guard must not pad the scrollport')
  // The single actuator is the frame custom property the stylesheet reads.
  assert.match(source, /style\.setProperty\(MOBILE_KBD_VAR/)
  // The scroll range comes from an in-flow spacer kept immediately before the
  // seat, including after a renderer remount reorders the seat list.
  assert.match(source, /spacer\.nextElementSibling !== seat/)
  // Bounded verification: the correction loop is capped AND refuses to run on
  // a carrier that moved with our own write, so an engine
  // that ignores the sticky inset — or feeds the lift back into the measured
  // edge — is reported instead of chased.
  assert.match(source, /while \(!carrierPushed && steps < KBD_MAX_VERIFY_STEPS\)/)
  assert.match(source, /if \(node !== null && before !== null && increment > 0/)
  // Diagnosis surface: every outcome is readable off the frame.
  for (const state of ['armed', 'idle', 'no-seat', 'no-frame', 'still-covered']) {
    assert.ok(source.includes(`'${state}'`), `missing guard state ${state}`)
  }
})

// ---------------------------------------------------------------------------
// IME ladder classification: the gesture is PERSISTENT, keyboard intent keeps
// its own short window.
// ---------------------------------------------------------------------------

test('classifyImeGesture: nav regions are nav, seat/portal/message are preserve', () => {
  assert.equal(classifyImeGesture(new ClosestStub({ [NAV_QUERY]: true })), 'nav')
  // The seat, a portaled picker menu and the message area match NO nav
  // selector: closest(NAV_QUERY) is null and the gesture is typing intent.
  assert.equal(classifyImeGesture(new ClosestStub({})), 'preserve')
  assert.equal(classifyImeGesture(null), 'preserve')
})

test('shouldDropImeRefocus decision table: nav drops inside its executable window, keyboard/seat preserve', () => {
  // Value pins (same discipline as BUSY_STUCK_MS): the table below is written
  // in terms of the constants, so without these a window change stays green.
  assert.equal(IME_NAV_DROP_WINDOW_MS, 45_000)
  assert.equal(IME_KEYBOARD_INTENT_MS, 500)
  const now = 1_000_000
  const table: Array<{ gesture: 'nav' | 'preserve'; gestureAt: number; keyboardAt: number; drop: boolean; note: string }> = [
    { gesture: 'nav', gestureAt: now - 1_000, keyboardAt: 0, drop: true, note: 'a one-second-old nav gesture drops (the official submit refocus)' },
    { gesture: 'nav', gestureAt: now - IME_NAV_DROP_WINDOW_MS + 100, keyboardAt: 0, drop: true, note: '44.9s: still inside the executable window' },
    { gesture: 'nav', gestureAt: now - IME_NAV_DROP_WINDOW_MS, keyboardAt: 0, drop: true, note: 'the window edge is inclusive' },
    { gesture: 'nav', gestureAt: now - IME_NAV_DROP_WINDOW_MS - 100, keyboardAt: 0, drop: false, note: '45.1s: the navigation intent has lapsed' },
    { gesture: 'nav', gestureAt: now - 600_000, keyboardAt: 0, drop: false, note: 'ten minutes later a late refocus is NOT ours to drop' },
    { gesture: 'preserve', gestureAt: now - 1, keyboardAt: 0, drop: false, note: 'seat/portal typing intent always preserves' },
    { gesture: 'nav', gestureAt: now - 1_000, keyboardAt: now - 1, drop: false, note: 'a fresh Tab/Arrow intent preserves' },
    { gesture: 'nav', gestureAt: now - 1_000, keyboardAt: now - IME_KEYBOARD_INTENT_MS + 1, drop: false, note: 'the intent window is exclusive at its edge' },
    { gesture: 'nav', gestureAt: now - 1_000, keyboardAt: now - IME_KEYBOARD_INTENT_MS, drop: true, note: 'an expired intent lets the nav drop through again' },
    { gesture: 'preserve', gestureAt: now - 1, keyboardAt: now - 1, drop: false, note: 'keyboard intent never turns a preserve into a drop' },
    { gesture: 'nav', gestureAt: now + 10_000, keyboardAt: 0, drop: false, note: 'a backwards clock step fails safe' },
  ]
  for (const row of table) {
    assert.equal(shouldDropImeRefocus(row.gesture, row.gestureAt, row.keyboardAt, now), row.drop, row.note)
  }
})

// ---------------------------------------------------------------------------
// Installer behavior: an inline minimal DOM double (this package runs no DOM
// environment) plus a controlled clock. Patches the globals the installers
// read and restores them; every test runs inside one synchronous block.
// ---------------------------------------------------------------------------

const FAKE_BASE_TIME = 1_000_000

class FakeNodeBase {}

/** The composer node the installers query. */
class FakeComposer extends FakeNodeBase {
  contentEditable = 'true'
  readonly dataset: { phase?: string } = {}
  /** The composer fingerprint reads these (text + child count). */
  readonly childNodes: unknown[] = []
  textContent = ''
  private readonly attributes = new Map<string, string>()
  blurs = 0
  focuses = 0
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  setAttribute(name: string, value = ''): void { this.attributes.set(name, value) }
  contains(node: unknown): boolean { return node === this }
  /** The composer input matches its own selector (the Enter installer resolves
   *  the editor through closest); every other anchor is absent in this double. */
  closest(selector: string): FakeComposer | null {
    return selector === '[data-composer-input]' ? this : null
  }
  blur(): void { this.blurs += 1 }
  focus(): void { this.focuses += 1 }
}

/** A pointer target whose closest() answers the nav selector. */
class FakeGestureTarget extends FakeNodeBase {
  private readonly nav: boolean
  constructor(nav: boolean) { super(); this.nav = nav }
  closest(selector: string): FakeGestureTarget | null {
    return selector === NAV_QUERY && this.nav ? this : null
  }
}

class FakeDocumentDouble {
  activeElement: unknown = null
  /** Every execCommand the Enter installer issues, in order. */
  readonly execCommands: string[] = []
  /** Per-command answer; a command not listed answers true ("supported"), a
   *  false answer drives the insertText / manual ladder. */
  execAnswers: Record<string, boolean> = {}
  /** Test hook: observe (or mutate the DOM as) a command's insertion. */
  onExec: ((command: string) => void) | null = null
  execCommand(command: string): boolean {
    this.execCommands.push(command)
    this.onExec?.(command)
    return this.execAnswers[command] ?? true
  }
  /** No trigger menu is open in these doubles. */
  querySelector(): null { return null }
  /** No live selection: the manual insert path stays unreachable. */
  getSelection(): null { return null }
  private readonly listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>()
  addEventListener(type: string, handler: (event: Record<string, unknown>) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }
  removeEventListener(type: string, handler: (event: Record<string, unknown>) => void): void {
    const list = this.listeners.get(type)
    if (list === undefined) return
    const index = list.indexOf(handler)
    if (index !== -1) list.splice(index, 1)
  }
  /** Dispatch to every registered handler; capture/bubble is ignored because
   *  the installers register capture-phase listeners only. The default
   *  methods exist so a handler that consumes the event (Enter) runs. */
  dispatch(type: string, init: Record<string, unknown> = {}): void {
    const event = {
      type,
      preventDefault: (): void => {},
      stopPropagation: (): void => {},
      ...init,
    }
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event)
  }
}

/** Minimal MutationObserver double for the editability channel: it records
 *  every observation and delivers an attribute record to the live observers
 *  whose observation covers the target and watches that attribute (the DOM
 *  delivery rule). */
class FakeMutationObserverDouble {
  static readonly instances: FakeMutationObserverDouble[] = []
  readonly observations: Array<{ target: unknown; options?: Record<string, unknown> }> = []
  disconnected = false
  private readonly callback: (records: Array<Record<string, unknown>>) => void
  constructor(callback: (records: Array<Record<string, unknown>>) => void) {
    this.callback = callback
    FakeMutationObserverDouble.instances.push(this)
  }
  observe(target: unknown, options?: Record<string, unknown>): void {
    this.disconnected = false
    this.observations.push({ target, options })
  }
  disconnect(): void { this.disconnected = true }
  takeRecords(): Array<Record<string, unknown>> { return [] }
  /** Deliver one attribute record to every covering live observer. */
  static fireAttribute(target: unknown, attribute: string, oldValue: string | null = null): void {
    for (const observer of FakeMutationObserverDouble.instances) {
      if (observer.disconnected) continue
      const covered = observer.observations.some(observation => {
        if (observation.target === target) return true
        const face = observation.target as { contains?: (node: unknown) => boolean } | null
        return typeof face?.contains === 'function' && face.contains(target)
      })
      if (!covered) continue
      const watched = observer.observations.some(observation => {
        const filter = observation.options?.attributeFilter
        return Array.isArray(filter) ? filter.includes(attribute) : observation.options?.attributes === true
      })
      if (watched) observer.callback([{ target, attributeName: attribute, oldValue }])
    }
  }
}

interface ComposerDomEnv {
  readonly document: FakeDocumentDouble
  root(composer: FakeComposer): ParentNode
  at(millis: number): void
  frames(): number
  flushFrame(): void
  /** Deliver one attribute mutation to every covering live observer. */
  fireAttribute(target: unknown, attribute: string, oldValue?: string | null): void
}

function withComposerDom(run: (env: ComposerDomEnv) => void): void {
  const globals = globalThis as unknown as Record<string, unknown>
  const previous = {
    document: globals.document,
    window: globals.window,
    HTMLElement: globals.HTMLElement,
    Element: globals.Element,
    Node: globals.Node,
    MutationObserver: globals.MutationObserver,
    requestAnimationFrame: globals.requestAnimationFrame,
    cancelAnimationFrame: globals.cancelAnimationFrame,
    now: Date.now,
  }
  const documentDouble = new FakeDocumentDouble()
  const frames: Array<(() => void) | null> = []
  let now = FAKE_BASE_TIME
  globals.document = documentDouble
  globals.window = { innerHeight: 800, visualViewport: null }
  globals.HTMLElement = FakeNodeBase
  globals.Element = FakeNodeBase
  globals.Node = FakeNodeBase
  FakeMutationObserverDouble.instances.length = 0
  globals.MutationObserver = FakeMutationObserverDouble
  globals.requestAnimationFrame = (handler: () => void): number => { frames.push(handler); return frames.length }
  globals.cancelAnimationFrame = (id: number): void => { frames[id - 1] = null }
  Date.now = (): number => now
  try {
    run({
      document: documentDouble,
      root: (composer: FakeComposer): ParentNode => ({
        querySelector: (selector: string) => (selector === '[data-composer-input]' ? composer : null),
        contains: (node: unknown): boolean => node === composer,
      }) as unknown as ParentNode,
      at: (millis: number): void => { now = FAKE_BASE_TIME + millis },
      frames: (): number => frames.length,
      flushFrame: (): void => { const frame = frames.shift(); frame?.() },
      fireAttribute: (target: unknown, attribute: string, oldValue: string | null = null): void => {
        FakeMutationObserverDouble.fireAttribute(target, attribute, oldValue)
      },
    })
  } finally {
    globals.document = previous.document
    globals.window = previous.window
    globals.HTMLElement = previous.HTMLElement
    globals.Element = previous.Element
    globals.Node = previous.Node
    globals.MutationObserver = previous.MutationObserver
    globals.requestAnimationFrame = previous.requestAnimationFrame
    globals.cancelAnimationFrame = previous.cancelAnimationFrame
    Date.now = previous.now
  }
}

function tapComposer(env: ComposerDomEnv, composer: FakeComposer): void {
  env.document.dispatch('pointerdown', { pointerType: 'touch', target: composer })
}

function stuckComposer(): FakeComposer {
  const composer = new FakeComposer()
  composer.contentEditable = 'false'
  composer.dataset.phase = 'submitting'
  return composer
}

test('self-heal: an early tap never restarts the 30s clock (tap@0 + tap@40s recovers)', () => {
  withComposerDom(env => {
    // Mounted stuck at install: the install-time DOM seed owns the clock.
    const composer = stuckComposer()
    const dispose = installComposerSelfHeal(env.root(composer))
    tapComposer(env, composer)
    assert.equal(composer.blurs, 0, 'elapsed 0 is not a stuck submit')
    assert.equal(composer.focuses, 0)
    env.at(40_000)
    tapComposer(env, composer)
    assert.equal(composer.blurs, 1, 'the clock survived the early tap')
    assert.equal(composer.contentEditable, 'true', 'the recovery restores editability')
    assert.equal(composer.focuses, 1, 'and refocuses the editor')
    dispose()
  })
})

test('self-heal: the first tap that finds it stuck starts the clock; a later tap >=30s recovers', () => {
  withComposerDom(env => {
    const composer = new FakeComposer() // editable at install: no clock yet
    const dispose = installComposerSelfHeal(env.root(composer))
    env.at(10_000)
    composer.contentEditable = 'false'
    composer.dataset.phase = 'submitting' // stuck appears with no observer record
    tapComposer(env, composer)
    assert.equal(composer.blurs, 0, 'the tap that finds it stuck only starts the clock')
    env.at(45_000)
    tapComposer(env, composer)
    assert.equal(composer.blurs, 1, '35s after the first sighting')
    dispose()
  })
})

test('self-heal: a tap before 30s does not recover — and does not restart the window', () => {
  withComposerDom(env => {
    const composer = new FakeComposer()
    const dispose = installComposerSelfHeal(env.root(composer))
    env.at(10_000)
    composer.contentEditable = 'false'
    composer.dataset.phase = 'submitting'
    tapComposer(env, composer) // starts the clock at 10s
    env.at(39_000)
    tapComposer(env, composer)
    assert.equal(composer.blurs, 0, '29s after the first sighting is still inside the window')
    env.at(40_000)
    tapComposer(env, composer)
    assert.equal(composer.blurs, 1, 'exactly 30s after the FIRST sighting: the early tap reset nothing')
    dispose()
  })
})

test('self-heal negatives: editable / not-busy / aria-disabled never recover', () => {
  for (const sample of [
    { name: 'editable', editable: true, phase: 'submitting', disabled: false },
    { name: 'not in a submit window', editable: false, phase: 'plain', disabled: false },
    { name: 'officially disabled', editable: false, phase: 'submitting', disabled: true },
  ]) {
    withComposerDom(env => {
      const composer = new FakeComposer()
      composer.contentEditable = sample.editable ? 'true' : 'false'
      composer.dataset.phase = sample.phase
      if (sample.disabled) composer.setAttribute('aria-disabled', 'true')
      const dispose = installComposerSelfHeal(env.root(composer))
      env.at(40_000)
      tapComposer(env, composer)
      assert.equal(composer.blurs, 0, sample.name + ': no recovery')
      assert.equal(composer.focuses, 0, sample.name + ': no refocus')
      assert.equal(composer.contentEditable, sample.editable ? 'true' : 'false', sample.name + ': the DOM is untouched')
      dispose()
    })
  }
})

test('self-heal: its own recovery write is not answered by a second blur/refocus (ONE focus dance)', () => {
  withComposerDom(env => {
    const composer = stuckComposer()
    const disposeSelfHeal = installComposerSelfHeal(env.root(composer))
    // Layer 2 observes the same composer: without the write marker it would
    // read the recovery's own false→true flip as a genuine one and blur+refocus
    // a SECOND time (the double focus dance).
    const disposeRecovery = installEditabilityRecovery(env.root(composer))
    try {
      tapComposer(env, composer) // the install-time DOM seed owns the clock
      env.at(BUSY_STUCK_MS)
      env.document.activeElement = composer
      tapComposer(env, composer)
      assert.equal(composer.blurs, 1, 'the self-heal recovery blurs once')
      assert.equal(composer.focuses, 1)
      assert.equal(composer.contentEditable, 'true', 'the recovery restored editability')
      // The contenteditable write reaches the recovery channel as a genuine
      // false→true flip on the focused composer.
      env.fireAttribute(composer, 'contenteditable', 'false')
      assert.equal(composer.blurs, 1, 'the recovery channel must not answer the self-heal write')
      assert.equal(composer.focuses, 1)
      // One-shot: a LATER genuine flip on the same element is recovered again.
      env.at(BUSY_STUCK_MS + 5_000)
      composer.contentEditable = 'false'
      composer.contentEditable = 'true'
      env.fireAttribute(composer, 'contenteditable', 'false')
      assert.equal(composer.blurs, 2, 'a later genuine flip recovers normally')
      assert.equal(composer.focuses, 2)
    } finally {
      disposeRecovery()
      disposeSelfHeal()
    }
  })
})

test('self-heal: the write marker expires (a delayed flip outside the window is recovered)', () => {
  withComposerDom(env => {
    const composer = stuckComposer()
    const disposeSelfHeal = installComposerSelfHeal(env.root(composer))
    const disposeRecovery = installEditabilityRecovery(env.root(composer))
    try {
      tapComposer(env, composer)
      env.at(BUSY_STUCK_MS)
      env.document.activeElement = composer
      tapComposer(env, composer)
      assert.equal(composer.blurs, 1)
      // The observer callback is delayed beyond the marker window (>1s): the
      // flip is then treated as any other flip, never silently swallowed.
      env.at(BUSY_STUCK_MS + 2_000)
      env.fireAttribute(composer, 'contenteditable', 'false')
      assert.equal(composer.blurs, 2, 'an expired marker does not suppress a genuine flip')
    } finally {
      disposeRecovery()
      disposeSelfHeal()
    }
  })
})

test('ime ladder: a nav gesture drops the programmatic focus inside its executable window', () => {
  withComposerDom(env => {
    const composer = new FakeComposer()
    const detach = installImeLadder(env.root(composer)).attach()
    env.document.activeElement = composer
    env.document.dispatch('pointerdown', { pointerType: 'touch', target: new FakeGestureTarget(true) })
    env.at(1_000) // the official submit/commit refocus lands right after the switch
    env.document.dispatch('focusin', { target: composer })
    assert.equal(composer.blurs, 1, 'a fresh nav classification still drops')
    assert.equal(env.frames(), 1, 'the drop loop is in flight')
    detach()
  })
})

test('ime ladder: a STALE nav gesture (ten minutes) preserves the late refocus', () => {
  withComposerDom(env => {
    const composer = new FakeComposer()
    const detach = installImeLadder(env.root(composer)).attach()
    env.document.activeElement = composer
    env.document.dispatch('pointerdown', { pointerType: 'touch', target: new FakeGestureTarget(true) })
    env.at(600_000) // ten minutes later: the navigation intent has expired
    env.document.dispatch('focusin', { target: composer })
    assert.equal(composer.blurs, 0, 'the drop window expired — the late refocus is preserved')
    assert.equal(env.frames(), 0)
    detach()
  })
})

test('ime ladder: a seat/portal gesture preserves the programmatic focus', () => {
  withComposerDom(env => {
    const composer = new FakeComposer()
    const detach = installImeLadder(env.root(composer)).attach()
    env.document.activeElement = composer
    env.document.dispatch('pointerdown', { pointerType: 'touch', target: new FakeGestureTarget(false) })
    env.at(86_400_000)
    env.document.dispatch('focusin', { target: composer })
    assert.equal(composer.blurs, 0, 'typing intent is never dropped, however old')
    assert.equal(env.frames(), 0)
    detach()
  })
})

test('ime ladder: a fresh Tab/Arrow keydown preserves the focus after a nav gesture', () => {
  withComposerDom(env => {
    const composer = new FakeComposer()
    const detach = installImeLadder(env.root(composer)).attach()
    env.document.activeElement = composer
    env.document.dispatch('pointerdown', { pointerType: 'touch', target: new FakeGestureTarget(true) })
    env.at(1_000)
    env.document.dispatch('keydown', { key: 'Tab' })
    env.document.dispatch('focusin', { target: composer })
    assert.equal(composer.blurs, 0, 'keyboard navigation is preserved inside its window')
    env.at(1_000 + IME_KEYBOARD_INTENT_MS)
    env.document.dispatch('focusin', { target: composer })
    assert.equal(composer.blurs, 1, 'once the keyboard-intent window expires the nav gesture drops again')
    // Arrow keys carry the same intent as Tab.
    env.at(1_000 + IME_KEYBOARD_INTENT_MS + 100)
    env.document.dispatch('keydown', { key: 'ArrowDown' })
    composer.blurs = 0
    env.document.dispatch('focusin', { target: composer })
    assert.equal(composer.blurs, 0, 'a fresh Arrow keydown preserves')
    detach()
  })
})

test('ime ladder: a typing (seat) pointerdown cancels an in-flight drop loop', () => {
  withComposerDom(env => {
    const composer = new FakeComposer()
    const detach = installImeLadder(env.root(composer)).attach()
    env.document.activeElement = composer
    env.document.dispatch('pointerdown', { pointerType: 'touch', target: new FakeGestureTarget(true) })
    env.document.dispatch('focusin', { target: composer })
    assert.equal(composer.blurs, 1)
    // The seat target: not nav (preserve) AND inside the composer seat zone
    // (closest returns null, the input itself is the zone).
    env.document.dispatch('pointerdown', { pointerType: 'touch', target: composer })
    env.flushFrame()
    assert.equal(composer.blurs, 1, 'the cancel stops the loop without another blur')
    detach()
  })
})

// ---------------------------------------------------------------------------
// Double-install guard: the document-level installers hold ONE seat per key.
// ---------------------------------------------------------------------------

test('installEnterToNewline is single-seat: a double install inserts ONE newline', () => {
  withComposerDom(env => {
    const composer = new FakeComposer()
    const first = installEnterToNewline()
    const second = installEnterToNewline()
    const enter = (): void => {
      env.document.dispatch('keydown', {
        key: 'Enter', target: composer, isComposing: false, keyCode: 13,
        shiftKey: false, ctrlKey: false, metaKey: false, repeat: false,
      })
    }
    enter()
    assert.deepEqual(env.document.execCommands, ['insertLineBreak'],
      'exactly ONE handler may intercept the Enter (two handlers = two newlines)')
    // The duplicate's disposer is a no-op: the live install must survive it,
    // and still exactly ONE handler runs per Enter.
    second()
    enter()
    assert.deepEqual(env.document.execCommands, ['insertLineBreak', 'insertLineBreak'],
      'the no-op disposer must not tear the original install down')
    first()
    enter()
    assert.equal(env.document.execCommands.length, 2, 'after the original release the handler is gone')
    // The key is free again: a fresh install after the release works.
    const third = installEnterToNewline()
    enter()
    assert.deepEqual(env.document.execCommands,
      ['insertLineBreak', 'insertLineBreak', 'insertLineBreak'])
    third()
  })
})

// ---------------------------------------------------------------------------
// Enter guard edges: the Alt/AltGraph chords, the live composition flag and
// the fingerprint-gated command ladder.
// ---------------------------------------------------------------------------

function pressEnter(env: ComposerDomEnv, composer: FakeComposer, init: Record<string, unknown> = {}): void {
  env.document.dispatch('keydown', {
    key: 'Enter', target: composer, isComposing: false, keyCode: 13,
    shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false,
    ...init,
  })
}

test('enter: the Alt/AltGraph chords and a live composition are never intercepted', () => {
  withComposerDom(env => {
    const composer = new FakeComposer()
    const dispose = installEnterToNewline()
    try {
      // AltGr arrives as Alt (and as Ctrl+Alt on Windows) or through the
      // AltGraph modifier state: that Enter types a character, not a newline.
      pressEnter(env, composer, { altKey: true })
      pressEnter(env, composer, { getModifierState: (mod: string) => mod === 'AltGraph' })
      assert.deepEqual(env.document.execCommands, [])
      // compositionstart opens the composing flag: the final Enter of a
      // composed input arrives with isComposing already false while the
      // session is open.
      env.document.dispatch('compositionstart')
      pressEnter(env, composer)
      assert.deepEqual(env.document.execCommands, [], 'a live composition is never intercepted')
      env.document.dispatch('compositionend')
      pressEnter(env, composer)
      assert.deepEqual(env.document.execCommands, [], 'the 10ms Safari trailing window still suppresses')
      env.at(10)
      pressEnter(env, composer)
      assert.deepEqual(env.document.execCommands, ['insertLineBreak'])
    } finally {
      dispose()
    }
  })
})

test('enter: the command ladder is fingerprint-gated (a lying boolean never doubles the insert)', () => {
  withComposerDom(env => {
    const composer = new FakeComposer()
    let dispose = installEnterToNewline()
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]): void => { warnings.push(args.map(String).join(' ')) }
    try {
      // insertLineBreak AND insertText both claim "unsupported": the manual
      // last resort (no selection in this double) fails and is reported once.
      env.document.execAnswers.insertLineBreak = false
      env.document.execAnswers.insertText = false
      pressEnter(env, composer)
      assert.deepEqual(env.document.execCommands, ['insertLineBreak', 'insertText'],
        'a false insertLineBreak escalates to the insertText fallback')
      assert.equal(warnings.length, 1, 'both commands left the document unchanged → reported once')
      pressEnter(env, composer)
      assert.equal(warnings.length, 1, 'the warning is once per install, not per keystroke')
      // A lying false that DID insert: insertText must not run on top of it.
      env.document.onExec = command => { if (command === 'insertLineBreak') composer.textContent = 'line\n' }
      env.document.execCommands.length = 0
      pressEnter(env, composer)
      assert.deepEqual(env.document.execCommands, ['insertLineBreak'],
        'the fingerprint gate keeps a successful-but-false command from being doubled')
      assert.equal(warnings.length, 1, 'nothing was left unchanged → no failure report')
      // insertText claims "supported" but wrote nothing either: its boolean is
      // not trusted, the manual fallback still runs (fresh install = fresh
      // warnedOnce).
      dispose()
      dispose = installEnterToNewline()
      warnings.length = 0
      env.document.onExec = null
      env.document.execCommands.length = 0
      env.document.execAnswers.insertLineBreak = false
      env.document.execAnswers.insertText = true
      pressEnter(env, composer)
      assert.deepEqual(env.document.execCommands, ['insertLineBreak', 'insertText'])
      assert.equal(warnings.length, 1,
        'a true-returning insertText that did not insert still falls through to the manual path')
    } finally {
      console.warn = originalWarn
      dispose()
    }
  })
})

