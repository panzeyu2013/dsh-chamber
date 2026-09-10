/**
 * Reaper unit tests (design 02 §3.4): the triple-verification reclaim
 * sequence — identity (ps command line), port ownership (lsof→ss→/proc,
 * fail-closed when every probe is unavailable), orphanhood (ppid 1 /
 * owner dead) — plus the killAndConfirm SIGTERM→SIGKILL sequence.
 *
 * Every external dependency (ps/lsof/ss/proc, signal, alive, sleep) is
 * injected through ReaperDeps; no real process is probed or signalled. The
 * spawn records live in a temp <stateDir>/managed-dsh.
 *
 * Run directly: node packages/control-plane/test/reaper.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runReaper } from '../src/reaper.ts'
import type { ReaperDeps } from '../src/reaper.ts'

const DSH_COMMAND = '/usr/bin/node /opt/deepseek/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --host 127.0.0.1 --port 17510'

function tempStateDir(t: any): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reaper-'))
  mkdirSync(join(dir, 'managed-dsh'), { recursive: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeRecord(stateDir: string, name: string, record: unknown) {
  writeFileSync(join(stateDir, 'managed-dsh', name), JSON.stringify(record))
}

function recordExists(stateDir: string, name: string): boolean {
  try {
    readFileSync(join(stateDir, 'managed-dsh', name), 'utf8')
    return true
  } catch {
    return false
  }
}

/** Default injected deps: a plausible dsh host whose port is provably owned. */
function dshDeps(overrides: Partial<ReaperDeps> = {}): ReaperDeps {
  return {
    psIdentity: () => ({ ppid: '1', command: DSH_COMMAND }),
    lsofPort: () => true,
    ssPort: () => null,
    procPort: async () => null,
    signal: () => true,
    alive: () => true,
    sleep: async () => {},
    termWaitMs: 10,
    termPollMs: 1,
    ...overrides,
  }
}

const spawnRecord = {
  pid: 4242,
  ownerPid: 99999, // dead by default (alive returns false for it below)
  ownerInstanceId: 'instance-1',
  port: 17510,
  binary: '/opt/deepseek/node_modules/@deepseek-ai/dsh/lib/bin.js',
  profile: 'web',
  source: 'managed',
  startedAt: Date.now(),
}

test('reaper: identity mismatch keeps the record untouched', async t => {
  const dir = tempStateDir(t)
  writeRecord(dir, '4242.json', spawnRecord)
  const logs: string[] = []
  const deps = dshDeps({
    // Command line contains none of the recorded entry/profile/port identity.
    psIdentity: () => ({ ppid: '1', command: '/usr/bin/python3 /srv/whatever.py --password super-secret' }),
  })
  const result = await runReaper({
    stateDir: dir,
    deps,
    logger: {
      log: value => { logs.push(String(value)) },
      warn: () => {},
      error: () => {},
    },
  })
  assert.deepEqual(result, { reclaimed: 0, kept: 1, errors: [] })
  assert.ok(recordExists(dir, '4242.json'), 'identity mismatch must leave the record and process untouched')
  assert.equal(logs.some(line => line.includes('super-secret')), false, 'an unrelated argv must never enter logs')
  assert.deepEqual(logs, ['reaper: 4242 identity mismatch; record kept'])
})

test('reaper: a symlinked pid record is kept as unsafe evidence and never drives a signal', async t => {
  if (process.platform === 'win32') t.skip('creating symlinks is privilege-dependent on Windows')
  const dir = tempStateDir(t)
  const victim = join(dir, 'record-victim.json')
  writeFileSync(victim, JSON.stringify(spawnRecord))
  const ledger = join(dir, 'managed-dsh', '4242.json')
  symlinkSync(victim, ledger)
  const signals: NodeJS.Signals[] = []

  const result = await runReaper({
    stateDir: dir,
    deps: dshDeps({ signal: (_pid, signal) => { signals.push(signal); return true } }),
  })

  assert.deepEqual(result, { reclaimed: 0, kept: 1, errors: [] })
  assert.deepEqual(signals, [])
  assert.equal(lstatSync(ledger).isSymbolicLink(), true)
  assert.equal(readFileSync(victim, 'utf8'), JSON.stringify(spawnRecord))
})

