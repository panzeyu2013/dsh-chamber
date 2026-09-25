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
 * never mounts. The plan's `'resync'` action merely ARMS the chip's control; the
 * click reaches `resync()` below, which is deliberately NOT ledger-gated (the
 * header ledger bounds the automatic error heal; a human click is its own bound).
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
  hasSessionStreamResync, resyncSessionStream, sessionStreamResyncInFlight, type SessionsLoose,
} from './session-stream-health-probe.ts'
import { SessionStreamHealthChip, type SessionStreamHealthInjected } from './SessionStreamHealthChip.tsx'

/** The official conversation header actions row (list, session scope). */
export const STREAM_HEALTH_HEADER_SLOT = 'conversation.session.header.actions' as const

/** Our own list id (the registry throws on a duplicate id at the same priority). */
const SLOT_ID = 'chamber-stream-health'

/** How many per-session ladder states the entry keeps (recency-capped). */
const LADDER_MEMORY = 64

/**
 * Manual-rebuild double-click window: the click is not ledger-gated, so this
 * guard is the only thing pacing it — the pinned `Session.resync()` awaits
 * `events.dispose()` before bumping the generation, so two clicks could start two opens.
 */
const MANUAL_RESYNC_GUARD_MS = 1_000

/**
 * Page-level carrier-churn event published by the in-repo api-gateway fork.
 * Duplicated as a literal on purpose: a client plugin must not deepen an import
 * path into the fork at bundle time (a lockstep test pins the two spellings).
 */
const CARRIER_CHURN_EVENT = 'dsh-chamber:stream-carrier-failed'

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
   * Latest carrier-churn fact for THIS source. The page hosts every boot ctx, so
   * the fact is attributed and filtered here; an unattributed fact is fail-open.
   */
  let carrierChurn: { at: number; count: number } | undefined
  /**
   * Render-side subscribers (the chip). The fact stays in this closure and a new
   * observation is announced, not passed as a value: while the session stays
   * `open` the chip’s ticker is off, so an unannounced event is never planned.
   */
  const churnListeners = new Set<() => void>()
  const ownInstanceId = (ctx as { readonly chamberInstanceId?: string }).chamberInstanceId
  ctx.effect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    const onChurn = (event: Event): void => {
      const detail = (event as CustomEvent<{ instanceId?: unknown; at?: unknown; count?: unknown }>).detail
      if (detail === null || typeof detail !== 'object') return
      if (ownInstanceId !== undefined && typeof detail.instanceId === 'string' && detail.instanceId !== ownInstanceId) return
      const at = typeof detail.at === 'number' && Number.isFinite(detail.at) ? detail.at : Date.now()
      const count = typeof detail.count === 'number' && Number.isFinite(detail.count)
        ? detail.count
        : (carrierChurn?.count ?? 0) + 1
      carrierChurn = { at, count }
      for (const listener of [...churnListeners]) listener()
    }
    window.addEventListener(CARRIER_CHURN_EVENT, onChurn)
    return () => {
      window.removeEventListener(CARRIER_CHURN_EVENT, onChurn)
      churnListeners.clear()
    }
  }, 'dsh-chamber: stream carrier churn fact')

  /** Per-session ladder state, keyed the way the budget is defined. */
  const ladders = new Map<string, SessionStreamHealthState>()
  /**
   * Last manual rebuild per session: the click is deliberately NOT ledger-gated,
   * so this is the only thing pacing it (two clicks inside one window could
   * start two opens).
   */
  const lastManualResyncAt = new Map<string, number>()

  /**
   * Re-insert a session’s ladder state to refresh its recency, then cap the map.
   * Shared by the automatic heal and the user-clicked resync so both spend the
   * same per-session ledger.
   */
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
      const plan = planSessionStreamHealth(
        ladders.get(sessionId) ?? createSessionStreamHealthState(),
        {
          openState,
          presented: surfacePresented,
          // The automatic heal executes the concrete resync on the PRESENTED
          // target, so both facts come from the same guarded probe read.
          healRoute: hasSessionStreamResync(sessions, sessionId),
          resyncAvailable: hasSessionStreamResync(sessions, sessionId),
          ...(carrierChurn === undefined ? {} : { carrierChurn }),
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
    // Carrier-churn wake-up for the renderer: the chip bumps its tick so
    // the ladder re-plans and the "reconnecting…" notice can appear and expire.
    subscribe: (listener) => {
      churnListeners.add(listener)
      return () => { churnListeners.delete(listener) }
    },
    // The user's own action — never taken automatically (design 14 discipline).
    reload: () => { window.location.reload() },
    // The user’s own per-session rebuild through the probe’s guarded slice. NOT
    // ledger-gated on purpose: the ledger bounds the AUTOMATIC arm, while the
    // manual exit must survive an exhausted automatic budget — but the attempt is
    // still stamped so it paces the automatic arm.
    resync: (sessionId) => {
      try {
        const sessions = readSessions(ctx)
        if (sessionStreamResyncInFlight(sessions, sessionId)) return
        const now = Date.now()
        // Double-click guard: a manual click is NOT ledger-gated, so two clicks in
        // the same second would call `resync()` twice — two generations, two streams.
        const previousManual = lastManualResyncAt.get(sessionId)
        if (previousManual !== undefined && now - previousManual < MANUAL_RESYNC_GUARD_MS) return
        lastManualResyncAt.set(sessionId, now)
        const current = ladders.get(sessionId) ?? createSessionStreamHealthState()
        // Account the attempt whether or not this build exposes the method (the
        // one-stamp-per-attempt rule): a face that vanished must not stay armed for a retry loop.
        resyncSessionStream(sessions, sessionId)
        storeLadder(sessionId, markSessionStreamHeal(current, now))
      } catch {
        // Never throws into React, and this package's client sources may not log.
      }
    },
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
