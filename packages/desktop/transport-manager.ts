/**
 * Generic transport runtime: the source-agnostic half of the connection
 * manager. Instances carry orthogonal `kind`/`transport`; the runtime resolves
 * the provider for that transport and owns the generic lifecycle.
 * - Atomic, fail-loud persisted registry (corrupt is never a fake-empty set;
 *   legacy v1 kind entries normalize on load/save).
 * - Phase machine idle → connecting → ready ⇄ degraded → error with two-tier
 *   retry (bounded fast burst, then indefinite slow re-probe); terminal
 *   failures set requiresUserAction and are never auto-retried.
 * - Readiness = TCP accept AND the provider's verifyUp identity check, so a
 *   non-dsh service never presents as ready; the transport URL never leaves
 *   this module raw. Provider/spawn/probe/allocator/RNG are injectable.
 */

import { createTransportRegistry, type SaveInstancesProvenance } from './transport-registry.ts'
import { createLinkHealth } from './transport-link-health.ts'
import { createLinkLoop } from './transport-link-loop.ts'
import type { InstanceState } from './transport-instance-state.ts'
export type { SaveInstancesProvenance } from './transport-registry.ts'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import { signalChild } from './transport-provider.ts'
import net from 'node:net'
import { dirname } from 'node:path'

// Failure text is single-sourced in describe-error.ts; the export name stays.
import { describeError } from './describe-error.ts'
// Owner-only atomic replace (O_EXCL tmp + 0600 + fsync + rename) — the registry
// never hand-writes a fixed-name .tmp path.
import { atomicWritePrivateFileNoFollow, ensurePrivateDirectoryNoFollow } from './control-plane-module.ts'
import { CHILD_LINE_MAX_CHARS, createBoundedLineProcessor } from './bounded-lines.ts'
import { findFreeEphemeralPort } from './free-port.ts'
import {INITIAL_LINK_HEALTH, LINK_POLICY, type LinkPolicy} from './transport-health.ts'
import type {
  SpawnedProcess,
  TransportExecAction,
  TransportExecResult,
  TransportInstanceInput,
  TransportInstanceSpec,
  TransportLogEntry,
  TransportMethod,
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

/** Display/persistence cap after provider redaction: CHILD_LINE_MAX_CHARS bounds
 *  incremental parsing, this smaller cap bounds the 32×200 ring footprint without
 *  weakening the classifier's view of a complete diagnostic line. */
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
 * Slow re-probe cadence after the fast burst is exhausted: the machine lands on
 * error (honest red state) but keeps ONE fresh attempt per slowRetryMs
 * indefinitely. Transient conditions are time-dependent, so "gave up" is never
 * permanent; terminal failures never reach this path, and a manual
 * connect()/disconnect() cancels the probe.
 */
export const SLOW_RETRY_MS = 60_000

/** Quiet window between a completed re-verification and a USER-INITIATED
 *  reverify(): the periodic cadence is the authority, rapid clicks must not pile
 *  probes onto one instance. */
export const READY_VERIFY_MIN_INTERVAL_MS = 10_000

/** Retry backoff with half-open jitter: keep at least half the raw exponential
 *  backoff and jitter the rest, so N-ctx tunnels and post-sleep/wake storms
 *  desynchronize instead of thundering-herding. */
export function jitteredBackoffMs(backoffMs: number, random: () => number = Math.random): number {
  return Math.floor(backoffMs * (0.5 + random() * 0.5))
}

/** SIGTERM → SIGKILL grace when stopping a child. Kept short so app quit is
 *  fast: tunnel teardown has no consistency cost before the deterministic KILL. */
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
  /** Slow re-probe cadence after the fast burst (default SLOW_RETRY_MS): one
   *  fresh attempt per interval, indefinite — only terminal failures stop. */
  slowRetryMs?: number
  disconnectGraceMs?: number
  ringBufferLimit?: number
  /** Provider exec timeout (ssh: systemctl; default 15s). */
  execTimeoutMs?: number
  /** Provider `run` exec timeout (ssh: dsh plugin/write-file; default 120s — pnpm hits the registry). */
  runExecTimeoutMs?: number
  /** Ready-state re-verification cadence. An EXPLICIT value pins one cadence (the
   *  determinism seam the transport tests drive); unset = the production two-tier
   *  default (LINK_POLICY.healthyProbeIntervalMs stable, watchProbeIntervalMs for
   *  LINK_POLICY.watchWindowMs after a ready edge or a health transition). */
  readyVerifyIntervalMs?: number
  /** Minimum gap for a USER-INITIATED reverify (default READY_VERIFY_MIN_INTERVAL_MS). */
  readyVerifyMinIntervalMs?: number
  /** Test seam only: override individual LINK_POLICY values (production reads the table). */
  linkPolicy?: Partial<LinkPolicy>
  /**
   * True while this instance is flushing our OWN bulk request body upstream.
   * The probe shares the tunnel's single TCP, so a timeout inside that window
   * proves congestion, not link loss; such a failure is re-probed and never
   * counted toward `down`. Omitted = never busy (tests/headless).
   */
  linkBusy?: (id: string) => boolean
}

