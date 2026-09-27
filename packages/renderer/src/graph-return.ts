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
 * WHY THE PROBE IS TIME-BOUNDED, NOT EPOCH-COUNTED: the ssh seed flow restarts the remote dsh
 * with `systemctl restart`, which does NOT flap the tunnel/transport phase (design 18 §3.6) —
 * the source stays `ready` across the whole restart. A probe counted per ready epoch would fire
 * once BEFORE the host had the graph and never again, so the graph would stay undiscovered. The
 * bounds are therefore:
 *  - `probe`: at most one channel re-check per {@link GRAPH_RETURN_PROBE_INTERVAL_MS} per source
 *    (the planner stamps the attempt, so a state-churn re-render cannot re-probe). One unary per
 *    minute per graph-less source sits inside the App's existing poll envelope; a permanently
 *    graph-less source costs exactly that and no store churn (the shared recheck writes only on a
 *    verdict STATE change).
 *  - `reboot`: when the diagnostic turns `ok` while the settled shell still reports
 *    `graphAnswered === false`, re-boot that instance once per distinct `ok` record — the fresh
 *    boot fetches the graph, loads the extra rows and arms live sync.
 * Bounds are structural: a re-boot that still finds no graph writes a fresh non-`ok` record (no
 * second fire), and an answered boot leaves `graphAnswered === true` (out of scope).
 */
import type { PluginGraphDiagnostic } from '@dsh-chamber/dsh-chamber-client-core'
import type { ShellState } from './shell.ts'

/** Minimum spacing between two channel re-checks of one graph-less source. */
export const GRAPH_RETURN_PROBE_INTERVAL_MS = 60_000

/** The settled-shell slice this policy reads (a Pick, so a field rename cannot drift). */
export type GraphReturnShellFacts = Pick<ShellState, 'booted' | 'error' | 'degraded' | 'graphAnswered'>

export interface GraphReturnFacts {
  /** The instance's settled shell state; undefined while no shell is registered. */
  shell: GraphReturnShellFacts | undefined
  /** Source phase from the servers projection (`ready` is the only probing phase). */
  phase: string | undefined
  /** The source's plugin-diagnostic slot. */
  diagnostic: PluginGraphDiagnostic | undefined
  /** Now (ms); the probe bound is measured against {@link lastProbeAt}. */
  nowMs: number
  /** When this source's last channel re-check fired (undefined = never). */
  lastProbeAt: number | undefined
  /** The `updatedAt` of the `ok` record a re-boot already consumed (undefined = none). */
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
  // A channel-class record (`not-injected`, or a recheck that ran while the host was down and
  // wrote `graph-unreachable`): ask again, at most once per interval.
  const probeable = diagnostic?.state === 'not-injected' || diagnostic?.state === 'graph-unreachable'
  if (probeable && facts.phase === 'ready'
    && (facts.lastProbeAt === undefined || facts.nowMs - facts.lastProbeAt >= GRAPH_RETURN_PROBE_INTERVAL_MS)) {
    return { kind: 'probe' }
  }
  return { kind: 'none' }
}

/** One pass over every source: the App's inputs plus the two per-source marks. */
export interface GraphReturnPassFacts {
  servers: readonly { id: string; phase: string | undefined }[]
  shells: Readonly<Record<string, GraphReturnShellFacts | undefined>>
  diagnostics: Readonly<Record<string, PluginGraphDiagnostic | undefined>>
  /** When each source's last probe fired. */
  probedAt: ReadonlyMap<string, number>
  /** The `ok` record each source's last re-boot consumed. */
  acted: ReadonlyMap<string, number>
  nowMs: number
}

export interface GraphReturnPass {
  /** Sources to re-check now (their probe mark is already stamped in {@link probedAt}). */
  probes: readonly string[]
  /** Sources to re-mount now (their mark is already stamped in {@link acted}). */
  reboots: readonly { id: string; updatedAt: number }[]
  probedAt: Map<string, number>
  acted: Map<string, number>
}

/**
 * Plan one graph-return pass. The marks are stamped HERE, in the same branch that decides the
 * action, so no caller can set a mark without performing (or vice versa) — and both marks are
 * pruned against the live source set, which is why they converge on retirement even when a source
 * leaves ready before it retires (an `acted` entry can outlive its probe mark).
 */
export function planGraphReturn(facts: GraphReturnPassFacts): GraphReturnPass {
  const live = new Set(facts.servers.map(server => server.id))
  const probedAt = new Map(facts.probedAt)
  const acted = new Map(facts.acted)
  for (const sourceId of new Set([...probedAt.keys(), ...acted.keys()])) {
    if (live.has(sourceId)) continue
    probedAt.delete(sourceId)
    acted.delete(sourceId)
  }
  const probes: string[] = []
  const reboots: { id: string; updatedAt: number }[] = []
  for (const server of facts.servers) {
    const diagnostic = facts.diagnostics[server.id]
    const decision = decideGraphReturn({
      shell: facts.shells[server.id],
      phase: server.phase,
      diagnostic,
      nowMs: facts.nowMs,
      lastProbeAt: probedAt.get(server.id),
      actedUpdatedAt: acted.get(server.id),
    })
    if (decision.kind === 'probe') {
      probedAt.set(server.id, facts.nowMs)
      probes.push(server.id)
    } else if (decision.kind === 'reboot' && diagnostic !== undefined) {
      acted.set(server.id, diagnostic.updatedAt)
      reboots.push({ id: server.id, updatedAt: diagnostic.updatedAt })
    }
  }
  return { probes, reboots, probedAt, acted }
}
