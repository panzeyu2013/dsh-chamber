/**
 * Orphan reaper for managed dsh hosts.
 *
 * Design: docs/design/02-host-management-deployment.md §3.4.2 (reaper 判定序列)
 * with §3.4.1 (记录文件格式). Direct port of the reference implementation's
 * managed-process-registry safety model: a spawn record is only reclaimed when
 * all of "we recorded it", "identity re-verified (command line + port
 * listener)", and "orphaned (reparented to init or owner dead)" hold; any
 * doubt keeps the record and the process untouched. Since the design-18
 * writer-quiescence revision, corrupt records and records whose pid is not an
 * integer are KEPT (fail-closed): a managed-host record is the only durable
 * evidence for a detached process group after the owning control plane dies,
 * so malformed bytes must not be erased — startup's writer-quiescence latch
 * stays closed until the record is resolved. Claim records (claim-*.json)
 * are v2-era external-takeover records — the external-claim module was
 * deleted with the thin-shell architecture (01 §4/§5), so nothing writes
 * claims in v4; they are never killed, only removed once their recorded
 * owner is dead. Run once at control-plane startup, before spawning hosts.
 *
 * Test seams: every external dependency (ps/lsof/ss/proc, process signalling,
 * liveness polling, wait timers) is injectable through `deps`.
 */

import { readdir, readFile, readlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { isAbsolute, join, normalize, sep } from 'node:path'
import {
  readPrivateFileNoFollow,
  removePrivateFileNoFollow,
  type PrivateFileIdentity,
} from './private-file.ts'
import type { Logger } from './types.ts'

const TERM_WAIT_MS = 1500
const TERM_POLL_MS = 100
const REAPER_COMMAND_OUTPUT_MAX_BYTES = 256 * 1024

const INSTALLED_ENTRY_SUFFIX = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const SOURCE_ENTRY_SUFFIX = join('apps', 'cli', 'src', 'bin.ts')

/** Escape a literal for a fail-closed command-line token regexp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether ps's rendered command contains one exact argv-like token. Quotes
 * and whitespace are accepted as token boundaries; suffix matches such as
 * `/unrelated/bin.ts.backup` are not. If ps renders an unusual/ambiguous
 * form, this deliberately returns false and the reaper keeps the process.
 */
function commandHasToken(command: string, token: string): boolean {
  if (token === '') return false
  return new RegExp(`(?:^|[\\s"'])${escapeRegExp(token)}(?=$|[\\s"'])`, 'u').test(command)
}

/** Require an exact adjacent `--flag value` pair in ps's command rendering. */
function commandHasFlagValue(command: string, flag: string, value: string): boolean {
  return new RegExp(
    `(?:^|[\\s"'])${escapeRegExp(flag)}[\\s"']+${escapeRegExp(value)}(?=$|[\\s"'])`,
    'u',
  ).test(command)
}

/** Only the two entry shapes spawn-dsh.ts can record are eligible to kill. */
function recognizedDshEntry(binary: unknown): binary is string {
  if (typeof binary !== 'string' || !isAbsolute(binary)) return false
  const entry = normalize(binary)
  return entry.endsWith(`${sep}${INSTALLED_ENTRY_SUFFIX}`)
    || entry.endsWith(`${sep}${SOURCE_ENTRY_SUFFIX}`)
}

/**
 * Injectable reaper dependencies (test seams; all optional, defaults are the
 * real implementations). Defaults preserve production behavior exactly.
 */
export interface ReaperDeps {
  /** ps -p <pid> -o ppid=,command= → {ppid, command}; throws on failure. */
  psIdentity?: (pid: number) => { ppid: string; command: string }
  /** lsof -iTCP:<port> -sTCP:LISTEN -t → whether pid owns the port; null = probe unavailable. */
  lsofPort?: (pid: number, port: number) => boolean | null
  /** ss -ltnp → whether pid owns the port; null = probe unavailable. */
  ssPort?: (pid: number, port: number) => boolean | null
  /** /proc/net/tcp + /proc/<pid>/fd scan → whether pid owns the port; null = probe unavailable. */
  procPort?: (pid: number, port: number) => Promise<boolean | null>
  /** Signal a process (group preferred, single-pid fallback). False = nothing signalled (gone). */
  signal?: (pid: number, sig: NodeJS.Signals) => boolean
  /** Whether a pid is alive (kill(pid, 0) semantics; EPERM counts as alive). */
  alive?: (pid: number) => boolean
  /** Whether the managed process group or its leader remains alive. */
  managedTreeAlive?: (pid: number) => boolean
  /** Sleep for the alive-poll interval. */
  sleep?: (ms: number) => Promise<void>
  /** SIGTERM grace window before SIGKILL (default 1500ms). */
  termWaitMs?: number
  /** Alive-poll interval during the grace window (default 100ms). */
  termPollMs?: number
}

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function realAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Detached managed hosts own PGID=pid on Unix. Only ESRCH proves that no
 * residual descendant remains after the leader exits. */
function groupAlive(pid: number): boolean {
  if (process.platform === 'win32') return realAlive(pid)
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

function realManagedTreeAlive(pid: number): boolean {
  return groupAlive(pid) || realAlive(pid)
}

/**
 * Signal the whole process group of a managed dsh host (design 02 §3.4.2:
 * "进程组 SIGTERM → 轮询 1.5s → SIGKILL" — spawn-dsh's terminateChild does
 * the same group kill). A group can be absent even while the pid is alive
 * (pid not a group leader, or the leader already reparented) — fall back to
 * the single pid then. Returns false when nothing was signalled (gone).
 */
function realSignal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, sig)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    try {
      process.kill(pid, sig)
      return true
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code === 'ESRCH') return false
      throw fallbackError
    }
  }
}

