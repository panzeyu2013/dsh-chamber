/** Pure orchestration tests: the host (registry/storage/agents) is a full
 *  in-memory mock — no vendor, no filesystem (git-worktree core parity). */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ArchiveCleanupCore,
  ArchiveCleanupError,
  indexChildren,
  orphanArchivedMembers,
  resolveDeletableTree,
  subtreeLiveness,
  MAX_PURGE_SESSIONS,
  MAX_PURGE_ERROR_RECORDS,
  MAX_SWEEP_CONTENT_PROBES,
  type ArchivedSessionState,
  type ArchiveCleanupHost,
} from '../src/core.ts'

function state(id: string, running = false): ArchivedSessionState {
  return { sessionId: id, running }
}

function subagent(id: string, parentSessionId: string, running = false): ArchivedSessionState {
  return { sessionId: id, origin: 'subagent', parentSessionId, running }
}

/** One-shot/per-session injectable failure: sessionId → { code, remaining }. */
interface InjectedFailure {
  readonly code: string
  remaining: number
}

class FakeHost implements ArchiveCleanupHost {
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
    return [...this.states.values()]
  }

  async listLiveSessionFacts(): Promise<{ running: string[]; loaded: string[] }> {
    if (this.failLiveRead) throw new ArchiveCleanupError('registry-unreadable', 'fake: live read failed')
    this.liveListCalls += 1
    // Mirror the binding: running ⊆ loaded (a running agent is attached too).
    return { running: [...this.live], loaded: [...new Set([...this.live, ...this.loaded])] }
  }

  async hasStoredContent(sessionId: string): Promise<boolean> {
    this.probeCalls.push(sessionId)
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

  async deleteSessionContent(sessionId: string, _cwd?: string, force = false): Promise<'deleted' | 'missing'> {
    const injected = this.consumeFailure(this.failDeletes, sessionId)
    if (injected !== null) {
      throw new ArchiveCleanupError(injected, `fake: delete failed for ${sessionId}`)
    }
    if (this.live.has(sessionId)) {
      throw new ArchiveCleanupError('running', `fake: ${sessionId} is running`)
    }
    if (!force && this.loaded.has(sessionId)) {
      throw new ArchiveCleanupError('loaded', `fake: ${sessionId} is loaded`)
    }
    if (!this.states.has(sessionId)) return 'missing'
    this.states.delete(sessionId)
    this.deleteLog.push(sessionId)
    if (this.crashAfterDeleteCount !== null && this.deleteLog.length >= this.crashAfterDeleteCount) {
      throw new Error('fake: process crashed mid-purge')
    }
    if (this.liveAddOnDeleteOf !== undefined && this.liveAddOnDelete !== undefined && sessionId === this.liveAddOnDeleteOf) {
      this.live.add(this.liveAddOnDelete)
    }
    return 'deleted'
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
function buildHost(): FakeHost {
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

test('preview: counts deletable trees, subagents, running subtrees and orphans', async () => {
  const core = new ArchiveCleanupCore(buildHost())
  const preview = await core.preview()
  assert.equal(preview.archived, 4)
  assert.equal(preview.deletableSessions, 2) // s1 + s2; s3 skipped (running child), s-orphan has no record
  assert.equal(preview.deletableSubagents, 2) // a1 + a1a
  assert.equal(preview.skippedRunning, 1)
  assert.equal(preview.skippedLoaded, 0)
})

test('preview: loaded-only subtrees are reported separately from running ones', async () => {
  const host = buildHost()
  host.loaded.add('s2')
  const preview = await new ArchiveCleanupCore(host).preview()
  assert.equal(preview.skippedRunning, 1) // s3 (durable-running child)
  assert.equal(preview.skippedLoaded, 1) // s2 (attached but idle)
  assert.equal(preview.deletableSessions, 1) // s1 only under the default guard
})

test('indexChildren: uninterrupted subagent-origin children only', () => {
  const host = buildHost()
  const children = indexChildren([...host.states.values()])
  assert.deepEqual([...children.get('s1') ?? []].sort(), ['a1'])
  assert.deepEqual([...children.get('a1') ?? []], ['a1a'])
  assert.deepEqual([...children.get('s3') ?? []], ['b1'])
  assert.equal(children.has('s2'), false)
})

test('resolveDeletableTree: children-first post-order, root last; null when running or unknown', () => {
  const host = buildHost()
  const states = new Map([...host.states.entries()])
  const children = indexChildren([...states.values()])
  const facts = { running: host.live, loaded: host.loaded }
  const tree = resolveDeletableTree('s1', states, children, facts)
  assert.ok(tree !== null)
  assert.deepEqual(tree.order, ['a1a', 'a1', 's1'])
  assert.equal(tree.subagentCount, 2)
  assert.equal(resolveDeletableTree('s3', states, children, facts), null)
  assert.equal(resolveDeletableTree('nope', states, children, facts), null)
})

test('subtreeLiveness: running beats loaded beats clear; force never overrides running', () => {
  const host = buildHost()
  const states = new Map([...host.states.entries()])
  const children = indexChildren([...states.values()])
  const facts = { running: host.live, loaded: host.loaded }

  assert.equal(subtreeLiveness('s1', states, children, facts), 'clear')
  host.loaded.add('a1a')
  assert.equal(subtreeLiveness('s1', states, children, facts), 'loaded')
  // A LOADED-only subtree is deletable with force…
  assert.ok(resolveDeletableTree('s1', states, children, facts) === null)
  assert.ok(resolveDeletableTree('s1', states, children, facts, true) !== null)
  // …but a RUNNING member wins, and force does NOT override it.
  host.live.add('a1a')
  assert.equal(subtreeLiveness('s1', states, children, facts), 'running')
  assert.equal(resolveDeletableTree('s1', states, children, facts, true), null)
})

test('purge: loaded-only subtrees are skipped by default and deleted under force', async () => {
  const host = buildHost()
  // s2 is attached-but-idle (loaded); s3 keeps its durable-running child b1.
  host.loaded.add('s2')
  const core = new ArchiveCleanupCore(host)

  const skipped = await core.purge()
  assert.equal(skipped.deletedSessions, 1) // s1 only
  assert.equal(skipped.skippedRunning, 1) // s3
  assert.equal(skipped.skippedLoaded, 1) // s2
  assert.equal(skipped.forcedLoaded, 0)
  assert.equal(host.states.has('s2'), true)
  assert.deepEqual(host.archived, new Set(['s2', 's3']))

  // The default run left s2 archived; force (caller already cancelled the
  // run) deletes it — the running subtree s3 is STILL refused.
  const forced = await core.purge(['s2', 's3'], true)
  assert.equal(forced.deletedSessions, 1) // s2
  assert.equal(forced.forcedLoaded, 1)
  assert.equal(forced.skippedRunning, 1) // s3's b1 is running — force must not bypass
  assert.equal(host.states.has('s2'), false)
  assert.equal(host.states.has('s3'), true)
  assert.equal(host.states.has('b1'), true)
  assert.deepEqual(host.archived, new Set(['s3']))
})

test('purge: a running member is refused with force too (delete-time guard)', async () => {
  const host = buildHost()
  // Deleting s1's leaf a1a flips its parent a1 RUNNING inside the SAME tree —
  // only the binding's delete-time guard can catch it, and force must not
  // bypass it (a live writer would recreate the artifact).
  host.liveAddOnDeleteOf = 'a1a'
  host.liveAddOnDelete = 'a1'
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s1'], true)
  assert.deepEqual(host.deleteLog, ['a1a'])
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.code, 'running')
  assert.equal(host.states.has('a1'), true)
  assert.equal(host.states.has('s1'), true)
  // The aborted tree keeps its members archived (s1 + the unrelated running
  // s2/s3). `s-orphan` IS cleared: the registry-global orphan sweep is
  // orthogonal to this run's tree outcome and only removes members with no
  // session record at all (design 24 §20 residual ①) — it deletes no content.
  assert.deepEqual(host.archived, new Set(['s1', 's2', 's3']))
})

test('purge: deletes children-first, removes archived members last, emits events once', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.deletedSessions, 2)
  assert.equal(result.deletedSubagents, 2)
  assert.equal(result.skippedRunning, 1)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(host.deleteLog, ['a1a', 'a1', 's1', 's2'])
  assert.deepEqual(host.removedFromArchived, ['s1', 's2', 's-orphan'])
  assert.deepEqual(host.emittedRemoved, ['a1a', 'a1', 's1', 's2'])
  assert.equal(host.changedEvents, 1)
  // Only archived subtrees were touched; the running subtree and the live
  // sibling are intact.
  assert.equal(host.states.has('s3'), true)
  assert.equal(host.states.has('b1'), true)
  assert.equal(host.states.has('s4'), true)
  assert.deepEqual(host.archived, new Set(['s3']))
})

