/**
 * SESSION STREAM-HEALTH LADDER LOCKS (design 14 §D4).
 *
 * The defect (carrier losses latching `openState='error'` ⇒ a frozen transcript)
 * is recovered by exactly three effects, all pinned here: the automatic stage
 * move for an `'error'` session, the notice-plus-reload arm for a parked
 * `'loading'` open, and the USER-triggered per-session `resync` the
 * loading-stall arm ARMS (the concrete
 * `Session.resync()` the pinned controller ships off-contract, reached through
 * the guarded structural slice). Assertions live at the decision boundary (pure
 * module) and the effect boundary (a fake sessions face), including the edges
 * that must stay pinned: the settle window, a backwards wall clock,
 * the rolling-window edge, the cross-phase hold, both first-notice timestamps
 * and the hidden stretch that must NOT hand back a fresh storm budget.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
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
import { en, zh } from '../../src/locales.ts'
import {
  hasHealNeighbor,
  hasHealRoute,
  hasSessionStreamResync,
  healSessionStream,
  isConversationSurfacePresented,
  pickHealNeighbor,
  previousPresented,
  rememberPresented,
  resyncSessionStream,
  sessionOpenState,
  sessionOpenInFlight,
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

/** planSessionStreamHealth bound to the pinned case-invariant config. */
function planAt(state: SessionStreamHealthState, observation: SessionStreamObservation, at: number) {
  return planSessionStreamHealth(state, observation, at, CONFIG)
}

function observe(openState: SessionStreamObservation['openState'], over: Partial<SessionStreamObservation> = {}): SessionStreamObservation {
  return { openState, presented: true, neighborAvailable: true, ...over }
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
    { at: T0 + 1_000, observation: observe('loading') },
    { at: T0 + 25_000, observation: observe('loading') },
    { at: T0 + 26_000, observation: observe('error') },
    { at: T0 + 33_999, observation: observe('error') },
    { at: T0 + 34_000, observation: observe('error') },
  ])
  assert.deepEqual(actions, [0, 0, 0, 0, 0, T0 + 34_000])
  assert.deepEqual(notices, [null, null, 'loading-stall', null, null, null])
})

test('stream-health: the resync lever is armed only by a loading stall with a live concrete face', () => {
  // The hold must AGE first, exactly like the stall notice it rides with: the
  // control is never offered on the first frame of a load.
  const hold = planAt(createSessionStreamHealthState(), observe('loading', { resyncAvailable: true }), T0)
  assert.equal(hold.action, 'none')
  assert.equal(hold.notice, null)
  const stalled = planAt(hold.state, observe('loading', { resyncAvailable: true }), T0 + L)
  assert.equal(stalled.action, 'resync')
  assert.equal(stalled.notice, 'loading-stall', 'the reload arm keeps its own notice')
  // Fail-closed on a build without the concrete face: the SAME stall with no
  // observed availability arms nothing (and the reload arm is untouched).
  const unavailable = planAt(hold.state, observe('loading'), T0 + L)
  assert.equal(unavailable.action, 'none')
  assert.equal(unavailable.notice, 'loading-stall')
  // Never in the error arm (that arm has its own automatic heal)…
  const errorHold = planAt(createSessionStreamHealthState(), observe('error', { resyncAvailable: true }), T0)
  const error = planAt(errorHold.state, observe('error', { resyncAvailable: true }), T0 + G)
  assert.equal(error.action, 'heal')
  // …and never for a cold or healthy stream, even with the face present.
  assert.equal(planAt(createSessionStreamHealthState(), observe('cold', { resyncAvailable: true }), T0 + L).action, 'none')
  assert.equal(planAt(createSessionStreamHealthState(), observe('open', { resyncAvailable: true }), T0 + L).action, 'none')
  // A churn fact on an open stream is informational: still no rebuild arm.
  assert.equal(
    planAt(createSessionStreamHealthState(), observe('open', { resyncAvailable: true, carrierChurn: { at: T0, count: 1 } }), T0).action,
    'none',
  )
})

