/**
 * Chamber connections settings section plugin (design 05 §5), browser half:
 * registers the "连接 / Connections" entry into the settings panel's
 * `settings.section` slot — the local instance card (health / connections
 * row / host logs) plus the remote host roster (registry CRUD, connect/
 * disconnect, on-demand systemd control, ring-buffer logs).
 *
 * All data rides page-level surfaces (window.dshChamber.desktopSsh IPC +
 * the control-plane REST client) — no host frames, no dsh runtime objects.
 * Non-secret metadata only: the form never asks for SSH material, and
 * nothing here ever sees a tunnel URL.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ConnectionsSection } from './ConnectionsSection.tsx'
import type { ConnectionsSectionInjected } from './ConnectionsSection.tsx'
import { en, zh, type SettingsConnectionsKey } from '../locales.ts'

export type { ConnectionsSectionInjected, ConnectionsSectionProps, PluginDiagnostic } from './ConnectionsSection.tsx'
export type { SettingsConnectionsKey } from '../locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The connections settings section copy. */
    'dsh-chamber.settings.connections': SettingsConnectionsKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'dsh-chamber.settings.connections'

/** Required services: the slot registry and the locale face. */
export const inject = ['slots', 'locale']

/**
 * Register the connections section once the `settings.section` declaration
 * is on the ledger. The inject face carries the bound translate (the same
 * one the nav label thunk reads); everything else the section needs is
 * page-level (IPC / control-plane REST), so no further services are wired.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chamber: settings connections dictionaries')

  const t = ctx.locale.bind(NS)
  const injected = (): ConnectionsSectionInjected => ({ t })

  // NOTE (2026-12 audit D-5): this host-ctx (chamber boot ctx) settings.section
  // ledger entry id 'connections' has NO renderer in any current shape — the
  // desktop chamber settings shell always renders ConnectionsSection through
  // its fixed nav id '__connections' (settings-bridge SettingsShell.tsx +
  // nav-active.ts CONNECTIONS_SECTION_ID) and the shell's child-ctx ledgers
  // (bridge-context mountBridgeSession) never mount this plugin. It is a
  // leftover of the settings-shell nav rework (the section used to be a plain
  // ledger row of the official settings page). Kept on purpose: removing it
  // changes the host-ctx ledger shape, and if a future host-ctx ledger
  // rendering path ever appears it would show a SECOND connections page next
  // to the fixed one — delete this registration when that path is designed
  // (the fixed '__connections' entry renders the same component).
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'connections',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, ConnectionsSection))
}
