/**
 * Row hover card (chamber-owned): the official ui-primitives HoverCard's chrome,
 * placement and copy affordance, driven by `createHoverIntent` instead of the
 * vendored atom's timer/state pair. The vendored atom arms its grace close
 * against the last COMMITTED `open`, so a pointerleave handled while React's
 * commit is pending strands a card with no pointer left to dismiss it; vendor
 * sources are read-only, so the corrected machine lives in this package.
 * Deliberate differences: the close path bumps the copy epoch (an in-flight
 * clipboard write cannot paint `copiedLabel` on the NEXT card); an off-screen or
 * non-laid-out anchor CLOSES the card while a partially visible one clamps to
 * `top >= 0`; placement follows the anchor's ResizeObserver.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { createHoverIntent, HOVER_OPEN_DELAY_MS, type HoverIntent } from '@dsh-chamber/dsh-chamber-client-core/hover-intent'
import cc from './sidebar-chamber.module.css'

/** Feedback dwell: how long the copy success label stays in the card. */
const COPY_FEEDBACK_MS = 1000
/** Viewport edge margin for the card's own placement. */
const EDGE_MARGIN = 8
/** Card offset from the anchor's right edge (official HoverCard value). */
const ANCHOR_GAP = 8

/** Props: the vendored atom's used subset, so the call sites stay unchanged. */
export interface RowHoverCardProps {
  anchor: ReactNode
  /** Card body; the pointer may rest on it, so it is readable and selectable. */
  content: ReactNode
  /** Suppress opening and close an open card (menu open, drag, inline rename). */
  disabled?: boolean
  /** Dwell before open (default {@link HOVER_OPEN_DELAY_MS}); read once at machine creation. */
  openDelayMs?: number
  /** Primary value copied by activation; omitted makes the card read-only. */
  copyText?: string | undefined
  /** Localized accessible activation-label prefix; required with `copyText`. */
  copyLabel?: string
  copiedLabel?: string
}

