/**
 * Roster-gated notification-open replay: notification clicks can be released before the
 * initial remote roster arrives, like deep-link activation. Once authority settles the
 * full payloads are replayed; a removed source is loud-dropped (ACK, never a ghost open).
 * Extracted verbatim from App.tsx (B1-3d); every dependency is an explicit input.
 */
import { useEffect } from 'react'
import { classifyRosterGatedSource, type RendererDeliveryCoordinates } from '../deep-link-activation.ts'

/** The pending open: identity coordinates plus the source generation it was released for. */
export type NotificationOpenDelivery = RendererDeliveryCoordinates & {
  sourceId: string
  sourceFingerprint: string
  sessionId: string
}

export interface NotificationOpenReplayInputs {
  rosterGate: { isSettled(): boolean }
  pendingRosterNotificationOpensRef: { current: NotificationOpenDelivery[] }
  liveServerIdsRef: { current: ReadonlySet<string> }
  acknowledgeNotificationOpen: (open: NotificationOpenDelivery) => Promise<void>
  enqueueNotificationOpen: (open: NotificationOpenDelivery, phase: 'held') => void
  reportNotificationAckFailure: (open: NotificationOpenDelivery, error: unknown) => void
  roster: unknown
  liveServerIds: unknown
}

export function useNotificationOpenReplay(inputs: NotificationOpenReplayInputs): void {
  const {
    rosterGate, pendingRosterNotificationOpensRef, liveServerIdsRef, acknowledgeNotificationOpen,
    enqueueNotificationOpen, reportNotificationAckFailure, roster, liveServerIds,
  } = inputs
  useEffect(() => {
    if (
      !rosterGate.isSettled()
      || pendingRosterNotificationOpensRef.current.length === 0
    ) return
    const pending = pendingRosterNotificationOpensRef.current
    pendingRosterNotificationOpensRef.current = []
    for (const open of pending) {
      const classification = classifyRosterGatedSource(open.sourceId, true, liveServerIdsRef.current)
      if (classification === 'missing') {
        console.warn(`[notifications] pending source is no longer in the authoritative roster: ${open.sourceId}`)
        void acknowledgeNotificationOpen(open).catch(error => {
          reportNotificationAckFailure(open, error)
        })
        continue
      }
      void enqueueNotificationOpen(open, 'held')
    }
  }, [
    roster,
    liveServerIds,
    acknowledgeNotificationOpen,
    enqueueNotificationOpen,
    reportNotificationAckFailure,
  ])
}
