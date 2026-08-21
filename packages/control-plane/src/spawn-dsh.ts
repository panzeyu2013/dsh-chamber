/**
 * Web-profile dsh spawn + process lifecycle for the control plane.
 *
 * v4 (connection-manager shape, design 02 §3.1): the local host is dsh's
 * built-in web profile — no slim-profile directory, no glue plugin. The base
 * command line is:
 *
 *   dsh --profile web --host 127.0.0.1 --port <P> --trusted-host 127.0.0.1:<P>
 *
 * An optional chamber-owned `--patch <path>` overlay (design 09 方案 A module B,
 * host-graph-seed.ts) is inserted right after `--profile web` when the plane
 * has seeded one: it mounts the chamber host package that exposes the host
 * boot graph (`clientModules.graph()`), the channel the chamber frontend uses
 * to load extra client plugins at runtime. The flag must precede the web
 * app's own flags (--host/--port/--trusted-host) — the dsh launcher passes
 * everything after its recognized flags through to the booted app verbatim
 * (@deepseek-ai/dsh args.ts).
 *
 * The browser trust fence (--trusted-host) admits requests whose Host header
 * is the instance's own 127.0.0.1:<P> — exactly what the per-instance reverse
 * proxy (design 03 §3.1) forwards.
 *
 * Port strategy: fixed base 17510, one attempt per port; a failed attempt
 * (process exit within 15s, or no TCP listener within 90s, or a failed
 * host.describe probe) advances port+1 and respawns, at most 5 attempts.
 * Spawn uses detached=true (own process group, design 02 §3.5.5: the host
 * survives a control-plane crash and the orphan reaper reclaims it, §3.4.2);
 * stdout/stderr are forwarded to the control-plane log and the per-port
 * rolling log. The node executable is resolved, not assumed on PATH
 * (resolveNodeExecutable: plain node → process.execPath; Electron main →
 * process.execPath + ELECTRON_RUN_AS_NODE=1 + --expose-internals; PATH/
 * known-root fallbacks) — a GUI-launched packaged app has a minimal PATH
 *  and `spawn('node', …)` would fail with ENOENT. The spawned environment
 *  is pinned (design 02 §3.2.1):
 *  DSH_TELEMETRY_DISABLED=1, DSH_PERMISSION_MODE=workspace-write, and
 *  SSH_CONNECTION=<loopback tuple> — the chamber-managed host is a local
 *  web profile whose directory-picker-auto (host/directory-picker-auto)
 *  resolves `browse` only when an SSH-launch marker is present (or the bind
 *  is non-loopback). The pin makes the managed host always serve the
 *  in-app `browse` interaction (host.listDirectory / host.createDirectory)
 *  so every instance — local and remote alike — uses the same in-app
 *  directory dialog (design 05 §4; the OS chooser is never surfaced to
 *  chamber users). Only directory-picker-auto reads SSH_CONNECTION in the
 *  dsh source (verified against the pinned harness commit b150a551… / dsh
 *  0.1.1-rc.2, where directory-picker-auto still reads it); `bundle/web-app` also probes SSH_CONNECTION/SSH_TTY via `launchedThroughSsh` (browser auto-open suppression — pre-existing at rc.8, harmless for chamber's own window), so the pin has no
 *  other effect.
 *  A pid
 *  record per design 02 §3.4.1 (pid/ownerPid/ownerInstanceId/port/binary/
 *  profile:'web'/source/startedAt) is atomically written under
 *  <stateDir>/managed-dsh/<pid>.json and cleaned up on exit.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, readFileSync, renameSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { call, RpcBusinessError } from './dsh-client.ts'
import { createHostLogWriter } from './host-logs.ts'
import type { Logger } from './types.ts'

/** First port attempted for a managed dsh host. */
export const BASE_DHSPORT = 17510

/**
 * Grace window between SIGTERM and SIGKILL when stopping a managed host
 * (design 02 §3.7). Kept short so app quit is fast: the host persists
 * session JSONL continuously, so a 1s window flushes the tail and a SIGKILL
 * then releases the port/fds deterministically — the "fast exit" half of the
 * speed-vs-reclamation balance.
 */
