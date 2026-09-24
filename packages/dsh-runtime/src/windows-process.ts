/**
 * Windows process-tree probes for the dsh-runtime installer supervisor (shared
 * pure-Node core: self-contained, never imports control-plane or desktop). Sibling
 * parity with packages/control-plane/src/win-probes.ts: same CIM/taskkill semantics,
 * keep behavior identical across both.
 *
 * Unix signals the detached install group (TERM→KILL) and treats "group alive" as
 * "writer alive". Windows has no POSIX signals or process groups: tree termination is
 * `taskkill /PID <pid> /T /F`; a leader that already exited can still have descendants
 * (Windows never reparents; ParentProcessId stays stale), discovered through the CIM
 * table and killed individually; any probe that cannot prove absence fails closed.
 * Pure parsers are unit-tested on every leg; exec helpers are win32-gated.
 */

import { spawnSync } from 'node:child_process'

// 30s (sibling parity with win-probes.ts, compared by the parity test): PowerShell
// 5.1 first-run + Defender scan can exceed 10s; the table cache bounds the cost.
export const PROBE_TIMEOUT_MS = 30_000
export const TABLE_CACHE_TTL_MS = 500

/** One normalized Win32_Process row: pid, stale parent chain and the stable identity
 *  fields a fresh probe must match before a residual pid is terminated. */
export interface WinProcessRow {
  pid: number
  ppid: number | null
  /** Full command line; null when unreadable (e.g. an elevated peer) — a null/empty
   *  command fails closed at the caller. */
  command: string | null
  /** CreationDate; null when absent/unreadable. Pid reuse must never authorize a kill,
   *  so the re-proof prefers this field. */
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
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (res.error !== undefined) throw res.error
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

// Pure parsers / builders (unit-tested on every platform)

/** Parse `ConvertTo-Json` output of a Win32_Process Pid/ParentPid/CommandLine/
 *  CreationDate projection into normalized rows; unparseable input yields []. */
export function parseProcessTable(text: string): WinProcessRow[] {
  if (typeof text !== 'string' || text.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const rows: WinProcessRow[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    const pid = toInt(record.ProcessId)
    if (pid === null) return
    rows.push({
      pid,
      ppid: toInt(record.ParentProcessId),
      command: toScalarString(record.CommandLine),
      createdAt: toScalarString(record.CreationDate),
    })
  }
  visit(parsed)
  return rows
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isInteger(parsed)) return parsed
  }
  return null
}

/** PowerShell ConvertTo-Json renders DateTime as a string (PS 5.1: `\/Date(…)\/`,
 *  PS 7: ISO-8601); anything else is unreadable and null. */
function toScalarString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Descendant pids whose stale ParentProcessId chain reaches `rootPid` (root itself
 *  never returned; cycles cannot re-enter it). */
export function descendantPidsOf(rows: WinProcessRow[], rootPid: number): number[] {
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
      if (child === rootPid || seen.has(child)) continue
      seen.add(child)
      found.push(child)
      stack.push(child)
    }
  }
  return found
}

/** taskkill argv: `/PID <pid> /T /F` — the whole tree in one bounded call. */
export function taskkillTreeArgs(pid: number): string[] {
  return ['/PID', String(pid), '/T', '/F']
}

/** Classify a taskkill run: exit 0 = signalled; a not-found message with a non-zero code
 *  = gone; anything else = error (never pretend absence). */
export function classifyTaskkill(status: number | null, combined: string): 'signalled' | 'gone' | 'error' {
  if (status === 0) return 'signalled'
  if (/not found|no running instance/i.test(combined)) return 'gone'
  return 'error'
}

/** The read-only, UTF-8-pinned CIM pid/parent/identity table command. */
export function processTableCommand(): string {
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate)',
    'ConvertTo-Json -InputObject $rows -Compress',
  ].join('; ')
}

// Exec helpers (win32-gated)

/** Full CIM table (briefly cached so 25ms poll loops do not pay one interpreter start
 *  per tick); throws when unavailable/unparseable. */
export function queryWindowsProcessTable(): WinProcessRow[] {
  assertWindows()
  const now = Date.now()
  if (tableCache !== null && now - tableCache.at < TABLE_CACHE_TTL_MS) return tableCache.rows
  return probeWindowsProcessTable()
}

/** Force a fresh CIM probe, bypassing the TTL cache: a pid identity must be re-proved
 *  from current state, never from the scan that found it. */
function queryWindowsProcessTableFresh(): WinProcessRow[] {
  assertWindows()
  return probeWindowsProcessTable()
}

