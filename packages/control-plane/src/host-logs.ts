/**
 * Host log reading + spawn-diagnostics summary (the read side behind GET /api/host/logs).
 *
 * Rolling host logs: one JSONL file per managed host at
 * <stateDir>/host-logs/<port>.log, one entry per line:
 *   {"ts":"<ISO 8601>","stream":"stdout|stderr","line":"<text>"}
 *
 * spawn-dsh.ts attaches a per-host JSONL writer at spawn, so a live host's
 * stdout/stderr lands there and reads resolve; a host that exited before any line was
 * captured may still report a typed not-found. The read side never touches the catalog
 * and derives the managed port from the spawn registry or an explicit port.
 *
 * Large files are read from the tail; when the needed line count does not fit the
 * window and the file exceeds MAX_WHOLE_READ_BYTES the read flags `truncated: true`.
 */

import { constants, type Stats } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { readPidRecord } from './spawn-dsh.ts'
import type { PidRecord } from './spawn-dsh.ts'
import {
  assertPrivateLeafStatNoFollow,
  noFollowOpenFlag,
  privateIdentityOf,
  samePrivateIdentity,
} from './private-file.ts'
import type { Logger } from './types.ts'

/** Default lines returned by readManagedLog. */
export const DEFAULT_LIMIT = 200

/** Hard cap on limit (clamped, never errors). */
export const MAX_LIMIT = 1000

/** Bytes read from the file tail on the first pass. */
const TAIL_READ_BYTES = 256 * 1024

/** Files at or below this size may be read whole when the tail window is too small. */
const MAX_WHOLE_READ_BYTES = 4 * 1024 * 1024

/** The rolling-log directory name under the state root. */
const LOG_DIR = 'host-logs'

/**
 * Rolling-log ring cap: how many lines one managed-host log keeps on disk. The writer
 * compacts back to COMPACT_KEEP_LINES once crossed, so a host can never grow an
 * unbounded log file (reads additionally clamp with the tail-window discipline).
 */
export const MAX_LOG_LINES = 500

/** Compaction retains this many trailing lines (so compaction runs ~every 100 writes). */
export const COMPACT_KEEP_LINES = 400

/** Per-host pending-write ceiling: once reached, the newest diagnostic entry is dropped
 *  instead of growing memory or backpressuring the managed host. */
export const MAX_PENDING_LOG_ENTRIES = 256
export const MAX_PENDING_LOG_BYTES = 512 * 1024

/** The rolling-log file for a given managed-host port. */
export function logPathFor(stateDir: string, port: number): string {
  return join(stateDir, LOG_DIR, `${port}.log`)
}

/** The appending rolling-log writer for one managed host. */
interface HostLogWriter {
  /** False means the entry was dropped at the high-water mark or after close. */
  write(line: string, streamName?: string): boolean
  /** Flush every entry accepted before this call while keeping the handle live. */
  flush(): Promise<void>
  /** Flush every entry accepted before this call. Never rejects. */
  close(): Promise<void>
}

interface PendingLogEntry {
  entry: string
  bytes: number
}

interface FileIdentity {
  dev: number
  ino: number
}

interface SafeLeaf {
  identity: FileIdentity
  stat: Stats
}

interface PinnedDirectory {
  path: string
  identity: FileIdentity
  handle: FileHandle | null
}

function assertSafeLeaf(path: string, value: Stats): SafeLeaf {
  // The unsafe-leaf rule is single-sourced in private-file.ts; host-logs keeps the stat it needs for size/mtime.
  assertPrivateLeafStatNoFollow(path, value)
  return { identity: privateIdentityOf(value), stat: value }
}

