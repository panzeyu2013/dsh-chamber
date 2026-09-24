/**
 * The imperative half of the stream-health ladder: the effects the seat may
 * perform — read the presented shape and the session's open LIVENESS, move the
 * stage across a neighbor and back (an `'error'` session), and rebuild THIS
 * session's event stream through the concrete per-session `resync()`.
 *
 * `resync()` has two entry points: the user's click (available while the stall
 * holds) and the ladder's automatic arm, which may fire only on POSITIVE
 * evidence that no open is in flight — an in-flight open is a slow Host being
 * waited on, never interrupted.
 *
 * The vendor face is read through a loose structural slice (no d.ts tree is
 * published for these runtime objects) and EVERY access is guarded here: an
 * unreadable or drifting face yields "no action", never a throw into React.
 * Failures stay silent (this package's ui-lock forbids console in `src/client`),
 * and a `resync()` promise is settled with a no-op catch.
 */
import { sessionOpenPromiseInFlight } from '@dsh-chamber/dsh-chamber-client-core'

/** Structural slice of the official `ISessions` face this module calls. */
export interface SessionsLoose {
  /** The official list store: ids AND the current selection are the lever. */
  readonly list: { getSnapshot(): { readonly ids: readonly string[]; readonly current?: string | undefined } }
  /** Stage the given session (`ISessions.open`). */
  open(sessionId: string): void
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
 * `Session`. `resolve(id)` is the framework accessor the stage follower calls
 * on every stage move. Optional for the same fail-closed reason as `resync`.
 */
export interface SessionsConcreteLoose extends SessionsLoose {
  resolve?(sessionId: string): { readonly session?: SessionResyncLoose | null | undefined } | undefined
}

/**
 * Pick the session whose stage visit carries a re-open of `targetId`: a
 * previously presented id when still listed (its scope is materialized, so the
 * detour costs a state read), else any other listed id. Never returns `targetId`.
 */
export function pickHealNeighbor(
  ids: readonly string[],
  targetId: string,
  preferredId?: string,
): string | undefined {
  if (preferredId !== undefined && preferredId !== targetId && ids.includes(preferredId)) return preferredId
  return ids.find(id => id !== targetId)
}

/**
 * Is the stage move usable for this target at all? It needs all three: the
 * target must still be the CURRENT session, must be LISTED, and another listed
 * session must exist to carry the detour. Without this gate an address-only
 * target looks like it has a neighbour even though the executed move refuses it
 * — spending the whole heal ledger on guaranteed-refused attempts.
 */
export function hasHealRoute(sessions: SessionsLoose | undefined, targetId: string): boolean {
  if (sessions === undefined) return false
  try {
    const snapshot = sessions.list.getSnapshot()
    if (snapshot.current !== targetId || !snapshot.ids.includes(targetId)) return false
    return hasHealNeighbor(snapshot.ids, targetId)
  } catch {
    return false
  }
}

/** True when some OTHER listed session can carry the stage move. */
export function hasHealNeighbor(ids: readonly string[], targetId: string): boolean {
  return pickHealNeighbor(ids, targetId) !== undefined
}

/**
 * Re-open one `'error'` session by moving the stage across a neighbor and back,
 * both calls in the SAME synchronous tick (list notifications flush
 * synchronously, React 19 commits as a microtask, so the commit sees only the
 * final binding — no visible detour). NO `await` may ever sit between them.
 *
 * Refuses unless the target is the CURRENT, LISTED session right now: an
 * address-only subagent session would lose eligibility and have its scope
 * pruned, a session that left the list would strand the user on the NEIGHBOR
 * (the first leg cannot be undone), and a stale passive effect must not drag
 * the stage back. `clear()` does not move the stage and a generation reconnect
 * keeps every ctx mounted, so neither is a lever either.
 */
export function healSessionStream(
  sessions: SessionsLoose | undefined,
  targetId: string,
  preferredId?: string,
): boolean {
  if (sessions === undefined) return false
  try {
    const snapshot = sessions.list.getSnapshot()
    const ids = snapshot.ids
    if (snapshot.current !== targetId || !ids.includes(targetId)) return false
    const neighbor = pickHealNeighbor(ids, targetId, preferredId)
    if (neighbor === undefined) return false
    sessions.open(neighbor)
    sessions.open(targetId)
    return true
  } catch {
    // Fail closed, and silently: this package's client sources are under a
    // source lock that forbids console beyond nothing at all (the ui-lock
    // test), and a heal must never surface as an app error of its own.
    return false
  }
}

/**
 * The concrete resync face of the CURRENT target, or undefined when this
 * build/service exposes none. Listedness is NOT required — that is what makes
 * address-only subagent selections reachable (current, absent from `ids`).
 * Every access is guarded; any drift yields undefined, read as "no lever".
 */
function readCurrentSession(
  sessions: SessionsLoose | undefined,
  sessionId: string,
): SessionResyncLoose | undefined {
  if (sessions === undefined) return undefined
  try {
    const concrete = sessions as SessionsConcreteLoose
    if (typeof concrete.resolve !== 'function') return undefined
    const snapshot = sessions.list.getSnapshot()
    if (snapshot.current !== sessionId) return undefined
    const session = concrete.resolve(sessionId)?.session
    if (session === null || session === undefined || typeof session !== 'object') return undefined
    return session
  } catch {
    return undefined
  }
}

/**
 * The concrete Session face of the CURRENT session, or undefined (guarded). The
 * property RESYNC READ can throw on a hostile proxy, so the capability check
 * lives inside the guard too.
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
 * Is the official open still in flight for the CURRENT session? `true` = an
 * open is pending (a slow Host may legitimately be working; nothing automatic
 * may touch it); `false` = `loading` with NOTHING pending (the pinned `doOpen()`
 * can settle there with no retry trigger, and re-issuing is then the cure and
 * free); `undefined` = this face cannot say — fail closed exactly like a missing
 * capability. The member MUST exist on the object for `false`: a build that
 * renamed or removed `openPromise` degrades to "unknown", never to "nothing
 * pending" (which would let the ladder destroy an in-flight open).
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
 * Does this build expose the per-session stream rebuild for the target? The
 * ladder's `resyncAvailable` observation comes from here, so a build without
 * the concrete method never arms (or renders) the control.
 */
export function hasSessionStreamResync(sessions: SessionsLoose | undefined, targetId: string): boolean {
  return readSessionResyncFace(sessions, targetId) !== undefined
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
 * Rebuild one session’s stream through the concrete vendor method. Called from
 * the automatic `'auto-resync'` arm (only after the plan proved no open is in
 * flight) and from the user's control; the seat accounts each attempt against
 * the session ledger. The async `resync()` may reject and is settled with a
 * no-op catch — the chip is a status surface, not an error channel, and this
 * file never touches the transport.
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
    // Fail closed, and silently: see the module header (ui-lock) and the
    // stage-move heal it mirrors.
    return false
  }
}

/** How many recently presented sessions a seat remembers for the heal detour. */
export const PRESENTED_MEMORY = 4

/** Move one presented session to the front of the recency list (immutable). */
export function rememberPresented(
  presented: readonly string[],
  sessionId: string,
  limit: number = PRESENTED_MEMORY,
): string[] {
  return [sessionId, ...presented.filter(id => id !== sessionId)].slice(0, limit)
}

/**
 * The cheapest detour target: the most recently presented session other than
 * the one being healed (its scope is normally still materialized, so the move
 * costs a state read instead of a fresh window load).
 */
export function previousPresented(presented: readonly string[], targetId: string): string | undefined {
  return presented.find(id => id !== targetId)
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
