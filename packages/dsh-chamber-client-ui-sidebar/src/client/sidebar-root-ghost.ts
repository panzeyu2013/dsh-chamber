/** Blank-row GHOST layout guard: arm the projection ghost with the same local grace
 *  clock and stop rendering it once the deadline passes. */

import { useEffect, useRef, useState } from 'react'
import { armBlankGhost, BLANK_GHOST_GRACE_MS } from '@dsh-chamber/dsh-chamber-client-core/derive'
import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'

export function useSidebarGhost({ servers, chamberInstanceId }: {
  servers: readonly ChamberServerAggregate[]
  chamberInstanceId: string | undefined
}) {
  // Blank-row GHOST slot (design 06 §2.2): the local grace clock that bounds how long
  // a departed blank "new session" row keeps its (invisible) layout slot. The App
  // holds the ghost for BLANK_GHOST_GRACE_MS so the list cannot shift inside the 350ms
  // double-click window; this component mirrors the same expiry and stops RENDERING it
  // when it passes — the App may not re-derive for another poll cycle, and the invisible
  // placeholder must not linger. A one-shot timer per arming bumps the tick; armings are rare.
  const ghostExpiry = useRef<Map<string, number>>(new Map())
  const ghostTimers = useRef<number[]>([])
  const [, setGhostTick] = useState(0)
  useEffect(() => {
    const timers = ghostTimers.current
    return () => { for (const timer of timers) window.clearTimeout(timer) }
  }, [])

  /**
   * Arm the blank-row GHOST slot, called SYNCHRONOUSLY in a session-row onClick
   * BEFORE the open: opening a real session moves `current` away from its blank row
   * (a cross-source click also un-currents it), and the ghost keeps the departed row
   * in the projection for BLANK_GHOST_GRACE_MS so the rows below never shift inside
   * the double-click window. The local expiry bounds the RENDER side at the same deadline.
   */
  const armBlankGhostForClick = (): void => {
    // Only the ACTIVE source can currently hold a blank provisional row (the App passes current only for the active view).
    const active = servers.find(server => server.id === chamberInstanceId)
    if (active === undefined) return
    const current = active.runtime?.current
    if (current === undefined) return
    const isBlankCurrent = active.workspaces.some(workspace =>
      workspace.sessions.some(session => session.id === current && session.blank === true))
    if (!isBlankCurrent) return
    armBlankGhost(active.id, current)
    ghostExpiry.current.set(current, Date.now() + BLANK_GHOST_GRACE_MS)
    // The one-shot timer trims itself from the ref once it fires, so repeated armings cannot grow ghostTimers unboundedly.
    const timerId = window.setTimeout(() => {
      setGhostTick(tick => tick + 1)
      const index = ghostTimers.current.indexOf(timerId)
      if (index >= 0) ghostTimers.current.splice(index, 1)
    }, BLANK_GHOST_GRACE_MS)
    ghostTimers.current.push(timerId)
  }
  return { ghostExpiry, armBlankGhostForClick }
}