/** createTransportManager dependencies (provider/spawn/probe/allocator injectable). */
export interface TransportManagerDeps {
  provider: TransportProvider
  /** Optional per-spec overrides: resolved BY TRANSPORT (`{ ssh, http }` — one
   *  provider per mechanism, serving both target kinds; validateSpec enforces the
   *  shipped kind×transport matrix), else the default `provider`. The pre-v2
   *  kind-keyed override is gone: a `kind`-keyed entry resolves to nothing. */
  providers?: Partial<Record<TransportMethod, TransportProvider>>
  spawnFn?: (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess
  portProbe?: (port: number, opts?: { timeoutMs?: number; host?: string }) => Promise<boolean>
  /** One-shot endpoint identity verification; defaults to the provider's
   *  verifyUp. Runs after the port probe reports the endpoint up and before the
   *  phase may become ready. Injectable so tests can fake it. */
  verifyProbe?: (spec: TransportInstanceSpec, endpoint: TransportProbeEndpoint, signal?: AbortSignal) => Promise<TransportVerifyResult>
  allocatePort?: () => Promise<number>
  /** Injectable RNG for the jittered reconnect backoff (tests pass a fixed value). */
  random?: () => number
  instancesFile: string
  logger?: { log?(message: string): void; warn?(message: string): void; error?(message: string): void }
  options?: TransportManagerOptions
}

/** Status-change listener: listener(instanceId, statusProjection). */
export type StatusChangedListener = (instanceId: string, status: TransportStatusProjection) => void

/** Synchronous registry delta projected with the instances-changed push: removed
 *  ids come from main's authoritative before/saved snapshots, so a rapid
 *  remove→re-add cannot be erased by a superseding async roster pull. */
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

/** Renderer lifecycle retirement is broader than deletion: changing the
 *  transport identity behind a stable id must tear down the old N-ctx shell so
 *  it cannot attach to a different host; presentation and service/home edits do
 *  not retire it. */
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

/** Registry persistence is committed before the push: a synchronous
 *  BrowserWindow/navigation race is a delivery miss, never a failed save;
 *  callers log and rely on the next pull. */
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

/** Registry-write provenance（F16/A4、F19）：`authoritative` = 真实用户
 * 动作（add/edit/delete/导入）提交的注册表新真相，成功即重建 live 文件，
 * 可以清零加载降级位；`compensation` = 事务失败后的回滚重写，只恢复事务前
 * 的主进程快照——它不是关于 live 文件内容的新事实（降级启动时 `before` 是
 * 内存里的空集，不是未知的磁盘内容），**绝不清零**降级位；且降级位仍非 null
 * 时连磁盘写入也一并跳过（F19：一次成功的空快照写盘会让下次启动把「未知」
 * 读成权威空注册表），只做内存回滚以维持调用方的 rollback 判定。V5-A 的
 * rosterIncomplete 位同理：补偿回滚不清零，且 roster 不完整期间同样跳过写盘
 * （把「行级丢弃后的部分快照」写回磁盘会让下次启动把「部分」读成「完整」）。 */

/** The runtime surface returned by createTransportManager. */
export interface TransportManager {
  loadInstances(): TransportInstanceSpec[]
  /**
   * Read-only health of the persisted registry's LAST load. True when the last
   * loadInstances() failed (corrupt/oversized file, or a missing live file
   * whose preserved .corrupt sibling exists): the in-memory set is then NOT
   * the file's contents, so a degraded empty roster must never be read as an
   * authoritative empty registry. Cleared by a successful load or by an
   * authoritative saveInstances() rebuild; a compensation rollback
   * deliberately keeps it and, while it is set, skips the disk write entirely
   * (see SaveInstancesProvenance).
   *
   * 诊断/测试面 (diagnostic/test-only): the production read face is
   * loadFailure() — the {degraded, reason} projection behind
   * desktop_ssh_instances_health. This predicate is equivalent to
   * loadFailure() !== null and is kept for tests and diagnostics.
   */
  registryDegraded(): boolean
  /** The failure text behind registryDegraded(); null while healthy. */
  loadFailure(): string | null
  /**
   * True when the LAST loadInstances() succeeded but dropped one or more
   * persisted rows (an entry its provider rejected, or a duplicate id): the
   * file HAS content the in-memory roster does not represent, so
   * listInstances() is a PARTIAL view. It must never be read as a complete
   * authoritative roster for retirement — the renderer's durable pruning gate
   * stays closed while this is true (same veto rank as registryDegraded()).
   * Cleared by a successful load with no drops or by an AUTHORITATIVE
   * saveInstances() rebuild; a compensation rollback deliberately keeps it
   * and, while it is set, skips the disk write (see SaveInstancesProvenance).
   *
   * 诊断/测试面 (diagnostic/test-only): the production read face is the
   * desktop_ssh_instances_health projection (rosterIncomplete/droppedCount).
   */
  registryIncomplete(): boolean
  /** Rows the LAST load dropped (invalid entries + duplicate ids); 0 while
   *  the last load was complete or failed. */
  loadDroppedCount(): number
  /** Persist a new instance set. `provenance` defaults to `'authoritative'`
   *  (real user saves/imports); pass `'compensation'` for a transaction
   *  rollback, which must NOT clear the registry-load degraded gate and, while
   *  that gate is closed, must not write the live file at all (F19). */
  saveInstances(next: TransportInstanceInput[], provenance?: SaveInstancesProvenance): TransportInstanceSpec[]
  listInstances(): TransportInstanceSpec[]
  connect(id: string): TransportStatusProjection | null
  disconnect(id: string): void
  status(id: string): TransportStatusProjection | null
  /** On-demand ready-state re-verification (user activation/resume/online): one
   *  immediate identity probe for a READY transport; no-op unless ready. */
  reverify(id: string, reason?: 'user' | 'resume' | 'online'): TransportStatusProjection | null
  /** Re-probe every READY remote (OS resume / renderer online). */
  reverifyAll(): void
  /** Failure-driven probe: a forwarded request got no HTTP answer while the link
   *  was healthy. Throttled; a no-op for non-ready/suspect/down/busy instances. */
  notifyLinkFailure(id: string): void
  /** The ready transport URL — INTERNAL ONLY. */
  readyUrl(id: string): string | null
  logs(id: string): TransportLogEntry[]
  clearLogs(id: string): boolean
  /** Append one line to an instance's ring buffer from OUTSIDE the runtime
   *  (plugin-sync outcomes, …); false for an unknown id. */
  appendLog(id: string, level: TransportLogEntry['level'], message: string): boolean
  /** Provider exec channel (ssh: remote systemd start/stop/restart/is-active;
   *  run = whitelisted remote command). */
  exec(id: string, action: TransportExecAction, payload?: TransportRunPayload): Promise<TransportExecResult>
  onStatusChanged(listener: StatusChangedListener): () => void
  /** Subscribe to successful ready-state re-verifications: listener(id) after
   *  every successful probe (periodic or user-initiated) while still ready. */
  onVerified(listener: (id: string) => void): () => void
  dispose(): void
  /** dispose() + wait for every SIGKILL escalation to resolve (app quit). */
  disposeAsync(): Promise<void>
}

/**
 * Replace provider-owned credentials without leaving a live transport bound to
 * the previous value. The writer is write-through: on a throw its old in-memory
 * value stays authoritative and the transport is restored under it.
 *
 * `belongsTo` answers "is the LIVE transport the consumer of this credential?":
 * ssh passwords match the SSH TRANSPORT, gateway tokens the GATEWAY TARGET (a
 * dsh target never consumes a token). A kind/transport switch leaves the
 * replacement provider's live transport alone.
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
  // An exec may run while the transport is idle: it still belongs to the old
  // credential generation and must be stopped before a clear/write.
  const shouldDisconnect = applicable
  if (shouldDisconnect) transport.disconnect(id)
  try {
    commit()
  } catch (error) {
    // A failed write-through commit leaves the previous value live; restore it.
    if (shouldReconnect) transport.connect(id)
    throw error
  }
  if (shouldReconnect) transport.connect(id)
}

/** Fields that bind provider exec work to one connection generation: label, HTTP
 *  scheme and SPKI do not change an SSH exec target; service and dsh home do.
 *  saveInstances disconnects/bump-epochs on the same set. */
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

/** Error that may carry a machine-readable code. */
interface CodedError extends Error {
  code?: string
}

/** Exception-safe formatter for provider hooks, injected deps and event data:
 *  catch blocks are part of the state machine and must never throw. */
const describeTransportError = describeError

/** Local -L bind races with the OS ephemeral allocator; ExitOnForwardFailure makes
 * the child exit, and the manager re-allocates without charging a retry attempt. */
// Narrow to actual local listener failures: remote forwarding refusals also use
// generic ssh wording and must go through the normal bounded retry path.
const PORT_BIND_FAILURE_PATTERN = /address already in use|cannot listen/i

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Persist the registry through the control-plane private-file primitive:
 *  random O_EXCL temp + 0600 + fsync + rename + parent fsync, refusing a planted
 *  symlink / multi-link leaf fail-closed; all writes serialize through
 *  saveInstances, and the rollback path rewrites the previous roster. */
function writeFileAtomic(filePath: string, text: string): void {
  ensurePrivateDirectoryNoFollow(dirname(filePath), 0o700)
  atomicWritePrivateFileNoFollow(filePath, text, { mode: 0o600 })
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

/** Create the transport runtime for one provider: the provider owns source-
 *  specific validation/argv/classification/exec, everything else is generic. */
export function createTransportManager({ provider, providers, spawnFn, portProbe, verifyProbe, allocatePort, random, instancesFile, logger, options = {} }: TransportManagerDeps): TransportManager {
  const linkPolicy: LinkPolicy = { ...LINK_POLICY, ...(options.linkPolicy ?? {}) }
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
  const readyVerifyIntervalMs = options.readyVerifyIntervalMs ?? linkPolicy.healthyProbeIntervalMs
  const readyVerifyMinIntervalMs = options.readyVerifyMinIntervalMs ?? READY_VERIFY_MIN_INTERVAL_MS
  // The runtime registry is TRANSPORT-keyed ('ssh'|'http'); the key type is a
  // plain string (a TransportMethod is not a TransportKind).
  const providersByKey = providers as Partial<Record<string, TransportProvider>> | undefined
  // Explicit annotation: `spawnFn ?? default` would infer a union of call
  // signatures (SpawnedProcess | ChildProcess), making `child.on` uncallable.
  const doSpawn: (command: string, args: readonly string[], opts: SpawnOptions) => SpawnedProcess =
    spawnFn ?? ((command: string, args: readonly string[], opts: SpawnOptions) => spawn(command, args, opts))
  const doProbe = portProbe ?? defaultPortProbe
  /** Resolve the provider for a spec (design 17 §2.2): the TRANSPORT-keyed
   * override wins (`providers: { ssh, http }` — one provider per mechanism,
   * serving both target kinds), else the default provider. The pre-v2
   * kind-keyed override is gone. */
  const resolveProvider = (entry: { kind?: unknown; transport?: unknown }): TransportProvider => {
    if (typeof entry.transport === 'string') {
      const byTransport = providersByKey?.[entry.transport]
      if (byTransport !== undefined) return byTransport
    }
    return provider
  }
  const doVerify = verifyProbe ?? ((spec: TransportInstanceSpec, endpoint: TransportProbeEndpoint, signal?: AbortSignal) => {
    const verify = resolveProvider(spec).verifyUp
    // A provider without verifyUp has no destination-identity check: pass.
    return verify === undefined ? Promise.resolve({ ok: true }) : verify(spec, endpoint, signal)
  })
  // Default allocator: one OS-assigned loopback port (bind(0) semantics).
  const doAllocate = allocatePort ?? findFreeEphemeralPort
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
  /** Exec-child SIGTERM → SIGKILL escalations: same grace as tunnel children;
   *  disposeAsync waits for both — a SIGTERM-ignoring ssh exec must not survive quit. */
  const execKillEscalations = new Map<SpawnedProcess, ReturnType<typeof setTimeout>>()
  /** Global tunnel escalation tracker: instance state may be deleted as soon as
   *  its row is removed, but app shutdown must still wait for that generation's
   *  SIGKILL/real exit and askpass-lease release. */
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
        probeAbort: null,
        lastLinkEventAt: 0,
        portBindFailed: false,
        portBindRetries: 0,
        link: { ...INITIAL_LINK_HEALTH },
        linkEpoch: 0,
        downGraceTimer: null,
        downGraceDeadlineAt: 0,
        pendingForcedProbe: false,
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

  /** State object identity is the registry-incarnation token: removal deletes it
   *  from `states` and a same-id re-add gets a different object, so old async
   *  closures can cheaply prove they own no projection/log writes. */
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
      // EVERY phase change flows through here, so arming on ready and canceling on
      // leaving ready cannot drift from the machine.
      if (next === 'ready') {
        // A fresh ready edge is the page-channel's reset key. Health starts healthy
        // for this incarnation; the probe reducer owns any later suspect/down.
        state.link = { ...INITIAL_LINK_HEALTH }
        state.portBindRetries = 0
        state.linkEpoch += 1
        armReadyVerify(id, state)
      } else {
        cancelReadyVerify(state)
        // Leaving ready revokes this incarnation's in-flight probe: a reconnect/terminal
        // edge must not leave it running for the rest of its provider budget (it could
        // still rotate a gateway session after the transport it probed for is gone).
        state.probeAbort?.abort()
        state.probeAbort = null
        clearDownGrace(state)
        // Health is meaningful only in ready (I2): EVERY leave-ready edge drops the
        // projection, so a degraded/reconnecting status never shows a stale
        // down/suspect link next to a phase that no longer owns it. The reason the
        // link went down is already in logSummary.
        state.link = { ...INITIAL_LINK_HEALTH }
      }
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

/** Arm the SIGTERM → SIGKILL escalation for ONE specific child: only that child's
 *  exit clears it, and arming another child never cancels a pending one — a
 *  SIGTERM-ignoring child always gets its SIGKILL. */
  function armKillEscalation(child: SpawnedProcess) {
    // One non-renewable deadline per child; repeated disconnect cannot postpone it.
    if (tunnelKillEscalations.has(child)) return
    const timer = setTimeout(() => {
      // Keep the GLOBAL entry until the actual child exit/error, so disposeAsync
      // cannot return between SIGKILL and the askpass-lease release.
      signalChild(child, 'SIGKILL')
    }, disconnectGraceMs)
    timer.unref?.()
    tunnelKillEscalations.set(child, timer)
  }

  /** A child lifecycle terminal event owns both escalation indexes; also used for a
   *  spawn `error`, which Node may emit without a later `exit` — retaining it
   *  would make shutdown wait for a process that was never created. */
  function clearTunnelKillEscalation(child: SpawnedProcess) {
    const escalation = tunnelKillEscalations.get(child)
    if (escalation !== undefined) {
      clearTimeout(escalation)
      tunnelKillEscalations.delete(child)
    }
  }

  /** Arm one non-renewable SIGTERM → SIGKILL deadline for an exec child:
   *  disconnect(), repeated disconnects and dispose() share the map, so none can
   *  postpone the deadline or deliver a second manager-owned KILL. */
  function armExecKillEscalation(child: SpawnedProcess) {
    if (execKillEscalations.has(child)) return
    const timer = setTimeout(() => {
      // Keep tracking until the child lifecycle reports exit/error; the grace
      // timer merely requests termination.
      signalChild(child, 'SIGKILL')
    }, disconnectGraceMs)
    timer.unref?.()
    execKillEscalations.set(child, timer)
  }

  /**
   * Terminal failure (auth, spawn, deterministic endpoint verification, or a
   * provider contract exception): stop recovery and land on error. Expected
   * config/auth failures set requiresUserAction; provider exceptions remain an
   * internal failure, never a false instruction to repair connection settings.
   * `userActionKind` discriminates the class for the UI: 'auth' = transport/
   * credential-level (SSH auth, host key, spawn), 'endpoint' = instance-level
   * terminal probe failure — the tunnel itself is fine, so the UI must never
   * suggest fixing SSH credentials. Defaults to 'auth'.
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
   * Bounded reconnect scheduling: land on degraded, then a fresh transport after
   * a jittered exponential backoff capped at retryMaxMs. maxRetryAttempts bounds
   * the FAST burst; a fresh connect() resets the counter. When the burst is
   * exhausted the machine lands on error but keeps an indefinite slow re-probe —
   * transient conditions are time-dependent and must recover without user action.
   * A manual connect()/disconnect() cancels the pending probe; terminal failures
   * never reach here.
   */
  function scheduleReconnect(id: string, state: InstanceState, reason: string) {
    if (!isCurrentState(id, state)) return
    clearDownGrace(state)
    if (state.reconnectTimer !== null) return
    if (state.retryAttempt >= maxRetryAttempts) {
      // 与快速路径同款清理：耗尽可能经 ready-loop 超时/验证失败到达，彼时子
      // 进程还活着——不留僵尸隧道与过期 localPort 投影。
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
      // recovery): each fire runs ONE fresh attempt, success lands ready and
      // resets counters, and requiresUserAction stays false.
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
    // A throwing injected RNG must never crash main from the exit handler — fall
    // back to the raw backoff.
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

  /** The endpoint a READY transport probes: the LIVE tunnel listener (ssh) or the
   *  direct endpoint (http) — same derivation as connect-time, so it sees the
   *  exact destination the proxy reaches. null when none (defensive). */
  const linkHealth = createLinkHealth({ linkPolicy, emitStatus, appendLogInternal, warn })
  const {
    cancelReadyVerify, clearDownGrace, probeBudgetFor,
  } = linkHealth

  const linkLoop = createLinkLoop({
    states,
    instances,
    linkPolicy,
    linkHealth,
    bus,
    isDisposed: () => disposed,
    isCurrentState,
    failTerminal,
    scheduleReconnect,
    appendLogInternal,
    resolveProvider,
    doRandom,
    doVerify,
    verifyProbe,
    warn,
    readyVerifyIntervalMs,
    readyVerifyMinIntervalMs,
    status,
    linkBusy: options.linkBusy,
    explicitReadyVerifyInterval: options.readyVerifyIntervalMs !== undefined,
  })
  const {
    armReadyVerify, cancelOnlineWave, notifyLinkFailure, reverify, reverifyAll, cancelReverify, lastFailureProbeAt, withProbeDeadline,
  } = linkLoop

  function onChildExit(id: string, state: InstanceState, child: SpawnedProcess, code: number | null, signal: NodeJS.Signals | null) {
    // Clear global tracking before registry ownership: removal may already have
    // deleted the state while this child releases its provider/askpass lease.
    clearTunnelKillEscalation(child)
    if (!isCurrentState(id, state)) return
    if (state.child !== child) return
    state.child = null
    state.childExited = true
    log(`transport-manager: ${id} transport process exited (${code ?? signal})`)
    appendLogInternal(state, 'warn', `transport process exited (${code ?? signal})`)
    if (state.portBindFailed && state.phase === 'connecting' && state.portBindRetries < 3) {
      // The OS gave our probe port away between bind-and-release and ssh -L. This
      // is not a transport attempt failure: re-allocate and retry without charging
      // the bounded burst, but never loop forever on a persistently forbidden bind.
      state.portBindFailed = false
      state.portBindRetries += 1
      state.localPort = null
      state.childExited = false
      appendLogInternal(state, 'info', 'local forward bind lost; re-allocating port without a retry attempt')
      void startTransport(id).catch(error => warn(`transport-manager: bind re-allocation rejected: ${describeTransportError(error)}`))
      return
    }
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

  /** Start one transport attempt and drive it to ready/degraded/error: poll the
   *  tunnel up to readyTimeoutMs; TCP accept + verification is the honest up signal. */
  async function startTransport(id: string) {
    if (disposed) return
    const spec = instances.get(id)
    if (spec === undefined) return
    // The provider for THIS instance's kind: a gateway target → gatewayProvider,
    // an ssh instance → sshProvider.
    const providerForSpec = resolveProvider(spec)
    const state = ensureState(id)
    // A ready transport is not re-started; an already-connecting invocation is
    // idempotent (connect() refuses while connecting/ready).
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
    state.portBindFailed = false
    state.authFailed = false
    state.requiresUserAction = false
    state.userActionKind = null
    // This invocation IS the transport attempt: bump the epoch so an in-flight
    // invocation of a previous attempt aborts at its guard instead of stealing it.
    state.tunnelEpoch += 1
    const epoch = state.tunnelEpoch
    // Every fresh attempt starts with a clean link-health streak. The ready edge
    // bumps linkEpoch; a failed attempt never inherits the previous streak.
    state.link = { ...INITIAL_LINK_HEALTH }
    clearDownGrace(state)
    // Entered here so the post-await guards and readiness loop have a stable anchor.
    transition(id, 'connecting', 'starting transport', state)

    let localPort: number | null = null
    // buildStartArgs present = tunnel (local port); absent = DIRECT ENDPOINT mode.
    if (providerForSpec.buildStartArgs !== undefined) {
      try {
        localPort = await doAllocate()
      } catch (allocateError) {
        // disconnect()/failTerminal/restart may have landed while allocating:
        // never arm recovery for a machine that moved on.
        if (!isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
        const detail = describeTransportError(allocateError)
        transition(id, 'error', `failed to allocate a local port: ${detail}`, state)
        appendLogInternal(state, 'error', `port allocation failed: ${detail}`)
        // A transient allocation failure (port exhaustion) must not stick in error
        // forever: arm the slow periodic re-probe (same pattern as max-retry).
        state.reconnectTimer = setTimeout(() => {
          state.reconnectTimer = null
          if (!isCurrentState(id, state)) return
          void startTransport(id).catch(error => warn(`transport-manager: slow re-probe rejected: ${describeTransportError(error)}`))
        }, slowRetryMs)
        state.reconnectTimer.unref?.()
        return
      }
      // The phase or epoch tells whether the machine moved on — abort, never start.
      if (!isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
    }
    if (!isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
    state.localPort = localPort

    let args: readonly string[] | null = null
    if (providerForSpec.buildStartArgs !== undefined) {
      try {
        args = providerForSpec.buildStartArgs(spec, localPort as number)
      } catch (buildError) {
        // A throwing provider must never leave the machine stuck in connecting.
        const detail = describeTransportError(buildError)
        warn(`transport-manager: providerForSpec.buildStartArgs threw: ${detail}`)
        failTerminal(id, state, `provider build failed: ${detail}`, false)
        return
      }
    }
    const directEndpoint = args === null
    // A contradictory provider (buildStartArgs returning null) must not leak the
    // never-bound port into projections/readyUrl — direct mode owns neither.
    if (directEndpoint) state.localPort = null
    const probeTarget = (() => {
      try {
        return directEndpoint
          ? (providerForSpec.probeTarget?.(spec) ?? { host: spec.host, port: spec.remotePort })
          : { host: '127.0.0.1', port: localPort as number }
      } catch (probeError) {
        // A throwing probeTarget must leave a loud error, never stuck connecting.
        const detail = describeTransportError(probeError)
        warn(`transport-manager: provider.probeTarget threw: ${detail}`)
        failTerminal(id, state, `provider probeTarget threw: ${detail}`, false)
        return null
      }
    })()
    if (probeTarget === null) return

    if (directEndpoint) {
      // DIRECT ENDPOINT mode: no child — the endpoint is reached as-is; only the
      // probe loop below runs.
      transition(id, 'connecting', `reaching ${spec.host}:${probeTarget.port} directly`, state)
    } else {
      // Provider-owned extra environment (ssh askpass) merges OVER process.env —
      // never replaces it (the child keeps HOME, PATH, …).
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
          windowsHide: true,
          env: transportLease === null ? undefined : { ...process.env, ...transportLease.env },
        })
      } catch (spawnError) {
        releaseTransportLease()
        state.requiresUserAction = true
        failTerminal(id, state, `failed to spawn transport: ${describeTransportError(spawnError)}`)
        return
      }
      // Bind provider-owned ephemeral resources to the ACTUAL child lifetime before
      // stale-epoch handling can signal it (Node may emit both error and exit).
      child.on('exit', releaseTransportLease)
      child.on('error', releaseTransportLease)
      if (!isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) {
        // A stale epoch (newer attempt took over mid-spawn): the fresh child must
        // still get the SIGKILL escalation or it becomes an unreaped orphan.
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
          // The exception may include sensitive source text: drop the line at the
          // redaction boundary.
          warn('transport-manager: provider.redactOutput threw; stdout dropped')
          appendLogInternal(state, 'error', 'transport output dropped: provider redactor failed')
          return
        }
        if (redacted !== '') appendLogInternal(state, 'info', redacted)
      }, outputOverflow)
      const processStderr = createBoundedLineProcessor(line => {
        if (PORT_BIND_FAILURE_PATTERN.test(line)) state.portBindFailed = true
        let logLine: string
        let terminalAuth: boolean
        try {
          const classified = providerForSpec.classifyStderr(line)
          logLine = classified.log
          terminalAuth = classified.terminalAuth
        } catch {
          // The classifier is also the redaction boundary: never echo its exception
          // or the raw input into logs.
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
        // Spawn failure (e.g. binary missing): terminal, user action. A REPLACED
        // child's late spawn-error must never fail the fresh transport; it may have
        // no exit event, so it ends this child's shutdown/escalation tracking.
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
        // A rejecting probe is simply "not up yet" — never a hang or a crash.
        const up = await doProbe(probeTarget.port, { host: probeTarget.host }).catch(() => false)
        if (controller.signal.aborted || !isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
        if (up) {
          // TCP-up is not an honest "the destination is dsh" signal — ANY service
          // would accept the connection. Verify the destination protocol before
          // declaring ready, or a non-dsh service presents as a ready instance.
          if (doVerify !== undefined) {
            let verification: TransportVerifyResult
            const connectProbeAbort = new AbortController()
            state.probeAbort = connectProbeAbort
            try {
              // Same provider-declared budget as the ready-state probe: a verifier
              // that violates its contract must not freeze the connect loop, and a
              // composite gateway verify must be allowed its whole 30s.
              verification = await withProbeDeadline(
                doVerify(spec, probeTarget, connectProbeAbort.signal),
                probeBudgetFor(spec, providerForSpec),
                () => { connectProbeAbort.abort() },
              )
            } catch (verifyError) {
              // A throwing verifier must never hang connecting — loud degraded path.
              warn(`transport-manager: endpoint verification threw: ${describeTransportError(verifyError)}`)
              verification = { ok: false, detail: 'endpoint verification failed', failureKind: 'network' }
            }
            if (state.probeAbort === connectProbeAbort) state.probeAbort = null
            if (controller.signal.aborted || !isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
            // An auth failure that landed during verification must stay terminal.
            if (state.authFailed) return failTerminal(id, state, 'authentication failed — requires user action')
            if (!verification.ok) {
              const reason = verification.detail ?? 'the endpoint is not a dsh instance'
              appendLogInternal(state, 'warn', reason)
              // A DETERMINISTIC verification failure (the destination answered the
              // probe and proved it is not a compatible dsh) is terminal: retrying
              // cannot change the answer, so it lands on error immediately instead of
              // burning the bounded reconnect cycle. Only transient failures enter the
              // reconnect path; the failure is INSTANCE-level — the transport worked —
              // so the UI shows an endpoint hint, never an SSH auth failure.
              if (verification.terminal === true) return failTerminal(id, state, reason, true, 'endpoint')
              return scheduleReconnect(id, state, reason)
            }
          }
          if (!state.childExited && (directEndpoint || state.child !== null)) {
            state.retryAttempt = 0
            state.requiresUserAction = false
            // A fresh ready edge starts the watch window: the first heartbeats run
            // at the tight cadence while the new relay path is still unproven.
            state.lastLinkEventAt = Date.now()
            transition(id, 'ready', 'transport is up', state)
            appendLogInternal(state, 'info', `transport ready on ${probeTarget.host}:${probeTarget.port}`)
          }
          return
        }
        if (Date.now() >= deadline) {
          // An auth failure that landed during the final probe must stay terminal.
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
    // Snapshot the exec generation: a late callback of an exec started before a
    // disconnect is stale and drops its write. The identity comparison below is
    // the authoritative fence even between children of a multi-step exec.
    const execEpoch = state.execEpoch
    const execIsCurrent = (): boolean => {
      const current = instances.get(id)
      return !disposed && state.execEpoch === execEpoch
        && current !== undefined && !execIdentityChanged(spec, current)
    }
    // Wrap the spawn so in-flight exec children are tracked per instance
    // (SIGTERMed by disconnect) and globally (SIGTERMed by dispose/app quit).
    const trackedSpawn = (command: string, args: readonly string[], spawnOptions: SpawnOptions) => {
      // Multi-stage execs (write-file then read-back) may request another child
      // after an await: never let an old-spec saga spawn after retarget/delete/
      // dispose — throwing releases the just-acquired askpass lease.
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
        // A real exit or spawn failure cancels the pending manager escalation;
        // askpass keeps its own per-child lease bound to the same lifecycle.
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
          // Stale-exec guard: never write into a reused/kind-switched instance.
          if (!execIsCurrent()) return
          appendLogInternal(state, level, message)
        },
        setProjection: (execId, key, value) => {
          if (execId === id && key === 'serviceActive') {
            // Stale-exec guard: an ssh-specific projection must never leak onto a reused id.
            if (!execIsCurrent()) return
            state.serviceActive = value
            emitStatus(id, state)
          }
        },
        projection: execId => execId === id && execIsCurrent() ? status(execId) : null,
      }, payload)
      // Removal or an ownership-changing same-id edit retires the captured state:
      // a SIGTERM-ignoring provider's old result must never borrow the new incarnation.
      if (!execIsCurrent() || !sameOperationalSpec(instances.get(id), spec)) {
        return { ok: false, error: 'exec superseded by connection change' }
      }
      return result
    } catch (execError) {
      // A rejecting provider must never escape IPC as an unhandled rejection.
      const detail = describeTransportError(execError)
      return { ok: false, error: `exec failed: ${detail}` }
    }
  }

  /**
   * Persisted-registry load health (F13/V5-A). One object so the registry module can
   * mutate it through a stable reference; the accessors below read the same fields.
   * Never credential material.
   */
  const registryState: { loadFailure: string | null; incomplete: boolean; droppedCount: number } = {
    loadFailure: null,
    incomplete: false,
    droppedCount: 0,
  }
  const registry = createTransportRegistry({
    instances,
    states,
    instancesFile,
    state: registryState,
    log,
    warn,
    writeFileAtomic,
    resolveProvider,
    connect: (id) => { connect(id) },
    disconnect: (id) => { disconnect(id) },
    execIdentityChanged,
    lastFailureProbeAt,
  })
  const { loadInstances, saveInstances, listInstances } = registry

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
    state.portBindRetries = 0
    state.requiresUserAction = false
    transition(id, 'connecting', 'starting transport', state)
    void startTransport(id).catch(error => warn(`transport-manager: startTransport rejected: ${describeTransportError(error)}`))
    return status(id)
  }

  /** Stop the transport: cancel pending reconnects, SIGTERM (then SIGKILL after the
   *  grace period), land on idle. Phase machine and logs stay; the local port is
   *  released on the next connect. */
  function disconnect(id: string) {
    const state = states.get(id)
    if (state === undefined) return
    if (state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }
    // Revoke both generations FIRST: fences allocation/verification awaits and
    // every in-flight or between-child exec before a same-id replacement connects.
    state.tunnelEpoch += 1
    state.execEpoch += 1
    // A probe in flight for THIS transport is stale the moment it is revoked: cancel
    // it instead of letting it run out its provider budget (a late gateway session
    // rotation after disconnect was the side effect).
    state.probeAbort?.abort()
    state.probeAbort = null
    stopReadyLoop(state)
    if (state.child !== null) {
      const child = state.child
      state.child = null
      signalChild(child, 'SIGTERM')
      armKillEscalation(child)
    }
    // In-flight provider execs belong to this transport: a disconnect cancels them
    // too (late callbacks are stale via the execEpoch bump). Enforce the short
    // disconnect grace — the provider's 120s run timeout is no teardown boundary.
    for (const child of state.execChildren) {
      signalChild(child, 'SIGTERM')
      armExecKillEscalation(child)
    }
    // Provider-owned per-instance resources retire with the transport, but SSH
    // askpass generations stay available to SIGTERM-pending children until their
    // leases release. The password survives disconnect/quit; only an explicit clear
    // or the main-owned save/delete transaction removes it.
    const spec = instances.get(id)
    if (spec !== undefined) resolveProvider(spec).disposeAuth?.(spec)
    state.localPort = null
    state.retryAttempt = 0
    state.requiresUserAction = false
    state.userActionKind = null
    transition(id, 'idle', 'disconnected', state)
    appendLogInternal(state, 'info', 'disconnected')
  }

  /** The non-secret status projection: phase/ports/retry/userAction/service fields
   *  only — never a transport URL or credential material. null for an unknown
   *  instance. */
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
      link: {
        state: state.link.health,
        linkEpoch: state.linkEpoch,
      },
    }
  }

  /** The ready transport URL — INTERNAL ONLY, never exposed through status() or the
   *  IPC surface (the renderer builds webview URLs from localPort alone). null unless
   *  the local tunnel is ready. */
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

  /** Subscribe to successful ready-state re-verifications: listener(id) fires after
   *  every successful probe while still ready — the moment a gateway session may
   *  have rotated and proxy registration headers must be re-evaluated. */
  function onVerified(listener: (id: string) => void): () => void {
    bus.on('verified', listener)
    return () => bus.removeListener('verified', listener)
  }

  /** Stop every transport, cancel in-flight execs, drop all listeners (app quit). */
  function dispose() {
    disposed = true
    cancelReverify()
    cancelOnlineWave()
    for (const id of [...states.keys()]) disconnect(id)
    // Hygiene sweep: a state that never left ready must not keep a probe timer.
    for (const state of states.values()) cancelReadyVerify(state)
    for (const child of execChildren) {
      signalChild(child, 'SIGTERM')
      // Same SIGTERM → SIGKILL escalation as tunnel children: disposeAsync drains
      // these, so a SIGTERM-ignoring ssh exec cannot be orphaned at app quit.
      armExecKillEscalation(child)
    }
    bus.removeAllListeners('status-changed')
    bus.removeAllListeners('verified')
  }

  /** dispose() then wait for every SIGKILL escalation to resolve (the child exits on
   *  SIGTERM, or the grace-period SIGKILL fires). Without the wait an ssh child
   *  ignoring SIGTERM would be orphaned — the timers are unref'd. Bounded by
   *  disconnectGraceMs + 1s. */

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
    registryDegraded: () => registryState.loadFailure !== null,
    loadFailure: () => registryState.loadFailure,
    registryIncomplete: () => registryState.incomplete,
    loadDroppedCount: () => registryState.droppedCount,
    saveInstances,
    listInstances,
    connect,
    disconnect,
    status,
    reverify,
    reverifyAll,
    notifyLinkFailure,
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