test('reaper: record replacement after read is never deleted as the stale inode', async t => {
  const dir = tempStateDir(t)
  const ledger = join(dir, 'managed-dsh', '4242.json')
  writeRecord(dir, '4242.json', spawnRecord)
  const successor = { ...spawnRecord, ownerPid: process.pid, startedAt: 'successor' }
  let replaced = false

  const result = await runReaper({
    stateDir: dir,
    deps: dshDeps({
      alive: pid => {
        if (pid === 4242 && !replaced) {
          replaced = true
          rmSync(ledger)
          writeFileSync(ledger, JSON.stringify(successor))
        }
        return false
      },
      managedTreeAlive: () => false,
    }),
  })

  assert.equal(result.reclaimed, 0)
  assert.equal(result.kept, 1)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /no longer owned/)
  assert.deepEqual(JSON.parse(readFileSync(ledger, 'utf8')), successor)
})

test('reaper: an unrelated bin.ts process with the same profile and port is never killed', async t => {
  const dir = tempStateDir(t)
  writeRecord(dir, '4242.json', spawnRecord)
  const signals: NodeJS.Signals[] = []
  const deps = dshDeps({
    // This is the exact stale-record/PID-reuse shape that the old broad
    // `command.includes("bin.ts")` heuristic accepted.
    psIdentity: () => ({
      ppid: '1',
      command: '/usr/bin/node /srv/unrelated/bin.ts --profile web --port 17510',
    }),
    signal: (_pid, sig) => { signals.push(sig); return true },
  })
  const result = await runReaper({ stateDir: dir, deps })
  assert.deepEqual(result, { reclaimed: 0, kept: 1, errors: [] })
  assert.deepEqual(signals, [], 'identity mismatch must be decided before any signal')
  assert.ok(recordExists(dir, '4242.json'))
})

test('reaper: the exact absolute source checkout entry is eligible for reclaim', async t => {
  const dir = tempStateDir(t)
  const binary = '/work/deepseek-harness/apps/cli/src/bin.ts'
  writeRecord(dir, '4242.json', { ...spawnRecord, binary })
  const signals: NodeJS.Signals[] = []
  const deps = dshDeps({
    psIdentity: () => ({
      ppid: '1',
      command: `/usr/bin/node --import tsx/esm ${binary} --profile web --host 127.0.0.1 --port 17510`,
    }),
    signal: (_pid, sig) => { signals.push(sig); return true },
    alive: (pid: number) => pid === 4242 && signals.length === 0,
  })
  const result = await runReaper({ stateDir: dir, deps })
  assert.deepEqual(result, { reclaimed: 1, kept: 0, errors: [] })
  assert.deepEqual(signals, ['SIGTERM'])
})

test('reaper: legacy basename-only records fail closed', async t => {
  const dir = tempStateDir(t)
  writeRecord(dir, '4242.json', { ...spawnRecord, binary: 'dsh' })
  const signals: NodeJS.Signals[] = []
  const result = await runReaper({
    stateDir: dir,
    deps: dshDeps({ signal: (_pid, sig) => { signals.push(sig); return true } }),
  })
  assert.deepEqual(result, { reclaimed: 0, kept: 1, errors: [] })
  assert.deepEqual(signals, [])
})

test('reaper: unverifiable port ownership (every probe unavailable) keeps the record', async t => {
  const dir = tempStateDir(t)
  writeRecord(dir, '4242.json', spawnRecord)
  const deps = dshDeps({
    // Identity is fine (dsh + --profile web) but every port probe is
    // unavailable → fail-closed: never treated as owned.
    lsofPort: () => null,
    ssPort: () => null,
    procPort: async () => null,
  })
  const result = await runReaper({ stateDir: dir, deps })
  assert.deepEqual(result, { reclaimed: 0, kept: 1, errors: [] })
  assert.ok(recordExists(dir, '4242.json'), 'an unverifiable process is kept, never killed')
})

