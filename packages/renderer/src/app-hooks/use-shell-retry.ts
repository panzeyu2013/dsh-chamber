/**
 * Shell re-mount policy: the App's two "re-boot ONE instance shell after its source became
 * ready" paths, in one owner (App owns the state containers; this module owns the policy, its
 * bounds and the single re-mount sink call).
 *
 * ① degraded self-heal: a boot that settled with a RETRYABLE gap is re-mounted once per ready
 *    epoch. The DECISION stays in the lifecycle container (`degradedSelfHeal`, reached through
 *    dispatchLifecycle): this hook feeds it the same facts every pass and consumes its typed
 *    effect, so "who decided" and "who remembers" keep one owner.
 * ② graph return: a CLEAN boot that carried no graph never armed the live subscriber, so a host
 *    that GAINS the graph later needs one re-mount (the documented SSH seed flow). The truth
 *    table and both bounds live in graph-return.ts; this hook wires them to the shared channel
 *    recheck and to the same retry sink. It is the per-instance replacement for the retired
 *    window reload — neither path ever reloads the page.
 *
 * The dep arrays are the ones the effects had inside App (the containers and the setter are
 * App-owned/stable); nothing here is a second source of truth for either decision.
 */
import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import {
  recheckPluginGraphDiagnostic,
  type ChamberServerAggregate,
  type PluginGraphDiagnostic,
} from '@dsh-chamber/dsh-chamber-client-core'
import type { SourceEvent } from '@dsh-chamber/dsh-stream-state'
import { decideGraphReturn } from '../graph-return.ts'
import type { ShellState } from '../shell.ts'

/** Container dispatch (the App's `dispatchLifecycle`): only the returned effect's `e`
 *  discriminant (`degradedSelfHeal`) is read here, so the dependency needs no more. */
export type ShellRetryDispatch = (
  viewId: string,
  event: SourceEvent,
  capturedEpoch?: number,
) => { readonly e?: string } | undefined

export interface ShellRetryDeps {
  /** The servers projection: source id + phase (the only field read here). */
  servers: readonly ChamberServerAggregate[]
  /** Settled shell states per instance id. */
  shellStates: Readonly<Record<string, ShellState>>
  /** Plugin-diagnostic slots per source id (the graph-return evidence). */
  pluginDiagnostics: Readonly<Record<string, PluginGraphDiagnostic | undefined>>
  /** Container event dispatch; the degraded self-heal decision is its typed effect. */
  dispatchLifecycle: ShellRetryDispatch
  /** The App's single re-mount sink (InstanceView retry token). */
  setRetryTokens: Dispatch<SetStateAction<Record<string, number>>>
}

export function useShellRetry(deps: ShellRetryDeps): void {
  const { servers, shellStates, pluginDiagnostics, dispatchLifecycle, setRetryTokens } = deps

  useEffect(() => {
    // Feed the facts into the container BEFORE planning, so the self-heal mark has one owner. The
    // dispatch is idempotent (`bootSettled` spreads previous state; `phaseChanged` away from ready
    // drops the mark) and `isRetryableBootGap` stays the reducer's single retryability source.
    for (const server of servers) dispatchLifecycle(server.id, { kind: 'phaseChanged', phase: server.phase })
    for (const [instanceId, state] of Object.entries(shellStates)) {
      if (state.degraded === null) continue
      dispatchLifecycle(instanceId, {
        kind: 'bootSettled',
        outcome: 'degraded',
        gapKind: state.degraded.kind,
      })
    }
    // The re-boot list comes from the container's typed effect: "who decided" and "who remembers"
    // are one place, and the carry-forward is reproduced by dispatching the same facts every pass.
    const retry: string[] = []
    for (const [instanceId, state] of Object.entries(shellStates)) {
      if (state.degraded === null) continue
      const effect = dispatchLifecycle(instanceId, {
        kind: 'bootSettled',
        outcome: 'degraded',
        gapKind: state.degraded.kind,
      })
      if (effect?.e === 'degradedSelfHeal') retry.push(instanceId)
    }
    if (retry.length === 0) return
    console.warn(`[app] degraded shell(s) re-booting after the source became ready: ${retry.join(', ')}`)
    setRetryTokens(prev => {
      const next = { ...prev }
      for (const instanceId of retry) next[instanceId] = (next[instanceId] ?? 0) + 1
      return next
    })
  }, [servers, shellStates])

  /** Graph-return bounds: probed = one channel re-check per ready epoch (cleared on leaving
   *  ready); acted = the `ok` record already consumed by a re-boot (one re-mount per record). */
  const graphProbedRef = useRef(new Map<string, true>())
  const graphRebootActedRef = useRef(new Map<string, number>())

  useEffect(() => {
    // 退役来源的记号随此循环收敛（与其它每来源状态同款的剪枝纪律）。
    const live = new Set(servers.map(server => server.id))
    for (const sourceId of [...graphProbedRef.current.keys()]) {
      if (live.has(sourceId)) continue
      graphProbedRef.current.delete(sourceId)
      graphRebootActedRef.current.delete(sourceId)
    }
    const probes: string[] = []
    const reboots: string[] = []
    for (const server of servers) {
      // 每 ready 世代一次的记号：离开 ready 即清，所以一次重连/重启后可以再探一次。
      if (server.phase !== 'ready') { graphProbedRef.current.delete(server.id); continue }
      const diagnostic = pluginDiagnostics[server.id]
      const decision = decideGraphReturn({
        shell: shellStates[server.id],
        phase: server.phase,
        diagnostic,
        probedThisEpoch: graphProbedRef.current.has(server.id),
        actedUpdatedAt: graphRebootActedRef.current.get(server.id),
      })
      if (decision.kind === 'probe') {
        graphProbedRef.current.set(server.id, true)
        probes.push(server.id)
      } else if (decision.kind === 'reboot' && diagnostic !== undefined) {
        graphRebootActedRef.current.set(server.id, diagnostic.updatedAt)
        reboots.push(server.id)
      }
    }
    if (probes.length > 0) {
      console.warn(`[app] source(s) booted without the client plugin graph; re-checking the channel once: ${probes.join(', ')}`)
      for (const sourceId of probes) void recheckPluginGraphDiagnostic(sourceId)
    }
    if (reboots.length === 0) return
    console.warn(`[app] client plugin graph is now available; re-booting shell(s) that booted without it: ${reboots.join(', ')}`)
    setRetryTokens(prev => {
      const next = { ...prev }
      for (const instanceId of reboots) next[instanceId] = (next[instanceId] ?? 0) + 1
      return next
    })
  }, [servers, shellStates, pluginDiagnostics])
}
