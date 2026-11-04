/**
 * ssh crash-orphan ledger + sweep: record shape/permissions, the pid+startedAt
 * identity matrix (dead / ours / pid-reused / unverifiable / malformed), the
 * injected-kill seam and the Windows no-op. No ssh process is spawned.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SSH_ORPHAN_START_TOLERANCE_MS,
  clearSshChild,
  readProcessStartedAt,
  recordSshChild,
  sshChildrenDir,
  sweepSshOrphans,
} from '../../ssh-orphan.ts'

function fixture(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-orphan-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeRecord(stateDir: string, pid: number, startedAt: number, extra = ''): string {
  const dir = sshChildrenDir(stateDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${String(pid)}.json`)
  writeFileSync(path, extra === '' ? JSON.stringify({ pid, startedAt, target: 'alice@home:2222' }) : extra)
  return path
}

test('recordSshChild writes one 0600 pid/startedAt/target record; clear removes it idempotently', (t) => {
  const base = fixture(t)
  const path = recordSshChild(base, 4242, { target: 'alice@home:2222', startedAt: 1_700_000_000_000 })
  assert.notEqual(path, null)
  assert.equal(path, join(sshChildrenDir(base), '4242.json'))
  assert.equal(statSync(sshChildrenDir(base)).mode & 0o777, 0o700)
  assert.equal(statSync(path!).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(readFileSync(path!, 'utf8')), {
    pid: 4242, startedAt: 1_700_000_000_000, target: 'alice@home:2222',
  })
  clearSshChild(base, 4242)
  assert.equal(existsSync(path!), false)
  clearSshChild(base, 4242) // absent record is not an error
})

test('sweep reclaims dead/ours and retires reused/malformed records without signalling the wrong pid', (t) => {
  const base = fixture(t)
  const now = 1_700_000_000_000
  const dead = writeRecord(base, 101, now)
  const ours = writeRecord(base, 102, now)
  const reused = writeRecord(base, 103, now)
  const unreadable = writeRecord(base, 104, now)
  const malformed = writeRecord(base, 105, now, '{"pid":')
  writeFileSync(join(sshChildrenDir(base), 'README.txt'), 'ignored')

  const signalled: number[] = []
  const result = sweepSshOrphans({
    stateDir: base,
    exitWaitMs: 0,
    isAlive: pid => pid !== 101,
    readStartedAt: pid => {
      if (pid === 102) return now + 1_000
      if (pid === 103) return now + SSH_ORPHAN_START_TOLERANCE_MS + 60_000
      if (pid === 104) return null
      return now
    },
    signal: pid => { signalled.push(pid) },
  })
  assert.deepEqual(signalled, [102], 'only the live pid whose start time matches ours is reclaimed')
  assert.equal(result.killed, 1)
  assert.equal(result.kept, 1)
  assert.equal(existsSync(dead), false, 'a dead pid\'s record is retired')
  assert.equal(existsSync(ours), false, 'a reclaimed orphan\'s record is retired')
  assert.equal(existsSync(reused), false, 'a pid-reuse record is retired')
  assert.equal(existsSync(unreadable), true, 'an unverifiable live pid keeps its record')
  assert.equal(existsSync(malformed), false, 'a torn record is retired')
  assert.equal(existsSync(join(sshChildrenDir(base), 'README.txt')), true, 'a non-.json file is never touched')
})

test('a signal failure that is not ESRCH keeps the record for the next sweep', (t) => {
  const base = fixture(t)
  const now = 1_700_000_000_000
  const path = writeRecord(base, 201, now)
  const result = sweepSshOrphans({
    stateDir: base,
    isAlive: () => true,
    readStartedAt: () => now,
    signal: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) },
  })
  assert.equal(result.killed, 0)
  assert.equal(result.kept, 0)
  assert.equal(existsSync(path), true)
})

test('SIGTERM escalation: a stubborn orphan gets SIGKILL after the bounded wait', (t) => {
  const base = fixture(t)
  const now = 1_700_000_000_000
  writeRecord(base, 401, now)
  writeRecord(base, 402, now)
  const alive = new Map<number, boolean>([[401, true], [402, true]])
  const signals: Array<{ pid: number; signal: string }> = []
  const result = sweepSshOrphans({
    stateDir: base,
    isAlive: pid => alive.get(pid) === true,
    readStartedAt: () => now,
    signal: (pid, signal) => {
      signals.push({ pid, signal })
      if (pid === 401) alive.set(401, false) // exits cleanly on SIGTERM
    },
    exitWaitMs: 20,
    sleepMs: () => { /* spin without a real timer; deadlines still apply */ },
  })
  assert.equal(result.killed, 2)
  assert.deepEqual(signals.filter(entry => entry.pid === 401), [{ pid: 401, signal: 'SIGTERM' }])
  assert.deepEqual(signals.filter(entry => entry.pid === 402), [
    { pid: 402, signal: 'SIGTERM' },
    { pid: 402, signal: 'SIGKILL' },
  ], 'an orphan that ignores SIGTERM is escalated before the socket directory is removed')
})

test('win32: record/clear/sweep are no-ops', (t) => {
  const base = fixture(t)
  const path = writeRecord(base, 301, 1_700_000_000_000)
  assert.equal(recordSshChild(base, 302, { target: 'x' }, 'win32'), null)
  assert.equal(existsSync(path), true, 'the sweep never touches an existing record on win32')
  const result = sweepSshOrphans({ stateDir: base, platform: 'win32', signal: () => { throw new Error('must not signal') } })
  assert.deepEqual(result, { killed: 0, removed: 0, kept: 0 })
  assert.equal(existsSync(path), true)
})

test('Linux: /proc start time parsing yields this process\' real start (stable + sane)', (t) => {
  if (process.platform !== 'linux') { t.skip('linux /proc only'); return }
  const startedAt = readProcessStartedAt(process.pid)
  assert.notEqual(startedAt, null)
  assert.ok(startedAt! <= Date.now(), 'a start time can never be in the future')
  assert.ok(Date.now() - startedAt! < 24 * 60 * 60 * 1000, 'a sane epoch within the last day')
  // Same process, same kernel facts: the comparison basis is deterministic.
  assert.equal(readProcessStartedAt(process.pid), startedAt)
  assert.equal(readProcessStartedAt(-1), null)
  assert.equal(readProcessStartedAt(0), null)
})
