/**
 * RemoteForwardManager — the main-process authority for browser port forwards
 * (design 28, Remote Browser v4; W0/S1 slice).
 *
 * WHAT IT OWNS.
 *   - the per-source registry of forwarded ports and their lifecycle state
 *     (requested -> starting -> bound -> reconnecting | closing | closed | error);
 *   - global ownership of every (aliasHost, localPort) pair, so two sources can
 *     never bind the same interface:port even when both ask for "the same" port;
 *   - per-source limits (8) and the global limit (32), counted over live records
 *     only (error/closed records never hold a listener or a slot);
 *   - single-flight on (sourceId, targetPort): concurrent requests converge on
 *     one child, and a repeated request for a bound port is idempotent;
 *   - the alias namespace hand-off (browserNamespace -> 127.0.0.2..254) and the
 *     retarget rule (identity change closes every forward of that source and
 *     rotates its alias);
 *   - `openInBrowser`: main composes `scheme://alias:port + path` and awaits the
 *     platform open; the renderer never passes a URL (security ruling).
 *
 * WHAT IT DOES NOT OWN (typed adapters + TODO, never a frozen-file edit):
 *   - process spawning and ssh auth (askpass leases) — ForwardChildLauncher;
 *   - the actual ssh argv — buildForwardArgs() in remote-forward-args.ts;
 *   - local port probing/listener probing — ForwardPortAllocator;
 *   - persisted namespaces — ForwardNamespaces (remote-forward-namespace.ts);
 *   - the OS open call and its per-source budget bookkeeping here — the caller
 *     injects `openExternal` (edges.openExternal); the global openExternally
 *     singleton (8/10s + 30s cooldown) is deliberately NOT reused, so a remote
 *     source cannot starve the app's own link leg;
 *   - native confirmation + persisting "browser enabled" — the `authorize`
 *     seam; the registrar persists the decision (TODO S1 wiring);
 *   - child reaping after kill -9 — remote-forward-lifecycle.ts.
 *
 * WIRE MIRROR. The state/error tables and the record shape are a structural
 * mirror of `@dsh-chamber/dsh-chamber-wire/forward` (the wire package is the
 * cross-process contract; the renderer/bridge imports it). The desktop package
 * does not depend on the wire package YET: a runtime import of raw TS from
 * node_modules breaks the packaged app (README: ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING)
 * and a dependency/lockfile update is outside this slice. `test/forward/forward-wire.test.ts`
 * asserts the two tables/shapes agree in both directions; when the desktop dep
 * lands, replace these declarations with `import type`/value imports from
 * '@dsh-chamber/dsh-chamber-wire/forward' (TODO W0 integration).
 *
 * TRUST. Every input here is assumed to be already guarded by the IPC registrar
 * (wire guards + sender/frame trust + the three-step fingerprint proof). The
 * manager re-validates the parts that change security outcomes (gate, ports,
 * path, ownership, limits) and fails closed with a typed code.
 */
import { randomUUID } from 'node:crypto'
import { buildForwardArgs, type ForwardSshSpec } from './remote-forward-args.ts'
import type { ForwardNamespaceAssignment } from './remote-forward-namespace.ts'

/** Lifecycle states (wire mirror — keep FORWARD_STATES order identical). */
export const FORWARD_STATES = [
  'requested',
  'starting',
  'bound',
  'reconnecting',
  'closing',
  'closed',
  'error',
] as const

/** One lifecycle state. */
export type ForwardState = (typeof FORWARD_STATES)[number]

/** Closed error-code table (wire mirror — the lockstep test pins set equality). */
export const FORWARD_ERROR_CODES = [
  'source_unknown',
  'source_not_dsh',
  'transport_not_ssh',
  'source_changed',
  'browser_disabled',
  'confirmation_declined',
  'confirmation_late',
  'target_port_invalid',
  'target_port_reserved',
  'scheme_invalid',
  'too_many_for_source',
  'too_many_global',
  'namespace_unavailable',
  'alias_exhausted',
  'port_exhausted',
  'local_bind_failed',
  'auth_failed',
  'forward_failed',
  'forward_not_found',
  'forward_not_owned',
  'forward_not_bound',
  'forward_stale',
  'invalid_path',
  'rate_limited',
  'open_failed',
] as const

/** One forward error code. */
export type ForwardErrorCode = (typeof FORWARD_ERROR_CODES)[number]

/** One forward scheme (https is passed through, never downgraded). */
export type ForwardScheme = 'http' | 'https'

/** The fixed remote loopback target of v1. */
export const FORWARD_TARGET_HOST = '127.0.0.1'

/** Hard caps (single source for the launcher's explanation and the manager's verdict). */
export const FORWARD_MAX_PER_SOURCE = 8
export const FORWARD_MAX_GLOBAL = 32
export const FORWARD_MIN_LOCAL_PORT = 1024
export const FORWARD_MAX_LOCAL_PORT = 65535
export const FORWARD_MIN_TARGET_PORT = 1
export const FORWARD_MAX_TARGET_PORT = 65535

/** Local-listener probe after spawn: how long "starting" may last before it is a bind fault. */
export const FORWARD_PROBE_TIMEOUT_MS = 2_000
export const FORWARD_PROBE_INTERVAL_MS = 100

/** A lost bind race re-allocates an ephemeral port; 3 launches then local_bind_failed. */
export const FORWARD_BIND_ATTEMPTS = 3

/** Bounded relaunch after a bound child dies (never an unbounded retry loop). */
export const FORWARD_RECONNECT = Object.freeze({ maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 8_000 })

/** Per-source open budget: 5 hand-offs / 60s, independent of the app's global link leg. */
export const FORWARD_OPEN_WINDOW_MS = 60_000
export const FORWARD_OPEN_MAX_PER_WINDOW = 5

/** Spawn throttle: at most one ssh child per 2s per source (design 28 §6.8). */
export const FORWARD_SPAWN_WINDOW_MS = 2_000
export const FORWARD_SPAWN_MAX_PER_WINDOW = 1

