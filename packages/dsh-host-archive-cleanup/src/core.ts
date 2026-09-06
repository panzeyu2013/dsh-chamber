/**
 * Archived-session content cleanup core (design 24 §4).
 *
 * TRUST BOUNDARY: callers arrive over the instance's host wire and are
 * untrusted JSON. They never supply a session id, a path, or a command: the
 * domain operates only on the authoritative archived set of THIS instance
 * (registry-global, todo 12 §1) and never touches non-archived content. The
 * orchestration below is pure and fixture-testable; every host capability it
 * needs arrives through the `ArchiveCleanupHost` seam, which the Remote
 * facade (`index.ts`) binds to §10-verified official primitives (see
 * `host-binding-pending` below and design 24 §10 — the bindings MUST be
 * resolved against the pinned vendor before this domain is enabled; nothing
 * here guesses a storage layout).
 *
 * Guarantees (design 24 §4):
 *  - children-first deletion with the archived-set member removed LAST, so a
 *    crash mid-purge leaves the top-level id archived and a later run can
 *    re-enumerate and converge (no uncollectable orphans);
 *  - running subtrees are skipped whole (fail-closed), never partially cut;
 *  - per-session isolation: one failure lands in `errors` and never blocks
 *    the remaining sessions (AGENTS: one failed entity must not erase or
 *    block unrelated complete entities);
 *  - idempotent per session: an id no longer in the set, or content already
 *    gone, is a no-op ("missing"), so repeated purges converge to empty.
 */

/** Hard upper bound on ARCHIVED-SET MEMBERS accounted by one purge
 *  (defensive capacity): the cap bounds the archived-set members counted for
 *  one purge — content descendants of those members are not separately
 *  counted against the cap (review F5). */
export const MAX_PURGE_SESSIONS = 65_536
/** Upper bound on per-item error records returned by one purge. */
export const MAX_PURGE_ERROR_RECORDS = 1_000

export interface ArchivedSessionState {
  readonly sessionId: string
  /** Coarse durable origin (wire: absent or 'subagent'). */
  readonly origin?: 'subagent'
  /** Link to the parent session (subagent-origin rows only). */
  readonly parentSessionId?: string
  /** Durable running bit from the authoritative session record. */
  readonly running: boolean
  /** Canonical working directory (header cwd) — lets the binding resolve the
   *  official artifact WITHOUT re-enumerating the whole corpus per delete
   *  (design 24 perf: purge uses one snapshot). */
  readonly cwd?: string
}

/**
 * The host capability seam. Implementations MUST be built on official
 * in-process primitives verified against the pinned vendor (design 24 §10);
 * an unverified capability must refuse loudly with `ArchiveCleanupError`
 * code `host-binding-pending` rather than guess a storage layout.
 */
export interface ArchiveCleanupHost {
  /** The authoritative archived id set (registry-global). */
  listArchivedSessionIds(): Promise<readonly string[]>
  /** Session records needed to walk the subagent lineage and the durable
   *  running bit (authoritative storage, never a client projection). */
  listSessionStates(): Promise<readonly ArchivedSessionState[]>
  /** Live agent ids at this moment (running guard). */
  listLiveAgentIds(): Promise<readonly string[]>
  /**
   * Delete one session's content through the official primitive. Children of
   * the session were already deleted by the caller (children-first order).
   * `cwd` is the snapshot header cwd (when available) so the binding resolves
   * the official artifact without a per-delete corpus re-enumeration.
   * Implementations refuse a session that is live at deletion time with code
   * `running` — the caller's mid-window live gate: there is no per-member
   * core pre-check (review F2), so a member that flips live AFTER the
   * per-tree recheck is caught here and, as the first in-tree failure,
   * aborts the remaining members of that tree (review F1, see purge).
   * @returns 'deleted' when content was removed, 'missing' when nothing was
   *   there (idempotent no-op — the caller still completes accounting).
   */
  deleteSessionContent(sessionId: string, cwd?: string): Promise<'deleted' | 'missing'>
  /** Remove ids from the archived set in ONE official persistence write
   *  (purge collects every completed root/orphan and commits at the end —
   *  design 24 perf: N per-tree atomic writes → 1). */
  removeArchivedSessionIds(ids: readonly string[]): Promise<void>
  /** Emit the official session-removed event for one deleted session.
   *  Implementations MUST wrap their failures in `ArchiveCleanupError` (the
   *  caller treats the first in-tree emit failure as a tree abort; a raw
   *  non-ArchiveCleanupError throw would kill the whole purge without item
   *  records — 2026-09 round-2 note). */
  emitSessionRemoved(sessionId: string): Promise<void>
  /** Emit the official archived-set-changed event after set mutations. */
  emitArchivedSessionsChanged(): Promise<void>
}

