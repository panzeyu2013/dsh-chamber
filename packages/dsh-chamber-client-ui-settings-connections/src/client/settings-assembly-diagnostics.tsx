/**
 * Settings-assembly diagnostics block (2026-09 relocation): the selected
 * source's plugin-settings assembly report, rendered INSIDE that source's
 * connection card — what loaded, what did not, and why (design 09 §5's
 * "never silent" rule, now scoped by construction instead of by a nav slot).
 *
 * Rendered on exactly the card whose source id the report names; every other
 * card renders nothing (no stale report is ever shown for a source the shell
 * has not assembled, and the block disappears with the tab, never lingers).
 */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  assemblyIsLoading, assemblyLines, assemblySummary,
  type AssemblyTranslate, type SettingsAssemblyReportView,
} from './settings-assembly-diagnostics.ts'
import css from './ConnectionsSection.module.css'

/** Props of the diagnostics block (the shell passes the report + its translate). */
export interface SettingsAssemblyDiagnosticsProps {
  /** The selected source's report; undefined while no source is selected/assembled. */
  report?: SettingsAssemblyReportView | undefined
  /** The shell's bound translate over ITS OWN dictionary namespace. */
  t?: AssemblyTranslate | undefined
  /** Ask the shell to re-read the source's plugin graph and reconcile. */
  onRefresh?: (() => void) | undefined
  /** A refresh is in flight. */
  refreshing?: boolean | undefined
}

/**
 * Render the selected source's settings-assembly diagnostics.
 * @param props - report + translate + refresh wiring.
 * @returns the block, or null when this card is not the report's source.
 */
export function SettingsAssemblyDiagnostics({
  report, t, onRefresh, refreshing,
}: SettingsAssemblyDiagnosticsProps): ReactNode {
  if (report === undefined || t === undefined) return null
  const loading = assemblyIsLoading(report)
  const lines = assemblyLines(report, t)
  const summary = assemblySummary(report, t)
  return (
    <div className={css.assemblyBlock}>
      <div className={css.assemblyHead}>
        <span className={css.assemblyTitle}>{t('assemblyTitle')}</span>
        {/* The count is meaningless while the phase is still assembling (it
            reads 0 until the graph answer lands) — the loading line says so. */}
        {!loading && <span className={css.assemblyCount}>{t('pluginsCount', { count: report.total })}</span>}
        {onRefresh !== undefined && (
          <button
            type="button"
            className={css.assemblyAction}
            onClick={onRefresh}
            disabled={refreshing === true}
          >
            {refreshing === true ? t('pluginsRefreshing') : t('pluginsRefresh')}
          </button>
        )}
      </div>
      <p className={css.assemblySummary}>{t('pluginsIntro')}</p>
      {summary !== null && <p className={css.assemblySummary}>{summary}</p>}
      {lines.length > 0 && (
        <ul className={css.assemblyList}>
          {lines.map((line, index) => (
            <li
              key={`${line.tone}-${index}`}
              className={clsx(css.assemblyItem, line.tone === 'warn' && css.assemblyWarn)}
            >
              {line.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The block for ONE card: null unless the report belongs to this card's source.
 * Keeps the call site free of the id comparison (and of a silently stale block
 * when the selected source changes while the panel stays open).
 * @param props - the report plus this card's source id, and the wiring above.
 * @returns the block for this card, or null.
 */
export function SettingsAssemblyDiagnosticsFor({
  sourceId, ...rest
}: SettingsAssemblyDiagnosticsProps & { sourceId: string }): ReactNode {
  if (rest.report === undefined || rest.report.sourceId !== sourceId) return null
  return <SettingsAssemblyDiagnostics {...rest} />
}