/** Three consecutive auth failures put the source in a 60s cooldown (§9.4). */
export const FORWARD_AUTH_FAILURE_LIMIT = 3
export const FORWARD_AUTH_COOLDOWN_MS = 60_000

/** A release waits this long for the child to exit before dropping the record. */
export const FORWARD_RELEASE_TIMEOUT_MS = 2_000

/** App quit / sidecar shutdown hard cap for ALL forward children (design 28 §6.7). */
export const FORWARD_QUIT_TIMEOUT_MS = 3_000

/**
 * Allowed transitions (documentation + tests; the manager drives them through
 * public calls, so an illegal pair is a bug the suite can catch).
 */
export const FORWARD_TRANSITIONS: Readonly<Record<ForwardState, readonly ForwardState[]>> = Object.freeze({
  requested: ['starting', 'closing', 'error'],
  starting: ['bound', 'reconnecting', 'closing', 'error'],
  bound: ['reconnecting', 'closing', 'error'],
  reconnecting: ['starting', 'closing', 'error'],
  closing: ['closed'],
  closed: [],
  error: ['closing', 'closed'],
})

/** Could `to` legally follow `from`? */
export function canForwardTransition(from: ForwardState, to: ForwardState): boolean {
  return FORWARD_TRANSITIONS[from].includes(to)
}

/** One non-secret error; detail is always main-composed (never ssh stderr). */
export interface ForwardError {
  readonly code: ForwardErrorCode
  readonly detail: string | null
}

/** One forwarded port as exchanged with the launcher (wire mirror). */
export interface ForwardRecord {
  readonly id: string
  readonly sourceId: string
  readonly namespace: number
  readonly aliasHost: string
  readonly localPort: number
  readonly scheme: ForwardScheme
  readonly targetHost: typeof FORWARD_TARGET_HOST
  readonly targetPort: number
  readonly state: ForwardState
  readonly stale: boolean
  readonly error: ForwardError | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly boundAt: number | null
}

/** Arguments of `request`. */
export interface ForwardRequestArgs {
  readonly sourceId: string
  readonly sourceFingerprint: string
  readonly port: number
  readonly scheme?: ForwardScheme
}

/** Arguments of `release`. */
export interface ForwardReleaseArgs {
  readonly sourceId: string
  readonly sourceFingerprint: string
  readonly id: string
}

/** Arguments of `list`. */
export interface ForwardListArgs {
  readonly sourceId: string
  readonly sourceFingerprint: string
}

/** Arguments of `openInBrowser`. */
export interface ForwardOpenArgs {
  readonly sourceId: string
  readonly sourceFingerprint: string
  readonly id: string
  readonly path?: string
}

/** Cap usage for one source snapshot. */
export interface ForwardLimitsSnapshot {
  readonly perSource: number
  readonly global: number
  readonly perSourceUsed: number
  readonly globalUsed: number
}

/** `request` result. */
export type ForwardRequestResult =
  | { readonly ok: true; readonly record: ForwardRecord }
  | { readonly ok: false; readonly error: ForwardError }

/** `release` result. */
export type ForwardReleaseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ForwardError }

/** `list` result. */
export type ForwardListResult =
  | { readonly ok: true; readonly records: readonly ForwardRecord[]; readonly limits: ForwardLimitsSnapshot }
  | { readonly ok: false; readonly error: ForwardError }

/** `openInBrowser` result. */
export type ForwardOpenResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ForwardError }

/** Result of retiring a source's forwards + namespace. */
export interface ForwardRetireResult {
  readonly released: number
  readonly namespaceRetired: boolean
}

/** A source as resolved from the trusted registry (never from renderer input). */
export interface ForwardSource {
  readonly sourceId: string
  /** Per-process proof minted by the main process (notifications.ts). */
  readonly fingerprint: string
  /** Target kind; only 'dsh' gets a browser. */
  readonly kind: string
  /** Transport method; only 'ssh' can be forwarded. */
  readonly transport: string
  /** Registry-resolved ssh destination. */
  readonly ssh: ForwardSshSpec
  /** The instance's own remote tunnel port (never a browser target). */
  readonly remotePort: number | null
  /** Stable digest of the persisted connection identity (host/user/sshPort/remotePort). */
  readonly identity: string
  /** Registry label for human-facing confirmation copy (never renderer input). */
  readonly label?: string
  /** Legacy whole-source grant (custom test seams / pre-v2 rows). */
  readonly browserEnabled: boolean
  /** Persisted per-namespace:port confirmations (`<browserNamespace>:<targetPort>`). */
  readonly confirmedPorts?: readonly string[]
}

/** Resolve + prove a source for one call; null = unknown or stale fingerprint. */
export interface ForwardSourceResolver {
  resolve(sourceId: string, fingerprint: string): ForwardSource | null
}

/** One child exit as classified by the adapter (ssh stderr stays in its log ring). */
export interface ForwardChildExit {
  readonly code: number | null
  readonly signal: string | null
  /** Terminal auth failure (askpass/OTP/permission). */
  readonly authFailed: boolean
  /** The local bind failed (ExitOnForwardFailure) — the port was lost, not the host. */
  readonly bindFailed: boolean
}

/** A spawned forward child. Escalation (SIGTERM -> SIGKILL) belongs to the adapter. */
export interface ForwardChild {
  /** Resolves exactly once when the child is gone. */
  readonly exit: Promise<ForwardChildExit>
  /** Idempotent stop request; the adapter owns signal escalation. */
  stop(): void
}

/** Everything the launcher needs to spawn one child (no envelope, no auth material here). */
export interface ForwardLaunchInput {
  readonly forwardId: string
  readonly sourceId: string
  readonly aliasHost: string
  readonly localPort: number
  readonly targetPort: number
  readonly scheme: ForwardScheme
  readonly ssh: ForwardSshSpec
  /** Fully built argv (buildForwardArgs) — the adapter spawns with shell:false. */
  readonly argv: readonly string[]
}

