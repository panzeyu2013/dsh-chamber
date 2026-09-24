/**
 * Deadline-driven re-render: "has this instant passed?" without a polling
 * counter. ONE timer arms for the remaining wait and fires once; a null or
 * already-passed deadline answers synchronously with no timer.
 *
 * Replaces the 1 Hz tick state App used for the control-plane health grace
 * window: that counter re-rendered every second for as long as the error
 * persisted (and its state existed only to be incremented). The question the
 * frame actually asks is a boolean predicate over the clock, so the primitive
 * is a deadline, not a tick.
 *
 * The answer is derived, never mirrored: a stale fire can neither survive a
 * null deadline nor leak into a NEW deadline (only the deadline a fire was
 * armed for counts), and a wait longer than one setTimeout re-arms instead of
 * firing early.
 */
import { useEffect, useState } from 'react'

/** Longest delay one setTimeout accepts; a longer wait re-arms after this. */
const MAX_TIMEOUT_MS = 2_147_483_647

/**
 * Pure render answer. null = no deadline, so it is never reached even after an
 * earlier deadline fired; a fire only counts for the deadline it was armed for.
 */
export function deadlineFired(deadline: number | null, now: number, firedFor: number | null): boolean {
  return deadline !== null && (firedFor === deadline || now >= deadline)
}

export function useDeadline(deadline: number | null): boolean {
  const [firedFor, setFiredFor] = useState<number | null>(null)
  useEffect(() => {
    if (deadline === null || Date.now() >= deadline) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (): void => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        setFiredFor(deadline)
        return
      }
      timer = setTimeout(arm, Math.min(remaining, MAX_TIMEOUT_MS))
    }
    arm()
    return () => { if (timer !== undefined) clearTimeout(timer) }
  }, [deadline])
  return deadlineFired(deadline, Date.now(), firedFor)
}
