/**
 * Bounded, verified convergence chain for purged-row suppression (design 24
 * §21). React-free and dependency-injected so the arm → verify → retry →
 * give-up behaviour is node-testable without a plugin host (the producer
 * itself imports React/CSS and cannot be imported by a node test).
 *
 * WHY A CHAIN AND NOT A SINGLE refresh() CALL (2026-09 修正轮 review findings):
 *   - the OFFICIAL refresh is single-flight (`SessionManager.refreshList`
 *     returns the in-flight promise), so a request that collides with a
 *     pre-purge pull resolves with the STALE response and schedules no
 *     trailing run → one call is not convergence;
 *   - a failed pull RESOLVES (the manager catches RemoteFailure, sets
 *     `listState='error'` and leaves the summaries untouched) while other
 *     failures reject → both outcomes must be retried;
 *   - a hung refresh promise would otherwise disable the seam forever (the
 *     official single-flight then hands the same hung promise to every later
 *     caller), so each attempt is raced with a watchdog.
 *
 * TERMINATION = AUTHORITATIVE PROBE, NOT "resolved" (2026-09 review rounds):
 * `refreshList` resolving does NOT prove the summaries are authoritative — it
 * also resolves on a failed pull and for a joined stale single-flight caller —
 * so a resolve can never release a suppression (an early revision did, and the
 * closure review proved it re-opened the ghost-row bug). When the bounded
 * refresh attempts leave ids listed, the chain therefore consults an
 * INDEPENDENT authoritative row source (`probe`: the chamber's own unary
 * `session.list`, a fresh per-call disk rescan that has neither the official
 * single-flight nor its cache) and releases ONLY the ids that source still
 * contains; ids it does not contain stay suppressed (the content is gone, the
 * official client merely failed to converge). A probe that fails/times out
 * keeps the suppression and warns. This closes the non-purge-shrink residual
 * (future unarchive/delete wire, out-of-band archive-media rewrite) without
 * ever un-hiding a purged row.
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
 * Pure one-attempt decision (see the module header for the rationale).
 * @param opts.attempt - 1-based attempt number just settled.
 * @param opts.maxAttempts - hard attempt bound (>= 1).
 * @param opts.lingering - suppressed ids the official summaries STILL list.
 * @returns the next step. `verify` is terminal: the caller consults the
 *   authoritative probe (and keeps the suppression for whatever the probe
 *   does not confirm).
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
 * Pure release selection: ONLY ids an authoritative source confirmed still
 * exists may be un-suppressed. Everything else stays suppressed.
 * @param lingering - suppressed ids the official summaries still list.
 * @param present - ids the authoritative probe returned.
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
   * One official session-list refresh. MUST be invoked as a method on the
   * service object (`service.refresh()`): `ClientSessions.refresh` is a
   * prototype method reading `this.manager`, so a detached call throws
   * TypeError (2026-09 review BLOCKER — the §20 seam never actually ran).
   * Returns undefined when the official client exposes no refresh face.
   */
  refresh: () => Promise<unknown> | undefined
  /** Suppressed ids still listed by the official summaries. */
  lingering: () => readonly string[]
  /**
   * Independent authoritative row source (the chamber's own unary
   * `session.list`: a fresh per-call disk rescan, no single-flight, no
   * client cache). Resolves to the ids the instance still has; undefined or a
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
   * Start (or join) the chain. A request arriving while the chain is running
   * is coalesced into it — the attempt budget is per purge, not per request
   * (2026-09 review MINOR: a bridge request must not restart the bound).
   */
  converge(): void
  /** Cancel any pending timer; a settled attempt issues nothing further. */
  dispose(): void
  /** True while an attempt or its retry is outstanding (test/observability seam). */
  active(): boolean
}

/**
 * Build one source's convergence chain. PURE with respect to I/O: every
 * effect (refresh, timers, warn) arrives through `deps`.
 * @param deps - injectable seams.
 * @returns the chain handle.
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
  // Terminal probes own PER-PROBE watchdog handles (a set, not one shared
  // slot): reusing a single slot let a probe that outlived its own watchdog
  // clear a LATER attempt's — or a LATER PROBE's — watchdog, wedging the chain
  // active forever (2026-09 scan MAJOR-1 + final-verify finding 3).
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
   * Terminal step: consult the INDEPENDENT authoritative probe and release
   * ONLY ids it confirms. A probe that is absent, rejects or times out keeps
   * every suppression (no authoritative answer ≠ "not purged").
   */
  const verifyAgainstProbe = (outcome: ConvergenceOutcome): void => {
    const noAnswer = (): string => outcome === 'resolved'
      ? `the official refresh kept listing them after ${attempt} attempt(s)`
      : `the official refresh produced no authoritative answer after ${attempt} attempt(s)`
    // Snapshot the suppression set BEFORE the probe: an id tombstoned while
    // the probe is in flight must NOT be judged against a probe answer that
    // predates it (2026-09 scan MINOR-3 — a stale probe could release a
    // genuinely purged id and re-emit its row).
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
    // One handle PER PROBE: a late settlement of THIS probe may only clear
    // its own watchdog, never a later probe's.
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
   * Settle one attempt. `settledAttempt` fences late settlements: an attempt
   * that already timed out must not be judged as — or terminate — a later one
   * (2026-09 closure-review D2).
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
