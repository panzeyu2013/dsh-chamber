/**
 * hover-intent.ts unit tests (plain node:test, no dsh, no DOM, mock timers): the row hover-card
 * state machine: the vendored HoverCard's timer/state pair has a
 * commit race — it arms its grace close against the last COMMITTED `open`, so a
 * pointerleave handled while React's commit of the dwell timer is still pending arms nothing and
 * strands the card. The committed
 * evidence is the cases below and the W-4b-race real-pointer leg.
 *
 * Pinned here: the dwell boundary, the fire-time pointer-inside check that cancels an open whose
 * commit is still in flight, the UNCONDITIONAL grace close, re-entry inside the grace,
 * press-dismiss, owner gating, the idempotent no-op close for a card that never opened, and
 * `dismissVisibleRowCard()` — the page slot's external closer the renderer's view-hide path calls
 * (a card portaled to `document.body` is not hidden by CSS-hiding the view that owns it).
 */

import { afterEach, beforeEach, test, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  createHoverIntent,
  dismissVisibleRowCard,
  HOVER_OPEN_DELAY_MS,
  type HoverIntent,
} from '@dsh-chamber/dsh-chamber-client-core/hover-intent'
import { HOVER_CLOSE_GRACE_MS } from '../../../dsh-chamber-client-core/src/hover-intent.ts'

/** Machines created by the current test. The visible-card slot is page-global (two N-ctx shells
 * share it), so every test disposes what it built — a card left open here would be dismissed by
 * the next test's first open. Fake timers are installed per test and reset after disposal. */
const created: HoverIntent[] = []
beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }))
afterEach(() => {
  while (created.length > 0) created.pop()?.dispose()
  mock.timers.reset()
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
  const h = harness()
  h.intent.enter()
  mock.timers.tick(HOVER_OPEN_DELAY_MS - 1)
  assert.equal(h.card, false)
  mock.timers.tick(1)
  assert.equal(h.card, true)
  assert.deepEqual(h.events, ['open'])
})

test('leaving before the dwell fires never opens — the armed timer fires with the pointer flag false', () => {
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
})

test('a leave handled after the dwell fired still closes the card — the open commit may land late, the close never depends on it', () => {
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
})

test('the dwell is re-armed by a fresh enter, and a leave cannot resurrect it', () => {
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
})

test('re-entering inside the grace cancels the close without restarting the dwell', () => {
  const h = harness()
  h.intent.enter()
  mock.timers.tick(HOVER_OPEN_DELAY_MS)
  h.intent.leave()
  mock.timers.tick(HOVER_CLOSE_GRACE_MS - 1)
  h.intent.enter()
  mock.timers.tick(10_000)
  assert.equal(h.card, true, 'the card survives the anchor→card transit')
  assert.deepEqual(h.events, ['open'])
})

test('leaving a card that never opened arms a no-op close (no stray close callback)', () => {
  const h = harness()
  h.intent.enter()
  mock.timers.tick(10)
  h.intent.leave()
  mock.timers.tick(10_000)
  assert.deepEqual(h.events, [])
})

test('a press on the anchor dismisses and stays closed until the pointer enters again', () => {
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
})

test('owner gating closes an open card and suppresses the dwell until it clears', () => {
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
})

test('dispose drops pending timers (StrictMode effect cleanups re-run setup)', () => {
  const h = harness()
  h.intent.enter()
  h.intent.dispose()
  mock.timers.tick(10_000)
  assert.deepEqual(h.events, [])
})

test('custom timings are honored (the machine takes both timings as options)', () => {
// Scope note: `openDelayMs` is an option of the
// machine and a documented prop of `RowHoverCard`, but NO production caller
// passes it — both `<RowHoverCard>` sites use the official 500ms dwell. This
// case proves the seam works; it does not claim a per-row dwell exists.
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
})

test('the store publishes exactly the visibility transitions, and nothing for a no-op close', () => {
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
})

test('unsubscribing stops the notifications (the component unmounts its view)', () => {
  const h = harness()
  h.unsubscribe()
  h.intent.enter()
  mock.timers.tick(HOVER_OPEN_DELAY_MS)
  assert.equal(h.card, true)
  assert.deepEqual(h.events, [])
})

test('a press after the dwell fired leaves the card closed for good — the flag, not a render, is the truth', () => {
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
})

test('one visible card per document: opening a second card dismisses the first', () => {
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
})

test('the newer card keeps the slot: closing it does not resurrect the older one, and a third card still opens', () => {
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
})

test('dispose frees the slot, so a card unmounted while open cannot dismiss the next one', () => {
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
})

test('dismissVisibleRowCard closes whichever card holds the page slot (the hidden-view closer)', () => {
  const h = harness()
  h.intent.enter()
  mock.timers.tick(HOVER_OPEN_DELAY_MS)
  assert.equal(h.card, true)
  // Called with NO handle: the card is portaled to document.body, so hiding
  // the view that owns it delivers it no pointer event at all.
  dismissVisibleRowCard()
  assert.equal(h.card, false)
  // Same close funnel as a leave/press: exactly one transition, published.
  assert.deepEqual(h.events, ['open', 'close'])
  // The slot was released, not just the card closed: a fresh enter opens
  // again, and the dismissed machine can still take the slot.
  h.intent.enter()
  mock.timers.tick(HOVER_OPEN_DELAY_MS)
  assert.equal(h.card, true)
  assert.deepEqual(h.events, ['open', 'close', 'open'])
})

test('dismissVisibleRowCard leaves a machine that does not hold the slot untouched', () => {
  const holder = harness()
  const bystander = harness()
  holder.intent.enter()
  mock.timers.tick(HOVER_OPEN_DELAY_MS)
  assert.equal(holder.card, true)
  dismissVisibleRowCard()
  assert.equal(holder.card, false)
  assert.equal(bystander.card, false)
  assert.deepEqual(bystander.events, [], 'a machine that never opened sees no transition')
  // The bystander is fully functional afterwards: the closer closed one card,
  // it did not disable the machine or corrupt the slot.
  bystander.intent.enter()
  mock.timers.tick(HOVER_OPEN_DELAY_MS)
  assert.equal(bystander.card, true)
  assert.deepEqual(bystander.events, ['open'])
})

test('dismissVisibleRowCard is a no-op when nothing is open (and never claims the slot)', () => {
  const h = harness()
  // The renderer calls it on every view-hide transition, including with no
  // card on screen: it must not throw and must not take the slot itself.
  dismissVisibleRowCard()
  assert.deepEqual(h.events, [])
  h.intent.enter()
  mock.timers.tick(HOVER_OPEN_DELAY_MS)
  assert.equal(h.card, true)
  // The card that opened AFTER the no-op is the one a later dismiss closes —
  // proof the no-op left `visibleCard` free rather than pointing at a corpse.
  dismissVisibleRowCard()
  assert.equal(h.card, false)
  assert.deepEqual(h.events, ['open', 'close'])
})
