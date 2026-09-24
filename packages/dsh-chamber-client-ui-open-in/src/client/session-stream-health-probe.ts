/**
 * The imperative half of the session stream-health ladder: the effects the seat
 * is allowed to perform — read the presented shape and the session's open
 * LIVENESS, move the stage across a neighbor and back (an `'error'` session),
 * and rebuild THIS session's event stream through the concrete per-session
 * `resync()`.
 *
 * `resync()` has two entry points: the user's own click (available while the
 * stall holds) and the renderer's page-level automatic arm, which may only
 * fire on POSITIVE evidence that no open is in flight (see
 * {@link sessionOpenInFlight}) — an in-flight open is a slow Host being waited on
 * and is never interrupted.
 *
 * The vendor face is reached through the loose structural slice the chamber's
 * client plugins already use for per-entry facts (open-in's `chamberInstanceId`
 * seam and the sidebar's session face): the workspace symlink publishes no d.ts
 * tree for these runtime objects, so typing against the slice that is actually
 * called is the honest option, and EVERY access is guarded here rather than at
 * each call site (fail-closed: an unreadable or drifting face yields "no
 * action", never a throw into React).
 *
 * WHY THE STAGE MOVE AND NOTHING ELSE. `ISessions.open(id)` routes through
 * `manager.select()` → `service.followCurrent()`, which returns immediately
 * unless `list.current !== watched`; the only re-open trigger the chamber can
 * reach is therefore a real stage change. `clear()` does NOT move the stage
 * (it blanks `current`, which the same guard treats as "hold"), and a
 * connection-generation reconnect deliberately keeps every ctx object mounted,
 * so neither is a lever here. Both are pinned by tests, so a future upstream
 * change to that guard fails loudly instead of silently disabling the heal.
 *
 * THE PRECONDITION. The detour is only safe while the target is STILL the
 * current, listed session, so every heal checks that first:
 *
 *  - an address-only subagent session (current, but absent from `ids`) would
 *    lose eligibility the moment the stage moves, and `pruneScopes()` would then
 *    tear down its scope — its Session, its input shell and any attached drafts —
 *    while the return leg could be blocked by the same `byId[current]` guard;
 *  - a session that left the list (a masked gap) makes `open(target)` throw,
 *    which would strand the user on the NEIGHBOR (the first leg cannot be
 *    undone);
 *  - an already-queued passive effect can run one commit after the user
 *    switched sessions, and must not drag the stage back to the session the
 *    chip last observed.
 *
 * All three collapse into the same guard, and all three degrade to the notice
 * arm (the reload action), which is the honest outcome for them.
 *
 * ONE SYNCHRONOUS BLOCK. The two `open()` calls are issued in the same tick on
 * purpose: the framework's list notifications flush synchronously, React 19
 * schedules the re-render as a microtask, so the commit sees only the final
 * binding (no visible detour). No `await` may ever be inserted between them.
 *
 * THE PER-SESSION RESYNC. The pinned controller's concrete `Session`
 * object exposes an `async resync()` that disposes the current event stream and
 * re-opens it — the exact lever a parked `'loading'` open needs, and the one
 * the stage move cannot supply for it. It is NOT on the `ISession` contract, so
 * it is reached here the same way the stage move reaches its concrete members:
 * a loose structural slice plus a runtime capability guard. The concrete
 * `ClientSessions` reaches a `Session` through `resolve(id)` — the framework's
 * own scope accessor, which `followCurrent()` calls on every stage move and
 * whose record carries the `Session` instance — so that is the read used. Only
 * the CURRENT half of the stage move's precondition applies here: a window must
 * never be rebuilt behind the user's back for a session that is not the one on
 * stage, but LISTEDNESS is not required because `resync()` is a direct
 * per-session call — and requiring it would make the control unreachable for
 * exactly the address-only subagent selections the stage move must refuse
 * (current, absent from `ids`; the vendor accessor resolves those through the
 * retained subagent address and fails closed for everything else).
 *
 * Both resync entry points fail closed: a missing `resolve`, a missing
 * `resync`, a wrong-shaped record, or a throw from either is "no lever" —
 * never an exception into React, and never a console line (this package's
 * ui-lock forbids `console.*` in `src/client/**`). The returned promise of a
 * successful call is settled with a no-op catch for the same reason: the chip
 * is a status surface, not an error channel.
 *
 * A `RemoteStreamCarrierError` that reaches the domain is the official
 * frontend's own retry policy (see the module header of `session-stream-health.ts`);
 * this file only recovers the view, it never touches the transport.
 */

