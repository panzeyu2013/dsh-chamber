/**
 * Bridge-rows plugin (design decision 2026-08): the chamber self-built rows
 * for the General settings page — Composer busy-Enter behavior and the
 * Permission default preset. The official rows (ui-conversation /
 * ui-permission-presets) are coupled to session-family fibers that cannot
 * run on the child context, so this plugin re-registers the same
 * `settings.general.item` entries (official ids/orders) backed by
 * self-built components over the official wire contract: the host's
 * `ui-conversation` / `permission` settings namespaces via describe/mutate.
 *
 * Invalidation rides the same no-op stub remote as every other bridged
 * surface (no WS stream — refresh on re-entry/switch, recorded deviation);
 * the settingsScope binding and the invalidation subscriptions are wired for
 * parity, so a future real remote gains push invalidation for free.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { conversationZh, conversationEn, permissionZh, permissionEn } from './locales.ts'
import { BusyEnterPolicy, CONVERSATION_SETTINGS_NAMESPACE } from './enter-row-controller.ts'
import type { BusyEnterBehavior } from './enter-row-controller.ts'
import { EnterBehaviorRow } from './EnterBehaviorRow.tsx'
import { PermissionPresetSettingsController } from './permission-row-controller.ts'
import type { PermissionSettingsApi } from './permission-row-controller.ts'
import { PERMISSION_SETTINGS_NS } from './permission-row-controller.ts'
import { permissionDefaultOf } from './permission-decode.ts'
import { PermissionRow } from './PermissionRow.tsx'

/** Dictionary namespace of the conversation row (official NS, unclaimed on the child ctx). */
const CONVERSATION_NS = 'conversation'

/** Dictionary namespace of the permission row (official NS). */
const PERMISSION_NS = 'settings.permission'

/** Required services (cordis fiber inject; all provided by the child context). */
export const inject = ['slots', 'locale', 'connection', 'settingsScope', 'remote', 'settingsSchema']

/**
 * Register the bridge rows once the `settings.general.item` declaration is
 * on the ledger (deferred via slots.inject — activation order vs the
 * official section plugins is unconstrained).
 * @param ctx - child client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(CONVERSATION_NS, { zh: conversationZh, en: conversationEn }),
    'bridge-rows: conversation row dictionaries')
  ctx.effect(() => ctx.locale.register(PERMISSION_NS, { zh: permissionZh, en: permissionEn }),
    'bridge-rows: permission row dictionaries')

  // Busy-Enter: the durable preference lives in the host's `ui-conversation`
  // namespace; the policy adopts it and writes field changes back through
  // the child settingsScope (isLoopback=true → persists to the target host).
  const scope = ctx.settingsScope.bind<{ busyEnter?: BusyEnterBehavior }>({
    namespace: CONVERSATION_SETTINGS_NAMESPACE,
  })
  const policy = new BusyEnterPolicy(scope)

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'composer-enter',
    order: 20,
    locale: CONVERSATION_NS,
    inject: () => ({
      hooks: { busyEnter: policy.busyEnter },
      setBusyEnter: (behavior: BusyEnterBehavior) => { policy.setBusyEnter(behavior) },
    }),
  }, EnterBehaviorRow))

  // Permission default: host descriptor read + revision-guarded mutate. The
  // schema-envelope decode needs the settings-owned schema service, which the
  // child ui-settings plugin provides on this ctx.
  const api = (ctx.get('connection') as unknown as { api: PermissionSettingsApi }).api
  const permission = new PermissionPresetSettingsController(
    api, permissionDefaultOf, ctx.get('settingsSchema'))

  // Pushed invalidations converge the open row without polling: the stub
  // remote drops them today (no-op $on) — the wiring mirrors the official
  // controllers and activates automatically if a real remote arrives.
  ctx.effect(() => {
    const refresh = (namespace?: unknown): void => {
      if (namespace !== undefined && namespace !== PERMISSION_SETTINGS_NS) return
      void permission.load()
    }
    const remote = ctx.get('remote') as { $on(event: string, fn: (...args: unknown[]) => void): () => void }
    const disposers = [
      remote.$on('settings/document-updated', refresh),
      ctx.on('connection/reset', () => { refresh() }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
      permission.dispose()
    }
  }, 'bridge-rows: permission invalidations')

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'permission',
    order: -20,
    locale: PERMISSION_NS,
    inject: () => ({
      hooks: { permission: permission.store },
      load: () => permission.load(),
      select: (preset: string) => permission.select(preset),
    }),
  }, PermissionRow))
}
