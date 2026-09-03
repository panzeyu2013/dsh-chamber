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
