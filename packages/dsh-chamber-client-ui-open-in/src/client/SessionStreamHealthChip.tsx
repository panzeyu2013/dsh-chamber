/**
 * Session stream-health chip: the visible half of the ladder in
 * `session-stream-health.ts`. It sits in the official conversation header
 * actions row (`conversation.session.header.actions`, list + session scope), so
 * it shows exactly while a conversation is presented — never on the shell
 * overlay, never over the composer, and never for a session the user is not
 * looking at.
 *
 * The component is deliberately thin: every decision and the ladder's whole
 * state live in the seat (`session-stream-health-seat.ts`), because a
 * session-scoped subtree is unmounted on every session switch and a component
 * ref would reset the cooldown/budget each time. This file owns the ticker, the
 * visibility re-check and the markup — that is all.
 *
 * It renders at most one line of text plus up to two user actions: the page
 * reload every (non-churn) notice offers, and — only while the pure plan ARMS
 * it (a parked `loading` open with lever budget left, on a build that exposes
 * the concrete face) — the per-session stream rebuild. Nothing here
 * reloads, re-opens, rebuilds or navigates on its own: both controls are the
 * user's own click, and the plan's `'resync'` action only decides whether the
 * second control is rendered.
 */
import { useEffect, useState, type ReactElement } from 'react'
import type { Translate } from '../shared/coordinator.ts'
import {
  sessionStreamNoticeKey,
  type SessionOpenState,
  type SessionStreamHealthPlan,
} from './session-stream-health.ts'
import { isConversationSurfacePresented } from './session-stream-health-probe.ts'
import styles from './SessionStreamHealthChip.module.css'

/** Injected face the seat supplies (bound translator + the ladder entry point). */
export interface SessionStreamHealthInjected {
  /** Bound translator for the open-in namespace (the chip's copy lives there). */
  t: Translate
  /**
   * Remember the session this seat is showing. The detour a heal performs is
   * cheaper when it reuses a session whose scope is already materialized (the
   * one the user just came from), so the seat keeps a short per-source recency
   * list and passes its most recent OTHER entry to the heal.
   */
  note(sessionId: string): void
  /**
   * One ladder step: plans, executes a requested heal and accounts it. The
   * seat owns the per-session state, so a remount cannot reset the cooldown or
   * the rolling budget.
   */
  step(sessionId: string, openState: SessionOpenState, presented: boolean, now: number): SessionStreamHealthPlan
  /**
   * Subscribe to carrier-churn facts for this source (C1 wiring fix, 2026-09).
   * The fact itself stays in the seat's closure; the chip only learns that a new
   * observation is due. Without this the churn notice could never be planned
   * while the session kept `openState === 'open'` (the ticker is off then, so
   * nothing re-ran the ladder when the event arrived).
   * @returns unsubscribe for the effect's cleanup.
   */
  subscribe(listener: () => void): () => void
  /** The user's own reload action. */
  reload(): void
  /**
   * The user's own per-session stream rebuild. Only ever invoked from the
   * control the plan armed; the seat re-checks the session's cooldown/budget
   * and the concrete face's availability before calling `resync()`.
   */
  resync(sessionId: string): void
}

/**
 * Slot props: the injected face plus the framework standard kit this header row
 * delivers — the per-header `sessionId` and the session selector hook. A
 * structural subset on purpose (the workspace symlink publishes no d.ts tree for
 * these runtime objects; see the same note on `OpenInProps`).
 */
export interface SessionStreamHealthProps extends SessionStreamHealthInjected {
  /** The session this header belongs to (framework-supplied). */
  sessionId: string
  /** Framework selector hook over the current session snapshot. */
  useSession: <S>(selector: (snapshot: { readonly openState: SessionOpenState }) => S) => S
}

/** One tick a second is enough: every threshold in the ladder is seconds wide. */
const TICK_MS = 1_000

function idlePlan(): SessionStreamHealthPlan {
  return { state: { phase: 'idle', since: 0, healStamps: [] }, action: 'none', notice: null }
}

