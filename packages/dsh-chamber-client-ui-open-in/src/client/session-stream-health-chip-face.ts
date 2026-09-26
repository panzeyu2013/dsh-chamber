/**
 * The stream-health chip’s VISIBLE surface as pure decisions.
 *
 * The package has no React/DOM test environment, so these functions ARE the
 * whole visible surface and can be pinned behaviourally; the component is a thin
 * projection of them. A notice that renders nothing, or a ticker that stops
 * re-planning, would otherwise be invisible to every test.
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
  /** The `data-chamber-stream-health` marker the chip publishes. */
  readonly marker: 'recovering' | SessionStreamNotice
}

/**
 * Project one plan and open state onto the chip’s visible surface; a null
 * label means the chip renders nothing at all.
 */
export function sessionStreamHealthChipFace(
  plan: SessionStreamHealthPlan,
  openState: SessionOpenState,
): SessionStreamHealthChipFace {
  const recovering = plan.state.phase === 'healing'
    || (plan.state.phase === 'error-hold' && openState === 'error')
  // The chip reports; it offers no control (the manual lever is retired).
  if (plan.notice === null && !recovering) return { label: null, marker: 'recovering' }
  return { label: plan.notice ?? 'healing', marker: plan.notice ?? 'recovering' }
}

/**
 * Whether the chip must keep its 1 s ticker armed: an idle session, an open
 * stream and a hidden page carry no timer; a holding arm or a visible notice
 * (which expires from its own fact timestamp) does.
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
 * The `setPlan` identity rule: a plan whose visible surface is unchanged keeps
 * its previous object, or every tick would re-run the effects for nothing.
 */
export function sameSessionStreamHealthPlan(
  previous: SessionStreamHealthPlan,
  next: SessionStreamHealthPlan,
): boolean {
  return previous.action === next.action
    && previous.notice === next.notice
    && previous.state.phase === next.state.phase
}
