import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canTargetSession, collectSessionClosure, createSourceOptions, findWorktree,
  gitFactsForWorkspace, removeBlockReason,
} from '../src/shared/git-facts.ts'
import { GitActionLedger } from '../src/shared/action-ledger.ts'
import { SerializedRefreshes } from '../src/shared/refresh-flight.ts'
import { normalizeGitSnapshot } from '../src/shared/snapshot.ts'
import type { GitWorktreeInfo, GitWorktreeSnapshot } from '../src/shared/types.ts'

const REPO_ID = `repo_${'a'.repeat(64)}`
const WORKTREE_ID = `worktree_${'b'.repeat(64)}`
const HEAD = 'c'.repeat(40)

function worktree(extra: Partial<GitWorktreeInfo> = {}): GitWorktreeInfo {
  return {
    worktreeId: WORKTREE_ID, path: '/repo', head: HEAD, branch: 'main', isMain: false,
    dirty: false, locked: false, status: 'ready', headState: 'branch',
    upstream: 'origin/main', ahead: 1, behind: 0, attention: [],
    workspaceId: 'ws-1', sessionIds: [], runningSessionIds: [],
    ...extra,
  }
}

test('snapshot keeps valid siblings beside malformed rows and preserves opaque ids', () => {
  const snapshot = normalizeGitSnapshot({
    repos: [
      {
        repoId: REPO_ID, commonDir: '/repo/.git', mainPath: '/repo',
        branches: [],
        worktrees: [
          worktree(),
          { path: '/missing-id', head: '123', branch: null },
          { ...worktree({ path: '/duplicate' }), worktreeId: WORKTREE_ID },
        ],
      },
      { commonDir: '/bad/.git', mainPath: '/bad', worktrees: [], branches: [] },
    ],
    errors: [{ code: 'status-failed', operation: 'status', path: '/other', message: 'one repo failed' }],
  })
  assert.equal(snapshot.repos.length, 1)
  assert.equal(snapshot.repos[0].repoId, REPO_ID)
  assert.deepEqual(snapshot.repos[0].worktrees.map(row => row.worktreeId), [WORKTREE_ID])
  assert.deepEqual(snapshot.errors.map(error => error.code), ['status-failed', 'invalid-worktree', 'duplicate-worktree-id', 'invalid-repo'])
})

test('snapshot never turns missing collections or malformed membership into healthy empty facts', () => {
  assert.throws(() => normalizeGitSnapshot({ errors: [] }), /repos must be an array/)
  assert.throws(() => normalizeGitSnapshot({ repos: [] }), /errors must be an array/)
  const snapshot = normalizeGitSnapshot({
    repos: [{
      repoId: REPO_ID, commonDir: '/repo/.git', mainPath: '/repo',
        branches: [],
      worktrees: [{ ...worktree(), sessionIds: 'not-an-array' }],
    }],
    errors: [{ nope: true }],
  })
  assert.equal(snapshot.repos[0].worktrees.length, 0)
  assert.deepEqual(snapshot.errors.map(error => error.code), ['invalid-error', 'invalid-worktree'])
})

test('topology helpers select and find by opaque identity, never display paths', () => {
  const snapshot: GitWorktreeSnapshot = {
    repos: [{ repoId: REPO_ID, commonDir: '/same', mainPath: '/repo', worktrees: [worktree()], branches: [] }],
    errors: [],
  }
  assert.deepEqual(createSourceOptions(snapshot), [{ workspaceId: 'ws-1', repoId: REPO_ID, label: 'repo' }])
  assert.equal(findWorktree(snapshot, REPO_ID, WORKTREE_ID)?.worktree.path, '/repo')
  assert.equal(findWorktree(snapshot, '/same', '/repo'), undefined)
})

test('safe-remove guard covers main/registration/live/current/fs safety and allows detached clean rows', () => {
  assert.equal(removeBlockReason(worktree({ isMain: true })), 'main')
  assert.equal(removeBlockReason(worktree({ workspaceId: null })), 'unregistered')
  assert.equal(removeBlockReason(worktree({ runningSessionIds: ['s'] })), 'running')
  assert.equal(removeBlockReason(worktree({ sessionIds: ['s'] }), 's'), 'current')
  // A BLANK current session carries no content and must not block removal.
  assert.equal(removeBlockReason(worktree({ sessionIds: ['s'] }), 's', true), undefined)
  assert.equal(removeBlockReason(worktree({ locked: true })), 'locked')
  assert.equal(removeBlockReason(worktree({ status: 'missing' })), 'unhealthy')
  assert.equal(removeBlockReason(worktree({ status: 'invalid' })), 'unhealthy')
  assert.equal(removeBlockReason(worktree({ status: 'not-a-repo' })), 'unhealthy')
  assert.equal(removeBlockReason(worktree({ dirty: true })), 'dirty')
  assert.equal(removeBlockReason(worktree({ dirty: null })), 'status-unknown')
  assert.equal(removeBlockReason(worktree({ branch: null })), undefined)
  // Fail-closed (2026-09): the runtime channel is absent — the current
  // session is UNKNOWN, so a worktree accounting sessions must block removal.
  assert.equal(removeBlockReason(worktree({ sessionIds: ['s'] }), undefined, false, false), 'runtime-unknown')
  assert.equal(removeBlockReason(worktree({ sessionIds: [] }), undefined, false, false), undefined)
  // A known blank current still does not block (blankness is only lenient
  // when the channel is present).
  assert.equal(removeBlockReason(worktree({ sessionIds: ['s'] }), 's', true, false), 'runtime-unknown')
})

