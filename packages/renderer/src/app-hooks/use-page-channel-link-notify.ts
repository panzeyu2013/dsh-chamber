/**
 * Page-channel link notifications: reference-diff the per-instance status map so one
 * instance's health push reconciles only that source (O(N×S) -> O(N) per push), and wake
 * the page channel for the local source only on a REAL local change (this effect also runs
 * when a remote status changed). Split out of App.tsx (B1-3h); refs and stores are inputs.
 */
import { useEffect } from 'react'
import type { createRemotesStore } from '../host/remotes-store.ts'
import { LOCAL_INSTANCE_ID } from '../local-instance.ts'
import { isServiceableLocalStatus, sourceIdForRawInstance } from '../transport-source.ts'

export interface PageChannelLinkNotifyInputs {
  notifiedStatusRef: { current: Record<string, unknown> }
  remotesStore: ReturnType<typeof createRemotesStore>
  pageChannelLinkListenersRef: { current: Set<(sourceId: string) => void> }
  remoteStatus: Record<string, unknown>
  health: { dsh?: { status?: string } } | null
  localReadyRef: { current: boolean }
  localLinkEpochRef: { current: number }
  localNotifiedEpochRef: { current: number }
}

export function usePageChannelLinkNotify(inputs: PageChannelLinkNotifyInputs): void {
  const {
    notifiedStatusRef, remotesStore, pageChannelLinkListenersRef, remoteStatus, health,
    localReadyRef, localLinkEpochRef, localNotifiedEpochRef,
  } = inputs
  useEffect(() => {
    const notify = (rawId: string): void => {
      const sourceId = rawId === LOCAL_INSTANCE_ID
        ? LOCAL_INSTANCE_ID
        : sourceIdForRawInstance(rawId, remotesStore.getSnapshot().instances)
      if (sourceId === null) return
      for (const listener of pageChannelLinkListenersRef.current) listener(sourceId)
    }
    const previous = notifiedStatusRef.current
    for (const [rawId, status] of Object.entries(remoteStatus)) {
      if (previous[rawId] === status) continue
      previous[rawId] = status
      notify(rawId)
    }
    for (const rawId of Object.keys(previous)) {
      if (!(rawId in remoteStatus)) delete previous[rawId]
    }
    if (health !== null) {
      // `degraded` still serves (design 02 §3.5): the predicate is the control-plane table.
      const localReady = isServiceableLocalStatus(health.dsh?.status)
      if (localReady && !localReadyRef.current) localLinkEpochRef.current += 1
      // Only a REAL local change wakes the page channel: this effect also runs when
      // a REMOTE status changed, and notifying the local source then would release
      // parked local subscriptions for no reason.
      const localChanged = localReady !== localReadyRef.current
        || localLinkEpochRef.current !== localNotifiedEpochRef.current
      localReadyRef.current = localReady
      localNotifiedEpochRef.current = localLinkEpochRef.current
      if (localChanged) notify(LOCAL_INSTANCE_ID)
    }
  }, [remoteStatus, health])
}
