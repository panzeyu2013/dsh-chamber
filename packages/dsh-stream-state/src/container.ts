/**
 * Per-source registry: ONE current generation per source id.
 *
 * Keying records by (sourceId, fingerprint) would leave the old record behind, so two
 * incarnations of one source show through as a merged, contradictory view, and a stale
 * fingerprint could still reduce the old record and emit its effects. The invariant: a
 * source id has exactly ONE live generation, and an event carrying any other generation
 * is dropped without an effect. The registry makes that structural - the key is the
 * source id, the entry stores its epoch, and {@link reincarnate} is the only way a new
 * incarnation appears. Callers capture the epoch and pass it with every event.
 *
 * EPOCH HIGH-WATER: an epoch is monotone per source id for the LIFETIME OF THE REGISTRY
 * VALUE, not the lifetime of the entry. Retiring an id removes its entry
 * ({@link retainSourceIds}) but not its high-water mark, so a same-id re-registration
 * continues the sequence instead of restarting at 1. Without it a numeric coincidence
 * would let a retired generation's late event pass the fence into a DIFFERENT generation.
 * The mark travels as hidden (non-enumerable symbol) metadata ON THE REGISTRY VALUE, never
 * as module-level state: the result stays a pure function of the value, and the public
 * shape (keys, spread, deepEqual, JSON) is exactly the live-source record.
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

/** One source id's live generation. The epoch is monotone per source id across retirements. */
export interface SourceRegistryEntry {
  readonly epoch: number
  readonly incarnation: SourceIncarnation
  readonly state: SourceLifecycleState
}

export type SourceRegistry = Readonly<Record<string, SourceRegistryEntry>>

/**
 * Hidden registry metadata: the highest epoch EVER issued per source id. Live entries are
 * covered by construction; retired ids keep their mark so a re-entry cannot reuse it.
 */
const EPOCH_HIGH_WATER: unique symbol = Symbol('dsh-stream-state.epochHighWater')

type EpochHighWater = Readonly<Record<string, number>>
type RegistryWithHighWater = SourceRegistry & { readonly [EPOCH_HIGH_WATER]?: EpochHighWater }

/** The carried mark; a registry built outside this module reads as empty (the next returned value folds its live entries back in). */
function highWaterOf(registry: SourceRegistry): EpochHighWater {
  return (registry as RegistryWithHighWater)[EPOCH_HIGH_WATER] ?? {}
}

/** The mark with every issued epoch folded in by MAX; the SAME object when nothing rises. */
function highWaterAfter(registry: SourceRegistry, issued: readonly (readonly [string, number])[]): EpochHighWater {
  const carried = highWaterOf(registry)
  let raised: Record<string, number> | undefined
  for (const [sourceId, epoch] of issued) {
    if (epoch <= (carried[sourceId] ?? 0)) continue
    raised ??= { ...carried }
    raised[sourceId] = epoch
  }
  return raised ?? carried
}

/**
 * Define the carried mark on a registry value this module is about to return. The property
 * is NON-enumerable, so Object.keys, spread, JSON and assert.deepStrictEqual see the
 * live-source record and nothing else. The guarantee holds for values that keep flowing
 * through this module's functions: a foreign spread/assign drops the mark (and would
 * restart the sequence if that copy were then mutated directly).
 */
function withHighWater<T extends SourceRegistry>(registry: T, highWater: EpochHighWater): T {
  Object.defineProperty(registry, EPOCH_HIGH_WATER, {
    value: highWater,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return registry
}

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
 * Register (or re-register) a source incarnation. Same fingerprint = the SAME generation
 * and the same registry reference; a different fingerprint = a new epoch, clean record.
 * A retired-then-returned id (same OR different fingerprint) continues its epoch sequence:
 * the carried high-water mark, not the entry's presence, is what the next epoch is based on.
 */
export function reincarnate(registry: SourceRegistry, incarnation: SourceIncarnation): SourceRegistry {
  const previous = registry[incarnation.sourceId]
  if (previous !== undefined && previous.incarnation.fingerprint === incarnation.fingerprint) return registry
  const highWater = highWaterOf(registry)
  const epoch = Math.max(highWater[incarnation.sourceId] ?? 0, previous?.epoch ?? 0) + 1
  return withHighWater(
    {
      ...registry,
      [incarnation.sourceId]: {
        epoch,
        incarnation,
        state: initialSourceLifecycle(incarnation),
      },
    },
    { ...highWater, [incarnation.sourceId]: epoch },
  )
}

/**
 * Dispatch one event for one source generation. The fence lives here: an unknown source
 * and an event whose epoch is not the entry's current epoch are dropped (accepted: false)
 * with no effect, so a retired life cannot move anything.
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
    registry: withHighWater(
      { ...registry, [sourceId]: { ...entry, state: reduction.state } },
      highWaterAfter(registry, [[sourceId, entry.epoch]]),
    ),
    effects: reduction.effects.map((effect) => ({ sourceId, effect })),
    accepted: true,
  }
}

/**
 * Drop unregistered sources; same reference when nothing changed, so callers can skip a
 * re-render. Dropping an entry must NOT drop its epoch high-water mark: a same-id re-entry
 * continues the sequence (see {@link reincarnate}).
 */
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
  if (!changed) return registry
  return withHighWater(
    next,
    highWaterAfter(registry, Object.entries(next).map(([sourceId, entry]) => [sourceId, entry.epoch] as const)),
  )
}

// Projections: each mirrors exactly one of the App's refs, reading the CURRENT
// generation only - the registry cannot express another.

/** App's degradedRetriedRef. */
export function projectDegradedRetried(registry: SourceRegistry): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [sourceId, entry] of Object.entries(registry)) {
    if (entry.state.degradedRetried) out[sourceId] = true
  }
  return out
}

/**
 * A Set-shaped ledger backed by the registry, for call sites that mutate a Set through
 * METHODS: `add`/`delete` cannot be intercepted by a property setter, so the adapter
 * implements the read surface and turns each mutation into ONE event.
 *
 * ITERATION DURING MUTATION IS SAFE: the projection-backed iterator walks a SNAPSHOT
 * Set, so a dispatch inside a sweep loop cannot invalidate the iteration.
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

/** App's harvestStateRef: source id -> HarvestState; a source with no record is ABSENT. */
export function projectHarvest(registry: SourceRegistry): Record<string, HarvestState> {
  const out: Record<string, HarvestState> = {}
  for (const [sourceId, entry] of Object.entries(registry)) {
    if (entry.state.harvest !== null) out[sourceId] = entry.state.harvest
  }
  return out
}

/**
 * A Record-shaped ledger view for harvest slots: the caller reads a record, runs a pure
 * policy function over it and stores the RESULT back. Translating that assignment is not
 * possible losslessly, so the registry accepts the finished record instead.
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
 * A Map-shaped ledger backed by the registry. Like {@link createSetLedgerView}, the
 * adapter owns the read surface and iteration walks a SNAPSHOT, so a sweep that deletes
 * inside the loop cannot invalidate the iterator.
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
