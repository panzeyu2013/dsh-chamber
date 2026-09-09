/**
 * Per-source purged-row suppression tracker (design 24 §21) — the STATEFUL
 * half of the producer's F1, extracted from `client/index.ts` so it is
 * node-testable (the producer file imports React/CSS and cannot be imported
 * by a node test, which is how two rounds of wiring defects escaped review).
 *
 * It owns exactly three facts per source ctx:
 *   - the last AUTHORITATIVE archive set observed (`archivedSeen`),
 *   - the raw store array identity of that observation (`rawSeen`, the
 *     per-push cost short-circuit: the official workspace model installs a
 *     new array only when the set content changes),
 *   - the tombstone set of ids that left the archive set and whose rows may
 *     still linger in the official summaries (`purged`).
 * and delegates verification to `purged-convergence.ts`.
 */
import {
  filterPurgedRows,
  lingeringPurgedIds,
  reconcilePurgedRows,
  trackArchiveSetShrink,
} from './purged-rows.ts'
import { createPurgedConvergence, type PurgedConvergenceChain } from './purged-convergence.ts'

/** Injectable seams (the producer passes the real ones; tests pass fakes). */
export interface PurgeTrackerDeps {
  /** Official refresh in METHOD-CALL form (see purged-convergence.ts). */
  refresh: () => Promise<unknown> | undefined
  /** Ids the official summaries currently list (`ctx.sessions.list.byId` keys). */
  listedSummaryIds: () => ReadonlySet<string>
  /**
   * Independent authoritative row source (chamber unary `session.list`) used
   * ONLY at the terminal convergence step: ids it still lists are released
   * from suppression (a shrink that was not a content purge must not hide a
   * live row); everything else stays suppressed.
   */
  probe?: () => Promise<ReadonlySet<string> | undefined> | undefined
  /** Called after a probe-confirmed release so the producer re-publishes. */
  onRelease?: () => void
  /** Honest warn reporting. */
  warn: (message: string) => void
  /** Forwarded to the convergence chain (tests inject fake timers). */
  schedule?: (run: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
  maxAttempts?: number
  retryMs?: number
  attemptTimeoutMs?: number
}

export interface PurgeTracker {
  /**
   * Observe the raw workspace `archivedSessionIds` field. Returns the ids
   * NEWLY tombstoned by this observation (empty for the first observation,
   * for an unchanged array identity, and for growth/no-change). A non-array
   * shape is treated as unknown and arms nothing.
   */
  observeArchive(archivedField: unknown): readonly string[]
  /**
   * Drop tombstones that no longer need suppressing: an id the official
   * refresh finally dropped (no longer listed) or one that re-entered the
   * archive set.
   */
  reconcile(listedIds: ReadonlySet<string>): void
  /** Currently suppressed ids (read-only view of the live set). */
  suppressed(): ReadonlySet<string>
  /** Filter tombstoned rows out (identity-preserving when nothing matches). */
  filter<T extends { sessionId: string }>(rows: readonly T[]): readonly T[]
  /** Start/join the verified convergence chain. */
  converge(): void
  /** Stop the chain and cancel its timers. */
  dispose(): void
  /** Chain activity (test/observability seam). */
  active(): boolean
}

const NO_IDS: readonly string[] = []

/**
 * Build one source's tracker.
 * @param deps - injectable seams.
 * @returns the tracker handle.
 */
export function createPurgeTracker(deps: PurgeTrackerDeps): PurgeTracker {
  const purged = new Set<string>()
  let archivedSeen: string[] | undefined
  let rawSeen: readonly unknown[] | undefined

  const chain: PurgedConvergenceChain = createPurgedConvergence({
    refresh: deps.refresh,
    lingering: () => lingeringPurgedIds([...purged], deps.listedSummaryIds()),
    release: (ids) => {
      for (const id of ids) purged.delete(id)
      deps.onRelease?.()
    },
    ...(deps.probe === undefined ? {} : { probe: deps.probe }),
    warn: deps.warn,
    ...(deps.schedule === undefined ? {} : { schedule: deps.schedule }),
    ...(deps.cancel === undefined ? {} : { cancel: deps.cancel }),
    ...(deps.maxAttempts === undefined ? {} : { maxAttempts: deps.maxAttempts }),
    ...(deps.retryMs === undefined ? {} : { retryMs: deps.retryMs }),
    ...(deps.attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs: deps.attemptTimeoutMs }),
  })

  return {
    observeArchive(archivedField: unknown): readonly string[] {
      if (!Array.isArray(archivedField) || archivedField === rawSeen) return NO_IDS
      rawSeen = archivedField
      const step = trackArchiveSetShrink(archivedSeen, archivedField.map(String))
      archivedSeen = step.archived
      if (step.removed.length === 0) return NO_IDS
      for (const id of step.removed) purged.add(id)
      chain.converge()
      return step.removed
    },
    reconcile(listedIds: ReadonlySet<string>): void {
      if (purged.size === 0) return
      const keep = new Set(reconcilePurgedRows([...purged], listedIds, new Set(archivedSeen ?? [])))
      for (const id of [...purged]) {
        if (!keep.has(id)) purged.delete(id)
      }
    },
    suppressed(): ReadonlySet<string> {
      // Defensive copy: callers (the producer's snapshot/runtime filters) only
      // read it, and the internal set must never become mutable from outside
      // (industry practice for a state-machine accessor).
      return new Set(purged)
    },
    filter<T extends { sessionId: string }>(rows: readonly T[]): readonly T[] {
      return filterPurgedRows(rows, purged)
    },
    converge(): void {
      chain.converge()
    },
    dispose(): void {
      chain.dispose()
    },
    active(): boolean {
      return chain.active()
    },
  }
}
