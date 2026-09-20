/**
 * SESSION STREAM-HEALTH LADDER LOCKS (design 14 §D4).
 *
 * The reproduced defect (four mux socket kills 25ms apart ⇒ `openState='error'`
 * ⇒ a frozen transcript) is recovered by exactly two effects, both pinned here:
 * the automatic stage move for an `'error'` session and the notice-plus-reload
 * arm for a parked `'loading'` open — at the decision boundary (pure module)
 * and the effect boundary (a fake sessions face), including the edges the
 * 2026-12 review found unpinned: the settle window, a backwards wall clock,
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
import {
  hasHealNeighbor,
  healSessionStream,
  isConversationSurfacePresented,
  pickHealNeighbor,
  previousPresented,
  rememberPresented,
  type SessionsLoose,
} from '../../src/client/session-stream-health-probe.ts'

const CONFIG: SessionStreamHealthConfig = SESSION_STREAM_HEALTH_DEFAULTS
const G = CONFIG.errorGraceMs
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
  // C2 (2026-09): the judged failure latches the reload notice, and it stays up
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
  // C2: from the first judged failure onward the notice is latched for the whole
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
  // cooldown and budget (2026-12 review).
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
  // grace + settle (C2) — it used to wait out the whole rolling budget (~296 s).
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
  // The notice appears the moment the first repair is judged failed (C2)…
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
  // 2026-09 verification (m6/m10): if the loading state or `markSessionStreamHeal`
  // dropped the latch, the button goes out for the retry's whole 20s judging window
  // — the very regression C2 removed. One tick after the retry must still carry it.
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
  // 2026-09 verification (m3): the loading state must carry `recoveredSinceHeal`,
  // otherwise the next error latches off the PREVIOUS episode's settle clock.
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
  // 2026-09 verification (m4): same shape through `presented === false`.
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
  // PRECONDITION (2026-12 review): the detour is only reversible while the
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

test('stream-health: surface presentation is the official chat column on a visible page', () => {
  const flow = { querySelector: (selector: string) => (selector === '[data-chat-flow]' ? {} : null) }
  assert.equal(isConversationSurfacePresented({ visibilityState: 'visible', ...flow }), true)
  assert.equal(isConversationSurfacePresented({ visibilityState: 'hidden', ...flow }), false)
  assert.equal(isConversationSurfacePresented({ visibilityState: 'visible', querySelector: () => null }), false)
  assert.equal(isConversationSurfacePresented(null), false)
  assert.equal(isConversationSurfacePresented(undefined), false)
})
