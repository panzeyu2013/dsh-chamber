/**
 * Generic transport runtime: source-agnostic half of the connection manager.
 * Instances carry orthogonal kind/transport; this module owns the generic
 * lifecycle: atomic persisted registry, phase machine (idle/connecting/ready/
 * degraded/error), readiness (TCP + provider verifyUp), and injectable
 * provider/spawn/probe/allocator/RNG seams. The transport URL never leaves raw.
 * - terminal failures set requiresUserAction and are not auto-retried by default;
 *   the sole exception is a provider-declared terminalRetryable verdict, which gets
 *   the bounded terminal re-check cadence (see armTerminalRetry).
 */

import { createTransportRegistry, type SaveInstancesProvenance } from './transport-registry.ts'
import { createLinkHealth } from './transport-link-health.ts'
import { createLinkLoop } from './transport-link-loop.ts'
import type { InstanceState } from './transport-instance-state.ts'
export type { SaveInstancesProvenance } from './transport-registry.ts'
import type { HostKeyGuard } from './host-key.ts'
import { toHostKeyProjection } from './host-key.ts'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import { signalChild } from './transport-provider.ts'
import { clearSshChild, recordSshChild } from './ssh-orphan.ts'
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

/** How long the transport listener has to accept TCP (local port / direct endpoint)
 *  before the attempt counts as unreachable. This window bounds REACHABILITY only:
 *  once the port accepts, the identity/composite verify gets its own window. */
export const READY_TIMEOUT_MS = 10_000

/** Authentication / composite-verify window once the endpoint accepts TCP. The
 *  connect-time verify budget is max(this, provider.verifyUpBudgetMs + cushion), so a
 *  slow multi-exchange gateway login is never judged by the 10s reachability window. */
export const AUTH_READY_TIMEOUT_MS = 20_000

/** Slack over the provider-declared verify budget: the provider's own inner timeout
 *  must classify the failure first; this outer dead-man deadline only releases a
 *  verifier that never settles. */
export const VERIFY_BUDGET_CUSHION_MS = 5_000

/**
 * Budget of ONE connect-time verify. The provider declares its composite worst case
 * (gateway password flow: login 10s → probe 5s → 401 → re-login 10s → re-probe 5s =
 * 30s, declared 35s); the cushion keeps the manager's outer deadline behind that
 * declared flow, and the authentication window is the floor for single-exchange
 * providers. The total attempt deadline is therefore
 * READY_TIMEOUT_MS + this budget, never just READY_TIMEOUT_MS.
 */
export function connectVerifyBudgetMs(
  authReadyTimeoutMs: number,
  providerBudgetMs: number,
  cushionMs: number = VERIFY_BUDGET_CUSHION_MS,
): number {
  // probeBudgetFor already guarantees a positive finite provider budget (it falls
  // back to linkPolicy.probeTimeoutMs), so the arithmetic is monotonic here.
  return Math.max(authReadyTimeoutMs, providerBudgetMs + cushionMs)
}

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
 * permanent; ORDINARY terminal failures never reach this path (a provider-declared
 * retryable terminal uses armTerminalRetry's own cadence), and a manual
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
  const safeBase = Number.isFinite(backoffMs) && backoffMs > 0 ? backoffMs : 1
  try {
    const delay = Math.floor(safeBase * (0.5 + random() * 0.5))
    return Number.isFinite(delay) && delay > 0 ? delay : safeBase
  } catch {
    return safeBase
  }
}

/** First terminal re-probe delay; each subsequent attempt backs off x3. */
export const TERMINAL_RETRY_BASE_MS = 300_000
/** Terminal re-probe ceiling (one hour). */
export const TERMINAL_RETRY_MAX_MS = 3_600_000

/** Symmetric ±20% jitter for the slow re-probe: mean == base, never below 0.8x.
 *  A hostile/NaN RNG (or a non-finite base) must never become setTimeout(0). */
export function slowRetryDelayMs(base: number, random: () => number = Math.random): number {
  const safeBase = Number.isFinite(base) && base > 0 ? base : 1
  try {
    const delay = Math.floor(safeBase * (0.8 + random() * 0.4))
    return Number.isFinite(delay) && delay > 0 ? delay : safeBase
  } catch {
    return safeBase
  }
}

/** Bounded terminal re-probe delay: 5m, 15m, 45m, then the 60m ceiling. */
export function terminalRetryDelayMs(
  attempt: number,
  base: number = TERMINAL_RETRY_BASE_MS,
  max: number = TERMINAL_RETRY_MAX_MS,
  random: () => number = Math.random,
): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1
  const safeBase = Number.isFinite(base) && base > 0 ? base : TERMINAL_RETRY_BASE_MS
  const safeMax = Number.isFinite(max) && max > 0 ? Math.max(max, safeBase) : safeBase
  const raw = Math.min(safeBase * 3 ** (safeAttempt - 1), safeMax)
  try {
    const delay = Math.floor(raw * (0.9 + random() * 0.2))
    // The jitter must never push an attempt past the declared ceiling.
    return Math.min(safeMax, Number.isFinite(delay) && delay > 0 ? delay : raw)
  } catch {
    return raw
  }
}

