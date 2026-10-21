/**
 * Transport link health (desktop probe policy).
 *
 * This is intentionally a PURE reducer: the desktop transport manager owns timers,
 * child processes and HTTP probes, while this module owns only the decision that
 * follows one probe observation. Keeping it pure makes the single-failure ->
 * suspect, second-network-failure -> down transition testable without fake sockets.
 *
 * Ownership: these thresholds are DESKTOP-ONLY (one consumer: the transport
 * manager). They deliberately do not live in dsh-stream-state: that package is
 * packaged as source into node_modules and the Electron main process must not
 * import a second source-only workspace package. There is no second consumer, so
 * this is the single threshold owner for the transport link.
 */

export const LINK_POLICY = {
  /** One identity/liveness probe may take this long. */
  probeTimeoutMs: 5_000,
  /** Re-probe delay while suspect (single-flight). */
  suspectProbeIntervalMs: 2_000,
  /** Healthy-state re-verification cadence (matches the existing 60s heartbeat). */
  healthyProbeIntervalMs: 60_000,
  /** Consecutive network-level probe failures before the link is declared down. */
  failuresBeforeDown: 2,
  /** How long a down link stays in ready (fast-failing new requests, preserving
   *  in-flight work) before the transport reconnect owns teardown. */
  downGraceMs: 5_000,
} as const

export type LinkHealth = 'healthy' | 'suspect' | 'down'

/** Structural subset of LINK_POLICY; callers may override values in tests without
 *  having to reproduce the literal table type. */
export interface LinkPolicy {
  readonly probeTimeoutMs: number
  readonly suspectProbeIntervalMs: number
  readonly healthyProbeIntervalMs: number
  readonly failuresBeforeDown: number
  readonly downGraceMs: number
}

/**
 * What one probe proved about the path.
 * - network  - no answer / timeout / DNS / TCP / TLS: the path is suspect.
 * - server   - the destination answered 5xx/408/425/429: reachable but busy.
 * - auth     - 401: reachable; credential handling belongs to the provider.
 * - protocol - answered and proved it is not a compatible target: terminal.
 * - none     - success.
 */
export type ProbeFailureClass = 'none' | 'network' | 'server' | 'auth' | 'protocol'

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
    readonly failureClass: Exclude<ProbeFailureClass, 'none'>
    readonly reason?: string
  }

export interface LinkHealthReduction {
  readonly state: LinkHealthState
  readonly becameHealthy: boolean
  readonly becameSuspect: boolean
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
      becameSuspect: false,
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
      becameSuspect: previous.health !== 'suspect' && !down,
      becameDown: down && previous.health !== 'down',
      nextProbeDelayMs: down ? null : policy.suspectProbeIntervalMs,
    }
  }

  // Reachable failures (server/auth) reset the network streak: the destination
  // answered, so the path is not down. A down link recovers to suspect, not
  // healthy, because the service still rejects the probe.
  return {
    state: {
      health: 'suspect',
      consecutiveNetworkFailures: 0,
      reason,
    },
    becameHealthy: false,
    becameSuspect: previous.health !== 'suspect',
    becameDown: false,
    nextProbeDelayMs: policy.suspectProbeIntervalMs * 5,
  }
}
