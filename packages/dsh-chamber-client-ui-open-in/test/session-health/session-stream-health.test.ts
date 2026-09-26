/**
 * SESSION STREAM-HEALTH LADDER LOCKS (design 14 §D4).
 *
 * The defect (carrier losses latching `openState='error'` ⇒ a frozen transcript)
 * is recovered by the concrete per-session `Session.resync()` the pinned
 * controller ships off-contract (reached through the guarded structural slice):
 * the `'error'` arm runs it AUTOMATICALLY after its grace, the parked
 * `'loading'` arm only ARMS the user's control, and the presented fact is the
 * official main view's `retainedBy.mainView` retention — a chamber-side
 * `current` mirror must never come back. Assertions live at the decision
 * boundary (pure module) and the effect boundary (a fake sessions face),
 * including the edges that must stay pinned: the settle window, a backwards wall
 * clock, the rolling-window edge, the cross-phase hold, both first-notice
 * timestamps and the hidden stretch that must NOT hand back a fresh storm budget.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import {
  createSessionStreamHealthState,
  markSessionStreamHeal,
  planSessionStreamHealth,
  sessionStreamNoticeKey,
  SESSION_STREAM_HEALTH_DEFAULTS,
  type SessionStreamHealthConfig,
  type SessionStreamHealthState,
  type SessionStreamObservation,
} from '../../src/client/session-stream-health.ts'
import { OPENING_TIMEOUT_LADDER_MS } from '@dsh-chamber/dsh-stream-state'
import { en, zh } from '../../src/locales.ts'
import {
  hasSessionStreamResync,
  isConversationSurfacePresented,
  parseSessionOpeningOutcome,
  resyncSessionStream,
  sessionOpenState,
  sessionOpenInFlight,
  sessionOpeningFailureLedger,
  type SessionsConcreteLoose,
  type SessionsLoose,
} from '../../src/client/session-stream-health-probe.ts'

const CONFIG: SessionStreamHealthConfig = SESSION_STREAM_HEALTH_DEFAULTS
const G = CONFIG.errorGraceMs
const L = CONFIG.loadingStallMs
const C = CONFIG.healCooldownMs
const S = CONFIG.healSettleMs
const W = CONFIG.healBudgetWindowMs
const T0 = 1_700_000_000_000
/** The whole opening ladder: the page's freshness bound for a terminal fact. */
const LADDER_TOTAL = OPENING_TIMEOUT_LADDER_MS.reduce((sum, ms) => sum + ms, 0)

/** planSessionStreamHealth bound to the pinned case-invariant config. */
function planAt(state: SessionStreamHealthState, observation: SessionStreamObservation, at: number) {
  return planSessionStreamHealth(state, observation, at, CONFIG)
}

/**
 * One shipped-shaped observation: a presented target with the concrete rc.2
 * resync face live. Tests that model a missing/unreadable face override
 * `resyncAvailable: false` explicitly; `undefined` stays the fail-closed
 * "unknown" input a drifting build produces.
 */
function observe(openState: SessionStreamObservation['openState'], over: Partial<SessionStreamObservation> = {}): SessionStreamObservation {
  return { openState, presented: true, healRoute: true, resyncAvailable: true, ...over }
}

/** Drive the ladder over a timeline, advancing a virtual clock. */
function drive(
  steps: ReadonlyArray<{ at: number; observation: SessionStreamObservation }>,
  start: SessionStreamHealthState = createSessionStreamHealthState(),
): { state: SessionStreamHealthState; actions: number[]; notices: Array<string | null> } {
  let state = start
  const actions: number[] = []
  const notices: Array<string | null> = []
  for (const step of steps) {
    const plan = planAt(state, step.observation, step.at)
    state = plan.state
    actions.push(plan.action === 'heal' ? step.at : 0)
    notices.push(plan.notice)
    if (plan.action === 'heal') state = markSessionStreamHeal(state, step.at)
  }
  return { state, actions, notices }
}

test('stream-health: an error state heals once, only after the grace', () => {
  const { actions, notices } = drive([
    { at: T0, observation: observe('error') },
    { at: T0 + G - 1, observation: observe('error') },
    { at: T0 + G, observation: observe('error') },
  ])
  assert.deepEqual(actions, [0, 0, T0 + G])
  assert.deepEqual(notices, [null, null, null])
})

test('stream-health: the settle window is never sampled as "failed" and never re-fires a heal', () => {
  const healed = T0 + G
  const { state, actions, notices } = drive([
    { at: T0, observation: observe('error') },
    { at: healed, observation: observe('error') },
    { at: healed + 1_000, observation: observe('error') },
    { at: healed + S - 1, observation: observe('error') },
    { at: healed + S, observation: observe('error') },
    { at: healed + C, observation: observe('error') },
  ])
  // Inside the settle window: no notice, no second heal.
  assert.equal(actions[2], 0)
  assert.equal(actions[3], 0)
  // The judged failure latches the reload notice, and it stays up
  // while the cooldown-paced retry runs — no "recovering…" over a dead repair.
  assert.deepEqual(notices, [null, null, null, null, 'heal-failed', 'heal-failed'])
  // The window closes into the hold, and the cooldown (not the settle) paces
  // the next attempt.
  assert.deepEqual(actions, [0, healed, 0, 0, 0, healed + C])
  assert.equal(state.healStamps.length, 2)
})

test('stream-health: the cooldown paces the retries and the rolling budget ends the storm with a reload notice', () => {
  const t1 = T0 + G
  const t2 = t1 + S
  const t3 = t1 + C
  const t4 = t3 + S
  const t5 = t3 + C
  const t6 = t5 + S
  const t7 = t5 + C
  const t8 = t7 + W
  const { state, actions, notices } = drive([
    { at: T0, observation: observe('error') },
    { at: t1, observation: observe('error') },
    { at: t2, observation: observe('error') },
    { at: t3, observation: observe('error') },
    { at: t4, observation: observe('error') },
    { at: t5, observation: observe('error') },
    { at: t6, observation: observe('error') },
    { at: t7, observation: observe('error') },
    { at: t8, observation: observe('error') },
  ])
  assert.deepEqual(actions, [0, t1, 0, t3, 0, t5, 0, 0, t8])
  // From the first judged failure onward the notice is latched for the whole
  // storm (indices 2-8); only the two pre-judgment ticks stay null.
  assert.deepEqual(notices, [null, null, 'heal-failed', 'heal-failed', 'heal-failed', 'heal-failed', 'heal-failed', 'heal-failed', 'heal-failed'])
  // One stamp per executed heal, each pruned once it leaves the rolling window.
  assert.equal(state.healStamps.length, 1)
})

