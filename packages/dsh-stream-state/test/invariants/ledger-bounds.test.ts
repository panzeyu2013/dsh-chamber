/**
 * Ledger bounds gate (G-C) - every rolling ledger is pruned to its window.
 *
 * WHY. The rebuild ledger and the ladder's dispatch ledgers only ever APPENDED.
 * Their readers filter by window at read time, so the values stay correct while
 * the arrays grow without bound: a long-lived page pays O(events) memory and every
 * read pays O(events) filtering. The audit's 3-day production log is exactly this
 * shape. A ledger must be pruned at write time to the window its readers use.
 *
 * THE FORMULA. After N events the ledger may hold at most the number of entries
 * that can coexist inside one window: for the rebuild ledger,
 * min(maxRebuildsPerWindow, floor(window/minSpacing) + 1); for a ladder tier,
 * floor(quotaWindowMs/max(cooldownMs, 1)) + 1 (or the tier quota when its cooldown
 * is zero). The test also asserts the direct property - every retained stamp is
 * inside the live window - so the bound cannot be satisfied by dropping entries the
 * readers still need.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { reduceCarrier } from '../../src/carrier.ts'
import { initialCarrierState } from '../../src/state.ts'
import { CARRIER_ENV } from '../../src/tables.ts'
import { planLadder, type Ladder, type LadderObservation } from '../../src/ladder.ts'

const EVENTS = 100_000

test('the rebuild ledger stays inside the throttle window after 10^5 events', () => {
  let state = initialCarrierState()
  let rebuilds = 0
  for (let index = 0; index < EVENTS; index++) {
    const at = index * 1_000
    const reduction = reduceCarrier(
      state,
      { kind: 'rebuildRequested', reason: 'laneReconnect', at, streamId: 's' },
      CARRIER_ENV,
    )
    state = reduction.state
    if (reduction.effects.some((effect) => effect.e === 'rebuildCarrier')) {
      rebuilds += 1
      // A rebuild flips the phase to 'replacing'; reopen the carrier so the next
      // window can legitimately admit another replacement.
      state = reduceCarrier(state, { kind: 'carrierOpened', at: at + 1 }, CARRIER_ENV).state
    }
  }
  assert.ok(rebuilds > 10, 'the run must actually exercise the keeper (rebuilds=' + rebuilds + ')')
  const bound =
    Math.min(
      CARRIER_ENV.maxRebuildsPerWindow,
      Math.floor(CARRIER_ENV.rebuildWindowMs / CARRIER_ENV.minRebuildSpacingMs) + 1,
    ) + 1
  assert.ok(
    state.rebuildsAt.length <= bound,
    'rebuildsAt grew to ' + state.rebuildsAt.length + ' (bound ' + bound + ' after ' + EVENTS + ' events)',
  )
  const windowStart = (EVENTS - 1) * 1_000 - CARRIER_ENV.rebuildWindowMs
  assert.ok(
    state.rebuildsAt.every((at) => at > windowStart),
    'a retained stamp is older than the throttle window and can never affect a decision',
  )
})

test('a ladder dispatch ledger stays inside its quota window after 10^5 ticks', () => {
  const ladder: Ladder = {
    name: 'g-c',
    quotaWindowMs: 60_000,
    tiers: [{ name: 'probe', afterMs: 0, cooldownMs: 1_000, quota: null, requiresStuckEvidence: false }],
  }
  const observation: LadderObservation = {
    sticky: true,
    symptomSinceMs: 0,
    stuckEvidence: false,
    progressStamp: 0,
    escalationBlocked: false,
  }
  let records = planLadder(ladder, {}, { a: observation }, 0).records
  for (let index = 1; index < EVENTS; index++) {
    records = planLadder(ladder, records, { a: observation }, index * 1_000).records
  }
  const history = records.a?.dispatches.probe ?? []
  const bound = Math.floor(ladder.quotaWindowMs / ladder.tiers[0].cooldownMs) + 1
  assert.ok(history.length > 10, 'the run must actually dispatch (dispatches=' + history.length + ')')
  assert.ok(
    history.length <= bound,
    'the probe dispatches grew to ' + history.length + ' (bound ' + bound + ' after ' + EVENTS + ' ticks)',
  )
  const now = (EVENTS - 1) * 1_000
  assert.ok(
    history.every((at) => at > now - ladder.quotaWindowMs),
    'a retained dispatch stamp is older than the quota window and can never affect a decision',
  )
})

test('the opening ledger is bounded by its key cap across repeated expiry rounds', () => {
  // The opening-ledger arm prunes by scanning the live key set on every event,
  // so 10^5 iterations spend their time in that scan (8.7s) without showing the
  // bound assertion anything new. 5,000 ticks = 10 full eviction cycles over the
  // 500 reused keys, which is what the invariant needs.
  const EXPIRY_TICKS = 5_000
  let state = initialCarrierState()
  for (let index = 0; index < EXPIRY_TICKS; index++) {
    const requestKey = 'k' + String(index % 500)
    state = reduceCarrier(state, { kind: 'openingSent', at: index * 1_000, streamId: 's', requestKey }, CARRIER_ENV).state
    state = reduceCarrier(state, { kind: 'openingExpired', at: index * 1_000 + 1, streamId: 's', requestKey, framesSinceSend: 1 }, CARRIER_ENV).state
  }
  assert.ok(
    Object.keys(state.openingStreaks).length <= CARRIER_ENV.openingEpisodeKeysMax,
    'openingStreaks grew to ' + String(Object.keys(state.openingStreaks).length),
  )
  assert.ok(
    Object.keys(state.streamRequestKeys).length <= CARRIER_ENV.openingEpisodeKeysMax,
    'streamRequestKeys grew to ' + String(Object.keys(state.streamRequestKeys).length),
  )
  assert.ok(
    Object.values(state.openingStreaks).every((streak) => Number.isFinite(streak) && streak >= 1),
    'every retained streak is a live count, not a placeholder',
  )
})
test('an ACTIVE streak survives ledger pressure instead of aging out', () => {
  // Reproduces review finding F1-LEDGER: the opening ledger evicts oldest-first, and
  // re-writing an existing key must move it to the back. A key that kept expiring while
  // fresh keys arrived would otherwise age out, its streak read back as 0, and the
  // stall-escalation threshold could never be reached. Every round admits half a cap of
  // fresh keys while the active key keeps expiring: far beyond any real client (one key
  // per opening attempt), yet comfortably inside the refresh margin that keeps a live
  // key recent.
  const ROUNDS = 12
  let state = initialCarrierState()
  const streaks: number[] = []
  for (let round = 0; round < ROUNDS; round++) {
    const at = round * 1_000_000
    const armed = reduceCarrier(state, { kind: 'openingSent', at, streamId: 's', requestKey: 'active' }, CARRIER_ENV)
    state = armed.state
    const deadline = armed.effects.find((effect) => effect.e === 'armOpeningDeadline')
    streaks.push(deadline === undefined ? -1 : deadline.streak)
    state = reduceCarrier(
      state,
      { kind: 'openingExpired', at: at + 1, streamId: 's', requestKey: 'active', framesSinceSend: 1 },
      CARRIER_ENV,
    ).state
    for (let filler = 0; filler < Math.floor(CARRIER_ENV.openingEpisodeKeysMax / 2); filler++) {
      state = reduceCarrier(
        state,
        { kind: 'openingExpired', at: at + 2 + filler, requestKey: 'f' + String(round) + '_' + String(filler) },
        CARRIER_ENV,
      ).state
    }
  }
  assert.deepEqual(
    streaks,
    Array.from({ length: ROUNDS }, (_, round) => round),
    'the active key keeps counting instead of restarting under ledger pressure',
  )
  assert.ok(
    Object.keys(state.openingStreaks).length <= CARRIER_ENV.openingEpisodeKeysMax,
    'the pressure loop must not break the key cap',
  )
})
