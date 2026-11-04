/**
 * Derived checkout-row facts + removal guard (design 08 PR2, 11-final-design §5.8).
 *
 * A checkout row is NOT a dsh workspace: its facts are resolved by PATH (the
 * occurrence keeps naming the SOURCE main workspace id) and its removal guard must
 * drop the registered-only assumptions — 'unregistered' is the PRECONDITION of the
 * path-based removal, and an IDLE viewed session is removable (ensure() falls back
 * to the source) while a RUNNING one is not. The registered guard was deleted in
 * PR3, so this is the ONLY removal guard left.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkoutDisplayLabel, checkoutRemoveBlockReason, findCheckout } from '../../src/shared/checkout.ts'
import type { GitRepoTopology, GitWorktreeInfo, GitWorktreeSnapshot } from '../../src/shared/types.ts'

const HEAD = 'c'.repeat(40)

function worktree(patch: Partial<GitWorktreeInfo> & { path: string }): GitWorktreeInfo {
  return {
    worktreeId: 'worktree_' + patch.path.replace(/\W+/gu, '_'),
    isMain: false,
    head: HEAD,
    branch: 'feature',
    dirty: false,
    locked: false,
    status: 'ready',
    headState: 'branch',
    upstream: null,
    ahead: 0,
    behind: 0,
    attention: [],
    workspaceId: null,
    sessionIds: [],
    runningSessionIds: [],
    ...patch,
  }
}

function repo(repoId: string, worktrees: GitWorktreeInfo[]): GitRepoTopology {
  return {
    repoId,
    commonDir: '/repos/' + repoId + '/.git',
    mainPath: worktrees[0]?.path ?? '/repo',
    worktrees,
    branches: [],
  }
}

function snapshot(...repos: GitRepoTopology[]): GitWorktreeSnapshot {
  return { repos, errors: [] }
}

/** The checkout path every guard case shares. */
const CHECKOUT = '/repo/.agents/worktrees/feature'

test('findCheckout resolves a derived row by canonical path, scoped by the repository identity', () => {
  const feature = worktree({ path: CHECKOUT, worktreeId: 'worktree_feature' })
  const other = worktree({ path: '/repo/.agents/worktrees/other' })
  const snap = snapshot(
    repo('repo_a', [worktree({ path: '/repo', isMain: true, workspaceId: 'ws-main' }), feature, other]),
    repo('repo_b', [worktree({ path: '/another', isMain: true })]),
  )
  const found = findCheckout(snap, CHECKOUT)
  assert.equal(found?.repo.repoId, 'repo_a')
  assert.equal(found?.worktree.worktreeId, 'worktree_feature')
  // The sidebar's repoKey scopes the search: a checkout path can only belong to one
  // repository, but a STALE layout must not match another repository's row.
  assert.equal(findCheckout(snap, CHECKOUT, 'repo_a')?.repo.repoId, 'repo_a')
  assert.equal(findCheckout(snap, CHECKOUT, 'repo_b'), undefined)
  // Trailing separators are the one spelling the host can leave unnormalized.
  assert.equal(findCheckout(snap, CHECKOUT + '/')?.worktree.path, CHECKOUT)
  // Externally removed checkout: no snapshot row — the caller must fail closed.
  assert.equal(findCheckout(snap, '/repo/.agents/worktrees/gone'), undefined)
})

test('findCheckout matches an UNREGISTERED worktree by path (no workspace id involved)', () => {
  const snap = snapshot(repo('repo_a', [
    worktree({ path: '/repo', isMain: true, workspaceId: 'ws-main' }),
    worktree({ path: CHECKOUT, workspaceId: null }),
  ]))
  const found = findCheckout(snap, CHECKOUT)
  assert.equal(found?.worktree.workspaceId, null)
  assert.equal(found?.worktree.path, CHECKOUT)
})

test('the row label prefers the branch, falls back to the derived title and never prints a null branch', () => {
  assert.equal(checkoutDisplayLabel('feature/x', 'feature/x', CHECKOUT), 'feature/x')
  // Detached checkout: the sidebar's title already fell back to the directory name.
  assert.equal(checkoutDisplayLabel(null, 'feature', CHECKOUT), 'feature')
  assert.equal(checkoutDisplayLabel('', 'feature', CHECKOUT), 'feature')
  // A hostile/partial occurrence: the canonical path's basename is the last resort.
  assert.equal(checkoutDisplayLabel(null, '', CHECKOUT), 'feature')
  assert.equal(checkoutDisplayLabel(undefined, '', '/repo/.agents/worktrees/named/'), 'named')
  // The label feeds copy and accessible names: it must never be the string "null".
  assert.ok(!checkoutDisplayLabel(null, '', CHECKOUT).includes('null'))
})

