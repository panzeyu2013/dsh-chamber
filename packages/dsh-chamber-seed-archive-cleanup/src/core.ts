/**
 * Archived-session content cleanup core (design 24 §4).
 * TRUST BOUNDARY: callers arrive over the host wire as untrusted JSON; their session-id
 * inputs can only SHRINK the deletion set (candidates = intersection with the authoritative
 * archived set read at run start; a protected id only ever removes trees), and host
 * capabilities arrive only through the `ArchiveCleanupHost` seam bound to vendor-verified
 * official primitives (else `host-binding-pending`).
 * Guarantees: children-first deletion with the archived member removed LAST; running/loaded
 * and PROTECTED subtrees skipped WHOLE (protection outranks `force`); per-session isolation;
 * idempotent; RESIDENT-RETAINED membership keeps a just-deleted attached row hidden; the
 * orphan sweep removes record-less membership only, TRIPLE-gated (fail-closed throughout).
 */

/** Defensive capacity: bounds archived-set members accounted by one purge —
 *  their content descendants are not separately counted. */
export const MAX_PURGE_SESSIONS = 65_536
/** Upper bound on per-item error records returned by one purge. */
export const MAX_PURGE_ERROR_RECORDS = 1_000
/**
 * Per-run budget on authoritative `hasStoredContent` probes; each is a full
 * official persistence read, so it is tighter than the member capacity. A
 * truncated sweep leaves the remainder archived (converges on a later run) and
 * records one run-level `archive-set` note.
 */
export const MAX_SWEEP_CONTENT_PROBES = 4_096

export interface ArchivedSessionState {
  readonly sessionId: string
  /** Coarse durable origin (wire: absent or 'subagent'). */
  readonly origin?: 'subagent'
  /** Link to the parent session (subagent-origin rows only). */
  readonly parentSessionId?: string
  /** Canonical working directory (header cwd) — lets the binding resolve the
   *  official artifact WITHOUT re-enumerating the corpus per delete. */
  readonly cwd?: string
}

/**
 * The host capability seam: implementations MUST be built on official in-process primitives
 * verified against the pinned vendor, else refuse loudly with `ArchiveCleanupError` code
 * `host-binding-pending` rather than guess a layout. Live-session facts at one instant,
 * split by WHY a session is live: `running` (executing a turn — deletion NEVER allowed,
 * even under `force`; a live writer recreates a header-less artifact) vs `loaded` (attached
 * but idle — refused by default, deletable only under explicit `force` after the caller
 * terminated the run; archived sessions have no UI route to start one).
 */
interface LiveSessionFacts {
  readonly running: readonly string[]
  readonly loaded: readonly string[]
}

/**
 * One session-content deletion outcome. `resident` answers the one question
 * the caller cannot answer from its own snapshot: is this session STILL
 * attached to this host process right now? The official session list is
 * live-preferred (`sessionQuery.listSessions()` merges the durable scan with
 * `ctx.sessions.list()`), so a resident row keeps being served after its files
 * are deleted — and the archived set is the ONLY thing hiding it. Clearing
 * that membership would resurface the just-deleted row as an ordinary session.
 */
export interface SessionContentDeletion {
  /** 'deleted' = this call removed content; 'missing' = nothing was there. */
  readonly outcome: 'deleted' | 'missing'
  /** TRUE when the session was still attached in THIS process at the deletion
   *  instant (running is refused earlier). Fail-closed: when the binding cannot
   *  prove the session is gone from the process it answers true — retention
   *  only ever keeps a row hidden, never exposes one. */
  readonly resident: boolean
}

