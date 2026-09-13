/**
 * Bridge outlet: a minimal re-implementation of the official slot render
 * pipeline (dsh-client-ui-renderer/src/client/scoped-slots.tsx) covering exactly the
 * root-scope LIST and KEYED slots the settings surface declares
 * (settings.section / settings.general.item / settings.plugins.tab list;
 * settings.plugin.item keyed). The ledger is the SELECTED source's own boot-ctx
 * registry (2026-12 完整桥接修订), whose renderer is anchored on `renderRoot`
 * for its own root tree — so the bridge renders entries itself, with the
 * source's own renderer-bound seats: same kit synthesis (t seat /
 * useStore+actions / renderSlot binding / standard hooks), same inject face
 * normalization, same ledger-version subscription, same cell dispatch (winner /
 * occupied-but-absent dead cell / dry-cell crash face — ./cell-dispatch.ts).
 * Scope kinds other than root+list/keyed render nothing (the official outlet's
 * undeclared-empty branch) and a child slot an entry never declared throws
 * BridgeAssemblyError — a miswired delegation must fail loud, never render
 * empty by design. That fail-loud policy is scoped to the chamber's OWN wiring:
 * the settings shell wraps every bridged outlet in `<BridgeEntryBoundary
 * containAll>` (see the boundary below) so a foreign entry's assembly error is
 * contained at the host seam and can never abdicate the chamber-owned shell.
 */
import { Component, useMemo, useSyncExternalStore, type FC, type ReactNode } from 'react'
// 2026-09-11 upstream-alignment A3: the official observableHook, not a second
// copy of it. bindings.tsx also creates three React contexts at module load
// (host / root binding / scope binding) — the import is an edge inside the one
// renderer build graph the bridge already shares. 2026-09-11 review-fix F4d: the
// bridge imports ONLY this module (the sibling `bind` module it deep-imports is
// the VENDOR module's own edge — `bindings.tsx` imports `./bind.ts` — and this
// package has no ambient declaration for it, because nothing here imports it).
import { observableHook } from '@deepseek-ai/dsh-client-ui-renderer/src/client/bindings.tsx'
import type {
  HostObservable, LocaleFace, RenderOpts, StoredEntry, StoreInstanceLike, Translate,
} from '@deepseek-ai/dsh-client-ui-slots'
import { dispatchKeyedCell, dispatchListCells } from './cell-dispatch.ts'
import type { SettingsSourceSlots } from './settings-source-face.ts'

/**
 * The ledger read face the outlet drives. Structural on purpose: it is the
 * public read API of an `@deepseek-ai/dsh-client-ui-renderer` SlotRegistry
 * (entries / entriesOfSlot / getVersion / subscribe / spec / onEntryError), so
 * the outlet can render ANY source's registry — the selected instance's own
 * boot-ctx ledger since the 2026-12 complete-bridge revision.
 */
export type BridgeLedger = SettingsSourceSlots

/** Type-erased component props share (mirror of the official render boundary). */
type InjectedProps = Record<string, unknown>

/**
 * Standard seats one source's entries are rendered with. They are the seats
 * the INSTANCE'S OWN renderer bound for its ctx's root scope — the settings
 * shell publishes the ones it received (settings-source-face.ts), so a
 * rendered section sees exactly the seats it would see in that instance's own
 * frontend: `useSessions` / `useWorkspaces` / `usePanelInfo` / `useResource`
 * / `useSessionPendingInteraction` plus the root `props` compartment
 * (`chamberFileApiBase`). Absent members stay absent — the panel never invents
 * a substitute observable for a source that did not provide one.
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
  // The seats come from the SOURCE'S OWN renderer binding: they are handed to
  // this panel by that source's settings shell (settings-source-face.ts), so a
  // section reads the same session/workspace/panel/resource seats it reads in
  // that instance's own frontend. Missing members stay missing — inventing an
  // empty observable would hide a genuinely absent source.
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
 * One entry crash must not take down its siblings (mirror of the official
 * boundary). Assembly failures (missing locale face, undeclared children)
 * rethrow by default — a miswired shell must fail loud; ordinary
 * render/inject crashes are contained: the cell renders an addressable
 * crash face (same shape as the official `<div data-slot-error>`) so a
 * silent blank never passes for an empty section.
 *
 * `containAll` flips the policy for the foreign-entry → host seam: the chamber
 * settings shell wraps every top-level `BridgeOutlet` it renders in
 * `<BridgeEntryBoundary containAll slotKey="…">` so NO foreign entry error —
 * assembly or ordinary — can escape the shell. The bridged content is a
 * DIFFERENT author (the plugins running in the SELECTED source's ctx): one
 * misbehaving entry (an entry calling renderSlot for an undeclared slot, a
 * missing locale face, …) must never be able to abdicate
 * the chamber-owned `sidebar.settings` shell to the hosting boot's
 * boundary, which would permanently fall the entry back to the official
 * SettingsRoot (no server dropdown). The chamber's OWN shell wiring stays
 * fail-loud: a BridgeAssemblyError raised by shell code (outside the
 * bridged outlets) still escapes.
 *
 * React invokes `getDerivedStateFromError` as a STATIC — no instance props
 * are reachable there — so the mode cannot be decided inside it. The caught
 * error is carried through the boundary state instead and `render()` (an
 * instance method) makes the call: containAll → crash face for EVERY error;
 * default → a BridgeAssemblyError rethrows from render, which propagates to
 * the next boundary up — the same escape as a getDerivedStateFromError
 * throw, keeping the per-entry default fail-loud.
 */
