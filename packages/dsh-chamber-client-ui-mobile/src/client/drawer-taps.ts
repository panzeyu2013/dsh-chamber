/**
 * Drawer tap self-heal (design 17 §18.4.4; touch tier only).
 *
 * iOS Safari reliably *suppresses the compatibility click* for taps inside
 * the sidebar drawer: the first tap on a session row shows only its hover
 * state (the row reveals its trailing time/actions on `:hover`, so the hit
 * element shifts between touchstart and touchend), and Safari cancels or
 * redirects the synthesized click — a second tap then "works" because the
 * hover layout is already applied. Empirical on-device record (community
 * mobile-dsh projects, 2026-08; mechanism surveyed in design 17 §18.4):
 * the synthesized click can be missing entirely, timing-independent.
 *
 * The row's activation lives in React's delegated onClick, so the heal does
 * not need to know what the row does: when a STABLE tap's real click never
 * arrives, re-dispatch an untrusted bubbling `click` from the pointerup
 * target. React's root-delegated listeners do not filter `isTrusted`, so
 * the row opens exactly as if the browser had delivered the click — and a
 * real click that DID arrive suppresses the heal (zero intervention).
 *
 * Guards (all mirrored in the pure helpers below, unit-tested):
 *  - touch tier only (`active()` gate; desktop mouse/pen paths untouched —
 *    the "PC leak" invariant applied to JS);
 *  - touch/pen pointers only;
 *  - only STABLE taps heal — a pan/scroll/drag must never synthesize an
 *    activation (movement beyond the slop, or a pointerup after the drawer
 *    scrolled, is a scroll intent);
 *  - only taps inside the drawer (`[data-mobile-role="sidebar"]`) heal —
 *    the floating toggle and backdrop are ordinary buttons outside it;
 *  - form fields (the drawer search box, inline editors) never heal: a
 *    suppressed tap there is a focus/selection concern, not an activation.
 *
 * Single-instance document-level effect by design (the gateway deployment
 * is single-shell; a future multi-shell mount must scope it — see index.ts
 * behavior-effect note).
 */
const DRAWER_SIDEBAR_SELECTOR = '[data-mobile-role="sidebar"]'
/** Form controls that must never receive a synthesized activation
 *  (contenteditable in every non-false state included). */
export const HEAL_FORM_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
/** Max pointer travel for a tap (px, both axes): beyond this it is a pan. */
export const TAP_SLOP_PX = 12
/** Grace before a suppressed tap is healed (ms): long enough to absorb a
 *  delayed-but-delivered compatibility click, short enough that a healed
 *  row activation still feels immediate. */
export const HEAL_GRACE_MS = 120
/** After a heal, a TRUSTED click arriving at nearly the same coordinates
 *  within this window is the delayed real click (or a ghost click after the
 *  drawer re-laid out) — swallowed so the row cannot activate twice. */
export const HEAL_SUPPRESS_MS = 150

export interface TapGeometry {
  startX: number
  startY: number
  endX: number
  endY: number
}

/** A stable tap: pointer travel within the slop on both axes. */
export function isStableTap(geometry: TapGeometry, slop: number = TAP_SLOP_PX): boolean {
  return Math.abs(geometry.endX - geometry.startX) <= slop
    && Math.abs(geometry.endY - geometry.startY) <= slop
}

/** The minimal element face the target predicate needs (real Element). */
export interface ClosestFace {
  closest(selector: string): ClosestFace | null
}

/** Only drawer taps outside form controls are heal candidates. */
export function isHealableDrawerTarget(target: ClosestFace | null): boolean {
  if (target === null) return false
  if (target.closest(HEAL_FORM_SELECTOR) !== null) return false
  return target.closest(DRAWER_SIDEBAR_SELECTOR) !== null
}

interface PendingTap {
  target: Element
  timer: ReturnType<typeof setTimeout> | null
}

interface HealFire {
  time: number
  x: number
  y: number
}