export interface ArchiveCleanupHost {
  /** The authoritative archived id set (registry-global). */
  listArchivedSessionIds(): Promise<readonly string[]>
  /** Session records needed to walk the subagent lineage and the durable
   *  running bit (authoritative storage, never a client projection). */
  listSessionStates(): Promise<readonly ArchivedSessionState[]>
  /** Live-session facts at this moment (running guard + force-deletable
   *  loaded set). */
  listLiveSessionFacts(): Promise<LiveSessionFacts>
  /**
   * DECISIVE per-candidate authoritative existence check: true when the OFFICIAL persistence
   * can still materialize a record for `sessionId` (it HAS content), false ONLY on the
   * official "no materialized durable log" answer. Bulk enumerations can narrow silently, so
   * "absent from the snapshot" never proves "no content" — the archived set
   * (`<dshHome>/storages`) and the content root (`<dshHome>/sessions`) can diverge, so the
   * sweep MUST ask this authoritative single-id read before clearing any membership, and MUST
   * fail CLOSED: only an explicit not-found answer returns false; every other outcome
   * (corruption, unsupported format, IO failure, absent service, drifted shape) returns TRUE.
   */
  hasStoredContent(sessionId: string): Promise<boolean>
  /**
   * Delete one session's content through the official primitive (children already deleted by
   * the caller). `cwd` is the snapshot header cwd so the binding resolves the artifact
   * without a per-delete re-enumeration. Refuse a RUNNING session unconditionally
   * (`running`); refuse a merely LOADED (idle) session (`loaded`) unless `force` — the
   * mid-window gate, since the core keeps no per-member pre-check; as the first in-tree
   * failure it aborts the rest of that tree. Members of `protectedIds` MUST be refused with
   * code `protected` (invariant guard for the whole-tree skip). Returns the outcome
   * ('missing' is an idempotent no-op) and residency at that instant — `resident` true
   * forces the caller to RETAIN the membership rather than un-hide a session in memory.
   */
  deleteSessionContent(
    sessionId: string,
    cwd?: string,
    force?: boolean,
    protectedIds?: ReadonlySet<string>,
  ): Promise<SessionContentDeletion>
  /** Remove ids from the archived set in ONE official write (one atomic write
   *  per run instead of N per tree). */
  removeArchivedSessionIds(ids: readonly string[]): Promise<void>
}

interface PurgeItemError {
  readonly sessionId: string
  readonly code: string
  readonly message: string
}

export interface PurgeResult {
  readonly deletedSessions: number
  readonly deletedSubagents: number
  readonly skippedRunning: number
  /** Roots skipped only because a member is loaded (never deleted; archived). */
  readonly skippedLoaded: number
  /** Roots skipped WHOLE because a member of their subtree closure is protected
   *  (`protectSessionIds`). Protection outranks `force`: never cut, never
   *  partially deleted, membership kept. Counted per tree root. */
  readonly skippedProtected: number
  /** Tree roots whose content this run deleted DESPITE a loaded member, under
   *  authorized `force`. Only actually-removed content counts. */
  readonly forcedLoaded: number
  /** Tree roots whose archived membership was KEPT because their session is
   *  still resident in this process: the content is gone, but the live-preferred
   *  corpus keeps serving the row and the archived set is the only thing hiding
   *  it (retention only ever keeps a row hidden). The leftovers converge by a
   *  later run's orphan sweep after the instance restarts. */
  readonly residentRetainedRoots?: readonly string[]
  readonly errors: readonly PurgeItemError[]
  /** True when item errors were truncated at MAX_PURGE_ERROR_RECORDS. */
  readonly truncated?: boolean
  /** Archived-set members removed by the registry-global ORPHAN SWEEP this run
   *  (record-less ids). Present only when at least one member was swept and the
   *  single official write succeeded. DELIBERATELY NOT part of the deletion
   *  counts — the sweep deletes no content. */
  readonly clearedOrphanMembers?: number
}

interface ArchiveCleanupDomainError {
  readonly code: string
  readonly message: string
  readonly retryable?: boolean
}

/** Explicit business carrier: the generic dsh gateway does not preserve thrown error fields (git-worktree parity). */
export type ArchiveCleanupDomainResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ArchiveCleanupDomainError }

