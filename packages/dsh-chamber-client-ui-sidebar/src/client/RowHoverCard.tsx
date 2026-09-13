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
 * 8px right-edge offset, the 200ms grace, the press-to-dismiss rule and the
 * copy-on-activation contract all mirror the atom it replaces.
 * `docs/design/06-sidebar-enhancements.md` §7 records the port and
 * `docs/progress/STATUS.md` carries the upstream defect as an open deviation.
 *
 * Deliberate differences from the vendored atom, all pinned by
 * `test/hover-card-wiring.test.ts`:
 *  - the close path bumps the copy epoch, so a clipboard write still in flight
 *    when the card closes can never make the NEXT card render `copiedLabel`
 *    (upstream does this in `close()`, `HoverCard.tsx:54-58`);
 *  - the vertical placement has no `EDGE_MARGIN` floor (upstream has none
 *    either): a fully off-screen anchor, or one that is not laid out at all (a
 *    zero-area / non-finite rect from a `display: none` ancestor or a detached
 *    node), CLOSES the card instead of pinning it at the viewport corner, while
 *    a partially visible anchor clamps to `top >= 0` so the card can never hang
 *    entirely above the viewport;
 *  - placement is recomputed on layout changes of the anchor (ResizeObserver),
 *    not only on open/scroll/resize;
 *  - the wrapper and the card carry `data-chamber-hovercard-anchor` /
 *    `data-chamber-hovercard` so the acceptance probes can locate them.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { createHoverIntent, HOVER_OPEN_DELAY_MS, type HoverIntent } from '../shared/hover-intent.ts'
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
  /**
   * Dwell before the card opens (default {@link HOVER_OPEN_DELAY_MS}, the
   * official atom's value). Read once, when the card's machine is created.
   */
  openDelayMs?: number
  /** Primary value copied by activation; omitted makes the card read-only. */
  copyText?: string | undefined
  /** Localized accessible activation-label prefix; required with `copyText`. */
  copyLabel?: string
  /** Localized visible success label; required with `copyText`. */
  copiedLabel?: string
}

