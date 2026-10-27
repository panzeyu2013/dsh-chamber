/**
 * Read-only refresh commands: the connection rows, the host health probe, one
 * transport status projection and the synchronous roster invalidation.
 *
 * Extracted verbatim from App.tsx. Every dependency is an explicit input (the two
 * stores, the ownership registry, the live-id ref and the roster generation seq), so
 * the callbacks stay empty-dependency and identity-stable exactly as before.
 */
import { useCallback } from 'react'
import api from '../api.ts'
import { errorMessage } from '../status.ts'
import { sourceIdForRawInstance, sourceIdForTransport } from '../transport-source.ts'
import type { RosterGate } from '../host/roster-gate.ts'
import type { RemotesStore } from '../host/remotes-store.ts'
import type { SourceOwnershipRegistry } from '../deep-link-activation.ts'

export interface RemoteRefreshInputs {
  setConnections: (next: Awaited<ReturnType<typeof api.connections.list>>) => void
  setHealth: (next: Awaited<ReturnType<typeof api.host.health>>) => void
  setHealthError: (next: string | null) => void
  setHealthErrorAt: (value: number | null | ((previous: number | null) => number | null)) => void
  remotesStore: RemotesStore
  sourceLifecyclesRef: { current: SourceOwnershipRegistry | null }
  liveServerIdsRef: { current: Set<string> }
  rosterGate: RosterGate
  remoteRosterRefreshSeqRef: { current: number }
}

export function useRemoteRefresh(inputs: RemoteRefreshInputs) {
  const {
    setConnections, setHealth, setHealthError, setHealthErrorAt,
    remotesStore, sourceLifecyclesRef, liveServerIdsRef, rosterGate, remoteRosterRefreshSeqRef,
  } = inputs

  const refreshConnections = useCallback(async () => {
    try {
      setConnections(await api.connections.list())
    } catch {
      // 控制面不可达由页面通道的 health 推送与一次性 /health 回读呈现；连接行保持现状
    }
  }, [])

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api.host.health())
      setHealthError(null)
      setHealthErrorAt(null)
    } catch (err) { if (err instanceof Error && err.name === 'ControlPlaneBusyError') return
      setHealthError(errorMessage(err))
      setHealthErrorAt(prev => prev ?? Date.now())
    }
  }, [])

  const refreshRemoteStatus = useCallback(async (id: string, expectedSourceId?: string) => {
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined) return
    const sourceId = expectedSourceId ?? sourceIdForRawInstance(id, remotesStore.getSnapshot().instances)
    if (sourceId === null) return
    const sourceOwner = sourceLifecyclesRef.current!.capture(sourceId)
    if (sourceOwner === null) return
    try {
      const projection = await ssh.status(id)
      if (
        projection !== null
        && sourceIdForTransport(projection.kind, id) === sourceId
        && liveServerIdsRef.current.has(sourceId)
        && sourceLifecyclesRef.current!.owns(sourceOwner)
      ) {
        remotesStore.setStatus(prev => ({ ...prev, [id]: projection }))
      }
    } catch {
      // 状态读取失败时保持已有投影（权威状态来自 onStatusChanged 推送）
    }
  }, [])

  /** Invalidate the roster synchronously before an instances-changed refresh:
   * the gate opens a NEW generation, so an event-side push can never observe
   * the previous generation as settled (the store read is synchronous). */
  const invalidateRemoteRoster = useCallback(() => {
    remoteRosterRefreshSeqRef.current += 1
    rosterGate.invalidate()
  }, [rosterGate])
  return { refreshConnections, refreshHealth, refreshRemoteStatus, invalidateRemoteRoster }
}
