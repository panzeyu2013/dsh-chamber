/**
 * Shared in-memory host fixtures for the archive-cleanup core suite: the state helpers,
 * FakeHost and buildHost. Never a test entry point.
 */

import {
  ArchiveCleanupError,
  type ArchivedSessionState,
  type ArchiveCleanupHost,
  type SessionContentDeletion,
} from '../../src/core.ts'

export function state(id: string, running = false): ArchivedSessionState {
  return { sessionId: id, running }
}

export function subagent(id: string, parentSessionId: string, running = false): ArchivedSessionState {
  return { sessionId: id, origin: 'subagent', parentSessionId, running }
}

/** One-shot/per-session injectable failure: sessionId → { code, remaining }. */
export interface InjectedFailure {
  readonly code: string
  remaining: number
}

export class FakeHost implements ArchiveCleanupHost {
  readonly archived = new Set<string>()
  readonly states = new Map<string, ArchivedSessionState>()
  /** RUNNING ids (agent executing a turn) — never deletable. */
  readonly live = new Set<string>()
  /** LOADED-only ids (attached, idle) — deletable only under `force`. */
  readonly loaded = new Set<string>()
  readonly deleteLog: string[] = []
  readonly removedFromArchived: string[] = []
  readonly emittedRemoved: string[] = []
  changedEvents = 0
  /** sessionId → injectable delete failures (decrement per call). */
  readonly failDeletes = new Map<string, InjectedFailure>()
  /** Whole-batch archived-set-removal failures remaining (single setState). */
  removalFailureRemaining = 0
  /** When set, deleting this session also flips `liveAddOnDelete` live (a
   *  deterministic mid-run running-flip hook). */
  liveAddOnDeleteOf?: string
  liveAddOnDelete?: string
  /** When set, deleting this session first ATTACHES it to the live store
   *  (models a session another client opens after the tree-level recheck —
   *  the mid-run residency race the plan-time snapshot cannot see). */
  attachOnDeleteOf?: string
  failStateRead = false
  failLiveRead = false
  /** Crash simulation: throw after this many successful content deletions. */
  crashAfterDeleteCount: number | null = null
  /** Regression counters (design 24 perf review): purge must read the state
   *  corpus ONCE and only re-read the cheap live set per tree. */
  stateListCalls = 0
  liveListCalls = 0
  readonly removalCalls: string[][] = []
  /** Every listSessionStates call (successful or failed) — lets a test fail
   *  exactly the orphan sweep's confirmation read (call 2) while the run's
   *  snapshot read (call 1) succeeds. */
  stateReadAttempts = 0
  failStateReadOnAttempt: number | null = null
  /** Hook: on the Nth listSessionStates call, ADD these records before
   *  returning (models an id the snapshot read transiently missed but the
   *  confirmation read lists — gate G2). */
  addStatesOnStateRead: { attempt: number; states: readonly ArchivedSessionState[] } | null = null
  /** Hook: return an EMPTY corpus on this listSessionStates call (models a
   *  confirmation read that collapses to empty — gate G1b). */
  emptyStateReadOnAttempt: number | null = null
  /** Every listArchivedSessionIds call (call 1 = snapshot, call 2 = the sweep
   *  confirmation read). */
  archivedListCalls = 0
  /** Hook: on the Nth listArchivedSessionIds call, REMOVE this id from the
   *  live archived set before returning (models a concurrent purge in another
   *  shell that cleared the membership first — gate G2 must not double-clear). */
  removeArchivedOnArchivedRead: { attempt: number; id: string } | null = null
  /** DECISIVE existence-probe bookkeeping (2026-12 blocker fix). Default
   *  notion of "content": a record exists in `states`. `contentIds` declares
   *  content-bearing ids the BULK reads omit (the blocker case). */
  readonly contentIds = new Set<string>()
  readonly probeCalls: string[] = []
  /** Probe failures injected as ArchiveCleanupError codes (per-id, remaining). */
  readonly failContentProbes = new Map<string, InjectedFailure>()
  /** Ids whose probe throws a RAW (non-domain) error — must still fail closed. */
  readonly rawContentProbeFailures = new Set<string>()

  async listArchivedSessionIds(): Promise<string[]> {
    this.archivedListCalls += 1
    const hook = this.removeArchivedOnArchivedRead
    if (hook !== null && hook.attempt === this.archivedListCalls) this.archived.delete(hook.id)
    return [...this.archived]
  }

  async listSessionStates(): Promise<ArchivedSessionState[]> {
    this.stateReadAttempts += 1
    if (this.failStateRead || this.failStateReadOnAttempt === this.stateReadAttempts) {
      throw new ArchiveCleanupError('registry-unreadable', 'fake: state read failed')
    }
    this.stateListCalls += 1
    if (this.emptyStateReadOnAttempt === this.stateReadAttempts) return []
    const hook = this.addStatesOnStateRead
    if (hook !== null && hook.attempt === this.stateReadAttempts) {
      for (const state of hook.states) this.states.set(state.sessionId, state)
    }
    // The REAL host record corpus is a UNION (sessionQuery.listSessions() ∪
    // persistence.list()): its live leg keeps serving a header for every
    // ATTACHED session even after that session's content is gone, so a resident
    // member never becomes record-less while the process lives (vendor
    // session-query corpus.ts). Model it — a fixture that returned only the
    // durable states made a resident member look record-less on the rerun,
    // which is what let the old "the rerun plans no tree and stays silent"
    // assertion pass (2026-13 review).
    const attached = new Set([...this.live, ...this.loaded])
    const liveOnly = [...attached]
      .filter(id => !this.states.has(id))
      .map(id => ({ sessionId: id, running: this.live.has(id) } as ArchivedSessionState))
    return [...this.states.values(), ...liveOnly]
  }

