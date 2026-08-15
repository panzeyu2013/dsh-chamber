/**
 * Orphan reaper for managed dsh hosts.
 *
 * Design: docs/design/02-host-management-deployment.md §3.4.2 (reaper 判定序列)
 * with §3.4.1 (记录文件格式). Direct port of the reference implementation's
 * managed-process-registry safety model: a spawn record is only reclaimed when
 * all of "we recorded it", "identity re-verified (command line + port
 * listener)", and "orphaned (reparented to init or owner dead)" hold; any
 * doubt keeps the record and the process untouched. Corrupt records and
 * records whose pid is not an integer are deleted without killing. Claim
 * records (claim-*.json) are v2-era external-takeover records — the
 * external-claim module was deleted with the thin-shell architecture (01
 * §4/§5), so nothing writes claims in v4; they are never killed, only
 * removed once their recorded owner is dead. Run once at control-plane
 * startup, before spawning hosts.
 */

import { readdir, readFile, readlink, unlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { Logger } from './types.ts'

const TERM_WAIT_MS = 1500
const TERM_POLL_MS = 100

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Signal the whole process group of a managed dsh host (design 02 §3.4.2:
 * "进程组 SIGTERM → 轮询 1.5s → SIGKILL" — spawn-dsh's terminateChild does
 * the same group kill). A group can be absent even while the pid is alive
 * (pid not a group leader, or the leader already reparented) — fall back to
 * the single pid then. Returns false when nothing was signalled (gone).
 */
function signal(pid: number, sig: NodeJS.Signals): boolean {
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

function psIdentity(pid: number): { ppid: string; command: string } {
  const res = spawnSync('ps', ['-p', String(pid), '-o', 'ppid=,command='], { encoding: 'utf8' })
  if (res.error) throw res.error
  if (res.status !== 0) throw new Error(`ps exited ${res.status} for pid ${pid}`)
  const line = res.stdout.split('\n').find(l => l.trim() !== '')
  if (!line) throw new Error(`ps produced no output for pid ${pid}`)
  const tokens = line.trim().split(/\s+/)
  return { ppid: tokens[0], command: tokens.slice(1).join(' ') }
}

function lsofPort(pid: number, port: number): boolean | null {
  const res = spawnSync('lsof', ['-iTCP:' + String(port), '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
  if (res.error) return null
  return res.stdout.split(/\s+/).filter(Boolean).includes(String(pid))
}

function ssPort(pid: number, port: number): boolean | null {
  const res = spawnSync('ss', ['-ltnp'], { encoding: 'utf8' })
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

async function procPort(pid: number, port: number): Promise<boolean | null> {
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

async function portOwnedBy(pid: number, port: number): Promise<boolean> {
  let verdict: boolean | null = lsofPort(pid, port)
  if (verdict === null) verdict = ssPort(pid, port)
  if (verdict === null) verdict = await procPort(pid, port)
  return verdict === null ? true : verdict
}

async function killAndConfirm(pid: number): Promise<void> {
  if (!signal(pid, 'SIGTERM')) return
  let deadline = Date.now() + TERM_WAIT_MS
  while (Date.now() < deadline) {
    await sleep(TERM_POLL_MS)
    if (!alive(pid)) return
  }
  if (!signal(pid, 'SIGKILL')) return
  deadline = Date.now() + TERM_WAIT_MS
  while (Date.now() < deadline) {
    await sleep(TERM_POLL_MS)
    if (!alive(pid)) return
  }
  throw new Error(`pid ${pid} still alive after SIGTERM + SIGKILL`)
}

async function removeFile(file: string): Promise<void> {
  try {
    await unlink(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** One entry's verdict: reclaimed (killed), kept (left in place), removed. */
type EntryStatus = 'reclaimed' | 'kept' | 'removed'

type LogFn = (message: string) => void

async function processEntry(dir: string, name: string, log: LogFn): Promise<{ status: EntryStatus }> {
  const file = join(dir, name)
  const label = name.slice(0, -5)
  let record: any
  try {
    record = JSON.parse(await readFile(file, 'utf8'))
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
    await removeFile(file)
    log(`reaper: ${label} corrupt record removed (${String(error)})`)
    return { status: 'removed' }
  }
  if (name.startsWith('claim-')) {
    const ownerPid = Number.isInteger(record.ownerPid) ? record.ownerPid : null
    if (ownerPid !== null && alive(ownerPid)) {
      log(`reaper: ${label} claim owner ${ownerPid} alive; kept`)
      return { status: 'kept' }
    }
    await removeFile(file)
    log(`reaper: ${label} claim owner ${String(ownerPid)} dead; claim removed`)
    return { status: 'removed' }
  }
  const pid = record.pid
  if (!Number.isInteger(pid) || pid <= 0) {
    await removeFile(file)
    log(`reaper: ${label} non-integer pid; record removed`)
    return { status: 'removed' }
  }
  if (!alive(pid)) {
    await removeFile(file)
    log(`reaper: ${pid} dead; record removed`)
    return { status: 'removed' }
  }
  const identity = psIdentity(pid)
  const profile = typeof record.profile === 'string' && record.profile !== '' ? record.profile : null
  const commandOk = profile === null
    ? identity.command.includes('dsh')
    : identity.command.includes('dsh') && identity.command.includes(`--profile ${profile}`)
  const portNum = Number(record.port)
  const portOk = Number.isInteger(portNum) && portNum > 0 ? await portOwnedBy(pid, portNum) : true
  if (!commandOk || !portOk) {
    log(`reaper: ${pid} identity mismatch (command='${identity.command}'); record kept`)
    return { status: 'kept' }
  }
  const ownerPid = Number.isInteger(record.ownerPid) ? record.ownerPid : null
  const orphan = identity.ppid === '1' || (ownerPid !== null && !alive(ownerPid))
  if (!orphan) {
    log(`reaper: ${pid} owner ${String(ownerPid)} alive (ppid ${identity.ppid}); record kept`)
    return { status: 'kept' }
  }
  log(`reaper: ${pid} orphan; SIGTERM`)
  await killAndConfirm(pid)
  await removeFile(file)
  log(`reaper: ${pid} exited; record removed`)
  return { status: 'reclaimed' }
}

/**
 * Scan <stateDir>/managed-dsh and reclaim orphaned managed dsh hosts per
 * design 02 §3.4.2. Safe under concurrent control-plane instances: entries
 * whose owner is still alive are never touched.
 * @param options - {stateDir, logger}.
 * @returns {reclaimed, kept, errors} — reclaimed: killed spawn records;
 * kept: records left in place (alive owner, identity mismatch, …); errors:
 * per-entry failures (files left in place).
 */
export interface ReaperResult {
  reclaimed: number
  kept: number
  errors: string[]
}

export async function runReaper({ stateDir, logger }: { stateDir: string; logger?: Logger }): Promise<ReaperResult> {
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
      const outcome = await processEntry(dir, name, log)
      if (outcome.status === 'reclaimed') reclaimed++
      else if (outcome.status === 'kept') kept++
    } catch (error) {
      errors.push(`reaper: ${name}: ${String(error)}`)
      kept++
    }
  }
  return { reclaimed, kept, errors }
}
