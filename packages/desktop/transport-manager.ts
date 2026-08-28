/**
 * Generic transport runtime (design 03 §2.2, transport-provider.ts): the
 * source-agnostic half of the connection manager. Every registry instance
 * carries a `kind`; the runtime drives the ONE TransportProvider given at
 * creation (v1: `ssh`, ssh-provider.ts) and owns everything generic:
 *
 * - Persisted instance registry (<userData>/ssh-instances.json, written with
 *   the repo's atomic-write convention: write .tmp → fsync → rename; corrupt
 *   files fail loudly, never masquerade as an empty set — the desktop main
 *   process preserves the corrupt file before starting empty). Legacy files
 *   without `kind` migrate to the provider kind on load.
 * - Transport lifecycle per instance: provider.buildStartArgs starts a child
 *   tunnel on a local port bound via net listen(0), readiness = the
 *   local port accepts a TCP connection AND the provider's endpoint identity
 *   verification passes — verifyUp, e.g. the ssh provider's host.describe
 *   handshake, so a non-dsh service on the destination port never presents
 *   as ready).
 * - Phase machine: idle → connecting → ready ⇄ degraded → error, with
 *   TWO-TIER retry: a fast burst of bounded jittered exponential backoff
 *   (retryBaseMs * 2^n, half-open jitter, capped) followed — when the burst
 *   is exhausted — by an indefinite SLOW re-probe (one fresh attempt per
 *   slowRetryMs). Transient conditions are time-dependent, so error is never
 *   a permanent give-up: a recovered condition is picked up automatically
 *   (manual connect()/disconnect() cancels the probe). A requiresUserAction
 *   flag marks provider-classified TERMINAL failures (authentication/host-key,
 *   spawn failure, and DETERMINISTIC endpoint verification failures — a
 *   destination that answered the identity probe but proved not to be a
 *   compatible dsh: never auto-retried, retrying could not change the answer).
 * - Provider exec channel (ssh: remote systemd, ssh-provider.ts) — loud,
 *   never auto-retried, never writes the tunnel's terminal classification.
 * - Per-instance ring-buffer logs (~200 lines), non-secret status
 *   projections + pushes, child supervision (SIGTERM → SIGKILL escalation
 *   tracked per child).
 *
 * Security discipline (design 05 §8): the transport URL
 * (http://127.0.0.1:<localPort> or a provider endpoint) NEVER leaves this
 * module raw. status() projects {kind, phase, localPort, sshPort,
 * remotePort, retryAttempt, requiresUserAction, serviceActive, logSummary}
 * only — the renderer builds webview URLs from localPort alone. No
 * credential material ever rides the command line (provider-owned) and
 * stderr is redacted by the provider before it enters the ring buffer.
 *
 * Testability: the provider, the spawn, the port probe, the port allocator
 * and the RNG are injectable, so pure-Node tests drive the phase machine
 * with a fake process/provider — no real SSH host needed. This module
 * imports nothing from 'electron'.
 */

import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import net from 'node:net'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { MAX_TRANSPORT_INSTANCES } from './transport-provider.ts'
import { CHILD_LINE_MAX_CHARS, createBoundedLineProcessor } from './bounded-lines.ts'
import type {
  SpawnedProcess,
  TransportExecAction,
  TransportExecResult,
  TransportInstanceInput,
  TransportInstanceSpec,
  TransportLogEntry,
  TransportPhase,
  TransportProbeEndpoint,
  TransportProvider,
  TransportRunPayload,
  TransportStatusProjection,
  TransportVerifyResult,
} from './transport-provider.ts'
export { INSTANCE_ID_PATTERN } from './transport-provider.ts'

/** Ring-buffer log cap per instance（滚动日志上限，截断 200 行）. */
export const RING_BUFFER_LIMIT = 200

/** Display/persistence projection cap after provider classification/redaction.
 * CHILD_LINE_MAX_CHARS bounds incremental parsing; this smaller cap bounds the
 * retained 32-instance × 200-line ring footprint without weakening the
 * classifier's ability to inspect a complete diagnostic line. */
export const RING_LOG_MESSAGE_MAX_CHARS = 4 * 1024
const RING_LOG_TRUNCATION_SUFFIX = ' … [truncated]'

/** How long the transport has to come up (local port accept / endpoint probe) before degraded. */
export const READY_TIMEOUT_MS = 10_000

/** Poll interval while waiting for the transport to come up. */
export const PROBE_INTERVAL_MS = 100

/** Fast reconnect attempts before the machine lands on error. */
export const MAX_RETRY_ATTEMPTS = 5

/** Reconnect backoff floor. */
export const RETRY_BASE_MS = 1_000

/** Reconnect backoff ceiling. */
export const RETRY_MAX_MS = 30_000

/**
 * Slow re-probe cadence after the FAST retry burst is exhausted: the machine
 * lands on error (honest red state) but keeps ONE fresh transport attempt per
 * slowRetryMs indefinitely — transient conditions (network outage, remote
 * restart, the remote service coming up) are TIME-DEPENDENT, so "gave up"
 * must never be a permanent state. Terminal failures never reach this path
 * (failTerminal stops them), and a manual connect()/disconnect() cancels the
 * probe. Success lands ready and resets the counters.
 */
export const SLOW_RETRY_MS = 60_000

/**
 * Retry backoff with half-open jitter (AWS exponential-backoff-and-jitter
 * practice): keep at least half the raw exponential backoff and jitter the
 * rest, so multiple tunnels (N-ctx) and post-sleep/wake storms desynchronize
 * instead of thundering-herding at identical instants.
 */
export function jitteredBackoffMs(backoffMs: number, random: () => number = Math.random): number {
  return Math.floor(backoffMs * (0.5 + random() * 0.5))
}

/** SIGTERM → SIGKILL grace when stopping a child. Kept short so app quit is
 * fast: a tunnel teardown has no consistency cost, so a 1s window is plenty
 * before the deterministic SIGKILL (the "fast exit" half of the
 * speed-vs-reclamation balance). */
export const DISCONNECT_GRACE_MS = 1_000

/** Per-attempt TCP connect timeout of the default port probe. */
export const PROBE_ATTEMPT_TIMEOUT_MS = 400

/** Tunable runtime behavior (tests pass small values). */
export interface TransportManagerOptions {
  readyTimeoutMs?: number
  probeIntervalMs?: number
  maxRetryAttempts?: number
  retryBaseMs?: number
  retryMaxMs?: number
  /**
   * Slow re-probe cadence after the fast retry burst is exhausted (default
   * SLOW_RETRY_MS): one fresh transport attempt per slowRetryMs, indefinite —
   * a transient failure never becomes a permanent give-up (only terminal
   * failures stop retrying, and they never reach this path).
   */
  slowRetryMs?: number
  disconnectGraceMs?: number
  ringBufferLimit?: number
  /** Provider exec timeout (ssh: systemctl; default 15s). */
  execTimeoutMs?: number
  /** Provider `run` exec timeout (ssh: dsh plugin/write-file; default 120s — pnpm hits the registry). */
  runExecTimeoutMs?: number
}

