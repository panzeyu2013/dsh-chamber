/**
 * The chamber polling kernel — the single source for the package's four poll
 * loops (gateway restart/start readiness, remote dsh-runtime settle, source
 * serving gate, purge-time running-bit settle wait). It owns ONLY the loop
 * shape (budget check, probe, verdict, wait) and the one default sleep; every
 * caller keeps its own probe, classify (done / fail / retry / stop), budget
 * (absolute `deadline` or fixed `attempts`) and timeout wording (the kernel
 * returns `undefined` on budget exhaustion). First-round semantics are explicit:
 * deadline pollers check the budget BEFORE the first probe (timeout 0 = no
 * probe, no sleep), while the serving gate probes once and only then tests its
 * deadline — `probeFirstRound` plus a deadline-checking classify keep that shape.
 */

/** The one default sleep of the package (deps seams still override it). */
export const sleepMs = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

/** What one classified probe round means. */
export type PollOutcome<T> =
  | { kind: 'done'; value: T }
  /** Terminal failure; the kernel throws this error. */
  | { kind: 'fail'; error: unknown }
  /** Budget-independent stop (e.g. the purge probe failed); resolve `undefined`. */
  | { kind: 'stop' }
  | { kind: 'retry' }

export interface PollRoundInfo {
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
  now?: () => number
}

/** Run the poll loop; resolve the classified value, or `undefined` when the budget
 *  runs out (the caller owns the timeout wording). */
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
