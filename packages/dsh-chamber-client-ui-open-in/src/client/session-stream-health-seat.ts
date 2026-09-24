/**
 * Seat registration for the conversation stream-health ladder — the ONE place
 * the ladder touches the framework: one slot registration, the per-session
 * ladder state, and the two ctx faces it calls. Kept out of `index.ts` (which
 * stays the open-in entry's own wiring) and out of the chip (which owns no ctx).
 *
 * WHY THE HEADER ACTIONS ROW: `conversation.session.header.actions` is
 * `{kind:'list', scope:'session'}` (vendor ui-conversation's slot map), so the
 * chip is mounted exactly while a conversation is presented, receives the
 * per-header `sessionId` and the session selector hook through the standard
 * kit, and never needs a page-level channel to learn what the user is looking
 * at. Its id and order collide with nothing (vendor rows sit at -10 / 10 / 20).
 *
 * WHY THE LADDER STATE LIVES HERE: the session-scoped subtree is
 * keyed by the session binding, so switching sessions UNMOUNTS the chip. A
 * component ref would therefore hand the same session a fresh grace, cooldown
 * and rolling budget after every visit — the storm bound would be decorative.
 * The seat's per-entry closure survives remounts and is keyed by sessionId,
 * which is exactly the granularity the budget is defined at.
 *
 * WHY THE FACE IS A SINGLETON: the chip's effects depend on the injected
 * members; a fresh closure per render would re-run them for nothing.
 *
 * EXECUTION DISCIPLINE: `step` executes the stage-move heal for an error face.
 * The renderer's page-level recovery seat owns the loading-state automatic
 * rebuild, so it also runs when the conversation header never mounts. The
 * plan's `'resync'` action merely
 * ARMS the chip's control; the click reaches `resync()` below, which is
 * deliberately NOT ledger-gated (the header ledger bounds the automatic error
 * heal; a human click is its own bound, and the manual exit must survive an
 * exhausted heal budget). Its stamp paces that error heal. The page's loading
 * rebuild has a separate ledger owned by the page frame.
 *
 * The recovery chip is registered BEFORE the open-in gates and independently of
 * them: a source whose per-entry open-in id does not parse still gets the
 * stream-health chip (that early `return` in `index.ts` must not take the
 * recovery arm with it).
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
  hasHealRoute, hasSessionStreamResync, healSessionStream, previousPresented, rememberPresented,
  resyncSessionStream, sessionStreamResyncInFlight, type SessionsLoose,
} from './session-stream-health-probe.ts'
import { SessionStreamHealthChip, type SessionStreamHealthInjected } from './SessionStreamHealthChip.tsx'

/** The official conversation header actions row (list, session scope). */
export const STREAM_HEALTH_HEADER_SLOT = 'conversation.session.header.actions' as const

/** Our own list id (the registry throws on a duplicate id at the same priority). */
const SLOT_ID = 'chamber-stream-health'

/** How many per-session ladder states the entry keeps (recency-capped). */
const LADDER_MEMORY = 64

/**
 * Manual-rebuild double-click window. The click is not
 * ledger-gated, so the ONLY thing pacing it is this guard: the pinned
 * `Session.resync()` awaits `events.dispose()` before bumping the generation, so
 * two clicks in one second could start two opens.
 */
const MANUAL_RESYNC_GUARD_MS = 1_000

/**
 * Page-level carrier-churn event published by the in-repo api-gateway fork
 * (`packages/dsh-api-gateway/src/client/stream-carrier-fact.ts`, design 14 §D4).
 *
 * Duplicated as a literal on purpose: a client plugin must not deepen an import
 * path into the fork at bundle time, and `test/ui-lock/instance-view-guard.test.ts`
 * pins the two spellings to each other (the vendor-lockstep precedent).
 */
const CARRIER_CHURN_EVENT = 'dsh-chamber:stream-carrier-failed'

