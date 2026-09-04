/**
 * Client-plugin runtime-loading diagnostic (design 09 §3.5): the pure,
 * UI-free projection helpers for one instance's plugin-graph load outcome.
 * Split from plugin-diagnostic.tsx so the plain-node test suite (which cannot
 * execute .tsx or CSS modules) can cover the state → tone/text decision —
 * mirroring the plugin-diff.ts split (plan 24 D5-A merged the former
 * PluginSyncModal/PluginInventoryView split into PluginDialog).
 */

import type { SettingsConnectionsKey } from '../locales.ts'

/** Client-plugin runtime-loading diagnostic for one instance (design 09). */
export interface PluginDiagnostic {
  state: 'ok' | 'not-injected' | 'graph-unreachable' | 'bundle-load-failed' | 'restart-required' | 'instance-version-conflict'
  message?: string
  pluginId?: string
}

/** Localized text for a client-plugin diagnostic state (design 09). */
export function pluginDiagnosticText(state: PluginDiagnostic['state'], t: (key: SettingsConnectionsKey) => string): string {
  switch (state) {
    case 'ok': return t('pluginDiagnosticOk')
    case 'not-injected': return t('pluginDiagnosticNotInjected')
    case 'graph-unreachable': return t('pluginDiagnosticGraphUnreachable')
    case 'bundle-load-failed': return t('pluginDiagnosticBundleFailed')
    case 'instance-version-conflict': return t('pluginDiagnosticInstanceVersionConflict')
    default: return t('pluginDiagnosticRestartRequired')
  }
}

/** Severity tone: a version conflict is informational, every other non-ok
 *  state is a problem. Cards use the tone for color; the detail (plugin id +
 *  reason) is shown for problems on the card and always in the plugin dialog.
 *  Unknown future states fall through to 'problem' (fail-safe, never silent). */
export function pluginDiagnosticTone(state: PluginDiagnostic['state']): 'ok' | 'info' | 'problem' {
  if (state === 'ok') return 'ok'
  if (state === 'instance-version-conflict') return 'info'
  return 'problem'
}

/** De-duplicated diagnostic banner projection (plan 24 B1.4): the renderer
 *  prints only `title：detail`. The short state name is the title; the
 *  detail is the message when present (the richest fact), otherwise the
 *  pluginId, otherwise null — the state-name + plugin-id + full-message
 *  triple repetition of one fact never reaches the screen. */
export interface PluginDiagnosticBanner {
  title: string
  detail: string | null
}

/** Fold one diagnostic into the de-duplicated banner projection. */
export function bannerProjection(
  diagnostic: PluginDiagnostic,
  t: (key: SettingsConnectionsKey) => string,
): PluginDiagnosticBanner {
  const message = diagnostic.message !== undefined && diagnostic.message !== ''
    ? diagnostic.message
    : null
  const pluginId = diagnostic.pluginId !== undefined && diagnostic.pluginId !== ''
    ? diagnostic.pluginId
    : null
  return {
    title: pluginDiagnosticText(diagnostic.state, t),
    detail: message ?? pluginId,
  }
}
