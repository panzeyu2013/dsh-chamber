/**
 * Git worktree core — preview/create replay, rollback authority and operation capacity.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { GitWorktreeError, OPERATION_TTL_MS } from '../src/core.ts'
import {
  LINKED,
  WORKTREES_KEY,
  MAIN_HEAD,
  FEATURE_HEAD,
  setup,
  targetOf,
  previewNew,
  mutationCalls,
} from './support/fake-repository.ts'

test('preview and create a new branch with bounded fixed argv and idempotent replay', async () => {
  const { core, repo } = setup()
  const preview = await previewNew(core)
  assert.equal(preview.targetPath, `/worktrees/${WORKTREES_KEY}/new-worktree`)
  assert.equal(preview.baseHead, MAIN_HEAD)
  assert.match(preview.repoId, /^repo_[0-9a-f]{64}$/)

  const created = await core.create({ previewToken: preview.previewToken, operationId: 'create-1' })
  assert.equal(created.created, true)
  assert.equal(created.replayed, false)
  assert.equal(created.rollbackAuthorized, true)
  assert.equal(created.branchCreated, true)
  assert.match(created.worktreeId, /^worktree_[0-9a-f]{64}$/)
  assert.deepEqual(mutationCalls(repo, 'add')[0]!.args, [
    'worktree', 'add', '-b', 'topic', '--', `/worktrees/${WORKTREES_KEY}/new-worktree`, MAIN_HEAD,
  ])
  assert.equal(mutationCalls(repo, 'add')[0]!.timeoutMs, 30_000)
  assert.equal(mutationCalls(repo, 'add')[0]!.maxOutputBytes, 256 * 1024)

  const replay = await core.create({ previewToken: preview.previewToken, operationId: 'create-1' })
  assert.equal(replay.replayed, true)
  assert.equal(replay.worktreeId, created.worktreeId)
  assert.equal(mutationCalls(repo, 'add').length, 1)
})

test('create revalidates an existing branch and rejects a moved preview', async () => {
  const { core, repo } = setup()
  repo.branches.set('existing', FEATURE_HEAD)
  const preview = await core.previewCreate({
    sourceWorkspaceId: 'ws-main',
    basename: 'existing-tree',
    branch: { kind: 'existing', name: 'existing' },
  })
  repo.branches.set('existing', '3333333333333333333333333333333333333333')
  await assert.rejects(
    core.create({ previewToken: preview.previewToken, operationId: 'stale-1' }),
    error => error instanceof GitWorktreeError && error.code === 'preview-stale',
  )
  assert.equal(mutationCalls(repo, 'add').length, 0)
})

test('a zero-exit add remains rollback-authorized when postcondition reading fails', async () => {
  const { core, repo } = setup()
  const preview = await previewNew(core)
  repo.failListAfterAdd = true
  await assert.rejects(core.create({ previewToken: preview.previewToken, operationId: 'uncertain-create' }))
  assert.equal(repo.worktrees.some(worktree => worktree.path === preview.targetPath), true)
  const reconciled = await core.create({ previewToken: preview.previewToken, operationId: 'uncertain-create' })
  assert.equal(reconciled.replayed, true)
  assert.equal(reconciled.rollbackAuthorized, true)
  assert.equal(mutationCalls(repo, 'add').length, 1)
  const rollback = await core.rollbackCreate({ operationId: 'uncertain-create' })
  assert.equal(rollback.removed, true)
  assert.equal(repo.worktrees.some(worktree => worktree.path === preview.targetPath), false)
})

test('timeout reconciliation can advance but never grants rollback provenance', async () => {
  const { core, repo } = setup()
  const preview = await previewNew(core)
  repo.throwAfterAdd = new GitWorktreeError('git-timeout', 'simulated timeout')
  await assert.rejects(
    core.create({ previewToken: preview.previewToken, operationId: 'timeout-create' }),
    error => error instanceof GitWorktreeError && error.code === 'git-timeout',
  )
  const reconciled = await core.create({ previewToken: preview.previewToken, operationId: 'timeout-create' })
  assert.equal(reconciled.created, true)
  assert.equal(reconciled.replayed, true)
  assert.equal(reconciled.rollbackAuthorized, false)
  assert.equal(reconciled.branchCreated, false)
  assert.equal(mutationCalls(repo, 'add').length, 1)
  await assert.rejects(
    core.rollbackCreate({ operationId: 'timeout-create' }),
    error => error instanceof GitWorktreeError && error.code === 'rollback-not-authorized',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('spawn failure cannot adopt or roll back an external exact-identity worktree', async () => {
  const { core, repo } = setup()
  const preview = await previewNew(core)
  repo.throwBeforeAdd = new GitWorktreeError('git-spawn-failed', 'simulated ENOENT')
  await assert.rejects(
    core.create({ previewToken: preview.previewToken, operationId: 'spawn-create' }),
    error => error instanceof GitWorktreeError && error.code === 'git-spawn-failed',
  )
  repo.branches.set(preview.branch, preview.baseHead)
  repo.existing.add(preview.targetPath)
  repo.worktrees.push({ path: preview.targetPath, branch: preview.branch, head: preview.baseHead })
  await assert.rejects(
    core.create({ previewToken: preview.previewToken, operationId: 'spawn-create' }),
    error => error instanceof GitWorktreeError && error.code === 'target-exists',
  )
  await assert.rejects(
    core.rollbackCreate({ operationId: 'spawn-create' }),
    error => error instanceof GitWorktreeError && error.code === 'operation-not-created',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('created terminal replay rejects a deleted or replaced worktree instead of returning cached authority', async () => {
  for (const change of ['deleted', 'replaced'] as const) {
    const { core, repo } = setup()
    const preview = await previewNew(core, `terminal-${change}`, `terminal-branch-${change}`)
    const created = await core.create({
      previewToken: preview.previewToken,
      operationId: `terminal-create-${change}`,
    })
    const index = repo.worktrees.findIndex(worktree => worktree.path === created.path)
    assert.ok(index > 0)
    if (change === 'deleted') {
      repo.worktrees.splice(index, 1)
      repo.existing.delete(created.path)
    } else {
      repo.worktrees[index]!.branch = 'external-replacement'
    }
    await assert.rejects(
      core.create({ previewToken: preview.previewToken, operationId: `terminal-create-${change}` }),
      error => error instanceof GitWorktreeError && error.code === 'operation-conflict',
    )
    assert.equal(mutationCalls(repo, 'add').length, 1)
  }
})

test('same repository worktree mutations are serialized by absolute common directory', async () => {
  const { core, repo } = setup()
  const first = await previewNew(core, 'one', 'topic-one')
  const second = await previewNew(core, 'two', 'topic-two')
  repo.mutationDelayMs = 20
  const [one, two] = await Promise.all([
    core.create({ previewToken: first.previewToken, operationId: 'parallel-1' }),
    core.create({ previewToken: second.previewToken, operationId: 'parallel-2' }),
  ])
  assert.equal(one.created && two.created, true)
  assert.equal(repo.maxActiveMutations, 1)
})

test('terminal operation ids expire after the bounded replay TTL', async () => {
  const { core, advanceTime } = setup()
  const first = await previewNew(core, 'ttl-first', 'ttl-branch-first')
  await core.create({ previewToken: first.previewToken, operationId: 'ttl-operation' })
  await core.rollbackCreate({ operationId: 'ttl-operation' })
  advanceTime(OPERATION_TTL_MS + 1)

  const second = await previewNew(core, 'ttl-second', 'ttl-branch-second')
  const reused = await core.create({ previewToken: second.previewToken, operationId: 'ttl-operation' })
  assert.equal(reused.path, `/worktrees/${WORKTREES_KEY}/ttl-second`)
  assert.equal(reused.replayed, false)
})

test('operation capacity evicts the oldest safe pre-admission record instead of wedging new work', async () => {
  const operationCapacity = 4
  const { core, advanceTime } = setup({ operationCapacity })
  const zeros = '0'.repeat(64)
  const expected = {
    repoId: `repo_${zeros}`,
    worktreeId: `worktree_${zeros}`,
    branch: 'main',
    head: MAIN_HEAD,
  }
  for (let index = 0; index <= operationCapacity; index += 1) {
    await assert.rejects(
      core.remove({
        operationId: `capacity-${index}`,
        workspaceId: `missing-${index}`,
        expected,
      }),
      error => error instanceof GitWorktreeError && error.code === 'workspace/not-found',
    )
    advanceTime(1)
  }
  await assert.rejects(
    core.remove({
      operationId: 'capacity-0',
      workspaceId: 'reused-after-eviction',
      expected,
    }),
    error => error instanceof GitWorktreeError && error.code === 'workspace/not-found',
  )
})

test('capacity never evicts an uncertain mutation tombstone before TTL', async () => {
  const { core, repo } = setup({ linked: true, operationCapacity: 1 })
  const { expected } = await targetOf(core)
  repo.throwBeforeRemove = new GitWorktreeError('git-timeout', 'simulated pre-commit timeout')
  await assert.rejects(
    core.remove({ operationId: 'retained-uncertain', workspaceId: 'ws-feature', expected }),
    error => error instanceof GitWorktreeError && error.code === 'git-timeout',
  )
  await assert.rejects(
    core.remove({ operationId: 'must-fail-closed', workspaceId: 'ws-feature', expected }),
    error => error instanceof GitWorktreeError && error.code === 'operation-capacity',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 1)
})

test('capacity retains a completed remove tombstone against same-identity ABA', async () => {
  const { core, repo } = setup({ linked: true, operationCapacity: 1 })
  const { expected } = await targetOf(core)
  await core.remove({ operationId: 'retained-removed', workspaceId: 'ws-feature', expected })
  repo.addLinked()
  await assert.rejects(
    core.remove({ operationId: 'aba-remove', workspaceId: 'ws-feature', expected }),
    error => error instanceof GitWorktreeError && error.code === 'operation-capacity',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 1)
  assert.equal(repo.worktrees.some(worktree => worktree.path === LINKED), true)
})

test('rollback is operation-bound, refuses a workspace, then removes clean without force', async () => {
  const { core, repo, workspaces } = setup()
  const preview = await previewNew(core)
  const created = await core.create({ previewToken: preview.previewToken, operationId: 'rollback-1' })
  workspaces.push({ workspaceId: 'ws-new', path: created.path, sessionIds: [] })
  await assert.rejects(
    core.rollbackCreate({ operationId: 'rollback-1' }),
    error => error instanceof GitWorktreeError && error.code === 'rollback-has-workspace',
  )
  workspaces.pop()
  const rolledBack = await core.rollbackCreate({ operationId: 'rollback-1' })
  assert.equal(rolledBack.removed, true)
  assert.equal(rolledBack.branchPreserved, true)
  assert.deepEqual(mutationCalls(repo, 'remove')[0]!.args, ['worktree', 'remove', '--', created.path])
  assert.equal(repo.branches.has('topic'), true)
  const replay = await core.rollbackCreate({ operationId: 'rollback-1' })
  assert.equal(replay.replayed, true)
  assert.equal(mutationCalls(repo, 'remove').length, 1)
})

test('rollback reconciles authoritative absence after its postcondition read fails', async () => {
  const { core, repo } = setup()
  const preview = await previewNew(core)
  const created = await core.create({ previewToken: preview.previewToken, operationId: 'rollback-reconcile' })
  repo.failListAfterRemove = true
  await assert.rejects(core.rollbackCreate({ operationId: 'rollback-reconcile' }))
  assert.equal(repo.worktrees.some(worktree => worktree.path === created.path), false)
  const reconciled = await core.rollbackCreate({ operationId: 'rollback-reconcile' })
  assert.equal(reconciled.removed, true)
  assert.equal(reconciled.replayed, true)
  assert.equal(mutationCalls(repo, 'remove').length, 1)
})

test('rollback refuses dirty operation-created worktrees', async () => {
  const { core, repo } = setup()
  const preview = await previewNew(core)
  const created = await core.create({ previewToken: preview.previewToken, operationId: 'dirty-rollback' })
  repo.worktrees.find(worktree => worktree.path === created.path)!.dirty = true
  await assert.rejects(
    core.rollbackCreate({ operationId: 'dirty-rollback' }),
    error => error instanceof GitWorktreeError && error.code === 'worktree-dirty',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('rollback of an externally deleted created worktree converges by clearing the leftover record', async () => {
  const { core, repo } = setup()
  const preview = await previewNew(core)
  const created = await core.create({ previewToken: preview.previewToken, operationId: 'rollback-vanished' })
  // An external actor deleted the DIRECTORY only; the admin record survives
  // (the same leftover-record shape as the 2026-09 missing-row report). The
  // rollback keeps every identity guard but skips the impossible dirty probe
  // and converges by clearing the record — a plain remove, never --force.
  repo.existing.delete(created.path)
  const rolledBack = await core.rollbackCreate({ operationId: 'rollback-vanished' })
  assert.equal(rolledBack.removed, true)
  assert.equal(rolledBack.path, created.path)
  assert.equal(rolledBack.branchPreserved, true)
  assert.equal(repo.worktrees.some(worktree => worktree.path === created.path), false)
  assert.equal(repo.branches.has('topic'), true)
  assert.deepEqual(mutationCalls(repo, 'remove')[0]!.args, ['worktree', 'remove', '--', created.path])
  const replay = await core.rollbackCreate({ operationId: 'rollback-vanished' })
  assert.equal(replay.removed, true)
  assert.equal(replay.replayed, true)
  assert.equal(mutationCalls(repo, 'remove').length, 1)
})

test('rollback refuses clean worktrees whose HEAD changed after creation', async () => {
  const { core, repo } = setup()
  const preview = await previewNew(core)
  const created = await core.create({ previewToken: preview.previewToken, operationId: 'head-rollback' })
  repo.worktrees.find(worktree => worktree.path === created.path)!.head =
    '4444444444444444444444444444444444444444'
  await assert.rejects(
    core.rollbackCreate({ operationId: 'head-rollback' }),
    error => error instanceof GitWorktreeError && error.code === 'worktree-changed',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('rollback repeats Git identity checks after the final registry and agent scan', async () => {
  const { core, repo, setSourceReadHook } = setup()
  const preview = await previewNew(core)
  const created = await core.create({ previewToken: preview.previewToken, operationId: 'rollback-final-check' })
  let reads = 0
  setSourceReadHook(() => {
    reads += 1
    if (reads === 2) {
      repo.worktrees.find(worktree => worktree.path === created.path)!.head =
        '5555555555555555555555555555555555555555'
    }
  })
  await assert.rejects(
    core.rollbackCreate({ operationId: 'rollback-final-check' }),
    error => error instanceof GitWorktreeError && error.code === 'worktree-changed',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('rollback canonicalizes workspace paths and catches a symlink alias', async () => {
  const { core, repo, workspaces } = setup()
  const preview = await previewNew(core)
  const created = await core.create({ previewToken: preview.previewToken, operationId: 'alias-rollback' })
  repo.aliases.set('/aliases/created', created.path)
  workspaces.push({ workspaceId: 'ws-alias', path: '/aliases/created', sessionIds: [] })
  await assert.rejects(
    core.rollbackCreate({ operationId: 'alias-rollback' }),
    error => error instanceof GitWorktreeError && error.code === 'rollback-has-workspace',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})
