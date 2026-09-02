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
 *   a child process and local loopback port) or direct-endpoint mode;
 *   readiness = the
 *   local port accepts a TCP connection AND the provider's endpoint identity
 *   verification passes — verifyUp, e.g. the ssh provider's session/list
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
 *   The projected userActionKind discriminates the terminal class ('auth' =
 *   transport/credential-level vs 'endpoint' = instance-level probe failure),
 *   so the UI never tells the user to fix SSH credentials when the tunnel
 *   itself was fine and the remote dsh instance is the problem (2026-08 fix).
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
 * requiresUserAction, userActionKind, serviceActive, logSummary} only — the
 * renderer builds
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
import { CHILD_LINE_MAX_CHARS, createBoundedLineProcessor } from './bounded-lines.ts'
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
 * Ready-state re-verification cadence for a READY transport (design 17 §9.3
 * live-session recovery): a transport that came up once has no further
 * liveness signal — an ssh tunnel child exit is detected, but a direct http
 * endpoint (or a remote dsh that died behind a healthy tunnel) never exits,
 * and a gateway session revoked server-side (remote password change rotates
 * the session secret) is only noticed by the pre-expiry refresh timer, which
 * may be hours away. Every ready transport therefore re-runs its provider's
 * identity probe on this cadence through the SAME verifyUp seam the
 * connect-time readiness check uses (a gateway password target re-logs in
 * ONCE with the stored password on a probe 401, so a merely-revoked session
 * self-heals without user action); a failed probe is classified exactly like
 * a connect-time failure — terminal → error:requires_user_action, transient →
 * the bounded reconnect path. User-initiated activation (source/session
 * switch) accelerates one probe through reverify(); on-demand probes are
 * quiet-windowed by READY_VERIFY_MIN_INTERVAL_MS.
 */
export const READY_VERIFY_INTERVAL_MS = 60_000

/** Quiet window between a completed ready-state re-verification and a
 * USER-INITIATED reverify() (the periodic cadence is the authority; rapid
 * source/session clicks must not pile probes onto one instance). */
