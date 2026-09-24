/**
 * Minimal Typert Remote mux client (/api/remote.mux) for the read-only
 * session-state observer.
 *
 * Why it lives in @dsh-chamber/control-plane: `ws` is declared by this
 * package only (packages/control-plane/package.json:19) and this package is
 * already the home of "the wire client that talks to a dsh host". The gateway
 * imports it through the package root (no manifest edge, no new dependency).
 *
 * What it is (and is NOT):
 *
 *   - ONE socket per host base URL. On open it sends exactly one `$events`
 *     open frame; every (re)connect — no matter why — is followed by a FULL
 *     unary `session/list` baseline reconciliation, because emit-type
 *     forwarded events have no retransmission and the `$events` opening frame
 *     does not replay session state (「（重）连必须对账」).
 *     Frames that arrive while the baseline request is in flight are queued
 *     and applied after it (standard snapshot+replay).
 *   - An OBSERVER. It never sends `$events/result` unless the injected
 *     delegate says another downstream mux client is attached AND the
 *     waterfall frame has aged past the grace window. Otherwise it holds the
 *     frame and settles nothing — answering `next` while no browser shell is
 *     attached makes the host settle the approval as "unavailable"
 *     (observer-discipline hard rule).
 *   - A readiness/event-silence signal: `status()` exposes `ready`,
 *     `clientId`, `lastEventAt`, `lastReadyAt`, `reconnects`, and an optional
 *     `silenceTimeoutMs` turns "connection alive, events stopped" into a
 *     resubscribe + full re-baseline.
 *   - Not a policy owner: it never decides the gateway's mode (sse/poll), never
 *     persists state and never becomes an authority on session facts.
 *
 * Privacy: only session ids / booleans / counters leave this
 * module. The waterfall `request` payload is parsed past and deliberately NOT
 * retained (no field for it exists below); `api-session/error` emits are
 * dropped without reading their text; diagnostics carry fixed strings and
 * error codes only.
 *
 * Socket seam: tests inject `openSocket` (see MuxSocket) and never touch
 * `ws`; the real opener imports `ws` lazily so this module stays loadable
 * under a plain node type-strip (no node_modules).
 */

import { call as controlPlaneCall } from './dsh-client.ts'
import {
  SESSION_STATE_HANDSHAKE_WINDOW_MS,
  type SessionStatePendingKind,
  type SessionTurnEnd,
  type SessionTurnEndCause,
  type SessionTurnEndKind,
} from './session-state-protocol.ts'
import { errorMessage } from './error-text.ts'

/**
 * Exact WebSocket route carrying every Typert Remote stream. The values below
 * mirror packages/dsh-api-gateway/src/stream-protocol.ts:6-18 (the in-repo
 * copy of the pinned vendor wire) — this package does NOT depend on
 * @dsh-chamber/dsh-api-gateway and must not grow that manifest edge. The
 * session-mux test pins each literal against that source file, so a vendor
 * rename fails loud instead of silently opening nothing.
 */
export const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'
/** Gateway-internal logical stream carrying the forwarded event family. */
export const REMOTE_EVENT_STREAM_ENDPOINT = '$events'
/** Unary endpoint answering one delivered waterfall. */
export const REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'
/** Empty standard Remote payload opening the forwarded-event stream. */
export const REMOTE_EVENT_STREAM_PAYLOAD: { readonly args: Readonly<Record<string, never>> } =
  Object.freeze({ args: Object.freeze({}) })

/** Local stream id of the single `$events` subscription. */
export const EVENTS_STREAM_ID = 'events'

/** Waterfall hold window before an attached downstream client may be answered
 *  on our behalf (1.5s grace). */
export const DEFAULT_WATERFALL_GRACE_MS = 1_500

/** Reconnect backoff floor. */
export const DEFAULT_MUX_RECONNECT_MIN_MS = 500
/** Reconnect backoff ceiling. */
export const DEFAULT_MUX_RECONNECT_MAX_MS = 15_000

/** Baseline `session/list` unary deadline. */
export const DEFAULT_BASELINE_TIMEOUT_MS = 15_000
/** One-shot follow deadline; the completion edge read must stay bounded. */
export const DEFAULT_FOLLOW_TIMEOUT_MS = 2_000
/** How many tail messages a completion-edge follow asks for (the turn/end
 *  record sits at the tail; the vendor wire's `follow` uses 4). */
export const FOLLOW_MAX_MESSAGES = 8
/** Bound on frames queued behind an in-flight baseline before the queue is
 *  dropped and a fresh reconciliation is requested. */
export const MAX_QUEUED_EVENTS_FRAMES = 256
/** `session/list` response cap: a full baseline can exceed the 1 MiB unary
 *  default, so the baseline call raises it deliberately and stays bounded. */
export const SESSION_LIST_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Zero-argument `session/list` payload (the Remote parameter name is
 *  `_request`; a wrong shape answers gateway/arguments-invalid). */
export const SESSION_LIST_PAYLOAD: { readonly args: { readonly _request: Readonly<Record<string, never>> } } =
  Object.freeze({ args: Object.freeze({ _request: Object.freeze({}) }) })

/** Unary response shape this client consumes (the narrow server-response). */
export interface MuxUnaryResult {
  result: {
    ok: boolean
    value?: unknown
    error?: { code?: string; message?: string; details?: unknown }
  }
}