/**
 * Install the drawer tap self-heal.
 * @param active - live touch-tier gate (matchMedia result read at event time).
 * @returns the disposer.
 */
export function installDrawerTapHeal(active: () => boolean): () => void {
  // Per-pointerId origins: two simultaneous touches (thumb rest + tap) each
  // keep their own start, so a suppressed tap is never silently dropped by
  // the other finger's pointerup.
  const pointerStarts = new Map<number, { x: number; y: number }>()
  let pending: PendingTap | null = null
  /** The last heal that fired, for late-real-click suppression. */
  let healFired: HealFire | null = null

  const clearPending = (): void => {
    if (pending === null) return
    if (pending.timer !== null) clearTimeout(pending.timer)
    pending = null
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (!active()) return
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return
    pointerStarts.set(event.pointerId, { x: event.clientX, y: event.clientY })
    // A new gesture disarms the post-heal suppression window.
    healFired = null
  }

  const onPointerUp = (event: PointerEvent): void => {
    if (!active()) return
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return
    const start = pointerStarts.get(event.pointerId)
    pointerStarts.delete(event.pointerId)
    if (start === undefined) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (!isStableTap({ startX: start.x, startY: start.y, endX: event.clientX, endY: event.clientY })) return
    if (!isHealableDrawerTarget(target)) return
    clearPending()
    const record: PendingTap = { target, timer: null }
    pending = record
    // Grace window before the heal fires. The compatibility click of a
    // SUPPRESSED tap never arrives at all, and a DELIVERED click normally
    // lands immediately after touchend (well inside the window) — the
    // capture-phase onClick above clears the pending record then. A short
    // grace (not a bare macrotask) additionally absorbs engines that delay
    // the click past the current task (double-tap-detection windows,
    // hover-reveal re-hit tests), so the heal and a late real click cannot
    // double-activate the row.
    record.timer = setTimeout(() => {
      if (pending !== record) return
      pending = null
      // Re-check the tier at fire time: a stale heal must not dispatch when
      // the touch tier flipped inside the grace window (resize/devtools).
      if (!active()) return
      if (!record.target.isConnected) return
      // Untrusted by definition — React's delegated listeners still run it.
      healFired = { time: Date.now(), x: event.clientX, y: event.clientY }
      record.target.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
      }))
    }, HEAL_GRACE_MS)
  }

  const onPointerCancel = (event: PointerEvent): void => {
    pointerStarts.delete(event.pointerId)
  }

  const onClick = (event: MouseEvent): void => {
    if (pending !== null) {
      if (!(event.target instanceof Node)) return
      // A real click from the tap target's subtree (or the target itself)
      // satisfies the pending heal. Our own synthesized click never reaches
      // this branch: the timer clears `pending` before dispatching.
      if (pending.target === event.target || pending.target.contains(event.target)) {
        clearPending()
      }
      return
    }
    // Late-real-click suppression after a heal: a TRUSTED click at nearly
    // the healed coordinates inside the suppression window is the click the
    // browser delayed (or a ghost click after the drawer re-laid out). The
    // heal already ran the row's activation; stop it before React's
    // delegated listeners see it (capture phase at document, above #root).
    if (healFired === null || !event.isTrusted || !(event.target instanceof Node)) return
    const since = Date.now() - healFired.time
    if (since < 0 || since > HEAL_SUPPRESS_MS) return
    if (Math.abs(event.clientX - healFired.x) > TAP_SLOP_PX
      || Math.abs(event.clientY - healFired.y) > TAP_SLOP_PX) return
    healFired = null
    event.stopPropagation()
  }

  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('pointerup', onPointerUp, true)
  document.addEventListener('pointercancel', onPointerCancel, true)
  document.addEventListener('click', onClick, true)
  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('pointerup', onPointerUp, true)
    document.removeEventListener('pointercancel', onPointerCancel, true)
    document.removeEventListener('click', onClick, true)
    clearPending()
    pointerStarts.clear()
    healFired = null
  }
}