/**
 * Spawn seam (real implementation: remote-forward-service spawns with
 * shell:false + POSIX detached, acquires one askpass lease, and writes the
 * child ledger BEFORE reporting the launch).
 */
export interface ForwardChildLauncher {
  launch(input: ForwardLaunchInput): ForwardChild | Promise<ForwardChild>
}

/** Local port probing, always ON the alias host (never 127.0.0.1). */
export interface ForwardPortAllocator {
  /** Bind-and-release probe for one specific port on the alias host. */
  isFree(host: string, port: number): Promise<boolean>
  /** One OS-assigned port on the alias host. */
  ephemeral(host: string): Promise<number>
}

/** Local listener probe: TCP connect to alias:port after spawn. */
export type ForwardListenerProbe = (host: string, port: number) => Promise<boolean>

/**
 * The awaited OS open seam (edges.openExternal; failures reject or return ok:false).
 * Production binds ShellIpcDeps.edges.openExternal, never the module singleton
 * openExternally (8/10s + 30s cooldown shared with deep links/updates).
 */
export interface ForwardOpenExternal {
  openExternal(url: string): Promise<{ ok: true } | { ok: false; detail: string | null }>
}

/** Injected timers (tests drive reconnect/backoff deterministically). */
export interface ForwardTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/**
 * Native confirmation seam; resolves true only for an explicit user approval.
 * Main composes the copy, persists the per-namespace:port grant, and re-proves
 * the fingerprint after the dialog (the source may have been retargeted).
 */
export type ForwardAuthorize = (
  source: ForwardSource,
  request: { readonly targetPort: number; readonly namespace: number },
) => Promise<boolean>

/** Namespace seam (production: ForwardNamespaces; tests: real class + fake storage). */
export interface ForwardNamespacePort {
  ensure(input: { sourceId: string; identity: string }): Promise<ForwardNamespaceAssignment>
  retire(sourceId: string): Promise<boolean>
}

/** Manager construction options — every side effect injected. */
export interface RemoteForwardManagerOptions {
  readonly sources: ForwardSourceResolver
  readonly namespaces: ForwardNamespacePort
  readonly ports: ForwardPortAllocator
  readonly probe: ForwardListenerProbe
  readonly launcher: ForwardChildLauncher
  readonly openExternal: ForwardOpenExternal
  readonly authorize?: ForwardAuthorize
  readonly now?: () => number
  readonly mintId?: () => string
  readonly timers?: ForwardTimers
  readonly probeTimeoutMs?: number
  readonly probeIntervalMs?: number
  readonly releaseTimeoutMs?: number
  readonly reconnect?: { readonly maxAttempts: number; readonly baseDelayMs: number; readonly maxDelayMs: number }
  /** Test seam; production uses FORWARD_SPAWN_WINDOW_MS. */
  readonly spawnWindowMs?: number
}

/** One internal continuation token set per record (never serialized). */
interface InternalForward {
  readonly id: string
  readonly sourceId: string
  readonly identity: string
  readonly fingerprint: string
  phase: ForwardState
  /** Any launch/release bumps this; stale async work checks it. */
  launchToken: number
  closed: boolean
  child: ForwardChild | null
  exit: ForwardChildExit | null
  reconnectAttempts: number
  bindAttempts: number
  reconnectTimer: unknown
}

const defaultTimers: ForwardTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function errorOf(code: ForwardErrorCode, detail: string | null = null): ForwardError {
  return { code, detail }
}

function failure(code: ForwardErrorCode): { readonly ok: false; readonly error: ForwardError } {
  return { ok: false, error: errorOf(code) }
}

function isTargetPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= FORWARD_MIN_TARGET_PORT && value <= FORWARD_MAX_TARGET_PORT
}

function isLocalPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= FORWARD_MIN_LOCAL_PORT && value <= FORWARD_MAX_LOCAL_PORT
}

function isScheme(value: unknown): value is ForwardScheme {
  return value === 'http' || value === 'https'
}

/**
 * The gate: which sources may forward, and which target ports are legal.
 * Pure and exported so the IPC rejection matrix and the manager share one
 * verdict (security review: reject gateway/local/http, reject the instance's
 * own tunnel port, reject 0/negative/fractional/out-of-range ports).
 */
export function evaluateForwardSourceGate(source: ForwardSource): ForwardError | null {
  if (source.kind !== 'dsh') return errorOf('source_not_dsh')
  if (source.transport !== 'ssh') return errorOf('transport_not_ssh')
  return null
}

/** The full gate: source kind/transport plus the target port itself. */
export function evaluateForwardGate(source: ForwardSource, targetPort: number): ForwardError | null {
  const sourceGate = evaluateForwardSourceGate(source)
  if (sourceGate !== null) return sourceGate
  if (!isTargetPort(targetPort)) return errorOf('target_port_invalid')
  if (source.remotePort !== null && targetPort === source.remotePort) return errorOf('target_port_reserved')
  return null
}

/** Same-origin path normalization result. */
export type ForwardPathResult = { readonly ok: true; readonly path: string } | { readonly ok: false }

/** Encoded control characters are rejected (header/path smuggling hygiene). */
const ENCODED_CONTROL = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu
const RAW_CONTROL = /[\u0000-\u001f\u007f]/u
const PATH_BASE = 'http://forward.invalid'

/**
 * Normalize the launcher's path argument into a same-origin relative path:
 *   - absent -> '/';
 *   - must parse against a fixed origin and keep that origin (absolute URLs,
 *     protocol-relative `//host` and `userinfo` are rejected);
 *   - the fragment is DROPPED (v1 never forwards it); path and query survive;
 *   - `//`, backslashes, CR/LF and encoded control bytes are rejected or
 *     normalized by URL parsing (an origin change is the reliable signal).
 */
