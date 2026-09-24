/**
 * Session-state wire contract — THE single source for the read-only
 * /chamber/session-state facts shared by the watcher server (gateway), the desktop
 * session-facts probe and the renderer's fact projection.
 *
 *   - `protocol` is the INTERFACE version, independent of product version; unknown
 *     feature ids are ignored and never degrade the source.
 *   - Only HTTP 404 is a VERSION fact (legacy-gateway); 5xx and timeouts are
 *     unavailable — a starting gateway must never be labelled "not upgraded".
 *   - A missing advertised-required feature ⇒ forward-skew with the exact ids.
 *   - `completedAtSource` distinguishes an observed completion edge from a gap
 *     reconstruction; only an observed completion may feed a notification.
 *   - Read marks merge monotonically (max), evaluated SOURCE-WIDE across clients
 *     plus the source floor (phone read ⇒ desktop dot out); `completed` counts as a
 *     completion, `aborted`+cause=user is a user stop (never unread), the rest neutral.
 */

/**
 * Interface major version of the /chamber/session-state wire. A semantic change
 * bumps this and keeps one version of dual reads; 0.4.x only adds.
 */
export const PROTOCOL_VERSION = 1

/** Alias of PROTOCOL_VERSION:
 *  one initializer, so the two exported names can never drift. */
export const SESSION_STATE_PROTOCOL_VERSION = PROTOCOL_VERSION

/** Canonical route prefix of the read-only session-state surface; it lives inside
 *  the existing /chamber/* auth gate — no new authentication face is created. */
export const SESSION_STATE_PATH = '/chamber/session-state'

/** SSE increment route; `id:` is a monotonic per-source cursor and
 *  `Last-Event-ID` resumes from it (heartbeat comments never carry an id). */
export const SESSION_STATE_STREAM_PATH = `${SESSION_STATE_PATH}/stream`

/** Idempotent, monotonic per-session read-mark upsert. */
export const SESSION_STATE_READ_PATH = `${SESSION_STATE_PATH}/read`

/** Idempotent, monotonic source-wide read-floor upsert (`through`; a
 *  server-side "take the current maximum" is explicitly rejected). */
export const SESSION_STATE_READ_ALL_PATH = `${SESSION_STATE_PATH}/read-all`

/** The four claimed paths in canonical order. */
export const SESSION_STATE_ROUTES = Object.freeze([
  SESSION_STATE_PATH,
  SESSION_STATE_STREAM_PATH,
  SESSION_STATE_READ_PATH,
  SESSION_STATE_READ_ALL_PATH,
] as const)

/**
 * The frozen feature tuple advertised in the descriptor: dotted, lowercase, stable
 * ids; a minor may only ADD ids. An explicit coverage net fails when this tuple
 * grows without a conscious update.
 */
export const SESSION_STATE_FEATURES = Object.freeze([
  /** GET /chamber/session-state returns the snapshot descriptor. */
  'session-state.snapshot',
/** The SSE increment route exists. */
  'session-state.stream',
  /** The stream resumes from Last-Event-ID within a bounded cursor window. */
  'session-state.last-event-id',
/** POST /read upserts a per-session read mark. */
  'session-state.read',
/** POST /read-all upserts the source-wide read floor. */
  'session-state.read-all',
  /** The snapshot carries the host clock (the only unread comparison domain). */
  'session-state.host-clock',
  /** The $events subscription is live (dsh-events family observed). */
  'session-state.dsh-events',
  /** pendingKind is derived from the forwarded request waterfalls. */
  'session-state.pending-graph',
] as const)

/** Known feature id (derived union of the frozen tuple). */
export type SessionStateFeature = (typeof SESSION_STATE_FEATURES)[number]

/** Known feature ids as a set, for wire-value filtering (never an
 *  authoritative "supported" list — the tuple above is). */
const KNOWN_SESSION_STATE_FEATURES: ReadonlySet<string> = new Set(SESSION_STATE_FEATURES)

