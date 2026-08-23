/**
 * dsh runtime snapshot/restore (design 16 §3.7) — the cross-version user-data
 * protection core. The runtime tree and user data (DSH_HOME) are physically
 * separate, so the only real risks are ① new version can't read old data and
 * ② a rolled-back old version can't read newer-written data. This module
 * guarantees「数据不因版本切换而丢失/损坏不可恢复」via: a still copy of
 * DSH_HOME before every switch (no-snapshot-no-switch), a two-phase restore
 * with idempotent completion, and a pre-rollback stash.
 *
 * Pure node built-ins, baseDir/dshHome injected — no electron, no IPC.
 */
import { cp, mkdir, readdir, rename, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface SnapshotPaths {
  /** `<baseDir>/dsh-runtime/snapshots` */
  snapshotsDir: string
  /** `<baseDir>/dsh-runtime/pre-rollback` */
  preRollbackDir: string
  /** `<baseDir>/dsh-runtime/restore-in-progress` */
  restoreMarker: string
}

export function snapshotPaths(baseDir: string): SnapshotPaths {
  const runtime = join(baseDir, 'dsh-runtime')
  return {
    snapshotsDir: join(runtime, 'snapshots'),
    preRollbackDir: join(runtime, 'pre-rollback'),
    restoreMarker: join(runtime, 'restore-in-progress'),
  }
}

type CopyFn = (src: string, dest: string) => Promise<void>

/** Recursive copy default (still copy = a DSH_HOME snapshot). */
const defaultCopy: CopyFn = async (src, dest) => {
  await cp(src, dest, { recursive: true })
}

async function dirNonEmpty(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir)
    return entries.length > 0
  } catch {
    return false
  }
}

/**
 * Take a still copy of DSH_HOME and atomically publish it to
 * `snapshots/<sourceVersion>-<timestamp>/`. `sourceVersion` is the version
 * that was active BEFORE the switch (§3.7 naming). A missing/empty DSH_HOME
 * still publishes a snapshot (recording「源版本无数据」). Any failure throws
 * — the caller must NOT switch the pointer (no-snapshot-no-switch).
 */