/** SIGTERM → SIGKILL grace when stopping a child. Kept short so app quit is
 *  fast: tunnel teardown has no consistency cost before the deterministic KILL. */
export const DISCONNECT_GRACE_MS = 1_000

/** Per-attempt TCP connect timeout of the default port probe. */
export const PROBE_ATTEMPT_TIMEOUT_MS = 400

/** Tunable runtime behavior (tests pass small values). */
export interface TransportManagerOptions {
  /** TCP/port reachability window (default READY_TIMEOUT_MS). */
  readyTimeoutMs?: number
  /** Authentication/composite-verify window after TCP accepts (default
   *  AUTH_READY_TIMEOUT_MS); the connect verify budget is max(this, provider
   *  verifyUpBudgetMs + verifyBudgetCushionMs). */
  authReadyTimeoutMs?: number
  /** Slack over the provider-declared verify budget (default VERIFY_BUDGET_CUSHION_MS). */
  verifyBudgetCushionMs?: number
  probeIntervalMs?: number
  maxRetryAttempts?: number
  retryBaseMs?: number
  retryMaxMs?: number
  /** Slow re-probe cadence after the fast burst (default SLOW_RETRY_MS): one
   *  fresh attempt per interval, indefinite — only terminal failures stop. */
  slowRetryMs?: number
  /** Provider-declared retryable terminal verdicts: first re-probe delay and ceiling. */
  terminalRetryBaseMs?: number
  terminalRetryMaxMs?: number
  /** One-shot readiness-window extension for a still-starting ssh child (post-KEX auth /
   *  forward setup). Omitted = ONE readyTimeoutMs window (the extension always runs once
   *  for a live child; set 0 to disable it). */
  readyExtensionMs?: number
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
  /**
   * SSH host-key guard (P0-3): the app-owned known_hosts. When present, ssh tunnels are gated
   * BEFORE spawn (an unknown target never reaches ssh's own policy), a host-key stderr failure
   * runs the self-proof probe, and the argv pins StrictHostKeyChecking=yes/UserKnownHostsFile.
   * Absent = no gate (tests/direct-endpoint-only hosts).
   */
  hostKey?: HostKeyGuard
  /** `socketPath` present = dial the UDS listener (port/host are then display
   *  facts only); absent = TCP. */
  portProbe?: (port: number, opts?: { timeoutMs?: number; host?: string; socketPath?: string }) => Promise<boolean>
  /** One-shot endpoint identity verification; defaults to the provider's
   *  verifyUp. Runs after the port probe reports the endpoint up and before the
   *  phase may become ready. Injectable so tests can fake it. */
  verifyProbe?: (spec: TransportInstanceSpec, endpoint: TransportProbeEndpoint, signal?: AbortSignal) => Promise<TransportVerifyResult>
  allocatePort?: () => Promise<number>
  /** Injectable RNG for the jittered reconnect backoff (tests pass a fixed value). */
  random?: () => number
  instancesFile: string
  /**
   * Crash-orphan ledger directory (ssh-orphan.ts). When set, every spawned ssh
   * child gets `<dir>/ssh-children/<pid>.json` and the record is removed on a
   * clean exit/error; a crashed app leaves it for the NEXT startup's sweep. Absent
   * = no ledger (tests and direct-endpoint-only hosts).
   */
  sshOrphanStateDir?: string
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
  /** Register the forward-plane retirement hook (design 28 source delete/retarget). */
  setSourceRetiredListener?(listener: ((sourceId: string) => void) | null): void
  /** The ready transport URL — INTERNAL ONLY. */
  readyUrl(id: string): string | null
  /** The ready POSIX UDS tunnel socket — INTERNAL ONLY (ssh on non-win32).
   *  null on TCP/direct transports and whenever the instance is not ready. The
   *  control-plane registration consumes it together with readyUrl(). */
  readySocketPath(id: string): string | null
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

/** Default readiness probe: one bounded TCP connect to host:port (loopback
 *  default), or — POSIX ssh tunnels — a connect to the UDS listener. */
function defaultPortProbe(port: number, { timeoutMs = PROBE_ATTEMPT_TIMEOUT_MS, host = '127.0.0.1', socketPath }: { timeoutMs?: number; host?: string; socketPath?: string } = {}): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(socketPath === undefined ? { port, host } : { path: socketPath })
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
export function createTransportManager({ provider, providers, spawnFn, portProbe, verifyProbe, allocatePort, random, instancesFile, logger, options = {}, hostKey, sshOrphanStateDir }: TransportManagerDeps): TransportManager {
  const linkPolicy: LinkPolicy = { ...LINK_POLICY, ...(options.linkPolicy ?? {}) }
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
  const authReadyTimeoutMs = options.authReadyTimeoutMs ?? AUTH_READY_TIMEOUT_MS
  const verifyBudgetCushionMs = options.verifyBudgetCushionMs ?? VERIFY_BUDGET_CUSHION_MS
  const probeIntervalMs = options.probeIntervalMs ?? PROBE_INTERVAL_MS
  const maxRetryAttempts = options.maxRetryAttempts ?? MAX_RETRY_ATTEMPTS
  const retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS
  const retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS
  const slowRetryMs = options.slowRetryMs ?? SLOW_RETRY_MS
  const terminalRetryBaseMs = options.terminalRetryBaseMs ?? TERMINAL_RETRY_BASE_MS
  const terminalRetryMaxMs = options.terminalRetryMaxMs ?? TERMINAL_RETRY_MAX_MS
  const readyExtensionMs = options.readyExtensionMs ?? readyTimeoutMs
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
  /** Crash-orphan ledger (ssh-orphan.ts): records are per CHILD pid and are removed
   *  on every exit/error path this runtime observes. A crash skips the removal and
   *  the next startup's sweep reclaims the leftover ssh process. Failures here are
   *  diagnostics only — the transport itself must never fail because the ledger did. */
  const orphanStateDir = sshOrphanStateDir
  function childPidOf(child: SpawnedProcess): number | null {
    const pid = child.pid
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null
  }
  function recordOrphan(child: SpawnedProcess, spec: TransportInstanceSpec): void {
    if (orphanStateDir === undefined) return
    const pid = childPidOf(child)
    if (pid === null) return
    const target = `${spec.user === null ? '' : `${spec.user}@`}${spec.host}:${String(spec.remotePort)}`
    try {
      recordSshChild(orphanStateDir, pid, { target, startedAt: Date.now() })
    } catch (error) {
      warn(`transport-manager: ssh orphan record write failed: ${describeTransportError(error)}`)
    }
  }
  function clearOrphan(child: SpawnedProcess): void {
    if (orphanStateDir === undefined) return
    const pid = childPidOf(child)
    if (pid === null) return
    try {
      clearSshChild(orphanStateDir, pid)
    } catch (error) {
      warn(`transport-manager: ssh orphan record clear failed: ${describeTransportError(error)}`)
    }
  }
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
  /** Per-incarnation terminal re-probe attempt count (kept out of InstanceState). */
  const terminalRetryAttempts = new WeakMap<InstanceState, number>()
  /** States currently running a terminal re-check: a transient failure restores the red projection. */
  const terminalRechecks = new WeakSet<InstanceState>()
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
        socketPath: null,
        child: null,
        childExited: false,
        authFailed: false,
        hostKeyFailed: false,
        hostKeyProbing: false,
        hostKey: null,
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
   * credential-level (SSH auth, spawn), 'hostkey' = the SSH host key needs a
   * fingerprint review/trust (never a password hint), 'endpoint' = instance-level
   * terminal probe failure — the tunnel itself is fine, so the UI must never
   * suggest fixing SSH credentials. Defaults to 'auth'.
   */
  function failTerminal(
    id: string,
    state: InstanceState,
    message: string,
    requiresUserAction = true,
    userActionKind: 'auth' | 'endpoint' | 'hostkey' | 'environment' | null = 'auth',
    retryableTerminal = false,
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
    state.socketPath = null
    state.retryAttempt = 0
    state.requiresUserAction = requiresUserAction
    state.userActionKind = requiresUserAction ? userActionKind : null
    terminalRechecks.delete(state)
    transition(id, 'error', message, state)
    appendLogInternal(state, 'error', message)
    if (requiresUserAction && retryableTerminal) armTerminalRetry(id, state)
    else terminalRetryAttempts.delete(state)
  }

  /** Arm the bounded terminal re-check CADENCE for a provider-declared retryable
   *  terminal verdict (identity/version mismatch): ONE attempt per delay, re-armed
   *  after each retryable failure. The red projection stays honest: phase error +
   *  requiresUserAction + userActionKind + the next-check summary. While the
   *  re-check runs it keeps the repair hint (terminalRecheck mode in startTransport);
   *  only a ready edge or a non-retryable answer ends the loop. */
  function armTerminalRetry(id: string, state: InstanceState): void {
    if (disposed || !isCurrentState(id, state)) return
    if (state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }
    const attempt = (terminalRetryAttempts.get(state) ?? 0) + 1
    terminalRetryAttempts.set(state, attempt)
    const delay = terminalRetryDelayMs(attempt, terminalRetryBaseMs, terminalRetryMaxMs, doRandom)
    const summary = state.logSummary.replace(/\s*\[auto re-check \d+ in \d+ms\]$/, '')
    state.logSummary = `${summary}${summary === '' ? '' : ' '}[auto re-check ${attempt} in ${delay}ms]`
    appendLogInternal(state, 'warn', `terminal re-check scheduled in ${delay}ms (attempt ${attempt})`)
    emitStatus(id, state)
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null
      if (disposed || !isCurrentState(id, state)) return
      // A manual connect/disconnect or a different phase/action class moved on.
      if (state.phase !== 'error' || !state.requiresUserAction) return
      terminalRechecks.add(state)
      void startTransport(id, { terminalRecheck: true })
        .catch(error => warn(`transport-manager: terminal re-check rejected: ${describeTransportError(error)}`))
    }, delay)
    state.reconnectTimer.unref?.()
  }

  /** A missing/unexecutable ssh binary is an environment problem, not a credential
   *  one: the repair surface is PATH/prefix/permissions, and the card must say so. */
  function spawnFailureKind(error: unknown): 'environment' | 'auth' {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR'
      ? 'environment'
      : 'auth'
  }

  /** P0-3: one self-proof probe per attempt (the exit handler and the ready loop may both observe
   *  the host-key flag). The probe is bounded and never throws; an absent guard is a no-op. */
  async function probeHostKeyForAttempt(id: string, state: InstanceState, spec: TransportInstanceSpec, guard: HostKeyGuard) {
    if (state.hostKeyProbing) return
    // Fence the probe to the attempt that started it: a 20s self-proof can
    // outlive disconnect()/a replacement child, and its late projection must
    // never overwrite the next attempt (review R1-B M2).
    const epoch = state.tunnelEpoch
    state.hostKeyProbing = true
    try {
      const projection = toHostKeyProjection(await guard.probe(spec))
      if (!isCurrentState(id, state) || state.tunnelEpoch !== epoch) return
      state.hostKey = projection
      // The terminal transition may already have been emitted by the other
      // observer (hostKeyProbing made it return early). Publish the late
      // projection so the trust panel still shows the changed fingerprints.
      emitStatus(id, state)
    } catch (error) {
      warn(`transport-manager: host-key probe threw: ${describeTransportError(error)}`)
    } finally {
      if (state.tunnelEpoch === epoch) state.hostKeyProbing = false
    }
  }

  /** A host-key failure is terminal with its OWN repair surface: probe the presented key first so
   *  the projection carries the fingerprint, then fail with userActionKind 'hostkey' (never 'auth'). */
  async function failHostKey(id: string, state: InstanceState) {
    const spec = instances.get(id)
    if (!isCurrentState(id, state) || spec === undefined) return
    const epoch = state.tunnelEpoch
    const phase = state.phase
    if (hostKey !== undefined) await probeHostKeyForAttempt(id, state, spec, hostKey)
    // A late probe from a revoked attempt must not fail the idle/new attempt.
    if (!isCurrentState(id, state) || state.tunnelEpoch !== epoch || state.phase !== phase) return
    appendLogInternal(state, 'error', 'host key verification failed (requires user action)')
    failTerminal(id, state, 'host key verification failed — review the fingerprint and trust it', true, 'hostkey')
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
    if (terminalRechecks.has(state)) {
      // A terminal re-check that failed TRANSIENTLY restores the red projection
      // (the repair hint and its class) and keeps the terminal cadence. Falling
      // into the fast burst would clear requiresUserAction and lose the user's
      // repair surface for a condition that is still the same terminal class.
      terminalRechecks.delete(state)
      clearDownGrace(state)
      stopReadyLoop(state)
      if (state.reconnectTimer !== null) {
        clearTimeout(state.reconnectTimer)
        state.reconnectTimer = null
      }
      if (state.child !== null) {
        signalChild(state.child, 'SIGTERM')
        armKillEscalation(state.child)
      }
      state.child = null
      state.localPort = null
      state.socketPath = null
      state.retryAttempt = 0
      transition(id, 'error', undefined, state)
      appendLogInternal(state, 'warn', `terminal re-check failed transiently (${reason}); keeping the repair hint and retrying later`)
      armTerminalRetry(id, state)
      return
    }
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
      state.socketPath = null
      const slowDelay = slowRetryDelayMs(slowRetryMs, doRandom)
      transition(id, 'error', `transport failed: max retry attempts exceeded (${reason}); retrying periodically`, state)
      appendLogInternal(state, 'error', `max retry attempts exceeded (${reason}); slow re-probe in ${slowDelay}ms`)
      // The phase stays error (honest red state — the probe is background
      // recovery): each fire runs ONE fresh attempt, success lands ready and
      // resets counters, and requiresUserAction stays false.
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null
        if (!isCurrentState(id, state)) return
        void startTransport(id).catch(error => warn(`transport-manager: slow re-probe rejected: ${describeTransportError(error)}`))
      }, slowDelay)
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
    state.socketPath = null
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

  /** Budget of one connect-time verify for this provider/spec: provider-declared
   *  composite flow + cushion, floored by the authentication window. Deliberately
   *  independent from readyTimeoutMs (the TCP/reachability window). */
  const connectVerifyBudgetMsFor = (spec: TransportInstanceSpec, providerForSpec: TransportProvider): number =>
    connectVerifyBudgetMs(authReadyTimeoutMs, probeBudgetFor(spec, providerForSpec), verifyBudgetCushionMs)

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
    if (terminalRechecks.has(state)) {
      // A re-check that PROVED a credential or host-key failure must switch to the
      // real terminal class and stop the re-probe loop: keeping the endpoint class
      // would replay the stored password every 5m..60m and hide the fingerprint
      // repair surface. Only an answer-less exit stays on the terminal cadence.
      if (state.hostKeyFailed) {
        void failHostKey(id, state)
        return
      }
      if (state.authFailed) {
        failTerminal(id, state, 'authentication failed — requires user action')
        return
      }
      scheduleReconnect(id, state, `terminal re-check transport exited (${code ?? signal})`)
      return
    }
    if (state.portBindFailed && state.phase === 'connecting' && state.portBindRetries < 3) {
      // The OS gave our probe port away between bind-and-release and ssh -L. This
      // is not a transport attempt failure: re-allocate and retry without charging
      // the bounded burst, but never loop forever on a persistently forbidden bind.
      state.portBindFailed = false
      state.portBindRetries += 1
      state.localPort = null
      state.socketPath = null
      state.childExited = false
      appendLogInternal(state, 'info', 'local forward bind lost; re-allocating port without a retry attempt')
      void startTransport(id).catch(error => warn(`transport-manager: bind re-allocation rejected: ${describeTransportError(error)}`))
      return
    }
    if (state.phase === 'idle' || state.phase === 'error') return
    if (state.hostKeyFailed) {
      void failHostKey(id, state)
      return
    }
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
  async function startTransport(id: string, mode: { terminalRecheck?: boolean } = {}) {
    if (disposed) return
    const spec = instances.get(id)
    if (spec === undefined) return
    // The provider for THIS instance's kind: a gateway target → gatewayProvider,
    // an ssh instance → sshProvider.
    const providerForSpec = resolveProvider(spec)
    const state = ensureState(id)
    const terminalRecheck = mode.terminalRecheck === true
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
    state.hostKeyFailed = false
    state.hostKeyProbing = false
    state.hostKey = null
    if (!terminalRecheck) {
      state.requiresUserAction = false
      state.userActionKind = null
    }
    // This invocation IS the transport attempt: bump the epoch so an in-flight
    // invocation of a previous attempt aborts at its guard instead of stealing it.
    state.tunnelEpoch += 1
    const epoch = state.tunnelEpoch
    // P2-3 auth evidence is PER ATTEMPT and lives in this invocation's closure: a
    // single auth-looking stderr line is a hint, never a verdict; two CONSECUTIVE
    // lines (or an exit-255 confirmation of a line already seen) are the verdict,
    // and the ready edge clears whatever the attempt accumulated.
    let authLineStreak = 0
    let sawAuthLine = false
    // Every fresh attempt starts with a clean link-health streak. The ready edge
    // bumps linkEpoch; a failed attempt never inherits the previous streak.
    state.link = { ...INITIAL_LINK_HEALTH }
    clearDownGrace(state)
    // Entered here so the post-await guards and readiness loop have a stable anchor.
    // A terminal re-check keeps the previous logSummary (the repair reason) and only
    // changes the phase; the projection carries connecting + requiresUserAction. The
    // old [auto re-check ...] countdown is retired while the probe runs.
    if (terminalRecheck) {
      state.logSummary = state.logSummary.replace(/\s*\[auto re-check \d+ in \d+ms\]$/, '')
    }
    transition(id, 'connecting', terminalRecheck ? undefined : 'starting transport', state)
    if (terminalRecheck) {
      appendLogInternal(state, 'info', `terminal re-check attempt ${terminalRetryAttempts.get(state) ?? 1}: probing whether the terminal verdict changed`)
    }

    // P0-3 pre-spawn host-key gate: an ssh target with no key in the APP-OWNED known_hosts is
    // never handed to ssh (the argv pins StrictHostKeyChecking=yes; auto-accept is unreachable).
    // The self-proof probe projects the fingerprint and the user must trust it before the next
    // attempt — this is the only door from 'unknown' to 'known'.
    if (hostKey !== undefined && spec.transport === 'ssh' && providerForSpec.buildStartArgs !== undefined
      && !hostKey.isKnown(spec)) {
      await probeHostKeyForAttempt(id, state, spec, hostKey)
      if (!isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
      appendLogInternal(state, 'error', 'host key is not trusted yet — review the fingerprint and trust it')
      failTerminal(id, state, 'host key verification failed — review the fingerprint and trust it', true, 'hostkey')
      return
    }

    // POSIX ssh tunnel: resolve the UDS listener BEFORE any port allocation. A
    // non-null path means no TCP listener exists at all; its path-budget check
    // runs here, so a too-deep tmpdir fails loudly instead of binding a
    // truncated path.
    let socketPath: string | null = null
    if (providerForSpec.buildStartArgs !== undefined && providerForSpec.transportSocketPath !== undefined) {
      try {
        socketPath = providerForSpec.transportSocketPath(spec)
      } catch (socketError) {
        if (!isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
        const detail = describeTransportError(socketError)
        appendLogInternal(state, 'error', `transport socket unavailable: ${detail}`)
        failTerminal(id, state, `transport socket unavailable: ${detail}`, false)
        return
      }
      if (!isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
    }
    state.socketPath = socketPath

    let localPort: number | null = null
    // buildStartArgs present = tunnel (TCP port or UDS); absent = DIRECT ENDPOINT
    // mode. A UDS tunnel has no local TCP port to allocate.
    if (providerForSpec.buildStartArgs !== undefined && socketPath === null) {
      try {
        localPort = await doAllocate()
      } catch (allocateError) {
        // disconnect()/failTerminal/restart may have landed while allocating:
        // never arm recovery for a machine that moved on.
        if (!isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
        const detail = describeTransportError(allocateError)
        if (terminalRecheck) {
          // A terminal re-check stopped on a local resource error: keep the red
          // projection and the repair hint, and return to the terminal cadence.
          // The normal slow-probe path would run a non-recheck attempt that clears
          // requiresUserAction and can lose the repair surface on a transient miss.
          terminalRechecks.delete(state)
          transition(id, 'error', undefined, state)
          appendLogInternal(state, 'warn', `terminal re-check could not allocate a local port: ${detail}; keeping the repair hint`)
          armTerminalRetry(id, state)
          return
        }
        const slowDelay = slowRetryDelayMs(slowRetryMs, doRandom)
        transition(id, 'error', `failed to allocate a local port: ${detail}`, state)
        appendLogInternal(state, 'error', `port allocation failed: ${detail}; slow re-probe in ${slowDelay}ms`)
        // A transient allocation failure (port exhaustion) must not stick in error
        // forever: arm the slow periodic re-probe (same pattern as max-retry).
        state.reconnectTimer = setTimeout(() => {
          state.reconnectTimer = null
          if (!isCurrentState(id, state)) return
          void startTransport(id).catch(error => warn(`transport-manager: slow re-probe rejected: ${describeTransportError(error)}`))
        }, slowDelay)
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
        args = providerForSpec.buildStartArgs(spec, localPort, hostKey?.knownHostsArgs(), state.socketPath)
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
    // never-bound port/socket into projections/readyUrl — direct mode owns neither.
    if (directEndpoint) {
      state.localPort = null
      state.socketPath = null
    }
    const probeTarget = (() => {
      try {
        return directEndpoint
          ? (providerForSpec.probeTarget?.(spec) ?? { host: spec.host, port: spec.remotePort })
          : state.socketPath !== null
            ? { host: '127.0.0.1', port: spec.remotePort, socketPath: state.socketPath }
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
        failTerminal(id, state, `failed to spawn transport: ${describeTransportError(spawnError)}`, true, spawnFailureKind(spawnError))
        return
      }
      // Bind provider-owned ephemeral resources to the ACTUAL child lifetime before
      // stale-epoch handling can signal it (Node may emit both error and exit).
      child.on('exit', releaseTransportLease)
      child.on('error', releaseTransportLease)
      // Ledger the child BEFORE the stale-epoch branch can signal it: a replaced
      // child that is already in flight must still be reclaimable after a crash.
      recordOrphan(child, spec)
      child.on('exit', () => clearOrphan(child))
      child.on('error', () => clearOrphan(child))
      if (!isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) {
        // A stale epoch (newer attempt took over mid-spawn): the fresh child must
        // still get the SIGKILL escalation or it becomes an unreaped orphan.
        signalChild(child, 'SIGTERM')
        armKillEscalation(child)
        return
      }
      state.child = child
      // A terminal re-check keeps the repair reason in logSummary; the spawn argv
      // belongs to the ring log, not to the projection the user is reading.
      transition(id, 'connecting', terminalRecheck ? undefined : `spawning ${args![0]} ${args!.slice(1).join(' ')}`, state)
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
        // A replaced child's late stderr must never latch a verdict onto the new
        // attempt (R1-B M2 / R2-A MAJOR-2).
        if (!isCurrentState(id, state) || state.tunnelEpoch !== epoch || state.phase === 'idle') return
        if (PORT_BIND_FAILURE_PATTERN.test(line)) state.portBindFailed = true
        let logLine: string
        let terminalAuth: boolean
        let terminalHostKey: boolean
        try {
          const classified = providerForSpec.classifyStderr(line)
          logLine = classified.log
          terminalAuth = classified.terminalAuth
          terminalHostKey = classified.hostKey === true
        } catch {
          // The classifier is also the redaction boundary: never echo its exception
          // or the raw input into logs.
          warn('transport-manager: provider.classifyStderr threw; stderr dropped')
          appendLogInternal(state, 'error', 'transport output dropped: provider classifier failed')
          return
        }
        if (logLine === '') return
        appendLogInternal(state, 'info', logLine)
        if (terminalHostKey) {
          // A ready transport already proved its host key: late chatter must not
          // latch a hostkey verdict onto a healthy incarnation (same rule as auth).
          if (state.phase === 'ready') return
          // Host-key failures have their own terminal class (P0-3): never booked as auth.
          state.hostKeyFailed = true
          appendLogInternal(state, 'error', 'host key verification failed (requires user action)')
        } else if (terminalAuth) {
          // Chatty banners/ProxyCommand output can mention credentials without proving a
          // credential verdict: ONE line is a hint, only the second CONSECUTIVE line is
          // terminal. A ready transport has already proven its identity — late chatter can
          // never latch a credential verdict onto a healthy incarnation.
          if (state.phase === 'ready') return
          authLineStreak += 1
          sawAuthLine = true
          if (authLineStreak >= 2) {
            state.authFailed = true
            appendLogInternal(state, 'error', 'authentication failure detected (requires user action)')
          } else {
            appendLogInternal(state, 'warn', 'authentication failure hint (1 of 2 consecutive lines) — waiting for confirmation')
          }
        } else {
          // "Consecutive" is the point: an intervening diagnostic line breaks the streak.
          authLineStreak = 0
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
          // ssh exits 255 for every failure of its own (auth, DNS, refused, timeout).
          // Before ready, an auth line already seen on stderr CONFIRMS the credential
          // class even when no second consecutive line arrived; a BARE 255 stays on the
          // bounded retry path (a transient network failure must keep self-healing).
          if (code === 255 && sawAuthLine && !state.authFailed && state.phase !== 'ready') {
            state.authFailed = true
            appendLogInternal(state, 'error', 'authentication failure detected (requires user action)')
          }
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
        failTerminal(id, state, `failed to spawn transport: ${detail}`, true, spawnFailureKind(error))
        clearTunnelKillEscalation(child)
      })
    }

    const controller = new AbortController()
    state.readyLoop = controller
    // REACHABILITY deadline only (the port/endpoint must accept TCP). The identity
    // verification below is a separate phase with its own budget: a slow but
    // successful composite verify must never be judged by this 10s window, so the
    // total attempt deadline is this window + the verify budget by construction.
    let deadline = Date.now() + readyTimeoutMs
    // One bounded extension for a child that is still STARTING (post-KEX auth,
    // PAM/LDAP, forward setup). A TCP/KEX black hole normally exits via ConnectTimeout
    // and never reaches this branch; DNS/Match-exec evaluation is NOT bounded by that
    // timeout and may consume this one extension. The second deadline stays a hard bound.
    let extended = false
    void (async () => {
      while (!controller.signal.aborted) {
        if (!isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
        if (state.hostKeyFailed) return void failHostKey(id, state)
        if (state.authFailed) return failTerminal(id, state, 'authentication failed — requires user action')
        if (state.childExited) return
        // A rejecting probe is simply "not up yet" — never a hang or a crash.
        const up = await doProbe(probeTarget.port, {
          host: probeTarget.host,
          ...(probeTarget.socketPath === undefined ? {} : { socketPath: probeTarget.socketPath }),
        }).catch(() => false)
        if (controller.signal.aborted || !isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
        if (up) {
          // TCP-up is not an honest "the destination is dsh" signal — ANY service
          // would accept the connection. Verify the destination protocol before
          // declaring ready, or a non-dsh service presents as a ready instance.
          if (doVerify !== undefined) {
            let verification: TransportVerifyResult
            const connectProbeAbort = new AbortController()
            state.probeAbort = connectProbeAbort
            // The verify phase owns its own window: max(AUTH_READY_TIMEOUT_MS,
            // provider budget + cushion). This is what lets a slow composite gateway
            // login (up to ~30s of real exchanges) settle instead of being reaped by
            // the TCP window; the provider's own inner timeout fires first.
            const verifyBudgetMs = connectVerifyBudgetMsFor(spec, providerForSpec)
            try {
              verification = await withProbeDeadline(
                doVerify(spec, probeTarget, connectProbeAbort.signal),
                verifyBudgetMs,
                () => { connectProbeAbort.abort() },
              )
            } catch (verifyError) {
              // A throwing verifier must never hang connecting — loud degraded path.
              warn(`transport-manager: endpoint verification threw: ${describeTransportError(verifyError)}`)
              verification = { ok: false, detail: 'endpoint verification failed', failureKind: 'network' }
            }
            if (state.probeAbort === connectProbeAbort) state.probeAbort = null
            if (controller.signal.aborted || !isCurrentState(id, state) || state.phase !== 'connecting' || epoch !== state.tunnelEpoch) return
            // A host-key/auth failure that landed during verification must stay terminal.
            if (state.hostKeyFailed) return void failHostKey(id, state)
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
              if (verification.terminal === true) return failTerminal(id, state, reason, true, 'endpoint', verification.terminalRetryable === true)
              return scheduleReconnect(id, state, reason)
            }
          }
          if (!state.childExited && (directEndpoint || state.child !== null)) {
            // The ready edge retires this attempt's auth evidence: a stray banner line
            // that arrived while connecting can never latch a credential verdict onto a
            // transport that just proved its identity.
            state.authFailed = false
            state.hostKeyFailed = false
            state.hostKeyProbing = false
            state.hostKey = null
            authLineStreak = 0
            sawAuthLine = false
            state.retryAttempt = 0
            state.requiresUserAction = false
            state.userActionKind = null
            terminalRetryAttempts.delete(state)
            terminalRechecks.delete(state)
            // A fresh ready edge starts the watch window: the first heartbeats run
            // at the tight cadence while the new relay path is still unproven.
            state.lastLinkEventAt = Date.now()
            transition(id, 'ready', 'transport is up', state)
            appendLogInternal(state, 'info', `transport ready on ${probeTarget.host}:${probeTarget.port}${probeTarget.socketPath === undefined ? '' : ' via unix socket'}`)
          }
          return
        }
        if (Date.now() >= deadline) {
          // A host-key/auth failure that landed during the final probe must stay terminal.
          if (state.hostKeyFailed) return void failHostKey(id, state)
          if (state.authFailed) return failTerminal(id, state, 'authentication failed — requires user action')
          if (state.childExited) return
          if (!extended && state.child !== null) {
            // The ssh child is alive but has not bound the listener yet: the
            // post-KEX phase has no ConnectTimeout of its own. Extend once.
            extended = true
            deadline = Date.now() + readyExtensionMs
            appendLogInternal(state, 'warn', `transport still starting after ${readyTimeoutMs}ms; extending the readiness window by ${readyExtensionMs}ms (post-KEX auth/forward)`)
          } else {
            const totalWindowMs = readyTimeoutMs + (extended ? readyExtensionMs : 0)
            appendLogInternal(state, 'warn', `transport did not come up within ${totalWindowMs}ms`)
            return scheduleReconnect(id, state, 'transport did not come up in time')
          }
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
        ...(hostKey === undefined ? {} : { knownHosts: hostKey.knownHostsArgs() }),
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
  let sourceRetiredListener: ((sourceId: string) => void) | null = null
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
    onSourceRetired: sourceId => { sourceRetiredListener?.(sourceId) },
  })
  const { loadInstances, saveInstances, listInstances } = registry

  /** Start (or restart) the transport for one instance: idempotent while
   *  connecting/ready; a manual connect resets retry and clears the pending reconnect. */
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
    terminalRetryAttempts.delete(state)
    terminalRechecks.delete(state)
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
    terminalRetryAttempts.delete(state)
    terminalRechecks.delete(state)
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
    state.socketPath = null
    state.retryAttempt = 0
    state.requiresUserAction = false
    state.userActionKind = null
    state.hostKeyFailed = false
    state.hostKeyProbing = false
    state.hostKey = null
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
      transportSocket: state.socketPath === null ? 'tcp' : 'unix',
      sshPort: spec.sshPort,
      remotePort: spec.remotePort,
      retryAttempt: state.retryAttempt,
      requiresUserAction: state.requiresUserAction,
      userActionKind: state.userActionKind,
      ...(state.hostKey === null ? {} : { hostKey: state.hostKey }),
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
   *  the local tunnel is ready. A UDS tunnel's URL carries the REMOTE loopback
   *  authority (Host/authority semantics identical to its TCP form) while the actual
   *  dial target is readySocketPath(). */
  function readyUrl(id: string): string | null {
    const state = states.get(id)
    if (state?.phase !== 'ready') return null
    if (state.socketPath !== null) {
      const spec = instances.get(id)
      return spec === undefined ? null : `http://127.0.0.1:${String(spec.remotePort)}`
    }
    if (state.localPort !== null) return `http://127.0.0.1:${state.localPort}`
    const spec = instances.get(id)
    if (spec === undefined) return null
    return resolveProvider(spec).endpointUrl?.(spec) ?? null
  }

  /** The ready UDS socket for one instance (null on TCP/direct/not-ready). */
  function readySocketPath(id: string): string | null {
    const state = states.get(id)
    if (state?.phase !== 'ready' || state.socketPath === null) return null
    return state.socketPath
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
    setSourceRetiredListener: (listener) => { sourceRetiredListener = listener },
    readyUrl,
    readySocketPath,
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
