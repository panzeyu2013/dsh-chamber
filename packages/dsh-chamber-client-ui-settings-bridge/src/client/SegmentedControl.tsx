import { useId, useLayoutEffect, useRef, useState } from 'react'
import css from './SegmentedControl.module.css'

export interface SegmentedOption<T extends string = string> {
  value: T
  label: string
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string = string> {
  options: SegmentedOption<T>[]
  value: T | null | undefined
  onChange: (value: T) => void
  /** Accessible name: pass the field label's id (aria-labelledby) or a plain
      string (aria-label); exactly one of the two. */
  ariaLabel?: string
  ariaLabelledBy?: string
  disabled?: boolean
  className?: string
}

// TRACK_PADDING 必须与 SegmentedControl.module.css 中 .segmented 的 padding
// 保持一致（测量出的 left/width 直接对接轨道坐标）。
const TRACK_PADDING = 2
const SEGMENT_GAP = 2

/**
 * 滑块式分段单选（chamber 设置通用）：轨道内蓝色滑块滑向选中项，选中
 * 文字反白（label-primary-foreground），未选中灰字。
 *
 * 选中色为官方业务蓝（--dsw-alias-state-business-primary，浅色
 * deepseek-500 / 深色 deepseek-400）——dsh 主题的 brand-primary 是中性
 * 黑/白，不适合做选中填充；反白文字在浅色为白、深色为近黑，两主题下与
 * 蓝色填充的对比度都达标。视觉语言参考官方 switch
 * （SubagentModelSelectionCard）与发送按钮（InputBar .primary：
 * info-fill 蓝底 + 白字形）。
 *
 * 与官方不同的是这里保留原生 radio 语义（每个选项一个 input[type=radio]，
 * 键盘方向键切换），滑块是 aria-hidden 的纯装饰层。
 *
 * 列宽按内容自适应（flex，各选项 max-content），因此滑块位置/宽度由
 * layout 测量得出——等宽列会让长文案溢出（如「隐藏到托盘」对「退出应用」）。
 * 测量在 useLayoutEffect 中进行，首帧 paint 前完成，无闪烁；测量只在选项
 * 文案签名变化时重跑（语言切换会触发，busy 等无关重渲染不会）。
 *
 * value 无匹配（如 hydration 前 settings 未到）时滑块隐藏——所有选项都
 * 未选中，滑块停在某一列会误导为"默认选中该项"。
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  ariaLabelledBy,
  disabled,
  className,
}: SegmentedControlProps<T>) {
  const groupName = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const [columnWidths, setColumnWidths] = useState<number[]>([])
  // 选项文案签名：仅 value/label 序列变化时重测（disabled 不影响列宽）。
  const optionSignature = options.map((option) => `${option.value}\u0000${option.label}`).join('\u0001')

  useLayoutEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const widths = Array.from(container.querySelectorAll<HTMLElement>(':scope > [data-segment]'))
      .map((segment) => segment.getBoundingClientRect().width)
    setColumnWidths(widths)
  }, [optionSignature])

  const selectedIndex = options.findIndex((option) => option.value === value)
  const matched = selectedIndex !== -1
  const safeIndex = Math.max(0, selectedIndex)
  const measured = columnWidths.length === options.length
  const thumbLeft = measured
    ? TRACK_PADDING + columnWidths.slice(0, safeIndex).reduce((sum, width) => sum + width + SEGMENT_GAP, 0)
    : TRACK_PADDING
  const thumbWidth = measured ? columnWidths[safeIndex] ?? 0 : 0

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className={className != null ? `${css.segmented} ${className}` : css.segmented}
    >
      {matched && (
        <span
          className={css.thumb}
          aria-hidden="true"
          style={measured ? { left: thumbLeft, width: thumbWidth } : undefined}
        />
      )}
      {options.map((option) => (
        <label key={option.value} data-segment className={css.segment}>
          <input
            type="radio"
            name={groupName}
            value={option.value}
            checked={value === option.value}
            disabled={disabled === true || option.disabled === true}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  )
}
