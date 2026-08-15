/**
 * Child cordis context assembly for one bridged instance (settings bridge,
 * design discussion 2026-08): an INDEPENDENT root Context (no parent
 * inheritance — full service isolation from the hosting boot) with a fake
 * `connection` (per-instance unary client + loopback=true) and a stub
 * `remote` (no WS stream; invalidation subscriptions become no-ops). The
 * official settings plugin subset runs on this ctx, so every registered
 * section/row binds its controllers and settings scopes to the TARGET
 * instance's RPC surface; the hosting boot's own ledger/scope/events are
 * untouched. Plugins whose inject declares session-family services
 * (ui-conversation, ui-permission-presets, the agent-preset seat/label
 * fibers) never activate here by design; their General-page rows
 * (composer-enter / permission) are replaced by the self-built BridgeRows
 * plugin over the same host settings facts (bridge-rows/).
 *
 * Teardown: dispose() unloads the root fiber (all plugin effects, slot
 * registrations, and settings-scope subscriptions).
 */
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry, type ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { LocaleFace, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { getBridgeApiClient, type BridgeApiClient, type BridgeRpcResult } from './bridge-api.ts'

import * as UiSettings from '@deepseek-ai/dsh-client-ui-settings/client'
import * as UiSettingsGeneral from '@deepseek-ai/dsh-client-ui-settings-general/client'
import * as UiSettingsModels from '@deepseek-ai/dsh-client-ui-settings-models/client'
import * as UiSettingsPlugins from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import * as UiSettingsPluginInventory from '@deepseek-ai/dsh-client-ui-settings-plugin-inventory/client'
import * as UiAgentPreset from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import * as LocalePlugin from '@deepseek-ai/dsh-client-locale/client'
import * as UiTheme from '@deepseek-ai/dsh-client-ui-theme/client'
import * as BridgeRows from './bridge-rows/index.ts'

/**
 * The fake connection handle (shape mirror of the official ConnectionHandle):
 * only the surfaces the settings plugins consume are real — `api` (the
 * per-instance bridge client) and `isLoopback` (true, so settings scopes and
 * welcome onboarding persist to the TARGET host, never memory mode).
 */
export interface FakeConnectionHandle {
  api: BridgeApiClient
  isLoopback: boolean
  hostDescription: null
  rpc: Record<string, never>
  start: () => { stop(): void }
}

/** The plugin-inventory remote face (Typert Remote result shape — the official tab reads result.ok / result.error / result.value). */
function pluginInventoryFace(api: BridgeApiClient) {
  return {
    list: async (): Promise<BridgeRpcResult> => {
      const envelope = await api.pluginInventory.list()
      return envelope.result
    },
  }
}

/**
 * Stub remote for the child context: forwarded-event subscriptions collect
 * as no-ops (no WS stream), while the Typert remote services the mounted
 * plugins actually call are exposed as plain properties (the official
 * api-gateway mounts them via cordis accessors; a plain object property is
 * the equivalent for the stub).
 */
function buildRemoteStub(api: BridgeApiClient) {
  return {
    $on(_key: string, _fn: (...args: never[]) => void): () => void {
      return () => {}
    },
    $dispatch(_event: unknown, _args: unknown[]): void {},
    pluginInventory: pluginInventoryFace(api),
  }
}

/** The rendered side of one bridged instance: the live child context and its service faces. */
export interface BridgeSession {
  /** The instance this session was assembled for ('local' or 'ssh-<id>'). */
  instanceId: string
  /** The independent child context (the rendering React tree must not call ctx methods outside the plugin fibers). */
  ctx: Context
  /** The child slot registry instance (read faces only: entries/entriesOfSlot/getVersion/subscribe/spec). */
  slots: SlotRegistry
  /** The child locale face (undefined until the locale plugin activated). */
  locale: LocaleFace | undefined
  /** Unload the whole child fiber tree (plugins, slots, scopes). */
  dispose(): Promise<void>
}

/** One official settings plugin row (inject + apply pair from the package's client half). */
type SettingsPlugin = { inject: readonly string[]; apply(ctx: ClientContext): void }

/** The official settings plugin subset the child context mounts. */
const SETTINGS_PLUGINS: readonly SettingsPlugin[] = [
  UiSettings,
  LocalePlugin,
  UiTheme,
  UiSettingsGeneral,
  UiSettingsModels,
  UiSettingsPlugins,
  UiSettingsPluginInventory,
  UiAgentPreset,
  BridgeRows,
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
  apply(ctx: ClientContext): void {
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

/**
 * Assemble the child context for one instance: plugin fibers run once every
 * inject service is satisfied (all services here provide synchronously, so
 * waiting for ACTIVE yields the fully-registered ledger); the bridge UI then
 * renders through `slots` version ticks.
 * @param instanceId - 'local' or 'ssh-<id>' (the /api/i/<id> prefix key).
 */
export async function mountBridgeSession(instanceId: string): Promise<BridgeSession> {
  const ctx = new Context()
  try {
    const api = getBridgeApiClient(instanceId)
    const connection: FakeConnectionHandle = {
      api,
      isLoopback: true,
      hostDescription: null,
      rpc: {},
      start: () => ({ stop() {} }),
    }
    ctx.provide('connection', connection)
    ctx.provide('remote', buildRemoteStub(api))
    // The `remote.pluginInventory` cordis service name the plugin-inventory
    // plugin's inject waits on (the official api-gateway provides it via
    // $mount; the stub provides it directly).
    ctx.provide('remote.pluginInventory', pluginInventoryFace(api))
    const fibers = [
      ctx.plugin(DECLARATION_PLUGIN),
      ctx.plugin(SlotRegistry),
      ...SETTINGS_PLUGINS.map(plugin => ctx.plugin(plugin)),
    ] as readonly { state: number; await(): Promise<unknown> }[]
    await waitForActive(fibers)
    return {
      ctx,
      instanceId,
      slots: ctx.get('slots') as SlotRegistry,
      locale: ctx.get('locale') as LocaleFace | undefined,
      dispose: () => ctx.fiber.dispose(),
    }
  } catch (error) {
    // A failed assembly still owns registered effects — unload the whole
    // child fiber tree before the rejection escapes (no leak on retry). A
    // dispose rejection must not swallow the assembly error.
    await ctx.fiber.dispose().catch(() => {})
    throw error
  }
}

/** Navigation row projection helper: mirror the official shell's ledger → row logic. */
export function sectionRows(slots: SlotRegistry): { id: string; order: number; label: string }[] {
  return slots.entries('settings.section')
    .map((entry: StoredEntry) => {
      const raw = typeof entry.options.label === 'function' ? entry.options.label() : entry.options.label
      return {
        id: entry.options.id ?? '',
        order: entry.options.order ?? 0,
        label: raw === undefined || raw === null ? '' : String(raw),
      }
    })
    .sort((a, b) => a.order - b.order)
}
