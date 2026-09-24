/**
 * Web-profile dsh spawn + process lifecycle for the control plane.
 *
 * Base command line: `dsh --profile web --host 127.0.0.1 --port <P>
 * --trusted-host 127.0.0.1:<P>`; an optional chamber-owned `--patch <path>` overlay
 * is inserted right after `--profile web` (before the web app's own flags, which
 * the launcher passes through verbatim). --trusted-host admits exactly the
 * 127.0.0.1:<P> Host the reverse proxy forwards.
 *
 * Ports: base DEFAULT_DSH_START_PORT (17510), port+1 per failed attempt (process
 * exit / no listener in 90s / failed identity probe), at most MAX_SPAWN_ATTEMPTS.
 * The child is detached in its own process group (it survives a control-plane
 * crash; the orphan reaper reclaims it).
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createConnection } from 'node:net'
import { call, probeHostIdentity, RpcBusinessError, RpcTransportError } from './dsh-client.ts'
import {
  clearAuthCookie,
  exchangeLaunchToken,
  extractLaunchToken,
  parseDshWebUrlLine,
  registerAuthCookie,
} from './browser-auth-cookie.ts'
import { createHostLogWriter } from './host-logs.ts'
import { ensurePrivateDirectoryNoFollow } from './private-file.ts'
import { removePidRecord, writePidRecord } from './pid-record.ts'
import type { Logger } from './types.ts'
import { ensureInstanceId, isValidInstanceId } from './instance-id.ts'
import { cimPidLiveness, hasWindowsResidualTree, treeKillWindows } from './win-probes.ts'

/**
 * Default first port for a managed local dsh host; spawns advance +1 per retry.
 * Distant from DEFAULT_CONTROL_PLANE_PORT (17500) so the two surfaces never collide.
 */
export const DEFAULT_DSH_START_PORT = 17510

/** Gateway credentials belong to the outer authenticated boundary and must never
 *  become ambient authority inside the managed dsh or its tools/plugins. */
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
 * Validate a dsh port base: a positive integer in the port range; spawn attempts
 * walk upward from it. Server gateway deployments override it via --dsh-port /
 * DSH_GATEWAY_DSH_PORT.
 */
export function isDshPortBaseValid(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535
}

/**
 * Grace window between SIGTERM and SIGKILL when stopping a managed host. Kept short
 * so app quit is fast; the host persists session JSONL continuously, so 1s flushes
 * the tail and SIGKILL then releases the port/fds deterministically.
 */
export const TERMINATE_GRACE_MS = 1_000

/** Maximum spawn attempts (port +1 per retry). */
export const MAX_SPAWN_ATTEMPTS = 5

/** How long a spawned host gets to open its TCP listener. */
export const LISTEN_WAIT_MS = 90_000
/** Bounded wait for the `dsh web:` launch-token line (one attempt may consume two windows: a 401 arriving before the line re-arms once). */
const AUTH_BOOTSTRAP_WAIT_MS = 15_000

/** Bound every loopback connect attempt so startup/shutdown cannot hang behind a socket that neither connects nor errors. */
export const PORT_PROBE_TIMEOUT_MS = 1_000

/**
 * Ceiling for the INCOMPLETE-LINE carry of the child-output forward path: output is
 * decoded raw so the readiness scanner sees complete lines, and this bounds the tail
 * a newline-less writer could grow. 64 KiB also stays below host-logs' 512 KiB
 * encoded-entry ceiling for worst-case JSON escaping.
 */
export const MAX_CHILD_OUTPUT_CHUNK_BYTES = 64 * 1024

/**
 * Mask credential-bearing query values in ONE COMPLETE child-output line — the last
 * gate before a managed host's stdout/stderr reaches the logs. The `?token=` launch
 * token is the only recoverable credential the host prints, so it must be redacted
 * on the complete line, never on per-chunk fragments.
 */
export function redactChildOutputLine(line: string): string {
  return line.replace(/([?&]token=)[^&\s)]+/g, '$1***')
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
 * Check whether a candidate loopback port is occupied. A connect timeout counts as
 * busy (an inconclusive probe must not launch a detached host on an unknown port);
 * abort always wins and destroys the in-flight socket.
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

/** The fixed web-profile flag set. --trusted-host and --port always agree
 *  (127.0.0.1:<P>) so the trust fence and the forwarded Host never diverge; a
 *  non-empty patchPath inserts `--patch <path>` right after `--profile web`. */
export function webProfileArgs(port: number, patchPath?: string): string[] {
  const base = ['--profile', 'web', '--host', '127.0.0.1', '--port', String(port), '--trusted-host', `127.0.0.1:${port}`]
  if (patchPath === undefined || patchPath === '') return base
  return ['--profile', 'web', '--patch', patchPath, '--host', '127.0.0.1', '--port', String(port), '--trusted-host', `127.0.0.1:${port}`]
}


/** How the dsh CLI entry was resolved for one spawn (see resolveDshEntry). */
export type DshEntryLayout = 'installed' | 'source'

