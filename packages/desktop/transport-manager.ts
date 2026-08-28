/**
 * Generic transport runtime (design 03 §2.2, transport-provider.ts): the
 * source-agnostic half of the connection manager. Every registry instance
 * carries orthogonal `kind` and `transport`; the runtime resolves the provider
 * registered for that transport (`ssh` or `http`, with a legacy fallback) and
 * owns everything generic:
 *
 * - Persisted instance registry (<userData>/ssh-instances.json, written with
 *   the repo's atomic-write convention: write .tmp → fsync → rename; corrupt
 *   files fail loudly, never masquerade as an empty set — the desktop main
 *   process preserves the corrupt file before starting empty). v2 migration
 *   on load/save (design 17 §2.2): legacy `kind:'ssh'`/`kind:'gateway'`
 *   entries normalize to {kind, transport} before provider validation.
 * - Transport lifecycle per instance: tunnel mode (providerForSpec.buildStartArgs →
 *   a child process, local port bound via net listen(0), readiness = the
 *   local port accepts a TCP connection AND the provider's endpoint identity
 *   verification passes — verifyUp, e.g. the ssh provider's host.describe
 *   handshake, so a non-dsh service on the destination port never presents
 *   as ready) and DIRECT ENDPOINT mode
 *   (buildStartArgs → null: no child, the runtime probes
 *   provider.probeTarget() and exposes provider.endpointUrl()).
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
 * module raw. status() projects {kind, transport, insecureHttp, phase,
 * localPort, sshPort, remotePort, remoteDshHome, retryAttempt,
 * requiresUserAction, serviceActive, logSummary} only — the renderer builds
 * webview URLs from localPort alone. No
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
import { canonicalizeTransportInstanceInput, MAX_TRANSPORT_INSTANCES } from './transport-provider.ts'
import type {
  SpawnedProcess,
  TransportExecAction,
  TransportExecResult,
  TransportInstanceInput,
  TransportInstanceSpec,
  TransportKind,
  TransportLogEntry,
  TransportPhase,
  TransportProbeEndpoint,
  TransportProvider,
  TransportRunPayload,
  TransportSpawnLease,
  TransportStatusProjection,
  TransportVerifyResult,
} from './transport-provider.ts'
export { INSTANCE_ID_PATTERN } from './transport-provider.ts'

/** Ring-buffer log cap per instance（滚动日志上限，截断 200 行）. */
export const RING_BUFFER_LIMIT = 200

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
  /** Optional per-spec overrides (design 17 §2.2/§7): the registry is
   * resolved BY TRANSPORT first (`{ ssh, http }` — one provider per
   * mechanism, serving both target kinds), then by the legacy kind key
   * (`{ gateway }`, v1 style), then the default `provider`. A key present
   * here wins for every spec whose transport/kind matches it. */
  providers?: Partial<Record<TransportKind, TransportProvider>>
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

