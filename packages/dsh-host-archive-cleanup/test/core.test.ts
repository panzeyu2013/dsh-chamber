/** Pure orchestration tests: the host (registry/storage/agents) is a full
 *  in-memory mock — no vendor, no filesystem (git-worktree core parity). */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ArchiveCleanupCore,
  ArchiveCleanupError,
  indexChildren,
  resolveDeletableTree,
  subtreeRunning,
  MAX_PURGE_SESSIONS,
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
  readonly live = new Set<string>()
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

  async listLiveAgentIds(): Promise<string[]> {
    if (this.failLiveRead) throw new ArchiveCleanupError('registry-unreadable', 'fake: live read failed')
    this.liveListCalls += 1
    return [...this.live]
  }

  private consumeFailure(map: Map<string, InjectedFailure>, sessionId: string): string | null {
    const failure = map.get(sessionId)
    if (failure === undefined || failure.remaining <= 0) return null
    failure.remaining -= 1
    if (failure.remaining === 0) map.delete(sessionId)
    return failure.code
  }

  async deleteSessionContent(sessionId: string, _cwd?: string): Promise<'deleted' | 'missing'> {
    const injected = this.consumeFailure(this.failDeletes, sessionId)
    if (injected !== null) {
      throw new ArchiveCleanupError(injected, `fake: delete failed for ${sessionId}`)
    }
    if (this.live.has(sessionId)) {
      throw new ArchiveCleanupError('running', `fake: ${sessionId} is running`)
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
})

test('indexChildren: uninterrupted subagent-origin children only', () => {
  const host = buildHost()
  const children = indexChildren([...host.states.values()])
  assert.deepEqual([...children.get('s1') ?? []].sort(), ['a1'])
  assert.deepEqual([...children.get('a1') ?? []], ['a1a'])
  assert.deepEqual([...children.get('s3') ?? []], ['b1'])
  assert.equal(children.has('s2'), false)
})

test('subtreeRunning: a running member anywhere in the tree skips it whole', () => {
  const host = buildHost()
  const states = new Map([...host.states.entries()])
  const children = indexChildren([...states.values()])
  assert.equal(subtreeRunning('s1', states, children, host.live), false)
  host.live.add('a1a')
  assert.equal(subtreeRunning('s1', states, children, host.live), true)
  host.live.clear()
  host.live.add('s4')
  assert.equal(subtreeRunning('s1', states, children, host.live), false)
})

test('resolveDeletableTree: children-first post-order, root last; null when running or unknown', () => {
  const host = buildHost()
  const states = new Map([...host.states.entries()])
  const children = indexChildren([...states.values()])
  const tree = resolveDeletableTree('s1', states, children, host.live)
  assert.ok(tree !== null)
  assert.deepEqual(tree.order, ['a1a', 'a1', 's1'])
  assert.equal(tree.subagentCount, 2)
  assert.equal(resolveDeletableTree('s3', states, children, host.live), null)
  assert.equal(resolveDeletableTree('nope', states, children, host.live), null)
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
