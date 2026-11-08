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

/**
 * 「接收预览版（beta）更新」开关的呈现真值表（design 11 §3.2 / design 25 §7）——
 * 纯函数，组件只做文案与描边映射。
 *
 * 通道 = **纯用户偏好**（v4）：壳推送的 `update.channel` 只由「env 封签 OR 偏好
 * `betaUpdates === true` 且本构建两条 feed URL 可用」裁决；版本后缀**不**参与
 * （beta 构建默认也是稳定通道，开关关闭时只收正式版）。开关值因此回读壳推送的
 * 生效通道，不是 settings 里的期望值回声，页面绝不自行再推一遍。
 *
 * 三态优先级（高 → 低）：
 *  - `unsupported`：宿主能力事实（Swift 原生壳且两条通道 URL 均已注入）不为真——
 *    缺字段按「不支持」读，绝不呈现一个永远无效的开关；
 *  - `unavailable`：更新面尚未水合（桥未就绪 / 无更新面）——未知不等于可用，
 *    禁用且不给出「不支持」的错误断言；
 *  - 否则可用：普通开关 = 当前生效通道是否 beta（默认关）。
 */
export interface BetaUpdatesUpdateLike {
  channel: 'stable' | 'beta'
}

export interface BetaUpdatesSwitchState {
  checked: boolean
  disabled: boolean
  reason: null | 'unsupported' | 'unavailable'
}

export function betaUpdatesSwitchState(input: {
  update: BetaUpdatesUpdateLike | null
  supported: boolean
}): BetaUpdatesSwitchState {
  if (input.supported !== true) {
    return { checked: input.update?.channel === 'beta', disabled: true, reason: 'unsupported' }
  }
  if (input.update === null) {
    return { checked: false, disabled: true, reason: 'unavailable' }
  }
  return { checked: input.update.channel === 'beta', disabled: false, reason: null }
}
