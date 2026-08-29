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
 * Port strategy: fixed base DEFAULT_DSH_START_PORT (17510), one attempt per
 * port; a failed attempt (process exit, or no TCP listener within 90s, or a
 * failed host.describe probe) advances port+1 and respawns, at most 5 attempts.
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
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createConnection } from 'node:net'
import { call, RpcBusinessError } from './dsh-client.ts'
import { createHostLogWriter } from './host-logs.ts'
import type { Logger } from './types.ts'

/**
 * Default first port attempted for a managed local dsh host (the local
 * instance start port baseline; spawns advance +1 per retry). Distant from
 * DEFAULT_CONTROL_PLANE_PORT (17500) so the two surfaces never collide.
 */
export const DEFAULT_DSH_START_PORT = 17510

/** Gateway credentials belong to the outer authenticated boundary and must
 * never become ambient authority inside the managed dsh or its tools/plugins.
 * Keep this exported pure helper covered without spawning a process. */
export function sanitizeManagedDshEnv(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output = { ...input }
  for (const name of Object.keys(output)) {
    // Windows environment names are case-insensitive even though enumeration
    // preserves spelling. Strip case-insensitively so a lower/mixed-case
    // credential that configured the parent cannot survive into the child.
    if (name.toUpperCase().startsWith('DSH_GATEWAY_')) delete output[name]
  }
  return output
}

/** First port attempted for a managed dsh host (desktop/local default). */
export const BASE_DHSPORT = DEFAULT_DSH_START_PORT

/**
 * Validate a dsh port base: a positive integer in the port range. The base is
 * the first port attempted for a managed dsh host; spawn attempts walk upward
 * (base, base+1, …). Server gateway deployments override it via
 * `--dsh-port` / `DSH_GATEWAY_DSH_PORT` (design 17 §3; the installer wizard
 * defaults to 30800 so the gateway occupies 30801 next to the managed dsh).
 */
export function isDshPortBaseValid(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535
}

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

/** How long a spawned host gets to open its TCP listener. */
export const LISTEN_WAIT_MS = 90_000

/** Bound every loopback connect attempt so startup and shutdown cannot hang
 * behind a socket that neither connects nor errors (for example, a local
 * firewall rule that drops packets instead of rejecting them). */
export const PORT_PROBE_TIMEOUT_MS = 1_000

/**
 * Per-pipe-event input ceiling. Child stdout/stderr arrives as Buffer objects;
 * slice those bytes before decoding so one hostile/buggy write cannot first
 * allocate an unbounded string in both the control-plane logger and host-log
 * JSON encoder. 64 KiB also leaves ample room below host-logs' 512 KiB
 * encoded-entry admission ceiling for worst-case JSON escaping.
 */
export const MAX_CHILD_OUTPUT_CHUNK_BYTES = 64 * 1024
const CHILD_OUTPUT_TRUNCATION_MARKER = '\n...[output chunk truncated]'

/** Format one child-pipe chunk once for both logger and rolling-log sinks. */
export function formatChildOutputChunk(chunk: Buffer): string {
  if (chunk.byteLength <= MAX_CHILD_OUTPUT_CHUNK_BYTES) return chunk.toString('utf8').trimEnd()
  const markerBytes = Buffer.byteLength(CHILD_OUTPUT_TRUNCATION_MARKER)
  const retainedBytes = Math.max(0, MAX_CHILD_OUTPUT_CHUNK_BYTES - markerBytes)
  return `${chunk.subarray(0, retainedBytes).toString('utf8').trimEnd()}${CHILD_OUTPUT_TRUNCATION_MARKER}`
}

/** A retry delay that wakes immediately when its lifecycle is cancelled. */
function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    const onAbort = () => done()
    signal.addEventListener('abort', onAbort, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
  })
}

interface PortProbeSocket {
  once(event: 'connect', listener: () => void): this
  once(event: 'error', listener: (error: Error) => void): this
  removeListener(event: 'connect', listener: () => void): this
  removeListener(event: 'error', listener: (error: Error) => void): this
  destroy(): this
}

type PortProbeConnect = (options: { host: string; port: number }) => PortProbeSocket