export async function snapshotDshHome(
  baseDir: string,
  dshHome: string,
  sourceVersion: string,
  copyFn: CopyFn = defaultCopy,
): Promise<string> {
  const paths = snapshotPaths(baseDir)
  await mkdir(paths.snapshotsDir, { recursive: true })
  const staging = join(paths.snapshotsDir, `.tmp-${randomBytes(4).toString('hex')}`)
  const finalPath = join(paths.snapshotsDir, `${sourceVersion}-${Date.now()}`)
  await mkdir(staging, { recursive: true })
  try {
    // Still copy: copy DSH_HOME contents into the staging dir. If DSH_HOME is
    // missing, the staging dir stays empty (an「empty snapshot」still records
    // that the source version had no data).
    if (existsSync(dshHome)) {
      await copyFn(dshHome, staging)
    }
    await rename(staging, finalPath)
    return finalPath
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/**
 * Restore a snapshot over DSH_HOME — two-phase (marker → backup → restore →
 * clear marker) with idempotent completion. Return:
 * - 'complete'   data restored (and marker cleared);
 * - 'half'       the current data was preserved to `.old` but the snapshot
 *                copy failed — data NOT restored, field kept for loud copy;
 * - 'incomplete' restore-in-progress marker present but the snapshot is gone
 *                — `.old` is preserved, nothing else touched.
 */
export async function restoreSnapshot(baseDir: string, dshHome: string, snapshotPath: string, copyFn: CopyFn = defaultCopy): Promise<'complete' | 'half' | 'incomplete'> {
  const { restoreMarker } = snapshotPaths(baseDir)
  const oldPath = `${dshHome}.old`
  const markerPresent = existsSync(restoreMarker)

  // P2-2: the marker's recorded snapshotPath is authoritative across sessions;
  // only fall back to the caller's arg when the marker is unreadable/absent.
  let effectiveSnapshot = snapshotPath
  if (markerPresent) {
    try {
      const marker = JSON.parse(await readFile(restoreMarker, 'utf8')) as { snapshotPath?: unknown }
      if (typeof marker.snapshotPath === 'string' && marker.snapshotPath !== '') {
        effectiveSnapshot = marker.snapshotPath
      }
    } catch { /* unreadable marker → keep the caller's arg */ }

    // P2-1: distinguish「already restored」(dshHome non-empty AND `.old`
    // exists — the backup step ran, then the copy landed) from「marker just
    // written, not started」(dshHome non-empty, `.old` absent — still the bad
    // data). Only the former clears the marker; the latter falls through to
    // the full restore.
    if ((await dirNonEmpty(dshHome)) && existsSync(oldPath)) {
      await rm(restoreMarker, { force: true })
      return 'complete'
    }
    if (!existsSync(effectiveSnapshot)) {
      // Snapshot gone: keep the field (`.old`, or the untouched current data),
      // loud incomplete — never touch data without a snapshot to restore.
      return 'incomplete'
    }
    // Fall through to the full restore below (not-started or backed-up states).
  } else {
    await mkdir(dirname(restoreMarker), { recursive: true })
    await writeFile(restoreMarker, JSON.stringify({ snapshotPath: effectiveSnapshot, startedAt: Date.now() }, null, 2), 'utf8')
  }

  // Backup current data (if any) → dshHome.old, then copy snapshot → dshHome.
  try {
    if (existsSync(dshHome)) {
      await rm(oldPath, { recursive: true, force: true })
      await rename(dshHome, oldPath)
    }
    await copyFn(effectiveSnapshot, dshHome)
    await rm(restoreMarker, { force: true })
    return 'complete'
  } catch {
    // Snapshot copy failed: current data is preserved in .old; data NOT
    // restored. Leave the marker for a later idempotent retry.
    return 'half'
  }
}

/**
 * Stash the current DSH_HOME before a manual rollback (§3.7 pre-rollback):
 * moves DSH_HOME to `pre-rollback/<timestamp>/` so the user can change their
 * mind. At most ONE stash is kept — an older stash is removed first.
 */
export async function stashPreRollback(baseDir: string, dshHome: string): Promise<string> {
  const { preRollbackDir } = snapshotPaths(baseDir)
  await mkdir(preRollbackDir, { recursive: true })
  // Unique dest (random suffix guards same-millisecond collisions so the
  // stash-first ordering below never renames onto an existing stash).
  const dest = join(preRollbackDir, `${Date.now()}-${randomBytes(3).toString('hex')}`)
  // Stash FIRST, then clear older stashes (P2-3): if the rename below fails,
  // the previous stash is still intact — never delete-then-create.
  if (existsSync(dshHome)) {
    await rename(dshHome, dest)
  } else {
    await mkdir(dest, { recursive: true })
  }
  // Upper bound = 1: clear any older stash, keeping the one just created.
  for (const entry of await readdir(preRollbackDir)) {
    const full = join(preRollbackDir, entry)
    if (full !== dest) {
      await rm(full, { recursive: true, force: true })
    }
  }
  return dest
}

/** Re-export for tests: whether a directory exists and is non-empty. */
export { dirNonEmpty }

/**
 * Startup completion entry (design 16 §3.3 crash-safety / §3.6「启动补完失败」
 * 分支): when a restore-in-progress marker is present (a previous switch crashed
 * mid-restore), complete it idempotently before any new spawn. Returns 'none'
 * when no marker exists. The marker's recorded snapshotPath is authoritative
 * (P2-2), so the caller need not know it.
 */
export async function completeInterruptedRestore(
  baseDir: string,
  dshHome: string,
  copyFn: CopyFn = defaultCopy,
): Promise<'none' | 'complete' | 'half' | 'incomplete'> {
  if (!existsSync(snapshotPaths(baseDir).restoreMarker)) return 'none';
  return restoreSnapshot(baseDir, dshHome, '', copyFn);
}
