/**
 * First authoritative roster acquisition: retry transient IPC failures on a short bounded
 * cadence. Exhaustion keeps the one pending activation held, with the 30s registry poll as
 * the long-tail recovery. Split out of App.tsx (B1-3f); every input is explicit.
 */
import { useEffect } from 'react'
import { REMOTE_ROSTER_RETRY_LIMIT, REMOTE_ROSTER_RETRY_MS } from '../host/budgets.ts'

export interface RosterAcquisitionInputs {
  sshBridgeReady: boolean
  rosterGate: { isListenerReady(): boolean; isSettled(): boolean }
  refreshRemotes: () => Promise<boolean>
  /** Only an effect-dependency: a new roster generation re-arms the attempt chain. */
  roster: unknown
}

export function useRosterAcquisition(inputs: RosterAcquisitionInputs): void {
  const { sshBridgeReady, rosterGate, refreshRemotes, roster } = inputs
  /** First authoritative roster acquisition: retry transient IPC failures on a short bounded cadence;
   *  exhaustion keeps the one pending activation held, with the 30s registry poll as long-tail recovery. */
  useEffect(() => {
    if (
      !sshBridgeReady
      || !rosterGate.isListenerReady()
      || rosterGate.isSettled()
    ) return
    let cancelled = false
    let attempts = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const attempt = (): void => {
      attempts += 1
      void refreshRemotes().then((settled) => {
        if (cancelled || settled) return
        if (attempts >= REMOTE_ROSTER_RETRY_LIMIT) {
          console.error('[renderer] remote instances roster unavailable; pending deep-link activation remains held')
          return
        }
        retryTimer = setTimeout(attempt, REMOTE_ROSTER_RETRY_MS)
      })
    }
    attempt()
    return () => {
      cancelled = true
      if (retryTimer !== null) clearTimeout(retryTimer)
    }
  }, [sshBridgeReady, roster, refreshRemotes])
}
