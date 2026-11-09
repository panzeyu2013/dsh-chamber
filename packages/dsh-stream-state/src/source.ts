/**
 * Source (per-instance view) lifecycle state - the pure core: one object carries every
 * per-source ledger, keyed by ONE identity, SourceIncarnation = (sourceId, fingerprint).
 *
 * PURITY: no imports, no clock reads; every duration arrives on the event.
 */

/** The lifecycle identity of one source view: a fingerprint change is a NEW incarnation
 * (the shell is retired and re-mounted), while the same pair is always the same one. */
export interface SourceIncarnation {
  readonly sourceId: string
  /** 64-hex proof from the ownership registry; 'local' for the local instance. */
  readonly fingerprint: string
}

/** Harvest bookkeeping, kept here so the source object is the single owner. */
export interface HarvestState {
  readonly attempts: number
  readonly mountedAt: number
  readonly retryAt: number
  readonly satisfied: boolean
}

export interface SourceLifecycleState {
  readonly incarnation: SourceIncarnation
  /** Settled boot state: null while booting. */
  readonly boot: { readonly outcome: 'booted' | 'degraded' | 'failed'; readonly kind?: string } | null
  /** The source phase projection this object last observed ('ready' | 'idle' | ...). */
  readonly phase: string | undefined
  /** Once-per-ready-epoch degraded self-heal mark, scoped to the MOUNT. */
  readonly degradedRetried: boolean
  /**
   * A settled-degraded mount with a retryable gap whose ready epoch has not been seen
   * yet. The arm is a FACT (the settle), never a moment: a settle that lands before the
   * source turns ready used to lose the self-heal entirely, because the emit was gated
   * on the ready phase at the settle tick and nothing re-armed it afterwards - only a
   * page reload could recover (real-machine P4/P5). Cleared when the heal is emitted and
   * by retryForgotten.
   */
  readonly healPending: boolean
  /** Background boots that own the single prewarm slot. */
  readonly autoPrewarmed: boolean
  /** A release forbade automatic prewarm for this incarnation until a user act. */
  readonly prewarmSuppressed: boolean
  /** User/overlay abandoned this view while switching away. */
  readonly abandoned: boolean
  /** Where an abandoned view was switched TO. Kept beside the boolean: one answers "is
   * it abandoned", the other "who inherited it", and different callers read each. */
  readonly abandonedTarget?: string
  readonly harvest: HarvestState | null
  /** Manual/auto retry counter. */
  readonly retryToken: number
}

export function initialSourceLifecycle(incarnation: SourceIncarnation): SourceLifecycleState {
  return {
    incarnation,
    boot: null,
    phase: undefined,
    degradedRetried: false,
    healPending: false,
    autoPrewarmed: false,
    prewarmSuppressed: false,
    abandoned: false,
    harvest: null,
    retryToken: 0,
  }
}

/** Events the source reducer understands. Unknown kinds are no-ops (total). */
export type SourceEvent =
  | { readonly kind: 'bootSettled'; readonly outcome: 'booted' | 'degraded' | 'failed'; readonly gapKind?: string }
  | { readonly kind: 'phaseChanged'; readonly phase: string | undefined }
  | { readonly kind: 'abandoned'; readonly target?: string }
  /** The abandonment mark is revoked (the switch that caused it was not delivered). */
  | { readonly kind: 'abandonmentCleared' }
  /** The caller computed the finished harvest record with baseline-harvest's pure
   * functions and hands it over whole, keeping those functions the policy and the
   * container the storage. */
  | { readonly kind: 'harvestRecord'; readonly record: HarvestState }
  /** The harvest entry is dropped with the source (the registry sweep). */
  | { readonly kind: 'harvestCleared' }
  /** The once-per-ready-epoch self-heal mark is dropped because the mount it belonged to
   * is gone - narrower than a full reset: it clears ONLY the mark, leaving the boot outcome
   * and the prewarm suppression as they are. */
  | { readonly kind: 'retryForgotten' }
  /** An automatic background prewarm claimed its slot for this source. It records ORIGIN
   * (prewarmed, not user-chosen). */
  | { readonly kind: 'prewarmStarted' }
  /** The origin flag is dropped because the claim it recorded is over (the shell was
   * consumed as a warm hit, reclaimed, or its source left the registry). Narrower than a
   * user act, so a prune can forget the origin without a full reset. */
  | { readonly kind: 'prewarmForgotten' }
  /** The suppression is dropped because its ledger entry is gone (registry sweep /
   * retirement). It clears ONLY the suppression and asks for no boot. */
  | { readonly kind: 'prewarmSuppressionForgotten' }
  /** A release forbids automatic prewarming for this source (its warm shell was just
   * collected) until a user act clears it. */
  | { readonly kind: 'prewarmSuppressed' }

