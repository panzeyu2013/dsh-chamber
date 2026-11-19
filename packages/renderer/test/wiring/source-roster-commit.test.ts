/**
 * Roster commit (health + instances snapshot pair) behavior.
 *
 * The regression this file pins: a PARTIAL roster (row-level drops, `rosterIncomplete`) must not
 * behave like an authoritative one. The planner keeps confirmed rows/identities (including a
 * missing row and a same-id NEW fingerprint, which is only a candidate) and never retires/settles;
 * only a healthy COMPLETE snapshot retires a same-id replacement exactly once, after which the old
 * durable notification state and native outbox entry are gone. Behavior is driven through the REAL
 * ownership registry + complete ledger + notification outbox, so the durable loss the old code
 * caused (pump dropping the old outbox entry, observer teardown withdrawing pending) is reproduced
 * as a negative assertion.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { epochOf, reincarnate, type SourceRegistry } from '../../../dsh-stream-state/src/index.ts'
import { createCompleteLedger } from '../../src/complete-ledger.ts'
import { SourceOwnershipRegistry } from '../../src/deep-link-activation.ts'
import { planRosterCommit } from '../../src/host/roster-commit.ts'
import { createRosterGate } from '../../src/host/roster-gate.ts'
import { createRemotesStore } from '../../src/host/remotes-store.ts'
import { LOCAL_INSTANCE_ID } from '../../src/local-instance.ts'
import { createNotificationOutbox } from '../../src/notification-outbox.ts'
import {
  NOTIFICATIONS_V1_KEY, loadNotifications, saveNotifications,
  type NotificationPayload, type NotificationStorageLike,
} from '../../src/notification-store.ts'
import { sourceIdForInstance } from '../../src/transport-source.ts'
import { commitRosterPlan, type RosterCommitSinks } from '../../src/app-hooks/use-roster-commit.ts'
import type { SshInstanceSpec } from '../../src/global.d.ts'

const FP_OLD = 'a'.repeat(64)
const FP_NEW = 'b'.repeat(64)
const RUN_ID = 'host:turn%2F8'
const PENDING_AT = 1_000

function fixture(id: string, fingerprint: string): SshInstanceSpec {
  return {
    id, label: id, kind: 'gateway', transport: 'http', host: '127.0.0.1', user: null,
    sshPort: null, remotePort: 8787, serviceName: null, remoteDshHome: null,
    sourceFingerprint: fingerprint, insecureHttp: true,
  }
}

function createStorage(): NotificationStorageLike {
  const map = new Map<string, string>()
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
  }
}

const HEALTHY = { degraded: false, rosterIncomplete: false } as const
const PARTIAL = { degraded: false, rosterIncomplete: true } as const
const DEGRADED = { degraded: true, rosterIncomplete: false } as const

/** One renderer-side roster authority: real owner registry / ledger / outbox + the App sinks. */
function createHarness() {
  const storage = createStorage()
  const alpha = fixture('alpha', FP_OLD)
  const sourceId = sourceIdForInstance(alpha)
  const seeded: NotificationPayload = {
    v: 1,
    notifiedRuns: { [sourceId]: { session: RUN_ID } },
    pending: { [sourceId]: { session: { at: PENDING_AT, watermark: 9 } } },
    outcomes: { [sourceId]: { goalA: 12 } },
  }
  saveNotifications(storage, seeded)
  const loaded = loadNotifications(storage)
  const ledger = createCompleteLedger(loaded.notifiedRuns, {
    pending: loaded.pending, outcomes: loaded.outcomes, now: PENDING_AT + 1_000,
  })
  const outbox = createNotificationOutbox(storage)
  const queued = outbox.enqueue({
    sourceId, sourceFingerprint: FP_OLD, sessionId: 'session', kind: 'complete', completionSeq: 11,
  })
  assert.notEqual(queued, null, 'the old generation has one durable outbox entry')
  const owners = new SourceOwnershipRegistry([LOCAL_INSTANCE_ID])
  const remotesStore = createRemotesStore()
  const gate = createRosterGate()
  const liveRef = { current: new Set<string>([LOCAL_INSTANCE_ID]) }
  let registry: SourceRegistry = {}
  const order: string[] = []
  const retired: string[] = []
  const persist = (): void => {
    saveNotifications(storage, {
      v: 1,
      notifiedRuns: ledger.notifiedRunTable(),
      pending: ledger.pendingTable(),
      outcomes: ledger.outcomesTable(),
    })
  }
  const sinks: RosterCommitSinks = {
    // The App's synchronous retirement entity: owner + shell + facts observers + durable tables.
    retireSources: sourceIds => {
      const set = new Set(sourceIds)
      if (set.size === 0) return
      order.push('retire:' + [...set].sort().join(','))
      for (const id of set) {
        if (id === LOCAL_INSTANCE_ID) continue
        retired.push(id)
        owners.retire([id])
        const hadDurable = ledger.hasDurable(id)
        ledger.withdraw(id)
        ledger.forget(id)
        if (hadDurable) persist()
        outbox.forgetSource(id)
        persist()
      }
    },
    activateSource: (sourceId, fingerprint) => {
      order.push('activate:' + sourceId);
      owners.activate(sourceId, fingerprint);
    },
    reincarnateSource: (sourceId, fingerprint) => {
      registry = reincarnate(registry, { sourceId, fingerprint });
    },
    installInstances: rows => { remotesStore.setInstances(rows) },
    settleRoster: () => { order.push('settle'); gate.settle() },
    setLive: sourceIds => { order.push('live'); liveRef.current = sourceIds },
    refreshStatus: (_instance, sourceId) => { order.push('refresh:' + sourceId) },
  };
  const refresh = (health: { degraded: boolean; rosterIncomplete: boolean }, instances: SshInstanceSpec[]) => {
    const plan = planRosterCommit({
      health, instances,
      priorInstances: remotesStore.getSnapshot().instances,
      live: liveRef.current,
      fingerprints: owners.fingerprints(),
    });
    const committed = commitRosterPlan(plan, sinks);
    return { plan, committed };
  };
  return {
    alpha, sourceId, storage, ledger, outbox, owners, remotesStore, gate, liveRef,
    registry: () => registry, order, retired, refresh, persist,
  };
}

