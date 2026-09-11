/**
 * Settings-assembly diagnostics (2026-09 relocation): the pure model behind the
 * block the connections section renders inside the SELECTED source's card.
 *
 * The report itself is produced by the settings shell
 * (`packages/dsh-chamber-client-ui-settings-bridge/src/client/settings-extensions.ts`
 * `toAssemblyReport`): the shell owns the per-source extension phase, and its
 * dictionary namespace owns the copy. The block therefore renders through the
 * `assemblyT` translate the shell passes alongside the report — the same shape
 * as this section's host-computed `restartNote` text — while everything that is
 * decision logic (tone, loading verdict, reading order) lives here as pure
 * functions so plain node can pin it.
 *
 * WHY this surface is not a settings nav entry (user decision, 2026-09): its
 * SUBJECT is one source, its OWNER is the chamber shell. The first nav group is
 * the selected source's own `settings.section` ledger and the second is
 * chamber-global state — a page about one source belongs to neither, so it is
 * scoped by construction here: it renders on exactly the card whose source id
 * the report names, next to the existing「客户端插件状态」line.
 */

/** One rendered diagnostics line (already localized by the shell's translate). */
export interface AssemblyLine {
  text: string
  /** `warn` = the phase itself failed; `info` = an honest report about a plugin. */
  tone: 'info' | 'warn'
}

/**
 * Structural view of the shell's `SettingsAssemblyReport`. Kept structural (not
 * imported) because the two packages meet through the bridge's ambient mirror:
 * the shell passes the value positionally and the producer owns the model.
 */
export interface SettingsAssemblyReportView {
  /** The source this snapshot belongs to ('local' | '<kind>-<id>'). */
  sourceId: string
  /** The extension phase's state for that source. */
  state: string
  /** Kept rows considered by the phase. */
  total: number
  /** The honest line list (keys are the shell dictionary's notice keys). */
  notices: readonly SettingsAssemblyNoticeView[]
}

/** One notice as it crosses the package boundary. */
export interface SettingsAssemblyNoticeView {
  key: string
  params?: Record<string, string> | undefined
}

/** Translate face the shell passes for ITS OWN dictionary namespace (params supported). */
export type AssemblyTranslate = (key: string, params?: Record<string, unknown>) => string

/** Notice keys that describe a failure of the phase rather than of one plugin. */
const WARN_NOTICE_KEYS: readonly string[] = ['pluginsUnavailable']

/** Whether the phase is still assembling (the report exists before it settles). */
export function assemblyIsLoading(report: SettingsAssemblyReportView): boolean {
  return report.state === 'pending' || report.state === 'loading'
}

/**
 * Project the report into the rendered line list.
 * The order is the producer's (stable reading order, see `extensionNotices`).
 * @param report - the report handed over by the settings shell.
 * @param t - the shell's bound translate (its own namespace owns the copy).
 * @returns one localized line per notice, with its tone.
 */
export function assemblyLines(
  report: SettingsAssemblyReportView,
  t: AssemblyTranslate,
): AssemblyLine[] {
  return report.notices.map(notice => ({
    text: t(notice.key, notice.params ?? {}),
    tone: WARN_NOTICE_KEYS.includes(notice.key) ? 'warn' : 'info',
  }))
}

/**
 * The block's summary line when there is no notice to show: the settled
 * "nothing to report" states, or the assembling state.
 * @param report - the report handed over by the settings shell.
 * @param t - the shell's bound translate.
 * @returns the summary text, or null when the notice list carries the story.
 */
export function assemblySummary(
  report: SettingsAssemblyReportView,
  t: AssemblyTranslate,
): string | null {
  if (assemblyIsLoading(report)) return t('pluginsLoading')
  if (report.notices.length > 0) return null
  return report.total === 0 ? t('pluginsEmpty') : t('pluginsAllLoaded')
}
