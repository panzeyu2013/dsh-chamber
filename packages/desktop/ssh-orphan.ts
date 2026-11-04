/**
 * ssh-orphan.ts — crash ledger for spawned ssh tunnel children.
 *
 * A tunnel child (`ssh -N -L …`) is NOT reaped by the kernel when the app dies:
 * it keeps forwarding into its listener until it exits on its own (server-side
 * timeout) or is killed. On POSIX the UDS listener path then still exists and is
 * owned by that orphan, so the next startup reclaims the child BEFORE any new
 * tunnel reuses the path. The stale socket FILE is not swept by directory: the
 * next spawn replaces its own path via StreamLocalBindUnlink=yes, while a
 * uid-wide rm could cut off another live chamber root.
 *
 * Ledger shape: one JSON file per spawned child at
 * `<stateDir>/ssh-children/<pid>.json` = { pid, startedAt, target }.
 * - written right after a successful spawn, removed on every observed child
 *   exit/error (including a replaced/stale child this runtime signalled);
 * - a clean quit therefore leaves nothing, and a crash leaves exactly the set
 *   of children that may still be alive.
 *
 * Sweep identity: "pid alive" alone is NOT ownership — the pid can be reused.
 * The record's wall-clock `startedAt` is compared with the process' actual
 * start time (Linux: /proc/<pid>/stat starttime + /proc/stat btime; macOS:
 * `ps -o lstart=`). A mismatch or an unreadable start time is NOT our process:
 * the pid is skipped (never killed) and only the stale record is removed.
 * Windows has no ssh UDS tunnel shape here, so record/sweep are no-ops.
 *
 * Pure Node (fs + child_process); no electron, no dependency.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { uptime as osUptime } from 'node:os'
import { join } from 'node:path'

/** Subdirectory of the control-plane state root holding one record per ssh child. */
export const SSH_CHILDREN_DIR_NAME = 'ssh-children'
/**
 * Wall-clock tolerance for the recorded start time vs the process' actual start
 * time. Linux derives it from btime (seconds precision) + starttime ticks; macOS
 * lstart has seconds precision too. PID reuse inside this window is extremely
 * unlikely and a false negative only leaves a stale record behind (no kill).
 */
export const SSH_ORPHAN_START_TOLERANCE_MS = 10_000
/** Linux USER_HZ for /proc/<pid>/stat field 22 (fixed at 100 on every mainstream arch). */
const LINUX_CLOCK_TICKS_PER_SECOND = 100

/** One crash-ledger entry; `target` is non-secret diagnostics (user@host:port). */
export interface SshChildRecord {
  pid: number
  /** Epoch ms captured at spawn (compared with the process' real start time). */
  startedAt: number
  /** Non-secret ssh target for diagnostics only. */
  target: string
}

/** Per-sweep outcome; `kept` = alive but its start time could not be read (left for the next sweep). */
export interface SshOrphanSweepResult {
  killed: number
  removed: number
  kept: number
}

export interface SshOrphanSweepOptions {
  stateDir: string
  /** Platform override (tests); defaults to process.platform. */
  platform?: NodeJS.Platform
  /** Epoch-ms of a live pid's start (tests inject); defaults to the OS reader. */
  readStartedAt?: (pid: number) => number | null
  /** Liveness seam (tests inject); defaults to kill(pid, 0). */
  isAlive?: (pid: number) => boolean
  /** Signal seam (tests inject); defaults to process.kill. */
  signal?: (pid: number, signal: NodeJS.Signals) => void
  /** Non-fatal diagnostics sink. */
  log?: (message: string) => void
  toleranceMs?: number
  /**
   * How long a reclaimed pid gets to exit after SIGTERM before SIGKILL (default
   * 1000ms). The wait is load-bearing, not cosmetic: ssh removes a UDS listener
   * path on exit, so an orphan that is still alive while the NEXT child binds the
   * same path could unlink the fresh listener. 0 disables the wait (tests).
   */
  exitWaitMs?: number
  /** Sync sleep seam (tests); default Atomics.wait. */
  sleepMs?: (ms: number) => void
}

