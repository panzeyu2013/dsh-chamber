/**
 * Shell re-mount policy: the App's two "re-boot ONE instance shell after its source became
 * ready" paths, in one owner (App owns the state containers; this module owns the policy, its
 * bounds and the single re-mount sink call).
 *
 * ① degraded self-heal: a boot that settled with a RETRYABLE gap is re-mounted once per ready
 *    epoch. The DECISION stays in the lifecycle container (`degradedSelfHeal`); the effect is
 *    ONE-SHOT (the reduction that emits it also sets `degradedRetried`, source.ts bootSettled),
 *    so it is read from the very dispatch that produces it — re-dispatching the same fact returns
 *    no effect and silently loses the self-heal.
 * ② graph return: a CLEAN boot that carried no graph never armed the live subscriber, so a host
 *    that GAINS the graph later needs one re-mount (the documented SSH seed flow). The truth
 *    table, the marks and both bounds live in graph-return.ts; the probe is TIME-bounded (an ssh
 *    `systemctl restart` does not flap the source phase), so this hook also runs the cadence
 *    independently of unrelated state churn. It is the per-instance replacement for the retired
 *    window reload — neither path ever reloads the page.
 *
 * The dep arrays are the ones the effects had inside App (the containers and the setter are
 * App-owned/stable); nothing here is a second source of truth for either decision.
 */
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import {
  recheckPluginGraphDiagnostic,
  type ChamberServerAggregate,
  type PluginGraphDiagnostic,
} from '@dsh-chamber/dsh-chamber-client-core'
import { GRAPH_RETURN_PROBE_INTERVAL_MS, planGraphReturn } from '../graph-return.ts'
import { planDegradedSelfHeal, type ShellRetryDispatch } from '../source-readiness.ts'
import type { ShellState } from '../shell.ts'

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
    // The feed (and the container's one-shot effect read) lives in the purely testable
    // planDegradedSelfHeal: this effect only supplies the facts and the sink.
    const retry = planDegradedSelfHeal({ servers, shellStates, dispatch: dispatchLifecycle })
    if (retry.length === 0) return
    console.warn(`[app] degraded shell(s) re-booting after the source became ready: ${retry.join(', ')}`)
    setRetryTokens(prev => {
      const next = { ...prev }
      for (const instanceId of retry) next[instanceId] = (next[instanceId] ?? 0) + 1
      return next
    })
  }, [servers, shellStates])

  /** Graph-return marks (graph-return.ts owns their semantics): when each source last probed and
   *  the `ok` record each last consumed. Both are pruned against the live source set per pass. */
  const graphProbedAtRef = useRef(new Map<string, number>())
  const graphRebootActedRef = useRef(new Map<string, number>())
  /** Render mirror: the interval callback below must read the LATEST inputs without re-arming. */
  const latestRef = useRef({ servers, shellStates, pluginDiagnostics })
  latestRef.current = { servers, shellStates, pluginDiagnostics }

  const graphReturnPass = useCallback((): void => {
    const plan = planGraphReturn({
      servers: latestRef.current.servers,
      shells: latestRef.current.shellStates,
      diagnostics: latestRef.current.pluginDiagnostics,
      probedAt: graphProbedAtRef.current,
      acted: graphRebootActedRef.current,
      nowMs: Date.now(),
    })
    graphProbedAtRef.current = plan.probedAt
    graphRebootActedRef.current = plan.acted
    if (plan.probes.length > 0) {
      console.warn(`[app] source(s) booted without the client plugin graph; re-checking the channel: ${plan.probes.join(', ')}`)
      for (const sourceId of plan.probes) void recheckPluginGraphDiagnostic(sourceId)
    }
    if (plan.reboots.length === 0) return
    console.warn(`[app] client plugin graph is now available; re-booting shell(s) that booted without it: ${plan.reboots.map(r => r.id).join(', ')}`)
    setRetryTokens(prev => {
      const next = { ...prev }
      for (const { id } of plan.reboots) next[id] = (next[id] ?? 0) + 1
      return next
    })
  }, [setRetryTokens])

  // (1) State-driven: react at once to the graph turning `ok` and to newly settled shells.
  useEffect(() => { graphReturnPass() }, [graphReturnPass, servers, shellStates, pluginDiagnostics])
  // (2) Time-driven: the probe cadence, independent of unrelated state churn (the ssh restart
  //     keeps the phase `ready`, so nothing else would re-run this policy afterwards). The
  //     planner's interval gate keeps this to at most one unary per source per interval.
  useEffect(() => {
    const timer = setInterval(graphReturnPass, GRAPH_RETURN_PROBE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [graphReturnPass])
}
