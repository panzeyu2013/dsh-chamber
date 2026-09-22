/**
 * Windows process/port probes and tree termination for the control-plane
 * lifecycle (design 02 §5.1「Windows 路径退化」→ v1 parity work).
 *
 * POSIX lacks none of these primitives (ps/lsof/ss/proc + process groups),
 * so nothing here runs on non-Windows hosts: every exec helper is win32-gated
 * and throws off-platform, while the pure parsers/classifiers below are unit
 * tested on every CI leg (including POSIX). Failure discipline mirrors the
 * reaper contract — an unavailable or ambiguous probe NEVER proves absence:
 *   - identity (replaces `ps -o ppid=,command=`):
 *       PowerShell `Get-CimInstance Win32_Process` (PowerShell 5.1 ships with
 *       Windows 10+ / Server 2016+; wmic is deprecated and tasklist carries
 *       no command line). Same-user/elevation queries expose CommandLine and
 *       ParentProcessId, restoring the Unix-style exact command-token match.
 *   - port ownership (replaces lsof/ss/proc): `Get-NetTCPConnection -State
 *       Listen` JSON rows keyed by LocalPort + OwningProcess (structured and
 *       free of localized state text), falling back to `netstat -ano -p tcp`
 *       LISTENING rows when the cmdlet/probe is unavailable. Both sources
 *       share the 500ms table cache.
 *   - tree liveness/kill (replaces process-group signals): Windows has no
 *       POSIX signals for arbitrary pids (kill is TerminateProcess), so the
 *       managed tree is force-terminated with `taskkill /T /F`. A dead leader
 *       can still leave descendants (Windows never reparents; ParentProcessId
 *       stays stale), so residual descendants are discovered through the CIM
 *       process table and killed individually — parity with the Unix
 *       "leader dead but residual process group alive ⇒ keep evidence" rule.
 *
 * Sibling-parity note (audit 2026): packages/dsh-runtime/src/windows-process.ts
 * is the shared-core twin of this module (same CIM/taskkill semantics,
 * self-contained because dsh-runtime must not import control-plane). Keep
 * behavior identical across both; the Windows CI leg runs both test sets.
 * The S1 residual re-proof (fresh CIM table, CreationDate/CommandLine) and the
 * S5 CIM liveness verdict are carried by both modules: S5 ported the re-proof
 * back to the installer twin's killWindowsTreeWithResidual (2026), so the two
 * are aligned again (review/windows/fixes/s5-win32-liveness.md).
 *
 * The PowerShell command is bounded, read-only, and spawns no user code
 * (-NoProfile -NonInteractive); the full process table is fetched once and
 * cached briefly so poll loops do not pay one interpreter startup per tick.
 */

import { spawnSync } from 'node:child_process'

/** Every probe/termination exec is bounded; a hung host tool cannot hang the
 *  reaper or a spawn attempt. 30s (2026-09 first real-runner finding): fresh
 *  windows-2022 runners pay Windows PowerShell 5.1 first-run + Defender
 *  real-time scan latency that exceeded 10s (spawnSync ETIMEDOUT in the
 *  win32 lifecycle integration); the 500ms table cache means the slow path
 *  is paid once per TTL, not per poll. MUST stay in sync with
 *  windows-process.ts PROBE_TIMEOUT_MS — enforced by the parity test
 *  (test/protocol/win-probes-parity.test.ts), not by this comment. */
export const WINDOWS_PROBE_TIMEOUT_MS = 30_000

/** CIM table cache TTL — MUST match windows-process.ts; parity-test-enforced. */
export const TABLE_CACHE_TTL_MS = 500

/** One parsed Win32_Process row (JSON-normalized). */
export interface CimProcessRow {
  pid: number
  /** ParentProcessId; null when the property is absent/empty. */
  ppid: number | null
  command: string | null
  /** CreationDate; null when the property is absent/unreadable. A residual
   *  pid is terminated only while this stable field (or the command line)
   *  still matches the scanned row — pid reuse must never authorize a kill. */
  createdAt: string | null
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error('windows process probes are only available on win32')
  }
}

