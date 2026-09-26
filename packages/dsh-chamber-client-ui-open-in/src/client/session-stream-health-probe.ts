/**
 * The imperative half of the stream-health ladder: the effects the seat may
 * perform — read the PRESENTED session's open shape and liveness, and rebuild
 * THIS session's event stream through the concrete per-session `resync()`.
 *
 * PRESENTATION (rc.2). Navigation belongs to view owners: the official
 * ui-workspace service retains the presented session with source
 * `'mainView'` and releases the reference it replaced, and the official
 * ui-session binds the centre column to the row whose `retainedBy.mainView`
 * count is positive. The chamber drives that same retention through
 * `uiWorkspace.openSession()` (the shell's dispatch and the sidebar's
 * boot-time arm), so "is this target the presented session?" is answered from
 * the official retain result in the sessions list snapshot — never from a
 * chamber-side `current` mirror.
 *
 * `resync()` has ONE entry point: the ladder's automatic arm (the manual
 * control was retired), which may fire only on POSITIVE evidence that no open
 * is in flight — an in-flight open is a slow Host being waited on, never
 * interrupted.
 *
 * The page stream-forensics channel (`dsh-chamber:stream-forensics`) is read
 * here too: a terminal opening fact (`opening-budget-exhausted` /
 * `opening-orphaned`) is retained in a page-level ledger and surfaced by the
 * seats, so an opening that died while its promise stayed pending becomes
 * visible instead of parking the page at "loading history".
 * Unknown kinds, drifted shapes and an absent channel change nothing.
 *
 * The vendor face is read through a loose structural slice (no d.ts tree is
 * published for these runtime objects) and EVERY access is guarded here: an
 * unreadable or drifting face yields "no action", never a throw into React.
 * Failures stay silent (this package's ui-lock forbids console in `src/client`),
 * and a `resync()` promise is settled with a no-op catch.
 */
import { sessionOpenPromiseInFlight } from '@dsh-chamber/dsh-chamber-client-core'
import { OPENING_TIMEOUT_LADDER_MS } from '@dsh-chamber/dsh-stream-state'

/**
 * How long a terminal fact may still describe the stall the page is looking at.
 * A ladder must be spent before one is published, so a fact older than the whole
 * ladder belongs to an episode the user has already left (or one that recovered
 * without an `opening-accepted` retirement) and must not fail a fresh loading seat.
 * Derived from the single-sourced ladder table, never a second magic number.
 */
const OPENING_FAILURE_FRESH_MS = OPENING_TIMEOUT_LADDER_MS.reduce((sum, ms) => sum + ms, 0)

/** One session row slice of the official list snapshot the probe reads. */
export interface SessionRowLoose {
  /** Local ownership counts, including the main view's reference count. */
  readonly retainedBy?: Readonly<Record<string, number>> | undefined
}

/** Structural slice of the official `ISessions` face this module calls. */
export interface SessionsLoose {
  /** The official list store: the presented session is the mainView-retained row. */
  readonly list: {
    getSnapshot(): { readonly byId?: Readonly<Record<string, SessionRowLoose>> | undefined }
  }
}

/**
 * Structural slice of the concrete `Session` face (`resync()` is public there,
 * not on the `ISession` contract). Optional on purpose: a build that predates
 * the method must degrade to "no lever", never throw.
 */
export interface SessionResyncLoose {
  /** Dispose the session's event stream and re-open it. */
  resync?(): unknown
  /**
   * The concrete in-flight-open promise: `null`/`undefined` while nothing is
   * pending, the pending promise while `doOpen()` runs. Read ONLY through
   * {@link sessionOpenInFlight}, which requires the member to exist.
   */
  openPromise?: unknown
  getSnapshot?(): { readonly openState?: unknown }
}

/**
 * Structural slice of the concrete sessions service members that reach a
 * `Session`. rc.2's contract entry is `binding(id)`: it returns the retained
 * `SessionBinding`, whose `.session` is the concrete face. Optional for the
 * same fail-closed reason as `resync`.
 */