test('stream-health: a hidden stretch keeps the event ledger and only stops the clocks', () => {
  const healed = T0 + G
  const hidden = planAt(
    markSessionStreamHeal(createSessionStreamHealthState(), healed), observe('error', { presented: false }), healed + 1_000,
  )
  assert.equal(hidden.state.phase, 'idle')
  assert.equal(hidden.state.since, 0)
  // The storm bound survives: a tray-hide round trip must not hand out a fresh
  // cooldown and budget.
  assert.equal(hidden.state.healStamps.length, 1)
  assert.equal(hidden.state.lastHealAt, healed)
  // Immediately visible again: still cooling, so no second heal.
  const resumed = planAt(hidden.state, observe('error'), healed + 2_000)
  assert.equal(resumed.action, 'none')
  assert.equal(resumed.notice, null)
})

test('stream-health: a backwards wall clock cannot latch the healing phase', () => {
  const healed = T0 + G
  const jumped = planAt(
    markSessionStreamHeal(createSessionStreamHealthState(), healed), observe('error'), healed - 3_600_000,
  )
  // The jump is treated as "settled": the phase falls back to the hold instead
  // of waiting for a clock that already passed.
  assert.equal(jumped.state.phase, 'error-hold')
  assert.equal(jumped.action, 'none')
  assert.equal(jumped.notice, null)
  // ...and the arm can act again as soon as the grace elapses on the new clock.
  const later = planAt(jumped.state, observe('error'), jumped.state.since + G)
  assert.equal(later.action, 'heal')
})

test('stream-health: the loading arm restarts its hold after an error-phase detour', () => {
  const { actions, notices } = drive([
    { at: T0, observation: observe('error') },
    { at: T0 + 1_000, observation: observe('loading', { resyncAvailable: false }) },
    { at: T0 + 25_000, observation: observe('loading', { resyncAvailable: false }) },
    { at: T0 + 26_000, observation: observe('error') },
    { at: T0 + 33_999, observation: observe('error') },
    { at: T0 + 34_000, observation: observe('error') },
  ])
  assert.deepEqual(actions, [0, 0, 0, 0, 0, T0 + 34_000])
  assert.deepEqual(notices, [null, null, 'loading-stall', null, null, null])
})

test('stream-health: a loading stall is reported, never acted on, and only with the observed face', () => {
  // The hold must AGE first, exactly like the stall notice it rides with: the
  // control is never offered on the first frame of a load.
  const hold = planAt(createSessionStreamHealthState(), observe('loading', { resyncAvailable: true }), T0)
  assert.equal(hold.action, 'none')
  assert.equal(hold.notice, null)
  const stalled = planAt(hold.state, observe('loading', { resyncAvailable: true }), T0 + L)
  assert.equal(stalled.action, 'none', 'the header never rebuilds on its own')
  assert.equal(stalled.notice, 'loading-stall', 'the stall notice keeps its own timing')
  // Fail-closed on a build without the concrete face: the SAME stall with no
  // observed availability arms nothing (and the reload arm is untouched).
  const unavailable = planAt(hold.state, observe('loading', { resyncAvailable: false }), T0 + L)
  assert.equal(unavailable.action, 'none')
  assert.equal(unavailable.notice, 'loading-stall')
  // Never in the error arm (that arm has its own automatic heal)…
  const errorHold = planAt(createSessionStreamHealthState(), observe('error', { resyncAvailable: true }), T0)
  const error = planAt(errorHold.state, observe('error', { resyncAvailable: true }), T0 + G)
  assert.equal(error.action, 'heal')
  // …and never for a cold or healthy stream, even with the face present.
  assert.equal(planAt(createSessionStreamHealthState(), observe('cold', { resyncAvailable: true }), T0 + L).action, 'none')
  assert.equal(planAt(createSessionStreamHealthState(), observe('open', { resyncAvailable: true }), T0 + L).action, 'none')

})

test('stream-health: the presented error heals automatically, and an exhausted budget only reports', () => {
  // Presented target + live concrete face: the automatic resync fires at the grace.
  const routedHold = planAt(createSessionStreamHealthState(), observe('error', { resyncAvailable: true }), T0)
  const routed = planAt(routedHold.state, observe('error', { resyncAvailable: true }), T0 + G)
  assert.equal(routed.action, 'heal')
  // With every automatic heal in the rolling window spent, the SAME observation
  // must not dispatch another one, and the notice now has no control to open:
  // the page's own bounded ladder owns the escalation (the manual lever was
  // retired by user ruling). The threshold still times the notice exactly as it
  // did when it also opened the control.
  const spent: SessionStreamHealthState = { phase: 'error-hold', since: T0, healStamps: [T0, T0 + C, T0 + 2 * C] }
  const spentNotice = planAt(spent, observe('error', { resyncAvailable: true }), T0 + C + S)
  assert.equal(spentNotice.action, 'none')
  // The chip reports the state: a spent automatic lane with a reachable face still
  // shows the failure notice (the timing the arm used to share), it just has no
  // control to offer.
  assert.equal(spentNotice.notice, 'heal-failed')
  // Fail-closed without the concrete face: no action is ever invented, and the
  // reload notice only appears once the hold has outlived a repair attempt.
  const noLever = planAt(createSessionStreamHealthState(), observe('error', { resyncAvailable: false }), T0)
  const noFace = planAt(noLever.state, observe('error', { resyncAvailable: false }), T0 + G)
  assert.equal(noFace.action, 'none')
  assert.equal(noFace.notice, null)
  const drained = planAt(noLever.state, observe('error', { resyncAvailable: false }), T0 + G + S)
  assert.equal(drained.action, 'none')
  assert.equal(drained.notice, 'heal-failed', 'no lever at all is reported, not hidden')
})