function execWindowsTool(file: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(file, args, {
    encoding: 'utf8',
    timeout: WINDOWS_PROBE_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (res.error !== undefined) throw res.error
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

// Pure parsers / builders (unit-tested on every platform)

/**
 * Parse the output of
 *   $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate)
 *   ConvertTo-Json -InputObject $rows -Compress
 * into normalized rows. Unparseable input yields [] (the caller then fails
 * closed); a JSON document that is neither an array nor an object is ignored.
 */
export function parseCimProcessTable(text: string): CimProcessRow[] {
  if (typeof text !== 'string' || text.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const rows: CimProcessRow[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    const pid = toFiniteInt(record.ProcessId)
    if (pid === null) return
    rows.push({
      pid,
      ppid: toFiniteInt(record.ParentProcessId),
      command: toScalarString(record.CommandLine),
      createdAt: toScalarString(record.CreationDate),
    })
  }
  visit(parsed)
  return rows
}

function toFiniteInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isInteger(parsed)) return parsed
  }
  return null
}

function toScalarString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** All pids in `rows` whose ancestor chain (via ParentProcessId) reaches
 *  `rootPid`. The root itself is never returned. Windows never reparents, so
 *  a stale ParentProcessId still identifies an orphaned descendant. */
export function descendantPidsOf(rows: CimProcessRow[], rootPid: number): number[] {
  const childrenOf = new Map<number, number[]>()
  for (const row of rows) {
    if (row.ppid === null || row.ppid === row.pid) continue
    const siblings = childrenOf.get(row.ppid)
    if (siblings === undefined) childrenOf.set(row.ppid, [row.pid])
    else siblings.push(row.pid)
  }
  const found: number[] = []
  const seen = new Set<number>()
  const stack = [rootPid]
  while (stack.length > 0) {
    const current = stack.pop() as number
    for (const child of childrenOf.get(current) ?? []) {
      // A parent/child cycle must never re-enter the root through its own
      // subtree (Windows ParentProcessId fields are stale-but-stable, so a
      // cycle is not expected — the guard is defensive).
      if (child === rootPid || seen.has(child)) continue
      seen.add(child)
      found.push(child)
      stack.push(child)
    }
  }
  return found
}

/** One listening socket owner row (port + owning pid), however probed. */
export interface TcpListenRow {
  port: number
  pid: number
}

/**
 * Parse `netstat -ano -p tcp` rows into every listening port/pid pair. The
 * parser accepts both IPv4 (127.0.0.1:port) and bracketed IPv6 ([::1]:port)
 * local forms; note that `-p tcp` typically lists IPv4 rows only on real
 * Windows output (IPv6 appears under tcpv6) — the tolerant shape is
 * deliberate (audit note, real-machine verification pending). Protocol and
 * state matching are case-insensitive (`tcp`/`LISTENING`/`listening`), but
 * an unrecognized (e.g. localized) state is skipped, never guessed as a
 * listener.
 */
export function parseNetstatListeningRows(text: string): TcpListenRow[] {
  const rows: TcpListenRow[] = []
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 5) continue
    if (fields[0].toUpperCase() !== 'TCP') continue
    if (fields[3].toUpperCase() !== 'LISTENING') continue
    const local = fields[1]
    const colon = local.lastIndexOf(':')
    if (colon === -1) continue
    const port = Number(local.slice(colon + 1))
    const pid = Number(fields[fields.length - 1])
    if (!Number.isInteger(port) || !Number.isInteger(pid) || pid <= 0) continue
    const key = `${port}:${pid}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ port, pid })
  }
  return rows
}

/** Port-scoped view of {@link parseNetstatListeningRows} (reaper seam). */
export function parseNetstatListeningPids(text: string, port: number): number[] {
  const pids = new Set<number>()
  for (const row of parseNetstatListeningRows(text)) {
    if (row.port === port) pids.add(row.pid)
  }
  return [...pids]
}

/**
 * Parse the output of
 *   $rows = @(Get-NetTCPConnection -State Listen | Select-Object LocalPort,OwningProcess)
 *   ConvertTo-Json -InputObject $rows -Compress
 * into normalized rows. `-State Listen` already narrows the table to
 * listeners, so only the local port and owning pid are read. Unparseable
 * input yields [] (the caller then falls back to netstat / fails closed); a
 * JSON document that is neither an array nor an object is ignored.
 */
export function parseTcpConnectionListenJson(text: string): TcpListenRow[] {
  if (typeof text !== 'string' || text.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  return collectTcpListenRows(parsed)
}

function collectTcpListenRows(parsed: unknown): TcpListenRow[] {
  const rows: TcpListenRow[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    const port = toFiniteInt(record.LocalPort)
    const pid = toFiniteInt(record.OwningProcess)
    // OwningProcess is absent/0 for rows without a real owner; a listener
    // row without both fields cannot prove ownership and is dropped.
    if (port === null || port <= 0 || port > 65535 || pid === null || pid <= 0) return
    rows.push({ port, pid })
  }
  visit(parsed)
  return rows
}

/** taskkill tree-termination argv: `/PID <pid> /T /F`. Windows has no
 *  graceful signal for console-less processes, so the tree is force-killed in
 *  one call (the SIGTERM stage of the Unix sequence maps to the same shape). */
export function taskkillTreeArgs(pid: number): string[] {
  return ['/PID', String(pid), '/T', '/F']
}

/**
 * Classify a taskkill run into 'signalled' (exit 0), 'gone' (the pid was
 * already absent), or 'error' (anything else — fail closed, never pretend).
 * taskkill prints "ERROR: ... not found." with a non-zero code for a missing
 * pid; both the exit code and the message are consulted so parser drift on
 * one host cannot flip a verdict.
 */
export function classifyTaskkillOutput(status: number | null, combined: string): 'signalled' | 'gone' | 'error' {
  if (status === 0) return 'signalled'
  if (/not found|no running instance/i.test(combined)) return 'gone'
  return 'error'
}

/** The listen-table PowerShell command line used as the primary port-owner
 *  probe. `-State Listen` means no localized netstat state text is parsed;
 *  read-only; output pinned to UTF-8 because powershell.exe defaults to the
 *  OEM console codepage. */
export function buildTcpListenTableCommand(): string {
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$rows = @(Get-NetTCPConnection -State Listen | Select-Object LocalPort,OwningProcess)',
    'ConvertTo-Json -InputObject $rows -Compress',
  ].join('; ')
}

/** The full-process-table PowerShell command line used for identity and
 *  residual-tree probes. Read-only; output pinned to UTF-8 because
 *  powershell.exe defaults to the OEM console codepage. */
export function buildCimTableCommand(): string {
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate)',
    'ConvertTo-Json -InputObject $rows -Compress',
  ].join('; ')
}

// Exec helpers (win32-gated; throw or fail closed off-platform)

/**
 * Query the full CIM process table (cached briefly so the reaper's poll
 * loops and per-record identity checks share one interpreter start).
 * Throws when PowerShell is unavailable or produced no parseable table.
 */
export function queryWindowsProcessTable(): CimProcessRow[] {
  assertWindows()
  const now = Date.now()
  if (tableCache !== null && now - tableCache.at < TABLE_CACHE_TTL_MS) return tableCache.rows
  return probeWindowsProcessTable()
}

function queryWindowsProcessTableFresh(): CimProcessRow[] {
  assertWindows()
  return probeWindowsProcessTable()
}

function probeWindowsProcessTable(): CimProcessRow[] {
  const { status, stdout, stderr } = execWindowsTool('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    buildCimTableCommand(),
  ])
  const rows = status === 0 ? parseCimProcessTable(stdout) : []
  if (rows.length === 0) {
    // An empty table is indistinguishable from a probe failure; never treat
    // it as proof of absence.
    throw new Error(`windows CIM process table unavailable (exit ${String(status)}): ${stderr.trim().slice(0, 512) || 'empty output'}`)
  }
  tableCache = { at: Date.now(), rows }
  return rows
}

let tableCache: { at: number; rows: CimProcessRow[] } | null = null

export type CimIdentityVerdict = 'match' | 'mismatch' | 'unprovable'

/**
 * Re-prove that `current` is still the process `original` described. Pid reuse
 * makes the numeric ProcessId alone insufficient, so the stable CreationDate
 * (or, when the date is unreadable on either side, the full command line) must
 * match. A different value and a missing current row are 'mismatch' (never
 * kill); an identity no shared field can prove is 'unprovable' and the caller
 * fails closed.
 */
export function cimRowStillIdentifies(original: CimProcessRow, current: CimProcessRow | null): CimIdentityVerdict {
  if (current === null || current.pid !== original.pid) return 'mismatch'
  if (original.createdAt !== null && current.createdAt !== null) {
    return original.createdAt === current.createdAt ? 'match' : 'mismatch'
  }
  if (original.command !== null && current.command !== null) {
    return original.command === current.command ? 'match' : 'mismatch'
  }
  return 'unprovable'
}

/**
 * Pure CIM-liveness classifier (S5 fix; unit-tested on every platform).
 * `original` is the row scanned earlier, or null when only pid presence is
 * asked. True = a row exists that still carries the scanned identity (or any
 * row when no identity was supplied); false = the table is readable and the
 * pid is absent (or names a reused, different process) — the scanned process
 * is gone; null = no shared identity field can prove the row, so the caller
 * keeps its fail-closed answer instead of treating doubt as death.
 */
export function classifyCimLiveness(pid: number, original: CimProcessRow | null, current: CimProcessRow | null): boolean | null {
  const row = current !== null && current.pid === pid ? current : null
  if (original === null) return row !== null
  const verdict = cimRowStillIdentifies(original, row)
  if (verdict === 'match') return true
  if (verdict === 'mismatch') return false
  return null
}

/** Table reader for the liveness proof: `fresh = false` is the shared
 *  500ms-cached probe, `fresh = true` bypasses the cache. Injectable so the
 *  fresh-recheck arm below is testable off-win32. */
export type CimTableRead = (fresh: boolean) => CimProcessRow[]

/**
 * Liveness classification from two table reads — the fresh-recheck core of
 * {@link cimPidLiveness}. A cached "alive" verdict is final; a cached "dead"
 * one is NOT: the shared table can PREDATE the pid, so a process created
 * after that read is absent from it while fully alive. "Dead" is the only
 * verdict that authorizes skipping a signal and dropping the pid ledger
 * (terminateChild, reaper), so it is trusted only after a cache-bypassing
 * re-probe — the same discipline treeKillWindows applies before terminating
 * residual descendants. A read failure at either step returns null (unknown;
 * the caller keeps its previous, fail-closed answer).
 */
export function classifyCimLivenessFromTableReads(
  pid: number,
  original: CimProcessRow | null,
  read: CimTableRead,
): boolean | null {
  let cachedRows: CimProcessRow[]
  try {
    cachedRows = read(false)
  } catch {
    return null
  }
  const cached = classifyCimLiveness(pid, original, cachedRows.find(row => row.pid === pid) ?? null)
  if (cached !== false) return cached
  let freshRows: CimProcessRow[]
  try {
    freshRows = read(true)
  } catch {
    return null
  }
  return classifyCimLiveness(pid, original, freshRows.find(row => row.pid === pid) ?? null)
}

/**
 * CIM-table liveness proof for one pid (S5 fix, additive; win32-only).
 * process.kill(pid, 0) is an OpenProcess probe: it still succeeds for a
 * terminated process object kept alive by an unreleased handle, so a
 * successful taskkill can read as "not quiesced" and keep the writer latch
 * closed forever. Win32_Process only enumerates active processes, so a
 * readable table without the pid proves the scanned process object is gone.
 * The shared 500ms table cache bounds the probe cost of 25ms/100ms poll loops
 * (one interpreter start per TTL), but a pid absent from that cache may simply
 * have been CREATED after the cached read — so a "dead" verdict is re-probed
 * against a fresh table before it is trusted ({@link
 * classifyCimLivenessFromTableReads}); the fail-open it closes would let
 * terminateChild return without signalling a live host while its caller drops
 * the pid record. A probe failure returns null (unknown; the caller keeps its
 * previous, fail-closed answer).
 */
export function cimPidLiveness(pid: number, original: CimProcessRow | null = null): boolean | null {
  assertWindows()
  return classifyCimLivenessFromTableReads(pid, original, fresh =>
    fresh ? queryWindowsProcessTableFresh() : queryWindowsProcessTable())
}

/** Identity adapter (reaper psIdentity seam): {ppid, command} for one pid.
 *  Throws on probe failure or a missing row — the caller keeps the record
 *  (fail closed). command may be '' for an unreadable (elevated) peer, which
 *  also fails the command-token check downstream and keeps the record. */
export function windowsIdentity(pid: number): { ppid: string; command: string } {
  const rows = queryWindowsProcessTable()
  const row = rows.find(candidate => candidate.pid === pid)
  if (row === undefined) throw new Error(`windows identity: no process ${pid}`)
  return { ppid: row.ppid === null ? '' : String(row.ppid), command: row.command ?? '' }
}

/**
 * Whether any descendant of `pid` (dead or alive leader) remains in the CIM
 * table. Fail-closed: a probe failure reports true (evidence must not be
 * erased on doubt). win32-only.
 */
export function hasWindowsResidualTree(pid: number): boolean {
  assertWindows()
  let rows: CimProcessRow[]
  try {
    rows = queryWindowsProcessTable()
  } catch {
    return true
  }
  return descendantPidsOf(rows, pid).length > 0
}

/**
 * Port-ownership adapter (reaper lsof seam): whether `pid` listens on `port`.
 * Primary probe is `Get-NetTCPConnection -State Listen` (structured JSON, no
 * localized state text); `netstat -ano -p tcp` LISTENING rows are the
 * fallback when the cmdlet is unavailable or produced no parseable table.
 * Exec failure of BOTH sources → null (probe unavailable); no row for the
 * port → false. win32-only.
 */
export function windowsPortOwnedBy(pid: number, port: number): boolean | null {
  assertWindows()
  try {
    const rows = queryWindowsListeningTable()
    if (rows === null) return null
    const pids = rows.filter(row => row.port === port).map(row => row.pid)
    if (pids.length === 0) return false
    return pids.includes(pid)
  } catch {
    return null
  }
}

let listenTableCache: { at: number; rows: TcpListenRow[] } | null = null

/** Both listen-table sources share the 500ms table cache (same discipline as
 *  the CIM table): the reaper's poll loop pays one interpreter start per TTL.
 *  Only a successful probe is cached; an unavailable probe is retried. */
function queryWindowsListeningTable(): TcpListenRow[] | null {
  const now = Date.now()
  if (listenTableCache !== null && now - listenTableCache.at < TABLE_CACHE_TTL_MS) return listenTableCache.rows
  const fromCmdlet = queryTcpConnectionListen()
  if (fromCmdlet !== null && fromCmdlet.length > 0) {
    listenTableCache = { at: Date.now(), rows: fromCmdlet }
    return fromCmdlet
  }
  // An EMPTY cmdlet table may be real or may be a silently failed cmdlet (an
  // older host without Get-NetTCPConnection still writes `[]`): netstat is
  // consulted before that empty result is trusted.
  const fromNetstat = queryNetstatListening()
  if (fromNetstat !== null) {
    listenTableCache = { at: Date.now(), rows: fromNetstat }
    return fromNetstat
  }
  if (fromCmdlet !== null) {
    listenTableCache = { at: Date.now(), rows: fromCmdlet }
    return fromCmdlet
  }
  return null
}

function queryTcpConnectionListen(): TcpListenRow[] | null {
  const { status, stdout } = execWindowsTool('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    buildTcpListenTableCommand(),
  ])
  if (status !== 0 || stdout.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    // Unparseable output is a probe failure, not "nothing listens": fall
    // through to netstat instead of reporting absence.
    return null
  }
  return collectTcpListenRows(parsed)
}

function queryNetstatListening(): TcpListenRow[] | null {
  const { status, stdout } = execWindowsTool('netstat.exe', ['-ano', '-p', 'tcp'])
  if (status !== 0 || stdout.trim() === '') return null
  return parseNetstatListeningRows(stdout)
}

/**
 * Force-terminate the whole managed tree rooted at `pid` (taskkill /T /F;
 * residual descendants of an already-dead leader are discovered through CIM
 * and killed individually). Returns true when something was signalled, false
 * when nothing existed (the Unix ESRCH equivalent); every other failure
 * throws loudly. win32-only.
 */
export function treeKillWindows(pid: number): boolean {
  assertWindows()
  let result = runTaskkill(pid)
  if (result === 'signalled') return true
  if (result === 'error') {
    // Audit (2026, med): taskkill renders its not-found message in the OS
    // language, so the English regex cannot prove 'gone' on localized
    // Windows. Verify liveness directly: a dead pid is 'gone'; a live (or
    // unverifiable) pid keeps the loud failure (fail closed).
    if (!windowsPidExists(pid)) result = 'gone'
    else throw new Error(`taskkill tree ${pid} failed`)
  }
  // Leader already gone: kill any residual descendants (Windows keeps their
  // stale ParentProcessId, so the tree is still discoverable). Probe failure
  // fails closed — throw instead of claiming absence.
  let rows: CimProcessRow[]
  try {
    rows = queryWindowsProcessTable()
  } catch (error) {
    throw new Error(`taskkill tree ${pid}: leader gone but residual probe unavailable: ${String(error)}`)
  }
  const residual = descendantPidsOf(rows, pid)
  let killedAny = false
  if (residual.length > 0) {
    const scanned = new Map(rows.map(row => [row.pid, row]))
    let fresh: Map<number, CimProcessRow>
    try {
      fresh = new Map(queryWindowsProcessTableFresh().map(row => [row.pid, row]))
    } catch (error) {
      throw new Error(`taskkill tree ${pid}: residual identity probe unavailable: ${String(error)}`)
    }
    for (const childPid of residual) {
      const verdict = cimRowStillIdentifies(scanned.get(childPid) as CimProcessRow, fresh.get(childPid) ?? null)
      if (verdict === 'mismatch') continue
      if (verdict === 'unprovable') {
        throw new Error(`taskkill residual ${childPid} (tree ${pid}): identity cannot be re-established; refusing to terminate`)
      }
      const outcome = runTaskkill(childPid)
      if (outcome === 'signalled') killedAny = true
      else if (outcome === 'error') {
        if (!windowsPidExists(childPid)) continue
        throw new Error(`taskkill residual ${childPid} (tree ${pid}) failed`)
      }
    }
  }
  return killedAny
}

function runTaskkill(pid: number): 'signalled' | 'gone' | 'error' {
  const { status, stdout, stderr } = execWindowsTool('taskkill.exe', taskkillTreeArgs(pid))
  return classifyTaskkillOutput(status, `${stdout}\n${stderr}`)
}

/** kill(0)-style liveness; EPERM counts as alive; only ESRCH is absence.
 *  Residual (S5, documented): process.kill(pid, 0) is an OpenProcess probe and
 *  can read a terminated process object as alive while a handle is unreleased.
 *  This synchronous call site only classifies a non-zero taskkill result
 *  ('gone' vs the loud 'error'); the awaitable kill-confirmation paths use
 *  {@link cimPidLiveness} instead. */
function windowsPidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    return true
  }
}
