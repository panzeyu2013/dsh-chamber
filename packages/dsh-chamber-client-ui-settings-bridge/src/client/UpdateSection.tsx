/**
 * Chamber-global「更新」group, rendered inside the「通用」section: a LOW-KEY flat row
 * group (group heading, a version line with「检查更新」on the right, phase status lines
 * below). A newer version adds a quiet notice plus「更新」; a completed download offers
 * the explicit「重启并安装」action. No dialogs, no badges, no banners: the user only sees
 * this by opening Settings, and the download starts only after an explicit click
 * (autoDownload stays off in the main process). All state is the non-secret projection
 * pushed by the desktop main process over the update bridge (update-store.ts).
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsBridgeKey } from '../locales.ts'
import type { UpdateState } from '../ambient/update-bridge.d.ts'
import {
  getUpdateState, subscribeUpdateState, requestUpdateCheck, requestUpdateDownload, requestUpdateRestart, requestOpenReleasePage,
} from './update-store.ts'
import { updateCheckDisabled, updateCheckPlatformBlocked, updateRestartAvailable } from './update-gate.ts'
import { classifyBlockedReason } from './blocked-reason.ts'
import css from './SettingsShell.module.css'

/** The shell's bound translate (params supported: {version} {percent} {reason}). */
type UpdateTranslate = (key: SettingsBridgeKey, params?: Record<string, unknown>) => string

function blockedCopy(update: UpdateState, t: UpdateTranslate): string {
  switch (classifyBlockedReason(update.installBlockedReason)) {
    case 'native-shell':
      return t('updateInstallBlockedNativeShell')
    case 'mac-signing':
      return t('updateInstallBlockedMacSigning')
    default:
      // 未知原因：原样透出（诚实，不编造签名缺失）。
      return t('updateDownloadBlocked', { reason: update.installBlockedReason ?? '' })
  }
}

/**
 * Phases where an explicit check would be a no-op: an in-flight check or download already
 * owns the flow, or「已下载，退出时安装」is final for this version (the main process
 * runCheck() gates the same set).
 */
function checkImpossible(update: UpdateState): boolean {
  return updateCheckDisabled(update.phase)
}