  /** Fail ONLY the Nth live read (1-based). Used to fail the final pre-write
   *  re-check while the run's earlier reads succeed. */
  failLiveReadOnCall: number | null = null

  async listLiveSessionFacts(): Promise<{ running: string[]; loaded: string[] }> {
    this.liveListCalls += 1
    if (this.failLiveRead || this.failLiveReadOnCall === this.liveListCalls) {
      throw new ArchiveCleanupError('registry-unreadable', 'fake: live read failed')
    }
    // Mirror the binding: running ⊆ loaded (a running agent is attached too).
    return { running: [...this.live], loaded: [...new Set([...this.live, ...this.loaded])] }
  }

  /** Attach this id when the orphan sweep probes content — i.e. AFTER every
   *  tree deletion and BEFORE the single archived-set write. That is the late
   *  window the final live re-check exists for (2026-13 review). */
  attachOnSweepProbe: string | null = null

  async hasStoredContent(sessionId: string): Promise<boolean> {
    this.probeCalls.push(sessionId)
    if (this.attachOnSweepProbe !== null) {
      this.loaded.add(this.attachOnSweepProbe)
      this.attachOnSweepProbe = null
    }
    const injected = this.consumeFailure(this.failContentProbes, sessionId)
    if (injected !== null) {
      throw new ArchiveCleanupError(injected, `fake: content probe failed for ${sessionId}`)
    }
    if (this.rawContentProbeFailures.has(sessionId)) {
      throw new Error(`fake: raw content probe failure for ${sessionId}`)
    }
    return this.states.has(sessionId) || this.contentIds.has(sessionId)
  }

  private consumeFailure(map: Map<string, InjectedFailure>, sessionId: string): string | null {
    const failure = map.get(sessionId)
    if (failure === undefined || failure.remaining <= 0) return null
    failure.remaining -= 1
    if (failure.remaining === 0) map.delete(sessionId)
    return failure.code
  }

  /** Protected sets the core passed into deleteSessionContent; the fake
   *  refuses them exactly like the real binding's invariant guard. */
  readonly protectedSeen = new Set<string>()

  async deleteSessionContent(
    sessionId: string,
    _cwd?: string,
    force = false,
    protectedIds?: ReadonlySet<string>,
  ): Promise<SessionContentDeletion> {
    if (protectedIds !== undefined && protectedIds.has(sessionId)) {
      for (const id of protectedIds) this.protectedSeen.add(id)
      throw new ArchiveCleanupError('protected', `fake: ${sessionId} is protected`)
    }
    const injected = this.consumeFailure(this.failDeletes, sessionId)
    if (injected !== null) {
      throw new ArchiveCleanupError(injected, `fake: delete failed for ${sessionId}`)
    }
    if (this.attachOnDeleteOf === sessionId) this.loaded.add(sessionId)
    if (this.live.has(sessionId)) {
      throw new ArchiveCleanupError('running', `fake: ${sessionId} is running`)
    }
    if (!force && this.loaded.has(sessionId)) {
      throw new ArchiveCleanupError('loaded', `fake: ${sessionId} is loaded`)
    }
    // Residency at THIS instant, exactly like the real binding (running ∪
    // loaded): the core retains the archived membership of a resident root.
    const resident = this.live.has(sessionId) || this.loaded.has(sessionId)
    if (!this.states.has(sessionId)) return { outcome: 'missing', resident }
    this.states.delete(sessionId)
    this.deleteLog.push(sessionId)
    if (this.crashAfterDeleteCount !== null && this.deleteLog.length >= this.crashAfterDeleteCount) {
      throw new Error('fake: process crashed mid-purge')
    }
    if (this.liveAddOnDeleteOf !== undefined && this.liveAddOnDelete !== undefined && sessionId === this.liveAddOnDeleteOf) {
      this.live.add(this.liveAddOnDelete)
    }
    return { outcome: 'deleted', resident }
  }

  async removeArchivedSessionIds(ids: readonly string[]): Promise<void> {
    if (this.removalFailureRemaining > 0) {
      this.removalFailureRemaining -= 1
      throw new ArchiveCleanupError('storage', 'fake: batched set removal failed')
    }
    this.removalCalls.push([...ids])
    for (const sessionId of ids) {
      this.archived.delete(sessionId)
      this.removedFromArchived.push(sessionId)
    }
  }

  async emitSessionRemoved(sessionId: string): Promise<void> {
    this.emittedRemoved.push(sessionId)
  }

  async emitArchivedSessionsChanged(): Promise<void> {
    this.changedEvents += 1
  }
}

/** Default fixture: s1 (archived, chain a1 → a1a), s2 (archived, leaf),
 *  s3 (archived) with a DURABLE-RUNNING child b1, orphan id s-orphan (in the
 *  archived set with NO session record — the registry-global sweep subject),
 *  and a live non-archived sibling s4 that must never be touched. */
export function buildHost(): FakeHost {
  const host = new FakeHost()
  host.archived.add('s1')
  host.states.set('s1', state('s1'))
  host.states.set('a1', subagent('a1', 's1'))
  host.states.set('a1a', subagent('a1a', 'a1'))
  host.archived.add('s2')
  host.states.set('s2', state('s2'))
  host.archived.add('s3')
  host.states.set('s3', state('s3'))
  host.states.set('b1', subagent('b1', 's3', true))
  host.archived.add('s-orphan')
  host.states.set('s4', state('s4'))
  return host
}
