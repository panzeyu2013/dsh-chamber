/**
 * Session-row title marquee, copied verbatim from upstream ui-workspace
 * `rows/Rows.tsx` (`MIN_TITLE_REVEAL_PX`, `TITLE_MARQUEE_PX_PER_MS`,
 * `placeTitle`, `restTitle`, `useTitleMarquee`): a clipped one-line title
 * crawls at a constant speed while its row is hovered and rests at the far
 * edge; the two `data-*` hooks publish the fade masks the stylesheet owns.
 * Overflow of at most MIN_TITLE_REVEAL_PX stays put — a barely-clipped title
 * moving a few pixels reads as jitter, not a reveal — and leaving returns the
 * title to the start in one step, because the resting ellipsis and the narrowed
 * cell would otherwise meet the text while it travelled back. Reduced motion
 * jumps to the far edge instead of crawling.
 */
import { useEffect, useMemo, useRef, type RefObject } from 'react'

/** Overflow at or below this many CSS pixels never marquees. */
export const MIN_TITLE_REVEAL_PX = 8
/** Marquee crawl speed in CSS pixels per millisecond (30px/s). */
export const TITLE_MARQUEE_PX_PER_MS = 0.03

/**
 * Place the title's scroll position and publish the stylesheet's fade-mask
 * hooks: `data-scrolled` while the title has left its start (left fade) and
 * `data-clipped` while text remains beyond the right edge (right fade).
 * @param title - the row's clipping title element.
 * @param left - scroll offset in CSS pixels.
 * @param range - the title's maximum scroll offset in CSS pixels.
 */
export function placeTitle(title: HTMLElement, left: number, range: number): void {
  if (typeof title.scrollTo === 'function') {
    title.scrollTo({ left, behavior: 'instant' })
  } else {
    title.scrollLeft = left
  }
  if (left > 0) title.dataset.scrolled = ''
  else delete title.dataset.scrolled
  if (left < range) title.dataset.clipped = ''
  else delete title.dataset.clipped
}

/**
 * Return the title to its resting state: scrolled to the start with both fade
 * masks off, so the resting ellipsis renders at full strength.
 * @param title - the row's clipping title element.
 */
export function restTitle(title: HTMLElement): void {
  if (typeof title.scrollTo === 'function') {
    title.scrollTo({ left: 0, behavior: 'instant' })
  } else {
    title.scrollLeft = 0
  }
  delete title.dataset.scrolled
  delete title.dataset.clipped
}

/**
 * Marquee a title wider than its one-line cell while its row is hovered.
 * @param title - ref to the row's clipping title element.
 * @returns stable pointer enter/leave handlers for the row.
 */
export function useTitleMarquee(title: RefObject<HTMLElement | null>): { enter: () => void; leave: () => void } {
  const frame = useRef(0)
  useEffect(() => () => {
    cancelAnimationFrame(frame.current)
  }, [])
  return useMemo(() => ({
    enter: () => {
      // Defensive: the title span renders unconditionally.
      if (title.current === null) return
      const element = title.current
      const range = element.scrollWidth - element.clientWidth
      if (range <= MIN_TITLE_REVEAL_PX) return
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        placeTitle(element, range, range)
        return
      }
      cancelAnimationFrame(frame.current)
      let previous: number | undefined
      let position = 0
      const step = (now: number): void => {
        position += previous === undefined ? 0 : (now - previous) * TITLE_MARQUEE_PX_PER_MS
        previous = now
        placeTitle(element, Math.min(position, range), range)
        if (position < range) frame.current = requestAnimationFrame(step)
      }
      frame.current = requestAnimationFrame(step)
    },
    leave: () => {
      cancelAnimationFrame(frame.current)
      // Defensive: the title span renders unconditionally.
      if (title.current === null) return
      restTitle(title.current)
    },
  }), [title])
}