test('purge: idempotent rerun converges to the running-skipped remainder only', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  await core.purge()
  const again = await core.purge()
  assert.equal(again.deletedSessions, 0)
  assert.equal(again.deletedSubagents, 0)
  assert.equal(again.skippedRunning, 1) // s3 stays running-skipped
  assert.equal(again.errors.length, 0)
  assert.equal(host.changedEvents, 1) // nothing left to mutate → no extra event
})

test('purge: a running subtree is skipped whole and stays archived', async () => {
  const host = buildHost()
  host.live.add('b1')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.skippedRunning, 1)
  assert.equal(host.states.has('s3'), true)
  assert.equal(host.states.has('b1'), true)
  assert.deepEqual(host.archived, new Set(['s3']))
})

test('purge: mid-run running flip is caught by the per-subtree recheck', async () => {
  // s3's child b1 is durable-idle at plan time; deleting s1 flips b1 live.
  // The per-tree recheck before s3 must skip the whole subtree mid-run.
  const host = buildHost()
  host.states.set('b1', subagent('b1', 's3', false))
  host.liveAddOnDeleteOf = 's1'
  host.liveAddOnDelete = 'b1'
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.deletedSessions, 2)
  assert.equal(result.deletedSubagents, 2)
  assert.equal(result.skippedRunning, 1) // s3 flipped live between plan and its turn
  assert.equal(result.errors.length, 0)
  assert.equal(host.states.has('s3'), true)
  assert.equal(host.states.has('b1'), true)
  assert.deepEqual(host.archived, new Set(['s3']))
})

test('purge: item failure isolation — a failing subtree does not block others and keeps its archived member for a rerun', async () => {
  const host = buildHost()
  host.failDeletes.set('s2', { code: 'storage', remaining: 1 })
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.deletedSessions, 1) // s1 subtree only
  assert.equal(result.deletedSubagents, 2)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.sessionId, 's2')
  assert.equal(result.errors[0]?.code, 'storage')
  // s2 stays archived (partial failure → re-enumerable).
  assert.deepEqual(host.archived, new Set(['s2', 's3']))
  const again = await core.purge()
  assert.equal(again.deletedSessions, 1)
  assert.equal(again.errors.length, 0)
  assert.deepEqual(host.archived, new Set(['s3']))
})

test('purge: delete-time running refusal surfaces as a per-item error and keeps the member', async () => {
  const host = buildHost()
  // s2's delete refuses with `running` exactly once (plan-time it is idle).
  host.failDeletes.set('s2', { code: 'running', remaining: 1 })
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.code, 'running')
  assert.deepEqual(host.archived, new Set(['s2', 's3']))
  const again = await core.purge()
  assert.equal(again.deletedSessions, 1)
  assert.equal(again.errors.length, 0)
  assert.deepEqual(host.archived, new Set(['s3']))
})

test('purge: a mid-tree running refusal aborts the tree — the refused member, its ancestors and the root survive; a rerun converges (review F1)', async () => {
  const host = buildHost()
  // a1 (NON-root member of s1's tree [a1a, a1, s1]) refuses at delete time
  // with `running` — the binding-guard shape for a mid-window live flip.
  host.failDeletes.set('a1', { code: 'running', remaining: 1 })
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  // a1a (deleted before the failure) stays deleted — prefix deletions are
  // not rolled back; a1 and its ancestors/root content are NOT touched.
  assert.deepEqual(host.deleteLog, ['a1a', 's2'])
  assert.equal(host.states.has('a1'), true, 'the refused member survives')
  assert.equal(host.states.has('s1'), true, 'the root survives (record intact)')
  assert.equal(result.deletedSessions, 1) // s2 only — s1's root content NOT deleted
  assert.equal(result.deletedSubagents, 1) // a1a only
  assert.equal(result.skippedRunning, 1) // s3 (running child)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.sessionId, 'a1')
  assert.equal(result.errors[0]?.code, 'running')
  // The root stays archived → the next purge re-enumerates the tree.
  assert.deepEqual(host.archived, new Set(['s1', 's3']))
  // Rerun with the member no longer running: a1a is gone ('missing'-safe),
  // a1 + root delete and the set member clears.
  const again = await core.purge()
  assert.equal(again.deletedSessions, 1)
  assert.equal(again.deletedSubagents, 1)
  assert.equal(again.errors.length, 0)
  assert.deepEqual(host.deleteLog, ['a1a', 's2', 'a1', 's1'])
  assert.deepEqual(host.archived, new Set(['s3']))
})

