/**
 * Child cordis context assembly for one bridged instance (settings bridge,
 * design discussion 2026-08; graph-driven extension 2026-12): an INDEPENDENT
 * root Context (no parent inheritance — full service isolation from the
 * hosting boot) with a fake `connection` (per-instance unary client +
 * loopback=true) and a stub `remote` (no WS stream; invalidation
 * subscriptions become no-ops). The official settings plugin subset runs on
 * this ctx, so every registered section/row binds its controllers and
 * settings scopes to the TARGET instance's RPC surface; the hosting boot's own
 * ledger/scope/events are untouched.
 *
 * ## Two plugin sets
 *
 * - BASE set (`BASE_PLUGINS`): the chamber's own infrastructure + the official
 *   settings families + the chamber replacements for session-family rows.
 *   Fail-loud: if this chain cannot activate, the mount rejects and the shell
 *   shows the error.
 * - EXTENSION set (2026-12): the SELECTED SOURCE'S OWN client plugin graph —
 *   `clientGraph/graph` over the per-instance proxy, minus the ids the chamber
 *   composite already covers, loaded through the page-level union module table
 *   and mounted into this same child context. This is what makes a plugin
 *   installed in that source's profile contribute its settings section here,
 *   exactly as it would in the source's own frontend. Extension mounting is
 *   CONTAINED per plugin: one foreign plugin's failure must never break the
 *   settings panel, and every outcome is reported (see settings-extensions.ts).
 *
 * A plugin whose root `inject` declares services this context does not provide
 * (session-family services: `sessions`, `uiConversation`, …) never activates;
 * that is reported as `inactive` with the exact missing service names instead
 * of silently rendering nothing. The chamber's own General-page rows for those
 * session-family settings are supplied by the self-built BridgeRows plugin.
 *
 * Teardown: dispose() unloads the root fiber (all plugin effects, slot
 * registrations, and settings-scope subscriptions) and cancels an in-flight
 * extension phase.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { LocaleFace, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import {
  cachedSourceClientGraph, clientPluginLoader, clientRowSignatures, loadClientPluginRows, notePluginMounted,
  notePluginUnmounted, publishSourceClientGraph,
  type ClientPluginRow,
} from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'
import { getBridgeApiClient, type BridgeApiClient } from './bridge-api.ts'
import {
  AGENT_PRESET_ID, BASE_PLUGIN_IDS, RUNTIME_SECTION_ID, isBasePluginId,
} from './base-plugins.ts'

import * as UiSettings from '@deepseek-ai/dsh-client-ui-settings/client'
import * as UiSettingsGeneral from '@deepseek-ai/dsh-client-ui-settings-general/client'
import * as UiSettingsModels from '@deepseek-ai/dsh-client-ui-settings-models/client'
import * as UiSettingsPlugins from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import * as UiSettingsPluginInventory from '@deepseek-ai/dsh-client-ui-settings-plugin-inventory/client'
import * as LocalePlugin from '@deepseek-ai/dsh-client-locale/client'
import * as UiTheme from '@deepseek-ai/dsh-client-ui-theme/client'
import * as BridgeRows from './bridge-rows/index.ts'

/**
 * The fake connection handle (shape mirror of the official ConnectionHandle):
 * only the surfaces the settings plugins consume are real — `api` (the
 * per-instance bridge client) and `isLoopback` (true, so settings scopes and
 * welcome onboarding persist to the TARGET host, never memory mode).
 */
import { createRuntimeSectionPlugin } from './runtime-section-plugin.ts'
import {
  runtimeServerProjectionKey,
  type RuntimeServerProjection,
} from './runtime-source.ts'
import {
  EMPTY_EXTENSION_SNAPSHOT,
  classifyContribution,
  contributedSeats,
  mergeContributionVerdict,
  decorateContributions,
  dependencyClosureProviders,
  omittedSeatContributions,
  parseClientGraphRows,
  projectExtensionRows,
  normalizePluginNamespace,
  type EntryCrash,
  type ExtensionSnapshot,
  type FiberLike,
  type PluginContribution,
} from './settings-extensions.ts'

export interface FakeConnectionHandle {
  api: BridgeApiClient
  isLoopback: boolean
  rpc: Record<string, never>
  start: () => { stop(): void }
}

/**
 * The Typert Remote namespaces the bridged official settings plugins consume,
 * all backed by the per-instance bridge client. Every method returns the
 * `RemoteResult` union (`{ok:true,value}` / `{ok:false,error}`) exactly as
 * the generated client would.
 */
