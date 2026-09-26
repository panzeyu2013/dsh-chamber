/**
 * Seat registration for the stream-health ladder — the ONE place the ladder
 * touches the framework: one slot registration, the per-session ladder state,
 * and the ctx faces it calls.
 *
 * The header-actions slot is session-scoped, so the chip mounts exactly while a
 * conversation is presented and gets the per-header `sessionId` plus the session
 * selector hook through the standard kit. The ladder state lives HERE because a
 * session-scoped subtree is unmounted on every switch — a component ref would
 * reset grace/cooldown/budget per visit, while this per-entry closure survives
 * remounts, keyed by sessionId.
 *
 * EXECUTION DISCIPLINE: `step` executes the automatic per-session `resync()`
 * for an error face (rc.2; the stage-move lever died with its `sessions.open`
 * API). The renderer's page-level recovery seat owns the automatic rebuild for
 * a face the header cannot heal, so it also runs when the conversation header
 * never mounts. The plan has no user-triggered action (the manual reload/rebuild
 * controls were retired); the chip only reports, and every escalation is
 * automatic.
 *
 * Registered BEFORE the open-in gates: a source whose open-in id does not parse
 * still gets the recovery chip.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { Translate } from '../shared/coordinator.ts'
import {
  createSessionStreamHealthState,
  markSessionStreamHeal,
  planSessionStreamHealth,
  SESSION_STREAM_HEALTH_DEFAULTS,
  type SessionOpenState,
  type SessionStreamHealthPlan,
  type SessionStreamHealthState,
} from './session-stream-health.ts'
import {
  hasSessionStreamResync, resyncSessionStream, sessionOpeningFailureLedger,
  type SessionsLoose,
} from './session-stream-health-probe.ts'
import { SessionStreamHealthChip, type SessionStreamHealthInjected } from './SessionStreamHealthChip.tsx'

/** The official conversation header actions row (list, session scope). */
export const STREAM_HEALTH_HEADER_SLOT = 'conversation.session.header.actions' as const

/** Our own list id (the registry throws on a duplicate id at the same priority). */
const SLOT_ID = 'chamber-stream-health'

/** How many per-session ladder states the entry keeps (recency-capped). */
const LADDER_MEMORY = 64

/**
 * Resolve the instance's session face LAZILY, one call at a time. This plugin
 * deliberately does not inject `sessions`, so the service can be absent; reading
 * an ABSENT service off the ctx PROXY throws in cordis, which would escape into
 * React's slot error boundary — `reflect.get(name, false)` is the non-throwing
 * form, and the try/catch covers a context with no reflect face at all. Nothing
 * is cached across calls, so a re-provided service under HMR is picked up.
 */
function readSessions(ctx: ClientContext): SessionsLoose | undefined {
  try {
    const reflect = (ctx as { reflect?: { get?(name: string, strict?: boolean): unknown } }).reflect
    if (reflect?.get !== undefined) {
      const found = reflect.get('sessions', false)
      return found === null || found === undefined ? undefined : (found as SessionsLoose)
    }
    return (ctx as { sessions?: SessionsLoose }).sessions
  } catch {
    return undefined
  }
}