export interface PreviewResult {
  /** Total archived-set members in the authoritative registry-global set
   *  (archived subagent-origin rows included — the set is not strictly
   *  top-level ids). */
  readonly archived: number
  /** Archived-set members this run would delete as deletable tree roots
   *  (one per tree; a root may itself be an archived subagent-origin row
   *  that no deletable ancestor covers — counting unchanged). */
  readonly deletableSessions: number
  /** Non-root members this run would delete — subagent-origin descendants
   *  of the deletable trees (a subagent-origin row that IS a deletable tree
   *  root counts in deletableSessions, not here). */
  readonly deletableSubagents: number
  /** Whole subtrees skipped because a member is running. */
  readonly skippedRunning: number
}

export interface PurgeItemError {
  readonly sessionId: string
  readonly code: string
  readonly message: string
}

export interface PurgeResult {
  readonly deletedSessions: number
  readonly deletedSubagents: number
  readonly skippedRunning: number
  readonly errors: readonly PurgeItemError[]
  /** True when item errors were truncated at MAX_PURGE_ERROR_RECORDS. */
  readonly truncated?: boolean
}

export interface ArchiveCleanupDomainError {
  readonly code: string
  readonly message: string
  readonly retryable?: boolean
}

/** Explicit business carrier: the generic dsh gateway does not preserve
 *  thrown error fields (git-worktree parity). */
export type ArchiveCleanupDomainResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ArchiveCleanupDomainError }

/** Stable action error code (serialized over the wire). Codes:
 *  - `busy`: another purge/preview is in flight on this domain (host single-
 *    flight, design 24 §3) — retry after the in-flight run settles;
 *  - `registry-unreadable`: an overall precondition failed (authoritative
 *    state could not be read) — nothing was mutated;
 *  - `host-binding-pending`: the binding for a host capability is not yet
 *    wired (design 24 §10 vendor gate) — the domain is not enabled;
 *  - `purge-capacity`: the candidate set exceeded MAX_PURGE_SESSIONS —
 *    nothing was mutated.
 *  Per-item failures are NOT thrown: they land in `PurgeResult.errors`
 *  (item codes: `missing`, `running`, `storage`). */
export class ArchiveCleanupError extends Error {
  readonly code: string
  readonly retryable?: boolean

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'ArchiveCleanupError'
    this.code = code
    this.retryable = retryable
  }
}

/** Convert only known domain failures; unexpected programming failures remain internal throws. */
export async function domainResult<T>(operation: () => Promise<T>): Promise<ArchiveCleanupDomainResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    if (!(error instanceof ArchiveCleanupError)) throw error
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.retryable === true ? { retryable: true } : {}),
      },
    }
  }
}

/** True when the session (or any of its uninterrupted subagent descendants)
 *  is running — the subtree skip predicate (fail-closed). */
