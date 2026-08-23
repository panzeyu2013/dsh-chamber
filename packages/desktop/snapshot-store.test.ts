/** snapshot-store design 17 §3.7 transactional data-safety tests. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  cp,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  cleanupSnapshotArtifacts,
  completeInterruptedRestore,
  findLatestSnapshotForVersion,
  prepareManualRollbackData,
  pruneSnapshots,
  restoreMarkerAuthorityStatus,
  restoreSnapshot,
  snapshotDshHome,
  snapshotPaths,
  snapshotSummary,
  stashPreRollback,
  type RestorePhase,
} from './snapshot-store.ts'

function makeDirs() {
  const base = mkdtempSync(path.join(tmpdir(), 'dsh-snap-'))
  const dshHome = path.join(base, 'state', 'dsh-home')
  mkdirSync(dshHome, { recursive: true })
  return { base, dshHome }
}

function put(dir: string, file: string, content: string) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, file), content, 'utf8')
}

function mode(file: string): number {
  return statSync(file).mode & 0o777
}

test('snapshotDshHome: still copy is atomically published and owner-only', async () => {
  const { base, dshHome } = makeDirs()
  put(dshHome, 'settings.yaml', 'x: 1')
  const snap = await snapshotDshHome(base, dshHome, '0.1.1-rc.2')
  assert.ok(snap.startsWith(snapshotPaths(base).snapshotsDir))
  assert.match(path.basename(snap), /^0\.1\.1-rc\.2-\d+$/)
  assert.equal(readFileSync(path.join(snap, 'settings.yaml'), 'utf8'), 'x: 1')
  assert.equal(readFileSync(path.join(dshHome, 'settings.yaml'), 'utf8'), 'x: 1')
  assert.equal(mode(snapshotPaths(base).snapshotsDir), 0o700)
  assert.equal(mode(snap), 0o700)
})

test('snapshotDshHome: missing home publishes a valid empty snapshot', async () => {
  const { base, dshHome } = makeDirs()
  rmSync(dshHome, { recursive: true, force: true })
  const snap = await snapshotDshHome(base, dshHome, '0.1.1-rc.2')
  assert.equal(readdirSync(snap).length, 0)
})

test('snapshotDshHome: partial-copy failure never publishes staging', async () => {
  const { base, dshHome } = makeDirs()
  put(dshHome, 'a', 'b')
  await assert.rejects(snapshotDshHome(base, dshHome, '0.1.1-rc.2', async (_src, dest) => {
    put(dest, 'partial', 'not-a-snapshot')
    throw new Error('ENOSPC')
  }), /ENOSPC/)
  assert.deepEqual(readdirSync(snapshotPaths(base).snapshotsDir), [])
})

test('restoreSnapshot: complete publishes staged snapshot and preserves old field', async () => {
  const { base, dshHome } = makeDirs()
  put(dshHome, 'current.txt', 'old-data')
  const snap = await snapshotDshHome(base, dshHome, '0.1.1-rc.2')
  put(dshHome, 'bad.txt', 'new-incompatible-data')
  assert.equal(await restoreSnapshot(base, dshHome, snap), 'complete')
  assert.equal(readFileSync(path.join(dshHome, 'current.txt'), 'utf8'), 'old-data')
  assert.ok(existsSync(path.join(`${dshHome}.old`, 'bad.txt')))
  assert.equal(mode(dshHome), 0o700)
  assert.equal(mode(`${dshHome}.old`), 0o700)
  assert.ok(!existsSync(snapshotPaths(base).restoreMarker))
})

test('restoreSnapshot: empty snapshot completes by phase, not by non-empty heuristic', async () => {
  const { base, dshHome } = makeDirs()
  rmSync(dshHome, { recursive: true, force: true })
  const empty = await snapshotDshHome(base, dshHome, '0.1.1')
  put(dshHome, 'new.txt', 'new')
  assert.equal(await restoreSnapshot(base, dshHome, empty), 'complete')
  assert.deepEqual(readdirSync(dshHome), [])
  assert.equal(readFileSync(path.join(`${dshHome}.old`, 'new.txt'), 'utf8'), 'new')
})

test('restoreSnapshot: partial copy fails twice without deleting or misreporting live data, then retries cleanly', async () => {
  const { base, dshHome } = makeDirs()
  put(dshHome, 'current.txt', 'unique-current')
  const snap = await snapshotDshHome(base, dshHome, '0.1.1')
  put(snap, 'wanted.txt', 'complete-snapshot')
  let attempts = 0
  const partialFailure = async (_src: string, dest: string) => {
    attempts += 1
    put(dest, `partial-${attempts}.txt`, 'partial')
    throw new Error('copy interrupted')
  }

  assert.equal(await restoreSnapshot(base, dshHome, snap, partialFailure), 'incomplete')
  assert.equal(await completeInterruptedRestore(base, dshHome, partialFailure), 'incomplete')
  assert.equal(readFileSync(path.join(dshHome, 'current.txt'), 'utf8'), 'unique-current')
  assert.ok(existsSync(snapshotPaths(base).restoreMarker))
  assert.equal(existsSync(`${dshHome}.old`), false)

  assert.equal(await completeInterruptedRestore(base, dshHome), 'complete')
  assert.equal(readFileSync(path.join(dshHome, 'wanted.txt'), 'utf8'), 'complete-snapshot')
  assert.equal(existsSync(path.join(dshHome, 'partial-1.txt')), false)
  assert.equal(existsSync(path.join(dshHome, 'partial-2.txt')), false)
  assert.equal(readFileSync(path.join(`${dshHome}.old`, 'current.txt'), 'utf8'), 'unique-current')
})

test('restoreSnapshot: empty partial copy failure remains incomplete and retries as a valid empty restore', async () => {
  const { base, dshHome } = makeDirs()
  rmSync(dshHome, { recursive: true, force: true })
  const empty = await snapshotDshHome(base, dshHome, '0.1.1')
  put(dshHome, 'current.txt', 'keep-until-staged')
  assert.equal(await restoreSnapshot(base, dshHome, empty, async (_src, dest) => {
    mkdirSync(dest, { recursive: true })
    throw new Error('failed after creating empty destination')
  }), 'incomplete')
  assert.equal(readFileSync(path.join(dshHome, 'current.txt'), 'utf8'), 'keep-until-staged')
  assert.equal(await completeInterruptedRestore(base, dshHome), 'complete')
  assert.deepEqual(readdirSync(dshHome), [])
})

test('restoreSnapshot: crash after backup resumes from explicit publishing phase', async () => {
  const { base, dshHome } = makeDirs()
  put(dshHome, 'current.txt', 'current')
  const snap = await snapshotDshHome(base, dshHome, '0.1.1')
  put(snap, 'restored.txt', 'restored')
  let crashed = false
  const afterPhase = (phase: RestorePhase) => {
    if (phase === 'publishing' && !crashed) {
      crashed = true
      throw new Error('simulated process death')
    }
  }
  assert.equal(await restoreSnapshot(base, dshHome, snap, undefined, { afterPhase }), 'half')
  assert.equal(existsSync(dshHome), false)
  assert.equal(readFileSync(path.join(`${dshHome}.old`, 'current.txt'), 'utf8'), 'current')
  assert.equal(await completeInterruptedRestore(base, dshHome), 'complete')
  assert.equal(readFileSync(path.join(dshHome, 'restored.txt'), 'utf8'), 'restored')
})

test('restoreSnapshot: crash after publish is recognized only from published phase', async () => {
  const { base, dshHome } = makeDirs()
  put(dshHome, 'current.txt', 'current')
  const snap = await snapshotDshHome(base, dshHome, '0.1.1')
  put(snap, 'restored.txt', 'restored')
  let crashed = false
  assert.equal(await restoreSnapshot(base, dshHome, snap, undefined, {
    afterPhase(phase) {
      if (phase === 'published' && !crashed) {
        crashed = true
        throw new Error('simulated process death')
      }
    },
  }), 'half')
  assert.ok(existsSync(snapshotPaths(base).restoreMarker))
  assert.equal(await completeInterruptedRestore(base, dshHome), 'complete')
  assert.equal(readFileSync(path.join(dshHome, 'restored.txt'), 'utf8'), 'restored')
})

test('restoreSnapshot: legacy ambiguous marker never treats partial non-empty home as complete', async () => {
  const { base, dshHome } = makeDirs()
  put(dshHome, 'source.txt', 'source')
  const snap = await snapshotDshHome(base, dshHome, '0.1.1')
  put(snap, 'required.txt', 'required')
  rmSync(dshHome, { recursive: true, force: true })
  put(dshHome, 'partial.txt', 'partial')
  put(`${dshHome}.old`, 'unique-old.txt', 'must-survive')
  const marker = snapshotPaths(base).restoreMarker
  writeFileSync(marker, JSON.stringify({ snapshotPath: snap, startedAt: 0 }), 'utf8')

  assert.equal(await completeInterruptedRestore(base, dshHome), 'complete')
  assert.equal(readFileSync(path.join(dshHome, 'required.txt'), 'utf8'), 'required')
  assert.equal(existsSync(path.join(dshHome, 'partial.txt')), false)
  assert.equal(readFileSync(path.join(`${dshHome}.old`, 'unique-old.txt'), 'utf8'), 'must-survive')
  const siblingBackups = readdirSync(path.dirname(dshHome)).filter((name) => name.startsWith(`${path.basename(dshHome)}.old-`))
  assert.equal(siblingBackups.length, 1)
  assert.equal(readFileSync(path.join(path.dirname(dshHome), siblingBackups[0], 'partial.txt'), 'utf8'), 'partial')
})

test('restoreSnapshot: missing marker snapshot is incomplete and preserves every field', async () => {
  const { base, dshHome } = makeDirs()
  put(dshHome, 'current.txt', 'current')
  put(`${dshHome}.old`, 'old.txt', 'old')
  const marker = snapshotPaths(base).restoreMarker
  mkdirSync(path.dirname(marker), { recursive: true })
  writeFileSync(marker, JSON.stringify({ snapshotPath: path.join(snapshotPaths(base).snapshotsDir, '0.1.1-1'), startedAt: 0 }), 'utf8')
  assert.equal(await completeInterruptedRestore(base, dshHome), 'incomplete')
  assert.equal(readFileSync(path.join(dshHome, 'current.txt'), 'utf8'), 'current')
  assert.equal(readFileSync(path.join(`${dshHome}.old`, 'old.txt'), 'utf8'), 'old')
})

test('restore marker authority rejects dangling/external symlinks and hardlinks without mutating targets', async () => {
  const { base, dshHome } = makeDirs()
  const marker = snapshotPaths(base).restoreMarker
  mkdirSync(path.dirname(marker), { recursive: true })

  symlinkSync(path.join(base, 'missing-marker-target'), marker, 'file')
  assert.equal(restoreMarkerAuthorityStatus(base), 'unsafe')
  assert.equal((await snapshotSummary(base)).restoreInProgress, true)
  assert.equal(await completeInterruptedRestore(base, dshHome), 'incomplete')
  assert.equal(lstatSync(marker).isSymbolicLink(), true)

  rmSync(marker, { force: true })
  const outside = path.join(base, 'outside-marker.json')
  writeFileSync(outside, '{}', { mode: 0o644 })
  chmodSync(outside, 0o644)
  symlinkSync(outside, marker, 'file')
  const symlinkTargetBefore = statSync(outside)
  assert.equal(await completeInterruptedRestore(base, dshHome), 'incomplete')
  const symlinkTargetAfter = statSync(outside)
  assert.equal(symlinkTargetAfter.mode & 0o777, symlinkTargetBefore.mode & 0o777)
  assert.equal(symlinkTargetAfter.ctimeMs, symlinkTargetBefore.ctimeMs)

  rmSync(marker, { force: true })
  linkSync(outside, marker)
  const hardlinkTargetBefore = statSync(outside)
  assert.equal(restoreMarkerAuthorityStatus(base), 'unsafe')
  assert.equal(await completeInterruptedRestore(base, dshHome), 'incomplete')
  const hardlinkTargetAfter = statSync(outside)
  assert.equal(hardlinkTargetAfter.mode & 0o777, hardlinkTargetBefore.mode & 0o777)
  assert.equal(hardlinkTargetAfter.nlink, hardlinkTargetBefore.nlink)
  assert.equal(hardlinkTargetAfter.mtimeMs, hardlinkTargetBefore.mtimeMs)
  assert.equal(hardlinkTargetAfter.ctimeMs, hardlinkTargetBefore.ctimeMs)
})

test('restore transaction rejects staged and published directory symlinks without following them', async () => {
  const staged = makeDirs()
  put(staged.dshHome, 'source.txt', 'source')
  const stagedSnapshot = await snapshotDshHome(staged.base, staged.dshHome, '0.1.1')
  let stagingPath = ''
  assert.equal(await restoreSnapshot(staged.base, staged.dshHome, stagedSnapshot, undefined, {
    afterPhase(phase, marker) {
      if (phase === 'staged') {
        stagingPath = marker.stagingPath
        throw new Error('pause at staged')
      }
    },
  }), 'incomplete')
  const stagedOutside = path.join(staged.base, 'staged-outside')
  mkdirSync(stagedOutside, { mode: 0o755 })
  chmodSync(stagedOutside, 0o755)
  rmSync(stagingPath, { recursive: true, force: true })
  symlinkSync(stagedOutside, stagingPath, 'dir')
  const stagedOutsideBefore = statSync(stagedOutside)
  assert.equal(await completeInterruptedRestore(staged.base, staged.dshHome), 'incomplete')
  assert.equal(lstatSync(stagingPath).isSymbolicLink(), true)
  assert.equal(statSync(stagedOutside).mode & 0o777, stagedOutsideBefore.mode & 0o777)
  assert.ok(existsSync(snapshotPaths(staged.base).restoreMarker))

  const published = makeDirs()
  put(published.dshHome, 'source.txt', 'source')
  const publishedSnapshot = await snapshotDshHome(published.base, published.dshHome, '0.1.1')
  assert.equal(await restoreSnapshot(published.base, published.dshHome, publishedSnapshot, undefined, {
    afterPhase(phase) {
      if (phase === 'published') throw new Error('pause at published')
    },
  }), 'half')
  const publishedOutside = path.join(published.base, 'published-outside')
  mkdirSync(publishedOutside, { mode: 0o755 })
  chmodSync(publishedOutside, 0o755)
  rmSync(published.dshHome, { recursive: true, force: true })
  symlinkSync(publishedOutside, published.dshHome, 'dir')
  const publishedOutsideBefore = statSync(publishedOutside)
  assert.equal(await completeInterruptedRestore(published.base, published.dshHome), 'incomplete')
  assert.equal(lstatSync(published.dshHome).isSymbolicLink(), true)
  assert.equal(statSync(publishedOutside).mode & 0o777, publishedOutsideBefore.mode & 0o777)
  assert.ok(existsSync(snapshotPaths(published.base).restoreMarker))
})

test('restore marker and snapshot store modes are owner-only even from permissive parents', async () => {
  const { base, dshHome } = makeDirs()
  put(dshHome, 'current.txt', 'current')
  const runtimeDir = path.join(base, 'dsh-runtime')
  mkdirSync(runtimeDir, { recursive: true, mode: 0o777 })
  const snap = await snapshotDshHome(base, dshHome, '0.1.1')
  assert.equal(await restoreSnapshot(base, dshHome, snap, undefined, {
    afterPhase(phase) {
      if (phase === 'copying') throw new Error('pause after marker')
    },
  }), 'incomplete')
  assert.equal(mode(runtimeDir), 0o700)
  assert.equal(mode(snapshotPaths(base).snapshotsDir), 0o700)
  assert.equal(mode(snapshotPaths(base).restoreMarker), 0o600)
})

test('snapshot lookup is exact and newest-first; manual helper stashes only when target data exists', async () => {
  const { base, dshHome } = makeDirs()
  const snapshots = snapshotPaths(base).snapshotsDir
  mkdirSync(path.join(snapshots, '0.1.1-100'), { recursive: true })
  mkdirSync(path.join(snapshots, '0.1.1-200'), { recursive: true })
  mkdirSync(path.join(snapshots, '0.1.10-999'), { recursive: true })
  assert.equal(await findLatestSnapshotForVersion(base, '0.1.1'), path.join(snapshots, '0.1.1-200'))

  put(dshHome, 'current.txt', 'current')
  const prepared = await prepareManualRollbackData(base, dshHome, '0.1.1')
  assert.equal(prepared.snapshotPath, path.join(snapshots, '0.1.1-200'))
  assert.ok(prepared.stashPath)
  assert.equal(readFileSync(path.join(prepared.stashPath!, 'current.txt'), 'utf8'), 'current')
  assert.equal(readFileSync(path.join(dshHome, 'current.txt'), 'utf8'), 'current', 'stash copy never moves live DSH_HOME')

  put(dshHome, 'keep.txt', 'keep')
  assert.deepEqual(await prepareManualRollbackData(base, dshHome, '9.9.9'), { snapshotPath: null, stashPath: null })
  assert.equal(readFileSync(path.join(dshHome, 'keep.txt'), 'utf8'), 'keep')
})

test('stashPreRollback: new stash precedes cleanup and directory stays owner-only', async () => {
  const { base, dshHome } = makeDirs()
  put(dshHome, 'v1.txt', 'one')
  const s1 = await stashPreRollback(base, dshHome)
  assert.ok(existsSync(path.join(s1, 'v1.txt')))
  put(dshHome, 'v2.txt', 'two')
  const s2 = await stashPreRollback(base, dshHome)
  assert.ok(existsSync(path.join(s2, 'v2.txt')))
  assert.deepEqual(readdirSync(snapshotPaths(base).preRollbackDir), [path.basename(s2)])
  assert.equal(mode(snapshotPaths(base).preRollbackDir), 0o700)
  assert.equal(mode(s2), 0o700)
})

test('stashPreRollback: partial-copy failure leaves live DSH_HOME and prior stash intact', async () => {
  const { base, dshHome } = makeDirs()
  put(dshHome, 'data.txt', 'authoritative')
  const prior = await stashPreRollback(base, dshHome)
  await assert.rejects(
    stashPreRollback(base, dshHome, async (_src, dest) => {
      put(dest, 'partial.txt', 'partial')
      throw new Error('ENOSPC')
    }),
    /ENOSPC/,
  )
  assert.equal(readFileSync(path.join(dshHome, 'data.txt'), 'utf8'), 'authoritative')
  assert.equal(readFileSync(path.join(prior, 'data.txt'), 'utf8'), 'authoritative')
  assert.deepEqual(readdirSync(snapshotPaths(base).preRollbackDir), [path.basename(prior)])
})

test('pruneSnapshots keeps newest active/known-good, exact failure/journal snapshots, and a bounded tail', async () => {
  const { base } = makeDirs()
  const dir = snapshotPaths(base).snapshotsDir
  for (const name of [
    '1.0.0-100', '1.0.0-200',
    '1.1.0-300', '1.1.0-400',
    '1.2.0-500', '1.3.0-600', '1.4.0-700',
  ]) mkdirSync(path.join(dir, name), { recursive: true })
  mkdirSync(path.join(dir, 'unparseable'), { recursive: true })

  const removed = await pruneSnapshots(base, {
    protectedVersions: ['1.0.0', '1.1.0'],
    protectedSnapshotNames: ['1.2.0-500'],
    keepRecentUnprotected: 1,
  })
  assert.deepEqual(removed.sort(), ['1.0.0-100', '1.1.0-300', '1.3.0-600'])
  assert.deepEqual(readdirSync(dir).sort(), [
    '1.0.0-200', '1.1.0-400', '1.2.0-500', '1.4.0-700', 'unparseable',
  ])
})

test('pruneSnapshots protects an active restore snapshot and fails closed on a corrupt marker', async () => {
  const { base } = makeDirs()
  const paths = snapshotPaths(base)
  const active = path.join(paths.snapshotsDir, '1.0.0-100')
  const old = path.join(paths.snapshotsDir, '2.0.0-200')
  mkdirSync(active, { recursive: true })
  mkdirSync(old, { recursive: true })
  writeFileSync(paths.restoreMarker, JSON.stringify({ snapshotPath: active }), 'utf8')
  assert.deepEqual(await pruneSnapshots(base, {
    protectedVersions: [], keepRecentUnprotected: 0,
  }), ['2.0.0-200'])
  assert.ok(existsSync(active))

  const another = path.join(paths.snapshotsDir, '3.0.0-300')
  mkdirSync(another, { recursive: true })
  writeFileSync(paths.restoreMarker, '{ broken', 'utf8')
  assert.deepEqual(await pruneSnapshots(base, {
    protectedVersions: [], keepRecentUnprotected: 0,
  }), [])
  assert.ok(existsSync(active))
  assert.ok(existsSync(another))
})

test('cleanupSnapshotArtifacts removes crash temps and keeps only the newest of four completed restores', async () => {
  const { base, dshHome } = makeDirs()
  put(dshHome, 'stable.txt', 'snapshot-data')
  const snap = await snapshotDshHome(base, dshHome, '1.0.0')
  const createdBackups: string[] = []

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    put(dshHome, `attempt-${attempt}.txt`, `before restore ${attempt}`)
    const before = new Set(readdirSync(path.dirname(dshHome)))
    assert.equal(await restoreSnapshot(base, dshHome, snap), 'complete')
    const created = readdirSync(path.dirname(dshHome)).find(name =>
      !before.has(name)
      && (name === `${path.basename(dshHome)}.old` || name.startsWith(`${path.basename(dshHome)}.old-`)))
    assert.ok(created, `restore ${attempt} published a unique backup`)
    createdBackups.push(created)
    // Use deliberately ordered mtimes so the retention assertion is stable on
    // filesystems whose rename ctime resolution is coarser than this loop.
    const time = new Date(Date.now() + attempt * 60_000)
    utimesSync(path.join(path.dirname(dshHome), created), time, time)
  }

  const paths = snapshotPaths(base)
  put(path.join(paths.snapshotsDir, '.tmp-crashed-snapshot'), 'partial', 'x')
  put(path.join(paths.preRollbackDir, '.tmp-crashed-stash'), 'partial', 'x')
  mkdirSync(path.join(paths.snapshotsDir, '.tmpish-user-entry'), { recursive: true })

  const cleaned = await cleanupSnapshotArtifacts(base, dshHome)
  assert.equal(cleaned.restoreBackupCleanup, 'completed')
  assert.deepEqual(cleaned.removedTemporaryEntries.sort(), [
    'pre-rollback/.tmp-crashed-stash',
    'snapshots/.tmp-crashed-snapshot',
  ])
  assert.equal(cleaned.removedRestoreBackups.length, 3)
  const remaining = readdirSync(path.dirname(dshHome)).filter(name =>
    name === `${path.basename(dshHome)}.old` || name.startsWith(`${path.basename(dshHome)}.old-`))
  assert.deepEqual(remaining, [createdBackups[3]])
  assert.equal(readFileSync(path.join(path.dirname(dshHome), remaining[0], 'attempt-4.txt'), 'utf8'), 'before restore 4')
  assert.ok(existsSync(path.join(paths.snapshotsDir, '.tmpish-user-entry')), 'only exact .tmp-* crash names are disposable')
})

test('cleanupSnapshotArtifacts deletes nothing while a valid or corrupt restore marker exists', async () => {
  const { base, dshHome } = makeDirs()
  const paths = snapshotPaths(base)
  put(path.join(paths.snapshotsDir, '.tmp-still-owned'), 'partial', 'x')
  put(path.join(paths.preRollbackDir, '.tmp-still-owned'), 'partial', 'x')
  put(`${dshHome}.old`, 'field.txt', 'field')
  mkdirSync(path.dirname(paths.restoreMarker), { recursive: true })

  writeFileSync(paths.restoreMarker, JSON.stringify({ snapshotPath: path.join(paths.snapshotsDir, '1.0.0-1') }))
  assert.deepEqual(await cleanupSnapshotArtifacts(base, dshHome), {
    removedTemporaryEntries: [],
    removedRestoreBackups: [],
    restoreBackupCleanup: 'blocked-marker',
  })
  assert.ok(existsSync(path.join(paths.snapshotsDir, '.tmp-still-owned')))
  assert.ok(existsSync(`${dshHome}.old`))

  writeFileSync(paths.restoreMarker, '{ corrupt')
  assert.deepEqual(await cleanupSnapshotArtifacts(base, dshHome), {
    removedTemporaryEntries: [],
    removedRestoreBackups: [],
    restoreBackupCleanup: 'blocked-marker',
  })
  assert.ok(existsSync(path.join(paths.preRollbackDir, '.tmp-still-owned')))
  assert.ok(existsSync(`${dshHome}.old`))
})

test('cleanupSnapshotArtifacts removes orphan temps but preserves every backup when DSH_HOME is missing', async () => {
  const { base, dshHome } = makeDirs()
  const paths = snapshotPaths(base)
  rmSync(dshHome, { recursive: true, force: true })
  put(`${dshHome}.old`, 'old.txt', 'old')
  put(`${dshHome}.old-123`, 'older.txt', 'older')
  put(path.join(paths.snapshotsDir, '.tmp-orphan'), 'partial', 'x')
  put(path.join(paths.preRollbackDir, '.tmp-orphan'), 'partial', 'x')

  const cleaned = await cleanupSnapshotArtifacts(base, dshHome)
  assert.equal(cleaned.restoreBackupCleanup, 'blocked-home-missing')
  assert.equal(cleaned.removedTemporaryEntries.length, 2)
  assert.deepEqual(cleaned.removedRestoreBackups, [])
  assert.ok(existsSync(`${dshHome}.old`))
  assert.ok(existsSync(`${dshHome}.old-123`))
})

test('cleanupSnapshotArtifacts never follows or removes a matching restore-backup symlink', {
  skip: process.platform === 'win32' ? 'symlink fixture requires Unix permissions' : false,
}, async () => {
  const { base, dshHome } = makeDirs()
  put(`${dshHome}.old`, 'old.txt', 'old')
  const outside = path.join(base, 'outside')
  put(outside, 'keep.txt', 'keep')
  symlinkSync(outside, `${dshHome}.old-unsafe`)

  const cleaned = await cleanupSnapshotArtifacts(base, dshHome)
  assert.equal(cleaned.restoreBackupCleanup, 'blocked-unsafe-entry')
  assert.deepEqual(cleaned.removedRestoreBackups, [])
  assert.ok(existsSync(`${dshHome}.old`), 'a sibling unsafe entry blocks all backup pruning')
  assert.equal(readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep')
})

test('snapshot and pre-rollback root symlinks fail closed without writing or deleting outside', async () => {
  const { base, dshHome } = makeDirs()
  put(dshHome, 'data', 'data')
  const runtime = path.join(base, 'dsh-runtime')
  mkdirSync(runtime, { recursive: true })
  const outsideSnapshots = path.join(base, 'outside-snapshots')
  put(outsideSnapshots, '.tmp-external', 'keep-temp')
  put(path.join(outsideSnapshots, '9.9.9-1'), 'data', 'keep-snapshot')
  chmodSync(outsideSnapshots, 0o755)
  symlinkSync(outsideSnapshots, snapshotPaths(base).snapshotsDir, 'dir')

  const outsideMode = statSync(outsideSnapshots).mode & 0o777
  await assert.rejects(snapshotDshHome(base, dshHome, '1.0.0'))
  assert.equal(statSync(outsideSnapshots).mode & 0o777, outsideMode)
  assert.equal(existsSync(path.join(outsideSnapshots, '1.0.0-1')), false)
  const cleaned = await cleanupSnapshotArtifacts(base, dshHome)
  assert.equal(cleaned.restoreBackupCleanup, 'blocked-unsafe-entry')
  assert.deepEqual(cleaned.removedTemporaryEntries, [])
  assert.deepEqual(await pruneSnapshots(base, { protectedVersions: [], keepRecentUnprotected: 0 }), [])
  assert.equal(readFileSync(path.join(outsideSnapshots, '.tmp-external'), 'utf8'), 'keep-temp')
  assert.equal(readFileSync(path.join(outsideSnapshots, '9.9.9-1', 'data'), 'utf8'), 'keep-snapshot')

  rmSync(snapshotPaths(base).snapshotsDir, { force: true })
  const outsideRollback = path.join(base, 'outside-rollback')
  put(outsideRollback, 'existing', 'keep-stash')
  chmodSync(outsideRollback, 0o755)
  symlinkSync(outsideRollback, snapshotPaths(base).preRollbackDir, 'dir')
  const rollbackMode = statSync(outsideRollback).mode & 0o777
  await assert.rejects(stashPreRollback(base, dshHome))
  assert.equal(statSync(outsideRollback).mode & 0o777, rollbackMode)
  assert.equal(readFileSync(path.join(outsideRollback, 'existing'), 'utf8'), 'keep-stash')
})

test('restore-backup cleanup rejects a symlinked DSH_HOME parent without touching outside backups', async () => {
  const { base, dshHome } = makeDirs()
  rmSync(path.dirname(dshHome), { recursive: true, force: true })
  const outsideState = path.join(base, 'outside-state')
  put(path.join(outsideState, 'dsh-home'), 'live', 'live')
  put(path.join(outsideState, 'dsh-home.old-1'), 'old', 'one')
  put(path.join(outsideState, 'dsh-home.old-2'), 'old', 'two')
  symlinkSync(outsideState, path.dirname(dshHome), 'dir')

  const result = await cleanupSnapshotArtifacts(base, dshHome)
  assert.equal(result.restoreBackupCleanup, 'blocked-unsafe-entry')
  assert.deepEqual(result.removedRestoreBackups, [])
  assert.equal(readFileSync(path.join(outsideState, 'dsh-home.old-1', 'old'), 'utf8'), 'one')
  assert.equal(readFileSync(path.join(outsideState, 'dsh-home.old-2', 'old'), 'utf8'), 'two')
})

test('snapshotSummary reports newest snapshot, restore marker, and stash count', async () => {
  const { base, dshHome } = makeDirs()
  put(dshHome, 'data', 'data')
  const snap = await snapshotDshHome(base, dshHome, '0.1.1')
  await stashPreRollback(base, dshHome)
  const marker = snapshotPaths(base).restoreMarker
  writeFileSync(marker, '{}', { mode: 0o600 })
  const summary = await snapshotSummary(base)
  assert.equal(summary.count, 1)
  assert.equal(summary.latestName, path.basename(snap))
  assert.match(String(summary.latestAt), /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(summary.restoreInProgress, true)
  assert.equal(summary.preRollbackCount, 1)
})

test('restoreSnapshot: staged copy itself may use node cp injection', async () => {
  const { base, dshHome } = makeDirs()
  put(dshHome, 'data', 'data')
  const snap = await snapshotDshHome(base, dshHome, '0.1.1')
  let copied = false
  assert.equal(await restoreSnapshot(base, dshHome, snap, async (src, dest) => {
    copied = true
    await new Promise<void>((resolve, reject) => cp(src, dest, { recursive: true }, (error) => error ? reject(error) : resolve()))
  }), 'complete')
  assert.equal(copied, true)
})