/** One phase-specific status line (plain text, actions aligned right). */
function StatusRow({
  update, busyKind, onUpdate, onRestart, t,
}: {
  update: UpdateState
  /** Which action owns the in-flight busy state — null = idle. The「正在重启并安装…」
   *  line is drawn ONLY for a RESTART-owned busy: a DOWNLOAD click's busy can survive
   *  one render past the update-downloaded push and must never mislabel the row. */
  busyKind: 'restart' | 'download' | null
  onUpdate: () => void
  onRestart: () => void
  t: UpdateTranslate
}) {
  const busy = busyKind !== null
  const { phase, latestVersion, downloadPercent, installBlockedReason, releaseUrl } = update
  // window.dshChamber.platform: Linux never offers the「重启并安装」action
  // (update-gate — AppImage single-instance race; the quit-install leg stays).
  const bridgePlatform = typeof window !== 'undefined' ? (window.dshChamber?.platform ?? null) : null
  // Real href + preventDefault: the accessible URL hint stays meaningful, but the
  // actual open goes through the allowlisted main-process bridge.
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
        // On mac WITHOUT a Developer ID signature the auto-install (deferred to quit)
        // would fail — Squirrel.Mac refuses unsigned updates — so a download is a doomed
        // install path. The blocked case offers no「更新」button, only the honest manual
        // hint + the release page. The main process ALSO refuses download() there.
        return installBlockedReason !== null ? (
          <div className={css.updateStatusLine}>
            <span className={css.updateStatusText}>
              {(() => {
                const version = latestVersion ?? ''
                switch (classifyBlockedReason(installBlockedReason)) {
                  case 'native-shell':
                    return t('updateAvailableBlockedNativeShell', { version })
                  case 'mac-signing':
                    return update.channel === 'beta'
                      ? t('updateAvailableBlockedBeta', { version })
                      : t('updateAvailableBlocked', { version })
                  default:
                    return t('updateAvailableBlockedUnknown', {
                      version,
                      reason: installBlockedReason ?? '',
                    })
                }
              })()}
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
            <Button variant="primary" size="sm" onClick={onUpdate} disabled={busy}>
              {t('updateAction')}
            </Button>
            {releaseLink}
          </div>
        )
      case 'downloading':
        // 原生（Sparkle）阶段没有百分比：显示不定量文案，绝不把 null 圆整成假的 0%。
        return (
          <p className={css.updateStatusText}>
            {downloadPercent === null
              ? t('updateDownloadingIndeterminate')
              : t('updateDownloading', { percent: Math.round(downloadPercent) })}
          </p>
        )
      case 'installing':
        // 原生安装中（Electron 不产生）：Sparkle 正在替换 bundle 并重启，页面只如实
        // 呈现进展——不提供第二次下载/安装入口（phase 门已排除 installing）。
        return <p className={css.updateStatusText}>{t('updateInstalling')}</p>
      case 'downloaded': {
        // The「已下载，退出时安装」row gains the user-triggered「重启并安装」primary
        // action (main-process quitAndInstall) whenever the restart can hold; quitting
        // alone is not a controllable install flow on every shape. The gate mirrors
        // updater.restartAndInstall() exactly (phase downloaded + no install block + NOT
        // linux), which the main process also enforces at the IPC boundary. Outcomes:
        // restart offered / install blocked → manual hint / Linux AppImage → quit-leg text.
        if (updateRestartAvailable(update.phase, installBlockedReason, bridgePlatform)) {
          // Restart-failure carry: the restart was attempted and FAILED (main keeps phase
          // `downloaded` for restart-only failures, since 'error' would mislabel it as a
          // download failure). Show the restart-specific line with the row's button as retry.
          if (update.restartFailureText !== undefined) {
            return (
              <div className={css.updateStatusLine}>
                <span className={css.updateStatusText}>{t('updateRestartFailed', { error: update.restartFailureText })}</span>
                <Button variant="primary" size="sm" onClick={onRestart} disabled={busy}>
                  {t('updateRestartAction')}
                </Button>
                {releaseLink}
              </div>
            )
          }
          // Restart busy-in-flight: the click armed quitAndInstall (ok) or is mid-invoke —
          // show the honest in-progress line while the quit window runs. Only a
          // RESTART-owned busy draws it; a DOWNLOAD-owned busy frame falls through to the
          // plain downloaded row, button still disabled.
          if (busyKind === 'restart') {
            return (
              <div className={css.updateStatusLine}>
                <span className={css.updateStatusText}>{t('updateRestarting')}</span>
                <Button variant="primary" size="sm" onClick={onRestart} disabled>
                  {t('updateRestartAction')}
                </Button>
                {releaseLink}
              </div>
            )
          }
          // Plain「已下载，退出时安装」row: restart offered (enabled unless busy); a
          // DOWNLOAD-owned busy frame lands here too and just stays disabled.
          return (
            <div className={css.updateStatusLine}>
              <span className={css.updateStatusText}>{t('updateDownloaded')}</span>
              <Button variant="primary" size="sm" onClick={onRestart} disabled={busy}>
                {t('updateRestartAction')}
              </Button>
              {releaseLink}
            </div>
          )
        }
        return installBlockedReason !== null ? (
          <div className={css.updateStatusLine}>
            <span className={css.updateStatusText}>{blockedCopy(update, t)}</span>
            {releaseLink}
          </div>
        ) : (
          <p className={css.updateStatusText}>{t('updateDownloaded')}</p>
        )
      }
      case 'error':
        // latestVersion null → a CHECK failure; set → a DOWNLOAD failure (+ retry, never
        // without a fresh check). A RESTART failure keeps phase `downloaded`.
        return latestVersion !== null ? (
          <div className={css.updateStatusLine}>
            <span className={css.updateStatusText}>{t('updateDownloadFailed')}</span>
            <Button variant="primary" size="sm" onClick={onUpdate} disabled={busy}>
              {t('updateAction')}
            </Button>
          </div>
        ) : (
          <p className={css.updateStatusText}>{t('updateCheckFailed')}</p>
        )
      default:
        // 'idle' — not checked yet (or not hydrated): current-version line only, never a fake "up to date".
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
  // Busy is tracked by its SOURCE: 'restart' only from「重启并安装」, 'download' from
  //「更新」. The downloaded row's「正在重启并安装…」line must show ONLY for a
  // restart-owned busy — a download click's busy can survive one render past the push.
  const [busyKind, setBusyKind] = useState<'restart' | 'download' | null>(null)
  const busy = busyKind !== null
  const [checking, setChecking] = useState(false)

  const onUpdate = useCallback(() => {
    setBusyKind('download')
    void requestUpdateDownload().finally(() => setBusyKind(null))
  }, [])

  const onRestart = useCallback(() => {
    setBusyKind('restart')
    // ok → quitAndInstall armed: the app is on its way out, so keep the button
    // disabled (the main-process single-flight would refuse a second click anyway).
    // Only a refused/failed call re-enables the row for an in-place retry.
    void requestUpdateRestart().then((result) => {
      if (!result.ok) setBusyKind(null)
    })
  }, [])

  // The click emits exactly one bridge invoke (update-store single-flight) and never
  // starts page-side discovery. The「正在检查更新…」row and every later row come from
  // the pushed phases; the local busy flag only covers the invoke itself.
  const onCheck = useCallback(() => {
    setChecking(true)
    void requestUpdateCheck().finally(() => setChecking(false))
  }, [])

  // Busy recovery: after an armed restart the local busy state deliberately stays set
  // (the quit window; the store's module single-flight is NOT reset on ok). When a
  // PUSHED state proves the restart actually failed — it carries restartFailureText, or
  // the phase left {downloaded, downloading} toward 'error'/'up-to-date' — busy must
  // clear so every button re-enables without an app reload. A plain downloaded push
  // keeps busy (the designed armed-forever quit); an in-flight download is untouched.
  useEffect(() => {
    if (update === null) return
    if (update.restartFailureText !== undefined
      || update.phase === 'error' || update.phase === 'up-to-date') {
      setBusyKind(null)
    }
  }, [update])

  const bridgeVersion = typeof window !== 'undefined' ? (window.dshChamber?.version ?? null) : null
  const currentVersion = update?.currentVersion ?? bridgeVersion
  // Manual check gates: no bridge yet, an action in flight, a phase that already
  // owns the flow (checkImpossible — mirrors main's runCheck() gates), or a platform
  // where the main process refuses checks outright (linux — no installer feed).
  const checkDisabled = update === null || checking || busy
    || checkImpossible(update)
    || updateCheckPlatformBlocked(update?.installBlockedReason)

  return (
    <div className={css.updateSection}>
      <h3 className={css.generalGroupTitle}>{t('updateTitle')}</h3>
      <div className={css.updateVersionRow}>
        <p className={css.updateRow}>{t('updateCurrentVersion', { version: currentVersion ?? '—' })}</p>
        <Button variant="outline" size="sm" onClick={onCheck} disabled={checkDisabled}>
          {t('updateCheckAction')}
        </Button>
      </div>
      {update !== null && (
        <StatusRow update={update} busyKind={busyKind} onUpdate={onUpdate} onRestart={onRestart} t={t} />
      )}
    </div>
  )
}
