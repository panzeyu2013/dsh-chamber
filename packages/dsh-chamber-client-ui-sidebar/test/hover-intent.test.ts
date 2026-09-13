/**
 * hover-intent.ts unit tests (plain node:test, no dsh, no DOM, mock timers):
 * the row hover-card state machine that replaced the vendored HoverCard's
 * timer/state pair. The defect it exists to kill is a commit race — the vendor
 * arms its grace close against the last COMMITTED `open`, so a pointerleave
 * handled while React's commit of the dwell timer was still pending armed
 * nothing and stranded the card on screen (measured reproduction:
 * `.tmp/hover-probe/race2-load.json`, documented in the module header).
 *
 * Pinned here: the dwell boundary, the fire-time pointer-inside check that
 * cancels an open whose commit is still in flight, the UNCONDITIONAL grace
 * close (a pending or committed open always resolves closed once the pointer is
 * gone), re-entry inside the grace, press-dismiss, owner gating, and the
 * idempotent no-op close for a card that never opened.
 */

import { afterEach, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  createHoverIntent,
  HOVER_CLOSE_GRACE_MS,
  HOVER_OPEN_DELAY_MS,
  type HoverIntent,
} from '../src/shared/hover-intent.ts'

/**
 * Machines created by the current test. The visible-card slot is page-global
 * (two N-ctx shells share it), so every test disposes what it built — otherwise
 * a card left open here would be dismissed by the next test's first open.
 */
const created: HoverIntent[] = []
afterEach(() => {
  while (created.length > 0) created.pop()?.dispose()
})

/**
 * A machine plus the visibility transitions it publishes — the same view the
 * component gets through `useSyncExternalStore(intent.subscribe, intent.isOpen)`.
 */
function harness(options: { openDelayMs?: number; graceMs?: number; disabled?: boolean } = {}) {
  const intent = createHoverIntent(options)
  created.push(intent)
  const events: string[] = []
  const unsubscribe = intent.subscribe(() => { events.push(intent.isOpen() ? 'open' : 'close') })
  return {
    intent,
    events,
    unsubscribe,
    /** Card visibility right now (the render authority). */
    get card() { return intent.isOpen() },
  }
}

test('the dwell opens exactly at openDelayMs while the pointer stays inside', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const h = harness()
    h.intent.enter()
    mock.timers.tick(HOVER_OPEN_DELAY_MS - 1)
    assert.equal(h.card, false)
    mock.timers.tick(1)
    assert.equal(h.card, true)
    assert.deepEqual(h.events, ['open'])
  } finally {
    mock.timers.reset()
  }
})

test('leaving before the dwell fires never opens — the armed timer fires with the pointer flag false', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const h = harness()
    h.intent.enter()
    mock.timers.tick(HOVER_OPEN_DELAY_MS - 1)
    h.intent.leave()
    // The dwell timer is still armed and fires past the boundary: the pointer
    // flag — not the timer — decides, so no card is opened or committed.
    mock.timers.tick(1)
    assert.equal(h.card, false)
    mock.timers.tick(10_000)
    assert.equal(h.card, false)
    assert.deepEqual(h.events, [])
  } finally {
    mock.timers.reset()
  }
})

test('a leave handled after the dwell fired still closes the card — the open commit may land late, the close never depends on it', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const h = harness()
    h.intent.enter()
    // The dwell fired: the owner's `open` is in flight (React commits it in a
    // later task, exactly the race window measured at 554ms under load).
    mock.timers.tick(HOVER_OPEN_DELAY_MS)
    assert.equal(h.card, true)
    // The pointerleave is handled against that in-flight/open state.
    h.intent.leave()
    mock.timers.tick(HOVER_CLOSE_GRACE_MS - 1)
    assert.equal(h.card, true, 'the grace keeps the card reachable while the pointer crosses the 8px gap')
    mock.timers.tick(1)
    assert.equal(h.card, false)
    assert.deepEqual(h.events, ['open', 'close'])
  } finally {
    mock.timers.reset()
  }
})

test('the dwell is re-armed by a fresh enter, and a leave cannot resurrect it', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const h = harness()
    h.intent.enter()
    mock.timers.tick(HOVER_OPEN_DELAY_MS - 1)
    h.intent.leave()
    mock.timers.tick(HOVER_OPEN_DELAY_MS)
    assert.deepEqual(h.events, [], 'the abandoned dwell never opened')
    h.intent.enter()
    mock.timers.tick(HOVER_OPEN_DELAY_MS - 1)
    assert.equal(h.card, false, 'the re-entry starts a fresh full dwell')
    mock.timers.tick(1)
    assert.equal(h.card, true)
    assert.deepEqual(h.events, ['open'])
  } finally {
    mock.timers.reset()
  }
})

test('re-entering inside the grace cancels the close without restarting the dwell', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const h = harness()
    h.intent.enter()
    mock.timers.tick(HOVER_OPEN_DELAY_MS)
    h.intent.leave()
    mock.timers.tick(HOVER_CLOSE_GRACE_MS - 1)
    h.intent.enter()
    mock.timers.tick(10_000)
    assert.equal(h.card, true, 'the card survives the anchor→card transit')
    assert.deepEqual(h.events, ['open'])
  } finally {
    mock.timers.reset()
  }
})

test('leaving a card that never opened arms a no-op close (no stray close callback)', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const h = harness()
    h.intent.enter()
    mock.timers.tick(10)
    h.intent.leave()
    mock.timers.tick(10_000)
    assert.deepEqual(h.events, [])
  } finally {
    mock.timers.reset()
  }
})