test('reaper: a record whose owner is still alive is kept (multi-instance safety)', async t => {
  const dir = tempStateDir(t)
  writeRecord(dir, '4242.json', { ...spawnRecord, ownerPid: 777 })
  const deps = dshDeps({
    // Not reparented (ppid is the owner) and the owner is alive.
    psIdentity: () => ({ ppid: '777', command: DSH_COMMAND }),
    alive: (pid: number) => pid === 4242 || pid === 777,
  })
  const result = await runReaper({ stateDir: dir, deps })
  assert.deepEqual(result, { reclaimed: 0, kept: 1, errors: [] })
  assert.ok(recordExists(dir, '4242.json'), 'a live owner must never be torn down')
})

test('reaper: an orphan (ppid 1, owner dead) is reclaimed via SIGTERM → SIGKILL and the record removed', async t => {
  const dir = tempStateDir(t)
  writeRecord(dir, '4242.json', spawnRecord)
  const signals: NodeJS.Signals[] = []
  const deps = dshDeps({
    signal: (_pid, sig) => { signals.push(sig); return true },
    // The pid stays alive through the SIGTERM grace window and only dies
    // once SIGKILL lands; the owner (99999) is dead from the start.
    alive: (pid: number) => pid === 4242 && !signals.includes('SIGKILL'),
  })
  const result = await runReaper({ stateDir: dir, deps })
  assert.deepEqual(result, { reclaimed: 1, kept: 0, errors: [] })
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'], 'killAndConfirm must signal SIGTERM first, then SIGKILL')
  assert.equal(recordExists(dir, '4242.json'), false, 'the reclaimed record is removed')
})

test('reaper: killAndConfirm gives up after SIGTERM + SIGKILL grace windows and the failure is surfaced', async t => {
  const dir = tempStateDir(t)
  writeRecord(dir, '4242.json', spawnRecord)
  const signals: NodeJS.Signals[] = []
  const deps = dshDeps({
    signal: (_pid, sig) => { signals.push(sig); return true },
    // Stubborn process: still alive after both signals.
    alive: (pid: number) => pid === 4242,
  })
  const result = await runReaper({ stateDir: dir, deps })
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(result.reclaimed, 0)
  assert.equal(result.kept, 1)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0], /still alive after SIGTERM \+ SIGKILL/)
  assert.ok(recordExists(dir, '4242.json'), 'a process that refused to die keeps its record')
})

test('reaper: dead pid records are removed while corrupt/invalid records remain as writer evidence', async t => {
  const dir = tempStateDir(t)
  writeRecord(dir, '1111.json', { ...spawnRecord, pid: 1111 })
  writeFileSync(join(dir, 'managed-dsh', '2222.json'), '{not-json')
  writeFileSync(join(dir, 'managed-dsh', '3333.json'), JSON.stringify({ ownerPid: 5555 })) // non-integer pid
  const deps = dshDeps({
    alive: () => false, // every recorded pid is dead
  })
  const result = await runReaper({ stateDir: dir, deps })
  assert.deepEqual(result, { reclaimed: 0, kept: 2, errors: [] })
  assert.equal(recordExists(dir, '1111.json'), false, 'dead pid → record removed')
  assert.equal(recordExists(dir, '2222.json'), true, 'corrupt record → kept as durable recovery evidence')
  assert.equal(recordExists(dir, '3333.json'), true, 'non-integer pid → kept as durable recovery evidence')
})

test('reaper: a claim record is only removed once its owner is dead; a live owner keeps it', async t => {
  const dir = tempStateDir(t)
  writeRecord(dir, 'claim-9000.json', { ownerPid: 9000 })
  const live = dshDeps({ alive: (pid: number) => pid === 9000 })
  const liveResult = await runReaper({ stateDir: dir, deps: live })
  assert.deepEqual(liveResult, { reclaimed: 0, kept: 1, errors: [] })
  assert.ok(recordExists(dir, 'claim-9000.json'), 'a claim with a live owner is never torn down')

  const dead = dshDeps({ alive: () => false })
  const deadResult = await runReaper({ stateDir: dir, deps: dead })
  assert.deepEqual(deadResult, { reclaimed: 0, kept: 0, errors: [] })
  assert.equal(recordExists(dir, 'claim-9000.json'), false, 'claim with a dead owner is removed')
})

