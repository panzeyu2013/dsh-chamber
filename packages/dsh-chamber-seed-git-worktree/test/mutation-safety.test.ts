/**
 * Git worktree core — mutation safety: submodule gates, wire-input caps, argv allowlist, local-runner hygiene.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { basename, resolve } from 'node:path'
import {
  GitWorktreeError,
  assertSafeGitArgv,
  domainResult,
  type GitRunner,
  type GitWorktreeDomainError,
} from '../src/core.ts'
import {
  MAIN,
  COMMON,
  LINKED,
  FEATURE_HEAD,
  FakeRepository,
  setup,
  targetOf,
  refuses,
  coreOver,
  previewNew,
  mutationCalls,
  STALE,
  addStaleRecord,
} from './support/fake-repository.ts'

test('remove refuses a submodule-hosting worktree unless discardChanges authorizes --force', async () => {
  for (const mode of ['registered', 'unregistered'] as const) {
    const { core, repo } = setup({ linked: true })
    // The worktree's admin git dir hosts a submodule `modules` dir — the same
    // criterion git's own removal guard checks (builtin/worktree.c validate_no_submodules).
    const target = mode === 'registered' ? LINKED : '/repos/ext-sub'
    const modulesDir = `${COMMON}/worktrees/${mode === 'registered' ? 'feature' : 'ext-sub'}`
    if (mode === 'unregistered') repo.addLinked({ path: target, branch: 'ext-sub', head: FEATURE_HEAD })
    repo.gitDirs.set(target, modulesDir)
    repo.gitDirStateFiles.set(modulesDir, new Set(['modules']))
    const { expected } = await targetOf(core, target)
    const input = mode === 'registered'
      ? { operationId: 'submodule-no-flag', workspaceId: 'ws-feature', expected }
      : { operationId: 'unreg-submodule', expected, path: target }

    // A CLEAN submodule worktree is refused pre-mutation with a typed
    // DETERMINISTIC code (retryable: false), and the same id replays it with
    // zero further mutations.
    const refused = await domainResult(() => core.remove(input))
    assert.ok(!refused.ok)
    const refusedError = (refused as { ok: false; error: GitWorktreeDomainError }).error
    assert.equal(refusedError.code, 'worktree-submodules')
    assert.equal(refusedError.retryable, false)
    assert.match(refusedError.message, /submodule/)
    assert.equal(mutationCalls(repo, 'remove').length, 0)
    assert.equal(repo.worktrees.some(worktree => worktree.path === target), true)
    const replay = await domainResult(() => core.remove(input))
    assert.ok(!replay.ok)
    assert.equal((replay as { ok: false; error: GitWorktreeDomainError }).error.code, 'worktree-submodules')
    assert.equal((replay as { ok: false; error: GitWorktreeDomainError }).error.retryable, false)
    assert.equal(mutationCalls(repo, 'remove').length, 0)

    // Only the explicit discard authorization bypasses git's guard, with --force.
    const removed = await core.remove({ ...input, operationId: `${input.operationId}-force`, discardChanges: true })
    assert.equal(removed.removed, true)
    assert.equal(removed.next, mode === 'registered' ? 'delete-workspace' : 'none')
    assert.equal(removed.branchPreserved, true)
    assert.deepEqual(mutationCalls(repo, 'remove').at(-1)!.args, ['worktree', 'remove', '--force', '--', target])
  }
})

test('pre-mutation git refusals are deterministic (typed when git names submodules); a committed failure stays retryable', async () => {
  const { core, repo } = setup({ linked: true })
  const { expected } = await targetOf(core)
  const input = { operationId: 'pre-mutation-refusal', workspaceId: 'ws-feature', expected }

  // git dies pre-mutation citing submodules: deterministic, upgraded to the typed code.
  repo.throwBeforeRemove = new GitWorktreeError(
    'git-command-failed',
    'Git worktree failed with exit 128: fatal: working trees containing submodules cannot be moved or removed',
  )
  const refused = await domainResult(() => core.remove(input))
  assert.ok(!refused.ok)
  const refusedError = (refused as { ok: false; error: GitWorktreeDomainError }).error
  assert.equal(refusedError.code, 'worktree-submodules')
  assert.equal(refusedError.retryable, false)
  assert.match(refusedError.message, /discardChanges/)
  assert.equal(repo.worktrees.some(worktree => worktree.path === LINKED), true)
  assert.equal(mutationCalls(repo, 'remove').length, 1)
  // Once the cause is fixed the same id replays and converges.
  const retried = await core.remove(input)
  assert.equal(retried.removed, true)
  assert.equal(retried.replayed, true)
  assert.equal(mutationCalls(repo, 'remove').length, 2)

  // A pre-mutation die() not naming submodules is equally deterministic.
  repo.addLinked()
  repo.throwBeforeRemove = new GitWorktreeError(
    'git-command-failed',
    'Git worktree failed with exit 128: fatal: refusing to remove the working tree',
  )
  const other = await domainResult(() => core.remove({
    operationId: 'pre-mutation-other',
    workspaceId: 'ws-feature',
    expected,
  }))
  assert.ok(!other.ok)
  const otherError = (other as { ok: false; error: GitWorktreeDomainError }).error
  assert.equal(otherError.code, 'git-command-failed')
  assert.equal(otherError.retryable, false)
  assert.equal(repo.worktrees.some(worktree => worktree.path === LINKED), true)
  assert.equal(mutationCalls(repo, 'remove').length, 3)
  const retriedOther = await core.remove({
    operationId: 'pre-mutation-other',
    workspaceId: 'ws-feature',
    expected,
  })
  assert.equal(retriedOther.removed, true)
  assert.equal(mutationCalls(repo, 'remove').length, 4)

  // A post-commit failure keeps the retryable classification for the same code.
  repo.addLinked()
  repo.throwAfterRemove = new GitWorktreeError(
    'git-command-failed',
    'Git worktree failed with exit 1: failed to delete the worktree directory',
  )
  const committed = await domainResult(() => core.remove({
    operationId: 'post-mutation-committed',
    workspaceId: 'ws-feature',
    expected,
  }))
  assert.ok(!committed.ok)
  const committedError = (committed as { ok: false; error: GitWorktreeDomainError }).error
  assert.equal(committedError.code, 'git-command-failed')
  assert.equal(committedError.retryable, true)
  assert.equal(repo.worktrees.some(worktree => worktree.path === LINKED), false)
})

test('git argv allowlist admits only the exact discardChanges remove grammar', async () => {
  assert.doesNotThrow(() => assertSafeGitArgv(['worktree', 'remove', '--force', '--', '/safe/path']))
  assert.throws(
    () => assertSafeGitArgv(['worktree', 'remove', '--force', '/safe/path']),
    error => error instanceof GitWorktreeError && error.code === 'unsafe-git-argv',
  )
  assert.throws(
    () => assertSafeGitArgv(['worktree', 'remove', '--force', '--', '--upload-pack=evil']),
    error => error instanceof GitWorktreeError && error.code === 'unsafe-git-argv',
  )
  assert.throws(
    () => assertSafeGitArgv(['worktree', 'remove', '--force', '--', 'relative/path']),
    error => error instanceof GitWorktreeError && error.code === 'unsafe-git-argv',
  )
})

test('remove accepts a detached linked worktree only with expected branch null', async () => {
  const { core, repo } = setup({ linked: true })
  repo.worktrees[1]!.branch = null
  const { expected, row: linked } = await targetOf(core)
  assert.equal(linked.branch, null)
  const removed = await core.remove({
    operationId: 'remove-detached',
    workspaceId: 'ws-feature',
    expected: { ...expected, branch: null },
  })
  assert.equal(removed.branch, null)
  assert.equal(removed.removed, true)
})

test('remove refuses a second workspace nested below the worktree', async () => {
  const { core, repo, workspaces } = setup({ linked: true })
  const { expected } = await targetOf(core)
  repo.existing.add(`${LINKED}/nested-workspace`)
  workspaces.push({ workspaceId: 'ws-nested', path: `${LINKED}/nested-workspace`, sessionIds: [] })
  await assert.rejects(core.remove({ operationId: 'remove-nested', workspaceId: 'ws-feature', expected }), refuses('nested-workspace'))
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('wire input cannot inject a path, option, network verb or operation reuse', async () => {
  assert.throws(
    () => assertSafeGitArgv(['fetch', 'origin']),
    error => error instanceof GitWorktreeError && error.code === 'unsafe-git-argv',
  )
  assert.throws(
    () => assertSafeGitArgv(['worktree', 'add', '--', '/safe/path', '--upload-pack=evil']),
    error => error instanceof GitWorktreeError && error.code === 'unsafe-git-argv',
  )
  const { core } = setup()
  await assert.rejects(
    core.previewCreate({
      sourceWorkspaceId: 'ws-main',
      basename: '../escape',
      branch: { kind: 'new', name: 'topic' },
    }),
    error => error instanceof GitWorktreeError && error.code === 'unsafe-path',
  )
  await assert.rejects(
    core.previewCreate({
      sourceWorkspaceId: 'ws-main',
      basename: 'safe',
      branch: { kind: 'new', name: '--evil' },
    }),
    error => error instanceof GitWorktreeError && error.code === 'invalid-branch',
  )

  const first = await previewNew(core, 'first', 'first-branch')
  const second = await previewNew(core, 'second', 'second-branch')
  await core.create({ previewToken: first.previewToken, operationId: 'same-op' })
  await assert.rejects(
    core.create({ previewToken: second.previewToken, operationId: 'same-op' }),
    error => error instanceof GitWorktreeError && error.code === 'operation-conflict',
  )
})

test('core independently enforces injected runner output caps', async () => {
  const repo = new FakeRepository()
  const overflowing: GitRunner = async request => {
    if (request.args[0] === 'rev-parse') {
      return { exitCode: 0, stdout: 'x'.repeat(request.maxOutputBytes + 1), stderr: '' }
    }
    return repo.runner(request)
  }
  const core = coreOver({ workspaces: [{ workspaceId: 'ws', path: MAIN, sessionIds: [] }], git: overflowing, fs: repo.fs })
  const result = await core.snapshot()
  assert.equal(result.repos.length, 0)
  assert.equal(result.errors.some(error => error.code === 'git-output-limit'), true)
})

test('domain carrier preserves stable business errors and lets true internal failures throw', async () => {
  assert.deepEqual(await domainResult(async () => ({ answer: 42 })), {
    ok: true,
    value: { answer: 42 },
  })
  assert.deepEqual(await domainResult(async () => {
    throw new GitWorktreeError('git-timeout', 'try again', {
      details: { phase: 'create' },
    })
  }), {
    ok: false,
    error: {
      code: 'git-timeout',
      message: 'try again',
      retryable: true,
      details: { phase: 'create' },
    },
  })
  // An EXPLICIT retryable: false (a host-proven pre-mutation refusal) is
  // serialized distinctly from "not in RETRYABLE_CODES" (no flag at all):
  // the client clears a pending uncertain-outcome recovery only on this
  // proof.
  assert.deepEqual(await domainResult(async () => {
    throw new GitWorktreeError('worktree-submodules', 'submodule refusal', { retryable: false })
  }), {
    ok: false,
    error: {
      code: 'worktree-submodules',
      message: 'submodule refusal',
      retryable: false,
    },
  })
  // An EXPLICIT retryable: true serializes as-is even for codes NOT in
  // RETRYABLE_CODES (an inferred/in-set spread would silently drop an
  // explicit true).
  assert.deepEqual(await domainResult(async () => {
    throw new GitWorktreeError('worktree-locked', 'explicit true', { retryable: true })
  }), {
    ok: false,
    error: {
      code: 'worktree-locked',
      message: 'explicit true',
      retryable: true,
    },
  })
  await assert.rejects(
    domainResult(async () => { throw new Error('programming failure') }),
    /programming failure/,
  )
})

test('bound-removal replay/commit guards keep their exact per-site codes and messages', async () => {
  /** Exact code+message refusal: these strings are the wire contract
   *  (git-api.ts routes on the code; the dialog shows the text). */
  const exactRefusal = async (promise: Promise<unknown>, code: string, message: string): Promise<void> => {
    let caught: unknown
    try {
      await promise
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof GitWorktreeError, `expected a ${code} refusal, got ${String(caught)}`)
    assert.equal(caught.code, code)
    assert.equal(caught.message, message)
  }

  // commitBoundRemove: the final in-lock topology read resolves a changed row.
  const commit = setup({ linked: true })
  const commitTarget = await targetOf(commit.core)
  let commitLists = 0
  commit.repo.onWorktreeList = () => {
    commitLists += 1
    if (commitLists === 2) commit.repo.worktrees[1]!.branch = 'changed'
  }
  await exactRefusal(
    commit.core.remove({ operationId: 'bound-diff-commit', workspaceId: 'ws-feature', expected: commitTarget.expected }),
    'operation-conflict',
    'removal target changed immediately before mutation',
  )
  assert.equal(mutationCalls(commit.repo, 'remove').length, 0)

  // ...the same guard maps a newly locked row to the SAME operation-conflict
  // code/text (commitBoundRemove never emits worktree-locked here).
  const commitLocked = setup({ linked: true })
  const commitLockedTarget = await targetOf(commitLocked.core)
  let commitLockedLists = 0
  commitLocked.repo.onWorktreeList = () => {
    commitLockedLists += 1
    if (commitLockedLists === 2) commitLocked.repo.worktrees[1]!.locked = true
  }
  await exactRefusal(
    commitLocked.core.remove({ operationId: 'bound-diff-commit-locked', workspaceId: 'ws-feature', expected: commitLockedTarget.expected }),
    'operation-conflict',
    'removal target changed immediately before mutation',
  )
  assert.equal(mutationCalls(commitLocked.repo, 'remove').length, 0)

  // reconcileBoundRemove: an uncertain replay whose bound target changed.
  const reconcile = setup({ linked: true })
  const reconcileTarget = await targetOf(reconcile.core)
  const reconcileInput = { operationId: 'bound-diff-reconcile', workspaceId: 'ws-feature', expected: reconcileTarget.expected }
  reconcile.repo.throwBeforeRemove = new GitWorktreeError('git-timeout', 'simulated pre-commit timeout')
  await assert.rejects(reconcile.core.remove(reconcileInput))
  reconcile.repo.worktrees[1]!.head = 'f'.repeat(40)
  await exactRefusal(
    reconcile.core.remove(reconcileInput),
    'operation-conflict',
    'bound removal target changed while its outcome was uncertain',
  )
  assert.equal(mutationCalls(reconcile.repo, 'remove').length, 1)

  // A changed identity outranks a concurrently locked row, exactly like the
  // original identity-first check (and unlike assertRemovableTarget, which
  // tests locked first).
  const precedence = setup({ linked: true })
  const precedenceTarget = await targetOf(precedence.core)
  const precedenceInput = { operationId: 'bound-diff-precedence', workspaceId: 'ws-feature', expected: precedenceTarget.expected }
  precedence.repo.throwBeforeRemove = new GitWorktreeError('git-timeout', 'simulated pre-commit timeout')
  await assert.rejects(precedence.core.remove(precedenceInput))
  precedence.repo.worktrees[1]!.head = 'f'.repeat(40)
  precedence.repo.worktrees[1]!.locked = true
  await exactRefusal(
    precedence.core.remove(precedenceInput),
    'operation-conflict',
    'bound removal target changed while its outcome was uncertain',
  )

  // ...while a locked-only replay keeps its own worktree-locked refusal.
  const locked = setup({ linked: true })
  const lockedTarget = await targetOf(locked.core)
  const lockedInput = { operationId: 'bound-diff-locked', workspaceId: 'ws-feature', expected: lockedTarget.expected }
  locked.repo.throwBeforeRemove = new GitWorktreeError('git-timeout', 'simulated pre-commit timeout')
  await assert.rejects(locked.core.remove(lockedInput))
  locked.repo.worktrees[1]!.locked = true
  await exactRefusal(locked.core.remove(lockedInput), 'worktree-locked', 'locked worktrees cannot be removed')

  // commitMissingRecordRemove: a changed leftover record (still missing).
  const missing = setup({ linked: true })
  addStaleRecord(missing.repo)
  const missingTarget = await targetOf(missing.core, STALE)
  let missingLists = 0
  missing.repo.onWorktreeList = () => {
    missingLists += 1
    if (missingLists === 2) missing.repo.worktrees.find(row => row.path === STALE)!.head = 'f'.repeat(40)
  }
  await exactRefusal(
    missing.core.remove({ operationId: 'bound-diff-missing', expected: missingTarget.expected, path: STALE }),
    'operation-conflict',
    'missing worktree record changed immediately before removal',
  )
  assert.equal(mutationCalls(missing.repo, 'remove').length, 0)

  // ...and a reappeared directory keeps the worktree-invalid refusal.
  const reappeared = setup({ linked: true })
  addStaleRecord(reappeared.repo)
  const reappearedTarget = await targetOf(reappeared.core, STALE)
  let reappearedLists = 0
  reappeared.repo.onWorktreeList = () => {
    reappearedLists += 1
    if (reappearedLists === 2) reappeared.repo.existing.add(STALE)
  }
  await exactRefusal(
    reappeared.core.remove({ operationId: 'bound-diff-reappeared', expected: reappearedTarget.expected, path: STALE }),
    'worktree-invalid',
    'the missing worktree directory reappeared; refresh and retry',
  )
  assert.equal(mutationCalls(reappeared.repo, 'remove').length, 0)
})