/** Structural slice of the official `ISessions` face this module calls. */
export interface SessionsLoose {
  /** The official list store: ids AND the current selection are the lever. */
  readonly list: { getSnapshot(): { readonly ids: readonly string[]; readonly current?: string | undefined } }
  /** Stage the given session (`ISessions.open`). */
  open(sessionId: string): void
}

/**
 * Structural slice of the official concrete `Session` face this module calls
 * (`Session.resync()` is public on the concrete object, not on the `ISession`
 * contract). Optional on purpose: a controller build that predates the method
 * must degrade to "no lever", never throw.
 */
export interface SessionResyncLoose {
  /** Dispose the session's event stream and re-open it. */
  resync?(): unknown
  /**
   * The concrete in-flight-open promise: `null`/`undefined` while nothing is
   * pending, the pending promise while `doOpen()` runs. Read ONLY through
   * {@link sessionOpenInFlight}, which requires the member to exist so a renamed
   * field degrades to "unknown" rather than to "nothing pending".
   */
  openPromise?: unknown
  getSnapshot?(): { readonly openState?: unknown }
}

/**
 * Structural slice of the concrete sessions service members that reach a
 * `Session`. `resolve(id)` is the framework's own scope accessor (the stage
 * follower calls it on every stage move), so it is the least intrusive read of
 * the per-session face. Optional for the same fail-closed reason as
 * {@link SessionResyncLoose.resync}.
 */
export interface SessionsConcreteLoose extends SessionsLoose {
  resolve?(sessionId: string): { readonly session?: SessionResyncLoose | null | undefined } | undefined
}

/**
 * Pick the session whose stage visit carries a re-open of `targetId`.
 *
 * A previously presented id is preferred when it is still listed (its scope is
 * already materialized, so the detour costs a state read rather than a fresh
 * window load); otherwise any other listed id is used, which materializes one
 * extra scope for the duration of the detour. Never returns `targetId`.
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
 * Is the stage move usable for this target at all?
 *
 * The move needs all three: the target must still be the CURRENT session, must be
 * LISTED (the seat's re-open validates it), and another listed session must exist
 * to carry the detour. Without this gate an address-only target looks like it has
 * a neighbour (the list contains other sessions) even though the executed move
 * refuses it — spending the whole heal ledger on guaranteed-refused attempts.
 *
 * @param sessions - the instance's session face (loose slice), if any.
 * @param targetId - the session whose stage the detour would move.
 * @returns true only when `healSessionStream` can actually run for the target.
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
 * both calls in the SAME synchronous tick.
 *
 * Refuses unless the target is the CURRENT, LISTED session right now (see the
 * module header): the lever is only reversible under that precondition, and the
 * caller's own state may be one commit stale.
 *
 * @param sessions - the instance's session face (loose slice).
 * @param targetId - the session whose journal must be rebuilt.
 * @param preferredId - previously presented id to reuse, when known.
 * @returns true only when both stage moves were issued.
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
 * The concrete resync face of the CURRENT, LISTED target, or undefined when
 * this build/service does not expose one.
 *
 * The precondition is "still the CURRENT session" (see the module header): the
 * chip's own session is the one on stage, and rebuilding a window for anything
 * else would touch a surface the user is not looking at. Listedness is NOT
 * required — that is what makes address-only subagent selections reachable
 * (their own header calls out current-but-unlisted as the case the stage move
 * must refuse). Every access is guarded; any drift yields undefined, which
 * callers read as "no lever".
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
 * The concrete Session face of the CURRENT session, or undefined (guarded).
 * The property RESYNC READ can throw on a hostile proxy, so the capability check
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
 * Is the official open still in flight for the CURRENT session?
 *
 * - `true` — an open is pending (`openPromise` carries it): a slow Host may be
 *   legitimately working, so nothing automatic may touch it;
 * - `false` — the session reports `loading` with NOTHING pending: the pinned
 *   `doOpen()` can settle there with no retry trigger at all, and re-issuing is
 *   both the cure and free (nothing is being interrupted);
 * - `undefined` — this build's face cannot say (no concrete slice, a missing
 *   member, a hostile accessor): fail closed, exactly like a missing capability.
 *
 * The member MUST exist on the object for `false` to be reported: a build that
 * renamed or removed `openPromise` degrades to "unknown", never to "nothing is
 * pending" — the latter would let the ladder destroy an in-flight open.
 *
 * @param sessions - the instance's session face (loose slice), if any.
 * @param sessionId - the session whose open liveness is read.
 * @returns the tri-state liveness, never a throw.
 */