// ── takeover mode (2026-09-10, design 02 §3.4) ─────────────────────────────
// The explicit 清理并接管 action clears THIS state directory's own stale or
// orphaned writers that the fail-closed default keeps forever. The rules that
// must never bend: no unverified process is signalled, and a writer whose
// owning control plane is still alive is never touched.

test('reaper takeover: ps unavailable + dead owner + verified listener reclaims the orphan', async t => {
  const dir = tempStateDir(t)
  writeRecord(dir, '4242.json', spawnRecord)
  const signalled: string[] = []
  const outcomes: any[] = []
  const deps = dshDeps({
    // The restricted-environment shape: identity cannot be re-verified at all.
    psIdentity: () => { throw new Error('spawnSync ps EPERM') },
    alive: (pid: number) => pid !== spawnRecord.ownerPid,
    signal: (_pid: number, sig: string) => { signalled.push(sig); return true },
    managedTreeAlive: () => signalled.length < 1,
  })
  const result = await runReaper({
    stateDir: dir, deps, takeover: true, onEntry: outcome => outcomes.push(outcome),
  })
  assert.deepEqual(result, { reclaimed: 1, kept: 0, errors: [] })
  assert.deepEqual(signalled, ['SIGTERM'])
  assert.equal(recordExists(dir, '4242.json'), false)
  assert.deepEqual(outcomes, [{
    name: '4242.json', status: 'reclaimed', pid: 4242, reason: 'takeover-reclaimed', takeOverAvailable: false,
  }])
})

test('reaper takeover: an unverifiable writer is still never signalled (fail closed)', async t => {
  const dir = tempStateDir(t)
  writeRecord(dir, '4242.json', spawnRecord)
  const signalled: string[] = []
  const outcomes: any[] = []
  const deps = dshDeps({
    psIdentity: () => { throw new Error('spawnSync ps EPERM') },
    // The recorded pid no longer owns the recorded listener: no proof left.
    lsofPort: () => false,
    alive: (pid: number) => pid !== spawnRecord.ownerPid,
    signal: (_pid: number, sig: string) => { signalled.push(sig); return true },
  })
  const result = await runReaper({
    stateDir: dir, deps, takeover: true, onEntry: outcome => outcomes.push(outcome),
  })
  assert.deepEqual(result, { reclaimed: 0, kept: 1, errors: [] })
  assert.deepEqual(signalled, [])
  assert.equal(recordExists(dir, '4242.json'), true)
  assert.equal(outcomes[0].reason, 'identity-unverified')
  assert.equal(outcomes[0].takeOverAvailable, true)
})

test('reaper takeover: a pid that provably runs something else drops only the record', async t => {
  const dir = tempStateDir(t)
  writeRecord(dir, '4242.json', spawnRecord)
  const signalled: string[] = []
  const deps = dshDeps({
    psIdentity: () => ({ ppid: '1', command: '/usr/bin/python3 /srv/unrelated.py' }),
    alive: (pid: number) => pid !== spawnRecord.ownerPid,
    signal: (_pid: number, sig: string) => { signalled.push(sig); return true },
  })
  const result = await runReaper({ stateDir: dir, deps, takeover: true })
  assert.deepEqual(result, { reclaimed: 0, kept: 0, errors: [] })
  assert.deepEqual(signalled, [], 'an unrelated process must never be signalled')
  assert.equal(recordExists(dir, '4242.json'), false, 'the stale record is the only thing dropped')
})