function durable(storage: NotificationStorageLike): NotificationPayload {
  return JSON.parse(storage.getItem(NOTIFICATIONS_V1_KEY) ?? '{}') as NotificationPayload
}

test('partial commit keeps a dropped row displayed with its confirmed identity and pending state', () => {
  const h = createHarness()
  const first = h.refresh(HEALTHY, [h.alpha])
  assert.equal(first.plan.mode, 'complete')
  assert.equal(h.gate.isSettled(), true)
  const displayed = h.remotesStore.getSnapshot().instances
  assert.deepEqual(displayed.map(row => row.id), [h.alpha.id])
  const owner = h.owners.capture(h.sourceId)
  assert.equal(owner?.fingerprint, FP_OLD)
  const liveBefore = h.liveRef.current

  // A row-dropping load (V5-A) answers with a subset: the confirmed row is MISSING from it.
  h.gate.invalidate()
  const { plan } = h.refresh(PARTIAL, [])
  assert.equal(plan.mode, 'partial')
  assert.equal(plan.instances, displayed, 'no visual change: the prior array reference is preserved')
  assert.equal(plan.settle, false, 'a partial answer never settles the roster gate')
  assert.equal(plan.retire.size, 0, 'a partial answer is not a retirement authority')
  assert.equal(plan.activate.length, 0, 'a confirmed source is never re-activated by a partial answer')
  assert.equal(h.gate.isSettled(), false)
  assert.equal(h.liveRef.current, liveBefore, 'last-known live is untouched')
  assert.equal(h.owners.capture(h.sourceId), owner, 'identity object is the same incarnation')
  assert.deepEqual(h.retired, [], 'no retirement edge ran')
  // The durable surfaces the old code deleted through the observer teardown / pump are intact.
  assert.notEqual(h.ledger.pendingEntry(h.sourceId, 'session'), undefined)
  assert.equal(h.ledger.notifiedRun(h.sourceId, 'session'), RUN_ID)
  assert.equal(h.outbox.entries().length, 1)
  const persisted = durable(h.storage)
  assert.notEqual(persisted.pending?.[h.sourceId], undefined, 'disk pending survives the partial answer')
  assert.notEqual(persisted.notifiedRuns?.[h.sourceId], undefined)
  assert.notEqual(loadNotifications(h.storage).pending?.[h.sourceId], undefined, 'reload restores pending')

  // Recovery: the next healthy COMPLETE answer carries the SAME fingerprint on the same roster
  // generation. The confirmed incarnation and every durable notification surface survive it, and
  // the held delivery becomes pump-eligible again without any fingerprint re-proof.
  const queued = h.outbox.entries()[0]
  const recovered = h.refresh(HEALTHY, [fixture('alpha', FP_OLD)])
  assert.equal(recovered.plan.mode, 'complete')
  assert.equal(recovered.plan.retire.size, 0, 'the recovered row is the same incarnation: nothing retires')
  assert.deepEqual(h.retired, [], 'the recovery never crossed a retirement edge')
  assert.equal(h.owners.capture(h.sourceId), owner, 'the owner survives the recovery as the same incarnation object')
  assert.equal(h.owners.capture(h.sourceId)?.fingerprint, FP_OLD)
  assert.equal(h.gate.isSettled(), true, 'the authoritative complete answer settles the roster gate')
  assert.deepEqual([...h.liveRef.current].sort(), [LOCAL_INSTANCE_ID, h.sourceId].sort(),
    'the authoritative live set is installed')
  assert.notEqual(h.ledger.pendingEntry(h.sourceId, 'session'), undefined)
  assert.equal(h.ledger.notifiedRun(h.sourceId, 'session'), RUN_ID)
  assert.notEqual(h.ledger.notifiedRun(h.sourceId, 'session'), undefined)
  assert.equal(h.outbox.entries().length, 1, 'no outbox entry was dropped')
  assert.equal(h.outbox.entries()[0], queued, 'the same pending delivery object survives the recovery')
  // Delivery-pump availability: the held entry is due and its proof still matches the confirmed
  // owner, so the pump delivers it instead of forgetting it on a fingerprint mismatch.
  assert.deepEqual(h.outbox.due().map(entry => entry.key), [queued.key])
  assert.equal(queued.sourceFingerprint, h.owners.capture(h.sourceId)?.fingerprint)
  const recoveredDisk = durable(h.storage)
  assert.notEqual(recoveredDisk.pending?.[h.sourceId], undefined, 'disk pending survives the recovery')
  assert.notEqual(recoveredDisk.notifiedRuns?.[h.sourceId], undefined)
  assert.notEqual(loadNotifications(h.storage).pending?.[h.sourceId], undefined, 'reload after recovery keeps pending')
})