test('stream-health: loading never acts, independent of the error-heal ledger', () => {
  const hold = planAt(createSessionStreamHealthState(), observe('loading', { resyncAvailable: true }), T0)
  assert.equal(hold.action, 'none', 'the hold must age first, exactly like the stall notice')
  const stalled = planAt(hold.state, observe('loading', { resyncAvailable: true }), T0 + L)
  assert.equal(stalled.action, 'none')
  assert.equal(stalled.notice, 'loading-stall')
  const spent: SessionStreamHealthState = { phase: 'loading-hold', since: T0, healStamps: [T0, T0 + 1_000, T0 + 2_000] }
  assert.equal(planAt(spent, observe('loading', { resyncAvailable: true }), T0 + L).action, 'none')
  const noFace = planAt(hold.state, observe('loading', { resyncAvailable: false }), T0 + L)
  assert.equal(noFace.action, 'none')
})

test('stream-health: a loading dwell past the failure bound is announced as a failure, never as an endless load', () => {
  const inFlight = { resyncAvailable: true } as const
  let state = createSessionStreamHealthState()
  const notices: Array<string | null> = []
  for (let at = T0; at <= T0 + CONFIG.loadingFailedMs + 1_000; at += 1_000) {
    const plan = planAt(state, observe('loading', { ...inFlight }), at)
    state = plan.state
    notices.push(plan.notice)
  }
  assert.equal(notices[0], null, 'the first frame is never announced')
  assert.equal(notices[Math.floor(CONFIG.loadingStallMs / 1_000)], 'loading-stall')
  assert.equal(notices[Math.floor(CONFIG.loadingFailedMs / 1_000)], 'loading-failed')
  assert.equal(notices.at(-1), 'loading-failed', 'the failure label is latched for the rest of the dwell')
  assert.equal(sessionStreamNoticeKey('loading-failed'), 'streamHealth.loadingFailed')
})

test('stream-health: the rolling window edge is exclusive, and releases exactly one stamp', () => {
  const stamped: SessionStreamHealthState = {
    phase: 'error-hold',
    since: T0,
    healStamps: [T0, T0 + C, T0 + 2 * C],
    lastHealAt: T0 + 2 * C,
  }
  const before = planAt(stamped, observe('error'), T0 + W - 1)
  assert.equal(before.state.healStamps.length, 3)
  assert.equal(before.action, 'none', 'the automatic lane is spent inside the window and nothing replaces it')
  assert.equal(before.notice, 'heal-failed')
  const exactly = planAt(stamped, observe('error'), T0 + W)
  assert.equal(exactly.state.healStamps.length, 2)
  assert.equal(exactly.action, 'heal')
})

test('stream-health: both arms report their failure notice at the exact tick the levers run out', () => {
  // No reachable face: the notice lands at grace + settle.
  const { notices } = drive([
    { at: T0, observation: observe('error', { resyncAvailable: false }) },
    { at: T0 + G + S - 1, observation: observe('error', { resyncAvailable: false }) },
    { at: T0 + G + S, observation: observe('error', { resyncAvailable: false }) },
  ])
  assert.deepEqual(notices, [null, null, 'heal-failed'])

  // First judged failure: sampled every second, the notice appears exactly at
  // grace + settle (waiting the whole rolling budget out would take ~296 s).
  let state = createSessionStreamHealthState()
  let firstNotice: number | undefined
  let lastNotice: number | undefined
  for (let at = T0; at <= T0 + 320_000; at += 1_000) {
    const plan = planAt(state, observe('error'), at)
    state = plan.state
    if (plan.action === 'heal') state = markSessionStreamHeal(state, at)
    if (plan.notice === 'heal-failed') {
      firstNotice ??= at
      lastNotice = at
    }
  }
  assert.equal(firstNotice, T0 + G + S)
  assert.equal(lastNotice, T0 + 320_000)
})

