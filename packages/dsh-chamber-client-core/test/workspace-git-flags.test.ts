/**
 * workspace-git-flags PR2 contract: UnregisteredWorktreeInfo carries `path` and
 * `locked`, the layout dedupe compares EVERY field (key-order insensitive) so a
 * path/lock-only refresh is never dropped, and no synthetic flag is published
 * for derived checkout rows (their identity lives on the derived row).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearWorkspaceGitFlags,
  getSourceRepoLayouts,
  getWorkspaceGitFlag,
  getWorkspaceGitFlagsVersion,
  setSourceRepoLayouts,
} from '../src/workspace-git-flags.ts'
import { layout, worktree } from './support/fixtures.ts'

test('layout dedupe compares all fields, including path/locked, and ignores key order', () => {
  clearWorkspaceGitFlags('s')
  const first = [layout('r1', 'm1', [worktree('/repo/wt', { branch: 'feat', dirty: true, locked: true })])]
  setSourceRepoLayouts('s', first)
  const v0 = getWorkspaceGitFlagsVersion()

  // The SAME facts, rebuilt with a different key order: no churn.
  const wt = worktree('/repo/wt', { branch: 'feat', dirty: true, locked: true })
  const reorderedWt = {
    head: wt.head,
    locked: wt.locked,
    dirty: wt.dirty,
    attention: [...wt.attention],
    headState: wt.headState,
    status: wt.status,
    branch: wt.branch,
    path: wt.path,
    worktreeId: wt.worktreeId,
    name: wt.name,
  }
  setSourceRepoLayouts('s', [{ unregistered: [reorderedWt], mainWorkspaceId: 'm1', repoKey: 'r1' }])
  assert.equal(getWorkspaceGitFlagsVersion(), v0, 'identical layouts in another key order do not bump')

  // Every field is load-bearing: path and locked included.
  setSourceRepoLayouts('s', [layout('r1', 'm1', [worktree('/repo/wt-moved', { branch: 'feat', dirty: true, locked: true })])])
  const vPath = getWorkspaceGitFlagsVersion()
  assert.ok(vPath > v0, 'a path-only change republishes')
  setSourceRepoLayouts('s', [layout('r1', 'm1', [worktree('/repo/wt-moved', { branch: 'feat', dirty: true, locked: false })])])
  const vLock = getWorkspaceGitFlagsVersion()
  assert.ok(vLock > vPath, 'a locked-only change republishes')
  setSourceRepoLayouts('s', [layout('r1', 'm1', [worktree('/repo/wt-moved', { branch: 'feat', dirty: false, locked: false })])])
  assert.ok(getWorkspaceGitFlagsVersion() > vLock, 'a dirty-only change republishes')
  assert.equal(getSourceRepoLayouts('s').length, 1)
  clearWorkspaceGitFlags('s')
  assert.deepEqual(getSourceRepoLayouts('s'), [])
})

test('layouts never mint a synthetic checkout flag (derived rows drive checkout identity)', () => {
  clearWorkspaceGitFlags('s')
  setSourceRepoLayouts('s', [layout('r1', 'm1', [worktree('/repo/wt')])])
  assert.equal(getWorkspaceGitFlag('s', '__checkout__:/repo/wt'), undefined)
  assert.equal(getWorkspaceGitFlag('s', '/repo/wt'), undefined)
  clearWorkspaceGitFlags('s')
})
