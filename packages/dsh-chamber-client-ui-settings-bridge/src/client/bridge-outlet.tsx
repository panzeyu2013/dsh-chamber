/**
 * Bridge outlet: a minimal re-implementation of the official slot render pipeline
 * (scoped-slots.tsx) covering exactly the root-scope LIST and KEYED slots the settings
 * surface declares. The ledger is the SELECTED source's own boot-ctx registry, so the
 * bridge renders entries itself with that source's own renderer-bound seats: same kit
 * synthesis, inject normalization, ledger-version subscription and cell dispatch. Other
 * scope kinds render nothing; a child slot an entry never declared throws
 * BridgeAssemblyError — a miswired delegation must fail loud. That policy is scoped to
 * the chamber's OWN wiring: every bridged outlet is wrapped in
 * `<BridgeEntryBoundary containAll>`, so a foreign assembly error stays at the host seam.
 */
import { Component, useMemo, useSyncExternalStore, type FC, type ReactNode } from 'react'
// The official observableHook, not a second copy: bindings.tsx creates three React
// contexts at module load (host / root binding / scope binding), an edge inside the one
// renderer build graph the bridge already shares. The bridge imports ONLY this module —
// the sibling `bind` module is the VENDOR's own edge, with no ambient declaration here.
import { observableHook } from '@deepseek-ai/dsh-client-ui-renderer/src/client/bindings.tsx'
import type {
  HostObservable, LocaleFace, RenderOpts, StoredEntry, StoreInstanceLike, Translate,
} from '@deepseek-ai/dsh-client-ui-slots'
import { dispatchKeyedCell, dispatchListCells } from './cell-dispatch.ts'
import type { SettingsSourceSlots } from './settings-source-face.ts'

/**
 * The ledger read face the outlet drives. Structural on purpose: the public read API of
 * a SlotRegistry (entries / entriesOfSlot / getVersion / subscribe / spec /
 * onEntryError), so the outlet can render ANY source's registry.
 */
export type BridgeLedger = SettingsSourceSlots

/** Type-erased component props share (mirror of the official render boundary). */
type InjectedProps = Record<string, unknown>

/**
 * Standard seats one source's entries are rendered with: the seats the INSTANCE'S
 * OWN renderer bound for its ctx's root scope, published by the settings shell
 * (settings-source-face.ts), so a section sees exactly the seats it would see in
 * that instance's own frontend (`useSessions` / `useWorkspaces` / `usePanelInfo` /
 * `useResource` / `useSessionPendingInteraction` plus root `props`). Absent members
 * stay absent — the panel never invents a substitute observable.
 */
export interface BridgeStandardSeats {
  useSessions?: unknown
  useWorkspaces?: unknown
  usePanelInfo?: unknown
  useResource?: unknown
  useSessionPendingInteraction?: unknown
  props?: Record<string, unknown>
}

/** Materialize the seat subset into the props share a section component reads. */
function seatProps(standard: BridgeStandardSeats | undefined): InjectedProps {
  if (standard === undefined) return {}
  return {
    ...(standard.props ?? {}),
    ...(standard.useSessions === undefined ? {} : { useSessions: standard.useSessions }),
    ...(standard.useWorkspaces === undefined ? {} : { useWorkspaces: standard.useWorkspaces }),
    ...(standard.usePanelInfo === undefined ? {} : { usePanelInfo: standard.usePanelInfo }),
    ...(standard.useResource === undefined ? {} : { useResource: standard.useResource }),
    ...(standard.useSessionPendingInteraction === undefined
      ? {}
      : { useSessionPendingInteraction: standard.useSessionPendingInteraction }),
  }
}

const noopSubscribe = (): (() => void) => () => {}

/** Store-instance cache, root scope: one instance per registered handle. */
const storeInstances = new WeakMap<StoredEntry, StoreInstanceLike>()

function storeOf(entry: StoredEntry): StoreInstanceLike | undefined {
  if (entry.store === undefined) return undefined
  let instance = storeInstances.get(entry)
  if (instance === undefined) {
    instance = entry.store.create()
    storeInstances.set(entry, instance)
  }
  return instance
}

