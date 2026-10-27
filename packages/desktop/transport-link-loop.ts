/**
 * Link-health loop: the down->reconnect grace, the ready-state heartbeat and its
 * single-flight verification, the online wake wave, the link-failure notifier and the
 * bounded reverify ladder. Split out of transport-manager.ts (B2-2b).
 *
 * The module owns exactly two pieces of state (the reverify generation and its
 * timers, cancelled together through cancelReverify); everything else arrives as a
 * dependency, and every per-instance timer still lives on InstanceState.
 */
import { type TransportInstanceSpec, type TransportProbeEndpoint, type TransportProvider, type TransportStatusProjection, type TransportVerifyResult } from './transport-provider.ts'
import { classifyProbeFailure, reduceLinkHealth, type LinkHealthReduction, type LinkPolicy, type ProbeFailureClass } from './transport-health.ts'
import { describeError as describeTransportError } from './describe-error.ts'
import type { InstanceState } from './transport-instance-state.ts'

export interface LinkLoopDeps {
  states: Map<string, InstanceState>
  instances: Map<string, TransportInstanceSpec>
  linkPolicy: LinkPolicy
  linkHealth: {
    applyLinkHealth: (id: string, state: InstanceState, event: Parameters<typeof reduceLinkHealth>[1]) => LinkHealthReduction
    clearDownGrace: (state: InstanceState) => void
    probeBudgetFor: (spec: TransportInstanceSpec, provider: TransportProvider) => number
    readyProbeEndpoint: (spec: TransportInstanceSpec, provider: TransportProvider, state: InstanceState) => TransportProbeEndpoint | null
  }
  bus: { listeners: (event: string) => Function[] }
  isDisposed: () => boolean
  isCurrentState: (id: string, state: InstanceState) => boolean
  failTerminal: (id: string, state: InstanceState, message: string, requiresUserAction?: boolean, userActionKind?: 'auth' | 'endpoint' | null) => void
  scheduleReconnect: (id: string, state: InstanceState, reason: string) => void
  appendLogInternal: (state: InstanceState, level: 'info' | 'warn' | 'error', message: string) => void
  resolveProvider: (entry: { kind?: unknown; transport?: unknown }) => any
  doRandom: () => number
  doVerify: (spec: TransportInstanceSpec, endpoint: TransportProbeEndpoint, signal?: AbortSignal) => Promise<TransportVerifyResult>
  /** The INJECTED verifier only (undefined = none): the skip gate below must stay live. */
  verifyProbe?: (spec: TransportInstanceSpec, endpoint: TransportProbeEndpoint, signal?: AbortSignal) => Promise<TransportVerifyResult>
  warn: (message: string) => void
  readyVerifyIntervalMs: number
  readyVerifyMinIntervalMs: number
  /** True when the caller pinned the cadence explicitly (determinism seam). */
  explicitReadyVerifyInterval: boolean
  /** Manager's status projection (a function declaration, hoisted). */
  status: (id: string) => TransportStatusProjection | null
  linkBusy?: (id: string) => boolean
}

const WAKE_STAGGER_MS = 120