/**
 * Check whether a candidate loopback port is occupied. A connect timeout is
 * treated conservatively as busy: an inconclusive probe must not launch a
 * detached host on a port whose ownership is unknown. Abort always wins and
 * destroys the in-flight socket so LocalHostManager.stop() can settle.
 */
export function probePortBusy(
  port: number,
  signal?: AbortSignal,
  timeoutMs = PORT_PROBE_TIMEOUT_MS,
  connect: PortProbeConnect = options => createConnection(options),
): Promise<boolean> {
  if (signal?.aborted) return Promise.reject(new Error('spawn aborted'))
  return new Promise<boolean>((resolve, reject) => {
    let socket: PortProbeSocket | undefined
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (socket !== undefined) {
        socket.removeListener('connect', onConnect)
        socket.removeListener('error', onError)
        socket.destroy()
      }
    }
    const finish = (busy: boolean, error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error === undefined) resolve(busy)
      else reject(error)
    }
    const onConnect = () => finish(true)
    const onError = () => finish(false)
    const onAbort = () => finish(false, new Error('spawn aborted'))
    signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish(true), timeoutMs)
    try {
      socket = connect({ host: '127.0.0.1', port })
      socket.once('connect', onConnect)
      socket.once('error', onError)
    } catch (error) {
      finish(false, error instanceof Error ? error : new Error(String(error)))
    }
  })
}

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
  /** The spawned entry token (argv0 / source script path); reaper identity
   * re-verification matches the live command against it. */
  entry?: string
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
 * @param entryPath - the spawned entry token (argv0 for installed layouts,
 *   the script path for the dev-tree source layout). The reaper re-verifies
 *   the live process against this token; without it the source layout's argv
 *   (no 'dsh' substring anywhere) can never match and a crashed dev tree
 *   leaves the writer-quiescence latch closed forever.
 */
