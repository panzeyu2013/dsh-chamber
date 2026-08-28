/**
 * Host log reading + spawn-diagnostics summary (module 03, host-management
 * deployment — the read side behind a coordinator-wired GET /api/host/logs).
 *
 * Rolling host logs (design 02 §3.2.1: "stdout/stderr 管道接入控制面滚动日志"):
 * the convention this module defines is one JSONL file per managed host at
 * <stateDir>/host-logs/<port>.log, one entry per line:
 *   {"ts":"<ISO 8601>","stream":"stdout|stderr","line":"<text>"}
 *
 * Honest note: spawn-dsh.ts attaches a per-host JSONL writer (createHostLogWriter)
 * at spawn, so a live host's stdout/stderr lands in <stateDir>/host-logs/<port>.log
 * and reads resolve; a host that exited before any line was captured may still
 * report a typed not-found. The module never writes, never touches the catalog,
 * and derives the managed port from the spawn registry
 * (<stateDir>/managed-dsh/<pid>.json) or from an explicit port, so it is
 * unit-testable against plain tmp-directory fixtures.
 *
 * Tail safety: large files are read from the tail (TAIL_READ_BYTES window);
 * when the needed line count does not fit the window and the file is larger
 * than MAX_WHOLE_READ_BYTES the read returns what the window held and flags
 * `truncated: true` instead of loading the whole file.
 */

