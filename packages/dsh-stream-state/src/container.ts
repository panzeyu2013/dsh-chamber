/**
 * Per-source registry: ONE current generation per source id.
 *
 * WHY A REGISTRY AND NOT A KEYED RECORD. Keying records by the pair
 * (sourceId, fingerprint) makes a re-registration start a NEW record - but
 * nothing removes the old one, and every projection walks all records of the
 * id. Two incarnations of one source therefore show through as a merged,
 * contradictory view (a flag from one incarnation, a hidden window from another),
 * and an event dispatched with a stale fingerprint would still reduce the old
 * record and emit its effects. The invariant is one sentence: a source id
 * has exactly ONE live generation, and an event carrying any other generation is
 * dropped without an effect.
 *
 * The registry makes that structural: the key is the source id, the entry stores
 * its epoch, and {@link reincarnate} is the only way a new incarnation appears (it
 * bumps the epoch and starts the record clean, so no penalties are inherited).
 * Callers that arm a callback for one generation capture the epoch and pass it with
 * every event; a late callback from a superseded generation can only be dropped.
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

/** One source id's live generation. The epoch is monotone per source id. */
export interface SourceRegistryEntry {
  readonly epoch: number
  readonly incarnation: SourceIncarnation
  readonly state: SourceLifecycleState
}

export type SourceRegistry = Readonly<Record<string, SourceRegistryEntry>>

export interface SourceRegistryReduction {
  readonly registry: SourceRegistry
  /** Effects paired with the source they belong to. */
  readonly effects: readonly { readonly sourceId: string; readonly effect: SourceEffect }[]
  /** false when the source is unknown or the event belonged to a superseded epoch. */
  readonly accepted: boolean
}

/** The current generation number for a source, or undefined when unregistered. */
export function epochOf(registry: SourceRegistry, sourceId: string): number | undefined {
  return registry[sourceId]?.epoch
}

/**
 * Register (or re-register) a source incarnation. Same fingerprint = the SAME
 * generation and the same registry reference (a reclaim/re-mount cycle keeps its
 * history); a different fingerprint = a new epoch whose record starts clean.
 */
export function reincarnate(registry: SourceRegistry, incarnation: SourceIncarnation): SourceRegistry {
  const previous = registry[incarnation.sourceId]
  if (previous !== undefined && previous.incarnation.fingerprint === incarnation.fingerprint) return registry
  return {
    ...registry,
    [incarnation.sourceId]: {
      epoch: (previous?.epoch ?? 0) + 1,
      incarnation,
      state: initialSourceLifecycle(incarnation),
    },
  }
}

/**
 * Dispatch one event for one source generation.
 *
 * The fence lives here: an unknown source and an event whose epoch is not the
 * entry's current epoch are dropped (accepted: false) with no effect. The event is
 * not reduced against a stale record, so a retired life cannot move anything.
 */
export function dispatchSource(
  registry: SourceRegistry,
  sourceId: string,
  event: SourceEvent & { readonly epoch: number },
  env: SourceEnv,
): SourceRegistryReduction {
  const entry = registry[sourceId]
  if (entry === undefined) return { registry, effects: [], accepted: false }
  if (event.epoch !== entry.epoch) return { registry, effects: [], accepted: false }
  const { epoch: _epoch, ...sourceEvent } = event
  const reduction = reduceSource(entry.state, sourceEvent, env)
  return {
    registry: { ...registry, [sourceId]: { ...entry, state: reduction.state } },
    effects: reduction.effects.map((effect) => ({ sourceId, effect })),
    accepted: true,
  }
}

/** Drop entries whose source is no longer registered. Returns the same reference when
 * nothing changed, so a caller can use identity to skip a re-render. */
export function retainSourceIds(
  registry: SourceRegistry,
  liveSourceIds: ReadonlySet<string>,
): SourceRegistry {
  let changed = false
  const next: Record<string, SourceRegistryEntry> = {}
  for (const [sourceId, entry] of Object.entries(registry)) {
    if (liveSourceIds.has(sourceId)) next[sourceId] = entry
    else changed = true
  }
  return changed ? next : registry
}

// ---------------------------------------------------------------------------
// Projections: each one mirrors exactly one of the App's refs. Every projection
// reads the CURRENT generation only - the registry cannot express another.
// ---------------------------------------------------------------------------

/** App's hiddenSinceRef: source id -> hidden-window start (only hidden views appear). */
export function projectHiddenSince(registry: SourceRegistry): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [sourceId, entry] of Object.entries(registry)) {
    if (entry.state.hiddenSince !== null) out[sourceId] = entry.state.hiddenSince
  }
  return out
}

/** App's degradedRetriedRef. */
export function projectDegradedRetried(registry: SourceRegistry): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [sourceId, entry] of Object.entries(registry)) {
    if (entry.state.degradedRetried) out[sourceId] = true
  }
  return out
}

/**
 * A Set-shaped ledger backed by the registry, for call sites that mutate a Set
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
export function projectAutoPrewarmed(registry: SourceRegistry): Set<string> {
  const out = new Set<string>()
  for (const [sourceId, entry] of Object.entries(registry)) {
    if (entry.state.autoPrewarmed) out.add(sourceId)
  }
  return out
}

/**
 * App's harvestStateRef: source id -> HarvestRecord. The registry entry's `harvest`
 * field is the SAME shape (its doc says so explicitly), so this projection is
 * lossless. A source with no record yet is simply ABSENT from the map.
 */
export function projectHarvest(registry: SourceRegistry): Record<string, HarvestState> {
  const out: Record<string, HarvestState> = {}
  for (const [sourceId, entry] of Object.entries(registry)) {
    if (entry.state.harvest !== null) out[sourceId] = entry.state.harvest
  }
  return out
}

/**
 * A Record-shaped ledger view for the harvest slots, where the caller READS a whole
 * record, runs a PURE function over it (baseline-harvest's harvestAttemptStarted /
 * harvestSatisfied), and stores the RESULT back. Translating that assignment is not
 * possible losslessly (the reducer would have to reverse-engineer which function
 * ran), so the registry accepts the finished record instead: storage is owned,
 * the policy functions stay where they are.
 */
export function createHarvestView(options: {
  readonly read: () => Readonly<Record<string, HarvestState>>
  readonly onWrite: (id: string, record: HarvestState) => void
  readonly onDelete: (id: string) => void
  /** What a caller sees for a source with no record yet (the initial value). */
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
 * A Map-shaped ledger backed by the registry (the record-shaped views could
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

/** App's abandonedViewsRef: source id -> the view it was switched TO. */
export function projectAbandonedTargets(registry: SourceRegistry): Map<string, string> {
  const out = new Map<string, string>()
  for (const [sourceId, entry] of Object.entries(registry)) {
    if (entry.state.abandoned && entry.state.abandonedTarget !== undefined) {
      out.set(sourceId, entry.state.abandonedTarget)
    }
  }
  return out
}

/** App's prewarmSuppressedRef (a Set of source ids). */
export function projectPrewarmSuppressed(registry: SourceRegistry): Set<string> {
  const out = new Set<string>()
  for (const [sourceId, entry] of Object.entries(registry)) {
    if (entry.state.prewarmSuppressed) out.add(sourceId)
  }
  return out
}
