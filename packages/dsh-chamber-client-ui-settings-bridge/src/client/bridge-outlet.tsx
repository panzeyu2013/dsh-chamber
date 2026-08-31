/**
 * Bridge outlet: a minimal re-implementation of the official slot render
 * pipeline (dsh-client-ui-renderer/src/client/scoped-slots.tsx) covering exactly the
 * root-scope LIST and KEYED slots the child settings context declares
 * (settings.section / settings.general.item / settings.plugins.tab list;
 * settings.plugin.item keyed). The official renderer is boot-root-anchored
 * (`renderRoot('root')` requires the sessions/workspaces services the child
 * context deliberately omits), so the bridge renders entries itself: same
 * kit synthesis (t seat / useStore+actions / renderSlot binding / standard
 * hooks), same inject face normalization, same ledger-version subscription.
 * Scope kinds other than root+list/keyed throw BridgeAssemblyError (no
 * session scope exists in a bridged settings surface) — a miswired surface
 * must fail loud, never render empty by design. That fail-loud policy is
 * scoped to the chamber's OWN wiring: the settings shell wraps every
 * bridged outlet in `<BridgeEntryBoundary containAll>` (see the boundary
 * below) so a child-ctx assembly error is contained at the host seam and
 * can never abdicate the chamber-owned shell.
 */
import { Component, useMemo, useSyncExternalStore, type FC, type ReactNode } from 'react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-ui-renderer/src/client/bind'
import type {
  HostObservable, LocaleFace, RenderOpts, SnapshotSelectorHook, StoredEntry, StoreInstanceLike, Translate,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'

/** Type-erased component props share (mirror of the official render boundary). */
type InjectedProps = Record<string, unknown>

/**
 * Per-source selector-hook cache (mirror of the official observableHook):
 * the official components call `useStore(s => s.active)` etc. with SELECTORS,
 * so the bare hook must be bindSnapshotSelector (useSyncExternalStoreWith-
 * Selector), not a whole-snapshot uSES. Cached per source for identity
 * stability (official session-provider.tsx observableHook).
 */
const hookCache = new WeakMap<HostObservable<unknown>, unknown>()

function bridgeObservableHook<T>(source: HostObservable<T>): SnapshotSelectorHook<T> {
  let hook = hookCache.get(source as HostObservable<unknown>)
  if (hook === undefined) {
    hook = bindSnapshotSelector(source)
    hookCache.set(source as HostObservable<unknown>, hook)
  }
  return hook as SnapshotSelectorHook<T>
}

/** Standard-hook stubs: bridged settings sections never read session/workspace state. */
const EMPTY_SNAPSHOT: Record<string, never> = {}
const EMPTY_OBSERVABLE: HostObservable<unknown> = {
  getSnapshot: () => EMPTY_SNAPSHOT,
  subscribe: () => () => {},
}
const emptyObservableHook = bridgeObservableHook(EMPTY_OBSERVABLE)

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
    bound[hookName] = bridgeObservableHook(source)
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
  slots: SlotRegistry,
  locale: LocaleFace | undefined,
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
      throw new BridgeAssemblyError(`bridge: slot '${key}' is declared scope '${declared.scope}', not 'root' — the bridge outlet has no session scope`)
    }
    return (
      <BridgeOutlet
        slots={slots}
        locale={locale}
        slotKey={key}
        ownerProps={owner}
        opts={opts}
      />
    )
  }
}

/** Render one root-scope entry: standard kit + t seat + store pair + renderSlot + inject + owner. */
function renderEntry(
  slots: SlotRegistry,
  locale: LocaleFace | undefined,
  entry: StoredEntry,
  ownerProps: object,
): ReactNode {
  const Comp = entry.component as FC<InjectedProps>
  const kit: InjectedProps = {
    useSessions: emptyObservableHook,
    useWorkspaces: emptyObservableHook,
  }
  if (entry.locale !== undefined) {
    if (locale === undefined) {
      throw new BridgeAssemblyError(`bridge: entry declares locale namespace '${entry.locale}' but no locale face is installed`)
    }
    kit['t'] = localeSeat(locale, entry.locale)
  }
  const store = storeOf(entry)
  const actions = store?.actions
  if (store !== undefined) {
    kit['useStore'] = bridgeObservableHook(store)
    kit['actions'] = store.actions
  }
  if (entry.children !== undefined) {
    kit['renderSlot'] = boundRenderSlot(slots, locale, entry)
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
 * `containAll` flips the policy for the child-ctx → host seam: the chamber
 * settings shell wraps every top-level `BridgeOutlet` it renders in
 * `<BridgeEntryBoundary containAll slotKey="…">` so NO child-ctx error —
 * assembly or ordinary — can escape the shell. The bridged content is a
 * DIFFERENT author (the official settings plugins running in the child
 * context): one misbehaving entry (an entry calling renderSlot for an
 * undeclared slot, a missing locale face, …) must never be able to abdicate
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
 * Render one root-scope LIST or KEYED slot from a child settings context:
 * ledger version subscription + locale revision + entries (shadowing
 * winners) in order, `only` id filter for the nav→section dispatch. KEYED
 * slots dispatch the single entry whose `options.key` matches
 * `opts.entryKey`, else the fallback. Subscribe/getVersion closures are
 * memoized per (slots, slotKey) — no resubscribe churn on unrelated
 * re-renders (official per-face cache pattern).
 */
export function BridgeOutlet({
  slots, locale, slotKey, ownerProps, opts,
}: {
  slots: SlotRegistry
  locale: LocaleFace | undefined
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
  const spec = slots.spec(slotKey)
  if (spec === undefined || (spec.kind !== 'list' && spec.kind !== 'keyed') || spec.scope !== 'root') return null
  if (spec.kind === 'keyed') {
    // One card per key (official keyed dispatch): the entry registered with
    // the requested key renders through the boundary. A miss is natural
    // empty — the chamber bridge has no shadowing, so the official
    // occupied-but-absent deadCell corner collapses to the fallback branch.
    const entry = [...slots.entriesOfSlot(slotKey)].find(e => e.options.key === opts?.entryKey)
    if (!entry) return <>{opts?.fallback ?? null}</>
    return (
      <BridgeEntryBoundary key={entryKeyOf(entry)} slotKey={slotKey}>
        {renderEntry(slots, locale, entry, ownerProps)}
      </BridgeEntryBoundary>
    )
  }
  let entries = [...slots.entriesOfSlot(slotKey)].sort((a, b) => (a.options.order ?? 0) - (b.options.order ?? 0))
  if (opts?.only !== undefined) entries = entries.filter(entry => entry.options.id === opts.only)
  if (entries.length === 0) return <>{opts?.fallback ?? null}</>
  return (
    <>
      {entries.map(entry => (
        <BridgeEntryBoundary key={entryKeyOf(entry)} slotKey={slotKey}>
          {renderEntry(slots, locale, entry, ownerProps)}
        </BridgeEntryBoundary>
      ))}
    </>
  )
}
