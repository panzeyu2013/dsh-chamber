import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  canTargetSession, createSourceOptions,
  gitFactsForWorkspace, sourceBranchChoices,
} from '../../src/shared/git-facts.ts'
import { GitActionLedger } from '../../src/shared/action-ledger.ts'
import { SerializedRefreshes } from '../../src/shared/refresh-flight.ts'
import { normalizeGitSnapshot } from '../../src/shared/snapshot.ts'
import type { GitWorktreeInfo, GitWorktreeSnapshot } from '../../src/shared/types.ts'
import { HEAD, REPO_ID, WORKTREE_ID } from '../support/fixtures.ts'

function worktree(extra: Partial<GitWorktreeInfo> = {}): GitWorktreeInfo {
  return {
    worktreeId: WORKTREE_ID, path: '/repo', head: HEAD, branch: 'main', isMain: false,
    dirty: false, locked: false, status: 'ready', headState: 'branch',
    upstream: 'origin/main', ahead: 1, behind: 0, attention: [],
    workspaceId: 'ws-1', sessionIds: [], runningSessionIds: [],
    ...extra,
  }
}

/** One host repo projection with the shared case defaults. */
function repo(worktrees: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { repoId: REPO_ID, commonDir: '/repo/.git', mainPath: '/repo', branches: [], worktrees, ...extra }
}

/** Normalize one raw snapshot through the module under test. */
function normalize(repos: unknown[], errors: unknown[] = [], extra: Record<string, unknown> = {}) {
  return normalizeGitSnapshot({ repos, errors, ...extra })
}

test('snapshot keeps valid siblings beside malformed rows and preserves opaque ids', () => {
  const snapshot = normalize([
    repo([
      worktree(),
      { path: '/missing-id', head: '123', branch: null },
      { ...worktree({ path: '/duplicate' }), worktreeId: WORKTREE_ID },
    ]),
    { commonDir: '/bad/.git', mainPath: '/bad', worktrees: [], branches: [] },
  ], [{ code: 'status-failed', operation: 'status', path: '/other', message: 'one repo failed' }])
  assert.equal(snapshot.repos.length, 1)
  assert.equal(snapshot.repos[0].repoId, REPO_ID)
  assert.deepEqual(snapshot.repos[0].worktrees.map(row => row.worktreeId), [WORKTREE_ID])
  assert.deepEqual(snapshot.errors.map(error => error.code), ['status-failed', 'invalid-worktree', 'duplicate-worktree-id', 'invalid-repo'])
})

test('a malformed snapshot branches value degrades to the empty fallback without rejecting the repo', () => {
  const snapshot = normalize([repo([worktree()], { branches: 'not-an-array' })])
  assert.equal(snapshot.repos.length, 1, 'the repo row survives: the fallback list is optional')
  assert.deepEqual(snapshot.repos[0].branches, [], 'the picker fallback degrades to empty, never a hard failure')
})

test('snapshot projects the optional blockingRunningSessionIds (absent on an old host, malformed fails the row)', () => {
  const withField = normalize([repo([worktree({ runningSessionIds: ['s1', 's2'], blockingRunningSessionIds: ['s2'] })])])
  assert.deepEqual(withField.repos[0]!.worktrees[0]!.runningSessionIds, ['s1', 's2'])
  assert.deepEqual(withField.repos[0]!.worktrees[0]!.blockingRunningSessionIds, ['s2'])

  const withoutField = normalize([repo([worktree({ runningSessionIds: ['s1'] })])])
  assert.equal(withoutField.repos[0]!.worktrees[0]!.blockingRunningSessionIds, undefined,
    'an old host omits the field — the client falls back to runningSessionIds')

  const malformed = normalize([repo([worktree({ blockingRunningSessionIds: ['ok', 7] as unknown as string[] })])])
  assert.equal(malformed.repos[0]!.worktrees.length, 0, 'a present-but-malformed value fails the row (fail closed)')
  assert.equal(malformed.errors.some(error => error.code === 'invalid-worktree'), true)

  // Non-subset: the archived-aware field names RUNNING sessions that block —
  // an id it names but runningSessionIds does not is a host defect, and the
  // dialog's set-difference inert count would under-report. Fail the row.
  const nonSubset = normalize([repo([worktree({ runningSessionIds: ['s1'], blockingRunningSessionIds: ['s1', 's2'] })])])
  assert.equal(nonSubset.repos[0]!.worktrees.length, 0, 'a non-subset blocking list fails the row (fail closed)')
  assert.equal(nonSubset.errors.some(error => error.code === 'invalid-worktree'), true)
})

test('snapshot never turns missing collections or malformed membership into healthy empty facts', () => {
  assert.throws(() => normalizeGitSnapshot({ errors: [] }), /repos must be an array/)
  assert.throws(() => normalizeGitSnapshot({ repos: [] }), /errors must be an array/)
  const snapshot = normalize([repo([{ ...worktree(), sessionIds: 'not-an-array' }])], [{ nope: true }])
  assert.equal(snapshot.repos[0].worktrees.length, 0)
  assert.deepEqual(snapshot.errors.map(error => error.code), ['invalid-error', 'invalid-worktree'])
})

test('create sources select the registered main checkout by opaque identity', () => {
  const snapshot: GitWorktreeSnapshot = normalize([repo([worktree({ isMain: true })], { commonDir: '/same' })])
  assert.deepEqual(createSourceOptions(snapshot), [{ workspaceId: 'ws-1', repoId: REPO_ID, label: 'repo' }])
  assert.deepEqual(createSourceOptions(normalize([repo([worktree({ isMain: true, workspaceId: null })])])), [])
})