export function writePidRecord(stateDir: string, pid: number, port: number, ownerPid: number, extra: Record<string, unknown> = {}, entryPath?: string | null): void {
  const dir = join(stateDir, 'managed-dsh')
  mkdirSync(dir, { recursive: true })
  const binary = typeof extra.binary === 'string' && extra.binary !== '' ? extra.binary : 'dsh'
  const { binary: _binary, ...additional } = extra
  const record = {
    pid,
    ownerPid,
    ...additional,
    port,
    // Record the exact CLI entry used for this process. The reaper compares
    // this absolute path against the live command line; a basename marker
    // such as `dsh`/`bin.ts` is too broad under stale-record PID reuse.
    binary,
    ...(entryPath !== undefined && entryPath !== null && entryPath !== '' ? { entry: entryPath } : {}),
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
function resolveDshEntry(dshWorkspacePath: string, port: number, patchPath?: string | null): { args: string[]; binary: string } {
  const profileFlags = webProfileArgs(port, patchPath ?? undefined)
  const installed = join(dshWorkspacePath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(installed)) {
    return { args: [installed, ...profileFlags], binary: installed }
  }
  const source = join(dshWorkspacePath, 'apps', 'cli', 'src', 'bin.ts')
  if (existsSync(source)) {
    // Use the absolute source entry in argv as well as in the pid record so
    // the orphan reaper can re-verify one exact token without a cwd guess.
    return { args: ['--import', 'tsx/esm', source, ...profileFlags], binary: source }
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
  /** First port attempted (default BASE_DHSPORT). Server gateway deployments
   *  set this via DSH_GATEWAY_DSH_PORT (design 17 §3). */
  dshPortBase?: number
  signal?: AbortSignal
  pidRecordWriter: typeof writePidRecord
  terminateChildFn: (child: ChildProcess) => Promise<void>
}

export const DSH_SPAWN_NON_RETRYABLE_CODE = 'dsh_spawn_non_retryable'
export const DSH_WRITER_QUIESCENCE_UNKNOWN_CODE = 'dsh_writer_quiescence_unknown'

export type SpawnLifecycleErrorCode =
  | typeof DSH_SPAWN_NON_RETRYABLE_CODE
  | typeof DSH_WRITER_QUIESCENCE_UNKNOWN_CODE

export class SpawnLifecycleError extends Error {
  readonly code: SpawnLifecycleErrorCode
  readonly cause: unknown

  constructor(code: SpawnLifecycleErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'SpawnLifecycleError'
    this.code = code
    this.cause = cause
  }
}

export function isWriterQuiescenceUnknown(error: unknown): error is Error & { code: typeof DSH_WRITER_QUIESCENCE_UNKNOWN_CODE } {
  return error instanceof Error
    && (error as Error & { code?: unknown }).code === DSH_WRITER_QUIESCENCE_UNKNOWN_CODE
}

function isNonRetryableSpawnError(error: unknown): error is Error & { code: SpawnLifecycleErrorCode } {
  if (!(error instanceof Error)) return false
  const code = (error as Error & { code?: unknown }).code
  return code === DSH_SPAWN_NON_RETRYABLE_CODE || code === DSH_WRITER_QUIESCENCE_UNKNOWN_CODE
}

function writerQuiescenceUnknown(child: ChildProcess, context: string, cause: unknown): SpawnLifecycleError {
  if (isWriterQuiescenceUnknown(cause)) return cause as SpawnLifecycleError
  const pid = child.pid ?? 'unknown'
  return new SpawnLifecycleError(
    DSH_WRITER_QUIESCENCE_UNKNOWN_CODE,
    `${context}; dsh process group ${pid} quiescence is unknown: ${String(cause)}`,
    cause,
  )
}

async function terminateAndProveQuiet(
  child: ChildProcess,
  terminateChildFn: (child: ChildProcess) => Promise<void>,
  context: string,
): Promise<void> {
  try {
    await terminateChildFn(child)
  } catch (error) {
    throw writerQuiescenceUnknown(child, context, error)
  }
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

async function spawnAttempt({
  dshHome,
  stateDir,
  dshWorkspacePath,
  port,
  logger,
  patchPath,
  signal,
  pidRecordWriter,
  terminateChildFn,
}: SpawnAttemptOptions): Promise<SpawnAttemptResult> {
  // The caller performs an async port preflight. stop() may abort while that
  // await is in flight, so re-check at the actual spawn boundary as well.
  if (signal?.aborted) throw new Error('spawn aborted')
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
    env: sanitizeManagedDshEnv({
      ...process.env,
      ...nodeExec.env,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'workspace-write',
      SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group: the host outlives a control-plane crash and the
    // orphan reaper (design 02 §3.4.2) reclaims it.
    detached: true,
  })
  // A spawn failure (ENOENT/EACCES/Electron fuse) arrives as an async
  // 'error' event. Attach a listener BEFORE the pid check: if the pid check
  // throws, the pending event would otherwise be unhandled and crash the
  // whole control plane with an uncaughtException. The listener converges
  // into the outcome failure once the outcome promise exists (2026 review).
  let onSpawnError: ((error: Error) => void) | undefined
  child.on('error', error => onSpawnError?.(error))
  const pid = child.pid
  if (pid === undefined) {
    child.kill('SIGKILL')
    throw new Error(`dsh spawn on port ${port} produced no pid`)
  }
  const forwardChildOutput = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    const line = formatChildOutputChunk(chunk)
    log(line)
    hostLog.write(line, stream)
  }
  child.stdout.on('data', chunk => forwardChildOutput(chunk, 'stdout'))
  child.stderr.on('data', chunk => forwardChildOutput(chunk, 'stderr'))
  // Unlike 'exit', 'close' fires only after both stdio pipes have closed, so
  // every data event is enqueued before the writer is retired.
  child.once('close', () => { void hostLog.close() })
  const instanceId = readInstanceId(stateDir)
  try {
    // The entry token rides the ledger so the reaper can re-verify the live
    // process identity in BOTH layouts (installed bin.js path / dev source
    // script) — design 02 §3.4.2.
    pidRecordWriter(stateDir, pid, port, process.pid, {
      ...(instanceId === null ? {} : { ownerInstanceId: instanceId }),
      binary: entry.binary,
    }, entry.binary)
  } catch (ledgerError) {
    // A detached writer must never continue without its durable reaper
    // evidence. Reclaim it before surfacing the ledger failure, and make the
    // attempt non-retryable so another port cannot create a second writer.
    try {
      await terminateAndProveQuiet(child, terminateChildFn, 'pid ledger publication failed and child cleanup did not prove quiescence')
    } catch (terminationError) {
      throw writerQuiescenceUnknown(
        child,
        `pid ledger publication failed (${String(ledgerError)}) and cleanup failed`,
        terminationError,
      )
    }
    // A custom/injected writer may have published and then thrown. Only erase
    // possible evidence after the process group is positively absent.
    removePidRecord(stateDir, pid)
    throw new SpawnLifecycleError(
      DSH_SPAWN_NON_RETRYABLE_CODE,
      `dsh pid ledger publication failed on port ${port}; child was reclaimed: ${String(ledgerError)}`,
      ledgerError,
    )
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let tcpProbeTimer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let activeSocket: ReturnType<typeof createConnection> | undefined
  let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  let onAbort: (() => void) | undefined
  const outcome = await new Promise<string>(resolve => {
    let settled = false
    const finish = (value: string) => {
      if (settled) return
      settled = true
      if (tcpProbeTimer !== undefined) clearTimeout(tcpProbeTimer)
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      activeSocket?.destroy()
      activeSocket = undefined
      resolve(value)
    }
    timer = setTimeout(() => finish('timeout'), LISTEN_WAIT_MS)
    onExit = (code, sig) => finish(`exit(${code ?? sig})`)
    child.once('exit', onExit)
    onAbort = () => finish('aborted')
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    onSpawnError = error => {
      // Converge into the regular non-tcp failure path: the caller's
      // terminateAndProveQuiet cleanup + loud throw take over.
      finish(`spawn-error: ${error.message}`)
    }
    const probe = () => {
      if (settled || child.exitCode !== null || child.signalCode !== null) return
      const socket = createConnection({ host: '127.0.0.1', port })
      activeSocket = socket
      const finishProbe = (connected: boolean) => {
        if (activeSocket !== socket) return
        if (tcpProbeTimer !== undefined) clearTimeout(tcpProbeTimer)
        activeSocket = undefined
        socket.destroy()
        if (connected) finish('tcp')
        else if (!settled) retryTimer = setTimeout(probe, 250)
      }
      tcpProbeTimer = setTimeout(() => finishProbe(false), PORT_PROBE_TIMEOUT_MS)
      socket.once('connect', () => {
        finishProbe(true)
      })
      socket.once('error', () => {
        finishProbe(false)
      })
    }
    probe()
  }).finally(() => {
    clearTimeout(timer)
    if (tcpProbeTimer !== undefined) clearTimeout(tcpProbeTimer)
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    activeSocket?.destroy()
    if (onExit !== undefined) child.removeListener('exit', onExit)
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
  })
  if (outcome !== 'tcp') {
    // stopLocal() uses the signal as a writer-quiescence barrier. Do not
    // settle the spawn promise until the detached process group has really
    // exited; merely delivering child.kill() would leave a snapshot race.
    await terminateAndProveQuiet(child, terminateChildFn, `spawn attempt on port ${port} failed before TCP readiness`)
    // The ledger is writer evidence: delete only after PGID quiescence was
    // positively established above.
    removePidRecord(stateDir, pid)
    throw new Error(`dsh spawn attempt on port ${port} failed: ${outcome} before TCP listen`)
  }
  // The TCP listener comes up before the connection plugin's /api routes are
  // mounted; describe can 404 briefly. Retry the probe until it succeeds or
  // the listen window expires.
  const controller = new AbortController()
  const onGenerationAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onGenerationAbort, { once: true })
  const probeTimer = setTimeout(() => controller.abort(), LISTEN_WAIT_MS)
  let lastProbeError: unknown
  try {
    for (;;) {
      if (controller.signal.aborted) {
        if (signal?.aborted) throw new Error('spawn aborted')
        throw lastProbeError ?? new Error('probe window expired')
      }
      try {
        await call(baseUrl, 'host.describe', {}, { signal: controller.signal })
        break
      } catch (probeError) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`dsh spawn attempt on port ${port} failed: child exited: ${String(probeError)}`)
        }
        if (controller.signal.aborted) throw probeError
        lastProbeError = probeError
        await waitForRetry(500, controller.signal)
      }
    }
  } catch (error) {
    await terminateAndProveQuiet(child, terminateChildFn, `spawn attempt on port ${port} failed during host.describe`)
    // Preserve the ledger when termination cannot prove group quiescence.
    removePidRecord(stateDir, pid)
    throw new Error(`dsh spawn attempt on port ${port} failed: host.describe: ${String(error)}`)
  } finally {
    clearTimeout(probeTimer)
    signal?.removeEventListener('abort', onGenerationAbort)
  }
  // Best-effort browse-capability probe (design 05 §4): the in-app directory
  // dialog needs the host to serve `browse`. A native-capability host — a
  // dsh version predating the SSH_CONNECTION resolver arm, or a deployment
  // that overrides the spawn env — answers `directory-picker-unavailable`:
  // loud in the log instead of a silent dialog failure. Never fails the
  // spawn (the host is otherwise healthy); other failures are ignored.
  try {
    await call(baseUrl, 'host.listDirectory', {}, { timeoutMs: 10_000, signal })
  } catch (probeError) {
    if (signal?.aborted) {
      await terminateAndProveQuiet(child, terminateChildFn, `spawn attempt on port ${port} aborted during browse probe`)
      removePidRecord(stateDir, pid)
      throw new Error(`dsh spawn attempt on port ${port} failed: spawn aborted`)
    }
    if (probeError instanceof RpcBusinessError && probeError.code === 'directory-picker-unavailable') {
      logger.warn(
        `[dsh:${port}] host serves the native directory picker — the in-app directory dialog (design 05 §4) will fail; `
        + 'expected when the dsh version predates the SSH_CONNECTION resolver arm or the spawn env was overridden',
      )
    }
  }
  if (signal?.aborted) {
    await terminateAndProveQuiet(child, terminateChildFn, `spawn attempt on port ${port} aborted after browse probe`)
    removePidRecord(stateDir, pid)
    throw new Error(`dsh spawn attempt on port ${port} failed: spawn aborted`)
  }
  return { child, port, baseUrl }
}