export function sessionOpenInFlight(sessions: SessionsLoose | undefined, sessionId: string): boolean | undefined {
  const session = readCurrentSession(sessions, sessionId)
  if (session === undefined) return undefined
  try {
    if (!Object.hasOwn(session, 'openPromise')) return undefined
    const pending = session.openPromise
    // ONLY an exactly-null own member is positive evidence of "nothing pending":
    // an empty/undefined value is UNKNOWN and must fail closed, because the
    // pinned vendor marks the empty slot with `null` — anything else
    // (a renamed slot, a lazily initialized getter) cannot be read as "parked".
    if (pending === null) return false
    if (typeof pending === 'object' || typeof pending === 'function') return true
    return undefined
  } catch {
    return undefined
  }
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
 * pure ladder's `resyncAvailable` observation comes from here, so a build
 * without the concrete method never arms (and never renders) the control.
 *
 * @param sessions - the instance's session face (loose slice).
 * @param targetId - the session whose stream would be rebuilt.
 * @returns true only when the guarded read finds a callable `resync`.
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
 * Rebuild one session's stream through the concrete vendor method.
 *
 * Called from the renderer's page-level automatic recovery arm (only after it
 * proved no open is in flight) and from the user's own controls. Each owner
 * accounts its attempts before calling this shared capability boundary.
 * `resync()` is async and may reject; the promise is settled with a no-op catch
 * because the chip has no error channel and this package may not log.
 *
 * @param sessions - the instance's session face (loose slice).
 * @param targetId - the session whose stream must be rebuilt.
 * @returns true when the call was issued or the same session already has one in flight.
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

/**
 * Move one presented session to the front of the recency list (immutable).
 * @param presented - most-recent-first ids.
 * @param sessionId - the session now on screen.
 * @param limit - how many entries to keep.
 * @returns the next list.
 */
export function rememberPresented(
  presented: readonly string[],
  sessionId: string,
  limit: number = PRESENTED_MEMORY,
): string[] {
  return [sessionId, ...presented.filter(id => id !== sessionId)].slice(0, limit)
}

/**
 * The cheapest detour target: the most recently presented session other than
 * the one being healed (its scope is normally still materialized, so the stage
 * move costs a state read instead of a fresh window load).
 */
export function previousPresented(presented: readonly string[], targetId: string): string | undefined {
  return presented.find(id => id !== targetId)
}

/**
 * The durable-shape read shared with the mobile stall observer: are we being
 * asked about a conversation that is actually presented, on a visible page?
 * `[data-chat-flow]` is the official ChatView column (vendor ui-chat); without it
 * no chat surface is on screen and every clock must stay at zero.
 *
 * KNOWN APPROXIMATION: existence in the document is not the
 * same as "visible to the user" (a CSS-hidden or covered column still counts),
 * and in a multi-instance shell the query is document-wide. Both only ever make
 * `presented` MORE permissive, and `presented` gates an action that the ladder
 * would otherwise take anyway for a session that is by construction the current
 * one of its own entry — so the cost of a false positive is bounded, while a
 * false negative would silently disable the recovery arm. Tightening it is
 * recorded as open work in docs/progress/STATUS.md.
 */
export function isConversationSurfacePresented(target: {
  readonly visibilityState?: string | undefined
  querySelector(selector: string): unknown
} | null | undefined): boolean {
  if (target === null || target === undefined) return false
  if (target.visibilityState === 'hidden') return false
  return target.querySelector('[data-chat-flow]') !== null
}
