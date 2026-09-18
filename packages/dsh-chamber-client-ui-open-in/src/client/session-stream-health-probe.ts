/**
 * The imperative half of the session stream-health ladder: the only two effects
 * the seat is allowed to perform — read the presented shape, and (for an
 * `'error'` session) move the stage across a neighbor and back.
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
 * THE PRECONDITION (2026-12 review, R2 major). The detour is only safe while the
 * target is STILL the current, listed session, so every heal checks that first:
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
 * KNOWN APPROXIMATION (2026-12 review): existence in the document is not the
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