export const TERMINATE_GRACE_MS = 1_000

/** Maximum spawn attempts (port +1 per retry). */
export const MAX_SPAWN_ATTEMPTS = 5

/** A child that exits this quickly is treated as a failed attempt. */
export const EARLY_EXIT_GRACE_MS = 15_000

/** How long a spawned host gets to open its TCP listener. */
export const LISTEN_WAIT_MS = 90_000

/** The fixed web-profile flag set (design 02 §3.1/§3.5); --trusted-host and
 * --port always agree (127.0.0.1:<P>) so the trust fence and the forwarded
 * Host header never diverge. When `patchPath` is non-empty, `--patch <path>`
 * (the dsh launcher's repeatable overlay flag) is inserted right after
 * `--profile web` — it must precede the web app's own flags, which the
 * launcher passes through verbatim (see the module header). */
export function webProfileArgs(port: number, patchPath?: string): string[] {
  const base = ['--profile', 'web', '--host', '127.0.0.1', '--port', String(port), '--trusted-host', `127.0.0.1:${port}`]
  if (patchPath === undefined || patchPath === '') return base
  return ['--profile', 'web', '--patch', patchPath, '--host', '127.0.0.1', '--port', String(port), '--trusted-host', `127.0.0.1:${port}`]
}

/**
 * The managed-dsh pid record shape (design 02 §3.4.1), written atomically
 * under <stateDir>/managed-dsh/<pid>.json by writePidRecord. Extra fields
 * (e.g. ownerInstanceId) are appended; the fixed columns are always present.
 */
export interface PidRecord {
  pid: number
  ownerPid: number
  port: number
  binary: string
  profile: string
  source: string
  startedAt: string
  ownerInstanceId?: string
}

/**
 * Write the managed-dsh pid record for a spawned child (design 02 §3.4.1).
 * The write is atomic (tmp + rename). Caller-compatible: extra fields
 * (e.g. ownerInstanceId from the control-plane instance identity, §3.6.1)
 * are appended; the fixed columns are always present.
 * @param stateDir - the control plane state root.
 * @param pid - the child's pid.
 * @param port - the port the child was asked to serve.
 * @param ownerPid - the control plane process pid.
 * @param extra - optional extra record fields (ownerInstanceId, …).
 */
export function writePidRecord(stateDir: string, pid: number, port: number, ownerPid: number, extra: Record<string, unknown> = {}): void {
  const dir = join(stateDir, 'managed-dsh')
  mkdirSync(dir, { recursive: true })
  const record = {
    pid,
    ownerPid,
    ...extra,
    port,
    binary: 'dsh',
    profile: 'web',
    source: 'spawn',
    startedAt: new Date().toISOString(),
  }
  atomicWriteJson(join(dir, `${pid}.json`), record)
}

/** Remove the managed-dsh pid record of a child that has exited. */
export function removePidRecord(stateDir: string, pid: number): void {
  try {
    rmSync(join(stateDir, 'managed-dsh', `${pid}.json`))
  } catch { /* already gone */ }
}

/** Best-effort control-plane instance id (<stateDir>/instance-id, design 02 §3.6.1). */
function readInstanceId(stateDir: string): string | null {
  try {
    const value = readFileSync(join(stateDir, 'instance-id'), 'utf8').trim()
    return value === '' ? null : value
  } catch {
    return null
  }
}

/**
 * Resolve the dsh CLI entry for a workspace, preferring the installed
 * artifact over the source checkout (runtime differences are intentional:
 * packaged runtimes ship the published @deepseek-ai/dsh npm package, dev
 * workspaces run the ref-dsh source tree — the tsx fallback is dev-only).
 * The web-profile flags ride the entry either way (design 02 §3.1).
 * @param dshWorkspacePath - the dsh installation root (cwd of the spawned process).
 * @param port - the port the host is asked to serve.
 * @param patchPath - optional `--patch` overlay (design 09 module B); null/absent when none.
 * @returns {args} node arguments to spawn.
 */