test('purge: a mid-tree storage failure aborts the tree — the refused member, its ancestors and the root survive; a rerun converges (review F1)', async () => {
  const host = buildHost()
  host.failDeletes.set('a1', { code: 'storage', remaining: 1 })
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.deepEqual(host.deleteLog, ['a1a', 's2'])
  assert.equal(host.states.has('a1'), true, 'the refused member survives')
  assert.equal(host.states.has('s1'), true, 'the root survives (record intact)')
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.deletedSubagents, 1)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.sessionId, 'a1')
  assert.equal(result.errors[0]?.code, 'storage')
  assert.deepEqual(host.archived, new Set(['s1', 's3']))
  const again = await core.purge()
  assert.equal(again.deletedSessions, 1)
  assert.equal(again.deletedSubagents, 1)
  assert.equal(again.errors.length, 0)
  assert.deepEqual(host.archived, new Set(['s3']))
})

test('purge: >1000 failing members truncate the error list at the shared cap with truncated=true (review F4)', async () => {
  const host = new FakeHost()
  for (let i = 0; i < MAX_PURGE_ERROR_RECORDS + 1; i += 1) {
    const id = `fail-${i}`
    host.archived.add(id)
    host.states.set(id, state(id))
    host.failDeletes.set(id, { code: 'storage', remaining: 1 })
  }
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.errors.length, MAX_PURGE_ERROR_RECORDS)
  assert.equal(result.truncated, true)
  assert.equal(result.deletedSessions, 0)
  assert.equal(result.deletedSubagents, 0)
  assert.equal(result.skippedRunning, 0)
  assert.equal(host.deleteLog.length, 0, 'every delete failed')
  assert.equal(host.removalCalls.length, 0, 'no tree completed → no batched set removal')
  // Truncation is surface-honest: the set members stay archived and a rerun
  // converges once the failures clear.
  assert.equal(host.archived.size, MAX_PURGE_ERROR_RECORDS + 1)
})

test('purge: an archived descendant covered by a completed tree is cleared in the SAME run (merge-round Nit N1)', async () => {
  const host = new FakeHost()
  // s1 archived with an archived subagent-origin descendant a1 (itself a set
  // member) plus a deeper descendant a1a; s2 archived leaf; s3 running-skipped.
  host.archived.add('s1')
  host.states.set('s1', state('s1'))
  host.archived.add('a1')
  host.states.set('a1', subagent('a1', 's1'))
  host.states.set('a1a', subagent('a1a', 'a1'))
  host.archived.add('s2')
  host.states.set('s2', state('s2'))
  host.archived.add('s3')
  host.states.set('s3', state('s3'))
  host.states.set('b1', subagent('b1', 's3', true))
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.deletedSessions, 2)
  assert.equal(result.deletedSubagents, 2)
  assert.deepEqual(result.errors, [])
  // a1's archived marker rides the SAME end-of-run batched write — no lag to
  // a later orphan pass.
  assert.deepEqual(host.removalCalls, [['s1', 's2', 'a1']])
  assert.deepEqual(host.archived, new Set(['s3']))
  // Converged after ONE run: a rerun has nothing left to clear or delete.
  const again = await core.purge()
  assert.equal(again.deletedSessions, 0)
  assert.equal(again.deletedSubagents, 0)
  assert.equal(host.changedEvents, 1)
})

test('purge: crash mid-subtree leaves the root archived and a rerun converges', async () => {
  const host = buildHost()
  host.crashAfterDeleteCount = 1
  const core = new ArchiveCleanupCore(host)
  await assert.rejects(() => core.purge(), /process crashed/)
  assert.deepEqual(host.deleteLog, ['a1a'])
  assert.deepEqual(host.removedFromArchived, [])
  // A "restarted process" sees the same persisted state (archived set
  // unchanged; a1a's record gone).
  const restarted = new FakeHost()
  for (const id of host.archived) restarted.archived.add(id)
  for (const [id, st] of host.states) restarted.states.set(id, st)
  const rerun = new ArchiveCleanupCore(restarted)
  const result = await rerun.purge()
  // s1's subtree: a1a is missing (no double delete), a1 + s1 delete; s2 too.
  assert.equal(result.deletedSessions, 2)
  assert.equal(result.deletedSubagents, 1)
  assert.deepEqual(restarted.deleteLog, ['a1', 's1', 's2'])
  assert.equal(restarted.states.has('s3'), true)
})

test('purge: registry-unreadable state fails the whole run without mutating', async () => {
  const host = buildHost()
  host.failStateRead = true
  const core = new ArchiveCleanupCore(host)
  await assert.rejects(() => core.purge(), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'registry-unreadable'
  })
  assert.equal(host.deleteLog.length, 0)
  assert.equal(host.removedFromArchived.length, 0)
})

test('purge: batched set-removal failure keeps every id archived for rerun convergence', async () => {
  const host = buildHost()
  host.removalFailureRemaining = 1
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.deletedSessions, 2) // content went
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.code, 'archive-set')
  // The single batched write failed → every completed root AND the orphan
  // stay archived (content is gone; the rerun converges via orphan handling).
  assert.equal(host.removalCalls.length, 0) // failed before recording
  assert.equal(host.archived.has('s1'), true)
  assert.equal(host.archived.has('s2'), true)
  assert.equal(host.archived.has('s-orphan'), true)
  const again = await core.purge()
  assert.equal(again.deletedSessions, 0)
  assert.equal(again.errors.length, 0)
  assert.equal(host.archived.has('s1'), false)
  assert.equal(host.archived.has('s2'), false)
  assert.equal(host.archived.has('s-orphan'), false)
  assert.deepEqual([...host.archived], ['s3'])
  assert.deepEqual(host.removalCalls, [['s1', 's2', 's-orphan']])
  assert.equal(host.changedEvents, 2) // one changed event per run with clear work
})