test('partial commit treats a same-id new fingerprint as a candidate (owner and row stay)', () => {
  const h = createHarness()
  h.refresh(HEALTHY, [h.alpha])
  const displayed = h.remotesStore.getSnapshot().instances[0]
  const owner = h.owners.capture(h.sourceId)
  const epoch = epochOf(h.registry(), h.sourceId)
  const entry = h.outbox.entries()[0]

  h.gate.invalidate()
  const { plan } = h.refresh(PARTIAL, [fixture('alpha', FP_NEW)])
  assert.equal(plan.mode, 'partial')
  assert.equal(plan.instances[0], displayed, 'the current row object is kept (no candidate row)')
  assert.equal(plan.retire.size, 0)
  assert.equal(plan.settle, false)
  assert.equal(h.owners.capture(h.sourceId), owner, 'the owner is NOT overwritten by the candidate')
  assert.equal(h.owners.capture(h.sourceId)?.fingerprint, FP_OLD)
  assert.equal(epochOf(h.registry(), h.sourceId), epoch, 'the lifecycle ledger keeps the old generation')
  assert.equal(h.remotesStore.getSnapshot().instances[0], displayed)
  // The notification pump matches the outbox entry against the CONFIRMED fingerprint: while the
  // candidate is deferred the old entry still belongs to the live incarnation (not forgotten).
  assert.equal(h.outbox.entries()[0], entry)
  assert.equal(entry.sourceFingerprint, h.owners.capture(h.sourceId)?.fingerprint)
  assert.equal(h.ledger.notifiedRun(h.sourceId, 'session'), RUN_ID)
  assert.deepEqual(h.retired, []);
})

