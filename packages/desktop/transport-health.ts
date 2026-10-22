/**
 * Transport link health (desktop probe policy).
 *
 * This is intentionally a PURE reducer: the desktop transport manager owns timers,
 * child processes and HTTP probes, while this module owns only the decision that
 * follows one probe observation. Keeping it pure makes the single-failure ->
 * suspect, second-network-failure -> down transition testable without fake sockets.
 *
 * Ownership: these thresholds are DESKTOP-ONLY (one consumer: the transport
 * manager). They deliberately do not live in dsh-stream-state: that package is a
 * pure stream-lifecycle table set with its own Swift mirror, and the transport
 * link has no page-side consumer — adding a second consumer would widen the build
 * graph and the parity surface for no shared fact. Two independent reasons: no
 * second consumer, and no wish to grow the packaged main-process import graph.
 */

export const LINK_POLICY = {
  /** Default probe budget for a provider that does not declare its own
   *  `verifyUpBudgetMs` (a single HTTP identity exchange). A provider whose
   *  verifyUp is a COMPOSITE flow (gateway password login → probe → re-login)
   *  declares a larger budget so a legitimately slow but reachable probe is not
   *  booked as a network failure. */
  probeTimeoutMs: 5_000,
  /** Re-probe delay while suspect (single-flight). */
  suspectProbeIntervalMs: 2_000,
  /** Re-probe delay after a REACHABLE failure (5xx/401): the path is fine, the
   *  service is busy or the credential needs attention — retrying every 2s would
   *  only add load. */
  reachableProbeIntervalMs: 10_000,
  /** Minimum gap between two FAILURE-DRIVEN forced probes for one instance. A
   *  burst of failed requests is one event, not N: the heartbeat stays the
   *  periodic owner, this only turns "detect at the next beat" into "detect in ~1s". */
  failureProbeMinIntervalMs: 2_000,
  /** Stable-link heartbeat. Held at 30s: with zero traffic this probe is the ONLY
   *  half-open detector, so the old 60s left a ~62s blind window; 30s halves it at
   *  the cost of one tiny identity request per instance per half minute. */
  healthyProbeIntervalMs: 30_000,
  /** Watch-window cadence: tighter probing for a while after a ready edge or a
   *  health transition, when a relay/NAT is most likely to have dropped state. */
  watchProbeIntervalMs: 10_000,
  /** How long the watch window lasts after the last link event. */
  watchWindowMs: 120_000,
  /** Consecutive network-level probe failures before the link is declared down. */
  failuresBeforeDown: 2,
  /** How long a down link keeps the ready phase (fast-failing NEW requests and
   *  subscriptions while in-flight work finishes) before the transport reconnect
   *  owns teardown. It must cover the design's own target black-hole scale
   *  (10–30s): tearing the tunnel down at ~15s killed links that healed on their
   *  own, which is exactly what the two-failure rule was meant to prevent. */
  downGraceMs: 30_000,
} as const

export type LinkHealth = 'healthy' | 'suspect' | 'down'

/** Structural subset of LINK_POLICY; callers may override values in tests without
 *  having to reproduce the literal table type. */
export interface LinkPolicy {
  readonly probeTimeoutMs: number
  readonly suspectProbeIntervalMs: number
  readonly reachableProbeIntervalMs: number
  readonly failureProbeMinIntervalMs: number
  readonly healthyProbeIntervalMs: number
  readonly watchProbeIntervalMs: number
  readonly watchWindowMs: number
  readonly failuresBeforeDown: number
  readonly downGraceMs: number
}

/**
 * What one probe proved about the path.
 * - network  - no answer / timeout / DNS / TCP / TLS: the path is suspect.
 * - server   - the destination answered 5xx/408/425/429: reachable but busy.
 * - auth     - 401: reachable; credential handling belongs to the provider.
 * - protocol - answered and proved it is not a compatible target: terminal.
 * A SUCCESS never reaches this classifier (the caller sees `ok`).
 */
export type ProbeFailureClass = 'network' | 'server' | 'auth' | 'protocol'

