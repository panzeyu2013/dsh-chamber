/**
 * Chamber-global「更新」group (design 11), rendered inside the「通用」section
 * (design 15 — the update nav entry was merged into General): a LOW-KEY flat
 * row group in the OpenChamber settings vocabulary — group heading, a version
 * line with the「检查更新」action on the right, and phase status line(s)
 * below. When a newer version exists a quiet notice plus a「更新」
 * button appear; once the download completed, the row offers the explicit
 *「重启并安装」action (2026-12 user decision — the user restarts into the
 * update right from the UI instead of relying on quit alone). No dialogs, no
 * badges, no banners: the user only ever sees this by opening Settings, and
 * the download starts only after the explicit click (autoDownload stays off
 * in the main process). All state is the non-secret projection pushed by the
 * desktop main process over the update bridge (update-store.ts).
 *
 * 2026-09-11 upstream-alignment T9: every action capsule in this file is the
 * shared ui-primitives `Button` (`variant="outline|primary" size="sm"`), the
 * exact recipe the hand-rolled `.updateButton` / `.updatePrimaryButton` rules
 * copied — the local rules are gone.
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
  update, busyKind, onUpdate, onRestart, t,
}: {
  update: UpdateState
  /** Which action owns the in-flight busy state — null = idle. The「正在重启
   *  并安装…」line is drawn ONLY for a RESTART-owned busy (round-2 review A4):
   *  a DOWNLOAD click's busy can survive one render past the update-downloaded
   *  push and must never briefly mislabel the downloaded row as restarting. */
  busyKind: 'restart' | 'download' | null
  onUpdate: () => void
  onRestart: () => void
  t: UpdateTranslate
}) {
  const busy = busyKind !== null
  const { phase, latestVersion, downloadPercent, installBlockedReason, releaseUrl } = update
  // window.dshChamber.platform ('darwin'|'win32'|'linux'|…): Linux never
  // offers the「重启并安装」action (update-gate — AppImage single-instance
  // race, 2026-12 review H1; the quit-install leg stays).
  const bridgePlatform = typeof window !== 'undefined' ? (window.dshChamber?.platform ?? null) : null
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
            <Button variant="primary" size="sm" onClick={onUpdate} disabled={busy}>
              {t('updateAction')}
            </Button>
            {releaseLink}
          </div>
        )
      case 'downloading':
        return <p className={css.updateStatusText}>{t('updateDownloading', { percent: Math.round(downloadPercent ?? 0) })}</p>
      case 'downloaded': {
        // 2026-12 user decision: the「已下载，退出时安装」row gains the
        // user-triggered「重启并安装」primary action (main-process
        // quitAndInstall — quit + install + relaunch through the normal quit
        // path) whenever the restart can actually hold. Quitting alone is not
        // a controllable install flow on every platform/shape; the explicit
        // restart is. The gate mirrors updater.restartAndInstall() exactly
        // (phase downloaded + no install block + NOT linux — the AppImage
        // single-instance race, review H1), which the main process also
        // enforces at the IPC boundary (never just UI hiding). Three outcomes
        // inside this case: restart offered (mac/win, installable) / install
        // blocked → manual hint / Linux AppImage (or any downloaded-but-
        // uninstallable shape) → plain quit-leg text.
        if (updateRestartAvailable(update.phase, installBlockedReason, bridgePlatform)) {
          // Restart-failure carry (2026-12 review round F2): the restart was
          // attempted and FAILED (main keeps the phase `downloaded` for
          // restart-only failures — an 'error' phase would mislabel this as a
          // download failure). Show the restart-specific failure line with the
          // row's「重启并安装」button as the retry affordance (re-enabled by the
          // recovery rule below — never the generic download-failure row).
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
          // Restart busy-in-flight (2026-12 review round F9): the click armed
          // quitAndInstall (ok) or is mid-invoke — show the honest in-progress
          // line instead of the plain downloaded line while the quit window
          // runs (busy stays until the quit — the designed single-flight).
          // Only a RESTART-owned busy draws this line (round-2 review A4): a
          // DOWNLOAD-owned busy frame at phase `downloaded` (the click's busy
          // can survive one render past the update-downloaded push) falls
          // through to the plain downloaded row below, with the button still
          // disabled by `busy` until the download settles.
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
          // Plain「已下载，退出时安装」row: restart offered (enabled unless
          // busy). A DOWNLOAD-owned busy frame at this phase (round-2 review
          // A4) lands here too — the row is correctly labeled, the restart
          // button just stays disabled until the download's finally settles.
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
        // latestVersion null → a CHECK failure (「无法检查更新」); set → a
        // DOWNLOAD failure (「更新下载失败」+ retry, never without a fresh
        // check — updater.ts clears latestVersion on check errors). A RESTART
        // failure never reaches this case since 2026-12 review round F2: the
        // main process keeps phase `downloaded` there and rides
        // restartFailureText (rendered by the downloaded row above).
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
  // Busy is tracked by its SOURCE (round-2 review A4): 'restart' only ever
  // comes from the「重启并安装」action, 'download' from the「更新」action. The
  // downloaded row's「正在重启并安装…」line must show ONLY for a restart-owned
  // busy — a download click's busy can survive one render past the
  // update-downloaded push (the download's finally settles after the phase
  // push) and must not briefly mislabel the downloaded row as restarting.
  const [busyKind, setBusyKind] = useState<'restart' | 'download' | null>(null)
  const busy = busyKind !== null
  const [checking, setChecking] = useState(false)

  const onUpdate = useCallback(() => {
    setBusyKind('download')
    void requestUpdateDownload().finally(() => setBusyKind(null))
  }, [])

  const onRestart = useCallback(() => {
    setBusyKind('restart')
    // ok → quitAndInstall armed: the app is on its way out (cleanup takes a
    // few seconds) — keep the button disabled so the quit window cannot see a
    // "dead" second click (the main-process single-flight would refuse it
    // anyway). Only a refused/failed call re-enables the row for an in-place
    // retry — the update-state push stays authoritative for every outcome.
    void requestUpdateRestart().then((result) => {
      if (!result.ok) setBusyKind(null)
    })
  }, [])

  const onCheck = useCallback(() => {
    setChecking(true)
    void requestUpdateCheck().finally(() => setChecking(false))
  }, [])

  // Busy recovery (2026-12 review round F2/F5): after an armed restart the
  // local busy state deliberately stays set (the quit window — the store's
  // module single-flight mirrors main and is NOT reset on ok). But when a
  // PUSHED state proves the restart actually failed — it carries
  // restartFailureText (main keeps phase `downloaded` there), or the phase
  // left {downloaded, downloading} toward 'error'/'up-to-date' — busy must
  // clear so every button (including the restart button) re-enables WITHOUT
  // an app reload. A plain downloaded push without a failure keeps busy (the
  // designed armed-forever-quit), and an in-flight download (phase
  // downloading) is untouched — its own finally resets busy.
  useEffect(() => {
    if (update === null) return
    if (update.restartFailureText !== undefined
      || update.phase === 'error' || update.phase === 'up-to-date') {
      setBusyKind(null)
    }
  }, [update])

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