/** t-seat cache per (face, namespace, revision): locale switches mint fresh references. */
const localeSeatCache = new WeakMap<LocaleFace, Map<string, { revision: number; t: Translate }>>()

function localeSeat(face: LocaleFace, ns: string): Translate {
  let perNs = localeSeatCache.get(face)
  if (perNs === undefined) {
    perNs = new Map()
    localeSeatCache.set(face, perNs)
  }
  const revision = face.getSnapshot().revision
  const cached = perNs.get(ns)
  if (cached !== undefined && cached.revision === revision) return cached.t
  const bound = face.bind(ns)
  const t: Translate = (key, params) => bound(key, params)
  perNs.set(ns, { revision, t })
  return t
}

/** Per-face subscription closures (cached by face identity — no churn per render). */
const localeSubscriptionCache = new WeakMap<LocaleFace, {
  subscribe: (fn: () => void) => () => void
  getRevision: () => number
}>()

function localeSubscription(face: LocaleFace): { subscribe: (fn: () => void) => () => void; getRevision: () => number } {
  let cached = localeSubscriptionCache.get(face)
  if (cached === undefined) {
    cached = {
      subscribe: fn => face.subscribe(fn),
      getRevision: () => face.getSnapshot().revision,
    }
    localeSubscriptionCache.set(face, cached)
  }
  return cached
}

/** Subscribe an outlet to the locale face revision (0 while none is installed). */
export function useLocaleRevision(face: LocaleFace | undefined): number {
  const subscription = face !== undefined ? localeSubscription(face) : undefined
  return useSyncExternalStore(
    subscription?.subscribe ?? noopSubscribe,
    subscription?.getRevision ?? (() => 0),
  )
}

/** Normalize an entry-owned inject face: `hooks` sources become `use<Name>` selector hooks. */
function bindInjectHooks(face: InjectedProps): InjectedProps {
  const sources = face['hooks']
  if (sources === undefined) return face
  const { hooks: _hooks, ...rest } = face
  const bound: InjectedProps = rest
  for (const [name, source] of Object.entries(sources as Record<string, HostObservable<unknown>>)) {
    const hookName = `use${name[0]?.toUpperCase() ?? ''}${name.slice(1)}`
    bound[hookName] = observableHook(source)
  }
  return bound
}

/** Run one root-scope entry's inject factory with the baked store actions. */
function runInject(entry: StoredEntry, actions: object | undefined): InjectedProps {
  const inject = entry.inject
  if (inject === undefined) return {}
  const face = (inject as (...args: unknown[]) => InjectedProps)(actions)
  return bindInjectHooks(face)
}

/** Per-entry inject cache (identity-stable per registration, mirrors the official cache axis). */
const rootInjectCache = new WeakMap<StoredEntry, InjectedProps>()

function cachedRootInject(entry: StoredEntry, actions: object | undefined): InjectedProps {
  let props = rootInjectCache.get(entry)
  if (props === undefined) {
    props = runInject(entry, actions)
    rootInjectCache.set(entry, props)
  }
  return props
}

/** renderSlot binding for an entry's declared children (authorization checks, then an outlet). */
function boundRenderSlot(
  slots: BridgeLedger,
  locale: LocaleFace | undefined,
  standard: BridgeStandardSeats | undefined,
  entry: StoredEntry,
): (key: string, owner: object, opts?: RenderOpts) => ReactNode {
  return (key, owner, opts) => {
    const declared = entry.children?.[key]
    if (declared === undefined) {
      throw new BridgeAssemblyError(`bridge: slot '${key}' is not declared by this entry's children`)
    }
    if (declared.kind !== 'list' && declared.kind !== 'keyed') {
      throw new BridgeAssemblyError(`bridge: slot '${key}' is declared '${declared.kind}', not 'list' or 'keyed' — unsupported by the bridge outlet`)
    }
    if (declared.scope !== 'root') {
      throw new BridgeAssemblyError(`bridge: slot '${key}' is declared scope '${declared.scope}', not 'root' — the bridge outlet renders root-scope settings slots only`)
    }
    return (
      <BridgeOutlet
        slots={slots}
        locale={locale}
        standard={standard}
        slotKey={key}
        ownerProps={owner}
        opts={opts}
      />
    )
  }
}