function remoteFaces(api: BridgeApiClient) {
  return {
    settings: api.settings,
    credentials: api.credentials,
    llm: api.llm,
    agentPresets: api.agentPresets,
    session: api.session,
    pluginInventory: api.pluginInventory,
  }
}

/**
 * The fake connection, provided as a cordis SERVICE (2026-12): service method
 * calls are caller-bound, so `this.ctx` inside a member is the calling
 * plugin's context. That is what makes the capability report possible — the
 * child context's connection is a settings-scoped face, and a plugin reading
 * it must be told when it asks for something the surface does not have.
 *
 * `rpc` stays an EMPTY OBJECT on purpose: it is a data field the official
 * settings plugins read (not call), so making it throw would break the base
 * chain for no honest gain — the reported degradation is the `remote.$on`
 * no-op below.
 */
class BridgeConnectionService extends Service implements FakeConnectionHandle {
  readonly api: BridgeApiClient
  readonly isLoopback = true
  readonly rpc: Record<string, never> = {}

  constructor(ctx: Context, api: BridgeApiClient) {
    super(ctx, 'connection')
    this.api = api
  }

  /** No-op transport lifecycle (the bridge has no stream of its own). */
  readonly start = (): { stop(): void } => ({ stop() {} })
}

/**
 * The stub remote, provided as a cordis SERVICE so a plugin's
 * `ctx.remote.$on(key, fn)` can be attributed to that plugin: the child
 * context has no WS stream, so forwarded host events are no-ops — and a plugin
 * that relies on them must learn that its settings will not live-update
 * (silent no-op = "no changes", which is exactly the masquerade the chamber's
 * proxy-honesty invariant forbids).
 */
class BridgeRemoteService extends Service {
  /** The forwarded-event keys subscribed so far, attributed to the caller's fiber name. */
  readonly subscriptions = new Map<string, Set<string>>()

  private readonly onChange: (() => void) | undefined

  constructor(ctx: Context, api: BridgeApiClient, onChange?: () => void) {
    super(ctx, 'remote')
    this.onChange = onChange
    // The namespace faces are assigned (not declared) because they are plain
    // data objects; the service proxy answers `ctx.remote.settings` through
    // the associate mechanism to the separately provided `remote.settings`
    // service, so a plugin's calls stay caller-bound either way.
    Object.assign(this, remoteFaces(api))
  }

  /** Fixed host facts: the child context is a local-instance face (see the note below). */
  readonly $host = { home: undefined, isLoopback: true }

  /**
   * Record one forwarded-event subscription and return a no-op disposer.
   * @param key - the forwarded host event name.
   * @param _fn - the listener (never invoked: no stream exists here).
   * @returns a disposer that removes the recorded subscription.
   */
  $on(key: string, _fn: (...args: never[]) => void): () => void {
    const owner = (this.ctx as { fiber?: { name?: string } }).fiber?.name ?? 'root'
    const keys = this.subscriptions.get(owner) ?? new Set<string>()
    keys.add(key)
    this.subscriptions.set(owner, keys)
    this.onChange?.()
    return () => {
      const current = this.subscriptions.get(owner)
      if (current === undefined) return
      current.delete(key)
      if (current.size === 0) this.subscriptions.delete(owner)
      this.onChange?.()
    }
  }

  /** No-op dispatch (nothing is forwarded into the child context). */
  $dispatch(_event: unknown, _args: unknown[]): void {}
}

/** The rendered side of one bridged instance: the live child context and its service faces. */
export interface BridgeSession {
  /** The instance this session was assembled for ('local' or '<kind>-<id>'). */
  instanceId: string
  /** Opaque authoritative lifecycle proof captured when this session was assembled. */
  sourceFingerprint: string
  /** Target/transport/version facts captured by the runtime section plugin. */
  runtimeProjectionKey: string
  /** The independent child context (the rendering React tree must not call ctx methods outside the plugin fibers). */
  ctx: Context
  /** The child slot registry instance (read faces only: entries/entriesOfSlot/getVersion/subscribe/spec). */
  slots: SlotRegistry
  /** The child locale face (undefined until the locale plugin activated). */
  locale: LocaleFace | undefined
  /** Live extension-phase projection for this source (uSES pair). */
  extensions: ExtensionObservable
  /** Re-read the source's plugin graph and reconcile the mounted extension set. */
  refreshExtensions(): Promise<void>
  /** Unload the whole child fiber tree (plugins, slots, scopes) + cancel the extension phase. */
  dispose(): Promise<void>
}

