import { useEffect } from 'react'
import {
  deliveryMatchesCurrentSource, settlePendingDeepLinkActivation,
  type RendererDeliveryCoordinates, type SourceOwnershipRegistry,
} from '../deep-link-activation.ts'
import { sourceIdForRawInstance } from '../transport-source.ts'

/** The pending cold-start activation: raw id retained until the authoritative roster
 *  resolves the canonical source id + its lifecycle proof. */
export type PendingDeepLinkDelivery = RendererDeliveryCoordinates & {
  rawInstanceId: string
  sourceId: string | null
  sourceFingerprint: string
}

export interface DeepLinkDeliveryInputs {
  rosterGate: { isSettled(): boolean }
  pendingDeepLinkDeliveryRef: { current: PendingDeepLinkDelivery | null }
  remotesStore: { getSnapshot(): { instances: readonly Parameters<typeof sourceIdForRawInstance>[1][number][] } }
  liveServerIdsRef: { current: ReadonlySet<string> }
  sourceLifecyclesRef: { current: SourceOwnershipRegistry | null }
  selectView: (viewId: string) => boolean
  acknowledgeDeepLink: (pending: PendingDeepLinkDelivery) => Promise<void>
  reportDeepLinkAckFailure: (pending: PendingDeepLinkDelivery, error: unknown) => void
  roster: unknown
  liveServerIds: unknown
}
export function useDeepLinkDelivery(inputs: DeepLinkDeliveryInputs): void {
  const {
    rosterGate, pendingDeepLinkDeliveryRef, remotesStore, liveServerIdsRef, sourceLifecyclesRef,
    selectView, acknowledgeDeepLink, reportDeepLinkAckFailure, roster, liveServerIds,
  } = inputs
  /** Replay the one cold-start remote activation only after the first authoritative instances_get
   *  committed the same roster generation. A missing target is an authoritative removal, so it is
   *  dropped instead of bypassing selectView's zombie-view guard. */
  useEffect(() => {
    // The state schedules this passive effect; the imperative ref is the final authority check. An
    // instances-changed event can invalidate the roster after commit but before this effect flushes,
    // in which case the intent must remain held for the replacement generation.
    if (!rosterGate.isSettled()) return
    const pending = pendingDeepLinkDeliveryRef.current
    if (pending === null) return
    const sourceId = pending.sourceId
      ?? sourceIdForRawInstance(pending.rawInstanceId, remotesStore.getSnapshot().instances)
    if (sourceId === null) {
      pendingDeepLinkDeliveryRef.current = null
      console.warn(`[renderer] deep-link raw source is absent from the authoritative roster: ${pending.rawInstanceId}`)
      void acknowledgeDeepLink(pending).catch(error => {
        reportDeepLinkAckFailure(pending, error)
      })
      return
    }
    const decision = settlePendingDeepLinkActivation(
      sourceId,
      liveServerIdsRef.current,
    )
    pendingDeepLinkDeliveryRef.current = null
    if (decision.discarded?.reason === 'missing') {
      console.warn(`[renderer] deep-link source is no longer in the authoritative roster: ${decision.discarded.sourceId}`)
    }
    if (decision.activateSourceId !== null) {
      if (deliveryMatchesCurrentSource(
        sourceLifecyclesRef.current!,
        sourceId,
        pending.sourceFingerprint,
      )) {
        selectView(decision.activateSourceId)
      } else {
        console.warn(`[renderer] ignored stale deep-link source proof: ${sourceId}`)
      }
    }
    void acknowledgeDeepLink(pending).catch(error => {
      reportDeepLinkAckFailure(pending, error)
    })
  }, [
    roster,
    liveServerIds,
    acknowledgeDeepLink,
    reportDeepLinkAckFailure,
  ])

}
