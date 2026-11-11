/**
 * Update-section gates — pure, testable. Mirrors the main-process runCheck() phase
 * gates: an explicit「检查更新」click is a no-op while a check/download already owns
 * the flow, or once「已下载，退出时安装」is final for this version. The phases are
 * flavor-neutral: the native flavor pushes Sparkle's checking/installing phases
 * through the same projection, so the page adds no discovery of its own.
 *
 * The file also owns the presentation decisions the section makes without a render
 * harness (this package has NO React test facility): the failure row's
 * technical-details disclosure (P05), the sidebar trigger's update indicator (P02)
 * and the restart-refusal map (P20-B).
 */
import type { UpdatePhase, UpdateState } from '../ambient/update-bridge.d.ts'
import type { SettingsBridgeKey } from '../locales.ts'

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

/**
 * ⟨P05⟩ 失败行的「技术详情」折叠是否可见（design 25 §7）：`update.error` 是主进程写入点
 * 已脱敏的原文投影（updater.sanitizeErrorText + 原生入站 512 上限），空/纯空白错误不渲染
 * 折叠入口——绝不给出一个展开后什么都没有的 details。判定抽在这里，组件只做接线。
 */
export function updateTechDetailsVisible(error: string | null | undefined): boolean {
  return typeof error === 'string' && error.trim() !== ''
}

/**
 * ⟨P20-B⟩ 「重启并安装」被拒的回执映射（design 25 §7）：原生壳在安装动作前先退出全屏，
 * 5s 内未退出即以 `fullscreen-timeout`（对齐上游 DesktopUpdateFailureKind 的 id）原样拒绝
 * 安装；该码是唯一有专属文案的拒绝，行内保留「重启并安装」可重试。其余拒绝（过期回答 /
 * 载荷非法 / 相位门 / 未知壳错误）一律走既有通用面 updateActionRefused——绝不把未知错误
 * 说成超时。
 */
const UPDATE_FULLSCREEN_TIMEOUT_ERROR = 'fullscreen-timeout'

export type RestartFailureView = 'none' | 'fullscreen-timeout' | 'refused'

export function restartFailureView(error: string | null | undefined): RestartFailureView {
  if (error === null || error === undefined) return 'none'
  return error === UPDATE_FULLSCREEN_TIMEOUT_ERROR ? 'fullscreen-timeout' : 'refused'
}

/**
 * ⟨P02⟩ 设置触发行「更新指示器」的呈现真值表（design 05 §5 / design 15 §1）：纯门，
 * 组件只做图标 / tooltip 映射。
 *
 * 渲染门 = wide（窄栏 rail 只渲染触发按钮；官方 DesktopUpdateIndicator 同样 !wide → null）
 * 且更新面已水合（update === null = 桥未就绪：未知不等于「无更新」，绝不渲染）。
 * 相位映射：checking / downloading / installing = busy（转圈）；available / downloaded =
 * download（下载图标）；error = error（红点）；idle / up-to-date = none。
 * `labelKey` 同时是 tooltip 与 aria-label 的词条——指示器没有可见文本（42px 触发行放不下
 * 官方那枚 label）。
 */
export type UpdateIndicatorKind = 'none' | 'busy' | 'download' | 'error'

export interface UpdateIndicatorView {
  kind: UpdateIndicatorKind
  /** Tooltip / aria-label dictionary key; null when the indicator is not rendered. */
  labelKey: SettingsBridgeKey | null
}

export function updateIndicatorView(update: UpdateState | null, wide: boolean): UpdateIndicatorView {
  if (!wide || update === null) return { kind: 'none', labelKey: null }
  switch (update.phase) {
    case 'checking':
      return { kind: 'busy', labelKey: 'updateIndicatorChecking' }
    case 'downloading':
      return { kind: 'busy', labelKey: 'updateIndicatorDownloading' }
    case 'installing':
      return { kind: 'busy', labelKey: 'updateIndicatorInstalling' }
    case 'available':
      return { kind: 'download', labelKey: 'updateIndicatorAvailable' }
    case 'downloaded':
      return { kind: 'download', labelKey: 'updateIndicatorDownloaded' }
    case 'error':
      return { kind: 'error', labelKey: 'updateIndicatorError' }
    default:
      return { kind: 'none', labelKey: null }
  }
}
