import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  GitSagaError, recoveryAfterSagaFailure, recoveryForFailure, runCreateSaga, runRemoveSaga,
} from '../../src/shared/saga.ts'
import {
  decodeCreateValue, decodeRemoveValue, GitWorktreeRpcError, isAmbiguousGitRpcFailure,
} from '../../src/shared/git-api.ts'
import type {
  CreateWorktreeResult, GitRecovery, PreviewCreateResult, RemoveWorktreeResult,
} from '../../src/shared/types.ts'
import { HEAD, PREVIEW_BASE, REPO_ID, WORKTREE_ID } from '../support/fixtures.ts'

const PREVIEW: PreviewCreateResult = { ...PREVIEW_BASE, previewToken: 'preview-1' }
/** The path-based removal correlation every remove case shares (operationId varies). */
const REMOVE_REQUEST = {
  operationId: 'op-remove',
  expected: { repoId: REPO_ID, worktreeId: WORKTREE_ID, branch: null, head: HEAD },
  path: '/feature',
}

function preview(token: string): PreviewCreateResult {
  return { ...PREVIEW, previewToken: token }
}

function createResult(operationId: string): CreateWorktreeResult {
  return {
    operationId, created: true, replayed: false, repoId: REPO_ID, worktreeId: WORKTREE_ID,
    commonDir: PREVIEW.commonDir, path: PREVIEW.targetPath, branch: PREVIEW.branch, head: PREVIEW.baseHead,
    branchCreated: true,
  }
}

/** The path-based host receipt: an unregistered checkout can only answer `none`. */
const removeResult: RemoveWorktreeResult = {
  operationId: 'op-remove', removed: true, replayed: false, repoId: REPO_ID, worktreeId: WORKTREE_ID,
  commonDir: '/repo/.git', path: '/feature', branch: null, head: HEAD,
  sessionIds: [], next: 'none', branchPreserved: true,
}

/** Run a saga that must throw, returning the GitSagaError (a bare Error fails here). */
async function expectSagaError(run: () => Promise<unknown>): Promise<GitSagaError> {
  try {
    await run()
    assert.fail('expected failure')
  } catch (error) {
    assert.ok(error instanceof GitSagaError)
    return error
  }
}

test('PR1 create saga is host-create + correlation only (no workspace/session/rollback legs)', async () => {
  const calls: string[] = []
  const created = await runCreateSaga({
    hostCreate: async input => { calls.push('git:' + input.operationId); return createResult(input.operationId) },
    isAmbiguousHostFailure: () => false,
  }, PREVIEW, { operationId: 'op-create' })
  assert.deepEqual(calls, ['git:op-create'])
  assert.equal(created.operationId, 'op-create')
  assert.equal(created.path, PREVIEW.targetPath)
})

test('ambiguous create retains preview/operation identity and a retry reuses both', async () => {
  const seen: Array<{ previewToken: string; operationId: string }> = []
  let attempt = 0
  const deps = {
    hostCreate: async (input: { previewToken: string; operationId: string }) => {
      seen.push(input)
      attempt += 1
      if (attempt === 1) throw new TypeError('response dropped')
      return createResult(input.operationId)
    },
    isAmbiguousHostFailure: () => true,
  }
  const failure = await expectSagaError(() =>
    runCreateSaga(deps, preview('preview-fixed'), { operationId: 'op-fixed' }))
  assert.equal(failure.recovery?.kind, 'git-create')
  const recovery = failure.recovery as Extract<GitRecovery, { kind: 'git-create' }>
  assert.deepEqual(recovery, {
    kind: 'git-create', preview: preview('preview-fixed'), operationId: 'op-fixed', message: 'response dropped',
  })
  const retried = await runCreateSaga(deps, recovery.preview, { operationId: recovery.operationId })
  assert.equal(retried.path, PREVIEW.targetPath)
  assert.deepEqual(seen, [
    { previewToken: 'preview-fixed', operationId: 'op-fixed' },
    { previewToken: 'preview-fixed', operationId: 'op-fixed' },
  ])
})

test('malformed create success is ambiguous and mints the same-id recovery', async () => {
  const error = await expectSagaError(() => runCreateSaga({
    hostCreate: async input => decodeCreateValue(
      { ...createResult(input.operationId), path: '/wrong-target' }, input, PREVIEW,
    ),
    isAmbiguousHostFailure: isAmbiguousGitRpcFailure,
  }, PREVIEW, { operationId: 'op-malformed' }))
  assert.equal(error.recovery?.kind, 'git-create')
  if (error.recovery?.kind !== 'git-create') assert.fail('expected git-create recovery')
  assert.equal(error.recovery.operationId, 'op-malformed')
})

