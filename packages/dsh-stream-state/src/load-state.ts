/**
 * B5: the shell's explicit load state machine.
 *
 * WHY THIS EXISTS. The native shell's load bookkeeping was three independent
 * booleans scattered across two Swift files, and each one had a defect that only
 * shows on a real machine:
 *
 *   1. `didStartLoading` latched with NO reset point - once set, a later
 *      generation could never re-enter the loading state (the latch survived the
 *      sidecar restart that invalidated it);
 *   2. `webViewContentAlive` could report TRUE while the page was a failure face
 *      or a blank shell (it answered "did a load ever commit", not "is there
 *      content");
 *   3. a probe ERROR was recorded as if the probe had succeeded (an unreachable
 *      sidecar could therefore look healthy).
 *
 * The fix is one state machine with an explicit `generation`: every event carries
 * the generation it belongs to, and an event from a superseded generation is
 * DROPPED rather than applied. That single rule dissolves (1) - a new generation
 * starts at `cold` again - while (2) and (3) become state predicates: content is
 * only believable in `loaded`, and a failed probe is a strike, never a success.
 *
 * PURITY (enforced by scripts/test.mjs): this module imports NOTHING. The Swift
 * mirror reads `tables.json` and is locked to the same phase names and thresholds
 * by scripts/gates/verify-stream-state-swift-parity.mjs.
 */

/** The phases, in the order a healthy shell visits them. `retrying` and
 *  `failurePage` are the two recovery faces. */
export type LoadPhase = 'cold' | 'probing' | 'loading' | 'loaded' | 'retrying' | 'failurePage'

export interface LoadState {
  readonly phase: LoadPhase
  /** Every event belongs to a generation; a stale one is ignored. */
  readonly generation: number
  /** Consecutive failed probes in THIS generation (reset by a success). */
  readonly probeStrikes: number
  /** A crash recovery is in flight: cleared when content is honestly alive. */
  readonly recoveringFromCrash: boolean
  /** The one-shot give-up gate: consumed when the failure page is shown. */
  readonly giveUpSpent: boolean
  /** When the current load armed, for the progress SLA. Null while not loading. */
  readonly loadingSinceMs: number | null
}

export interface LoadEnv {
  /** Failed probes before the shell moves to `retrying`. */
  readonly probeStrikeLimit: number
  /** Retries before the give-up gate may fire. */
  readonly retryLimit: number
  /** Loads this long without content are late (the SLA the shell reports). */
  readonly progressSlaMs: number
}

export type LoadEffect =
  | { readonly e: 'scheduleRecovery'; readonly generation: number }
  | { readonly e: 'showFailurePage' }
  | { readonly e: 'log'; readonly name: string; readonly detail: string }

export type LoadEvent =
  /** A new sidecar/web generation exists: the shell restarts its bookkeeping. */
  | { readonly kind: 'generationStarted'; readonly generation: number; readonly at: number }
  /** WebKit began a load for this generation (`didStartLoading`). */
  | { readonly kind: 'loadStarted'; readonly generation: number; readonly at: number }
  /** The page reports it is alive AND has content. Only believed in `loaded`. */
  | { readonly kind: 'contentAlive'; readonly generation: number; readonly at: number }
  | { readonly kind: 'probeSucceeded'; readonly generation: number; readonly at: number }
  /** A probe FAILED: a strike, never a success (defect 3). */
  | { readonly kind: 'probeFailed'; readonly generation: number; readonly at: number }
  | { readonly kind: 'recoveryScheduled'; readonly generation: number; readonly at: number }
  | { readonly kind: 'recoveryFailed'; readonly generation: number; readonly at: number }
  | { readonly kind: 'crashRecovered'; readonly generation: number; readonly at: number }

export function initialLoadState(): LoadState {
  return {
    phase: 'cold',
    generation: 0,
    probeStrikes: 0,
    recoveringFromCrash: false,
    giveUpSpent: false,
    loadingSinceMs: null,
  }
}

/** Whether the shell may present real content for this state. The honest answer
 *  to "webViewContentAlive": NOT a boolean the page sets, but this predicate. */
export function contentIsBelievable(state: LoadState): boolean {
  return state.phase === 'loaded'
}

