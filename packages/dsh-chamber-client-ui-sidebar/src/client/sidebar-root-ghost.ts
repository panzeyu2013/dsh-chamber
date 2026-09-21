/**
 * The blank-row GHOST layout guard (extracted verbatim from SidebarRoot,
 * 2026-12 split): arm the projection ghost with the same local grace clock
 * and stop rendering it once the deadline passes.
 */

import { useEffect, useRef, useState } from 'react'
import { armBlankGhost, BLANK_GHOST_GRACE_MS } from '../shared/derive.ts'
import type { ChamberServerAggregate } from '../shared/aggregate-store.ts'

export function useSidebarGhost({ servers, chamberInstanceId }: {
  servers: readonly ChamberServerAggregate[]
  chamberInstanceId: string | undefined
}) {
  // chamber (design 06 §2.2): blank-row GHOST slot — the
  // local grace clock that bounds how long a departed blank "new session" row
  // keeps its (invisible) layout slot. The App's projection holds the ghost
  // for BLANK_GHOST_GRACE_MS (derive.ts armBlankGhost/sessionVisible) so the
  // list cannot shift inside the 350ms double-click window; this component
  // mirrors the same expiry and stops RENDERING the ghost when it passes —
  // the App may not re-derive for another poll cycle and the invisible
  // placeholder must not linger. A one-shot timer per arming bumps the tick
  // so the render re-evaluates the expiries (armings are rare: only a click
  // on a real session while a blank row is current).
  const ghostExpiry = useRef<Map<string, number>>(new Map())
  const ghostTimers = useRef<number[]>([])
  const [, setGhostTick] = useState(0)
  useEffect(() => {
    const timers = ghostTimers.current
    return () => { for (const timer of timers) window.clearTimeout(timer) }
  }, [])

  /**
   * chamber (design 06 §2.2): arm the blank-row GHOST
   * slot. Called SYNCHRONOUSLY in a session-row onClick BEFORE the open —
   * opening any real session moves the active source's current away from its
   * blank "new session" row (or a cross-source click switches the view, which
   * also un-currents it), and the App re-derives on the runtime-facts report
   * a moment later. The ghost keeps the departed blank row in the projection
   * for BLANK_GHOST_GRACE_MS, so the rows below never shift inside the
   * double-click window and the second click still lands on the target row.
   * The local expiry (ghostExpiry) bounds the RENDER side at the same
   * deadline; the one-shot timer closes the invisible gap even if the App
   * does not re-derive until the next poll cycle.
   */
  const armBlankGhostForClick = (): void => {
    // Only the ACTIVE source can currently hold a blank provisional row (the
    // App passes current only for the active view, 06 §4.3 single-selection).
    const active = servers.find(server => server.id === chamberInstanceId)
    if (active === undefined) return
    const current = active.runtime?.current
    if (current === undefined) return
    const isBlankCurrent = active.workspaces.some(workspace =>
      workspace.sessions.some(session => session.id === current && session.blank === true))
    if (!isBlankCurrent) return
    armBlankGhost(active.id, current)
    ghostExpiry.current.set(current, Date.now() + BLANK_GHOST_GRACE_MS)
    // The one-shot timer trims itself from the ref once it fires, so repeated
    // armings (rare, but each timer outlives the 450ms grace) cannot grow
    // ghostTimers unboundedly.
    const timerId = window.setTimeout(() => {
      setGhostTick(tick => tick + 1)
      const index = ghostTimers.current.indexOf(timerId)
      if (index >= 0) ghostTimers.current.splice(index, 1)
    }, BLANK_GHOST_GRACE_MS)
    ghostTimers.current.push(timerId)
  }
  return { ghostExpiry, armBlankGhostForClick }
}
