import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DELIVERY_EFFICACY, chamberRunId, classifyDeliverySymptoms,
  deliveryLadder, describeRunId, hostRunId, parseChamberRunId, planDeliveryRecovery, preferRunId,
  runIdFamily, unresolvedRetryDelayMs,
} from '../../src/index.ts'
import { LADDER_TABLES } from '../../src/tables.ts'

// ---------------------------------------------------------------------------
// SessionRunId: two families, never compared, never merged.
// ---------------------------------------------------------------------------

test('run id: chamber namespace round-trips through encode/parse', () => {
  const runId = chamberRunId({ sourceFingerprint: 'ssh:host/1', generation: 7, sessionId: 's:1/2', episode: 3 })
  assert.ok(runId.startsWith('chamber:'))
  assert.deepEqual(parseChamberRunId(runId), {
    sourceFingerprint: 'ssh:host/1', generation: 7, sessionId: 's:1/2', episode: 3,
  })
  assert.equal(runIdFamily(runId), 'chamber')
})

test('run id: host keys stay opaque and never equal a chamber id', () => {
  const host = hostRunId('turn/42')
  const chamber = chamberRunId({ sourceFingerprint: 'local', generation: 1, sessionId: 'turn/42', episode: 42 })
  assert.ok(host.startsWith('host:'))
  assert.equal(runIdFamily(host), 'host')
  assert.notEqual(host, chamber)
  assert.equal(parseChamberRunId(host), null)
  assert.equal(runIdFamily('outbox-legacy-key'), 'legacy')
  assert.equal(describeRunId(undefined), 'no-run')
  assert.equal(describeRunId(chamber), 'chamber:turn/42#42')
})

test('preferRunId: the host id wins, and equal-family disagreement is a conflict to instrument', () => {
  const host = hostRunId('r1')
  const chamber1 = chamberRunId({ sourceFingerprint: 'local', generation: 1, sessionId: 's', episode: 1 })
  const chamber2 = chamberRunId({ sourceFingerprint: 'local', generation: 1, sessionId: 's', episode: 2 })
  assert.deepEqual(preferRunId(undefined, chamber1), { runId: chamber1, conflict: false })
  assert.deepEqual(preferRunId(host, undefined), { runId: host, conflict: false })
  assert.deepEqual(preferRunId(host, chamber1), { runId: host, conflict: false })
  assert.deepEqual(preferRunId(undefined, chamber1).runId, chamber1)
  assert.deepEqual(preferRunId(host, chamber2), { runId: host, conflict: false })
  const sameFamily = preferRunId(chamber1, chamber2)
  assert.equal(sameFamily.conflict, true, 'two chamber ids for one session must be reported, never merged')
})

// ---------------------------------------------------------------------------
// Evidence classification: open-stall needs POSITIVE evidence, not silence.
// ---------------------------------------------------------------------------

test('symptoms: an in-flight OPEN is not a stall, an in-flight RECOVERY is still one', () => {
  const base = { sessionId: 's', symptomSinceMs: 0 }
  assert.deepEqual(classifyDeliverySymptoms({ ...base, open: {
    state: 'loading', openInFlight: false, resyncInFlight: false, resyncAvailable: true,
  } }), ['open-stall'])
  assert.deepEqual(classifyDeliverySymptoms({ ...base, open: {
    state: 'loading', openInFlight: true, resyncInFlight: false, resyncAvailable: true,
  } }), [], 'a slow host keeps its in-flight open')
  assert.deepEqual(classifyDeliverySymptoms({ ...base, open: {
    state: 'loading', openInFlight: false, resyncInFlight: true, resyncAvailable: true,
  } }), ['open-stall'],
  'an in-flight resync does not resolve the stall: the streak and its ledger must survive')
  assert.deepEqual(classifyDeliverySymptoms({ ...base, open: {
    state: 'loading', openInFlight: undefined, resyncInFlight: false, resyncAvailable: true,
  } }), [], 'an unreadable face fails closed like a missing capability')
  assert.deepEqual(classifyDeliverySymptoms({ ...base, open: {
    state: 'open', openInFlight: false, resyncInFlight: false, resyncAvailable: true,
  } }), [])
})