export function normalizeForwardPath(raw: unknown): ForwardPathResult {
  if (raw === undefined || raw === null) return { ok: true, path: '/' }
  if (typeof raw !== 'string') return { ok: false }
  if (raw.length > 2048) return { ok: false }
  if (RAW_CONTROL.test(raw) || ENCODED_CONTROL.test(raw)) return { ok: false }
  let parsed: URL
  try {
    parsed = new URL(raw, PATH_BASE)
  } catch {
    return { ok: false }
  }
  if (parsed.origin !== PATH_BASE) return { ok: false }
  if (parsed.username !== '' || parsed.password !== '') return { ok: false }
  const path = (parsed.pathname === '' ? '/' : parsed.pathname) + parsed.search
  return { ok: true, path: path.startsWith('/') ? path : '/' + path }
}

/** Compose the external URL from a bound record (main-only; never renderer input). */
export function forwardOpenUrl(record: Pick<ForwardRecord, 'scheme' | 'aliasHost' | 'localPort'>, path: string): string {
  return record.scheme + '://' + record.aliasHost + ':' + String(record.localPort) + path
}

/** The manager. One instance per process (Electron main or Swift sidecar). */
export class RemoteForwardManager {
  readonly #sources: ForwardSourceResolver
  readonly #namespaces: ForwardNamespacePort
  readonly #ports: ForwardPortAllocator
  readonly #probe: ForwardListenerProbe
  readonly #launcher: ForwardChildLauncher
  readonly #openExternal: ForwardOpenExternal
  readonly #authorize: ForwardAuthorize | undefined
  readonly #now: () => number
  readonly #mintId: () => string
  readonly #timers: ForwardTimers
  readonly #probeTimeoutMs: number
  readonly #probeIntervalMs: number
  readonly #releaseTimeoutMs: number
  readonly #reconnect: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number }
  readonly #spawnWindowMs: number

  readonly #records = new Map<string, ForwardRecord>()
  readonly #internals = new Map<string, InternalForward>()
  /** (aliasHost:localPort) -> forward id; the global ownership table. */
  readonly #owners = new Map<string, string>()
  readonly #inflight = new Map<string, Promise<ForwardRequestResult>>()
  readonly #openWindows = new Map<string, number[]>()
  readonly #spawnWindows = new Map<string, number[]>()
  readonly #authFailures = new Map<string, { count: number; last: number }>()
  readonly #authCooldownUntil = new Map<string, number>()

