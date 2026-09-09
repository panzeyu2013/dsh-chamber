/**
 * Archived-session content cleanup core (design 24 §4).
 *
 * TRUST BOUNDARY: callers arrive over the instance's host wire and are
 * untrusted JSON. They never supply a path or a command, and their only
 * session-id input is purge's OPTIONAL subset filter — which can never
 * extend the deletion set: candidates are always the intersection with the
 * authoritative archived set of THIS instance read at run start
 * (registry-global, todo 12 §1). The domain never touches non-archived
 * content. The orchestration below is pure and fixture-testable; every host
 * capability it needs arrives through the `ArchiveCleanupHost` seam, which
 * the Remote facade (`index.ts`) binds to §10-verified official primitives
 * (see `host-binding-pending` below and design 24 §10 — the bindings MUST be
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
 *    gone, is a no-op ("missing"), so repeated purges converge to empty;
 *  - registry-global orphan sweep (design 24 §20 residual ①): every purge run
 *    ALSO clears archived-set members that have no session record across the
 *    ENTIRE archived set — not just the run's candidate subset. Membership of
 *    record-less ids is the whole operation (ZERO new content-deletion
 *    semantics); the sweep rides the same single set write and is
 *    TRIPLE-gated before it is committed: (1) a credibility guard on the
 *    snapshot/confirmation corpora, (2) a fresh double-confirmation read, and
 *    (3) the decisive per-candidate authoritative existence probe
 *    (`hasStoredContent` — 2026-12 blocker fix; see SWEEP below).
 */

/** Hard upper bound on ARCHIVED-SET MEMBERS accounted by one purge
 *  (defensive capacity): the cap bounds the archived-set members counted for
 *  one purge — content descendants of those members are not separately
 *  counted against the cap (review F5). */
export const MAX_PURGE_SESSIONS = 65_536
/** Upper bound on per-item error records returned by one purge. */
export const MAX_PURGE_ERROR_RECORDS = 1_000
/**
 * Upper bound on per-candidate authoritative content-existence probes
 * (`hasStoredContent`) performed by ONE registry-global orphan sweep
 * (2026-12 blocker fix). Each probe is a full official persistence read
 * (`sessionPersistence.inspect` — the jsonl backend parses the session log),
 * so the sweep carries its own budget, tighter than the archived-set capacity
 * that bounds how many members a run may CONSIDER. The live instance observed
 * by the 2026-12 review had 739 record-less candidates — comfortably inside
 * one run. When the budget truncates a sweep, the un-probed remainder stays
 * archived, converges on a later run (the sweep is idempotent), and the run
 * records ONE run-level `archive-set` note naming the truncation.
 */
export const MAX_SWEEP_CONTENT_PROBES = 4_096

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
   * DECISIVE per-candidate authoritative existence check (2026-12 blocker
   * fix). Returns true when the OFFICIAL persistence can still materialize a
   * record for `sessionId` right now — i.e. the session HAS content — and
   * false ONLY on the official "no materialized durable log" answer.
   *
   * Why this exists: both bulk enumerations can be SILENTLY NARROWED in
   * reachable ways (the live-preferred query corpus answers live-only without
   * an error when its optional persistence binding is absent; the jsonl list
   * skips unparseable/empty artifacts and returns [] when the sessions root
   * is absent). "Absent from the corpus snapshot" therefore never proves
   * "no content", and the archived set lives in `<dshHome>/storages` while
   * session content lives in `<dshHome>/sessions`, so the two can diverge.
   * The sweep MUST ask the authoritative single-id read before clearing any
   * membership.
   *
   * Implementations MUST fail CLOSED: only an explicit not-found answer may
   * return false; every other outcome (corruption, unsupported format,
   * transport/IO failure, absent service, a drifted error shape) returns
   * TRUE. A host that cannot perform the check at all returns true — the
   * sweep is then skipped and a run-level `archive-set` note is recorded
   * instead of guessing.
   */
  hasStoredContent(sessionId: string): Promise<boolean>
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
  /** Archived-set members removed by the registry-global ORPHAN SWEEP this
   *  run (design 24 §20 residual ①): ids that sat in the archived set with no
   *  session record at all. Present only when at least one member was swept
   *  AND the single official set write succeeded; absent means zero.
   *  DELIBERATELY NOT part of `deletedSessions`/`deletedSubagents` — those
   *  count CONTENT deletions only, and the sweep deletes no content.
   *  Additive optional field: old clients ignore unknown result keys (the
   *  chamber sidebar reads named counts through `countField`), so the wire
   *  contract is unchanged. */
  readonly clearedOrphanMembers?: number
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
 *    nothing was mutated;
 *  - `invalid-request`: a purge subset filter was malformed (non-string/
 *    empty ids) or oversized (> MAX_PURGE_SESSIONS entries) — nothing was
 *    mutated (2026-09 revision: purge gained an optional subset filter).
 *  Per-item failures are NOT thrown: they land in `PurgeResult.errors`
 *  (item codes: `missing`, `running`, `storage`). Run-level failures that
 *  must not abort completed deletions (the batched set write, the changed
 *  event, a skipped orphan sweep) use the item code `archive-set` with an
 *  empty sessionId. */
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