/**
 * The cwd for one managed-host spawn: installed layouts use the managed dsh home —
 * a stable, 0700, control-plane-owned directory — because an app install/update
 * replaces the runtime tree IN PLACE, and a process whose cwd is that tree keeps the
 * unlinked inode (worker_threads share process.cwd(), so every tool call would fail
 * with `uv_cwd ENOENT` until restart). Source layouts keep the workspace cwd: their
 * tsx loader resolves through the workspace node_modules and a checkout is not
 * replaced in place. The entry itself is always absolute, so neither branch depends
 * on cwd to find the CLI.
 */
export function resolveSpawnCwd(input: {
  readonly layout: DshEntryLayout
  readonly dshWorkspacePath: string
  readonly dshHome: string
}): string {
  return input.layout === 'installed' ? input.dshHome : input.dshWorkspacePath
}

/**
 * Resolve the dsh CLI entry for a workspace, preferring the installed artifact over
 * the source checkout (packaged runtimes ship the published npm package, dev
 * workspaces run the ref-dsh source tree — the tsx fallback is dev-only). The
 * resolved layout also selects the child cwd (see resolveSpawnCwd).
 */
function resolveDshEntry(dshWorkspacePath: string, port: number, patchPath?: string | null): { args: string[]; binary: string; layout: DshEntryLayout } {
  const profileFlags = webProfileArgs(port, patchPath ?? undefined)
  const installed = join(dshWorkspacePath, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(installed)) {
    return { args: [installed, ...profileFlags], binary: installed, layout: 'installed' }
  }
  const source = join(dshWorkspacePath, 'apps', 'cli', 'src', 'bin.ts')
  if (existsSync(source)) {
    // Absolute source entry in argv as well as in the pid record, so the reaper can re-verify one exact token.
    return { args: ['--import', 'tsx/esm', source, ...profileFlags], binary: source, layout: 'source' }
  }
  throw new Error(`no dsh CLI entry found in ${dshWorkspacePath} (neither node_modules/@deepseek-ai/dsh/lib/bin.js nor apps/cli/src/bin.ts)`)
}

/**
 * One spawn attempt: launch the child with the web-profile flags for `port` and
 * wait for readiness (TCP listener, then a successful unified host-identity probe —
 * probeHostIdentity speaks the fixed-size session/canOpenWorkspacePath boolean with
 * a legacy session/list fallback). The child is the dsh process itself — no pnpm
 * wrapper, so there is no grandchild to orphan.
 */
interface SpawnAttemptOptions {
  dshHome: string
  stateDir: string
  ownerInstanceId: string
  dshWorkspacePath: string
  port: number
  logger: Logger
  patchPath?: string | null
  dshPortBase?: number
  authBootstrapWaitMs?: number
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

/**
 * Render any thrown value without ever producing the literal `undefined` or `null`:
 * failure messages are user-facing, so a non-Error throw must still name that fact.
 */
function describeThrownValue(value: unknown): string {
  if (value === undefined) return 'no error object was thrown'
  if (value === null) return 'null was thrown'
  if (value instanceof Error) return value.message === '' ? `${value.name === '' ? 'Error' : value.name} (no message)` : value.message
  const text = String(value)
  return text === '' ? 'a non-Error value with an empty string form was thrown' : text
}

function writerQuiescenceUnknown(child: ChildProcess, context: string, cause: unknown): SpawnLifecycleError {
  if (isWriterQuiescenceUnknown(cause)) return cause as SpawnLifecycleError
  const pid = child.pid ?? 'unknown'
  return new SpawnLifecycleError(
    DSH_WRITER_QUIESCENCE_UNKNOWN_CODE,
    `${context}; dsh process group ${pid} quiescence is unknown: ${describeThrownValue(cause)}`,
    cause,
  )
}

/**
 * Why one spawn attempt failed. The exhausted-spawn error carries one typed record
 * per attempt so the terminal message names the REAL cause — port collision, listen
 * timeout, exit code, or stderr tail — never a bare `undefined`.
 */
export type SpawnAttemptFailureKind =
  | 'port-busy'
  | 'child-exit'
  | 'listen-timeout'
  | 'spawn-error'
  | 'identity-probe'
  | 'auth-bootstrap'
  | 'aborted'
  | 'unknown'

/** One failed spawn attempt, with its concrete reason. */
export interface SpawnAttemptFailure {
  /** 1-based attempt number inside the MAX_SPAWN_ATTEMPTS window. */
  attempt: number
  port: number
  kind: SpawnAttemptFailureKind
  /** Human-readable reason; always non-empty and never "undefined". */
  message: string
  /** Child exit code observed by the attempt, when any. */
  exitCode?: number | null
  /** Child exit signal observed by the attempt, when any. */
  signal?: string | null
  /** Bounded, credential-redacted stderr tail of the attempt, when any. */
  stderr?: string
}

/** Code of the terminal exhausted-spawn error. */
export const DSH_SPAWN_ATTEMPTS_EXHAUSTED_CODE = 'dsh_spawn_attempts_exhausted'

/** Bounded stderr digest carried by one failed attempt's reason. */
export const MAX_ATTEMPT_STDERR_DIGEST_CHARS = 512

/** The typed failure of ONE attempt (readiness phases wrap their reason here). */
class SpawnAttemptError extends Error {
  readonly kind: SpawnAttemptFailureKind
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stderr: string

