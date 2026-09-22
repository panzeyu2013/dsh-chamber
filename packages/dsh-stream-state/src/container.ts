/**
 * Per-source container (B2): ONE state object per source instead of six refs.
 *
 * WHY A CONTAINER AND NOT JUST THE REDUCER. The App's ledgers were keyed by view id,
 * but the thing whose lifetime they describe is a source INCARNATION - the pair
 * (sourceId, fingerprint). A container keyed by that pair is what lets a registry
 * re-registration be a fence (the old incarnation's counters cannot leak into the
 * new one) while a reclaim/re-mount cycle stays the SAME incarnation (the once-per-
 * ready-epoch rules keep their meaning).
 *
 * The projections below are how a migration stays incremental: every existing ref
 * (hiddenSince / degradedRetried / autoPrewarmed / prewarmSuppressed / abandoned /
 * harvest) is a PURE VIEW of the container, so a caller can switch one ledger at a
 * time and the rest keep reading the projection. Once all callers read from here,
 * the refs are deleted (B2's last step) - and until then the projection is what
 * guarantees the two readings agree.
 *
 * PURITY: no imports beyond the sibling reducer; no clock, no DOM.
 */

import { initialSourceLifecycle, reduceSource } from './source.ts'
import type {
  HarvestState,
  SourceEffect,
  SourceEnv,
  SourceEvent,
  SourceIncarnation,
  SourceLifecycleState,
} from './source.ts'

export interface SourceContainerReduction {
  readonly states: Readonly<Record<string, SourceLifecycleState>>
  /** Effects paired with the source they belong to. */
  readonly effects: readonly { readonly sourceId: string; readonly effect: SourceEffect }[]
}

/** Stable key for an incarnation: the pair, never the bare id. */
export function incarnationKey(incarnation: SourceIncarnation): string {
  return incarnation.sourceId + '\u0000' + incarnation.fingerprint
}

/**
 * Dispatch one event for one source.
 *
 * INCARNATION FENCE: when the fingerprint differs from the stored one, the record is
 * rebuilt from scratch. That is the whole point of keying by the pair - a registry
 * re-registration legitimately starts with no history, and carrying the old
 * incarnation's suppression/quota into it would make a re-registered source inherit
 * a previous life's penalties.
 */
export function dispatchSource(
  states: Readonly<Record<string, SourceLifecycleState>>,
  incarnation: SourceIncarnation,
  event: SourceEvent,
  env: SourceEnv,
): SourceContainerReduction {
  const key = incarnationKey(incarnation)
  const previous = states[key]
  const base = previous !== undefined && previous.incarnation.fingerprint === incarnation.fingerprint
    ? previous
    : initialSourceLifecycle(incarnation)
  const reduction = reduceSource(base, event, env)
  return {
    states: { ...states, [key]: reduction.state },
    effects: reduction.effects.map((effect) => ({ sourceId: incarnation.sourceId, effect })),
  }
}

/** Drop records whose source is no longer registered (mirrors the App's
 * `live` sweep). Returns the same reference when nothing changed, so a caller can
 * use identity to skip a re-render. */
export function retainSources(
  states: Readonly<Record<string, SourceLifecycleState>>,
  liveKeys: ReadonlySet<string>,
): Readonly<Record<string, SourceLifecycleState>> {
  let changed = false
  const next: Record<string, SourceLifecycleState> = {}
  for (const [key, state] of Object.entries(states)) {
    if (liveKeys.has(key)) next[key] = state
    else changed = true
  }
  return changed ? next : states
}

// ---------------------------------------------------------------------------
// Projections: each one replaces exactly one of the App's refs.
// ---------------------------------------------------------------------------

/** App's hiddenSinceRef: view id -> hidden-window start (only hidden views appear). */
export function projectHiddenSince(
  states: Readonly<Record<string, SourceLifecycleState>>,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const state of Object.values(states)) {
    if (state.hiddenSince !== null) out[state.incarnation.sourceId] = state.hiddenSince
  }
  return out
}

/** App's degradedRetriedRef. */
export function projectDegradedRetried(
  states: Readonly<Record<string, SourceLifecycleState>>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const state of Object.values(states)) {
    if (state.degradedRetried) out[state.incarnation.sourceId] = true
  }
  return out
}

/**
 * A Set-shaped ledger backed by the container, for call sites that mutate a Set
 * through METHODS.
 *
 * WHY THIS SHAPE AND NOT A PROPERTY VIEW. A `Set` is mutated with `add`/`delete`,
 * which no property setter can intercept (the record-shaped ledgers could use an
 * assignment-translating view; these cannot). So the adapter implements the read
 * surface the call sites actually use - `has`, `size`, iteration, `new Set(view)`,
 * `[...view]` - from the projection, and turns each mutation into ONE event.
 *
 * ITERATION DURING MUTATION IS SAFE HERE. The App sweeps with
 * `for (const id of set) if (!live.has(id)) set.delete(id)`. A projection-backed
 * iterator walks a SNAPSHOT Set, so a dispatch during the loop cannot invalidate it;
 * the next read simply sees the new state. (Contrast a real Set, where deleting the
 * current entry mid-iteration is a generator hazard.)
 */
export interface SetLedgerView extends ReadonlySet<string> {
  add(id: string): unknown
  delete(id: string): boolean
}