test('session targeting requires a healthy worktree', () => {
  assert.equal(canTargetSession(worktree()), true)
  assert.equal(canTargetSession(worktree({ status: 'missing' })), false)
  assert.equal(canTargetSession(worktree({ status: 'invalid' })), false)
  assert.equal(canTargetSession(worktree({ status: 'not-a-repo' })), false)
  // Unregistered worktrees are adoptable: workspace.create registers them.
  assert.equal(canTargetSession(worktree({ workspaceId: null })), true)
})

test('snapshot normalizes health/head/attention fields and rejects malformed values', () => {
  const snapshot = normalizeGitSnapshot({
    repos: [{
      repoId: REPO_ID, commonDir: '/repo/.git', mainPath: '/repo',
        branches: [],
      worktrees: [
        worktree({ status: 'missing', headState: 'unborn', attention: ['merge', 'bisect'] }),
        { ...worktree(), status: 'bogus' },
        { ...worktree(), headState: 'detached', attention: ['nope'] },
      ],
    }],
    errors: [],
  })
  assert.equal(snapshot.repos[0].worktrees.length, 1)
  const row = snapshot.repos[0].worktrees[0]
  assert.equal(row.status, 'missing')
  assert.equal(row.headState, 'unborn')
  assert.deepEqual(row.attention, ['merge', 'bisect'])
  assert.deepEqual(snapshot.errors.map(error => error.code), ['invalid-worktree', 'invalid-worktree'])
})

test('action ledger survives projection replacement and blocks a second mutation until the original lease ends', () => {
  const ledger = new GitActionLedger()
  const lease = ledger.begin('local', { kind: 'create', operationId: 'op-1' })
  assert.ok(lease !== undefined)
  // No source/projection object participates in authority: reconnect reads
  // the same lease, and another action cannot mint a second operation.
  assert.deepEqual(ledger.current('local'), { kind: 'create', operationId: 'op-1' })
  assert.equal(ledger.begin('local', { kind: 'remove', operationId: 'op-2' }), undefined)
  assert.equal(ledger.end({ ...lease, token: Symbol('stale') }), false)
  assert.deepEqual(ledger.current('local'), { kind: 'create', operationId: 'op-1' })
  assert.equal(ledger.end(lease), true)
  assert.equal(ledger.current('local'), undefined)
  assert.ok(ledger.begin('local', { kind: 'remove', operationId: 'op-2' }) !== undefined)
})

test('concurrent forced refresh waiters coalesce into one serialized successor', async () => {
  const gate = new SerializedRefreshes<string>()
  let resolveFirst!: (value: string) => void
  let resolveSecond!: (value: string) => void
  const first = new Promise<string>(resolve => { resolveFirst = resolve })
  const second = new Promise<string>(resolve => { resolveSecond = resolve })
  const writes: string[] = []
  let fetches = 0
  const task = async (): Promise<string> => {
    fetches += 1
    const value = await (fetches === 1 ? first : second)
    writes.push(value)
    return value
  }

  const initial = gate.run('local', false, task)
  const forcedA = gate.run('local', true, task)
  const forcedB = gate.run('local', true, task)
  assert.equal(fetches, 1)
  resolveFirst('old')
  assert.equal(await initial, 'old')
  // Let the queued successor enter task() before resolving its deferred.
  await Promise.resolve()
  assert.equal(fetches, 2)
  resolveSecond('fresh')
  assert.deepEqual(await Promise.all([forcedA, forcedB]), ['fresh', 'fresh'])
  assert.equal(fetches, 2)
  assert.deepEqual(writes, ['old', 'fresh'])
})

