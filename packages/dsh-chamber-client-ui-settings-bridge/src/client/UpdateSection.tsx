/**
 * Chamber-global「更新」section (design 11): a LOW-KEY status block showing
 * the current version and — when a newer version exists — a quiet one-line
 * notice plus a「更新」button. No dialogs, no badges, no banners: the user
 * only ever sees this by opening Settings, and the download starts only
 * after the explicit click (autoDownload stays off in the main process).
 * All state is the non-secret projection pushed by the desktop main process
 * over the update bridge (update-store.ts).
 */
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { SettingsBridgeKey } from '../locales.ts'
import type { UpdateState } from '../ambient/update-bridge.d.ts'
import {
  getUpdateState, subscribeUpdateState, requestUpdateDownload, requestOpenReleasePage,
} from './update-store.ts'
import css from './SettingsShell.module.css'

/** The shell's bound translate (params supported: {version} {percent} {reason}). */
type UpdateTranslate = (key: SettingsBridgeKey, params?: Record<string, unknown>) => string

/**
 * Localized reason for the mac-install-blocked state (design 11 §3.1): the
 * main-process reasons are technical English; map the known ones to
 * dictionary keys so the zh/en row reads naturally, falling back to the raw
 * reason for anything unknown (honest, never fabricated).
 */
function blockedCopy(update: UpdateState, t: UpdateTranslate): string {
  if (update.installBlockedReason === 'missing Developer ID signature') {
    return t('updateInstallBlockedMacSigning')
  }
  return t('updateDownloadBlocked', { reason: update.installBlockedReason ?? '' })
}

/** One phase-specific status row (plain text, no emphasis). */
function StatusRow({
  update, busy, onUpdate, t,
}: {
  update: UpdateState
  busy: boolean
  onUpdate: () => void
  t: UpdateTranslate
}) {
  const { phase, latestVersion, downloadPercent, installBlockedReason, releaseUrl } = update
  // Real href + preventDefault: the accessible URL hint stays meaningful, but
  // the actual open goes through the allowlisted main-process bridge (the
  // Electron frame pins navigation to the control-plane origin).
  const releaseLink = releaseUrl !== null
    ? (
      <a
        className={css.updateLink}
        href={releaseUrl}
        onClick={(event: ReactMouseEvent) => {
          event.preventDefault()
          void requestOpenReleasePage(releaseUrl)
        }}
      >
        {t('updateReleaseLink')}
      </a>
    )
    : null

  const status = (() => {
    switch (phase) {
      case 'checking':
        return <p className={css.updateRow}>{t('updateChecking')}</p>
      case 'up-to-date':
        return <p className={css.updateRow}>{t('updateUpToDate')}</p>
      case 'available':
        // On mac WITHOUT a Developer ID signature the auto-install (deferred
        // to quit) would fail — Squirrel.Mac refuses unsigned updates — so a
        // download is a doomed install path. The blocked case offers no
        // 「更新」button, only the honest manual hint + the release page
        // (design 11 §3.1: blocked install is a prerequisite, not a UX fork;
        // never pretend). The main process ALSO refuses download() on
        // installBlockedReason (updater.ts) — not just UI hiding.
        return installBlockedReason !== null ? (
          <div className={css.updateActions}>
            <p className={css.updateRow}>
              {update.channel === 'beta'
                ? t('updateAvailableBlockedBeta', { version: latestVersion ?? '' })
                : t('updateAvailableBlocked', { version: latestVersion ?? '' })}
            </p>
            <div className={css.updateActionRow}>{releaseLink}</div>
          </div>
        ) : (
          <div className={css.updateActions}>
            <p className={css.updateRow}>
              {update.channel === 'beta'
                ? t('updateAvailableBeta', { version: latestVersion ?? '' })
                : t('updateAvailable', { version: latestVersion ?? '' })}
            </p>
            <div className={css.updateActionRow}>
              <button type="button" className={css.updateButton} onClick={onUpdate} disabled={busy}>
                {t('updateAction')}
              </button>
              {releaseLink}
            </div>
          </div>
        )
      case 'downloading':
        return <p className={css.updateRow}>{t('updateDownloading', { percent: Math.round(downloadPercent ?? 0) })}</p>
      case 'downloaded':
        return installBlockedReason !== null ? (
          <div className={css.updateActions}>
            <p className={css.updateRow}>{blockedCopy(update, t)}</p>
            <div className={css.updateActionRow}>{releaseLink}</div>
          </div>
        ) : (
          <p className={css.updateRow}>{t('updateDownloaded')}</p>
        )
      case 'error':
        // latestVersion null → a CHECK failure (「无法检查更新」); set → a
        // DOWNLOAD failure (「更新下载失败」+ retry, never without a fresh
        // check — updater.ts clears latestVersion on check errors).
        return latestVersion !== null ? (
          <div className={css.updateActions}>
            <p className={css.updateRow}>{t('updateDownloadFailed')}</p>
            <div className={css.updateActionRow}>
              <button type="button" className={css.updateButton} onClick={onUpdate} disabled={busy}>
                {t('updateAction')}
              </button>
            </div>
          </div>
        ) : (
          <p className={css.updateRow}>{t('updateCheckFailed')}</p>
        )
      default:
        // 'idle' — not checked yet (or the bridge has not hydrated): show only
        // the current-version row, never a fake "up to date".
        return null
    }
  })()

  return (
    <div className={css.updateStatus} aria-live="polite">
      {status}
    </div>
  )
}

/** The update section content (rendered inside the settings options column). */
export function UpdateSection({ t }: { t: UpdateTranslate }) {
  const update = useSyncExternalStore(subscribeUpdateState, getUpdateState)
  const [busy, setBusy] = useState(false)

  const onUpdate = useCallback(() => {
    setBusy(true)
    void requestUpdateDownload().finally(() => setBusy(false))
  }, [])

  const bridgeVersion = typeof window !== 'undefined' ? (window.dshChamber?.version ?? null) : null
  const currentVersion = update?.currentVersion ?? bridgeVersion

  return (
    <div className={css.updateSection}>
      <p className={css.updateRow}>{t('updateCurrentVersion', { version: currentVersion ?? '—' })}</p>
      {update !== null && <StatusRow update={update} busy={busy} onUpdate={onUpdate} t={t} />}
    </div>
  )
}