function resolveDshEntry(dshWorkspacePath: string, port: number, patchPath?: string | null): { args: string[] } {
  const profileFlags = webProfileArgs(port, patchPath ?? undefined)
  const installed = join(dshWorkspacePath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(installed)) {
    return { args: [installed, ...profileFlags] }
  }
  const source = join(dshWorkspacePath, 'apps', 'cli', 'src', 'bin.ts')
  if (existsSync(source)) {
    return { args: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...profileFlags] }
  }
  throw new Error(`no dsh CLI entry found in ${dshWorkspacePath} (neither node_modules/@deepseek-ai/dsh/lib/bin.js nor apps/cli/src/bin.ts)`)
}

/**
 * One spawn attempt: launch the child with the web-profile flags for `port`
 * and wait for readiness (TCP listener, then a successful host.describe
 * probe). The child is the dsh process itself — spawned directly, never via
 * a pnpm wrapper, so there is no grandchild to orphan when we terminate.
 */
interface SpawnAttemptOptions {
  dshHome: string
  stateDir: string
  dshWorkspacePath: string
  port: number
  logger: Logger
  /** Optional `--patch` overlay passed to the dsh launcher (design 09 module B). */
  patchPath?: string | null
  signal?: AbortSignal
}

/**
 * Resolve the node executable that runs the dsh CLI entry (the host is
 * spawned directly, never via a pnpm wrapper). The control plane may run
 * under plain node (standalone serve, tests) or inside the Electron main
 * process (desktop): a Finder-launched packaged app gets a minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), so `spawn('node', …)` fails with
 * ENOENT. Resolution order:
 * - Electron (`process.versions.electron` set) → `process.execPath` plus
 *   `ELECTRON_RUN_AS_NODE=1` (Electron's documented production mechanism:
 *   the app binary starts as a normal node process; requires the
 *   `runAsNode` fuse, which electron-builder leaves enabled by default —
 *   the fuse must stay enabled). `--expose-internals` is prepended:
 *   dsh's loader resolves `internal/modules/esm/loader` via
 *   `node-addon-require-builtin`, whose V8-embedder probing does not work
 *   under Electron's patched Node ("no compatible
 *   GetAlignedPointerFromEmbedderData symbol"), while the documented
 *   `--expose-internals` require path does.
 * - plain node → `process.execPath` (the running node binary; the
 *   require-builtin addon path works there).
 * - fallback: `node` resolved from PATH, then well-known install roots,
 *   then the bare name (last-resort, preserves the historic behavior).
 * @returns {file} the node executable, the node args to prepend to the
 * CLI entry, and the extra env entries (only the Electron case adds
 * ELECTRON_RUN_AS_NODE).
 */
