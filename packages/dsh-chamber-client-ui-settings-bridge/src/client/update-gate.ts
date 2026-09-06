/**
 * Update-section gates (design 11) — pure, testable. Mirrors the main-process
 * runCheck() phase gates (packages/desktop/updater.ts): an explicit「检查更新」
 * click is a no-op while a check/download already owns the flow, or once the
 *「已下载，退出时安装」state is final for this version.
 */
import type { UpdatePhase } from '../ambient/update-bridge.d.ts'

/** Whether the「检查更新」button must be disabled for the given phase. */
export function updateCheckDisabled(phase: UpdatePhase | undefined): boolean {
  return phase === 'checking' || phase === 'downloading' || phase === 'downloaded'
}

/**
 * Whether the「重启并安装」button (2026-12 user decision — restart into the
 * downloaded update, quitAndInstall) may be offered: only a COMPLETED
 * download on a shape where automatic installation is possible AND the
 * restart semantics can hold. Mirrors the controller-side gates of
 * updater.restartAndInstall() exactly (phase `downloaded` +
 * installBlockedReason null + NOT linux) — the main process enforces the
 * same conditions, not just this UI gate.
 *
 * Linux is excluded regardless of shape (2026-12 review H1): electron-
 * updater's AppImageUpdater swaps the running file and spawns the new
 * instance BEFORE the old process quits, and the fresh instance collides
 * with the still-alive old one under Electron's single-instance lock — the
 * promised auto-restart structurally cannot happen on AppImage. Linux keeps
 * the quit-install leg (「已下载，退出时安装」row, no restart button).
 * `platform` is the window.dshChamber.platform projection ('darwin' |
 * 'win32' | 'linux' | …).
 */
export function updateRestartAvailable(
  phase: UpdatePhase | undefined,
  installBlockedReason: string | null | undefined,
  platform?: string | null,
): boolean {
  return platform !== 'linux' && phase === 'downloaded' && installBlockedReason === null
}

/**
 * Whether a manual check is pointless on this platform: the main process
 * refuses checkNow() on Linux NON-AppImage shapes (dev / unpacked dir / deb —
 * no installer feed; the AppImage shape schedules and checks like mac/win,
 * design 21 shape gate) and never schedules checks there, so an enabled
 * button would be a permanently silent no-op. mac WITHOUT a Developer ID
 * signature must stay checkable (a check is still meaningful there — only
 * the install leg is blocked), so this keys on the exact linux reason
 * string, not on any installBlockedReason.
 */
export function updateCheckPlatformBlocked(installBlockedReason: string | null | undefined): boolean {
  return installBlockedReason === 'auto-update is not supported on this platform'
}
