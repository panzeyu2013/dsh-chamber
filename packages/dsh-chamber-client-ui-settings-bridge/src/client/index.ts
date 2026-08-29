/**
 * Chamber settings shell plugin (design discussion 2026-08), browser half:
 * registers the「设置 / Settings」shell into the `sidebar.settings` slot at a
 * LOWER priority than the official SettingsRoot registration, so the
 * official shell is shadowed (never conflicts — the official entry stays on
 * the ledger and its settings.* children declarations remain valid). The
 * shell itself (SettingsShell.tsx) mounts a child cordis context per selected
 * server and renders the chamber-global connections surface as a fixed nav
 * entry — no chamber-side persistence, no new control-plane API; every
 * configuration fact stays on the target host.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the slot registry face (ctx.slots) and the sidebar seat
// ('sidebar.settings') into this program.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { SettingsShell } from './SettingsShell.tsx'
import type { SettingsShellInjected } from './SettingsShell.tsx'
import { en, zh, type SettingsBridgeKey } from '../locales.ts'

export type { SettingsShellInjected, SettingsShellProps } from './SettingsShell.tsx'
export type { SettingsBridgeKey } from '../locales.ts'
export type { DshRuntimeSectionProps, DshRuntimeSource } from './DshRuntimeSection.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The chamber settings shell copy. */
    'dsh-chamber.settings.bridge': SettingsBridgeKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'dsh-chamber.settings.bridge'

/** The embedded connections section's dictionary namespace (owned by dsh-client-ui-settings-connections). */
const CONNECTIONS_NS = 'dsh-chamber.settings.connections'

/**
 * Shadow priority: the official SettingsRoot registers at the default 0;
 * the slot core's shadowing rule renders the LOWEST priority winner, so -1
 * replaces the official shell without touching its ledger entry.
 */
const SHADOW_PRIORITY = -1

/** Required services: the slot registry and the locale face. */
export const inject = ['slots', 'locale']

/**
 * Register the chamber settings shell once the `sidebar.settings` declaration
 * is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chamber: settings shell dictionaries')

  const t = ctx.locale.bind(NS)
  const connectionsT = ctx.locale.bind(CONNECTIONS_NS)
  const chamberInstanceId = (ctx as ClientContext & { chamberInstanceId?: string }).chamberInstanceId
  const injected = (): SettingsShellInjected => ({ t, connectionsT, chamberInstanceId })

  ctx.slots.inject('sidebar.settings', () => ctx.slots.register({
    name: 'sidebar.settings',
    id: 'chamber-shell',
    priority: SHADOW_PRIORITY,
    label: () => t('trigger'),
    inject: injected,
  }, SettingsShell))
  // The per-server「dsh 运行时」settings.section is NOT registered here: the
  // shell renders the SELECTED server's child-cordis-context ledger, so the
  // section registers per session via createRuntimeSectionPlugin(instanceId)
  // in bridge-context.ts (design 18 §3.6 修订 + design 05 §5).
}