export function resolveNodeExecutable(): { file: string; args: string[]; env: Record<string, string> } {
  if (process.versions.electron !== undefined) {
    return { file: process.execPath, args: ['--expose-internals'], env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  const execPathName = basename(process.execPath).toLowerCase()
  if (execPathName === 'node' || execPathName === 'node.exe') {
    return { file: process.execPath, args: [], env: {} }
  }
  const fromPath = searchPathForNode()
  if (fromPath !== null) return { file: fromPath, args: [], env: {} }
  const known = KNOWN_NODE_LOCATIONS.find(candidate => existsSync(candidate))
  if (known !== undefined) return { file: known, args: [], env: {} }
  return { file: 'node', args: [], env: {} }
}

/** Locate a `node` executable by scanning PATH (first match wins). */
function searchPathForNode(): string | null {
  const isWin = process.platform === 'win32'
  const names = isWin ? ['node.exe'] : ['node']
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir === '') continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Well-known node install roots used as a fallback when PATH has no node. */
const KNOWN_NODE_LOCATIONS = [
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
  '/usr/bin/node',
  join(homedir(), '.nvm', 'current', 'bin', 'node'),
  join(homedir(), '.volta', 'bin', 'node'),
  join(homedir(), '.fnm', 'aliases', 'default', 'bin', 'node'),
]

/** A ready spawned child and the wire facts about it. */
interface SpawnAttemptResult {
  child: ChildProcess
  port: number
  baseUrl: string
}

async function spawnAttempt({ dshHome, stateDir, dshWorkspacePath, port, logger, patchPath, signal }: SpawnAttemptOptions): Promise<SpawnAttemptResult> {
  const baseUrl = `http://127.0.0.1:${port}`
  const log = (line: string) => logger.log(`[dsh:${port}] ${line}`)
  // Per-port rolling log (design 02 §3.8 / host-logs.ts): stdout/stderr go
  // to the control-plane log AND to <stateDir>/host-logs/<port>.log (JSONL)
  // so GET /api/host/logs can serve the recent lines without re-spawning.
  const hostLog = createHostLogWriter(stateDir, port)
  const entry = resolveDshEntry(dshWorkspacePath, port, patchPath)
  // The node executable is resolved, never assumed on PATH: the control
  // plane may run inside the Electron main process, where a GUI-launched
  // app has a minimal PATH (design 02 §3.1 — resolveNodeExecutable).
  const nodeExec = resolveNodeExecutable()
  const child = spawn(nodeExec.file, [...nodeExec.args, ...entry.args], {
    cwd: dshWorkspacePath,
    // Deterministic, privacy-pinned environment (design 02 §3.2.1);
    // the Electron branch additionally injects ELECTRON_RUN_AS_NODE=1
    // so the app binary runs the CLI as a plain node process.
    // SSH_CONNECTION is the browse-interaction pin (see the module header):
    // the host's directory-picker-auto resolves `browse` under an
    // SSH-launch marker, so the managed host serves host.listDirectory /
    // host.createDirectory — one in-app dialog for every instance.
    env: {
      ...process.env,
      ...nodeExec.env,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'workspace-write',
      SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group: the host outlives a control-plane crash and the
    // orphan reaper (design 02 §3.4.2) reclaims it.
    detached: true,
  })
  const pid = child.pid
  if (pid === undefined) {
    child.kill('SIGKILL')
    throw new Error(`dsh spawn on port ${port} produced no pid`)
  }
  child.stdout.on('data', chunk => {
    const line = String(chunk).trimEnd()
    log(line)
    hostLog.write(line, 'stdout')
  })
  child.stderr.on('data', chunk => {
    const line = String(chunk).trimEnd()
    log(line)
    hostLog.write(line, 'stderr')
  })
  child.once('exit', () => hostLog.close())
  const instanceId = readInstanceId(stateDir)
  writePidRecord(stateDir, pid, port, process.pid, instanceId === null ? {} : { ownerInstanceId: instanceId })

  let timer: ReturnType<typeof setTimeout> | undefined
  let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  let onAbort: (() => void) | undefined
  const outcome = await new Promise<string>(resolve => {
    timer = setTimeout(() => resolve('timeout'), LISTEN_WAIT_MS)
    onExit = (code, sig) => resolve(`exit(${code ?? sig})`)
    child.once('exit', onExit)
    onAbort = () => resolve('aborted')
    signal?.addEventListener('abort', onAbort, { once: true })
    const probe = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve('tcp')
      })
      socket.once('error', () => {
        socket.destroy()
        setTimeout(probe, 250)
      })
    }
    probe()
  }).finally(() => {
    clearTimeout(timer)
    if (onExit !== undefined) child.removeListener('exit', onExit)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  })
  if (outcome !== 'tcp') {
    child.kill('SIGKILL')
    removePidRecord(stateDir, pid)
    throw new Error(`dsh spawn attempt on port ${port} failed: ${outcome} before TCP listen`)
  }
  // The TCP listener comes up before the connection plugin's /api routes are
  // mounted; describe can 404 briefly. Retry the probe until it succeeds or
  // the listen window expires.
  const controller = new AbortController()
  const probeTimer = setTimeout(() => controller.abort(), LISTEN_WAIT_MS)
  let lastProbeError: unknown
  try {
    for (;;) {
      if (controller.signal.aborted) throw lastProbeError ?? new Error('probe window expired')
      try {
        await call(baseUrl, 'host.describe', {}, { signal: controller.signal })
        break
      } catch (probeError) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`dsh spawn attempt on port ${port} failed: child exited: ${String(probeError)}`)
        }
        lastProbeError = probeError
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
  } catch (error) {
    clearTimeout(probeTimer)
    child.kill('SIGKILL')
    removePidRecord(stateDir, pid)
    throw new Error(`dsh spawn attempt on port ${port} failed: host.describe: ${String(error)}`)
  }
  clearTimeout(probeTimer)
  // Best-effort browse-capability probe (design 05 §4): the in-app directory
  // dialog needs the host to serve `browse`. A native-capability host — a
  // dsh version predating the SSH_CONNECTION resolver arm, or a deployment
  // that overrides the spawn env — answers `directory-picker-unavailable`:
  // loud in the log instead of a silent dialog failure. Never fails the
  // spawn (the host is otherwise healthy); other failures are ignored.
  try {
    await call(baseUrl, 'host.listDirectory', {}, { timeoutMs: 10_000 })
  } catch (probeError) {
    if (probeError instanceof RpcBusinessError && probeError.code === 'directory-picker-unavailable') {
      logger.warn(
        `[dsh:${port}] host serves the native directory picker — the in-app directory dialog (design 05 §4) will fail; `
        + 'expected when the dsh version predates the SSH_CONNECTION resolver arm or the spawn env was overridden',
      )
    }
  }
  return { child, port, baseUrl }
}