/**
 * The features a client requires for unread/pending to be meaningful. A conforming
 * descriptor missing any of these classifies as forward-skew, so the source degrades
 * explicitly instead of claiming ok with silently narrower facts.
 */
export const SESSION_STATE_BASE_FEATURES: readonly SessionStateFeature[] = Object.freeze([
  'session-state.snapshot',
  'session-state.host-clock',
])

/**
 * Stable, structured degradation codes: wire-independent diagnostics the client maps
 * to user-visible copy through sessionStateNoteKey, never by parsing prose.
 */
export const SESSION_STATE_DEGRADATION_CODES = Object.freeze([
  /** pre-0.4.0 gateway: the route set is absent (HTTP 404). */
  'legacy-gateway',
  /** 0.4.0 gateway with the observer switch off (503 session_state_disabled). */
  'watcher-disabled',
  /** 200 response without a usable protocol field — most conservative path. */
  'unversioned',
  /** 5xx / timeout / network / non-404 carrier failure: NOT a version fact. */
  'unavailable',
  /** Descriptor newer than this client, or missing a required feature. */
  'forward-skew',
  /** Runtime handshake failed: no session events observed inside the window. */
  'dsh-events-absent',
  /** Pending cannot be derived in the current mode. */
  'pending-unavailable',
  /** Last-Event-ID is behind the retained cursor ring — refetch the snapshot. */
  'cursor-expired',
  /** Last-Event-ID is ahead of the cursor (observer restart) — refetch. */
  'cursor-ahead',
  /** The gateway predates the read routes; read marks stay local. */
  'read-unsupported',
] as const)

/** Stable degradation code (derived union of the tuple). */
export type SessionStateDegradationCode = (typeof SESSION_STATE_DEGRADATION_CODES)[number]

/** Read-request body cap (gateway routes reject larger bodies with 413). */
export const SESSION_STATE_READ_BODY_MAX_BYTES = 16 * 1024

/** Client-install id shape: an unguessable token minted once per install
 *  (localStorage + server registration). Read marks are keyed by it. */
export const SESSION_STATE_CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/

/** Session-id bound accepted by the read routes (control characters rejected
 *  by the route validator, not here). */
export const SESSION_STATE_SESSION_ID_MAX_CHARS = 128

/** One capability probe deadline: a single retry, then exponential backoff. */
export const SESSION_STATE_PROBE_TIMEOUT_MS = 5_000

/** Runtime dsh-events handshake window (5s ⇒ mode:poll +
 *  dsh-events-absent; no half-subscribed row may survive). */
export const SESSION_STATE_HANDSHAKE_WINDOW_MS = 5_000

/** Wire runtime mode: live event subscription, polling fallback, or off. */
export type SessionStateMode = 'sse' | 'poll' | 'off'

/** Projected host lifecycle state (gateway plane connectionState, mapped). */
export type SessionStateHostState =
  | 'ready'
  | 'degraded'
  | 'starting'
  | 'stopped'
  | 'error'
  | 'restart-exhausted'
  | 'quarantined'
  | 'unknown'

/** Pending interaction kind derived from the forwarded request waterfalls. */
export type SessionStatePendingKind = 'approval' | 'question'

/**
 * How a completion edge was obtained. `observed` = a live
 * api-session/status true→false edge (notification-eligible); `reconstructed`
 * = gap reconstruction across an observer restart (unread only — back-filling
 * a notification for a completion that happened while the desktop was closed
 * is forbidden).
 */
export type SessionStateCompletedAtSource = 'observed' | 'reconstructed'

/** Persisted turn/end.reason kind family of the pinned dsh. */
export type SessionTurnEndKind =
  | 'completed'
  | 'aborted'
  | 'blocked'
  | 'error'
  | 'max-tokens'
  | 'interrupted'