/**
 * Resolve the instance's session face LAZILY, one call at a time.
 *
 * Two facts drive this shape:
 *  - this plugin deliberately does not inject `sessions` (its inject roster is
 *    pinned by the boot-graph tests, and the chip must work even before — or
 *    without — a session controller), so the service can be absent;
 *  - reading an ABSENT service off the ctx PROXY throws in cordis rather than
 *    yielding undefined, so a bare `ctx.sessions` read would escape into
 *    React's slot error boundary instead of degrading. `reflect.get(name, false)`
 *    is the non-throwing form; the try/catch covers any context without a
 *    reflect face at all.
 *
 * Nothing is cached across calls on purpose (a re-provided service under HMR is
 * then picked up on the next tick).
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
  // Per-entry recency of the sessions this seat has shown, most recent first:
  // the detour a heal performs is cheapest through a session whose scope is
  // already materialized, which is normally the one the user just came from
  // (an arbitrary neighbor would materialize one more window + follow stream).
  let presented: readonly string[] = []
  const note = (sessionId: string): void => { presented = rememberPresented(presented, sessionId) }

  /**
   * Latest carrier-churn fact for THIS source. The page hosts every boot ctx, so
   * the fact is attributed and filtered here; an unattributed fact (a boot
   * without a chamber instance id) is accepted, fail-open.
   */
  let carrierChurn: { at: number; count: number } | undefined
  /**
   * Render-side subscribers (the chip). The fact stays in this closure — a new
   * observation is announced, not passed as a value: while the session keeps
   * `openState === 'open'` the chip's ticker is off, so
   * an event nobody announces would never be planned into the churn notice.
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
  const previousOf = (sessionId: string): string | undefined => previousPresented(presented, sessionId)

  /** Per-session ladder state, keyed the way the budget is defined. */
  const ladders = new Map<string, SessionStreamHealthState>()
  /**
   * Last manual rebuild per session. The manual click is
   * deliberately NOT ledger-gated, so this is the only thing that paces it: the
   * pinned `resync()` awaits `dispose()` before bumping the generation, so two
   * clicks inside one window could start two opens.
   */
  const lastManualResyncAt = new Map<string, number>()

  /**
   * Re-insert a session's ladder state to refresh its recency, then cap the map
   * (an entry is a few numbers; the cap keeps a long browsing history from
   * growing it). Shared by the automatic heal and the user-clicked resync so
   * both spend the same per-session ledger.
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
          // The stage move needs a CURRENT, LISTED target, so a
          // neighbour in the list is not enough — an address-only target would be
          // refused after spending the ledger. hasHealRoute() gates all three.
          neighborAvailable: hasHealRoute(sessions, sessionId),
          resyncAvailable: hasSessionStreamResync(sessions, sessionId),
          ...(carrierChurn === undefined ? {} : { carrierChurn }),
        },
        now,
        SESSION_STREAM_HEALTH_DEFAULTS,
      )
      let state = plan.state
      if (plan.action === 'heal') {
        // The ATTEMPT is accounted whether or not the lever reported success: a
        // refusing lever (target no longer current/listed) must not retry once
        // per tick, and the cooldown plus the rolling budget already bound the
        // attempts — the ladder reports 'heal-failed' once they run out.
        healSessionStream(sessions, sessionId, previousOf(sessionId))
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
    note,
    step,
    // Carrier-churn wake-up for the renderer: the chip bumps its tick so
    // the ladder re-plans and the "reconnecting…" notice can appear and expire.
    subscribe: (listener) => {
      churnListeners.add(listener)
      return () => { churnListeners.delete(listener) }
    },
    // The user's own action — never taken automatically (design 14 discipline).
    reload: () => { window.location.reload() },
    // The user's own per-session stream rebuild: the concrete
    // `Session.resync()` reached through the probe's guarded capability slice.
    // NOT ledger-gated on purpose: the ledger bounds the AUTOMATIC
    // arm, while the user's manual exit must remain available even after that
    // budget is spent — a human click is its own bound. The attempt is still
    // stamped so it paces the automatic arm.
    resync: (sessionId) => {
      try {
        const sessions = readSessions(ctx)
        if (sessionStreamResyncInFlight(sessions, sessionId)) return
        const now = Date.now()
        // Double-click guard: a manual click is NOT ledger-gated,
        // so two clicks in the same second would call the concrete `resync()` twice
        // — two generations and a possible second stream. One call per window.
        const previousManual = lastManualResyncAt.get(sessionId)
        if (previousManual !== undefined && now - previousManual < MANUAL_RESYNC_GUARD_MS) return
        lastManualResyncAt.set(sessionId, now)
        const current = ladders.get(sessionId) ?? createSessionStreamHealthState()
        // Account the attempt whether or not this build exposes the method (the
        // same one-stamp-per-attempt rule the automatic arms follow): a face that
        // vanished between planning and clicking must not leave the control armed
        // for a retry loop.
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
    // Same row as the vendor session actions; 0 keeps their relative order
    // untouched and leaves room for a future chamber entry on either side.
    order: 0,
    label: () => t('streamHealth.label'),
    inject: () => face,
  }, SessionStreamHealthChip))
}
