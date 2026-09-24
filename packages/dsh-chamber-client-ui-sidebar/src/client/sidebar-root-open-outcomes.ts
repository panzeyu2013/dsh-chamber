/** App-layer session-open outcomes rendered as per-row errors: bounded visibility
 *  and the early clear path (key/delete semantics in shared/open-outcome.ts). */

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { chamberBridge } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { openErrorKey, withoutOpenError } from '@dsh-chamber/dsh-chamber-client-core/open-outcome'

/** How long a failed session open stays visible as the row's inline error: the
 *  App-layer dispatch owns the failure, so the sidebar presents it bounded, and a
 *  later outcome for the same session clears it early. */
const OPEN_FAILURE_VISIBLE_MS = 10_000

export function useSidebarOpenOutcomes({ setRowErrors }: {
  setRowErrors: Dispatch<SetStateAction<Record<string, string>>>
}) {
  // The row-error key one open outcome reports into — ServerSection renders it in
  // the session row's action-error slot; key/delete semantics live in shared/open-outcome.ts.
  const openErrorTimers = useRef<Map<string, number>>(new Map())
  /** Drop one session's open-failure row error (early clear paths only). */
  const clearOpenRowError = useCallback((serverId: string, sessionId: string) => {
    const key = openErrorKey(serverId, sessionId)
    const timer = openErrorTimers.current.get(key)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      openErrorTimers.current.delete(key)
    }
    setRowErrors(prev => withoutOpenError(prev, key))
  }, [])
  // Every App-layer open outcome is reported back over the chamberBridge: each
  // sidebar shell renders the SAME aggregated rows, so once the target shell's tree
  // is mounted (an outcome can only settle after the shell that serves it mounted)
  // the failure shows on the very row clicked — a console-only report would leave it
  // invisible. Failures appear for OPEN_FAILURE_VISIBLE_MS; success (or a fresh click)
  // removes the error early. Outcomes settling before that mount are lost by design:
  // those edges (registry-guard, replacement failures, queue timeouts) surface elsewhere.
  useEffect(() => {
    const armExpiry = (key: string): void => {
      const previous = openErrorTimers.current.get(key)
      if (previous !== undefined) window.clearTimeout(previous)
      openErrorTimers.current.set(key, window.setTimeout(() => {
        openErrorTimers.current.delete(key)
        setRowErrors(prev => withoutOpenError(prev, key))
      }, OPEN_FAILURE_VISIBLE_MS))
    }
    const unsubscribe = chamberBridge.onOpenSessionOutcome(({ sourceId, sessionId, message }) => {
      const key = openErrorKey(sourceId, sessionId)
      if (message === undefined) {
        clearOpenRowError(sourceId, sessionId)
        return
      }
      setRowErrors(prev => (prev[key] === message ? prev : { ...prev, [key]: message }))
      armExpiry(key)
    })
    return () => {
      unsubscribe()
      for (const timer of openErrorTimers.current.values()) window.clearTimeout(timer)
      openErrorTimers.current.clear()
    }
  }, [clearOpenRowError])
  return { clearOpenRowError }
}