test('domainResult: ArchiveCleanupError maps through the carrier; unknown failures stay throws', async () => {
  const { domainResult } = await import('../src/core.ts')
  const ok = await domainResult(async () => 42)
  assert.deepEqual(ok, { ok: true, value: 42 })
  const refused = await domainResult(async () => {
    throw new ArchiveCleanupError('busy', 'busy message', true)
  })
  assert.deepEqual(refused, { ok: false, error: { code: 'busy', message: 'busy message', retryable: true } })
  await assert.rejects(() => domainResult(async () => { throw new Error('boom') }), /boom/)
})

test('capacity guard: oversized archived sets refuse before any mutation', async () => {
  const host = new FakeHost()
  for (let i = 0; i < MAX_PURGE_SESSIONS + 1; i += 1) {
    host.archived.add(`bulk-${i}`)
    host.states.set(`bulk-${i}`, state(`bulk-${i}`))
  }
  const core = new ArchiveCleanupCore(host)
  await assert.rejects(() => core.purge(), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'purge-capacity'
  })
  assert.equal(host.deleteLog.length, 0)
})

test('purge reads the state corpus once plus ONE orphan-sweep confirmation scan, re-reads only the live set per tree, and batches the set removal (perf contract)', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.errors.length, 0)
  assert.equal(result.clearedOrphanMembers, 1)
  assert.equal(host.stateListCalls, 1 + 1, 'snapshot scan + the ONE sweep confirmation scan (s-orphan exists)')
  assert.equal(host.liveListCalls, 1 + 2 + 1, 'snapshot + one live refresh per deletable tree (s1, s2) + the sweep confirmation — running trees never enter the loop')
  assert.equal(host.removalCalls.length, 1, 'archived-set removal is ONE batched write')
  assert.deepEqual(host.removalCalls[0], ['s1', 's2', 's-orphan'])
})

test('purge: a converged set with no orphan members keeps the single-scan contract (no confirmation read)', async () => {
  const host = buildHost()
  host.archived.delete('s-orphan')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.errors.length, 0)
  assert.equal(result.clearedOrphanMembers, undefined)
  assert.equal(host.stateListCalls, 1, 'no orphan candidates → no confirmation scan')
  assert.equal(host.liveListCalls, 1 + 2)
  assert.deepEqual(host.removalCalls, [['s1', 's2']])
})

test('purge subset: a single selected root deletes only its deletable tree; the registry-global orphan sweep still clears record-less members outside the selection', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s2'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.deletedSubagents, 0)
  assert.equal(result.skippedRunning, 0)
  assert.deepEqual(host.deleteLog, ['s2'])
  assert.equal(host.archived.has('s1'), true, 'a record-bearing member outside the subset is untouched')
  assert.equal(host.archived.has('s3'), true)
  // Design 24 §20 residual ①: the record-less member is cleared even though
  // the filter never named it, and it never inflates the content counts.
  assert.equal(host.archived.has('s-orphan'), false)
  assert.equal(result.clearedOrphanMembers, 1)
  assert.deepEqual(host.removalCalls, [['s2', 's-orphan']])
})

test('purge subset: selecting an archived root cascades its subagent lineage children-first', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s1'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.deletedSubagents, 2)
  // Children-first: descendants before the root.
  assert.equal(host.deleteLog.indexOf('s1'), host.deleteLog.length - 1)
  assert.deepEqual([...host.deleteLog].sort(), ['a1', 'a1a', 's1'])
  assert.equal(host.archived.has('s1'), false)
  assert.equal(host.archived.has('s2'), true)
})

test('purge subset: a stale/non-archived id is no candidate — nothing deleted, never an error; the orphan sweep still converges', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s4', 'never-archived'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 0)
  assert.equal(result.deletedSubagents, 0)
  assert.equal(host.deleteLog.length, 0)
  // No content candidates — but the registry-global orphan sweep is
  // orthogonal to the filter (design 24 §20 residual ①): the record-less set
  // member is cleared in the same single write.
  assert.deepEqual(host.removalCalls, [['s-orphan']])
  assert.equal(result.clearedOrphanMembers, 1)
  // The filter can never reach the non-archived live sibling.
  assert.equal(host.states.has('s4'), true)
  // Unrelated archived members stay untouched.
  assert.equal(host.archived.has('s1'), true)
  assert.equal(host.archived.has('s2'), true)
})

test('purge subset: running subtrees in the selection are skipped whole and stay archived', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s3'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 0)
  assert.equal(result.skippedRunning, 1)
  assert.equal(host.deleteLog.length, 0)
  assert.equal(host.archived.has('s3'), true)
  assert.equal(host.states.has('b1'), true, 'running child untouched')
})

test('purge subset: mixed selection deletes the deletable roots and skips the running one in one run', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s1', 's3'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.deletedSubagents, 2)
  assert.equal(result.skippedRunning, 1)
  assert.equal(host.archived.has('s1'), false)
  assert.equal(host.archived.has('s3'), true)
  assert.deepEqual(host.removalCalls, [['s1', 's-orphan']])
})

test('purge subset: an orphan member selected in the filter is cleared with the same batched write', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s1', 's-orphan'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.clearedOrphanMembers, 1)
  assert.deepEqual(host.removalCalls, [['s1', 's-orphan']])
  assert.equal(host.archived.has('s2'), true, 'unselected member untouched')
})

test('purge subset: malformed filters refuse loudly before any mutation', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  await assert.rejects(() => core.purge(['s1', 42 as never]), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'invalid-request'
  })
  await assert.rejects(() => core.purge(['']), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'invalid-request'
  })
  const oversized: string[] = []
  for (let i = 0; i < MAX_PURGE_SESSIONS + 1; i += 1) oversized.push(`bulk-${i}`)
  await assert.rejects(() => core.purge(oversized), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'invalid-request'
  })
  assert.equal(host.deleteLog.length, 0)
  assert.equal(host.removalCalls.length, 0)
})

test('purge subset: an empty selection deletes NO content but still converges the registry-global orphan backlog', async () => {
  // The empty filter is a deliberate delete-nothing CONTENT subset; the
  // registry-global orphan sweep is orthogonal to it (design 24 §20
  // residual ①), so the run still reads the corpus and clears record-less
  // set members in one write — no content is ever touched.
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge([])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 0)
  assert.equal(result.deletedSubagents, 0)
  assert.equal(result.skippedRunning, 0)
  assert.equal(result.clearedOrphanMembers, 1)
  assert.equal(host.deleteLog.length, 0, 'no content deletion')
  assert.deepEqual(host.removalCalls, [['s-orphan']])
  assert.equal(host.archived.has('s1'), true, 'record-bearing members untouched')
  assert.equal(host.archived.has('s2'), true)
  assert.equal(host.archived.has('s3'), true)
  assert.equal(host.archived.has('s-orphan'), false)
  // Idempotent: a second empty run has nothing left to clear and no error.
  const again = await core.purge([])
  assert.equal(again.errors.length, 0)
  assert.equal(again.clearedOrphanMembers, undefined)
  assert.equal(host.removalCalls.length, 1)
  assert.equal(host.changedEvents, 1)
})