/** Stable action error code (serialized over the wire):
 *  `busy` — another purge is in flight (host single-flight);
 *  `registry-unreadable` — a precondition read failed, nothing mutated;
 *  `host-binding-pending` — a host capability is not wired, domain disabled;
 *  `purge-capacity` / `invalid-request` — the candidate set or a filter
 *  exceeded MAX_PURGE_SESSIONS (nothing mutated).
 *  Per-item failures are NOT thrown: they land in `PurgeResult.errors` (codes
 *  `missing`, `running`, `loaded`, `protected`, `storage`); run-level failures
 *  that must not abort completed deletions use code `archive-set` with an
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

/** Single in-package description of an unknown thrown value (no second copy). */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

/** Strongest liveness found anywhere in one uninterrupted subtree. */
type SubtreeLiveness = 'running' | 'loaded' | 'clear'

/**
 * Classify one session subtree (root plus every uninterrupted subagent-origin
 * descendant): 'running' wins over 'loaded', which wins over 'clear' —
 * fail-closed, the strongest member decides.
 */
export function subtreeLiveness(
  sessionId: string,
  childrenOf: ReadonlyMap<string, readonly string[]>,
  facts: { readonly running: ReadonlySet<string>; readonly loaded: ReadonlySet<string> },
): SubtreeLiveness {
  const visited = new Set<string>()
  const queue = [sessionId]
  let sawLoaded = false
  while (queue.length > 0) {
    const current = queue.shift() as string
    if (visited.has(current)) continue
    visited.add(current)
    if (facts.running.has(current)) return 'running'
    if (facts.loaded.has(current)) sawLoaded = true
    for (const child of childrenOf.get(current) ?? []) queue.push(child)
  }
  return sawLoaded ? 'loaded' : 'clear'
}


interface DeletableTree {
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

/** Children-first post-order over one subtree (cycle-guarded, iterative);
 *  `order[0]` is the deepest leaf, the root last. Needs the closure BEFORE the
 *  liveness gates so a PROTECTED tree is recognised even when running/loaded. */
function subtreeOrder(
  rootSessionId: string,
  childrenOf: ReadonlyMap<string, readonly string[]>,
): string[] {
  const order: string[] = []
  const visited = new Set<string>()
  // Iterative post-order: an explicit stack keeps arbitrarily deep lineage
  // chains safe; the cycle guard skips an edge back to a visited ancestor.
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
  return order
}

/**
 * The "live/attached" id set the orphan predicate excludes: running ∪ loaded —
 * either state means a real writer or an attached agent, so the membership must
 * never be swept even if the durable corpus momentarily fails to list a record.
 */
export function liveSessionIdsOf(
  facts: {
    readonly running: readonly string[] | ReadonlySet<string>
    readonly loaded: readonly string[] | ReadonlySet<string>
  },
): Set<string> {
  return new Set<string>([...facts.running, ...facts.loaded])
}

/**
 * Registry-global ORPHAN SWEEP predicate: archived-set members with NO session record at
 * all — no content to delete and no row in any official session list, so they are
 * unreachable through the archive manager (rows ∩ set) and would accumulate forever.
 * Widens the per-candidate orphan predicate's SCOPE to the WHOLE archived set, adding
 * ZERO content-deletion semantics: only the record-less membership is removed.
 * Fail-closed: `statesBySession` must come from a SUCCESSFUL enumeration (an id is never
 * assumed record-less), and `liveSessionIds` (running ∪ loaded) is defense-in-depth — a
 * live/attached id never loses its membership. A successful enumeration is NOT proof of
 * absent content, so `purge` still requires the credibility guards and the decisive probe.
 */
export function orphanArchivedMembers(
  archivedIds: readonly string[],
  statesBySession: ReadonlyMap<string, ArchivedSessionState>,
  liveSessionIds: ReadonlySet<string>,
): string[] {
  const orphans: string[] = []
  for (const id of archivedIds) {
    if (statesBySession.has(id)) continue
    if (liveSessionIds.has(id)) continue
    orphans.push(id)
  }
  return orphans
}

/** Shape/capacity validation shared by purge's session-id filters (deletion
 *  subset and protected set): malformed or oversized refuses the whole request
 *  with `invalid-request` and mutates nothing. */
function assertSessionIdFilter(field: string, value: readonly string[] | undefined): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || id === '')) {
    throw new ArchiveCleanupError(
      'invalid-request',
      `archiveCleanup: purge ${field} must be an array of non-empty session id strings`,
    )
  }
  if (value.length > MAX_PURGE_SESSIONS) {
    throw new ArchiveCleanupError(
      'invalid-request',
      `archiveCleanup: purge ${field} exceeds ${MAX_PURGE_SESSIONS} entries`,
    )
  }
}