/** The observable face the shell reads for the extension phase. */
export interface ExtensionObservable {
  getSnapshot(): ExtensionSnapshot
  subscribe(listener: () => void): () => void
}

/** One official settings plugin row (inject + apply pair from the package's client half). */
type SettingsPlugin = { inject: readonly string[]; apply(ctx: Context): void }

/** A base plugin with the package id it is mounted (and attributed) under. */
interface NamedSettingsPlugin {
  id: string
  plugin: SettingsPlugin
}

/**
 * The BASE plugin set the child context mounts (2026-12: renamed from the old
 * whitelist `SETTINGS_PLUGINS`; the SELECTED SOURCE's own plugins are added by
 * the extension phase below, not here). Every id here MUST be in the renderer's
 * `CHAMBER_COVERED_IDS`, or the extension phase would mount the same package a
 * second time on this context.
 */
const BASE_PLUGINS: readonly NamedSettingsPlugin[] = [
  { id: '@deepseek-ai/dsh-client-ui-settings', plugin: UiSettings },
  { id: '@deepseek-ai/dsh-client-locale', plugin: LocalePlugin },
  { id: '@deepseek-ai/dsh-client-ui-theme', plugin: UiTheme },
  { id: '@deepseek-ai/dsh-client-ui-settings-general', plugin: UiSettingsGeneral },
  { id: '@deepseek-ai/dsh-client-ui-settings-models', plugin: UiSettingsModels },
  { id: '@deepseek-ai/dsh-client-ui-settings-plugins', plugin: UiSettingsPlugins },
  { id: '@deepseek-ai/dsh-client-ui-settings-plugin-inventory', plugin: UiSettingsPluginInventory },
  { id: '@dsh-chamber/dsh-chamber-client-ui-settings-bridge', plugin: BridgeRows },
]

/**
 * The slot declaration chain the official settings shell needs. The
 * declarations ledger is tree-shaped (root → sidebar → sidebar.settings →
 * settings.*), and `sidebar.settings` is only declared by the entry of the
 * `sidebar` slot — which in the full app is the sidebar plugin's shell. The
 * child context mounts no sidebar, so this plugin supplies the declaration
 * chain with inert entries: once `sidebar.settings` is declared,
 * ui-settings-general's own `slots.inject('sidebar.settings')` registers the
 * official SettingsRoot there, whose children declaration opens
 * `settings.section` / `settings.general.item` / … for the section plugins.
 * The bridge shell renders `settings.section` directly and never renders the
 * inert entries.
 */