/** aborted cause family (dsh TurnEndCancelCause; `legacy` = cause absent). */
export type SessionTurnEndCause = 'user' | 'parent' | 'hook' | 'disposed' | 'legacy'

/** The last observed turn conclusion of one session. `at` is the OBSERVER's clock;
 *  `seq` is the host event sequence number when the follow stream carried one. */
export interface SessionTurnEnd {
  kind: SessionTurnEndKind
  cause: SessionTurnEndCause | null
  at: number
  seq: number | null
}

/** One session row of the snapshot/delta. Session ids and state metadata
 *  only — never a title, cwd, prompt or message (privacy rule). */
export interface SessionStateRow {
  sessionId: string
  running: boolean
  pendingKind: SessionStatePendingKind | null
  subagentCount: number
  /** Host-clock milliseconds (summary.updatedAt; on the current pin it only
   *  advances on user-authored durable messages). */
  updatedAt: number
  /** Observer-clock milliseconds of the observed true→false edge (or null). */
  completedAt: number | null
  completedAtSource: SessionStateCompletedAtSource | null
  /** Observer-clock milliseconds the session was last seen running. */
  lastRunningAt: number | null
  lastTurnEnd: SessionTurnEnd | null
  /**
   * 观察者**刷新这一行事实**时的 host 域毫秒（0 = 从未观察）。加法字段：把「这一行有多新」
   * 变成可查询事实，使 t_c + 2s 这类判据可测，而不必从沉默里推断。
   */
  factAt: number
}

/** Source-wide read state. `marks` is the per-session max across clients known to the
 *  observer; `floor` is the read-all floor. `clientId` echoes the requesting install. */
export interface SessionStateReadState {
  clientId: string | null
  marks: Readonly<Record<string, number>>
  floor: number
}

/** Host gate + clock carried by every snapshot. When `serviceable` is false the rows
 *  are still returned but MUST be read as unknown — host-down never fabricates a completion. */
export interface SessionStateHostInfo {
  now: number
  serviceable: boolean
  state: SessionStateHostState
}

/** Full snapshot (GET {SESSION_STATE_PATH}); the SSE first frame is the same shape. */
/**
 * Watcher self-diagnostics: read-only counters that let clients and acceptance
 * instruments SEE dropped frames, reconnects, follow reads and turn/end
 * classification instead of inferring from silence. Additive descriptor field —
 * unknown clients keep working. No independent "gap detected" event exists, so the
 * counters are named baselines/reconnects (each ready/reconnect reconciles).
 */
export interface SessionStateDiagnostics {
  /** `$events` downlink frames received since start(). */
  eventsReceived: number
  /** Host-domain ms of the last received frame; 0 = none yet. */
  lastEventAt: number
  /** Full `session/list` baselines applied (>1 = at least one reconcile). */
  baselines: number
  /** Cumulative reconnect attempts (R21 silence / link loss). */
  reconnects: number
  /** Completion edges that opened exactly one `session/follow`. */
  followReads: number
  /** `session/follow` reads that failed (tail unreadable). */
  followFailures: number
  /** Waterfall frames currently held (never settled by us). */
  heldWaterfalls: number
  /** Effective mode and whether the mux degraded to polling (R18). */
  mode: SessionStateMode
  degraded: boolean
  /** turn/end classification mix of settled completions (I16/R12). */
  turnEnds: { completed: number; userStopped: number; neutral: number; unreadable: number }
  /** Store-side losses: evicted rows / trimmed read clients / trimmed marks. */
  dropped: { sessions: number; readClients: number; readMarks: number }
  /** Cursor of the last committed delta batch (baseline-progress readback). */
  cursor: number
}

export interface SessionStateSnapshot {
  protocol: number
  features: readonly SessionStateFeature[]
  mode: SessionStateMode
  cursor: number
  host: SessionStateHostInfo
  sessions: readonly SessionStateRow[]
  read: SessionStateReadState
  /** I6/I16：加法字段（本版 watcher 总是发；旧客户端忽略）。 */
  diagnostics?: SessionStateDiagnostics
}