test('symptoms: an error the header cannot heal is the page\'s open-stall', () => {
  const base = { sessionId: 's', symptomSinceMs: 0 }
  // A usable header route keeps the error with the header (no duplicate recovery).
  assert.deepEqual(classifyDeliverySymptoms({ ...base, open: {
    state: 'error', openInFlight: false, resyncInFlight: false, resyncAvailable: true, healRoute: true,
  } }), [])
  // An address-only/masked target has no stage move: the page resync is the only lever.
  assert.deepEqual(classifyDeliverySymptoms({ ...base, open: {
    state: 'error', openInFlight: false, resyncInFlight: false, resyncAvailable: true, healRoute: false,
  } }), ['open-stall'])
  // Without the concrete resync face there is no lever to classify for.
  assert.deepEqual(classifyDeliverySymptoms({ ...base, open: {
    state: 'error', openInFlight: false, resyncInFlight: false, resyncAvailable: false, healRoute: false,
  } }), [])
  // An open still in flight is never interrupted, whatever the error hold.
  assert.deepEqual(classifyDeliverySymptoms({ ...base, open: {
    state: 'error', openInFlight: true, resyncInFlight: false, resyncAvailable: true, healRoute: false,
  } }), [])
  // Unknown route fails closed: the header owns the error arm.
  assert.deepEqual(classifyDeliverySymptoms({ ...base, open: {
    state: 'error', openInFlight: false, resyncInFlight: false, resyncAvailable: true,
  } }), [])
  // Unknown LIVENESS is not an in-flight open: the vendor writes 'error' only after
  // its open settled or failed (openPromise cleared), so an unreadable bit keeps the
  // page resync reachable instead of failing closed forever.
  assert.deepEqual(classifyDeliverySymptoms({ ...base, open: {
    state: 'error', resyncInFlight: false, resyncAvailable: true, healRoute: false,
  } }), ['open-stall'])
})

test('recovery: an error with no header route dispatches the bounded page resync', () => {
  const table = LADDER_TABLES.delivery
  const evidence = {
    sessionId: 's1', symptomSinceMs: 0,
    open: {
      state: 'error' as const, openInFlight: false, resyncInFlight: false,
      resyncAvailable: true, healRoute: false,
    },
  }
  const plan = planDeliveryRecovery({ evidence, records: {}, now: table.resyncGraceMs })
  assert.deepEqual(plan.symptoms, ['open-stall'])
  assert.deepEqual(plan.plan.actions.map(action => action.tier), ['resync'])
})

test('an open already in flight blocks dispatch: recovery never interrupts an opening', () => {
  const table = LADDER_TABLES.delivery
  const plan = planDeliveryRecovery({
    evidence: {
      sessionId: 's1', symptomSinceMs: 0,
      open: { state: 'loading', openInFlight: true, resyncInFlight: false, resyncAvailable: true },
    },
    records: {},
    now: table.resyncGraceMs,
  })
  assert.deepEqual(plan.plan.actions, [], 'the host is already opening: no resync on top of it')
})

test('an in-flight resync blocks dispatch without consuming quota, flag or not', () => {
  const table = LADDER_TABLES.delivery
  const first = planDeliveryRecovery({
    evidence: {
      sessionId: 's1', symptomSinceMs: 0,
      open: { state: 'loading', openInFlight: false, resyncInFlight: false, resyncAvailable: true },
    },
    records: {},
    now: table.resyncGraceMs,
  })
  assert.deepEqual(first.plan.actions.map(action => action.tier), ['resync'])
  const dispatched = first.plan.records.s1?.dispatches.resync?.length ?? 0
  assert.equal(dispatched, 1)
  const inFlight = planDeliveryRecovery({
    evidence: {
      sessionId: 's1', symptomSinceMs: table.resyncGraceMs,
      open: { state: 'loading', openInFlight: false, resyncInFlight: true, resyncAvailable: true },
    },
    records: first.plan.records,
    now: table.resyncGraceMs + 30_000,
  })
  assert.deepEqual(inFlight.symptoms, ['open-stall'])
  assert.deepEqual(inFlight.plan.actions, [], 'no second resync while one is disposing')
  assert.equal(inFlight.plan.records.s1?.dispatches.resync?.length ?? 0, dispatched,
    'the blocked tick consumed no quota (the caller flag is not required for the guarantee)')
})