/** createTransportManager dependencies (provider/spawn/probe/allocator injectable). */
export interface TransportManagerDeps {
  provider: TransportProvider
  spawnFn?: (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess
  portProbe?: (port: number, opts?: { timeoutMs?: number; host?: string }) => Promise<boolean>
  /**
   * One-shot endpoint identity verification; defaults to the provider's
   * verifyUp. Runs after the transport probe reports the endpoint up and
   * before the phase may become ready. Injectable so tests can fake it.
   */
  verifyProbe?: (spec: TransportInstanceSpec, endpoint: TransportProbeEndpoint) => Promise<TransportVerifyResult>
  allocatePort?: () => Promise<number>
  /** Injectable RNG for the jittered reconnect backoff (tests pass a fixed value). */
  random?: () => number
  instancesFile: string
  logger?: { log?(message: string): void; warn?(message: string): void; error?(message: string): void }
  options?: TransportManagerOptions
}

/** Status-change listener: listener(instanceId, statusProjection). */
export type StatusChangedListener = (instanceId: string, status: TransportStatusProjection) => void

/**
 * Optional registry commit preparation. It runs after the complete proposal
 * has been validated and normalized, but before either file is changed. The
 * returned synchronous commit runs after the new registry file is durable
 * and before in-memory publication or transport restart. If it throws, the
 * previous registry file is restored and the old runtime remains untouched.
 */
export type PrepareRegistryCommit = (
  next: readonly TransportInstanceSpec[],
) => (() => void) | undefined

/** Synchronous registry delta projected with the instances-changed push. The
 * removed ids come from main's authoritative before/saved snapshots, so a
 * rapid remove→re-add cannot be erased by a superseding async roster pull. */
export function computeRemovedInstanceIds(
  before: readonly Pick<TransportInstanceSpec, 'id'>[],
  after: readonly Pick<TransportInstanceSpec, 'id'>[],
): string[] {
  const afterIds = new Set(after.map(instance => instance.id))
  const removed: string[] = []
  const seen = new Set<string>()
  for (const instance of before) {
    if (!afterIds.has(instance.id) && !seen.has(instance.id)) {
      seen.add(instance.id)
      removed.push(instance.id)
    }
  }
  return removed
}

/** Stored SSH passwords are credentials for an authentication endpoint, not
 * for a stable UI id. Deletion or an edit to host/user/sshPort retires the
 * old secret; label, forwarded remotePort and remote service/home changes do
 * not alter the SSH authentication peer and keep it. */
export function computePasswordRetirementIds(
  before: readonly Pick<TransportInstanceSpec, 'id' | 'host' | 'user' | 'sshPort'>[],
  after: readonly Pick<TransportInstanceSpec, 'id' | 'host' | 'user' | 'sshPort'>[],
): string[] {
  const afterById = new Map(after.map(instance => [instance.id, instance]))
  const retired: string[] = []
  const seen = new Set<string>()
  for (const previous of before) {
    if (seen.has(previous.id)) continue
    seen.add(previous.id)
    const current = afterById.get(previous.id)
    if (current === undefined
      || previous.host !== current.host
      || previous.user !== current.user
      || previous.sshPort !== current.sshPort) {
      retired.push(previous.id)
    }
  }
  return retired
}

/** Renderer lifecycle retirement is broader than deletion: changing the
 * transport identity behind a stable id must tear down the old N-ctx shell so
 * it cannot become transparently attached to a different host. Presentation
 * and service/home edits do not retire the shell. */
export function computeRetiredInstanceIds(
  before: readonly Pick<TransportInstanceSpec, 'id' | 'kind' | 'host' | 'user' | 'sshPort' | 'remotePort'>[],
  after: readonly Pick<TransportInstanceSpec, 'id' | 'kind' | 'host' | 'user' | 'sshPort' | 'remotePort'>[],
): string[] {
  const afterById = new Map(after.map(instance => [instance.id, instance]))
  const retired: string[] = []
  const seen = new Set<string>()
  for (const previous of before) {
    if (seen.has(previous.id)) continue
    seen.add(previous.id)
    const current = afterById.get(previous.id)
    if (current === undefined
      || previous.kind !== current.kind
      || previous.host !== current.host
      || previous.user !== current.user
      || previous.sshPort !== current.sshPort
      || previous.remotePort !== current.remotePort) {
      retired.push(previous.id)
    }
  }
  return retired
}

/** Registry persistence is already committed before the renderer push. A
 * synchronous BrowserWindow/navigation race is therefore a delivery miss,
 * never a failed save; callers log this result and rely on the next pull. */
export function attemptCommittedRegistryPush(push: () => void):
  | { sent: true }
  | { sent: false; error: string } {
  try {
    push()
    return { sent: true }
  } catch (error) {
    return { sent: false, error: describeTransportError(error) }
  }
}

/** The runtime surface returned by createTransportManager. */
export interface TransportManager {
  loadInstances(): TransportInstanceSpec[]
  saveInstances(next: TransportInstanceInput[], prepareCommit?: PrepareRegistryCommit): TransportInstanceSpec[]
  listInstances(): TransportInstanceSpec[]
  connect(id: string): TransportStatusProjection | null
  disconnect(id: string): void
  status(id: string): TransportStatusProjection | null
  /** The ready transport URL — INTERNAL ONLY (design 05 §8). */
  readyUrl(id: string): string | null
  logs(id: string): TransportLogEntry[]
  clearLogs(id: string): boolean
  /** Append one line to an instance's ring buffer from OUTSIDE the transport
   *  runtime (plugin-sync seed outcomes, …). Returns false for an unknown id. */
  appendLog(id: string, level: TransportLogEntry['level'], message: string): boolean
  /** Provider exec channel (ssh: remote systemd start/stop/restart/is-active; run = whitelisted remote command, design 13 §4.1). */
  exec(id: string, action: TransportExecAction, payload?: TransportRunPayload): Promise<TransportExecResult>
  onStatusChanged(listener: StatusChangedListener): () => void
  dispose(): void
  /** dispose() + wait for every SIGKILL escalation to resolve (app quit). */
  disposeAsync(): Promise<void>
}

/** Internal per-instance runtime state (phase machine + logs; never persisted). */
interface InstanceState {
  phase: TransportPhase
  localPort: number | null
  child: SpawnedProcess | null
  childExited: boolean
  authFailed: boolean
  retryAttempt: number
  requiresUserAction: boolean
  serviceActive: boolean | null
  logSummary: string
  reconnectTimer: ReturnType<typeof setTimeout> | null
  /** Provider exec children owned by this exact registry incarnation. */
  execChildren: Set<SpawnedProcess>
  /** Operational exec incarnation, independent from the live tunnel. */
  execEpoch: number
  readyLoop: AbortController | null
  logs: TransportLogEntry[]
  /** Monotonic transport attempt counter: stale startTransport invocations and
   *  delayed exits of replaced children are recognized and ignored. */
  tunnelEpoch: number
}

/** Error that may carry a machine-readable code. */
interface CodedError extends Error {
  code?: string
}

/** Exception-safe formatter for provider hooks, injected deps and event data.
 * Catch blocks are part of the state machine and must themselves never throw. */
export function describeTransportError(value: unknown): string {
  try {
    if (value instanceof Error && typeof value.message === 'string' && value.message !== '') return value.message
  } catch { /* hostile Error proxy/getter */ }
  try {
    const text = String(value)
    return text === '' ? 'unknown error' : text
  } catch {
    return 'unknown error'
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Atomic write mirroring the control-plane json-store protocol in plain
 * node:fs: write .tmp → fsync → rename (the shared .tmp path never has two
 * concurrent writers because the runtime serializes all writes through
 * saveInstances).
 */
function writeFileAtomic(filePath: string, text: string) {
  const tmpPath = `${filePath}.tmp`
  mkdirSync(dirname(filePath), { recursive: true })
  const fd = openSync(tmpPath, 'w')
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, filePath)
}

/** Allocate a free local port via net listen(0). */
function allocateLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

/** Default readiness probe: one bounded TCP connect to host:port (loopback default). */
function defaultPortProbe(port: number, { timeoutMs = PROBE_ATTEMPT_TIMEOUT_MS, host = '127.0.0.1' }: { timeoutMs?: number; host?: string } = {}): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ port, host })
    socket.unref()
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * Create the transport runtime for one provider.
 * @param deps - {provider, spawnFn?, portProbe?, allocatePort?, random?,
 *   instancesFile, logger?, options?}. The provider owns source-specific
 *   validation/argv/classification/exec; everything else is generic.
 * @returns {loadInstances(), saveInstances(), listInstances(), connect(),
 *   disconnect(), status(), readyUrl(), logs(), clearLogs(), exec(),
 *   onStatusChanged(), dispose()}.
 */
