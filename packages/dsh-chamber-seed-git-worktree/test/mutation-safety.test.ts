/**
 * Git worktree core — mutation safety: submodule gates, wire-input caps, argv allowlist, local-runner hygiene.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { basename, resolve } from 'node:path'
import {
  GitWorktreeCore,
  GitWorktreeError,
  assertSafeGitArgv,
  createLocalGitRunner,
  domainResult,
  type GitChildProcess,
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
  previewNew,
  mutationCalls,
} from './support/fake-repository.ts'

test('remove refuses a worktree hosting submodule checkouts unless discardChanges authorizes --force', async () => {
  const { core, repo } = setup({ linked: true })
  const modulesDir = `${COMMON}/worktrees/feature`
  // The linked worktree's admin git dir hosts a submodule `modules` dir —
  // the same criterion git's own removal guard checks (builtin/worktree.c
  // validate_no_submodules).
  repo.gitDirs.set(LINKED, modulesDir)
  repo.gitDirStateFiles.set(modulesDir, new Set(['modules']))
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees[1]!
  const expected = {
    repoId: repository.repoId,
    worktreeId: linked.worktreeId,
    branch: linked.branch!,
    head: linked.head,
  }

  // A CLEAN submodule worktree is refused pre-mutation with a typed
  // DETERMINISTIC code: zero git mutations, and the wire carries
  // retryable: false so the client never mints an "uncertain outcome"
  // recovery that only a same-reason retry could clear.
  const refused = await domainResult(() => core.remove({
    operationId: 'submodule-no-flag',
    workspaceId: 'ws-feature',
    expected,
  }))
  assert.ok(!refused.ok)
  const refusedError = (refused as { ok: false; error: GitWorktreeDomainError }).error
  assert.equal(refusedError.code, 'worktree-submodules')
  assert.equal(refusedError.retryable, false)
  assert.match(refusedError.message, /submodule/)
  assert.equal(mutationCalls(repo, 'remove').length, 0)
  assert.equal(repo.worktrees.some(worktree => worktree.path === LINKED), true)

  // The same operation id replays the SAME typed refusal deterministically
  // (zero further mutations; the gate left the record 'ready' — nothing
  // uncertain to reconcile).
  const replay = await domainResult(() => core.remove({
    operationId: 'submodule-no-flag',
    workspaceId: 'ws-feature',
    expected,
  }))
  assert.ok(!replay.ok)
  const replayError = (replay as { ok: false; error: GitWorktreeDomainError }).error
  assert.equal(replayError.code, 'worktree-submodules')
  assert.equal(replayError.retryable, false)
  assert.equal(mutationCalls(repo, 'remove').length, 0)

  // With the explicit discard authorization the removal goes through with
  // --force (git's submodule guard is bypassed only by --force).
  const removed = await core.remove({
    operationId: 'submodule-force',
    workspaceId: 'ws-feature',
    expected,
    discardChanges: true,
  })
  assert.equal(removed.removed, true)
  assert.equal(removed.next, 'delete-workspace')
  assert.equal(removed.branchPreserved, true)
  assert.deepEqual(mutationCalls(repo, 'remove').at(-1)!.args, ['worktree', 'remove', '--force', '--', LINKED])
})

test('unregistered removal of a submodule worktree hits the same typed gate', async () => {
  const { core, repo } = setup({ linked: true })
  const external = '/repos/ext-sub'
  const modulesDir = `${COMMON}/worktrees/ext-sub`
  repo.addLinked({ path: external, branch: 'ext-sub', head: FEATURE_HEAD })
  // The external worktree's admin git dir hosts a submodule `modules` dir.
  repo.gitDirs.set(external, modulesDir)
  repo.gitDirStateFiles.set(modulesDir, new Set(['modules']))
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const worktree = repository.worktrees.find(candidate => candidate.path === external)!
  const expected = {
    repoId: repository.repoId,
    worktreeId: worktree.worktreeId,
    branch: 'ext-sub' as string | null,
    head: FEATURE_HEAD,
  }

  const refused = await domainResult(() => core.remove({
    operationId: 'unreg-submodule',
    expected,
    path: external,
  }))
  assert.ok(!refused.ok)
  const refusedError = (refused as { ok: false; error: GitWorktreeDomainError }).error
  assert.equal(refusedError.code, 'worktree-submodules')
  assert.equal(refusedError.retryable, false)
  assert.equal(mutationCalls(repo, 'remove').length, 0)
  assert.equal(repo.worktrees.some(worktree => worktree.path === external), true)

  const removed = await core.remove({
    operationId: 'unreg-submodule-force',
    expected,
    path: external,
    discardChanges: true,
  })
  assert.equal(removed.removed, true)
  assert.equal(removed.next, 'none')
  assert.deepEqual(mutationCalls(repo, 'remove').at(-1)!.args, ['worktree', 'remove', '--force', '--', external])
})

test('pre-mutation git refusals are deterministic (typed when git names submodules); a committed failure stays retryable', async () => {
  const { core, repo } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees[1]!
  const expected = {
    repoId: repository.repoId,
    worktreeId: linked.worktreeId,
    branch: linked.branch!,
    head: linked.head,
  }
  const input = { operationId: 'pre-mutation-refusal', workspaceId: 'ws-feature', expected }

  // git dies BEFORE deleting anything, citing submodules (its own guard when
  // the host's best-effort preflight missed a gitdir layout without the
  // admin `modules` dir): the target is still listed with the SAME identity,
  // its directory still exists and the worktree is still clean — the
  // refusal is reclassified DETERMINISTIC and UPGRADED to the typed code so
  // the client dialog can offer the discard authorization.
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
  // Once the cause is fixed, the same operation id replays and converges
  // (the deterministic refusal left the record 'ready', yet the bound intent
  // still reconciles through the same path).
  const retried = await core.remove(input)
  assert.equal(retried.removed, true)
  assert.equal(retried.replayed, true)
  assert.equal(mutationCalls(repo, 'remove').length, 2)

  // A pre-mutation die() that does NOT name submodules stays on the
  // git-command-failed code but is equally deterministic (dismissible).
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

  // A failure AFTER git committed the removal (the target vanished mid-
  // command) keeps the retryable classification for the same code: the
  // outcome is genuinely uncertain and the same-id replay must reconcile it.
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
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees[1]!
  assert.equal(linked.branch, null)
  const removed = await core.remove({
    operationId: 'remove-detached',
    workspaceId: 'ws-feature',
    expected: {
      repoId: repository.repoId,
      worktreeId: linked.worktreeId,
      branch: null,
      head: linked.head,
    },
  })
  assert.equal(removed.branch, null)
  assert.equal(removed.removed, true)
})

test('remove refuses a second workspace nested below the worktree', async () => {
  const { core, repo, workspaces } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees[1]!
  repo.existing.add(`${LINKED}/nested-workspace`)
  workspaces.push({ workspaceId: 'ws-nested', path: `${LINKED}/nested-workspace`, sessionIds: [] })
  await assert.rejects(
    core.remove({
      operationId: 'remove-nested',
      workspaceId: 'ws-feature',
      expected: {
        repoId: repository.repoId,
        worktreeId: linked.worktreeId,
        branch: linked.branch,
        head: linked.head,
      },
    }),
    error => error instanceof GitWorktreeError && error.code === 'nested-workspace',
  )
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
  const core = new GitWorktreeCore({
    source: { listWorkspaces: () => [{ workspaceId: 'ws', path: MAIN, sessionIds: [] }], listAgents: () => [], listArchivedSessionIds: () => [] },
    git: overflowing,
    fs: repo.fs,
  })
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
  // proof. (2026-09 submodule/deterministic-refusal amendment.)
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
  // RETRYABLE_CODES (2026-09: the earlier spread only ever emitted true for
  // inferred/in-set codes, silently dropping an explicit true).
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

test('local runner waits for child close after output kill before settling', async () => {
  class FakeChild extends EventEmitter implements GitChildProcess {
    readonly stdout = new EventEmitter()
    readonly stderr = new EventEmitter()
    killed = false

    kill(): boolean {
      this.killed = true
      this.emit('error', new Error('simulated kill failure event'))
      return false
    }
  }

  const child = new FakeChild()
  const runner = createLocalGitRunner(() => child)
  const pending = runner({
    cwd: MAIN,
    args: ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    timeoutMs: 1_000,
    maxOutputBytes: 4,
  })
  let settled = false
  void pending.then(
    () => { settled = true },
    () => { settled = true },
  )
  child.stdout.emit('data', Buffer.from('12345'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(child.killed, true)
  assert.equal(settled, false)
  child.emit('close', null)
  await assert.rejects(
    pending,
    error => error instanceof GitWorktreeError && error.code === 'git-output-limit',
  )
  assert.equal(settled, true)
})

test('local runner normalizes synchronous spawn throws as pre-admission failure', async () => {
  const runner = createLocalGitRunner(() => { throw new Error('synchronous spawn failure') })
  await assert.rejects(
    runner({
      cwd: MAIN,
      args: ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    }),
    error => error instanceof GitWorktreeError
      && error.code === 'git-spawn-failed'
      && /synchronous spawn failure/u.test(error.message),
  )
})
