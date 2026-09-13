/**
 * Row hover card (chamber-owned): the official ui-primitives `HoverCard`'s card
 * chrome, placement and copy affordance, driven by `createHoverIntent`
 * (../shared/hover-intent.ts) instead of the vendored atom's timer/state pair.
 *
 * Why the chamber owns this atom: the vendored HoverCard arms its grace close
 * against the last COMMITTED `open`, so a pointerleave handled while React's
 * commit of the dwell timer was still pending stranded a card on screen with no
 * pointer left to dismiss it (the measured defect and the reproduction live in
 * `hover-intent.ts`'s header). Vendor sources are read-only here (pinned
 * upstream), so the corrected machine lives in this package; the card box, the
 * 8px right-edge offset, the vertical clamp, the 200ms grace, the press-to-
 * dismiss rule and the copy-on-activation contract all mirror the atom it
 * replaces. `docs/design/06-sidebar-enhancements.md` §7 records the port and
 * `docs/progress/STATUS.md` carries the upstream defect as an open deviation.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { createHoverIntent, type HoverIntent } from '../shared/hover-intent.ts'
import cc from './sidebar-chamber.module.css'

/** Feedback dwell: how long the copy success label stays in the card. */
const COPY_FEEDBACK_MS = 1000
/** Viewport edge margin for the card's own placement. */
const EDGE_MARGIN = 8
/** Card offset from the anchor's right edge (official HoverCard value). */
const ANCHOR_GAP = 8

/** Props: the vendored atom's used subset, so the call sites stay unchanged. */
export interface RowHoverCardProps {
  /** The hover target, rendered in place inside the wrapper span. */
  anchor: ReactNode
  /** Card body; the pointer may rest on it, so it is readable and selectable. */
  content: ReactNode
  /** Suppress opening and close an open card (menu open, drag, inline rename). */
  disabled?: boolean
  /** Primary value copied by activation; omitted makes the card read-only. */
  copyText?: string | undefined
  /** Localized accessible activation-label prefix. */
  copyLabel: string
  /** Localized visible success label. */
  copiedLabel: string
}

/**
 * Render an anchor with a hover-triggered preview card.
 * @param props - see {@link RowHoverCardProps}.
 * @returns the anchor wrapper plus the portaled card while open.
 */
export function RowHoverCard({
  anchor, content, disabled = false, copyText, copyLabel, copiedLabel,
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

  // One machine per card, created on the first render (its options are plain
  // values) and reused across StrictMode's double-invoked effects: `dispose`
  // only drops timers.
  const intentRef = useRef<HoverIntent | null>(null)
  if (intentRef.current === null) intentRef.current = createHoverIntent({ disabled })
  const intent = intentRef.current
  // Visibility is READ from the machine, never mirrored into component state:
  // React re-checks this snapshot after commit, so a decision taken mid-render
  // (leave, press, owner gate) can never be overridden by a stale open commit.
  const open = useSyncExternalStore(intent.subscribe, intent.isOpen)

  // Owner gating mid-hover (menu opened, drag started) closes immediately.
  useEffect(() => {
    intent.setDisabled(disabled)
  }, [intent, disabled])

  // The copy feedback belongs to one showing of the card.
  useEffect(() => {
    if (open) return
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

  // Fixed-position from the anchor rect; track the anchor while open (the
  // capture-phase scroll listener catches nested panes). Both axes are clamped
  // inside the viewport: the card is 244px wide and the sidebar sits at the
  // left edge, so on a narrow window the official right-edge offset alone would
  // push the card off screen. Keyed on `open` alone (never on `content`, whose
  // element identity changes every render) and identity-guarded, so placement
  // cannot feed itself a render loop. The card stays `visibility: hidden` until
  // the first measurement lands, so it can never paint at 0,0.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const place = (): void => {
      const wrapper = rootRef.current
      const card = cardRef.current
      /* v8 ignore next -- both refs are attached before this effect runs and the listeners die with them. */
      if (wrapper === null || card === null) return
      const r = wrapper.getBoundingClientRect()
      const left = Math.max(EDGE_MARGIN, Math.min(r.right + ANCHOR_GAP, window.innerWidth - card.offsetWidth - EDGE_MARGIN))
      const top = Math.max(EDGE_MARGIN, Math.min(r.top, window.innerHeight - card.offsetHeight - EDGE_MARGIN))
      setPos(prev => (prev !== null && prev.left === left && prev.top === top ? prev : { left, top }))
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
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
        className={`${cc.hoverCard}${copyable ? ` ${cc.hoverCardCopyable}` : ''}${copied ? ` ${cc.hoverCardFeedback}` : ''}`}
        style={{
          left: pos?.left ?? 0,
          top: pos?.top ?? 0,
          visibility: pos === null ? 'hidden' : undefined,
          minHeight: copied && copyHeightRef.current !== null ? copyHeightRef.current : undefined,
        }}
        role={copyable ? 'button' : undefined}
        tabIndex={copyable ? 0 : undefined}
        aria-label={copyable ? `${copyLabel}: ${copyText}` : undefined}
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
      className={cc.hoverAnchor}
      onPointerEnter={() => { intent.enter() }}
      onPointerLeave={() => { intent.leave() }}
      // A press inside the anchor (row click, menu trigger) dismisses the card
      // immediately. Capture presses reach this handler from the card too — it
      // is a React child of the wrapper — but a press there starts a selection,
      // so the card must stay mounted under it.
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