export interface SessionsConcreteLoose extends SessionsLoose {
  binding?(sessionId: string): { readonly session?: SessionResyncLoose | null | undefined } | undefined
}

/**
 * Is this id the session the official main view presents? The row's
 * `retainedBy.mainView` count is the fact ui-session binds the centre column
 * from, so a zero/absent count means the target is not on stage (a stale React
 * effect, an address the view never retained) and its scope must not be rebuilt.
 */
function isMainViewRetained(sessions: SessionsLoose, sessionId: string): boolean {
  try {
    const count = sessions.list.getSnapshot().byId?.[sessionId]?.retainedBy?.mainView
    return typeof count === 'number' && count > 0
  } catch {
    return false
  }
}

/**
 * The concrete resync face of the CURRENT presented target, or undefined when
 * this build/service exposes none. Listedness is NOT required — the mainView
 * retention is the whole presentation fact, so an address-only subagent
 * selection is reachable exactly like a catalogued row.
 * Every access is guarded; any drift yields undefined, read as "no lever".
 */
function readCurrentSession(
  sessions: SessionsLoose | undefined,
  sessionId: string,
): SessionResyncLoose | undefined {
  if (sessions === undefined) return undefined
  try {
    if (!isMainViewRetained(sessions, sessionId)) return undefined
    const concrete = sessions as SessionsConcreteLoose
    // ONE accessor: the rc.2 contract entry. A throwing accessor is a drift —
    // fail closed, never a fallback to another member.
    const binding = concrete.binding
    if (typeof binding !== 'function') return undefined
    const session = binding.call(concrete, sessionId)?.session
    if (session === null || session === undefined || typeof session !== 'object') return undefined
    return session
  } catch {
    return undefined
  }
}

/**
 * The concrete Session face of the CURRENT presented session, or undefined
 * (guarded). The property RESYNC READ can throw on a hostile proxy, so the
 * capability check lives inside the guard too.
 */
function readSessionResyncFace(
  sessions: SessionsLoose | undefined,
  sessionId: string,
): SessionResyncLoose | undefined {
  const session = readCurrentSession(sessions, sessionId)
  if (session === undefined) return undefined
  try {
    if (typeof session.resync !== 'function') return undefined
    return session
  } catch {
    return undefined
  }
}

/**
 * Is the official open still in flight for the CURRENT presented session?
 * `true` = an open is pending (a slow Host may legitimately be working; nothing
 * automatic may touch it); `false` = `loading` with NOTHING pending (the pinned
 * `doOpen()` can settle there with no retry trigger, and re-issuing is then the
 * cure and free); `undefined` = this face cannot say — fail closed exactly like
 * a missing capability. The member MUST exist on the object for `false`: a
 * build that renamed or removed `openPromise` degrades to "unknown", never to
 * "nothing pending" (which would let the ladder destroy an in-flight open).
 */
export function sessionOpenInFlight(sessions: SessionsLoose | undefined, sessionId: string): boolean | undefined {
  const session = readCurrentSession(sessions, sessionId)
  if (session === undefined) return undefined
  // The tri-state read is single-sourced in client-core; the mobile ladder reads
  // the same function, so the fail-closed rules cannot drift between tiers.
  return sessionOpenPromiseInFlight(session)
}

/** Read the concrete current session's opening result for a page-level seat. */
export function sessionOpenState(
  sessions: SessionsLoose | undefined, sessionId: string,
): 'cold' | 'loading' | 'open' | 'error' | undefined {
  const session = readCurrentSession(sessions, sessionId)
  try {
    const value = session?.getSnapshot?.().openState
    return value === 'cold' || value === 'loading' || value === 'open' || value === 'error'
      ? value : undefined
  } catch { return undefined }
}

/**
 * Is the concrete per-session stream rebuild reachable for the presented
 * target, and is that target on stage at all? This is the ONE header-arm
 * capability read: the ladder's `resyncAvailable` observation and the page's
 * `healRoute` evidence both come from here, so a build without the concrete
 * method (or a target the main view does not retain) never arms the automatic
 * heal and never looks healable to the page.
 */
