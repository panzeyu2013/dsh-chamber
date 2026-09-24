/**
 * Client-plugin runtime-loading diagnostic: pure, UI-free projection helpers for one instance's
 * plugin-graph load outcome. Split from plugin-diagnostic.tsx so the plain-node test suite (which
 * cannot execute .tsx or CSS modules) can cover the state → tone/text decision.
 */

import type { SettingsConnectionsKey } from '../locales.ts'
// The settled-boot gap vocabulary is OWNED by the sidebar's shared bridge contract: this package
// imports the TYPE, not a copy of the union. The payload extraction (bootGapShape) is the same
// shared face's implementation — this file's ONE runtime dependency.
import { bootGapShape, type ServerBootGap } from '@dsh-chamber/dsh-chamber-client-core'

export type { ServerBootGap }

/** Client-plugin runtime-loading diagnostic for one instance (design 09). */
export interface PluginDiagnostic {
  state: 'ok' | 'not-injected' | 'graph-unreachable' | 'bundle-load-failed' | 'restart-required' | 'instance-version-conflict'
  message?: string
  pluginId?: string
}

/**
 * Localized text for a settled-boot GAP.
 *
 * A SEPARATE fact from {@link PluginDiagnostic}: that diagnostic describes the host boot-GRAPH
 * channel — its `ok` is legitimate when the graph was fetched and every row that arrived applied —
 * while a gap says a whole surface is missing although the boot settled. The classic case (a page
 * surface never provided) leaves the graph channel at `ok`, which is why the card renders this
 * line INSTEAD of an ok diagnostic. Exhaustive by construction: no `default` plus the declared
 * `string` return makes a future kind a compile error; an empty payload degrades to the generic
 * sentence rather than rendering "缺少  ".
 * @param gap - the structured gap fact from the bridge projection.
 * @returns the localized sentence.
 */
export function bootGapText(
  gap: ServerBootGap,
  t: (key: SettingsConnectionsKey, params?: Record<string, string | number>) => string,
): string {
  // Payload extraction is the shared projection; this switch maps the shape onto the connections
  // dictionary. The LOCAL instance's missing graph endpoint is a chamber-side seed fact.
  const shape = bootGapShape(gap)
  switch (shape.key) {
    case 'graph-unavailable':
      return t('bootGapGraphUnavailable')
    case 'local-graph-not-injected':
      return t('bootGapLocalGraphNotInjected')
    case 'required-services-missing':
      return t('bootGapRequiredServicesMissing', { services: shape.services })
    case 'deferred-registration-failed':
      return t('bootGapDeferredRegistrationFailed', { n: shape.failed })
    case 'generic':
      return t('bootGapGeneric')
  }
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

/** Severity tone: a version conflict is informational, every other non-ok state is a problem.
 *  Unknown future states fall through to 'problem' (fail-safe, never silent). */
export function pluginDiagnosticTone(state: PluginDiagnostic['state']): 'ok' | 'info' | 'problem' {
  if (state === 'ok') return 'ok'
  if (state === 'instance-version-conflict') return 'info'
  return 'problem'
}

/** De-duplicated diagnostic banner projection: the renderer prints only `title：detail` — the short
 *  state name as title, then the message (richest fact), else the pluginId, else null. */
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
