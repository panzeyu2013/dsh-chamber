/**
 * Drawer tap self-heal (touch tier only).
 *
 * iOS Safari suppresses the compatibility click for taps inside the sidebar
 * drawer: the first tap on a session row only shows its hover state (the row
 * reveals trailing actions on :hover, shifting the hit element). The row's
 * activation lives in React's delegated onClick, so when a STABLE tap's real
 * click never arrives, re-dispatch an untrusted bubbling click from the
 * pointerup target (React does not filter isTrusted); a real click that DID
 * arrive suppresses the heal.
 *
 * Guards (mirrored in the pure helpers): touch tier and touch/pen only
 * (PC-leak invariant); STABLE taps only (a scrolled drawer is scroll intent);
 * BOTH endpoints inside [data-mobile-role="sidebar"] (never double-fire the
 * backdrop's own close); never form controls. Single document-level effect
 * (installOnce: a duplicate install would race a second pending window on the
 * same pointerId and double-handle every tap).
 */
import { INSTALL_KEYS, installOnce } from './composer.ts'

const DRAWER_SIDEBAR_SELECTOR = '[data-mobile-role="sidebar"]'
/** Form controls that must never receive a synthesized activation
 *  (contenteditable in every non-false state included). */
export const HEAL_FORM_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
/** Max pointer travel for a tap (px, both axes): beyond this it is a pan. */
export const TAP_SLOP_PX = 12
/** Grace before a suppressed tap is healed (ms): absorbs a delayed-but-
 *  delivered compatibility click while keeping activation immediate. */
export const HEAL_GRACE_MS = 120
/** After a heal, a TRUSTED click at nearly the same coordinates within this
 *  window is the delayed real (or ghost) click — swallowed against double-open. */
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

/** Ancestor-relation facts of a real click vs the pending tap target. */
export interface HealClearFacts {
  /** The click landed at/inside the pointerup target. */
  atOrInsideTapTarget: boolean
  /** The click landed on an ANCESTOR of the pointerup target: iOS retargets a
   *  delayed synthesized click to the common down/up ancestor, which already
   *  bubbled through the row's delegated activation — a heal would double-fire. */
  ancestorOfTapTarget: boolean
}

/** A real click clears the pending heal iff it relates to the tap target in
 *  either direction — an already-activated row must never be re-healed. Pure. */
export function shouldClearPendingHeal(facts: HealClearFacts): boolean {
  return facts.atOrInsideTapTarget || facts.ancestorOfTapTarget
}

/** Late-real-click suppression after a heal: a TRUSTED click at nearly the
 *  healed coordinates inside the window is the delayed (or ghost) click, and
 *  the heal already ran the row's activation. Pure — unit-tested. */
export function isSuppressedLateClick(healFiredAtMs: number, nowMs: number, dx: number, dy: number): boolean {
  const since = nowMs - healFiredAtMs
  if (since < 0 || since > HEAL_SUPPRESS_MS) return false
  return Math.abs(dx) <= TAP_SLOP_PX && Math.abs(dy) <= TAP_SLOP_PX
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
 * Install the drawer tap self-heal. active is the live touch-tier gate, read
 * at event time.
 */
export function installDrawerTapHeal(active: () => boolean): () => void {
  return installOnce(INSTALL_KEYS.drawerTapHeal, () => installDrawerTapHealInner(active))
}

function installDrawerTapHealInner(active: () => boolean): () => void {
  // Per-pointerId origins: two simultaneous touches keep their own start. The
  // down target is kept too — healing requires the WHOLE gesture inside.
  const pointerStarts = new Map<number, { x: number; y: number; downTarget: Element | null }>()
  // Per-pointerId pending heals: two fingers tapping two rows at once own two
  // independent grace windows (a single slot let the second tap cancel the
  // first one's heal).
  const pending = new Map<number, PendingTap>()
  /** The heals that fired recently, for late-real-click suppression: one entry
   *  per concurrently healed tap. Pruned on every push and by the next gesture. */
  let healFires: HealFire[] = []

  const clearPending = (pointerId: number): void => {
    const record = pending.get(pointerId)
    if (record === undefined) return
    if (record.timer !== null) clearTimeout(record.timer)
    pending.delete(pointerId)
  }
  const clearAllPending = (): void => {
    for (const pointerId of [...pending.keys()]) clearPending(pointerId)
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (!active()) return
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return
    const downTarget = event.target instanceof Element ? event.target : null
    pointerStarts.set(event.pointerId, { x: event.clientX, y: event.clientY, downTarget })
    // A new gesture disarms the post-heal suppression window.
    healFires = []
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
    // Both endpoints must be inside the drawer: a tap that BEGAN on the
    // backdrop (within the 12px slop) must not heal over its close action.
    if (!isHealableDrawerTarget(start.downTarget)) return
    if (!isHealableDrawerTarget(target)) return
    // Replace only THIS pointer's pending heal: another finger's window is its
    // own (pointerId is the identity a gesture never shares).
    clearPending(event.pointerId)
    const record: PendingTap = { target, timer: null }
    pending.set(event.pointerId, record)
    // Grace window: a suppressed tap's compatibility click never arrives at
    // all, a delivered one lands right after touchend; a short grace (not a
    // bare macrotask) also absorbs engines that delay past the current task,
    // so heal and a late real click cannot both activate the row.
    record.timer = setTimeout(() => {
      if (pending.get(event.pointerId) !== record) return
      pending.delete(event.pointerId)
      // Re-check the tier at fire time: a stale heal must not dispatch after a flip.
      if (!active()) return
      if (!record.target.isConnected) return
      const firedAt = Date.now()
      // Expired entries are dropped here so a long session cannot accumulate
      // them; the new fire joins the suppression window.
      healFires = healFires.filter(fire => firedAt - fire.time <= HEAL_SUPPRESS_MS)
      healFires.push({ time: firedAt, x: event.clientX, y: event.clientY })
      // Untrusted by definition — React's delegated listeners still run it.
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
    if (pending.size > 0) {
      if (!(event.target instanceof Node)) return
      // A real click that relates to a tap target clears THAT pending heal in
      // EITHER direction: at/inside the pointerup target, or on an ANCESTOR of
      // it (iOS retargets to the common down/up ancestor, which already
      // activated the row through React delegation). Our own synthesized click
      // never reaches here: the timer clears pending before dispatching. A
      // pending belonging to another finger's row stays armed.
      for (const [pointerId, record] of pending) {
        const clickInsidePending = record.target === event.target || record.target.contains(event.target)
        const pendingInsideClick = event.target instanceof Element && event.target.contains(record.target)
        if (shouldClearPendingHeal({ atOrInsideTapTarget: clickInsidePending, ancestorOfTapTarget: pendingInsideClick })) {
          clearPending(pointerId)
        }
      }
      return
    }
    // Late-real-click suppression (capture, above #root): the heal already ran
    // the activation, so stop a trusted delayed/ghost click before React sees it.
    if (healFires.length === 0 || !event.isTrusted || !(event.target instanceof Node)) return
    const now = Date.now()
    const remaining: HealFire[] = []
    let suppressed = false
    for (const fire of healFires) {
      if (isSuppressedLateClick(fire.time, now, event.clientX - fire.x, event.clientY - fire.y)) suppressed = true
      else remaining.push(fire)
    }
    healFires = remaining
    if (!suppressed) return
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
    clearAllPending()
    pointerStarts.clear()
    healFires = []
  }
}
