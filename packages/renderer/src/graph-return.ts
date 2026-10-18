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
 * A re-boot can itself be deferred by the page budget and write no fresh diagnostic, so its
 * bound is TIME-based (at most one per GRAPH_RETURN_REBOOT_RETRY_MS) and capped per pass
 * (GRAPH_RETURN_REBOOT_PER_PASS); an answered boot leaves graphAnswered === true (out of scope).
 */
import type { PluginGraphDiagnostic } from '@dsh-chamber/dsh-chamber-client-core'
import type { ShellState } from './shell.ts'

/** Minimum spacing between two channel re-checks of one graph-less source. */
export const GRAPH_RETURN_PROBE_INTERVAL_MS = 60_000

/** Base spacing between two re-boots of one still-graphless source. The window
 *  doubles per consecutive re-boot (see {@link rebootRetryWindowMs}): a sticky
 *  source that never arms must not re-mount its whole shell every 60s forever. */
export const GRAPH_RETURN_REBOOT_RETRY_MS = 60_000

/** Attempt cap in the exponential window (60s, 120s, 240s, 480s, then 480s). */
export const GRAPH_RETURN_REBOOT_BACKOFF_MAX = 3

/** One source's re-boot ledger entry. */
export interface GraphRebootMark {
  /** When the last re-boot fired (ms). */
  readonly at: number
  /** Consecutive re-boots fired without the graph answering again. */
  readonly attempts: number
}

/** Spacing before the next re-boot after `attempts` consecutive ones. */
export function rebootRetryWindowMs(attempts: number): number {
  const exponent = Math.min(Math.max(0, Math.trunc(attempts)), GRAPH_RETURN_REBOOT_BACKOFF_MAX)
  return GRAPH_RETURN_REBOOT_RETRY_MS * 2 ** exponent
}

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
  /** This source's re-boot ledger entry (undefined = never re-booted). */
  reboot: GraphRebootMark | undefined
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
  // The graph answers now: re-boot at most once per retry window (a boot that
  // itself gets budget-deferred writes no fresh diagnostic, so a per-record bound
  // would latch the source graphless forever).
  if (diagnostic?.state === 'ok') {
    if (facts.phase !== 'ready') return { kind: 'none' }
    return facts.reboot !== undefined
      && facts.nowMs - facts.reboot.at < rebootRetryWindowMs(facts.reboot.attempts)
      ? { kind: 'none' }
      : { kind: 'reboot' }
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
/** Per-pass global probe quota: one pass may not fan out a unary per graphless
 *  source (design 26 extension — the same-origin pool is shared). Deferred
 *  sources keep their due state and are picked by the next pass (state-driven
 *  passes make the rotation immediate; the 60s gate still bounds each source). */
export const GRAPH_RETURN_PROBE_PER_PASS = 2

/** Per-pass global re-boot quota (many simultaneous ok transitions must not
 *  re-mount the whole fleet into the same saturated page budget). */
export const GRAPH_RETURN_REBOOT_PER_PASS = 2

export interface GraphReturnPassFacts {
  servers: readonly { id: string; phase: string | undefined }[]
  shells: Readonly<Record<string, GraphReturnShellFacts | undefined>>
  diagnostics: Readonly<Record<string, PluginGraphDiagnostic | undefined>>
  /** When each source's last probe fired. */
  probedAt: ReadonlyMap<string, number>
  /** Per-source re-boot ledger entries. */
  acted: ReadonlyMap<string, GraphRebootMark>
  nowMs: number
}

export interface GraphReturnPass {
  /** Sources to re-check now (their probe mark is already stamped in {@link probedAt}). */
  probes: readonly string[]
  /** Sources to re-mount now (their mark is already stamped in {@link acted}). */
  reboots: readonly { id: string }[]
  probedAt: Map<string, number>
  acted: Map<string, GraphRebootMark>
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
  const reboots: { id: string }[] = []
  const rebootCandidates: { id: string; updatedAt: number; mark: GraphRebootMark | undefined }[] = []
  const due: { id: string; lastProbeAt: number }[] = []
  for (const server of facts.servers) {
    const diagnostic = facts.diagnostics[server.id]
    const decision = decideGraphReturn({
      shell: facts.shells[server.id],
      phase: server.phase,
      diagnostic,
      nowMs: facts.nowMs,
      lastProbeAt: probedAt.get(server.id),
      reboot: acted.get(server.id),
    })
    // Reset the attempt counter only when the graph actually ANSWERED (the shell
    // left scope) or the source retired: a re-boot's own boot writes a fresh
    // non-ok record, so resetting on "not ok" made the exponential window
    // unreachable (attempts stuck at 1, every 60s).
    const shell = facts.shells[server.id]
    if (shell !== undefined && shell.graphAnswered !== false) acted.delete(server.id)
    if (decision.kind === 'probe') {
      due.push({ id: server.id, lastProbeAt: probedAt.get(server.id) ?? Number.NEGATIVE_INFINITY })
    } else if (decision.kind === 'reboot' && diagnostic !== undefined) {
      rebootCandidates.push({ id: server.id, updatedAt: diagnostic.updatedAt, mark: acted.get(server.id) })
    }
  }
  // Rotation by recency: the 60s interval equals the timer cadence, so a stable
  // head order would re-claim the quota every pass and starve the tail (review
  // M3/M4). Oldest due first; never-probed sources count as oldest.
  due.sort((left, right) => (
    left.lastProbeAt < right.lastProbeAt ? -1 : left.lastProbeAt > right.lastProbeAt ? 1 : 0
  ))
  for (const entry of due.slice(0, GRAPH_RETURN_PROBE_PER_PASS)) {
    probedAt.set(entry.id, facts.nowMs)
    probes.push(entry.id)
  }
  // Re-boots are capped per pass too: many simultaneous ok transitions must not
  // re-mount the whole fleet into the same saturated page budget. Deferred
  // candidates stay unstamped and the next pass picks them; the time bound holds.
  // Same recency rotation as probes: a persistent head must not claim the quota
  // every pass while the tail never re-boots.
  rebootCandidates.sort((left, right) => {
    const leftAt = left.mark?.at ?? Number.NEGATIVE_INFINITY
    const rightAt = right.mark?.at ?? Number.NEGATIVE_INFINITY
    return leftAt < rightAt ? -1 : leftAt > rightAt ? 1 : 0
  })
  for (const entry of rebootCandidates.slice(0, GRAPH_RETURN_REBOOT_PER_PASS)) {
    acted.set(entry.id, { at: facts.nowMs, attempts: (entry.mark?.attempts ?? 0) + 1 })
    reboots.push({ id: entry.id })
  }
  return { probes, reboots, probedAt, acted }
}