/** The runtime surface returned by createTransportManager. */
export interface TransportManager {
  loadInstances(): TransportInstanceSpec[]
  saveInstances(next: TransportInstanceInput[]): TransportInstanceSpec[]
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

/**
 * Replace provider-owned credentials without leaving a live transport bound
 * to the previous value. The credential writer is write-through: if it
 * throws, its old in-memory value remains authoritative, so reconnecting
 * restores the prior transport.
 *
 * `belongsTo` answers "is the LIVE transport the one that consumes this
 * credential?": ssh passwords match the SSH TRANSPORT, gateway tokens match
 * the GATEWAY TARGET (design 17 §2 — a gateway-over-http and a gateway-over-
 * ssh transport both consume the token; a dsh target never does). A kind or
 * transport switch leaves the replacement provider's live transport alone —
 * kind-switch cleanup may clear the OLD provider's secret after the
 * replacement provider is already live.
 */
export function commitTransportCredentialUpdate(
  transport: Pick<TransportManager, 'status' | 'disconnect' | 'connect'>,
  id: string,
  belongsTo: (status: TransportStatusProjection) => boolean,
  commit: () => void,
): void {
  const previousStatus = transport.status(id)
  const applicable = previousStatus !== null && belongsTo(previousStatus)
  const shouldReconnect = applicable && previousStatus.phase !== 'idle'
  // An exec may run while the transport itself is idle. It still belongs to
  // the old credential generation and must be stopped before a clear/write,
  // but an exec-only generation is not auto-connected after the mutation.
  const shouldDisconnect = applicable
  if (shouldDisconnect) transport.disconnect(id)
  try {
    commit()
  } catch (error) {
    // A write-through credential store leaves its previous value live on a
    // failed commit. Restore the transport under that prior credential.
    if (shouldReconnect) transport.connect(id)
    throw error
  }
  if (shouldReconnect) transport.connect(id)
}

/** Fields that bind provider exec work to one connection generation. Label,
 * HTTP scheme and SPKI do not change an SSH exec target; the remote service
 * and dsh home do. saveInstances disconnects/bump-epochs on the same set. */
function execIdentityChanged(a: TransportInstanceSpec, b: TransportInstanceSpec): boolean {
  return a.kind !== b.kind
    || a.transport !== b.transport
    || a.host !== b.host
    || a.user !== b.user
    || a.sshPort !== b.sshPort
    || a.remotePort !== b.remotePort
    || a.serviceName !== b.serviceName
    || a.remoteDshHome !== b.remoteDshHome
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
  /**
   * Per-child SIGTERM → SIGKILL escalation timers (one slot per child, so
   * arming a NEW child's escalation can never cancel an older child's
   * pending SIGKILL — a SIGTERM-ignoring child always gets its SIGKILL).
   */
  killEscalations: Map<SpawnedProcess, ReturnType<typeof setTimeout>>
  readyLoop: AbortController | null
  logs: TransportLogEntry[]
  /** Monotonic transport attempt counter: stale startTransport invocations and
   *  delayed exits of replaced children are recognized and ignored. */
  tunnelEpoch: number
  /**
   * Monotonic exec-generation counter, incremented on disconnect: execs
   * started BEFORE the disconnect (whose callbacks may still fire late) are
   * recognized as stale and never write into the instance's state — a
   * removed-and-reused id, a kind switch, or a field-edit restart must not
   * be polluted by the old instance's in-flight exec (review 2026-08).
   */
  execEpoch: number
  /** In-flight provider exec children of THIS instance, SIGTERMed by
   *  disconnect (a disconnect cancels the execs it owns) in addition to the
   *  global set SIGTERMed by dispose (app quit). */
  execChildren: Set<SpawnedProcess>
}

/** Error that may carry a machine-readable code. */
interface CodedError extends Error {
  code?: string
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
export function createTransportManager({ provider, providers, spawnFn, portProbe, verifyProbe, allocatePort, random, instancesFile, logger, options = {} }: TransportManagerDeps): TransportManager {
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
  // The registry is keyed by TransportKind; resolveProvider looks up BOTH the
  // spec's transport ('ssh'|'http') and its legacy kind key — widen for the
  // transport-keyed lookup (a TransportMethod is a string, not a TransportKind).
  const providersByKey = providers as Partial<Record<string, TransportProvider>> | undefined
  // Explicit annotation: `spawnFn ?? default` would otherwise infer a UNION
  // of call signatures (SpawnedProcess | ChildProcess), making `child.on`
  // uncallable at the call sites.
  const doSpawn: (command: string, args: readonly string[], opts: SpawnOptions) => SpawnedProcess =
    spawnFn ?? ((command: string, args: readonly string[], opts: SpawnOptions) => spawn(command, args, opts))
  const doProbe = portProbe ?? defaultPortProbe
  /** Resolve the provider for a spec (design 17 §2.2): the TRANSPORT-keyed
   * override wins (`providers: { ssh, http }` — one provider per mechanism,
   * serving both target kinds), then the legacy kind-keyed override
   * (`providers: { gateway }`, v1 style), then the default provider. */
  const resolveProvider = (entry: { kind?: unknown; transport?: unknown }): TransportProvider => {
    if (typeof entry.transport === 'string') {
      const byTransport = providersByKey?.[entry.transport]
      if (byTransport !== undefined) return byTransport
    }
    if (typeof entry.kind === 'string') {
      const byKind = providersByKey?.[entry.kind]
      if (byKind !== undefined) return byKind
    }
    return provider
  }
  const doVerify = verifyProbe ?? ((spec: TransportInstanceSpec, endpoint: TransportProbeEndpoint) => {
    const verify = resolveProvider(spec).verifyUp
    // A provider without verifyUp has no destination-identity check: pass.
    return verify === undefined ? Promise.resolve({ ok: true }) : verify(spec, endpoint)
  })
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
  /** Quit/teardown gate (2026 final review): set by dispose(); exec()/connect()
   *  refuse new work after it — no spawn can be started into the shutdown. */
  let disposed = false
  /** Exec-child SIGTERM → SIGKILL escalations (2026 audit M2): exec children
   *  get the same grace escalation as tunnel children, and disposeAsync waits
   *  for both — a SIGTERM-ignoring ssh exec must not survive app quit. */
  const execKillEscalations = new Map<SpawnedProcess, ReturnType<typeof setTimeout>>()
  /** Global tunnel escalation tracker. Instance state may be deleted as soon
   * as its registry row is removed, but app shutdown must still wait for that
   * removed generation's SIGKILL/real exit and askpass-lease release. */
  const tunnelKillEscalations = new Map<SpawnedProcess, ReturnType<typeof setTimeout>>()
  const bus = new EventEmitter()

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
        killEscalations: new Map(),
        readyLoop: null,
        logs: [],
        tunnelEpoch: 0,
        execEpoch: 0,
        execChildren: new Set(),
      }
      states.set(id, state)
    }
    return state
  }

  function appendLogInternal(state: InstanceState, level: TransportLogEntry['level'], message: string) {
    state.logs.push({ ts: Date.now(), level, message })
    if (state.logs.length > ringBufferLimit) {
      state.logs.splice(0, state.logs.length - ringBufferLimit)
    }
  }

  /** Broadcast the non-secret status projection to status-changed listeners. */
  function emitStatus(id: string) {
    const projection = status(id)
    if (projection === null) return
    for (const listener of bus.listeners('status-changed')) {
      try {
        listener(id, projection)
      } catch (listenerError) {
        warn(`transport-manager status listener threw: ${String(listenerError)}`)
      }
    }
  }

  /** Set phase/logSummary and broadcast (only on actual change). */
  function transition(id: string, next: TransportPhase, summary?: string) {
    const state = ensureState(id)
    const changed = state.phase !== next || (summary !== undefined && state.logSummary !== summary)
    if (!changed) return
    if (state.phase !== next) {
      log(`transport-manager: ${id} ${state.phase} → ${next}${summary ? ` (${summary})` : ''}`)
      state.phase = next
    }
    if (summary !== undefined) state.logSummary = summary
    emitStatus(id)
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
  function armKillEscalation(state: InstanceState, child: SpawnedProcess) {
    // One non-renewable deadline per child. A repeated disconnect or an
    // immediate dispose cannot postpone a removed generation's SIGKILL.
    if (tunnelKillEscalations.has(child)) return
    const timer = setTimeout(() => {
      state.killEscalations.delete(child)
      // Keep the GLOBAL entry until the actual child exit/error. disposeAsync
      // therefore cannot return between sending SIGKILL and releasing the
      // child-bound provider/askpass lease.
      signalChild(child, 'SIGKILL')
    }, disconnectGraceMs)
    timer.unref?.()
    state.killEscalations.set(child, timer)
    tunnelKillEscalations.set(child, timer)
  }

  /** A child lifecycle terminal event owns both escalation indexes. This is
   * also used for a spawn `error`, which Node may emit without a later
   * `exit`; retaining that entry would make app shutdown wait for a process
   * that was never successfully created. */
  function clearTunnelKillEscalation(state: InstanceState | undefined, child: SpawnedProcess) {
    const escalation = tunnelKillEscalations.get(child)
    if (escalation !== undefined) {
      clearTimeout(escalation)
      tunnelKillEscalations.delete(child)
    }
    state?.killEscalations.delete(child)
  }

  /** Arm one non-renewable SIGTERM → SIGKILL deadline for an exec child.
   * disconnect(), repeated disconnects, and dispose() all share this map, so
   * none can postpone the deadline or deliver a second manager-owned KILL. */
  function armExecKillEscalation(child: SpawnedProcess) {
    if (execKillEscalations.has(child)) return
    const timer = setTimeout(() => {
      // Like tunnel leases, keep tracking until the child lifecycle reports
      // exit/error; the grace timer merely requests termination.
      signalChild(child, 'SIGKILL')
    }, disconnectGraceMs)
    timer.unref?.()
    execKillEscalations.set(child, timer)
  }

  /**
   * Terminal failure (auth, spawn, deterministic endpoint verification):
   * stop the recovery machinery and land on error with
   * requiresUserAction=true. Never auto-retried — the user must act (fix
   * credentials, host keys, the transport binary, or a destination that
   * answered the probe but is not a dsh instance).
   */
  function failTerminal(id: string, message: string) {
    const state = ensureState(id)
    if (state.phase === 'error') return
    if (state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }
    stopReadyLoop(state)
    if (state.child !== null) {
      signalChild(state.child, 'SIGTERM')
      armKillEscalation(state, state.child)
    }
    state.child = null
    state.localPort = null
    state.retryAttempt = 0
    state.requiresUserAction = true
    transition(id, 'error', message)
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
  function scheduleReconnect(id: string, reason: string) {
    const state = ensureState(id)
    if (state.reconnectTimer !== null) return
    if (state.retryAttempt >= maxRetryAttempts) {
      // 与快速路径同款清理：耗尽可能经 ready-loop 超时 / 验证失败路径到达，
      // 彼时子进程还活着——不留僵尸隧道与过期 localPort 投影（下个慢速重探
      // 的 startTransport 也会 SIGTERM 它，但 60s 窗口不该由错误态背负）。
      stopReadyLoop(state)
      if (state.child !== null) {
        signalChild(state.child, 'SIGTERM')
        armKillEscalation(state, state.child)
      }
      state.child = null
      state.localPort = null
      transition(id, 'error', `transport failed: max retry attempts exceeded (${reason}); retrying periodically`)
      appendLogInternal(state, 'error', `max retry attempts exceeded (${reason}); slow re-probe in ${slowRetryMs}ms`)
      // The phase stays error (honest red state — the probe is background
      // recovery, never a permanent spinner); each fire runs ONE fresh
      // attempt through the normal machine (startTransport), and success
      // lands ready and resets the counters. requiresUserAction stays false:
      // this is not a user-action failure.
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null
        void startTransport(id).catch(error => warn(`transport-manager: slow re-probe rejected: ${String(error)}`))
      }, slowRetryMs)
      state.reconnectTimer.unref?.()
      return
    }
    stopReadyLoop(state)
    if (state.child !== null) {
      signalChild(state.child, 'SIGTERM')
      armKillEscalation(state, state.child)
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
      warn(`transport-manager: injected random threw: ${String(randomError)}`)
      backoff = Math.min(retryBaseMs * 2 ** (state.retryAttempt - 1), retryMaxMs)
    }
    appendLogInternal(state, 'warn', `reconnect in ${backoff}ms (attempt ${state.retryAttempt}/${maxRetryAttempts}): ${reason}`)
    transition(id, 'degraded', reason)
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null
      void startTransport(id).catch(error => warn(`transport-manager: startTransport rejected: ${String(error)}`))
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
  function onChildExit(id: string, child: SpawnedProcess, code: number | null, signal: NodeJS.Signals | null) {
    const state = states.get(id)
    // Clear global tracking BEFORE consulting state: removal deliberately
    // deletes the state immediately, while this old child/lease may still be
    // terminating. An unrelated child's exit never cancels another's entry.
    clearTunnelKillEscalation(state, child)
    if (state === undefined) return
    if (state.child !== child) return
    state.child = null
    state.childExited = true
    log(`transport-manager: ${id} transport process exited (${code ?? signal})`)
    appendLogInternal(state, 'warn', `transport process exited (${code ?? signal})`)
    if (state.phase === 'idle' || state.phase === 'error') return
    if (state.authFailed || state.requiresUserAction) {
      failTerminal(id, 'authentication failed — requires user action')
      return
    }
    if (state.phase === 'ready') {
      scheduleReconnect(id, `transport dropped (exit ${code ?? signal})`)
      return
    }
    scheduleReconnect(id, `transport failed before ready (exit ${code ?? signal})`)
  }

  /**
   * Start one transport attempt and drive it to ready/degraded/error. The
   * readiness detection polls the probe target (probeIntervalMs) up to
   * readyTimeoutMs: the port accepting a connection (tunnel mode) — or the
   * direct endpoint answering (endpoint mode) — is the honest "up" signal.
   */
  async function startTransport(id: string) {
    const spec = instances.get(id)
    if (spec === undefined) return
    // The provider for THIS instance's kind (design 17 §7) — a gateway
    // instance resolves to gatewayProvider, an ssh instance to sshProvider.
    const providerForSpec = resolveProvider(spec)
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
      armKillEscalation(state, state.child)
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
    transition(id, 'connecting', 'starting transport')

    let localPort: number | null = null
    // Capability: a provider with buildStartArgs gets a local tunnel port;
    // a provider without it is DIRECT ENDPOINT mode (no child, no port).
    if (providerForSpec.buildStartArgs !== undefined) {
      try {
        localPort = await doAllocate()
      } catch (allocateError) {
        // disconnect()/failTerminal/restart may have landed while the port was
        // being allocated: never arm recovery for a machine that moved on —
        // a manual disconnect must cancel the slow re-probe (2026 final
        // review, same guard as the success path below).
        if (state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
        transition(id, 'error', `failed to allocate a local port: ${String(allocateError)}`)
        appendLogInternal(state, 'error', `port allocation failed: ${String(allocateError)}`)
        // A transient allocation failure (ephemeral-port exhaustion) must not
        // leave the instance stuck in error forever: arm the slow periodic
        // re-probe, same pattern as the max-retry recovery (2026 audit M10).
        state.reconnectTimer = setTimeout(() => {
          state.reconnectTimer = null
          void startTransport(id).catch(error => warn(`transport-manager: slow re-probe rejected: ${String(error)}`))
        }, slowRetryMs)
        state.reconnectTimer.unref?.()
        return
      }
      // disconnect()/failTerminal/restart may have landed while the port was
      // being allocated; the phase or the epoch tells us — abort, never start.
      if (state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
      state.localPort = localPort
    }

    let args: readonly string[] | null = null
    if (providerForSpec.buildStartArgs !== undefined) {
      try {
        args = providerForSpec.buildStartArgs(spec, localPort as number)
      } catch (buildError) {
        // A throwing provider must never leave the machine stuck in
        // connecting with no child and no recovery machinery.
        warn(`transport-manager: providerForSpec.buildStartArgs threw: ${String(buildError)}`)
        transition(id, 'error', `provider build failed: ${String(buildError)}`)
        appendLogInternal(state, 'error', `provider buildStartArgs threw: ${String(buildError)}`)
        return
      }
    }
    const directEndpoint = args === null
    // A contradictory provider (buildStartArgs present but returning null)
    // must not leak the allocated-but-never-bound port into the projection
    // or readyUrl — direct endpoint mode owns neither.
    if (directEndpoint) state.localPort = null
    const probeTarget = (() => {
      try {
        return directEndpoint
          ? (providerForSpec.probeTarget?.(spec) ?? { host: spec.host, port: spec.remotePort })
          : { host: '127.0.0.1', port: localPort as number }
      } catch (probeError) {
        // A throwing probeTarget must not leave the machine stuck in
        // connecting (no child, no recovery) — loud error instead.
        warn(`transport-manager: provider.probeTarget threw: ${String(probeError)}`)
        transition(id, 'error', `provider probeTarget threw: ${String(probeError)}`)
        appendLogInternal(state, 'error', `provider probeTarget threw: ${String(probeError)}`)
        return null
      }
    })()
    if (probeTarget === null) return

    if (directEndpoint) {
      // DIRECT ENDPOINT mode: no child process — the endpoint is reached
      // as-is (e.g. a tailnet host); only the probe loop below runs.
      transition(id, 'connecting', `reaching ${spec.host}:${probeTarget.port} directly`)
    } else {
      // Provider-owned extra environment (ssh: the askpass env for password
      // auth, design 05 §8) is merged over process.env — never replaces it
      // (the child must keep HOME, PATH, …). A throwing provider lands on a
      // loud error, never a stuck connecting with no child.
      let transportLease: TransportSpawnLease | null = null
      if (providerForSpec.buildStartEnv !== undefined) {
        try {
          transportLease = providerForSpec.buildStartEnv(spec)
        } catch (envError) {
          warn(`transport-manager: providerForSpec.buildStartEnv threw: ${String(envError)}`)
          transition(id, 'error', `provider buildStartEnv threw: ${String(envError)}`)
          appendLogInternal(state, 'error', `provider buildStartEnv threw: ${String(envError)}`)
          return
        }
      }
      let leaseReleased = false
      const releaseTransportLease = () => {
        if (leaseReleased || transportLease === null) return
        leaseReleased = true
        try {
          transportLease.release()
        } catch (releaseError) {
          warn(`transport-manager: provider transport lease release threw: ${String(releaseError)}`)
        }
      }
      let child: SpawnedProcess
      try {
        child = doSpawn('ssh', args!, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: transportLease === null ? undefined : { ...process.env, ...transportLease.env },
        })
      } catch (spawnError) {
        releaseTransportLease()
        state.requiresUserAction = true
        failTerminal(id, `failed to spawn transport: ${String(spawnError)}`)
        return
      }
      // Bind provider-owned ephemeral resources to the ACTUAL child
      // lifetime before any stale-epoch handling can signal it. Node may
      // emit both error and exit, so the one-shot wrapper owns idempotency.
      child.on('exit', releaseTransportLease)
      child.on('error', releaseTransportLease)
      if (state.phase !== 'connecting' || epoch !== state.tunnelEpoch) {
        // A stale epoch (a newer attempt took over while this spawn was in
        // flight): the freshly spawned child must still get the SIGKILL
        // escalation — a SIGTERM-ignoring transport would otherwise become
        // an unreaped orphan.
        signalChild(child, 'SIGTERM')
        armKillEscalation(state, child)
        return
      }
      state.child = child
      transition(id, 'connecting', `spawning ${args![0]} ${args!.slice(1).join(' ')}`)
      if (child.stdout !== null) {
        child.stdout.on('data', chunk => {
          if (state.child !== child) return
          // Non-stderr channels get the provider's redaction too (the stderr
          // path is redacted inside classifyStderr; without this a
          // misbehaving remote could echo credential/path-shaped text into
          // the ring via stdout). Guarded like the stderr path — a throwing
          // redactor must never take the transport down.
          let log: string
          try {
            log = providerForSpec.redactOutput?.(String(chunk)) ?? String(chunk)
          } catch (redactError) {
            warn(`transport-manager: providerForSpec.redactOutput threw on stdout: ${String(redactError)}`)
            log = String(chunk)
          }
          appendLogInternal(state, 'info', log.trimEnd())
        })
      }
      // Line-buffered stderr (per child): provider classification (redaction
      // + auth detection) runs on COMPLETE lines only — node chunk boundaries
      // are arbitrary, and a key path or an auth phrase straddling two chunks
      // must never bypass either. The data guard mirrors the exit handler: a
      // REPLACED child's late stderr must not poison the fresh attempt.
      let stderrPending = ''
      const processStderr = (text: string) => {
        stderrPending += text
        const lines = stderrPending.split(/\r?\n/)
        stderrPending = lines.pop() ?? ''
        for (const line of lines) {
          // A throwing provider must never kill the main process from an
          // event handler (uncaughtException) — guard the classification.
          let logLine: string
          let terminalAuth: boolean
          try {
            const classified = providerForSpec.classifyStderr(line)
            logLine = classified.log
            terminalAuth = classified.terminalAuth
          } catch (classifyError) {
            warn(`transport-manager: provider.classifyStderr threw: ${String(classifyError)}`)
            continue
          }
          if (logLine === '') continue
          appendLogInternal(state, 'info', logLine)
          if (terminalAuth) {
            state.authFailed = true
            appendLogInternal(state, 'error', 'authentication failure detected (requires user action)')
          }
        }
      }
      if (child.stderr !== null) {
        child.stderr.on('data', chunk => {
          if (state.child !== child) return
          processStderr(String(chunk))
        })
      }
      child.on('exit', (code, exitSignal) => {
        // Flush the unterminated stderr line before the exit handler decides —
        // an auth pattern may live on the final (newline-less) line.
        if (state.child === child) processStderr('\n')
        onChildExit(id, child, code, exitSignal)
      })
      child.on('error', error => {
        // Spawn failure (e.g. the transport binary is missing): terminal,
        // user action. Guarded: a REPLACED child's late spawn-error must
        // never failTerminal the fresh transport. A spawn error may have no
        // following exit event, so it is also an authoritative end to this
        // child's global shutdown/escalation tracking.
        if (state.child !== child) {
          clearTunnelKillEscalation(state, child)
          return
        }
        appendLogInternal(state, 'error', `transport spawn error: ${String(error)}`)
        state.requiresUserAction = true
        failTerminal(id, `failed to spawn transport: ${String(error)}`)
        clearTunnelKillEscalation(state, child)
      })
    }

    const controller = new AbortController()
    state.readyLoop = controller
    const deadline = Date.now() + readyTimeoutMs
    void (async () => {
      while (!controller.signal.aborted) {
        if (state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
        if (state.authFailed) return failTerminal(id, 'authentication failed — requires user action')
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
              warn(`transport-manager: endpoint verification threw: ${String(verifyError)}`)
              verification = { ok: false, detail: 'endpoint verification failed' }
            }
            if (controller.signal.aborted || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
            // An auth failure that landed while the verification was in
            // flight must stay terminal — never fall through to a reconnect.
            if (state.authFailed) return failTerminal(id, 'authentication failed — requires user action')
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
              if (verification.terminal === true) return failTerminal(id, reason)
              return scheduleReconnect(id, reason)
            }
          }
          if (directEndpoint) {
            state.retryAttempt = 0
            state.requiresUserAction = false
            transition(id, 'ready', 'endpoint is reachable')
            appendLogInternal(state, 'info', `endpoint reachable: ${spec.host}:${probeTarget.port}`)
          } else if (!state.childExited && state.child !== null) {
            state.retryAttempt = 0
            state.requiresUserAction = false
            transition(id, 'ready', 'transport is up')
            appendLogInternal(state, 'info', `transport ready on 127.0.0.1:${localPort}`)
          }
          return
        }
        if (Date.now() >= deadline) {
          // An auth failure that landed while the final probe was in flight
          // must stay terminal — never fall through to a reconnect.
          if (state.authFailed) return failTerminal(id, 'authentication failed — requires user action')
          if (state.childExited) return
          appendLogInternal(state, 'warn', `transport did not come up within ${readyTimeoutMs}ms`)
          return scheduleReconnect(id, 'transport did not come up in time')
        }
        await sleep(probeIntervalMs)
      }
    })().catch(error => warn(`transport-manager ready loop rejected: ${String(error)}`))
  }

  /** Provider exec channel (ssh: one remote systemd exec). */
  function exec(id: string, action: TransportExecAction, payload?: TransportRunPayload): Promise<TransportExecResult> {
    if (disposed) return Promise.resolve({ ok: false, error: 'transport manager is disposed' })
    const spec = instances.get(id)
    if (spec === undefined) {
      return Promise.resolve({ ok: false, error: 'ssh instance not found' })
    }
    const providerForSpec = resolveProvider(spec)
    if (providerForSpec.exec === undefined) {
      return Promise.resolve({ ok: false, error: `exec not supported by transport kind ${spec.kind}` })
    }
    const state = ensureState(id)
    // Snapshot the exec generation: disconnect() increments execEpoch, so a
    // late callback of an exec started before the disconnect recognizes it
    // is stale and drops its write (a removed-and-reused id, a kind switch,
    // or a field-edit restart must never be polluted by the old instance's
    // in-flight exec — review 2026-08). Label-only edits do not disconnect;
    // the identity comparison
    // below is the authoritative fence even between children in a multi-step
    // exec, when the per-child set may momentarily be empty.
    const execEpoch = state.execEpoch
    const execIsCurrent = (): boolean => {
      const current = instances.get(id)
      return !disposed && state.execEpoch === execEpoch
        && current !== undefined && !execIdentityChanged(spec, current)
    }
    // Wrap the spawn so in-flight exec children are tracked per instance
    // (SIGTERMed by disconnect — a disconnect cancels the execs it owns)
    // and globally (SIGTERMed by dispose/app quit).
    const trackedSpawn = (command: string, args: readonly string[], spawnOptions: SpawnOptions) => {
      // Multi-stage provider execs (notably write-file then read-back) may
      // request another child after an await. Never let an old-spec saga spawn
      // its next step after retarget/delete/dispose; throwing lets the provider
      // release the just-acquired askpass lease through its spawn-failure path.
      if (!execIsCurrent()) throw new Error('exec superseded by connection change')
      const child = doSpawn(command, args, spawnOptions)
      execChildren.add(child)
      state.execChildren.add(child)
      let trackingReleased = false
      const releaseTracking = () => {
        if (trackingReleased) return
        trackingReleased = true
        execChildren.delete(child)
        state.execChildren.delete(child)
        // A real exit or spawn failure cancels the pending manager escalation.
        // Askpass has its own per-child lease and uses the same actual child
        // lifecycle; no disconnect path releases that lease prematurely.
        const escalation = execKillEscalations.get(child)
        if (escalation !== undefined) {
          clearTimeout(escalation)
          execKillEscalations.delete(child)
        }
      }
      child.on('exit', releaseTracking)
      child.on('error', releaseTracking)
      return child
    }
    let operation: Promise<TransportExecResult>
    try {
      operation = providerForSpec.exec(spec, action, {
        spawnFn: trackedSpawn,
        execTimeoutMs,
        runTimeoutMs: runExecTimeoutMs,
        disconnectGraceMs,
        log: (level, message) => {
          // Stale-exec guard: an exec that outlived its instance's
          // disconnect must never write into the ring buffer of a reused
          // (or kind-switched) instance.
          if (!execIsCurrent()) return
          appendLogInternal(state, level, message)
        },
        setProjection: (execId, key, value) => {
          if (key === 'serviceActive') {
            // Stale-exec guard (same rationale as log): an ssh-specific
            // projection must never leak onto a kind-switched or reused id.
            if (!execIsCurrent()) return
            state.serviceActive = value
            emitStatus(execId)
          }
        },
        projection: execId => execId === id && execIsCurrent() ? status(execId) : null,
      }, payload)
    } catch (execError) {
      // A throwing provider must never surface as a sync rejection through
      // the IPC layer — loud error result instead.
      return Promise.resolve({ ok: false, error: `exec failed: ${String(execError)}` })
    }
    return Promise.resolve(operation).then(
      result => execIsCurrent()
        ? result
        : { ok: false, error: 'exec superseded by connection change' },
      execError => ({ ok: false, error: `exec failed: ${String(execError)}` }),
    )
  }

  /**
   * v2 registry migration (design 17 §2.2/§9.1): the v1 `kind` conflated the
   * transport with the target type ('ssh' | 'gateway'). Entries are rewritten
   * BEFORE provider validation so providers only ever see the v2 form:
   * - kind:'ssh'     → { kind:'dsh', transport:'ssh' }
   * - kind:'gateway' → { kind:'gateway', transport:'http' }
   * - kind missing   → { kind:'dsh', transport:'ssh' } (the v1 default)
   * - transport missing → inferred from kind (dsh→ssh, gateway→http);
   *   an unknown kind (test fixtures, future targets) keeps its kind and no
   *   transport — resolveProvider falls back to the kind-keyed provider.
   * The source id `ssh-<id>` legacy mapping stays a control-plane concern
   * (design 17 §2.1); the desktop registry carries the v2 kind.
   */
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
      const wrapped: CodedError = new Error(`ssh-instances file is corrupt: ${String(error)}`)
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
      // A null/non-object entry (corrupt or hand-edited file) must never
      // throw inside provider resolution — drop it loudly with the other
      // invalid entries (the corrupt whole-file path preserves the file;
      // this is the per-entry defense).
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        dropped.push(entry)
        continue
      }
      // v2 migration first (design 17 §2.2): legacy kinds normalize before
      // provider selection so the provider is resolved by the v2 transport.
      const migrated = canonicalizeTransportInstanceInput(entry)
      const providerFor = resolveProvider(migrated as { kind?: unknown; transport?: unknown })
      const normalized = providerFor.validateSpec(migrated)
      if (normalized === null) {
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
   * disconnected and are removed; the set becomes exactly `next`. Invalid
   * entries are dropped with a warning; duplicate ids keep the FIRST entry
   * (loud, never silent) so the file and the returned set never disagree.
   * Instances whose target kind, transport method or parameters
   * (host/user/sshPort/remotePort/insecureHttp) changed while their
   * transport is live are restarted so the transport and the projection
   * never disagree. Teardown
   * always runs while the OLD spec is still authoritative: provider-owned
   * resources and status listeners must observe/unregister the old kind before
   * the registry starts projecting the replacement kind.
   * @returns the persisted instance list.
   */
  function saveInstances(next: TransportInstanceInput[]): TransportInstanceSpec[] {
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
    const dropped: TransportInstanceInput[] = []
    const restartIds: string[] = []
    const stopBeforeReplaceIds: string[] = []
    const projectionResetIds: string[] = []
    const seenIds = new Set<string>()
    for (const entry of next) {
      // A null/non-object entry must never throw inside provider resolution —
      // drop it loudly with the other invalid entries (defensive; the renderer
      // never produces one, a hand-edited file can).
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        dropped.push(entry as TransportInstanceInput)
        continue
      }
      // v2 migration first (design 17 §2.2): legacy kinds normalize before
      // provider selection so the provider is resolved by the v2 transport.
      const migrated = canonicalizeTransportInstanceInput(entry)
      const providerFor = resolveProvider(migrated as { kind?: unknown; transport?: unknown })
      const normalized = providerFor.validateSpec(migrated)
      if (normalized === null) {
        dropped.push(entry)
        continue
      }
      if (seenIds.has(normalized.id)) {
        dropped.push(entry)
        continue
      }
      seenIds.add(normalized.id)
      const previous = instances.get(normalized.id)
      const state = previous === undefined ? undefined : states.get(normalized.id)
      const kindChanged = previous !== undefined && previous.kind !== normalized.kind
      if (previous !== undefined && (kindChanged || previous.serviceName !== normalized.serviceName)) {
        projectionResetIds.push(normalized.id)
      }
      // transport and insecureHttp are part of the live-transport identity:
      // switching ssh↔http (or http↔https) while live must tear down and
      // restart the transport so the projection/proxy URL never disagrees
      // with the mechanism. (insecureHttp is NOT part of transportTargetChanged
      // — the secret survives the switch, design 17 §9.1 — but the LIVE
      // transport still restarts to re-register the new origin.) The same
      // applies to the SPKI pin (S23): a pin edit while live must restart so
      // verifyUp + the proxy registration pick up the new pin (the pin is not
      // a credential — transportTargetChanged stays untouched, so the token/
      // password survive the edit).
      const transportFieldsChanged = previous !== undefined && (kindChanged
        || previous.transport !== normalized.transport
        || previous.insecureHttp !== normalized.insecureHttp
        || previous.spkiPin !== normalized.spkiPin
        || previous.host !== normalized.host
        || previous.user !== normalized.user
        || previous.sshPort !== normalized.sshPort
        || previous.remotePort !== normalized.remotePort
        || previous.serviceName !== normalized.serviceName
        || previous.remoteDshHome !== normalized.remoteDshHome)
      if (transportFieldsChanged && state !== undefined) {
        // A kind switch must dispose the old provider even while idle. An
        // exec-only generation is activity too: it may have been started
        // without connect(), so phase can still be idle while an old-target
        // child is live. Tear it down before the registry points at the new
        // endpoint; only an actually non-idle TRANSPORT is restarted.
        if (kindChanged || state.phase !== 'idle' || state.execChildren.size > 0) {
          stopBeforeReplaceIds.push(normalized.id)
        }
        if (state.phase !== 'idle') restartIds.push(normalized.id)
      }
      kept.push(normalized)
    }
    if (dropped.length > 0) warn(`transport-manager: dropped ${dropped.length} invalid or duplicate instance(s) from save`)
    // Persist BEFORE mutating the in-memory registry: a failed write throws
    // while the registry (and every live transport) stays untouched, so the
    // runtime and the UI never diverge on a partial save.
    writeFileAtomic(instancesFile, `${JSON.stringify(kept, undefined, 2)}\n`)
    const nextIds = new Set(kept.map(entry => entry.id))
    for (const id of [...instances.keys()]) {
      if (!nextIds.has(id)) {
        const removedSpec = instances.get(id)
        log(`transport-manager: instance ${id} removed from the set; disconnecting its transport`)
        disconnect(id)
        // The instance is GONE: drop its runtime state (phase machine, ring
        // buffer, per-instance exec children) so a later same-id reuse
        // starts clean — an in-flight exec of the removed instance must
        // never write into the NEW instance's state (its callbacks are
        // already stale via the execEpoch bump; this is the authoritative
        // cleanup, review 2026-08).
        states.delete(id)
        // Request final cleanup of every provider-owned generation on
        // REMOVAL (not a plain disconnect). SSH keeps each tunnel/exec
        // askpass path until that generation's live child lease releases;
        // purge never invalidates a still-running child's environment.
        if (removedSpec !== undefined) resolveProvider(removedSpec).purgeAuth?.(removedSpec)
      }
    }
    // Stop changed transports BEFORE replacing `instances`. disconnect()
    // resolves the provider and emits the idle projection from the current
    // registry entry; doing this after replacement disposes the new provider
    // and asks listeners to unregister the wrong `<kind>:<id>` target.
    for (const id of stopBeforeReplaceIds) {
      log(`transport-manager: instance ${id} transport kind/parameters changed; stopping old transport`)
      disconnect(id)
    }
    instances.clear()
    for (const entry of kept) instances.set(entry.id, entry)
    // Provider-specific projection fields cannot cross a kind boundary. For
    // example, an SSH systemd result must never appear on a gateway status.
    for (const id of projectionResetIds) {
      const state = states.get(id)
      if (state !== undefined) state.serviceActive = null
    }
    // Transport parameters changed while live: stop the old transport and
    // start a fresh one under the new spec (disconnect is idempotent,
    // connect starts from the now-updated registry).
    for (const id of restartIds) {
      log(`transport-manager: instance ${id} transport kind/parameters changed; starting replacement transport`)
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
    // Quit/teardown guard (2026 final review, defensive depth): a connect
    // arriving after dispose() is a no-op returning the current projection.
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
    transition(id, 'connecting', 'starting transport')
    void startTransport(id).catch(error => warn(`transport-manager: startTransport rejected: ${String(error)}`))
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
    // Bump the exec generation FIRST: every in-flight exec started before
    // this disconnect becomes stale at once, so any late callback (a child
    // that ignored the SIGTERM and exits later) is dropped instead of
    // writing into the instance's state — a removed-and-reused id, a kind
    // switch, or a field-edit restart must never be polluted by the old
    // instance's exec (review 2026-08).
    state.execEpoch += 1
    stopReadyLoop(state)
    if (state.child !== null) {
      const child = state.child
      state.child = null
      signalChild(child, 'SIGTERM')
      armKillEscalation(state, child)
    }
    // In-flight provider execs (ssh: systemctl / run) belong to this
    // transport: a disconnect cancels them too, instead of leaving them
    // running against a torn-down transport (their late callbacks are
    // already stale via the execEpoch bump). SIGTERM now and enforce the
    // manager's short disconnect grace; the provider's normal run timeout can
    // be 120s and is not an acceptable deletion/retarget teardown boundary.
    for (const child of state.execChildren) {
      signalChild(child, 'SIGTERM')
      armExecKillEscalation(child)
    }
    // Provider-owned per-instance resources are retired with the transport.
    // SSH askpass generations remain available to SIGTERM-pending tunnel/
    // exec children and are deleted by their child leases on exit/error. The
    // password itself survives disconnect and app quit; its bound persistent
    // mirror is reloaded at startup. Only an explicit clear or the
    // main-owned save/delete transaction removes it.
    const spec = instances.get(id)
    if (spec !== undefined) resolveProvider(spec).disposeAuth?.(spec)
    state.localPort = null
    state.retryAttempt = 0
    state.requiresUserAction = false
    transition(id, 'idle', 'disconnected')
    appendLogInternal(state, 'info', 'disconnected')
  }

  /**
   * The non-secret status projection (design 05 §8): kind, transport,
   * insecureHttp, phase, localPort, sshPort, remotePort, retryAttempt,
   * requiresUserAction, serviceActive, logSummary. Never a transport URL,
   * never credential material. null for an unknown instance.
   */
  function status(id: string): TransportStatusProjection | null {
    const spec = instances.get(id)
    if (spec === undefined) return null
    const state = ensureState(id)
    return {
      kind: spec.kind,
      transport: spec.transport,
      insecureHttp: spec.insecureHttp,
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
   * localPort alone). Tunnel mode: the local listener; endpoint mode: the
   * provider's endpoint URL. Returns null unless the transport is ready.
   */
  function readyUrl(id: string): string | null {
    const state = states.get(id)
    if (state?.phase !== 'ready') return null
    if (state.localPort !== null) return `http://127.0.0.1:${state.localPort}`
    const spec = instances.get(id)
    if (spec === undefined) return null
    return resolveProvider(spec).endpointUrl?.(spec) ?? null
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
      // Exec children get the same SIGTERM → SIGKILL escalation as tunnel
      // children (2026 audit M2): disposeAsync waits for these to drain, so a
      // SIGTERM-ignoring ssh exec cannot be orphaned at app quit.
      armExecKillEscalation(child)
    }
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
        const pending = tunnelKillEscalations.size > 0 || execKillEscalations.size > 0
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
