/**
 * Graph-return policy: the per-instance replacement for the retired window reload.
 *
 * A source can boot CLEANLY without a client plugin graph: `not-injected` is the legitimate
 * non-local shape (a remote dsh whose profile carries no chamber host packages, or
 * gateway/mobile). Such a shell never armed the live subscriber — shell.ts arms only on an
 * ANSWERED graph — and the graph is fetched only inside the boot, so when that host GAINS the
 * graph later (the documented SSH seed flow: seed the chamber host package, restart that dsh)
 * nothing re-fetches it. Before the retirement the seed restart armed a WINDOW reload for
 * exactly that flow; a per-instance re-mount is its narrower replacement.
 *
 * The App owns the wiring; the two bounded steps are decided here:
 *  - `probe`: on the ready transition ask the shared channel recheck once per ready epoch
 *    (`not-injected` is channel-class; the recheck writes only on a verdict STATE change, so a
 *    permanently graph-less source costs one unary per epoch and no store churn);
 *  - `reboot`: when the diagnostic turns `ok` while the settled shell still reports
 *    `graphAnswered === false`, re-boot that instance once per distinct `ok` record — the fresh
 *    boot fetches the graph, loads the extra rows and arms live sync.
 *
 * Bounds are structural: a re-boot that still finds no graph writes a fresh non-`ok` record (no
 * second fire), and an answered boot leaves `graphAnswered === true` (out of scope).
 */
import type { PluginGraphDiagnostic } from '@dsh-chamber/dsh-chamber-client-core'
import type { ShellState } from './shell.ts'

/** The settled-shell slice this policy reads (a Pick, so a field rename cannot drift). */
export type GraphReturnShellFacts = Pick<ShellState, 'booted' | 'error' | 'degraded' | 'graphAnswered'>

export interface GraphReturnFacts {
  /** The instance's settled shell state; undefined while no shell is registered. */
  shell: GraphReturnShellFacts | undefined
  /** Source phase from the servers projection (`ready` is the only probing phase). */
  phase: string | undefined
  /** The source's plugin-diagnostic slot. */
  diagnostic: PluginGraphDiagnostic | undefined
  /** A channel re-check already ran since the source last entered ready. */
  probedThisEpoch: boolean
  /** The `updatedAt` of the `ok` record a re-boot already consumed. */
  actedUpdatedAt: number | undefined
}

export type GraphReturnDecision =
  | { kind: 'none' }
  | { kind: 'probe' }
  | { kind: 'reboot' }

/** Decide the one graph-return action for one source (see the module header for the bounds). */
export function decideGraphReturn(facts: GraphReturnFacts): GraphReturnDecision {
  const { shell, diagnostic } = facts
  // Only a settled CLEAN boot that ATTEMPTED the graph and got nothing: a degraded boot belongs
  // to the degraded self-heal (one owner, isRetryableBootGap), and an answered boot armed its own
  // subscriber. Absent `graphAnswered` (safe mode / module-system failure) is never in scope.
  if (shell === undefined || shell.booted !== true || shell.error !== null
    || shell.degraded !== null || shell.graphAnswered !== false) return { kind: 'none' }
  // The graph answers now: re-boot once per distinct `ok` record.
  if (diagnostic?.state === 'ok') {
    return diagnostic.updatedAt === facts.actedUpdatedAt ? { kind: 'none' } : { kind: 'reboot' }
  }
  // Still `not-injected`: ask once per ready epoch whether the host has gained the graph. The
  // write-back drives the branch above on the next pass.
  if (diagnostic?.state === 'not-injected' && facts.phase === 'ready' && !facts.probedThisEpoch) {
    return { kind: 'probe' }
  }
  return { kind: 'none' }
}