test('a definitive 404 host error surfaces as a no-recovery failure, never a recovery entry', async () => {
  const error = await expectSagaError(() => runCreateSaga({
    hostCreate: async () => {
      const failure = new Error('git-host-not-loaded: The Git plugin is not loaded in this instance (host package missing or inactive).')
      ;(failure as { code?: string }).code = 'git-host-not-loaded'
      throw failure
    },
    isAmbiguousHostFailure: () => false,
  }, PREVIEW, { operationId: 'op-404' }))
  assert.equal(error.recovery, undefined, 'a definitive host failure must not mint a recovery entry')
})

test('a definitive retry error does not erase an older unknown-operation recovery', () => {
  const previous: GitRecovery = {
    kind: 'git-create', preview: preview('p'), operationId: 'op', message: 'response dropped',
  }
  assert.deepEqual(recoveryForFailure(new GitSagaError(new Error('preview token lost after restart')), previous), {
    ...previous,
    message: 'preview token lost after restart',
  })
  assert.equal(
    recoveryForFailure(new GitSagaError(new Error('create failed'), undefined, true, false), previous),
    undefined,
  )
})

test('a host-proven pre-mutation refusal clears a pending git-remove replay; anything else keeps it', () => {
  const pending: GitRecovery = { kind: 'git-remove', ...REMOVE_REQUEST, message: 'ambiguous' }
  assert.equal(
    recoveryAfterSagaFailure(
      new GitSagaError(new GitWorktreeRpcError('worktree-submodules', 'refused', undefined, false)),
      pending,
    ),
    undefined,
    'explicit retryable: false proves nothing was removed',
  )
  assert.equal(
    recoveryAfterSagaFailure(new GitSagaError(new GitWorktreeRpcError('worktree-submodules', 'refused')), pending)?.message,
    'worktree-submodules: refused',
    'the same code without the flag stays replayable',
  )
  assert.equal(recoveryAfterSagaFailure(new GitSagaError(new Error('boom')), pending)?.message, 'boom')
})

test('remove is Git-first; an ambiguous response retains the exact operation and opaque expectation', async () => {
  const calls: string[] = []
  const error = await expectSagaError(() => runRemoveSaga({
    hostRemove: async () => { calls.push('git'); throw new TypeError('response dropped') },
    ambiguousRecovery: error => ({ kind: 'git-remove', ...REMOVE_REQUEST, message: String((error as Error).message) }),
  }))
  assert.deepEqual(error.recovery, { kind: 'git-remove', ...REMOVE_REQUEST, message: 'response dropped' })
  assert.deepEqual(calls, ['git'])
})

test('a path-based removal receipt ends at the host: no registry/verification leg exists', async () => {
  const calls: string[] = []
  const result = await runRemoveSaga({
    hostRemove: async () => { calls.push('git'); return removeResult },
    ambiguousRecovery: () => { calls.push('ambiguous'); return undefined },
  })
  assert.equal(result.next, 'none')
  assert.deepEqual(calls, ['git'])
})

test('a delete-workspace receipt is refused closed: PR3 never deletes a registry row', async () => {
  const registered: RemoveWorktreeResult = { ...removeResult, workspaceId: 'ws-2', next: 'delete-workspace' }
  const error = await expectSagaError(() => runRemoveSaga({
    hostRemove: async () => registered,
    ambiguousRecovery: () => undefined,
  }))
  assert.equal(error.recovery, undefined, 'no workspace-delete recovery exists')
  assert.equal(error.refreshNeeded, true, 'the facts are refreshed to show the still-registered state')
  assert.match(error.message, /registered workspace/)
})

test('malformed remove success keeps the same operation recoverable and mints no registry leg', async () => {
  const request = { ...REMOVE_REQUEST, operationId: 'op-malformed-remove' }
  const error = await expectSagaError(() => runRemoveSaga({
    hostRemove: async () => decodeRemoveValue({
      ...removeResult,
      operationId: request.operationId,
      path: '/different',
    }, request, request.path),
    ambiguousRecovery: error => isAmbiguousGitRpcFailure(error)
      ? { kind: 'git-remove', ...request, message: String((error as Error).message) }
      : undefined,
  }))
  assert.equal(error.recovery?.kind, 'git-remove')
  assert.equal(error.recovery?.operationId, request.operationId)
})