  constructor(options: RemoteForwardManagerOptions) {
    this.#sources = options.sources
    this.#namespaces = options.namespaces
    this.#ports = options.ports
    this.#probe = options.probe
    this.#launcher = options.launcher
    this.#openExternal = options.openExternal
    this.#authorize = options.authorize
    this.#now = options.now ?? (() => Date.now())
    this.#mintId = options.mintId ?? (() => 'fwd-' + randomUUID().replace(/-/gu, ''))
    this.#timers = options.timers ?? defaultTimers
    this.#probeTimeoutMs = options.probeTimeoutMs ?? FORWARD_PROBE_TIMEOUT_MS
    this.#probeIntervalMs = options.probeIntervalMs ?? FORWARD_PROBE_INTERVAL_MS
    this.#releaseTimeoutMs = options.releaseTimeoutMs ?? FORWARD_RELEASE_TIMEOUT_MS
    const reconnect = options.reconnect ?? FORWARD_RECONNECT
    this.#reconnect = {
      maxAttempts: reconnect.maxAttempts,
      baseDelayMs: reconnect.baseDelayMs,
      maxDelayMs: reconnect.maxDelayMs,
    }
    this.#spawnWindowMs = options.spawnWindowMs ?? FORWARD_SPAWN_WINDOW_MS
  }

  /**
   * Request (or reuse) one forward. Idempotent on (sourceId, targetPort);
   * concurrent identical calls share the same in-flight attempt (single-flight).
   * Resolves once the first start attempt settled: bound, or error (with the
   * record still visible for display until release).
   */
  request(args: ForwardRequestArgs): Promise<ForwardRequestResult> {
    const key = this.#requestKey(args)
    if (key === null) return Promise.resolve(failure('target_port_invalid'))
    const inflight = this.#inflight.get(key)
    if (inflight !== undefined) return inflight
    const run = this.#requestOnce(args).finally(() => {
      this.#inflight.delete(key)
    })
    this.#inflight.set(key, run)
    return run
  }

  /** Close one forward; never throws for an already-gone record. */
  async release(args: ForwardReleaseArgs): Promise<ForwardReleaseResult> {
    const source = this.#sources.resolve(args.sourceId, args.sourceFingerprint)
    if (source === null) return failure('source_unknown')
    const record = this.#records.get(args.id)
    if (record === undefined || record.sourceId !== source.sourceId) return failure('forward_not_found')
    await this.#releaseRecord(args.id)
    return { ok: true }
  }

  /** Per-source snapshot (poll face; v1 has no push channel). */
  list(args: ForwardListArgs): Promise<ForwardListResult> {
    const source = this.#sources.resolve(args.sourceId, args.sourceFingerprint)
    if (source === null) return Promise.resolve(failure('source_unknown'))
    const records: ForwardRecord[] = []
    for (const record of this.#records.values()) {
      if (record.sourceId !== source.sourceId) continue
      // An identity change stales EVERY record of the source, including a
      // terminal error record (the launcher must not offer it as usable).
      const current = this.#internals.get(record.id)?.identity !== source.identity
        ? (this.#patch(record.id, { stale: true }) ?? record)
        : record
      records.push(current)
    }
    records.sort((left, right) => (left.createdAt - right.createdAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    return Promise.resolve({
      ok: true,
      records,
      limits: {
        perSource: FORWARD_MAX_PER_SOURCE,
        global: FORWARD_MAX_GLOBAL,
        perSourceUsed: this.#countActive(source.sourceId),
        globalUsed: this.#countActive(),
      },
    })
  }

  /**
   * Open the record's alias URL in the system browser. Main composes the URL;
   * the call is honest about the outcome (ok | typed error) and consumes a
   * per-source budget, never the app-wide openExternally bucket.
   */
  async openInBrowser(args: ForwardOpenArgs): Promise<ForwardOpenResult> {
    const source = this.#sources.resolve(args.sourceId, args.sourceFingerprint)
    if (source === null) return failure('source_unknown')
    const sourceGate = evaluateForwardSourceGate(source)
    if (sourceGate !== null) return { ok: false, error: sourceGate }
    const record = this.#records.get(args.id)
    if (record === undefined || record.sourceId !== source.sourceId) return failure('forward_not_found')
    if (this.#internals.get(record.id)?.identity !== source.identity) {
      this.#patch(record.id, { stale: true })
      return failure('forward_stale')
    }
    if (record.stale) return failure('forward_stale')
    if (record.state !== 'bound') return failure('forward_not_bound')
    if (!this.#hasOpenBudget(source.sourceId)) return failure('rate_limited')
    const authorized = await this.#authorizeSource(source, record.targetPort, record.namespace)
    if (authorized !== null) return { ok: false, error: authorized }
    const fresh = this.#sources.resolve(source.sourceId, source.fingerprint)
    if (fresh === null || fresh.identity !== source.identity) {
      this.#patch(record.id, { stale: true })
      return failure('confirmation_late')
    }
    const normalized = normalizeForwardPath(args.path)
    if (!normalized.ok) return failure('invalid_path')
    if (!this.#consumeOpenBudget(source.sourceId)) return failure('rate_limited')
    const url = forwardOpenUrl(record, normalized.path)
    try {
      const opened = await this.#openExternal.openExternal(url)
      if (opened.ok) return { ok: true }
      return failure('open_failed')
    } catch {
      return failure('open_failed')
    }
  }

  /**
   * Delete/retarget teardown: close every forward of the source and retire its
   * alias (the tombstone is never reused). Returns what actually happened.
   */
  async retireSource(sourceId: string): Promise<ForwardRetireResult> {
    const ids = [...this.#records.values()].filter(record => record.sourceId === sourceId).map(record => record.id)
    await Promise.all(ids.map(id => this.#releaseRecord(id).catch(() => undefined)))
    const released = ids.length
    let namespaceRetired = false
    try {
      namespaceRetired = await this.#namespaces.retire(sourceId)
    } catch {
      namespaceRetired = false
    }
    this.#openWindows.delete(sourceId)
    return { released, namespaceRetired }
  }

  /** App exit / sidecar shutdown: close everything, never throw. */
  async stopAll(): Promise<void> {
    // Stop every child CONCURRENTLY, then bound the whole leg at 3s. Serial
    // 2s releases could exceed the shell's 4.5/5s quit deadline with >3
    // records, and later children would never even receive SIGTERM.
    const ids = [...this.#records.keys()]
    const all = Promise.all(ids.map(id => this.#releaseRecord(id).catch(() => undefined))).then(() => undefined)
    await this.#withTimeout(all, FORWARD_QUIT_TIMEOUT_MS)
  }

  #requestKey(args: ForwardRequestArgs): string | null {
    const raw: unknown = args
    if (typeof raw !== 'object' || raw === null) return null
    if (!isTargetPort(args.port)) return null
    return String(args.sourceId) + ':' + String(args.port)
  }

  async #requestOnce(args: ForwardRequestArgs): Promise<ForwardRequestResult> {
    const raw: unknown = args
    if (typeof raw !== 'object' || raw === null) return failure('source_unknown')
    const source = this.#sources.resolve(args.sourceId, args.sourceFingerprint)
    if (source === null) return failure('source_unknown')
    const gate = evaluateForwardGate(source, args.port)
    if (gate !== null) return { ok: false, error: gate }
    const scheme = args.scheme ?? 'http'
    if (!isScheme(scheme)) return failure('scheme_invalid')

    // Retarget safety (review I2): an identity change closes the old host's
    // tunnels before a new one may use this source's alias.
    await this.#retireIdentityMismatches(source)

    const existing = this.#findActive(source.sourceId, args.port)
    if (existing !== null) return { ok: true, record: existing }

    const limitError = this.#checkLimits(source.sourceId)
    if (limitError !== null) return { ok: false, error: limitError }

    // A failed record for the same key is display-only; drop it so a retry does
    // not grow the list. It owns no resources (fail() released them).
    this.#dropTerminalRecord(source.sourceId, args.port)

    // The design freezes the confirmation key as browserNamespace + targetPort,
    // so the namespace must be assigned before the native dialog. If the user
    // declines, the durable alias remains but no listener is created.
    let assignment: ForwardNamespaceAssignment
    try {
      assignment = await this.#namespaces.ensure({ sourceId: source.sourceId, identity: source.identity })
    } catch (error) {
      return failure(this.#namespaceErrorCode(error))
    }

    const authorized = await this.#authorizeSource(source, args.port, assignment.namespace)
    if (authorized !== null) {
      // A late confirmation creates no child. Do NOT burn the just-assigned
      // lifetime alias for a per-process fingerprint change; a real retarget is
      // already retired by the transport-registry source-retirement hook.
      return { ok: false, error: authorized }
    }

    // The dialog is a long await. Re-prove the source before any argv/child is
    // built: a retarget/delete during the modal must not leave a listener to
    // the old host. Retire the just-ensured old-identity alias as well.
    const fresh = this.#sources.resolve(source.sourceId, source.fingerprint)
    if (fresh === null || fresh.identity !== source.identity) {
      await this.#namespaces.retire(source.sourceId).catch(() => false)
      return failure('confirmation_late')
    }

    const choice = await this.#chooseLocalPort(assignment.aliasHost, args.port, false)
    if (!choice.ok) return failure(choice.code)

    const now = this.#now()
    const record: ForwardRecord = {
      id: this.#mintForwardId(),
      sourceId: source.sourceId,
      namespace: assignment.namespace,
      aliasHost: assignment.aliasHost,
      localPort: choice.port,
      scheme,
      targetHost: FORWARD_TARGET_HOST,
      targetPort: args.port,
      state: 'requested',
      stale: false,
      error: null,
      createdAt: now,
      updatedAt: now,
      boundAt: null,
    }
    this.#records.set(record.id, record)
    this.#internals.set(record.id, {
      id: record.id,
      sourceId: source.sourceId,
      identity: fresh.identity,
      fingerprint: args.sourceFingerprint,
      phase: 'requested',
      launchToken: 0,
      closed: false,
      child: null,
      exit: null,
      reconnectAttempts: 0,
      bindAttempts: 0,
      reconnectTimer: null,
    })
    if (!this.#claim(record.aliasHost, record.localPort, record.id)) {
      // Unreachable with a single-threaded manager (claim happens with no await
      // since the port was chosen); kept as a loud invariant.
      this.#fail(record.id, 'local_bind_failed')
      return failure('local_bind_failed')
    }
    const internal = this.#internals.get(record.id) as InternalForward
    await this.#start(record.id, internal, fresh)
    return { ok: true, record: this.#records.get(record.id) ?? record }
  }

  #mintForwardId(): string {
    const id = this.#mintId()
    if (typeof id !== 'string' || !/^fwd-[0-9a-f]{16,64}$/u.test(id)) {
      throw new TypeError('forward id mint must return fwd-<hex>')
    }
    return id
  }

  #namespaceErrorCode(error: unknown): ForwardErrorCode {
    const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : ''
    if (code === 'alias_exhausted') return 'alias_exhausted'
    return 'namespace_unavailable'
  }

  /** Native confirmation / persisted per-port enablement. Null = authorized. */
  async #authorizeSource(source: ForwardSource, targetPort: number, namespace: number): Promise<ForwardError | null> {
    if (source.browserEnabled) return null
    const key = String(namespace) + ':' + String(targetPort)
    if ((source.confirmedPorts ?? []).includes(key)) return null
    if (this.#authorize === undefined) return errorOf('browser_disabled')
    let granted = false
    try {
      granted = await this.#authorize(source, { targetPort, namespace })
    } catch (error) {
      const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : ''
      if (code === 'confirmation_late') return errorOf('confirmation_late')
      granted = false
    }
    return granted ? null : errorOf('confirmation_declined')
  }

  /** Close records that belong to a previous connection identity of this source. */
  async #retireIdentityMismatches(source: ForwardSource): Promise<void> {
    const stale = [...this.#records.values()].filter(record => {
      if (record.sourceId !== source.sourceId) return false
      return this.#internals.get(record.id)?.identity !== source.identity
    })
    await Promise.all(stale.map(record => this.#releaseRecord(record.id).catch(() => undefined)))
  }

  #findActive(sourceId: string, targetPort: number): ForwardRecord | null {
    for (const record of this.#records.values()) {
      if (record.sourceId !== sourceId || record.targetPort !== targetPort) continue
      if (record.state === 'error' || record.state === 'closed') continue
      return record
    }
    return null
  }

  #dropTerminalRecord(sourceId: string, targetPort: number): void {
    for (const record of [...this.#records.values()]) {
      if (record.sourceId !== sourceId || record.targetPort !== targetPort) continue
      if (record.state !== 'error' && record.state !== 'closed') continue
      this.#records.delete(record.id)
      this.#internals.delete(record.id)
    }
  }

  #checkLimits(sourceId: string): ForwardError | null {
    if (this.#countActive(sourceId) >= FORWARD_MAX_PER_SOURCE) return errorOf('too_many_for_source')
    if (this.#countActive() >= FORWARD_MAX_GLOBAL) return errorOf('too_many_global')
    return null
  }

  #countActive(sourceId?: string): number {
    let count = 0
    for (const record of this.#records.values()) {
      if (record.state === 'error' || record.state === 'closed') continue
      if (sourceId !== undefined && record.sourceId !== sourceId) continue
      count += 1
    }
    return count
  }

  #ownerKey(host: string, port: number): string {
    return host + ':' + String(port)
  }

  #isOwned(host: string, port: number): boolean {
    return this.#owners.has(this.#ownerKey(host, port))
  }

  #claim(host: string, port: number, forwardId: string): boolean {
    const key = this.#ownerKey(host, port)
    if (this.#owners.has(key)) return false
    this.#owners.set(key, forwardId)
    return true
  }

  #releaseOwnership(record: ForwardRecord): void {
    const key = this.#ownerKey(record.aliasHost, record.localPort)
    if (this.#owners.get(key) === record.id) this.#owners.delete(key)
  }

  async #chooseLocalPort(
    aliasHost: string,
    targetPort: number,
    fresh: boolean,
  ): Promise<{ ok: true; port: number } | { ok: false; code: ForwardErrorCode }> {
    // Same-port only when the remote side is an unprivileged port, the alias is
    // free and nobody owns the pair. A lost bind race on a retry NEVER picks the
    // same port again (fresh=true): that would loop on the same collision.
    if (!fresh && targetPort >= FORWARD_MIN_LOCAL_PORT && !this.#isOwned(aliasHost, targetPort)) {
      try {
        if (await this.#ports.isFree(aliasHost, targetPort)) return { ok: true, port: targetPort }
      } catch {
        /* probe failed: fall through to an ephemeral port */
      }
    }
    for (let attempt = 0; attempt < FORWARD_BIND_ATTEMPTS; attempt += 1) {
      let port: number
      try {
        port = await this.#ports.ephemeral(aliasHost)
      } catch {
        return { ok: false, code: 'port_exhausted' }
      }
      if (!isLocalPort(port)) continue
      if (this.#isOwned(aliasHost, port)) continue
      return { ok: true, port }
    }
    return { ok: false, code: 'port_exhausted' }
  }

  #patch(id: string, patch: Partial<ForwardRecord>): ForwardRecord | null {
    const current = this.#records.get(id)
    if (current === undefined) return null
    const next: ForwardRecord = { ...current, ...patch, updatedAt: this.#now() }
    this.#records.set(id, next)
    const internal = this.#internals.get(id)
    if (internal !== undefined) internal.phase = next.state
    return next
  }

  #alive(internal: InternalForward): boolean {
    return !internal.closed && this.#internals.get(internal.id) === internal
  }

  #delay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise(resolve => {
      this.#timers.setTimeout(() => resolve(), ms)
    })
  }

  /** Launch + probe loop; owns bind retries and bounded reconnects. */
  async #start(id: string, internal: InternalForward, source: ForwardSource): Promise<void> {
    for (;;) {
      if (!this.#alive(internal)) return
      const record = this.#records.get(id)
      if (record === undefined) return
      if (this.#authBlocked(source.sourceId)) {
        this.#fail(id, 'rate_limited')
        return
      }
      if (!(await this.#waitForSpawnSlot(source.sourceId, () => this.#alive(internal)))) return
      this.#patch(id, { state: 'starting', stale: false })
      let argv: string[]
      try {
        argv = buildForwardArgs(source.ssh, record.aliasHost, record.localPort, record.targetPort)
      } catch {
        this.#fail(id, 'forward_failed')
        return
      }
      internal.bindAttempts += 1
      const launchToken = internal.launchToken + 1
      internal.launchToken = launchToken
      internal.exit = null
      let child: ForwardChild
      try {
        child = await this.#launcher.launch({
          forwardId: record.id,
          sourceId: source.sourceId,
          aliasHost: record.aliasHost,
          localPort: record.localPort,
          targetPort: record.targetPort,
          scheme: record.scheme,
          ssh: source.ssh,
          argv,
        })
      } catch {
        this.#fail(id, 'forward_failed')
        return
      }
      if (!this.#alive(internal)) {
        child.stop()
        return
      }
      internal.child = child
      void child.exit.then(exit => this.#onChildExit(id, internal, launchToken, exit))
      const outcome = await this.#awaitBound(internal, record.aliasHost, record.localPort)
      if (!this.#alive(internal)) return
      if (outcome === 'bound' && internal.exit === null) {
        this.#patch(id, { state: 'bound', stale: false, error: null, boundAt: this.#now() })
        this.#authFailures.delete(source.sourceId)
        this.#authCooldownUntil.delete(source.sourceId)
        // Reconnect budget is per record (not per incident): a flapping child
        // must not loop forever. A successful bind only resets the BIND retry
        // budget; the user starts a fresh reconnect budget by releasing and
        // requesting again. TODO(W0): reset after a long stable session once
        // the product decides the window.
        internal.bindAttempts = 0
        return
      }
      // Re-read after the await with an explicit type: TypeScript's control-flow
      // narrowing from #awaitBound's `internal.exit !== null` does not model the
      // exit callback mutating the property during the await.
      const exit = internal.exit as ForwardChildExit | null
      internal.launchToken += 1 // detach the exit callback of the failed launch
      internal.child = null
      child.stop()
      if (exit !== null && exit.authFailed) {
        this.#recordAuthFailure(source.sourceId)
        this.#fail(id, 'auth_failed')
        return
      }
      const bindLike = outcome === 'timeout' || (exit !== null && exit.bindFailed)
      if (bindLike && internal.bindAttempts < FORWARD_BIND_ATTEMPTS) {
        const reallocated = await this.#reallocate(id, internal)
        if (!reallocated) return
        continue
      }
      if (bindLike) {
        this.#fail(id, 'local_bind_failed')
        return
      }
      if (!(await this.#waitForReconnect(id, internal))) return
      internal.bindAttempts = 0
    }
  }

  /** Probe the local listener until bound, exit, timeout or cancellation. */
  async #awaitBound(internal: InternalForward, host: string, port: number): Promise<'bound' | 'exited' | 'timeout'> {
    const deadline = this.#now() + this.#probeTimeoutMs
    for (;;) {
      if (!this.#alive(internal)) return 'exited'
      if (internal.exit !== null) return 'exited'
      let reachable = false
      try {
        reachable = await this.#probe(host, port)
      } catch {
        reachable = false
      }
      if (!this.#alive(internal)) return 'exited'
      if (reachable) return 'bound'
      if (this.#now() >= deadline) return 'timeout'
      await this.#delay(this.#probeIntervalMs)
    }
  }

  /** Re-pick a local port after a lost bind race; false when the record failed. */
  async #reallocate(id: string, internal: InternalForward): Promise<boolean> {
    const record = this.#records.get(id)
    if (record === undefined) return false
    this.#releaseOwnership(record)
    const choice = await this.#chooseLocalPort(record.aliasHost, record.targetPort, true)
    if (!choice.ok) {
      this.#fail(id, choice.code)
      return false
    }
    if (!this.#alive(internal)) return false
    if (!this.#claim(record.aliasHost, choice.port, id)) {
      this.#fail(id, 'local_bind_failed')
      return false
    }
    this.#patch(id, { localPort: choice.port, state: 'starting' })
    return true
  }

  /** Bounded reconnect wait; false when the budget is exhausted (record failed). */
  async #waitForReconnect(id: string, internal: InternalForward): Promise<boolean> {
    if (internal.reconnectAttempts >= this.#reconnect.maxAttempts) {
      this.#fail(id, 'forward_failed')
      return false
    }
    internal.reconnectAttempts += 1
    this.#patch(id, { state: 'reconnecting', stale: true })
    await this.#delay(this.#backoffMs(internal.reconnectAttempts))
    if (!this.#alive(internal)) return false
    return true
  }

  #backoffMs(attempt: number): number {
    const raw = this.#reconnect.baseDelayMs * 2 ** Math.max(0, attempt - 1)
    return Math.min(raw, this.#reconnect.maxDelayMs)
  }

  /** Exit notification for the LAST launch token only. */
  #onChildExit(id: string, internal: InternalForward, launchToken: number, exit: ForwardChildExit): void {
    if (internal.launchToken !== launchToken) return
    internal.exit = exit
    internal.child = null
    if (!this.#alive(internal)) return
    if (internal.phase === 'starting' || internal.phase === 'requested') return // start loop owns it
    if (internal.phase !== 'bound') return
    if (exit.authFailed) {
      this.#recordAuthFailure(internal.sourceId)
      this.#fail(id, 'auth_failed')
      return
    }
    this.#scheduleReconnect(id, internal)
  }

  #scheduleReconnect(id: string, internal: InternalForward): void {
    if (internal.reconnectAttempts >= this.#reconnect.maxAttempts) {
      this.#fail(id, 'forward_failed')
      return
    }
    internal.reconnectAttempts += 1
    this.#patch(id, { state: 'reconnecting', stale: true })
    internal.reconnectTimer = this.#timers.setTimeout(() => {
      internal.reconnectTimer = null
      void this.#restart(id, internal)
    }, this.#backoffMs(internal.reconnectAttempts))
  }

  /** Relaunch after an unexpected exit; re-proves the source identity first. */
  async #restart(id: string, internal: InternalForward): Promise<void> {
    if (!this.#alive(internal)) return
    const source = this.#sources.resolve(internal.sourceId, internal.fingerprint)
    if (source === null) {
      this.#fail(id, 'source_unknown')
      return
    }
    if (source.identity !== internal.identity) {
      this.#fail(id, 'source_changed')
      return
    }
    internal.bindAttempts = 0
    await this.#start(id, internal, source)
  }

  /** Terminal failure: release every resource, keep the record for display. */
  #fail(id: string, code: ForwardErrorCode): void {
    const internal = this.#internals.get(id)
    if (internal === undefined || internal.closed) return
    internal.closed = true
    internal.launchToken += 1
    if (internal.reconnectTimer !== null) {
      this.#timers.clearTimeout(internal.reconnectTimer)
      internal.reconnectTimer = null
    }
    const child = internal.child
    internal.child = null
    if (child !== null) child.stop()
    const record = this.#records.get(id)
    if (record !== undefined) this.#releaseOwnership(record)
    this.#patch(id, { state: 'error', stale: false, error: errorOf(code) })
  }

  /** Close + forget one record (release/retire). */
  async #releaseRecord(id: string): Promise<void> {
    const record = this.#records.get(id)
    if (record === undefined) return
    const internal = this.#internals.get(id)
    if (internal !== undefined && !internal.closed) {
      internal.closed = true
      internal.launchToken += 1
      if (internal.reconnectTimer !== null) {
        this.#timers.clearTimeout(internal.reconnectTimer)
        internal.reconnectTimer = null
      }
      const child = internal.child
      internal.child = null
      this.#patch(id, { state: 'closing', error: null })
      if (child !== null) {
        const exited = child.exit.then(() => undefined, () => undefined)
        child.stop()
        await this.#withTimeout(exited, this.#releaseTimeoutMs)
      }
    }
    const current = this.#records.get(id)
    if (current !== undefined) this.#releaseOwnership(current)
    this.#patch(id, { state: 'closed', error: null })
    this.#records.delete(id)
    this.#internals.delete(id)
  }

  #withTimeout(promise: Promise<void>, ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise(resolve => {
      const timer = this.#timers.setTimeout(() => resolve(), ms)
      void promise.then(() => {
        this.#timers.clearTimeout(timer)
        resolve()
      }, () => {
        this.#timers.clearTimeout(timer)
        resolve()
      })
    })
  }

  /** Wait for the per-source spawn slot, then consume it (design 28 §6.8). */
  async #waitForSpawnSlot(sourceId: string, alive: () => boolean): Promise<boolean> {
    for (;;) {
      if (!alive()) return false
      const now = this.#now()
      const window = (this.#spawnWindows.get(sourceId) ?? [])
        .filter(stamp => now - stamp < this.#spawnWindowMs && stamp <= now)
      if (window.length < FORWARD_SPAWN_MAX_PER_WINDOW) {
        window.push(now)
        this.#spawnWindows.set(sourceId, window)
        return true
      }
      // Use the window length rather than the injected clock for the wait:
      // tests can hold a fixed clock and still observe deterministic spacing.
      await this.#delay(this.#spawnWindowMs)
      if (!alive()) return false
      // Consume the new slot; do not wipe the window (that let every subsequent
      // request bypass the 1/2s throttle).
      this.#spawnWindows.set(sourceId, [this.#now()])
      return true
    }
  }

  #authBlocked(sourceId: string): boolean {
    const until = this.#authCooldownUntil.get(sourceId)
    if (until === undefined) return false
    if (until > this.#now()) return true
    this.#authCooldownUntil.delete(sourceId)
    return false
  }

  #recordAuthFailure(sourceId: string): void {
    const now = this.#now()
    const previous = this.#authFailures.get(sourceId)
    const count = (previous === undefined ? 0 : previous.count) + 1
    this.#authFailures.set(sourceId, { count, last: now })
    if (count >= FORWARD_AUTH_FAILURE_LIMIT) {
      this.#authCooldownUntil.set(sourceId, now + FORWARD_AUTH_COOLDOWN_MS)
      this.#authFailures.delete(sourceId)
    }
  }

  #hasOpenBudget(sourceId: string): boolean {
    const now = this.#now()
    const window = (this.#openWindows.get(sourceId) ?? []).filter(stamp => now - stamp < FORWARD_OPEN_WINDOW_MS && stamp <= now)
    this.#openWindows.set(sourceId, window)
    return window.length < FORWARD_OPEN_MAX_PER_WINDOW
  }

  #consumeOpenBudget(sourceId: string): boolean {
    const now = this.#now()
    const window = (this.#openWindows.get(sourceId) ?? []).filter(stamp => now - stamp < FORWARD_OPEN_WINDOW_MS && stamp <= now)
    if (window.length >= FORWARD_OPEN_MAX_PER_WINDOW) {
      this.#openWindows.set(sourceId, window)
      return false
    }
    window.push(now)
    this.#openWindows.set(sourceId, window)
    return true
  }
}