export function subtreeRunning(
  sessionId: string,
  statesBySession: ReadonlyMap<string, ArchivedSessionState>,
  childrenOf: ReadonlyMap<string, readonly string[]>,
  liveAgentIds: ReadonlySet<string>,
): boolean {
  const visited = new Set<string>()
  const queue = [sessionId]
  while (queue.length > 0) {
    const current = queue.shift() as string
    if (visited.has(current)) continue
    visited.add(current)
    const state = statesBySession.get(current)
    if (liveAgentIds.has(current) || state?.running === true) return true
    for (const child of childrenOf.get(current) ?? []) queue.push(child)
  }
  return false
}

export interface DeletableTree {
  readonly rootSessionId: string
  /** Children-first deletion order (descendants before the root). */
  readonly order: readonly string[]
  readonly subagentCount: number
}

/** Index uninterrupted subagent-origin children under every session. */
export function indexChildren(
  states: readonly ArchivedSessionState[],
): ReadonlyMap<string, readonly string[]> {
  const childrenOf = new Map<string, string[]>()
  for (const state of states) {
    if (state.origin !== 'subagent') continue
    if (state.parentSessionId === undefined) continue
    const list = childrenOf.get(state.parentSessionId)
    if (list === undefined) childrenOf.set(state.parentSessionId, [state.sessionId])
    else list.push(state.sessionId)
  }
  return childrenOf
}

/** Resolve the deletable subtree under one archived top-level id, or null
 *  when the whole subtree is skipped because a member is running. Returns
 *  null for an unknown root (orphan/archived id with no session record —
 *  treated as already gone, see purge). Children-first order is produced by
 *  post-order walk (cycle-guarded). */
export function resolveDeletableTree(
  rootSessionId: string,
  statesBySession: ReadonlyMap<string, ArchivedSessionState>,
  childrenOf: ReadonlyMap<string, readonly string[]>,
  liveAgentIds: ReadonlySet<string>,
): DeletableTree | null {
  if (!statesBySession.has(rootSessionId)) return null
  if (subtreeRunning(rootSessionId, statesBySession, childrenOf, liveAgentIds)) return null

  const order: string[] = []
  const visited = new Set<string>()
  // Iterative post-order (merge-round Nit N2): recursion depth equalled the
  // subagent chain depth; an explicit stack keeps arbitrarily deep lineage
  // chains safe. Produces the exact children-first order of the recursive
  // post-order (each node's subtree completes before the node itself), with
  // the same cycle guard (a cycle edge back to a visited ancestor is
  // skipped — the node was already queued by its first path).
  const stack: Array<{ sessionId: string; expanded: boolean }> = [
    { sessionId: rootSessionId, expanded: false },
  ]
  while (stack.length > 0) {
    const { sessionId, expanded } = stack.pop() as { sessionId: string; expanded: boolean }
    if (expanded) {
      order.push(sessionId)
      continue
    }
    if (visited.has(sessionId)) continue
    visited.add(sessionId)
    stack.push({ sessionId, expanded: true })
    const children = childrenOf.get(sessionId) ?? []
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ sessionId: children[i] as string, expanded: false })
    }
  }
  // order[0] is the deepest-visited leaf; the root is last. subagentCount
  // excludes the root itself.
  return {
    rootSessionId,
    order,
    subagentCount: order.length - 1,
  }
}

/** The pure orchestration core (design 24 §4 steps 1–7). */
export class ArchiveCleanupCore {
  private readonly host: ArchiveCleanupHost

  constructor(host: ArchiveCleanupHost) {
    this.host = host
  }