/**
 * Registry-global ORPHAN SWEEP predicate (design 24 §20 residual ①): the
 * archived-set members with NO session record at all — no content to delete
 * and no row in any official session list, so they are unreachable through
 * the archive manager (which lists rows ∩ set) and accumulate forever.
 *
 * This is EXACTLY the predicate the per-candidate plan already used for
 * candidate orphans (`resolvePlan`); the sweep only widens its SCOPE from
 * "this run's candidates" to the WHOLE authoritative archived set. It adds
 * zero content-deletion semantics: an orphan has nothing to delete, so the
 * only operation is removing its archived-set membership.
 *
 * Fail-closed inputs: `statesBySession` must come from a SUCCESSFUL official
 * enumeration (a failed enumeration throws and the caller never reaches this
 * predicate) — an id is never assumed record-less. `liveAgentIds` is an
 * extra defense-in-depth exclusion: an id that is live/open must never lose
 * its membership even if the durable corpus momentarily fails to list a
 * record for it (a live session's content is real). By definition an orphan
 * is never live, so the guard is a no-op in practice.
 *
 * This predicate only produces CANDIDATES (2026-12 blocker fix): a successful
 * enumeration is not proof that an absent id has no content (both bulk reads
 * can narrow silently), so `purge` additionally requires the credibility
 * guards and the decisive per-candidate `hasStoredContent` probe before any
 * candidate's membership is cleared. See `purge` SWEEP G1–G3.
 */