export function createTransportManager({ provider, spawnFn, portProbe, verifyProbe, allocatePort, random, instancesFile, logger, options = {} }: TransportManagerDeps): TransportManager {
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
  const probeIntervalMs = options.probeIntervalMs ?? PROBE_INTERVAL_MS
  const maxRetryAttempts = options.maxRetryAttempts ?? MAX_RETRY_ATTEMPTS
  const retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS
  const retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS
  const slowRetryMs = options.slowRetryMs ?? SLOW_RETRY_MS
  const disconnectGraceMs = options.disconnectGraceMs ?? DISCONNECT_GRACE_MS
  const ringBufferLimit = options.ringBufferLimit ?? RING_BUFFER_LIMIT
  const execTimeoutMs = options.execTimeoutMs ?? 15_000
  const runExecTimeoutMs = options.runExecTimeoutMs ?? 120_000
  // Explicit annotation: `spawnFn ?? default` would otherwise infer a UNION
  // of call signatures (SpawnedProcess | ChildProcess), making `child.on`
  // uncallable at the call sites.
  const doSpawn: (command: string, args: readonly string[], opts: SpawnOptions) => SpawnedProcess =
    spawnFn ?? ((command: string, args: readonly string[], opts: SpawnOptions) => spawn(command, args, opts))
  const doProbe = portProbe ?? defaultPortProbe
  const doVerify = verifyProbe ?? provider.verifyUp
  const doAllocate = allocatePort ?? allocateLocalPort
  const doRandom = random ?? Math.random
  const loggerLog = logger?.log
  const log = typeof loggerLog === 'function' ? (message: string) => loggerLog(message) : () => {}
  const loggerWarn = logger?.warn
  const warn = typeof loggerWarn === 'function' ? (message: string) => loggerWarn(message) : () => {}

  /** instanceId → spec ({id, label, kind, host, user, remotePort}). */
  const instances = new Map<string, TransportInstanceSpec>()
  /** instanceId → runtime state (phase machine + logs; never persisted). */
  const states = new Map<string, InstanceState>()
  /** In-flight provider exec children, SIGTERMed by dispose() (app quit). */
  const execChildren = new Set<SpawnedProcess>()
  /** Teardown gate: after dispose starts, no path may create a new child. */
  let disposed = false
  /** Transport-child SIGTERM → SIGKILL timers outlive registry retirement.
   * Keeping them manager-global means deleting an InstanceState cannot lose
   * cleanup ownership during immediate same-id re-add or app quit. */
  const killEscalations = new Map<SpawnedProcess, ReturnType<typeof setTimeout>>()
  const bus = new EventEmitter()

  function sameOperationalSpec(left: TransportInstanceSpec | undefined, right: TransportInstanceSpec): boolean {
    return left !== undefined
      && left.id === right.id
      && left.kind === right.kind
      && left.host === right.host
      && left.user === right.user
      && left.sshPort === right.sshPort
      && left.remotePort === right.remotePort
      && left.serviceName === right.serviceName
      && left.remoteDshHome === right.remoteDshHome
  }

  function ensureState(id: string): InstanceState {
    let state = states.get(id)
    if (state === undefined) {
      state = {
        phase: 'idle',
        localPort: null,
        child: null,
        childExited: false,
        authFailed: false,
        retryAttempt: 0,
        requiresUserAction: false,
        serviceActive: null,
        logSummary: '',
        reconnectTimer: null,
        execChildren: new Set(),
        execEpoch: 0,
        readyLoop: null,
        logs: [],
        tunnelEpoch: 0,
      }
      states.set(id, state)
    }
    return state
  }

  function appendLogInternal(state: InstanceState, level: TransportLogEntry['level'], message: string) {
    const retainedMessage = message.length <= RING_LOG_MESSAGE_MAX_CHARS
      ? message
      : `${message.slice(0, RING_LOG_MESSAGE_MAX_CHARS - RING_LOG_TRUNCATION_SUFFIX.length)}${RING_LOG_TRUNCATION_SUFFIX}`
    state.logs.push({ ts: Date.now(), level, message: retainedMessage })
    if (state.logs.length > ringBufferLimit) {
      state.logs.splice(0, state.logs.length - ringBufferLimit)
    }
  }

  /** State object identity is the registry-incarnation token. Removal deletes
   * it from `states`; a same-id re-add gets a different object, so every old
   * async closure can cheaply prove it no longer owns projection/log writes. */
  function isCurrentState(id: string, state: InstanceState): boolean {
    return states.get(id) === state && instances.has(id)
  }

  /** Broadcast the non-secret status projection to status-changed listeners. */
  function emitStatus(id: string, expectedState?: InstanceState) {
    if (expectedState !== undefined && !isCurrentState(id, expectedState)) return
    const projection = status(id)
    if (projection === null) return
    for (const listener of bus.listeners('status-changed')) {
      try {
        listener(id, projection)
      } catch (listenerError) {
        warn(`transport-manager status listener threw: ${describeTransportError(listenerError)}`)
      }
    }
  }

  /** Set phase/logSummary and broadcast (only on actual change). */
  function transition(id: string, next: TransportPhase, summary: string | undefined, expectedState: InstanceState) {
    if (!isCurrentState(id, expectedState)) return
    const state = expectedState
    const changed = state.phase !== next || (summary !== undefined && state.logSummary !== summary)
    if (!changed) return
    if (state.phase !== next) {
      log(`transport-manager: ${id} ${state.phase} → ${next}${summary ? ` (${summary})` : ''}`)
      state.phase = next
    }
    if (summary !== undefined) state.logSummary = summary
    emitStatus(id, state)
  }

  function stopReadyLoop(state: InstanceState) {
    if (state.readyLoop !== null) {
      state.readyLoop.abort()
      state.readyLoop = null
    }
  }

  /** Best-effort SIGTERM (or SIGKILL for the disconnect grace escalation). */
  function signalChild(child: SpawnedProcess | null, signal: NodeJS.Signals) {
    if (child === null) return
    try {
      child.kill(signal)
    } catch { /* already gone */ }
  }

  /**
   * Arm the SIGTERM → SIGKILL escalation for ONE specific child (per-child
   * tracking: only that child's exit may clear it, and arming another
   * child's escalation never cancels a pending one — a SIGTERM-ignoring
   * child always gets its SIGKILL).
   */
  function armKillEscalation(child: SpawnedProcess) {
    const previous = killEscalations.get(child)
    if (previous !== undefined) clearTimeout(previous)
    const timer = setTimeout(() => {
      killEscalations.delete(child)
      signalChild(child, 'SIGKILL')
    }, disconnectGraceMs)
    timer.unref?.()
    killEscalations.set(child, timer)
  }

  function clearKillEscalation(child: SpawnedProcess) {
    const escalation = killEscalations.get(child)
    if (escalation === undefined) return
    clearTimeout(escalation)
    killEscalations.delete(child)
  }

  /**
   * Terminal failure (auth, spawn, deterministic endpoint verification):
   * stop the recovery machinery and land on error with
   * requiresUserAction=true. Never auto-retried — the user must act (fix
   * credentials, host keys, the transport binary, or a destination that
   * answered the probe but is not a dsh instance).
   */
  function failTerminal(id: string, state: InstanceState, message: string) {
    if (!isCurrentState(id, state)) return
    if (state.phase === 'error') return
    if (state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }
    stopReadyLoop(state)
    if (state.child !== null) {
      signalChild(state.child, 'SIGTERM')
      armKillEscalation(state.child)
    }
    state.child = null
    state.localPort = null
    state.retryAttempt = 0
    state.requiresUserAction = true
    transition(id, 'error', message, state)
    appendLogInternal(state, 'error', message)
  }

  /**
   * Bounded reconnect scheduling: land on degraded, then start a fresh
   * transport after a jittered exponential backoff (retryBaseMs * 2^(n-1)
   * with half-open jitter, capped). The attempt bound (maxRetryAttempts)
   * bounds the FAST burst; a fresh connect() resets the counter.
   *
   * When the burst is exhausted the machine lands on error but keeps an
   * indefinite SLOW re-probe (one fresh transport attempt per slowRetryMs):
   * transient conditions are time-dependent, so a recovered condition must be
   * picked up automatically without user action. Only TERMINAL failures stop
   * retrying — they never reach here (failTerminal). A manual connect()/
   * disconnect() cancels the pending probe (reconnectTimer is shared).
   */
  function scheduleReconnect(id: string, state: InstanceState, reason: string) {
    if (!isCurrentState(id, state)) return
    if (state.reconnectTimer !== null) return
    if (state.retryAttempt >= maxRetryAttempts) {
      // 与快速路径同款清理：耗尽可能经 ready-loop 超时 / 验证失败路径到达，
      // 彼时子进程还活着——不留僵尸隧道与过期 localPort 投影（下个慢速重探
      // 的 startTransport 也会 SIGTERM 它，但 60s 窗口不该由错误态背负）。
      stopReadyLoop(state)
      if (state.child !== null) {
        signalChild(state.child, 'SIGTERM')
        armKillEscalation(state.child)
      }
      state.child = null
      state.localPort = null
      transition(id, 'error', `transport failed: max retry attempts exceeded (${reason}); retrying periodically`, state)
      appendLogInternal(state, 'error', `max retry attempts exceeded (${reason}); slow re-probe in ${slowRetryMs}ms`)
      // The phase stays error (honest red state — the probe is background
      // recovery, never a permanent spinner); each fire runs ONE fresh
      // attempt through the normal machine (startTransport), and success
      // lands ready and resets the counters. requiresUserAction stays false:
      // this is not a user-action failure.
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null
        if (!isCurrentState(id, state)) return
        void startTransport(id).catch(error => warn(`transport-manager: slow re-probe rejected: ${describeTransportError(error)}`))
      }, slowRetryMs)
      state.reconnectTimer.unref?.()
      return
    }
    stopReadyLoop(state)
    if (state.child !== null) {
      signalChild(state.child, 'SIGTERM')
      armKillEscalation(state.child)
    }
    state.child = null
    state.localPort = null
    state.retryAttempt += 1
    // A throwing injected RNG must never crash the main process from the
    // child-exit event handler (uncaughtException) — fall back to the raw
    // backoff instead.
    let backoff: number
    try {
      backoff = jitteredBackoffMs(Math.min(retryBaseMs * 2 ** (state.retryAttempt - 1), retryMaxMs), doRandom)
    } catch (randomError) {
      warn(`transport-manager: injected random threw: ${describeTransportError(randomError)}`)
      backoff = Math.min(retryBaseMs * 2 ** (state.retryAttempt - 1), retryMaxMs)
    }
    appendLogInternal(state, 'warn', `reconnect in ${backoff}ms (attempt ${state.retryAttempt}/${maxRetryAttempts}): ${reason}`)
    transition(id, 'degraded', reason, state)
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null
      if (!isCurrentState(id, state)) return
      void startTransport(id).catch(error => warn(`transport-manager: startTransport rejected: ${describeTransportError(error)}`))
    }, backoff)
    state.reconnectTimer.unref?.()
  }

  /**
   * The transport process exit handler. While idle (after disconnect) it is
   * ignored; a provider-classified auth failure is terminal (failTerminal); a
   * ready transport that drops, or one that died before coming up, enters
   * the bounded reconnect path. An exit of a REPLACED child
   * (disconnect/restart/failTerminal already nulled state.child and possibly
   * started a new transport) is ignored — its delayed SIGTERM exit must
   * never kill or degrade the fresh transport.
   */
  function onChildExit(id: string, state: InstanceState, child: SpawnedProcess, code: number | null, signal: NodeJS.Signals | null) {
    // Clear the SIGKILL escalation ONLY for THIS exiting child (per-child
    // tracking — an unrelated child's exit never cancels another's).
    clearKillEscalation(child)
    if (!isCurrentState(id, state)) return
    if (state.child !== child) return
    state.child = null
    state.childExited = true
    log(`transport-manager: ${id} transport process exited (${code ?? signal})`)
    appendLogInternal(state, 'warn', `transport process exited (${code ?? signal})`)
    if (state.phase === 'idle' || state.phase === 'error') return
    if (state.authFailed || state.requiresUserAction) {
      failTerminal(id, state, 'authentication failed — requires user action')
      return
    }
    if (state.phase === 'ready') {
      scheduleReconnect(id, state, `transport dropped (exit ${code ?? signal})`)
      return
    }
    scheduleReconnect(id, state, `transport failed before ready (exit ${code ?? signal})`)
  }

  /**
   * Start one transport attempt and drive it to ready/degraded/error. The
   * readiness detection polls the local tunnel (probeIntervalMs) up to
   * readyTimeoutMs; accepting a connection plus protocol verification is the
   * honest "up" signal.
   */
  async function startTransport(id: string) {
    if (disposed) return
    const spec = instances.get(id)
    if (spec === undefined) return
    const state = ensureState(id)
    // A ready transport is not re-started; an already-connecting invocation
    // is idempotent (connect() is the only other entry and it refuses while
    // connecting/ready, so no double start can originate there).
    if (state.phase === 'ready') return
    stopReadyLoop(state)
    if (state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }
    if (state.child !== null) {
      signalChild(state.child, 'SIGTERM')
      armKillEscalation(state.child)
    }
    state.childExited = false
    state.authFailed = false
    state.requiresUserAction = false
    // This invocation IS the transport attempt (connect or the scheduled
    // reconnect): bump the epoch so any in-flight invocation of a previous
    // attempt (disconnect → reconnect restarts, spec-edit restarts) aborts
    // at its next guard instead of starting/stealing a second transport.
    state.tunnelEpoch += 1
    const epoch = state.tunnelEpoch
    // The connecting phase is entered here so the post-await guards and the
    // readiness-detection loop have a stable anchor.
    transition(id, 'connecting', 'starting transport', state)

    let localPort: number
    try {
      localPort = await doAllocate()
    } catch (allocateError) {
      if (state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
      const detail = describeTransportError(allocateError)
      transition(id, 'error', `failed to allocate a local port: ${detail}`, state)
      appendLogInternal(state, 'error', `port allocation failed: ${detail}`)
      // Port exhaustion is transient. Keep one slow retry instead of leaving
      // the instance permanently wedged in error.
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null
        if (!isCurrentState(id, state)) return
        void startTransport(id).catch(error => warn(`transport-manager: slow re-probe rejected: ${describeTransportError(error)}`))
      }, slowRetryMs)
      state.reconnectTimer.unref?.()
      return
    }
    if (state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
    state.localPort = localPort

    let args: readonly string[]
    try {
      args = provider.buildStartArgs(spec, localPort)
    } catch (buildError) {
      const detail = describeTransportError(buildError)
      warn(`transport-manager: provider.buildStartArgs threw: ${detail}`)
      transition(id, 'error', `provider build failed: ${detail}`, state)
      if (isCurrentState(id, state)) appendLogInternal(state, 'error', `provider buildStartArgs threw: ${detail}`)
      return
    }
    const probeTarget = { host: '127.0.0.1', port: localPort }

    let transportEnv: NodeJS.ProcessEnv | null = null
    if (provider.buildStartEnv !== undefined) {
      try {
        transportEnv = provider.buildStartEnv(spec)
      } catch (envError) {
        const detail = describeTransportError(envError)
        warn(`transport-manager: provider.buildStartEnv threw: ${detail}`)
        transition(id, 'error', `provider buildStartEnv threw: ${detail}`, state)
        if (isCurrentState(id, state)) appendLogInternal(state, 'error', `provider buildStartEnv threw: ${detail}`)
        return
      }
    }
    let child: SpawnedProcess
    try {
      child = doSpawn('ssh', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: transportEnv === null ? undefined : { ...process.env, ...transportEnv },
      })
    } catch (spawnError) {
      state.requiresUserAction = true
      failTerminal(id, state, `failed to spawn transport: ${describeTransportError(spawnError)}`)
      return
    }
    if (state.phase !== 'connecting' || epoch !== state.tunnelEpoch) {
      signalChild(child, 'SIGTERM')
      return
    }
    state.child = child
    transition(id, 'connecting', `spawning ${args[0]} ${args.slice(1).join(' ')}`, state)

    const outputOverflow = () => appendLogInternal(
      state,
      'error',
      `transport output line dropped: exceeds ${CHILD_LINE_MAX_CHARS} characters`,
    )
    const classifyOutput = (line: string, detectAuth: boolean): void => {
      let logLine: string
      let terminalAuth = false
      try {
        const classified = provider.classifyStderr(line)
        logLine = classified.log
        terminalAuth = detectAuth && classified.terminalAuth
      } catch {
        // The classifier is the credential-redaction boundary. Its exception
        // may quote the sensitive input, so emit only a fixed diagnostic.
        warn('transport-manager: provider.classifyStderr threw; output dropped')
        appendLogInternal(state, 'error', 'transport output dropped: provider classifier failed')
        return
      }
      if (logLine === '') return
      appendLogInternal(state, 'info', logLine)
      if (terminalAuth) {
        state.authFailed = true
        appendLogInternal(state, 'error', 'authentication failure detected (requires user action)')
      }
    }
    const processStdout = createBoundedLineProcessor(line => classifyOutput(line, false), outputOverflow)
    const processStderr = createBoundedLineProcessor(line => classifyOutput(line, true), outputOverflow)
    child.stdout?.on('data', chunk => {
      if (state.child === child) processStdout(String(chunk))
    })
    child.stderr?.on('data', chunk => {
      if (state.child === child) processStderr(String(chunk))
    })
    child.on('exit', (code, exitSignal) => {
      if (state.child === child) {
        processStdout('\n')
        processStderr('\n')
      }
      onChildExit(id, state, child, code, exitSignal)
    })
    child.on('error', error => {
      if (state.child !== child) return
      const detail = describeTransportError(error)
      appendLogInternal(state, 'error', `transport spawn error: ${detail}`)
      state.requiresUserAction = true
      failTerminal(id, state, `failed to spawn transport: ${detail}`)
    })

    const controller = new AbortController()
    state.readyLoop = controller
    const deadline = Date.now() + readyTimeoutMs
    void (async () => {
      while (!controller.signal.aborted) {
        if (state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
        if (state.authFailed) return failTerminal(id, state, 'authentication failed — requires user action')
        if (state.childExited) return
        // A rejecting probe must never hang the machine in connecting or
        // crash the loop — a probe failure is simply "not up yet".
        const up = await doProbe(probeTarget.port, { host: probeTarget.host }).catch(() => false)
        if (controller.signal.aborted || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
        if (up) {
          // TCP-up is not an honest "the destination is dsh" signal: ANY
          // service on the destination port would accept the connection.
          // Verify the endpoint actually answers the destination protocol
          // before declaring ready — a non-dsh service on the remote port
          // must never present as a ready instance (fake connection).
          if (doVerify !== undefined) {
            let verification: TransportVerifyResult
            try {
              verification = await doVerify(spec, probeTarget)
            } catch (verifyError) {
              // A throwing verifier must never hang the machine in
              // connecting or crash the loop — loud degraded path instead.
              warn(`transport-manager: endpoint verification threw: ${describeTransportError(verifyError)}`)
              verification = { ok: false, detail: 'endpoint verification failed' }
            }
            if (controller.signal.aborted || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
            // An auth failure that landed while the verification was in
            // flight must stay terminal — never fall through to a reconnect.
            if (state.authFailed) return failTerminal(id, state, 'authentication failed — requires user action')
            if (!verification.ok) {
              const reason = verification.detail ?? 'the endpoint is not a dsh instance'
              appendLogInternal(state, 'warn', reason)
              // A DETERMINISTIC verification failure (the destination
              // answered the probe and proved it is not a compatible dsh —
              // wrong version / wrong protocol / a non-dsh service) is
              // terminal: retrying cannot change the answer, so it lands on
              // error immediately instead of burning the bounded reconnect
              // cycle (and its UI flicker) on a failure that will repeat.
              // Only transient failures (connection error, timeout) enter
              // the reconnect path.
              if (verification.terminal === true) return failTerminal(id, state, reason)
              return scheduleReconnect(id, state, reason)
            }
          }
          if (!state.childExited && state.child !== null) {
            state.retryAttempt = 0
            state.requiresUserAction = false
            transition(id, 'ready', 'transport is up', state)
            appendLogInternal(state, 'info', `transport ready on 127.0.0.1:${localPort}`)
          }
          return
        }
        if (Date.now() >= deadline) {
          // An auth failure that landed while the final probe was in flight
          // must stay terminal — never fall through to a reconnect.
          if (state.authFailed) return failTerminal(id, state, 'authentication failed — requires user action')
          if (state.childExited) return
          appendLogInternal(state, 'warn', `transport did not come up within ${readyTimeoutMs}ms`)
          return scheduleReconnect(id, state, 'transport did not come up in time')
        }
        await sleep(probeIntervalMs)
      }
    })().catch(error => warn(`transport-manager ready loop rejected: ${describeTransportError(error)}`))
  }

  /** Provider exec channel (ssh: one remote systemd exec). */
  async function exec(id: string, action: TransportExecAction, payload?: TransportRunPayload): Promise<TransportExecResult> {
    if (disposed) return { ok: false, error: 'transport manager is disposed' }
    const spec = instances.get(id)
    if (spec === undefined) {
      return { ok: false, error: 'ssh instance not found' }
    }
    if (provider.exec === undefined) {
      return { ok: false, error: `exec not supported by transport kind ${spec.kind}` }
    }
    const state = ensureState(id)
    const execEpoch = state.execEpoch
    const isCurrentExecOwner = () => isCurrentState(id, state) && state.execEpoch === execEpoch
    // Wrap the spawn so in-flight exec children are tracked and SIGTERMed by
    // dispose() (app quit) instead of being orphaned mid-network-blackhole.
    const trackedSpawn = (command: string, args: readonly string[], spawnOptions: SpawnOptions) => {
      const child = doSpawn(command, args, spawnOptions)
      execChildren.add(child)
      state.execChildren.add(child)
      child.on('exit', () => {
        clearKillEscalation(child)
        execChildren.delete(child)
        state.execChildren.delete(child)
      })
      return child
    }
    try {
      const result = await provider.exec(spec, action, {
        spawnFn: trackedSpawn,
        execTimeoutMs,
        runTimeoutMs: runExecTimeoutMs,
        disconnectGraceMs,
        log: (level, message) => {
          if (isCurrentExecOwner()) appendLogInternal(state, level, message)
        },
        setProjection: (execId, key, value) => {
          if (execId === id && isCurrentExecOwner() && key === 'serviceActive') {
            state.serviceActive = value
            emitStatus(id, state)
          }
        },
        projection: execId => execId === id && isCurrentExecOwner() ? status(id) : null,
      }, payload)
      // Removal or an ownership-changing same-id edit retires the captured
      // state before installing a fresh one. Even if a provider resolves after
      // ignoring SIGTERM, its old result must never borrow the new registry
      // incarnation's status/projection or present as a successful operation.
      if (!isCurrentExecOwner() || !sameOperationalSpec(instances.get(id), spec)) {
        return { ok: false, error: 'ssh instance changed while exec was in progress' }
      }
      return result
    } catch (execError) {
      // A throwing/rejecting provider must never escape through the IPC layer
      // as an unhandled rejection — loud error result instead.
      const detail = describeTransportError(execError)
      return { ok: false, error: `exec failed: ${detail}` }
    }
  }

  /** Load the persisted instance set; a missing file is an empty set. */
  function loadInstances(): TransportInstanceSpec[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(instancesFile, 'utf8'))
    } catch (error: unknown) {
      if ((error as CodedError | undefined)?.code === 'ENOENT') return listInstances()
      // Corrupt instance file: loud failure, never a fake-empty set (mirrors
      // the json-store "corrupt is never a fake-empty" invariant). The caller
      // (desktop main) preserves the file before starting empty.
      const wrapped: CodedError = new Error(`ssh-instances file is corrupt: ${describeTransportError(error)}`)
      wrapped.code = 'ssh_instances_corrupt'
      throw wrapped
    }
    if (!Array.isArray(parsed)) {
      const wrapped: CodedError = new Error('ssh-instances file does not contain an array')
      wrapped.code = 'ssh_instances_corrupt'
      throw wrapped
    }
    if (parsed.length > MAX_TRANSPORT_INSTANCES) {
      const wrapped: CodedError = new Error(`ssh-instances file exceeds the ${MAX_TRANSPORT_INSTANCES}-instance limit`)
      wrapped.code = 'ssh_instances_too_many'
      throw wrapped
    }
    const dropped: unknown[] = []
    const seenIds = new Set<string>()
    let duplicates = 0
    for (const entry of parsed) {
      const normalized = provider.validateSpec(entry)
      if (normalized === null || normalized.kind !== provider.kind) {
        dropped.push(entry)
        continue
      }
      if (seenIds.has(normalized.id)) {
        // Duplicate persisted ids: first wins (last-wins would silently flip
        // the registry vs the file); loud, never silent.
        duplicates += 1
        continue
      }
      seenIds.add(normalized.id)
      instances.set(normalized.id, normalized)
    }
    if (dropped.length > 0) warn(`transport-manager: dropped ${dropped.length} invalid instance(s) from ${instancesFile}`)
    if (duplicates > 0) warn(`transport-manager: dropped ${duplicates} duplicate id(s) from ${instancesFile} (first wins)`)
    return listInstances()
  }

  /**
   * Persist a new instance set (atomic write) and align the registry:
   * instances that disappeared from the set have their transports
   * disconnected and are removed; the set becomes exactly `next`. Save is an
   * atomic proposal: one invalid/kind-mismatched entry or duplicate id rejects
   * the whole replacement before persistence or live transport mutation.
   * (Load-time recovery remains lenient for a damaged existing file.)
   * Instances whose operational parameters (host/user/ports/service/home)
   * changed retire their old async ownership; a previously-live transport is
   * restarted so the transport and projection never disagree.
   * @returns the persisted instance list.
   */
  function saveInstances(next: TransportInstanceInput[], prepareCommit?: PrepareRegistryCommit): TransportInstanceSpec[] {
    if (!Array.isArray(next)) {
      const error: CodedError = new Error('instances must be an array')
      error.code = 'ssh_instances_invalid'
      throw error
    }
    if (next.length > MAX_TRANSPORT_INSTANCES) {
      const error: CodedError = new Error(`instances exceed the ${MAX_TRANSPORT_INSTANCES}-instance limit`)
      error.code = 'ssh_instances_too_many'
      throw error
    }
    const kept: TransportInstanceSpec[] = []
    const restartIds: string[] = []
    const replaceStateIds: string[] = []
    const resetExecIds: string[] = []
    const seenIds = new Set<string>()
    for (const [index, entry] of next.entries()) {
      const normalized = provider.validateSpec(entry)
      if (normalized === null || normalized.kind !== provider.kind) {
        const error: CodedError = new Error(`instance at index ${index} is invalid for transport kind ${provider.kind}`)
        error.code = 'ssh_instances_invalid'
        throw error
      }
      if (seenIds.has(normalized.id)) {
        const error: CodedError = new Error(`duplicate instance id at index ${index}`)
        error.code = 'ssh_instances_duplicate'
        throw error
      }
      seenIds.add(normalized.id)
      const previous = instances.get(normalized.id)
      const state = previous === undefined ? undefined : states.get(normalized.id)
      const transportIdentityChanged = previous !== undefined && (previous.host !== normalized.host
        || previous.user !== normalized.user
        || previous.sshPort !== normalized.sshPort
        || previous.remotePort !== normalized.remotePort)
      const execIdentityChanged = transportIdentityChanged || (previous !== undefined
        && (previous.serviceName !== normalized.serviceName
          || previous.remoteDshHome !== normalized.remoteDshHome))
      if (transportIdentityChanged && state !== undefined) {
        // The state object is the async ownership token, so a transport edit
        // must replace it even while the tunnel is idle: provider exec can be
        // in flight independently of tunnel phase.
        replaceStateIds.push(normalized.id)
        if (state.phase !== 'idle') restartIds.push(normalized.id)
      } else if (execIdentityChanged && state !== undefined) {
        resetExecIds.push(normalized.id)
      }
      kept.push(normalized)
    }
    // The optional coordinator validates against defensive copies of the
    // COMPLETE normalized proposal before any durable change. It returns a
    // synchronous write-through operation to run at the publication barrier.
    const commit = prepareCommit?.(kept.map(entry => ({ ...entry })))
    const previous = listInstances()
    // Persist BEFORE mutating the in-memory registry: a failed write throws
    // while the registry (and every live transport) stays untouched, so the
    // runtime and the UI never diverge on a partial save. A coordinated
    // secondary store commits next; only then may transports observe/restart
    // under the new registry incarnation.
    writeFileAtomic(instancesFile, `${JSON.stringify(kept, undefined, 2)}\n`)
    try {
      commit?.()
    } catch (commitError) {
      try {
        writeFileAtomic(instancesFile, `${JSON.stringify(previous, undefined, 2)}\n`)
      } catch (rollbackError) {
        const error: CodedError = new Error(
          `registry commit failed and the previous registry could not be restored: ${describeTransportError(rollbackError)}`,
          { cause: commitError },
        )
        error.code = 'transport_registry_commit_incomplete_rollback'
        throw error
      }
      throw commitError
    }
    const nextIds = new Set(kept.map(entry => entry.id))
    for (const id of [...instances.keys()]) {
      if (!nextIds.has(id)) {
        log(`transport-manager: instance ${id} removed from the set; disconnecting its transport`)
        retireInstance(id)
        instances.delete(id)
      }
    }
    // Same-id transport edits are registry-incarnation changes too. Retire
    // under the OLD spec before replacing `instances`, so provider auth and
    // all old tunnel/exec children are cleaned against their true owner.
    for (const id of replaceStateIds) {
      log(`transport-manager: instance ${id} transport parameters changed; retiring its previous runtime state`)
      retireInstance(id)
    }
    // serviceName/remoteDshHome edit changes remote-operation ownership but
    // not the tunnel endpoint. Revoke/kill exec in place and clear its
    // projection while preserving the ready transport and shell connection.
    for (const id of resetExecIds) resetExecIncarnation(id)
    instances.clear()
    for (const entry of kept) instances.set(entry.id, entry)
    // A previously-live transport starts from a fresh state under the new
    // spec. Idle edited instances remain lazy, but their next status/exec is
    // equally fresh because the old state was retired above.
    for (const id of restartIds) {
      log(`transport-manager: instance ${id} transport parameters changed; restarting its transport`)
      connect(id)
    }
    return listInstances()
  }

  /** The current instance set (non-secret metadata). */
  function listInstances(): TransportInstanceSpec[] {
    return [...instances.values()].map(spec => ({ ...spec }))
  }

  /**
   * Start (or restart) the transport for one instance. Idempotent while
   * already connecting/ready; a manual connect from error/degraded resets
   * the retry counter and clears the pending reconnect.
   * @returns the status projection.
   */
  function connect(id: string): TransportStatusProjection | null {
    if (disposed) return status(id)
    if (!instances.has(id)) {
      const error: CodedError = new Error('ssh instance not found')
      error.code = 'ssh_instance_not_found'
      throw error
    }
    const state = ensureState(id)
    if (state.phase === 'connecting' || state.phase === 'ready') return status(id)
    if (state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }
    state.retryAttempt = 0
    state.requiresUserAction = false
    transition(id, 'connecting', 'starting transport', state)
    void startTransport(id).catch(error => warn(`transport-manager: startTransport rejected: ${describeTransportError(error)}`))
    return status(id)
  }

  /**
   * Stop the transport: cancel pending reconnects, SIGTERM the process
   * (then SIGKILL after the grace period), land on idle. The phase machine
   * and logs stay; the local port is released on the next connect.
   */
  function disconnect(id: string) {
    const state = states.get(id)
    if (state === undefined) return
    if (state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }
    stopReadyLoop(state)
    if (state.child !== null) {
      const child = state.child
      state.child = null
      signalChild(child, 'SIGTERM')
      armKillEscalation(child)
    }
    // Provider-owned per-instance resources (ssh: the ephemeral askpass
    // helper) are released with the transport; the in-memory password
    // itself survives a plain disconnect so the user can reconnect without
    // retyping — it is only cleared by setSshPassword(null), instance
    // removal, or app quit.
    const spec = instances.get(id)
    if (spec !== undefined) provider.disposeAuth?.(spec)
    state.localPort = null
    state.retryAttempt = 0
    state.requiresUserAction = false
    transition(id, 'idle', 'disconnected', state)
    appendLogInternal(state, 'info', 'disconnected')
  }

  /** Permanently retire one registry incarnation. Unlike plain disconnect,
   * this revokes every old async writer and drops all reusable projections/
   * logs. Cleanup timers remain manager-owned until their child exits/fires. */
  function retireInstance(id: string): void {
    const state = states.get(id)
    if (state === undefined) {
      const spec = instances.get(id)
      if (spec !== undefined) provider.disposeAuth?.(spec)
      return
    }
    disconnect(id)
    // Provider exec is scoped to the registry incarnation too. Terminate any
    // live subprocess; its provider Promise may still settle, but the identity
    // guards above make all late log/projection calls inert.
    resetExecIncarnation(id)
    state.tunnelEpoch += 1
    state.logs.length = 0
    state.logSummary = ''
    state.serviceActive = null
    states.delete(id)
  }

  function resetExecIncarnation(id: string): void {
    const state = states.get(id)
    if (state === undefined) return
    for (const child of state.execChildren) {
      signalChild(child, 'SIGTERM')
      armKillEscalation(child)
    }
    state.execChildren.clear()
    state.execEpoch += 1
    if (state.serviceActive !== null) {
      state.serviceActive = null
      emitStatus(id, state)
    }
  }

  /**
   * The non-secret status projection (design 05 §8): kind, phase, localPort,
   * sshPort, remotePort, retryAttempt, requiresUserAction, serviceActive,
   * logSummary. Never a transport URL, never credential material. null for
   * an unknown instance.
   */
  function status(id: string): TransportStatusProjection | null {
    const spec = instances.get(id)
    if (spec === undefined) return null
    const state = ensureState(id)
    return {
      kind: spec.kind,
      phase: state.phase,
      localPort: state.localPort,
      sshPort: spec.sshPort,
      remotePort: spec.remotePort,
      retryAttempt: state.retryAttempt,
      requiresUserAction: state.requiresUserAction,
      serviceActive: state.serviceActive,
      remoteDshHome: spec.remoteDshHome,
      logSummary: state.logSummary,
    }
  }

  /**
   * The ready transport URL — INTERNAL ONLY, never exposed through status()
   * or the IPC surface (design 05 §8: the renderer builds webview URLs from
   * localPort alone). Returns null unless the local tunnel is ready.
   */
  function readyUrl(id: string): string | null {
    const state = states.get(id)
    if (state?.phase !== 'ready') return null
    return state.localPort === null ? null : `http://127.0.0.1:${state.localPort}`
  }

  /** Ring-buffer log lines for one instance (copies; newest last). */
  function logs(id: string): TransportLogEntry[] {
    const state = states.get(id)
    if (state === undefined) return []
    return state.logs.map(entry => ({ ...entry }))
  }

  /** Clear one instance's ring buffer. */
  function clearLogs(id: string): boolean {
    const state = states.get(id)
    if (state === undefined) return false
    state.logs.length = 0
    return true
  }

  /** Append one line from outside the runtime (plugin-sync seed outcomes, …):
   *  same ring-buffer semantics as the internal appendLog; unknown id → false. */
  function appendLog(id: string, level: TransportLogEntry['level'], message: string): boolean {
    const state = states.get(id)
    if (state === undefined) return false
    appendLogInternal(state, level, message)
    return true
  }

  /** Subscribe to status changes: listener(instanceId, statusProjection). */
  function onStatusChanged(listener: StatusChangedListener): () => void {
    bus.on('status-changed', listener)
    return () => bus.removeListener('status-changed', listener)
  }

  /** Stop every transport, cancel in-flight execs, drop all listeners (app quit). */
  function dispose() {
    disposed = true
    for (const id of [...states.keys()]) disconnect(id)
    for (const child of execChildren) {
      signalChild(child, 'SIGTERM')
      armKillEscalation(child)
    }
    execChildren.clear()
    bus.removeAllListeners('status-changed')
  }

  /**
   * dispose() and THEN wait for every SIGKILL escalation to resolve — either
   * the child exits on SIGTERM (escalation cleared by onChildExit) or the
   * grace-period SIGKILL fires. App quit must not lose the escalation to
   * process teardown: without the wait, an ssh child that ignores SIGTERM
   * would be orphaned (the escalation timers are unref'd, so quitting within
   * the grace period leaves them unfulfilled). Bounded by disconnectGraceMs + 1s.
   */
  async function disposeAsync(): Promise<void> {
    dispose()
    const deadline = Date.now() + disconnectGraceMs + 1000
    await new Promise<void>((resolve) => {
      const check = () => {
        const pending = killEscalations.size > 0
        if (!pending || Date.now() >= deadline) resolve()
        else setTimeout(check, 25)
      }
      check()
    })
  }

  return {
    loadInstances,
    saveInstances,
    listInstances,
    connect,
    disconnect,
    status,
    readyUrl,
    logs,
    clearLogs,
    appendLog,
    exec,
    onStatusChanged,
    dispose,
    disposeAsync,
  }
}