/** Render an anchor with a hover-triggered preview card. */
export function RowHoverCard({
  anchor, content, disabled = false, openDelayMs = HOVER_OPEN_DELAY_MS, copyText, copyLabel, copiedLabel,
}: RowHoverCardProps) {
  const rootRef = useRef<HTMLSpanElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyHeightRef = useRef<number | null>(null)
  const copyEpochRef = useRef(0)
  const copyingRef = useRef(false)
  const mountedRef = useRef(true)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [copied, setCopied] = useState(false)

  const clearCopied = useCallback(() => {
    if (copyTimerRef.current !== null) {
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = null
    }
    copyHeightRef.current = null
    setCopied(false)
  }, [])

  // 每张卡一个机器，首渲染创建（选项是普通值，之后改 prop 不会重新计时），
  // StrictMode 双调用下复用。`dispose` 丢掉两个计时器并释放页面级槽位；复用仍安全
  // 仅因重挂载时 open === false——挪进依赖变化的 effect 会释放仍在屏幕上的卡的槽位。
  const intentRef = useRef<HoverIntent | null>(null)
  if (intentRef.current === null) intentRef.current = createHoverIntent({ disabled, openDelayMs })
  const intent = intentRef.current
  // 可见性从机器读取，绝不镜像进组件 state：React 在 commit 后会重新核对快照，
  // 渲染中途做出的决定（leave/press/所有者门）不会被过期的 open commit 覆盖。
  const open = useSyncExternalStore(intent.subscribe, intent.isOpen)

  // Owner gating mid-hover (menu opened, drag started) closes immediately.
  useEffect(() => {
    intent.setDisabled(disabled)
  }, [intent, disabled])

  // The copy feedback belongs to one showing of the card. `open === false` is
  // 复制反馈属于一次展示。`open === false` 是唯一关闭漏斗（宽限关闭/按下即收/禁用），
  // 在此自增 epoch 才能取消关闭时仍在飞行中的剪贴板写入——否则它会在关闭→重开后
  // 落定，为新卡刷出 copiedLabel 并带上没人要求的计时器。两句顺序无意义。
  useEffect(() => {
    if (open) return
    copyEpochRef.current += 1
    clearCopied()
  }, [open, clearCopied])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      copyEpochRef.current += 1
      intent.dispose()
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current)
        copyTimerRef.current = null
      }
    }
  }, [intent])

  // 依锚点 rect 固定定位并在打开期间跟随（捕获阶段 scroll 监听嵌套面板，ResizeObserver
  // 捕获不滚动就移动行的重排）。水平轴夹在视口内（卡片宽 244px，窄窗口下官方右缘偏移会出屏）；
  // 竖直轴无 EDGE_MARGIN 下限：完全出屏/未布局的锚点关闭卡片而不是钉在边缘，部分可见的夹到 top >= 0。
  // 只依赖 `open` 并做等值守卫（content 的元素标识每次渲染都变），首次测量前卡片 visibility: hidden。
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const place = (): void => {
      const wrapper = rootRef.current
      const card = cardRef.current
      /* v8 ignore next -- both refs are attached before this effect runs and the listeners die with them. */
      if (wrapper === null || card === null) return
      const r = wrapper.getBoundingClientRect()
      // 无面积或非有限的 rect 表示锚点根本没布局（display:none 祖先里的行或已分离节点）：
      // 它报告原点，出屏测试既不见上也不见下，卡片会钉在左上角底下什么都没有——改为关闭。
      if (!Number.isFinite(r.left) || !Number.isFinite(r.top)
        || !Number.isFinite(r.right) || !Number.isFinite(r.bottom)
        || !(r.right > r.left) || !(r.bottom > r.top)) {
        intent.press()
        return
      }
      if (r.bottom < 0 || r.top > window.innerHeight
        || r.right < 0 || r.left > window.innerWidth) {
        // 锚点本体出屏（滚动越过，或列表在静止指针下移动）：无可预览，夹边浮起的
        // 卡片没有锚点可解释。经机器关闭（普通渲染变更可能以错误顺序被重新 commit）；
        // 两轴都判是对称契约（竖直可达，水平为防御性对称）。
        intent.press()
        return
      }
      const left = Math.max(EDGE_MARGIN, Math.min(r.right + ANCHOR_GAP, window.innerWidth - card.offsetWidth - EDGE_MARGIN))
      // 底边夹紧同上游且不低于视口顶边：部分可见的锚点可能比卡片矮，卡片要留在 y=0 可读而不是整个挂到屏外。
      const top = Math.max(0, Math.min(r.top, window.innerHeight - card.offsetHeight - EDGE_MARGIN))
      setPos(prev => (prev !== null && prev.left === left && prev.top === top ? prev : { left, top }))
    }
    place()
    // 观察 wrapper 自身的盒与其包含块：在上方插入/移除行会移动锚点而不改变其尺寸，
    // 容器盒是最接近的可观察信号。已知边界（今天不可达）：同尺寸两行互换时两个盒都不变，
    // 无 scroll/resize 可观察，卡片保留旧坐标直到下次滚动/调整；上游根本没有观察器。
    const observer = new ResizeObserver(place)
    const wrapper = rootRef.current
    /* v8 ignore next -- both refs are attached before this effect runs (the same assumption `place` makes). */
    if (wrapper !== null) {
      observer.observe(wrapper)
      const container = wrapper.parentElement
      if (container !== null) observer.observe(container)
    }
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  const copy = async (text: string): Promise<void> => {
    if (copied || copyingRef.current) return
    copyingRef.current = true
    const copyEpoch = copyEpochRef.current
    const accepted = await writeClipboard(text)
    copyingRef.current = false
    const card = cardRef.current
    if (!accepted || !mountedRef.current || copyEpoch !== copyEpochRef.current || card === null) return
    const height = card.offsetHeight
    copyHeightRef.current = height > 0 ? height : null
    setCopied(true)
    copyTimerRef.current = setTimeout(clearCopied, COPY_FEEDBACK_MS)
  }

  const copyable = copyText !== undefined
  const card = open
    ? (
      <div
        ref={cardRef}
        // 外部探针标记（精确名；按它定位传送出去的卡片）。
        data-chamber-hovercard=""
        className={`${cc.hoverCard}${copyable ? ` ${cc.hoverCardCopyable}` : ''}${copied ? ` ${cc.hoverCardFeedback}` : ''}`}
        style={{
          left: pos?.left ?? 0,
          top: pos?.top ?? 0,
          visibility: pos === null ? 'hidden' : undefined,
          minHeight: copied && copyHeightRef.current !== null ? copyHeightRef.current : undefined,
        }}
        role={copyable ? 'button' : undefined}
        tabIndex={copyable ? 0 : undefined}
        aria-label={copyable ? `${copyLabel ?? ''}: ${copyText}` : undefined}
        onClick={copyable
          ? (e) => {
            const selection = window.getSelection()
            if (selection !== null && !selection.isCollapsed) {
              for (let i = 0; i < selection.rangeCount; i += 1) {
                if (selection.getRangeAt(i).intersectsNode(e.currentTarget)) return
              }
            }
            void copy(copyText)
          }
          : undefined}
        onKeyDown={copyable
          ? (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            void copy(copyText)
          }
          : undefined}
      >
        {copied ? <span className={cc.hoverCardCopied} aria-hidden="true">{copiedLabel}</span> : content}
      </div>
    )
    : null

  return (
    <span
      ref={rootRef}
      // 外部探针标记（精确名），见卡片上的孪生标记。
      data-chamber-hovercard-anchor=""
      className={cc.hoverAnchor}
      onPointerEnter={() => { intent.enter() }}
      onPointerLeave={() => { intent.leave() }}
      // 锚点内的按下（行点击、菜单触发器）立即收卡；卡上的按下也会到达此处理器
      // （卡是 wrapper 的 React 子节点），但那是在选文本，卡片必须保持挂载。
      onPointerDownCapture={(e) => {
        if (cardRef.current?.contains(e.target as Node)) return
        intent.press()
      }}
    >
      {anchor}
      {open && copyable && <span className={cc.hoverCardStatus} role="status">{copied ? copiedLabel : ''}</span>}
      {card !== null && createPortal(card, document.body)}
    </span>
  )
}