import { open, readdir, stat } from 'node:fs/promises'
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPidRecord } from './spawn-dsh.ts'
import type { PidRecord } from './spawn-dsh.ts'
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
 * Rolling-log ring cap (design 02 §3.8: "RING_BUFFER 行数/字节上限，如 500 行，
 * 滚动丢弃"): how many lines one managed-host log keeps on disk. The writer
 * compacts back to COMPACT_KEEP_LINES once the cap is crossed, so a long-lived
 * host can never grow an unbounded log file (reads additionally clamp with the
 * tail-window/truncated discipline below).
 */
export const MAX_LOG_LINES = 500

/** Compaction retains this many trailing lines (so compaction runs ~every 100 writes). */
export const COMPACT_KEEP_LINES = 400

/** The rolling-log file for a given managed-host port. */
export function logPathFor(stateDir: string, port: number): string {
  return join(stateDir, LOG_DIR, `${port}.log`)
}

/** The appending rolling-log writer for one managed host. */
interface HostLogWriter {
  write(line: string, streamName?: string): void
  close(): void
}

/** Appending JSONL writer for one managed host (the write side of the
 * rolling-log convention above — attached by spawn-dsh.ts to the host's
 * stdout/stderr). Writes are SYNCHRONOUS appendFileSync calls: an async
 * WriteStream would race compaction's rename (a pending async open appends
 * its buffered backlog into the renamed file, duplicating and interleaving
 * content — 2026 round-3 review). The volume is tiny (the web-profile host
 * is silent on stdio; the observable content is lifecycle transitions), so
 * sync appends are free. Failures are swallowed (the control-plane logger
 * already carried the line; a dead log file must never wedge the host pipe).
 */
export function createHostLogWriter(stateDir: string, port: number): HostLogWriter {
  let needsSetup = true
  let linesWritten = 0
  // In-memory ring of the last COMPACT_KEEP_LINES lines — the compaction
  // source (the file is never re-read for compaction, so no read-vs-write
  // race exists at all).
  const ring: string[] = []
  /**
   * Drop all in-memory knowledge of the current backing-file generation.
   * After any append/compaction failure we cannot prove that the file still
   * contains the ring; retaining it could resurrect deleted content when a
   * later compaction replaces a newly-created file.
   */
  function resetGeneration(): void {
    ring.length = 0
    linesWritten = 0
    needsSetup = true
  }
  /** (Re)create the log directory; the next append then lands. */
  function setup(): void {
    try {
      mkdirSync(join(stateDir, LOG_DIR), { recursive: true })
      needsSetup = false
    } catch {
      /* swallow — the write is lost; the next write retries */
    }
  }
  /** Compaction: keep the trailing COMPACT_KEEP_LINES. Failures are
   * swallowed: logging must never wedge the host pipe. */
  function compact(): void {
    try {
      const tmp = `${logPathFor(stateDir, port)}.compact.tmp`
      // Ring entries already end with '\n' — join with '' (a '\n' join
      // would double the separators and leave blank lines between entries).
      writeFileSync(tmp, ring.join(''))
      renameSync(tmp, logPathFor(stateDir, port))
      linesWritten = ring.length
    } catch {
      resetGeneration()
      /* swallow — see header note */
    }
  }
  return {
    write(line, streamName) {
      if (needsSetup) setup()
      const entry = `${JSON.stringify({ ts: new Date().toISOString(), stream: streamName, line })}\n`
      try {
        appendFileSync(logPathFor(stateDir, port), entry)
        // The ring is the compaction source and compaction REPLACES the file
        // with it — push only on success so the invariant ring == file holds
        // exactly (a swallowed write must never be resurrected by a later
        // compaction; 2026 review hardening).
        ring.push(entry)
        if (ring.length > COMPACT_KEEP_LINES) ring.splice(0, ring.length - COMPACT_KEEP_LINES)
        // Count only writes known to have landed in this backing generation.
        linesWritten += 1
        if (linesWritten > MAX_LOG_LINES) compact()
      } catch {
        // The write is lost and the backing generation is now uncertain.
        // Forget its ring/counter so a later recreation cannot resurrect it.
        resetGeneration()
      }
    },
    close() {
      // Sync appends are already durable; nothing to flush.
    },
  }
}

/** A typed error carrying the design-wide wire code. */
type CodedError = Error & { code: string }

/**
 * Typed error for absent connections/logs (design-wide `not_found` code,
 * same family as api.ts 404 {error:'not_found'}).
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
 * All valid spawn records from the managed-dsh registry (design 02 §3.4.1),
 * newest first. Corrupt/pid-less records are skipped (registry discipline:
 * "解析失败或 pid 非整数 → 删文件，不猜测" — reads are read-only, so the
 * corrupt file is left for the reaper). Claim files (claim-<port>.json,
 * external takeovers) are never host-spawn records and are ignored.
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
    records.push(Object.assign({ pid }, record))
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
 * Resolve a read key to a managed-host port: an explicit port (number or
 * numeric string) wins; otherwise the key must be the known connectionId
 * 'local' (the only spawnable kind in v1), which resolves to the most recent
 * spawn record's port. Unknown connection ids return null (typed not-found).
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
 * Parse one rolling-log line. JSONL entries yield {ts, stream, line};
 * non-JSON lines (raw passthrough, unknown writer) yield {ts:null,
 * stream:null, line:raw} — an honest "no metadata" rather than a guess.
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
 * Read the last `limit` log lines (plus `offset` skipped from the newest
 * end), oldest first. Truncation-safe: only the file tail is read into
 * memory unless the file is small enough to read whole.
 * @param path - the rolling-log file.
 * @param limit - lines to return (must be a positive integer).
 * @param offset - lines to skip from the newest end (non-negative integer).
 * @returns {{lines: Array, truncated: boolean}} — `truncated` is true when
 *   the file is larger than MAX_WHOLE_READ_BYTES and the needed line count
 *   did not fit the tail window.
 */
export async function readLogTail(path: string, { limit, offset }: { limit: number; offset: number }): Promise<{ lines: LogLine[]; truncated: boolean }> {
  const fd = await open(path, 'r')
  try {
    const info = await fd.stat()
    if (info.size === 0) return { lines: [], truncated: false }
    const needed = limit + offset
    let text
    if (info.size <= TAIL_READ_BYTES) {
      // The whole file fits the window: read it all, nothing is partial.
      const buffer = Buffer.alloc(info.size)
      const { bytesRead } = await fd.read(buffer, 0, info.size, 0)
      text = buffer.subarray(0, bytesRead).toString('utf8')
    } else {
      // Read the tail window; its first line is a fragment of a line cut
      // mid-way — drop it (never return partial lines).
      const buffer = Buffer.alloc(TAIL_READ_BYTES)
      const { bytesRead } = await fd.read(buffer, 0, TAIL_READ_BYTES, info.size - TAIL_READ_BYTES)
      text = buffer.subarray(0, bytesRead).toString('utf8')
      const firstBreak = text.indexOf('\n')
      text = firstBreak === -1 ? '' : text.slice(firstBreak + 1)
      if (text.split('\n').filter(line => line !== '').length < needed && info.size <= MAX_WHOLE_READ_BYTES) {
        // The window is too small but the file is cheap to read whole — do
        // it for a complete answer (never silently return a subset).
        const whole = Buffer.alloc(info.size)
        const { bytesRead: wholeRead } = await fd.read(whole, 0, info.size, 0)
        text = whole.subarray(0, wholeRead).toString('utf8')
      }
    }
    let lines = text.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const truncated = text !== '' && lines.length < needed && info.size > MAX_WHOLE_READ_BYTES
    if (lines.length > needed) lines = lines.slice(lines.length - needed)
    // offset: drop the newest `offset` lines — offset >= available skips
    // EVERYTHING (never "return all lines", which would violate the limit
    // and the skip semantics; 2026 round-3 review).
    if (offset > 0) lines = lines.length > offset ? lines.slice(0, lines.length - offset) : []
    return { lines: lines.map(parseLogLine).filter((entry): entry is LogLine => entry !== null), truncated }
  } finally {
    await fd.close()
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

/**
 * Create the host-log read module.
 * @param options - {stateDir, logger}.
 * @returns {{readManagedLog, listDiagnostics, logPathFor}}.
 */
export function hostLogs({ stateDir, logger }: { stateDir: string; logger?: Logger }): HostLogsModule {
  const warn = (...parts: unknown[]) => logger?.warn?.(...parts)

  /**
   * Read the recent rolling-log lines of a managed host.
   * @param connectionIdOrPort - a port (number or numeric string) or a
   *   connectionId ('local' — resolved via the spawn registry).
   * @param options - {limit=200, offset=0}: limit is clamped to MAX_LIMIT,
   *   offset skips the newest `offset` lines.
   * @returns {port, lines, truncated} — entries are {ts, stream, line},
   *   oldest first. Throws {code:'not_found'} when no managed record or no
   *   log file exists; {code:'invalid_argument'} on bad limit/offset.
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
   * Spawn diagnostics summary (for the diagnostics endpoint): every managed
   * spawn record plus per-record rolling-log file facts. The design's
   * structured lastSpawnDiagnostics (binary/args/cwd/env-counts, §3.2.1)
   * does not exist in spawn-dsh yet — v1 reports the record fields, which
   * is the authoritative spawn fact the registry holds.
   */
  async function listDiagnostics(): Promise<DiagnosticsResult> {
    const records = await listSpawnRecords(stateDir)
    const managed: SpawnDiagnostics[] = []
    for (const record of records) {
      let logFile: LogFileFacts
      try {
        const info = await stat(logPathFor(stateDir, record.port))
        logFile = { exists: true, size: info.size, mtimeMs: info.mtimeMs }
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