async function inspectLeaf(path: string): Promise<SafeLeaf | null> {
  try {
    return assertSafeLeaf(path, await lstat(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function inspectExpectedLeaf(path: string, expected: FileIdentity): Promise<SafeLeaf> {
  const current = await inspectLeaf(path)
  if (current === null || !samePrivateIdentity(current.identity, expected)) {
    throw new Error(`host log leaf identity changed: ${path}`)
  }
  return current
}

/** Pin the caller-owned final log directory where POSIX exposes a no-follow directory
 *  descriptor; on Windows retain the before/after path identity checks. */
async function pinDirectory(path: string): Promise<PinnedDirectory> {
  const before = await lstat(path)
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`host log parent is not a real directory: ${path}`)
  }
  const identity = privateIdentityOf(before)
  if (
    process.platform === 'win32'
    || typeof constants.O_DIRECTORY !== 'number'
    || typeof constants.O_NOFOLLOW !== 'number'
  ) {
    return { path, identity, handle: null }
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isDirectory() || !samePrivateIdentity(identity, privateIdentityOf(opened))) {
      throw new Error(`host log parent changed while opening: ${path}`)
    }
    return { path, identity, handle }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function verifyDirectory(pin: PinnedDirectory): Promise<void> {
  const atPath = await lstat(pin.path)
  if (
    atPath.isSymbolicLink()
    || !atPath.isDirectory()
    || !samePrivateIdentity(pin.identity, privateIdentityOf(atPath))
  ) {
    throw new Error(`host log parent identity changed: ${pin.path}`)
  }
  if (pin.handle !== null) {
    const opened = await pin.handle.stat()
    if (!opened.isDirectory() || !samePrivateIdentity(pin.identity, privateIdentityOf(opened))) {
      throw new Error(`host log parent descriptor changed: ${pin.path}`)
    }
  }
}

async function syncDirectory(pin: PinnedDirectory): Promise<void> {
  await verifyDirectory(pin)
  if (pin.handle !== null) {
    try {
      await pin.handle.sync()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // NFS/CIFS/FUSE mounts commonly reject an O_RDONLY directory fsync (EINVAL/ENOTSUP):
      // a durability fallback, never an identity failure — tolerate those codes, keep the checks.
      if (code !== 'EINVAL' && code !== 'ENOTSUP') throw error
    }
  }
  await verifyDirectory(pin)
}

async function closeDirectory(pin: PinnedDirectory): Promise<void> {
  await pin.handle?.close()
}

async function writeAll(handle: FileHandle, value: string): Promise<void> {
  const bytes = Buffer.from(value)
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset)
    if (bytesWritten === 0) throw new Error('host log write made no progress')
    offset += bytesWritten
  }
}

async function removeOwnedLeaf(path: string, expected: FileIdentity): Promise<void> {
  const current = await inspectLeaf(path)
  if (current !== null && samePrivateIdentity(current.identity, expected)) await unlink(path)
}

/** One shared lane per backing path: spawn-dsh stdout/stderr and the local lifecycle
 *  logger can both create handles for the same port; sharing queue AND ring is what makes
 *  compaction preserve both producers. */
const hostLogLanes = new Map<string, AsyncHostLogLane>()

class AsyncHostLogLane {
  readonly path: string
  readonly directory: string
  handleCount = 0

  #needsSetup = true
  #linesWritten = 0
  #ring: string[] = []
  #activeIdentity: FileIdentity | null = null
  #pending: PendingLogEntry[] = []
  #pendingEntries = 0
  #pendingBytes = 0
  #drainPromise: Promise<void> | null = null
  #warn: ((message: string) => void) | null
  #warnedOnce = false

  constructor(stateDir: string, port: number, warn?: (message: string) => void) {
    this.path = logPathFor(stateDir, port)
    this.directory = join(stateDir, LOG_DIR)
    this.#warn = warn ?? null
  }

  /** Rebind the diagnostic sink when a later handle brings its own logger (one lane is shared per path). */
  setWarn(warn: (message: string) => void): void {
    this.#warn = warn
  }

  /** Report a dropped batch once per failure episode. The sink runs under try/catch: a
   *  throwing logger must never escape into #drain or the caller's setState path. */
  #warnDrop(detail: string): void {
    if (this.#warnedOnce) return
    this.#warnedOnce = true
    try {
      this.#warn?.(`host-logs: host log writes are failing; buffered host log entries were dropped (${detail})`)
    } catch { /* a diagnostic sink must never take the host pipe down */ }
  }

  /**
   * Drop all in-memory knowledge of the current backing-file generation. After any
   * append/compaction failure we cannot prove the file still contains the ring; retaining
   * it could resurrect deleted content when a later compaction replaces a new file.
   */
  #resetGeneration(): void {
    this.#ring = []
    this.#linesWritten = 0
    this.#activeIdentity = null
    this.#needsSetup = true
  }

  /** Load only a bounded tail of an existing generation: earlier lines must count toward
   *  the same on-disk cap, but startup must not read an arbitrarily large legacy log. */
  async #hydrateGeneration(parent: PinnedDirectory): Promise<void> {
    await verifyDirectory(parent)
    const before = await inspectLeaf(this.path)
    if (before === null) return
    const fd = await open(this.path, constants.O_RDONLY | noFollowOpenFlag())
    try {
      const info = await fd.stat()
      const opened = assertSafeLeaf(this.path, info)
      if (!samePrivateIdentity(before.identity, opened.identity)) {
        throw new Error(`host log leaf changed while opening: ${this.path}`)
      }
      await inspectExpectedLeaf(this.path, opened.identity)
      await verifyDirectory(parent)
      this.#activeIdentity = opened.identity
      if (info.size === 0) return
      const bytes = Math.min(info.size, MAX_WHOLE_READ_BYTES)
      const buffer = Buffer.allocUnsafe(bytes)
      const { bytesRead } = await fd.read(buffer, 0, bytes, info.size - bytes)
      let text = buffer.subarray(0, bytesRead).toString('utf8')
      if (info.size > bytes) {
        const firstBreak = text.indexOf('\n')
        text = firstBreak === -1 ? '' : text.slice(firstBreak + 1)
      }
      const lines = text.split('\n')
      if (lines[lines.length - 1] === '') lines.pop()
      const retained = lines.slice(-COMPACT_KEEP_LINES)
      this.#ring.push(...retained.map(line => `${line}\n`))
      // A partial tail proves the old generation exceeded our byte budget; compact it on the next successful append.
      this.#linesWritten = info.size > bytes ? MAX_LOG_LINES : lines.length
      const after = assertSafeLeaf(this.path, await fd.stat())
      const atPath = await inspectExpectedLeaf(this.path, opened.identity)
      await verifyDirectory(parent)
      if (
        !samePrivateIdentity(opened.identity, after.identity)
        || after.stat.size !== info.size
        || after.stat.mtimeMs !== info.mtimeMs
        || after.stat.ctimeMs !== info.ctimeMs
        || atPath.stat.size !== after.stat.size
        || atPath.stat.mtimeMs !== after.stat.mtimeMs
        || atPath.stat.ctimeMs !== after.stat.ctimeMs
      ) {
        throw new Error(`host log leaf changed while hydrating: ${this.path}`)
      }
    } finally {
      await fd.close()
    }
  }

  /** (Re)create the log directory; the next append then lands. */
  async #setup(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const parent = await pinDirectory(this.directory)
    try {
      await this.#hydrateGeneration(parent)
      this.#needsSetup = false
    } finally {
      await closeDirectory(parent)
    }
  }

  /** Append to the exact active generation, or exclusively create the first; no bytes
   *  are dispatched before parent/leaf identity checks. */
  async #append(value: string): Promise<void> {
    const parent = await pinDirectory(this.directory)
    const expected = this.#activeIdentity
    const created = expected === null
    let fd: FileHandle | null = null
    try {
      await verifyDirectory(parent)
      if (expected !== null) await inspectExpectedLeaf(this.path, expected)
      const flags = constants.O_WRONLY | constants.O_APPEND | noFollowOpenFlag()
        | (created ? constants.O_CREAT | constants.O_EXCL : 0)
      fd = await open(this.path, flags, 0o600)
      const opened = assertSafeLeaf(this.path, await fd.stat())
      if (expected !== null && !samePrivateIdentity(expected, opened.identity)) {
        throw new Error(`host log leaf changed while opening for append: ${this.path}`)
      }
      await inspectExpectedLeaf(this.path, opened.identity)
      await verifyDirectory(parent)
      await writeAll(fd, value)
      await fd.sync()
      const after = assertSafeLeaf(this.path, await fd.stat())
      if (!samePrivateIdentity(opened.identity, after.identity)) {
        throw new Error(`host log descriptor identity changed after append: ${this.path}`)
      }
      await inspectExpectedLeaf(this.path, opened.identity)
      await verifyDirectory(parent)
      if (created) await syncDirectory(parent)
      this.#activeIdentity = opened.identity
    } finally {
      try {
        await fd?.close()
      } finally {
        await closeDirectory(parent)
      }
    }
  }

  /** Atomically replace the backing generation with its retained tail. */
  async #compact(retained: string[]): Promise<void> {
    const expected = this.#activeIdentity
    if (expected === null) throw new Error(`host log generation disappeared before compaction: ${this.path}`)
    const parent = await pinDirectory(this.directory)
    const tmp = join(
      this.directory,
      `.${basename(this.path)}.compact-${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
    )
    let fd: FileHandle | null = null
    let tempIdentity: FileIdentity | null = null
    let published = false
    try {
      await verifyDirectory(parent)
      await inspectExpectedLeaf(this.path, expected)
      fd = await open(
        tmp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowOpenFlag(),
        0o600,
      )
      const opened = assertSafeLeaf(tmp, await fd.stat())
      tempIdentity = opened.identity
      await inspectExpectedLeaf(tmp, opened.identity)
      await verifyDirectory(parent)
      // Ring entries already end with '\n' — join with '' (a '\n' join would leave blank lines).
      await writeAll(fd, retained.join(''))
      await fd.sync()
      const after = assertSafeLeaf(tmp, await fd.stat())
      if (!samePrivateIdentity(opened.identity, after.identity)) {
        throw new Error(`host log temp descriptor changed before publish: ${tmp}`)
      }
      await fd.close()
      fd = null
      await inspectExpectedLeaf(tmp, opened.identity)
      await inspectExpectedLeaf(this.path, expected)
      await verifyDirectory(parent)
      await rename(tmp, this.path)
      published = true
      await inspectExpectedLeaf(this.path, opened.identity)
      await syncDirectory(parent)
      this.#activeIdentity = opened.identity
    } finally {
      if (fd !== null) {
        try { await fd.close() } catch { /* best effort */ }
      }
      if (!published && tempIdentity !== null) {
        try {
          await verifyDirectory(parent)
          await removeOwnedLeaf(tmp, tempIdentity)
        } catch { /* preserve unsafe/replaced residue as evidence */ }
      }
      await closeDirectory(parent)
    }
  }

  /** Drain batches serially: append and compaction share this lane, so no buffered append can target a renamed-away inode. */
  async #drain(): Promise<void> {
    // Keep write() enqueue-only even on an idle lane: no filesystem work on the child stream's data callback stack.
    await Promise.resolve()
    while (this.#pending.length > 0) {
      const batch = this.#pending.splice(0)
      const batchBytes = batch.reduce((sum, item) => sum + item.bytes, 0)
      try {
        if (this.#needsSetup) await this.#setup()
        const entries = batch.map(item => item.entry)
        if (this.#linesWritten + entries.length > MAX_LOG_LINES) {
          // Crossing the cap is one atomic replacement, not append followed by a full-file
          // write: the backing file never exposes an oversized batch between two filesystem ops.
          const retained = [...this.#ring, ...entries].slice(-COMPACT_KEEP_LINES)
          await this.#compact(retained)
          this.#ring = retained
          this.#linesWritten = retained.length
        } else {
          await this.#append(entries.join(''))
          // Mutate the compaction source only after persistence succeeds: a swallowed write must never be resurrected.
          this.#ring.push(...entries)
          if (this.#ring.length > COMPACT_KEEP_LINES) {
            this.#ring.splice(0, this.#ring.length - COMPACT_KEEP_LINES)
          }
          this.#linesWritten += entries.length
        }
        this.#pendingEntries -= batch.length
        this.#pendingBytes -= batchBytes
        // This batch reached disk: a following failure is a NEW episode and may warn again.
        this.#warnedOnce = false
      } catch (error) {
        // The failed batch and everything queued behind it are diagnostic-only and are
        // dropped together — the first failure of an episode reports the drop once through
        // the injected sink. A later NEW write gets one fresh setup attempt; a permanently
        // broken disk never creates an infinite retry loop or wedges the host's stdout pipe.
        this.#warnDrop(error instanceof Error ? error.message : String(error))
        this.#pending = []
        this.#pendingEntries = 0
        this.#pendingBytes = 0
        this.#resetGeneration()
        return
      }
    }
  }

  #ensureDrain(): void {
    if (this.#drainPromise !== null) return
    const pending = this.#drain()
    this.#drainPromise = pending
    void pending.then(() => {
      if (this.#drainPromise !== pending) return
      this.#drainPromise = null
      if (this.#pending.length > 0) this.#ensureDrain()
      else maybeReleaseHostLogLane(this)
    })
  }

  enqueue(entry: string): boolean {
    const bytes = Buffer.byteLength(entry)
    if (
      this.#pendingEntries >= MAX_PENDING_LOG_ENTRIES
      || bytes > MAX_PENDING_LOG_BYTES
      || this.#pendingBytes + bytes > MAX_PENDING_LOG_BYTES
    ) return false
    this.#pending.push({ entry, bytes })
    this.#pendingEntries += 1
    this.#pendingBytes += bytes
    this.#ensureDrain()
    return true
  }

  async flush(): Promise<void> {
    while (this.#drainPromise !== null) await this.#drainPromise
  }

  get idle(): boolean {
    return this.#drainPromise === null && this.#pendingEntries === 0
  }
}

function getHostLogLane(
  stateDir: string,
  port: number,
  warn?: (message: string) => void,
): AsyncHostLogLane {
  const path = logPathFor(stateDir, port)
  let lane = hostLogLanes.get(path)
  if (lane === undefined) {
    lane = new AsyncHostLogLane(stateDir, port, warn)
    hostLogLanes.set(path, lane)
  } else if (warn !== undefined) {
    lane.setWarn(warn)
  }
  return lane
}

function maybeReleaseHostLogLane(lane: AsyncHostLogLane): void {
  if (lane.handleCount === 0 && lane.idle && hostLogLanes.get(lane.path) === lane) {
    hostLogLanes.delete(lane.path)
  }
}

/** Appending JSONL handle for one managed host (write side of spawn-dsh.ts and
 * local-connection.ts). Handles for the same backing path share one bounded asynchronous
 * lane, so a buffered write can never race a rename. The high-water policy drops the
 * newest entry — the control-plane logger already carried it, and diagnostics must never
 * backpressure the host pipe. `options.warn` receives ONE diagnostic per drop episode
 * (re-armed after a successful append/compaction) under try/catch, never awaited. */
export function createHostLogWriter(
  stateDir: string,
  port: number,
  options: { warn?: (message: string) => void } = {},
): HostLogWriter {
  let ownedLane: AsyncHostLogLane | null = null
  let closed = false

  function laneForWrite(): AsyncHostLogLane {
    if (ownedLane === null) {
      ownedLane = getHostLogLane(stateDir, port, options.warn)
      ownedLane.handleCount += 1
    }
    return ownedLane
  }

  return {
    write(line, streamName) {
      if (closed) return false
      const entry = `${JSON.stringify({ ts: new Date().toISOString(), stream: streamName, line })}\n`
      return laneForWrite().enqueue(entry)
    },
    async flush() {
      await ownedLane?.flush()
    },
    async close() {
      if (!closed) {
        closed = true
        if (ownedLane !== null) ownedLane.handleCount -= 1
      }
      const lane = ownedLane
      if (lane === null) return
      await lane.flush()
      maybeReleaseHostLogLane(lane)
    },
  }
}

/** A typed error carrying the design-wide wire code. */
type CodedError = Error & { code: string }

/**
 * Typed error for absent connections/logs (design-wide `not_found`, same family as
 * api.ts 404 {error:'not_found'}).
 */
function notFoundError(message: string): CodedError {
  const error = new Error(message) as CodedError
  error.code = 'not_found'
  return error
}

/** Typed error for invalid read arguments. */
function invalidArgumentError(message: string): CodedError {
  const error = new Error(message) as CodedError
  error.code = 'invalid_argument'
  return error
}

/**
 * All valid spawn records from the managed-dsh registry, newest first. Corrupt/pid-less
 * records are skipped (reads are read-only, so the corrupt file is left for the reaper).
 * claim-*.json files are never host-spawn records and are ignored.
 */
async function listSpawnRecords(stateDir: string): Promise<PidRecord[]> {
  let entries
  try {
    entries = await readdir(join(stateDir, 'managed-dsh'))
  } catch {
    return []
  }
  const records: PidRecord[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const pid = Number(name.slice(0, -'.json'.length))
    if (!Number.isInteger(pid) || pid < 1) continue // claim-*.json and junk
    const record = readPidRecord(stateDir, pid)
    if (record === null) continue
    records.push(record)
  }
  records.sort((a, b) => {
    const ta = a.startedAt ?? ''
    const tb = b.startedAt ?? ''
    if (ta !== tb) return ta < tb ? 1 : -1
    return b.pid - a.pid
  })
  return records
}

/** The most recent spawn record, or null. */
async function latestSpawnRecord(stateDir: string): Promise<PidRecord | null> {
  const records = await listSpawnRecords(stateDir)
  return records.length === 0 ? null : records[0]
}

/**
 * Resolve a read key to a managed-host port: an explicit port wins; otherwise the key
 * must be the known connectionId 'local' (the only spawnable kind in v1), which resolves
 * to the most recent spawn record. Unknown ids return null (typed not-found).
 */
async function resolvePort(stateDir: string, key: number | string): Promise<number | null> {
  if (typeof key === 'number' && Number.isInteger(key)) return key
  if (typeof key === 'string' && /^\d+$/.test(key)) return Number(key)
  if (key === 'local') {
    const record = await latestSpawnRecord(stateDir)
    return record === null ? null : record.port
  }
  return null
}

/** One parsed rolling-log line (JSONL entries carry ts/stream, raw lines neither). */
interface LogLine {
  ts: string | null
  stream: 'stdout' | 'stderr' | null
  line: string
}

/**
 * Parse one rolling-log line. JSONL entries yield {ts, stream, line}; non-JSON lines yield
 * {ts:null, stream:null, line:raw} — an honest "no metadata", never a guess.
 */
function parseLogLine(raw: string): LogLine | null {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
  if (line === '') return null
  try {
    const parsed = JSON.parse(line)
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.line === 'string') {
      return {
        ts: typeof parsed.ts === 'string' ? parsed.ts : null,
        stream: parsed.stream === 'stderr' ? 'stderr' : 'stdout',
        line: parsed.line,
      }
    }
  } catch { /* fall through to raw passthrough */ }
  return { ts: null, stream: null, line }
}

/**
 * Read the last `limit` log lines (plus `offset` skipped from the newest end), oldest
 * first. Truncation-safe: only the file tail is read unless the file is small enough to
 * read whole. `truncated` is true when the file exceeds MAX_WHOLE_READ_BYTES and the
 * needed line count did not fit the tail window.
 */
export async function readLogTail(path: string, { limit, offset }: { limit: number; offset: number }): Promise<{ lines: LogLine[]; truncated: boolean }> {
  const parent = await pinDirectory(dirname(path))
  let fd: FileHandle | null = null
  try {
    await verifyDirectory(parent)
    const before = await inspectLeaf(path)
    if (before === null) {
      throw Object.assign(new Error(`host log file is missing: ${path}`), { code: 'ENOENT' })
    }
    fd = await open(path, constants.O_RDONLY | noFollowOpenFlag())
    const info = await fd.stat()
    const opened = assertSafeLeaf(path, info)
    if (!samePrivateIdentity(before.identity, opened.identity)) {
      throw new Error(`host log leaf changed while opening for read: ${path}`)
    }
    await inspectExpectedLeaf(path, opened.identity)
    await verifyDirectory(parent)
    if (info.size === 0) {
      const afterEmptyRead = assertSafeLeaf(path, await fd.stat())
      await inspectExpectedLeaf(path, opened.identity)
      await verifyDirectory(parent)
      if (!samePrivateIdentity(opened.identity, afterEmptyRead.identity)) {
        throw new Error(`host log leaf changed during empty read: ${path}`)
      }
      return { lines: [], truncated: false }
    }
    const needed = limit + offset
    let text
    if (info.size <= TAIL_READ_BYTES) {
      // The whole file fits the window: read it all, nothing is partial.
      const buffer = Buffer.alloc(info.size)
      const { bytesRead } = await fd.read(buffer, 0, info.size, 0)
      text = buffer.subarray(0, bytesRead).toString('utf8')
    } else {
      // The tail window's first line is a mid-line fragment — drop it (never return partial lines).
      const buffer = Buffer.alloc(TAIL_READ_BYTES)
      const { bytesRead } = await fd.read(buffer, 0, TAIL_READ_BYTES, info.size - TAIL_READ_BYTES)
      text = buffer.subarray(0, bytesRead).toString('utf8')
      const firstBreak = text.indexOf('\n')
      text = firstBreak === -1 ? '' : text.slice(firstBreak + 1)
      if (text.split('\n').filter(line => line !== '').length < needed && info.size <= MAX_WHOLE_READ_BYTES) {
        // The window is too small but the file is cheap to read whole — do it for a complete answer.
        const whole = Buffer.alloc(info.size)
        const { bytesRead: wholeRead } = await fd.read(whole, 0, info.size, 0)
        text = whole.subarray(0, wholeRead).toString('utf8')
      }
    }
    let lines = text.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const truncated = text !== '' && lines.length < needed && info.size > MAX_WHOLE_READ_BYTES
    if (lines.length > needed) lines = lines.slice(lines.length - needed)
    // offset: drop the newest `offset` lines; offset >= available skips EVERYTHING
    // (never "return all lines").
    if (offset > 0) lines = lines.length > offset ? lines.slice(0, lines.length - offset) : []
    const after = assertSafeLeaf(path, await fd.stat())
    await inspectExpectedLeaf(path, opened.identity)
    await verifyDirectory(parent)
    // Concurrent append is safe (every read is bounded by the original size); replacement/
    // compaction or truncation is not — never return bytes from a generation the namespace no longer owns.
    if (!samePrivateIdentity(opened.identity, after.identity) || after.stat.size < info.size) {
      throw new Error(`host log leaf changed during read: ${path}`)
    }
    return { lines: lines.map(parseLogLine).filter((entry): entry is LogLine => entry !== null), truncated }
  } finally {
    try {
      await fd?.close()
    } finally {
      await closeDirectory(parent)
    }
  }
}

/** One managed host's log facts attached to diagnostics. */
interface LogFileFacts {
  exists: boolean
  size?: number
  mtimeMs?: number
}

/** One spawn-diagnostics row (the managed registry entry + its log file facts). */
interface SpawnDiagnostics {
  pid: number
  port: number
  startedAt: string | null
  source: string | null
  ownerPid: number | null
  ownerInstanceId: string | null
  profile: string | null
  binary: string | null
  logFile: LogFileFacts
}

/** The listDiagnostics summary. */
interface DiagnosticsResult {
  lastSpawn: SpawnDiagnostics | null
  managed: SpawnDiagnostics[]
  count: number
}

/** The readManagedLog result. */
interface ManagedLogResult {
  port: number
  lines: LogLine[]
  truncated: boolean
}

/** The hostLogs module surface (read side of the rolling-log convention). */
interface HostLogsModule {
  readManagedLog(connectionIdOrPort: number | string, options?: { limit?: number; offset?: number }): Promise<ManagedLogResult>
  listDiagnostics(): Promise<DiagnosticsResult>
  logPathFor(stateDir: string, port: number): string
}

/** Create the host-log read module; returns {readManagedLog, listDiagnostics, logPathFor}. */
export function hostLogs({ stateDir, logger }: { stateDir: string; logger?: Logger }): HostLogsModule {
  const warn = (...parts: unknown[]) => logger?.warn?.(...parts)

  /**
   * Read the recent rolling-log lines of a managed host. `connectionIdOrPort` is a port
   * or the connectionId 'local' (resolved via the spawn registry). limit is clamped to
   * MAX_LIMIT; offset skips the newest lines. Throws {code:'not_found'} or
   * {code:'invalid_argument'}.
   */
  async function readManagedLog(connectionIdOrPort: number | string, options: { limit?: number; offset?: number } = {}): Promise<ManagedLogResult> {
    const limitRaw = options.limit ?? DEFAULT_LIMIT
    const offsetRaw = options.offset ?? 0
    if (!Number.isInteger(limitRaw) || limitRaw < 1) {
      throw invalidArgumentError(`limit must be a positive integer, got ${JSON.stringify(limitRaw)}`)
    }
    if (!Number.isInteger(offsetRaw) || offsetRaw < 0) {
      throw invalidArgumentError(`offset must be a non-negative integer, got ${JSON.stringify(offsetRaw)}`)
    }
    const limit = Math.min(limitRaw, MAX_LIMIT)
    const port = await resolvePort(stateDir, connectionIdOrPort)
    if (port === null) {
      throw notFoundError(`no managed host record for ${String(connectionIdOrPort)}`)
    }
    const path = logPathFor(stateDir, port)
    let result
    try {
      result = await readLogTail(path, { limit, offset: offsetRaw })
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        throw notFoundError(`no host log file for port ${port} (${path})`)
      }
      throw error
    }
    if (result.truncated) {
      warn(`host-logs: port ${port} log is larger than the tail window; only the newest ${result.lines.length} line(s) were read (truncated read)`)
    }
    return { port, lines: result.lines, truncated: result.truncated }
  }

  /**
   * Spawn diagnostics summary: every managed spawn record plus per-record rolling-log file
   * facts. v1 reports the record fields, the authoritative spawn fact the registry holds.
   */
  async function listDiagnostics(): Promise<DiagnosticsResult> {
    const records = await listSpawnRecords(stateDir)
    const managed: SpawnDiagnostics[] = []
    for (const record of records) {
      let logFile: LogFileFacts
      try {
        const log = await inspectLeaf(logPathFor(stateDir, record.port))
        logFile = log === null
          ? { exists: false }
          : { exists: true, size: log.stat.size, mtimeMs: log.stat.mtimeMs }
      } catch {
        logFile = { exists: false }
      }
      managed.push({
        pid: record.pid,
        port: record.port,
        startedAt: record.startedAt ?? null,
        source: record.source ?? null,
        ownerPid: record.ownerPid ?? null,
        ownerInstanceId: record.ownerInstanceId ?? null,
        profile: record.profile ?? null,
        binary: record.binary ?? null,
        logFile,
      })
    }
    return {
      lastSpawn: managed.length === 0 ? null : managed[0],
      managed,
      count: managed.length,
    }
  }

  return { readManagedLog, listDiagnostics, logPathFor }
}