test('stream-health: a judged-failed heal latches the reload notice while the retries continue', () => {
  const healed = T0 + G
  const judged = healed + S
  const retry = healed + C
  const { actions, notices } = drive([
    { at: T0, observation: observe('error') },
    { at: healed, observation: observe('error') },
    { at: judged, observation: observe('error') },
    { at: judged + 1_000, observation: observe('error') },
    { at: retry, observation: observe('error') },
    { at: retry + S, observation: observe('error') },
  ])
  // The notice appears the moment the first repair is judged failed…
  assert.deepEqual(notices, [null, null, 'heal-failed', 'heal-failed', 'heal-failed', 'heal-failed'])
  // …and the automatic retry lane never stops: the cooldown, not the notice,
  // paces the second attempt.
  assert.deepEqual(actions, [0, healed, 0, 0, retry, 0])
})
test('stream-health: the latch hangs off the settle clock, not off the healing phase', () => {
  const healed = T0 + G
  const judged = healed + S
  const retry = healed + C
  // (a) the re-open itself reports `loading` for a second (vendor doOpen() sets
  //     it synchronously): the notice still lands at the settle tick once the
  //     stream is back on `error`, instead of >100s later.
  const flap = drive([
    { at: T0, observation: observe('error') },
    { at: healed, observation: observe('error') },
    { at: healed + 1_000, observation: observe('loading') },
    { at: healed + 2_000, observation: observe('error') },
    { at: judged + 1_000, observation: observe('error') },
    { at: retry, observation: observe('error') },
  ])
  assert.deepEqual(flap.actions, [0, healed, 0, 0, 0, retry])
  assert.deepEqual(flap.notices, [null, null, null, null, 'heal-failed', 'heal-failed'])

  // (b) once latched, a later loading dwell never takes the notice back.
  const dwell = drive([
    { at: T0, observation: observe('error') },
    { at: healed, observation: observe('error') },
    { at: judged, observation: observe('error') },
    { at: judged + 1_000, observation: observe('loading') },
  ])
  assert.deepEqual(dwell.notices, [null, null, 'heal-failed', 'heal-failed'])

  // (c) a hidden stretch that swallows the whole settle window still latches
  //     the moment the surface is back on `error`.
  const hidden = drive([
    { at: T0, observation: observe('error') },
    { at: healed, observation: observe('error') },
    { at: healed + S, observation: observe('error', { presented: false }) },
    { at: healed + S + 1_000, observation: observe('error') },
  ])
  assert.deepEqual(hidden.notices, [null, null, null, 'heal-failed'])

  // (d) a recovery ends the episode: the next error gets its own grace instead of
  //     inheriting the already-settled heal's clock (the cooldown still paces it).
  const recovered = drive([
    { at: T0, observation: observe('error') },
    { at: healed, observation: observe('error') },
    { at: healed + 1_000, observation: observe('open') },
    { at: healed + 2_000, observation: observe('error') },
    { at: healed + 10_000, observation: observe('error') },
  ])
  // The final tick arms the MANUAL control (the cooldown still blocks the
  // automatic lane, and a human click is its own bound); the latch marker is
  // what must stay unset — a false latch would pin the notice on a fresh episode.
  assert.deepEqual(recovered.notices, [null, null, null, null, 'heal-failed'])
  assert.equal(recovered.state.healFailedLatched, undefined, 'a fresh episode must not inherit the settled heal clock')
  assert.equal(recovered.actions[4], 0, 'the cooldown still paces the new episode')

  // (e) …and the marker is not dropped by the next tick: even past the old settle
  //     window the notice waits for THIS episode's own heal to be judged.
  const newEpisode = drive([
    { at: T0, observation: observe('error') },
    { at: healed, observation: observe('error') },
    { at: healed + 1_000, observation: observe('open') },
    { at: healed + 2_000, observation: observe('error') },
    { at: healed + 10_000, observation: observe('error') },
    { at: healed + S + 2_000, observation: observe('error') },
    { at: healed + C, observation: observe('error') },
    { at: healed + C + S, observation: observe('error') },
  ])
  // Indices 4-5 report the spent/cooling automatic lane (no control exists any
  // more); index 6 is the new episode's own automatic heal (its notice stays null
  // until the heal is judged), index 7 the latch after that heal's settle window.
  // The point: the latch waits for THIS episode's own clock.
  assert.deepEqual(newEpisode.notices,
                   [null, null, null, null, 'heal-failed', 'heal-failed', null, 'heal-failed'])
  assert.equal(newEpisode.actions[6], healed + C, 'the new episode still heals itself')
})

test('stream-health: the latch survives the retry heal\'s own settle window', () => {
  // If the loading state or `markSessionStreamHeal` dropped the latch, the notice
  // would go out for the retry's whole 20s judging window. One tick after the
  // retry must still carry it.
  const healed = T0 + G
  const judged = healed + S
  const retry = healed + C
  const { actions, notices } = drive([
    { at: T0, observation: observe('error') },
    { at: healed, observation: observe('error') },
    { at: judged, observation: observe('error') },
    { at: retry, observation: observe('error') },
    { at: retry + 1_000, observation: observe('error') },
    { at: retry + S - 1, observation: observe('error') },
    { at: retry + S, observation: observe('error') },
  ])
  assert.equal(actions[3], retry, 'the cooldown still fires the retry')
  assert.deepEqual(notices,
                   [null, null, 'heal-failed', 'heal-failed', 'heal-failed', 'heal-failed', 'heal-failed'])
})

test('stream-health: a recovery marker survives a loading dwell (no false latch)', () => {
  // The loading state must carry `recoveredSinceHeal`, otherwise the next error
  // latches off the PREVIOUS episode's settle clock.
  const healed = T0 + G
  const { notices, state } = drive([
    { at: T0, observation: observe('error') },
    { at: healed, observation: observe('error') },
    { at: healed + 1_000, observation: observe('open') },
    { at: healed + 2_000, observation: observe('loading') },
    { at: healed + 3_000, observation: observe('error') },
    { at: healed + S + 3_000, observation: observe('error') },
  ])
  // The last tick reports the cooling automatic lane (no control exists any
  // more); the LATCH marker is what must stay unset — a false latch is the bug.
  assert.deepEqual(notices, [null, null, null, null, null, 'heal-failed'])
  assert.equal(state.healFailedLatched, undefined)
})

test('stream-health: a recovery marker survives a hidden tick (no false latch)', () => {
  // Same shape through `presented === false`.
  const healed = T0 + G
  const { notices, state } = drive([
    { at: T0, observation: observe('error') },
    { at: healed, observation: observe('error') },
    { at: healed + 1_000, observation: observe('open') },
    { at: healed + 2_000, observation: observe('error', { presented: false }) },
    { at: healed + 3_000, observation: observe('error') },
    { at: healed + S + 3_000, observation: observe('error') },
  ])
  assert.deepEqual(notices, [null, null, null, null, null, 'heal-failed'])
  assert.equal(state.healFailedLatched, undefined)
})

test('stream-health: cold and open are inert, and recovery keeps the budget', () => {
  const held: SessionStreamHealthState = { phase: 'error-hold', since: T0, healStamps: [T0 - C] }
  const cold = planAt(held, observe('cold'), T0 + G + S)
  assert.equal(cold.action, 'none')
  assert.equal(cold.notice, null)
  assert.equal(cold.state.phase, 'idle')
  assert.equal(cold.state.healStamps.length, 1)
  const open = planAt(held, observe('open'), T0 + G + S)
  assert.equal(open.notice, null)
  assert.equal(open.state.phase, 'idle')
  assert.equal(open.state.healStamps.length, 1)
  assert.equal(sessionStreamNoticeKey('loading-stall'), 'streamHealth.loadingStall')
  assert.equal(sessionStreamNoticeKey('heal-failed'), 'streamHealth.healFailed')
})