/** Whether the load has outlived its progress SLA (the shell reports this, it does
 *  not act on it: the retry schedule is what acts).
 *
 *  LATE IS A PHASE PREDICATE. `loadingSinceMs` is an arming stamp, not a status:
 *  probeSucceeded/recoveryFailed used to leave it behind, so a settled shell with a
 *  stale stamp read as late forever. Only an ACTIVE load can outlive its SLA, and a
 *  non-finite or rolled-back clock can never make it late (I4). */
export function loadIsLate(state: LoadState, now: number, env: LoadEnv): boolean {
  if (state.phase !== 'loading' || state.loadingSinceMs === null) return false
  const elapsed = now - state.loadingSinceMs
  return Number.isFinite(elapsed) && elapsed > env.progressSlaMs
}

export function reduceLoadState(
  state: LoadState,
  event: LoadEvent,
  env: LoadEnv,
): { readonly state: LoadState; readonly effects: readonly LoadEffect[] } {
  // The generation fence, in one place: everything except a NEW generation is
  // dropped when it belongs to a superseded one. Defect 1 (the permanent latch)
  // cannot exist under this rule.
  if (event.kind !== 'generationStarted' && event.generation !== state.generation) {
    return { state, effects: [] }
  }

  switch (event.kind) {
    case 'generationStarted':
      // A restarted sidecar invalidates every fact the old generation carried.
      if (event.generation <= state.generation) return { state, effects: [] }
      return {
        state: {
          ...state,
          phase: 'cold',
          generation: event.generation,
          probeStrikes: 0,
          giveUpSpent: false,
          loadingSinceMs: null,
        },
        effects: [{ e: 'log', name: 'load-generation', detail: String(event.generation) }],
      }

    case 'loadStarted':
      // Arming is per-generation, so a load that begins again after a failure is
      // believed again (the old latch would have refused it).
      return {
        state: { ...state, phase: 'loading', loadingSinceMs: event.at },
        effects: [],
      }

    case 'contentAlive':
      // Defect 2: content is only believable in `loaded`, and this event is what
      // puts it there - a page that claims content while probing/retrying is not
      // believed.
      return {
        state: {
          ...state,
          phase: 'loaded',
          probeStrikes: 0,
          recoveringFromCrash: false,
          loadingSinceMs: null,
        },
        effects: [],
      }

    case 'probeSucceeded':
      return { state: { ...state, phase: 'loaded', probeStrikes: 0, loadingSinceMs: null }, effects: [] }

    case 'probeFailed': {
      // Defect 3: a failed probe is a STRIKE. It never marks the shell loaded.
      const probeStrikes = state.probeStrikes + 1
      if (probeStrikes >= env.probeStrikeLimit) {
        return {
          state: { ...state, probeStrikes, phase: 'retrying', loadingSinceMs: state.loadingSinceMs ?? event.at },
          effects: [
            { e: 'log', name: 'probe-failed', detail: String(probeStrikes) },
            { e: 'scheduleRecovery', generation: state.generation },
          ],
        }
      }
      return {
        state: { ...state, probeStrikes, phase: state.phase === 'loaded' ? 'probing' : state.phase },
        effects: [{ e: 'log', name: 'probe-failed', detail: String(probeStrikes) }],
      }
    }

    case 'recoveryScheduled':
      return {
        state: { ...state, phase: 'retrying', recoveringFromCrash: true, loadingSinceMs: state.loadingSinceMs ?? event.at },
        effects: [],
      }

    case 'recoveryFailed': {
      // The give-up gate is one-shot: the failure page is shown at most once per
      // generation, so a retry storm cannot re-announce it.
      if (state.giveUpSpent) {
        return { state, effects: [{ e: 'log', name: 'recovery-failed-again', detail: String(event.generation) }] }
      }
      return {
        state: { ...state, phase: 'failurePage', giveUpSpent: true, recoveringFromCrash: false, loadingSinceMs: null },
        effects: [{ e: 'showFailurePage' }],
      }
    }

    case 'crashRecovered':
      return {
        state: { ...state, recoveringFromCrash: false, phase: 'probing', probeStrikes: 0, loadingSinceMs: null },
        effects: [],
      }

    default:
      return { state, effects: [] }
  }
}