/** One SSE increment. Emitted events have no replay, so every (re)connect also
 *  performs a full session/list baseline reconciliation; a delta optimizes on top of it. */
export interface SessionStateDelta {
  cursor: number
  sessions: readonly SessionStateRow[]
  removedSessionIds: readonly string[]
  /** Present whenever any read mark moved (R10 cross-client convergence). */
  read: SessionStateReadState | null
  host: SessionStateHostInfo | null
  mode: SessionStateMode | null
}

/** POST {SESSION_STATE_READ_PATH} body: idempotent, monotonic upsert. */
export interface ReadRequest {
  clientId: string
  sessionId: string
  /** The client's monotonic completion cursor for this session (never a
   *  client wall clock). */
  readThrough: number
}

/** POST {SESSION_STATE_READ_ALL_PATH} body: source-wide floor upsert. The client
 *  supplies `through`; the server must NOT compute "now". */
export interface ReadAllRequest {
  clientId: string
  through: number
}

/** The descriptor facts the capability classifier consumes (parsed from an
 *  otherwise untrusted 200 body). */
export interface SessionStateDescriptor {
  /** Positive integer protocol major, or null when absent/invalid. */
  protocol: number | null
  /** Raw advertised ids in wire order (unknown ids preserved for diagnostics
   *  and ignored for judgement — compat rule R2). */
  features: readonly string[]
  mode: SessionStateMode | null
  cursor: number | null
}

/** Capability verdict family (the protocol contract). */
export type SessionStateCapabilityKind =
  | 'ok'
  | 'legacy-gateway'
  | 'disabled'
  | 'unversioned'
  | 'unavailable'
  | 'forward-skew'

/** Transport-failure reason of one capability probe. */
export type SessionStateProbeFailureReason = 'timeout' | 'network'

/** One capability-probe observation: a status (+ parsed body) or a transport failure.
 *  This module performs no I/O. */
export type SessionStateProbeOutcome =
  | { readonly kind: 'response'; readonly status: number; readonly body?: unknown }
  | { readonly kind: 'failure'; readonly reason: SessionStateProbeFailureReason }

/** The classified capability of one source. */
export interface SessionStateCapability {
  kind: SessionStateCapabilityKind
  /** HTTP status, or null for a transport failure. */
  status: number | null
  /** Parsed protocol major, when the response carried a valid one. */
  protocol: number | null
  mode: SessionStateMode | null
  /** Known advertised features (unknown ids are dropped, never judged). */
  features: readonly SessionStateFeature[]
  /** Required features the descriptor does not advertise (forward-skew). */
  missingFeatures: readonly SessionStateFeature[]
  /** Stable degradation code, or null when kind is ok. */
  degradation: SessionStateDegradationCode | null
  /** Short diagnostic detail (status/timeout/network); never a payload. */
  detail: string | null
}

/** Disposition of one turn/end fact for the unread predicate (R12). */
export type SessionTurnEndDisposition = 'completed' | 'user-stopped' | 'neutral'

