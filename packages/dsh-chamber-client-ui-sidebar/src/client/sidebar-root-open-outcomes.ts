/**
 * App-layer session-open outcomes rendered as per-row errors: bounded
 * visibility and the early clear path (see shared/open-outcome.ts for the
 * key/delete semantics).
 */

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { chamberBridge } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { openErrorKey, withoutOpenError } from '@dsh-chamber/dsh-chamber-client-core/open-outcome'

/**
 * How long a failed session open stays visible as the row's inline error.
 * The App-layer dispatch owns the failure (it pays the whole polling budget
 * before reporting), so the sidebar only presents it — bounded, then gone.
 * A later outcome for the same session (a fresh request or a success) clears
 * it early.
 */
const OPEN_FAILURE_VISIBLE_MS = 10_000

export function useSidebarOpenOutcomes({ setRowErrors }: {
  setRowErrors: Dispatch<SetStateAction<Record<string, string>>>
}) {
  // chamber (打开失败可见性): the row-error key one failed/succeeded open
  // reports into — ServerSection renders it in the session row's action-error
  // slot. Key template and delete semantics live in shared/open-outcome.ts so
  // the writer and the reader can never drift.
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
  // chamber (打开失败可见性): every App-layer open outcome is reported back
  // over the chamberBridge. Each sidebar shell renders the SAME aggregated
  // rows, so once the target shell's tree is mounted (the open outcome can
  // only settle after the shell that serves it mounted — the dispatch budget
  // runs against its holder) the shell the user is looking at shows the
  // failure on the very row that was clicked; a console-only report would
  // leave every failure invisible while the user stares at the switched
  // view with nothing selected. Failures appear for OPEN_FAILURE_VISIBLE_MS;
  // success (or a fresh click, cleared in openSession) removes the error
  // early. Outcomes settling before the target tree mounts are lost by
  // design — those edges already surface elsewhere (registry-guard and
  // replacement failures name the source; queue timeouts land on the boot
  // failure overlay).
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