  /** Step 1–3 read pass shared by preview and purge. */
  private async readAuthoritativeState(): Promise<{
    archivedIds: string[]
    statesBySession: Map<string, ArchivedSessionState>
    childrenOf: Map<string, readonly string[]>
    liveAgentIds: Set<string>
  }> {
    let archivedIds: readonly string[]
    let states: readonly ArchivedSessionState[]
    let live: readonly string[]
    try {
      ;[archivedIds, states, live] = await Promise.all([
        this.host.listArchivedSessionIds(),
        this.host.listSessionStates(),
        this.host.listLiveAgentIds(),
      ])
    } catch (error) {
      if (error instanceof ArchiveCleanupError) throw error
      throw new ArchiveCleanupError('registry-unreadable', `归档状态不可读：${error instanceof Error ? error.message : String(error)}`)
    }
    const statesBySession = new Map<string, ArchivedSessionState>()
    for (const state of states) {
      const existing = statesBySession.get(state.sessionId)
      if (existing === undefined) statesBySession.set(state.sessionId, state)
    }
    const childrenOf = new Map<string, readonly string[]>()
    for (const [parent, children] of indexChildren(states)) {
      childrenOf.set(parent, children)
    }
    return {
      archivedIds: [...new Set(archivedIds.map(String))],
      statesBySession,
      childrenOf,
      liveAgentIds: new Set(live.map(String)),
    }
  }

  /** Resolve the run plan: archived roots not already covered by another
   *  deletable root's subtree, each mapped to its deletable tree (or skipped
   *  when running). A root that is itself a subagent descendant of an
   *  earlier deletable root is covered by that root's tree and skipped here
   *  (no double deletion). */
  private resolvePlan(
    archivedIds: readonly string[],
    statesBySession: ReadonlyMap<string, ArchivedSessionState>,
    childrenOf: ReadonlyMap<string, readonly string[]>,
    liveAgentIds: ReadonlySet<string>,
  ): { trees: DeletableTree[]; skippedRunning: number; orphanRoots: string[] } {
    const trees: DeletableTree[] = []
    let skippedRunning = 0
    const orphanRoots: string[] = []
    const covered = new Set<string>()
    for (const id of archivedIds) {
      // Covered check FIRST (design 24 perf): an ancestor tree that is
      // deletable implies every member is non-running, so a covered archived
      // descendant needs no BFS — O(A) instead of O(A²) for nested chains.
      if (covered.has(id)) continue
      if (!statesBySession.has(id)) {
        // Orphan/archived id without a session record — nothing to delete,
        // but the purge still removes the set member (set converges).
        orphanRoots.push(id)
        continue
      }
      const tree = resolveDeletableTree(id, statesBySession, childrenOf, liveAgentIds)
      if (tree === null) {
        skippedRunning += 1
        continue
      }
      for (const member of tree.order) covered.add(member)
      trees.push(tree)
    }
    return { trees, skippedRunning, orphanRoots }
  }

  /** Read-only preview (design 24 §3): a point-in-time snapshot for confirm
   *  copy — never authoritative for the purge itself. */
  async preview(): Promise<PreviewResult> {
    const { archivedIds, statesBySession, childrenOf, liveAgentIds } = await this.readAuthoritativeState()
    const plan = this.resolvePlan(archivedIds, statesBySession, childrenOf, liveAgentIds)
    let deletableSessions = 0
    let deletableSubagents = 0
    for (const tree of plan.trees) {
      deletableSessions += 1
      deletableSubagents += tree.subagentCount
    }
    return {
      archived: archivedIds.length,
      deletableSessions,
      deletableSubagents,
      skippedRunning: plan.skippedRunning,
    }
  }

