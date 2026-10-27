/**
 * Link-health helpers: probe budget/endpoint derivation, the link-health reducer
 * application, the two ready-verify/grace cancellers and the probe budget cap.
 * Split out of transport-manager.ts (B2-2a). Every function operates on the passed
 * InstanceState; the module owns no state and no timers of its own — the three
 * effects it needs arrive through deps.
 */
import { reduceLinkHealth, type LinkHealthReduction, type LinkPolicy } from './transport-health.ts'
import {
  type TransportInstanceSpec, type TransportProbeEndpoint, type TransportProvider,
} from './transport-provider.ts'
import { describeError as describeTransportError } from './describe-error.ts'
import type { InstanceState } from './transport-instance-state.ts'

export interface LinkHealthDeps {
  linkPolicy: LinkPolicy
  emitStatus: (id: string, expectedState?: InstanceState) => void
  appendLogInternal: (state: InstanceState, level: 'info' | 'warn' | 'error', message: string) => void
  warn: (message: string) => void
}

export function createLinkHealth(deps: LinkHealthDeps) {
  const { linkPolicy, emitStatus, appendLogInternal, warn } = deps
  function readyProbeEndpoint(
    spec: TransportInstanceSpec,
    providerForSpec: TransportProvider,
    state: InstanceState,
  ): TransportProbeEndpoint | null {
    if (providerForSpec.buildStartArgs !== undefined) {
      // Tunnel mode: the probe rides the live tunnel listener (loopback).
      return state.localPort === null ? null : { host: '127.0.0.1', port: state.localPort }
    }
    try {
      return providerForSpec.probeTarget?.(spec) ?? { host: spec.host, port: spec.remotePort }
    } catch {
      // A throwing probeTarget has no probeable endpoint — skip the probe.
      return null
    }
  }

  /** Publish one link-health transition; probe timestamps alone do not wake the renderer. */
  function applyLinkHealth(
    id: string,
    state: InstanceState,
    event: Parameters<typeof reduceLinkHealth>[1],
  ): LinkHealthReduction {
    const before = state.link
    const reduction = reduceLinkHealth(before, event, linkPolicy)
    state.link = reduction.state
    // A down->healthy recovery is a new usable link generation and must wake the
    // page channel. A suspect->healthy recovery never left ready and is deliberately
    // health-only: bumping linkEpoch here would invalidate the 30s stability window
    // on every probe flap.
    if (reduction.becameHealthy && before.health !== 'suspect') state.linkEpoch += 1
    // Leaving `down` cancels the pending confirmation window: a later down edge
    // must start a FRESH one instead of inheriting the old deadline.
    if (before.health === 'down' && reduction.state.health !== 'down') clearDownGrace(state)
    const changed = before.health !== reduction.state.health
      || before.reason !== reduction.state.reason
    // Every real transition opens (or extends) the watch window: the next heartbeat
    // uses the tight cadence, so a link that just flapped is re-sampled in ~10s
    // instead of waiting out the stable 30s beat.
    if (changed) state.lastLinkEventAt = Date.now()
    if (changed) {
      appendLogInternal(state, reduction.becameDown ? 'warn' : 'info',
        `link ${before.health} → ${reduction.state.health}`
        + (reduction.state.reason === null ? '' : ` (${reduction.state.reason})`))
      emitStatus(id, state)
    }
    return reduction
  }

  /** Cancel one instance's pending ready-state re-verification timer. */
  function cancelReadyVerify(state: InstanceState): void {
    if (state.readyProbeTimer !== null) {
      clearTimeout(state.readyProbeTimer)
      state.readyProbeTimer = null
    }
    // The quiet window belongs to ONE ready incarnation: a verification completed
    // right before leaving ready must not suppress the next generation's first
    // user reverify (the reconnect's connect-time check is not one).
    state.lastVerifyAt = 0
  }

  /** Clear the down->reconnect grace. */
  function clearDownGrace(state: InstanceState): void {
    state.downGraceDeadlineAt = 0
    if (state.downGraceTimer === null) return
    clearTimeout(state.downGraceTimer)
    state.downGraceTimer = null
  }

  /** The budget one ready-state probe needs: the provider's declared composite
   *  budget, else the single-exchange default. */
  function probeBudgetFor(spec: TransportInstanceSpec, providerForSpec: TransportProvider): number {
    try {
      const declared = typeof providerForSpec.verifyUpBudgetMs === 'function'
        ? providerForSpec.verifyUpBudgetMs(spec)
        : providerForSpec.verifyUpBudgetMs
      return typeof declared === 'number' && Number.isFinite(declared) && declared > 0
        ? declared
        : linkPolicy.probeTimeoutMs
    } catch (error) {
      // A provider-declared budget is an optimization, never a reason to skip the
      // grace: a throwing declaration falls back to the table value.
      warn(`transport-manager: verifyUpBudgetMs threw for ${spec.id}; using the table fallback: ${describeTransportError(error)}`)
      return linkPolicy.probeTimeoutMs
    }
  }

  /** Keep phase ready (and in-flight work alive) for a bounded grace after down.
   *  EVERY down edge restarts the window (a link that recovered to `suspect` and
   *  fell back to down got its first window cut short otherwise). New requests and
   *  new subscriptions fail fast via the projection; the transport reconnect only
   *  takes ownership when the window expires. An in-flight probe may extend the
   *  timer, but never past `downGraceDeadlineAt`. */

  return { readyProbeEndpoint, applyLinkHealth, cancelReadyVerify, clearDownGrace, probeBudgetFor }
}