/** The pure orchestration core (design 24 §4 steps 1–7). */
export class ArchiveCleanupCore {
  private readonly host: ArchiveCleanupHost

  constructor(host: ArchiveCleanupHost) {
    this.host = host
  }

  /** Step 1–3 read pass of every purge run. */
  private async readAuthoritativeState(): Promise<{
    archivedIds: string[]
    statesBySession: Map<string, ArchivedSessionState>
    childrenOf: Map<string, readonly string[]>
    liveFacts: { running: Set<string>; loaded: Set<string> }
    /** Raw number of session records the snapshot returned (before
     *  de-duplication); the sweep credibility guard keys on it. */
    snapshotRecordCount: number
  }> {
    let archivedIds: readonly string[]
    let states: readonly ArchivedSessionState[]
    let live: LiveSessionFacts
    try {
      ;[archivedIds, states, live] = await Promise.all([
        this.host.listArchivedSessionIds(),
        this.host.listSessionStates(),
        this.host.listLiveSessionFacts(),
      ])
    } catch (error) {
      if (error instanceof ArchiveCleanupError) throw error
      throw new ArchiveCleanupError('registry-unreadable', `归档状态不可读：${errorText(error)}`)
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
      liveFacts: {
        running: new Set(live.running.map(String)),
        loaded: new Set(live.loaded.map(String)),
      },
      snapshotRecordCount: states.length,
    }
  }

  /** Resolve the run plan: candidate roots not already covered by another
   *  deletable root's subtree, each mapped to its deletable tree, else skipped
   *  (running / loaded without `force` / closure contains a PROTECTED id).
   *  Candidates are the full archived set or the requested subset ∩ archived
   *  set; a root that is a subagent descendant of an earlier deletable root is
   *  covered and skipped (no double deletion). Orphan candidates (no session
   *  record) are no tree — the registry-global sweep covers them. PROTECTION is
   *  checked against the FULL closure (a protected descendant protects its
   *  ancestor tree) and BEFORE liveness, since protection outranks `force`. */
  private resolvePlan(
    candidateIds: readonly string[],
    statesBySession: ReadonlyMap<string, ArchivedSessionState>,
    childrenOf: ReadonlyMap<string, readonly string[]>,
    liveFacts: { readonly running: ReadonlySet<string>; readonly loaded: ReadonlySet<string> },
    force: boolean,
    protectedIds: ReadonlySet<string> = new Set<string>(),
  ): { trees: DeletableTree[]; skippedRunning: number; skippedLoaded: number; skippedProtected: number } {
    const trees: DeletableTree[] = []
    let skippedRunning = 0
    let skippedLoaded = 0
    let skippedProtected = 0
    const covered = new Set<string>()
    for (const id of candidateIds) {
      // Covered check FIRST: a deletable ancestor implies every member is
      // non-running, so a covered descendant needs no BFS — O(A) not O(A²).
      if (covered.has(id)) continue
      if (!statesBySession.has(id)) {
        // Orphan/archived id without a session record — nothing to delete;
        // its set membership is cleared by the registry-global orphan sweep.
        continue
      }
      // Classification order: closure FIRST, then protection, then liveness —
      // protection is authoritative over `force`.
      const order = subtreeOrder(id, childrenOf)
      if (protectedIds.size > 0 && order.some(member => protectedIds.has(member))) {
        skippedProtected += 1
        continue
      }
      const liveness = subtreeLiveness(id, childrenOf, liveFacts)
      if (liveness === 'running') {
        // A running member is never deletable (a live writer recreates a
        // header-less artifact) — the client stops the run first.
        skippedRunning += 1
        continue
      }
      if (liveness === 'loaded' && !force) {
        // Loaded-only skip: deletable through an explicit force purge after
        // the caller terminated the run.
        skippedLoaded += 1
        continue
      }
      for (const member of order) covered.add(member)
      trees.push({ rootSessionId: id, order, subagentCount: order.length - 1 })
    }
    return { trees, skippedRunning, skippedLoaded, skippedProtected }
  }