export function hasSessionStreamResync(sessions: SessionsLoose | undefined, targetId: string): boolean {
  return readSessionResyncFace(sessions, targetId) !== undefined
}

/**
 * Page-level terminal-opening evidence, read back from the in-repo api-gateway
 * fork's stream-forensics channel (design 14 §D4). The fork publishes one
 * bounded fact per lifecycle transition. ONLY the ladder's end is a verdict:
 * `opening-budget-exhausted` (always, at the cap) and `opening-orphaned` (the
 * cap was reached with frames delivered but never accepted) say the logical
 * stream's opening will never settle. A widening miss is a DIAGNOSTIC (`opening-miss`), and a terminal
 * `opening-timeout` (no frame ever arrived) ships ALONGSIDE the always-published
 * `opening-budget-exhausted`, so this ledger needs only the budget fact;
 * both are deliberately ignored here - a healthy-but-slow Host on rung 1 of 5
 * must never be shown as failed. `opening-accepted` retires the evidence for
 * the opening it belongs to. Facts carry no payload, prompt or credential.
 *
 * TOLERANCE: unknown kinds and drifted shapes are IGNORED. A fact names the
 * instance it happened in and, when the publisher can attribute one, the
 * session; an unattributed fact counts for whichever session is presented and
 * loading, which is the only page-visible candidate. A page whose bundle
 * predates these kinds (or that carries no plugin publishing them) leaves the
 * ledger empty, and every reader then behaves exactly as before.
 */

/** Window event the in-repo api-gateway fork publishes one bounded stream fact on. */
const STREAM_FORENSICS_EVENT = 'dsh-chamber:stream-forensics'

/** The two terminal opening outcomes a stream fact can carry. */
export type SessionOpeningFailure = 'budget-exhausted' | 'orphaned'

/** One parsed opening outcome; `accepted` retires a recorded failure. */
export interface SessionOpeningOutcome {
  readonly outcome: 'accepted' | SessionOpeningFailure
  readonly instanceId: string | undefined
  /** The session the publisher attributed the opening to, when it could. */
  readonly sessionId: string | undefined
  /** The fact's own publish time (0 when the channel carried none). */
  readonly at: number
}

/**
 * Parse one `dsh-chamber:stream-forensics` detail. Unknown kinds, absent
 * fields and hostile shapes yield null — the channel is data, never a command.
 */
export function parseSessionOpeningOutcome(detail: unknown): SessionOpeningOutcome | null {
  if (detail === null || typeof detail !== 'object') return null
  const record = detail as {
    readonly kind?: unknown
    readonly instanceId?: unknown
    readonly sessionId?: unknown
    readonly at?: unknown
  }
  const outcome = record.kind === 'opening-accepted'
    ? 'accepted'
    : record.kind === 'opening-budget-exhausted'
      ? 'budget-exhausted'
      : record.kind === 'opening-orphaned'
        ? 'orphaned'
        : null
  if (outcome === null) return null
  return {
    outcome,
    instanceId: typeof record.instanceId === 'string' ? record.instanceId : undefined,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
    at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0,
  }
}

/** One retained terminal-opening fact. */
export interface SessionOpeningFailureFact {
  readonly instanceId: string | undefined
  readonly sessionId: string | undefined
  readonly failure: SessionOpeningFailure
  /** The fact's own publish time (0 when the channel carried none). */
  readonly at: number
}

/** Reader face every seat consumes; the store itself is page-global. */
export interface SessionOpeningFailureLedger {
  /** Record one page fact; unknown kinds/shapes are ignored, never thrown. */
  record(detail: unknown): void
  /**
   * The latest FRESH failure for this instance/session (an exact session match
   * first, then an unattributed instance-level fact), or undefined = no evidence.
   * `now` is the reader's clock; a fact older than the whole opening ladder is
   * stale evidence about an episode that is over.
   */
  failureFor(instanceId: string | undefined, sessionId: string, now?: number): SessionOpeningFailureFact | undefined
  /** Wake-up for fact arrivals, so a visible seat re-plans immediately. */
  subscribe(listener: () => void): () => void
}