/**
 * Render an anchor with a hover-triggered preview card.
 * @param props - see {@link RowHoverCardProps}.
 * @returns the anchor wrapper plus the portaled card while open.
 */
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

  // One machine per card, created on the first render (its options are plain
  // values, so a later prop change cannot re-time a card already in flight) and
  // reused across StrictMode's double-invoked effects. NOTE what `dispose`
  // really does (2026-09-13 review C6): it drops both timers AND releases the
  // page-global slot. Reusing the machine is still safe there only because a
  // remount happens with `open === false` (the dwell has not fired yet) — moving
  // `dispose()` into an effect with changing deps would release the slot of a
  // card that is still on screen, i.e. a card no other card can dismiss.
  const intentRef = useRef<HoverIntent | null>(null)
  if (intentRef.current === null) intentRef.current = createHoverIntent({ disabled, openDelayMs })
  const intent = intentRef.current
  // Visibility is READ from the machine, never mirrored into component state:
  // React re-checks this snapshot after commit, so a decision taken mid-render
  // (leave, press, owner gate) can never be overridden by a stale open commit.
  const open = useSyncExternalStore(intent.subscribe, intent.isOpen)

  // Owner gating mid-hover (menu opened, drag started) closes immediately.
  useEffect(() => {
    intent.setDisabled(disabled)
  }, [intent, disabled])

  // The copy feedback belongs to one showing of the card. `open === false` is
  // the ONE close funnel — grace close, press-dismiss and disability flip all
  // publish it — so bumping the epoch here is what cancels a clipboard write
  // still in flight when the card closes. Without it that write settles after
  // close→reopen and paints `copiedLabel` on the NEW card for a second, armed
  // with a timer nobody asked for; the same bump lives in the vendored atom's
  // `close()` (upstream ui-primitives HoverCard.tsx:54-58), which this card
  // replaces. The order of the two statements below carries no meaning: both run
  // synchronously, and the stale write's continuation is a microtask that cannot
  // interleave them — the epoch only has to be stale by the time it resumes.
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

  // Fixed-position from the anchor rect; track the anchor while open (the
  // capture-phase scroll listener catches nested panes, the ResizeObserver
  // catches layout changes that move the row without a scroll — a list reflow,
  // a fold, a rename swapping the row for a form). The horizontal axis is
  // clamped inside the viewport: the card is 244px wide and the sidebar sits at
  // the left edge, so on a narrow window the official right-edge offset alone
  // would push the card off screen. The vertical axis has no such `EDGE_MARGIN`
  // floor (upstream has none either): a fully off-screen anchor, or one that is
  // not laid out at all, closes the card instead of pinning it at the edge with
  // nothing under it, and a partially visible anchor clamps to `top >= 0` so the
  // card never hangs entirely above the viewport. Keyed on
  // `open` alone (never on `content`, whose element identity changes every
  // render) and identity-guarded, so placement cannot feed itself a render
  // loop. The card stays `visibility: hidden` until the first measurement
  // lands, so it can never paint at 0,0.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const place = (): void => {
      const wrapper = rootRef.current
      const card = cardRef.current
      /* v8 ignore next -- both refs are attached before this effect runs and the listeners die with them. */
      if (wrapper === null || card === null) return
      const r = wrapper.getBoundingClientRect()
      // A rect with no area — or a non-finite one — means the anchor is not laid
      // out at all: a row inside a `display: none` ancestor (its workspace group
      // folded while the card was open) or a node detached from the document.
      // Such an anchor reports the origin, so the off-screen test below sees it
      // as neither above nor below the viewport and the card would stay pinned
      // at the top-left corner with nothing under it. Close instead. The mobile
      // watchdog guards the same shape (`isUsableAnchorRect`,
      // dsh-chamber-client-ui-mobile/src/client/official-hover-card.ts:164-166).
      if (!Number.isFinite(r.left) || !Number.isFinite(r.top)
        || !Number.isFinite(r.right) || !Number.isFinite(r.bottom)
        || !(r.right > r.left) || !(r.bottom > r.top)) {
        intent.press()
        return
      }
      if (r.bottom < 0 || r.top > window.innerHeight
        || r.right < 0 || r.left > window.innerWidth) {
        // The anchor itself is off screen (scrolled past, or the list moved
        // under a stationary pointer): there is nothing to preview, and a
        // clamped card would float at an edge with no anchor to explain it.
        // Close through the machine — a plain render change could be
        // re-committed in the wrong order.
        // Both axes, deliberately (2026-09-13 review C7c): the vertical case is
        // the reachable one (the sidebar only scrolls vertically), and the
        // horizontal arms are defensive symmetry so "off-screen anchor ⇒ close"
        // stays a two-axis contract instead of a one-axis special case.
        intent.press()
        return
      }
      const left = Math.max(EDGE_MARGIN, Math.min(r.right + ANCHOR_GAP, window.innerWidth - card.offsetWidth - EDGE_MARGIN))
      // Bottom-clamped like upstream, and never above the viewport's top edge: a
      // PARTIALLY visible anchor (the on-screen case, since the degenerate and
      // off-screen rects returned above) can sit closer to the top than the card
      // is tall, and the card must stay readable at y=0 instead of hanging
      // entirely off-screen. Closing is not required here — the anchor is real.
      const top = Math.max(0, Math.min(r.top, window.innerHeight - card.offsetHeight - EDGE_MARGIN))
      setPos(prev => (prev !== null && prev.left === left && prev.top === top ? prev : { left, top }))
    }
    place()
    // The wrapper's own box AND its containing block: a row inserted or removed
    // above this one moves the anchor without resizing it, and the container's
    // box is the closest observable signal for that reflow.
    // Known bound (2026-09-13 review C7d, not reachable today): a reorder that
    // swaps two same-size rows changes NEITHER box, and with no scroll/resize
    // event there is nothing to observe — the card would keep the old
    // coordinates until the next scroll or resize. Upstream has no observer at
    // all, so this is strictly narrower than the atom it replaces; fixing it
    // would mean observing the list's child order, which is not worth a
    // MutationObserver for a transient mis-anchor.
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
        // Acceptance-probe hook (exact name; the review counts/locates the
        // portaled card by it).
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
      // Acceptance-probe hook (exact name; the review counts/locates anchors by
      // it). See the card's twin marker above.
      data-chamber-hovercard-anchor=""
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
