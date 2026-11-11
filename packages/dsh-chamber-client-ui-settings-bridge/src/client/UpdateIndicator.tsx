/**
 * 设置触发行的「更新」指示器（P02 / design 05 §5 / design 15 §1）——官方
 * DesktopUpdateIndicator 的 chamber 自持实现：不 import 官方插件组件（跨插件禁令），
 * 只消费本页已共享的模块单例 update-store（SettingsShell 传入的纯门投影，不新开订阅）。
 *
 * 形态：仅 wide 触发行渲染；icon + Tooltip + aria-label，**无可见 label**（42px 触发行
 * 放不下官方那枚 label，且面板内已有完整状态行）。点击 = 打开设置并落在「客户端」页的
 * 更新组（SettingsShell 的 openSection(GENERAL_SECTION_ID)），不消费
 * dshDesktop.updates.open（差异登记见 design 15 §1 被否方案）。
 */
import { IconDownloadOutlineRegular, IconLoadingOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsBridgeKey } from '../locales.ts'
import type { UpdateIndicatorView } from './update-gate.ts'
import css from './SettingsShell.module.css'

type IndicatorTranslate = (key: SettingsBridgeKey) => string

export function UpdateIndicator({
  wide, view, t, onOpen,
}: {
  /** Wide trigger row only; the rail renders the trigger button alone (official parity). */
  wide: boolean
  /** The pure gate projection (update-gate.updateIndicatorView). */
  view: UpdateIndicatorView
  t: IndicatorTranslate
  onOpen: () => void
}) {
  if (!wide || view.kind === 'none' || view.labelKey === null) return null
  const label = t(view.labelKey)
  // 官方 busy 语义：aria-disabled 且点击不动作（状态行本身是唯一的进度面）。
  const busy = view.kind === 'busy'
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        className={css.updateIndicator}
        aria-label={label}
        aria-disabled={busy ? 'true' : undefined}
        onClick={() => { if (!busy) onOpen() }}
      >
        <span className={css.updateIndicatorIcon} aria-hidden="true">
          {view.kind === 'error' ? (
            <span className={css.updateIndicatorErrorDot} />
          ) : view.kind === 'busy' ? (
            <IconLoadingOutlineRegular className={css.updateIndicatorSpinner} size={14} />
          ) : (
            <IconDownloadOutlineRegular size={14} />
          )}
        </span>
      </button>
    </Tooltip>
  )
}