export function registerSessionStreamHealthSeat(ctx: ClientContext, t: Translate): void {
  /**
   * Render-side wake-up subscribers (the chip). Announced, not passed as a value:
   * the terminal opening fact must surface the moment it lands instead of waiting
   * for the chip's next 1 s tick.
   */
  const wakeListeners = new Set<() => void>()
  const ownInstanceId = (ctx as { readonly chamberInstanceId?: string }).chamberInstanceId
  /**
   * Terminal opening evidence published by the in-repo api-gateway fork. The
   * fact lives in the page-level ledger (shared with the renderer's page seat
   * through the one page realm); this seat only wakes the chip, so the failure
   * notice appears the moment the evidence lands. Reading the ledger ALSO
   * installs its one page listener; an absent/or drifted channel changes nothing.
   */
  const openingFailures = sessionOpeningFailureLedger()
  ctx.effect(() => {
    const unsubscribe = openingFailures.subscribe(() => {
      for (const listener of [...wakeListeners]) listener()
    })
    // Disposal drops the ledger subscription AND the chip callbacks: a disposed
    // seat must not keep firing render-side wake-ups (the retired churn effect
    // used to clear them).
    return () => {
      unsubscribe()
      wakeListeners.clear()
    }
  }, 'dsh-chamber: stream opening failure wake-up')

  /** Per-session ladder state, keyed the way the budget is defined. */
  const ladders = new Map<string, SessionStreamHealthState>()

  /** Re-insert a session’s ladder state to refresh its recency, then cap the map. */
  const storeLadder = (sessionId: string, state: SessionStreamHealthState): void => {
    ladders.delete(sessionId)
    ladders.set(sessionId, state)
    if (ladders.size > LADDER_MEMORY) {
      const oldest = ladders.keys().next().value
      if (oldest !== undefined) ladders.delete(oldest)
    }
  }

  /**
   * One ladder step for one session: plan, execute a requested heal, account it.
   * Never throws — a drifting or absent vendor face degrades to "no action".
   */
  const step = (
    sessionId: string,
    openState: SessionOpenState,
    surfacePresented: boolean,
    now: number,
  ): SessionStreamHealthPlan => {
    try {
      const sessions = readSessions(ctx)
      // Evidence is read for a loading target only: that is the one arm it
      // speaks to, and a proven-dead opening must be visible NOW — while the
      // seat still never re-issues it automatically (it only reports).
      const openingFailure = openState === 'loading'
        ? openingFailures.failureFor(ownInstanceId, sessionId, now)
        : undefined
      // One guarded capability read: the automatic heal's route and the reachable
      // face answer the same question, so they must not be able to disagree.
      const resyncAvailable = hasSessionStreamResync(sessions, sessionId)
      const plan = planSessionStreamHealth(
        ladders.get(sessionId) ?? createSessionStreamHealthState(),
        {
          openState,
          presented: surfacePresented,
          // The automatic heal executes the concrete resync on the PRESENTED
          // target, so both facts come from the same guarded probe read.
          healRoute: resyncAvailable,
          resyncAvailable,
          ...(openingFailure === undefined ? {} : { openingFailure: openingFailure.failure }),
        },
        now,
        SESSION_STREAM_HEALTH_DEFAULTS,
      )
      let state = plan.state
      if (plan.action === 'heal') {
        // The ATTEMPT is accounted whether or not the lever reported success: a
        // refusing lever must not retry once per tick — the cooldown and rolling
        // budget already bound the attempts.
        resyncSessionStream(sessions, sessionId)
        state = markSessionStreamHeal(state, now)
      }
      storeLadder(sessionId, state)
      return state === plan.state ? plan : { state, action: plan.action, notice: plan.notice }
    } catch {
      return { state: createSessionStreamHealthState(), action: 'none', notice: null }
    }
  }

  const face: SessionStreamHealthInjected = {
    t,
    step,
    // Wake-up for the renderer: the chip bumps its tick so a terminal opening
    // fact is planned immediately instead of on its next 1 s tick.
    subscribe: (listener) => {
      wakeListeners.add(listener)
      return () => { wakeListeners.delete(listener) }
    },
    // No user-triggered action exists (retired by user ruling); the face's only
    // side effect is the automatic heal executed by `step`.
  }

  ctx.slots.inject(STREAM_HEALTH_HEADER_SLOT, () => ctx.slots.register({
    name: STREAM_HEALTH_HEADER_SLOT,
    id: SLOT_ID,
    // Same row as the vendor session actions; 0 keeps their order and leaves room on either side.
    order: 0,
    label: () => t('streamHealth.label'),
    inject: () => face,
  }, SessionStreamHealthChip))
}
