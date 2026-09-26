/**
 * Session stream-health chip: the visible half of the ladder. It sits in the
 * official conversation header actions row (list + session scope), so it shows
 * exactly while a conversation is presented.
 *
 * Deliberately thin: every decision and the whole ladder state live in the seat
 * (a session-scoped subtree is unmounted on every switch, so a component ref
 * would reset cooldown/budget). This file owns the visibility re-check, the
 * React wiring and the markup; the visible surface (notice, whether to keep
 * ticking) is the pure projection in `session-stream-health-chip-face.ts`, so it
 * can be behaviour-tested without a DOM. It renders at most one line of status
 * text and NO control: the manual reload/rebuild lever was retired (user
 * ruling — upstream has no such control), and nothing here reloads, re-opens,
 * rebuilds or navigates on its own.
 */
import { useEffect, useState, type ReactElement } from 'react'
import type { Translate } from '../shared/coordinator.ts'
import {
  sessionStreamNoticeKey,
  type SessionOpenState,
  type SessionStreamHealthPlan,
} from './session-stream-health.ts'
import { isConversationSurfacePresented } from './session-stream-health-probe.ts'
import {
  sameSessionStreamHealthPlan,
  sessionStreamHealthChipFace,
  sessionStreamHealthChipHoldsTick,
} from './session-stream-health-chip-face.ts'
import styles from './SessionStreamHealthChip.module.css'

/** Injected face the seat supplies: bound translator and one ladder step. */
export interface SessionStreamHealthInjected {
  /** Bound translator for the open-in namespace (the chip's copy lives there). */
  t: Translate
  /** One ladder step: plans, executes a requested heal and accounts it. The seat
   *  owns the state, so a remount cannot reset the cooldown or rolling budget. */
  step(sessionId: string, openState: SessionOpenState, presented: boolean, now: number): SessionStreamHealthPlan
}

/**
 * Slot props: the injected face plus the framework standard kit (per-header
 * `sessionId`, session selector hook). A structural subset on purpose.
 */
export interface SessionStreamHealthProps extends SessionStreamHealthInjected {
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
  const { t, step, sessionId, useSession } = props
  const openState = useSession(snapshot => snapshot.openState)
  const [plan, setPlan] = useState<SessionStreamHealthPlan>(idlePlan)
  const [tick, setTick] = useState(0)
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')

  // Visibility is re-read on the event, not only on the tick: a page resumed
  // from the tray may have had its timers throttled.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVisibility = (): void => {
      setVisible(document.visibilityState !== 'hidden')
      setTick(value => value + 1)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { document.removeEventListener('visibilitychange', onVisibility) }
  }, [])

  // One ladder step per render-relevant change. The seat owns the state and the
  // only side effect (executing the automatic heal); this component issues none.
  useEffect(() => {
    const presented = visible && isConversationSurfacePresented(typeof document === 'undefined' ? null : document)
    const next = step(sessionId, openState, presented, Date.now())
    setPlan(previous => (sameSessionStreamHealthPlan(previous, next) ? previous : next))
  }, [openState, sessionId, tick, visible, step])

  // Age the ladder only while an arm is holding and the page is visible: an idle
  // session, an open stream, or a hidden page carries no timer. A visible NOTICE
  // also ticks — its threshold (or its clear condition) must be re-evaluated.
  useEffect(() => {
    if (!sessionStreamHealthChipHoldsTick(plan, openState, visible)) return
    const timer = window.setInterval(() => setTick(value => value + 1), TICK_MS)
    return () => window.clearInterval(timer)
  }, [plan.state.phase, plan.notice, openState, visible])

  // The visible surface is the pure projection (behaviour-tested without a DOM):
  // a null label means nothing renders. While the ladder holds an 'error' state it
  // may still act on its own, and the user must see that a repair is in flight
  const face = sessionStreamHealthChipFace(plan, openState)
  if (face.label === null) return null

  const label = face.label === 'healing' ? t('streamHealth.healing') : t(sessionStreamNoticeKey(face.label))
  return (
    <div className={styles.chip} data-chamber-stream-health={face.marker}>
      {/* The live region is the LABEL only: an interactive control must not be
          announced as part of every update (and the manual lever is retired). */}
      <span role="status" aria-live="polite">{label}</span>
    </div>
  )
}
