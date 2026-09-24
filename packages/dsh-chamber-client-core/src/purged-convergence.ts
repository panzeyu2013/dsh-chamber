/**
 * Bounded, verified convergence chain for purged-row suppression. React-free and
 * dependency-injected so arm → verify → retry → give-up is node-testable without a
 * plugin host.
 *
 * WHY A CHAIN, NOT A SINGLE refresh(): the OFFICIAL refresh is single-flight
 * (`SessionManager.refreshList` returns the in-flight promise), so a request that
 * collides with a pre-purge pull resolves with the STALE response and schedules no
 * trailing run; a failed pull RESOLVES (the manager catches RemoteFailure, sets
 * `listState='error'`, leaves the summaries untouched) while other failures reject —
 * both must be retried; and a hung promise would otherwise disable the seam forever,
 * so each attempt is raced with a watchdog.
 *
 * TERMINATION = AUTHORITATIVE PROBE, NOT "resolved": `refreshList` resolving does NOT
 * prove the summaries are authoritative (it also resolves on a failed pull and for a
 * joined stale single-flight caller), so the terminal step consults an INDEPENDENT row
 * source (`probe`: the chamber's own unary `session.list`, a fresh per-call disk
 * rescan) and releases ONLY the ids it still contains; the rest stay suppressed (the
 * content is gone, the client merely failed to converge). A failing/timing-out probe
 * keeps the suppression and warns.
 */
import { PURGED_REFRESH_MAX_ATTEMPTS, PURGED_REFRESH_RETRY_MS } from './purged-rows.ts'

/** Outcome of one refresh attempt. */
export type ConvergenceOutcome = 'resolved' | 'rejected' | 'timeout'

/** What the chain should do after one attempt. */
export type ConvergenceStep =
  | { action: 'converged' }
  | { action: 'retry' }
  | { action: 'verify' }

/**
 * Pure one-attempt decision: `verify` is terminal — the caller then consults the
 * authoritative probe and keeps the suppression for whatever it does not confirm.
 * @returns the next step.
 */
export function nextConvergenceStep(opts: {
  attempt: number
  maxAttempts: number
  lingering: readonly string[]
}): ConvergenceStep {
  if (opts.lingering.length === 0) return { action: 'converged' }
  return opts.attempt >= opts.maxAttempts ? { action: 'verify' } : { action: 'retry' }
}

/**
 * Pure release selection: ONLY ids an authoritative source confirmed still exists may
 * be un-suppressed.
 * @returns the subset of `lingering` present in `present` (order preserved).
 */
export function releasableAfterProbe(
  lingering: readonly string[],
  present: ReadonlySet<string>,
): string[] {
  return lingering.filter(id => present.has(id))
}

