/**
 * Serving-gate phase mirror: waitForServing reads the ref, so the effect writes it once per
 * servers/remoteStatus change (never during render). Remote sources read the RAW transport
 * projection (same source as deferredBootIds): deriveServers publishes SOURCE_PHASE_UNKNOWN
 * for a missing projection, and folding that synthetic value into the gate would fast-judge a
 * delayed projection as 'not connected'. Local keeps its derived phase; undefined = fact not
 * here yet, the gate keeps waiting within its budget. Extracted from App.tsx (B1-3k).
 */
import { useEffect } from 'react'
import { LOCAL_INSTANCE_ID } from '../local-instance.ts'
import { servingGatePhase } from '../source-readiness.ts'
import { rawInstanceIdFromSourceId } from '../transport-source.ts'

export interface ServingGatePhasesInputs {
  servers: readonly { id: string; phase: string }[]
  remoteStatus: Record<string, unknown>
  serversPhaseRef: { current: Record<string, string | undefined> }
}

export function useServingGatePhases(inputs: ServingGatePhasesInputs): void {
  const { servers, remoteStatus, serversPhaseRef } = inputs
  useEffect(() => {
    const phases: Record<string, string | undefined> = {}
    for (const server of servers) {
      if (server.id === LOCAL_INSTANCE_ID) { phases[server.id] = server.phase; continue }
      const rawId = rawInstanceIdFromSourceId(server.id)
      // 纯函数决定语义：原始投影缺席 → undefined（等）；在场 → 派生相位（含托管折叠的终态词表）。
      phases[server.id] = rawId === null
        ? server.phase
        : servingGatePhase(server.phase, remoteStatus[rawId] !== undefined)
    }
    serversPhaseRef.current = phases
  }, [servers, remoteStatus])

}