test('capacity guard: an oversized archived set still allows bounded subset purges', async () => {
  const host = new FakeHost()
  for (let i = 0; i < MAX_PURGE_SESSIONS + 1; i += 1) {
    host.archived.add(`bulk-${i}`)
    host.states.set(`bulk-${i}`, state(`bulk-${i}`))
  }
  const core = new ArchiveCleanupCore(host)
  // The full-set purge refuses (purge-capacity)…
  await assert.rejects(() => core.purge(), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'purge-capacity'
  })
  // …but a bounded subset of the same oversized set still runs.
  const result = await core.purge(['bulk-0', 'bulk-1'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 2)
  assert.equal(host.archived.has('bulk-0'), false)
  assert.equal(host.archived.has('bulk-2'), true)
})

test('purge subset: an archived descendant selected WITH its archived ancestor is covered by the ancestor tree', async () => {
  // Fixture: archived set contains BOTH s1 (top-level) and its subagent
  // descendant a1 (archived member). Candidates resolve in archived-set
  // order: s1 first → its tree covers a1 (no double deletion), and a1 — an
  // archived member covered by a completed tree — is cleared from the set
  // in the SAME batched write (merge-round Nit N1 semantics under a subset
  // run). Counts: one tree root (s1) + two subagent members (a1, a1a).
  const host = buildHost()
  host.archived.add('a1')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s1', 'a1'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1, 'one tree root — the a1 row is covered by its ancestor tree')
  assert.equal(result.deletedSubagents, 2, 'a1 + a1a deleted children-first')
  assert.deepEqual(host.deleteLog, ['a1a', 'a1', 's1'])
  // Set removal: root + covered archived descendant + the swept orphan, one
  // write, deduped.
  assert.equal(host.removalCalls.length, 1)
  assert.deepEqual(new Set(host.removalCalls[0]), new Set(['s1', 'a1', 's-orphan']))
  assert.equal(host.archived.has('a1'), false)
  assert.equal(host.archived.has('s1'), false)
  assert.equal(host.archived.has('s2'), true)
})

test('purge subset: an archived subagent-origin row selected without its ancestor deletes only its own subtree', async () => {
  // Wire-reachable edge (the UI never selects hidden subagent rows): s1 is
  // NOT selected and stays archived; a1 (archived subagent child of s1) is
  // selected alone → only a1's own subtree (a1 + a1a) is deleted; the
  // ancestor s1 record lives in its own directory and is untouched.
  const host = buildHost()
  host.archived.add('a1')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['a1'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1, 'the archived subagent row is its own tree root')
  assert.equal(result.deletedSubagents, 1)
  assert.deepEqual(new Set(host.deleteLog), new Set(['a1', 'a1a']))
  assert.equal(host.archived.has('a1'), false)
  assert.equal(host.archived.has('s1'), true, 'ancestor content and membership untouched')
  assert.equal(host.states.has('s1'), true)
})

test('purge subset: the first in-tree failure still aborts the REMAINING members of that tree only', async () => {
  // F1 semantics under a subset run: deleting s2's tree fails at delete
  // time (storage) → s2 (its root) survives archived; the OTHER selected
  // tree (s1) completes; a rerun converges the remainder.
  const host = buildHost()
  host.failDeletes.set('s2', { code: 'storage', remaining: 1 })
  const core = new ArchiveCleanupCore(host)
  const first = await core.purge(['s1', 's2'])
  assert.equal(first.deletedSessions, 1)
  assert.equal(first.errors.length, 1)
  assert.equal(first.errors[0]?.sessionId, 's2')
  assert.equal(first.errors[0]?.code, 'storage')
  assert.equal(host.archived.has('s1'), false)
  assert.equal(host.archived.has('s2'), true, 'failed root stays archived')
  assert.equal(host.removalCalls.length, 1)
  assert.deepEqual(host.removalCalls[0], ['s1', 's-orphan'])
  // Rerun converges the aborted remainder.
  const second = await core.purge(['s2'])
  assert.equal(second.errors.length, 0)
  assert.equal(second.deletedSessions, 1)
  assert.equal(host.archived.has('s2'), false)
})

test('purge subset: duplicate filter ids delete once and keep counts honest', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s2', 's2', 's2'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1)
  assert.equal(host.deleteLog.length, 1)
  assert.deepEqual(host.removalCalls, [['s2', 's-orphan']])
})

test('purge subset: a malformed filter refuses BEFORE any authoritative read (validation-first)', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  await assert.rejects(() => core.purge([42 as never]), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'invalid-request'
  })
  assert.equal(host.stateReadAttempts, 0, 'no corpus read for a malformed request')
  assert.equal(host.removalCalls.length, 0)
})

test('purge subset: an empty selection reads the corpus for the sweep but deletes no content and skips no tree', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge([])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 0)
  assert.equal(result.skippedRunning, 0)
  assert.equal(host.stateListCalls, 1 + 1, 'snapshot scan + the sweep confirmation (s-orphan exists)')
  assert.equal(host.deleteLog.length, 0)
  assert.deepEqual(host.removalCalls, [['s-orphan']])
})

/* ------------------------------------------------------------------ */
/* Registry-global orphan sweep (design 24 §20 residual ①).            */
/* ------------------------------------------------------------------ */

test('orphanArchivedMembers: record-less members only; a live record-less id is excluded (fail-closed predicate)', () => {
  const states = new Map<string, ArchivedSessionState>([
    ['with-record', state('with-record')],
    ['sub', subagent('sub', 'with-record')],
  ])
  assert.deepEqual(
    orphanArchivedMembers(['with-record', 'ghost-1', 'sub', 'ghost-2'], states, new Set()),
    ['ghost-1', 'ghost-2'],
  )
  // A record-less id that is live/open is NEVER swept (defense in depth: its
  // content is real even if the durable enumeration momentarily misses it).
  assert.deepEqual(orphanArchivedMembers(['ghost-1', 'ghost-2'], states, new Set(['ghost-1'])), ['ghost-2'])
  assert.deepEqual(orphanArchivedMembers([], states, new Set()), [])
})