/** Render one root-scope entry: standard kit + t seat + store pair + renderSlot + inject + owner. */
function renderEntry(
  slots: BridgeLedger,
  locale: LocaleFace | undefined,
  standard: BridgeStandardSeats | undefined,
  entry: StoredEntry,
  ownerProps: object,
): ReactNode {
  const Comp = entry.component as FC<InjectedProps>
  // The seats come from the SOURCE'S OWN renderer binding, handed to this panel by that
  // source's settings shell, so a section reads the same seats as in its own frontend.
  // Missing members stay missing — an invented observable would hide an absent source.
  const kit: InjectedProps = seatProps(standard)
  if (entry.locale !== undefined) {
    if (locale === undefined) {
      throw new BridgeAssemblyError(`bridge: entry declares locale namespace '${entry.locale}' but no locale face is installed`)
    }
    kit['t'] = localeSeat(locale, entry.locale)
  }
  const store = storeOf(entry)
  const actions = store?.actions
  if (store !== undefined) {
    kit['useStore'] = observableHook(store)
    kit['actions'] = store.actions
  }
  if (entry.children !== undefined) {
    kit['renderSlot'] = boundRenderSlot(slots, locale, standard, entry)
  }
  const injected = cachedRootInject(entry, actions)
  return <Comp {...kit} {...injected} {...ownerProps} />
}

/** Bridge assembly failure (mirror of the official SlotAssemblyError): miswired surfaces must fail loud, not degrade. */
export class BridgeAssemblyError extends Error {}

/**
 * One entry crash must not take down its siblings (mirror of the official boundary).
 * Assembly failures (missing locale face, undeclared children) rethrow by default — a
 * miswired shell must fail loud — while ordinary render/inject crashes are contained as an
 * addressable crash face, so a silent blank never passes for an empty section.
 *
 * `containAll` flips the policy for the foreign-entry → host seam: every top-level
 * `BridgeOutlet` is wrapped in `<BridgeEntryBoundary containAll>` so NO foreign entry
 * error can escape and abdicate the chamber-owned `sidebar.settings` shell (which would
 * fall back to the official SettingsRoot). The chamber's OWN wiring stays fail-loud.
 * `getDerivedStateFromError` is a STATIC, so the mode cannot be decided there: the caught
 * error rides the boundary state and `render()` makes the call — containAll → crash face
 * for EVERY error; default → a BridgeAssemblyError rethrows to the next boundary up.
 */
export class BridgeEntryBoundary extends Component<
  { slotKey: string; containAll?: boolean; children: ReactNode },
  { failed: boolean; error: unknown }
> {
  override state: { failed: boolean; error: unknown } = { failed: false, error: null }
  static getDerivedStateFromError(error: unknown): { failed: boolean; error: unknown } {
    // Static (no props): the error rides the state and render() applies the mode — see the class doc.
    return { failed: true, error }
  }
  override componentDidCatch(error: unknown): void {
    console.error('bridge settings entry crashed:', error)
  }
  override render(): ReactNode {
    if (this.state.failed) {
      // containAll (host seam): contain EVERYTHING — the crash face renders and the
      // chamber shell survives. Default (per-entry): BridgeAssemblyError rethrows
      // from render, propagating to the next boundary up.
      if (this.props.containAll !== true && this.state.error instanceof BridgeAssemblyError) {
        throw this.state.error
      }
      return <div data-slot-error={this.props.slotKey} />
    }
    return this.props.children
  }
}

/** Entry-identity React keys (mirror of the official entryKeyOf): remount fresh on winner changes. */
let nextEntryKey = 0
const entryKeys = new WeakMap<StoredEntry, number>()

function entryKeyOf(entry: StoredEntry): number {
  let key = entryKeys.get(entry)
  if (key === undefined) {
    key = nextEntryKey++
    entryKeys.set(entry, key)
  }
  return key
}