/** Injectable seams (tests pass fakes; the producer passes the real ones). */
export interface PurgedConvergenceDeps {
  /**
   * One official session-list refresh. MUST be invoked as a method on the service
   * object (`service.refresh()`): `ClientSessions.refresh` is a prototype method
   * reading `this.manager`, so a detached call throws TypeError. Undefined when the
   * client exposes no refresh face.
   */
  refresh: () => Promise<unknown> | undefined
  /** Suppressed ids still listed by the official summaries. */
  lingering: () => readonly string[]
  /**
   * Independent authoritative row source (the chamber's own unary `session.list`: a
   * fresh per-call disk rescan, no single-flight, no client cache). Undefined or a
   * rejection means "no authoritative answer" (suppression is kept).
   */
  probe?: () => Promise<ReadonlySet<string> | undefined> | undefined
  /** Drop suppression for ids the authoritative probe confirmed. */
  release?: (ids: readonly string[]) => void
  /** Honest terminal/warn reporting. */
  warn: (message: string) => void
  /** Timer seams (defaults: global setTimeout/clearTimeout). */
  schedule?: (run: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
  /** Attempt bound; defaults to {@link PURGED_REFRESH_MAX_ATTEMPTS}. */
  maxAttempts?: number
  /** Spacing between attempts; defaults to {@link PURGED_REFRESH_RETRY_MS}. */
  retryMs?: number
  /** Per-attempt watchdog for a hung refresh (0 disables; default 2x retryMs). */
  attemptTimeoutMs?: number
}

export interface PurgedConvergenceChain {
  /**
   * Start (or join) the chain. A request arriving while the chain runs is coalesced
   * into it — the attempt budget is per purge, not per request.
   */
  converge(): void
  /** Cancel any pending timer; a settled attempt issues nothing further. */
  dispose(): void
  /** True while an attempt or its retry is outstanding (test/observability seam). */
  active(): boolean
}

/**
 * Build one source's convergence chain. PURE w.r.t. I/O: every effect (refresh,
 * timers, warn) arrives through `deps`. @returns the chain handle.
 */
export function createPurgedConvergence(deps: PurgedConvergenceDeps): PurgedConvergenceChain {
  const maxAttempts = Math.max(1, deps.maxAttempts ?? PURGED_REFRESH_MAX_ATTEMPTS)
  const retryMs = deps.retryMs ?? PURGED_REFRESH_RETRY_MS
  const attemptTimeoutMs = deps.attemptTimeoutMs ?? retryMs * 2
  const schedule = deps.schedule ?? ((run, ms) => setTimeout(run, ms))
  const cancel = deps.cancel ?? ((handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })

  let attempt = 0
  let running = false
  let disposed = false
  let timer: unknown
  let watchdog: unknown
  // Terminal probes own PER-PROBE watchdog handles (a set, not one shared slot): a
  // shared slot would let a probe outliving its watchdog clear a LATER probe's and wedge
  // the chain active forever.
  const probeWatchdogs = new Set<unknown>()

  const clearTimer = (): void => {
    if (timer !== undefined) {
      cancel(timer)
      timer = undefined
    }
  }
  const clearWatchdog = (): void => {
    if (watchdog !== undefined) {
      cancel(watchdog)
      watchdog = undefined
    }
  }
  const clearProbeWatchdog = (handle: unknown): void => {
    if (probeWatchdogs.delete(handle)) cancel(handle)
  }
  const clearAllProbeWatchdogs = (): void => {
    for (const handle of probeWatchdogs) cancel(handle)
    probeWatchdogs.clear()
  }
  const finish = (): void => {
    clearTimer()
    clearWatchdog()
    clearAllProbeWatchdogs()
    running = false
  }

  /**
   * Terminal step: consult the INDEPENDENT authoritative probe and release ONLY ids it
   * confirms. A probe that is absent, rejects or times out keeps every suppression (no
   * answer ≠ "not purged").
   */
  const verifyAgainstProbe = (outcome: ConvergenceOutcome): void => {
    const noAnswer = (): string => outcome === 'resolved'
      ? `the official refresh kept listing them after ${attempt} attempt(s)`
      : `the official refresh produced no authoritative answer after ${attempt} attempt(s)`
    // Snapshot the suppression set BEFORE the probe: an id tombstoned while the probe is
    // in flight must not be judged against a probe answer that predates it (a stale probe
    // could release a genuinely purged id and re-emit its row).
    const lingering = deps.lingering()
    if (lingering.length === 0) {
      finish()
      return
    }
    if (deps.probe === undefined) {
      deps.warn(`purged rows stay suppressed: ${noAnswer()} and no authoritative session-list probe is available`)
      finish()
      return
    }
    const pending = deps.probe()
    if (pending === undefined) {
      deps.warn(`purged rows stay suppressed: ${noAnswer()} and the instance session-list probe is unavailable`)
      finish()
      return
    }
    // One handle PER PROBE: a late settlement of THIS probe may only clear its own watchdog.
    let probeHandle: unknown
    const clearThisProbe = (): void => { clearProbeWatchdog(probeHandle) }
    const probed: Promise<ReadonlySet<string> | undefined> = attemptTimeoutMs > 0
      ? new Promise<ReadonlySet<string> | undefined>((resolve) => {
        probeHandle = schedule(() => {
          probeWatchdogs.delete(probeHandle)
          resolve(undefined)
        }, attemptTimeoutMs)
        probeWatchdogs.add(probeHandle)
        void Promise.resolve(pending).then(
          (present) => { clearThisProbe(); resolve(present) },
          () => { clearThisProbe(); resolve(undefined) },
        )
      })
      : Promise.resolve(pending).then(
        (present) => present,
        () => undefined,
      )
    void probed.then((present) => {
      clearThisProbe()
      if (disposed) return
      try {
        if (present === undefined) {
          deps.warn(`purged rows stay suppressed: ${noAnswer()} and the instance session-list probe gave no ` +
            'authoritative answer')
          return
        }
        const releasable = releasableAfterProbe(lingering, present)
        if (releasable.length > 0) {
          deps.release?.(releasable)
          deps.warn(`released the purged-row suppression for ${releasable.length} session(s) the instance still lists ` +
            '— the archive-set shrink was not a content purge')
        }
        const remaining = lingering.filter(id => !releasable.includes(id))
        if (remaining.length > 0) {
          deps.warn(`purged rows still listed in the official session summaries after ${attempt} refresh attempt(s) ` +
            `(${remaining.length} row(s)) — they stay suppressed until the summaries converge (a connection generation at the latest)`)
        }
      } finally {
        // A throwing release/warn callback must never leave the chain active.
        finish()
      }
    })
  }

  /**
   * Settle one attempt. `settledAttempt` fences late settlements: an attempt that
   * already timed out must not be judged as — or terminate — a later one.
   */
  const settle = (settledAttempt: number, outcome: ConvergenceOutcome): void => {
    if (disposed || !running || settledAttempt !== attempt) return
    clearWatchdog()
    const lingering = deps.lingering()
    const decision = nextConvergenceStep({ attempt, maxAttempts, lingering })
    if (decision.action === 'converged') {
      finish()
      return
    }
    if (decision.action === 'verify') {
      verifyAgainstProbe(outcome)
      return
    }
    clearTimer()
    timer = schedule(() => { timer = undefined; runAttempt() }, retryMs)
  }

  const runAttempt = (): void => {
    if (disposed) {
      running = false
      return
    }
    attempt += 1
    const current = attempt
    const pending = deps.refresh()
    if (pending === undefined) {
      // No official refresh face: keep the suppression, nothing to verify with.
      deps.warn('official session-list refresh is unavailable — purged rows stay suppressed until a connection generation')
      finish()
      return
    }
    const resolved: Promise<ConvergenceOutcome> = Promise.resolve(pending).then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    )
    const raced = attemptTimeoutMs > 0
      ? Promise.race([
        resolved,
        new Promise<ConvergenceOutcome>((resolve) => {
          watchdog = schedule(() => { watchdog = undefined; resolve('timeout') }, attemptTimeoutMs)
        }),
      ])
      : resolved
    void raced.then((outcome) => { settle(current, outcome) })
  }

  return {
    converge(): void {
      if (disposed || running) return
      running = true
      attempt = 0
      runAttempt()
    },
    dispose(): void {
      disposed = true
      finish()
    },
    active(): boolean {
      return running
    },
  }
}
