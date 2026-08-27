import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  bootstrapCorruptMetadataRecoveryMarker,
  detectRuntimeMetadataHealth,
  inspectCorruptMetadataRecoveryMarker,
  readMetadataRecoveryState,
  recoverRuntimeMetadata,
  rescueCorruptMetadataRecoveryMarker,
  resumeMetadataRecoveryCore,
  type RuntimeMetadataRecoveryOperations,
} from '../src/runtime-metadata-recovery.ts'

interface Fixture {
  root: string
  baseDir: string
  runtimeDir: string
  dshHome: string
}

function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-runtime-metadata-recovery-'))
  const baseDir = path.join(root, 'user-data')
  const runtimeDir = path.join(baseDir, 'dsh-runtime')
  const dshHome = path.join(baseDir, 'dsh-home')
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  mkdirSync(path.join(dshHome, 'nested'), { recursive: true, mode: 0o755 })
  writeFileSync(path.join(dshHome, 'settings.yaml'), 'theme: dark\n', { mode: 0o644 })
  writeFileSync(path.join(dshHome, 'nested', 'session.json'), '{"id":"s1"}\n', { mode: 0o644 })
  return { root, baseDir, runtimeDir, dshHome }
}

function writeSelectionEvidence(f: Fixture): string[] {
  writeFileSync(path.join(f.runtimeDir, 'current'), '{ broken current', 'utf8')
  writeFileSync(path.join(f.runtimeDir, 'override.json'), JSON.stringify({
    shellVersion: '1.0.0',
    chosenVersion: '2.0.0',
    resolvedVersion: '2.0.0',
    pending: null,
    swapAttempted: false,
  }), 'utf8')
  writeFileSync(path.join(f.runtimeDir, 'activation-journal.json'), '{ broken journal', 'utf8')
  writeFileSync(path.join(f.runtimeDir, 'current.corrupt-older'), 'old-current', 'utf8')
  writeFileSync(path.join(f.runtimeDir, 'override.json.corrupt'), 'old-override', 'utf8')
  writeFileSync(path.join(f.runtimeDir, 'activation-journal.json.corrupt-extra'), 'old-journal', 'utf8')
  return [
    'activation-journal.json',
    'activation-journal.json.corrupt-extra',
    'current',
    'current.corrupt-older',
    'override.json',
    'override.json.corrupt',
  ]
}

function pathsFor(f: Fixture, id: string) {
  const transaction = path.join(f.runtimeDir, 'metadata-recovery-data', id)
  return {
    marker: path.join(f.runtimeDir, 'metadata-recovery.json'),
    transaction,
    stashTmp: path.join(transaction, '.dsh-home.stash.tmp'),
    stash: path.join(transaction, 'dsh-home.stash'),
    evidence: path.join(transaction, 'evidence'),
    ready: path.join(transaction, 'stash-ready.json'),
    finalized: path.join(transaction, 'finalized.json'),
  }
}