/**
 * Anchor style shared by every outlet wrapper: `display:contents` keeps the wrapper out
 * of layout (grid/flex parents see the slot's own children), so the anchor is purely
 * addressable surface. Module constant so the wrapper never diffs its style prop.
 */
const ANCHOR_STYLE = { display: 'contents' } as const

/**
 * Render one root-scope LIST or KEYED slot from a settings ledger: ledger version
 * subscription + locale revision + entries (shadowing winners) in order, with an
 * `only` id filter for the nav→section dispatch. KEYED slots dispatch the single entry
 * whose `options.key` matches `opts.entryKey`, else the fallback. Subscribe/getVersion
 * closures are memoized per (slots, slotKey) — no resubscribe churn. The ledger is the
 * SELECTED SOURCE's own boot-ctx registry; `standard` carries its renderer-bound seats.
 *
 * The official anchor contract: every slot render site exposes a stable
 * `[data-slot="<key>"]` wrapper — the seam official stylesheets target. The wrapper
 * rides the OUTLET, not the dispatch outcome: winner, fallback, dead cell and undeclared
 * slot all render inside it, so the anchor never flickers with registration churn.
 */
export function BridgeOutlet({
  slots, locale, standard, slotKey, ownerProps, opts,
}: {
  slots: BridgeLedger
  locale: LocaleFace | undefined
  standard?: BridgeStandardSeats
  slotKey: string
  ownerProps: object
  opts?: RenderOpts
}) {
  const version = useSyncExternalStore(
    useMemo(() => (fn: () => void) => slots.subscribe(slotKey, fn), [slots, slotKey]),
    useMemo(() => () => slots.getVersion(slotKey), [slots, slotKey]),
  )
  void version
  useLocaleRevision(locale)
  return (
    <div data-slot={slotKey} style={ANCHOR_STYLE}>
      {renderOutletContent(slots, locale, standard, slotKey, ownerProps, opts)}
    </div>
  )
}

function renderOutletContent(
  slots: BridgeLedger,
  locale: LocaleFace | undefined,
  standard: BridgeStandardSeats | undefined,
  slotKey: string,
  ownerProps: object,
  opts: RenderOpts | undefined,
): ReactNode {
  const spec = slots.spec(slotKey)
  // Undeclared (or no-longer-declared) keys and undispatched scope/kind combos
  // render empty: natural empty, not an ownership failure.
  if (spec === undefined || (spec.kind !== 'list' && spec.kind !== 'keyed') || spec.scope !== 'root') return null
  if (spec.kind === 'keyed') {
    // One card per key. A cell whose registrations all abdicated is OCCUPIED but
    // has no winner: it renders the addressable crash face instead of the fallback,
    // so a crashed registrant is never mistaken for an unregistered key.
    const cell = dispatchKeyedCell(
      [...slots.entries(slotKey)],
      [...slots.entriesOfSlot(slotKey)],
      opts?.entryKey,
    )
    if (cell.kind === 'fallback') return <>{opts?.fallback ?? null}</>
    if (cell.kind === 'dead') return <div data-slot-error={slotKey} />
    return (
      <BridgeEntryBoundary key={entryKeyOf(cell.entry)} slotKey={slotKey}>
        {renderEntry(slots, locale, standard, cell.entry, ownerProps)}
      </BridgeEntryBoundary>
    )
  }
  // One row per id cell — the winner, or the crash face once every entry of the cell abdicated.
  const rows = dispatchListCells(
    [...slots.entries(slotKey)],
    [...slots.entriesOfSlot(slotKey)],
    opts?.only,
  )
  if (rows.length === 0) return <>{opts?.fallback ?? null}</>
  // Winner rows key by entry identity, dry-cell rows by id — disjoint prefixes keep the two namespaces apart.
  return (
    <>
      {rows.map((row, index) => row.entry !== undefined
        ? (
          <BridgeEntryBoundary key={`e${entryKeyOf(row.entry)}`} slotKey={slotKey}>
            {renderEntry(slots, locale, standard, row.entry, ownerProps)}
          </BridgeEntryBoundary>
        )
        : <div data-slot-error={slotKey} key={`x${row.id ?? index}`} />)}
    </>
  )
}
