/**
 * Layout publication (design 08 PR2, 11-final-design §5.1): the Git plugin's
 * snapshot-to-layout projection is the derived checkout rows' ONLY fact source, so
 * the placement key (path) and the removal guard's locked fact must be published
 * for every unregistered non-main checkout — while the main checkout and every
 * REGISTERED worktree stay out of the unregistered list (their row is the
 * workspace row; a second derived row would split the same path's sessions).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { repoLayouts } from '../../src/shared/layout.ts'
import type { GitRepoTopology, GitWorktreeInfo, GitWorktreeSnapshot } from '../../src/shared/types.ts'

const HEAD = 'c'.repeat(40)

/** One worktree row with honest defaults; each case names only its facts. */
function worktree(patch: Partial<GitWorktreeInfo> & { path: string; isMain: boolean }): GitWorktreeInfo {
  return {
    worktreeId: 'worktree_' + patch.path.replace(/\W+/gu, '_'),
    head: HEAD,
    branch: 'main',
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

test('layout rows carry the placement path, locked and the opaque worktree id for unregistered non-main checkouts', () => {
  const layouts = repoLayouts(snapshot(repo('repo_a', [
    worktree({ path: '/repo', isMain: true }),
    worktree({
      path: '/repo/.agents/worktrees/feature',
      isMain: false,
      worktreeId: 'worktree_feature',
      branch: 'feature/x',
      dirty: null,
      locked: true,
      status: 'missing',
      headState: 'detached',
      head: 'a'.repeat(40),
      attention: ['rebase'],
      workspaceId: null,
    }),
  ])))
  assert.equal(layouts.length, 1)
  const entry = layouts[0]!
  assert.equal(entry.repoKey, 'repo_a')
  assert.equal(entry.mainWorkspaceId, null, 'the main checkout is unregistered: no session root (I9)')
  assert.equal(entry.unregistered.length, 1, 'the MAIN checkout is never an unregistered row')
  const row = entry.unregistered[0]!
  // The exact published shape: every key here is consumed downstream (path by the
  // derived row, locked by the removal guard, worktreeId by the host input).
  assert.deepEqual(row, {
    name: 'feature',
    worktreeId: 'worktree_feature',
    branch: 'feature/x',
    status: 'missing',
    headState: 'detached',
    attention: ['rebase'],
    dirty: null,
    head: 'a'.repeat(40),
    path: '/repo/.agents/worktrees/feature',
    locked: true,
  })
})

test('a registered worktree is not a layout row, and its repository main checkout names the session root', () => {
  const layouts = repoLayouts(snapshot(repo('repo_b', [
    worktree({ path: '/repo-b', isMain: true, workspaceId: 'ws-main' }),
    worktree({ path: '/repo-b/.agents/worktrees/registered', isMain: false, workspaceId: 'ws-linked' }),
    worktree({ path: '/repo-b/.agents/worktrees/free', isMain: false, workspaceId: null }),
  ])))
  const entry = layouts[0]!
  assert.equal(entry.mainWorkspaceId, 'ws-main')
  assert.deepEqual(entry.unregistered.map(row => row.path), ['/repo-b/.agents/worktrees/free'],
    'a registered worktree keeps its workspace row; only the unregistered checkout derives one')
})

test('every repository contributes one entry in snapshot order (multi-repo sources stay isolated)', () => {
  const layouts = repoLayouts(snapshot(
    repo('repo_one', [worktree({ path: '/one', isMain: true, workspaceId: 'ws-1' })]),
    repo('repo_two', [worktree({ path: '/two', isMain: true, workspaceId: 'ws-2' }),
      worktree({ path: '/two/.agents/worktrees/t', isMain: false, locked: true })]),
  ))
  assert.deepEqual(layouts.map(entry => entry.repoKey), ['repo_one', 'repo_two'])
  assert.deepEqual(layouts.map(entry => entry.mainWorkspaceId), ['ws-1', 'ws-2'])
  assert.deepEqual(layouts[0]!.unregistered, [])
  assert.equal(layouts[1]!.unregistered[0]!.locked, true)
})

test('attention is copied, so a later mutation of the snapshot row cannot rewrite a published layout', () => {
  const attention = ['merge']
  const layouts = repoLayouts(snapshot(repo('repo_c', [
    worktree({ path: '/repo-c', isMain: true, workspaceId: 'ws-c' }),
    worktree({ path: '/repo-c/.agents/worktrees/a', isMain: false, attention }),
  ])))
  attention.push('rebase')
  assert.deepEqual(layouts[0]!.unregistered[0]!.attention, ['merge'])
})

test('an empty snapshot publishes no layout (a disconnected/failed round clears the checkout rows)', () => {
  assert.deepEqual(repoLayouts({ repos: [], errors: [] }), [])
})