test('session closure enumerates direct + transitive subsessions, cycle-safe and excluding unrelated sessions', () => {
  const sessions = [
    { sessionId: 'root-a' },
    { sessionId: 'sub-a1', parentSessionId: 'root-a' },
    { sessionId: 'sub-a2', parentSessionId: 'sub-a1' },
    { sessionId: 'root-b' },
    { sessionId: 'sub-b1', parentSessionId: 'root-b' },
    { sessionId: 'unrelated' },
    // Cycle: c1 <-> c2 must terminate.
    { sessionId: 'c1', parentSessionId: 'c2' },
    { sessionId: 'c2', parentSessionId: 'c1' },
  ]
  const closure = collectSessionClosure(sessions, ['root-a', 'c1'])
  assert.deepEqual(closure, ['root-a', 'c1', 'sub-a1', 'c2', 'sub-a2'])
  assert.equal(collectSessionClosure(sessions, ['root-b']).length, 2)
  assert.equal(collectSessionClosure(sessions, ['missing-root']).length, 1)
  assert.equal(collectSessionClosure([], ['root-a']).length, 1)
})

test('snapshot passes through unknown sourceError codes while keeping partial facts', () => {
  const snapshot = normalizeGitSnapshot({
    repos: [{ repoId: REPO_ID, commonDir: '/repo/.git', mainPath: '/repo', worktrees: [worktree()], branches: [] }],
    errors: [],
    sourceError: { code: 'newer-host-error-code', message: 'explicit' },
  })
  assert.equal(snapshot.sourceError?.code, 'newer-host-error-code')
  assert.equal(snapshot.repos[0].worktrees.length, 1)
  assert.throws(
    () => normalizeGitSnapshot({
      repos: [], errors: [], sourceError: { code: 42, message: 'bad' },
    }),
    /sourceError must carry string code\/message/,
  )
})

test('workspace-centric discovery maps workspaces to their git rows by workspaceId', () => {
  const snapshot: GitWorktreeSnapshot = {
    repos: [
      {
        repoId: REPO_ID, commonDir: '/a/.git', mainPath: '/a',
        branches: [],
        worktrees: [
          worktree({ path: '/a', workspaceId: 'ws-a', isMain: true }),
          { ...worktree({ path: '/a/wt-x', workspaceId: 'ws-a' }), worktreeId: `worktree_${'c'.repeat(64)}` },
          { ...worktree({ path: '/a/wt-orphan', workspaceId: null }), worktreeId: `worktree_${'d'.repeat(64)}` },
        ],
      },
      {
        repoId: `repo_${'e'.repeat(64)}`, commonDir: '/b/.git', mainPath: '/b',
        branches: [],
        worktrees: [{ ...worktree({ path: '/b', workspaceId: 'ws-b' }), worktreeId: `worktree_${'f'.repeat(64)}` }],
      },
    ],
    errors: [],
  }
  const wsA = gitFactsForWorkspace(snapshot, 'ws-a')
  assert.equal(wsA.length, 2)
  assert.deepEqual(wsA.map(entry => entry.worktree.path), ['/a', '/a/wt-x'])
  assert.equal(wsA[0].repoId, REPO_ID)
  assert.equal(gitFactsForWorkspace(snapshot, 'ws-b').length, 1)
  assert.equal(gitFactsForWorkspace(snapshot, 'ws-unknown').length, 0)
  // Unregistered rows (workspaceId null) match no workspace.
  assert.equal(gitFactsForWorkspace(snapshot, 'unmatched').length, 0)
})


test('an older host omitting attention/upstream/ahead/behind degrades instead of rejecting the row', () => {
  const snapshot = normalizeGitSnapshot({
    repos: [
      {
        repoId: REPO_ID, commonDir: '/repo/.git', mainPath: '/repo',
        branches: [],
        worktrees: [
          {
            worktreeId: WORKTREE_ID, path: '/repo', head: HEAD, branch: 'main', isMain: true,
            dirty: false, locked: false, status: 'ready', headState: 'branch',
            workspaceId: 'ws-1', sessionIds: [], runningSessionIds: [],
            // attention / upstream / ahead / behind all ABSENT (old host).
          },
        ],
      },
    ],
    errors: [],
  })
  assert.equal(snapshot.errors.length, 0)
  assert.equal(snapshot.repos.length, 1)
  const row = snapshot.repos[0]!.worktrees[0]!
  assert.deepEqual(row.attention, [])
  assert.equal(row.upstream, null)
  assert.equal(row.ahead, 0)
  assert.equal(row.behind, 0)
})

test('a PRESENT but unknown attention reason still fails the row closed', () => {
  const snapshot = normalizeGitSnapshot({
    repos: [
      {
        repoId: REPO_ID, commonDir: '/repo/.git', mainPath: '/repo',
        branches: [],
        worktrees: [
          {
            worktreeId: WORKTREE_ID, path: '/repo', head: HEAD, branch: 'main', isMain: true,
            dirty: false, locked: false, status: 'ready', headState: 'branch',
            attention: ['future-reason'],
            workspaceId: 'ws-1', sessionIds: [], runningSessionIds: [],
          },
        ],
      },
    ],
    errors: [],
  })
  assert.ok(snapshot.repos[0]!.worktrees.length === 0, 'unknown attention reason must reject the row')
})