function realPsIdentity(pid: number): { ppid: string; command: string } {
  const res = spawnSync('ps', ['-p', String(pid), '-o', 'ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: REAPER_COMMAND_OUTPUT_MAX_BYTES,
  })
  if (res.error) throw res.error
  if (res.status !== 0) throw new Error(`ps exited ${res.status} for pid ${pid}`)
  const line = res.stdout.split('\n').find(l => l.trim() !== '')
  if (!line) throw new Error(`ps produced no output for pid ${pid}`)
  const tokens = line.trim().split(/\s+/)
  return { ppid: tokens[0], command: tokens.slice(1).join(' ') }
}

function realLsofPort(pid: number, port: number): boolean | null {
  const res = spawnSync('lsof', ['-iTCP:' + String(port), '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
    maxBuffer: REAPER_COMMAND_OUTPUT_MAX_BYTES,
  })
  if (res.error) return null
  return res.stdout.split(/\s+/).filter(Boolean).includes(String(pid))
}

function realSsPort(pid: number, port: number): boolean | null {
  const res = spawnSync('ss', ['-ltnp'], {
    encoding: 'utf8',
    maxBuffer: REAPER_COMMAND_OUTPUT_MAX_BYTES,
  })
  if (res.error || res.status !== 0) return null
  let sawPort = false
  let sawPids = false
  for (const line of res.stdout.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 5 || !fields[3].endsWith(':' + String(port))) continue
    sawPort = true
    const pids = [...line.matchAll(/pid=(\d+)/g)].map(m => m[1])
    if (pids.length === 0) continue
    sawPids = true
    if (pids.includes(String(pid))) return true
  }
  if (!sawPort || sawPids) return false
  return null
}

async function realProcPort(pid: number, port: number): Promise<boolean | null> {
  let netTcp
  try {
    netTcp = await readFile('/proc/net/tcp', 'utf8')
  } catch {
    return null
  }
  const hexPort = Number(port).toString(16).toUpperCase().padStart(4, '0')
  const inodes = new Set()
  for (const line of netTcp.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10 || fields[1] !== `0100007F:${hexPort}` || fields[3] !== '0A') continue
    inodes.add(fields[9])
  }
  if (inodes.size === 0) return false
  let fds
  try {
    fds = await readdir(`/proc/${pid}/fd`)
  } catch {
    return null
  }
  for (const fd of fds) {
    let link
    try {
      link = await readlink(`/proc/${pid}/fd/${fd}`)
    } catch {
      continue
    }
    const match = /^socket:\[(\d+)\]$/.exec(link)
    if (match && inodes.has(match[1])) return true
  }
  return false
}

/** Merge partial deps over the real defaults (production behavior unchanged). */
function resolveDeps(deps?: ReaperDeps): Required<ReaperDeps> {
  const resolvedAlive = deps?.alive ?? realAlive
  return {
    psIdentity: deps?.psIdentity ?? realPsIdentity,
    lsofPort: deps?.lsofPort ?? realLsofPort,
    ssPort: deps?.ssPort ?? realSsPort,
    procPort: deps?.procPort ?? realProcPort,
    signal: deps?.signal ?? realSignal,
    alive: resolvedAlive,
    // Existing focused tests inject a synthetic pid-liveness function. Use it
    // for tree liveness too unless they explicitly model a residual group;
    // production takes the exact process-group-aware implementation.
    managedTreeAlive: deps?.managedTreeAlive
      ?? (deps?.alive === undefined ? realManagedTreeAlive : resolvedAlive),
    sleep: deps?.sleep ?? realSleep,
    termWaitMs: deps?.termWaitMs ?? TERM_WAIT_MS,
    termPollMs: deps?.termPollMs ?? TERM_POLL_MS,
  }
}