test('a clean unregistered checkout is removable: "unregistered" is not a block', () => {
  // Every checkout row has workspaceId === null — that is the precondition, not a
  // reason to refuse the path-based removal.
  assert.equal(checkoutRemoveBlockReason(worktree({ path: CHECKOUT })), undefined)
  assert.equal(checkoutRemoveBlockReason(worktree({ path: CHECKOUT, workspaceId: 'ws-x' })), undefined)
})

test('the checkout removal guard rejects main, locked, unhealthy, status-unknown and running', () => {
  assert.equal(checkoutRemoveBlockReason(worktree({ path: '/repo', isMain: true })), 'main')
  assert.equal(checkoutRemoveBlockReason(worktree({ path: CHECKOUT, locked: true })), 'locked')
  assert.equal(checkoutRemoveBlockReason(worktree({ path: CHECKOUT, status: 'invalid' })), 'unhealthy')
  assert.equal(checkoutRemoveBlockReason(worktree({ path: CHECKOUT, status: 'not-a-repo' })), 'unhealthy')
  assert.equal(checkoutRemoveBlockReason(worktree({ path: CHECKOUT, dirty: null })), 'status-unknown')
  assert.equal(checkoutRemoveBlockReason(worktree({ path: CHECKOUT, runningSessionIds: ['s-run'] })), 'running')
  // The archived-aware fact wins when the host provides it; a present-but-empty
  // blocking set means "no session actually gates the removal".
  assert.equal(
    checkoutRemoveBlockReason(worktree({ path: CHECKOUT, runningSessionIds: ['s-run'], blockingRunningSessionIds: [] })),
    undefined,
  )
  assert.equal(
    checkoutRemoveBlockReason(worktree({ path: CHECKOUT, runningSessionIds: [], blockingRunningSessionIds: ['s-run'] })),
    'running',
  )
})

test('a missing path is not blocked: the removal is the leftover-record cleanup', () => {
  assert.equal(checkoutRemoveBlockReason(worktree({ path: CHECKOUT, status: 'missing' })), undefined)
  // The seed snapshot reports dirty=null for a vanished path; that must not degrade to status-unknown.
  assert.equal(checkoutRemoveBlockReason(worktree({ path: CHECKOUT, status: 'missing', dirty: null })), undefined)
  // Locked still wins over missing (the host refuses a locked worktree).
  assert.equal(checkoutRemoveBlockReason(worktree({ path: CHECKOUT, status: 'missing', locked: true })), 'locked')
})

test('a DIRTY checkout stays actionable (the confirmation collects the discard acknowledgement)', () => {
  // 'dirty' is a reason, not a hard block: the row's click opens the confirmation
  // whose acknowledge enables discardChanges.
  assert.equal(checkoutRemoveBlockReason(worktree({ path: CHECKOUT, dirty: true })), 'dirty')
})

test('the VIEWED session: running blocks it, an IDLE one is removable (ensure() falls back to the source)', () => {
  const runningHere = worktree({ path: CHECKOUT, runningSessionIds: ['s-current'] })
  assert.equal(checkoutRemoveBlockReason(runningHere, 's-current'), 'current',
    'the on-screen session is running in this checkout: its cwd must not be deleted')
  // Another session running here is the plain running reason.
  assert.equal(checkoutRemoveBlockReason(runningHere, 's-other'), 'running')
  // An IDLE viewed session never appears in the path-based running facts, so the
  // checkout may be removed — the session's next message falls back to the source.
  const idleHere = worktree({ path: CHECKOUT })
  assert.equal(checkoutRemoveBlockReason(idleHere, 's-current'), undefined)
  // No runtime channel (unmounted/legacy source): the guard must not invent a
  // current-session block; the host's path-based running guard stays authoritative.
  assert.equal(checkoutRemoveBlockReason(idleHere, undefined), undefined)
})