test('stream-health: a hidden surface zeroes every clock (no accumulation while backgrounded)', () => {
  const hidden = drive([
    { at: T0, observation: observe('error', { presented: false }) },
    { at: T0 + 600_000, observation: observe('error', { presented: false }) },
  ])
  assert.equal(hidden.state.phase, 'idle')
  assert.deepEqual(hidden.actions, [0, 0])

  const shown = drive([
    { at: T0, observation: observe('error') },
    { at: T0 + G, observation: observe('error') },
  ])
  assert.equal(shown.actions[1], T0 + G)
})

test('stream-health: presentation is the official mainView retention, not a chamber current mirror', () => {
  const list = (byId: Record<string, { retainedBy?: Readonly<Record<string, number>> }>): SessionsConcreteLoose => ({
    list: { getSnapshot: () => ({ byId }) },
    binding: () => ({ session: { resync: () => {} } }),
  })
  const main = list({ a: { retainedBy: { mainView: 1 } } })
  assert.equal(hasSessionStreamResync(main, 'a'), true, 'the mainView-retained row is the presented target')
  // An id the main view does not retain has no lever from this seat: a
  // sidebar-only retention is not "on stage" for the conversation header.
  const sidebar = list({ a: { retainedBy: { sidebarView: 1 } } })
  assert.equal(hasSessionStreamResync(sidebar, 'a'), false)
  // A zero/negative count is not retention.
  assert.equal(hasSessionStreamResync(list({ a: { retainedBy: { mainView: 0 } } }), 'a'), false)
  // Absent row / absent byId / hostile snapshot: fail closed, never throw.
  assert.equal(hasSessionStreamResync(list({}), 'a'), false)
  assert.equal(hasSessionStreamResync({ list: { getSnapshot: () => ({}) } }, 'a'), false)
  assert.equal(hasSessionStreamResync({
    list: { getSnapshot: () => { throw new Error('shape drift') } },
  }, 'a'), false)
  assert.equal(hasSessionStreamResync(undefined, 'a'), false)
})

test('stream-health: the resync probe reaches the concrete face behind guards and fails closed', async () => {
  let calls = 0
  const resync = (): Promise<void> => { calls += 1; return Promise.resolve() }
  const presented: SessionsConcreteLoose = {
    list: { getSnapshot: () => ({ byId: { a: { retainedBy: { mainView: 1 } } } }) },
    binding: (sessionId: string) => (sessionId === 'a' ? { session: { resync } } : undefined),
  }
  assert.equal(hasSessionStreamResync(presented, 'a'), true)
  assert.equal(resyncSessionStream(presented, 'a'), true)
  assert.equal(calls, 1)
  // A session the main view does not retain is refused by the same presented
  // precondition, and its concrete face is never read.
  const other: SessionsConcreteLoose = {
    list: { getSnapshot: () => ({ byId: { a: { retainedBy: { mainView: 1 } }, b: { retainedBy: {} } } }) },
    binding: () => ({ session: { resync } }),
  }
  assert.equal(hasSessionStreamResync(other, 'b'), false)
  assert.equal(resyncSessionStream(other, 'b'), false)
  assert.equal(calls, 1, 'a non-presented session must not be rebuilt')
  // Address-only subagent selections are presented exactly like catalogued rows:
  // the mainView retention is the whole fact, so listedness gates nothing.
  const addressOnly: SessionsConcreteLoose = {
    list: { getSnapshot: () => ({ byId: { child: { retainedBy: { mainView: 1 } } } }) },
    binding: id => (id === 'child' ? { session: { resync } } : undefined),
  }
  assert.equal(hasSessionStreamResync(addressOnly, 'child'), true)
  assert.equal(resyncSessionStream(addressOnly, 'child'), true, 'an address-only child must be rebuildable')
  assert.equal(calls, 2, 'the address-only child resync must reach the vendor method')
  const masked: SessionsConcreteLoose = {
    list: { getSnapshot: () => { throw new Error('shape drift') } },
    binding: () => ({ session: { resync } }),
  }
  assert.equal(resyncSessionStream(masked, 'a'), false)
  // A face without the rc.2 binding accessor has no concrete entry.
  const noBinding: SessionsLoose = {
    list: { getSnapshot: () => ({ byId: { a: { retainedBy: { mainView: 1 } } } }) },
  }
  assert.equal(hasSessionStreamResync(noBinding, 'a'), false)
  assert.equal(resyncSessionStream(noBinding, 'a'), false)
  // The method's own absence on the Session object (a pin without resync()).
  const noMethod: SessionsConcreteLoose = { ...presented, binding: () => ({ session: {} }) }
  assert.equal(hasSessionStreamResync(noMethod, 'a'), false)
  assert.equal(resyncSessionStream(noMethod, 'a'), false)
  // Wrong shapes and throws are "no lever", never an exception.
  const wrongShape: SessionsConcreteLoose = { ...presented, binding: () => ({ session: null }) }
  assert.equal(hasSessionStreamResync(wrongShape, 'a'), false)
  assert.equal(resyncSessionStream(wrongShape, 'a'), false)
  // A hostile accessor must not escape the guard: the capability read itself can
  // throw, and the whole point is "no lever", never an exception into React.
  const hostileGetter: SessionsConcreteLoose = {
    ...presented,
    binding: () => ({
      session: new Proxy({}, {
        get: () => { throw new Error('hostile resync getter') },
      }) as never,
    }),
  }
  assert.doesNotThrow(() => { assert.equal(hasSessionStreamResync(hostileGetter, 'a'), false) })
  assert.doesNotThrow(() => { assert.equal(resyncSessionStream(hostileGetter, 'a'), false) })
  const missingSession: SessionsConcreteLoose = { ...presented, binding: () => undefined }
  assert.equal(hasSessionStreamResync(missingSession, 'a'), false)
  assert.equal(resyncSessionStream(missingSession, 'a'), false)
  const hostileBinding: SessionsConcreteLoose = { ...presented, binding: () => { throw new Error('shape drift') } }
  assert.equal(hasSessionStreamResync(hostileBinding, 'a'), false)
  assert.equal(resyncSessionStream(hostileBinding, 'a'), false)
  const throwingResync: SessionsConcreteLoose = {
    ...presented,
    binding: () => ({ session: { resync: (): unknown => { calls += 1; throw new Error('reopen blew up') } } }),
  }
  assert.equal(hasSessionStreamResync(throwingResync, 'a'), true, 'the capability exists before the call')
  assert.equal(resyncSessionStream(throwingResync, 'a'), false, 'a synchronous throw degrades to not available')
  // An async rejection is settled by the probe's own catch; an unhandled
  // rejection here would fail this test file under the node runner.
  const rejecting: SessionsConcreteLoose = {
    ...presented,
    binding: () => ({ session: { resync: (): Promise<void> => { calls += 1; return Promise.reject(new Error('reopen rejected')) } } }),
  }
  assert.equal(resyncSessionStream(rejecting, 'a'), true)
  await new Promise(resolve => { setTimeout(resolve, 0) })
  // No face at all is the same "no lever" answer.
  assert.equal(hasSessionStreamResync(undefined, 'a'), false)
  assert.equal(resyncSessionStream(undefined, 'a'), false)
  assert.equal(calls, 4, 'only the ISSUED calls (presented, address-only child, throwing, rejecting) ever reached the method')
})