async function portOwnedBy(pid: number, port: number, deps: Required<ReaperDeps>): Promise<boolean> {
  let verdict: boolean | null = deps.lsofPort(pid, port)
  if (verdict === null) verdict = deps.ssPort(pid, port)
  if (verdict === null) verdict = await deps.procPort(pid, port)
  // fail-closed: when every probe is unavailable we cannot prove the pid owns
  // the port, so never treat it as owned (an unverifiable process is kept).
  return verdict === true
}

async function killAndConfirm(pid: number, deps: Required<ReaperDeps>): Promise<void> {
  if (!deps.signal(pid, 'SIGTERM')) return
  let deadline = Date.now() + deps.termWaitMs
  while (Date.now() < deadline) {
    await deps.sleep(deps.termPollMs)
    if (!deps.managedTreeAlive(pid)) return
  }
  if (!deps.signal(pid, 'SIGKILL')) return
  deadline = Date.now() + deps.termWaitMs
  while (Date.now() < deadline) {
    await deps.sleep(deps.termPollMs)
    if (!deps.managedTreeAlive(pid)) return
  }
  throw new Error(`process group ${pid} still alive after SIGTERM + SIGKILL`)
}

function assertRecordStillOwned(file: string, expected: PrivateFileIdentity, expectedValue: string): void {
  // dev/ino normally identifies the ledger leaf, but a filesystem may reuse
  // an inode after an unlink followed by an immediate replacement. Re-read
  // the exact bytes as well as the identity so a successor record cannot be
  // mistaken for the record we inspected earlier.
  const current = readPrivateFileNoFollow(file, { maxBytes: 64 * 1024 })
  if (current.value !== expectedValue
    || current.identity.dev !== expected.dev
    || current.identity.ino !== expected.ino) {
    throw new Error(`private state leaf is unsafe or no longer owned: ${file}`)
  }
}

