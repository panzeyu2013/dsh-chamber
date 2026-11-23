/**
 * Chamber-side supply of browser-synced plugin configuration (0.2.3-alpha.1 W4-0).
 *
 * Upstream 0.2.3-alpha.1 projects every Loader row's top-level volatile Config fields into the
 * boot graph row (`config`) and hands each client plugin activation its own `SyncedConfig`
 * object of per-field volatile references. The official client composition wires that through
 * `ClientEntries.start` (`loader.ctx.on('internal/config', …)`), which the chamber N-ctx
 * composite CANNOT use: the module system (and the one `ClientEntries` controller it owns) is
 * page-level while the composite mounts one cordis root per instance, and `entries.start` may
 * run only once per page. Without a supply, every plugin that dereferences its config in
 * `apply` (connection's `config.recovery.get()`, ui-conversation's
 * `config.maxConcurrentFileUploads`, ui-workspace's `config.recentViewLimit`, …) silently
 * fails: a caller never throws, the plugin fiber ends FAILED and the ROOT fiber stays ACTIVE —
 * the user sees an empty shell with no boot error (measured; PLAN §13.1).
 *
 * This module is the chamber equivalent, per INSTANCE:
 *  - {@link createSyncedConfigActivation} builds the same per-field reference object upstream's
 *    `SyncedConfigEntry` hands to an activation (`get()/getSnapshot()/subscribe()`, absent
 *    values read `undefined`); the composite passes it as the plugin's second argument for
 *    every COVERED row in {@link SYNCED_CONFIG_COVERED_IDS}, and
 *  - {@link installSyncedConfigSupply} installs a per-instance `internal/config` waterfall
 *    listener for the EXTRA (host-graph) rows so `loader.create({ name })` activates them with
 *    the same reference object, no `dsh-client-web` boot seam required.
 *
 * The values come from the host graph rows: `host-graph.ts` keeps every row's `config` field
 * and captures the COVERED rows' values before `dedupeCoveredRows` drops those rows (they are
 * still on the wire — config is a per-row fact, not a per-bundle one).
 *
 * Degradation contract: a row with no `config` (an older host that does not project it, or a
 * plugin with no volatile fields) still receives a reference object whose fields read
 * `undefined` — the plugins' own fallbacks use their defaults, the fiber activates, and no
 * empty-shell failure occurs. Live volatile updates are NOT applied by this batch (the boot
 * value is the activation's value); see the report/STATUS entry.
 */

/** One plugin's synced Config values, keyed by field name (the upstream wire shape). */
export type SyncedConfigValues = Readonly<Record<string, unknown>>

/** One synced Config field's read-only volatile view (the subset plugins consume). */
export interface SyncedConfigRef<T = unknown> {
  /** Current value; `undefined` when the Host sent none. */
  get(): T | undefined
  /** Same value as {@link get} (React's `useSyncExternalStore` contract). */
  getSnapshot(): T | undefined
  /** Observe changes; returns the disposer. The boot supply never notifies (no live writer yet). */
  subscribe(listener: () => void): () => void
}

/** Deep-freeze a JSON value the way the upstream controller freezes host values. */
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}

/**
 * One field's reference: immutable value, observable identity. The boot supply is immutable in
 * this batch — a reference never changes — so `subscribe` is an inert registration whose
 * disposer is a no-op: shipping a never-notified listener set plus a never-called writer would
 * be dead machinery. A future live-config batch adds the writer and the notification together
 * (the upstream `SyncedConfigEntry.update` semantics); see the module header.
 */
class FieldRef<T = unknown> implements SyncedConfigRef<T> {
  readonly #value: T | undefined

  constructor(value: T | undefined) {
    this.#value = value
  }

  readonly get = (): T | undefined => this.#value
  readonly getSnapshot = (): T | undefined => this.#value

  /** Inert registration (boot supply is immutable); returns the disposable handle. */
  readonly subscribe = (_listener: () => void): (() => void) => () => {}
}

/**
 * One plugin activation's synced Config object: an inert read-only view whose properties are
 * per-field references created on first access (the upstream `SyncedConfigActivation` shape).
 * Every field may read `undefined`; the object is not extensible, writable or deletable.
 */
export class SyncedConfigActivation {
  readonly #values: SyncedConfigValues
  readonly #refs = new Map<string, FieldRef>()
  /** The object handed to the activation's `apply(ctx, config)`. */
  readonly config: object

