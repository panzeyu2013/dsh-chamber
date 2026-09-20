/**
 * Composer visibility guard — BEHAVIORAL tests for the DOM-bound installer
 * (the 2026-12 review's F1/F3/F4/F5/F6/F8): the previous suite pinned only the
 * pure decisions and a source regex, so mutations of the poll, the seat query,
 * the verify loop and the teardown all stayed green.
 *
 * Every case runs against test/support/guard-harness.ts: a plain-node DOM
 * double, a window with NO visualViewport (an engine that delivers no viewport
 * event), a fake clock driving the guard's 250ms interval, and an engine model
 * that decides how fully the layout honors the sticky inset.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  KBD_MAX_VERIFY_STEPS, KBD_POLL_BUDGET_MS, KBD_POLL_MS,
  MOBILE_KBD_ATTR, MOBILE_KBD_STATE_ATTR, MOBILE_KBD_SPACER_ATTR, MOBILE_KBD_VAR,
} from '../../src/client/composer.ts'
import { MOBILE_CSS } from '../../src/client/styles.ts'
import {
  createGuardHarness, type FakeElement, type GuardHarness, type GuardHarnessOptions,
} from '../support/guard-harness.ts'

function withGuard(options: GuardHarnessOptions, run: (h: GuardHarness, dispose: () => void) => void): void {
  const h = createGuardHarness(options)
  const dispose = h.install()
  try {
    run(h, dispose)
  } finally {
    dispose()
    h.restore()
  }
}

const spacerOf = (h: GuardHarness): FakeElement => {
  const spacer = h.root.querySelector(`[${MOBILE_KBD_SPACER_ATTR}]`)
  assert.ok(spacer !== null, 'the guard must have inserted its in-flow spacer')
  return spacer
}

test('MOBILE_KBD_VAR equals the custom property the sticky-bottom arm consumes (rename lock)', () => {
  // F7: renaming the JS constant used to pass the whole suite — the arm in
  // styles.ts kept consuming the literal. Parse the property name OUT of the
  // shipped CSS so the two sides can only move together.
  const arm = MOBILE_CSS.match(/\[data-mobile-frame\]\[data-mobile-kbd\][^\{]*\{([^\}]*)\}/)
  assert.ok(arm !== null, 'the single sticky-bottom arm must exist in MOBILE_CSS')
  const consumed = (arm[1] as string).match(/var\(\s*(--[a-zA-Z0-9-]+)/)
  assert.ok(consumed !== null, 'the arm must consume a custom property')
  assert.equal(MOBILE_KBD_VAR, consumed[1])
})

test('poll alone converges: geometry moves with no viewport event (F5)', () => {
  withGuard({ covered: 0 }, h => {
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'idle')
    // The keyboard opens and only the LAYOUT changes: no visualViewport,
    // resize, focus, pointer or phase event is dispatched.
    h.openKeyboardWithoutEvents(336)
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'idle', 'no event → the guard cannot have seen it yet')
    h.clock.advance(KBD_POLL_MS)
    assert.equal(h.frame.getAttribute(MOBILE_KBD_ATTR), '352', 'the bounded poll is the convergence path')
    assert.equal(h.frame.style.getPropertyValue(MOBILE_KBD_VAR), '352px')
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'armed')
  })
})

test('the poll budget is per focus arm: pointer/focus churn never extends it (F2/F5)', () => {
  withGuard({ covered: 336 }, h => {
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'armed')
    // 4Hz synthetic taps + focusin churn for the whole 4s budget (the measured
    // mutation: each event reset pollUntil before the running-interval return,
    // so the 250ms sync loop lived forever while the composer held focus).
    for (let elapsed = 0; elapsed <= KBD_POLL_BUDGET_MS; elapsed += KBD_POLL_MS) {
      h.pointerDown()
      h.focusIn()
      h.clock.advance(KBD_POLL_MS)
    }
    assert.equal(h.clock.pending, 0, 'the interval must stop at KBD_POLL_BUDGET_MS despite the churn')
    const reads = h.counts.scrollerRects
    h.clock.advance(2_000)
    assert.equal(h.counts.scrollerRects, reads, 'nothing may sync after the budget stopped the poll')
  })
})

test('the poll stops when focus leaves the editable (F5)', () => {
  withGuard({ covered: 336 }, h => {
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'armed')
    h.blur()
    // The grace window (1.2s) keeps the interval through the close animation;
    // after it, the poll must end instead of syncing forever.
    h.clock.advance(KBD_POLL_BUDGET_MS)
    assert.equal(h.clock.pending, 0, 'focus loss must clear the interval')
    const reads = h.counts.scrollerRects
    h.clock.advance(2_000)
    assert.equal(h.counts.scrollerRects, reads)
  })
})

test('a focused editable OUTSIDE the composer seat leaves the guard idle (F6)', () => {
  withGuard({ covered: 336, focused: false }, h => {
    // The keyboard belongs to a settings-sheet question-card field: the seat
    // must not move just because SOME editable is focused.
    h.focusOutsideEditable()
    h.pointerDown()
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'idle')
    assert.equal(h.frame.hasAttribute(MOBILE_KBD_ATTR), false)
    assert.equal(h.root.querySelectorAll(`[${MOBILE_KBD_SPACER_ATTR}]`).length, 0)
    h.clock.advance(KBD_POLL_MS)
    assert.equal(h.frame.hasAttribute(MOBILE_KBD_ATTR), false, 'the poll must not arm a non-composer field')
  })
})

test('a carrier that grows with the lift is latched, never ramped (F2)', () => {
  // The measurement's premise is that the scrollport's border box is
  // flex-sized, so our own writes cannot move it. This model breaks it: each
  // write grows the measured edge by the increment it applied (the synthetic
  // feedback that ramped 352 → 5984px over the poll window). The guard must
  // read the edge across the write, latch, and REPORT the residue.
  withGuard({ covered: 336, scrollerGrowsWithLift: 1 }, h => {
    const first = h.frame.getAttribute(MOBILE_KBD_ATTR)
    assert.equal(first, '352')
    for (let tick = 0; tick < 20; tick += 1) h.clock.advance(KBD_POLL_MS)
    assert.equal(h.frame.getAttribute(MOBILE_KBD_ATTR), first,
      'a self-pushed carrier must not raise the lift past its first bounded value')
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'still-covered',
      'the residue is reported instead of chased')
  })
})

test('a hidden active-phase root earlier in DOM order never wins the seat query (F3)', () => {
  withGuard({ covered: 336, hiddenSeatFirst: true }, h => {
    // First-match seat selection served the hidden seat (scrollport 0x0) and
    // stayed idle while the real seat was covered.
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'armed')
    assert.equal(h.frame.getAttribute(MOBILE_KBD_ATTR), '352')
    const spacer = spacerOf(h)
    assert.equal(spacer.style.height, '352px')
    assert.equal(h.seat.previousElementSibling?.hasAttribute(MOBILE_KBD_SPACER_ATTR), true,
      'the spacer must sit immediately before the REAL seat')
  })
})

test('dispose removes the state attribute from the frame and <html> (F4)', () => {
  withGuard({ covered: 336 }, (h, dispose) => {
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'armed')
    assert.equal(h.document.documentElement.getAttribute(MOBILE_KBD_STATE_ATTR), 'armed')
    dispose()
    assert.equal(h.frame.hasAttribute(MOBILE_KBD_STATE_ATTR), false)
    assert.equal(h.document.documentElement.hasAttribute(MOBILE_KBD_STATE_ATTR), false)
    assert.equal(h.frame.hasAttribute(MOBILE_KBD_ATTR), false)
    assert.equal(h.root.querySelectorAll(`[${MOBILE_KBD_SPACER_ATTR}]`).length, 0)
  })
})

test('an engine that honors the sticky inset arms with one coherent 352px lift', () => {
  withGuard({ covered: 336 }, h => {
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'armed')
    assert.equal(h.frame.getAttribute(MOBILE_KBD_ATTR), '352')
    assert.equal(h.frame.style.getPropertyValue(MOBILE_KBD_VAR), '352px')
    assert.equal(spacerOf(h).style.height, '352px')
  })
})

test('a requirement that GROWS during the write is corrected within the same sync, on the FINAL lift (F1)', () => {
  // Narrowed 2026-09: with an unchanged requirement the loop cannot fire
  // (`extra > 0` needs `residual > lift - 8`, while a partially honoured
  // engine leaves `residual <= nextKbdOffset(covered) - lift <= -8`) — a
  // partially honouring engine converges on the next event/poll tick instead.
  // The loop therefore only corrects demand that grew while the write landed.
  // The keyboard keeps rising while the first write lands (visible bottom drops
  // 400px): the first residual (384px) is worse than the applied lift, so the
  // bounded loop adds exactly the missing delta (48px → total 400) instead of
  // re-applying the whole residual. Every surface must carry that FINAL lift —
  // the attribute used to stay on the pre-verify target.
  withGuard({ covered: 336, keyboardGrowthOnFirstWrite: 400 }, h => {
    assert.equal(h.frame.getAttribute(MOBILE_KBD_ATTR), '400')
    assert.equal(h.frame.style.getPropertyValue(MOBILE_KBD_VAR), '400px')
    assert.equal(spacerOf(h).style.height, '400px')
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'still-covered',
      'a 400px growth cannot be cleared by one bounded correction — it is reported')
    assert.ok(h.counts.seatRects <= KBD_MAX_VERIFY_STEPS + 2)
  })
})

test('a non-converging engine ends still-covered with the FINAL lift everywhere, never 3x (F1/F8)', () => {
  withGuard({ covered: 336, responsiveness: 0 }, h => {
    // The seat never moves: the guard re-verifies at most
    // KBD_MAX_VERIFY_STEPS times, then REPORTS instead of chasing.
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'still-covered')
    // attr === var === spacer === the measured need (336 + 8 headroom → 352).
    // The measured defect was attr=352 / var=1056 / spacer=1056 because each
    // verify extra re-added the already-applied lift.
    assert.equal(h.frame.getAttribute(MOBILE_KBD_ATTR), '352')
    assert.equal(h.frame.style.getPropertyValue(MOBILE_KBD_VAR), '352px')
    const spacer = spacerOf(h)
    assert.equal(spacer.style.height, '352px')
    // Bounded measurement budget per sync: the loop corrections plus the final
    // read (never an unbounded ramp).
    assert.ok(h.counts.seatRects <= KBD_MAX_VERIFY_STEPS + 2,
      `the seat was measured ${h.counts.seatRects} times in one sync`)
    // The poll's next sync must not accumulate the offset either.
    h.clock.advance(KBD_POLL_MS)
    assert.equal(h.frame.getAttribute(MOBILE_KBD_ATTR), '352')
    assert.equal(spacer.style.height, '352px')
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'still-covered')
  })
})