async function removeFile(file: string, expected: PrivateFileIdentity, expectedValue: string): Promise<void> {
  try {
    assertRecordStillOwned(file, expected, expectedValue)
    // removePrivateFileNoFollow repeats the identity check at the namespace
    // operation itself, closing the final check/remove gap it can cover.
    removePrivateFileNoFollow(file, expected)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** One entry's verdict: reclaimed (killed), kept (left in place), removed. */
type EntryStatus = 'reclaimed' | 'kept' | 'removed'

type LogFn = (message: string) => void

/**
 * Match only one recorded absolute entry token from a supported dsh layout.
 * Basenames, substrings and relative paths are deliberately insufficient:
 * stale-ledger PID reuse must never signal an unrelated `bin.ts` process.
 */
export function commandMatchesEntry(command: string, entry: string | null, binary: string | null): boolean {
  const recordedEntry = recognizedDshEntry(entry)
    ? normalize(entry)
    : recognizedDshEntry(binary) ? normalize(binary) : null
  return recordedEntry !== null && commandHasToken(command, recordedEntry)
}

async function processEntry(dir: string, name: string, log: LogFn, deps: Required<ReaperDeps>): Promise<{ status: EntryStatus }> {
  const file = join(dir, name)
  const label = name.slice(0, -5)
  let record: any
  let recordIdentity: PrivateFileIdentity | null = null
  let recordValue: string | null = null
  try {
    const read = readPrivateFileNoFollow(file, { maxBytes: 64 * 1024 })
    recordIdentity = read.identity
    recordValue = read.value
    record = JSON.parse(read.value)
  } catch (error) {
    if (name.startsWith('claim-')) {
      // Corrupt claims are never deleted: a claim with a live owner must
      // never be torn down by the reaper (that would let another instance
      // take over a still-owned host). v4 writes no claims — these files
      // can only survive from a v2-era installation — but the defensive
      // handling stays.
      log(`reaper: ${label} corrupt claim kept (${String(error)})`)
      return { status: 'kept' }
    }
    // A managed-host record is the only durable evidence for a detached
    // process group after the owning control plane dies.  Malformed bytes do
    // not prove that writer absent, so preserve the record and make startup's
    // writer-quiescence latch fail closed.
    log(`reaper: ${label} corrupt record kept (${String(error)})`)
    return { status: 'kept' }
  }
  if (name.startsWith('claim-')) {
    const ownerPid = Number.isInteger(record.ownerPid) ? record.ownerPid : null
    if (ownerPid !== null && deps.alive(ownerPid)) {
      log(`reaper: ${label} claim owner ${ownerPid} alive; kept`)
      return { status: 'kept' }
    }
    await removeFile(file, recordIdentity!, recordValue!)
    log(`reaper: ${label} claim owner ${String(ownerPid)} dead; claim removed`)
    return { status: 'removed' }
  }
  const pid = record.pid
  if (!Number.isInteger(pid) || pid <= 0) {
    // The filename/payload may have been torn while publishing the ledger.
    // Without a trustworthy PGID there is no safe absence proof; deleting the
    // file would erase the only recovery evidence and reopen DSH_HOME writes.
    log(`reaper: ${label} invalid pid; record kept`)
    return { status: 'kept' }
  }
  if (!deps.alive(pid)) {
    // A crashed leader can leave PTY/plugin descendants in its detached
    // group. We can no longer re-verify the leader identity safely, so keep
    // the ledger and fail writer-quiescence closed instead of deleting the
    // only evidence and racing a runtime snapshot.
    if (deps.managedTreeAlive(pid)) {
      log(`reaper: ${pid} leader dead but residual process group alive; record kept`)
      return { status: 'kept' }
    }
    await removeFile(file, recordIdentity!, recordValue!)
    log(`reaper: ${pid} dead; record removed`)
    return { status: 'removed' }
  }
  // A new record can be published for a reused pid while this scan is in
  // flight. Do not even inspect or signal the live process on stale evidence.
  assertRecordStillOwned(file, recordIdentity!, recordValue!)
  const portNum = Number(record.port)
  const identity = deps.psIdentity(pid)
  const profile = typeof record.profile === 'string' && record.profile !== '' ? record.profile : null
  const entry = typeof record.entry === 'string' && record.entry !== '' ? record.entry : null
  const binary = typeof record.binary === 'string' && record.binary !== '' ? record.binary : null
  // Exact identity, not a basename heuristic: the record carries the
  // absolute entry path that spawn-dsh actually passed to Node. Requiring
  // that token plus the exact profile and port flags makes stale-record PID
  // reuse fail closed even when the unrelated process also runs `bin.ts`.
  const commandOk = profile === 'web'
    && Number.isInteger(portNum)
    && portNum > 0
    && commandMatchesEntry(identity.command, entry, binary)
    && commandHasFlagValue(identity.command, '--profile', profile)
    && commandHasFlagValue(identity.command, '--port', String(portNum))
  // Missing/invalid port ⇒ cannot verify the listener belongs to this pid;
  // fail-closed (kept) instead of the previous fail-open default.
  const portOk = Number.isInteger(portNum) && portNum > 0 ? await portOwnedBy(pid, portNum, deps) : false
  if (!commandOk || !portOk) {
    // A stale record may now point at an unrelated process whose argv carries
    // credentials. The command is inspection-only evidence and must never be
    // copied into chamber logs.
    log(`reaper: ${pid} identity mismatch; record kept`)
    return { status: 'kept' }
  }
  const ownerPid = Number.isInteger(record.ownerPid) ? record.ownerPid : null
  const orphan = identity.ppid === '1' || (ownerPid !== null && !deps.alive(ownerPid))
  if (!orphan) {
    log(`reaper: ${pid} owner ${String(ownerPid)} alive (ppid ${identity.ppid}); record kept`)
    return { status: 'kept' }
  }
  log(`reaper: ${pid} orphan; SIGTERM`)
  assertRecordStillOwned(file, recordIdentity!, recordValue!)
  await killAndConfirm(pid, deps)
  await removeFile(file, recordIdentity!, recordValue!)
  log(`reaper: ${pid} exited; record removed`)
  return { status: 'reclaimed' }
}

/**
 * Scan <stateDir>/managed-dsh and reclaim orphaned managed dsh hosts per
 * design 02 §3.4.2. Safe under concurrent control-plane instances: entries
 * whose owner is still alive are never touched.
 * @param options - {stateDir, logger, deps?} (deps are test seams; default =
 *   the real ps/lsof/ss/proc/signal implementations).
 * @returns {reclaimed, kept, errors} — reclaimed: killed spawn records;
 * kept: records left in place (alive owner, identity mismatch, …); errors:
 * per-entry failures (files left in place).
 */
export interface ReaperResult {
  reclaimed: number
  kept: number
  errors: string[]
}

export async function runReaper({
  stateDir,
  logger,
  deps,
}: {
  stateDir: string
  logger?: Logger
  deps?: ReaperDeps
}): Promise<ReaperResult> {
  const resolved = resolveDeps(deps)
  const log: LogFn = typeof logger?.log === 'function'
    ? (message) => logger.log(message)
    : () => {}
  const dir = join(stateDir, 'managed-dsh')
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { reclaimed: 0, kept: 0, errors: [] }
    return { reclaimed: 0, kept: 0, errors: [`cannot scan ${dir}: ${String(error)}`] }
  }
  let reclaimed = 0
  let kept = 0
  const errors: string[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const outcome = await processEntry(dir, name, log, resolved)
      if (outcome.status === 'reclaimed') reclaimed++
      else if (outcome.status === 'kept') kept++
    } catch (error) {
      errors.push(`reaper: ${name}: ${String(error)}`)
      kept++
    }
  }
  return { reclaimed, kept, errors }
}