export function orphanArchivedMembers(
  archivedIds: readonly string[],
  statesBySession: ReadonlyMap<string, ArchivedSessionState>,
  liveAgentIds: ReadonlySet<string>,
): string[] {
  const orphans: string[] = []
  for (const id of archivedIds) {
    if (statesBySession.has(id)) continue
    if (liveAgentIds.has(id)) continue
    orphans.push(id)
  }
  return orphans
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
    /** Raw number of session records the snapshot enumeration returned (before
     *  de-duplication). The registry-global orphan sweep's credibility guard
     *  keys on it: a corpus reporting ZERO records while N members are
     *  archived is not credible (2026-12 blocker fix). */
    snapshotRecordCount: number
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
      snapshotRecordCount: states.length,
    }
  }

  /** Resolve the run plan: candidate roots not already covered by another
   *  deletable root's subtree, each mapped to its deletable tree (or skipped
   *  when running). Candidates are the full archived set (purge without a
   *  filter) or the requested subset ∩ archived set (filtered purge); a root
   *  that is itself a subagent descendant of an earlier deletable root is
   *  covered by that root's tree and skipped here (no double deletion).
   *  Orphan candidates (no session record) are no tree and are NOT collected
   *  here: the registry-global orphan sweep (`orphanArchivedMembers`) covers
   *  them — and every other record-less member — in one pass. */
  private resolvePlan(
    candidateIds: readonly string[],
    statesBySession: ReadonlyMap<string, ArchivedSessionState>,
    childrenOf: ReadonlyMap<string, readonly string[]>,
    liveAgentIds: ReadonlySet<string>,
  ): { trees: DeletableTree[]; skippedRunning: number } {
    const trees: DeletableTree[] = []
    let skippedRunning = 0
    const covered = new Set<string>()
    for (const id of candidateIds) {
      // Covered check FIRST (design 24 perf): an ancestor tree that is
      // deletable implies every member is non-running, so a covered archived
      // descendant needs no BFS — O(A) instead of O(A²) for nested chains.
      if (covered.has(id)) continue
      if (!statesBySession.has(id)) {
        // Orphan/archived id without a session record — nothing to delete;
        // its set membership is cleared by the registry-global orphan sweep.
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
    return { trees, skippedRunning }
  }

  /**
   * DECISIVE sweep gate (2026-12 blocker fix): keep only the candidates the
   * OFFICIAL persistence proves it cannot materialize. The bulk snapshot and
   * the confirmation read are both best-effort enumerations that can narrow
   * silently (see `ArchiveCleanupHost.hasStoredContent`); this per-candidate
   * read is the only authority for "no content".
   *
   * Fail-closed rules, in order:
   *  - capability absent (not a function) ⇒ NOTHING is swept, one run-level
   *    `archive-set` note;
   *  - the probe throws ANY error ⇒ that candidate keeps its membership (a
   *    failed existence check is "may have content"), the run is never
   *    aborted, and ONE run-level `archive-set` note summarizes the failures
   *    (per-candidate records would flood the shared item cap);
   *  - any return other than the exact boolean `false` ⇒ keeps its membership
   *    (a truthy/undefined answer is not a proof of absence);
   *  - at most MAX_SWEEP_CONTENT_PROBES probes per run; a truncated remainder
   *    stays archived and ONE run-level `archive-set` note is recorded.
   *
   * The probe is invoked AS A METHOD on the host object (implementations are
   * routinely instance-state classes — the detached-`locate` real-machine
   * regression of 2026-09).
   */
  private async selectContentFreeCandidates(
    candidateIds: readonly string[],
    recordNote: (sessionId: string, code: string, message: string) => void,
  ): Promise<string[]> {
    if (candidateIds.length === 0) return []
    const probe = this.host.hasStoredContent as ((sessionId: string) => Promise<boolean>) | undefined
    if (typeof probe !== 'function') {
      recordNote('', 'archive-set', `archiveCleanup: orphan sweep skipped — the host has no hasStoredContent capability (${candidateIds.length} record-less member(s) kept archived)`)
      return []
    }
    const bounded = candidateIds.slice(0, MAX_SWEEP_CONTENT_PROBES)
    if (candidateIds.length > bounded.length) {
      recordNote('', 'archive-set', `archiveCleanup: orphan sweep truncated at ${MAX_SWEEP_CONTENT_PROBES} content-existence probes — ${candidateIds.length - bounded.length} member(s) kept archived for a later run`)
    }
    const swept: string[] = []
    let probeFailures = 0
    let firstProbeFailure = ''
    for (const sessionId of bounded) {
      let hasContent: unknown
      try {
        hasContent = await this.host.hasStoredContent(sessionId)
      } catch (error) {
        // Fail closed AND isolate: an unreadable existence check must never
        // abort the run (completed content deletions are committed by the
        // caller's single write) nor clear a membership.
        probeFailures += 1
        if (firstProbeFailure === '') {
          firstProbeFailure = error instanceof Error ? error.message : String(error)
        }
        continue
      }
      // Strict identity: ONLY the exact boolean false proves absence.
      if (hasContent === false) swept.push(sessionId)
    }
    if (probeFailures > 0) {
      recordNote('', 'archive-set', `archiveCleanup: orphan sweep kept ${probeFailures} member(s) — content-existence probe failed (fail-closed): ${firstProbeFailure}`)
    }
    return swept
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
   * Optional `sessionIds` subset filter (2026-09 revision, design 24 wire
   * amendment): when provided, ONLY the listed archived-set members are
   * candidate roots (each with its own deletable subtree). The filter can
   * never extend the deletion set — candidates are ALWAYS the intersection
   * with the authoritative archived set read at run start — and a listed id
   * that already left the set (concurrent purge in another shell) is simply
   * no candidate: idempotent, never an error. `undefined` = the full set
   * (unchanged semantics); a provided EMPTY array = delete NO content (the
   * registry-global orphan sweep below still runs — see SWEEP).
   *
   * BUCKET SEMANTICS NOTE (review round 2026-09): counts are per TREE ROOT,
   * not per row origin — when the archived set itself contains a
   * subagent-origin row and it is selected WITHOUT any deletable ancestor
   * (reachable over the wire), it is its own tree root and counts in
   * `deletedSessions`; when the same row is covered by a selected ancestor's
   * completed tree it counts in `deletedSubagents`. The buckets can
   * therefore flip with candidate order for one selection — the UI never
   * selects hidden subagent rows, so presentation is unaffected.
   *
   * SWEEP (design 24 §20 residual ①): independently of the filter, every run
   * clears archived-set members that are ORPHANS across the ENTIRE archived
   * set — ids with no session record in the run's authoritative snapshot
   * (`orphanArchivedMembers`). Historical no-directory members accumulated by
   * older versions / failed set writes are otherwise unreachable (the manager
   * lists rows ∩ set) and would accumulate forever. ZERO new
   * content-deletion semantics: the sweep only removes membership of
   * record-less ids, never deletes content, and never touches an id that has
   * a record (running or not). FAIL-CLOSED, TRIPLE-GATED (2026-12 blocker
   * fix — "absent from the snapshot" is NOT proof of absent content, because
   * both bulk enumerations can narrow silently):
   *  G1 credibility — an EMPTY snapshot corpus while members are archived, or
   *  a confirmation corpus collapsing to empty, SKIPS the sweep with a
   *  run-level `archive-set` note;
   *  G2 double confirmation — the swept ids must ALSO be record-less, still
   *  archived and not live in a FRESH read taken after the content deletions;
   *  a failed fresh read SKIPS the sweep (run-level `archive-set` note);
   *  G3 the DECISIVE per-candidate authoritative existence probe — the
   *  official single-id persistence read (`hasStoredContent`) must prove it
   *  cannot materialize the id; a probe that throws, is unavailable, or
   *  answers anything but the exact boolean `false` keeps the membership
   *  (bounded by MAX_SWEEP_CONTENT_PROBES per run, truncation noted).
   * Every skip is a run-level `archive-set` note, never an abort: the
   * completed content deletions are still committed. The confirmation read
   * happens ONLY when the snapshot shows orphan members, so a converged
   * instance keeps the single-scan contract. The sweep is bounded by the
   * defensive capacity: an archived set beyond MAX_PURGE_SESSIONS is not
   * swept (a full-set purge over it already refuses with `purge-capacity`).
   * Swept ids ride the SAME single `removeArchivedSessionIds` write as the
   * completed trees, deduped, and are counted separately in
   * `clearedOrphanMembers` (never in
   * `deletedSessions`/`deletedSubagents`).
   *
   * Performance contract (design 24 perf review): the authoritative snapshot
   * (archived set + session states + lineage) is read ONCE; per deletable
   * tree only the cheap in-memory live set is re-read and checked at the
   * TREE level (the real running guard — no per-member pre-check, review F2:
   * a mid-tree live flip surfaces through the binding's delete-time
   * `running` refusal). Per-member deletion uses the snapshot's cwd so the
   * binding never re-enumerates the corpus. Completed roots (and any
   * archived descendants their completed trees covered) plus swept orphans
   * are removed from the archived set in a single official write after the
   * whole run. The orphan sweep adds at most MAX_SWEEP_CONTENT_PROBES
   * single-id persistence reads (only for members that survived G1+G2).
   * Per-session failures land in `errors` (truncated at
   * MAX_PURGE_ERROR_RECORDS with `truncated`). The FIRST in-tree failure
   * aborts the REMAINING members of that tree (review F1): ancestors and the
   * root stay untouched and archived so a rerun re-enumerates and converges,
   * while members deleted before the failure stay deleted (prefix deletions
   * are not rolled back). Per-session isolation across INDEPENDENT trees is
   * unchanged: the run continues with the next tree.
   */
  async purge(sessionIds?: readonly string[]): Promise<PurgeResult> {
    // Filter validation runs BEFORE the authoritative read (review round
    // 2026-09): shape/length checks depend on nothing from the corpus, so a
    // malformed/oversized request must not pay a full registry + corpus scan
    // just to be refused. A provided EMPTY array is a deliberate
    // delete-nothing CONTENT subset (never the full-set interpretation); the
    // run still proceeds to the registry-global orphan sweep, which is
    // orthogonal to the filter (design 24 §20 residual ①) and deletes no
    // content.
    if (sessionIds !== undefined) {
      if (!Array.isArray(sessionIds)
        || sessionIds.some(id => typeof id !== 'string' || id === '')) {
        throw new ArchiveCleanupError(
          'invalid-request',
          'archiveCleanup: purge subset filter must be an array of non-empty session id strings',
        )
      }
      if (sessionIds.length > MAX_PURGE_SESSIONS) {
        throw new ArchiveCleanupError(
          'invalid-request',
          `archiveCleanup: purge subset filter exceeds ${MAX_PURGE_SESSIONS} entries`,
        )
      }
    }
    const { archivedIds, statesBySession, childrenOf, liveAgentIds, snapshotRecordCount } = await this.readAuthoritativeState()
    let candidates: readonly string[]
    if (sessionIds === undefined) {
      if (archivedIds.length > MAX_PURGE_SESSIONS) {
        throw new ArchiveCleanupError('purge-capacity', `archived set exceeds the ${MAX_PURGE_SESSIONS}-session purge capacity`)
      }
      candidates = archivedIds
    } else {
      const selected = new Set(sessionIds)
      // Intersection with the authoritative archived set, in set order:
      // listed-but-gone ids are no candidates (concurrent purge / stale
      // client list — idempotent skip, never an error).
      candidates = archivedIds.filter(id => selected.has(id))
    }
    // Snapshot membership of the archived set (merge-round Nit N1): lets the
    // end-of-run batched removal also clear archived descendants covered by a
    // completed tree IN THE SAME RUN instead of lagging to a later orphan
    // pass. Only ids that were members at snapshot time are ever cleared.
    const archivedAtStart = new Set<string>(archivedIds)
    // Registry-global orphan sweep CANDIDATES (design 24 §20 residual ①):
    // record-less members of the WHOLE archived set (the subset filter does
    // not limit this — that is the point of the sweep), taken from the same
    // authoritative snapshot the run already read. The defensive capacity
    // bounds the sweep exactly like a full-set purge: an oversized set is
    // never swept (its full-set purge already refuses with purge-capacity).
    const sweepCandidates = archivedIds.length <= MAX_PURGE_SESSIONS
      ? orphanArchivedMembers(archivedIds, statesBySession, liveAgentIds)
      : []
    const plan = this.resolvePlan(candidates, statesBySession, childrenOf, liveAgentIds)
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
    // ---- Registry-global orphan sweep (design 24 §20 residual ①) --------
    // A sweep candidate has no record in the SNAPSHOT — which is exactly the
    // inference that caused the 2026-12 blocker, because both bulk
    // enumerations can narrow silently. Three gates stand between a candidate
    // and its membership removal, and ALL must pass:
    //
    //  G1 CREDIBILITY (this block): a snapshot corpus reporting ZERO records
    //     while members are archived is not credible, and a confirmation
    //     corpus that COLLAPSES to zero after a non-empty snapshot is not
    //     credible either. Both SKIP the sweep with a run-level `archive-set`
    //     note (never an abort: completed content deletions still commit).
    //  G2 DOUBLE CONFIRMATION (fail-closed): the snapshot candidates are
    //     re-checked against a FRESH archived set + record corpus + live set
    //     taken after the content deletions. If the fresh read fails, the
    //     sweep is SKIPPED (run-level `archive-set` note, never guessed).
    //  G3 AUTHORITATIVE EXISTENCE PROBE (decisive, 2026-12 blocker fix): each
    //     surviving candidate is asked of the OFFICIAL single-id persistence
    //     read (`hasStoredContent`); it is swept ONLY when that read proves it
    //     cannot materialize the id. This is what makes "missing from both
    //     bulk reads" insufficient on its own.
    //
    // Runs only when the snapshot actually shows orphan members, so a
    // converged instance keeps the single-scan contract.
    let sweptOrphanMembers: string[] = []
    if (sweepCandidates.length > 0) {
      if (snapshotRecordCount === 0) {
        // G1a: an empty corpus is not evidence of absence. The live instance
        // has 739 archived members — a corpus that reports zero records while
        // the archived set is non-empty is a broken/narrowed enumeration, and
        // acting on it would clear the membership of every content-bearing
        // member at once (the reviewer's one-row purge repro).
        recordError('', 'archive-set', `archiveCleanup: orphan sweep skipped — the snapshot session corpus is empty while ${archivedIds.length} archived member(s) exist; an empty corpus is not credible evidence of absent content`)
      } else {
        try {
          const [freshArchivedIds, freshStates, freshLive] = await Promise.all([
            this.host.listArchivedSessionIds(),
            this.host.listSessionStates(),
            this.host.listLiveAgentIds(),
          ])
          if (freshStates.length === 0) {
            // G1b: the confirmation corpus collapsed to empty after a
            // non-empty snapshot — equally non-credible; clear nothing.
            recordError('', 'archive-set', `archiveCleanup: orphan sweep skipped — the confirmation read's session corpus collapsed to empty (snapshot had ${snapshotRecordCount} record(s)); a collapsed corpus is not credible evidence of absent content`)
          } else {
            const freshArchived = new Set(freshArchivedIds.map(String))
            const freshRecordIds = new Set(freshStates.map(state => state.sessionId))
            const freshLiveIds = new Set(freshLive.map(String))
            // G2: both reads must agree the id is record-less, still archived
            // and not live.
            const confirmed = sweepCandidates.filter(id => freshArchived.has(id)
              && !freshRecordIds.has(id) && !freshLiveIds.has(id))
            // G3: the decisive per-candidate authoritative existence probe.
            sweptOrphanMembers = await this.selectContentFreeCandidates(confirmed, recordError)
          }
        } catch (error) {
          // Error isolation (requirement: a sweep failure must never abort or
          // erase the completed deletions). Only known domain failures are
          // swallowed — an unexpected programming failure stays an internal
          // throw, exactly like the snapshot read.
          if (!(error instanceof ArchiveCleanupError)) throw error
          recordError('', 'archive-set', `archiveCleanup: orphan sweep skipped — ${error.message}`)
        }
      }
    }
    // The archived-set members of every completed tree are removed LAST in
    // ONE official write (root ids stay archived until their whole subtree is
    // gone; a crash before this point leaves a re-enumerable remainder).
    // Covered archived descendants of a completed tree ride the same write.
    // Swept orphan set members (no session record) carry no content —
    // removing their membership is the whole operation and is safe at any
    // point; they are double-confirmed above. DEDUPE (review round 2026-09):
    // when an archived subagent-origin row precedes its ancestor in
    // archived-set order both may be tree roots, and the same id can land in
    // completedRoots AND later in coveredArchivedMembers under the ancestor's
    // completed tree — duplicates are harmless for the binding (its Set
    // filter dedupes) but the wire record must stay clean.
    const clearIds = [...new Set([...completedRoots, ...coveredArchivedMembers, ...sweptOrphanMembers])]
    let clearedOrphanMembers = 0
    if (clearIds.length > 0) {
      try {
        await this.host.removeArchivedSessionIds(clearIds)
        // Counted only after the single official write SUCCEEDED: a failed
        // write leaves every id archived, so the honest swept count is zero.
        clearedOrphanMembers = sweptOrphanMembers.length
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
      ...(clearedOrphanMembers > 0 ? { clearedOrphanMembers } : {}),
    }
  }
}