test('an in-flight resync pauses the ladder WITHOUT wiping its ledger (alternating timing)', () => {
  // The page samples once per second; a real resync disposes and reopens the stream
  // (vendor Session.resync awaits teardown), so the in-flight flag spans samples. If
  // an in-flight resync removed the symptom, collapseRecords would delete the record
  // every other tick: quota/cooldown reset, resync re-fires immediately, and the
  // upper tiers plus the exhaustion notice stay unreachable forever.
  const table = LADDER_TABLES.delivery
  const started = 1_000
  let records: Parameters<typeof planDeliveryRecovery>[0]['records'] = {}
  let resyncDispatchedFor: number | undefined
  const resyncs: number[] = []
  const tiers: string[] = []
  for (let t = started; t <= started + 900_000; t += 1_000) {
    const tick = Math.floor((t - started) / 1_000)
    const resyncInFlight = tick % 2 === 1 && resyncDispatchedFor !== undefined
    const plan = planDeliveryRecovery({
      evidence: {
        sessionId: 's1',
        symptomSinceMs: started,
        ...(resyncDispatchedFor === undefined ? {} : { stuckEvidence: true }),
        open: { state: 'loading', openInFlight: false, resyncInFlight, resyncAvailable: true },
      },
      records,
      now: t,
    })
    records = plan.plan.records
    for (const action of plan.plan.actions) {
      tiers.push(action.tier)
      if (action.tier === 'resync') { resyncs.push(t); resyncDispatchedFor = started }
    }
  }
  // The headline repro: 200s of 1s sampling with an in-flight recovery every other
  // tick must not exceed the window cap (the wipe re-fired it ~100 times).
  const first200s = resyncs.filter(at => at < started + 200_000)
  assert.ok(first200s.length <= table.resyncMax,
    'resync must respect the ' + table.resyncMax + '-per-window cap in the first 200s, got ' + first200s.length)
  // Rolling-window compliance over the whole run (both pre-fix and post-fix numbers
  // are meaningful here: the cap is per window, not per run).
  for (const at of resyncs) {
    const inWindow = resyncs.filter(other => other > at - table.resyncWindowMs && other <= at).length
    assert.ok(inWindow <= table.resyncMax, 'no resync window may exceed the cap, got ' + inWindow + ' at ' + at)
  }
  assert.ok(tiers.includes('instance-reboot'), 'the upper tiers must become reachable once stuck evidence exists')
  assert.ok(tiers.includes('document-reload'), 'and the reload tier after that')
  // Exhaustion is deliberately NOT asserted: cooling tiers count as live levers, and
  // an open stall whose upper tiers still hold quota keeps acting. The host-stall
  // notice is for "no lever can act", which content-only stalls reach.
})

test('symptoms: every stall family is observable and order-stable', () => {
  const symptoms = classifyDeliverySymptoms({
    sessionId: 's', symptomSinceMs: 0,
    scheduleStalled: true, inputBlocked: true,
    authorityDiverged: true, unresolvedCompletion: true,
  })
  assert.deepEqual(symptoms, [
    'schedule-stall', 'input-block', 'authority-divergence', 'delivery-unresolved',
  ])
})

// ---------------------------------------------------------------------------
// The one ladder: table-driven order, evidence gates, quotas, exhaustion.
// ---------------------------------------------------------------------------

