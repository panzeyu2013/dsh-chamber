/**
 * Update-section gates — pure, testable. Mirrors the main-process runCheck() phase
 * gates: an explicit「检查更新」click is a no-op while a check/download already owns
 * the flow, or once「已下载，退出时安装」is final for this version. The phases are
 * flavor-neutral: the native flavor pushes Sparkle's checking/installing phases
 * through the same projection, so the page adds no discovery of its own.
 */
import type { UpdatePhase } from '../ambient/update-bridge.d.ts'

export function updateCheckDisabled(phase: UpdatePhase | undefined): boolean {
  // 'installing' (native/Sparkle install in flight) owns the flow exactly like downloading/downloaded.
  return phase === 'checking' || phase === 'downloading' || phase === 'downloaded'
    || phase === 'installing'
}

/**
 * Whether the「重启并安装」button (restart into the downloaded update,
 * quitAndInstall) may be offered: only a COMPLETED download on a shape where
 * automatic installation is possible AND the restart semantics can hold. Mirrors
 * updater.restartAndInstall() exactly (phase `downloaded` + installBlockedReason
 * null + NOT linux) — the main process enforces the same conditions.
 *
 * Linux is excluded regardless of shape: electron-updater's AppImageUpdater swaps
 * the running file and spawns the new instance BEFORE the old process quits, and the
 * fresh instance collides with the still-alive old one under Electron's
 * single-instance lock — the promised auto-restart structurally cannot happen. Linux
 * keeps the quit-install leg. `platform` is the window.dshChamber.platform projection.
 */
export function updateRestartAvailable(
  phase: UpdatePhase | undefined,
  installBlockedReason: string | null | undefined,
  platform?: string | null,
): boolean {
  return platform !== 'linux' && phase === 'downloaded' && installBlockedReason === null
}

/**
 * Whether a manual check is pointless on this platform: the main process refuses
 * checkNow() on Linux NON-AppImage shapes (dev / unpacked dir / deb — no installer
 * feed) and never schedules checks there, so an enabled button would be a permanently
 * silent no-op. mac WITHOUT a Developer ID signature must stay checkable (only the
 * install leg is blocked), so this keys on the exact linux reason string, never on
 * installBlockedReason.
 */
export function updateCheckPlatformBlocked(installBlockedReason: string | null | undefined): boolean {
  return installBlockedReason === 'auto-update is not supported on this platform'
}
