/**
 * plugins-journal tests (design 21 §6.3 write order + journal hygiene; plan
 * Phase 4.2). Plain node:test over tmp dirs; no toolchain.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  JOURNAL_RETENTION_LIMIT,
  backupsRoot,
  backupDirFor,
  createPluginsJournal,
  journalFilePath,
  thirdPartyRoot,
} from '../src/plugins-journal.ts'
import type { JournalLogger } from '../src/plugins-journal.ts'

const silent: JournalLogger = { log() {}, warn() {} }
const posix = process.platform !== 'win32'
const mode = (path: string): number => statSync(path).mode & 0o777

function makeLogger(): { logger: JournalLogger; warns: string[] } {
  const warns: string[] = []
  return { logger: { log() {}, warn(message: unknown) { warns.push(String(message)) } }, warns }
}

function tmpState(t: { after(fn: () => void): void }): string {
  const stateDir = mkdtempSync(join(tmpdir(), 'plugins-journal-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  return stateDir
}

test('appendPending records durable pending ops; recent is newest-first and persists across reopen', t => {
  const stateDir = tmpState(t)
  const journal = createPluginsJournal(stateDir, silent)
  const a = journal.appendPending({ kind: 'install', name: 'pkg-a', spec: 'pkg-a@^1.0.0', initiator: 'test-desktop' })
  const b = journal.appendPending({ kind: 'remove', name: 'pkg-b' })
  const c = journal.appendPending({ kind: 'materialize', name: 'pkg-c', spec: 'file:/tmp/pkg-c.tgz' })

  assert.equal(typeof a, 'string')
  assert.ok(a !== b && b !== c, 'op ids are unique')

  const recent = journal.recent()
  assert.deepEqual(recent.map(op => op.id), [c, b, a])
  for (const op of recent) {
    assert.equal(op.status, 'pending')
    assert.equal(op.preImage, null)
  }
  assert.equal(recent[0]!.kind, 'materialize')
  assert.equal(recent[0]!.spec, 'file:/tmp/pkg-c.tgz')
  assert.equal(recent[2]!.initiator, 'test-desktop')
  assert.equal(recent[2]!.spec, 'pkg-a@^1.0.0')
  assert.equal(journal.recent(2).length, 2)
  assert.equal(journal.latestFailed(), null)

  if (posix) {
    assert.equal(mode(thirdPartyRoot(stateDir)), 0o700)
    assert.equal(mode(journalFilePath(stateDir)), 0o600)
  }
  // Durability: a reopened journal sees the same records.
  const reopened = createPluginsJournal(stateDir, silent)
  assert.deepEqual(reopened.recent().map(op => op.id), [c, b, a])
})

test('markTerminal records ok/failed/blocked (+error/restarted) and no-ops on a missing op id', t => {
  const stateDir = tmpState(t)
  const journal = createPluginsJournal(stateDir, silent)
  const okId = journal.appendPending({ kind: 'install', name: 'pkg-ok' })
  const failedId = journal.appendPending({ kind: 'install', name: 'pkg-fail' })
  const blockedId = journal.appendPending({ kind: 'remove', name: 'pkg-blocked' })

  const marked = journal.markTerminal(okId, { status: 'ok' })
  assert.equal(marked?.status, 'ok')
  assert.equal(marked?.id, okId)
  assert.equal(marked?.error, undefined)

  const failed = journal.markTerminal(failedId, { status: 'failed', error: 'registry refused', restarted: 'skipped' })
  assert.equal(failed?.status, 'failed')
  assert.equal(failed?.error, 'registry refused')
  assert.equal(failed?.restarted, 'skipped')

  const blocked = journal.markTerminal(blockedId, { status: 'blocked', error: 'runtime busy; retry later' })
  assert.equal(blocked?.status, 'blocked')
  assert.equal(blocked?.error, 'runtime busy; retry later')

  const latest = journal.recent()
  assert.deepEqual(latest.map(op => op.status), ['blocked', 'failed', 'ok'])
  assert.equal(journal.latestFailed()?.id, failedId)

  // Re-marking a terminal op can attach a later restart outcome.
  const reMarked = journal.markTerminal(failedId, { status: 'failed', restarted: 'failed' })
  assert.equal(reMarked?.restarted, 'failed')
  assert.equal(reMarked?.error, undefined, 'omitted error is cleared')

  // Missing op id: null, and the journal file is untouched.
  const before = readFileSync(journalFilePath(stateDir), 'utf8')
  assert.equal(journal.markTerminal('no-such-op', { status: 'ok' }), null)
  assert.equal(readFileSync(journalFilePath(stateDir), 'utf8'), before)
})

test('reconcile flips pending to failed once (with preImage note) and is idempotent', t => {
  const stateDir = tmpState(t)
  const journal = createPluginsJournal(stateDir, silent)
  const interrupted1 = journal.appendPending({ kind: 'install', name: 'pkg-int-1' })
  const done = journal.appendPending({ kind: 'remove', name: 'pkg-done' })
  journal.markTerminal(done, { status: 'ok' })
  const interrupted2 = journal.appendPending({ kind: 'materialize', name: 'pkg-int-2', spec: 'file:/x.tgz' })

  const reconciled = journal.reconcile()
  assert.deepEqual(
    reconciled.map(op => op.id).sort(),
    [interrupted1, interrupted2].sort(),
  )
  for (const op of reconciled) {
    assert.equal(op.status, 'failed')
    assert.equal(op.error, 'interrupted before completion; preImage retained')
  }

  const after = journal.recent()
  assert.equal(after.find(op => op.id === done)?.status, 'ok', 'terminal ops are untouched')
  assert.equal(after.find(op => op.id === interrupted1)?.status, 'failed')

  // Idempotent: second run transitions nothing and rewrites nothing.
  const fileBefore = readFileSync(journalFilePath(stateDir), 'utf8')
  assert.deepEqual(journal.reconcile(), [])
  assert.equal(readFileSync(journalFilePath(stateDir), 'utf8'), fileBefore)

  // Reopened journal sees the reconciled state (durability).
  const reopened = createPluginsJournal(stateDir, silent)
  assert.equal(reopened.recent().find(op => op.id === interrupted2)?.status, 'failed')
})

test('a corrupt journal is renamed aside with a warn and a fresh journal starts', t => {
  const stateDir = tmpState(t)
  const filePath = journalFilePath(stateDir)
  const { logger, warns } = makeLogger()
  const garbage = '{"version":1,"ops":[ not json'
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, garbage, 'utf8')

  const journal = createPluginsJournal(stateDir, logger)
  assert.equal(journal.recent().length, 0, 'corrupt journal must not crash the journal surface')
  assert.ok(warns.some(message => message.includes('corrupt')), 'corruption is announced: never silent')

  const entries = readdirSync(thirdPartyRoot(stateDir))
  const aside = entries.find(name => /^journal\.json\.corrupt-\d+$/u.test(name))
  assert.ok(aside !== undefined, 'corrupt journal is moved aside with a timestamp')
  assert.equal(readFileSync(join(thirdPartyRoot(stateDir), aside!), 'utf8'), garbage, 'aside keeps the evidence')

  // Fresh journal is fully usable afterwards (no crash-loop, no data loss on
  // the new records).
  const opId = journal.appendPending({ kind: 'install', name: 'pkg-after-corrupt' })
  journal.markTerminal(opId, { status: 'ok' })
  const reopened = createPluginsJournal(stateDir, silent)
  assert.equal(reopened.recent()[0]?.name, 'pkg-after-corrupt')
  assert.equal(reopened.recent()[0]?.status, 'ok')
})

test('an oversized (unbounded) journal file is treated as corrupt: aside + fresh', t => {
  const stateDir = tmpState(t)
  const filePath = journalFilePath(stateDir)
  const { logger, warns } = makeLogger()
  mkdirSync(dirname(filePath), { recursive: true })
  // Valid JSON but far beyond the 256 KiB read bound.
  writeFileSync(filePath, `{"version":1,"ops":[${'{}'.repeat(200_000)}]}`, 'utf8')

  const journal = createPluginsJournal(stateDir, logger)
  assert.equal(journal.recent().length, 0)
  assert.ok(warns.length >= 1)
  const entries = readdirSync(thirdPartyRoot(stateDir))
  assert.ok(entries.some(name => /^journal\.json\.corrupt-\d+$/u.test(name)), 'oversized file is moved aside')
})

test('recordPreImage references the backup dir; retention keeps the newest ops and drops unreferenced backups', t => {
  const stateDir = tmpState(t)
  const journal = createPluginsJournal(stateDir, silent)
  const root = backupsRoot(stateDir)

  // 55 completed ops, each with its own backup dir + a marker file.
  const ids: string[] = []
  for (let i = 0; i < 55; i += 1) {
    const id = journal.appendPending({ kind: 'install', name: `pkg-${String(i).padStart(2, '0')}` })
    journal.recordPreImage(id)
    const dir = backupDirFor(stateDir, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `{"name":"pkg-${i}"}`, 'utf8')
    journal.markTerminal(id, { status: 'ok' })
    ids.push(id)
  }

  const recent = journal.recent()
  assert.equal(recent.length, JOURNAL_RETENTION_LIMIT, 'journal is pruned to the newest 50 ops')
  const retainedIds = new Set(recent.map(op => op.id))
  for (const id of retainedIds) assert.ok(retainedIds.has(id) && recent.some(op => op.preImage === id))
  // The oldest 5 ops' backups were pruned with their ops.
  for (const id of ids.slice(0, 5)) {
    assert.ok(!retainedIds.has(id), `op ${id} is pruned`)
    assert.ok(!existsSync(backupDirFor(stateDir, id)), `backup dir of pruned op ${id} is removed`)
  }
  for (const id of ids.slice(5)) {
    assert.equal(existsSync(backupDirFor(stateDir, id)), true, `backup dir of retained op ${id} survives`)
  }

  // An unreferenced dir is dropped on the next terminal mark; referenced ones
  // survive even when their op predates the newest op.
  const junk = join(root, 'stale-op-dir')
  mkdirSync(junk, { recursive: true })
  writeFileSync(join(junk, 'package.json'), '{}', 'utf8')
  const extra = journal.appendPending({ kind: 'remove', name: 'pkg-extra' })
  journal.recordPreImage(extra)
  const extraDir = backupDirFor(stateDir, extra)
  mkdirSync(extraDir, { recursive: true })
  journal.markTerminal(extra, { status: 'failed', error: 'nope' })
  assert.equal(existsSync(junk), false, 'unreferenced backup dir is removed on terminal mark')
  assert.equal(existsSync(extraDir), true)
  assert.equal(journal.recent().length, JOURNAL_RETENTION_LIMIT)
})

test('retention drops unreferenced dirs only when the journal references the rest (best effort)', t => {
  const stateDir = tmpState(t)
  const journal = createPluginsJournal(stateDir, silent)
  const root = backupsRoot(stateDir)

  // Ops WITHOUT preImage reference (e.g. blocked before backup): their
  // physically-existing dirs are still unreferenced and must be cleaned.
  const id1 = journal.appendPending({ kind: 'install', name: 'pkg-1' })
  const id2 = journal.appendPending({ kind: 'install', name: 'pkg-2' })
  const kept = backupDirFor(stateDir, id1)
  mkdirSync(kept, { recursive: true })
  const orphan = join(root, id2)
  mkdirSync(orphan, { recursive: true })
  journal.recordPreImage(id1)
  journal.markTerminal(id1, { status: 'ok' })
  assert.equal(existsSync(kept), true, 'referenced backup survives')
  assert.equal(existsSync(orphan), false, 'unreferenced dir (op without preImage) is removed')
  journal.markTerminal(id2, { status: 'blocked', error: 'runtime busy; retry later' })
})

test('markChildPid records the spawned pid on a pending op; markTerminal clears it', t => {
  const stateDir = tmpState(t)
  const journal = createPluginsJournal(stateDir, silent)
  const opId = journal.appendPending({ kind: 'install', name: 'pkg-pid', spec: 'pkg-pid@1' })
  journal.markChildPid(opId, 4242)
  let recent = journal.recent()
  assert.equal(recent.find(op => op.id === opId)?.status, 'pending')
  assert.equal(recent.find(op => op.id === opId)?.childPid, 4242, 'pid persists across reopen')
  const reopened = createPluginsJournal(stateDir, silent)
  assert.equal(reopened.recent().find(op => op.id === opId)?.childPid, 4242)

  journal.markTerminal(opId, { status: 'ok' })
  recent = journal.recent()
  assert.equal(recent.find(op => op.id === opId)?.status, 'ok')
  assert.equal(recent.find(op => op.id === opId)?.childPid, undefined, 'a terminal op no longer runs — stale pids must never be reaped')
})

test('reconcile returns interrupted ops with their recorded childPid (orphan reaping input)', t => {
  const stateDir = tmpState(t)
  const journal = createPluginsJournal(stateDir, silent)
  const orphaned = journal.appendPending({ kind: 'install', name: 'pkg-orphan', spec: 'pkg-orphan@1' })
  journal.markChildPid(orphaned, 999)
  const plain = journal.appendPending({ kind: 'remove', name: 'pkg-plain' })
  const reconciled = journal.reconcile()
  assert.equal(reconciled.length, 2)
  const byId = new Map(reconciled.map(op => [op.id, op]))
  assert.equal(byId.get(orphaned)?.childPid, 999, 'the orphaned op carries its pid for the kill step')
  assert.equal(byId.get(plain)?.childPid, undefined)
  assert.equal(byId.get(orphaned)?.status, 'failed')
  // Idempotent: a second reconcile returns nothing.
  assert.equal(journal.reconcile().length, 0)
})
