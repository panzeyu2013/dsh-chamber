/**
 * Git worktree core — preview/create replay, the two-step filter-parity checkout,
 * terminal replay guards and operation capacity.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GitWorktreeError, OPERATION_TTL_MS } from '../src/core.ts'
import {
  MAIN_HEAD,
  FEATURE_HEAD,
  LINKED,
  WORKTREES_ROOT,
  POOL_IGNORE,
  setup,
  targetOf,
  previewNew,
  mutationCalls,
} from './support/fake-repository.ts'

test('preview and create a new branch with the two-step filter-parity checkout and idempotent replay', async () => {
  const { core, repo } = setup()
  repo.filterDrivers.add('lfs')
  const preview = await previewNew(core)
  assert.equal(preview.targetPath, `${WORKTREES_ROOT}/new-worktree`)
  assert.equal(preview.baseHead, MAIN_HEAD)
  assert.match(preview.repoId, /^repo_[0-9a-f]{64}$/)

  const created = await core.create({ previewToken: preview.previewToken, operationId: 'create-1' })
  assert.equal(created.created, true)
  assert.equal(created.replayed, false)
  assert.equal(created.branchCreated, true)
  assert.match(created.worktreeId, /^worktree_[0-9a-f]{64}$/)

  // Step 1: add --no-checkout writes only the admin record.
  const add = mutationCalls(repo, 'add')[0]!
  assert.deepEqual(add.args, [
    'worktree', 'add', '--no-checkout', '-b', 'topic', '--', `${WORKTREES_ROOT}/new-worktree`, MAIN_HEAD,
  ])
  assert.equal(add.timeoutMs, 30_000)
  assert.equal(add.maxOutputBytes, 256 * 1024)

  // Step 2: enumerate filter.* in the TARGET checkout, then reset with command-scoped
  // GIT_CONFIG_* overrides (clean/smudge/process empty, required=false).
  const stepVerbs = repo.calls
    .filter(call => call.args[0] === 'config' || call.args[0] === 'reset'
      || (call.args[0] === 'worktree' && call.args[1] === 'add'))
    .map(call => call.args[0])
  assert.deepEqual(stepVerbs, ['worktree', 'config', 'reset'])
  const enumeration = repo.calls.find(call => call.args[0] === 'config')!
  assert.deepEqual(enumeration.args, ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'])
  assert.equal(enumeration.cwd, preview.targetPath)
  const reset = repo.calls.find(call => call.args[0] === 'reset')!
  assert.deepEqual(reset.args, ['reset', '--hard', '--no-recurse-submodules', 'HEAD'])
  assert.equal(reset.cwd, preview.targetPath)
  assert.equal(reset.env!.GIT_CONFIG_COUNT, '4')
  assert.equal(reset.env!.GIT_CONFIG_KEY_0, 'filter.lfs.clean')
  assert.equal(reset.env!.GIT_CONFIG_VALUE_0, '')
  assert.equal(reset.env!.GIT_CONFIG_KEY_3, 'filter.lfs.required')
  assert.equal(reset.env!.GIT_CONFIG_VALUE_3, 'false')

  // The pool self-ignore landed before the add (create-only write).
  assert.equal(repo.written.get(POOL_IGNORE), '*\n')

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

test('a zero-exit add remains reconcilable when the postcondition read fails', async () => {
  const { core, repo } = setup()
  const preview = await previewNew(core)
  repo.failListAfterAdd = true
  await assert.rejects(core.create({ previewToken: preview.previewToken, operationId: 'uncertain-create' }))
  assert.equal(repo.worktrees.some(worktree => worktree.path === preview.targetPath), true)
  const reconciled = await core.create({ previewToken: preview.previewToken, operationId: 'uncertain-create' })
  assert.equal(reconciled.replayed, true)
  assert.equal(mutationCalls(repo, 'add').length, 1)
})

test('timeout reconciliation can advance but never reports branch provenance', async () => {
  const { core, repo } = setup()
  const preview = await previewNew(core)
  repo.throwAfterAdd = new GitWorktreeError('git-timeout', 'simulated timeout')
  await assert.rejects(
    core.create({ previewToken: preview.previewToken, operationId: 'timeout-create' }),
    error => error instanceof GitWorktreeError && error.code === 'git-timeout',
  )
  // The add succeeded but its reset never ran: reconciliation COMPLETES the checkout
  // instead of adopting an empty --no-checkout worktree.
  const reconciled = await core.create({ previewToken: preview.previewToken, operationId: 'timeout-create' })
  assert.equal(reconciled.created, true)
  assert.equal(reconciled.replayed, true)
  assert.equal(reconciled.branchCreated, false)
  assert.equal(mutationCalls(repo, 'add').length, 1)
  assert.equal(repo.calls.filter(call => call.args[0] === 'reset').length, 1)
})

test('spawn failure cannot adopt an external exact-identity worktree', async () => {
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
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('created terminal replay rejects a deleted, replaced or moved-source checkout', async () => {
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

  // The replay also re-reads the registry: a source that moved off the main checkout
  // invalidates the receipt instead of returning cached authority.
  const moved = setup({ linked: true })
  const movedPreview = await previewNew(moved.core, 'terminal-moved', 'terminal-branch-moved')
  await moved.core.create({ previewToken: movedPreview.previewToken, operationId: 'terminal-moved' })
  moved.workspaces[0] = { ...moved.workspaces[0]!, path: LINKED }
  await assert.rejects(
    moved.core.create({ previewToken: movedPreview.previewToken, operationId: 'terminal-moved' }),
    error => error instanceof GitWorktreeError && error.code === 'operation-conflict',
  )
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
  advanceTime(OPERATION_TTL_MS + 1)

  const second = await previewNew(core, 'ttl-second', 'ttl-branch-second')
  const reused = await core.create({ previewToken: second.previewToken, operationId: 'ttl-operation' })
  assert.equal(reused.path, `${WORKTREES_ROOT}/ttl-second`)
  assert.equal(reused.replayed, false)
})

test('operation capacity evicts only safe pre-admission records and retains tombstones', async () => {
  // The oldest safe pre-admission record is evicted instead of wedging new work.
  const operationCapacity = 4
  const evict = setup({ operationCapacity })
  const zeros = '0'.repeat(64)
  const expected = { repoId: `repo_${zeros}`, worktreeId: `worktree_${zeros}`, branch: 'main', head: MAIN_HEAD }
  for (let index = 0; index <= operationCapacity; index += 1) {
    await assert.rejects(
      evict.core.remove({ operationId: `capacity-${index}`, workspaceId: `missing-${index}`, expected }),
      error => error instanceof GitWorktreeError && error.code === 'workspace/not-found',
    )
    evict.advanceTime(1)
  }
  await assert.rejects(
    evict.core.remove({ operationId: 'capacity-0', workspaceId: 'reused-after-eviction', expected }),
    error => error instanceof GitWorktreeError && error.code === 'workspace/not-found',
  )

  // An uncertain tombstone is never evicted before its TTL.
  const uncertain = setup({ linked: true, operationCapacity: 1 })
  const uncertainTarget = await targetOf(uncertain.core)
  uncertain.repo.throwBeforeRemove = new GitWorktreeError('git-timeout', 'simulated pre-commit timeout')
  await assert.rejects(
    uncertain.core.remove({ operationId: 'retained-uncertain', workspaceId: 'ws-feature', expected: uncertainTarget.expected }),
    error => error instanceof GitWorktreeError && error.code === 'git-timeout',
  )
  await assert.rejects(
    uncertain.core.remove({ operationId: 'must-fail-closed', workspaceId: 'ws-feature', expected: uncertainTarget.expected }),
    error => error instanceof GitWorktreeError && error.code === 'operation-capacity',
  )
  assert.equal(mutationCalls(uncertain.repo, 'remove').length, 1)

  // A completed remove tombstone is retained against same-identity ABA.
  const aba = setup({ linked: true, operationCapacity: 1 })
  const abaTarget = await targetOf(aba.core)
  await aba.core.remove({ operationId: 'retained-removed', workspaceId: 'ws-feature', expected: abaTarget.expected })
  aba.repo.addLinked()
  await assert.rejects(
    aba.core.remove({ operationId: 'aba-remove', workspaceId: 'ws-feature', expected: abaTarget.expected }),
    error => error instanceof GitWorktreeError && error.code === 'operation-capacity',
  )
  assert.equal(mutationCalls(aba.repo, 'remove').length, 1)
  assert.equal(aba.repo.worktrees.some(worktree => worktree.path === LINKED), true)
})
