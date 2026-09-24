/**
 * Chamber connections settings plugin, browser half: the dictionary namespace of the chamber
 * settings shell's fixed「连接 / Connections」page (local instance card — health / connections row /
 * host logs — plus the remote host roster: registry CRUD, connect/disconnect, systemd control,
 * ring-buffer logs). The shell renders the page through its fixed nav id; this plugin owns the
 * copy and the section component.
 * All data rides page-level surfaces (desktopSsh IPC + control-plane REST client) — no host
 * frames, no dsh runtime objects. Non-secret metadata only: the form never asks for SSH material,
 * and nothing here ever sees a tunnel URL.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
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
 * Register the connections dictionary namespace the settings shell binds. No slot registration:
 * the section is a FIXED chamber-global nav page, not a per-source ledger row.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chamber: settings connections dictionaries')

  // No host-ctx `settings.section` registration: the shell renders ConnectionsSection through its
  // fixed nav id (`__connections`), and the panel renders the SELECTED source's own settings ledger
  // instead of assembling a second plugin set. The settings cluster is registered all-or-nothing, so
  // this entry could not serve as a fallback for a failed shell chunk either; keeping the ledger clean
  // also removes the "second connections page" hazard.
}