/** Signal the whole process group of a detached child; fall back to the pid. */
function signalManagedGroup(child: ChildProcess, pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    try {
      child.kill(signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    // A detached Unix child is normally its process-group leader. Retain a
    // direct-pid fallback for a platform/runtime that did not establish the
    // group, but only while Node still considers this exact child live.
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      process.kill(pid, signal)
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code !== 'ESRCH') throw fallbackError
    }
  }
}

/** Whether the owned process group (or Windows direct child) still exists.
 * EPERM proves existence without permission; only ESRCH proves quiescence. */
export function managedProcessGroupAlive(child: ChildProcess): boolean {
  const pid = child.pid
  if (pid === undefined) return false
  const target = process.platform === 'win32' ? pid : -pid
  try {
    process.kill(target, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') {
      if (process.platform !== 'win32' && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(pid, 0)
          return true
        } catch (fallbackError) {
          return (fallbackError as NodeJS.ErrnoException).code === 'EPERM'
        }
      }
      return false
    }
    if (code === 'EPERM') return true
    throw error
  }
}

const PROCESS_GROUP_POLL_MS = 25

async function waitForManagedGroupExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (managedProcessGroupAlive(child)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await new Promise(resolve => setTimeout(resolve, Math.min(PROCESS_GROUP_POLL_MS, remaining)))
  }
  return true
}

