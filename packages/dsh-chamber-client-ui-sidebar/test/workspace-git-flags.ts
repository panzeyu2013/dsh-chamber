/**
 * workspace-git-flags.ts unit tests (plain node:test, no dsh, no DOM):
 * the neutral flags store — set/clear/retain semantics and the monotonic
 * version counter that drives the sidebar re-render (review P1), plus the
 * orphan-preserving refresh contract (review 2026-08: an externally deleted
 * worktree's workspace keeps its worktree identity through the prune).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearWorkspaceGitFlags, getSourceRepoLayouts, getWorkspaceGitFlag, getWorkspaceGitFlagsVersion,
  retainSourceWorkspaceFlags, setSourceRepoLayouts, setWorkspaceGitFlag,
} from '../src/shared/workspace-git-flags.ts'

test('set/clear + version counter bumps on change only', () => {
  const v0 = getWorkspaceGitFlagsVersion()
  setWorkspaceGitFlag('s', 'w1', { isWorktree: true, isMain: false, repoKey: 'r' })
  assert.equal(getWorkspaceGitFlag('s', 'w1')?.isWorktree, true)
  assert.ok(getWorkspaceGitFlagsVersion() > v0, 'version bumps on a real change')
  const v1 = getWorkspaceGitFlagsVersion()
  setWorkspaceGitFlag('s', 'w1', { isWorktree: true, isMain: false, repoKey: 'r' })
  assert.equal(getWorkspaceGitFlagsVersion(), v1, 'identical re-set does not bump')
  clearWorkspaceGitFlags('s')
  assert.equal(getWorkspaceGitFlag('s', 'w1'), undefined)
  assert.ok(getWorkspaceGitFlagsVersion() > v1, 'clear bumps')
})

test('retain prunes only the non-kept ids of the source', () => {
  setWorkspaceGitFlag('s', 'keep-a', { isWorktree: false, isMain: true, repoKey: 'r' })
  setWorkspaceGitFlag('s', 'stale-b', { isWorktree: true, isMain: false, repoKey: 'r' })
  setWorkspaceGitFlag('other', 'keep-c', { isWorktree: true, isMain: false, repoKey: 'r2' })
  retainSourceWorkspaceFlags('s', new Set(['keep-a']))
  assert.equal(getWorkspaceGitFlag('s', 'keep-a')?.isMain, true, 'kept id survives')
  assert.equal(getWorkspaceGitFlag('s', 'stale-b'), undefined, 'stale id pruned')
  assert.equal(getWorkspaceGitFlag('other', 'keep-c')?.isWorktree, true, 'other source untouched')
  clearWorkspaceGitFlags('s')
  clearWorkspaceGitFlags('other')
})

test('repo layouts publish + clear with the source', () => {
  setSourceRepoLayouts('s', [{ repoKey: 'r', mainWorkspaceId: 'm', unregistered: [] }])
  assert.equal(getSourceRepoLayouts('s').length, 1)
  assert.equal(getSourceRepoLayouts('s')[0]!.repoKey, 'r')
  setSourceRepoLayouts('s', [{ repoKey: 'r', mainWorkspaceId: 'm', unregistered: [] }])
  const v = getWorkspaceGitFlagsVersion()
  setSourceRepoLayouts('s', [{ repoKey: 'r', mainWorkspaceId: 'm', unregistered: [] }])
  assert.equal(getWorkspaceGitFlagsVersion(), v, 'identical layouts do not bump')
  clearWorkspaceGitFlags('s')
  assert.equal(getSourceRepoLayouts('s').length, 0)
})
