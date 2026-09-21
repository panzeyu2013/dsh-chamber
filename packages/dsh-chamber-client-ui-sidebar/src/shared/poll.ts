/**
 * The chamber polling kernel (single-source for the four poll loops that used
 * to carry their own deadline/sleep/backoff plumbing): the gateway restart/
 * start readiness poll, the remote dsh-runtime settle poll, the source serving
 * gate and the purge-time running-bit settle wait.
 *
 * The kernel owns ONLY the loop shape — budget check, probe, verdict, wait —
 * and the one default sleep. Every caller keeps its own:
 *   - probe (what one round reads);
 *   - classify (what a round means: done / fail / retry / stop);
 *   - budget (an absolute `deadline` or a fixed `attempts` count) and the
 *     wording of its timeout error (the kernel returns `undefined` when the
 *     budget runs out and lets the caller phrase it).
 *
 * First-round semantics are explicit because the callers genuinely differ:
 * the deadline pollers check the budget BEFORE the first probe (timeout 0 =
 * no probe, no sleep), while the serving gate probes once and only then tests
 * its deadline; `probeFirstRound` + a classify that checks the deadline keep
 * that shape without a second loop.
 */

/** The one default sleep of the package (deps seams still override it). */
export const sleepMs = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

/** What one classified probe round means. */
export type PollOutcome<T> =
  /** The poll succeeded; stop with this value. */
  | { kind: 'done'; value: T }
  /** Terminal failure; the kernel throws this error. */
  | { kind: 'fail'; error: unknown }
  /** Budget-independent stop (e.g. the purge probe failed); resolve `undefined`. */
  | { kind: 'stop' }
  /** Not settled yet; wait and probe again. */
  | { kind: 'retry' }

/** Facts about the round being classified. */
export interface PollRoundInfo {
  /** 1-based probe round number. */
  round: number
  /** True when this is the last round the budget allows (attempts mode exact;
   *  deadline mode approximate — the deadline would pass before another round). */
  last: boolean
}

export interface PollUntilOptions<Probe, Done = Probe> {
  /** One round's read. A rejection is handled by `onProbeError`. */
  probe: () => Promise<Probe> | Probe
  /** What this round's value means (`Done` may differ from the probe shape). */
  classify: (result: Probe, info: PollRoundInfo) => PollOutcome<Done>
  /** Wait between probe rounds (ms). */
  intervalMs: number
  /** Absolute epoch-ms budget; the loop gives up once `now() >= deadline`. */
  deadline?: number
  /** Fixed probe-round budget (mutually exclusive with `deadline`). */
  attempts?: number
  /** Wait BEFORE each probe (attempts mode); default false = probe first. */
  waitFirst?: boolean
  /** Probe the first round even when the deadline has already passed. */
  probeFirstRound?: boolean
  /** Probe rejection handling; default = rethrow the error. */
  onProbeError?: (error: unknown) => PollOutcome<Done>
  /** Wait implementation (default {@link sleepMs}); abort-aware callers pass their own. */
  sleep?: (ms: number) => Promise<void>
  /** Clock seam (tests). */
  now?: () => number
}

/**
 * Run the poll loop; resolve the classified value, or `undefined` when the
 * budget runs out (the caller owns the timeout wording).
 * @param options - probe/classify plus the budget and wait seams.
 * @returns the done value, or undefined on budget exhaustion / `stop`.
 */
export async function pollUntil<Probe, Done = Probe>(options: PollUntilOptions<Probe, Done>): Promise<Done | undefined> {
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? sleepMs
  const { attempts, deadline, intervalMs, probe, classify } = options
  const exhausted = (): boolean =>
    attempts !== undefined ? false : deadline !== undefined && now() >= deadline
  let round = 0
  for (;;) {
    if (attempts !== undefined && round >= attempts) return undefined
    if (exhausted() && !(options.probeFirstRound === true && round === 0)) return undefined
    if (options.waitFirst === true) {
      await sleep(intervalMs)
      if (exhausted()) return undefined
    }
    round += 1
    const last = attempts !== undefined
      ? round >= attempts
      : deadline !== undefined && now() + intervalMs >= deadline
    let result: Probe
    try {
      result = await probe()
    } catch (error) {
      const verdict = options.onProbeError?.(error) ?? { kind: 'fail', error }
      if (verdict.kind === 'done') return verdict.value
      if (verdict.kind === 'stop') return undefined
      if (verdict.kind === 'fail') throw verdict.error
      if (options.waitFirst !== true) await sleep(intervalMs)
      continue
    }
    const verdict = classify(result, { round, last })
    if (verdict.kind === 'done') return verdict.value
    if (verdict.kind === 'stop') return undefined
    if (verdict.kind === 'fail') throw verdict.error
    if (options.waitFirst !== true) await sleep(intervalMs)
  }
}
