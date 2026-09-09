/**
 * Chamber connections settings plugin (design 05 §5), browser half: the
 * dictionary namespace of the chamber settings shell's fixed「连接 /
 * Connections」page (local instance card — health / connections row / host
 * logs — plus the remote host roster: registry CRUD, connect/disconnect,
 * on-demand systemd control, ring-buffer logs). The page itself is rendered by
 * the chamber settings shell through its fixed nav id; this plugin owns the
 * copy and the section component (2026-12: the old host-ctx `settings.section`
 * registration was removed — see apply).
 *
 * All data rides page-level surfaces (window.dshChamber.desktopSsh IPC +
 * the control-plane REST client) — no host frames, no dsh runtime objects.
 * Non-secret metadata only: the form never asks for SSH material, and
 * nothing here ever sees a tunnel URL.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
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

/** Required service: the locale face (the shell binds this namespace). */
export const inject = ['locale']

/**
 * Register the connections dictionary namespace the settings shell binds
 * (`ctx.locale.bind('dsh-chamber.settings.connections')`, settings-bridge
 * index.ts). No slot registration: the section is a FIXED chamber-global nav
 * page, not a per-source ledger row.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chamber: settings connections dictionaries')

  // 2026-12 (audit D-5 resolved): the host-ctx (chamber boot ctx)
  // `settings.section` registration is GONE. It never had a renderer in any
  // shape — the desktop chamber settings shell renders ConnectionsSection
  // through its fixed nav id (`__connections`, SettingsShell.tsx +
  // nav-active.ts CONNECTIONS_SECTION_ID) and the per-source child contexts
  // (bridge-context mountBridgeSession) never mount this plugin. The settings
  // cluster is registered all-or-nothing (chamber-entry registerDeferred), so
  // the entry could not even serve as a fallback for a failed settings-shell
  // chunk: that failure drops this plugin's registration too. Keeping the
  // ledger clean also removes the "second connections page" hazard if a
  // host-ctx ledger rendering path ever appears.
}
