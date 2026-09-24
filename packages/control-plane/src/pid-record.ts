/**
 * Managed-dsh pid ledger (design 02 §3.3): the on-disk record shape of
 * <stateDir>/managed-dsh/<pid>.json plus its atomic owner-private write,
 * bounded no-follow read and best-effort removal.
 *
 * This module is the single owner of the ledger format. The spawner
 * (spawn-dsh.ts) writes and removes a record; the log reader (host-logs.ts)
 * reads records to resolve a managed host's port. Keeping the format here is
 * what lets those two stay independent — host-logs must never import the
 * spawner just to read a pid file.
 */
import { join } from 'node:path'
import {
  atomicWritePrivateFileNoFollow,
  ensurePrivateDirectoryNoFollow,
  readPrivateFileNoFollow,
  removePrivateFileNoFollow,
} from './private-file.ts'

/**
 * The managed-dsh pid record shape (design 02 §3.3), written atomically
 * under <stateDir>/managed-dsh/<pid>.json by writePidRecord. Extra fields
 * (e.g. ownerInstanceId) are appended; the fixed columns are always present.
 */
export interface PidRecord {
  pid: number
  ownerPid: number
  port: number
  binary: string
  /** The spawned entry token (argv0 / source script path); reaper identity
   * re-verification matches the live command against it. */
  entry?: string
  profile: string
  source: string
  startedAt: string
  ownerInstanceId?: string
}

/**
 * Write the managed-dsh pid record for a spawned child (design 02 §3.3).
 * The write is atomic (tmp + rename). Caller-compatible: extra fields
 * (e.g. ownerInstanceId from the control-plane instance identity, §3.6.1)
 * are appended; the fixed columns are always present.
 * @param stateDir - the control plane state root.
 * @param pid - the child's pid.
 * @param port - the port the child was asked to serve.
 * @param ownerPid - the control plane process pid.
 * @param extra - optional extra record fields (ownerInstanceId, …).
 * @param entryPath - the spawned entry token (argv0 for installed layouts,
 *   the script path for the dev-tree source layout). The reaper re-verifies
 *   the live process against this token; without it the source layout's argv
 *   (no 'dsh' substring anywhere) can never match and a crashed dev tree
 *   leaves the writer-quiescence latch closed forever.
 */
export function writePidRecord(stateDir: string, pid: number, port: number, ownerPid: number, extra: Record<string, unknown> = {}, entryPath?: string | null): void {
  const dir = join(stateDir, 'managed-dsh')
  ensurePrivateDirectoryNoFollow(dir, 0o700)
  const binary = typeof extra.binary === 'string' && extra.binary !== '' ? extra.binary : 'dsh'
  const { binary: _binary, ...additional } = extra
  const record = {
    pid,
    ownerPid,
    ...additional,
    port,
    // Record the exact CLI entry used for this process. The reaper compares
    // this absolute path against the live command line; a basename marker
    // such as `dsh`/`bin.ts` is too broad under stale-record PID reuse.
    binary,
    ...(entryPath !== undefined && entryPath !== null && entryPath !== '' ? { entry: entryPath } : {}),
    profile: 'web',
    source: 'spawn',
    startedAt: new Date().toISOString(),
  }
  atomicWriteJson(join(dir, `${pid}.json`), record)
}

/** Remove the managed-dsh pid record of a child that has exited. */
export function removePidRecord(stateDir: string, pid: number): void {
  try {
    removePrivateFileNoFollow(join(stateDir, 'managed-dsh', `${pid}.json`))
  } catch { /* best effort: unsafe/unremovable evidence remains for the startup reaper */ }
}

/** Atomic owner-private JSON write: random O_EXCL temp + file fsync + rename
 * + pinned parent fsync, with no-follow/identity checks throughout. */
function atomicWriteJson(path: string, value: unknown): void {
  atomicWritePrivateFileNoFollow(path, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 })
}

/** Read a managed-dsh pid record; null when absent or corrupt. */
export function readPidRecord(stateDir: string, pid: number): PidRecord | null {
  if (!Number.isInteger(pid) || pid < 1) return null
  try {
    const read = readPrivateFileNoFollow(join(stateDir, 'managed-dsh', `${pid}.json`), { maxBytes: 64 * 1024 })
    const value: unknown = JSON.parse(read.value)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const row = value as Partial<PidRecord>
    if (row.pid !== pid
      || typeof row.ownerPid !== 'number' || !Number.isInteger(row.ownerPid) || row.ownerPid < 1
      || typeof row.port !== 'number' || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535
      || typeof row.binary !== 'string' || row.binary === '' || row.binary.length > 4096
      || row.profile !== 'web'
      || typeof row.source !== 'string' || row.source === '' || row.source.length > 64
      || typeof row.startedAt !== 'string' || row.startedAt === '' || row.startedAt.length > 128
      || (row.entry !== undefined && (typeof row.entry !== 'string' || row.entry === '' || row.entry.length > 4096))
      || (row.ownerInstanceId !== undefined
        && (typeof row.ownerInstanceId !== 'string' || row.ownerInstanceId === '' || row.ownerInstanceId.length > 256))) {
      return null
    }
    return {
      pid,
      ownerPid: row.ownerPid,
      port: row.port,
      binary: row.binary,
      profile: 'web',
      source: row.source,
      startedAt: row.startedAt,
      ...(row.entry === undefined ? {} : { entry: row.entry }),
      ...(row.ownerInstanceId === undefined ? {} : { ownerInstanceId: row.ownerInstanceId }),
    }
  } catch {
    return null
  }
}