/**
 * Abandon a FAILED spawn attempt: process-group SIGKILL → wait for the exit →
 * remove the pid record. Every spawnAttempt failure path converges here so a
 * broken attempt can never leave an untracked detached process behind (2026
 * audit H3 — writePidRecord failures and the TCP/describe failure paths used
 * to kill only the pid and remove the record before exit). Mirror of
 * terminateChild's group discipline; the record is removed only after the
 * process is confirmed dead (design 02 §3.3: 注销只在确认进程已退出后) — a
 * child that somehow survives the SIGKILL stays tracked for the orphan reaper.
 * (main's H3 helper; the merged spawnAttempt failure paths use the stronger
 * terminateAndProveQuiet, this remains exported for direct cleanup callers.)
 */
export async function killFailedSpawn(stateDir: string, child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    signalManagedGroup(child, pid, 'SIGKILL')
    await exited
  }
  removePidRecord(stateDir, pid)
}

/**
 * Stop a managed child and prove the complete detached process group is gone.
 * The leader's `exit` event is insufficient: PTY/plugin descendants can keep
 * the PGID and continue writing DSH_HOME. The pid ledger is removed by the
 * caller only after this function returns successfully.
 */
export async function terminateChild(child: ChildProcess, graceMs = TERMINATE_GRACE_MS): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return
  try {
    if (!managedProcessGroupAlive(child)) return
    signalManagedGroup(child, pid, 'SIGTERM')
    if (await waitForManagedGroupExit(child, graceMs)) return
    signalManagedGroup(child, pid, 'SIGKILL')
    if (await waitForManagedGroupExit(child, graceMs)) return
    throw new SpawnLifecycleError(
      DSH_WRITER_QUIESCENCE_UNKNOWN_CODE,
      `dsh process group ${pid} did not exit after SIGKILL`,
    )
  } catch (error) {
    throw writerQuiescenceUnknown(child, 'managed child termination failed', error)
  }
}