  constructor(kind: SpawnAttemptFailureKind, message: string, facts: { exitCode?: number | null; signal?: string | null; stderr?: string } = {}) {
    super(message)
    this.name = 'SpawnAttemptError'
    this.kind = kind
    this.exitCode = facts.exitCode ?? null
    this.signal = facts.signal ?? null
    this.stderr = facts.stderr ?? ''
  }
}

/** The terminal failure after the whole retry window was exhausted. */
export class DshSpawnExhaustedError extends Error {
  readonly code = DSH_SPAWN_ATTEMPTS_EXHAUSTED_CODE
  /** One record per attempted port — always MAX_SPAWN_ATTEMPTS here. */
  readonly attempts: readonly SpawnAttemptFailure[]

  constructor(basePort: number, attempts: readonly SpawnAttemptFailure[]) {
    super(formatSpawnExhaustedMessage(basePort, attempts))
    this.name = 'DshSpawnExhaustedError'
    this.attempts = attempts
  }
}

/**
 * Render the terminal message from every attempt's reason; a genuinely empty reason
 * becomes an explicit sentence so the string never contains `undefined`.
 */
function formatSpawnExhaustedMessage(basePort: number, attempts: readonly SpawnAttemptFailure[]): string {
  const range = attempts.length === 0
    ? `port ${basePort}`
    : attempts.length === 1
      ? `port ${attempts[0].port}`
      : `ports ${attempts[0].port}..${attempts[attempts.length - 1].port}`
  const details = attempts.length === 0
    ? 'no attempt produced a failure record'
    : attempts.map(failure => `[${failure.kind}] port ${failure.port}: ${failure.message}${failure.stderr === undefined || failure.stderr === '' ? '' : ` (stderr: ${failure.stderr})`}`).join('; ')
  return `dsh failed to start after ${MAX_SPAWN_ATTEMPTS} attempts on ${range}: ${details}`
}

/** Turn any thrown value into a failure record with a non-empty reason. */
function recordSpawnAttemptFailure(attempt: number, port: number, error: unknown): SpawnAttemptFailure {
  if (error instanceof SpawnAttemptError) {
    const record: SpawnAttemptFailure = { attempt, port, kind: error.kind, message: error.message }
    if (error.exitCode !== null) record.exitCode = error.exitCode
    if (error.signal !== null) record.signal = error.signal
    const stderr = error.stderr.trim()
    if (stderr !== '') record.stderr = stderr
    return record.message === '' ? { ...record, message: `attempt failed (${error.kind}) without a message` } : record
  }
  return { attempt, port, kind: 'unknown', message: describeThrownValue(error) }
}

/** Map one readiness outcome (timeout / exit / spawn-error / abort) to the typed attempt failure. */
function readinessAttemptError(
  port: number,
  outcome: string,
  exitFacts: { code: number | null; signal: string | null } | null,
  stderr: string,
): SpawnAttemptError {
  if (outcome === 'timeout') {
    return new SpawnAttemptError('listen-timeout', `no TCP listener on 127.0.0.1:${port} within ${LISTEN_WAIT_MS}ms`, { stderr })
  }
  if (outcome.startsWith('exit(')) {
    const label = exitFacts?.code ?? exitFacts?.signal ?? outcome.slice('exit('.length, -1)
    return new SpawnAttemptError('child-exit', `child exited (${label}) before opening a TCP listener`, {
      exitCode: exitFacts?.code ?? null,
      signal: exitFacts?.signal ?? null,
      stderr,
    })
  }
  if (outcome.startsWith('spawn-error: ')) {
    return new SpawnAttemptError('spawn-error', `child process spawn failed: ${outcome.slice('spawn-error: '.length)}`, { stderr })
  }
  if (outcome === 'aborted') {
    return new SpawnAttemptError('aborted', 'spawn was aborted before TCP readiness', { stderr })
  }
  return new SpawnAttemptError('unknown', `attempt ended without TCP readiness: ${outcome}`, { stderr })
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
 * Resolve the node executable that runs the dsh CLI entry (never a pnpm wrapper).
 * The plane may run under plain node or inside the Electron main process: a
 * Finder-launched packaged app has a minimal PATH, so `spawn('node', …)` fails with
 * ENOENT. Electron → process.execPath + ELECTRON_RUN_AS_NODE=1 (requires the
 * runAsNode fuse, which must stay enabled) and --expose-internals (dsh's loader
 * resolves internal/modules/esm/loader through the require path, which Electron's
 * patched Node requires). Plain node → process.execPath. Fallback: PATH, then
 * well-known install roots, then the bare name.
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
  const known = knownNodeLocations().find(candidate => isExecutableFile(candidate))
  if (known !== undefined) return { file: known, args: [], env: {} }
  return { file: 'node', args: [], env: {} }
}

/** Only a regular executable file counts as a node candidate (a same-named directory must not shadow a later valid entry). */
function isExecutableFile(target: string): boolean {
  try {
    accessSync(target, constants.X_OK)
    return statSync(target).isFile()
  } catch {
    return false
  }
}

/** Locate a `node` executable by scanning PATH (first match wins). */
function searchPathForNode(): string | null {
  const isWin = process.platform === 'win32'
  const names = isWin ? ['node.exe'] : ['node']
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (dir === '') continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

/** Compare nvm version dir names (v24.20.0) numerically, descending — readdir order must never decide the version. */
function compareNodeVersionsDesc(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value.replace(/^v/, '').split('.').map(segment => Number.parseInt(segment, 10) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (b[index] ?? 0) - (a[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** nvm-installed node binaries (darwin + linux share the layout): ~/.nvm/alias/default first,
 *  then every ~/.nvm/versions/node/<v>/bin/node, newest first. Best-effort — never throws. */
function nvmNodeCandidates(home: string): string[] {
  const versionsRoot = join(home, '.nvm', 'versions', 'node')
  if (!existsSync(versionsRoot)) return []
  const candidates: string[] = []
  const defaultAlias = join(home, '.nvm', 'alias', 'default')
  try {
    const alias = readFileSync(defaultAlias, 'utf8').trim()
    if (alias !== '' && !alias.includes('/') && !alias.includes('..')) {
      candidates.push(join(versionsRoot, alias, 'bin', 'node'))
    }
  } catch {
    // alias missing/unreadable — fall through to the full scan
  }
  try {
    const versions = readdirSync(versionsRoot)
      .filter(version => /^v\d+\.\d+\.\d+$/.test(version))
      .sort(compareNodeVersionsDesc)
    for (const version of versions) candidates.push(join(versionsRoot, version, 'bin', 'node'))
  } catch {
    // An unreadable nvm dir must not break the fallback: later candidates and the bare-name last resort stay reachable.
  }
  return candidates
}

/** Well-known node install roots used when PATH has no node, platform-adapted;
 *  the nvm layout is identical on darwin and linux. */
function knownNodeLocations(): string[] {
  const home = homedir()
  const nvmBins = nvmNodeCandidates(home)
  const systemBins = ['/usr/local/bin/node', '/usr/bin/node']
  const versionManagers = [
    join(home, '.nvm', 'current', 'bin', 'node'),
    join(home, '.volta', 'bin', 'node'),
    join(home, '.fnm', 'aliases', 'default', 'bin', 'node'),
  ]
  if (process.platform === 'darwin') {
    return ['/opt/homebrew/bin/node', ...systemBins, ...versionManagers, ...nvmBins]
  }
  if (process.platform === 'linux') {
    // User-land nvm/pnpm/snap nodes come BEFORE the distro /usr/bin node (Homebrew first on darwin).
    return [...nvmBins, join(home, '.local', 'bin', 'node'), '/snap/bin/node', ...systemBins, ...versionManagers]
  }
  return [...versionManagers, ...systemBins]
}

/** A ready spawned child and the wire facts about it. */
interface SpawnAttemptResult {
  child: ChildProcess
  port: number
  baseUrl: string
}

async function spawnAttempt({
  dshHome,
  stateDir,
  ownerInstanceId,
  dshWorkspacePath,
  port,
  logger,
  patchPath,
  signal,
  pidRecordWriter,
  terminateChildFn,
  authBootstrapWaitMs,
}: SpawnAttemptOptions): Promise<SpawnAttemptResult> {
  // The caller performs an async port preflight; stop() may abort while it is in
  // flight, so re-check at the actual spawn boundary.
  if (signal?.aborted) throw new Error('spawn aborted')
  const baseUrl = `http://127.0.0.1:${port}`
  // A fresh spawn carries a fresh launch token — any cookie from a previous spawn on this port must not leak into the probe.
  clearAuthCookie(baseUrl)
  const log = (line: string) => logger.log(`[dsh:${port}] ${line}`)
  // Per-port rolling log: stdout/stderr go to the control-plane log AND to
  // <stateDir>/host-logs/<port>.log (JSONL) so GET /api/host/logs can serve recent lines.
  const hostLog = createHostLogWriter(stateDir, port, {
    // A dropped host-log batch is diagnostic-only but must not be silent: the writer
    // reports the first failure of each episode on the live stdio logger.
    warn: message => logger.warn(message),
  })
  const entry = resolveDshEntry(dshWorkspacePath, port, patchPath)
  // The cwd is never the installed runtime tree (see resolveSpawnCwd): an in-place
  // update would leave the host with an unlinked working directory.
  const spawnCwd = resolveSpawnCwd({ layout: entry.layout, dshWorkspacePath, dshHome })
  if (entry.layout === 'installed') {
    // The stable cwd must exist before the spawn (direct spawnDsh callers may not have created it).
    ensurePrivateDirectoryNoFollow(dshHome, 0o700, { existingMode: 'preserve' })
  }
  // The node executable is resolved, never assumed on PATH: under the Electron main
  // process a GUI-launched app has a minimal PATH (resolveNodeExecutable).
  const nodeExec = resolveNodeExecutable()
  const child = spawn(nodeExec.file, [...nodeExec.args, ...entry.args], {
    cwd: spawnCwd,
    // Deterministic, privacy-pinned environment; the Electron branch also injects
    // ELECTRON_RUN_AS_NODE=1. SSH_CONNECTION is the browse-interaction pin: under an
    // SSH-launch marker directory-picker-auto serves directoryPicker.list /
    // createDirectory, so every instance gets the same in-app dialog.
    env: sanitizeManagedDshEnv({
      ...process.env,
      ...nodeExec.env,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'workspace-write',
      SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group: the host outlives a control-plane crash and the orphan
    // reaper reclaims it; windowsHide keeps a detached Windows child headless.
    detached: true,
    windowsHide: true,
  })
  // A spawn failure (ENOENT/EACCES/Electron fuse) arrives as an async 'error' event;
  // attach the listener BEFORE the pid check, or a throwing pid check would leave it
  // unhandled and crash the whole plane.
  let onSpawnError: ((error: Error) => void) | undefined
  child.on('error', error => onSpawnError?.(error))
  const pid = child.pid
  if (pid === undefined) {
    child.kill('SIGKILL')
    throw new Error(`dsh spawn on port ${port} produced no pid`)
  }
  // Line-buffered forward path: the readiness line may split across stdio chunks —
  // redaction must see the COMPLETE line, never per-chunk fragments.
  let forwardLineTail = ''
  // Bounded, redacted stderr digest: a failed attempt must name what the child printed.
  let stderrDigest = ''
  const forwardChildOutput = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    // RAW bytes, never trimmed: the trailing newline must survive so line splitting
    // works; the scanner has the same raw-bytes rule.
    const text = chunk.toString('utf8')
    const segments = (forwardLineTail + text).split('\n')
    // Bound the incomplete-line tail so a child that never emits newlines cannot grow
    // the buffer without limit.
    forwardLineTail = (segments.pop() ?? '').slice(-MAX_CHILD_OUTPUT_CHUNK_BYTES)
    for (const segment of segments) {
      const safeLine = redactChildOutputLine(segment)
      log(safeLine)
      hostLog.write(safeLine, stream)
      if (stream === 'stderr') {
        stderrDigest = (stderrDigest === '' ? safeLine : `${stderrDigest}\n${safeLine}`).slice(-MAX_ATTEMPT_STDERR_DIGEST_CHARS)
      }
    }
  }
  // Browser-auth bootstrap: the web profile prints
  // `dsh web: <url>?token=<launchToken>` at Loader settlement, and the launch token
  // is process-memory random, so this stdout line is the ONLY recoverable carrier.
  // Hosts that print no token yield no cookie and continue unchanged; the cookie
  // never leaves this process. Held as an object property so the readiness phase's
  // later read is not CFA-narrowed to the initializer.
  const dshWebScanner: { cleanup: (() => void) | null } = { cleanup: null }
  // Whether the readiness line has settled (a URL line was seen, or stdout ended). An
  // UNSETTLED scanner is the only state in which the line can still arrive, so it is
  // the sole condition under which the bootstrap wait is re-armed by a 401.
  const dshWebLine: { settled: boolean } = { settled: false }
  const dshWebUrlPromise = new Promise<string | null>(resolve => {
    let stdoutTail = ''
    const settle = (value: string | null) => {
      dshWebLine.settled = true
      resolve(value)
    }
    const onStdout = (chunk: Buffer) => {
      // RAW bytes: trimming the chunk end would swallow the space before `(LAN: …)` at
      // a chunk boundary and corrupt the token query.
      stdoutTail = (stdoutTail + chunk.toString('utf8')).slice(-8_192)
      // Match only COMPLETE lines: the readiness line always ends with a newline, and a
      // chunk-split URL must never mint a truncated token.
      if (stdoutTail.includes('\n')) {
        const url = parseDshWebUrlLine(stdoutTail)
        if (url !== undefined) {
          cleanup()
          settle(url)
        }
      }
    }
    const onStdoutEnd = () => {
      cleanup()
      settle(null)
    }
    const cleanup = () => {
      child.stdout.off('data', onStdout)
      child.stdout.off('end', onStdoutEnd)
      dshWebScanner.cleanup = null
    }
    dshWebScanner.cleanup = cleanup
    child.stdout.on('data', onStdout)
    child.stdout.on('end', onStdoutEnd)
  })
  child.stdout.on('data', chunk => forwardChildOutput(chunk, 'stdout'))
  child.stderr.on('data', chunk => forwardChildOutput(chunk, 'stderr'))
  // 'close' fires only after both stdio pipes closed, so every data event is enqueued before retirement.
  child.once('close', () => { void hostLog.close() })
  try {
    // The entry token rides the ledger so the reaper can re-verify the live process
    // identity in BOTH layouts (installed bin.js / dev source script).
    pidRecordWriter(stateDir, pid, port, process.pid, {
      ownerInstanceId,
      binary: entry.binary,
    }, entry.binary)
  } catch (ledgerError) {
    // A detached writer must never continue without its durable reaper evidence:
    // reclaim it before surfacing the ledger failure, and make the attempt
    // non-retryable so another port cannot create a second writer.
    try {
      await terminateAndProveQuiet(child, terminateChildFn, 'pid ledger publication failed and child cleanup did not prove quiescence')
    } catch (terminationError) {
      throw writerQuiescenceUnknown(
        child,
        `pid ledger publication failed (${describeThrownValue(ledgerError)}) and cleanup failed`,
        terminationError,
      )
    }
    // Only erase possible published evidence after the process group is positively absent.
    removePidRecord(stateDir, pid)
    throw new SpawnLifecycleError(
      DSH_SPAWN_NON_RETRYABLE_CODE,
      `dsh pid ledger publication failed on port ${port}; child was reclaimed: ${describeThrownValue(ledgerError)}`,
      ledgerError,
    )
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let tcpProbeTimer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let activeSocket: ReturnType<typeof createConnection> | undefined
  let onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  // Exit facts of THIS attempt, kept for the typed failure record.
  let childExitFacts: { code: number | null; signal: string | null } | null = null
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
    onExit = (code, sig) => {
      childExitFacts = { code, signal: sig }
      finish(`exit(${code ?? sig})`)
    }
    child.once('exit', onExit)
    onAbort = () => finish('aborted')
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    onSpawnError = error => {
      // Converge into the regular non-tcp failure path (terminateAndProveQuiet + loud throw).
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
    // stopLocal() uses the signal as a writer-quiescence barrier: do not settle the
    // spawn promise until the detached process group has really exited.
    await terminateAndProveQuiet(child, terminateChildFn, `spawn attempt on port ${port} failed before TCP readiness`)
    // The ledger is writer evidence: delete only after PGID quiescence was positively established.
    removePidRecord(stateDir, pid)
    throw readinessAttemptError(port, outcome, childExitFacts, stderrDigest)
  }
  // Browser-auth bootstrap runs CONCURRENTLY with the probe: wait for the URL line,
  // exchange the launch token for the session cookie and register it for this baseUrl.
  // A 401 answer (the new-wire gate) awaits this wait; hosts with no token resolve
  // without a cookie. ONE readiness budget covers TCP listener, identity probe and both
  // browser-auth windows.
  const controller = new AbortController()
  const onGenerationAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', onGenerationAbort, { once: true })
  const probeTimer = setTimeout(() => controller.abort(), LISTEN_WAIT_MS)
  /**
   * One bounded wait for the `dsh web:` launch-token line plus its exchange; resolves
   * 'minted' or a failure message. Re-armable: the host mounts /api routes (401)
   * before the loader prints the line, so the first 401 can arrive with the line
   * outstanding and the caller may open a second window. A line that WAS seen is
   * final and never re-armed.
   */
  const waitForLaunchToken = async (): Promise<'minted' | string> => {
    const bootstrapController = new AbortController()
    const bootstrapTimer = setTimeout(() => bootstrapController.abort(), authBootstrapWaitMs ?? AUTH_BOOTSTRAP_WAIT_MS)
    const onSpawnAbort = () => bootstrapController.abort()
    if (signal?.aborted) bootstrapController.abort()
    else signal?.addEventListener('abort', onSpawnAbort, { once: true })
    const onChildExit = () => bootstrapController.abort()
    child.once('exit', onChildExit)
    // The readiness budget outranks a window: an expired budget must not leave a re-armed window waiting.
    const onBudgetAbort = () => bootstrapController.abort()
    if (controller.signal.aborted) bootstrapController.abort()
    else controller.signal.addEventListener('abort', onBudgetAbort, { once: true })
    try {
      // An already-aborted signal must settle the race immediately (a listener attached after abort never fires).
      const whenAborted = (abortSignal: AbortSignal): Promise<string | null> => new Promise(resolve => {
        if (abortSignal.aborted) resolve(null)
        else abortSignal.addEventListener('abort', () => resolve(null), { once: true })
      })
      const webUrl = await Promise.race([dshWebUrlPromise, whenAborted(bootstrapController.signal)])
      const token = webUrl === null ? undefined : extractLaunchToken(webUrl)
      if (token === undefined) {
        if (webUrl !== null) log('host prints a web URL without a launch token — pre-0.1.2 wire (or token suppressed), no auth cookie needed')
        return 'no launch token in the readiness line (pre-0.1.2 host or token suppressed)'
      }
      const cookie = await exchangeLaunchToken(baseUrl, token, bootstrapController.signal)
      if (cookie !== null) {
        registerAuthCookie(baseUrl, cookie)
        log('browser-auth cookie minted (0.1.2 wire)')
        return 'minted'
      }
      return 'the host did not mint a session cookie'
    } catch (error) {
      return describeThrownValue(error)
    } finally {
      clearTimeout(bootstrapTimer)
      signal?.removeEventListener('abort', onSpawnAbort)
      controller.signal.removeEventListener('abort', onBudgetAbort)
      child.off('exit', onChildExit)
      bootstrapController.abort()
    }
  }
  const authBootstrapPromise = waitForLaunchToken()
  // The TCP listener comes up before the connection plugin's /api routes, so a unary
  // probe can 404 briefly; retry until success or the listen window expires. Readiness
  // speaks probeHostIdentity: POST /api/session/canOpenWorkspacePath (zero-arg boolean
  // Remote, 64 KiB cap), falling back to the legacy session/list probe for runtime trees
  // that predate the identity method.
  let lastProbeError: unknown
  let bootstrapRearmed = false
  // The LATEST bootstrap outcome, not the first window's: after a re-arm the original
  // promise still holds the expired-window failure, so re-reading it would mislabel a
  // later 401 even though a cookie was minted.
  let lastAuthOutcome: 'minted' | string | null = null
  try {
    for (;;) {
      if (controller.signal.aborted) {
        if (signal?.aborted) throw new Error('spawn aborted')
        throw lastProbeError ?? new Error('probe window expired')
      }
      try {
        await probeHostIdentity(baseUrl, { signal: controller.signal, logger })
        break
      } catch (probeError) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new SpawnAttemptError(
            'child-exit',
            `child exited: ${describeThrownValue(probeError)}`,
            { stderr: stderrDigest },
          )
        }
        if (controller.signal.aborted) throw probeError
        if (probeError instanceof RpcTransportError && probeError.status === 401) {
          if (lastAuthOutcome === null) lastAuthOutcome = await authBootstrapPromise
          let authOutcome: 'minted' | string = lastAuthOutcome
          // The host answers /api with 401 as soon as the listener is up and prints the
          // URL line only after its loader settles, so the FIRST 401 can arrive while the
          // token line is outstanding: re-arm ONE fresh bounded window. A line that was
          // seen (with or without a token) is final.
          if (authOutcome !== 'minted' && !bootstrapRearmed && !dshWebLine.settled) {
            bootstrapRearmed = true
            log('browser-auth: no launch token yet when the host answered 401 — re-arming the bootstrap window once')
            authOutcome = await waitForLaunchToken()
            lastAuthOutcome = authOutcome
          }
          if (authOutcome !== 'minted') {
            logger.warn(`[dsh:${port}] browser-auth bootstrap failed (${authOutcome}); the host-identity probe will 401 on the 0.1.2 wire`)
            throw new SpawnAttemptError(
              'auth-bootstrap',
              `instance requires the 0.1.2 browser-auth cookie, but the bootstrap failed (${authOutcome})`,
              { stderr: stderrDigest },
            )
          }
          // Cookie minted — fall through and retry the probe with it.
        }
        lastProbeError = probeError
        await waitForRetry(500, controller.signal)
      }
    }
  } catch (error) {
    clearAuthCookie(baseUrl)
    await terminateAndProveQuiet(child, terminateChildFn, `spawn attempt on port ${port} failed during the host-identity probe`)
    // Preserve the ledger when termination cannot prove group quiescence.
    removePidRecord(stateDir, pid)
    throw new SpawnAttemptError(
      'identity-probe',
      `host identity probe failed: ${describeThrownValue(error)}`,
      { stderr: stderrDigest },
    )
  } finally {
    clearTimeout(probeTimer)
    signal?.removeEventListener('abort', onGenerationAbort)
    // The URL line arrives once (or never), and no window can be re-armed after this
    // phase: the scanner listeners must not ride the whole instance lifetime.
    dshWebScanner.cleanup?.()
  }
  // Best-effort browse-capability probe: the in-app directory dialog needs the host to
  // serve `browse`. A native-capability host (older dsh, overridden spawn env) answers
  // directory-picker/unavailable — loud in the log, never fatal.
  try {
    // directoryPicker.list is a Typert Remote; the minimal `{args:{}}` payload probes the
    // browse capability (the empty path lists the home directory; the result is discarded).
    await call(baseUrl, 'directoryPicker/list', { args: {} }, { timeoutMs: 10_000, signal })
  } catch (probeError) {
    if (signal?.aborted) {
      await terminateAndProveQuiet(child, terminateChildFn, `spawn attempt on port ${port} aborted during browse probe`)
      removePidRecord(stateDir, pid)
      throw new Error(`dsh spawn attempt on port ${port} failed: spawn aborted`)
    }
    if (probeError instanceof RpcBusinessError && probeError.code === 'directory-picker/unavailable') {
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
    // Windows has no POSIX group signals: force-terminate the whole tree with
    // taskkill /T /F (win-probes also reaps residual descendants of an already-dead
    // leader). false = the ESRCH equivalent; real failures throw loudly.
    treeKillWindows(pid)
    return
  }
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    // A detached Unix child is normally its process-group leader; keep a direct-pid
    // fallback for a runtime that did not establish the group, while Node still
    // considers this exact child live.
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      process.kill(pid, signal)
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException).code !== 'ESRCH') throw fallbackError
    }
  }
}

/** Whether the owned process group (or Windows direct child) still exists. EPERM
 * proves existence; only ESRCH proves quiescence. The win32 branch is
 * process.kill(pid, 0), which can read a terminated-but-held process as alive — the
 * async termination paths use managedTreeAliveProved instead. */
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

/**
 * Awaitable tree-quiescence proof for the termination paths. POSIX returns
 * managedProcessGroupAlive(). On win32 that is an OpenProcess probe that can read a
 * terminated-but-held process as alive forever; the CIM table enumerates only active
 * processes, so a readable table without the pid proves absence, an unreadable table
 * falls back to kill(0) (unknown ⇒ fail closed), and a dead leader with residual
 * descendants still counts alive. The absence proof is re-proved against a FRESH
 * table (the 500ms cache can predate the pid).
 */
async function managedTreeAliveProved(child: ChildProcess): Promise<boolean> {
  if (process.platform !== 'win32') return managedProcessGroupAlive(child)
  const pid = child.pid
  if (pid === undefined) return false
  const verdict = cimPidLiveness(pid)
  if (verdict === null) return managedProcessGroupAlive(child)
  if (verdict) return true
  return hasWindowsResidualTree(pid)
}

const PROCESS_GROUP_POLL_MS = 25

async function waitForManagedGroupExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (await managedTreeAliveProved(child)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await new Promise(resolve => setTimeout(resolve, Math.min(PROCESS_GROUP_POLL_MS, remaining)))
  }
  return true
}

/**
 * Stop a managed child and prove the complete detached process group is gone. The
 * leader's `exit` is insufficient: PTY/plugin descendants can keep the PGID and
 * continue writing DSH_HOME. The caller removes the pid ledger only after success.
 */
export async function terminateChild(child: ChildProcess, graceMs = TERMINATE_GRACE_MS): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return
  try {
    if (!(await managedTreeAliveProved(child))) return
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
  /** Stable owner identity captured by createControlPlane; direct callers may omit it. */
  ownerInstanceId?: string
  dshHome: string
  dshWorkspacePath: string
  logger: Logger
  /** Optional `--patch` overlay passed to the dsh launcher (design 09 module B). */
  patchPath?: string | null
  /** First port attempted (default BASE_DHSPORT). Server gateway deployments
   *  set this via DSH_GATEWAY_DSH_PORT (design 17 §3). */
  dshPortBase?: number
  /** Bounded wait for the `dsh web:` launch-token line (default AUTH_BOOTSTRAP_WAIT_MS). */
  authBootstrapWaitMs?: number
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

/** Spawn a ready dsh host on a free port from DEFAULT_DSH_START_PORT upward. */
export async function spawnDsh({
  stateDir,
  ownerInstanceId,
  dshHome,
  dshWorkspacePath,
  logger,
  patchPath,
  signal,
  dshPortBase,
  authBootstrapWaitMs,
  pidRecordWriter = writePidRecord,
  terminateChildFn = terminateChild,
}: SpawnDshOptions): Promise<SpawnedHost> {
  const basePort = dshPortBase ?? BASE_DHSPORT
  if (!isDshPortBaseValid(basePort)) {
    throw new Error(`invalid dsh port base: ${String(basePort)}`)
  }
  const resolvedOwnerInstanceId = ownerInstanceId ?? ensureInstanceId(stateDir)
  if (!isValidInstanceId(resolvedOwnerInstanceId)) {
    throw new Error('spawn ownerInstanceId must be a UUID')
  }
  // One typed record per failed attempt; the terminal error below carries all
  // of them, so an exhausted retry window always names the real reason.
  const failures: SpawnAttemptFailure[] = []
  for (let attempt = 0; attempt < MAX_SPAWN_ATTEMPTS; attempt++) {
    const port = basePort + attempt
    if (signal?.aborted) throw new Error('spawn aborted')
    // Port pre-check: skip an occupied port (a stray process would otherwise die with EADDRINUSE).
    let busy: boolean
    try {
      busy = await probePortBusy(port, signal)
    } catch (probeError) {
      if (signal?.aborted) throw probeError
      failures.push(recordSpawnAttemptFailure(attempt + 1, port, probeError))
      logger.log(`spawn attempt ${attempt + 1}/${MAX_SPAWN_ATTEMPTS} on port ${port} failed: port pre-check failed`)
      continue
    }
    if (busy) {
      failures.push({
        attempt: attempt + 1,
        port,
        kind: 'port-busy',
        message: `port ${port} is already in use (a TCP connect to 127.0.0.1:${port} succeeded)`,
      })
      logger.log(`port ${port} already in use; skipping`)
      continue
    }
    // stop() can win during the async port pre-check; never create a detached child for a cancelled generation.
    if (signal?.aborted) throw new Error('spawn aborted')
    try {
      const spawned = await spawnAttempt({
        dshHome,
        stateDir,
        ownerInstanceId: resolvedOwnerInstanceId,
        dshWorkspacePath,
        port,
        logger,
        patchPath,
        signal,
        pidRecordWriter,
        terminateChildFn,
        authBootstrapWaitMs,
      })
      return {
        ...spawned,
        stop: async () => {
          // The browser-auth cookie dies with the child.
          clearAuthCookie(spawned.baseUrl)
          await terminateAndProveQuiet(spawned.child, terminateChildFn, 'managed host stop failed')
          const pid = spawned.child.pid
          // terminateChild rejects on residual group liveness, so a failed proof leaves
          // this record for the startup reaper/fail-closed gate.
          if (pid !== undefined) removePidRecord(stateDir, pid)
        },
      }
    } catch (error) {
      const failure = recordSpawnAttemptFailure(attempt + 1, port, error)
      failures.push(failure)
      logger.log(`spawn attempt ${attempt + 1}/${MAX_SPAWN_ATTEMPTS} on port ${port} failed: ${failure.message}`)
      // Ledger publication and unknown-writer failures are lifecycle failures, not port
      // collisions; retrying would create a second DSH_HOME writer.
      if (isNonRetryableSpawnError(error)) throw error
    }
  }
  // Every iteration records exactly one failure, so this is always the full window.
  throw new DshSpawnExhaustedError(basePort, failures)
}