test('stream-health: the rc.2 binding(id) accessor alone reaches the concrete face', () => {
  // The REAL rc.2 service exposes `binding(id) -> SessionBinding` and no
  // `resolve` at all, so this face has exactly one accessor; the resolve-only
  // rejection is asserted in the accessor test below.
  let calls = 0
  const resync = (): Promise<void> => { calls += 1; return Promise.resolve() }
  const rc2: SessionsConcreteLoose = {
    list: { getSnapshot: () => ({ byId: { a: { retainedBy: { mainView: 1 } } } }) },
    binding: id => (id === 'a'
      ? { session: { resync, openPromise: null, getSnapshot: () => ({ openState: 'loading' }) } }
      : undefined),
  }
  assert.equal(hasSessionStreamResync(rc2, 'a'), true, 'the binding-only rc.2 face must expose the lever')
  assert.equal(sessionOpenState(rc2, 'a'), 'loading', 'the binding-only rc.2 face must expose the open state')
  assert.equal(sessionOpenInFlight(rc2, 'a'), false, 'the binding-only rc.2 face must expose the open promise')
  assert.equal(resyncSessionStream(rc2, 'a'), true)
  assert.equal(calls, 1)
  // A row the main view does not retain is refused BEFORE the accessor runs.
  let consulted = 0
  const notPresented: SessionsConcreteLoose = {
    list: { getSnapshot: () => ({ byId: { b: { retainedBy: { sidebarView: 1 } } } }) },
    binding: () => { consulted += 1; return { session: { resync } } },
  }
  assert.equal(hasSessionStreamResync(notPresented, 'b'), false)
  assert.equal(consulted, 0, 'a non-presented target never reaches the concrete accessor')
})

test('stream-health: binding is the only accessor, and a throwing accessor fails closed', () => {
  const consulted: string[] = []
  const rc2: SessionsConcreteLoose = {
    list: { getSnapshot: () => ({ byId: { a: { retainedBy: { mainView: 1 } } } }) },
    binding: () => { consulted.push('binding'); return { session: { resync: () => {} } } },
  }
  assert.equal(hasSessionStreamResync(rc2, 'a'), true)
  assert.deepEqual(consulted, ['binding'])
  // A throwing binding is a drifted face: fail closed, never a fallback.
  const broken: SessionsConcreteLoose = { ...rc2, binding: () => { throw new Error('drift') } }
  assert.equal(hasSessionStreamResync(broken, 'a'), false)
  assert.equal(sessionOpenInFlight(broken, 'a'), undefined)
  assert.equal(resyncSessionStream(broken, 'a'), false)
  // Reverse assertion: the removed pre-rc.2 private resolve(id) is NOT an
  // accessor, so a fake carrying only it has no lever at all.
  const legacyOnly = {
    list: { getSnapshot: () => ({ byId: { a: { retainedBy: { mainView: 1 } } } }) },
    resolve: () => ({ session: { resync: () => {} } }),
  }
  assert.equal(hasSessionStreamResync(legacyOnly, 'a'), false, 'a resolve-only fake is not a face')
  assert.equal(sessionOpenState(legacyOnly, 'a'), undefined)
  assert.equal(resyncSessionStream(legacyOnly, 'a'), false)
})


test('stream-health: open liveness is tri-state, and only "nothing pending" is true evidence', () => {
  const pending = Promise.resolve()
  const concrete: SessionsConcreteLoose = {
    list: { getSnapshot: () => ({ byId: { a: { retainedBy: { mainView: 1 } } } }) },
    binding: id => (id === 'a' ? { session: { resync: () => {}, openPromise: pending } } : undefined),
  }
  assert.equal(sessionOpenInFlight(concrete, 'a'), true, 'a pending open is in flight')
  const idle: SessionsConcreteLoose = { ...concrete, binding: () => ({ session: { resync: () => {}, openPromise: null } }) }
  assert.equal(sessionOpenInFlight(idle, 'a'), false, 'a null openPromise with the state on loading is the parked window')
  // A missing member is UNKNOWN, never "nothing pending": a renamed field must not
  // let the ladder destroy an open that is still in flight.
  const drifted: SessionsConcreteLoose = { ...concrete, binding: () => ({ session: { resync: () => {} } }) }
  assert.equal(sessionOpenInFlight(drifted, 'a'), undefined)
  // Not the current session, no concrete face, a hostile accessor: unknown.
  const other: SessionsConcreteLoose = { ...concrete, binding: () => ({ session: { openPromise: null } }) }
  assert.equal(sessionOpenInFlight(other, 'b'), undefined)
  assert.equal(sessionOpenInFlight(undefined, 'a'), undefined)
  const noBinding: SessionsLoose = { list: { getSnapshot: () => ({ byId: { a: { retainedBy: { mainView: 1 } } } }) } }
  assert.equal(sessionOpenInFlight(noBinding, 'a'), undefined)
  const hostile: SessionsConcreteLoose = {
    ...concrete,
    binding: () => ({ session: new Proxy({}, { get: () => { throw new Error('hostile openPromise getter') } }) as never }),
  }
  assert.doesNotThrow(() => { assert.equal(sessionOpenInFlight(hostile, 'a'), undefined) })
  // ONLY an exactly-null own member is positive evidence: an empty slot is
  // UNKNOWN and must fail closed, or a renamed slot would let the automatic arm
  // rebuild an in-flight open.
  const undefinedMember: SessionsConcreteLoose = { ...concrete, binding: () => ({ session: { openPromise: undefined } }) }
  assert.equal(sessionOpenInFlight(undefinedMember, 'a'), undefined)
})