export function SessionStreamHealthChip(props: SessionStreamHealthProps): ReactElement | null {
  const { t, note, step, subscribe, reload, resync, sessionId, useSession } = props
  const openState = useSession(snapshot => snapshot.openState)
  const [plan, setPlan] = useState<SessionStreamHealthPlan>(idlePlan)
  const [tick, setTick] = useState(0)
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')

  // Visibility is re-read on the event, not only on the tick: a page resumed
  // from the tray may have had its timers throttled, and the mobile tier's
  // stall observer does the same.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVisibility = (): void => {
      setVisible(document.visibilityState !== 'hidden')
      setTick(value => value + 1)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { document.removeEventListener('visibilitychange', onVisibility) }
  }, [])

  // Tell the seat which session is on screen (the heal's cheapest detour is the
  // session the user came from). Keyed on the id, so a header remount on a
  // session switch still records it.
  useEffect(() => {
    note(sessionId)
  }, [note, sessionId])

  // Carrier-churn facts arrive as EVENTS — the seat's closure owns the fact, so
  // no prop changes when one lands. Bump the tick to re-plan the ladder (the
  // "reconnecting…" notice appears), and because a visible notice keeps the
  // ticker alive it expires on its own afterwards (C1 wiring fix, 2026-09).
  useEffect(() => subscribe(() => setTick(value => value + 1)), [subscribe])

  // One ladder step per render-relevant change. The seat is where the state and
  // the only side effects live (executing a requested heal, and the user's own
  // resync click — which no effect here ever issues).
  useEffect(() => {
    const presented = visible && isConversationSurfacePresented(typeof document === 'undefined' ? null : document)
    const next = step(sessionId, openState, presented, Date.now())
    setPlan(previous =>
      previous.action === next.action && previous.notice === next.notice && previous.state.phase === next.state.phase
        ? previous
        : next,
    )
  }, [openState, sessionId, tick, visible, note, step])

  // Age the ladder only while an arm is actually holding and the page is
  // visible: an idle session, an open stream, or a hidden page carries no timer.
  // A visible NOTICE also ticks: the carrier-churn notice is derived from a fact
  // timestamp, so it has to be re-planned to expire on its own.
  useEffect(() => {
    const holding = plan.state.phase !== 'idle'
      || (openState !== 'open' && openState !== 'cold')
      || plan.notice !== null
    if (!holding || !visible) return
    const timer = window.setInterval(() => setTick(value => value + 1), TICK_MS)
    return () => window.clearInterval(timer)
  }, [plan.state.phase, plan.notice, openState, visible])

  // While the ladder holds an 'error' state it may still act on its own (the
  // grace, then a retry after each cooldown), and the user must see that a
  // repair is in flight rather than only the vendor's error line. Once the
  // ladder is out of levers the notice takes over with the one action left.
  const recovering = plan.state.phase === 'healing' || (plan.state.phase === 'error-hold' && openState === 'error')
  if (plan.notice === null && !recovering) return null

  const label = plan.notice === null ? t('streamHealth.healing') : t(sessionStreamNoticeKey(plan.notice))
  return (
    <div className={styles.chip} data-chamber-stream-health={plan.notice ?? 'recovering'}>
      {/* The live region is the LABEL only: a live region must not contain the
          interactive control (assistive tech would announce the button as part
          of every update). */}
      <span role="status" aria-live="polite">{label}</span>
      {/* Churn is informational: the stream reopens on its own, so the chip
          offers no action that would interrupt a recovery in flight. */}
      {plan.notice === null || plan.notice === 'carrier-churn' ? null : (
        <>
          <button type="button" className={styles.action} onClick={reload}>
            {t('streamHealth.reload')}
          </button>
          {/* The per-session lever: rendered ONLY while the pure plan arms it
              (a loading stall with the session's cooldown/budget intact and the
              concrete face present). The click is the only invocation — the
              plan never rebuilds a stream by itself. */}
          {plan.action === 'resync' ? (
            <button type="button" className={styles.action} onClick={() => { resync(sessionId) }}>
              {t('streamHealth.resync')}
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}