export class BridgeEntryBoundary extends Component<
  { slotKey: string; containAll?: boolean; children: ReactNode },
  { failed: boolean; error: unknown }
> {
  override state: { failed: boolean; error: unknown } = { failed: false, error: null }
  static getDerivedStateFromError(error: unknown): { failed: boolean; error: unknown } {
    // Static (no props): the error rides the state and render() applies the
    // mode — see the class doc above.
    return { failed: true, error }
  }
  override componentDidCatch(error: unknown): void {
    console.error('bridge settings entry crashed:', error)
  }
  override render(): ReactNode {
    if (this.state.failed) {
      // containAll (child-ctx → host seam): contain EVERYTHING — the crash
      // face renders and the chamber shell survives. Default (per-entry):
      // BridgeAssemblyError rethrows so a miswired surface fails loud; the
      // throw from render propagates to the next boundary up.
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
 * Anchor style shared by every outlet wrapper: `display:contents` keeps the
 * wrapper out of layout (grid/flex parents see the slot's own children), so the
 * anchor is purely addressable surface. Module-level constant — a stable
 * reference so the wrapper never diffs its style prop (official ANCHOR_STYLE).
 */
const ANCHOR_STYLE = { display: 'contents' } as const

/**
 * Render one root-scope LIST or KEYED slot from a settings ledger:
 * ledger version subscription + locale revision + entries (shadowing
 * winners) in order, `only` id filter for the nav→section dispatch. KEYED
 * slots dispatch the single entry whose `options.key` matches
 * `opts.entryKey`, else the fallback. Subscribe/getVersion closures are
 * memoized per (slots, slotKey) — no resubscribe churn on unrelated
 * re-renders (official per-face cache pattern).
 *
 * Since the 2026-12 complete-bridge revision the ledger is the SELECTED
 * SOURCE's own boot-ctx registry and `standard` carries that source's own
 * renderer-bound seats, so an entry renders with the props it would have in
 * that instance's own frontend.
 *
 * 2026-09-11 upstream-alignment T4 — the official anchor contract: every slot
 * render site exposes a stable `[data-slot="<key>"]` wrapper, because that is
 * the addressable seam the official stylesheets target
 * (`ui-settings-general/src/client/GeneralSection.module.css`:
 * `.section > :global([data-slot='settings.general.item']) > :last-child`).
 * The wrapper rides the OUTLET, not the dispatch outcome: the winning entry,
 * the fallback, the occupied-but-absent dead cell and an undeclared slot all
 * render inside it, so the anchor never flickers with registration churn.
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

/** Kind dispatch behind the outlet anchor (keyed/list winners, fallbacks, addressable crash faces). */
function renderOutletContent(
  slots: BridgeLedger,
  locale: LocaleFace | undefined,
  standard: BridgeStandardSeats | undefined,
  slotKey: string,
  ownerProps: object,
  opts: RenderOpts | undefined,
): ReactNode {
  const spec = slots.spec(slotKey)
  // Undeclared (or no-longer-declared) keys, and the scope/kind combinations
  // the bridge does not dispatch, render empty: this is natural empty, not an
  // ownership failure (official undeclared-empty branch).
  if (spec === undefined || (spec.kind !== 'list' && spec.kind !== 'keyed') || spec.scope !== 'root') return null
  if (spec.kind === 'keyed') {
    // One card per key (official keyed dispatch). A cell whose registrations all
    // abdicated is OCCUPIED but has no winner: it renders the addressable crash
    // face instead of the fallback, so a crashed registrant is never mistaken
    // for an unregistered key.
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
  // One row per id cell — the cell's winner, or the crash face once every entry
  // of the cell abdicated (a dry cell must not silently drop its row).
  const rows = dispatchListCells(
    [...slots.entries(slotKey)],
    [...slots.entriesOfSlot(slotKey)],
    opts?.only,
  )
  if (rows.length === 0) return <>{opts?.fallback ?? null}</>
  // Winner rows key by entry identity; dry-cell rows key by id — the disjoint
  // prefixes keep the two namespaces from colliding (official row keys).
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