test('page recovery reads only the presented concrete session and rejects unknown states', () => {
  const sessions: SessionsConcreteLoose = {
    list: { getSnapshot: () => ({ byId: { a: { retainedBy: { mainView: 1 } }, b: { retainedBy: {} } } }) },
    binding: id => ({ session: { getSnapshot: () => ({ openState: id === 'a' ? 'loading' : 'open' }) } }),
  }
  assert.equal(sessionOpenState(sessions, 'a'), 'loading')
  assert.equal(sessionOpenState(sessions, 'b'), undefined, 'a hidden session must not drive the visible recovery surface')
  const unknownState: SessionsConcreteLoose = { ...sessions, binding: () => ({ session: { getSnapshot: () => ({ openState: 'invented' }) } }) }
  const staleScope: SessionsConcreteLoose = { ...sessions, binding: () => { throw new Error('stale scope') } }
  assert.equal(sessionOpenState(unknownState, 'a'), undefined)
  assert.equal(sessionOpenState(staleScope, 'a'), undefined)
})

test('stream-health: surface presentation is the official chat column on a visible page', () => {
  const flow = { querySelector: (selector: string) => (selector === '[data-chat-flow]' ? {} : null) }
  assert.equal(isConversationSurfacePresented({ visibilityState: 'visible', ...flow }), true)
  assert.equal(isConversationSurfacePresented({ visibilityState: 'hidden', ...flow }), false)
  assert.equal(isConversationSurfacePresented({ visibilityState: 'visible', querySelector: () => null }), false)
  assert.equal(isConversationSurfacePresented(null), false)
  assert.equal(isConversationSurfacePresented(undefined), false)
})

test('stream-health: every notice key exists in both dictionaries', () => {
  // The four notices the ladder can return and the four fixed chip labels must
  // have copy in both dictionaries. The mapping itself is pinned above; this pins
  // that the mapped key RESOLVES, so a helper rename can never ship a raw key.
  for (const key of [
    'streamHealth.label', 'streamHealth.healing', 'streamHealth.loadingStall', 'streamHealth.loadingFailed',
    'streamHealth.healFailed',
  ]) {
    assert.equal(typeof (zh as Record<string, string>)[key], 'string', 'zh is missing ' + key)
    assert.equal(typeof (en as Record<string, string>)[key], 'string', 'en is missing ' + key)
  }
})

test('stream-health: a terminal opening fact fails the load now, with no action to take', () => {
  // The evidence outranks the stall timer: the notice lands on the FIRST tick,
  // and no control is offered — a loading face has no
  // automatic arm here (this seat never re-issues an open on its own).
  const budget = planAt(createSessionStreamHealthState(), observe('loading', { openingFailure: 'budget-exhausted' }), T0)
  assert.equal(budget.notice, 'loading-failed', 'the terminal outcome IS the failure notice')
  assert.equal(budget.action, 'none')
  assert.notEqual(budget.action, 'heal', 'a proven-dead opening is never re-issued automatically')
  assert.equal(sessionStreamNoticeKey('loading-failed'), 'streamHealth.loadingFailed')
  const orphaned = planAt(createSessionStreamHealthState(), observe('loading', { openingFailure: 'orphaned' }), T0)
  assert.equal(orphaned.notice, 'loading-failed')
  assert.equal(orphaned.action, 'none')
  // No reachable concrete face: the failure is still shown; nothing is invented.
  const noFace = planAt(
    createSessionStreamHealthState(),
    observe('loading', { openingFailure: 'budget-exhausted', resyncAvailable: false }), T0,
  )
  assert.equal(noFace.notice, 'loading-failed')
  assert.equal(noFace.action, 'none')
})

test('stream-health: loading without opening evidence keeps the pinned timer behaviour', () => {
  // (b) no evidence: exactly today's arm — no notice, no action, until the
  // stall hold ages; the in-flight shape stays protected by the same silence.
  const hold = planAt(createSessionStreamHealthState(), observe('loading'), T0)
  assert.equal(hold.notice, null, 'no notice on the first frame')
  assert.equal(hold.action, 'none', 'no action before the stall hold ages')
  const beforeStall = planAt(hold.state, observe('loading'), T0 + L - 1)
  assert.equal(beforeStall.notice, null)
  assert.equal(beforeStall.action, 'none')
  // The concurrency/multi-instance shape the seat passes: a live concrete face
  // and no evidence is still "wait", never an automatic rebuild.
  assert.equal(planAt(createSessionStreamHealthState(), observe('loading', { resyncAvailable: true }), T0).action, 'none')
})

test('stream-health: opening evidence never touches the error arm', () => {
  // (c) the error path is untouched by the new evidence field: the automatic
  // heal still fires on its own grace.
  const hold = planAt(createSessionStreamHealthState(), observe('error', { openingFailure: 'orphaned' }), T0)
  assert.equal(hold.action, 'none')
  const healed = planAt(hold.state, observe('error', { openingFailure: 'orphaned' }), T0 + G)
  assert.equal(healed.action, 'heal')
  assert.equal(healed.notice, null)
})