/** Memory bound: sessions whose opening failed since this page loaded. */
const OPENING_FAILURE_MEMORY = 64

interface OpeningFailureState {
  /** Keyed `instance\0session`; a fact that named its session. */
  readonly bySession: Map<string, SessionOpeningFailureFact>
  /** Keyed `instance`; an unattributed fact covers every session of it. */
  readonly byInstance: Map<string, SessionOpeningFailureFact>
  readonly listeners: Set<() => void>
  listening: boolean
}

const OPENING_FAILURE_KEY = Symbol.for('dsh-chamber:session-opening-failures')
const openingFailureRealm = globalThis as unknown as Record<symbol, OpeningFailureState | undefined>

function openingFailureState(): OpeningFailureState {
  const existing = openingFailureRealm[OPENING_FAILURE_KEY]
  if (existing !== undefined) return existing
  const created: OpeningFailureState = {
    bySession: new Map(),
    byInstance: new Map(),
    listeners: new Set(),
    listening: false,
  }
  openingFailureRealm[OPENING_FAILURE_KEY] = created
  return created
}

function openingFailureKey(instanceId: string | undefined, sessionId: string): string {
  return (instanceId ?? '') + '\u0000' + sessionId
}

/** Insert with recency ordering and the memory bound (oldest-first eviction). */
function retainOpeningFailure(
  map: Map<string, SessionOpeningFailureFact>,
  key: string,
  fact: SessionOpeningFailureFact,
): void {
  map.delete(key)
  map.set(key, fact)
  if (map.size <= OPENING_FAILURE_MEMORY) return
  const oldest = map.keys().next().value
  if (oldest !== undefined) map.delete(oldest)
}

/** One listener's failure must never break the page (or the other listeners). */
function notifyOpeningFailure(state: OpeningFailureState): void {
  for (const listener of [...state.listeners]) {
    try { listener() } catch { /* swallowed by contract */ }
  }
}

/**
 * The page's ONE opening-failure ledger. The renderer shell and the host-loaded
 * client plugin bundle this module separately, so the store and its forensics
 * listener are shared through the page realm, never module identity. Without a
 * DOM (tests) the in-memory face stays and callers drive `record` directly.
 */
export function sessionOpeningFailureLedger(): SessionOpeningFailureLedger {
  const state = openingFailureState()
  const ledger: SessionOpeningFailureLedger = {
    record(detail) {
      const parsed = parseSessionOpeningOutcome(detail)
      if (parsed === null) return
      if (parsed.outcome === 'accepted') {
        // Retire what this accepted opening proves: its own session's fact, and the
        // instance-level fallback - an accept proves the carrier answers for that
        // INSTANCE now, and the fallback was only ever a coarse guess at which
        // session an unattributed fact belonged to (a wrong guess must not outlive
        // the evidence that contradicts it).
        if (parsed.sessionId !== undefined) {
          state.bySession.delete(openingFailureKey(parsed.instanceId, parsed.sessionId))
        }
        state.byInstance.delete(parsed.instanceId ?? '')
        notifyOpeningFailure(state)
        return
      }
      const fact: SessionOpeningFailureFact = {
        instanceId: parsed.instanceId,
        sessionId: parsed.sessionId,
        failure: parsed.outcome,
        at: parsed.at,
      }
      if (parsed.sessionId === undefined) {
        retainOpeningFailure(state.byInstance, parsed.instanceId ?? '', fact)
      } else {
        retainOpeningFailure(state.bySession, openingFailureKey(parsed.instanceId, parsed.sessionId), fact)
      }
      notifyOpeningFailure(state)
    },
    failureFor(instanceId, sessionId, now) {
      const clock = now ?? Date.now()
      // A fact that carries no time (an older/channel-lite bundle) is taken at face
      // value, exactly as before this window existed; a stamped one expires with the
      // ladder that produced it.
      const fresh = (fact: SessionOpeningFailureFact | undefined): SessionOpeningFailureFact | undefined =>
        fact === undefined || fact.at === 0 || clock - fact.at <= OPENING_FAILURE_FRESH_MS ? fact : undefined
      return fresh(state.bySession.get(openingFailureKey(instanceId, sessionId)))
        ?? fresh(state.byInstance.get(instanceId ?? ''))
    },
    subscribe(listener) {
      state.listeners.add(listener)
      return () => { state.listeners.delete(listener) }
    },
  }
  if (!state.listening && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    state.listening = true
    window.addEventListener(STREAM_FORENSICS_EVENT, (event: Event): void => {
      try {
        ledger.record((event as CustomEvent<unknown>).detail)
      } catch { /* a page listener must never break the lifecycle it observes */ }
    })
  }
  return ledger
}

