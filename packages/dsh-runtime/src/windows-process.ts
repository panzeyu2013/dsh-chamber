/**
 * Windows process-tree probes for the dsh-runtime installer supervisor
 * (design 21 M2a; design 18 §9.1 — shared pure-Node core, so this module is
 * self-contained and must not import from control-plane or desktop).
 *
 * Sibling-parity note (audit 2026): packages/control-plane/src/win-probes.ts
 * is the control-plane twin of this module (same CIM/taskkill semantics —
 * dsh-runtime stays self-contained and must not import control-plane). Keep
 * behavior identical across both; the Windows CI leg runs both test sets.
 *
 * Parity target: on Unix the supervisor signals the detached install group
 * (TERM→KILL) and treats "group alive" as "writer alive". Windows has no
 * POSIX signals and no process groups, so:
 *   - tree termination = `taskkill /PID <pid> /T /F` (kills pnpm AND its
 *     lifecycle-script descendants in one bounded call);
 *   - a leader that already exited can still have descendants (Windows never
 *     reparents; ParentProcessId stays stale), so residual descendants are
 *     discovered through the CIM process table (`Get-CimInstance
 *     Win32_Process`) and killed individually;
 *   - any probe that cannot prove absence fails closed (reports alive).
 *
 * Pure parsers/classifiers are unit-tested on every CI leg; every exec helper
 * is win32-gated and throws off-platform.
 */

import { spawnSync } from 'node:child_process'

// 30s (2026-09 real-runner finding; sibling parity with win-probes.ts
// WINDOWS_PROBE_TIMEOUT_MS): PowerShell 5.1 first-run + Defender scan on
// fresh windows runners exceeded 10s; the table cache bounds the cost.
const PROBE_TIMEOUT_MS = 30_000
const TABLE_CACHE_TTL_MS = 500

/** One normalized Win32_Process row (pid + stale parent chain only). */
export interface WinProcessRow {
  pid: number
  ppid: number | null
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

// ---------------------------------------------------------------------------
// Pure parsers / builders (unit-tested on every platform)
// ---------------------------------------------------------------------------

/** Parse `ConvertTo-Json` output of a Win32_Process ProcessId/ParentProcessId
 *  projection into normalized rows; unparseable input yields []. */
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
    rows.push({ pid, ppid: toInt(record.ParentProcessId) })
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

/** Descendant pids whose stale ParentProcessId chain reaches `rootPid`
 *  (the root itself is never returned; cycles cannot re-enter it). */
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

/** Classify a taskkill run: exit 0 = signalled; a not-found message with a
 *  non-zero code = gone; anything else = error (never pretend absence). */
export function classifyTaskkill(status: number | null, combined: string): 'signalled' | 'gone' | 'error' {
  if (status === 0) return 'signalled'
  if (/not found|no running instance/i.test(combined)) return 'gone'
  return 'error'
}

/** The read-only, UTF-8-pinned CIM pid/parent table command. */
export function processTableCommand(): string {
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)',
    'ConvertTo-Json -InputObject $rows -Compress',
  ].join('; ')
}

// ---------------------------------------------------------------------------
// Exec helpers (win32-gated)
// ---------------------------------------------------------------------------

/** Full CIM table (briefly cached so 25ms poll loops do not pay one
 *  interpreter start per tick). Throws when unavailable/unparseable. */
export function queryWindowsProcessTable(): WinProcessRow[] {
  assertWindows()
  const now = Date.now()
  if (tableCache !== null && now - tableCache.at < TABLE_CACHE_TTL_MS) return tableCache.rows
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

/** Whether any descendant of `pid` (dead or alive leader) remains. Fail
 *  closed: a probe failure reports true (writer evidence is never erased on
 *  doubt). win32-only. */
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

/** Force-terminate the whole tree rooted at `pid`. Returns true when
 *  something was signalled, false when nothing existed; throws loudly on any
 *  other failure. win32-only. */
export function killWindowsTree(pid: number): boolean {
  assertWindows()
  const { status, stdout, stderr } = execWindowsTool('taskkill.exe', taskkillTreeArgs(pid))
  let outcome = classifyTaskkill(status, `${stdout}\n${stderr}`)
  if (outcome === 'error') {
    // Audit (2026, med): localized taskkill output may miss the English
    // not-found message; verify liveness directly before declaring failure.
    if (!windowsPidExists(pid)) outcome = 'gone'
    else throw new Error(`taskkill tree ${pid} failed`)
  }
  if (outcome === 'signalled') return true
  return false
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

/** Tree kill including residual descendants of an already-dead leader:
 *  taskkill the root tree; when the root is gone, discover descendants
 *  through CIM and kill each. Returns true when anything was signalled,
 *  false when nothing existed; throws loudly on failure (probe failure fails
 *  closed). win32-only. */
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
  for (const childPid of residual) {
    if (killWindowsTree(childPid)) killedAny = true
  }
  return killedAny
}