test('the complete snapshot retires a deferred same-id replacement exactly once and clears its run', () => {
  const h = createHarness()
  h.refresh(HEALTHY, [h.alpha])
  const owner = h.owners.capture(h.sourceId)
  const epoch = epochOf(h.registry(), h.sourceId)
  h.gate.invalidate()
  h.refresh(PARTIAL, [fixture('alpha', FP_NEW)])
  assert.equal(h.gate.isSettled(), false, 'the candidate is not committed by a partial answer')

  // The authoritative complete snapshot observes the new fingerprint: the retirement edge lands
  // here (exactly once), BEFORE the replacement incarnation is activated.
  const replacement = fixture('alpha', FP_NEW)
  const { plan } = h.refresh(HEALTHY, [replacement])
  assert.equal(plan.mode, 'complete')
  assert.deepEqual([...plan.retire], [h.sourceId])
  assert.equal(plan.settle, true)
  assert.equal(h.retired.filter(id => id === h.sourceId).length, 1)
  const retireAt = h.order.lastIndexOf('retire:' + h.sourceId)
  assert.ok(retireAt !== -1 && h.order.indexOf('activate:' + h.sourceId, retireAt) > retireAt,
    'retirement precedes replacement activation')
  const replacementOwner = h.owners.capture(h.sourceId)
  assert.notEqual(replacementOwner, owner);
  assert.equal(replacementOwner?.fingerprint, FP_NEW)
  assert.ok((epochOf(h.registry(), h.sourceId) ?? 0) > (epoch ?? 0), 'the replacement has a new epoch')
  assert.equal(h.remotesStore.getSnapshot().instances[0], replacement, 'the authoritative row replaces the deferred candidate')
  assert.equal(h.gate.isSettled(), true)
  assert.deepEqual([...h.liveRef.current].sort(), [LOCAL_INSTANCE_ID, h.sourceId].sort())
  // The old generation's durable run identity and native outbox entry are gone (AND persisted).
  assert.equal(h.ledger.notifiedRun(h.sourceId, 'session'), undefined)
  assert.equal(h.outbox.entries().length, 0)
  const persisted = durable(h.storage)
  assert.equal(persisted.notifiedRuns?.[h.sourceId], undefined);
  assert.equal(persisted.pending?.[h.sourceId], undefined);
  assert.deepEqual(JSON.parse(h.storage.getItem('dsh-chamber.notification-outbox.v2') ?? '[]'), []);

  // Idempotence: the next complete snapshot with the same fingerprint retires nothing again.
  h.gate.invalidate()
  const again = h.refresh(HEALTHY, [fixture('alpha', FP_NEW)])
  assert.equal(again.plan.retire.size, 0)
  assert.equal(h.retired.filter(id => id === h.sourceId).length, 1)
  assert.equal(h.owners.capture(h.sourceId), replacementOwner, 'same fingerprint = same incarnation')
})

test('partial commit installs and activates a genuinely new source id without touching live', () => {
  const h = createHarness()
  h.refresh(HEALTHY, [h.alpha])
  const alphaRow = h.remotesStore.getSnapshot().instances[0]
  const liveBefore = h.liveRef.current
  const beta = fixture('beta', 'c'.repeat(64))
  const betaSourceId = sourceIdForInstance(beta)

  h.gate.invalidate()
  const { plan } = h.refresh(PARTIAL, [h.alpha, beta])
  assert.equal(plan.mode, 'partial')
  assert.deepEqual(plan.activate.map(entry => entry.sourceId), [betaSourceId])
  assert.equal(plan.instances[0], alphaRow, 'confirmed row keeps its object identity')
  assert.equal(plan.instances[1], beta, 'the new row is installed so the connection is visible')
  assert.equal(h.liveRef.current, liveBefore, 'partial never updates the authoritative live set')
  const betaOwner = h.owners.capture(betaSourceId)
  assert.equal(betaOwner?.fingerprint, 'c'.repeat(64));
  assert.equal(epochOf(h.registry(), betaSourceId), 1);

  // The next complete snapshot confirms the same incarnation: no second activation/epoch bump.
  h.gate.invalidate()
  const confirmed = h.refresh(HEALTHY, [h.alpha, beta])
  assert.equal(confirmed.plan.retire.size, 0)
  assert.equal(h.owners.capture(betaSourceId), betaOwner)
  assert.equal(epochOf(h.registry(), betaSourceId), 1)
  assert.ok(h.liveRef.current.has(betaSourceId), 'the complete snapshot makes it authoritative')
  assert.equal(h.gate.isSettled(), true)
})

test('a degraded registry answer commits nothing', () => {
  const h = createHarness()
  h.refresh(HEALTHY, [h.alpha])
  const displayed = h.remotesStore.getSnapshot().instances
  const owner = h.owners.capture(h.sourceId)
  const calls: string[] = []
  const probe: RosterCommitSinks = {
    retireSources: () => { calls.push('retire') },
    activateSource: (sourceId, fingerprint) => { calls.push('activate:' + sourceId + '@' + fingerprint) },
    reincarnateSource: sourceId => { calls.push('reincarnate:' + sourceId) },
    installInstances: () => { calls.push('install') },
    settleRoster: () => { calls.push('settle') },
    setLive: () => { calls.push('live') },
    refreshStatus: () => { calls.push('refresh') },
  };
  const plan = planRosterCommit({
    health: DEGRADED, instances: [], priorInstances: displayed,
    live: h.liveRef.current, fingerprints: h.owners.fingerprints(),
  });
  assert.equal(plan.mode, 'degraded')
  assert.equal(plan.instances, displayed, 'a degraded answer installs nothing')
  assert.equal(plan.activate.length, 0)
  assert.equal(plan.retire.size, 0)
  assert.equal(plan.settle, false)
  assert.equal(commitRosterPlan(plan, probe), false, 'the executor refuses to commit a degraded plan')
  assert.deepEqual(calls, [], 'no sink ran for a degraded plan')
  assert.equal(h.remotesStore.getSnapshot().instances, displayed)
  assert.equal(h.owners.capture(h.sourceId), owner)
})