// Session.resync() waits for the old stream's dispose before starting open().
// During that wait openPromise is still null, so it cannot guard a second
// rebuild from the page or the conversation header.
// The renderer shell and the host-loaded client plugin can bundle this module
// separately. Share the guard through their one page realm, not module identity.
const RESYNC_GUARD_KEY = Symbol.for('dsh-chamber:session-resync-in-flight')
const resyncGuardRealm = globalThis as unknown as Record<symbol, unknown>
const resyncingSessions: WeakSet<SessionResyncLoose> = resyncGuardRealm[RESYNC_GUARD_KEY] instanceof WeakSet
  ? resyncGuardRealm[RESYNC_GUARD_KEY] as WeakSet<SessionResyncLoose>
  : new WeakSet<SessionResyncLoose>()
resyncGuardRealm[RESYNC_GUARD_KEY] = resyncingSessions

export function sessionStreamResyncInFlight(sessions: SessionsLoose | undefined, targetId: string): boolean {
  const session = readCurrentSession(sessions, targetId)
  return session !== undefined && resyncingSessions.has(session)
}

/**
 * Rebuild one session's stream through the concrete vendor method. Called from
 * the error arm's automatic heal only (the manual control was retired); the seat
 * accounts each attempt against the session ledger. The async `resync()` may
 * reject and
 * is settled with a no-op catch — the chip is a status surface, not an error
 * channel, and this file never touches the transport.
 */
export function resyncSessionStream(sessions: SessionsLoose | undefined, targetId: string): boolean {
  let session: SessionResyncLoose | undefined
  try {
    session = readSessionResyncFace(sessions, targetId)
    if (session === undefined) return false
    // Capture the method after the check: narrowing a property does not survive
    // aliasing, and the receiver must stay the session face.
    const resync = session.resync
    if (typeof resync !== 'function') return false
    const face = session
    if (resyncingSessions.has(face)) return true
    resyncingSessions.add(face)
    const pending = resync.call(face)
    void Promise.resolve(pending).then(
      () => { resyncingSessions.delete(face) },
      () => { resyncingSessions.delete(face) },
    )
    return true
  } catch {
    if (session !== undefined) resyncingSessions.delete(session)
    // Fail closed, and silently: see the module header (ui-lock).
    return false
  }
}

/**
 * The durable-shape read shared with the mobile stall observer: is a
 * conversation actually presented on a visible page? `[data-chat-flow]` is the
 * official ChatView column; without it no chat surface is on screen and every
 * clock must stay at zero. KNOWN APPROXIMATION: document existence is not
 * "visible to the user" and the query is document-wide, but both only make
 * `presented` MORE permissive — a false negative would silently disable the
 * recovery arm, while a false positive is bounded.
 */
export function isConversationSurfacePresented(target: {
  readonly visibilityState?: string | undefined
  querySelector(selector: string): unknown
} | null | undefined): boolean {
  if (target === null || target === undefined) return false
  if (target.visibilityState === 'hidden') return false
  return target.querySelector('[data-chat-flow]') !== null
}
