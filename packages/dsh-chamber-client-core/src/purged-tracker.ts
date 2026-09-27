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
interface PurgeTrackerDeps {
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
  /** Restore bounded per-source facts across a renderer restart. */
  restore?: () => PurgeTrackerState | undefined
  /** Persist the current tombstones and last authoritative session ids. */
  persist?: (state: PurgeTrackerState) => void
/** Forwarded to the convergence chain. */
  schedule?: (run: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
  maxAttempts?: number
  retryMs?: number
  attemptTimeoutMs?: number
}

/** Durable, content-free purge facts for one source incarnation. */
export interface PurgeTrackerState {
  readonly purgedIds: readonly string[]
  readonly knownSessionIds: readonly string[]
}

interface PurgeTracker {
  /** Observe the raw workspace `archivedSessionIds` field; returns the ids NEWLY
   *  tombstoned (empty for a first observation, an unchanged array identity, growth or
   *  no-change). A non-array shape is treated as unknown and arms nothing. */
  observeArchive(archivedField: unknown): readonly string[]
  /** I-1 官方恢复（unarchive）：恢复的 id 必须立刻离开墓碑，且**不得**被它自己的归档集收缩
   *  重新立碑——该收缩正是恢复的足迹，而内容并没有被删。id 记到那次收缩被观察到为止，
   *  恢复事实先到（收缩后到）或后到（墓碑已立）都安全。 */
  release(ids: readonly string[]): void
  /** Drop tombstones no longer needing suppression (id dropped by the official refresh, or re-entered the archive set). */
  reconcile(listedIds: ReadonlySet<string>): void
  /** Compare summaries with a fresh host scan and tombstone stale rows. `legacyCandidates`
   *  are rows eligible for first-upgrade cleanup before this tracker has a remembered
   *  host-authoritative baseline; callers exclude active and just-created sessions. */
  observeAuthoritativeList(
    summaryIds: ReadonlySet<string>,
    authoritativeIds: ReadonlySet<string>,
    legacyCandidates?: ReadonlySet<string>,
  ): readonly string[]
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
  let restored: PurgeTrackerState | undefined
  try {
    restored = deps.restore?.()
  } catch (error) {
    deps.warn(`purge state restore failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const cleanIds = (values: readonly string[] | undefined): string[] =>
    (values ?? []).filter(id => typeof id === 'string' && id.length > 0 && id.length <= 512)
  const purged = new Set(cleanIds(restored?.purgedIds))
  // I-1：刚被官方恢复的 id（还没观察到它那次收缩）。见 PurgeTracker.release。
  const restoredIds = new Set<string>()
  let knownSessionIds = new Set(cleanIds(restored?.knownSessionIds))
  let archivedSeen: string[] | undefined
  let rawSeen: readonly unknown[] | undefined

  const persist = (): void => {
    if (deps.persist === undefined) return
    try {
      deps.persist({ purgedIds: [...purged], knownSessionIds: [...knownSessionIds] })
    } catch (error) {
      deps.warn(`purge state persist failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const chain: PurgedConvergenceChain = createPurgedConvergence({
    refresh: deps.refresh,
    lingering: () => lingeringPurgedIds([...purged], deps.listedSummaryIds()),
    release: (ids) => {
      let changed = false
      for (const id of ids) changed = purged.delete(id) || changed
      if (changed) persist()
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
      // 恢复造成的收缩不是 purge：消费掉 restored 记录，且不为这些 id 立碑。
      const armed = step.removed.filter(id => !restoredIds.has(id))
      for (const id of step.removed) restoredIds.delete(id)
      if (armed.length === 0) return NO_IDS
      for (const id of armed) purged.add(id)
      persist()
      chain.converge()
      return armed
    },
    release(ids: readonly string[]): void {
      // 足迹只在「这次恢复的收缩还没被观察到」时记（见 restoredIds 声明处）：收缩已经过去的
      // id 没有可豁免的快照，记下来只会静默吞掉它下一次真 purge 的收缩（逆序帧：host 先写
      // global 推流、后回 unary，恢复事实落在收缩之后）。
      const observed = new Set(archivedSeen ?? [])
      let changed = false
      for (const id of cleanIds(ids)) {
        if (purged.delete(id)) changed = true
        if (observed.has(id)) restoredIds.add(id)
      }
      if (changed) persist()
      deps.onRelease?.()
    },
    reconcile(listedIds: ReadonlySet<string>): void {
      if (purged.size === 0) return
      const keep = new Set(reconcilePurgedRows([...purged], listedIds, new Set(archivedSeen ?? [])))
      let changed = false
      for (const id of [...purged]) {
        if (!keep.has(id)) changed = purged.delete(id) || changed
      }
      if (changed) persist()
    },
    observeAuthoritativeList(summaryIds, authoritativeIds, legacyCandidates = new Set<string>()): readonly string[] {
      const removed: string[] = []
      const archived = new Set(archivedSeen ?? [])
      const previouslyKnown = new Set(knownSessionIds)
      for (const id of summaryIds) {
        const wasKnown = previouslyKnown.has(id)
        const isLegacyCandidate = legacyCandidates.has(id)
        if ((wasKnown || isLegacyCandidate)
          && !authoritativeIds.has(id) && !archived.has(id) && !purged.has(id)) {
          purged.add(id)
          removed.push(id)
        }
      }
      // The host scan is the live-session baseline. First-upgrade cleanup may include
      // legacy summaries predating this tracker, but only caller-vetted candidates;
      // new/active rows are excluded to avoid turning a creation/write race into a tombstone.
      knownSessionIds = new Set([...authoritativeIds].filter(id => !archived.has(id) && !purged.has(id)))
      if (removed.length > 0) chain.converge()
      persist()
      return removed
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