test('purge: the registry-global sweep clears record-less members OUTSIDE the candidate subset without touching content', async () => {
  const host = buildHost()
  // A second historical no-directory member, never named by any filter.
  host.archived.add('s-orphan-2')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s1'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.deletedSubagents, 2)
  // Content: ONLY s1's tree — the orphans were never deletion candidates.
  assert.deepEqual(host.deleteLog, ['a1a', 'a1', 's1'])
  assert.equal(host.deleteLog.includes('s-orphan'), false)
  assert.equal(host.deleteLog.includes('s-orphan-2'), false)
  // Membership: both record-less members ride the SAME single write as the
  // completed tree root; the record-bearing members outside the subset stay.
  assert.equal(host.removalCalls.length, 1)
  assert.deepEqual(host.removalCalls[0], ['s1', 's-orphan', 's-orphan-2'])
  assert.equal(result.clearedOrphanMembers, 2)
  assert.equal(host.archived.has('s1'), false)
  assert.equal(host.archived.has('s-orphan'), false)
  assert.equal(host.archived.has('s-orphan-2'), false)
  assert.equal(host.archived.has('s2'), true, 'record-bearing member outside the subset untouched')
  assert.equal(host.archived.has('s3'), true)
  assert.equal(host.states.has('s2'), true)
  assert.equal(host.states.has('s4'), true)
  // The swept count never inflates the content counts.
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.deletedSubagents, 2)
})

test('purge: a member with a session record is NEVER swept — including one skipped as running and one outside the subset', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  // Full-set run: s3's subtree is running-skipped; s1/s2 delete.
  const full = await core.purge()
  assert.equal(full.skippedRunning, 1)
  assert.equal(full.clearedOrphanMembers, 1)
  assert.equal(host.archived.has('s3'), true, 'running-skipped member keeps its record AND its membership')
  assert.equal(host.states.has('s3'), true)
  assert.equal(host.states.has('b1'), true)
  assert.deepEqual(host.removalCalls[0], ['s1', 's2', 's-orphan'])
  // Subset run: an idle record-bearing member outside the subset is likewise
  // never swept (only record-less ids are).
  const host2 = buildHost()
  const core2 = new ArchiveCleanupCore(host2)
  await core2.purge(['s1'])
  assert.equal(host2.archived.has('s2'), true)
  assert.equal(host2.states.has('s2'), true)
  assert.equal(host2.archived.has('s3'), true)
})

test('purge: a failed sweep confirmation read SKIPS the sweep, records archive-set, and still commits the completed deletions', async () => {
  const host = buildHost()
  // Attempt 1 = the run snapshot (succeeds); attempt 2 = the sweep
  // confirmation read (fails) — the fail-closed leg.
  host.failStateReadOnAttempt = 2
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.deletedSessions, 2, 'completed content deletions are reported')
  assert.equal(result.deletedSubagents, 2)
  assert.equal(result.clearedOrphanMembers, undefined, 'nothing was swept — never guessed')
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.sessionId, '')
  assert.equal(result.errors[0]?.code, 'archive-set')
  assert.equal(result.errors[0]?.message.includes('orphan sweep skipped'), true)
  // The completed trees still ride the single write; the record-less member
  // stays archived for a later run.
  assert.deepEqual(host.removalCalls, [['s1', 's2']])
  assert.equal(host.archived.has('s-orphan'), true)
  assert.equal(host.archived.has('s1'), false)
  assert.equal(host.archived.has('s2'), false)
  assert.equal(host.changedEvents, 1)
  // A later run (enumeration healthy again) converges the orphan.
  host.failStateReadOnAttempt = null
  const again = await core.purge()
  assert.equal(again.errors.length, 0)
  assert.equal(again.clearedOrphanMembers, 1)
  assert.equal(host.archived.has('s-orphan'), false)
})

test('purge: the orphan sweep is idempotent — a second run is a no-op with no error and no extra set write', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const first = await core.purge()
  assert.equal(first.clearedOrphanMembers, 1)
  const second = await core.purge()
  assert.equal(second.errors.length, 0)
  assert.equal(second.deletedSessions, 0)
  assert.equal(second.clearedOrphanMembers, undefined)
  assert.equal(host.removalCalls.length, 1, 'no second write')
  assert.equal(host.changedEvents, 1, 'no second changed event')
  assert.deepEqual([...host.archived], ['s3'])
})

test('purge: swept orphans ride the SAME deduped single write as completed trees and covered descendants', async () => {
  const host = buildHost()
  // a1 is BOTH an archived member and a descendant covered by s1's tree.
  host.archived.add('a1')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.errors.length, 0)
  assert.equal(host.removalCalls.length, 1, 'ONE official set write')
  const call = host.removalCalls[0] as string[]
  assert.equal(new Set(call).size, call.length, 'clearIds is deduped')
  assert.deepEqual(new Set(call), new Set(['s1', 's2', 'a1', 's-orphan']))
  assert.equal(result.clearedOrphanMembers, 1, 'only the record-less member counts as swept')
  assert.deepEqual(host.archived, new Set(['s3']))
})

test('purge: an archived set beyond the defensive capacity skips the orphan sweep while bounded subset purges still run', async () => {
  const host = new FakeHost()
  for (let i = 0; i < MAX_PURGE_SESSIONS + 1; i += 1) {
    host.archived.add(`bulk-${i}`)
    host.states.set(`bulk-${i}`, state(`bulk-${i}`))
  }
  // A historical no-directory member inside the oversized set.
  host.archived.add('bulk-ghost')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['bulk-0'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.clearedOrphanMembers, undefined, 'capacity bounds the sweep — nothing swept')
  assert.deepEqual(host.removalCalls, [['bulk-0']])
  assert.equal(host.archived.has('bulk-ghost'), true)
  assert.equal(host.stateListCalls, 1, 'no confirmation scan when the sweep is out of capacity')
})

test('purge: a record-less member that is live is never swept (defense in depth)', async () => {
  const host = buildHost()
  host.live.add('s-orphan')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.errors.length, 0)
  assert.equal(result.clearedOrphanMembers, undefined)
  assert.deepEqual(host.removalCalls, [['s1', 's2']])
  assert.equal(host.archived.has('s-orphan'), true, 'a live id keeps its membership')
})