function probeWindowsProcessTable(): WinProcessRow[] {
  const { status, stdout, stderr } = execWindowsTool('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    processTableCommand(),
  ])
  const rows = status === 0 ? parseProcessTable(stdout) : []
  if (rows.length === 0) {
    throw new Error(`windows CIM process table unavailable (exit ${String(status)}): ${stderr.trim().slice(0, 512) || 'empty output'}`)
  }
  tableCache = { at: Date.now(), rows }
  return rows
}

let tableCache: { at: number; rows: WinProcessRow[] } | null = null

/** Verdict of re-proving one scanned residual pid against a fresh table. */
export type CimIdentityVerdict = 'match' | 'mismatch' | 'unprovable'

/**
 * Re-prove that `current` is still the process `original` described (same rule as the
 * control-plane twin): pid reuse makes ProcessId alone insufficient, so the stable
 * CreationDate (or, when unreadable on either side, the full command line) must match. A
 * different value and a missing row are 'mismatch' (never kill); an identity no shared
 * field can prove is 'unprovable' and the caller fails closed.
 */
export function cimRowStillIdentifies(original: WinProcessRow, current: WinProcessRow | null): CimIdentityVerdict {
  if (current === null || current.pid !== original.pid) return 'mismatch'
  if (original.createdAt !== null && current.createdAt !== null) {
    return original.createdAt === current.createdAt ? 'match' : 'mismatch'
  }
  if (original.command !== null && current.command !== null) {
    return original.command === current.command ? 'match' : 'mismatch'
  }
  return 'unprovable'
}

/** Whether any descendant of `pid` (dead or alive leader) remains. Fail closed: a
 *  probe failure reports true (writer evidence is never erased on doubt). win32-only. */
export function hasWindowsDescendants(pid: number): boolean {
  assertWindows()
  let rows: WinProcessRow[]
  try {
    rows = queryWindowsProcessTable()
  } catch {
    return true
  }
  return descendantPidsOf(rows, pid).length > 0
}

/** Force-terminate the whole tree rooted at `pid`: true when something was signalled,
 *  false when nothing existed, throws loudly otherwise. win32-only. */
export function killWindowsTree(pid: number): boolean {
  assertWindows()
  const { status, stdout, stderr } = execWindowsTool('taskkill.exe', taskkillTreeArgs(pid))
  let outcome = classifyTaskkill(status, `${stdout}\n${stderr}`)
  if (outcome === 'error') {
    // Localized taskkill output may miss the English not-found message; verify liveness
    // directly before declaring failure.
    if (!windowsPidExists(pid)) outcome = 'gone'
    else throw new Error(`taskkill tree ${pid} failed`)
  }
  if (outcome === 'signalled') return true
  return false
}

/** kill(0)-style liveness; EPERM counts as alive, only ESRCH is absence. Residual
 *  (sibling parity): an OpenProcess probe can read a terminated-but-held process object as
 *  alive, so it only classifies a non-zero taskkill result; quiescence proofs consult CIM. */
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

/** Tree kill including residual descendants of an already-dead leader: taskkill the root
 *  tree; when the root is gone, discover descendants through CIM, re-prove each scanned
 *  pid's identity against a FRESH table (pid reuse must never authorize a kill) and kill
 *  the matches. True when anything was signalled, false when nothing existed; probe
 *  failure throws (fails closed). win32-only. */
export function killWindowsTreeWithResidual(pid: number): boolean {
  assertWindows()
  if (killWindowsTree(pid)) return true
  let rows: WinProcessRow[]
  try {
    rows = queryWindowsProcessTable()
  } catch (error) {
    throw new Error(`taskkill tree ${pid}: leader gone but residual probe unavailable: ${String(error)}`)
  }
  const residual = descendantPidsOf(rows, pid)
  let killedAny = false
  if (residual.length > 0) {
    // Pids are recycled: re-probe the table (bypassing the cache) immediately before
    // terminating and kill only rows that still carry the scanned identity; an unprovable
    // identity throws instead of terminating on doubt.
    const scanned = new Map(rows.map(row => [row.pid, row]))
    let fresh: Map<number, WinProcessRow>
    try {
      fresh = new Map(queryWindowsProcessTableFresh().map(row => [row.pid, row]))
    } catch (error) {
      throw new Error(`taskkill tree ${pid}: residual identity probe unavailable: ${String(error)}`)
    }
    for (const childPid of residual) {
      const verdict = cimRowStillIdentifies(scanned.get(childPid) as WinProcessRow, fresh.get(childPid) ?? null)
      if (verdict === 'mismatch') continue
      if (verdict === 'unprovable') {
        throw new Error(`taskkill residual ${childPid} (tree ${pid}): identity cannot be re-established; refusing to terminate`)
      }
      if (killWindowsTree(childPid)) killedAny = true
    }
  }
  return killedAny
}
