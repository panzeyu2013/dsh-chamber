/**
 * First-contact connection bootstrap (local only).
 *
 * Local: once the first connection row arrives (null = not fetched yet), a missing/stopped/error
 * local row triggers ONE idempotent POST /api/connections; a serviceable row (ready|degraded,
 * design 02 §3.5) marks it booted. A failed POST never sets the flag, so the next 30s poll retries.
 *
 * Remote rows are HOST-OWNED since the connection-intent move (v2 §P2-B, design 05 §3): the
 * sidecar reconciles its persisted roster after bindPlane + the ready frame (and again for
 * authoritative additions), so the page never auto-connects a remote instance. The page only
 * presents facts and sends explicit intents (connect/disconnect IPC); a manual disconnect is
 * remembered by the host for the rest of this app session. Removed ids need no cleanup here —
 * the retirement flow owns view teardown and the host owns re-add behavior.
 */
import { useEffect } from 'react'
import { api } from '../api.ts'
import { LOCAL_INSTANCE_ID } from '../local-instance.ts'
import { isServiceableLocalStatus } from '../transport-source.ts'
import type { ConnectionSummary } from '../api.ts'

export interface ConnectionBootstrapInputs {
  connections: ConnectionSummary[] | null
  localBootedRef: { current: boolean }
}

export function useConnectionBootstrap(inputs: ConnectionBootstrapInputs): void {
  const { connections, localBootedRef } = inputs
  useEffect(() => {
    if (connections === null) return
    if (localBootedRef.current) return
    const local = connections.find(c => c.connectionId === LOCAL_INSTANCE_ID && c.kind === 'local')
    // A serving local connection must never reach createLocal (design 02 §3.5).
    if (local !== undefined && isServiceableLocalStatus(local.status)) {
      localBootedRef.current = true
      return
    }
    void api.connections.createLocal().then(() => {
      localBootedRef.current = true
    }).catch(err => {
      console.error('[renderer] auto-start local failed (will retry on the next connections poll):', err)
    })
  }, [connections])
}