export const READY_VERIFY_MIN_INTERVAL_MS = 10_000

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
  /** Ready-state re-verification cadence for a READY transport (default
   * READY_VERIFY_INTERVAL_MS): one provider identity probe per interval keeps
   * a ready-but-dead session/endpoint from presenting as healthy (see
   * READY_VERIFY_INTERVAL_MS). Tests pass small values. */
  readyVerifyIntervalMs?: number
  /** Minimum gap between a completed ready-state re-verification and a
   * USER-INITIATED reverify() (default READY_VERIFY_MIN_INTERVAL_MS). Tests
   * pass small values. */
  readyVerifyMinIntervalMs?: number
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
  /** On-demand ready-state re-verification (user activation): one immediate
   * identity probe for a READY transport; no-op unless ready. Returns the
   * current status projection. */
  reverify(id: string): TransportStatusProjection | null
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
  /** Subscribe to successful ready-state re-verifications: listener(id) after
   * every successful ready-state identity probe (periodic heartbeat or
   * user-initiated reverify) while the transport stayed ready. */
  onVerified(listener: (id: string) => void): () => void
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
  /** Class of the terminal failure behind requiresUserAction ('auth' =
   * transport/credential-level, 'endpoint' = instance-level terminal probe
   * failure — the transport reached the destination and the answer
   * rejected the connection); null otherwise. Projected for the UI so an
   * endpoint failure never masquerades as an SSH auth failure (2026-08 fix). */
  userActionKind: 'auth' | 'endpoint' | null
  serviceActive: boolean | null
  logSummary: string
  reconnectTimer: ReturnType<typeof setTimeout> | null
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
  /** Pending ready-state re-verification timer (armed on ready, canceled on
   *  leaving ready — see READY_VERIFY_INTERVAL_MS). */
  readyProbeTimer: ReturnType<typeof setTimeout> | null
  /** One in-flight ready-state re-verification per instance (single-flight:
   *  the periodic heartbeat and a user-initiated reverify never overlap). */
  verifyInFlight: boolean
  /** Epoch-ms of the last completed ready-state re-verification (0 = none);
   *  the user-initiated quiet window reads it. */
  lastVerifyAt: number
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
  const readyVerifyIntervalMs = options.readyVerifyIntervalMs ?? READY_VERIFY_INTERVAL_MS
  const readyVerifyMinIntervalMs = options.readyVerifyMinIntervalMs ?? READY_VERIFY_MIN_INTERVAL_MS
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
  /** Teardown gate: after dispose starts, no path may create a new child. */
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
        userActionKind: null,
        serviceActive: null,
        logSummary: '',
        reconnectTimer: null,
        readyLoop: null,
        logs: [],
        tunnelEpoch: 0,
        execEpoch: 0,
        execChildren: new Set(),
        readyProbeTimer: null,
        verifyInFlight: false,
        lastVerifyAt: 0,
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
      // Ready-state re-verification lifecycle: EVERY phase change flows
      // through here, so arming on ready and canceling on leaving ready
      // cannot drift from the machine (see READY_VERIFY_INTERVAL_MS).
      if (next === 'ready') armReadyVerify(id, state)
      else cancelReadyVerify(state)
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
    // One non-renewable deadline per child. A repeated disconnect or an
    // immediate dispose cannot postpone a removed generation's SIGKILL.
    if (tunnelKillEscalations.has(child)) return
    const timer = setTimeout(() => {
      // Keep the GLOBAL entry until the actual child exit/error. disposeAsync
      // therefore cannot return between sending SIGKILL and releasing the
      // child-bound provider/askpass lease.
      signalChild(child, 'SIGKILL')
    }, disconnectGraceMs)
    timer.unref?.()
    tunnelKillEscalations.set(child, timer)
  }

  /** A child lifecycle terminal event owns both escalation indexes. This is
   * also used for a spawn `error`, which Node may emit without a later
   * `exit`; retaining that entry would make app shutdown wait for a process
   * that was never successfully created. */
  function clearTunnelKillEscalation(child: SpawnedProcess) {
    const escalation = tunnelKillEscalations.get(child)
    if (escalation !== undefined) {
      clearTimeout(escalation)
      tunnelKillEscalations.delete(child)
    }
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
   * Terminal failure (auth, spawn, deterministic endpoint verification, or a
   * provider contract exception): stop recovery and land on error. Expected
   * configuration/auth failures set requiresUserAction; provider exceptions
   * are terminal for this attempt but remain an internal failure, never a
   * false instruction that the user must repair their connection settings.
   *
   * `userActionKind` discriminates the terminal class for the UI (projected
   * as TransportStatusProjection.userActionKind): 'auth' = transport/
   * credential-level (SSH auth, host key, spawn), 'endpoint' = instance-level
   * terminal probe failure (the destination ANSWERED at the protocol level
   * but rejected the connection — the SSH tunnel itself is fine, so the UI
   * must never suggest fixing SSH credentials). Defaults to 'auth'.
   */
  function failTerminal(
    id: string,
    state: InstanceState,
    message: string,
    requiresUserAction = true,
    userActionKind: 'auth' | 'endpoint' | null = 'auth',
  ) {
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
    state.requiresUserAction = requiresUserAction
    state.userActionKind = requiresUserAction ? userActionKind : null
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
   * The endpoint a READY transport's re-verification probes: the LIVE tunnel
   * listener (ssh) or the direct endpoint (http) — the same derivation as the
   * connect-time probe, so the re-verification sees the exact destination the
   * proxy reaches. null when the ready transport has no probeable endpoint
   * (defensive; a ready transport always has one).
   */
  function readyProbeEndpoint(
    spec: TransportInstanceSpec,
    providerForSpec: TransportProvider,
    state: InstanceState,
  ): TransportProbeEndpoint | null {
    if (providerForSpec.buildStartArgs !== undefined) {
      // Tunnel mode: the probe rides the live tunnel listener (loopback).
      return state.localPort === null ? null : { host: '127.0.0.1', port: state.localPort }
    }
    try {
      return providerForSpec.probeTarget?.(spec) ?? { host: spec.host, port: spec.remotePort }
    } catch {
      // A throwing probeTarget has no probeable endpoint — skip the probe.
      return null
    }
  }

  /** Cancel one instance's pending ready-state re-verification timer. */
  function cancelReadyVerify(state: InstanceState): void {
    if (state.readyProbeTimer !== null) {
      clearTimeout(state.readyProbeTimer)
      state.readyProbeTimer = null
    }
    // The user quiet window belongs to ONE ready incarnation: a verification
    // completed right before leaving ready must not suppress the first user
    // reverify of the next ready generation (the reconnect's own connect-time
    // verification is not a ready-state verification).
    state.lastVerifyAt = 0
  }

  /** Arm the periodic ready-state re-verification for one READY transport. */
  function armReadyVerify(id: string, state: InstanceState): void {
    if (state.readyProbeTimer !== null) return
    const spec = instances.get(id)
    if (spec === undefined) return
    const providerForSpec = resolveProvider(spec)
    // Only targets with a REAL identity verifier get a heartbeat; a provider
    // without verifyUp (and no injected probe) has nothing to re-check.
    if (verifyProbe === undefined && providerForSpec.verifyUp === undefined) return
    const timer = setTimeout(() => {
      state.readyProbeTimer = null
      void verifyReadyTransport(id, state, 'periodic')
    }, readyVerifyIntervalMs)
    timer.unref?.()
    state.readyProbeTimer = timer
  }

  /**
   * One ready-state identity re-verification — the shared body of the
   * periodic heartbeat and the user-initiated reverify() (see
   * READY_VERIFY_INTERVAL_MS). Runs the SAME provider verifyUp seam as the
   * connect-time readiness check (doVerify), so a gateway password target
   * automatically re-logs in ONCE with the stored password on a probe 401
   * (verifyGatewayPasswordSession) and a merely-revoked session self-heals
   * without a phase change; the failure classification mirrors the
   * connect-time verification EXACTLY — terminal → failTerminal
   * (requiresUserAction, endpoint class), transient → scheduleReconnect (the
   * same bounded recovery a dropped ssh tunnel child takes). A transition or
   * registry change while the probe is in flight drops the result — the
   * machine's own transitions own the aftermath.
   */
  async function verifyReadyTransport(id: string, state: InstanceState, source: 'periodic' | 'user'): Promise<void> {
    if (disposed || !isCurrentState(id, state) || state.phase !== 'ready') return
    if (state.verifyInFlight) return
    // User-initiated reverifies are quiet-windowed: rapid source/session
    // activation must not pile probes onto one instance (the periodic timer
    // is the cadence authority; on-demand only accelerates the check for the
    // instance the user is about to act on).
    if (source === 'user' && state.lastVerifyAt !== 0
      && Date.now() - state.lastVerifyAt < readyVerifyMinIntervalMs) return
    const spec = instances.get(id)
    if (spec === undefined) return
    const providerForSpec = resolveProvider(spec)
    // Same real-verifier gate as armReadyVerify: a provider without verifyUp
    // (and no injected probe) has nothing to re-check — a user reverify on
    // such a target must not run the trivial passthrough probe and emit a
    // spurious 'verified'.
    if (verifyProbe === undefined && providerForSpec.verifyUp === undefined) return
    const endpoint = readyProbeEndpoint(spec, providerForSpec, state)
    if (endpoint === null) {
      // Defensive: a READY transport always has a probeable endpoint (tunnel
      // localPort set, direct probeTarget resolvable). Never let this silent
      // return kill the periodic chain — warn loud and re-arm so a transient
      // condition self-heals.
      warn(`transport-manager: ready-state probe skipped for ${id}: no probeable endpoint while ready`)
      if (state.readyProbeTimer === null) armReadyVerify(id, state)
      return
    }
    const epoch = state.tunnelEpoch
    state.verifyInFlight = true
    let verification: TransportVerifyResult
    try {
      verification = await doVerify(spec, endpoint)
    } catch (verifyError) {
      // A throwing verifier must never crash the machine from a timer
      // callback — classify as a transient failure (bounded recovery).
      warn(`transport-manager: ready-state endpoint verification threw: ${describeTransportError(verifyError)}`)
      verification = { ok: false, detail: 'ready-state endpoint verification failed' }
    } finally {
      state.verifyInFlight = false
    }
    // The machine may have moved (disconnect/restart/removal/transition)
    // while the probe was in flight — drop the stale result.
    if (disposed || !isCurrentState(id, state) || state.phase !== 'ready' || epoch !== state.tunnelEpoch) return
    state.lastVerifyAt = Date.now()
    if (verification.ok) {
      // Chain-continuation invariant: after ANY successful verification while
      // the transport is still current/ready, the periodic chain must
      // continue. A user-initiated reverify overlapping the periodic tick
      // eats that tick via single-flight without re-arming, so a successful
      // user probe must restore the chain (otherwise the heartbeat silently
      // dies until the next leave-ready/re-ready cycle — the exact failure
      // this change prevents).
      if (state.readyProbeTimer === null) armReadyVerify(id, state)
      // A successful probe is the only moment a password session may have
      // rotated inside verifyUp (401 → stored-password re-login) — surface it
      // so the owner can re-register the proxy with the fresh cookie when the
      // registered auth headers changed (see onVerified).
      for (const listener of bus.listeners('verified')) {
        try {
          listener(id)
        } catch (listenerError) {
          warn(`transport-manager verified listener threw: ${describeTransportError(listenerError)}`)
        }
      }
      return
    }
    const reason = verification.detail ?? 'the endpoint is not a dsh instance'
    if (verification.terminal === true) {
      failTerminal(id, state, reason, true, 'endpoint')
      return
    }
    scheduleReconnect(id, state, `ready-state verification failed: ${reason}`)
  }

  /**
   * Public on-demand ready-state re-verification (user activation of the
   * source/session, IPC desktop_ssh_reverify): one immediate identity probe
   * for the instance the user is about to act on — a dead gateway session or
   * a dead remote endpoint flips the phase within one probe round-trip
   * instead of waiting for the next heartbeat tick. No-op unless the
   * transport is ready (error/degraded/connecting/idle are owned by the
   * machine's own retry semantics), single-flight and quiet-windowed.
   * @returns the current status projection.
   */
  function reverify(id: string): TransportStatusProjection | null {
    const state = states.get(id)
    if (state === undefined) return status(id)
    void verifyReadyTransport(id, state, 'user')
    return status(id)
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
    // Clear global tracking before consulting registry ownership: removal may
    // already have deleted the state while this child finishes releasing its
    // provider/askpass lease.
    clearTunnelKillEscalation(child)
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
      armKillEscalation(state.child)
    }
    state.childExited = false
    state.authFailed = false
    state.requiresUserAction = false
    state.userActionKind = null
    // This invocation IS the transport attempt (connect or the scheduled
    // reconnect): bump the epoch so any in-flight invocation of a previous
    // attempt (disconnect → reconnect restarts, spec-edit restarts) aborts
    // at its next guard instead of starting/stealing a second transport.
    state.tunnelEpoch += 1
    const epoch = state.tunnelEpoch
    // The connecting phase is entered here so the post-await guards and the
    // readiness-detection loop have a stable anchor.
    transition(id, 'connecting', 'starting transport', state)

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
        if (!isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
        const detail = describeTransportError(allocateError)
        transition(id, 'error', `failed to allocate a local port: ${detail}`, state)
        appendLogInternal(state, 'error', `port allocation failed: ${detail}`)
        // A transient allocation failure (ephemeral-port exhaustion) must not
        // leave the instance stuck in error forever: arm the slow periodic
        // re-probe, same pattern as the max-retry recovery (2026 audit M10).
        state.reconnectTimer = setTimeout(() => {
          state.reconnectTimer = null
          if (!isCurrentState(id, state)) return
          void startTransport(id).catch(error => warn(`transport-manager: slow re-probe rejected: ${describeTransportError(error)}`))
        }, slowRetryMs)
        state.reconnectTimer.unref?.()
        return
      }
      // disconnect()/failTerminal/restart may have landed while the port was
      // being allocated; the phase or the epoch tells us — abort, never start.
      if (!isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
    }
    if (!isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
    state.localPort = localPort

    let args: readonly string[] | null = null
    if (providerForSpec.buildStartArgs !== undefined) {
      try {
        args = providerForSpec.buildStartArgs(spec, localPort as number)
      } catch (buildError) {
        // A throwing provider must never leave the machine stuck in
        // connecting with no child and no recovery machinery.
        const detail = describeTransportError(buildError)
        warn(`transport-manager: providerForSpec.buildStartArgs threw: ${detail}`)
        failTerminal(id, state, `provider build failed: ${detail}`, false)
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
        const detail = describeTransportError(probeError)
        warn(`transport-manager: provider.probeTarget threw: ${detail}`)
        failTerminal(id, state, `provider probeTarget threw: ${detail}`, false)
        return null
      }
    })()
    if (probeTarget === null) return

    if (directEndpoint) {
      // DIRECT ENDPOINT mode: no child process — the endpoint is reached
      // as-is (e.g. a tailnet host); only the probe loop below runs.
      transition(id, 'connecting', `reaching ${spec.host}:${probeTarget.port} directly`, state)
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
          const detail = describeTransportError(envError)
          warn(`transport-manager: providerForSpec.buildStartEnv threw: ${detail}`)
          failTerminal(id, state, `provider buildStartEnv threw: ${detail}`, false)
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
          warn(`transport-manager: provider transport lease release threw: ${describeTransportError(releaseError)}`)
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
        failTerminal(id, state, `failed to spawn transport: ${describeTransportError(spawnError)}`)
        return
      }
      // Bind provider-owned ephemeral resources to the ACTUAL child
      // lifetime before any stale-epoch handling can signal it. Node may
      // emit both error and exit, so the one-shot wrapper owns idempotency.
      child.on('exit', releaseTransportLease)
      child.on('error', releaseTransportLease)
      if (!isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) {
        // A stale epoch (a newer attempt took over while this spawn was in
        // flight): the freshly spawned child must still get the SIGKILL
        // escalation — a SIGTERM-ignoring transport would otherwise become
        // an unreaped orphan.
        signalChild(child, 'SIGTERM')
        armKillEscalation(child)
        return
      }
      state.child = child
      transition(id, 'connecting', `spawning ${args![0]} ${args!.slice(1).join(' ')}`, state)
      const outputOverflow = () => appendLogInternal(
        state,
        'error',
        `transport output line dropped: exceeds ${CHILD_LINE_MAX_CHARS} characters`,
      )
      const processStdout = createBoundedLineProcessor(line => {
        let redacted: string
        try {
          redacted = providerForSpec.redactOutput?.(line) ?? line
        } catch {
          // The exception may include the sensitive source text. Keep the
          // diagnostic fixed and drop the line at the redaction boundary.
          warn('transport-manager: provider.redactOutput threw; stdout dropped')
          appendLogInternal(state, 'error', 'transport output dropped: provider redactor failed')
          return
        }
        if (redacted !== '') appendLogInternal(state, 'info', redacted)
      }, outputOverflow)
      const processStderr = createBoundedLineProcessor(line => {
        let logLine: string
        let terminalAuth: boolean
        try {
          const classified = providerForSpec.classifyStderr(line)
          logLine = classified.log
          terminalAuth = classified.terminalAuth
        } catch {
          // The classifier is also the credential-redaction boundary; never
          // echo its exception or the raw input into logs.
          warn('transport-manager: provider.classifyStderr threw; stderr dropped')
          appendLogInternal(state, 'error', 'transport output dropped: provider classifier failed')
          return
        }
        if (logLine === '') return
        appendLogInternal(state, 'info', logLine)
        if (terminalAuth) {
          state.authFailed = true
          appendLogInternal(state, 'error', 'authentication failure detected (requires user action)')
        }
      }, outputOverflow)
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
        // Spawn failure (e.g. the transport binary is missing): terminal,
        // user action. Guarded: a REPLACED child's late spawn-error must
        // never failTerminal the fresh transport. A spawn error may have no
        // following exit event, so it is also an authoritative end to this
        // child's global shutdown/escalation tracking.
        if (state.child !== child) {
          clearTunnelKillEscalation(child)
          return
        }
        const detail = describeTransportError(error)
        appendLogInternal(state, 'error', `transport spawn error: ${detail}`)
        state.requiresUserAction = true
        failTerminal(id, state, `failed to spawn transport: ${detail}`)
        clearTunnelKillEscalation(child)
      })
    }

    const controller = new AbortController()
    state.readyLoop = controller
    const deadline = Date.now() + readyTimeoutMs
    void (async () => {
      while (!controller.signal.aborted) {
        if (!isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
        if (state.authFailed) return failTerminal(id, state, 'authentication failed — requires user action')
        if (state.childExited) return
        // A rejecting probe must never hang the machine in connecting or
        // crash the loop — a probe failure is simply "not up yet".
        const up = await doProbe(probeTarget.port, { host: probeTarget.host }).catch(() => false)
        if (controller.signal.aborted || !isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
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
            if (controller.signal.aborted || !isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
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
              // the reconnect path. The failure is INSTANCE-level, not
              // transport-level: the tunnel/endpoint transport worked and
              // reached the destination — the UI must show an endpoint
              // hint, never an SSH auth failure (2026-08 fix).
              if (verification.terminal === true) return failTerminal(id, state, reason, true, 'endpoint')
              return scheduleReconnect(id, state, reason)
            }
          }
          if (!state.childExited && (directEndpoint || state.child !== null)) {
            state.retryAttempt = 0
            state.requiresUserAction = false
            transition(id, 'ready', 'transport is up', state)
            appendLogInternal(state, 'info', `transport ready on ${probeTarget.host}:${probeTarget.port}`)
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
    const providerForSpec = resolveProvider(spec)
    if (providerForSpec.exec === undefined) {
      return { ok: false, error: `exec not supported by transport kind ${spec.kind}` }
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
    try {
      const result = await providerForSpec.exec(spec, action, {
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
          if (execId === id && key === 'serviceActive') {
            // Stale-exec guard (same rationale as log): an ssh-specific
            // projection must never leak onto a kind-switched or reused id.
            if (!execIsCurrent()) return
            state.serviceActive = value
            emitStatus(id, state)
          }
        },
        projection: execId => execId === id && execIsCurrent() ? status(execId) : null,
      }, payload)
      // Removal or an ownership-changing same-id edit retires the captured
      // state before installing a fresh one. Even if a provider resolves after
      // ignoring SIGTERM, its old result must never borrow the new registry
      // incarnation's status/projection or present as a successful operation.
      if (!execIsCurrent() || !sameOperationalSpec(instances.get(id), spec)) {
        return { ok: false, error: 'exec superseded by connection change' }
      }
      return result
    } catch (execError) {
      // A throwing/rejecting provider must never escape through the IPC layer
      // as an unhandled rejection — loud error result instead.
      const detail = describeTransportError(execError)
      return { ok: false, error: `exec failed: ${detail}` }
    }
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
   * disconnected and are removed; the set becomes exactly `next`. Save is an
   * atomic proposal: one invalid/provider-mismatched entry or duplicate id rejects
   * the whole replacement before persistence or live transport mutation.
   * (Load-time recovery remains lenient for a damaged existing file.)
   * Instances whose target kind, transport method or parameters
   * changed revoke the old tunnel and exec generations before publication; a
   * previously-live transport restarts so runtime and projection never
   * disagree. Teardown
   * always runs while the OLD spec is still authoritative: provider-owned
   * resources and status listeners must observe/unregister the old kind before
   * the registry starts projecting the replacement kind.
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
    const stopBeforeReplaceIds: string[] = []
    const projectionResetIds: string[] = []
    const seenIds = new Set<string>()
    for (const [index, entry] of next.entries()) {
      // Save is an all-or-nothing proposal. Unlike lenient startup recovery,
      // a malformed caller entry must reject the whole roster before any
      // persistence, credential commit, or runtime mutation.
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        const error: CodedError = new Error(`instance at index ${index} is invalid`)
        error.code = 'ssh_instances_invalid'
        throw error
      }
      // v2 migration first (design 17 §2.2): legacy kinds normalize before
      // provider selection so the provider is resolved by the v2 transport.
      const migrated = canonicalizeTransportInstanceInput(entry)
      const providerFor = resolveProvider(migrated as { kind?: unknown; transport?: unknown })
      const normalized = providerFor.validateSpec(migrated)
      if (normalized === null) {
        const error: CodedError = new Error(`instance at index ${index} is invalid for its transport provider`)
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
      const kindChanged = previous !== undefined && previous.kind !== normalized.kind
      if (previous !== undefined && execIdentityChanged(previous, normalized)) {
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
        // Always revoke the old generation, including the between-child gap
        // of a multi-stage exec where phase is idle and execChildren is
        // momentarily empty. Only an actually live transport is restarted.
        stopBeforeReplaceIds.push(normalized.id)
        if (state.phase !== 'idle') restartIds.push(normalized.id)
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
      // A same-id operational replacement is a fresh runtime generation, not
      // a presentation edit. Drop the retired state's ring/projections after
      // teardown so its terminal "disconnected" entry and cached summary can
      // never be presented as facts of the replacement. Global child kill
      // trackers retain any SIGTERM-pending children independently.
      states.delete(id)
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
    // Revoke both generations FIRST. This fences allocation/verification
    // awaits and every in-flight or between-child provider exec before a
    // same-id replacement can enter connecting under a new spec.
    state.tunnelEpoch += 1
    state.execEpoch += 1
    stopReadyLoop(state)
    if (state.child !== null) {
      const child = state.child
      state.child = null
      signalChild(child, 'SIGTERM')
      armKillEscalation(child)
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
    state.userActionKind = null
    transition(id, 'idle', 'disconnected', state)
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
      userActionKind: state.userActionKind,
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

  /** Subscribe to successful ready-state re-verifications: listener(id) fires
   * after EVERY ready-state identity probe that succeeded while the transport
   * stayed ready (periodic heartbeat or user-initiated reverify) — the moment
   * a gateway password session may have rotated (verifyUp's 401 → one
   * stored-password re-login) and the proxy registration headers must be
   * re-evaluated. Failure paths never emit: they already flip the phase, and
   * the machine's own transitions own the aftermath. */
  function onVerified(listener: (id: string) => void): () => void {
    bus.on('verified', listener)
    return () => bus.removeListener('verified', listener)
  }

  /** Stop every transport, cancel in-flight execs, drop all listeners (app quit). */
  function dispose() {
    disposed = true
    for (const id of [...states.keys()]) disconnect(id)
    // Hygiene sweep: every leave-ready path cancels the probe via
    // transition(), but a state that never left ready must not keep a timer.
    for (const state of states.values()) cancelReadyVerify(state)
    for (const child of execChildren) {
      signalChild(child, 'SIGTERM')
      // Exec children get the same SIGTERM → SIGKILL escalation as tunnel
      // children (2026 audit M2): disposeAsync waits for these to drain, so a
      // SIGTERM-ignoring ssh exec cannot be orphaned at app quit.
      armExecKillEscalation(child)
    }
    bus.removeAllListeners('status-changed')
    bus.removeAllListeners('verified')
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
    reverify,
    readyUrl,
    logs,
    clearLogs,
    appendLog,
    exec,
    onStatusChanged,
    onVerified,
    dispose,
    disposeAsync,
  }
}
