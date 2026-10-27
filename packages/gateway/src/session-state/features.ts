/**
 * Source-level capability facts: the advertised feature set per runtime mode and the
 * host-state normalizer. Shared by the store (mode transitions) and the chamber
 * surface (descriptor advertisement); split out of session-state.ts (B3-3) so the
 * store can import them without a facade cycle.
 */
import { SESSION_STATE_FEATURES, type SessionStateFeature, type SessionStateHostState, type SessionStateMode } from '@dsh-chamber/control-plane'
/** Features unavailable without the live $events subscription (the per-mode descriptor tells the truth). */
const EVENT_ONLY_FEATURES: ReadonlySet<SessionStateFeature> = new Set<SessionStateFeature>([
  'session-state.dsh-events',
  'session-state.pending-graph',
])

/** Features advertised for one runtime mode. */
export function featuresForMode(mode: SessionStateMode): readonly SessionStateFeature[] {
  if (mode === 'off') return []
  if (mode === 'sse') return SESSION_STATE_FEATURES
  return SESSION_STATE_FEATURES.filter(feature => !EVENT_ONLY_FEATURES.has(feature))
}

/** Map the plane connectionState string onto the frozen host-state union. */
export function normalizeHostState(state: string): SessionStateHostState {
  switch (state) {
    case 'ready':
    case 'degraded':
    case 'starting':
    case 'stopped':
    case 'error':
    case 'restart-exhausted':
    case 'quarantined':
      return state
    default:
      return 'unknown'
  }
}