/** Options for spawnDsh. */
export interface SpawnDshOptions {
  stateDir: string
  dshHome: string
  dshWorkspacePath: string
  logger: Logger
  /** Optional `--patch` overlay passed to the dsh launcher (design 09 module B). */
  patchPath?: string | null
  /** First port attempted (default BASE_DHSPORT). Server gateway deployments
   *  set this via DSH_GATEWAY_DSH_PORT (design 17 §3). */
  dshPortBase?: number
  signal?: AbortSignal
  /** Injectable ledger writer for deterministic lifecycle-failure tests. */
  pidRecordWriter?: typeof writePidRecord
  /** Injectable terminator for deterministic residual-writer tests. */
  terminateChildFn?: (child: ChildProcess) => Promise<void>
}

/** The ready host surface returned by spawnDsh. */
export interface SpawnedHost {
  child: ChildProcess
  port: number
  baseUrl: string
  stop(): Promise<void>
}

/**
 * Spawn a ready dsh host on a free port from DEFAULT_DSH_START_PORT upward.
 * @param options - {stateDir, dshHome, dshWorkspacePath, logger, patchPath?,
 *   signal}.
 * @returns {child, port, baseUrl, stop()}.
 */
export async function spawnDsh({
  stateDir,
  dshHome,
  dshWorkspacePath,
  logger,
  patchPath,
  signal,
  dshPortBase,
  pidRecordWriter = writePidRecord,
  terminateChildFn = terminateChild,
}: SpawnDshOptions): Promise<SpawnedHost> {
  const basePort = dshPortBase ?? BASE_DHSPORT
  if (!isDshPortBaseValid(basePort)) {
    throw new Error(`invalid dsh port base: ${String(basePort)}`)
  }
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_SPAWN_ATTEMPTS; attempt++) {
    const port = basePort + attempt
    if (signal?.aborted) throw new Error('spawn aborted')
    // Port pre-check: skip a port that is already taken (a stray process from
    // an earlier run would otherwise make this attempt die with EADDRINUSE).
    const busy = await probePortBusy(port, signal)
    if (busy) {
      logger.log(`port ${port} already in use; skipping`)
      continue
    }
    // stop() can win during the asynchronous port pre-check. Never create a
    // detached child for a lifecycle generation that is already cancelled.
    if (signal?.aborted) throw new Error('spawn aborted')
    try {
      const spawned = await spawnAttempt({
        dshHome,
        stateDir,
        dshWorkspacePath,
        port,
        logger,
        patchPath,
        signal,
        pidRecordWriter,
        terminateChildFn,
      })
      return {
        ...spawned,
        stop: async () => {
          await terminateAndProveQuiet(spawned.child, terminateChildFn, 'managed host stop failed')
          const pid = spawned.child.pid
          // terminateChild rejects on residual group liveness, so a failed
          // proof leaves this record for the startup reaper/fail-closed gate.
          if (pid !== undefined) removePidRecord(stateDir, pid)
        },
      }
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      logger.log(`spawn attempt ${attempt + 1}/${MAX_SPAWN_ATTEMPTS} on port ${port} failed: ${message}`)
      // Ledger publication and unknown-writer failures are lifecycle failures,
      // not port collisions. Retrying would create a second DSH_HOME writer.
      if (isNonRetryableSpawnError(error)) throw error
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
  // fsync before the rename (2026 review): a crash between write and rename
  // must not leave a zero-length/partial record at the final path.
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, `${JSON.stringify(value, undefined, 2)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}
