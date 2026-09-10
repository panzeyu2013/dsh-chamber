/**
 * Plugin-settings diagnostics view (2026-12).
 *
 * Renders the selected source's extension-phase snapshot: how many of its own
 * client plugins were considered, which ones contributed settings, and — the
 * point of the whole surface — WHY the others did not. Nothing that failed to
 * render may stay invisible: inactive plugins (missing services), failed
 * bundles/applies, registrations into seats the chamber shell does not render,
 * contained render crashes, and cross-source module sharing all appear here.
 */
import clsx from 'clsx'
import type { SettingsBridgeKey } from '../locales.ts'
import { extensionNotices, type ExtensionSnapshot } from './settings-extensions.ts'
import css from './SettingsShell.module.css'

/** Props of the diagnostics view. */
export interface ExtensionsViewProps {
  /** Bound translate over this shell's dictionary namespace. */
  t: (key: SettingsBridgeKey, params?: Record<string, unknown>) => string
  /** The live snapshot (undefined while the session is still assembling). */
  snapshot: ExtensionSnapshot | undefined
  /** Re-read the source's plugin graph and reconcile. */
  onRefresh: () => void
  /** A refresh is in flight. */
  refreshing: boolean
}

/**
 * Render the diagnostics view.
 * @param props - translate + snapshot + refresh wiring.
 * @returns the view.
 */
export function ExtensionsView({ t, snapshot, onRefresh, refreshing }: ExtensionsViewProps) {
  if (snapshot === undefined || snapshot.state === 'pending' || snapshot.state === 'loading') {
    return <p className={css.placeholder}>{t('pluginsLoading')}</p>
  }
  const notices = extensionNotices(snapshot)
  return (
    <div className={css.pluginsView}>
      <p className={css.pluginsIntro}>{t('pluginsIntro')}</p>
      <div className={css.pluginsToolbar}>
        <span className={css.pluginsCount}>{t('pluginsCount', { count: snapshot.total })}</span>
        <button
          type="button"
          className={css.inlineAction}
          onClick={onRefresh}
          disabled={refreshing}
        >
          {refreshing ? t('pluginsRefreshing') : t('pluginsRefresh')}
        </button>
      </div>
      {notices.length === 0 ? (
        <p className={css.placeholder}>{snapshot.total === 0 ? t('pluginsEmpty') : t('pluginsAllLoaded')}</p>
      ) : (
        <ul className={css.noticeList}>
          {notices.map((notice, index) => (
            <li key={`${notice.key}-${index}`} className={clsx(css.noticeItem, notice.key === 'pluginsUnavailable' && css.noticeWarn)}>
              {t(notice.key, notice.params)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
