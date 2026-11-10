/**
 * On-demand branch candidates (`branches`, design 08 §2.1/§4.1).
 *
 * The create dialog's picker reads Git AT OPEN TIME: an out-of-band branch (forge composer,
 * agent `create_worktree`, a terminal) must be visible even when a snapshot cached the
 * discovery seconds earlier, and a read failure must be explicit instead of the snapshot's
 * silent empty-list degrade.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_BRANCH_CANDIDATES } from '../src/core.ts'
import { MAIN, setup, coreOver, refuses } from './support/fake-repository.ts'

const FRESH_HEAD = 'a'.repeat(40)

/** Run the real core over the fake repository with one overridden Git command. */
async function coreWithShowRef(
  repo: ReturnType<typeof setup>['repo'],
  showRef: { exitCode: number; stdout: string; stderr?: string },
) {
  const runner = repo.runner
  return coreOver({
    workspaces: [{ workspaceId: 'ws-main', path: MAIN, sessionIds: [] }],
    git: async request => request.args[0] === 'show-ref' && request.args[1] === '--heads'
      ? { exitCode: showRef.exitCode, stdout: showRef.stdout, stderr: showRef.stderr ?? '' }
      : runner(request),
    fs: repo.fs,
  })
}

test('branches reads Git directly: an out-of-band branch appears after the snapshot cached discovery', async () => {
  const { core, repo } = setup()
  const snapshot = await core.snapshot()
  // Precondition: the cached snapshot predates the out-of-band branch.
  assert.deepEqual(snapshot.repos[0]!.branches, ['main'])
  repo.branches.set('fresh', FRESH_HEAD)
  repo.calls.length = 0

  const result = await core.branches({ sourceWorkspaceId: 'ws-main' })
  assert.deepEqual([...result.branches].sort(), ['fresh', 'main'])
  assert.equal(result.sourceWorkspaceId, 'ws-main')
  assert.equal(result.repoId, snapshot.repos[0]!.repoId)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.checkedOutBranches, ['main'])
  assert.ok(
    repo.calls.some(call => call.args[0] === 'show-ref' && call.args[1] === '--heads'),
    'the on-demand read must run its own show-ref (never the snapshot discovery cache)',
  )

  // Every call reflects the current refs, not a cached first answer.
  repo.branches.set('newer', 'b'.repeat(40))
  const again = await core.branches({ sourceWorkspaceId: 'ws-main' })
  assert.ok(again.branches.includes('newer'))
})

test('unborn repository (show-ref exit 1 + empty output) is an empty candidate list, not a failure', async () => {
  const { repo } = setup()
  repo.branches.clear()
  const core = await coreWithShowRef(repo, { exitCode: 1, stdout: '' })
  const result = await core.branches({ sourceWorkspaceId: 'ws-main' })
  assert.deepEqual(result.branches, [])
  assert.equal(result.truncated, false)
})

test('a repo with no refs (show-ref exit 0 + empty output) is an empty list too (Git-version tolerance)', async () => {
  const { core, repo } = setup()
  repo.branches.clear()
  const result = await core.branches({ sourceWorkspaceId: 'ws-main' })
  assert.deepEqual(result.branches, [], 'some Git versions answer --heads with exit 0 and no refs')
  assert.equal(result.truncated, false)
})

test('show-ref failures are explicit, never a silent empty list', async () => {
  // Non-zero exit with output: a failed read, not an empty repository.
  const failing = setup()
  const failingCore = await coreWithShowRef(failing.repo, { exitCode: 1, stdout: 'deadbeef', stderr: 'refs unavailable' })
  await assert.rejects(
    failingCore.branches({ sourceWorkspaceId: 'ws-main' }),
    refuses('git-command-failed', /show-ref/u),
  )
  // A malformed line is a protocol drift, not a shorter list.
  const drifted = setup()
  const driftedCore = await coreWithShowRef(drifted.repo, { exitCode: 0, stdout: 'not-a-ref-line\n' })
  await assert.rejects(
    driftedCore.branches({ sourceWorkspaceId: 'ws-main' }),
    refuses('git-protocol-error', /unexpected local-branch line/u),
  )
})

test('the source gate mirrors previewCreate: unknown workspace, linked source, bad input', async () => {
  const linked = setup({ linked: true })
  await assert.rejects(linked.core.branches({ sourceWorkspaceId: 'nope' }), refuses('workspace/not-found'))
  await assert.rejects(linked.core.branches({ sourceWorkspaceId: 'ws-feature' }), refuses('source-not-main-checkout'))
  await assert.rejects(
    linked.core.branches({ sourceWorkspaceId: 'ws-main', extra: true } as never),
    refuses('invalid-input'),
  )
})

test('checkedOutBranches covers every worktree of the repository (advisory set)', async () => {
  const { core } = setup({ linked: true })
  const result = await core.branches({ sourceWorkspaceId: 'ws-main' })
  assert.deepEqual(result.checkedOutBranches, ['feature', 'main'])
})

test('checkedOutBranches is bounded too and reports truncation', async () => {
  const { core, repo } = setup()
  for (let index = 0; index < MAX_BRANCH_CANDIDATES + 5; index += 1) {
    repo.worktrees.push({ path: `/repos/pool/w${index}`, branch: `wt${index}`, head: 'd'.repeat(40) })
  }
  const result = await core.branches({ sourceWorkspaceId: 'ws-main' })
  assert.equal(result.checkedOutBranches.length, MAX_BRANCH_CANDIDATES)
  assert.equal(result.truncated, true)
})

test('the candidate list is bounded and reports truncation', async () => {
  const { core, repo } = setup()
  for (let index = 0; index < MAX_BRANCH_CANDIDATES + 10; index += 1) {
    repo.branches.set(`b${index}`, 'c'.repeat(40))
  }
  const result = await core.branches({ sourceWorkspaceId: 'ws-main' })
  assert.equal(result.branches.length, MAX_BRANCH_CANDIDATES)
  assert.equal(result.truncated, true)
})
