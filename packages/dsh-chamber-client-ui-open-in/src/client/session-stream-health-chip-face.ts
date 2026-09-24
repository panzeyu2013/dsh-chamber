/**
 * The stream-health chip's VISIBLE surface as pure decisions (design 14 §D4).
 *
 * WHY THIS IS A MODULE. The chip is the user's only recovery surface, but this
 * package has no React/DOM test environment (no jsdom, and the repo forbids
 * adding one for this): a behaviour mutation inside the component — a flipped
 * action branch, a notice that renders no button, a ticker that stops re-planning
 * — would be invisible to every test. These three pure functions are the whole
 * visible surface, so they can be pinned behaviourally, and the component is a
 * thin projection of them.
 */
import type {
  SessionOpenState,
  SessionStreamHealthPlan,
  SessionStreamNotice,
} from './session-stream-health.ts'

/** What the chip renders this tick: a `null` label means nothing at all. */
export interface SessionStreamHealthChipFace {
  /** The live-region label: `'healing'` while an arm is running, else the notice. */
  readonly label: 'healing' | SessionStreamNotice | null
  /** The page-reload control (never offered for the informational churn notice). */
  readonly reload: boolean
  /** The user-triggered per-session rebuild control. */
  readonly resync: boolean
  /** The `data-chamber-stream-health` marker the chip publishes. */
  readonly marker: 'recovering' | SessionStreamNotice
}

/**
 * Project one plan and open state onto the chip's visible surface.
 * @param plan - the ladder's plan for this tick.
 * @param openState - the official open state the chip subscribed to.
 * @returns the face; `label === null` means the chip renders nothing at all.
 */
export function sessionStreamHealthChipFace(
  plan: SessionStreamHealthPlan,
  openState: SessionOpenState,
): SessionStreamHealthChipFace {
  const recovering = plan.state.phase === 'healing'
    || (plan.state.phase === 'error-hold' && openState === 'error')
  if (plan.notice === null && !recovering) {
    return { label: null, reload: false, resync: false, marker: 'recovering' }
  }
  // Churn is informational: the stream reopens on its own, so the chip offers no
  // action that would interrupt a recovery already in flight.
  const actionable = plan.notice !== null && plan.notice !== 'carrier-churn'
  return {
    label: plan.notice ?? 'healing',
    reload: actionable,
    resync: actionable && plan.action === 'resync',
    marker: plan.notice ?? 'recovering',
  }
}

/**
 * Whether the chip must keep its 1 s ticker armed. An idle session, an open stream
 * and a hidden page carry no timer; a holding arm (or a visible notice, which
 * expires from its own fact timestamp and so must keep re-planning) does.
 * @param plan - the ladder's plan for this tick.
 * @param openState - the official open state the chip subscribed to.
 * @param visible - whether the page is currently visible.
 * @returns whether the interval must stay armed.
 */
export function sessionStreamHealthChipHoldsTick(
  plan: SessionStreamHealthPlan,
  openState: SessionOpenState,
  visible: boolean,
): boolean {
  if (!visible) return false
  return plan.state.phase !== 'idle'
    || (openState !== 'open' && openState !== 'cold')
    || plan.notice !== null
}

/**
 * The `setPlan` identity rule: a plan whose visible surface is unchanged must
 * keep its previous object, or every tick would re-run the effects for nothing.
 * @param previous - the plan currently held by the component.
 * @param next - the plan the seat just produced.
 * @returns whether `previous` may be kept.
 */
export function sameSessionStreamHealthPlan(
  previous: SessionStreamHealthPlan,
  next: SessionStreamHealthPlan,
): boolean {
  return previous.action === next.action
    && previous.notice === next.notice
    && previous.state.phase === next.state.phase
}