test('a complete empty roster retires every remote source authoritatively', () => {
  const h = createHarness()
  h.refresh(HEALTHY, [h.alpha])
  const beta = fixture('beta', 'c'.repeat(64))
  const betaSourceId = sourceIdForInstance(beta)
  h.refresh(HEALTHY, [h.alpha, beta])
  h.gate.invalidate()
  const { plan } = h.refresh(HEALTHY, [])
  assert.equal(plan.mode, 'complete')
  assert.deepEqual([...plan.retire].sort(), [h.sourceId, betaSourceId].sort())
  assert.deepEqual([...h.liveRef.current], [LOCAL_INSTANCE_ID])
  assert.deepEqual(h.remotesStore.getSnapshot().instances, [])
  assert.equal(h.owners.size, 1, 'only the always-active local owner remains')
  assert.equal(h.outbox.entries().length, 0)
  assert.equal(durable(h.storage).notifiedRuns?.[h.sourceId], undefined)
  assert.equal(h.gate.isSettled(), true)
})

test('invalid lifecycle proofs are omitted in every mode with the single loud diagnostic', () => {
  const h = createHarness()
  h.refresh(HEALTHY, [h.alpha])
  const prior = h.remotesStore.getSnapshot().instances
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args) };
  try {
    // complete: the malformed row is omitted from the installed authoritative set.
    const complete = planRosterCommit({
      health: HEALTHY, instances: [fixture('beta', 'not-a-proof')], priorInstances: prior,
      live: h.liveRef.current, fingerprints: h.owners.fingerprints(),
    });
    assert.equal(complete.mode, 'complete')
    assert.deepEqual(complete.instances, [], 'no row without a valid proof is installed')
    assert.equal(complete.activate.length, 0)
    assert.ok(errors.some(args => String(args[0]).includes('invalid authoritative lifecycle proof')),
      'the omitted row is diagnosed loudly once');
    // partial: a malformed replacement row for a confirmed source keeps the current row.
    const partial = planRosterCommit({
      health: PARTIAL, instances: [fixture('alpha', 'still-not-a-proof')], priorInstances: prior,
      live: h.liveRef.current, fingerprints: h.owners.fingerprints(),
    });
    assert.equal(partial.mode, 'partial')
    assert.equal(partial.instances, prior)
    assert.equal(partial.activate.length, 0)
    assert.equal(partial.retire.size, 0)
  } finally {
    console.error = original;
  }
})

test('the App delegates the roster refresh to the one hook (no second commit path)', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const app = readFileSync(
    fileURLToPath(new URL('../../src/App.tsx', import.meta.url)), 'utf8');
  const hook = readFileSync(
    fileURLToPath(new URL('../../src/app-hooks/use-roster-commit.ts', import.meta.url)), 'utf8');
  const planner = readFileSync(
    fileURLToPath(new URL('../../src/host/roster-commit.ts', import.meta.url)), 'utf8');
  assert.ok(app.includes('const refreshRemotes = useRosterCommit('), 'App only wires the hook');
  assert.equal(app.includes('await ssh.instances_get()'), false, 'the snapshot pair is not read in App');
  assert.equal(app.includes('await ssh.instances_health()'), false, 'the health probe is not read in App');
  assert.equal(app.includes('planRosterCommit('), false, 'App does not call the planner directly');
  assert.equal(app.includes('rosterGate.settle()'), false, 'only the hook settles');
  assert.equal(hook.split('await ssh.instances_health()').length - 1, 1, 'one health probe');
  assert.equal(hook.split('await ssh.instances_get()').length - 1, 1, 'one roster pull');
  assert.equal(hook.split('remoteRosterRefreshSeqRef.current !== seq').length - 1, 2,
    'both awaits are guarded by the refresh generation');
  assert.equal(hook.split('rosterGate.settle()').length - 1, 1, 'one settle call site');
  assert.equal(planner.split('authoritativeSourceRetirements(').length - 1, 1, 'one retirement differential');
  assert.equal(planner.split("mode: 'partial'").length - 1, 2, 'plan type arm + the partial plan builder');
  assert.equal(planner.split("mode: 'complete'").length - 1, 2, 'plan type arm + the complete plan builder');
})