test('stream-health: an error state the stage move must refuse arms the user resync control instead', () => {
  // An address-only subagent selection: current, absent from ids, so the seat
  // reports no stage route (neighborAvailable false) while the concrete resync
  // face is live. The arm is USER-executed and grace-aged exactly like the heal.
  const hold = planAt(createSessionStreamHealthState(), observe('error', { neighborAvailable: false, resyncAvailable: true }), T0)
  assert.equal(hold.action, 'none', 'an error is never made worse by acting on its first frame')
  const armed = planAt(hold.state, observe('error', { neighborAvailable: false, resyncAvailable: true }), T0 + G)
  assert.equal(armed.action, 'resync')
  // The chip renders controls only alongside a notice, so an armed rebuild MUST
  // carry one (action='resync' + notice=null would render neither the rebuild
  // button nor the reload fallback).
  assert.equal(armed.notice, 'heal-failed')
  // Fail-closed without the concrete face: the same hold only reports the reload
  // notice once it has outlived a repair attempt, and never invents an action.
  const noFace = planAt(hold.state, observe('error', { neighborAvailable: false }), T0 + G)
  assert.equal(noFace.action, 'none')
  assert.equal(noFace.notice, null)
  const drained = planAt(noFace.state, observe('error', { neighborAvailable: false }), T0 + G + S)
  assert.equal(drained.action, 'none')
  assert.equal(drained.notice, 'heal-failed', 'no lever at all is reported, not hidden')
  // With a route the automatic stage move keeps precedence over the manual control.
  const routedHold = planAt(createSessionStreamHealthState(), observe('error', { resyncAvailable: true }), T0)
  const routed = planAt(routedHold.state, observe('error', { resyncAvailable: true }), T0 + G)
  assert.equal(routed.action, 'heal')
})

test('stream-health: loading only arms a manual rebuild, independent of the error-heal ledger', () => {
  const hold = planAt(createSessionStreamHealthState(), observe('loading', { resyncAvailable: true }), T0)
  assert.equal(hold.action, 'none', 'the hold must age first, exactly like the stall notice')
  const armed = planAt(hold.state, observe('loading', { resyncAvailable: true }), T0 + L)
  assert.equal(armed.action, 'resync')
  assert.equal(armed.notice, 'loading-stall')
  const spent: SessionStreamHealthState = { phase: 'loading-hold', since: T0, healStamps: [T0, T0 + 1_000, T0 + 2_000] }
  assert.equal(planAt(spent, observe('loading', { resyncAvailable: true }), T0 + L).action, 'resync')
  const noFace = planAt(hold.state, observe('loading'), T0 + L)
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
  assert.equal(before.action, 'none')
  assert.equal(before.notice, 'heal-failed')
  const exactly = planAt(stamped, observe('error'), T0 + W)
  assert.equal(exactly.state.healStamps.length, 2)
  assert.equal(exactly.action, 'heal')
})