test('create sources are main checkouts only (V6): a linked workspace is never a fallback', () => {
  // A linked worktree with a registered workspace must NOT become the source:
  // the host refuses it (source-not-main-checkout) and the session root would be
  // wrong (design 08 I1).
  assert.deepEqual(createSourceOptions(normalize([repo([worktree()])])), [])
  // An unregistered main checkout offers no create source at all (I9).
  assert.deepEqual(createSourceOptions(normalize([repo([worktree({ isMain: true, workspaceId: null })])])), [])
})

test('source-branch choices keep the main checkout branch selectable and never empty for a real repo', () => {
  // The host list is authoritative and passed through UNFILTERED: `main` is a
  // valid base (the host resolves it via localBranchHead) and filtering it out
  // would make a single-branch repository show an empty picker.
  assert.deepEqual(sourceBranchChoices(['main'], []), ['main'])
  assert.deepEqual(sourceBranchChoices(['main', 'mobile'], ['main']), ['main', 'mobile'])
  // A deleted remembered branch is dropped by the caller's membership check,
  // so a stale localStorage value can never resurrect a gone branch.
  assert.equal(sourceBranchChoices(['main', 'mobile'], []).includes('swift'), false)
  // Fallback path (host list absent/older): the selected repo's own worktree
  // branches, deduplicated in row order, detached rows skipped.
  assert.deepEqual(sourceBranchChoices([], ['main', 'mobile', 'main', null]), ['main', 'mobile'])
  assert.deepEqual(sourceBranchChoices([], []), [])
})

test('the create dialog never filters the main checkout branch out of the source picker', () => {
  // Source-level pin: a pure-helper test alone cannot catch filtering being
  // re-added at the call site. Positive pin: the picker consumes the helper
  // result; the ONLY per-candidate change is the mode-scoped checked-out
  // advisory (by construction 'false' in the NEW-branch startRef path).
  const dialog = readFileSync(new URL('../../src/client/CreateWorktreeDialog.tsx', import.meta.url), 'utf8')
  assert.match(dialog, /items=\{branchMenuItems\}/,
    'the source-branch picker must offer the helper result (main checkout branch included)')
  assert.match(dialog, /branchOptionCheckedOut\(name, \w+, mode\)/,
    'the checked-out advisory must stay mode-scoped so the startRef picker keeps the main branch')
  assert.doesNotMatch(dialog, /existingBranchChoices\.filter/,
    'the source-branch picker must never filter the main checkout branch out')
})

test('session targeting requires a healthy worktree', () => {
  assert.equal(canTargetSession(worktree()), true)
  assert.equal(canTargetSession(worktree({ status: 'missing' })), false)
  assert.equal(canTargetSession(worktree({ status: 'invalid' })), false)
  assert.equal(canTargetSession(worktree({ status: 'not-a-repo' })), false)
  // An unregistered checkout is a session target (path-based enter, no registration).
  assert.equal(canTargetSession(worktree({ workspaceId: null })), true)
})

test('snapshot normalizes health/head/attention fields and rejects malformed values', () => {
  const snapshot = normalize([repo([
    worktree({ status: 'missing', headState: 'unborn', attention: ['merge', 'bisect'] }),
    { ...worktree(), status: 'bogus' },
    { ...worktree(), headState: 'detached', attention: ['nope'] },
  ])])
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

test('snapshot passes through unknown sourceError codes while keeping partial facts', () => {
  const snapshot = normalize([repo([worktree()])], [], { sourceError: { code: 'newer-host-error-code', message: 'explicit' } })
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
  const snapshot: GitWorktreeSnapshot = normalize([
    repo([
      worktree({ path: '/a', workspaceId: 'ws-a', isMain: true }),
      { ...worktree({ path: '/a/wt-x', workspaceId: 'ws-a' }), worktreeId: `worktree_${'c'.repeat(64)}` },
      { ...worktree({ path: '/a/wt-orphan', workspaceId: null }), worktreeId: `worktree_${'d'.repeat(64)}` },
    ], { commonDir: '/a/.git', mainPath: '/a' }),
    repo([{ ...worktree({ path: '/b', workspaceId: 'ws-b' }), worktreeId: `worktree_${'f'.repeat(64)}` }], {
      repoId: `repo_${'e'.repeat(64)}`, commonDir: '/b/.git', mainPath: '/b',
    }),
  ])
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
  const snapshot = normalize([repo([{
    worktreeId: WORKTREE_ID, path: '/repo', head: HEAD, branch: 'main', isMain: true,
    dirty: false, locked: false, status: 'ready', headState: 'branch',
    workspaceId: 'ws-1', sessionIds: [], runningSessionIds: [],
    // attention / upstream / ahead / behind all ABSENT (old host).
  }])])
  assert.equal(snapshot.errors.length, 0)
  assert.equal(snapshot.repos.length, 1)
  const row = snapshot.repos[0]!.worktrees[0]!
  assert.deepEqual(row.attention, [])
  assert.equal(row.upstream, null)
  assert.equal(row.ahead, 0)
  assert.equal(row.behind, 0)
})

test('a PRESENT but unknown attention reason still fails the row closed', () => {
  const snapshot = normalize([repo([{
    worktreeId: WORKTREE_ID, path: '/repo', head: HEAD, branch: 'main', isMain: true,
    dirty: false, locked: false, status: 'ready', headState: 'branch',
    attention: ['future-reason'],
    workspaceId: 'ws-1', sessionIds: [], runningSessionIds: [],
  }])])
  assert.ok(snapshot.repos[0]!.worktrees.length === 0, 'unknown attention reason must reject the row')
})