/** Unary carrier seam; defaults to the control-plane client
 *  (packages/control-plane/src/dsh-client.ts `call`, cookie included). */
export type MuxUnaryCall = (
  baseUrl: string,
  method: string,
  payload: unknown,
  options?: { signal?: AbortSignal; timeoutMs?: number | null; maxResponseBytes?: number },
) => Promise<MuxUnaryResult>

/** One white-listed `session/list` row. A projection whitelist, not a
 *  convenience: title/cwd/agentPreset/todos/projections must never enter the
 *  observer (privacy whitelist). */
export interface SessionListBaselineItem {
  sessionId: string
  running: boolean
  updatedAt: number
  parentSessionId: string | null
  origin: 'subagent' | null
}

/** Client-to-host logical stream frame (mirrors stream-protocol.ts types). */
export interface MuxOpenFrame {
  readonly type: 'open'
  readonly streamId: string
  readonly endpoint: string
  readonly payload: unknown
}
/** Client-to-host stream cancellation. */
export interface MuxCancelFrame {
  readonly type: 'cancel'
  readonly streamId: string
}

/** Host-to-client logical stream frame (validated subset). */
export type MuxServerFrame =
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }
  | { readonly type: 'end'; readonly streamId: string }
  | { readonly type: 'error'; readonly streamId: string; readonly error: { readonly code?: string; readonly message?: string } }

/** One parsed `$events` downlink frame. The waterfall `request` payload has
 *  NO field here — it is dropped at parse time, never retained. */
export type RemoteEventFrame =
  | { readonly type: 'ready'; readonly clientId: string }
  | { readonly type: 'emit'; readonly event: string; readonly args: readonly unknown[] }
  | { readonly type: 'waterfall'; readonly event: string; readonly eventId: string; readonly agentId: string }
  | { readonly type: 'cancel'; readonly eventId: string }
  | { readonly type: 'unknown' }

/** Socket readiness, mirroring ws readyState in stream terms. */
export type MuxSocketReadyState = 'connecting' | 'open' | 'closed'

/**
 * The socket seam. Production uses {@link openRemoteMuxSocket} (real `ws`);
 * tests inject a fake implementing this exact surface. `onOpen` is part of
 * the contract because `ws` throws when `send` runs while CONNECTING.
 */
export interface MuxSocket {
  readonly readyState: MuxSocketReadyState
  send(text: string): void
  close(code?: number, reason?: string): void
  onOpen(listener: () => void): () => void
  onMessage(listener: (text: string) => void): () => void
  onClose(listener: (info: { code: number; reason: string }) => void): () => void
  onError(listener: (error: Error) => void): () => void
}

/** Options of one real socket open. The cookie is fetched per connection by
 *  the caller and never cached here. */
export interface MuxSocketOpenOptions {
  cookie: string | undefined
  signal: AbortSignal
  /** Close the socket when it has not opened in time. */
  handshakeTimeoutMs?: number
}

/** Minimal structural view of a ws socket (avoids depending on ws types here). */
interface WebSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'open', listener: () => void): void
  on(event: 'message', listener: (data: unknown) => void): void
  on(event: 'close', listener: (code: number, reason: unknown) => void): void
  on(event: 'error', listener: (error: unknown) => void): void
}