/** The health slice the transport manager stores per instance. */
export interface LinkHealthState {
  readonly health: LinkHealth
  /** Consecutive NETWORK-level failures. Reachable answers reset this count. */
  readonly consecutiveNetworkFailures: number
  readonly reason: string | null
}

export const INITIAL_LINK_HEALTH: LinkHealthState = Object.freeze({
  health: 'healthy',
  consecutiveNetworkFailures: 0,
  reason: null,
})

export type LinkHealthEvent =
  | {
    readonly kind: 'probe-ok'
    readonly at: number
  }
  | {
    readonly kind: 'probe-failure'
    readonly at: number
    readonly failureClass: ProbeFailureClass
    readonly reason?: string
  }

export interface LinkHealthReduction {
  readonly state: LinkHealthState
  readonly becameHealthy: boolean
  /** Public transitions only: the manager logs/arms on these. A plain
   *  suspect->suspect or healthy->healthy reduction has no transition flag. */
  readonly becameDown: boolean
  /** Delay before the next probe; null = the manager must reconnect, not probe. */
  readonly nextProbeDelayMs: number | null
}

/** Facts a provider can surface from one identity probe. */
export interface ProbeFailureFacts {
  /** The destination answered with this status, or null when it never answered. */
  readonly statusCode?: number | null
  /** The provider's deterministic identity/version verdict. */
  readonly terminal?: boolean
}

/**
 * Classify one probe result. This is the only place that decides whether a failed
 * probe counts as a LINK failure; an HTTP answer - even a 5xx - proves reachability
 * and therefore must never tear the tunnel down.
 */
export function classifyProbeFailure(facts: ProbeFailureFacts): ProbeFailureClass {
  if (facts.terminal === true) return 'protocol'
  const status = facts.statusCode
  if (typeof status === 'number' && Number.isFinite(status)) {
    if (status === 401) return 'auth'
    if (status === 408 || status === 425 || status === 429 || status >= 500) return 'server'
    if (status >= 400) return 'protocol'
    // A 2xx answer that failed the identity check is classified by the provider;
    // reaching here without terminal is a protocol oddity.
    return 'protocol'
  }
  // No status means the probe never got an HTTP answer: network-level.
  return 'network'
}

/** One probe observation -> the next health state and probe cadence. */
export function reduceLinkHealth(
  previous: LinkHealthState,
  event: LinkHealthEvent,
  policy: LinkPolicy = LINK_POLICY,
): LinkHealthReduction {
  if (event.kind === 'probe-ok') {
    const state: LinkHealthState = {
      health: 'healthy',
      consecutiveNetworkFailures: 0,
      reason: null,
    }
    return {
      state,
      becameHealthy: previous.health !== 'healthy',
      becameDown: false,
      nextProbeDelayMs: policy.healthyProbeIntervalMs,
    }
  }

  const failureClass = event.failureClass
  const trimmed = event.reason?.trim()
  const reason = trimmed === undefined || trimmed === '' ? failureClass : trimmed

  if (failureClass === 'network') {
    // A clock the reducer cannot reason about never authorizes DOWN: the next
    // probe may still prove the path alive. This mirrors the stream tables'
    // conservative time discipline.
    const countable = Number.isFinite(event.at)
    const failures = countable
      ? previous.consecutiveNetworkFailures + 1
      : previous.consecutiveNetworkFailures
    const down = countable && failures >= policy.failuresBeforeDown
    const health: LinkHealth = down ? 'down' : 'suspect'
    return {
      state: {
        health,
        consecutiveNetworkFailures: failures,
        reason,
      },
      becameHealthy: false,
      becameDown: down && previous.health !== 'down',
      nextProbeDelayMs: down ? null : policy.suspectProbeIntervalMs,
    }
  }

  // Reachable failures (server/auth) reset the network streak: the destination
  // answered, so the path is not down. A down link recovers to suspect, not
  // healthy, because the service still rejects the probe. The slower
  // reachable cadence is a table value, not an implicit multiple.
  return {
    state: {
      health: 'suspect',
      consecutiveNetworkFailures: 0,
      reason,
    },
    becameHealthy: false,
    becameDown: false,
    nextProbeDelayMs: policy.reachableProbeIntervalMs,
  }
}