function rescuePathsFor(f: Fixture, id: string) {
  const transaction = path.join(f.runtimeDir, 'metadata-recovery-rescue-data', id)
  return {
    marker: path.join(f.runtimeDir, 'metadata-recovery.json'),
    transaction,
    stash: path.join(transaction, 'dsh-home.stash'),
    evidence: path.join(transaction, 'evidence'),
    ready: path.join(transaction, 'stash-ready.json'),
    finalized: path.join(transaction, 'finalized.json'),
  }
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function writeLegacyRecoveryTree(f: Fixture): { root: string; files: Map<string, Buffer> } {
  const root = path.join(f.runtimeDir, 'metadata-recovery-data')
  const stash = path.join(root, '1700000000000-deadbeefdeadbeef', 'dsh-home.stash')
  const evidence = path.join(root, '1700000000000-deadbeefdeadbeef', 'evidence')
  mkdirSync(stash, { recursive: true })
  mkdirSync(evidence, { recursive: true })
  const files = new Map<string, Buffer>([
    ['1700000000000-deadbeefdeadbeef/dsh-home.stash/original.txt', Buffer.from('legacy stash\n')],
    ['1700000000000-deadbeefdeadbeef/evidence/current', Buffer.from('{ old evidence')],
  ])
  for (const [relative, bytes] of files) writeFileSync(path.join(root, relative), bytes)
  return { root, files }
}

function assertLegacyRecoveryTreeUnchanged(root: string, files: Map<string, Buffer>): void {
  for (const [relative, bytes] of files) {
    assert.deepEqual(readFileSync(path.join(root, relative)), bytes)
  }
  assert.deepEqual(readdirSync(root), ['1700000000000-deadbeefdeadbeef'])
}

function exactMetadataSources(f: Fixture): string[] {
  return readdirSync(f.runtimeDir)
    .filter(name => name === 'current'
      || name === 'override.json'
      || name === 'activation-journal.json'
      || name.includes('.corrupt'))
    .sort()
}

test('detect health combines tri-state reads with durable corrupt sentinels', () => {
  const f = fixture()
  writeFileSync(path.join(f.runtimeDir, 'current'), JSON.stringify({ version: '1.0.0' }))
  writeFileSync(path.join(f.runtimeDir, 'override.json'), '{ malformed')
  writeFileSync(path.join(f.runtimeDir, 'activation-journal.json.corrupt-old'), 'journal evidence')

  const health = detectRuntimeMetadataHealth(f.baseDir)
  assert.equal(health.status, 'selection-corrupt')
  assert.equal(health.current.kind, 'valid')
  assert.equal(health.override.kind, 'corrupt')
  assert.equal(health.activationJournal.kind, 'missing')
  assert.deepEqual(health.corruptEvidence, [
    'activation-journal.json.corrupt-old',
    'override.json.corrupt',
  ])
  assert.ok(!existsSync(path.join(f.runtimeDir, 'override.json')))
  assert.ok(existsSync(path.join(f.runtimeDir, 'override.json.corrupt')))
})

function writeValidPreparedJournal(f: Fixture, targetVersion: string): void {
  writeFileSync(path.join(f.runtimeDir, 'activation-journal.json'), JSON.stringify({
    schemaVersion: 1,
    phase: 'prepared',
    targetVersion,
    targetIsBuiltin: false,
    manualRollback: false,
    intentKind: 'version-switch',
    sourceVersion: '1.0.0',
    sourceIsBuiltin: false,
    sourceWasKnownGood: false,
    knownGoodVersion: null,
    preSwapSnapshotName: '1.0.0-1700000000000',
    manualDataSnapshotName: null,
    preRollbackStashName: null,
    rollbackTarget: null,
    nextIntent: null,
    startedAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  }), 'utf8')
}

function writePendingOverride(f: Fixture, pending: string): void {
  writeFileSync(path.join(f.runtimeDir, 'override.json'), JSON.stringify({
    shellVersion: '0.1.5',
    chosenVersion: pending,
    resolvedVersion: pending,
    pending,
    swapAttempted: false,
  }), 'utf8')
}

test('detect health flags a semantically-mismatched journal target as selection-corrupt', () => {
  const f = fixture()
  writeFileSync(path.join(f.runtimeDir, 'current'), JSON.stringify({ version: '2.0.0' }), 'utf8')
  writePendingOverride(f, '2.0.0')
  writeValidPreparedJournal(f, '1.0.0') // journal target 1.0.0 ≠ pending 2.0.0

  const health = detectRuntimeMetadataHealth(f.baseDir)
  assert.equal(health.status, 'selection-corrupt')
  assert.equal(health.current.kind, 'valid')
  assert.equal(health.override.kind, 'valid')
  assert.equal(health.activationJournal.kind, 'valid')
})

test('detect health flags a missing journal with an already-advanced pointer as selection-corrupt', () => {
  const f = fixture()
  writeFileSync(path.join(f.runtimeDir, 'current'), JSON.stringify({ version: '2.0.0' }), 'utf8')
  writePendingOverride(f, '2.0.0')
  // no activation-journal.json — the pre-swap journal is missing while the
  // pointer already advanced to pending (runtime-startup journal-mismatch).

  const health = detectRuntimeMetadataHealth(f.baseDir)
  assert.equal(health.status, 'selection-corrupt')
  assert.equal(health.activationJournal.kind, 'missing')
})

test('detect health leaves a consistent pending state healthy', () => {
  const f = fixture()
  writeFileSync(path.join(f.runtimeDir, 'current'), JSON.stringify({ version: '1.0.0' }), 'utf8')
  writePendingOverride(f, '2.0.0')
  writeValidPreparedJournal(f, '2.0.0') // journal target == pending

  const health = detectRuntimeMetadataHealth(f.baseDir)
  assert.equal(health.status, 'healthy')
})

function writeRestoringJournal(f: Fixture, preSwapSnapshotName: string): void {
  writeFileSync(path.join(f.runtimeDir, 'activation-journal.json'), JSON.stringify({
    schemaVersion: 1,
    phase: 'restoring',
    targetVersion: '1.0.0',
    targetIsBuiltin: false,
    manualRollback: false,
    intentKind: 'version-switch',
    sourceVersion: '2.0.0',
    sourceIsBuiltin: false,
    sourceWasKnownGood: false,
    knownGoodVersion: null,
    preSwapSnapshotName,
    manualDataSnapshotName: null,
    preRollbackStashName: null,
    rollbackTarget: '1.0.0',
    nextIntent: null,
    startedAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  }), 'utf8')
}

test('detect health flags a restoring journal whose restore snapshot is gone', () => {
  const f = fixture()
  writeFileSync(path.join(f.runtimeDir, 'current'), JSON.stringify({ version: '2.0.0' }), 'utf8')
  writePendingOverride(f, '1.0.0')
  // The journal references a pre-swap snapshot that does not exist: the
  // restore can never complete (startup blocks 'restore-incomplete').
  writeRestoringJournal(f, '2.0.0-1700000000000')

  const health = detectRuntimeMetadataHealth(f.baseDir)
  assert.equal(health.status, 'selection-corrupt')
})

test('detect health leaves a restoring journal healthy while its snapshot exists', () => {
  const f = fixture()
  writeFileSync(path.join(f.runtimeDir, 'current'), JSON.stringify({ version: '2.0.0' }), 'utf8')
  writePendingOverride(f, '1.0.0')
  writeRestoringJournal(f, '2.0.0-1700000000000')
  mkdirSync(path.join(f.runtimeDir, 'snapshots', '2.0.0-1700000000000'), { recursive: true, mode: 0o700 })

  const health = detectRuntimeMetadataHealth(f.baseDir)
  assert.equal(health.status, 'healthy')
})

test('detect health flags an app-update-invalidated override mid-transaction', () => {
  const f = fixture()
  writeFileSync(path.join(f.runtimeDir, 'current'), JSON.stringify({ version: '1.0.0' }), 'utf8')
  // Override written by the OLD shell (0.1.4), journal still mid-transaction.
  writeFileSync(path.join(f.runtimeDir, 'override.json'), JSON.stringify({
    shellVersion: '0.1.4',
    chosenVersion: '2.0.0',
    resolvedVersion: '2.0.0',
    pending: '2.0.0',
    swapAttempted: false,
  }), 'utf8')
  writeValidPreparedJournal(f, '2.0.0')

  assert.equal(detectRuntimeMetadataHealth(f.baseDir).status, 'healthy', 'without the shell version the invalidation is unknowable')
  assert.equal(detectRuntimeMetadataHealth(f.baseDir, '0.1.5').status, 'selection-corrupt', 'a newer shell invalidates the old transaction')
})

test('full recovery stashes DSH_HOME, preserves every metadata byte, probes, and finalizes', async () => {
  const f = fixture()
  const expectedEvidence = writeSelectionEvidence(f)
  const sourceBytes = new Map(expectedEvidence.map(name => [
    name,
    readFileSync(path.join(f.runtimeDir, name), 'utf8'),
  ]))
  let stopped = 0
  let probed = 0

  const result = await recoverRuntimeMetadata({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => { stopped += 1 },
    completeRestore: async () => 'none',
    probeBuiltin: async () => {
      probed += 1
      assert.deepEqual(exactMetadataSources(f), [], 'probe runs only after selection metadata is archived')
      return { ok: true }
    },
  })

  assert.equal(result.status, 'finalized')
  assert.equal(result.phase, 'finalized')
  assert.equal(stopped, 1)
  assert.equal(probed, 1)
  assert.deepEqual(result.record.evidenceFiles, expectedEvidence)
  assert.deepEqual(result.record.archivedEvidence, expectedEvidence)
  assert.equal(result.record.probeAttempts, 1)
  const paths = pathsFor(f, result.record.id)
  assert.ok(existsSync(paths.stash))
  assert.ok(existsSync(paths.ready))
  assert.ok(existsSync(paths.finalized))
  assert.ok(!existsSync(paths.stashTmp))
  assert.equal(readFileSync(path.join(paths.stash, 'settings.yaml'), 'utf8'), 'theme: dark\n')
  assert.equal(readFileSync(path.join(paths.stash, 'nested', 'session.json'), 'utf8'), '{"id":"s1"}\n')
  assert.equal(statSync(paths.transaction).mode & 0o777, 0o700)
  assert.equal(statSync(paths.stash).mode & 0o777, 0o700)
  assert.equal(statSync(path.join(paths.stash, 'settings.yaml')).mode & 0o777, 0o600)
  assert.equal(statSync(paths.marker).mode & 0o777, 0o600)
  for (const name of expectedEvidence) {
    const archived = path.join(paths.evidence, name)
    assert.equal(readFileSync(archived, 'utf8'), sourceBytes.get(name))
    assert.equal(statSync(archived).mode & 0o777, 0o600)
  }
  const markerText = readFileSync(paths.marker, 'utf8')
  assert.ok(!markerText.includes(f.dshHome), 'marker never persists a user path')
  assert.equal(readMetadataRecoveryState(f.baseDir).kind, 'valid')
  assert.equal(detectRuntimeMetadataHealth(f.baseDir).status, 'recovery-finalized')
})

test('copy crash leaves every metadata source untouched; restart discards partial tmp and resumes', async () => {
  const f = fixture()
  const expectedEvidence = writeSelectionEvidence(f)
  let copies = 0
  const copyCrash: Partial<RuntimeMetadataRecoveryOperations> = {
    copyFile: (source, destination) => {
      copyFileSync(source, destination)
      copies += 1
      if (copies === 1) throw new Error('injected copy crash')
    },
  }
  await assert.rejects(() => recoverRuntimeMetadata({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
    operations: copyCrash,
  }), /injected copy crash/)

  const interrupted = readMetadataRecoveryState(f.baseDir)
  assert.equal(interrupted.kind, 'valid')
  if (interrupted.kind !== 'valid') throw new Error('unreachable')
  assert.equal(interrupted.record.phase, 'stashing')
  assert.deepEqual(exactMetadataSources(f), expectedEvidence)
  const paths = pathsFor(f, interrupted.record.id)
  assert.ok(!existsSync(paths.stash), 'no published stash after a copy crash')
  assert.deepEqual(readdirSync(paths.evidence), [], 'no metadata is archived without a stash')

  const resumed = await recoverRuntimeMetadata({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
  })
  assert.equal(resumed.status, 'finalized')
  assert.equal(resumed.record.id, interrupted.record.id)
  assert.ok(!existsSync(paths.stashTmp))
  assert.deepEqual(readdirSync(paths.evidence).sort(), expectedEvidence)
})

test('rename crash after filesystem effect resumes per file without overwriting or losing evidence', async () => {
  const f = fixture()
  const expectedEvidence = writeSelectionEvidence(f)
  let injected = false
  const renameCrash: Partial<RuntimeMetadataRecoveryOperations> = {
    renamePath: (source, destination, kind) => {
      renameSync(source, destination)
      if (!injected && kind === 'evidence' && path.basename(source) === 'current') {
        injected = true
        throw new Error('injected rename crash')
      }
    },
  }
  await assert.rejects(() => recoverRuntimeMetadata({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
    operations: renameCrash,
  }), /injected rename crash/)

  const interrupted = readMetadataRecoveryState(f.baseDir)
  assert.equal(interrupted.kind, 'valid')
  if (interrupted.kind !== 'valid') throw new Error('unreachable')
  assert.equal(interrupted.record.phase, 'archiving')
  const paths = pathsFor(f, interrupted.record.id)
  assert.ok(!existsSync(path.join(f.runtimeDir, 'current')))
  assert.ok(existsSync(path.join(paths.evidence, 'current')))

  const resumed = await recoverRuntimeMetadata({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
  })
  assert.equal(resumed.status, 'finalized')
  assert.deepEqual(readdirSync(paths.evidence).sort(), expectedEvidence)
})

test('phase crash after probe-required persists the checkpoint and resumes directly at probe', async () => {
  const f = fixture()
  writeSelectionEvidence(f)
  let crashed = false
  await assert.rejects(() => recoverRuntimeMetadata({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
    operations: {
      afterCheckpoint: checkpoint => {
        if (!crashed && checkpoint === 'probe-required') {
          crashed = true
          throw new Error('injected phase crash')
        }
      },
    },
  }), /injected phase crash/)
  const interrupted = readMetadataRecoveryState(f.baseDir)
  assert.equal(interrupted.kind, 'valid')
  if (interrupted.kind !== 'valid') throw new Error('unreachable')
  assert.equal(interrupted.record.phase, 'probe-required')

  let probes = 0
  const resumed = await recoverRuntimeMetadata({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => { probes += 1; return { ok: true } },
  })
  assert.equal(resumed.status, 'finalized')
  assert.equal(probes, 1)
  assert.equal(resumed.record.id, interrupted.record.id)
})

test('probe failure retains marker, stash, and evidence; a later successful probe finalizes idempotently', async () => {
  const f = fixture()
  const expectedEvidence = writeSelectionEvidence(f)
  let stopCalls = 0
  const failed = await recoverRuntimeMetadata({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => { stopCalls += 1 },
    completeRestore: async () => 'complete',
    probeBuiltin: async () => ({ ok: false, error: `${f.dshHome}/settings.yaml failed` }),
  })
  assert.equal(failed.status, 'probe-failed')
  assert.equal(failed.phase, 'probe-required')
  assert.equal(failed.record.probeAttempts, 1)
  assert.equal(stopCalls, 2, 'rejected probe host is stopped again')
  assert.ok(!failed.error.includes(f.dshHome), 'persisted/projected probe error is path-redacted')
  const paths = pathsFor(f, failed.record.id)
  assert.ok(existsSync(paths.stash))
  assert.deepEqual(readdirSync(paths.evidence).sort(), expectedEvidence)
  assert.ok(!existsSync(paths.finalized))

  const passed = await recoverRuntimeMetadata({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
  })
  assert.equal(passed.status, 'finalized')
  assert.equal(passed.record.id, failed.record.id)
  assert.equal(passed.record.probeAttempts, 2)
  assert.ok(existsSync(paths.finalized))
  assert.deepEqual(readdirSync(paths.evidence).sort(), expectedEvidence)
})

test('corrupt recovery marker blocks before lifecycle callbacks and preserves selection metadata', async () => {
  const f = fixture()
  writeSelectionEvidence(f)
  const marker = path.join(f.runtimeDir, 'metadata-recovery.json')
  writeFileSync(marker, '{ malformed marker', 'utf8')
  let stopped = 0

  assert.equal(detectRuntimeMetadataHealth(f.baseDir).status, 'recovery-marker-corrupt')
  await assert.rejects(() => recoverRuntimeMetadata({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => { stopped += 1 },
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
  }), /marker/)
  assert.equal(stopped, 0)
  assert.ok(existsSync(path.join(f.runtimeDir, 'current')))
  assert.ok(existsSync(marker))
  assert.ok(!existsSync(path.join(f.runtimeDir, 'metadata-recovery-data')))
})

test('unsafe recovery id and a symlinked DSH_HOME root fail closed without archiving metadata', async t => {
  if (process.platform === 'win32') {
    t.skip('runtime metadata mutation is read-only on Windows')
    return
  }
  const f = fixture()
  writeSelectionEvidence(f)
  const linkedHome = path.join(f.baseDir, 'linked-dsh-home')
  symlinkSync(f.dshHome, linkedHome)
  await assert.rejects(() => recoverRuntimeMetadata({
    baseDir: f.baseDir,
    dshHome: linkedHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
  }), /real directory/)
  assert.ok(existsSync(path.join(f.runtimeDir, 'current')))
  const state = readMetadataRecoveryState(f.baseDir)
  assert.equal(state.kind, 'missing')
  assert.ok(!existsSync(path.join(f.runtimeDir, 'metadata-recovery-data')))

  const f2 = fixture()
  writeSelectionEvidence(f2)
  writeFileSync(path.join(f2.runtimeDir, 'metadata-recovery.json'), JSON.stringify({
    schemaVersion: 1,
    id: '../escape',
    phase: 'stashing',
  }))
  assert.equal(readMetadataRecoveryState(f2.baseDir).kind, 'corrupt')
  assert.throws(() => resumeMetadataRecoveryCore({
    baseDir: f2.baseDir,
    dshHome: f2.dshHome,
    builtinVersion: '1.0.0',
  }), /invalid shape/)
  assert.ok(lstatSync(path.join(f2.runtimeDir, 'current')).isFile())
})

test('half/incomplete restore blocks before stash creation or evidence archival', async () => {
  const f = fixture()
  const expectedEvidence = writeSelectionEvidence(f)
  const result = await recoverRuntimeMetadata({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'half',
    probeBuiltin: async () => { throw new Error('probe must not run') },
  })
  assert.equal(result.status, 'restore-blocked')
  assert.equal(result.phase, 'restore-blocked')
  assert.deepEqual(exactMetadataSources(f), expectedEvidence)
  assert.ok(!existsSync(path.join(f.runtimeDir, 'metadata-recovery-data')))
})

test('missing-snapshot incomplete restore is recoverable via metadata recovery while half stays blocked', async () => {
  // 'half' is transient and retryable: the retry-restore action owns the scene
  // and metadata recovery must not archive over it.
  const half = fixture()
  writeSelectionEvidence(half)
  const blocked = await recoverRuntimeMetadata({
    baseDir: half.baseDir,
    dshHome: half.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'half',
    probeBuiltin: async () => { throw new Error('probe must not run') },
  })
  assert.equal(blocked.status, 'restore-blocked')
  assert.ok(!existsSync(path.join(half.runtimeDir, 'metadata-recovery-data')))

  // 'incomplete' is permanent (the journaled snapshot is missing or
  // untrustworthy — no retry can succeed). The recover-metadata path proceeds:
  // the selection evidence AND the stale restore marker are archived, the
  // active marker is cleared, and the builtin probe/finalize runs.
  const incomplete = fixture()
  const expectedEvidence = writeSelectionEvidence(incomplete)
  writeFileSync(path.join(incomplete.runtimeDir, 'restore-in-progress'), JSON.stringify({
    schemaVersion: 1,
    phase: 'copying',
    snapshotPath: 'unresolvable-snapshot',
  }), 'utf8')
  const result = await recoverRuntimeMetadata({
    baseDir: incomplete.baseDir,
    dshHome: incomplete.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'incomplete',
    probeBuiltin: async () => ({ ok: true }),
  })
  assert.equal(result.status, 'finalized')
  const paths = pathsFor(incomplete, result.record.id)
  assert.deepEqual(
    readdirSync(paths.evidence).sort(),
    [...expectedEvidence, 'restore-in-progress'].sort(),
    'selection evidence and the stale restore marker are archived',
  )
  assert.ok(
    !existsSync(path.join(incomplete.runtimeDir, 'restore-in-progress')),
    'the active restore marker is cleared by the archival',
  )
})

test('second-order rescue proceeds past an incomplete restore and archives the stale restore marker', async () => {
  const f = fixture()
  const corruptBytes = Buffer.from('{ incomplete-restore-corrupt-marker')
  writeFileSync(path.join(f.runtimeDir, 'metadata-recovery.json'), corruptBytes)
  writeFileSync(path.join(f.runtimeDir, 'restore-in-progress'), '{"schemaVersion":1,"phase":"copying"}', 'utf8')
  const result = await rescueCorruptMetadataRecoveryMarker({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'incomplete',
    probeBuiltin: async () => ({ ok: true }),
  })
  assert.equal(result.status, 'finalized')
  assert.equal(result.record.storageKind, 'marker-rescue')
  const paths = rescuePathsFor(f, result.record.id)
  assert.deepEqual(
    readdirSync(paths.evidence).sort(),
    ['metadata-recovery.json.prior-corrupt', 'restore-in-progress'],
  )
  assert.ok(!existsSync(path.join(f.runtimeDir, 'restore-in-progress')))
})

test('missing DSH_HOME publishes a valid empty stash before archiving metadata', async () => {
  const f = fixture()
  const missingHome = path.join(f.baseDir, 'never-created-dsh-home')
  const expectedEvidence = writeSelectionEvidence(f)
  const result = await recoverRuntimeMetadata({
    baseDir: f.baseDir,
    dshHome: missingHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => {
      mkdirSync(missingHome, { recursive: true })
      writeFileSync(path.join(missingHome, 'created-by-builtin'), 'ok')
      return { ok: true }
    },
  })
  assert.equal(result.status, 'finalized')
  assert.equal(result.record.dshHomeWasMissing, true)
  const paths = pathsFor(f, result.record.id)
  assert.deepEqual(readdirSync(paths.stash), [], 'missing source is represented by an empty published stash')
  assert.ok(existsSync(paths.ready), 'empty stash still has a durable completion record')
  assert.deepEqual(readdirSync(paths.evidence).sort(), expectedEvidence)
})

test('stash preserves normal and dangling profile symlinks without reading their targets', async t => {
  if (process.platform === 'win32') {
    t.skip('symlink creation requires platform privileges on Windows')
    return
  }
  const f = fixture()
  writeSelectionEvidence(f)
  const nodeModules = path.join(f.dshHome, 'profiles', 'node_modules')
  const external = path.join(f.root, 'outside-sensitive-package')
  mkdirSync(nodeModules, { recursive: true })
  mkdirSync(external, { recursive: true })
  const secret = 'SECRET-MUST-NOT-BE-COPIED-5e73f6f1'
  writeFileSync(path.join(external, 'secret.txt'), secret)
  chmodSync(external, 0o000)
  const packageTarget = path.relative(nodeModules, external)
  const danglingTarget = '../missing-package-target'
  symlinkSync(packageTarget, path.join(nodeModules, 'dsh-app'))
  symlinkSync(danglingTarget, path.join(nodeModules, 'dangling-app'))

  const result = await recoverRuntimeMetadata({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
  })

  assert.equal(result.status, 'finalized')
  const stashNodeModules = path.join(pathsFor(f, result.record.id).stash, 'profiles', 'node_modules')
  const copiedPackageLink = path.join(stashNodeModules, 'dsh-app')
  const copiedDanglingLink = path.join(stashNodeModules, 'dangling-app')
  assert.ok(lstatSync(copiedPackageLink).isSymbolicLink())
  assert.ok(lstatSync(copiedDanglingLink).isSymbolicLink())
  assert.equal(readlinkSync(copiedPackageLink), packageTarget)
  assert.equal(readlinkSync(copiedDanglingLink), danglingTarget)
  assert.deepEqual(readdirSync(stashNodeModules).sort(), ['dangling-app', 'dsh-app'])
  assert.ok(!readFileSync(path.join(pathsFor(f, result.record.id).stash, 'settings.yaml'), 'utf8').includes(secret))
  chmodSync(external, 0o700)
})

test('stash rejects unsupported special filesystem entries before metadata archival', async t => {
  if (process.platform === 'win32') {
    t.skip('filesystem socket fixture is POSIX-only')
    return
  }
  const f = fixture()
  const expectedEvidence = writeSelectionEvidence(f)
  const fifoPath = path.join(f.dshHome, 'unsupported.fifo')
  execFileSync('/usr/bin/mkfifo', [fifoPath])
  await assert.rejects(() => recoverRuntimeMetadata({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
  }), /non-file, non-directory/)
  assert.deepEqual(exactMetadataSources(f), expectedEvidence)
})

test('stash detects an ancestor directory replaced by a symlink and never publishes outside bytes', async t => {
  if (process.platform === 'win32') {
    t.skip('symlink creation requires platform privileges on Windows')
    return
  }
  const f = fixture()
  const expectedEvidence = writeSelectionEvidence(f)
  const sourceDirectory = path.join(f.dshHome, 'profiles', 'race-source')
  const movedDirectory = path.join(f.root, 'original-race-source')
  const outsideDirectory = path.join(f.root, 'outside-race-source')
  mkdirSync(sourceDirectory, { recursive: true })
  mkdirSync(outsideDirectory, { recursive: true })
  writeFileSync(path.join(sourceDirectory, 'a-trigger'), 'inside-trigger')
  writeFileSync(path.join(sourceDirectory, 'z-victim'), 'inside-victim')
  const outsideSecret = 'OUTSIDE-SECRET-MUST-NEVER-BE-STASHED'
  writeFileSync(path.join(outsideDirectory, 'a-trigger'), 'outside-trigger')
  writeFileSync(path.join(outsideDirectory, 'z-victim'), outsideSecret)
  let swapped = false

  await assert.rejects(() => recoverRuntimeMetadata({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
    operations: {
      copyFile: (source, destination) => {
        copyFileSync(source, destination)
        if (!swapped && source === path.join(sourceDirectory, 'a-trigger')) {
          swapped = true
          renameSync(sourceDirectory, movedDirectory)
          symlinkSync(outsideDirectory, sourceDirectory)
        }
      },
    },
  }), /identity changed/)

  const state = readMetadataRecoveryState(f.baseDir)
  assert.equal(state.kind, 'valid')
  if (state.kind !== 'valid') throw new Error('unreachable')
  assert.equal(state.record.phase, 'stashing')
  const paths = pathsFor(f, state.record.id)
  assert.ok(!existsSync(paths.stash), 'a raced source tree never publishes a stash')
  assert.ok(!existsSync(path.join(paths.stashTmp, 'profiles', 'race-source', 'z-victim')))
  assert.deepEqual(exactMetadataSources(f), expectedEvidence)
})

test('multiply linked marker or selection metadata fails closed without changing the old recovery tree', async () => {
  const selection = fixture()
  writeSelectionEvidence(selection)
  const selectionLegacy = writeLegacyRecoveryTree(selection)
  const legacySelectionFile = path.join(
    selectionLegacy.root,
    '1700000000000-deadbeefdeadbeef/evidence/current',
  )
  const activeCurrent = path.join(selection.runtimeDir, 'current')
  unlinkSync(activeCurrent)
  linkSync(legacySelectionFile, activeCurrent)
  const corruptMarker = Buffer.from('{ independent-corrupt-marker')
  writeFileSync(path.join(selection.runtimeDir, 'metadata-recovery.json'), corruptMarker)
  const selectionBefore = statSync(legacySelectionFile)
  const selectionBytes = readFileSync(legacySelectionFile)

  await assert.rejects(() => rescueCorruptMetadataRecoveryMarker({
    baseDir: selection.baseDir,
    dshHome: selection.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
  }), /metadata evidence/)
  const selectionAfter = statSync(legacySelectionFile)
  assert.deepEqual(readFileSync(legacySelectionFile), selectionBytes)
  assert.equal(selectionAfter.mode, selectionBefore.mode)
  assert.equal(selectionAfter.nlink, selectionBefore.nlink)
  assert.equal(selectionAfter.mtimeMs, selectionBefore.mtimeMs)
  assert.equal(selectionAfter.ctimeMs, selectionBefore.ctimeMs)

  const marker = fixture()
  const markerLegacy = writeLegacyRecoveryTree(marker)
  const legacyMarkerFile = path.join(
    markerLegacy.root,
    '1700000000000-deadbeefdeadbeef/evidence/current',
  )
  const activeMarker = path.join(marker.runtimeDir, 'metadata-recovery.json')
  linkSync(legacyMarkerFile, activeMarker)
  const markerBefore = statSync(legacyMarkerFile)
  const markerBytes = readFileSync(legacyMarkerFile)
  assert.deepEqual(inspectCorruptMetadataRecoveryMarker(marker.baseDir), {
    recoverable: false,
    reason: 'marker-unsafe',
  })
  await assert.rejects(() => rescueCorruptMetadataRecoveryMarker({
    baseDir: marker.baseDir,
    dshHome: marker.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
  }), /marker-unsafe/)
  const markerAfter = statSync(legacyMarkerFile)
  assert.deepEqual(readFileSync(legacyMarkerFile), markerBytes)
  assert.equal(markerAfter.mode, markerBefore.mode)
  assert.equal(markerAfter.nlink, markerBefore.nlink)
  assert.equal(markerAfter.mtimeMs, markerBefore.mtimeMs)
  assert.equal(markerAfter.ctimeMs, markerBefore.ctimeMs)
})

test('health detection rejects a hard-linked authority leaf without changing old recovery evidence', () => {
  const f = fixture()
  const legacy = writeLegacyRecoveryTree(f)
  const evidence = path.join(
    legacy.root,
    '1700000000000-deadbeefdeadbeef/evidence/current',
  )
  const activeCurrent = path.join(f.runtimeDir, 'current')
  linkSync(evidence, activeCurrent)
  const before = statSync(evidence)
  const beforeBytes = readFileSync(evidence)

  const health = detectRuntimeMetadataHealth(f.baseDir)
  assert.equal(health.status, 'selection-corrupt')
  assert.deepEqual(health.current, { kind: 'corrupt' })

  const after = statSync(evidence)
  assert.deepEqual(readFileSync(evidence), beforeBytes)
  assert.equal(after.mode, before.mode)
  assert.equal(after.nlink, before.nlink)
  assert.equal(after.mtimeMs, before.mtimeMs)
  assert.equal(after.ctimeMs, before.ctimeMs)
})

test('corrupt-marker rescue capability exposes only opaque facts and rejects unsafe markers', () => {
  const missing = fixture()
  assert.deepEqual(inspectCorruptMetadataRecoveryMarker(missing.baseDir), {
    recoverable: false,
    reason: 'marker-missing',
  })

  const malformed = Buffer.from([0x7b, 0x20, 0xff, 0x00, 0x7d])
  const marker = path.join(missing.runtimeDir, 'metadata-recovery.json')
  writeFileSync(marker, malformed)
  assert.deepEqual(inspectCorruptMetadataRecoveryMarker(missing.baseDir), {
    recoverable: true,
    byteLength: malformed.byteLength,
    sha256: sha256(malformed),
  })

  if (process.platform !== 'win32') {
    const unsafe = fixture()
    const target = path.join(unsafe.root, 'marker-target')
    writeFileSync(target, '{ malformed target')
    symlinkSync(target, path.join(unsafe.runtimeDir, 'metadata-recovery.json'))
    assert.deepEqual(inspectCorruptMetadataRecoveryMarker(unsafe.baseDir), {
      recoverable: false,
      reason: 'marker-unsafe',
    })
  }

  const directory = fixture()
  mkdirSync(path.join(directory.runtimeDir, 'metadata-recovery.json'))
  assert.deepEqual(inspectCorruptMetadataRecoveryMarker(directory.baseDir), {
    recoverable: false,
    reason: 'marker-unsafe',
  })
})

test('second-order rescue preserves opaque marker, full stash, selection evidence, and old recovery tree', async () => {
  const f = fixture()
  const selectionEvidence = writeSelectionEvidence(f)
  const corruptMarker = Buffer.from([0x7b, 0x22, 0x62, 0x61, 0x64, 0xff, 0x00])
  writeFileSync(path.join(f.runtimeDir, 'metadata-recovery.json'), corruptMarker)
  const legacy = writeLegacyRecoveryTree(f)
  let probes = 0

  const result = await rescueCorruptMetadataRecoveryMarker({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => {
      probes += 1
      assert.deepEqual(exactMetadataSources(f), [])
      return { ok: true }
    },
  })

  assert.equal(result.status, 'finalized')
  assert.equal(probes, 1)
  assert.equal(result.record.storageKind, 'marker-rescue')
  assert.deepEqual(result.record.priorRecoveryMarker, {
    name: 'metadata-recovery.json.prior-corrupt',
    byteLength: corruptMarker.byteLength,
    sha256: sha256(corruptMarker),
  })
  assert.deepEqual(result.record.evidenceFiles, [
    ...selectionEvidence,
    'metadata-recovery.json.prior-corrupt',
  ].sort())
  const paths = rescuePathsFor(f, result.record.id)
  assert.deepEqual(
    readFileSync(path.join(paths.evidence, 'metadata-recovery.json.prior-corrupt')),
    corruptMarker,
  )
  assert.equal(readFileSync(path.join(paths.stash, 'settings.yaml'), 'utf8'), 'theme: dark\n')
  assert.ok(existsSync(paths.finalized))
  assertLegacyRecoveryTreeUnchanged(legacy.root, legacy.files)
  assert.deepEqual(inspectCorruptMetadataRecoveryMarker(f.baseDir), {
    recoverable: false,
    reason: 'marker-valid',
  })
})

test('marker-only second-order rescue is valid and does not infer missing selection data', async () => {
  const f = fixture()
  const corruptMarker = Buffer.from('{ marker-only corruption')
  writeFileSync(path.join(f.runtimeDir, 'metadata-recovery.json'), corruptMarker)

  const bootstrapped = bootstrapCorruptMetadataRecoveryMarker({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
  })
  assert.equal(bootstrapped.phase, 'probe-required')
  if (bootstrapped.phase !== 'probe-required') throw new Error('unreachable')
  assert.deepEqual(bootstrapped.record.evidenceFiles, ['metadata-recovery.json.prior-corrupt'])
  const paths = rescuePathsFor(f, bootstrapped.record.id)
  assert.deepEqual(readFileSync(path.join(paths.evidence, 'metadata-recovery.json.prior-corrupt')), corruptMarker)

  const resumed = await recoverRuntimeMetadata({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
  })
  assert.equal(resumed.status, 'finalized')
  assert.equal(resumed.record.id, bootstrapped.record.id)
})

test('second-order rescue copy crash leaves active marker and old recovery tree untouched', async () => {
  const f = fixture()
  const expectedEvidence = writeSelectionEvidence(f)
  const corruptMarker = Buffer.from('{ corrupt-marker-copy-crash')
  const marker = path.join(f.runtimeDir, 'metadata-recovery.json')
  writeFileSync(marker, corruptMarker)
  const legacy = writeLegacyRecoveryTree(f)
  let copied = 0

  await assert.rejects(() => rescueCorruptMetadataRecoveryMarker({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
    operations: {
      copyFile: (source, destination) => {
        copyFileSync(source, destination)
        copied += 1
        if (copied === 1) throw new Error('injected rescue stash copy crash')
      },
    },
  }), /injected rescue stash copy crash/)

  assert.deepEqual(readFileSync(marker), corruptMarker)
  assert.deepEqual(exactMetadataSources(f), expectedEvidence)
  assert.equal(readMetadataRecoveryState(f.baseDir).kind, 'corrupt')
  assertLegacyRecoveryTreeUnchanged(legacy.root, legacy.files)
})

test('second-order rescue revalidates marker identity and bytes after opaque copy', async () => {
  const f = fixture()
  const expectedEvidence = writeSelectionEvidence(f)
  const original = Buffer.from('{ marker-before-concurrent-change')
  const changed = Buffer.from('{ marker-after-concurrent-change')
  const marker = path.join(f.runtimeDir, 'metadata-recovery.json')
  writeFileSync(marker, original)

  await assert.rejects(() => rescueCorruptMetadataRecoveryMarker({
    baseDir: f.baseDir,
    dshHome: f.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
    operations: {
      copyFile: (source, destination) => {
        copyFileSync(source, destination)
        if (source === marker) writeFileSync(marker, changed)
      },
    },
  }), /changed while its evidence was copied/)

  assert.deepEqual(readFileSync(marker), changed)
  assert.equal(readMetadataRecoveryState(f.baseDir).kind, 'corrupt')
  assert.deepEqual(exactMetadataSources(f), expectedEvidence)
})

test('atomic marker rescue commit is restartable both before and after rename effect', async () => {
  const before = fixture()
  writeSelectionEvidence(before)
  const beforeBytes = Buffer.from('{ corrupt-before-commit')
  const beforeMarker = path.join(before.runtimeDir, 'metadata-recovery.json')
  writeFileSync(beforeMarker, beforeBytes)
  await assert.rejects(() => rescueCorruptMetadataRecoveryMarker({
    baseDir: before.baseDir,
    dshHome: before.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
    operations: {
      renamePath: (source, destination, kind) => {
        if (kind === 'marker-rescue-commit') throw new Error('injected pre-commit rename crash')
        renameSync(source, destination)
      },
    },
  }), /injected pre-commit rename crash/)
  assert.deepEqual(readFileSync(beforeMarker), beforeBytes)
  assert.equal(readMetadataRecoveryState(before.baseDir).kind, 'corrupt')
  const orphanId = readdirSync(path.join(before.runtimeDir, 'metadata-recovery-rescue-data'))[0]
  const orphanPaths = rescuePathsFor(before, orphanId)
  assert.ok(existsSync(orphanPaths.stash))
  assert.deepEqual(
    readFileSync(path.join(orphanPaths.evidence, 'metadata-recovery.json.prior-corrupt')),
    beforeBytes,
  )

  const beforeRestarted = await rescueCorruptMetadataRecoveryMarker({
    baseDir: before.baseDir,
    dshHome: before.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
  })
  assert.equal(beforeRestarted.status, 'finalized')

  const after = fixture()
  writeSelectionEvidence(after)
  const afterBytes = Buffer.from('{ corrupt-after-commit')
  writeFileSync(path.join(after.runtimeDir, 'metadata-recovery.json'), afterBytes)
  let injected = false
  await assert.rejects(() => rescueCorruptMetadataRecoveryMarker({
    baseDir: after.baseDir,
    dshHome: after.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
    operations: {
      renamePath: (source, destination, kind) => {
        renameSync(source, destination)
        if (!injected && kind === 'marker-rescue-commit') {
          injected = true
          throw new Error('injected post-commit rename crash')
        }
      },
    },
  }), /injected post-commit rename crash/)
  const committed = readMetadataRecoveryState(after.baseDir)
  assert.equal(committed.kind, 'valid')
  if (committed.kind !== 'valid') throw new Error('unreachable')
  assert.equal(committed.record.phase, 'archiving')
  assert.equal(committed.record.storageKind, 'marker-rescue')

  const afterRestarted = await recoverRuntimeMetadata({
    baseDir: after.baseDir,
    dshHome: after.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
  })
  assert.equal(afterRestarted.status, 'finalized')
  assert.equal(afterRestarted.record.id, committed.record.id)
  assert.deepEqual(
    readFileSync(path.join(
      rescuePathsFor(after, committed.record.id).evidence,
      'metadata-recovery.json.prior-corrupt',
    )),
    afterBytes,
  )
})

test('second-order restore block makes no rescue transaction and probe failure remains retryable', async () => {
  const blocked = fixture()
  const blockedBytes = Buffer.from('{ blocked-corrupt-marker')
  writeFileSync(path.join(blocked.runtimeDir, 'metadata-recovery.json'), blockedBytes)
  const blockedResult = await rescueCorruptMetadataRecoveryMarker({
    baseDir: blocked.baseDir,
    dshHome: blocked.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'half',
    probeBuiltin: async () => { throw new Error('must not probe') },
  })
  assert.equal(blockedResult.status, 'restore-blocked')
  assert.deepEqual(readFileSync(path.join(blocked.runtimeDir, 'metadata-recovery.json')), blockedBytes)
  assert.ok(!existsSync(path.join(blocked.runtimeDir, 'metadata-recovery-rescue-data')))

  const retryable = fixture()
  writeSelectionEvidence(retryable)
  const corruptBytes = Buffer.from('{ probe-failure-corrupt-marker')
  writeFileSync(path.join(retryable.runtimeDir, 'metadata-recovery.json'), corruptBytes)
  const legacy = writeLegacyRecoveryTree(retryable)
  const failed = await rescueCorruptMetadataRecoveryMarker({
    baseDir: retryable.baseDir,
    dshHome: retryable.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'complete',
    probeBuiltin: async () => ({ ok: false, error: 'builtin still unavailable' }),
  })
  assert.equal(failed.status, 'probe-failed')
  assert.equal(failed.record.storageKind, 'marker-rescue')
  const paths = rescuePathsFor(retryable, failed.record.id)
  assert.deepEqual(
    readFileSync(path.join(paths.evidence, 'metadata-recovery.json.prior-corrupt')),
    corruptBytes,
  )
  assert.ok(existsSync(paths.stash))
  assert.ok(!existsSync(paths.finalized))
  assertLegacyRecoveryTreeUnchanged(legacy.root, legacy.files)

  const passed = await recoverRuntimeMetadata({
    baseDir: retryable.baseDir,
    dshHome: retryable.dshHome,
    builtinVersion: '1.0.0',
    stopHost: async () => undefined,
    completeRestore: async () => 'none',
    probeBuiltin: async () => ({ ok: true }),
  })
  assert.equal(passed.status, 'finalized')
  assert.equal(passed.record.id, failed.record.id)
  assertLegacyRecoveryTreeUnchanged(legacy.root, legacy.files)
})