  /**
   * @param values - Host-validated values for this row; absent fields read `undefined`.
   */
  constructor(values: SyncedConfigValues = {}) {
    this.#values = freezeDeep(structuredClone(values) as SyncedConfigValues)
    // An extensible empty target keeps the Proxy invariants satisfied for fields that
    // appear later (the upstream implementation, same reason).
    this.config = new Proxy({}, {
      set: () => false,
      defineProperty: () => false,
      deleteProperty: () => false,
      get: (_target, property) => typeof property === 'string' ? this.#ref(property) : undefined,
      has: (_target, property) => typeof property === 'string' && Object.hasOwn(this.#values, property),
      ownKeys: () => Object.keys(this.#values),
      getOwnPropertyDescriptor: (_target, property) =>
        typeof property === 'string' && Object.hasOwn(this.#values, property)
          ? { configurable: true, enumerable: true, value: this.#ref(property) }
          : undefined,
    })
  }

  #ref(field: string): FieldRef {
    let ref = this.#refs.get(field)
    if (ref === undefined) {
      ref = new FieldRef(this.#values[field])
      this.#refs.set(field, ref)
    }
    return ref
  }
}

/**
 * Build the config object for one activation.
 * @param values - the row's synced values; omitted ⇒ an all-`undefined` reference object.
 * @returns the object to pass as the plugin's second `apply` argument.
 */
export function createSyncedConfigActivation(values?: SyncedConfigValues): object {
  return new SyncedConfigActivation(values).config
}

/**
 * The COVERED composite rows whose alpha.1 client face dereferences its synced Config in
 * `apply`/`Service` construction (PLAN §12.3.1 / §13.1; measured against the pinned tree).
 * ONLY these rows get a second argument from the composite — passing a reference object to a
 * plugin that declares its own Config schema would fail cordis validation, so the roster is an
 * explicit, tested list rather than "every row".
 */
export const SYNCED_CONFIG_COVERED_IDS: readonly string[] = [
  // connection/client/index.ts: `config.recovery.get()` in apply — the silent-empty-shell
  // chain root (connection FAILED ⇒ api-gateway/remote/api-remotes PENDING).
  '@deepseek-ai/dsh-client-connection',
  // ui-conversation/src/client/apply.ts: `config.maxConcurrentFileUploads` (subscribe in the
  // Service constructor).
  '@deepseek-ai/dsh-client-ui-conversation',
  // ui-workspace/src/client/index.ts: `config.recentViewLimit` → navigation.ts subscribe.
  '@deepseek-ai/dsh-client-ui-workspace',
  // ui-context-menu/src/client/index.ts: `config.resolutionTimeoutMs.get()` on the first menu.
  '@deepseek-ai/dsh-client-ui-context-menu',
  // shortcuts client entry: the service CLASS constructor reads `config.stopSequenceMs`.
  '@deepseek-ai/dsh-client-shortcuts',
  // ui-settings-models (deferred): `config.credentialOnboarding` in apply.
  '@deepseek-ai/dsh-client-ui-settings-models',
]

/** One instance's synced-config supply: raw row values plus the extra-row ids they belong to. */
export interface SyncedConfigSupply {
  /** Host-graph row id → the row's projected volatile values (covered and extra rows alike). */
  readonly values: ReadonlyMap<string, SyncedConfigValues>
  /** The ids of this boot's EXTRA (host-graph) rows: the only entries the listener activates. */
  readonly extraRowIds: ReadonlySet<string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-entry synced-config supply; installed by the shell before any plugin materializes. */
    chamberSyncedConfig?: SyncedConfigSupply
  }
}

/**
 * The synced Config object one COMPOSITE row's activation receives, when the row is on the
 * config-consuming roster.
 * @param ctx - the per-instance root Context (carries `chamberSyncedConfig`).
 * @param id - the package/row id being registered.
 * @returns the activation object, or `undefined` for a row that takes no synced Config.
 */
export function syncedConfigActivationFor(
  ctx: { chamberSyncedConfig?: SyncedConfigSupply },
  id: string,
): object | undefined {
  if (!SYNCED_CONFIG_COVERED_IDS.includes(id)) return undefined
  return createSyncedConfigActivation(ctx.chamberSyncedConfig?.values.get(id))
}

/** The minimal context face {@link installSyncedConfigSupply} needs (tests pass a stub). */
export interface SyncedConfigSupplyTarget {
  provide?(name: string, value: unknown): unknown
  on?(name: string, listener: (...args: any[]) => unknown, options?: unknown): unknown
}

/**
 * Install the per-instance supply: publish it on the context for the composite's covered-row
 * `register`, and (real cordis only) install the `internal/config` waterfall listener that
 * hands each EXTRA-row entry root the same reference object. Entry roots of the kernel rows and
 * the composite itself are left untouched (they take no config).
 * @param ctx - the per-instance root Context, before the Loader exists.
 * @param supply - this boot's row values + extra-row ids.
 */
export function installSyncedConfigSupply(ctx: SyncedConfigSupplyTarget, supply: SyncedConfigSupply): void {
  ctx.provide?.('chamberSyncedConfig', supply)
  if (typeof ctx.on !== 'function') return
  /** One activation per extra-row entry, built on first materialization. */
  const activations = new Map<string, object>()
  const activationFor = (id: string): object => {
    let activation = activations.get(id)
    if (activation === undefined) {
      activation = createSyncedConfigActivation(supply.values.get(id))
      activations.set(id, activation)
    }
    return activation
  }
  ctx.on('internal/config', (fiber: any, next: () => unknown) => {
    // Reflection of a hostile fiber shape must never break another entry's config.
    let entry: any
    let parentEntry: any
    let runtimeConfig: any
    try {
      entry = fiber?.entry
      parentEntry = fiber?.parent?.fiber?.entry
      runtimeConfig = fiber?.runtime?.Config
    } catch {
      return next()
    }
    // As the loader's own listener: skip non-entry fibers and CHILD plugins (a child
    // inherits its parent's entry), keep their explicit config; only an entry ROOT
    // (parent belongs to another/no entry) receives the synced activation.
    if (entry === undefined || parentEntry === entry) return next()
    let name: unknown
    try { name = entry?.options?.name } catch { return next() }
    if (typeof name !== 'string' || !supply.extraRowIds.has(name)) return next()
    // Upstream entries.ts parity: a Client face that declares its own Config schema keeps
    // Cordis's ordinary configuration when the Host sent no synced values, and throws when
    // it did (a face cannot have both schemas).
    if (runtimeConfig !== undefined) {
      const values = supply.values.get(name)
      const empty = values === undefined || Object.keys(values).length === 0
      if (empty) return next()
      throw new Error(`client-modules: the Client face of ${name} exports a Config schema; synced configuration requires the Host schema alone`)
    }
    // Every no-schema extra row gets an activation even without wire values (upstream
    // entries.ts applyConfig treats an absent row config as {}); fields read undefined.
    return activationFor(name)
  }, { global: true, prepend: true })
}
