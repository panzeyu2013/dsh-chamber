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
  /** Mounted means the view (and its shell) is currently materialized. */
  readonly mounted: boolean
  /** Settled boot state: null while booting. */
  readonly boot: { readonly outcome: 'booted' | 'degraded' | 'failed'; readonly kind?: string } | null
  /** Monotonic-ish start of the current hidden window, or null while visible. */
  readonly hiddenSince: number | null
  /** The source phase projection this object last observed ('ready' | 'idle' | ...). */
  readonly phase: string | undefined
  /** Once-per-ready-epoch degraded self-heal mark, scoped to the MOUNT. */
  readonly degradedRetried: boolean
  /** Background boots that own the single prewarm slot. */
  readonly autoPrewarmed: boolean
  /** Retention reclaimed this incarnation: no automatic prewarm until a user act. */
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
    mounted: false,
    boot: null,
    hiddenSince: null,
    phase: undefined,
    degradedRetried: false,
    autoPrewarmed: false,
    prewarmSuppressed: false,
    abandoned: false,
    harvest: null,
    retryToken: 0,
  }
}

/** Events the source reducer understands. Unknown kinds are no-ops (total). */
export type SourceEvent =
  | { readonly kind: 'mounted'; readonly at: number }
  | { readonly kind: 'unmounted'; readonly at: number }
  | { readonly kind: 'bootSettled'; readonly outcome: 'booted' | 'degraded' | 'failed'; readonly gapKind?: string }
  | { readonly kind: 'phaseChanged'; readonly phase: string | undefined }
  | { readonly kind: 'hidden'; readonly at: number }
  /**
   * The view landed on screen: the hidden WINDOW closes. Deliberately narrower than
   * 'painted' - the prewarm-suppression ledger clears only on an explicit user action /
   * registry removal, so using 'painted' here would re-open the prewarm loop retention
   * exists to stop.
   */
  | { readonly kind: 'windowReset' }
  | { readonly kind: 'painted'; readonly at: number }
  | { readonly kind: 'userSelected'; readonly at: number }
  | { readonly kind: 'reclaimed'; readonly at: number }
  | { readonly kind: 'abandoned'; readonly target?: string }
  /** The abandonment mark is revoked (the switch that caused it was not delivered). */
  | { readonly kind: 'abandonmentCleared' }
  | { readonly kind: 'harvestStarted'; readonly at: number; readonly backoffMs: number }
  | { readonly kind: 'harvestSatisfied' }
  /** The caller computed the finished harvest record with baseline-harvest's pure
   * functions and hands it over whole, keeping those functions the policy and the
   * container the storage. */
  | { readonly kind: 'harvestRecord'; readonly record: HarvestState }
  /** The harvest entry is dropped with the source (the registry sweep). */
  | { readonly kind: 'harvestCleared' }
  | { readonly kind: 'retryRequested' }
  /** The once-per-ready-epoch self-heal mark is dropped because the mount it belonged to
   * is gone - narrower than 'reclaimed': it clears ONLY the mark, leaving the boot outcome
   * and the prewarm suppression as they are. */
  | { readonly kind: 'retryForgotten' }
  /** An automatic background prewarm claimed its slot for this source. It records ORIGIN
   * (prewarmed, not user-chosen), which retention uses to decide whose warm shell to
   * collect first. */
  | { readonly kind: 'prewarmStarted' }
  /** The retention suppression is lifted (the user opened the source, or the registry
   * dropped it). Narrower than 'userSelected', which also clears `abandoned` and returns
   * a `mount` effect: re-enabling prewarming need not ask for a boot. */
  | { readonly kind: 'prewarmUnsuppressed' }
  /** The origin flag is dropped because the claim it recorded is over (the shell was
   * consumed as a warm hit, reclaimed, or its source left the registry). Narrower than
   * the mount/paint events, so a prune can forget the origin without a full reset. */
  | { readonly kind: 'prewarmForgotten' }
  /** The retention suppression is dropped because its ledger entry is gone (registry
   * sweep / retirement). It clears ONLY the suppression and asks for no boot, unlike
   * 'prewarmUnsuppressed' (entry still exists) or 'userSelected'. */
  | { readonly kind: 'prewarmSuppressionForgotten' }
  /** Retention forbids automatic prewarming for this source (its warm shell was just
   * collected) - distinct from 'reclaimed', which also drops the boot outcome and the
   * harvest record. */
  | { readonly kind: 'prewarmSuppressed' }

export interface SourceReduction {
  readonly state: SourceLifecycleState
  /** Typed effects the App performs; the reducer never touches the shell. */
  readonly effects: readonly SourceEffect[]
}

export type SourceEffect =
  /** Boot (or re-boot) this source view; the only way a mount happens. */
  | { readonly e: 'mount'; readonly reason: 'user' | 'prewarm' | 'harvest' | 'selfHeal' }
  /** Dispose the shell and unmount the view. */
  | { readonly e: 'reclaim' }
  /** Ask the sidebar to re-boot a settled-degraded mount (once per ready epoch). */
  | { readonly e: 'degradedSelfHeal' }

/** Consecutive hidden time needed before retention may reclaim (table value is
 * owned by the App; the reducer only compares). */
export interface SourceEnv {
  readonly reclaimGraceMs: number
  /** Degraded gaps a re-boot can plausibly fix (boot-gap's verdict, carried in). */
  readonly retryableGap: (kind: string | undefined) => boolean
}

