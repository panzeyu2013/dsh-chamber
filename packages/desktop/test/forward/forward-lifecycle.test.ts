/**
 * Forward child lifecycle tests (W0/S1, security review I4/I8).
 *
 * The reaper is the only code in this repository allowed to kill a process it
 * does not own directly, so every fail-closed rule is pinned here:
 *   - identity = pid + start-time token + full argv (including the bind spec);
 *   - a probe that cannot prove identity => NO kill, record kept;
 *   - a probe that proves the pid is gone => tombstone removed, NO kill;
 *   - storage ownership attestation false => nothing is killed or removed;
 *   - kill failure keeps the tombstone for the next launch;
 *   - the registry is versioned/strict and a corrupt file refuses to load.
 * Platform argv builders (taskkill /T /F) are pure and asserted here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildForwardArgs } from '../../remote-forward-args.ts'
import {
  ForwardChildLedger,
  ForwardLifecycleError,
  FORWARD_CHILD_REGISTRY_MAX_ENTRIES,
  FORWARD_REAP_SEMANTICS,
  forwardBindSpec,
  forwardSpawnSupervision,
  matchesForwardChild,
  parseForwardChildRegistry,
  posixKillTarget,
  reapForwardChildren,
  serializeForwardChildRegistry,
  validateForwardChildRecord,
  windowsTaskkillArgs,
} from '../../remote-forward-lifecycle.ts'
import type {
  ForwardChildLedgerPort,
  ForwardChildRecord,
  ForwardChildRegistryStorage,
  ForwardKillOutcome,
  ForwardKillPlan,
  ForwardKiller,
  ForwardProcessProbe,
  ForwardProcessSnapshot,
  ForwardReapReport,
} from '../../remote-forward-lifecycle.ts'

const CHILD_ARGV = buildForwardArgs(
  { host: 'dev.example.com', user: 'root', sshPort: null },
  '127.0.0.2',
  40_000,
  5173,
)

function childRecord(overrides: Partial<ForwardChildRecord> = {}): ForwardChildRecord {
  return {
    forwardId: 'fwd-0123456789abcdef',
    sourceId: 'dsh-web-1',
    pid: 4242,
    startTime: '12345.678',
    argv: [...CHILD_ARGV],
    pgid: 4242,
    localHost: '127.0.0.2',
    localPort: 40_000,
    targetPort: 5173,
    recordedAt: 1_000,
    ...overrides,
  }
}

function snapshotOf(record: ForwardChildRecord): ForwardProcessSnapshot {
  return { pid: record.pid, startTime: record.startTime, argv: [...record.argv] }
}

class MemoryStorage implements ForwardChildRegistryStorage {
  text: string | null = null
  writes = 0
  failWrite = false
  failRead = false
  ownerOk = true

  async read(): Promise<string | null> {
    if (this.failRead) throw new Error('EACCES')
    return this.text
  }
  async write(text: string): Promise<void> {
    if (this.failWrite) throw new Error('ENOSPC')
    this.writes += 1
    this.text = text
  }
  async verifyOwner(): Promise<boolean> {
    return this.ownerOk
  }
}

class FakeProbe implements ForwardProcessProbe {
  readonly snapshots = new Map<number, ForwardProcessSnapshot | null>()
  readonly errors = new Set<number>()
  readonly calls: number[] = []

  async inspect(pid: number): Promise<ForwardProcessSnapshot | null> {
    this.calls.push(pid)
    if (this.errors.has(pid)) throw new Error('CIM unavailable')
    return this.snapshots.get(pid) ?? null
  }
}

class FakeKiller implements ForwardKiller {
  readonly plans: ForwardKillPlan[] = []
  outcome: ForwardKillOutcome = 'killed'
  throws = false

  async kill(plan: ForwardKillPlan): Promise<ForwardKillOutcome> {
    this.plans.push(plan)
    if (this.throws) throw new Error('kill failed')
    return this.outcome
  }
}

class FakeLedger implements ForwardChildLedgerPort {
  records: ForwardChildRecord[]
  readonly removed: string[] = []

  constructor(records: ForwardChildRecord[] = []) {
    this.records = [...records]
  }

  list(): readonly ForwardChildRecord[] {
    return this.records
  }

  async remove(forwardId: string): Promise<void> {
    this.removed.push(forwardId)
    this.records = this.records.filter(record => record.forwardId !== forwardId)
  }
}

function reasonOf(report: ForwardReapReport, forwardId: string) {
  return report.verdicts.find(verdict => verdict.forwardId === forwardId)?.reason
}

test('the reaper semantics are documented as fail-closed and next-start bounded', () => {
  assert.deepEqual({ ...FORWARD_REAP_SEMANTICS }, {
    window: 'next-start',
    requiresPid: true,
    requiresStartTime: true,
    requiresArgv: true,
    failClosed: true,
  })
})

test('forwardBindSpec is exactly the -L argument fragment', () => {
  assert.equal(forwardBindSpec(childRecord()), '127.0.0.2:40000:127.0.0.1:5173')
  assert.ok(CHILD_ARGV.includes(forwardBindSpec(childRecord())))
})

test('validate accepts a complete record and round-trips the schema', () => {
  const record = validateForwardChildRecord(childRecord())
  const text = serializeForwardChildRegistry({ version: 1, children: [record] })
  assert.equal(text.endsWith('\n'), true)
  assert.deepEqual(parseForwardChildRegistry(text), { version: 1, children: [record] })
  assert.deepEqual(parseForwardChildRegistry(null), { version: 1, children: [] })
  assert.deepEqual(parseForwardChildRegistry(''), { version: 1, children: [] })
})

test('validate rejects hostile/inconsistent records', () => {
  const cases: Array<Record<string, unknown>> = [
    { ...childRecord(), extra: 1 },
    { ...childRecord(), localHost: '127.0.0.1' },
    { ...childRecord(), localHost: '127.0.0.255' },
    { ...childRecord(), localPort: 80 },
    { ...childRecord(), targetPort: 0 },
    { ...childRecord(), pid: 0 },
    { ...childRecord(), pgid: -3 },
    { ...childRecord(), startTime: '' },
    { ...childRecord(), startTime: 'bad\ntime' },
    { ...childRecord(), argv: [] },
    { ...childRecord(), argv: ['-N', '-p', '22', 'dev.example.com'] },
    { ...childRecord(), forwardId: 'fwd-XYZ' },
    { ...childRecord(), sourceId: 'local' },
    { ...childRecord(), recordedAt: -1 },
  ]
  cases.forEach((value, index) => {
    assert.throws(() => validateForwardChildRecord(value), (error: unknown) => {
      return error instanceof ForwardLifecycleError && error.code === 'invalid_child_record'
    }, 'case ' + String(index))
  })
})

test('corrupt registry files fail closed (strict schema, unique ids/pids)', () => {
  const record = childRecord()
  const corrupt: string[] = [
    '{',
    'null',
    '[]',
    JSON.stringify({ version: 2, children: [] }),
    JSON.stringify({ version: 1, children: [], extra: 1 }),
    JSON.stringify({ version: 1, children: {} }),
    JSON.stringify({ version: 1, children: [record, record] }),
    JSON.stringify({ version: 1, children: [record, { ...record, forwardId: 'fwd-ffffffffffffffff' }] }),
    JSON.stringify({ version: 1, children: [record, { ...record, pid: 4243 }] }),
    JSON.stringify({ version: 1, children: Array.from({ length: FORWARD_CHILD_REGISTRY_MAX_ENTRIES + 1 }, (_value, index) => ({ ...record, forwardId: 'fwd-' + String(index).padStart(16, '0'), pid: index + 1 })) }),
  ]
  corrupt.forEach((text, index) => {
    assert.throws(() => parseForwardChildRegistry(text), (error: unknown) => {
      return error instanceof ForwardLifecycleError && error.code === 'child_registry_corrupt'
    }, 'case ' + String(index))
  })
})

test('matchesForwardChild requires pid + start-time + the full argv', () => {
  const record = childRecord()
  const snapshot = snapshotOf(record)
  assert.equal(matchesForwardChild(record, snapshot), true)
  // New ledger records carry the program name; the OS probe returns it too.
  assert.equal(matchesForwardChild(record, { ...snapshot, argv: ['ssh', ...snapshot.argv] }), true)
  assert.equal(matchesForwardChild(record, { ...snapshot, argv: ['/usr/bin/ssh', ...snapshot.argv] }), true)
  assert.equal(matchesForwardChild(record, { ...snapshot, argv: ['C:\\Windows\\System32\\OpenSSH\\ssh.exe', ...snapshot.argv] }), true)
  assert.equal(matchesForwardChild(record, { ...snapshot, argv: ['scp', ...snapshot.argv] }), false)
  assert.equal(matchesForwardChild(record, { ...snapshot, argv: ['ssh', ...snapshot.argv, 'extra'] }), false)
  assert.equal(matchesForwardChild(record, { ...snapshot, startTime: '99999.1' }), false)
  assert.equal(matchesForwardChild(record, { ...snapshot, argv: [...snapshot.argv, 'extra'] }), false)
  assert.equal(matchesForwardChild(record, { ...snapshot, argv: snapshot.argv.slice(0, -1) }), false)
  const withoutBind = snapshot.argv.filter(argument => argument !== forwardBindSpec(record))
  assert.equal(matchesForwardChild(record, { ...snapshot, argv: withoutBind }), false)
  assert.equal(matchesForwardChild(record, { ...snapshot, pid: 1 }), false)
})

test('platform builders: POSIX process group vs Windows taskkill /T /F', () => {
  assert.equal(posixKillTarget(childRecord()), -4242)
  assert.equal(posixKillTarget(childRecord({ pgid: null })), 4242)
  assert.equal(posixKillTarget(childRecord({ pgid: 1 })), 4242)
  assert.deepEqual(windowsTaskkillArgs(4242), ['/PID', '4242', '/T', '/F'])
  assert.throws(() => windowsTaskkillArgs(0), RangeError)
  assert.deepEqual(forwardSpawnSupervision('posix', 4242), { detached: true, pgid: 4242 })
  assert.deepEqual(forwardSpawnSupervision('win32', 4242), { detached: false, pgid: null })
  assert.throws(() => forwardSpawnSupervision('posix', 0), RangeError)
})

test('ledger: add/list/remove are write-through and serialized', async () => {
  const storage = new MemoryStorage()
  const ledger = new ForwardChildLedger({ storage, now: () => 1_000 })
  await ledger.load()
  const added = await ledger.add({ ...childRecord(), recordedAt: undefined })
  assert.equal(added.recordedAt, 1_000)
  assert.deepEqual(ledger.list().map(record => record.forwardId), ['fwd-0123456789abcdef'])
  assert.equal(storage.writes, 1)
  await Promise.all([
    ledger.add({ ...childRecord({ forwardId: 'fwd-1111111111111111', pid: 5000 }) }),
    ledger.add({ ...childRecord({ forwardId: 'fwd-2222222222222222', pid: 5001 }) }),
  ])
  assert.equal(ledger.list().length, 3)
  await ledger.remove('fwd-1111111111111111')
  await ledger.remove('fwd-1111111111111111')
  assert.deepEqual(ledger.list().map(record => record.forwardId), ['fwd-0123456789abcdef', 'fwd-2222222222222222'])
  assert.equal(storage.writes, 4)
})

test('ledger refuses duplicate ids/pids, a corrupt file and a full registry', async () => {
  const storage = new MemoryStorage()
  const ledger = new ForwardChildLedger({ storage })
  await ledger.load()
  await ledger.add(childRecord())
  await assert.rejects(
    () => ledger.add(childRecord()),
    (error: unknown) => error instanceof ForwardLifecycleError && error.code === 'invalid_child_record',
  )
  await assert.rejects(
    () => ledger.add(childRecord({ forwardId: 'fwd-9999999999999999' })),
    (error: unknown) => error instanceof ForwardLifecycleError && error.code === 'invalid_child_record',
  )

  const corrupt = new MemoryStorage()
  corrupt.text = '{"version":1,"children":[{"broken":true}]}'
  const corruptLedger = new ForwardChildLedger({ storage: corrupt })
  await assert.rejects(
    () => corruptLedger.load(),
    (error: unknown) => error instanceof ForwardLifecycleError && error.code === 'child_registry_corrupt',
  )

  const full = new MemoryStorage()
  const fullLedger = new ForwardChildLedger({ storage: full })
  await fullLedger.load()
  for (let index = 0; index < FORWARD_CHILD_REGISTRY_MAX_ENTRIES; index += 1) {
    await fullLedger.add(childRecord({
      forwardId: 'fwd-' + String(index).padStart(16, '0'),
      pid: 10_000 + index,
    }))
  }
  await assert.rejects(
    () => fullLedger.add(childRecord({ forwardId: 'fwd-ffffffffffffffff', pid: 50_000 })),
    (error: unknown) => error instanceof ForwardLifecycleError && error.code === 'child_registry_full',
  )
})

test('ledger surfaces storage failures and refuses list before load', async () => {
  const storage = new MemoryStorage()
  const ledger = new ForwardChildLedger({ storage })
  assert.throws(() => ledger.list(), (error: unknown) => {
    return error instanceof ForwardLifecycleError && error.code === 'child_registry_not_loaded'
  })
  await ledger.load()
  storage.failWrite = true
  await assert.rejects(
    () => ledger.add(childRecord()),
    (error: unknown) => error instanceof ForwardLifecycleError && error.code === 'child_registry_unavailable',
  )
  assert.deepEqual(ledger.list(), [], 'a failed write must not commit memory state')
  storage.failWrite = false
  storage.failRead = true
  const unreadable = new ForwardChildLedger({ storage })
  await assert.rejects(
    () => unreadable.load(),
    (error: unknown) => error instanceof ForwardLifecycleError && error.code === 'child_registry_unavailable',
  )
})

test('reaper kills a proven child via its process group and removes the tombstone', async () => {
  const record = childRecord()
  const ledger = new FakeLedger([record])
  const probe = new FakeProbe()
  probe.snapshots.set(record.pid, snapshotOf(record))
  const killer = new FakeKiller()
  const report = await reapForwardChildren({ ledger, probe, killer })
  assert.equal(report.trusted, true)
  assert.equal(report.reaped, 1)
  assert.equal(report.remaining, 0)
  assert.deepEqual(killer.plans, [{ pid: 4242, pgid: 4242 }])
  assert.deepEqual(ledger.removed, [record.forwardId])
  assert.equal(reasonOf(report, record.forwardId), 'killed')
})

test('reaper never kills when identity is unprovable, mismatched or unattested', async () => {
  const record = childRecord()
  const cases: Array<{
    name: string
    probe: (probe: FakeProbe) => void
    killer?: (killer: FakeKiller) => void
    ledger?: FakeLedger
    expected: string
    expectedRemoved: boolean
    ownership?: boolean
  }> = [
    {
      name: 'probe throws',
      probe: probe => probe.errors.add(record.pid),
      expected: 'unprovable',
      expectedRemoved: false,
    },
    {
      name: 'pid reused (start-time mismatch)',
      probe: probe => probe.snapshots.set(record.pid, { ...snapshotOf(record), startTime: '9.9' }),
      expected: 'identity_mismatch',
      expectedRemoved: false,
    },
    {
      name: 'forged file points at an unrelated process',
      probe: probe => probe.snapshots.set(record.pid, { ...snapshotOf(record), argv: ['/usr/bin/sshd', '-D'] }),
      expected: 'identity_mismatch',
      expectedRemoved: false,
    },
    {
      name: 'proven gone',
      probe: probe => probe.snapshots.set(record.pid, null),
      expected: 'already_gone',
      expectedRemoved: true,
    },
    {
      name: 'kill failed',
      probe: probe => probe.snapshots.set(record.pid, snapshotOf(record)),
      killer: killer => {
        killer.outcome = 'failed'
      },
      expected: 'kill_failed',
      expectedRemoved: false,
    },
    {
      name: 'killer threw',
      probe: probe => probe.snapshots.set(record.pid, snapshotOf(record)),
      killer: killer => {
        killer.throws = true
      },
      expected: 'kill_failed',
      expectedRemoved: false,
    },
    {
      name: 'kill raced with exit',
      probe: probe => probe.snapshots.set(record.pid, snapshotOf(record)),
      killer: killer => {
        killer.outcome = 'not_found'
      },
      expected: 'already_gone',
      expectedRemoved: true,
    },
  ]
  for (const testCase of cases) {
    const ledger = new FakeLedger([record])
    const probe = new FakeProbe()
    const killer = new FakeKiller()
    testCase.probe(probe)
    testCase.killer?.(killer)
    const report = await reapForwardChildren({ ledger, probe, killer })
    assert.equal(reasonOf(report, record.forwardId), testCase.expected, testCase.name)
    assert.equal(ledger.removed.includes(record.forwardId), testCase.expectedRemoved, testCase.name)
    if (!testCase.expectedRemoved) assert.equal(killer.plans.length <= 1, true)
  }
})

test('ownership attestation false means NOTHING is probed, killed or removed', async () => {
  const record = childRecord()
  const ledger = new FakeLedger([record])
  const probe = new FakeProbe()
  const killer = new FakeKiller()
  let attestations = 0
  const report = await reapForwardChildren({
    ledger,
    probe,
    killer,
    verifyOwnership: async () => {
      attestations += 1
      return false
    },
  })
  assert.equal(attestations, 1)
  assert.equal(report.trusted, false)
  assert.equal(report.reaped, 0)
  assert.equal(report.remaining, 1)
  assert.equal(reasonOf(report, record.forwardId), 'registry_untrusted')
  assert.deepEqual(probe.calls, [])
  assert.deepEqual(killer.plans, [])
  assert.deepEqual(ledger.removed, [])
})

test('ownership attestation that throws is treated as untrusted', async () => {
  const record = childRecord()
  const ledger = new FakeLedger([record])
  const probe = new FakeProbe()
  const killer = new FakeKiller()
  const report = await reapForwardChildren({
    ledger,
    probe,
    killer,
    verifyOwnership: async () => {
      throw new Error('ACL check failed')
    },
  })
  assert.equal(report.trusted, false)
  assert.deepEqual(killer.plans, [])
})

test('a custom planFor drives the Windows taskkill shape without a Windows host', async () => {
  const record = childRecord({ pgid: null })
  const ledger = new FakeLedger([record])
  const probe = new FakeProbe()
  probe.snapshots.set(record.pid, snapshotOf(record))
  const killer = new FakeKiller()
  const plans: ForwardKillPlan[] = []
  const report = await reapForwardChildren({
    ledger,
    probe,
    killer,
    planFor: child => ({ pid: child.pid, pgid: null }),
  })
  assert.equal(report.reaped, 1)
  assert.deepEqual(killer.plans, [{ pid: record.pid, pgid: null }])
  plans.push(...killer.plans)
  assert.deepEqual(windowsTaskkillArgs(plans[0].pid), ['/PID', '4242', '/T', '/F'])
})

test('end-to-end: a persisted child is reaped on the next launch and the file is emptied', async () => {
  const storage = new MemoryStorage()
  const writer = new ForwardChildLedger({ storage, now: () => 1_000 })
  await writer.load()
  const record = await writer.add({ ...childRecord(), recordedAt: undefined })

  const reader = new ForwardChildLedger({ storage, now: () => 2_000 })
  await reader.load()
  const probe = new FakeProbe()
  probe.snapshots.set(record.pid, snapshotOf(record))
  const killer = new FakeKiller()
  const report = await reapForwardChildren({ ledger: reader, probe, killer, verifyOwnership: () => storage.verifyOwner() })
  assert.equal(report.reaped, 1)
  assert.deepEqual(reader.list(), [])
  assert.deepEqual(parseForwardChildRegistry(storage.text), { version: 1, children: [] })
})
