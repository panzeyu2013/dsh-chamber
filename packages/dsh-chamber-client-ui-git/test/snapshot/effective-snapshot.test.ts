/**
 * The published snapshot for one refresh round: a failed EMPTY round keeps the previous
 * topology (no branch/fold/drag flicker) but must still carry THIS round's path errors —
 * they feed the orphan projection (`path-unavailable` / `workspace-path-failed`) that the
 * sidebar's orphan badge and cleanup entry ride on. Dropping them hides a vanished
 * workspace until some later round succeeds (registered residual, design 08 §6.4).
 * Run directly: node test/snapshot/effective-snapshot.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectiveSnapshot } from '../../src/shared/git-facts.ts'
import type { GitRepoTopology, GitWorktreeError, GitWorktreeSnapshot } from '../../src/shared/types.ts'

const REPO: GitRepoTopology = {
  repoId: 'repo-1', commonDir: '/repo/.git', mainPath: '/repo', worktrees: [], branches: [],
}
const PATH_ERROR: GitWorktreeError = {
  code: 'path-unavailable', operation: 'discover', workspaceId: 'ws-1', path: '/gone', message: 'path is gone',
}
const DEADLINE = { code: 'snapshot-deadline', message: 'deadline' }

function snap(extra: Partial<GitWorktreeSnapshot> = {}): GitWorktreeSnapshot {
  return { repos: [], errors: [], ...extra }
}

test('a healthy round publishes exactly the fresh snapshot', () => {
  const fresh = snap({ repos: [REPO] })
  assert.equal(effectiveSnapshot(snap({ repos: [REPO] }), fresh), fresh,
    'a round without a source error replaces the facts wholesale (identity, not a copy)')
})

test('a partial round with a source error still replaces the previous snapshot', () => {
  const previous = snap({ repos: [REPO] })
  const fresh = snap({ repos: [REPO], errors: [PATH_ERROR], sourceError: DEADLINE })
  assert.equal(effectiveSnapshot(previous, fresh), fresh, 'fresh progress beats stale truth')
})

test('the stale-empty window keeps the previous topology but takes fresh path errors', () => {
  const previous = snap({ repos: [REPO] })
  const fresh = snap({ errors: [PATH_ERROR], sourceError: DEADLINE })
  const effective = effectiveSnapshot(previous, fresh)
  assert.notEqual(effective, previous, 'fresh path health means it is NOT a pure reuse')
  assert.equal(effective.repos, previous.repos, 'the topology stays the previous one (no flicker)')
  assert.deepEqual(effective.errors, [PATH_ERROR], 'the orphan projection sees this round path verdicts')
})

test('a stale-empty round with no fresh errors reuses the previous snapshot untouched', () => {
  const previous = snap({ repos: [REPO] })
  assert.equal(effectiveSnapshot(previous, snap({ sourceError: { code: 'git-unavailable', message: 'no git' } })), previous,
    'nothing fresh => the effective (previous) snapshot is published as-is')
})

test('the first round has nothing to keep: the empty error snapshot is published as-is', () => {
  const fresh = snap({ errors: [PATH_ERROR], sourceError: DEADLINE })
  assert.equal(effectiveSnapshot(undefined, fresh), fresh)
})
