/**
 * Chamber-global「更新」group (design 11), rendered inside the「通用」section
 * (design 15 — the update nav entry was merged into General): a LOW-KEY flat
 * row group in the OpenChamber settings vocabulary — group heading, a version
 * line with the「检查更新」action on the right, and phase status line(s)
 * below. When a newer version exists a quiet notice plus a「更新」
 * button appear. No dialogs, no badges, no banners: the user only ever sees
 * this by opening Settings, and the download starts only after the explicit
 * click (autoDownload stays off in the main process). All state is the
 * non-secret projection pushed by the desktop main process over the update
 * bridge (update-store.ts).
 */
import { useCallback, useState, useSyncExternalStore } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { SettingsBridgeKey } from '../locales.ts'
import type { UpdateState } from '../ambient/update-bridge.d.ts'
import {
  getUpdateState, subscribeUpdateState, requestUpdateCheck, requestUpdateDownload, requestOpenReleasePage,
} from './update-store.ts'
import { updateCheckDisabled, updateCheckPlatformBlocked } from './update-gate.ts'
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

/**
 * Phases where an explicit check would be a no-op (an in-flight check or
 * download already owns the flow, or the「已下载，退出时安装」state is final
 * for this version — the main process runCheck() gates the same set).
 */
function checkImpossible(update: UpdateState): boolean {
  return updateCheckDisabled(update.phase)
}

/** One phase-specific status line (plain text, actions aligned right). */
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
        return <p className={css.updateStatusText}>{t('updateChecking')}</p>
      case 'up-to-date':
        return <p className={css.updateStatusText}>{t('updateUpToDate')}</p>
      case 'available':
        // On mac WITHOUT a Developer ID signature the auto-install (deferred
        // to quit) would fail — Squirrel.Mac refuses unsigned updates — so a
        // download is a doomed install path. The blocked case offers no
        // 「更新」button, only the honest manual hint + the release page
        // (design 11 §3.1: blocked install is a prerequisite, not a UX fork;
        // never pretend). The main process ALSO refuses download() on
        // installBlockedReason (updater.ts) — not just UI hiding.
        return installBlockedReason !== null ? (
          <div className={css.updateStatusLine}>
            <span className={css.updateStatusText}>
              {update.channel === 'beta'
                ? t('updateAvailableBlockedBeta', { version: latestVersion ?? '' })
                : t('updateAvailableBlocked', { version: latestVersion ?? '' })}
            </span>
            {releaseLink}
          </div>
        ) : (
          <div className={css.updateStatusLine}>
            <span className={css.updateStatusText}>
              {update.channel === 'beta'
                ? t('updateAvailableBeta', { version: latestVersion ?? '' })
                : t('updateAvailable', { version: latestVersion ?? '' })}
            </span>
            <button type="button" className={css.updatePrimaryButton} onClick={onUpdate} disabled={busy}>
              {t('updateAction')}
            </button>
            {releaseLink}
          </div>
        )
      case 'downloading':
        return <p className={css.updateStatusText}>{t('updateDownloading', { percent: Math.round(downloadPercent ?? 0) })}</p>
      case 'downloaded':
        return installBlockedReason !== null ? (
          <div className={css.updateStatusLine}>
            <span className={css.updateStatusText}>{blockedCopy(update, t)}</span>
            {releaseLink}
          </div>
        ) : (
          <p className={css.updateStatusText}>{t('updateDownloaded')}</p>
        )
      case 'error':
        // latestVersion null → a CHECK failure (「无法检查更新」); set → a
        // DOWNLOAD failure (「更新下载失败」+ retry, never without a fresh
        // check — updater.ts clears latestVersion on check errors).
        return latestVersion !== null ? (
          <div className={css.updateStatusLine}>
            <span className={css.updateStatusText}>{t('updateDownloadFailed')}</span>
            <button type="button" className={css.updatePrimaryButton} onClick={onUpdate} disabled={busy}>
              {t('updateAction')}
            </button>
          </div>
        ) : (
          <p className={css.updateStatusText}>{t('updateCheckFailed')}</p>
        )
      default:
        // 'idle' — not checked yet (or the bridge has not hydrated): show only
        // the current-version line, never a fake "up to date".
        return null
    }
  })()

  return (
    <div className={css.updateStatus} aria-live="polite">
      {status}
    </div>
  )
}

/** The update group content (rendered inside the「通用」settings column). */
export function UpdateSection({ t }: { t: UpdateTranslate }) {
  const update = useSyncExternalStore(subscribeUpdateState, getUpdateState)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)

  const onUpdate = useCallback(() => {
    setBusy(true)
    void requestUpdateDownload().finally(() => setBusy(false))
  }, [])

  const onCheck = useCallback(() => {
    setChecking(true)
    void requestUpdateCheck().finally(() => setChecking(false))
  }, [])

  const bridgeVersion = typeof window !== 'undefined' ? (window.dshChamber?.version ?? null) : null
  const currentVersion = update?.currentVersion ?? bridgeVersion
  // Manual check gates: no bridge yet (nothing to ask), an action in flight,
  // a phase that already owns the flow (checkImpossible — mirrors the main
  // process runCheck() gates), or a platform where the main process refuses
  // checks outright (linux — no installer feed; see update-gate).
  const checkDisabled = update === null || checking || busy
    || checkImpossible(update)
    || updateCheckPlatformBlocked(update?.installBlockedReason)

  return (
    <div className={css.updateSection}>
      <h3 className={css.generalGroupTitle}>{t('updateTitle')}</h3>
      <div className={css.updateVersionRow}>
        <p className={css.updateRow}>{t('updateCurrentVersion', { version: currentVersion ?? '—' })}</p>
        <button type="button" className={css.updateButton} onClick={onCheck} disabled={checkDisabled}>
          {t('updateCheckAction')}
        </button>
      </div>
      {update !== null && <StatusRow update={update} busy={busy} onUpdate={onUpdate} t={t} />}
    </div>
  )
}