test('purge: a sweep-skip record shares the item error cap — truncated stays honest and completed deletions are unaffected', async () => {
  const host = new FakeHost()
  for (let i = 0; i < MAX_PURGE_ERROR_RECORDS; i += 1) {
    const id = `fail-${i}`
    host.archived.add(id)
    host.states.set(id, state(id))
    host.failDeletes.set(id, { code: 'storage', remaining: 1 })
  }
  host.archived.add('ghost') // record-less member → the sweep runs
  host.failStateReadOnAttempt = 2 // …and its confirmation read fails
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.errors.length, MAX_PURGE_ERROR_RECORDS)
  assert.equal(result.truncated, true, 'the dropped sweep-skip record still sets the honest truncation flag')
  assert.equal(result.errors.every(error => error.code === 'storage'), true)
  assert.equal(result.deletedSessions, 0)
  assert.equal(result.clearedOrphanMembers, undefined)
  assert.equal(host.removalCalls.length, 0, 'nothing completed and the sweep was skipped → no write')
  assert.equal(host.archived.has('ghost'), true)
  assert.equal(host.archived.size, MAX_PURGE_ERROR_RECORDS + 1)
})

test('purge: a failed single set write keeps the swept orphans archived too (honest zero, rerun converges)', async () => {
  const host = buildHost()
  host.removalFailureRemaining = 1
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.deletedSessions, 2, 'content deletions stand')
  assert.equal(result.clearedOrphanMembers, undefined, 'the failed write swept nothing')
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.code, 'archive-set')
  assert.equal(host.archived.has('s-orphan'), true)
  const again = await core.purge()
  assert.equal(again.errors.length, 0)
  assert.equal(again.deletedSessions, 0, 'content was already gone')
  // Convergence: the two completed-but-unwritten roots now have no record
  // either, so they are swept as orphans together with the historical member.
  assert.equal(again.clearedOrphanMembers, 3)
  assert.equal(host.archived.has('s-orphan'), false)
  assert.equal(host.archived.has('s1'), false)
  assert.equal(host.archived.has('s2'), false)
})

/* ------------------------------------------------------------------ */
/* Orphan-sweep blocker fix (2026-12 adversarial second scan): the      */
/* sweep's G1 credibility guards + G3 decisive existence probe.         */
/* ------------------------------------------------------------------ */

test('purge BLOCKER: a content-bearing member missing from BOTH bulk reads is never swept (G3 authoritative probe)', async () => {
  // The reviewer's repro, minus the empty-corpus guard: a NON-empty corpus
  // that silently omits two content-bearing archived members (jsonl skips
  // unparseable artifacts / the query corpus narrows live-only). Before the
  // fix, `purge(['keep-1'])` answered deleted=0, clearedOrphanMembers=2 and
  // erased both memberships while keep-2's artifact stayed on disk.
  const host = new FakeHost()
  host.states.set('other', state('other')) // credible corpus (G1a passes)
  host.archived.add('keep-1')
  host.archived.add('keep-2')
  host.archived.add('ghost-1') // genuinely record-less AND content-less
  host.contentIds.add('keep-1')
  host.contentIds.add('keep-2')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['keep-1'])
  assert.equal(result.deletedSessions, 0, 'no record → no content-deletion candidate')
  assert.equal(result.deletedSubagents, 0)
  // The probe is PER CANDIDATE: only the id the official read cannot
  // materialize loses its membership; the two content-bearing members keep
  // theirs and never inflate the swept count.
  assert.equal(result.clearedOrphanMembers, 1)
  assert.deepEqual(host.removalCalls, [['ghost-1']], 'ONE official set write, containing only the content-free member')
  assert.deepEqual([...host.archived], ['keep-1', 'keep-2'], 'both content-bearing memberships survive')
  assert.deepEqual(host.probeCalls, ['keep-1', 'keep-2', 'ghost-1'], 'every candidate asked the authoritative read')
})

test('purge subset (reviewer repro): a one-row purge deletes its own row and never clears an unrelated content-bearing archived member', async () => {
  // The reviewer's call shape: `purge(['keep-1'])` on an archived set where
  // keep-2 has content on disk but no record in the narrowed corpus.
  // Pre-fix: clearedOrphanMembers=2 and keep-2's membership gone (content
  // orphaned, the session reappears non-archived and can never be re-deleted
  // through the manager). Post-fix: keep-2 keeps its membership.
  const host = new FakeHost()
  host.states.set('other', state('other')) // unrelated session keeps the corpus non-empty
  host.archived.add('keep-1')
  host.states.set('keep-1', state('keep-1'))
  host.archived.add('keep-2')
  host.contentIds.add('keep-2')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['keep-1'])
  assert.equal(result.deletedSessions, 1, 'the selected row is deleted')
  assert.equal(result.clearedOrphanMembers, undefined, 'the unrelated member is NOT cleared')
  assert.deepEqual(host.removalCalls, [['keep-1']], 'the set write names only the completed tree')
  assert.deepEqual([...host.archived], ['keep-2'], 'keep-2 stays archived → still reachable via the manager')
  assert.deepEqual(host.probeCalls, ['keep-2'], 'the unrelated candidate was probed and kept')
  assert.equal(result.errors.length, 0, 'keeping a content-bearing member is not an error')
})

test('purge sweep G1a: an empty snapshot corpus never clears archived members (reviewer repro, no probes)', async () => {
  // The reviewer's exact shape: the corpus reports ZERO records while two
  // members are archived (an absent sessions root / unmounted persistence
  // binding answers empty with NO error). Zero records is not evidence that
  // content is absent — the sweep must not even probe.
  const host = new FakeHost()
  host.archived.add('keep-1')
  host.archived.add('keep-2')
  host.contentIds.add('keep-2')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['keep-1'])
  assert.equal(result.deletedSessions, 0)
  assert.equal(result.clearedOrphanMembers, undefined)
  assert.deepEqual(host.removalCalls, [])
  assert.deepEqual([...host.archived], ['keep-1', 'keep-2'])
  assert.deepEqual(host.probeCalls, [], 'G1a skips BEFORE the confirmation read and every probe')
  assert.equal(host.stateListCalls, 1, 'no confirmation read on a non-credible corpus')
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.sessionId, '')
  assert.equal(result.errors[0]?.code, 'archive-set')
  assert.match(result.errors[0]?.message ?? '', /corpus is empty/)
})