export function createLinkLoop(deps: LinkLoopDeps) {
  const {
    states, instances, linkPolicy, linkHealth, bus, isDisposed, isCurrentState, failTerminal,
    scheduleReconnect, appendLogInternal, resolveProvider, doRandom, doVerify, verifyProbe, warn,
    readyVerifyIntervalMs, readyVerifyMinIntervalMs, status, linkBusy, explicitReadyVerifyInterval,
  } = deps
  const { applyLinkHealth, clearDownGrace, probeBudgetFor, readyProbeEndpoint } = linkHealth
  let reverifyGeneration = 0
  const reverifyTimers = new Set<ReturnType<typeof setTimeout>>()
  function armDownGrace(id: string, state: InstanceState, reason: string): void {
    clearDownGrace(state)
    const spec = instances.get(id)
    const budgetMs = spec === undefined ? linkPolicy.probeTimeoutMs : probeBudgetFor(spec, resolveProvider(spec))
    state.downGraceDeadlineAt = Date.now() + linkPolicy.downGraceMs + budgetMs
    const expire = (): void => {
      state.downGraceTimer = null
      if (!isCurrentState(id, state) || state.phase !== 'ready' || state.link.health !== 'down') return
      // Read the deadline from the state (the single record of this window), so a
      // cleared/re-armed grace can never be extended by a stale closure.
      if (state.verifyInFlight && Date.now() < state.downGraceDeadlineAt) {
        state.downGraceTimer = setTimeout(expire, 1_000)
        state.downGraceTimer.unref?.()
        return
      }
      scheduleReconnect(id, state, `link remained down after grace: ${reason}`)
    }
    state.downGraceTimer = setTimeout(expire, linkPolicy.downGraceMs)
    state.downGraceTimer.unref?.()
  }

  /** Arm the periodic ready-state re-verification for one READY transport. */
  /**
   * Stable vs watch-window heartbeat. Right after a ready edge or a health
   * transition, a relay/NAT is most likely to have dropped state, so the link is
   * sampled every 10s for two minutes; once it has been quiet-and-healthy for
   * longer, the 30s heartbeat is enough. 30s (not 60s) is deliberate: with zero
   * traffic the heartbeat is the ONLY half-open detector (design 27 §6.19).
   */
  function heartbeatCadence(state: InstanceState): number {
    const sinceEvent = Date.now() - state.lastLinkEventAt
    const inWatch = sinceEvent >= 0 && sinceEvent < linkPolicy.watchWindowMs
    // An EXPLICIT readyVerifyIntervalMs pins one cadence (the determinism seam the
    // transport tests drive): the two-tier window is a production default only, so a
    // test that says "probe every 40ms" is never overridden by the watch tier.
    if (!inWatch || explicitReadyVerifyInterval) return readyVerifyIntervalMs
    return linkPolicy.watchProbeIntervalMs
  }

  function armReadyVerify(id: string, state: InstanceState, delayMs?: number): void {
    if (state.readyProbeTimer !== null) return
    const spec = instances.get(id)
    if (spec === undefined) return
    const providerForSpec = resolveProvider(spec)
    // Only targets with a REAL identity verifier get a heartbeat.
    if (verifyProbe === undefined && providerForSpec.verifyUp === undefined) return
    // The healthy cadence arrives either implicit (undefined) or as the reducer's
    // stable value; both keep the jitter. Failure-driven cadences never get it.
    const healthyCadence = delayMs === undefined || delayMs === linkPolicy.healthyProbeIntervalMs
    const effectiveDelay = delayMs ?? (state.link.health === 'healthy'
      ? heartbeatCadence(state)
      : linkPolicy.suspectProbeIntervalMs)
    // Jitter belongs to the HEALTHY heartbeat only (spread N instances across the
    // minute). The failure-driven cadences are already the anti-storm mechanism;
    // jittering a 2s/10s re-probe would only blur the table's values.
    const jitter = healthyCadence && effectiveDelay >= 10_000
      ? Math.floor((doRandom() - 0.5) * effectiveDelay * 0.2)
      : 0
    const timer = setTimeout(() => {
      state.readyProbeTimer = null
      void verifyReadyTransport(id, state, 'periodic')
    }, Math.max(1, effectiveDelay + jitter))
    timer.unref?.()
    state.readyProbeTimer = timer
  }

  /** Provider verifyUp promises are contractually bounded; this is the manager's
   *  last-resort deadline so a buggy/never-settling verifier cannot freeze the
   *  heartbeat with verifyInFlight=true forever. */
  async function withProbeDeadline<T>(operation: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => {
        // Cancel the underlying operation first: a probed gateway must not finish a
        // session rotation after its deadline (and a disconnected transport must not
        // keep a request alive at all).
        onTimeout?.()
        reject(new Error('probe deadline exceeded'))
      }, timeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([operation, deadline])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * One ready-state identity re-verification — shared by the periodic heartbeat
   * and reverify(). Runs the SAME verifyUp seam as the connect-time check, so a
   * gateway 401 re-logs in once with the stored password and a revoked session
   * self-heals; failures classify exactly like connect-time (terminal →
   * failTerminal endpoint class, transient → scheduleReconnect). A transition or
   * registry change while in flight drops the result.
   */
  async function verifyReadyTransport(
    id: string,
    state: InstanceState,
    source: 'periodic' | 'user' | 'resume' | 'online' | 'failure',
  ): Promise<void> {
    if (isDisposed() || !isCurrentState(id, state) || state.phase !== 'ready') return
    if (state.verifyInFlight) {
      // A forced wake/online probe must not be lost behind the periodic heartbeat.
      if (source !== 'periodic') state.pendingForcedProbe = true
      // The timer that just fired is CONSUMED. Without a re-arm, an in-flight probe
      // of an older incarnation (or one that outlives its window) becomes the last
      // tick: the heartbeat chain dies until some other event fires.
      if (state.readyProbeTimer === null) armReadyVerify(id, state)
      return
    }
    // ONLY user reverifies are quiet-windowed. Resume/online must be able to force
    // the first probe after a network change; otherwise a ready-but-half-open
    // tunnel waits for the next heartbeat tick.
    if (source === 'user' && state.lastVerifyAt !== 0
      && Date.now() - state.lastVerifyAt < readyVerifyMinIntervalMs) return
    const spec = instances.get(id)
    if (spec === undefined) return
    const providerForSpec = resolveProvider(spec)
    // Same real-verifier gate: a target with nothing to re-check must not run the
    // trivial passthrough probe and emit a spurious 'verified'.
    if (verifyProbe === undefined && providerForSpec.verifyUp === undefined) return
    const endpoint = readyProbeEndpoint(spec, providerForSpec, state)
    if (endpoint === null) {
      // Defensive: a READY transport always has a probeable endpoint. Warn loud and
      // re-arm so this silent return never kills the periodic chain.
      warn(`transport-manager: ready-state probe skipped for ${id}: no probeable endpoint while ready`)
      if (state.readyProbeTimer === null) armReadyVerify(id, state)
      return
    }
    const epoch = state.tunnelEpoch
    // The deadline covers the WHOLE provider flow (a gateway password verify is
    // login → probe → 401 → re-login → re-probe; capping it at the single-exchange
    // budget booked a slow-but-reachable link as a network failure).
    const probeBudgetMs = probeBudgetFor(spec, providerForSpec)
    state.verifyInFlight = true
    // The probe is cancellable: the deadline aborts it (instead of leaving an orphan
    // request that could still rotate a gateway session), and so does a disconnect.
    const probeAbort = new AbortController()
    state.probeAbort = probeAbort
    let verification: TransportVerifyResult
    try {
      verification = await withProbeDeadline(doVerify(spec, endpoint, probeAbort.signal), probeBudgetMs, () => { probeAbort.abort() })
    } catch (verifyError) {
      // A throwing verifier is a transient NETWORK failure, never a crash.
      warn(`transport-manager: ready-state endpoint verification threw: ${describeTransportError(verifyError)}`)
      verification = { ok: false, detail: 'ready-state endpoint verification failed', failureKind: 'network' }
    } finally {
      state.verifyInFlight = false
      if (state.probeAbort === probeAbort) state.probeAbort = null
      if (state.pendingForcedProbe) {
        state.pendingForcedProbe = false
        queueMicrotask(() => {
          if (isDisposed() || !isCurrentState(id, state) || state.phase !== 'ready') return
          void verifyReadyTransport(id, state, 'resume')
        })
      }
    }
    // The machine may have moved while in flight — drop the stale result.
    if (isDisposed() || !isCurrentState(id, state) || state.phase !== 'ready' || epoch !== state.tunnelEpoch) return
    const completedAt = Date.now()
    state.lastVerifyAt = completedAt
    if (verification.ok) {
      applyLinkHealth(id, state, { kind: 'probe-ok', at: completedAt })
      clearDownGrace(state)
      // Chain-continuation invariant: after ANY successful verification while
      // current/ready the periodic chain must continue — a user reverify that ate
      // the tick via single-flight must restore it, or the heartbeat silently dies.
      if (state.readyProbeTimer === null) armReadyVerify(id, state)
      // A successful probe is the only moment a session may have rotated inside
      // verifyUp (401 → re-login): surface it so the proxy can re-register.
      for (const listener of bus.listeners('verified')) {
        try {
          listener(id)
        } catch (listenerError) {
          warn(`transport-manager verified listener threw: ${describeTransportError(listenerError)}`)
        }
      }
      return
    }
    const reason = verification.detail ?? 'the endpoint is not a dsh instance'
    // Providers should set failureKind explicitly. For older/custom providers the
    // fallback reads the verdict AND the status inside `detail` ("HTTP 404"), so it
    // can yield protocol just as well as network — a terminal-looking answer ends
    // the transport instead of counting toward link loss.
    const statusMatch = /\bHTTP (\d{3})\b/i.exec(verification.detail ?? '')
    const fallbackClass = classifyProbeFailure({
      ...(statusMatch === null ? {} : { statusCode: Number(statusMatch[1]) }),
      terminal: verification.terminal === true,
    })
    const failureClass: ProbeFailureClass = verification.failureKind ?? fallbackClass
    if (verification.terminal === true || failureClass === 'protocol') {
      failTerminal(id, state, reason, true, 'endpoint')
      return
    }
    // Our own bulk upload owns the tunnel's single TCP: a probe timeout inside
    // that window proves congestion, not link death. Re-probe without counting,
    // so a 20MB@2Mbps upload cannot fast-fail and tear down its own transport.
    if (failureClass === 'network' && linkBusy?.(id) === true) {
      appendLogInternal(state, 'info',
        `probe failed while a bulk upload owns the link; not counted as link loss (${reason})`)
      if (state.readyProbeTimer !== null) {
        clearTimeout(state.readyProbeTimer)
        state.readyProbeTimer = null
      }
      armReadyVerify(id, state, linkPolicy.suspectProbeIntervalMs)
      return
    }
    const reduction = applyLinkHealth(id, state, {
      kind: 'probe-failure',
      at: completedAt,
      failureClass,
      reason,
    })
    if (reduction.becameDown) {
      // Keep ready for the bounded grace: the proxy fast-fails NEW requests and
      // subscriptions through the health projection while in-flight uploads and
      // streams finish. Keep probing, or a link that recovers inside the grace
      // would still be torn down blindly at expiry. The pending healthy timer (an
      // on-demand probe may have run with it armed) must be replaced, never left
      // to swallow the grace cadence.
      armDownGrace(id, state, `ready-state verification down: ${reason}`)
      if (state.readyProbeTimer !== null) {
        clearTimeout(state.readyProbeTimer)
        state.readyProbeTimer = null
      }
      armReadyVerify(id, state, linkPolicy.suspectProbeIntervalMs)
      return
    }
    // Suspect/reachable failures keep the tunnel and re-probe on the reducer's
    // cadence. They must never revoke in-flight traffic. An on-demand probe may
    // have run while the healthy periodic timer was still armed: replace that timer
    // with the short suspect cadence instead of waiting out the old window.
    if (state.readyProbeTimer !== null) {
      clearTimeout(state.readyProbeTimer)
      state.readyProbeTimer = null
    }
    armReadyVerify(id, state, reduction.nextProbeDelayMs ?? undefined)
  }

  /**
   * One `online` wake wave. The page reports the browser event per instance, so
   * without coalescing a wake fires N probes in the same tick; the manager owns
   * the same 120ms stagger `reverifyAll` uses.
   */
  const pendingOnlineReverify = new Set<string>()
  const onlineReverifyTimers = new Set<ReturnType<typeof setTimeout>>()
  let onlineWaveTimer: ReturnType<typeof setTimeout> | null = null

  function flushOnlineWave(): void {
    onlineWaveTimer = null
    const ids = [...pendingOnlineReverify]
    pendingOnlineReverify.clear()
    let slot = 0
    for (const id of ids) {
      const delay = slot === 0 ? 0 : slot * WAKE_STAGGER_MS
      slot += 1
      if (delay === 0) {
        const current = states.get(id)
        if (current !== undefined) void verifyReadyTransport(id, current, 'online')
        continue
      }
      const timer = setTimeout(() => {
        onlineReverifyTimers.delete(timer)
        if (isDisposed()) return
        const current = states.get(id)
        if (current === undefined || current.phase !== 'ready') return
        void verifyReadyTransport(id, current, 'online')
      }, delay)
      timer.unref?.()
      onlineReverifyTimers.add(timer)
    }
  }

  function cancelOnlineWave(): void {
    pendingOnlineReverify.clear()
    if (onlineWaveTimer !== null) {
      clearTimeout(onlineWaveTimer)
      onlineWaveTimer = null
    }
    for (const timer of onlineReverifyTimers) clearTimeout(timer)
    onlineReverifyTimers.clear()
  }

  /** Epoch-ms of the last failure-driven forced probe per instance (debounce). */
  const lastFailureProbeAt = new Map<string, number>()

  /**
   * Fresh evidence from a REAL forwarded request that never got an HTTP answer
   * (socket error / proxy timeout): force ONE identity probe now instead of
   * waiting for the next heartbeat. Deliberately conservative:
   * - only while the link is still `healthy` (suspect/down already has a cadence);
   * - not while our own bulk upload owns the tunnel (congestion, not death);
   * - no overlap with an in-flight probe, and at most one per
   *   `failureProbeMinIntervalMs` (a burst of failed requests is one event).
   */
  function notifyLinkFailure(id: string): void {
    const state = states.get(id)
    if (state === undefined || state.phase !== 'ready') return
    if (state.link.health !== 'healthy') return
    if (linkBusy?.(id) === true) return
    if (state.verifyInFlight) {
      // The in-flight probe is about to produce a fresher verdict than this
      // request-level observation (it succeeds ⇒ the link is up now and the failed
      // request was a host-level problem; it fails ⇒ the cadence already owns the
      // verdict). Queueing another forced probe here would double every probe under
      // a burst and defeat the throttle.
      return
    }
    const now = Date.now()
    if (!Number.isFinite(now)) return
    if (now - (lastFailureProbeAt.get(id) ?? 0) < linkPolicy.failureProbeMinIntervalMs) return
    lastFailureProbeAt.set(id, now)
    void verifyReadyTransport(id, state, 'failure')
  }

  /** Public on-demand ready-state re-verification (desktop_ssh_reverify): one
   *  immediate identity probe for the instance the user is about to act on, so a
   *  dead session/endpoint flips within one round-trip. No-op unless ready. */
  function reverify(id: string, reason: 'user' | 'resume' | 'online' = 'user'): TransportStatusProjection | null {
    const state = states.get(id)
    if (state === undefined) return status(id)
    if (reason === 'online') {
      pendingOnlineReverify.add(id)
      if (onlineWaveTimer === null) {
        onlineWaveTimer = setTimeout(flushOnlineWave, 0)
        onlineWaveTimer.unref?.()
      }
      return status(id)
    }
    void verifyReadyTransport(id, state, reason)
    return status(id)
  }

  /** Re-probe every READY remote after an OS/network wake. Suspect/down included;
   *  a healthy link is also probed so a ready-but-half-open tunnel cannot wait
   *  for the next heartbeat tick. Error/degraded instances are handled by connect(). */
  function reverifyAll(): void {
    const generation = ++reverifyGeneration
    for (const timer of reverifyTimers) clearTimeout(timer)
    reverifyTimers.clear()
    let slot = 0
    for (const id of instances.keys()) {
      const state = states.get(id)
      if (state === undefined || state.phase !== 'ready') continue
      const delay = slot === 0 ? 0 : slot * WAKE_STAGGER_MS
      slot += 1
      if (delay === 0) {
        void verifyReadyTransport(id, state, 'resume')
        continue
      }
      const timer = setTimeout(() => {
        reverifyTimers.delete(timer)
        if (generation !== reverifyGeneration) return
        const current = states.get(id)
        if (current === undefined || current !== state || current.phase !== 'ready') return
        void verifyReadyTransport(id, state, 'resume')
      }, delay)
      timer.unref?.()
      reverifyTimers.add(timer)
    }
  }

  function cancelReverify(): void {
    reverifyGeneration += 1
    for (const timer of reverifyTimers) clearTimeout(timer)
    reverifyTimers.clear()
  }

  return {
    armDownGrace, heartbeatCadence, armReadyVerify, flushOnlineWave, cancelOnlineWave,
    notifyLinkFailure, reverify, reverifyAll, cancelReverify, lastFailureProbeAt, withProbeDeadline,
  }
}
