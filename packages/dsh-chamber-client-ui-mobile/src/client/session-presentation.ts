/**
 * The mobile tier's ONE read of official session presentation.
 *
 * PRESENTED ID. rc.2 keys presentation off the official list row whose
 * `retainedBy.mainView` count is positive (the official ui-workspace owns the
 * only mainView reference). The list snapshot carries per-row ownership data
 * (`SessionSummary.retainedBy`, vendor `client/sessions/service.ts`), so
 * "no positive mainView" is the authoritative "nothing is presented" — there is
 * no other id field to read.
 *
 * CONCRETE SESSION. The face behind the presented id is reached through the
 * sessions service accessor `binding(id)` (returns the retained
 * `SessionBinding`, whose `.session` is the concrete face).
 *
 * Every read is guarded and fail-closed: an unknown or throwing shape yields
 * undefined, never a throw into the poll loop or the shell.
 */

/** One official list row slice: local ownership counts keyed by source label. */
export interface PresentedSessionRowLoose {
  /** rc.2 row ownership counts; a positive `mainView` count presents the row. */
  readonly retainedBy?: Readonly<Record<string, number | undefined>> | undefined
}

/** The official list snapshot slice this module reads. */
export interface SessionListSnapshotLoose {
  /** Rows by id; the rc.2 list always carries this map. */
  readonly byId?: Record<string, PresentedSessionRowLoose | undefined> | undefined
}

/** The official list-store slice this module reads. */
export interface SessionsPresentationLoose {
  readonly list?: {
    getSnapshot?(): SessionListSnapshotLoose | undefined
  } | undefined
}

/** One concrete-session carrier: the binding exposes the face as `.session`. */
interface ConcreteSessionCarrierLoose {
  readonly session?: unknown
}

/** The sessions service slice that reaches a concrete Session (fully guarded). */
export interface SessionsConcreteLoose extends SessionsPresentationLoose {
  /** rc.2 contract entry: the retained binding for `sessionId`, or undefined. */
  binding?(sessionId: string): ConcreteSessionCarrierLoose | undefined
}

/**
 * The presented session id, or undefined when nothing is presented (or the
 * snapshot is unreadable). Fail-closed: a hostile snapshot returns undefined
 * instead of throwing.
 * @param snapshot - the official list-store snapshot, possibly absent.
 * @returns the mainView-retained id, or undefined.
 */
export function presentedSessionId(snapshot: SessionListSnapshotLoose | null | undefined): string | undefined {
  if (snapshot === null || snapshot === undefined) return undefined
  try {
    const byId = snapshot.byId
    if (byId === undefined || byId === null || typeof byId !== 'object') return undefined
    for (const id of Object.keys(byId)) {
      if ((byId[id]?.retainedBy?.mainView ?? 0) > 0) return id
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * The concrete Session object behind the presented id, or undefined (guarded,
 * fail-closed). The accessor is `binding`; a throwing accessor yields undefined.
 * @param sessions - the official sessions service slice, possibly absent.
 * @returns the presented concrete Session, or undefined when unreachable.
 */
export function presentedConcreteSession(
  sessions: SessionsConcreteLoose | undefined,
): Record<string, unknown> | undefined {
  if (sessions === undefined) return undefined
  try {
    const current = presentedSessionId(sessions.list?.getSnapshot?.())
    if (current === undefined) return undefined
    const binding = sessions.binding
    if (typeof binding !== 'function') return undefined
    const session = binding.call(sessions, current)?.session
    if (session === null || session === undefined || typeof session !== 'object') return undefined
    return session as Record<string, unknown>
  } catch {
    return undefined
  }
}
