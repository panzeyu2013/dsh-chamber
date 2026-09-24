import { LADDER_TABLES } from '@dsh-chamber/dsh-stream-state'

/** Page-level opening outcome independent of the conversation header tree.
 *  Every window comes from the one ladder table: a local numeric copy again
 *  turns `verify-ladder-table-parity` red. */
export const SESSION_OPEN_FEEDBACK_MS = LADDER_TABLES.streamHealth.loadingStallMs
export const SESSION_OPEN_FAILED_MS = LADDER_TABLES.streamHealth.loadingFailedMs

export type SessionOpenRecoveryPhase = 'quiet' | 'waiting' | 'failed'

export interface SessionOpenHealth {
  sessionId: string
  state: 'cold' | 'loading' | 'open' | 'error' | 'missing'
  since: number
  now: number
  resyncAvailable: boolean
  /** Only `false` proves that the concrete session has no pending open. */
  openInFlight?: boolean | undefined
  /** A previous resync may still be disposing its old stream. */
  resyncInFlight?: boolean | undefined
}

/** An unmounted session is an observable missing face, not an infinite spinner. */
export function advanceSessionOpenHealth(
  previous: SessionOpenHealth | null,
  sessionId: string,
  observed: { openState: SessionOpenHealth['state']; resyncAvailable: boolean; openInFlight?: boolean | undefined; resyncInFlight?: boolean | undefined } | null,
  at: number,
): SessionOpenHealth | null {
  if (observed === null) {
    if (previous?.sessionId === sessionId && previous.state === 'error') {
      return { ...previous, now: at, resyncAvailable: false, openInFlight: undefined, resyncInFlight: undefined }
    }
    const since = previous?.sessionId === sessionId && previous.state !== 'open'
      ? previous.since : at
    return { sessionId, state: 'missing', since, now: at, resyncAvailable: false, openInFlight: undefined, resyncInFlight: undefined }
  }
  // Missing → loading is the same unresolved open. A short probe gap cannot
  // restart the deadline, while a genuinely open face resets it.
  const since = previous?.sessionId === sessionId && previous.state !== 'open'
    && observed.openState !== 'open' ? previous.since : at
  return {
    sessionId, state: observed.openState, since, now: at,
    resyncAvailable: observed.resyncAvailable,
    openInFlight: observed.openInFlight,
    resyncInFlight: observed.resyncInFlight,
  }
}

export function sessionOpenRecoveryPhase(
  openState: SessionOpenHealth['state'] | undefined,
  elapsedMs: number,
): SessionOpenRecoveryPhase {
  if (openState === 'error') return 'failed'
  if (openState !== 'loading' && openState !== 'missing') return 'quiet'
  if (elapsedMs >= SESSION_OPEN_FAILED_MS) return 'failed'
  return elapsedMs >= SESSION_OPEN_FEEDBACK_MS ? 'waiting' : 'quiet'
}

/** The page owns this decision even when the vendor conversation header is absent. */
export function presentedSessionOpenRecoveryPhase(
  health: SessionOpenHealth | null,
  currentSessionId: string | undefined,
  knownBlank: boolean,
): SessionOpenRecoveryPhase {
  if (health === null || health.sessionId !== currentSessionId) return 'quiet'
  // A blank session may legitimately have no materialized Session object.
  // Its actual loading/error face is still a failure candidate.
  if (knownBlank && health.state === 'missing') return 'quiet'
  return sessionOpenRecoveryPhase(health.state, health.now - health.since)
}
