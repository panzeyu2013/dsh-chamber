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
 * WHY THE LADDER STATE LIVES HERE (2026-12 review): the session-scoped subtree is
 * keyed by the session binding, so switching sessions UNMOUNTS the chip. A
 * component ref would therefore hand the same session a fresh grace, cooldown
 * and rolling budget after every visit — the storm bound would be decorative.
 * The seat's per-entry closure survives remounts and is keyed by sessionId,
 * which is exactly the granularity the budget is defined at.
 *
 * WHY THE FACE IS A SINGLETON: the chip's effects depend on the injected
 * members; a fresh closure per render would re-run them for nothing.
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
  hasHealNeighbor, healSessionStream, previousPresented, rememberPresented, type SessionsLoose,
} from './session-stream-health-probe.ts'
import { SessionStreamHealthChip, type SessionStreamHealthInjected } from './SessionStreamHealthChip.tsx'

/** The official conversation header actions row (list, session scope). */
export const STREAM_HEALTH_HEADER_SLOT = 'conversation.session.header.actions' as const

/** Our own list id (the registry throws on a duplicate id at the same priority). */
const SLOT_ID = 'chamber-stream-health'

/** How many per-session ladder states the entry keeps (recency-capped). */
const LADDER_MEMORY = 64

/**
 * Page-level carrier-churn event published by the in-repo api-gateway fork
 * (`packages/dsh-api-gateway/src/client/stream-carrier-fact.ts`, design 14 §D4).
 *
 * Duplicated as a literal on purpose: a client plugin must not deepen an import
 * path into the fork at bundle time, and `test/session-health/stream-health-wiring.test.ts`
 * pins the two spellings to each other (the vendor-lockstep precedent).
 */
const CARRIER_CHURN_EVENT = 'dsh-chamber:stream-carrier-failed'

/**
 * Resolve the instance's session face LAZILY, one call at a time.
 *
 * Two facts drive this shape (2026-12 review):
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
    }
    window.addEventListener(CARRIER_CHURN_EVENT, onChurn)
    return () => { window.removeEventListener(CARRIER_CHURN_EVENT, onChurn) }
  }, 'dsh-chamber: stream carrier churn fact')
  const previousOf = (sessionId: string): string | undefined => previousPresented(presented, sessionId)

  /** Per-session ladder state, keyed the way the budget is defined. */
  const ladders = new Map<string, SessionStreamHealthState>()

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
      const ids = readSessions(ctx)?.list.getSnapshot().ids
      const plan = planSessionStreamHealth(
        ladders.get(sessionId) ?? createSessionStreamHealthState(),
        {
          openState,
          presented: surfacePresented,
          neighborAvailable: ids === undefined ? false : hasHealNeighbor(ids, sessionId),
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
        healSessionStream(readSessions(ctx), sessionId, previousOf(sessionId))
        state = markSessionStreamHeal(state, now)
      }
      // Re-insert to refresh recency, then cap the map (an entry is a few
      // numbers; the cap keeps a long browsing history from growing it).
      ladders.delete(sessionId)
      ladders.set(sessionId, state)
      if (ladders.size > LADDER_MEMORY) {
        const oldest = ladders.keys().next().value
        if (oldest !== undefined) ladders.delete(oldest)
      }
      return state === plan.state ? plan : { state, action: plan.action, notice: plan.notice }
    } catch {
      return { state: createSessionStreamHealthState(), action: 'none', notice: null }
    }
  }

  const face: SessionStreamHealthInjected = {
    t,
    note,
    step,
    // The user's own action — never taken automatically (design 14 discipline).
    reload: () => { window.location.reload() },
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
