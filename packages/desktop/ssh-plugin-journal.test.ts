/**
 * ssh-plugin-journal.ts tests (design 21 §6.4 ssh undo journal, plan Phase
 * 5): record/latestOk semantics, per-file retention, corrupt-aside recovery,
 * bounded no-follow reads, 0600 atomic writes and never-throw persistence.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSshPluginJournal,
  SSH_PLUGIN_JOURNAL_MAX_BYTES,
  SSH_PLUGIN_JOURNAL_RETENTION,
  sshPluginJournalFile,
} from './ssh-plugin-journal.ts'

interface Logged {
  level: 'log' | 'warn'
  args: unknown[]
}

function silentLogger(): { logger: { log(...args: unknown[]): void; warn(...args: unknown[]): void }; logs: Logged[] } {
  const logs: Logged[] = []
  return {
    logger: {
      log: (...args) => { logs.push({ level: 'log', args }) },
      warn: (...args) => { logs.push({ level: 'warn', args }) },
    },
    logs,
  }
}

function journalDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-ssh-journal-'))
}

function warns(logs: Logged[]): Logged[] {
  return logs.filter(entry => entry.level === 'warn')
}

// ============================================================================
// record / latestOk
// ============================================================================

test('journal: record + latestOk return the newest OK op of one instance only', () => {
  const dir = journalDir()
  const { logger } = silentLogger()
  const journal = createSshPluginJournal(dir, logger)
  journal.record({ instanceId: 's1', name: 'pkg-a', kind: 'add', specBefore: null, ok: true })
  journal.record({ instanceId: 's1', name: 'pkg-b', kind: 'remove', specBefore: '^2.0.0', ok: true })
  journal.record({ instanceId: 's2', name: 'pkg-c', kind: 'add', specBefore: null, ok: true })

  const latest = journal.latestOk('s1')
  assert.ok(latest !== null)
  if (latest !== null) {
    assert.equal(latest.name, 'pkg-b')
    assert.equal(latest.kind, 'remove')
    assert.equal(latest.specBefore, '^2.0.0')
    assert.equal(latest.instanceId, 's1')
    assert.equal(latest.ok, true)
    assert.equal(typeof latest.id, 'string')
    assert.equal(typeof latest.ts, 'number')
  }
  assert.equal(journal.latestOk('s2')?.name, 'pkg-c')
  assert.equal(journal.latestOk('s3'), null, 'an instance without ops has nothing to undo')
  // recent() is newest-first across instances.
  assert.deepEqual(journal.recent().map(op => op.name), ['pkg-c', 'pkg-b', 'pkg-a'])
})

test('journal: failed rows are recorded but never undoable (latestOk skips them)', () => {
  const dir = journalDir()
  const journal = createSshPluginJournal(dir, silentLogger().logger)
  journal.record({ instanceId: 's1', name: 'pkg-old', kind: 'remove', specBefore: '^1.0.0', ok: true })
  journal.record({ instanceId: 's1', name: 'pkg-new', kind: 'add', specBefore: null, ok: false, error: 'remote add failed' })
  const latest = journal.latestOk('s1')
  assert.ok(latest !== null)
  assert.equal(latest?.name, 'pkg-old', 'the failed add is not the undoable op')
  const failed = journal.recent().find(op => op.name === 'pkg-new')
  assert.equal(failed?.ok, false)
  assert.equal(failed?.error, 'remote add failed')
})

test('journal: specBefore round-trips unmasked (the undoable fact)', () => {
  const dir = journalDir()
  const journal = createSshPluginJournal(dir, silentLogger().logger)
  journal.record({ instanceId: 's1', name: 'mat-pkg', kind: 'remove', specBefore: 'file:/root/.dsh-chamber/plugins/mat-pkg-1.tgz', ok: true })
  const latest = journal.latestOk('s1')
  assert.equal(latest?.specBefore, 'file:/root/.dsh-chamber/plugins/mat-pkg-1.tgz')
})

test('journal: clear drops only the ops of the cleared instance', () => {
  const dir = journalDir()
  const journal = createSshPluginJournal(dir, silentLogger().logger)
  journal.record({ instanceId: 's1', name: 'a', kind: 'add', specBefore: null, ok: true })
  journal.record({ instanceId: 's2', name: 'b', kind: 'add', specBefore: null, ok: true })
  journal.clear('s1')
  assert.equal(journal.latestOk('s1'), null)
  assert.equal(journal.latestOk('s2')?.name, 'b')
})

test('journal: ops carry their operational target fingerprint; latestOkForTarget binds undo to the CURRENT target', () => {
  const dir = journalDir()
  const journal = createSshPluginJournal(dir, silentLogger().logger)
  journal.record({ instanceId: 's1', name: 'pkg-a', kind: 'add', fingerprint: 'fp-host-a', specBefore: null, ok: true })
  journal.record({ instanceId: 's1', name: 'pkg-b', kind: 'remove', fingerprint: 'fp-host-b', specBefore: '^1.0.0', ok: true })
  journal.record({ instanceId: 's1', name: 'legacy', kind: 'add', specBefore: null, ok: true })

  // The newest op of the CURRENT target is undoable...
  assert.equal(journal.latestOkForTarget('s1', 'fp-host-b')?.name, 'pkg-b')
  // ...an older op of the SAME target is reachable once the newer one of a
  // DIFFERENT target is out of the way (edits clear the journal in main, but
  // the per-op binding is the authoritative guard)...
  assert.equal(journal.latestOkForTarget('s1', 'fp-host-a')?.name, 'pkg-a')
  // ...ops of another target never are.
  assert.equal(journal.latestOkForTarget('s1', 'fp-host-c'), null)
  // Unbound/legacy ops (fingerprint null) are NEVER undoable: their target
  // cannot be proven.
  assert.equal(journal.latestOkForTarget('s1', 'fp-host-c') ?? null, null)
  // The unbound op's record still round-trips with fingerprint null.
  assert.equal(journal.recent().find(op => op.name === 'legacy')?.fingerprint, null)
  assert.equal(journal.recent().find(op => op.name === 'pkg-a')?.fingerprint, 'fp-host-a')
})

// ============================================================================
// retention / bounds / file discipline
// ============================================================================

test('journal: the file keeps only the newest RETENTION ops (per file, across instances)', () => {
  const dir = journalDir()
  const journal = createSshPluginJournal(dir, silentLogger().logger)
  for (let i = 0; i < SSH_PLUGIN_JOURNAL_RETENTION + 25; i += 1) {
    journal.record({ instanceId: 's1', name: `pkg-${i}`, kind: 'add', specBefore: null, ok: true })
  }
  const recent = journal.recent()
  assert.equal(recent.length, SSH_PLUGIN_JOURNAL_RETENTION)
  assert.equal(recent[0].name, `pkg-${SSH_PLUGIN_JOURNAL_RETENTION + 24}`, 'newest op retained first')
  assert.equal(journal.latestOk('s1')?.name, `pkg-${SSH_PLUGIN_JOURNAL_RETENTION + 24}`)
  const raw = JSON.parse(readFileSync(sshPluginJournalFile(dir), 'utf8')) as { ops: unknown[] }
  assert.equal(raw.ops.length, SSH_PLUGIN_JOURNAL_RETENTION, 'the on-disk array is pruned too')
})

test('journal: writes are atomic, 0600 and versioned', () => {
  const dir = journalDir()
  const journal = createSshPluginJournal(dir, silentLogger().logger)
  journal.record({ instanceId: 's1', name: 'pkg', kind: 'add', specBefore: null, ok: true })
  const file = sshPluginJournalFile(dir)
  assert.equal(existsSync(file), true)
  assert.equal(statSync(file).mode & 0o777, 0o600, 'journal file must be owner-only')
  assert.ok(!existsSync(`${file}.tmp`), 'no tmp residue after a successful write')
  const payload = JSON.parse(readFileSync(file, 'utf8')) as { version: number; ops: unknown[] }
  assert.equal(payload.version, 1)
  assert.equal(payload.ops.length, 1)
})

// ============================================================================
// corrupt / unreadable / oversized → aside + fresh (never crash-looping)
// ============================================================================

test('journal: a corrupt journal is moved aside with a warn and a fresh journal starts', () => {
  const dir = journalDir()
  const file = sshPluginJournalFile(dir)
  writeFileSync(file, '{not json', { mode: 0o600 })
  const { logger, logs } = silentLogger()
  const journal = createSshPluginJournal(dir, logger)
  assert.equal(journal.latestOk('s1'), null, 'a corrupt journal reads as empty')
  journal.record({ instanceId: 's1', name: 'pkg', kind: 'add', specBefore: null, ok: true })
  assert.equal(journal.latestOk('s1')?.name, 'pkg', 'fresh journal works after the aside')
  const asideWarn = warns(logs).find(entry => String(entry.args[0]).includes('moving it aside'))
  assert.ok(asideWarn !== undefined, 'the corruption must be loud (warn), never silent')
  const asideFiles = new Set<string>()
  for (const entry of warns(logs)) {
    const text = String(entry.args[0])
    for (const candidate of text.matchAll(/ssh-plugin-journal\.json\.corrupt-\d+/g)) asideFiles.add(candidate[0])
  }
  assert.equal(asideFiles.size, 1, 'the corrupt journal is retained as evidence beside the fresh one')
})

test('journal: an oversized journal (over the 64 KiB bound) is treated as corrupt evidence', () => {
  const dir = journalDir()
  const file = sshPluginJournalFile(dir)
  const oversized = `${JSON.stringify({ version: 1, ops: [] })}\n${'x'.repeat(SSH_PLUGIN_JOURNAL_MAX_BYTES)}`
  writeFileSync(file, oversized, { mode: 0o600 })
  const { logger, logs } = silentLogger()
  const journal = createSshPluginJournal(dir, logger)
  assert.equal(journal.latestOk('s1'), null)
  assert.ok(
    warns(logs).some(entry => String(entry.args[0]).includes('corrupt or unreadable')),
    'oversized reads must be loud, never silently truncated',
  )
  journal.record({ instanceId: 's1', name: 'pkg', kind: 'add', specBefore: null, ok: true })
  assert.equal(journal.latestOk('s1')?.name, 'pkg')
})

test('journal: an unsupported schema version is moved aside, not guessed at', () => {
  const dir = journalDir()
  const file = sshPluginJournalFile(dir)
  writeFileSync(file, JSON.stringify({ version: 99, ops: [] }), { mode: 0o600 })
  const { logger, logs } = silentLogger()
  const journal = createSshPluginJournal(dir, logger)
  assert.equal(journal.latestOk('s1'), null)
  assert.ok(warns(logs).some(entry => String(entry.args[0]).includes('schema version 99')))
})

// ============================================================================
// never-throw persistence
// ============================================================================

test('journal: record never throws — an unwritable journal directory warns and drops', () => {
  // A FILE in place of the journal DIRECTORY makes every read/write fail.
  const dir = journalDir()
  const blockedDir = join(dir, 'blocked-as-file')
  writeFileSync(blockedDir, '', { mode: 0o600 })
  const { logger, logs } = silentLogger()
  const journal = createSshPluginJournal(blockedDir, logger)
  journal.record({ instanceId: 's1', name: 'pkg', kind: 'add', specBefore: null, ok: true })
  assert.equal(journal.latestOk('s1'), null, 'the failed write never surfaces an op')
  assert.ok(warns(logs).some(entry => String(entry.args[0]).includes('could not persist record')))
})