  /**
   * DECISIVE sweep gate: keep only candidates the OFFICIAL persistence proves it cannot
   * materialize. Fail-closed rules, in order:
   *  - capability absent ⇒ NOTHING is swept, one run-level note;
   *  - the probe throws ⇒ that candidate keeps its membership (a failed check is "may have
   *    content"), one run-level note summarizes the failures;
   *  - any return other than the exact boolean `false` ⇒ keeps its membership;
   *  - at most MAX_SWEEP_CONTENT_PROBES probes per run; the truncated remainder stays
   *    archived (converges later) with one run-level note.
   * The probe is invoked AS A METHOD (instance-state classes — a detached call loses `this`).
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
          firstProbeFailure = errorText(error)
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

  /**
   * Delete the content of every archived session (children-first, archived member removed
   * last — ONE batched set removal at the end). `sessionIds` (optional) limits candidate
   * roots to archived members; it can never extend the deletion set (candidates =
   * intersection with the authoritative archived set read at run start) and a listed id
   * already gone is an idempotent no-op. `undefined` = full set; an EMPTY array deletes NO
   * content (the orphan sweep still runs); counts are per TREE ROOT. `force` also deletes
   * merely-loaded subtrees (the caller MUST have terminated the run first); running members
   * are always refused.
   * SWEEP / RESIDENT RETENTION / `protectSessionIds` semantics and the performance contract
   * (snapshot read ONCE; first in-tree failure aborts the remaining members of that tree,
   * ancestors/root staying archived for a convergent rerun): see the run body.
   */
  async purge(
    sessionIds?: readonly string[],
    force = false,
    protectSessionIds?: readonly string[],
  ): Promise<PurgeResult> {
    // Filter validation runs BEFORE the authoritative read: a malformed or
    // oversized request must not pay a full registry + corpus scan. EMPTY means
    // delete-nothing content subset, never full-set; the sweep still runs.
    assertSessionIdFilter('subset filter', sessionIds)
    assertSessionIdFilter('protected set', protectSessionIds)
    // The protected set can only ever SHRINK the deletion set, so an unknown or
    // stale id is a silent no-op — the same fail-closed direction as the filter.
    const protectedIds = new Set<string>(protectSessionIds ?? [])
    const { archivedIds, statesBySession, childrenOf, liveFacts, snapshotRecordCount } = await this.readAuthoritativeState()
    let candidates: readonly string[]
    if (sessionIds === undefined) {
      if (archivedIds.length > MAX_PURGE_SESSIONS) {
        throw new ArchiveCleanupError('purge-capacity', `archived set exceeds the ${MAX_PURGE_SESSIONS}-session purge capacity`)
      }
      candidates = archivedIds
    } else {
      const selected = new Set(sessionIds)
      // Intersection with the authoritative set, in set order: listed-but-gone
      // ids are no candidates (idempotent skip, never an error).
      candidates = archivedIds.filter(id => selected.has(id))
    }
    // Snapshot membership: lets the end-of-run batched removal also clear
    // archived descendants covered by a completed tree in the same run.
    const archivedAtStart = new Set<string>(archivedIds)
    // Sweep candidates: record-less members of the WHOLE archived set (the
    // subset filter does not limit this), same authoritative snapshot. The
    // capacity bounds it exactly like a full-set purge; PROTECTED ids are
    // excluded (a sweep must never un-archive a row the client is viewing).
    const sweepCandidates = archivedIds.length <= MAX_PURGE_SESSIONS
      ? orphanArchivedMembers(archivedIds, statesBySession, liveSessionIdsOf(liveFacts))
        .filter(id => !protectedIds.has(id))
      : []
    const plan = this.resolvePlan(candidates, statesBySession, childrenOf, liveFacts, force, protectedIds)
    let deletedSessions = 0
    let deletedSubagents = 0
    let forcedLoaded = 0
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
    // Roots whose membership is RETAINED because the session is still resident:
    // content gone but the live-preferred corpus keeps serving the row.
    const residentRetainedRoots: string[] = []
    for (const tree of plan.trees) {
      // TREE-LEVEL protection re-check (belt-and-braces over resolvePlan):
      // never START deleting a partially protected tree — prefix deletions are
      // not rolled back. Recorded as an invariant violation when it fires.
      if (protectedIds.size > 0 && tree.order.some(member => protectedIds.has(member))) {
        plan.skippedProtected += 1
        recordError(
          tree.rootSessionId,
          'archive-set',
          `archiveCleanup: skipped ${tree.rootSessionId}: its subtree contains a protected id (invariant violation — the plan must have skipped this tree)`,
        )
        continue
      }
      // Cheap in-memory live refresh only: the durable snapshot stays fixed for
      // the run (single-flight + idempotent deletion). Feeds the TREE-level
      // running recheck only — a mid-tree flip is caught by the binding.
      let nowFacts: { running: Set<string>; loaded: Set<string> }
      try {
        const facts = await this.host.listLiveSessionFacts()
        nowFacts = { running: new Set(facts.running.map(String)), loaded: new Set(facts.loaded.map(String)) }
      } catch (error) {
        if (error instanceof ArchiveCleanupError) throw error
        throw new ArchiveCleanupError('registry-unreadable', `live agent 状态不可读：${errorText(error)}`)
      }
      const liveness = subtreeLiveness(tree.rootSessionId, childrenOf, nowFacts)
      if (liveness === 'running') {
        plan.skippedRunning += 1
        continue
      }
      if (liveness === 'loaded' && !force) {
        plan.skippedLoaded += 1
        continue
      }
      // The whole-subtree skip holds up to each member's deletion instant; the
      // binding's delete-time live guard is the ONLY mid-window gate.
      // ABORT SEMANTICS: the FIRST in-tree failure stops the REMAINING members
      // of this tree (ancestors and the root stay archived, so a later purge
      // re-enumerates the intact remainder and converges). Members already
      // deleted stay deleted — prefix deletions are not rolled back. Never
      // delete ancestors past a failed member: the root's record lives inside
      // its own content directory, so clearing the root would make the NEXT run
      // treat it as an orphan and clear it WITHOUT re-enumerating the survivor
      // — a permanent silent content leak.
      let treeAborted = false
      // The root's content outcome feeds the force accounting below.
      let rootDeleted = false
      // Residency is collected for EVERY member, not just the root: a
      // descendant attached after the tree recheck reports `resident` at its own
      // deletion instant, and ignoring it would un-hide a subagent one level down.
      let memberResident = false
      for (const sessionId of tree.order) {
        const state = statesBySession.get(sessionId)
        try {
          // Every member except the root is a subagent-origin descendant.
          const deletion = await this.host.deleteSessionContent(sessionId, state?.cwd, force, protectedIds)
          if (deletion.resident) memberResident = true
          if (sessionId === tree.rootSessionId) {
            rootDeleted = deletion.outcome === 'deleted'
            if (rootDeleted) deletedSessions += 1
          } else if (deletion.outcome === 'deleted') {
            deletedSubagents += 1
          }
        } catch (error) {
          if (!(error instanceof ArchiveCleanupError)) throw error
          // First in-tree failure — abort the remaining members: the refused
          // member survives under an archived root and a later purge re-runs it.
          treeAborted = true
          recordError(sessionId, error.code, error.message)
          break
        }
      }
      if (treeAborted) {
        // Crash consistency: the root stays archived until the WHOLE subtree is
        // provably gone, so a rerun re-enumerates the remainder and converges.
        continue
      }
      // ---- RETAINED MEMBERSHIP for resident trees ----
      // A completed tree still RESIDENT in this process keeps its archived
      // membership: the content is gone, but the live-preferred corpus keeps
      // serving the row and the archived set is the only thing hiding it.
      // Two independent signals: a loaded tree-level recheck (the force path),
      // or ANY member reporting residency at its own deletion instant (attached
      // after the recheck, e.g. opened by another client mid-run). Retaining is
      // fail-closed: it keeps a row hidden, never exposes one. The whole tree is
      // retained so no partial membership is left behind; leftovers converge by
      // a later run's orphan sweep once the process ends.
      const retained = liveness === 'loaded' || memberResident
      if (retained) {
        residentRetainedRoots.push(tree.rootSessionId)
        // Count only a root whose content THIS run removed — an already-gone resident root was not force-deleted.
        if (rootDeleted) forcedLoaded += 1
        continue
      }
      completedRoots.push(tree.rootSessionId)
      for (const member of tree.order) {
        // An archived descendant covered by this completed tree is cleared in
        // the SAME run — no marker lag to a later orphan pass.
        if (member !== tree.rootSessionId && archivedAtStart.has(member)) {
          coveredArchivedMembers.push(member)
        }
      }
    }
    // ---- Registry-global orphan sweep ----
    // A sweep candidate has no record in the SNAPSHOT — not proof of absence
    // (both bulk enumerations can narrow silently). Three gates, ALL required:
    //  G1 CREDIBILITY: a zero-record snapshot while members are archived, or a
    //     confirmation corpus collapsing to zero, SKIPS the sweep;
    //  G2 DOUBLE CONFIRMATION: candidates re-checked against a FRESH archived
    //     set + record corpus + live set taken after the deletions; a failed
    //     fresh read SKIPS the sweep (never guessed);
    //  G3 DECISIVE `hasStoredContent` probe: swept ONLY when the official
    //     single-id read proves it cannot materialize the id.
    // Runs only when the snapshot shows orphan members (converged instances keep
    // the single-scan contract); every skip is a run-level note, never an abort.
    let sweptOrphanMembers: string[] = []
    if (sweepCandidates.length > 0) {
      if (snapshotRecordCount === 0) {
        // G1a: an empty corpus while the archived set is non-empty is a
        // broken/narrowed enumeration — acting on it would clear everything.
        recordError('', 'archive-set', `archiveCleanup: orphan sweep skipped — the snapshot session corpus is empty while ${archivedIds.length} archived member(s) exist; an empty corpus is not credible evidence of absent content`)
      } else {
        try {
          const [freshArchivedIds, freshStates, freshLiveFacts] = await Promise.all([
            this.host.listArchivedSessionIds(),
            this.host.listSessionStates(),
            this.host.listLiveSessionFacts(),
          ])
          if (freshStates.length === 0) {
            // G1b: the confirmation corpus collapsed to empty — equally non-credible; clear nothing.
            recordError('', 'archive-set', `archiveCleanup: orphan sweep skipped — the confirmation read's session corpus collapsed to empty (snapshot had ${snapshotRecordCount} record(s)); a collapsed corpus is not credible evidence of absent content`)
          } else {
            const freshArchived = new Set(freshArchivedIds.map(String))
            const freshRecordIds = new Set(freshStates.map(state => state.sessionId))
            const freshLiveIds = liveSessionIdsOf(freshLiveFacts)
            // G2: both reads must agree the id is record-less, still archived
            // and not live.
            const confirmed = sweepCandidates.filter(id => freshArchived.has(id)
              && !freshRecordIds.has(id) && !freshLiveIds.has(id))
            // G3: the decisive per-candidate authoritative existence probe.
            sweptOrphanMembers = await this.selectContentFreeCandidates(confirmed, recordError)
          }
        } catch (error) {
          // Error isolation: a sweep failure must never abort or erase the
          // completed deletions; unexpected programming failures still throw.
          if (!(error instanceof ArchiveCleanupError)) throw error
          recordError('', 'archive-set', `archiveCleanup: orphan sweep skipped — ${error.message}`)
        }
      }
    }
    // Completed trees are removed LAST in ONE official write (root ids stay
    // archived until their whole subtree is gone). Covered archived descendants
    // ride the same write; RESIDENT-RETAINED trees never reach `completedRoots`
    // (their membership is the only thing hiding the row). Swept orphan members
    // carry no content and are double-confirmed. DEDUPE: an id can land in both
    // completedRoots and coveredArchivedMembers — the wire record must stay clean.
    const clearIds = [...new Set([...completedRoots, ...coveredArchivedMembers, ...sweptOrphanMembers])]
      // Defensive invariant: a protected id must never leave the archived set in
      // this run — skipping it keeps it archived, so a later run still sees it.
      .filter(id => !protectedIds.has(id))
    // Membership Set for the tail loops: includes() scans would be O(n²) at MAX_PURGE_SESSIONS.
    const clearIdSet = new Set(clearIds)
    // ---- LAST LIVE RE-CHECK, immediately before the batched write ----
    // This write happens after the whole run (potentially minutes later), so a
    // session attaching inside that window would be un-hidden the moment its
    // membership clears. Hence a FRESH read filters the write: an id reported
    // live is NOT cleared (a completed root among them becomes resident-retained
    // and is reported; retention can leave a partial set — the fail-closed
    // direction). A FAILED read writes nothing and records a run-level note:
    // "cannot prove nobody attached" must never clear memberships.
    let liveNow = new Set<string>()
    let liveReadFailed = false
    if (clearIds.length > 0) {
      try {
        const facts = await this.host.listLiveSessionFacts()
        liveNow = new Set([...facts.running, ...facts.loaded].map(String))
      } catch (error) {
        if (!(error instanceof ArchiveCleanupError)) throw error
        recordError('', 'archive-set', error.message)
        liveReadFailed = true
      }
    }
    for (const root of completedRoots) {
      if (!clearIdSet.has(root) || !liveNow.has(root)) continue
      residentRetainedRoots.push(root)
      // Its content WAS removed by this run while the session was live: force accounting follows the retained root.
      forcedLoaded += 1
    }
    const writeIds = liveReadFailed ? [] : clearIds.filter(id => !liveNow.has(id))
    const writeIdSet = new Set(writeIds)
    let clearedOrphanMembers = 0
    if (clearIds.length > 0) {
      try {
        if (writeIds.length > 0) await this.host.removeArchivedSessionIds(writeIds)
        // Counted only after the single official write SUCCEEDED, and only for
        // the swept members actually written (a late-retained id was not).
        clearedOrphanMembers = sweptOrphanMembers.filter(id => writeIdSet.has(id)).length
      } catch (error) {
        if (!(error instanceof ArchiveCleanupError)) throw error
        // Every listed id stays archived; the next purge re-runs them. Run-level
        // note: this record SHARES the item cap, so `truncated: true` is honest —
        // the set members stay archived and a rerun still converges.
        recordError('', 'archive-set', error.message)
      }
    }
    return {
      deletedSessions,
      deletedSubagents,
      skippedRunning: plan.skippedRunning,
      skippedLoaded: plan.skippedLoaded,
      skippedProtected: plan.skippedProtected,
      forcedLoaded,
      errors,
      ...(truncated ? { truncated: true } : {}),
      ...(clearedOrphanMembers > 0 ? { clearedOrphanMembers } : {}),
      ...(residentRetainedRoots.length > 0 ? { residentRetainedRoots } : {}),
    }
  }
}