/** Signal the whole process group of a detached child; fall back to the pid. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch { /* already gone */ }
  }
}

/** Stop a managed child: process-group SIGTERM, escalate to SIGKILL after
 * TERMINATE_GRACE_MS (1s — the fast-exit half of the speed-vs-reclamation balance). */
async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  if (pid === undefined) return
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  killGroup(pid, 'SIGTERM')
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) killGroup(pid, 'SIGKILL')
  }, TERMINATE_GRACE_MS)
  await exited
  clearTimeout(timer)
}

/** Options for spawnDsh. */
export interface SpawnDshOptions {
  stateDir: string
  dshHome: string
  dshWorkspacePath: string
  logger: Logger
  /** Optional `--patch` overlay passed to the dsh launcher (design 09 module B). */
  patchPath?: string | null
  signal?: AbortSignal
}

/** The ready host surface returned by spawnDsh. */
export interface SpawnedHost {
  child: ChildProcess
  port: number
  baseUrl: string
  stop(): Promise<void>
}

/**
 * Spawn a ready dsh host on a free port from BASE_DHSPORT upward.
 * @param options - {stateDir, dshHome, dshWorkspacePath, logger, patchPath?,
 *   signal}.
 * @returns {child, port, baseUrl, stop()}.
 */
export async function spawnDsh({ stateDir, dshHome, dshWorkspacePath, logger, patchPath, signal }: SpawnDshOptions): Promise<SpawnedHost> {
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_SPAWN_ATTEMPTS; attempt++) {
    const port = BASE_DHSPORT + attempt
    if (signal?.aborted) throw new Error('spawn aborted')
    // Port pre-check: skip a port that is already taken (a stray process from
    // an earlier run would otherwise make this attempt die with EADDRINUSE).
    const busy = await new Promise<boolean>(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
    })
    if (busy) {
      logger.log(`port ${port} already in use; skipping`)
      continue
    }
    try {
      const spawned = await spawnAttempt({ dshHome, stateDir, dshWorkspacePath, port, logger, patchPath, signal })
      return {
        ...spawned,
        stop: async () => {
          await terminateChild(spawned.child)
          const pid = spawned.child.pid
          if (pid !== undefined) removePidRecord(stateDir, pid)
        },
      }
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      logger.log(`spawn attempt ${attempt + 1}/${MAX_SPAWN_ATTEMPTS} on port ${port} failed: ${message}`)
    }
  }
  throw new Error(`dsh failed to start after ${MAX_SPAWN_ATTEMPTS} attempts: ${String(lastError)}`)
}

/** Read a managed-dsh pid record; null when absent or corrupt. */
export function readPidRecord(stateDir: string, pid: number): PidRecord | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, 'managed-dsh', `${pid}.json`), 'utf8')) as PidRecord
  } catch {
    return null
  }
}

/** Atomic JSON write (tmp + rename): catalog/pid durability without partial files. */
export function atomicWriteJson(path: string, value: unknown): void {
  const tmp = `${path}.${randomUUID()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, undefined, 2)}\n`)
  renameSync(tmp, path)
}