/** Narrow an untrusted value to a plain JSON object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** A non-negative safe-integer watermark (host or observer clock domain). */
function isWatermark(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Filter advertised ids to the known frozen set (unknown ids are ignored). */
function knownFeatures(raw: readonly string[]): readonly SessionStateFeature[] {
  return raw.filter((feature): feature is SessionStateFeature => KNOWN_SESSION_STATE_FEATURES.has(feature))
}

/**
 * Parse the descriptor facts out of one 200 response body. Never throws and never
 * guesses: an absent/invalid field stays null, so the classifier takes the most
 * conservative path. Unknown fields are ignored.
 */
export function parseSessionStateDescriptor(value: unknown): SessionStateDescriptor | null {
  if (!isPlainRecord(value)) return null
  const protocol = typeof value.protocol === 'number'
    && Number.isSafeInteger(value.protocol)
    && value.protocol >= 1
    ? value.protocol
    : null
  const features = Array.isArray(value.features)
    ? value.features.filter((feature): feature is string => typeof feature === 'string' && feature.length > 0)
    : []
  const mode = value.mode === 'sse' || value.mode === 'poll' || value.mode === 'off' ? value.mode : null
  const cursor = isWatermark(value.cursor) ? value.cursor : null
  return { protocol, features, mode, cursor }
}

/**
 * Compute the missing-required-feature set of one advertised list. Unknown ids do not
 * count; ok === false only when a required id is absent.
 */
export function sessionStateFeatureSupport(
  advertised: readonly string[],
  required: readonly SessionStateFeature[] = SESSION_STATE_BASE_FEATURES,
): { ok: boolean; missing: readonly SessionStateFeature[] } {
  const present = new Set(advertised)
  const missing = required.filter(feature => !present.has(feature))
  return { ok: missing.length === 0, missing }
}

/**
 * Classify one capability probe observation into the verdict family. Pure — no I/O,
 * no clock; `requiredFeatures` defaults to SESSION_STATE_BASE_FEATURES. The order of
 * the checks IS the contract:
 *   1. transport failure ⇒ unavailable (never legacy)
 *   2. 404 ⇒ legacy-gateway; 503 + session_state_disabled ⇒ disabled
 *   3. any other non-2xx ⇒ unavailable
 *   4. 2xx without protocol field ⇒ unversioned
 *   5. 2xx with mode==='off' ⇒ disabled ("observer off" second shape)
 *   6. protocol > PROTOCOL_VERSION ⇒ forward-skew
 *   7. required feature missing ⇒ forward-skew (+ missingFeatures)
 *   8. otherwise ⇒ ok
 */
export function classifySessionStateProbe(
  outcome: SessionStateProbeOutcome,
  requiredFeatures: readonly SessionStateFeature[] = SESSION_STATE_BASE_FEATURES,
): SessionStateCapability {
  if (outcome.kind === 'failure') {
    return {
      kind: 'unavailable',
      status: null,
      protocol: null,
      mode: null,
      features: [],
      missingFeatures: [],
      degradation: 'unavailable',
      detail: outcome.reason,
    }
  }
  const { status } = outcome
  const empty: Pick<SessionStateCapability, 'protocol' | 'mode' | 'features' | 'missingFeatures'> = {
    protocol: null,
    mode: null,
    features: [],
    missingFeatures: [],
  }
  if (status === 404) {
    return { kind: 'legacy-gateway', status, ...empty, degradation: 'legacy-gateway', detail: 'status' }
  }
  if (status === 503 && isSessionStateDisabledBody(outcome.body)) {
    return { kind: 'disabled', status, ...empty, degradation: 'watcher-disabled', detail: 'status' }
  }
  if (status < 200 || status >= 300) {
    return { kind: 'unavailable', status, ...empty, degradation: 'unavailable', detail: 'status' }
  }
  const descriptor = parseSessionStateDescriptor(outcome.body)
  if (descriptor === null || descriptor.protocol === null) {
    return { kind: 'unversioned', status, ...empty, degradation: 'unversioned', detail: 'status' }
  }
  const features = knownFeatures(descriptor.features)
  // The kill switch has two server shapes (503 session_state_disabled; 200 +
  // mode:'off'), both meaning "upgraded gateway, observer off" — never a version-skew hint.
  if (descriptor.mode === 'off') {
    return {
      kind: 'disabled',
      status,
      protocol: descriptor.protocol,
      mode: 'off',
      features,
      missingFeatures: [],
      degradation: 'watcher-disabled',
      detail: 'mode',
    }
  }
  const support = sessionStateFeatureSupport(descriptor.features, requiredFeatures)
  if (descriptor.protocol > PROTOCOL_VERSION) {
    return {
      kind: 'forward-skew',
      status,
      protocol: descriptor.protocol,
      mode: descriptor.mode,
      features,
      missingFeatures: support.missing,
      degradation: 'forward-skew',
      detail: 'protocol',
    }
  }
  if (!support.ok) {
    return {
      kind: 'forward-skew',
      status,
      protocol: descriptor.protocol,
      mode: descriptor.mode,
      features,
      missingFeatures: support.missing,
      degradation: 'forward-skew',
      detail: 'features',
    }
  }
  return {
    kind: 'ok',
    status,
    protocol: descriptor.protocol,
    mode: descriptor.mode,
    features,
    missingFeatures: [],
    degradation: null,
    detail: null,
  }
}

/** Recognize the 503 kill-switch body ({error|code:'session_state_disabled'}, including nested error.code). */
function isSessionStateDisabledBody(body: unknown): boolean {
  if (!isPlainRecord(body)) return false
  if (body.error === 'session_state_disabled' || body.code === 'session_state_disabled') return true
  const nested = body.error
  return isPlainRecord(nested) && nested.code === 'session_state_disabled'
}

/**
 * Map one verdict kind to its user-visible copy key, or null for `ok`. The exhaustive
 * switch (no default) makes a new verdict kind a compile error, so a degraded source
 * can never render silently. The sidebar owns the translations; this owns the key set.
 */
export function sessionStateNoteKey(kind: SessionStateCapabilityKind): string | null {
  switch (kind) {
    case 'ok': return null
    case 'legacy-gateway': return 'source.sessionState.legacyGateway'
    case 'disabled': return 'source.sessionState.disabled'
    case 'unversioned': return 'source.sessionState.unversioned'
    case 'unavailable': return 'source.sessionState.unavailable'
    case 'forward-skew': return 'source.sessionState.forwardSkew'
  }
}

/**
 * Monotonic read-mark merge: max(existing, incoming). Read marks only ever rise, so a
 * reordered or repeated write can never resurrect unread. Values outside the watermark
 * domain are treated as absent.
 */
export function mergeReadMark(existing: number | null | undefined, incoming: number): number {
  const current = isWatermark(existing) ? existing : 0
  const next = isWatermark(incoming) ? incoming : 0
  return next > current ? next : current
}

/**
 * Clamp an incoming read mark to the HOST clock at acceptance time. Read marks live in
 * the host domain, so a client may claim to have read up to "now" but never into its own
 * future: a desktop clock running ahead would otherwise suppress every completion
 * landing in the skew window (lost true unread). Watermarks share the same host domain
 * (`row.updatedAt`/`row.completedAt`), so a legitimate mark is unaffected.
 */
export function clampReadThrough(value: number, at: number): number {
  const ceiling = isWatermark(at) ? at : 0
  return value > ceiling ? ceiling : value
}

/**
 * Source-wide effective read mark for ONE session: the max over every client's mark for
 * that session plus the source floor. "Stored per client-install, judged per source" is
 * what lets a read on one client clear unread on every other client.
 */
export function effectiveReadMark(
  marks: Iterable<number | null | undefined>,
  floor = 0,
): number {
  let effective = isWatermark(floor) ? floor : 0
  for (const mark of marks) {
    if (isWatermark(mark) && mark > effective) effective = mark
  }
  return effective
}

/**
 * Classify one turn/end fact for the unread predicate: `completed` counts as a
 * completion; `aborted` with cause `user` is an explicit stop and must NOT arm unread;
 * every other conclusion (blocked/error/max-tokens/interrupted, aborted for other
 * causes, or an absent fact) is neutral.
 */
export function classifyTurnEnd(
  turnEnd: SessionTurnEnd | null | undefined,
): SessionTurnEndDisposition {
  if (turnEnd === null || turnEnd === undefined) return 'neutral'
  if (turnEnd.kind === 'completed') return 'completed'
  if (turnEnd.kind === 'aborted' && turnEnd.cause === 'user') return 'user-stopped'
  return 'neutral'
}