export interface SourceReduction {
  readonly state: SourceLifecycleState
  /** Typed effects the App performs; the reducer never touches the shell. */
  readonly effects: readonly SourceEffect[]
}

export type SourceEffect =
  /** Ask the sidebar to re-boot a settled-degraded mount (once per ready epoch). */
  { readonly e: 'degradedSelfHeal' }

/** Degraded gaps a re-boot can plausibly fix (boot-gap's verdict, carried in). */
export interface SourceEnv {
  readonly retryableGap: (kind: string | undefined) => boolean
}

/**
 * One reduction step. Total function: every (state, event) returns a state.
 *
 * The self-heal rule as data: the mark is scoped to the ready epoch and the COUNT
 * stays visible on the same object (hence `retryToken` beside it).
 */
export function reduceSource(
  state: SourceLifecycleState,
  event: SourceEvent,
  env: SourceEnv,
): SourceReduction {
  switch (event.kind) {
    case 'bootSettled': {
      const next: SourceLifecycleState = {
        ...state,
        boot: { outcome: event.outcome, ...(event.gapKind === undefined ? {} : { kind: event.gapKind }) },
      }
      // The self-heal arm: a settled-degraded mount with a retryable gap waits for ready.
      // A settle that lands while the source is NOT ready keeps the arm PENDING instead of
      // dropping it: the ready epoch that follows is the fact that pays for the re-mount.
      if (event.outcome !== 'degraded') return { state: { ...next, healPending: false }, effects: [] }
      if (!env.retryableGap(event.gapKind)) return { state: { ...next, healPending: false }, effects: [] }
      if (state.phase !== 'ready') return { state: { ...next, healPending: true }, effects: [] }
      if (state.degradedRetried) return { state: { ...next, healPending: false }, effects: [] }
      return {
        state: { ...next, degradedRetried: true, healPending: false, retryToken: state.retryToken + 1 },
        effects: [{ e: 'degradedSelfHeal' }],
      }
    }

    case 'phaseChanged': {
      // Leaving ready drops the self-heal mark: a later ready transition earns a fresh attempt.
      const degradedRetried = event.phase === 'ready' ? state.degradedRetried : false
      const next: SourceLifecycleState = { ...state, phase: event.phase, degradedRetried }
      // Entering ready pays for an arm left pending by a settle that preceded it.
      if (event.phase !== 'ready' || !state.healPending || state.degradedRetried) {
        return { state: next, effects: [] }
      }
      return {
        state: { ...next, degradedRetried: true, healPending: false, retryToken: state.retryToken + 1 },
        effects: [{ e: 'degradedSelfHeal' }],
      }
    }

    case 'retryForgotten':
      return { state: { ...state, degradedRetried: false, healPending: false }, effects: [] }

    case 'prewarmStarted':
      return { state: { ...state, autoPrewarmed: true }, effects: [] }

    case 'prewarmForgotten':
      return { state: { ...state, autoPrewarmed: false }, effects: [] }

    case 'prewarmSuppressionForgotten':
      return { state: { ...state, prewarmSuppressed: false }, effects: [] }

    case 'prewarmSuppressed':
      return { state: { ...state, prewarmSuppressed: true }, effects: [] }

    case 'abandoned':
      return {
        state: {
          ...state,
          abandoned: true,
          ...(event.target === undefined ? {} : { abandonedTarget: event.target }),
        },
        effects: [],
      }

    case 'abandonmentCleared': {
      const { abandonedTarget: _dropped, ...rest } = state
      return { state: { ...rest, abandoned: false }, effects: [] }
    }

    case 'harvestRecord':
      return { state: { ...state, harvest: event.record }, effects: [] }

    case 'harvestCleared':
      return { state: { ...state, harvest: null }, effects: [] }

    default:
      return { state, effects: [] }
  }
}

export function reduceSourceSequence(
  state: SourceLifecycleState,
  events: readonly SourceEvent[],
  env: SourceEnv,
): SourceReduction {
  let current = state
  const effects: SourceEffect[] = []
  for (const event of events) {
    const step = reduceSource(current, event, env)
    current = step.state
    effects.push(...step.effects)
  }
  return { state: current, effects }
}