test('stream-health: both arms report their reload notice at the exact tick the levers run out', () => {
  // No neighbor: the notice lands at grace + settle.
  const { notices } = drive([
    { at: T0, observation: observe('error', { neighborAvailable: false }) },
    { at: T0 + G + S - 1, observation: observe('error', { neighborAvailable: false }) },
    { at: T0 + G + S, observation: observe('error', { neighborAvailable: false }) },
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

  // (b) once latched, a later loading dwell never takes the button back.
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
  assert.deepEqual(recovered.notices, [null, null, null, null, null])
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
  assert.deepEqual(newEpisode.notices,
                   [null, null, null, null, null, null, null, 'heal-failed'])
  assert.equal(newEpisode.actions[6], healed + C, 'the new episode still heals itself')
})

test('stream-health: the latch survives the retry heal\'s own settle window', () => {
  // If the loading state or `markSessionStreamHeal` dropped the latch, the button
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
  const { notices } = drive([
    { at: T0, observation: observe('error') },
    { at: healed, observation: observe('error') },
    { at: healed + 1_000, observation: observe('open') },
    { at: healed + 2_000, observation: observe('loading') },
    { at: healed + 3_000, observation: observe('error') },
    { at: healed + S + 3_000, observation: observe('error') },
  ])
  assert.deepEqual(notices, [null, null, null, null, null, null])
})

test('stream-health: a recovery marker survives a hidden tick (no false latch)', () => {
  // Same shape through `presented === false`.
  const healed = T0 + G
  const { notices } = drive([
    { at: T0, observation: observe('error') },
    { at: healed, observation: observe('error') },
    { at: healed + 1_000, observation: observe('open') },
    { at: healed + 2_000, observation: observe('error', { presented: false }) },
    { at: healed + 3_000, observation: observe('error') },
    { at: healed + S + 3_000, observation: observe('error') },
  ])
  assert.deepEqual(notices, [null, null, null, null, null, null])
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

test('stream-health: the neighbour choice never picks the target and degrades predictably', () => {
  assert.equal(pickHealNeighbor(['a', 'b', 'c'], 'b'), 'a')
  assert.equal(pickHealNeighbor(['a', 'b', 'c'], 'b', 'c'), 'c')
  // A preference that is gone, or that IS the target, falls back to the first
  // other id — the heal must never lose its detour silently.
  assert.equal(pickHealNeighbor(['a', 'b'], 'b', 'b'), 'a')
  assert.equal(pickHealNeighbor(['a', 'b'], 'b', 'zz'), 'a')
  assert.equal(pickHealNeighbor(['only'], 'only'), undefined)
  assert.equal(pickHealNeighbor([], 'only'), undefined)
  assert.equal(hasHealNeighbor(['only'], 'only'), false)
  assert.equal(hasHealNeighbor(['only', 'other'], 'only'), true)
})

test('stream-health: the stage move visits a neighbour first, and only for a current, listed target', () => {
  const calls: string[] = []
  const sessions: SessionsLoose = {
    list: { getSnapshot: () => ({ ids: ['a', 'b', 'c'], current: 'b' }) },
    open: (id: string) => { calls.push(id) },
  }
  assert.equal(healSessionStream(sessions, 'b'), true)
  assert.deepEqual(calls, ['a', 'b'])
  // The preferred (previously presented) neighbour wins when it is still listed.
  calls.length = 0
  assert.equal(healSessionStream(sessions, 'b', 'c'), true)
  assert.deepEqual(calls, ['c', 'b'])
  // A preference that is gone or is the target itself degrades to any other id.
  calls.length = 0
  assert.equal(healSessionStream(sessions, 'b', 'b'), true)
  assert.deepEqual(calls, ['a', 'b'])
  // PRECONDITION: the detour is only reversible while the
  // target is the CURRENT, LISTED session. Everything else refuses — an
  // address-only child would lose its scope to pruneScopes(), and a masked gap
  // would strand the user on the neighbour.
  calls.length = 0
  const onOther: SessionsLoose = { list: { getSnapshot: () => ({ ids: ['a', 'b'], current: 'a' }) }, open: id => { calls.push(id) } }
  assert.equal(healSessionStream(onOther, 'b'), false)
  const masked: SessionsLoose = { list: { getSnapshot: () => ({ ids: ['a', 'b'] }) }, open: id => { calls.push(id) } }
  assert.equal(healSessionStream(masked, 'b'), false)
  const addressOnly: SessionsLoose = { list: { getSnapshot: () => ({ ids: ['a'], current: 'child' }) }, open: id => { calls.push(id) } }
  assert.equal(healSessionStream(addressOnly, 'child'), false)
  assert.deepEqual(calls, [])
})

test('stream-health: the heal is a no-op without a face or a second session, and never throws', () => {
  assert.equal(healSessionStream(undefined, 'only'), false)
  const solo: SessionsLoose = {
    list: { getSnapshot: () => ({ ids: ['only'], current: 'only' }) },
    open: () => { throw new Error('must not open') },
  }
  assert.equal(healSessionStream(solo, 'only'), false)
  const hostile: SessionsLoose = {
    list: { getSnapshot: () => ({ ids: ['a', 'b'], current: 'b' }) },
    open: () => { throw new Error('framework blew up') },
  }
  assert.equal(healSessionStream(hostile, 'b'), false)
  const drifting: SessionsLoose = {
    list: { getSnapshot: () => { throw new Error('shape drift') } },
    open: () => { throw new Error('must not open') },
  }
  assert.equal(healSessionStream(drifting, 'b'), false)
})

test('stream-health: the stage move is only offered when its target is current, listed and has a neighbour', () => {
  const currentListed: SessionsLoose = { list: { getSnapshot: () => ({ ids: ['a', 'b'], current: 'b' }) }, open: () => {} }
  assert.equal(hasHealRoute(currentListed, 'b'), true)
  // An address-only subagent selection: current but absent from ids. The move must
  // refuse it, so it must not look like it has a route (otherwise the ledger is
  // spent on guaranteed refusals).
  const addressOnly: SessionsLoose = { list: { getSnapshot: () => ({ ids: ['a'], current: 'child' }) }, open: () => {} }
  assert.equal(hasHealRoute(addressOnly, 'child'), false)
  // Not current, no other listed session, or a throwing snapshot: no route.
  const notCurrent: SessionsLoose = { list: { getSnapshot: () => ({ ids: ['a', 'b'], current: 'a' }) }, open: () => {} }
  assert.equal(hasHealRoute(notCurrent, 'b'), false)
  const solo: SessionsLoose = { list: { getSnapshot: () => ({ ids: ['only'], current: 'only' }) }, open: () => {} }
  assert.equal(hasHealRoute(solo, 'only'), false)
  const throwing: SessionsLoose = { list: { getSnapshot: () => { throw new Error('shape drift') } }, open: () => {} }
  assert.equal(hasHealRoute(throwing, 'a'), false)
  assert.equal(hasHealRoute(undefined, 'a'), false)
})

test('stream-health: the resync probe reaches the concrete face behind guards and fails closed', async () => {
  let calls = 0
  let opened = 0
  const resync = (): Promise<void> => { calls += 1; return Promise.resolve() }
  const concrete: SessionsConcreteLoose = {
    list: { getSnapshot: () => ({ ids: ['a', 'b'], current: 'a' }) },
    open: () => { opened += 1; throw new Error('the resync lever must never move the stage') },
    resolve: (sessionId: string) => (sessionId === 'a' ? { session: { resync } } : undefined),
  }
  assert.equal(hasSessionStreamResync(concrete, 'a'), true)
  assert.equal(resyncSessionStream(concrete, 'a'), true)
  assert.equal(calls, 1)
  assert.equal(opened, 0)
  // A session that is not the CURRENT, LISTED one is refused by the same
  // precondition the stage move uses, and its concrete face is never read.
  const other: SessionsConcreteLoose = {
    list: { getSnapshot: () => ({ ids: ['a', 'b'], current: 'a' }) },
    open: () => {},
    resolve: () => ({ session: { resync } }),
  }
  assert.equal(hasSessionStreamResync(other, 'b'), false)
  assert.equal(resyncSessionStream(other, 'b'), false)
  assert.equal(calls, 1, 'a non-current session must not be rebuilt')
  // Address-only subagent selections are CURRENT but absent from ids; the stage
  // move must refuse them, yet the concrete per-session resync is exactly their
  // lever, so listedness must NOT gate this read.
  const addressOnlyCurrent: SessionsConcreteLoose = {
    list: { getSnapshot: () => ({ ids: ['a'], current: 'child' }) },
    open: () => {},
    resolve: id => (id === 'child' ? { session: { resync } } : undefined),
  }
  assert.equal(hasSessionStreamResync(addressOnlyCurrent, 'child'), true)
  assert.equal(resyncSessionStream(addressOnlyCurrent, 'child'), true, 'an address-only child must be rebuildable')
  assert.equal(calls, 2, 'the address-only child resync must reach the vendor method')
  const masked: SessionsConcreteLoose = {
    list: { getSnapshot: () => ({ ids: ['a', 'b'] }) },
    open: () => {},
    resolve: () => ({ session: { resync } }),
  }
  assert.equal(resyncSessionStream(masked, 'a'), false)
  // A build without the concrete services method (a face that predates it).
  const noResolve: SessionsLoose = {
    list: { getSnapshot: () => ({ ids: ['a'], current: 'a' }) },
    open: () => {},
  }
  assert.equal(hasSessionStreamResync(noResolve, 'a'), false)
  assert.equal(resyncSessionStream(noResolve, 'a'), false)
  // The method's own absence on the Session object (a pin without resync()).
  const noMethod: SessionsConcreteLoose = { ...concrete, resolve: () => ({ session: {} }) }
  assert.equal(hasSessionStreamResync(noMethod, 'a'), false)
  assert.equal(resyncSessionStream(noMethod, 'a'), false)
  // Wrong shapes and throws are "no lever", never an exception.
  const wrongShape: SessionsConcreteLoose = { ...concrete, resolve: () => ({ session: null }) }
  assert.equal(hasSessionStreamResync(wrongShape, 'a'), false)
  assert.equal(resyncSessionStream(wrongShape, 'a'), false)
  // A hostile accessor must not escape the guard: the capability read itself can
  // throw, and the whole point is "no lever", never an exception into React.
  const hostileGetter: SessionsConcreteLoose = {
    ...concrete,
    resolve: () => ({
      session: new Proxy({}, {
        get: () => { throw new Error('hostile resync getter') },
      }) as never,
    }),
  }
  assert.doesNotThrow(() => { assert.equal(hasSessionStreamResync(hostileGetter, 'a'), false) })
  assert.doesNotThrow(() => { assert.equal(resyncSessionStream(hostileGetter, 'a'), false) })
  const missingSession: SessionsConcreteLoose = { ...concrete, resolve: () => undefined }
  assert.equal(hasSessionStreamResync(missingSession, 'a'), false)
  assert.equal(resyncSessionStream(missingSession, 'a'), false)
  const hostileResolve: SessionsConcreteLoose = { ...concrete, resolve: () => { throw new Error('shape drift') } }
  assert.equal(hasSessionStreamResync(hostileResolve, 'a'), false)
  assert.equal(resyncSessionStream(hostileResolve, 'a'), false)
  const throwingResync: SessionsConcreteLoose = {
    ...concrete,
    resolve: () => ({ session: { resync: (): unknown => { calls += 1; throw new Error('reopen blew up') } } }),
  }
  assert.equal(hasSessionStreamResync(throwingResync, 'a'), true, 'the capability exists before the call')
  assert.equal(resyncSessionStream(throwingResync, 'a'), false, 'a synchronous throw degrades to not available')
  // An async rejection is settled by the probe's own catch; an unhandled
  // rejection here would fail this test file under the node runner.
  const rejecting: SessionsConcreteLoose = {
    ...concrete,
    resolve: () => ({ session: { resync: (): Promise<void> => { calls += 1; return Promise.reject(new Error('reopen rejected')) } } }),
  }
  assert.equal(resyncSessionStream(rejecting, 'a'), true)
  await new Promise(resolve => { setTimeout(resolve, 0) })
  // No face at all is the same "no lever" answer.
  assert.equal(hasSessionStreamResync(undefined, 'a'), false)
  assert.equal(resyncSessionStream(undefined, 'a'), false)
  assert.equal(calls, 4, 'only the ISSUED calls (concrete, address-only child, throwing, rejecting) ever reached the method')
})

test('stream-health: the detour prefers the session the user came from, capped and deduped', () => {
  let presented: readonly string[] = []
  presented = rememberPresented(presented, 'a')
  presented = rememberPresented(presented, 'b')
  presented = rememberPresented(presented, 'a')
  assert.deepEqual([...presented], ['a', 'b'])
  assert.equal(previousPresented(presented, 'a'), 'b')
  assert.equal(previousPresented(presented, 'b'), 'a')
  assert.equal(previousPresented(['only'], 'only'), undefined)
  let many: readonly string[] = []
  for (const id of ['a', 'b', 'c', 'd', 'e']) many = rememberPresented(many, id, 3)
  assert.deepEqual([...many], ['e', 'd', 'c'])
})

test('stream-health: a recent carrier-churn fact surfaces the reconnecting notice and expires on its own', () => {
  const state = createSessionStreamHealthState()
  const fresh = planAt(state, observe('open', { carrierChurn: { at: T0, count: 2 } }), T0)
  assert.equal(fresh.notice, 'carrier-churn')
  assert.equal(fresh.action, 'none', 'churn must never be answered with a heal')
  assert.equal(fresh.state.phase, 'idle', 'the notice must not age a ladder phase')
  assert.equal(sessionStreamNoticeKey('carrier-churn'), 'streamHealth.carrierChurn')
  assert.equal(planAt(state, observe('open', { carrierChurn: { at: T0, count: 2 } }), T0 + CONFIG.carrierChurnMs).notice,
    'carrier-churn', 'the window is inclusive at its edge')
  assert.equal(planAt(state, observe('open', { carrierChurn: { at: T0, count: 2 } }), T0 + CONFIG.carrierChurnMs + 1).notice,
    null, 'the notice must expire without another fact')
  assert.equal(planAt(state, observe('open', { carrierChurn: { at: T0, count: 0 } }), T0).notice, null,
    'a zero count is not churn')
  assert.equal(planAt(state, observe('open'), T0).notice, null, 'no fact, no notice')
})

test('stream-health: churn never overrides the error or loading arms', () => {
  const churn = { at: T0, count: 3 }
  // Both arms need their hold to AGE first (the notice is never handed out on the
  // first frame), so each case steps twice — churn must not shortcut either.
  const errorHold = planAt(
    createSessionStreamHealthState(), observe('error', { neighborAvailable: false, carrierChurn: churn }), T0,
  )
  const errored = planAt(
    errorHold.state, observe('error', { neighborAvailable: false, carrierChurn: churn }), T0 + G + CONFIG.healSettleMs,
  )
  assert.equal(errored.notice, 'heal-failed', 'the hopeless arm owns the notice while the open state is error')
  const loadingHold = planAt(createSessionStreamHealthState(), observe('loading', { carrierChurn: churn }), T0)
  const loading = planAt(loadingHold.state, observe('loading', { carrierChurn: churn }), T0 + CONFIG.loadingStallMs)
  assert.equal(loading.notice, 'loading-stall', 'the stall arm owns the notice while the open state is loading')
})

test('stream-health: open liveness is tri-state, and only "nothing pending" is true evidence', () => {
  const pending = Promise.resolve()
  const concrete: SessionsConcreteLoose = {
    list: { getSnapshot: () => ({ ids: ['a', 'b'], current: 'a' }) },
    open: () => {},
    resolve: id => (id === 'a' ? { session: { resync: () => {}, openPromise: pending } } : undefined),
  }
  assert.equal(sessionOpenInFlight(concrete, 'a'), true, 'a pending open is in flight')
  const idle: SessionsConcreteLoose = { ...concrete, resolve: () => ({ session: { resync: () => {}, openPromise: null } }) }
  assert.equal(sessionOpenInFlight(idle, 'a'), false, 'a null openPromise with the state on loading is the parked window')
  // A missing member is UNKNOWN, never "nothing pending": a renamed field must not
  // let the ladder destroy an open that is still in flight.
  const drifted: SessionsConcreteLoose = { ...concrete, resolve: () => ({ session: { resync: () => {} } }) }
  assert.equal(sessionOpenInFlight(drifted, 'a'), undefined)
  // Not the current session, no concrete face, a hostile accessor: unknown.
  const other: SessionsConcreteLoose = { ...concrete, resolve: () => ({ session: { openPromise: null } }) }
  assert.equal(sessionOpenInFlight(other, 'b'), undefined)
  assert.equal(sessionOpenInFlight(undefined, 'a'), undefined)
  const noResolve: SessionsLoose = { list: { getSnapshot: () => ({ ids: ['a'], current: 'a' }) }, open: () => {} }
  assert.equal(sessionOpenInFlight(noResolve, 'a'), undefined)
  const hostile: SessionsConcreteLoose = {
    ...concrete,
    resolve: () => ({ session: new Proxy({}, { get: () => { throw new Error('hostile openPromise getter') } }) as never }),
  }
  assert.doesNotThrow(() => { assert.equal(sessionOpenInFlight(hostile, 'a'), undefined) })
  // ONLY an exactly-null own member is positive evidence: an empty slot is
  // UNKNOWN and must fail closed, or a renamed slot would let the automatic arm
  // rebuild an in-flight open.
  const undefinedMember: SessionsConcreteLoose = { ...concrete, resolve: () => ({ session: { openPromise: undefined } }) }
  assert.equal(sessionOpenInFlight(undefinedMember, 'a'), undefined)
})

test('page recovery reads only the current concrete session and rejects unknown states', () => {
  const sessions: SessionsConcreteLoose = {
    list: { getSnapshot: () => ({ ids: ['a', 'b'], current: 'a' }) },
    open: () => {},
    resolve: id => ({ session: { getSnapshot: () => ({ openState: id === 'a' ? 'loading' : 'open' }) } }),
  }
  assert.equal(sessionOpenState(sessions, 'a'), 'loading')
  assert.equal(sessionOpenState(sessions, 'b'), undefined, 'a hidden session must not drive the visible recovery surface')
  const unknownState: SessionsConcreteLoose = { ...sessions, resolve: () => ({ session: { getSnapshot: () => ({ openState: 'invented' }) } }) }
  const staleScope: SessionsConcreteLoose = { ...sessions, resolve: () => { throw new Error('stale scope') } }
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
    'streamHealth.healFailed', 'streamHealth.reload', 'streamHealth.resync', 'streamHealth.carrierChurn',
  ]) {
    assert.equal(typeof (zh as Record<string, string>)[key], 'string', 'zh is missing ' + key)
    assert.equal(typeof (en as Record<string, string>)[key], 'string', 'en is missing ' + key)
  }
})