export function createSetLedgerView(options: {
  readonly read: () => ReadonlySet<string>
  readonly onAdd: (id: string) => void
  readonly onDelete: (id: string) => void
}): SetLedgerView {
  const size = (): number => options.read().size
  return {
    get size() {
      return size()
    },
    has: (id: string) => options.read().has(id),
    add: (id: string) => {
      options.onAdd(id)
      return undefined
    },
    delete: (id: string) => {
      const existed = options.read().has(id)
      options.onDelete(id)
      return existed
    },
    keys: () => options.read().keys(),
    values: () => options.read().values(),
    entries: () => options.read().entries(),
    forEach: (callback: (value: string, value2: string, set: ReadonlySet<string>) => void) => {
      const snapshot = options.read()
      for (const id of snapshot) callback(id, id, snapshot)
    },
    [Symbol.iterator]: () => options.read()[Symbol.iterator](),
    [Symbol.toStringTag]: 'Set',
  } as never
}

/** App's autoPrewarmedRef (a Set of source ids). */
export function projectAutoPrewarmed(
  states: Readonly<Record<string, SourceLifecycleState>>,
): Set<string> {
  const out = new Set<string>()
  for (const state of Object.values(states)) {
    if (state.autoPrewarmed) out.add(state.incarnation.sourceId)
  }
  return out
}

/**
 * App's harvestStateRef: view id -> HarvestRecord. The container's `harvest` field
 * is the SAME shape (its doc says so explicitly), so this projection is lossless.
 * A source with no record yet is simply ABSENT from the map.
 */
export function projectHarvest(
  states: Readonly<Record<string, SourceLifecycleState>>,
): Record<string, HarvestState> {
  const out: Record<string, HarvestState> = {}
  for (const state of Object.values(states)) {
    if (state.harvest !== null) out[state.incarnation.sourceId] = state.harvest
  }
  return out
}

/**
 * A Record-shaped ledger view for the harvest slots, where the caller READS a whole
 * record, runs a PURE function over it (baseline-harvest's harvestAttemptStarted /
 * harvestSatisfied), and stores the RESULT back. Translating that assignment is not
 * possible losslessly (the reducer would have to reverse-engineer which function
 * ran), so the container accepts the finished record instead: storage is owned,
 * the policy functions stay where they are.
 */
export function createHarvestView(options: {
  readonly read: () => Readonly<Record<string, HarvestState>>
  readonly onWrite: (id: string, record: HarvestState) => void
  readonly onDelete: (id: string) => void
  /** What a caller sees for a source with no record yet (the legacy initial value). */
  readonly initial: () => HarvestState
}): Record<string, HarvestState> {
  const record: Record<string, HarvestState> = {}
  return new Proxy(record, {
    get: (_target, property) => {
      const snapshot = options.read()
      if (typeof property === 'string') {
        const found = snapshot[property]
        return found === undefined ? options.initial() : found
      }
      return (snapshot as unknown as Record<PropertyKey, unknown>)[property]
    },
    has: (_target, property) =>
      typeof property === 'string'
        ? true
        : (property as unknown as string) in options.read(),
    ownKeys: () => Reflect.ownKeys(options.read()),
    getOwnPropertyDescriptor: (_target, property) => ({
      configurable: true,
      enumerable: true,
      value: typeof property === 'string'
        ? (options.read()[property] ?? options.initial())
        : undefined,
    }),
    set: (_target, property, value) => {
      if (typeof property !== 'string') return false
      options.onWrite(property, value as HarvestState)
      return true
    },
    deleteProperty: (_target, property) => {
      if (typeof property !== 'string') return false
      options.onDelete(property)
      return true
    },
  })
}

/**
 * A Map-shaped ledger backed by the container (the record-shaped views could
 * translate ASSIGNMENTS; Map/Set ledgers mutate through METHODS, so they need an
 * adapter that owns the read surface).
 *
 * Like {@link createSetLedgerView}, iteration walks a SNAPSHOT: the App's sweeps do
 * `for (const id of [...map.keys()])` and delete inside the loop, and a projection
 * iterator would otherwise be invalidated by the dispatch it triggers.
 */
export interface MapLedgerView extends ReadonlyMap<string, string> {
  set(id: string, target: string): unknown
  delete(id: string): boolean
}

export function createMapLedgerView(options: {
  readonly read: () => ReadonlyMap<string, string>
  readonly onSet: (id: string, target: string) => void
  readonly onDelete: (id: string) => void
}): MapLedgerView {
  return {
    get size() {
      return options.read().size
    },
    get: (id: string) => options.read().get(id),
    has: (id: string) => options.read().has(id),
    set: (id: string, target: string) => {
      options.onSet(id, target)
      return undefined
    },
    delete: (id: string) => {
      const existed = options.read().has(id)
      options.onDelete(id)
      return existed
    },
    keys: () => options.read().keys(),
    values: () => options.read().values(),
    entries: () => options.read().entries(),
    forEach: (callback: (value: string, key: string, map: ReadonlyMap<string, string>) => void) => {
      const snapshot = options.read()
      for (const [key, value] of snapshot) callback(value, key, snapshot)
    },
    [Symbol.iterator]: () => options.read()[Symbol.iterator](),
    [Symbol.toStringTag]: 'Map',
  } as never
}

/** App's abandonedViewsRef: view id -> the view it was switched TO. */
export function projectAbandonedTargets(
  states: Readonly<Record<string, SourceLifecycleState>>,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const state of Object.values(states)) {
    if (state.abandoned && state.abandonedTarget !== undefined) {
      out.set(state.incarnation.sourceId, state.abandonedTarget)
    }
  }
  return out
}

/** App's prewarmSuppressedRef (a Set of source ids). */
export function projectPrewarmSuppressed(
  states: Readonly<Record<string, SourceLifecycleState>>,
): Set<string> {
  const out = new Set<string>()
  for (const state of Object.values(states)) {
    if (state.prewarmSuppressed) out.add(state.incarnation.sourceId)
  }
  return out
}