test('a press on the anchor dismisses and stays closed until the pointer enters again', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const h = harness()
    h.intent.enter()
    mock.timers.tick(HOVER_OPEN_DELAY_MS)
    h.intent.press()
    assert.equal(h.card, false)
    // Still inside, but the dwell must not re-fire without a fresh enter.
    mock.timers.tick(10_000)
    assert.equal(h.card, false)
    h.intent.leave()
    mock.timers.tick(10_000)
    h.intent.enter()
    mock.timers.tick(HOVER_OPEN_DELAY_MS)
    assert.equal(h.card, true)
    assert.deepEqual(h.events, ['open', 'close', 'open'])
  } finally {
    mock.timers.reset()
  }
})

test('owner gating closes an open card and suppresses the dwell until it clears', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const h = harness()
    h.intent.enter()
    mock.timers.tick(HOVER_OPEN_DELAY_MS)
    assert.equal(h.card, true)
    h.intent.setDisabled(true)
    assert.equal(h.card, false, 'a menu opening mid-hover drops the card immediately')
    h.intent.leave()
    h.intent.enter()
    mock.timers.tick(10_000)
    assert.equal(h.card, false, 'a disabled card never opens')
    h.intent.setDisabled(false)
    h.intent.leave()
    h.intent.enter()
    mock.timers.tick(HOVER_OPEN_DELAY_MS)
    assert.equal(h.card, true)
  } finally {
    mock.timers.reset()
  }
})

test('dispose drops pending timers (StrictMode effect cleanups re-run setup)', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const h = harness()
    h.intent.enter()
    h.intent.dispose()
    mock.timers.tick(10_000)
    assert.deepEqual(h.events, [])
  } finally {
    mock.timers.reset()
  }
})

test('custom timings are honored (workspace headers may tune the dwell independently)', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const h = harness({ openDelayMs: 120, graceMs: 40 })
    h.intent.enter()
    mock.timers.tick(119)
    assert.equal(h.card, false)
    mock.timers.tick(1)
    assert.equal(h.card, true)
    h.intent.leave()
    mock.timers.tick(39)
    assert.equal(h.card, true)
    mock.timers.tick(1)
    assert.equal(h.card, false)
  } finally {
    mock.timers.reset()
  }
})

test('the store publishes exactly the visibility transitions, and nothing for a no-op close', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const h = harness()
    h.intent.enter()
    mock.timers.tick(HOVER_OPEN_DELAY_MS)
    h.intent.leave()
    mock.timers.tick(HOVER_CLOSE_GRACE_MS)
    assert.deepEqual(h.events, ['open', 'close'])
    // Leaving an already-closed card arms a no-op close: subscribers must not
    // see a second transition (React would re-render on a false change).
    h.intent.leave()
    mock.timers.tick(HOVER_CLOSE_GRACE_MS)
    mock.timers.tick(10_000)
    assert.deepEqual(h.events, ['open', 'close'])
  } finally {
    mock.timers.reset()
  }
})

test('unsubscribing stops the notifications (the component unmounts its view)', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const h = harness()
    h.unsubscribe()
    h.intent.enter()
    mock.timers.tick(HOVER_OPEN_DELAY_MS)
    assert.equal(h.card, true)
    assert.deepEqual(h.events, [])
  } finally {
    mock.timers.reset()
  }
})

test('a press after the dwell fired leaves the card closed for good — the flag, not a render, is the truth', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const h = harness()
    h.intent.enter()
    mock.timers.tick(HOVER_OPEN_DELAY_MS)
    assert.equal(h.card, true)
    // The owner is still inside the region: a press must dismiss and stay
    // dismissed, with no later transition resurrecting the card.
    h.intent.press()
    assert.equal(h.card, false)
    mock.timers.tick(10_000)
    assert.equal(h.card, false)
    assert.deepEqual(h.events, ['open', 'close'])
  } finally {
    mock.timers.reset()
  }
})

test('one visible card per document: opening a second card dismisses the first', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const first = harness()
    const second = harness()
    first.intent.enter()
    mock.timers.tick(HOVER_OPEN_DELAY_MS)
    assert.equal(first.card, true)
    second.intent.enter()
    mock.timers.tick(HOVER_OPEN_DELAY_MS)
    assert.equal(second.card, true)
    assert.equal(first.card, false, 'a pointer can only be in one region — the older card must go')
    assert.deepEqual(first.events, ['open', 'close'])
    assert.deepEqual(second.events, ['open'])
  } finally {
    mock.timers.reset()
  }
})

test('the newer card keeps the slot: closing it does not resurrect the older one, and a third card still opens', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const first = harness()
    const second = harness()
    const third = harness()
    first.intent.enter()
    mock.timers.tick(HOVER_OPEN_DELAY_MS)
    second.intent.enter()
    mock.timers.tick(HOVER_OPEN_DELAY_MS)
    second.intent.leave()
    mock.timers.tick(HOVER_CLOSE_GRACE_MS)
    assert.deepEqual([first.card, second.card], [false, false])
    third.intent.enter()
    mock.timers.tick(HOVER_OPEN_DELAY_MS)
    assert.deepEqual([first.card, second.card, third.card], [false, false, true])
  } finally {
    mock.timers.reset()
  }
})

test('dispose frees the slot, so a card unmounted while open cannot dismiss the next one', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const unmounted = harness()
    unmounted.intent.enter()
    mock.timers.tick(HOVER_OPEN_DELAY_MS)
    assert.equal(unmounted.card, true)
    // The owner unmounts with the card open (view switch, sidebar collapse).
    unmounted.intent.dispose()
    const next = harness()
    next.intent.enter()
    mock.timers.tick(HOVER_OPEN_DELAY_MS)
    assert.equal(next.card, true)
    assert.deepEqual(unmounted.events, ['open'], 'the dead card must not be dismissed through a stale slot entry')
  } finally {
    mock.timers.reset()
  }
})