  /**
   * Delete the content of every archived session (children-first, archived
   * member removed last — ONE batched set removal at the end).
   *
   * Performance contract (design 24 perf review): the authoritative snapshot
   * (archived set + session states + lineage) is read ONCE; per deletable
   * tree only the cheap in-memory live set is re-read and checked at the
   * TREE level (the real running guard — no per-member pre-check, review F2:
   * a mid-tree live flip surfaces through the binding's delete-time
   * `running` refusal). Per-member deletion uses the snapshot's cwd so the
   * binding never re-enumerates the corpus. Completed roots (and any
   * archived descendants their completed trees covered) plus orphans are
   * removed from the archived set in a single official write after the whole
   * run. Per-session failures land in `errors` (truncated at
   * MAX_PURGE_ERROR_RECORDS with `truncated`). The FIRST in-tree failure
   * aborts the REMAINING members of that tree (review F1): ancestors and the
   * root stay untouched and archived so a rerun re-enumerates and converges,
   * while members deleted before the failure stay deleted (prefix deletions
   * are not rolled back). Per-session isolation across INDEPENDENT trees is
   * unchanged: the run continues with the next tree.
   */
  async purge(): Promise<PurgeResult> {
    const { archivedIds, statesBySession, childrenOf, liveAgentIds } = await this.readAuthoritativeState()
    if (archivedIds.length > MAX_PURGE_SESSIONS) {
      throw new ArchiveCleanupError('purge-capacity', `archived set exceeds the ${MAX_PURGE_SESSIONS}-session purge capacity`)
    }
    // Snapshot membership of the archived set (merge-round Nit N1): lets the
    // end-of-run batched removal also clear archived descendants covered by a
    // completed tree IN THE SAME RUN instead of lagging to a later orphan
    // pass. Only ids that were members at snapshot time are ever cleared.
    const archivedAtStart = new Set<string>(archivedIds)
    const plan = this.resolvePlan(archivedIds, statesBySession, childrenOf, liveAgentIds)
    let deletedSessions = 0
    let deletedSubagents = 0
    let truncated = false
    const errors: PurgeItemError[] = []
    const recordError = (sessionId: string, code: string, message: string): void => {
      if (errors.length >= MAX_PURGE_ERROR_RECORDS) {
        truncated = true
        return
      }
      errors.push({ sessionId, code, message })
    }

    const completedRoots: string[] = []
    const coveredArchivedMembers: string[] = []
    for (const tree of plan.trees) {
      // Cheap in-memory live refresh only (design 24 perf): the durable
      // snapshot stays fixed for the run — single-flight rules out in-process
      // concurrency and deletion is idempotent. The refresh feeds the
      // TREE-level running recheck ONLY (no per-member pre-check, review F2):
      // a member that flips live after this recheck is refused by the
      // binding's delete-time live guard, which then aborts this tree as the
      // first in-tree failure (semantics below).
      let nowLive: ReadonlySet<string>
      try {
        nowLive = new Set(await this.host.listLiveAgentIds())
      } catch (error) {
        if (error instanceof ArchiveCleanupError) throw error
        throw new ArchiveCleanupError('registry-unreadable', `live agent 状态不可读：${error instanceof Error ? error.message : String(error)}`)
      }
      if (subtreeRunning(tree.rootSessionId, statesBySession, childrenOf, nowLive)) {
        plan.skippedRunning += 1
        continue
      }
      // Member-window note (merge-round Minor-4 + review follow-up F1/F2):
      // the whole-subtree skip guarantee holds up to each member's deletion
      // instant, and the binding's delete-time live guard is the ONLY
      // mid-window gate (the dead per-member O(1) pre-check was removed —
      // the tree-level recheck above already proved the subtree non-running
      // against the same fresh set, so it could never fire; a genuine
      // mid-tree live flip now surfaces as the binding's
      // ArchiveCleanupError('running') and triggers the abort below).
      //
      // ABORT SEMANTICS: the FIRST in-tree failure (any ArchiveCleanupError
      // from a member deletion — delete-time `running`/`storage` — or from
      // emitSessionRemoved) stops processing the REMAINING members of this
      // tree: ancestors and the root stay untouched and archived, so a later
      // purge re-enumerates the intact remainder and converges (design 24
      // §4 step-4/Minor-4). Members already deleted BEFORE the failure stay
      // deleted — prefix deletions are not rolled back (they were
      // legitimately deletable at their deletion instant). Never delete
      // ancestors past a failed member: the root's session record lives
      // inside its own content directory (vendor-verified:
      // session-persistence-jsonl list() walks session dirs), so deleting
      // the root over a surviving member would make the NEXT purge treat the
      // root id as an orphan and clear it from the archived set WITHOUT
      // re-enumerating the survivor — a permanent silent content leak. The
      // outer loop continues with the NEXT independent tree (per-session
      // isolation across trees unchanged).
      let treeAborted = false
      for (const sessionId of tree.order) {
        const state = statesBySession.get(sessionId)
        try {
          // Every member except the root is a subagent-origin descendant.
          const outcome = await this.host.deleteSessionContent(sessionId, state?.cwd)
          if (sessionId === tree.rootSessionId) {
            if (outcome === 'deleted') deletedSessions += 1
          } else if (outcome === 'deleted') {
            deletedSubagents += 1
          }
          try {
            await this.host.emitSessionRemoved(sessionId)
          } catch (error) {
            if (!(error instanceof ArchiveCleanupError)) throw error
            // First in-tree failure — abort the remaining members of this
            // tree (the deleted member itself stays deleted). Note: when the
            // deletion above already succeeded, the member was counted
            // `deleted` AND is listed as an error for the same sessionId
            // (double presentation) — accepted: the deletion is durable and
            // a rerun converges via 'missing', while the error honestly tells
            // the client the projection side (event) failed. The binding is a
            // documented no-op today, so this branch is future-proofing.
            treeAborted = true
            recordError(sessionId, error.code, error.message)
            break
          }
        } catch (error) {
          if (!(error instanceof ArchiveCleanupError)) throw error
          // First in-tree failure — abort the remaining members of this
          // tree: the refused member survives under an archived root (or IS
          // the root, which stays archived) and a later purge re-runs it.
          treeAborted = true
          recordError(sessionId, error.code, error.message)
          break
        }
      }
      if (treeAborted) {
        // Crash/partial-failure consistency (design 24 §4 step 4 + F1): the
        // root id stays archived until the WHOLE subtree is provably gone;
        // the abort guarantees nothing past the failed member was touched,
        // so a rerun re-enumerates the remainder and converges.
        continue
      }
      completedRoots.push(tree.rootSessionId)
      for (const member of tree.order) {
        // Merge-round Nit N1: an archived descendant covered by this
        // completed tree (a subagent-origin id that is itself in the
        // archived set) is cleared in the SAME run — no marker lag to a
        // later orphan pass.
        if (member !== tree.rootSessionId && archivedAtStart.has(member)) {
          coveredArchivedMembers.push(member)
        }
      }
    }
    // The archived-set members of every completed tree are removed LAST in
    // ONE official write (root ids stay archived until their whole subtree is
    // gone; a crash before this point leaves a re-enumerable remainder).
    // Covered archived descendants of a completed tree ride the same write.
    // Orphan set members (no session record) carry no content — removing
    // them is the whole operation and is safe at any point.
    const clearIds = [...completedRoots, ...coveredArchivedMembers, ...plan.orphanRoots]
    if (clearIds.length > 0) {
      try {
        await this.host.removeArchivedSessionIds(clearIds)
      } catch (error) {
        if (!(error instanceof ArchiveCleanupError)) throw error
        // Every listed id stays archived; the next purge re-runs them
        // (content already gone → orphan convergence). Run-level note
        // (review F4): this archive-set record SHARES the item cap — a full
        // MAX_PURGE_ERROR_RECORDS-length list keeps `truncated: true`, which
        // is the honest surface: the set members stay archived, so a rerun
        // still converges despite the truncation flag.
        recordError('', 'archive-set', error.message)
      }
      try {
        await this.host.emitArchivedSessionsChanged()
      } catch (error) {
        if (!(error instanceof ArchiveCleanupError)) throw error
        // The changed event is a projection signal only — a failure must not
        // roll back completed deletions; it is recorded per design 24 §11.
        // Same shared-cap semantics as the removal record above (F4).
        recordError('', 'archive-set', error.message)
      }
    }
    return {
      deletedSessions,
      deletedSubagents,
      skippedRunning: plan.skippedRunning,
      errors,
      ...(truncated ? { truncated: true } : {}),
    }
  }
}
