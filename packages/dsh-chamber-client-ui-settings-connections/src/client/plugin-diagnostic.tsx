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
 * Since 2026-12 the card also renders the instance's settled-boot GAP (design
 * 05 §4 「降级呈现」second batch) — a DIFFERENT fact from the diagnostic above.
 * The graph channel may legitimately answer `ok` (the graph was fetched and
 * every row that arrived applied) while a service the page's own frontend
 * injects was never provided, which is exactly the "session titles fine,
 * conversation body empty" case. So when a gap is present the `ok` diagnostic
 * line is SUPPRESSED: "客户端插件状态：正常" next to "前端能力受限" would read as a
 * contradiction, and the `ok` half is not actionable. Problem/info diagnostic
 * states still render — those name a different (graph/bundle) failure.
 *
 * The pure helpers (PluginDiagnostic / pluginDiagnosticText /
 * pluginDiagnosticTone / bootGapText) live in plugin-diagnostic.ts so the
 * plain-node test suite can cover them; this file owns only the component.
 */

import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { SettingsConnectionsKey } from '../locales.ts'
import {
  bootGapText, pluginDiagnosticText, pluginDiagnosticTone,
  type PluginDiagnostic, type ServerBootGap,
} from './plugin-diagnostic.ts'
import css from './ConnectionsSection.module.css'

export type { PluginDiagnostic, ServerBootGap } from './plugin-diagnostic.ts'
export { bootGapText, pluginDiagnosticText, pluginDiagnosticTone } from './plugin-diagnostic.ts'

/** Full dictionary lookup: the gap sentences carry params, the diagnostic ones do not. */
type Translate = (key: SettingsConnectionsKey, params?: Record<string, string | number>) => string

/**
 * One instance's client-plugin runtime diagnostic line + its settled-boot gap
 * line. The diagnostic is a chamber-owned fact (design 09) surfaced on the
 * chamber-global connections page — never on top of the official dsh「插件」
 * settings section. A version conflict shows only the neutral state marker here
 * (design 09 §3.5: cards carry the marker, the plugin dialog carries status,
 * plugin id and reason).
 *
 * Both lines are `role="status"`: neither is an emergency, and neither may
 * steal focus (the fatal overlay owns `alert`).
 */
export function PluginDiagnosticLine({ diagnostic, bootGap, t }: {
  diagnostic: PluginDiagnostic | undefined
  /** The source's settled-boot gap, from the bridge projection. */
  bootGap: ServerBootGap | undefined
  t: Translate
}): ReactNode {
  // An `ok` graph channel says nothing about whether the page's surfaces
  // registered; the gap line below is the honest statement then.
  const showDiagnostic = diagnostic !== undefined && !(bootGap !== undefined && diagnostic.state === 'ok')
  if (!showDiagnostic && bootGap === undefined) return null
  const tone = diagnostic === undefined ? 'info' : pluginDiagnosticTone(diagnostic.state)
  const showDetail = diagnostic !== undefined && tone === 'problem'
  return (
    <>
      {showDiagnostic && diagnostic !== undefined && (
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
      )}
      {bootGap !== undefined && (
        <>
          <p className={clsx(css.pluginDiagnostic, css.pluginDiagnosticWarn)} role="status">
            <strong>{t('bootGapLabel')}：{bootGapText(bootGap, t)}</strong>
            {/* The services are ALREADY inside the sentence (`{services}`); rendering
                them again here duplicated the id on screen (2026-12 review, caught by
                rendering the three seats side by side). The failed-id list is the
                complementary half — the sentence carries the COUNT, the span names
                which rows — so only that one is appended. */}
            {(bootGap.failedIds ?? []).length > 0 && <span>{(bootGap.failedIds ?? []).join(', ')}</span>}
          </p>
          {/* Actionable next step, mirroring the version-conflict hint's shape
              (pluginDiagnosticVersionConflictHint): the honest fix lives on the
              instance, and the copy says 常见原因 — the app cannot prove it. */}
          <p className={css.hint}>{t('bootGapHint')}</p>
        </>
      )}
    </>
  )
}
