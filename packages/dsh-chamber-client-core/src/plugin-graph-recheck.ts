/**
 * Channel-class plugin-diagnostic self-heal recheck: when the LAST recorded
 * diagnostic is a CHANNEL fact (`not-injected` / `graph-unreachable`),
 * re-check the boot-graph channel and write the healed verdict back through
 * chamberBridge; BOOT facts (`bundle-load-failed`, `restart-required`,
 * `instance-version-conflict`) are never touched — only a boot changes them.
 * Writes only on a verdict STATE change (message-only drift → no ping-pong),
 * re-reads the store at write time (a fresher boot record is never clobbered),
 * and treats a 503 `instance_unavailable` as "cannot judge". Verdict
 * classification and the wire byte mirror the renderer boot fetch through the
 * shared `plugin-graph-classify.ts` / postUnary.
 */

import { chamberBridge } from './aggregate-store.ts'
import type { PluginGraphDiagnostic, PluginGraphDiagnosticState } from './aggregate-store.ts'
import { postUnary, type UnaryPostOutcome } from './wire-common.ts'
import {
  classifyPluginGraphOutcome, wrapGraphTransportFailure,
} from './plugin-graph-classify.ts'

/** Channel facts a recheck may heal; boot facts never. */
const CHANNEL_CLASS_STATES: ReadonlySet<PluginGraphDiagnosticState> = new Set(['not-injected', 'graph-unreachable'])

/** True only for the channel-class diagnostics (self-heal candidates); boot facts never. */
export function isChannelClassDiagnostic(state: PluginGraphDiagnosticState | undefined): boolean {
  return state !== undefined && CHANNEL_CLASS_STATES.has(state)
}

export type PluginGraphRecheckOutcome =
  /** The channel answers a valid graph → reported `ok` (heal). */
  | 'reported-ok'
  /** The channel answers 404 / unknown method → reported `not-injected`. */
  | 'reported-not-injected'
  /** The channel failed otherwise → reported `graph-unreachable`. */
  | 'reported-graph-unreachable'
  /** No write: state unchanged, record changed mid-flight, or 503 `instance_unavailable`. */
  | 'unchanged'
  /** No write: no recorded diagnostic, or it is not a channel-class state. */
  | 'skipped'

export interface PluginGraphRecheckDeps {
  /** Injectable seams; default to the ambient fetch, page origin, Date.now. */
  fetchImpl?: typeof fetch
  origin?: string
  now?: () => number
}

/**
 * Re-check one source's host boot-graph channel and write the verdict back
 * through chamberBridge when it differs from the recorded diagnostic (write
 * discipline in the header).
 *
 * @param sourceId - proxy source id (`local` | `<kind>-<id>`), the
 *   plugin-diagnostic store key.
 */
export async function recheckPluginGraphDiagnostic(
  sourceId: string,
  deps: PluginGraphRecheckDeps = {},
): Promise<PluginGraphRecheckOutcome> {
  const current = chamberBridge.getPluginDiagnostics()[sourceId]
  if (current === undefined || !isChannelClassDiagnostic(current.state)) return 'skipped'

  const now = deps.now ?? (() => Date.now())

  // Verdict write-back. Recency gate: the store is re-read at WRITE time (no
  // await between) so a boot record that landed mid-flight is never clobbered;
  // only a STATE change writes (a message-only drift would ping-pong).
  const report = (state: PluginGraphDiagnostic['state'], message?: string): PluginGraphRecheckOutcome => {
    const recorded = chamberBridge.getPluginDiagnostics()[sourceId]
    if (recorded === undefined
      || recorded.state !== current.state
      || recorded.message !== current.message
      || recorded.updatedAt !== current.updatedAt
      || recorded.pluginId !== current.pluginId) return 'unchanged'
    if (state === recorded.state) return 'unchanged'
    chamberBridge.reportPluginDiagnostic(sourceId, {
      state,
      message,
      updatedAt: now(),
      ...(recorded.pluginId === undefined ? {} : { pluginId: recorded.pluginId }),
    })
    return state === 'ok' ? 'reported-ok'
      : state === 'not-injected' ? 'reported-not-injected'
        : 'reported-graph-unreachable'
  }

  // Shared 30s bounded-unary transport byte (wire-common.ts postUnary); the kernel's
  // mintRpcId() falls back to an 'rpc-' id where crypto.randomUUID is absent (a bare
  // randomUUID() would throw → graph-unreachable).
  let outcome: UnaryPostOutcome
  try {
    outcome = await postUnary(`/api/i/${sourceId}`, 'clientGraph/graph', {}, {
      fetchImpl: deps.fetchImpl,
      origin: deps.origin,
    })
  } catch (error) {
    return report('graph-unreachable', wrapGraphTransportFailure(error))
  }

  // Single-source classification (plugin-graph-classify.ts): 503 → cannot judge (never
  // write); channel → the boot's state + message; malformed → graph-unreachable.
  const verdict = classifyPluginGraphOutcome(outcome)
  if (verdict.kind === 'instance-unavailable') return 'unchanged'
  if (verdict.kind === 'channel') return report(verdict.state, verdict.message)
  if (verdict.kind === 'malformed') return report('graph-unreachable', verdict.message)
  return report('ok')
}
