/**
 * Per-source purged-row suppression tracker — the STATEFUL half of the
 * producer's suppression, kept node-testable (the producer imports React/CSS).
 * Owns three facts per source ctx: the last AUTHORITATIVE archive set
 * (`archivedSeen`), that observation's raw store array identity (`rawSeen` — the
 * per-push cost short-circuit: the official workspace model installs a new array
 * only when the set content changes), and the tombstone set of ids that left the
 * archive set whose rows may still linger in the official summaries (`purged`).
 * Verification is delegated to `purged-convergence.ts`.
 */
import {
  filterPurgedRows,
  lingeringPurgedIds,
  reconcilePurgedRows,
  trackArchiveSetShrink,
} from './purged-rows.ts'
import { createPurgedConvergence, type PurgedConvergenceChain } from './purged-convergence.ts'

/** Injectable seams. */
export interface PurgeTrackerDeps {
  /** Official refresh in METHOD-CALL form (see purged-convergence.ts). */
  refresh: () => Promise<unknown> | undefined
  /** Ids the official summaries currently list (`ctx.sessions.list.byId` keys). */
  listedSummaryIds: () => ReadonlySet<string>
  /** Independent authoritative row source (chamber unary `session.list`) used ONLY at the
   *  terminal convergence step: ids it still lists are released from suppression. */
  probe?: () => Promise<ReadonlySet<string> | undefined> | undefined
  /** Called after a probe-confirmed release so the producer re-publishes. */
  onRelease?: () => void
  /** Honest warn reporting. */
  warn: (message: string) => void
/** Forwarded to the convergence chain. */
  schedule?: (run: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
  maxAttempts?: number
  retryMs?: number
  attemptTimeoutMs?: number
}

export interface PurgeTracker {
  /** Observe the raw workspace `archivedSessionIds` field; returns the ids NEWLY
   *  tombstoned (empty for a first observation, an unchanged array identity, growth or
   *  no-change). A non-array shape is treated as unknown and arms nothing. */
  observeArchive(archivedField: unknown): readonly string[]
  /** Drop tombstones no longer needing suppression (id dropped by the official refresh, or re-entered the archive set). */
  reconcile(listedIds: ReadonlySet<string>): void
  suppressed(): ReadonlySet<string>
  /** Filter tombstoned rows out (identity-preserving when nothing matches). */
  filter<T extends { sessionId: string }>(rows: readonly T[]): readonly T[]
  /** Start/join the verified convergence chain. */
  converge(): void
  dispose(): void
  active(): boolean
}

const NO_IDS: readonly string[] = []

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
      // Defensive copy: callers only read it, and the internal set must never become mutable from outside.
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