/** True on platforms that have the POSIX ssh UDS tunnel shape. */
export function sshOrphanSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

/** The crash-ledger directory under the state root. */
export function sshChildrenDir(stateDir: string): string {
  return join(stateDir, SSH_CHILDREN_DIR_NAME)
}

function usablePid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0
}

/** Record one spawned child. Returns the record path, or null when unsupported/not-a-real-pid. */
export function recordSshChild(
  stateDir: string,
  pid: number,
  info: { target: string; startedAt?: number },
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!sshOrphanSupported(platform) || !usablePid(pid)) return null
  const dir = sshChildrenDir(stateDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const record: SshChildRecord = {
    pid,
    startedAt: info.startedAt ?? Date.now(),
    // Bounded, non-secret diagnostics: the ssh target may carry a username but never
    // a credential/token, and the file is owner-only.
    target: typeof info.target === 'string' ? info.target.slice(0, 512) : '',
  }
  const path = join(dir, `${String(pid)}.json`)
  writeFileSync(path, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
  return path
}

/** Remove the record for one child (clean exit/error); absent record is not an error. */
export function clearSshChild(stateDir: string, pid: number, platform: NodeJS.Platform = process.platform): void {
  if (!sshOrphanSupported(platform) || !usablePid(pid)) return
  try {
    unlinkSync(join(sshChildrenDir(stateDir), `${String(pid)}.json`))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/**
 * Read a live process' start time (epoch ms). Linux: `btime` + `starttime/CLK_TCK`;
 * macOS: `ps -o lstart=`; anything else (or unreadable/hidepid) = null, and the
 * sweep keeps the record instead of guessing.
 */
export function readProcessStartedAt(pid: number, platform: NodeJS.Platform = process.platform): number | null {
  if (!usablePid(pid)) return null
  if (platform === 'linux') return linuxProcessStartedAt(pid)
  if (platform === 'darwin') return darwinProcessStartedAt(pid)
  return null
}

function linuxProcessStartedAt(pid: number): number | null {
  let text: string
  try {
    text = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
  } catch {
    return null
  }
  // comm (field 2) may contain spaces/')': the LAST ')' is the field boundary;
  // the first field after it is state (3), starttime is field 22 → rest index 19.
  const close = text.lastIndexOf(')')
  if (close < 0) return null
  const rest = text.slice(close + 1).trim().split(/\s+/u)
  if (rest.length < 20) return null
  const startTicks = Number(rest[19])
  if (!Number.isSafeInteger(startTicks) || startTicks < 0) return null
  const bootMs = linuxBootEpochMs()
  if (bootMs === null) return null
  return bootMs + (startTicks * 1000) / LINUX_CLOCK_TICKS_PER_SECOND
}

function linuxBootEpochMs(): number | null {
  try {
    for (const line of readFileSync('/proc/stat', 'utf8').split('\n')) {
      if (!line.startsWith('btime ')) continue
      const seconds = Number(line.slice('btime '.length).trim())
      return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : null
    }
  } catch { /* fall through to the uptime estimate */ }
  // Same estimate the state-root lease uses when btime is unreadable. The sweep
  // tolerance absorbs the jiffy/precision error.
  const uptimeSeconds = osUptime()
  return Number.isFinite(uptimeSeconds) && uptimeSeconds >= 0 ? Date.now() - uptimeSeconds * 1000 : null
}

function darwinProcessStartedAt(pid: number): number | null {
  try {
    const text = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (text === '') return null
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = a same-numbered process exists but is not ours to signal. It cannot
    // be our ssh child (same uid), so "alive" here is conservative but safe: the
    // start-time check still rejects it.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Poll a signalled pid until `deadlineMs` elapses or it is gone (sync, short steps). */
function waitForProcessExit(pid: number, deadlineMs: number, isAlive: (pid: number) => boolean, sleepMs: (ms: number) => void): void {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline && isAlive(pid)) sleepMs(25)
}

function readRecord(path: string): SshChildRecord | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (!usablePid(record.pid)) return null
  if (typeof record.startedAt !== 'number' || !Number.isFinite(record.startedAt) || record.startedAt <= 0) return null
  if (typeof record.target !== 'string') return null
  return { pid: record.pid, startedAt: record.startedAt, target: record.target }
}

/**
 * Reclaim ssh children left behind by a crashed predecessor. Runs BEFORE the UDS
 * socket directory is removed, so a reclaimed child cannot keep forwarding into a
 * path that is about to disappear. A record is removed in every terminal case:
 * dead pid, malformed record, or a live pid whose start time proves it is a
 * DIFFERENT process (pid reuse → never signalled). Only a live pid whose start
 * time cannot be read is kept (measured, never guessed).
 */
export function sweepSshOrphans(options: SshOrphanSweepOptions): SshOrphanSweepResult {
  const result: SshOrphanSweepResult = { killed: 0, removed: 0, kept: 0 }
  if (!sshOrphanSupported(options.platform ?? process.platform)) return result
  const dir = sshChildrenDir(options.stateDir)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return result
  }
  const isAlive = options.isAlive ?? processIsAlive
  const signal = options.signal ?? ((pid: number, sig: NodeJS.Signals) => { process.kill(pid, sig) })
  const readStartedAt = options.readStartedAt ?? ((pid: number) => readProcessStartedAt(pid, options.platform))
  const toleranceMs = options.toleranceMs ?? SSH_ORPHAN_START_TOLERANCE_MS
  const exitWaitMs = options.exitWaitMs ?? 1_000
  const sleepMs = options.sleepMs ?? syncSleep
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const path = join(dir, entry)
    const record = readRecord(path)
    if (record === null) {
      // A torn/corrupt record names no process we can prove: drop it.
      try { unlinkSync(path); result.removed += 1 } catch { /* raced */ }
      continue
    }
    if (!isAlive(record.pid)) {
      try { unlinkSync(path); result.removed += 1 } catch { /* raced */ }
      continue
    }
    const actualStartedAt = readStartedAt(record.pid)
    if (actualStartedAt === null) {
      result.kept += 1
      continue
    }
    if (Math.abs(actualStartedAt - record.startedAt) > toleranceMs) {
      // The pid now belongs to another process: never signal it, just retire the record.
      try { unlinkSync(path); result.removed += 1 } catch { /* raced */ }
      continue
    }
    try {
      signal(record.pid, 'SIGTERM')
      result.killed += 1
      // Wait out the child's own exit before the caller removes the socket
      // directory: ssh unlinks its -L path on exit, so a still-alive orphan could
      // delete the NEXT child's freshly bound socket. SIGKILL is the bound.
      if (exitWaitMs > 0) {
        waitForProcessExit(record.pid, exitWaitMs, isAlive, sleepMs)
        if (isAlive(record.pid)) {
          try { signal(record.pid, 'SIGKILL') } catch { /* raced with exit */ }
          waitForProcessExit(record.pid, Math.min(exitWaitMs, 500), isAlive, sleepMs)
        }
      }
    } catch (error) {
      // ESRCH (exited between the liveness probe and the signal) is the expected race;
      // any other failure leaves the record for the NEXT sweep instead of looping here.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        options.log?.(`ssh orphan ${String(record.pid)} could not be signalled: ${String(error)}`)
        continue
      }
    }
    try { unlinkSync(path); result.removed += 1 } catch { /* raced */ }
  }
  if (result.killed > 0) options.log?.(`reclaimed ${String(result.killed)} orphaned ssh tunnel child(ren)`)
  return result
}