/** ws URL for one host base URL. */
export function muxUrlFor(baseUrl: string): string {
  const url = new URL(REMOTE_STREAM_MUX_PATH, baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

/**
 * Open the host's /api/remote.mux socket with the real `ws` implementation
 * (lazy import: this module stays loadable without node_modules, and pure
 * tests never execute it). The caller owns the cookie and passes one per
 * connection (authCookieFor(baseUrl) — never cached across spawns).
 */
export function openRemoteMuxSocket(baseUrl: string, options: MuxSocketOpenOptions): MuxSocket {
  const { cookie, signal, handshakeTimeoutMs } = options
  const openListeners = new Set<() => void>()
  const messageListeners = new Set<(text: string) => void>()
  const closeListeners = new Set<(info: { code: number; reason: string }) => void>()
  const errorListeners = new Set<(error: Error) => void>()
  let state: MuxSocketReadyState = 'connecting'
  let ws: WebSocketLike | null = null
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null

  const clearHandshakeTimer = () => {
    if (handshakeTimer !== null) clearTimeout(handshakeTimer)
    handshakeTimer = null
  }
  const emitClose = (code: number, reason: string) => {
    if (state === 'closed') return
    state = 'closed'
    clearHandshakeTimer()
    for (const listener of [...closeListeners]) listener({ code, reason })
  }
  const emitError = (error: Error) => {
    for (const listener of [...errorListeners]) listener(error)
  }
  const onAbort = () => {
    try { ws?.close(1001, 'caller-aborted') } catch { /* best-effort */ }
    emitClose(1001, 'caller-aborted')
  }
  if (signal.aborted) queueMicrotask(onAbort)
  else signal.addEventListener('abort', onAbort, { once: true })

  void import('ws').then((wsModule) => {
    if (state === 'closed') return
    const namespace = wsModule as { default?: unknown; WebSocket?: unknown }
    const Ctor = (namespace.default ?? namespace.WebSocket) as (new (url: string, opts: Record<string, unknown>) => WebSocketLike) | undefined
    if (Ctor === undefined) {
      emitError(new Error('session-mux: ws module exposes no WebSocket constructor'))
      emitClose(1011, 'ws-unavailable')
      return
    }
    ws = new Ctor(muxUrlFor(baseUrl), cookie === undefined ? {} : { headers: { cookie } })
    ws.on('open', () => {
      if (state !== 'connecting') return
      state = 'open'
      clearHandshakeTimer()
      for (const listener of [...openListeners]) listener()
    })
    ws.on('message', (data: unknown) => {
      const text = typeof data === 'string' ? data : String(data)
      for (const listener of [...messageListeners]) listener(text)
    })
    ws.on('close', (code: unknown, reason: unknown) => {
      emitClose(typeof code === 'number' ? code : 1006, typeof reason === 'string' ? reason : String(reason ?? ''))
    })
    ws.on('error', (error: unknown) => {
      emitError(error instanceof Error ? error : new Error(String(error)))
    })
    if (typeof handshakeTimeoutMs === 'number' && handshakeTimeoutMs > 0) {
      handshakeTimer = setTimeout(() => {
        try { ws?.close() } catch { /* best-effort */ }
        emitClose(4408, 'handshake-timeout')
      }, handshakeTimeoutMs)
      handshakeTimer.unref?.()
    }
  }).catch((error: unknown) => {
    emitError(error instanceof Error ? error : new Error(String(error)))
    emitClose(1011, 'ws-unavailable')
  })

  return {
    get readyState(): MuxSocketReadyState { return state },
    send(text: string): void {
      if (ws !== null) ws.send(text)
    },
    close(code?: number, reason?: string): void {
      try { ws?.close(code, reason) } catch { /* best-effort */ }
      emitClose(code ?? 1000, reason ?? '')
    },
    onOpen(listener: () => void): () => void {
      openListeners.add(listener)
      if (state === 'open') queueMicrotask(listener)
      return () => { openListeners.delete(listener) }
    },
    onMessage(listener: (text: string) => void): () => void {
      messageListeners.add(listener)
      return () => { messageListeners.delete(listener) }
    },
    onClose(listener: (info: { code: number; reason: string }) => void): () => void {
      closeListeners.add(listener)
      return () => { closeListeners.delete(listener) }
    },
    onError(listener: (error: Error) => void): () => void {
      errorListeners.add(listener)
      return () => { errorListeners.delete(listener) }
    },
  }
}

/** Parse one host-to-client text frame; null for anything else. */
export function parseMuxServerFrame(text: string): MuxServerFrame | null {
  let decoded: unknown
  try { decoded = JSON.parse(text) } catch { return null }
  if (!isRecord(decoded)) return null
  const streamId = decoded.streamId
  if (typeof streamId !== 'string' || streamId.length === 0) return null
  if (decoded.type === 'item') {
    return Object.hasOwn(decoded, 'value')
      ? { type: 'item', streamId, value: decoded.value }
      : { type: 'item', streamId }
  }
  if (decoded.type === 'end') return { type: 'end', streamId }
  if (decoded.type === 'error') {
    const error = isRecord(decoded.error) ? decoded.error : {}
    return {
      type: 'error',
      streamId,
      error: {
        ...(typeof error.code === 'string' ? { code: error.code } : {}),
        ...(typeof error.message === 'string' ? { message: error.message } : {}),
      },
    }
  }
  return null
}

/**
 * Parse one `$events` item value. Known fields are strict, unknown fields are
 * tolerated (upstream may add fields; this deliberately departs from the
 * vendor's exactKeys parser). The waterfall `request` is
 * dropped here.
 */
export function parseRemoteEventFrame(value: unknown): RemoteEventFrame | null {
  if (!isRecord(value)) return null
  if (value.type === 'ready' && typeof value.clientId === 'string' && value.clientId.length > 0) {
    return { type: 'ready', clientId: value.clientId }
  }
  if (value.type === 'emit' && typeof value.event === 'string' && value.event.length > 0) {
    const args = Array.isArray(value.args) ? (value.args as readonly unknown[]) : []
    return { type: 'emit', event: value.event, args }
  }
  if (value.type === 'waterfall'
    && typeof value.event === 'string'
    && typeof value.eventId === 'string' && value.eventId.length > 0
    && typeof value.agentId === 'string' && value.agentId.length > 0) {
    return { type: 'waterfall', event: value.event, eventId: value.eventId, agentId: value.agentId }
  }
  if (value.type === 'cancel' && typeof value.eventId === 'string' && value.eventId.length > 0) {
    return { type: 'cancel', eventId: value.eventId }
  }
  return { type: 'unknown' }
}

/** Project one untrusted `session/list` item through the privacy whitelist. */
export function parseSessionListBaselineItem(value: unknown): SessionListBaselineItem | null {
  if (!isRecord(value)) return null
  const sessionId = value.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  const parentSessionId = typeof value.parentSessionId === 'string' && value.parentSessionId.length > 0
    ? value.parentSessionId
    : typeof value.parent === 'string' && value.parent.length > 0 ? value.parent : null
  return {
    sessionId,
    running: value.running === true,
    updatedAt: isWatermark(value.updatedAt) ? value.updatedAt : 0,
    parentSessionId,
    origin: value.origin === 'subagent' ? 'subagent' : null,
  }
}

/**
 * Parse a full `session/list` result value ({items:[...]}) through the
 * whitelist. A malformed envelope yields an empty list — a baseline of zero
 * rows is a legitimate state (no sessions), never a crash.
 */
export function parseSessionListBaselineItems(value: unknown): SessionListBaselineItem[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return []
  const items: SessionListBaselineItem[] = []
  for (const raw of value.items) {
    const item = parseSessionListBaselineItem(raw)
    if (item !== null) items.push(item)
  }
  return items
}

/** One-shot `session/follow` request for a completion edge (exactly one
 *  follow per observed true→false edge; never N resident follow streams). */
export function buildSessionFollowPayload(sessionId: string, maxMessages = FOLLOW_MAX_MESSAGES): unknown {
  return { args: { request: { address: { kind: 'session', sessionId }, maxMessages } } }
}

/** Deterministic exponential backoff delay for one reconnect attempt
 *  (attempt counts from 1; capped at `maxMs`). Pure and exported so the
 *  backoff policy is pinned without wall-clock-dependent tests. */
export function muxReconnectDelayMs(
  attempt: number,
  minMs = DEFAULT_MUX_RECONNECT_MIN_MS,
  maxMs = DEFAULT_MUX_RECONNECT_MAX_MS,
): number {
  const normalized = Number.isSafeInteger(attempt) && attempt >= 1 ? attempt : 1
  return Math.min(maxMs, minMs * 2 ** Math.min(normalized - 1, 16))
}

/** One `$events/result` delegation (the observer's ONLY way to settle a
 *  waterfall, and only under the delegate rule). */
export function buildEventResultNextPayload(clientId: string, eventId: string): unknown {
  return { args: { clientId, eventId, outcome: { kind: 'next' } } }
}

/** Client lifecycle state of the mux (policy-free: the caller maps it to the
 *  gateway's sse/poll mode). */
export type SessionMuxState = 'stopped' | 'waiting' | 'connecting' | 'live'

/** Reasons a caller may force a reconciliation/connection kick. */
export type MuxKickReason = 'host-ready' | 'resync' | 'tick' | 'frame-removed'
/** Reasons a reconciliation actually ran. */
export type MuxReconcileReason = MuxKickReason | 'connect' | 'coalesced'

/** Observable mux status: the signal surface ("ready/lastEventAt"). */
export interface SessionMuxStatus {
  state: SessionMuxState
  /** A `$events` ready frame has been received for the current socket. */
  ready: boolean
  /** Generation-scoped client id from the ready frame. */
  clientId: string | null
  /** Mux-clock ms of the last `$events` downlink frame (emit/waterfall/cancel
   *  or ready) — the event-silence input. */
  lastEventAt: number | null
  /** Downlink frames received since start() (仪表 I6：丢帧可见，不靠沉默推断). */
  eventsReceived: number
  /** Full `session/list` baselines applied since start() — every ready/reconnect
   *  reconciles, so a baseline count above 1 is the visible form of
   *  "we may have missed frames and re-read the authority". */
  baselines: number
  /** Mux-clock ms the current generation became ready. */
  lastReadyAt: number | null
  /** Cumulative reconnect attempts since start(). */
  reconnects: number
  /** Last full `session/list` baseline succeeded. */
  baselineOk: boolean
  lastBaselineAt: number | null
  heldWaterfalls: number
  /** The socket opened but no ready frame arrived inside the handshake
   *  window ⇒ the caller should degrade to poll. */
  eventsDegraded: boolean
  /** Fixed-string/error-code diagnostic only; never a payload. */
  lastError: string | null
}

/** Deps of one mux instance. Every side effect is injected. */
export interface SessionMuxDeps {
  /** Current host origin (http://127.0.0.1:<port>) or null when unavailable. */
  getBaseUrl(): string | null
  /** Per-connection cookie (authCookieFor); omit only in hostless tests. */
  authCookieFor?(baseUrl: string): string | undefined
  /** Unary carrier; defaults to the control-plane client. */
  call?: MuxUnaryCall
  /** Whether ANOTHER downstream mux client is attached (gateway-proxy
   *  getDiagnostics().activeStreams > 0). The mux's own direct socket must
   *  never count itself. */
  otherMuxClientsAttached(): boolean
  /** A full baseline was reconciled; `reason` names the trigger. */
  onBaseline?(items: readonly SessionListBaselineItem[], info: { at: number; reason: MuxReconcileReason }): void
  /** Baseline `session/list` failed: host state is unknown, never "empty". */
  onBaselineError?(error: unknown, at: number): void
  /** api-session/status emit (the running edge). */
  onStatus?(sessionId: string, running: boolean, at: number): void
  /** api-session/activity emit; `updatedAt` only when the host event carried
   *  a host-clock watermark. */
  onActivity?(sessionId: string, updatedAt: number | null, at: number): void
  /** api-session/added emit (whitelisted row). */
  onAdded?(item: SessionListBaselineItem, at: number): void
  /** api-session/removed emit. */
  onRemoved?(sessionId: string, at: number): void
  /** A request waterfall was received and is being held. */
  onPending?(sessionId: string, kind: SessionStatePendingKind, eventId: string, at: number): void
  /** A previously held waterfall was cancelled (or was a foreign waterfall we
   *  held but never classified). */
  onCancel?(eventId: string, at: number): void
  /** Status edge (observable signal). */
  onStatusChange?(status: SessionMuxStatus): void
  /** Event silence exceeded silenceTimeoutMs (only when configured). */
  onSilence?(at: number): void
  /** Operational warning: fixed message only, never a payload. */
  onWarn?(message: string): void
  /** Socket seam (default: real ws via openRemoteMuxSocket). */
  openSocket?(baseUrl: string, options: MuxSocketOpenOptions): MuxSocket
  now?(): number
  /** Waterfall hold window (default 1500ms). */
  waterfallGraceMs?: number
  reconnectMinMs?: number
  reconnectMaxMs?: number
  /** Baseline unary deadline. */
  baselineTimeoutMs?: number
  /** One-shot follow deadline. */
  followTimeoutMs?: number
  /** Ready-frame deadline after socket open (default 5s, protocol constant). */
  handshakeTimeoutMs?: number
  /** When set, event silence beyond this many ms triggers onSilence + a full
   *  resubscribe/re-baseline. Undefined ⇒ no silence policy here. */
  silenceTimeoutMs?: number
}

/** The mux handle. */
export interface SessionMux {
  start(): void
  stop(): void
  /** Host/observation edge: connect if needed, otherwise reconcile. */
  kick(reason: MuxKickReason): void
  /** One-shot session/follow for a completion edge: resolves the tail
   *  turn/end (or null) and cancels the stream immediately. */
  followTurnEndOnce(sessionId: string): Promise<SessionTurnEnd | null>
  status(): SessionMuxStatus
}

interface HeldWaterfall {
  eventId: string
  agentId: string
  event: string
  kind: SessionStatePendingKind | null
  at: number
  delegated: boolean
  attempts: number
  timer: ReturnType<typeof setTimeout> | null
}

interface PendingFollow {
  streamId: string
  last: SessionTurnEnd | null
  timer: ReturnType<typeof setTimeout> | null
  settle: (value: SessionTurnEnd | null) => void
}

const TURN_END_KINDS: ReadonlySet<string> = new Set<SessionTurnEndKind>([
  'completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted',
])
const TURN_END_CAUSES: ReadonlySet<string> = new Set<SessionTurnEndCause>([
  'user', 'parent', 'hook', 'disposed', 'legacy',
])
const APPROVAL_EVENT = 'approval/request'
const USER_QUESTIONS_EVENT = 'user-questions/request'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWatermark(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Create one session-state mux. It connects lazily (start/kick), reconciles a
 * full baseline on every ready frame, routes emit/waterfall/cancel frames and
 * holds waterfalls until the delegate rule allows a `next` answer.
 */
export function createSessionMux(deps: SessionMuxDeps): SessionMux {
  const now = deps.now ?? (() => Date.now())
  const call = deps.call ?? (controlPlaneCall as MuxUnaryCall)
  const openSocket = deps.openSocket ?? openRemoteMuxSocket
  const graceMs = deps.waterfallGraceMs ?? DEFAULT_WATERFALL_GRACE_MS
  const reconnectMinMs = deps.reconnectMinMs ?? DEFAULT_MUX_RECONNECT_MIN_MS
  const reconnectMaxMs = deps.reconnectMaxMs ?? DEFAULT_MUX_RECONNECT_MAX_MS
  const baselineTimeoutMs = deps.baselineTimeoutMs ?? DEFAULT_BASELINE_TIMEOUT_MS
  const followTimeoutMs = deps.followTimeoutMs ?? DEFAULT_FOLLOW_TIMEOUT_MS
  const handshakeTimeoutMs = deps.handshakeTimeoutMs ?? SESSION_STATE_HANDSHAKE_WINDOW_MS
  const silenceTimeoutMs = deps.silenceTimeoutMs

  let started = false
  let stopped = true
  let generation = 0
  let socket: MuxSocket | null = null
  let socketBaseUrl: string | null = null
  let abort: AbortController | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  let backoffAttempt = 0
  let baselineInFlight: Promise<void> | null = null
  let reconcileQueued = false
  let baselineQueue: string[] = []
  const heldWaterfalls = new Map<string, HeldWaterfall>()
  const follows = new Map<string, PendingFollow>()
  let followSeq = 0
  const status: SessionMuxStatus = {
    state: 'stopped',
    ready: false,
    clientId: null,
    lastEventAt: null,
    eventsReceived: 0,
    baselines: 0,
    lastReadyAt: null,
    reconnects: 0,
    baselineOk: false,
    lastBaselineAt: null,
    heldWaterfalls: 0,
    eventsDegraded: false,
    lastError: null,
  }

  const warn = (message: string) => { deps.onWarn?.(message) }
  const emitStatus = () => { deps.onStatusChange?.(statusSnapshot()) }
  const setStatus = (patch: Partial<SessionMuxStatus>) => {
    Object.assign(status, patch)
    emitStatus()
  }
  const statusSnapshot = (): SessionMuxStatus => ({ ...status })

  const clearTimer = (timer: ReturnType<typeof setTimeout> | null): null => {
    if (timer !== null) clearTimeout(timer)
    return null
  }
  const armReconnect = (): void => {
    if (stopped || !started || reconnectTimer !== null) return
    const attempt = backoffAttempt + 1
    backoffAttempt = attempt
    const delay = muxReconnectDelayMs(attempt, reconnectMinMs, reconnectMaxMs)
    status.reconnects += 1
    emitStatus()
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
    reconnectTimer.unref?.()
  }
  const dropSocket = (code: number, reason: string): void => {
    const current = socket
    socket = null
    socketBaseUrl = null
    generation += 1
    clearTimer(handshakeTimer)
    handshakeTimer = null
    clearTimer(silenceTimer)
    silenceTimer = null
    if (current !== null) {
      try { current.close(code, reason) } catch { /* best-effort */ }
    }
  }
  const connect = (): void => {
    if (stopped || !started) return
    const baseUrl = deps.getBaseUrl()
    if (baseUrl === null) {
      setStatus({ state: 'waiting', lastError: 'host-unavailable' })
      return
    }
    if (socket !== null && socketBaseUrl === baseUrl) return
    if (socket !== null) dropSocket(1000, 'base-changed')
    const connectGeneration = generation
    abort = new AbortController()
    const cookie = deps.authCookieFor?.(baseUrl)
    status.ready = false
    status.clientId = null
    status.eventsDegraded = false
    setStatus({ state: 'connecting' })
    const opened = openSocket(baseUrl, { cookie, signal: abort.signal })
    socket = opened
    socketBaseUrl = baseUrl
    opened.onOpen(() => {
      if (connectGeneration !== generation || stopped) return
      sendFrame({ type: 'open', streamId: EVENTS_STREAM_ID, endpoint: REMOTE_EVENT_STREAM_ENDPOINT, payload: REMOTE_EVENT_STREAM_PAYLOAD })
      if (handshakeTimeoutMs > 0) {
        handshakeTimer = setTimeout(() => {
          if (connectGeneration !== generation || stopped || status.ready) return
          status.eventsDegraded = true
          setStatus({ lastError: 'events-handshake-timeout' })
          warn('session-mux: $events ready frame did not arrive inside the handshake window; degrading')
          dropSocket(1000, 'handshake-timeout')
          armReconnect()
        }, handshakeTimeoutMs)
        handshakeTimer.unref?.()
      }
    })
    opened.onMessage((text) => {
      if (connectGeneration !== generation || stopped) return
      handleServerText(text)
    })
    opened.onError((error) => {
      if (connectGeneration !== generation || stopped) return
      status.lastError = errorMessage(error)
    })
    opened.onClose(() => {
      if (connectGeneration !== generation || stopped) return
      status.ready = false
      status.clientId = null
      clearTimer(silenceTimer)
      silenceTimer = null
      clearTimer(handshakeTimer)
      handshakeTimer = null
      socket = null
      socketBaseUrl = null
      generation += 1
      releaseHeldWaterfalls()
      setStatus({ state: 'connecting' })
      armReconnect()
    })
  }
  const sendFrame = (frame: MuxOpenFrame | MuxCancelFrame): void => {
    if (socket === null || socket.readyState !== 'open') return
    try { socket.send(JSON.stringify(frame)) } catch (error) { warn(`session-mux: stream send failed (${errorMessage(error)})`) }
  }
  const handleServerText = (text: string): void => {
    const frame = parseMuxServerFrame(text)
    if (frame === null) {
      warn('session-mux: ignoring an unparseable mux frame')
      return
    }
    if (frame.type === 'item') {
      if (frame.streamId === EVENTS_STREAM_ID) {
        if (baselineInFlight !== null) {
          if (baselineQueue.length >= MAX_QUEUED_EVENTS_FRAMES) {
            baselineQueue = []
            reconcileQueued = true
            warn('session-mux: baseline frame queue overflowed; re-baselining')
            return
          }
          baselineQueue.push(text)
          return
        }
        handleEventItem(frame.value)
      } else {
        handleFollowItem(frame.streamId, frame.value)
      }
      return
    }
    if (frame.type === 'end') {
      // $events 流结束当 no-op ⇒ ready 仍 true，只能等 45s 静默看门狗，
      // 该窗口内"开始并完成"的会话边沿永久丢且仪器不动。按 error 同款：标记降级 + 丢弃 + 重连。
      if (frame.streamId === EVENTS_STREAM_ID) {
        status.eventsDegraded = true
        warn('session-mux: $events stream ended by host; reconnecting (no silent no-op)')
        dropSocket(1000, 'events-end')
        armReconnect()
        return
      }
      settleFollow(frame.streamId, null)
      return
    }
    if (frame.error.code !== undefined) status.lastError = frame.error.code
    warn(`session-mux: stream ${frame.streamId} error (${frame.error.code ?? 'unknown'})`)
    if (frame.streamId === EVENTS_STREAM_ID) {
      status.eventsDegraded = true
      dropSocket(1000, 'events-error')
      armReconnect()
      return
    }
    settleFollow(frame.streamId, follows.get(frame.streamId)?.last ?? null)
  }
  const handleEventItem = (value: unknown): void => {
    const frame = parseRemoteEventFrame(value)
    if (frame === null || frame.type === 'unknown') return
    touchEvent()
    if (frame.type === 'ready') {
      if (status.ready) return
      backoffAttempt = 0
      setStatus({
        state: 'live',
        ready: true,
        clientId: frame.clientId,
        lastReadyAt: now(),
        lastEventAt: now(),
        eventsDegraded: false,
      })
      armSilenceTimer()
      tryDelegateHeld()
      reconcile('connect')
      return
    }
    if (frame.type === 'emit') {
      handleEmit(frame.event, frame.args)
      tryDelegateHeld()
      return
    }
    if (frame.type === 'waterfall') {
      holdWaterfall(frame.event, frame.eventId, frame.agentId)
      return
    }
    if (frame.type === 'cancel') {
      const held = heldWaterfalls.get(frame.eventId)
      if (held !== undefined) {
        clearTimer(held.timer)
        heldWaterfalls.delete(frame.eventId)
        status.heldWaterfalls = heldWaterfalls.size
      }
      deps.onCancel?.(frame.eventId, now())
      tryDelegateHeld()
      emitStatus()
    }
  }
  const handleEmit = (event: string, args: readonly unknown[]): void => {
    const at = now()
    if (event === 'api-session/status') {
      const [sessionId, running] = args
      if (typeof sessionId !== 'string' || typeof running !== 'boolean') return
      deps.onStatus?.(sessionId, running, at)
      return
    }
    if (event === 'api-session/activity') {
      const [sessionId, updatedAt] = args
      if (typeof sessionId !== 'string') return
      deps.onActivity?.(sessionId, isWatermark(updatedAt) ? updatedAt : null, at)
      return
    }
    if (event === 'api-session/added') {
      const item = parseSessionListBaselineItem(args[0])
      if (item !== null) deps.onAdded?.(item, at)
      return
    }
    if (event === 'api-session/removed') {
      const sessionId = args[0]
      if (typeof sessionId === 'string' && sessionId.length > 0) deps.onRemoved?.(sessionId, at)
      return
    }
    // api-session/error and every other forwarded event are dropped without
    // reading their payload (privacy: errorChain text must never be retained).
  }
  const holdWaterfall = (event: string, eventId: string, agentId: string): void => {
    if (heldWaterfalls.has(eventId)) return
    const at = now()
    const kind: SessionStatePendingKind | null =
      event === APPROVAL_EVENT ? 'approval' : event === USER_QUESTIONS_EVENT ? 'question' : null
    const held: HeldWaterfall = { eventId, agentId, event, kind, at, delegated: false, attempts: 0, timer: null }
    heldWaterfalls.set(eventId, held)
    status.heldWaterfalls = heldWaterfalls.size
    if (kind !== null) deps.onPending?.(agentId, kind, eventId, at)
    held.timer = setTimeout(() => {
      held.timer = null
      tryDelegateHeld()
    }, graceMs)
    held.timer.unref?.()
    tryDelegateHeld()
    emitStatus()
  }
  const tryDelegateHeld = (): void => {
    if (stopped || !status.ready || status.clientId === null) return
    const at = now()
    for (const held of [...heldWaterfalls.values()]) {
      if (held.delegated || held.attempts >= 2) continue
      const elapsed = at - held.at
      if (elapsed < graceMs) {
        // The grace timer is a real timer while the elapsed check uses the mux
        // clock, so its callback can observe elapsed = graceMs - 1 and reject
        // the sweep. Re-arm for the remainder: without this the rejection is
        // final until the next tick (5s default) and, when no further event
        // arrives, the held waterfall never delegates at all.
        if (held.timer === null) {
          held.timer = setTimeout(() => {
            held.timer = null
            tryDelegateHeld()
          }, Math.max(1, graceMs - elapsed + 1))
          held.timer.unref?.()
        }
        continue
      }
      // HARD RULE: never answer unless another downstream mux client is
      // attached AND the grace window has elapsed. Otherwise hold silently.
      if (!deps.otherMuxClientsAttached()) continue
      held.attempts += 1
      void call(socketBaseUrl ?? deps.getBaseUrl() ?? '', REMOTE_EVENT_RESULT_ENDPOINT,
        buildEventResultNextPayload(status.clientId, held.eventId),
        { timeoutMs: baselineTimeoutMs })
        .then(() => {
          held.delegated = true
          emitStatus()
        })
        .catch((error: unknown) => {
          warn(`session-mux: waterfall delegation failed (${errorMessage(error)})`)
          emitStatus()
        })
    }
  }
  /** Drop every held waterfall without settling anything (socket death,
   *  stop). The host removes this client from the deliveries on close, so a
   *  held frame must never survive into the next generation. A held PENDING
   *  waterfall (kind !== null) also has a session-state pending entry keyed by
   *  eventId; without this onCancel the entry stayed pending until an
   *  unrelated waterfall or observer.stop. onCancel only clears the local
   *  pending map (it never answers the host), so it is safe on every
   *  non-answering release; a foreign waterfall (kind === null) never had an
   *  entry and is deliberately not reported. */
  const releaseHeldWaterfalls = (): void => {
    const at = now()
    for (const held of heldWaterfalls.values()) {
      clearTimer(held.timer)
      if (held.kind !== null) deps.onCancel?.(held.eventId, at)
    }
    heldWaterfalls.clear()
    status.heldWaterfalls = 0
  }
  const touchEvent = (): void => {
    status.lastEventAt = now()
    status.eventsReceived += 1
    armSilenceTimer()
  }
  const armSilenceTimer = (): void => {
    clearTimer(silenceTimer)
    silenceTimer = null
    if (silenceTimeoutMs === undefined || silenceTimeoutMs <= 0 || stopped) return
    silenceTimer = setTimeout(() => {
      silenceTimer = null
      if (stopped || !status.ready) return
      deps.onSilence?.(now())
      warn('session-mux: event silence exceeded the configured window; resubscribing and re-baselining')
      dropSocket(1000, 'event-silence')
      connect()
    }, silenceTimeoutMs)
    silenceTimer.unref?.()
  }
  const reconcile = (reason: MuxReconcileReason): void => {
    if (stopped || !started) return
    if (baselineInFlight !== null) {
      reconcileQueued = true
      return
    }
    const baseUrl = deps.getBaseUrl()
    if (baseUrl === null) return
    const baselineGeneration = generation
    const signal = abort?.signal
    baselineInFlight = (async () => {
      try {
        const response = await call(baseUrl, 'session/list', SESSION_LIST_PAYLOAD, {
          signal,
          timeoutMs: baselineTimeoutMs,
          maxResponseBytes: SESSION_LIST_MAX_RESPONSE_BYTES,
        })
        if (baselineGeneration !== generation) return
        if (response.result.ok !== true) {
          throw new Error(`session/list failed: ${response.result.error?.code ?? 'unknown'}`)
        }
        const items = parseSessionListBaselineItems(response.result.value)
        deps.onBaseline?.(items, { at: now(), reason })
        setStatus({ baselineOk: true, lastBaselineAt: now(), baselines: status.baselines + 1 })
      } catch (error) {
        if (baselineGeneration !== generation) return
        status.baselineOk = false
        setStatus({ lastError: `session/list failed (${errorMessage(error)})` })
        deps.onBaselineError?.(error, now())
      }
    })().finally(() => {
      baselineInFlight = null
      const queued = baselineQueue
      baselineQueue = []
      for (const text of queued) {
        const frame = parseMuxServerFrame(text)
        if (frame !== null && frame.type === 'item' && frame.streamId === EVENTS_STREAM_ID) handleEventItem(frame.value)
      }
      if (reconcileQueued) {
        reconcileQueued = false
        reconcile('coalesced')
      }
    }).catch(() => {
      // Caller-owned callbacks must never poison the reconcile chain: the
      // failure was already surfaced through onBaselineError/onWarn.
    })
  }
  const handleFollowItem = (streamId: string, value: unknown): void => {
    const pending = follows.get(streamId)
    if (pending === undefined || !isRecord(value)) return
    if (value.type === 'error') {
      settleFollow(streamId, pending.last)
      return
    }
    if (value.type === 'snapshot' && Array.isArray(value.records)) {
      for (const record of value.records) {
        const fact = turnEndFromRecord(record)
        if (fact !== null) pending.last = fact
      }
      if (pending.last !== null) settleFollow(streamId, pending.last)
      return
    }
    if (value.type === 'event') {
      const fact = turnEndFromRecord(value)
      if (fact !== null) settleFollow(streamId, fact)
    }
  }
  const turnEndFromRecord = (record: unknown): SessionTurnEnd | null => {
    if (!isRecord(record)) return null
    const event = isRecord(record.event) ? record.event : record
    if (event.type !== 'turn/end') return null
    const data = isRecord(event.data) ? event.data : null
    const reason = data !== null && isRecord(data.reason) ? data.reason : null
    if (reason === null || typeof reason.kind !== 'string' || !TURN_END_KINDS.has(reason.kind)) return null
    const nested = isRecord(reason.reason) ? reason.reason : null
    const cause = nested !== null && typeof nested.kind === 'string' && TURN_END_CAUSES.has(nested.kind)
      ? nested.kind as SessionTurnEndCause
      : null
    return {
      kind: reason.kind as SessionTurnEndKind,
      cause,
      at: now(),
      seq: isWatermark(event.seq) ? event.seq : null,
    }
  }
  const settleFollow = (streamId: string, value: SessionTurnEnd | null): void => {
    const pending = follows.get(streamId)
    if (pending === undefined) return
    follows.delete(streamId)
    clearTimer(pending.timer)
    sendFrame({ type: 'cancel', streamId })
    pending.settle(value)
  }
  const followTurnEndOnce = (sessionId: string): Promise<SessionTurnEnd | null> => {
    if (stopped || !status.ready || socket === null || socket.readyState !== 'open') return Promise.resolve(null)
    followSeq += 1
    const streamId = `follow-${followSeq}`
    return new Promise<SessionTurnEnd | null>((resolve) => {
      const pending: PendingFollow = { streamId, last: null, timer: null, settle: resolve }
      pending.timer = setTimeout(() => {
        if (status.ready) warn('session-mux: session/follow timed out before a turn/end tail')
        settleFollow(streamId, null)
      }, followTimeoutMs)
      pending.timer.unref?.()
      follows.set(streamId, pending)
      sendFrame({ type: 'open', streamId, endpoint: 'session/follow', payload: buildSessionFollowPayload(sessionId) })
    })
  }

  return {
    start(): void {
      if (started && !stopped) return
      started = true
      stopped = false
      backoffAttempt = 0
      setStatus({ state: 'connecting' })
      connect()
    },
    stop(): void {
      if (stopped) return
      stopped = true
      started = false
      reconnectTimer = clearTimer(reconnectTimer)
      handshakeTimer = clearTimer(handshakeTimer)
      silenceTimer = clearTimer(silenceTimer)
      releaseHeldWaterfalls()
      for (const streamId of [...follows.keys()]) settleFollow(streamId, null)
      dropSocket(1000, 'stop')
      abort = null
      setStatus({ state: 'stopped', ready: false, clientId: null, heldWaterfalls: 0 })
    },
    kick(reason: MuxKickReason): void {
      if (stopped || !started) return
      if (reason === 'host-ready') {
        reconnectTimer = clearTimer(reconnectTimer)
        backoffAttempt = 0
        if (socket === null) connect()
        else if (socketBaseUrl !== deps.getBaseUrl()) {
          dropSocket(1000, 'host-ready')
          connect()
        }
      }
      if (status.ready) reconcile(reason)
      tryDelegateHeld()
    },
    followTurnEndOnce,
    status: statusSnapshot,
  }
}