test('delivery ladder reads its budgets from the shared table', () => {
  const ladder = deliveryLadder()
  const table = LADDER_TABLES.delivery
  assert.deepEqual(ladder.tiers.map(tier => tier.name), ['resync', 'instance-reboot', 'document-reload'])
  assert.equal(ladder.tiers[0]?.afterMs, table.resyncGraceMs)
  assert.equal(ladder.tiers[0]?.quota, table.resyncMax)
  assert.equal(ladder.tiers[1]?.requiresStuckEvidence, true, 'a reboot is stronger than a resync')
  assert.equal(ladder.tiers[2]?.quota, table.reloadMax)
})

test('recovery: resync dispatches at grace, spends its quota, then the ladder is exhausted', () => {
  const table = LADDER_TABLES.delivery
  const evidence = {
    sessionId: 's1', symptomSinceMs: 0,
    open: { state: 'loading' as const, openInFlight: false, resyncInFlight: false, resyncAvailable: true },
  }
  const first = planDeliveryRecovery({ evidence, records: {}, now: table.resyncGraceMs })
  assert.deepEqual(first.plan.actions.map(action => action.tier), ['resync'])
  const at = table.resyncGraceMs
  const records = { s1: { symptomSinceMs: 0, progressStamp: 0, dispatches: { resync: [at] } } }
  const second = planDeliveryRecovery({ evidence, records, now: at + table.resyncCooldownMs })
  assert.deepEqual(second.plan.actions.map(action => action.tier), ['resync'])
  const records2 = { s1: { symptomSinceMs: 0, progressStamp: 0, dispatches: { resync: [at, at + table.resyncCooldownMs] } } }
  const third = planDeliveryRecovery({ evidence, records: records2, now: at + table.resyncCooldownMs * 3 })
  assert.deepEqual(third.plan.actions, [], 'the resync quota bounds the automatic arm')
  assert.deepEqual(third.plan.exhausted, ['s1'], 'an exhausted ladder is a fact the caller must surface')
})

test('recovery: a stronger tier needs stuck evidence and its own deadline', () => {
  const table = LADDER_TABLES.delivery
  const evidence = {
    sessionId: 's1', symptomSinceMs: 0,
    scheduleStalled: true,
    open: { state: 'loading' as const, openInFlight: false, resyncInFlight: false, resyncAvailable: true },
  }
  const spent = { s1: { symptomSinceMs: 0, progressStamp: 0, dispatches: { resync: [0, table.resyncCooldownMs] } } }
  const tooEarly = planDeliveryRecovery({ evidence, records: spent, now: table.resyncCooldownMs * 3 })
  assert.deepEqual(tooEarly.plan.actions, [], 'no stuck evidence and before the reboot deadline: hold')
  const stuck = planDeliveryRecovery({
    evidence: { ...evidence, stuckEvidence: true }, records: spent, now: table.rebootAfterMs,
  })
  assert.deepEqual(stuck.plan.actions.map(action => action.tier), ['instance-reboot'])
})

// ---------------------------------------------------------------------------
// Efficacy: the action-to-boundary contract itself is a table.
// ---------------------------------------------------------------------------

test('efficacy: every tier names the state it resets, cheapest first', () => {
  const tiers = DELIVERY_EFFICACY.map(row => row.tier)
  assert.deepEqual(tiers, ['journal-restart', 'resync', 'instance-reboot', 'document-reload', 'webcontent-crash-recovery'])
  for (const row of DELIVERY_EFFICACY) {
    assert.ok(row.resets.length > 0, row.tier + ' must name what it resets')
    assert.ok(row.evidence.length > 0, row.tier + ' must name its evidence')
  }
  const reload = DELIVERY_EFFICACY.find(row => row.tier === 'document-reload')
  assert.match(reload?.resets ?? '', /module-level/)
})

test('unresolved retry backoff is bounded by the table', () => {
  const table = LADDER_TABLES.delivery
  assert.equal(unresolvedRetryDelayMs(0), table.unresolvedRetryBaseMs)
  assert.equal(unresolvedRetryDelayMs(99), table.unresolvedRetryMaxMs)
})