test('purge sweep G1b: a confirmation corpus collapsing to empty skips the sweep and still commits completed deletions', async () => {
  const host = buildHost()
  host.emptyStateReadOnAttempt = 2
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.deletedSessions, 2, 'completed content deletions are committed')
  assert.equal(result.deletedSubagents, 2)
  assert.equal(result.clearedOrphanMembers, undefined)
  assert.deepEqual(host.removalCalls, [['s1', 's2']])
  assert.equal(host.archived.has('s-orphan'), true, 'the candidate stays archived')
  assert.deepEqual(host.probeCalls, [], 'no probes on a collapsed corpus')
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.code, 'archive-set')
  assert.match(result.errors[0]?.message ?? '', /collapsed to empty/)
})

test('purge sweep G2: a candidate the CONFIRMATION read lists is not swept (transient snapshot miss)', async () => {
  const host = buildHost()
  host.archived.add('late-1') // record-less in the snapshot → a candidate
  host.addStatesOnStateRead = { attempt: 2, states: [state('late-1')] }
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s1'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.clearedOrphanMembers, 1, 'only the genuinely record-less member')
  assert.deepEqual(host.removalCalls, [['s1', 's-orphan']])
  assert.equal(host.archived.has('late-1'), true)
  assert.equal(host.probeCalls.includes('late-1'), false, 'filtered by G2 before any probe')
})

test('purge sweep G2: a candidate that left the archived set (concurrent purge) is not double-cleared', async () => {
  const host = buildHost()
  host.archived.add('ghost-late')
  host.removeArchivedOnArchivedRead = { attempt: 2, id: 'ghost-late' }
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s1'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.clearedOrphanMembers, 1)
  assert.deepEqual(host.removalCalls, [['s1', 's-orphan']], 'no redundant clear of the departed id')
  assert.equal(host.probeCalls.includes('ghost-late'), false)
})

test('purge sweep G3: a failing content-existence probe keeps the membership (fail closed) and never aborts the run', async () => {
  const host = buildHost()
  host.failContentProbes.set('s-orphan', { code: 'storage', remaining: 1 })
  const core = new ArchiveCleanupCore(host)
  const first = await core.purge()
  assert.equal(first.deletedSessions, 2, 'completed content deletions stand')
  assert.equal(first.deletedSubagents, 2)
  assert.equal(first.clearedOrphanMembers, undefined)
  assert.deepEqual(host.removalCalls, [['s1', 's2']])
  assert.equal(host.archived.has('s-orphan'), true, 'an unreadable existence check never clears a membership')
  assert.equal(first.errors.length, 1)
  assert.equal(first.errors[0]?.code, 'archive-set')
  assert.match(first.errors[0]?.message ?? '', /probe failed/)
  // A LATER run (probe healthy again) converges it.
  const again = await core.purge()
  assert.equal(again.errors.length, 0)
  assert.equal(again.clearedOrphanMembers, 1)

  // A RAW (non-domain) probe failure must be caught too — it can never abort
  // the run or clear a membership.
  const host2 = buildHost()
  host2.rawContentProbeFailures.add('s-orphan')
  const result2 = await new ArchiveCleanupCore(host2).purge()
  assert.equal(result2.deletedSessions, 2)
  assert.equal(result2.clearedOrphanMembers, undefined)
  assert.equal(host2.archived.has('s-orphan'), true)
  assert.equal(result2.errors.length, 1)
  assert.match(result2.errors[0]?.message ?? '', /raw content probe failure/)
})

test('purge sweep G3: a probe answer that is not the exact boolean false never clears a membership', async () => {
  // Only the exact boolean false is a proof of absent content. A drifted host
  // returning undefined/0/'' (falsy but not false) must NOT be read as "no
  // content" — and such an answer is not an error, just insufficient proof.
  for (const answer of [undefined, null, 0, ''] as const) {
    const host = buildHost()
    Object.defineProperty(host, 'hasStoredContent', {
      value: async () => answer,
      configurable: true,
    })
    const result = await new ArchiveCleanupCore(host).purge()
    assert.equal(result.deletedSessions, 2, 'content deletions unaffected')
    assert.equal(result.clearedOrphanMembers, undefined, `probe answer ${String(answer)} is not a proof of absence`)
    assert.deepEqual(host.removalCalls, [['s1', 's2']])
    assert.equal(host.archived.has('s-orphan'), true)
    assert.equal(result.errors.length, 0, 'a non-false answer is not an error — just not a proof')
  }
  // The exact boolean false still sweeps (no over-correction).
  const okHost = buildHost()
  const okResult = await new ArchiveCleanupCore(okHost).purge()
  assert.equal(okResult.clearedOrphanMembers, 1)
})

test('purge sweep G3: a host without the hasStoredContent capability never sweeps (fail closed, run-level note)', async () => {
  const host = buildHost()
  // The seam requires the capability, but a drifted/older host may not
  // provide it at runtime — shadow the prototype method with undefined.
  Object.defineProperty(host, 'hasStoredContent', { value: undefined, configurable: true })
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.deletedSessions, 2)
  assert.equal(result.deletedSubagents, 2)
  assert.equal(result.clearedOrphanMembers, undefined)
  assert.deepEqual(host.removalCalls, [['s1', 's2']])
  assert.equal(host.archived.has('s-orphan'), true)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.code, 'archive-set')
  assert.match(result.errors[0]?.message ?? '', /no hasStoredContent capability/)
})

test('purge sweep G3: the per-run probe budget bounds one sweep, notes the truncation, and the remainder converges later', async () => {
  const host = new FakeHost()
  host.states.set('keeper', state('keeper'))
  host.states.set('other', state('other'))
  host.archived.add('keeper')
  for (let i = 0; i < MAX_SWEEP_CONTENT_PROBES + 1; i += 1) host.archived.add(`ghost-${i}`)
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['keeper'])
  assert.equal(result.deletedSessions, 1)
  assert.equal(host.probeCalls.length, MAX_SWEEP_CONTENT_PROBES, 'exactly the budget is probed')
  assert.equal(result.clearedOrphanMembers, MAX_SWEEP_CONTENT_PROBES)
  assert.equal(host.archived.has(`ghost-${MAX_SWEEP_CONTENT_PROBES}`), true, 'the truncated remainder stays archived')
  assert.equal(host.archived.has('keeper'), false)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.code, 'archive-set')
  assert.match(result.errors[0]?.message ?? '', new RegExp(`truncated at ${MAX_SWEEP_CONTENT_PROBES}`))
  // Convergence: the next run (corpus still non-empty via `other`) sweeps the
  // single remaining member.
  const again = await core.purge()
  assert.equal(again.errors.length, 0)
  assert.equal(again.clearedOrphanMembers, 1)
  assert.equal(host.archived.size, 0)
})