test('reaper takeover: a live foreign writer (owner alive) is neither killed nor cleared', async t => {
  const dir = tempStateDir(t)
  writeRecord(dir, '4242.json', spawnRecord)
  const signalled: string[] = []
  const outcomes: any[] = []
  const deps = dshDeps({
    psIdentity: () => ({ ppid: '555', command: '/usr/bin/python3 /srv/unrelated.py' }),
    alive: () => true,                       // both the writer AND its owner live
    signal: (_pid: number, sig: string) => { signalled.push(sig); return true },
  })
  const result = await runReaper({
    stateDir: dir, deps, takeover: true, onEntry: outcome => outcomes.push(outcome),
  })
  assert.deepEqual(result, { reclaimed: 0, kept: 1, errors: [] })
  assert.deepEqual(signalled, [])
  assert.equal(recordExists(dir, '4242.json'), true)
  assert.equal(outcomes[0].reason, 'identity-mismatch')
  assert.equal(outcomes[0].takeOverAvailable, false, 'another running app instance is not a takeover target')
})

test('reaper takeover: a live verified writer whose owner is alive stays untouched', async t => {
  const dir = tempStateDir(t)
  writeRecord(dir, '4242.json', spawnRecord)
  const signalled: string[] = []
  const deps = dshDeps({
    // Verified managed host (matching command), but NOT an orphan: its parent
    // is alive and so is the control plane that spawned it.
    psIdentity: () => ({ ppid: '555', command: DSH_COMMAND }),
    alive: () => true,
    signal: (_pid: number, sig: string) => { signalled.push(sig); return true },
  })
  const result = await runReaper({ stateDir: dir, deps, takeover: true })
  assert.deepEqual(result, { reclaimed: 0, kept: 1, errors: [] })
  assert.deepEqual(signalled, [])
  assert.equal(recordExists(dir, '4242.json'), true)
})

test('reaper: a corrupted record stays even under takeover (no proof, no deletion)', async t => {
  const dir = tempStateDir(t)
  writeFileSync(join(dir, 'managed-dsh', '4242.json'), '{ not json')
  const outcomes: any[] = []
  const deps = dshDeps()
  const result = await runReaper({
    stateDir: dir, deps, takeover: true, onEntry: outcome => outcomes.push(outcome),
  })
  assert.deepEqual(result, { reclaimed: 0, kept: 1, errors: [] })
  assert.equal(recordExists(dir, '4242.json'), true)
  assert.equal(outcomes[0].reason, 'invalid-record')
})

test('reaper: the default mode reports per-entry reasons without changing its verdicts', async t => {
  const dir = tempStateDir(t)
  writeRecord(dir, '4242.json', spawnRecord)
  const outcomes: any[] = []
  const deps = dshDeps({
    psIdentity: () => { throw new Error('spawnSync ps EPERM') },
    // Recorded owner gone, recorded listener still owned by the pid: the two
    // facts the explicit action needs (and that the default mode ignores).
    alive: (pid: number) => pid !== spawnRecord.ownerPid,
  })
  const result = await runReaper({ stateDir: dir, deps, onEntry: outcome => outcomes.push(outcome) })
  assert.deepEqual(result, { reclaimed: 0, kept: 1, errors: [] }, 'startup stays fail-closed')
  assert.deepEqual(outcomes, [{
    name: '4242.json', status: 'kept', pid: 4242, reason: 'identity-unverified', takeOverAvailable: true,
  }])
})

test('reaper takeover: a record without a usable ownerPid is never killed on the ps-free proof', async t => {
  const dir = tempStateDir(t)
  // No ownerPid column at all: orphanhood cannot be proven without ps, and the
  // port proof alone must never authorize a kill.
  writeRecord(dir, '4242.json', { ...spawnRecord, ownerPid: undefined })
  const signalled: string[] = []
  const outcomes: any[] = []
  const deps = dshDeps({
    psIdentity: () => { throw new Error('spawnSync ps EPERM') },
    lsofPort: () => true,
    signal: (_pid: number, sig: string) => { signalled.push(sig); return true },
  })
  const result = await runReaper({
    stateDir: dir, deps, takeover: true, onEntry: outcome => outcomes.push(outcome),
  })
  assert.deepEqual(result, { reclaimed: 0, kept: 1, errors: [] })
  assert.deepEqual(signalled, [])
  assert.equal(recordExists(dir, '4242.json'), true)
  assert.equal(outcomes[0].reason, 'identity-unverified')
  assert.equal(outcomes[0].takeOverAvailable, false, 'nothing can be proven about its owner')
})