const DECLARATION_PLUGIN: SettingsPlugin = {
  inject: ['slots'],
  apply(ctx: Context): void {
    const inert = (): null => null
    ctx.slots.register({
      name: 'root',
      children: { 'sidebar': { kind: 'single', scope: 'root' } },
    }, inert)
    ctx.slots.register({
      name: 'sidebar',
      children: {
        'sidebar.settings': { kind: 'single', scope: 'root' },
        'sidebar.workspaces': { kind: 'single', scope: 'root' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
      },
    }, inert)
  },
}

/** Wall-clock budget for the child plugin chain to reach ACTIVE (fail-loud, never hang). */
const MOUNT_TIMEOUT_MS = 5000

/**
 * Per-plugin settle budget for the extension phase: how long one extension
 * plugin's `await()` may take before its verdict is decided. A plugin still
 * LOADING after this window is reported `inactive`; if it finishes later its
 * registrations still appear on the ledger (the shell renders the ledger
 * reactively), so the verdict is a diagnostic, never a gate.
 */
const EXTENSION_SETTLE_MS = 1500

/**
 * OPTIONAL dependency-closure expansion (2026-12, default OFF).
 *
 * When ON, an extension plugin whose graph row declares a package dependency
 * that the chamber composite already covers gets that covered provider mounted
 * into the same child context first (its client half is already on the page
 * module table), so the plugin's services can resolve instead of leaving it
 * `inactive`.
 *
 * Why OFF by default: the dependent plugin's `inactive` notice already names
 * the missing service honestly, while mounting speculative providers widens
 * the surface for no proven benefit (a provider that registers into slots the
 * child context does not declare fails contained, but pointlessly). Enable per
 * evidence — i.e. when a real plugin's settings section is blocked by a
 * covered provider that is safe to mount in a reduced context.
 */
const DEPENDENCY_CLOSURE_ENABLED = false

/**
 * cordis FiberState values (const enum, inlined at build): PENDING=0,
 * LOADING=1, ACTIVE=2, FAILED=3, DISPOSED=4, UNLOADING=5.
 */
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3

/**
 * Wait until every child plugin fiber is ACTIVE. cordis `fiber.await()` only
 * settles the CURRENT load task — a fiber still waiting on an inject service
 * settles immediately without running its body — so a plain `Promise.all`
 * can return before the settings chain registered. Poll the fiber states
 * until the chain converged (all services here provide synchronously, so
 * convergence is a few microtask rounds). Each round races the pending
 * awaits against a short tick so the deadline check ALWAYS runs — a fiber
 * whose await() never settles must not hang the loading state forever
 * (fail-loud, never hang).
 * @param fibers - the child plugin fibers.
 */
async function waitForActive(fibers: readonly { state: number; await(): Promise<unknown> }[]): Promise<void> {
  const deadline = Date.now() + MOUNT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const pending = fibers.filter(fiber => fiber.state !== FIBER_ACTIVE && fiber.state !== FIBER_FAILED)
    if (pending.length === 0) {
      const failed = fibers.filter(fiber => fiber.state === FIBER_FAILED)
      if (failed.length > 0) {
        const reasons = await Promise.all(failed.map(fiber => fiber.await().catch(error => String(error))))
        throw new Error(`settings-bridge: child plugin chain failed: ${reasons.join(' | ')}`)
      }
      return
    }
    await Promise.race([
      Promise.all(pending.map(fiber => fiber.await().catch(() => {}))),
      new Promise(resolve => setTimeout(resolve, 250)),
    ])
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  const stuck = fibers
    .filter(fiber => fiber.state !== FIBER_ACTIVE && fiber.state !== FIBER_FAILED)
    .map(fiber => fiber.state)
    .join(', ')
  throw new Error(`settings-bridge: child plugin chain did not activate (states: ${stuck})`)
}

/** Mutable extension-phase state (one per session; published immutably). */
class ExtensionStore implements ExtensionObservable {
  private snapshot: ExtensionSnapshot = EMPTY_EXTENSION_SNAPSHOT
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): ExtensionSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Publish a new immutable snapshot (no-op when nothing observable changed). */
  publish(next: ExtensionSnapshot): void {
    const previous = this.snapshot
    if (previous.state === next.state
      && previous.reason === next.reason
      && previous.total === next.total
      && previous.signature === next.signature
      && previous.crashes.length === next.crashes.length
      && previous.omittedSeats.length === next.omittedSeats.length
      && contributionsEqual(previous.contributions, next.contributions)) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}

function contributionsEqual(a: readonly PluginContribution[], b: readonly PluginContribution[]): boolean {
  if (a.length !== b.length) return false
  return a.every((entry, index) => {
    const other = b[index] as PluginContribution
    return entry.id === other.id
      && entry.state === other.state
      && entry.error === other.error
      && (entry.seats ?? []).join(',') === (other.seats ?? []).join(',')
      && (entry.missing ?? []).join(',') === (other.missing ?? []).join(',')
      && (entry.sharedWith ?? []).join(',') === (other.sharedWith ?? []).join(',')
  })
}

/**
 * Assemble the child context for one instance: plugin fibers run once every
 * inject service is satisfied (all services here provide synchronously, so
 * waiting for ACTIVE yields the fully-registered base ledger); the extension
 * phase then streams the SOURCE'S OWN plugin contributions in. The bridge UI
 * renders through `slots` version ticks + the extension observable.
 * @param server - explicit target/transport projection plus the proxy id.
 */
export async function mountBridgeSession(server: RuntimeServerProjection): Promise<BridgeSession> {
  // Wiring lockstep (the chamber-entry assertCoveredFactoryLockstep precedent,
  // fail loud per mount): every plugin this assembly mounts must be declared in
  // the pure base list, or seat attribution would classify a base registration
  // as third-party and the covered-lockstep test would be looking at a
  // different set than the one actually mounted.
  for (const entry of BASE_PLUGINS) {
    if (!BASE_PLUGIN_IDS.includes(entry.id)) {
      throw new Error(`settings-bridge: base plugin "${entry.id}" is missing from base-plugins.ts`)
    }
  }
  const instanceId = server.id
  const ctx = new Context()
  // Declared OUTSIDE the try so an assembly failure after the phase started
  // (or a later throw before the session is returned) still cancels the phase
  // before the child context is disposed — a running phase must never touch a
  // disposed context.
  let phase: ExtensionPhase | undefined
  try {
    const api = getBridgeApiClient(instanceId)
    // Both faces are cordis SERVICES (2026-12): service method calls are
    // caller-bound, so a plugin's `ctx.remote.$on(...)` can be attributed to
    // that plugin's fiber — the honest source of the capability report.
    let onRemoteSubscription: (() => void) | undefined
    new BridgeConnectionService(ctx, api)
    const remote = new BridgeRemoteService(ctx, api, () => { onRemoteSubscription?.() })
    // The stub `remote` carries every namespace the mounted official plugins'
    // injects wait on (`remote.settings`, `remote.credentials`, `remote.llm`,
    // `remote.agentPresets`, `remote.session`, `remote.pluginInventory`) — the
    // official api-gateway provides each via $mount accessors; the stub
    // provides them as direct cordis services (property + service name, the
    // same pair the old pluginInventory face used). Without them the settings
    // chain can never satisfy its inject and the 5s mount gate fails loud.
    ctx.provide('remote.settings', api.settings)
    ctx.provide('remote.credentials', api.credentials)
    ctx.provide('remote.llm', api.llm)
    ctx.provide('remote.agentPresets', api.agentPresets)
    ctx.provide('remote.session', api.session)
    ctx.provide('remote.pluginInventory', api.pluginInventory)
    // The agent-preset settings section is not first-screen (LCP/perf pass,
    // P4): its bundle is a lazy vite chunk of the chamber build, fetched here
    // — at settings-page mount, well after the boot settled — instead of
    // being statically imported into the boot first chunk. Same section, same
    // mount path; only the chunk timing changes.
    const runtimePlugin = createRuntimeSectionPlugin(server)
    const plugins: NamedSettingsPlugin[] = [
      ...BASE_PLUGINS,
      { id: AGENT_PRESET_ID, plugin: await import('@deepseek-ai/dsh-client-ui-agent-preset/client') as SettingsPlugin },
      ...(runtimePlugin === null ? [] : [{ id: RUNTIME_SECTION_ID, plugin: runtimePlugin }]),
    ]
    const fibers = [
      ctx.plugin(DECLARATION_PLUGIN),
      ctx.plugin(SlotRegistry),
      ...plugins.map(entry => ctx.plugin({ ...entry.plugin, name: entry.id })),
    ] as readonly { state: number; await(): Promise<unknown> }[]
    await waitForActive(fibers)
    const slots = ctx.get('slots') as SlotRegistry
    const extensions = new ExtensionStore()
    // Entry-render crashes on this child context (a bridged plugin's section
    // throwing while rendering) are contained by the outlet boundary; the
    // supervision seam turns them into an addressable diagnostic instead of a
    // bare empty cell.
    const crashes: EntryCrash[] = []
    ctx.effect(() => slots.onEntryError((seat, entry, error) => {
      crashes.push({
        seat,
        ...(entry.registrant === undefined ? {} : { pluginId: entry.registrant }),
        detail: error instanceof Error ? error.message : String(error),
      })
      extensions.publish({ ...extensions.getSnapshot(), crashes: [...crashes] })
    }), 'settings-bridge: entry-error supervision')
    const extensionPhase = new ExtensionPhase({
      ctx,
      slots,
      store: extensions,
      crashes,
      instanceId,
      sourceFingerprint: server.sourceFingerprint,
      basePath: `/api/i/${instanceId}`,
      remoteSubscriptions: remote.subscriptions,
    })
    // A plugin subscribing to forwarded host events mid-session (or during
    // its apply, after the phase published) updates the report: the surface
    // must never let "no events" pass for "no changes".
    phase = extensionPhase
    onRemoteSubscription = () => { extensionPhase.republish() }
    // Fire-and-forget: the panel is usable as soon as the BASE chain is up,
    // and extension sections stream in (the ledger is reactive).
    void extensionPhase.start()
    return {
      ctx,
      instanceId,
      sourceFingerprint: server.sourceFingerprint,
      runtimeProjectionKey: runtimeServerProjectionKey(server),
      slots,
      locale: ctx.get('locale') as LocaleFace | undefined,
      extensions,
      refreshExtensions: () => extensionPhase.refresh(),
      dispose: async () => {
        extensionPhase.cancel()
        await ctx.fiber.dispose()
      },
    }
  } catch (error) {
    // A failed assembly still owns registered effects — cancel a started
    // extension phase and unload the whole child fiber tree before the
    // rejection escapes (no leak on retry). A dispose rejection must not
    // swallow the assembly error.
    phase?.cancel()
    await ctx.fiber.dispose().catch(() => {})
    throw error
  }
}

/** Everything one source's extension phase needs. */
interface ExtensionPhaseOptions {
  ctx: Context
  slots: SlotRegistry
  store: ExtensionStore
  crashes: EntryCrash[]
  instanceId: string
  sourceFingerprint: string
  basePath: string
  /** Caller-attributed `remote.$on` keys per plugin id (capability report). */
  remoteSubscriptions: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * The per-source extension phase: fetch (or reuse) the source's client plugin
 * graph, load every non-covered bundle into the page module table, and mount
 * each one into the child context with a contained verdict.
 *
 * Cancellation: every await is followed by a `cancelled` check, so a panel
 * close / source switch can never touch a disposed context.
 */
/** One plugin fiber mounted by the extension phase (disposed on reconcile/cancel). */
interface MountedPlugin {
  fiber: { dispose(): Promise<void> }
  /** The plugin's own root fiber (re-classification after late activations). */
  root: FiberLike
  /** Fibers observed while it mounted (root + nested `ctx.inject` descendants). */
  observed: readonly FiberLike[]
  /** Apply rejection captured at mount time, when any. */
  applyError?: unknown
}

class ExtensionPhase {
  private cancelled = false
  private running = false
  private readonly mounted = new Map<string, MountedPlugin>()
  private readonly options: ExtensionPhaseOptions

  constructor(options: ExtensionPhaseOptions) {
    this.options = options
  }

  /** Cancel the phase (session dispose). Idempotent. */
  cancel(): void {
    this.cancelled = true
    const mounted = [...this.mounted.entries()]
    this.mounted.clear()
    for (const [id, entry] of mounted) {
      notePluginUnmounted(id, this.options.instanceId)
      void entry.fiber.dispose().catch(() => {})
    }
  }

  /** Start the phase (idempotent per session). */
  async start(): Promise<void> {
    await this.run(false)
  }

  /** Re-read the graph and reconcile the mounted extension set (manual refresh). */
  async refresh(): Promise<void> {
    if (this.cancelled) return
    await this.run(true)
  }

  /** Dispose one mounted plugin and forget its page-level sharing fact. */
  private async unmount(id: string, record: MountedPlugin): Promise<void> {
    this.mounted.delete(id)
    notePluginUnmounted(id, this.options.instanceId)
    await record.fiber.dispose().catch(() => {})
  }

  /** Re-publish the current snapshot with fresh capability decoration. */
  republish(): void {
    const snapshot = this.options.store.getSnapshot()
    if (snapshot.contributions.length === 0) return
    this.publish({ contributions: decorateContributions(snapshot.contributions, this.options.remoteSubscriptions) })
  }

  private publish(next: Partial<ExtensionSnapshot>): void {
    this.options.store.publish({
      ...this.options.store.getSnapshot(),
      ...next,
      contributions: this.reclassify(decorateContributions(
        next.contributions ?? this.options.store.getSnapshot().contributions,
        this.options.remoteSubscriptions,
      )),
      crashes: [...this.options.crashes],
    })
  }

  /**
   * Re-derive every mounted plugin's verdict from its LIVE fiber tree before
   * publishing. A plugin can activate AFTER its first verdict (its required
   * service is provided by another extension plugin mounted later in the same
   * phase, or by an asynchronous provider); freezing the first verdict would
   * report a working section as inactive — the exact dishonesty this surface
   * exists to prevent.
   * @param contributions - the contributions about to be published.
   * @returns the same list with fresh states and current seats.
   */
  private reclassify(contributions: readonly PluginContribution[]): PluginContribution[] {
    return contributions.map((contribution) => {
      const record = this.mounted.get(contribution.id)
      if (record === undefined) return contribution
      const fresh = classifyContribution(contribution.id, record.root, record.observed, record.applyError)
      if (fresh.state === contribution.state) return contribution
      return mergeContributionVerdict(contribution, fresh, contributedSeats(this.options.slots, contribution.id))
    })
  }

  /**
   * One phase run.
   * @param force - bypass the page-level graph cache (manual refresh).
   */
  private async run(force: boolean): Promise<void> {
    if (this.cancelled || this.running) return
    this.running = true
    const { slots, instanceId, sourceFingerprint, basePath } = this.options
    try {
      const loader = clientPluginLoader()
      if (loader === null || loader.modules === undefined) {
        this.publish({ state: 'unavailable', reason: 'page-module-table-unavailable', total: 0 })
        return
      }
      this.publish({ state: 'loading' })
      const raw = force
        ? await this.fetchGraph()
        : (cachedSourceClientGraph(instanceId, sourceFingerprint)?.rows ?? await this.fetchGraph())
      if (this.cancelled) return
      if (raw === null) return // fetchGraph already published the reason
      const projection = projectExtensionRows(raw, loader.coveredIds ?? [], basePath)
      const rows = projection.rows
      const signature = clientRowSignatures(rows).idSet
      const previous = this.options.store.getSnapshot().contributions
      // RECONCILE (manual refresh / re-open): a plugin already mounted and
      // still present keeps its fiber AND its verdict (re-mounting it would
      // duplicate its registrations on this context); a row whose previous
      // verdict was failed/skipped is retried from scratch; a plugin that left
      // the graph is disposed. Rows the projector dropped (unsafe bundle URL)
      // are reported as that plugin's failure — a poisoned host graph must
      // never disappear silently.
      const retained: PluginContribution[] = []
      const toMount: ClientPluginRow[] = []
      const present = new Set(rows.map(row => row.id))
      for (const row of rows) {
        const existing = this.mounted.get(row.id)
        const verdict = previous.find(entry => entry.id === row.id)
        if (existing !== undefined && verdict !== undefined
          && (verdict.state === 'active' || verdict.state === 'inactive')) {
          retained.push(verdict)
        } else {
          if (existing !== undefined) await this.unmount(row.id, existing)
          toMount.push(row)
        }
      }
      for (const [id, record] of [...this.mounted]) {
        if (!present.has(id)) await this.unmount(id, record)
      }
      const outcomes = await loadClientPluginRows(instanceId, toMount, {
        loadBundle: url => loader.loadBundle(url),
      }, { ordinary: 'defer', timeout: 'collect' })
      if (this.cancelled) return
      const failures = new Map<string, string>()
      const revConflicts = new Map<string, 'restart' | 'version'>()
      for (const outcome of outcomes) {
        if (outcome.state === 'failed') failures.set(outcome.row.id, messageOf(outcome.error))
        if (outcome.state === 'rev-conflict') revConflicts.set(outcome.row.id, outcome.conflict)
      }
      const mountedNow: PluginContribution[] = []
      for (const dropped of projection.dropped) {
        mountedNow.push({ id: dropped.id, state: 'failed', error: dropped.reason })
      }
      // OPTIONAL dependency closure (default OFF, see DEPENDENCY_CLOSURE_ENABLED):
      // mount covered providers first so the plugins that declared them can
      // resolve. Providers are attributed as `role: 'provider'` and never
      // produce user-facing notices.
      if (DEPENDENCY_CLOSURE_ENABLED) {
        const providers = dependencyClosureProviders(
          toMount,
          loader.coveredIds ?? [],
          [...this.mounted.keys(), ...BASE_PLUGIN_IDS],
        )
        for (const providerId of providers) {
          if (this.cancelled) return
          const provider = await this.mountRow(
            { id: providerId, url: '', rev: '' },
            loader.modules,
            'provider',
          )
          mountedNow.push(provider)
        }
      }
      for (const row of toMount) {
        if (this.cancelled) return
        const loadFailure = failures.get(row.id)
        if (loadFailure !== undefined) {
          mountedNow.push({ id: row.id, state: 'failed', error: `bundle load failed: ${loadFailure}` })
          continue
        }
        const mounted = await this.mountRow(row, loader.modules)
        const conflict = revConflicts.get(row.id)
        mountedNow.push(conflict === undefined ? mounted : { ...mounted, revConflict: conflict })
      }
      if (this.cancelled) return
      this.publish({
        state: 'ready',
        total: rows.length,
        contributions: [...retained, ...mountedNow],
        omittedSeats: omittedSeatContributions(slots, isBasePluginId),
        signature,
      })
    } catch (error) {
      if (this.cancelled) return
      // A phase failure must not strand the panel: report it, keep whatever the
      // base chain already rendered.
      this.publish({ state: 'unavailable', reason: messageOf(error) })
    } finally {
      this.running = false
    }
  }

  /** Fetch the source's graph; publishes the unavailable reason on failure. */
  private async fetchGraph(): Promise<ClientPluginRow[] | null> {
    const { instanceId, sourceFingerprint } = this.options
    try {
      const result = await getBridgeApiClient(instanceId).clientGraph.graph()
      if (this.cancelled) return null
      if (!result.ok) {
        this.publish({
          state: 'unavailable',
          reason: `clientGraph/graph: ${result.error.code} ${result.error.message}`.trim(),
        })
        return null
      }
      const rows = parseClientGraphRows(result.value)
      publishSourceClientGraph(instanceId, { sourceFingerprint, rows })
      return rows
    } catch (error) {
      if (!this.cancelled) this.publish({ state: 'unavailable', reason: messageOf(error) })
      return null
    }
  }

  /**
   * Mount one extension row into the child context and classify the result.
   * Never throws: every failure becomes that plugin's verdict.
   */
  private async mountRow(
    row: ClientPluginRow,
    modules: { import(specifier: string): Promise<unknown> },
    role: 'contribution' | 'provider' = 'contribution',
  ): Promise<PluginContribution> {
    const { ctx, slots } = this.options
    let namespace: unknown
    try {
      namespace = await modules.import(row.id)
    } catch (error) {
      return { id: row.id, state: 'failed', error: `module table: ${messageOf(error)}` }
    }
    if (this.cancelled) return { id: row.id, state: 'skipped' }
    const normalized = normalizePluginNamespace(namespace)
    if (normalized === null) return { id: row.id, state: 'skipped' }
    // Observe every fiber created from here on so a plugin that registers its
    // settings contribution inside a nested `ctx.inject(...)` is classified by
    // its real waiters, not by its (active) root fiber alone.
    const observed: FiberLike[] = []
    const off = ctx.on('internal/plugin', (fiber: FiberLike) => { observed.push(fiber) })
    // The session may be cancelled (context disposed) while a mount settles;
    // unsubscribing an already-disposed context must not turn a containment
    // verdict into a thrown assembly error.
    const disposeObserver = (): void => {
      try {
        off()
      } catch {
        // The child context is already gone — nothing left to unsubscribe.
      }
    }
    let root: (FiberLike & { await(): Promise<unknown>; dispose(): Promise<void> }) | undefined
    let applyError: unknown
    try {
      root = ctx.plugin(
        normalized.nameable ? { ...(normalized.plugin as object), name: row.id } : normalized.plugin,
      ) as unknown as FiberLike & { await(): Promise<unknown>; dispose(): Promise<void> }
    } catch (error) {
      disposeObserver()
      return { id: row.id, state: 'failed', error: messageOf(error) }
    }
    try {
      await withTimeout(root.await().catch((error: unknown) => { applyError = error }), EXTENSION_SETTLE_MS)
    } catch {
      // Settle budget exhausted: the verdict below reads the live fiber state.
    }
    disposeObserver()
    if (this.cancelled) return { id: row.id, state: 'skipped' }
    const classified = classifyContribution(row.id, root, observed, applyError)
    const verdict: PluginContribution = role === 'contribution' ? classified : { ...classified, role }
    const seats = contributedSeats(slots, row.id)
    // Track EVERY mounted fiber, including failed ones: a manual refresh must
    // dispose the old fiber before retrying the same id, or the retry would
    // register a second copy on this context.
    this.mounted.set(row.id, {
      fiber: root,
      root,
      observed: [...observed],
      ...(applyError === undefined ? {} : { applyError }),
    })
    if (verdict.state === 'failed' || verdict.state === 'skipped') {
      return seats.length === 0 ? verdict : { ...verdict, seats }
    }
    if (verdict.state === 'active' && seats.length > 0) {
      const sharedWith = notePluginMounted(row.id, this.options.instanceId)
      return {
        ...verdict,
        seats,
        ...(sharedWith.length === 0 ? {} : { sharedWith }),
      }
    }
    // Active-but-no-settings-seat: kept mounted (it may provide a service
    // another plugin needs); inactive: the fiber stays PENDING and holds no
    // registrations, and a service provided later in this session could still
    // activate it — both are reported with their seats (possibly empty).
    return { ...verdict, seats }
  }
}

/** Resolve when `promise` settles, or reject at the budget (the caller decides). */
async function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('settings-bridge: extension settle budget exhausted')) }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Navigation row projection helper: mirror the official shell's ledger → row logic. */
export function sectionRows(slots: SlotRegistry): { id: string; order: number; label: string; registrant?: string }[] {
  return slots.entries('settings.section')
    .map((entry: StoredEntry) => {
      const raw = typeof entry.options.label === 'function' ? entry.options.label() : entry.options.label
      return {
        id: entry.options.id ?? '',
        order: entry.options.order ?? 0,
        label: raw === undefined || raw === null ? '' : String(raw),
        ...(entry.registrant === undefined ? {} : { registrant: entry.registrant }),
      }
    })
    .sort((a, b) => a.order - b.order)
}

