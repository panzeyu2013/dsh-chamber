/**
 * Client-plugin runtime-loading diagnostic (design 09 §3.5): the shared
 * chamber-owned projection of one instance's plugin-graph load outcome,
 * surfaced on the chamber-global connections page — never on top of the
 * official dsh「插件」settings section.
 *
 * `instance-version-conflict` is INFORMATIONAL: the page keeps the
 * first-loaded plugin revision and nothing in-app can switch it (page-level
 * first-load-wins re-runs identically on any restart). It must therefore
 * never be styled like a problem — instance cards show only the neutral
 * state marker, and the full detail (plugin id + reason) lives in the
 * per-instance plugin dialog.
 *
 * The pure helpers (PluginDiagnostic / pluginDiagnosticText /
 * pluginDiagnosticTone) live in plugin-diagnostic.ts so the plain-node test
 * suite can cover them; this file owns only the component.
 */

import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { SettingsConnectionsKey } from '../locales.ts'
import { pluginDiagnosticText, pluginDiagnosticTone, type PluginDiagnostic } from './plugin-diagnostic.ts'
import css from './ConnectionsSection.module.css'

export type { PluginDiagnostic } from './plugin-diagnostic.ts'
export { pluginDiagnosticText, pluginDiagnosticTone } from './plugin-diagnostic.ts'

/**
 * One instance's client-plugin runtime diagnostic line. The diagnostic is a
 * chamber-owned fact (design 09) surfaced on the chamber-global connections
 * page — never on top of the official dsh「插件」settings section. A version
 * conflict shows only the neutral state marker here (design 09 §3.5: cards
 * carry the marker, the plugin dialog carries status, plugin id and reason).
 */
export function PluginDiagnosticLine({ diagnostic, t }: {
  diagnostic: PluginDiagnostic | undefined
  t: (key: SettingsConnectionsKey) => string
}): ReactNode {
  if (diagnostic === undefined) return null
  const tone = pluginDiagnosticTone(diagnostic.state)
  const showDetail = tone === 'problem'
  return (
    <p
      className={clsx(
        css.pluginDiagnostic,
        tone === 'problem' ? css.pluginDiagnosticProblem : tone === 'info' ? css.pluginDiagnosticInfo : css.pluginDiagnosticOk,
      )}
      role="status"
    >
      <strong>{t('pluginDiagnosticLabel')}：{pluginDiagnosticText(diagnostic.state, t)}</strong>
      {showDetail && diagnostic.pluginId !== undefined && <span>{diagnostic.pluginId}</span>}
      {showDetail && diagnostic.message !== undefined && <span>{diagnostic.message}</span>}
    </p>
  )
}