/**
 * One reduction step. Total function: every (state, event) returns a state.
 *
 * Two rules as data: a RECLAIM DOES NOT FORGET THE SELF-HEAL MARK unless the incarnation
 * changes (the mark is mount-scoped, but the COUNT must stay visible - hence `retryToken`
 * and the mark share this object); and a RECLAIMED INCARNATION CANNOT BE AUTO-PREWARMED
 * (otherwise the next tick re-boots it in a loop) until a user action clears it.
 */
export function reduceSource(
  state: SourceLifecycleState,
  event: SourceEvent,
  env: SourceEnv,
): SourceReduction {
  switch (event.kind) {
    case 'mounted':
      // A mount starts a NEW boot: the settle outcome, the self-heal mark and the
      // background-slot flag belong to the mount that just ended, so they are cleared
      // here - the reclaim path can then stay honest about who owns the mark.
      return {
        state: {
          ...state,
          mounted: true,
          hiddenSince: null,
          abandoned: false,
          boot: null,
          degradedRetried: false,
          autoPrewarmed: false,
        },
        effects: [],
      }

    case 'unmounted':
      return { state: { ...state, mounted: false, hiddenSince: event.at }, effects: [] }

    case 'bootSettled': {
      const next: SourceLifecycleState = {
        ...state,
        boot: { outcome: event.outcome, ...(event.gapKind === undefined ? {} : { kind: event.gapKind }) },
      }
      // The self-heal arm: a settled-degraded mount with a retryable gap waits for ready.
      if (event.outcome !== 'degraded') return { state: next, effects: [] }
      if (!env.retryableGap(event.gapKind)) return { state: next, effects: [] }
      if (state.phase !== 'ready' || state.degradedRetried) return { state: next, effects: [] }
      return {
        state: { ...next, degradedRetried: true, retryToken: state.retryToken + 1 },
        effects: [{ e: 'degradedSelfHeal' }],
      }
    }

    case 'phaseChanged': {
      // Leaving ready drops the self-heal mark: a later ready transition earns a fresh attempt.
      const degradedRetried = event.phase === 'ready' ? state.degradedRetried : false
      return { state: { ...state, phase: event.phase, degradedRetried }, effects: [] }
    }

    case 'retryForgotten':
      return { state: { ...state, degradedRetried: false }, effects: [] }

    case 'prewarmStarted':
      return { state: { ...state, autoPrewarmed: true }, effects: [] }

    case 'prewarmUnsuppressed':
      return { state: { ...state, prewarmSuppressed: false }, effects: [] }

    case 'prewarmForgotten':
      return { state: { ...state, autoPrewarmed: false }, effects: [] }

    case 'prewarmSuppressionForgotten':
      return { state: { ...state, prewarmSuppressed: false }, effects: [] }

    case 'prewarmSuppressed':
      return { state: { ...state, prewarmSuppressed: true }, effects: [] }

    case 'hidden':
      return { state: { ...state, hiddenSince: event.at }, effects: [] }

    case 'windowReset':
      // Only the window: suppression is cleared by 'userSelected' (a different lifecycle question).
      return { state: { ...state, hiddenSince: null }, effects: [] }

    case 'painted':
      // On screen clears the hidden window AND the retention suppression.
      return {
        state: { ...state, hiddenSince: null, prewarmSuppressed: false, autoPrewarmed: false },
        effects: [],
      }

    case 'userSelected':
      return {
        state: { ...state, prewarmSuppressed: false, abandoned: false },
        effects: [{ e: 'mount', reason: 'user' }],
      }

    case 'reclaimed': {
      if (state.mounted) return { state, effects: [] }
      // A mount that never settled is never a reclaim candidate.
      if (state.boot === null) return { state, effects: [] }
      if (state.hiddenSince === null || event.at - state.hiddenSince < env.reclaimGraceMs) {
        return { state, effects: [] }
      }
      return {
        state: {
          ...state,
          boot: null,
          harvest: null,
          autoPrewarmed: false,
          prewarmSuppressed: true,
          hiddenSince: null,
          // The mark dies with the mount it belonged to; the next mount starts unmarked.
          degradedRetried: false,
        },
        effects: [{ e: 'reclaim' }],
      }
    }

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

    case 'harvestStarted':
      return {
        state: {
          ...state,
          autoPrewarmed: true,
          harvest: {
            attempts: (state.harvest?.attempts ?? 0) + 1,
            mountedAt: event.at,
            retryAt: event.at + event.backoffMs,
            satisfied: false,
          },
        },
        effects: [{ e: 'mount', reason: 'harvest' }],
      }

    case 'harvestRecord':
      return { state: { ...state, harvest: event.record }, effects: [] }

    case 'harvestCleared':
      return { state: { ...state, harvest: null }, effects: [] }

    case 'harvestSatisfied':
      return {
        state: {
          ...state,
          harvest: { attempts: state.harvest?.attempts ?? 0, mountedAt: 0, retryAt: 0, satisfied: true },
        },
        effects: [],
      }

    case 'retryRequested':
      // A manual retry is its own bound: it only bumps the counter the boot trigger reads.
      return { state: { ...state, retryToken: state.retryToken + 1 }, effects: [{ e: 'mount', reason: 'selfHeal' }] }

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
