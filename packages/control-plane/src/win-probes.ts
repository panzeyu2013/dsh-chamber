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
 *   - port ownership (replaces lsof/ss/proc): `netstat -ano -p tcp`
 *       LISTENING rows keyed by local address + owning pid.
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
 *  windows-process.ts PROBE_TIMEOUT_MS (sibling-parity audit). */
const WINDOWS_PROBE_TIMEOUT_MS = 30_000

/** CIM table cache TTL — MUST match windows-process.ts (sibling-parity audit, round 2). */
const TABLE_CACHE_TTL_MS = 500

/** One parsed Win32_Process row (JSON-normalized). */
export interface CimProcessRow {
  pid: number
  /** ParentProcessId; null when the property is absent/empty. */
  ppid: number | null
  /** Full command line; null when the query could not read it (e.g. an
   *  elevated peer). A null/empty command fails closed at the caller. */
  command: string | null
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

// ---------------------------------------------------------------------------
// Pure parsers / builders (unit-tested on every platform)
// ---------------------------------------------------------------------------

/**
 * Parse the output of
 *   $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine)
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
      command: typeof record.CommandLine === 'string' && record.CommandLine !== ''
        ? record.CommandLine
        : null,
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

/**
 * Parse `netstat -ano -p tcp` LISTENING rows into the pids listening on
 * `port`. The parser accepts both IPv4 (127.0.0.1:port) and bracketed IPv6
 * ([::1]:port) local forms; note that `-p tcp` typically lists IPv4 rows
 * only on real Windows output (IPv6 appears under tcpv6) — the tolerant
 * shape is deliberate (audit note, real-machine verification pending).
 */
export function parseNetstatListeningPids(text: string, port: number): number[] {
  const pids = new Set<number>()
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 5) continue
    if (fields[0].toUpperCase() !== 'TCP') continue
    if (fields[3].toUpperCase() !== 'LISTENING') continue
    const local = fields[1]
    const colon = local.lastIndexOf(':')
    if (colon === -1) continue
    if (local.slice(colon + 1) !== String(port)) continue
    const pid = Number(fields[fields.length - 1])
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
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

/** The full-process-table PowerShell command line used for identity and
 *  residual-tree probes. Read-only; output pinned to UTF-8 because
 *  powershell.exe defaults to the OEM console codepage. */
export function buildCimTableCommand(): string {
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine)',
    'ConvertTo-Json -InputObject $rows -Compress',
  ].join('; ')
}

// ---------------------------------------------------------------------------
// Exec helpers (win32-gated; throw or fail closed off-platform)
// ---------------------------------------------------------------------------

/**
 * Query the full CIM process table (cached briefly so the reaper's poll
 * loops and per-record identity checks share one interpreter start).
 * Throws when PowerShell is unavailable or produced no parseable table.
 */
export function queryWindowsProcessTable(): CimProcessRow[] {
  assertWindows()
  const now = Date.now()
  if (tableCache !== null && now - tableCache.at < TABLE_CACHE_TTL_MS) return tableCache.rows
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
 * Port-ownership adapter (reaper lsof seam): whether `pid` listens on `port`
 * (netstat LISTENING row). Exec failure → null (probe unavailable); no
 * LISTENING row for the port → false. win32-only.
 */
export function windowsPortOwnedBy(pid: number, port: number): boolean | null {
  assertWindows()
  try {
    const { status, stdout } = execWindowsTool('netstat.exe', ['-ano', '-p', 'tcp'])
    if (status !== 0) return null
    const pids = parseNetstatListeningPids(stdout, port)
    if (pids.length === 0) return false
    return pids.includes(pid)
  } catch {
    return null
  }
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
  for (const childPid of residual) {
    const outcome = runTaskkill(childPid)
    if (outcome === 'signalled') killedAny = true
    else if (outcome === 'error') {
      if (!windowsPidExists(childPid)) continue
      throw new Error(`taskkill residual ${childPid} (tree ${pid}) failed`)
    }
  }
  return killedAny
}

function runTaskkill(pid: number): 'signalled' | 'gone' | 'error' {
  const { status, stdout, stderr } = execWindowsTool('taskkill.exe', taskkillTreeArgs(pid))
  return classifyTaskkillOutput(status, `${stdout}\n${stderr}`)
}

/** kill(0)-style liveness; EPERM counts as alive; only ESRCH is absence. */
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