test('force removal echoes discardChanges into the git-remove recovery for byte-identical replays', async () => {
  const request = { ...REMOVE_REQUEST, operationId: 'op-force-remove' }
  const error = await expectSagaError(() => runRemoveSaga({
    hostRemove: async () => { throw new TypeError('response dropped') },
    ambiguousRecovery: error => ({ kind: 'git-remove', ...request, message: String((error as Error).message), discardChanges: true }),
  }))
  assert.equal(error.recovery?.kind, 'git-remove')
  assert.equal(error.recovery?.discardChanges, true)
})

test('PR1 wiring lock: create is host-only and a new session is source workspace + enter', () => {
  const coordinator = readFileSync(new URL('../../src/shared/coordinator.ts', import.meta.url), 'utf8')
    .replace(/\s+/gu, ' ')
  // No workspace/session/rollback/placement machinery may survive in the client.
  assert.doesNotMatch(coordinator, /createWorkspaceForSource|insertWorkspaceBefore|renameWorkspaceForSource/)
  assert.doesNotMatch(coordinator, /rollbackCreate|runAdoptSessionSaga|reportWorkspacePlacementFailed/)
  // The create saga sends only the correlated host create.
  assert.match(coordinator, /hostCreate: input => gitWorktreeApi\.create\(sourceId, input, preview\), isAmbiguousHostFailure: isAmbiguousGitRpcFailure,/)
  // The checkout session is rooted in the SOURCE (main) workspace, then entered.
  assert.match(coordinator, /createSessionForSource\(sourceId, mainWorkspaceId, \{ sessionId, origin: 'user', workingDirectory: path \}\)/)
  assert.match(coordinator, /gitWorktreeApi\.enter\(sourceId, \{ sessionId, path \}\)/)
  // Exactly one labelled session-creation site remains (the sidebar ledger lock).
  assert.equal((coordinator.match(/origin: 'user'/gu) ?? []).length, 1,
    'the checkout session creation is the only user-labelled session site left')
  // Enter failure voids the echo's placement intent (design 08 §4.2): the committed session is
  // rooted in the source workspace, so its row must follow the host cwd at once.
  assert.match(coordinator, /chamberBridge\.reportSessionPlacementFailed\(\{ sourceId, sessionId: created \}\)/)
  assert.equal((coordinator.match(/reportSessionPlacementFailed/gu) ?? []).length, 1,
    'the failure side is the only publisher (the success path retires on the authority)')
  // Enter success re-requests the OFFICIAL session list (reason='enter'): the working-directory
  // move is projection-only (the host re-broadcasts list events only on session/agent
  // lifecycle events), so the mounted shell summary keeps the creation seed until it re-reads
  // the corpus (design 05 §2.2.1 / design 08 §4.2).
  assert.match(coordinator, /chamberBridge\.requestSessionListRefresh\(sourceId, 'enter'\)/)
  assert.doesNotMatch(coordinator, /requestSessionListRefresh\(sourceId\)/,
    'the enter arm always carries its reason; the reason-less tick path lives in the App')
})

test('PR3 wiring lock: the registered removal, archive and workspace handoff are gone', () => {
  const coordinator = readFileSync(new URL('../../src/shared/coordinator.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(coordinator, /removeWorktree\(|RemoveTarget|WorktreeDirtyError|currentSessionIsBlank/)
  assert.doesNotMatch(coordinator, /fetchInstanceSnapshot|getInstanceClient|archiveSessionForSource|runPreRemoveArchive/)
  assert.doesNotMatch(coordinator, /deleteWorkspaceForSource|workspaceDelete|InstanceRpcError/)
  assert.doesNotMatch(coordinator, /runPreRemoveArchive|runWorkspaceDeleteRecovery/)
  // The path-based recovery keeps the bounded pre-mutation refusal rule (it is
  // NOT part of the retired workspace lifecycle).
  assert.match(coordinator, /recoveryAfterSagaFailure\(error, previousRecovery\)/)
  assert.match(coordinator, /runRemoveSaga\(\{/)
  assert.match(coordinator, /hostRemove: \(\) => gitWorktreeApi\.remove\(sourceId, input, target\.path\)/)
})
