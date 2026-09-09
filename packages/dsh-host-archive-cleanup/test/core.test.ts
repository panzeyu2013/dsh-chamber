/** Pure orchestration tests: the host (registry/storage/agents) is a full
 *  in-memory mock — no vendor, no filesystem (git-worktree core parity). */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ArchiveCleanupCore,
  ArchiveCleanupError,
  indexChildren,
  resolveDeletableTree,
  subtreeLiveness,
  MAX_PURGE_SESSIONS,
  MAX_PURGE_ERROR_RECORDS,
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

  async listArchivedSessionIds(): Promise<string[]> {
    return [...this.archived]
  }

  async listSessionStates(): Promise<ArchivedSessionState[]> {
    if (this.failStateRead) throw new ArchiveCleanupError('registry-unreadable', 'fake: state read failed')
    this.stateListCalls += 1
    return [...this.states.values()]
  }

  async listLiveSessionFacts(): Promise<{ running: string[]; loaded: string[] }> {
    if (this.failLiveRead) throw new ArchiveCleanupError('registry-unreadable', 'fake: live read failed')
    this.liveListCalls += 1
    // Mirror the binding: running ⊆ loaded (a running agent is attached too).
    return { running: [...this.live], loaded: [...new Set([...this.live, ...this.loaded])] }
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
 *  s3 (archived) with a DURABLE-RUNNING child b1, orphan id s-orphan, and a
 *  live non-archived sibling s4 that must never be touched. */
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
  assert.deepEqual(host.archived, new Set(['s1', 's2', 's3', 's-orphan']))
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

test('purge reads the state corpus once, re-reads only the live set per tree, and batches the set removal (perf contract)', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.errors.length, 0)
  assert.equal(host.stateListCalls, 1, 'the authoritative corpus is scanned exactly once per purge')
  assert.equal(host.liveListCalls, 1 + 2, 'one live refresh per deletable tree (s1, s2) plus the snapshot read — running trees never enter the loop')
  assert.equal(host.removalCalls.length, 1, 'archived-set removal is ONE batched write')
  assert.deepEqual(host.removalCalls[0], ['s1', 's2', 's-orphan'])
})

test('purge subset: a single selected root deletes only its deletable tree and converges the set', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s2'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.deletedSubagents, 0)
  assert.equal(result.skippedRunning, 0)
  assert.deepEqual(host.deleteLog, ['s2'])
  assert.equal(host.archived.has('s1'), true)
  assert.equal(host.archived.has('s3'), true)
  assert.equal(host.archived.has('s-orphan'), true)
  assert.deepEqual(host.removalCalls, [['s2']])
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

test('purge subset: a stale/non-archived id is no candidate — nothing deleted, never an error', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s4', 'never-archived'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 0)
  assert.equal(result.deletedSubagents, 0)
  assert.equal(host.deleteLog.length, 0)
  assert.equal(host.removalCalls.length, 0, 'nothing to clear — no set write')
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
  assert.deepEqual(host.removalCalls, [['s1']])
})

test('purge subset: an orphan member selected in the filter is cleared with the same batched write', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s1', 's-orphan'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1)
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

test('purge subset: an empty selection is an idempotent no-op', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge([])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 0)
  assert.equal(host.deleteLog.length, 0)
  assert.equal(host.removalCalls.length, 0)
  assert.equal(host.archived.size, 4, 'full fixture set untouched')
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
  // Set removal: root + covered archived descendant, one write, deduped.
  assert.equal(host.removalCalls.length, 1)
  assert.deepEqual(new Set(host.removalCalls[0]), new Set(['s1', 'a1']))
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
  assert.deepEqual(host.removalCalls[0], ['s1'])
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
  assert.deepEqual(host.removalCalls, [['s2']])
})

test('purge subset: a malformed filter refuses BEFORE any authoritative read (validation-first)', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  await assert.rejects(() => core.purge([42 as never]), (error: unknown) => {
    return error instanceof ArchiveCleanupError && error.code === 'invalid-request'
  })
  assert.equal(host.stateListCalls, 0, 'no corpus read for a malformed request')
  assert.equal(host.removalCalls.length, 0)
})

test('purge subset: an empty selection short-circuits without any authoritative read', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge([])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 0)
  assert.equal(host.stateListCalls, 0)
  assert.equal(host.liveListCalls, 0)
  assert.equal(host.removalCalls.length, 0)
  assert.equal(host.archived.size, 4)
})