test('response forensics: unknown kinds and drifted shapes are ignored, never recorded', () => {
  // (d) an old bundle (no opening kinds) or a drifted fact must never throw and
  // must never change behaviour: the ledger simply stays empty.
  const ledger = sessionOpeningFailureLedger()
  for (const detail of [
    null, undefined, 0, 'opening-budget-exhausted', {},
    { kind: 'opening-timeout', instanceId: 'ignored', sessionId: 's', at: T0 },
    // The fork's non-terminal rung diagnostic: it must never fail a loading seat.
    { kind: 'opening-miss', instanceId: 'ignored', sessionId: 's', at: T0 },
    { kind: 'socket-lost', instanceId: 'ignored', at: T0 },
    { kind: 'invented-kind', instanceId: 'ignored', at: T0 },
  ]) {
    assert.doesNotThrow(() => { ledger.record(detail) })
    assert.equal(parseSessionOpeningOutcome(detail), null)
  }
  assert.equal(ledger.failureFor('ignored', 's'), undefined, 'an unknown kind records no evidence')
})

test('response forensics: ANY acceptance retires the unattributed instance fallback', () => {
  // The fallback is a guess at which session an unattributed fact belonged to. Once
  // the carrier demonstrably answers again (some session accepted), keeping the guess
  // would fail an unrelated session that is merely loading (review finding 5/O4).
  const ledger = sessionOpeningFailureLedger()
  ledger.record({ kind: 'opening-budget-exhausted', instanceId: 'inst-fallback', at: T0 })
  assert.equal(ledger.failureFor('inst-fallback', 'unrelated', T0 + 1)?.failure, 'budget-exhausted')
  ledger.record({ kind: 'opening-accepted', instanceId: 'inst-fallback', sessionId: 'somebody', at: T0 + 2 })
  assert.equal(ledger.failureFor('inst-fallback', 'unrelated', T0 + 3), undefined,
    'an attributed acceptance retires the coarse instance fallback too')
})

test('response forensics: the probe listens on the fork event name, spelled identically', () => {
  // The probe cannot import the fork at bundle time (a client plugin must not
  // deepen a path into it), so the literal is duplicated on purpose and pinned
  // here against the fork's own export — a silent rename must not disable the
  // whole evidence channel.
  const fork = stripComments(readFileSync(
    new URL('../../../dsh-api-gateway/src/client/stream-forensics.ts', import.meta.url), 'utf8'))
  const probe = stripComments(readFileSync(
    new URL('../../src/client/session-stream-health-probe.ts', import.meta.url), 'utf8'))
  const forkEvent = /export const STREAM_FORENSICS_EVENT = '([^']+)'/u.exec(fork)
  const probeEvent = /const STREAM_FORENSICS_EVENT = '([^']+)'/u.exec(probe)
  assert.ok(forkEvent !== null, 'the fork must export the page event name')
  assert.equal(probeEvent?.[1], forkEvent[1], 'the probe must listen on the fork event, spelled identically')
})

test('response forensics: a terminal fact is read per session and retired by accepted', () => {
  const ledger = sessionOpeningFailureLedger()
  let woke = 0
  const unsubscribe = ledger.subscribe(() => { woke += 1 })
  assert.equal(
    parseSessionOpeningOutcome({ kind: 'opening-budget-exhausted', instanceId: 'inst', sessionId: 's1', at: T0 })?.outcome,
    'budget-exhausted',
  )
  ledger.record({ kind: 'opening-budget-exhausted', instanceId: 'inst', sessionId: 's1', at: T0 })
  assert.equal(ledger.failureFor('inst', 's1', T0 + 3)?.failure, 'budget-exhausted')
  assert.equal(ledger.failureFor('inst', 's2', T0 + 3), undefined, 'an attributed fact covers only its session')
  assert.equal(ledger.failureFor('other', 's1', T0 + 3), undefined, 'another instance is never covered')
  // A fact older than the whole ladder describes an episode that is over: a seat
  // that starts loading now must not inherit it (no accepted fact ever arrived).
  assert.equal(ledger.failureFor('inst', 's1', T0 + LADDER_TOTAL + 1), undefined,
    'a terminal fact expires with the ladder that produced it')
  assert.ok(woke >= 1, 'a recorded fact wakes the visible seats')
  // An unattributed fact is instance-wide: the presented loading session is the
  // only page-visible candidate.
  ledger.record({ kind: 'opening-orphaned', instanceId: 'inst', at: T0 + 1 })
  assert.equal(ledger.failureFor('inst', 's2', T0 + 3)?.failure, 'orphaned')
  // An accepted opening retires the instance-level fallback; the attributed
  // session's own fact is retired by an attributed acceptance.
  ledger.record({ kind: 'opening-accepted', instanceId: 'inst', at: T0 + 2 })
  assert.equal(ledger.failureFor('inst', 's2', T0 + 3), undefined, 'accepted retires the instance fallback')
  assert.equal(ledger.failureFor('inst', 's1', T0 + 3)?.failure, 'budget-exhausted', 'the exact fact survives an unattributed acceptance')
  ledger.record({ kind: 'opening-accepted', instanceId: 'inst', sessionId: 's1', at: T0 + 3 })
  assert.equal(ledger.failureFor('inst', 's1', T0 + 4), undefined)
  unsubscribe()
  assert.equal(parseSessionOpeningOutcome({ kind: 'opening-accepted', instanceId: 'inst' })?.at, 0,
    'a fact without a time is accepted with a zero stamp')
  // ...and an UNDATED failure fact is taken at face value: the freshness window may only
  // expire evidence it can actually date (an older/channel-lite bundle keeps its meaning).
  ledger.record({ kind: 'opening-budget-exhausted', instanceId: 'inst-undated', sessionId: 's', at: 0 })
  assert.equal(ledger.failureFor('inst-undated', 's', T0)?.failure, 'budget-exhausted')
})
