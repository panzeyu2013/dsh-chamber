import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GitSagaError, recoveryForFailure, runAdoptSessionSaga, runCreateSaga, runPreRemoveArchive,
  runRemoveSaga, runRollbackRecovery, runWorkspaceAdoptRecovery, runWorkspaceDeleteRecovery,
} from '../src/shared/saga.ts'
import {
  decodeCreateValue, decodeRemoveValue, decodeRollbackCreateValue, isAmbiguousGitRpcFailure,
} from '../src/shared/git-api.ts'
import type {
  CreateWorktreeResult, GitRecovery, PreviewCreateResult, RemoveWorktreeResult,
} from '../src/shared/types.ts'

const REPO_ID = `repo_${'a'.repeat(64)}`
const WORKTREE_ID = `worktree_${'b'.repeat(64)}`
const HEAD = 'c'.repeat(40)
const PREVIEW: PreviewCreateResult = {
  previewToken: 'preview-1', expiresAt: 1_800_000_000_000, repoId: REPO_ID,
  commonDir: '/repo/.git', mainPath: '/repo', targetPath: '/feature', branch: 'feature', baseHead: HEAD,
}

function preview(token: string): PreviewCreateResult {
  return { ...PREVIEW, previewToken: token }
}

function createResult(operationId: string, rollbackAuthorized = true): CreateWorktreeResult {
  return {
    operationId, created: true, replayed: false, repoId: REPO_ID, worktreeId: WORKTREE_ID,
    commonDir: PREVIEW.commonDir, path: PREVIEW.targetPath, branch: PREVIEW.branch, head: PREVIEW.baseHead,
    branchCreated: true, rollbackAuthorized,
  }
}

const removeResult: RemoveWorktreeResult = {
  operationId: 'op-remove', removed: true, replayed: false, repoId: REPO_ID, worktreeId: WORKTREE_ID,
  workspaceId: 'ws-2', commonDir: '/repo/.git', path: '/feature', branch: null, head: HEAD,
  sessionIds: ['s-old'], next: 'delete-workspace', branchPreserved: true,
}

test('create saga orders host -> workspace -> preallocated session and commits that id', async () => {
  const calls: string[] = []
  const result = await runCreateSaga({
    hostCreate: async input => { calls.push(`git:${input.operationId}`); return createResult(input.operationId) },
    hostRollback: async () => { calls.push('rollback') },
    workspaceCreate: async path => { calls.push(`workspace:${path}`); return { workspaceId: 'ws-2', path, created: true } },
    sessionCreate: async (workspaceId, sessionId) => { calls.push(`session:${workspaceId}:${sessionId}`); return sessionId },
    isAmbiguousHostFailure: () => false,
  }, PREVIEW, { operationId: 'op-create', sessionId: 'session-fixed' })
  assert.deepEqual(calls, ['git:op-create', 'workspace:/feature', 'session:ws-2:session-fixed'])
  assert.equal(result.sessionId, 'session-fixed')
})

test('ambiguous create retains preview/operation/session identities and a retry reuses all three', async () => {
  const seen: Array<{ previewToken: string; operationId: string }> = []
  let attempt = 0
  const deps = {
    hostCreate: async (input: { previewToken: string; operationId: string }) => {
      seen.push(input)
      attempt += 1
      if (attempt === 1) throw new TypeError('response dropped')
      return createResult(input.operationId)
    },
    hostRollback: async () => {},
    workspaceCreate: async (path: string) => ({ workspaceId: 'ws-2', path, created: true }),
    sessionCreate: async (_workspaceId: string, sessionId: string) => sessionId,
    isAmbiguousHostFailure: () => true,
  }
  let recovery: any
  try {
    await runCreateSaga(deps, preview('preview-fixed'), { operationId: 'op-fixed', sessionId: 'session-fixed' })
    assert.fail('expected dropped response')
  } catch (error) {
    assert.ok(error instanceof GitSagaError)
    recovery = error.recovery
  }
  assert.deepEqual(recovery, {
    kind: 'git-create', preview: preview('preview-fixed'), operationId: 'op-fixed', sessionId: 'session-fixed', message: 'response dropped',
    createSession: true,
  })
  const retried = await runCreateSaga(
    deps,
    recovery.preview,
    { operationId: recovery.operationId, sessionId: recovery.sessionId },
  )
  assert.equal(retried.sessionId, 'session-fixed')
  assert.deepEqual(seen, [
    { previewToken: 'preview-fixed', operationId: 'op-fixed' },
    { previewToken: 'preview-fixed', operationId: 'op-fixed' },
  ])
})

test('workspace failure rolls back only its operation and rollback failure is recoverable', async () => {
  const calls: string[] = []
  try {
    await runCreateSaga({
      hostCreate: async () => createResult('only-this-op'),
      hostRollback: async input => { calls.push(input.operationId); throw new Error('rollback dropped') },
      workspaceCreate: async () => { throw new Error('workspace failed') },
      sessionCreate: async () => { assert.fail('session must not be attempted') },
      isAmbiguousHostFailure: () => false,
    }, preview('p'), { operationId: 'only-this-op', sessionId: 's' })
    assert.fail('expected failure')
  } catch (error) {
    assert.ok(error instanceof GitSagaError)
    assert.equal(error.refreshNeeded, true)
    assert.equal(error.recovery?.kind, 'rollback-create')
    if (error.recovery?.kind !== 'rollback-create') assert.fail('expected rollback recovery')
    assert.equal(error.recovery.operationId, 'only-this-op')
    assert.equal(error.recovery.repoId, REPO_ID)
    assert.equal(error.recovery.worktreeId, WORKTREE_ID)
    assert.equal(error.recovery.commonDir, PREVIEW.commonDir)
    assert.equal(error.recovery.path, '/feature')
    assert.equal(error.recovery.branch, PREVIEW.branch)
    assert.equal(error.recovery.head, PREVIEW.baseHead)
    assert.equal(error.recovery.sessionId, 's')
  }
  assert.deepEqual(calls, ['only-this-op'])
})

test('after session.create is attempted, failure never compensates and retains the same session id', async () => {
  let rolledBack = false
  try {
    await runCreateSaga({
      hostCreate: async () => createResult('op'),
      hostRollback: async () => { rolledBack = true },
      workspaceCreate: async path => ({ workspaceId: 'ws-2', path, created: true }),
      sessionCreate: async () => { throw new Error('session response dropped') },
      isAmbiguousHostFailure: () => false,
    }, preview('p'), { operationId: 'op', sessionId: 'session-fixed' })
    assert.fail('expected failure')
  } catch (error) {
    assert.ok(error instanceof GitSagaError)
    assert.equal(error.recovery?.kind, 'session-create')
    assert.equal(error.recovery?.sessionId, 'session-fixed')
  }
  assert.equal(rolledBack, false)
})

test('workspace response loss resolves rollback-has-workspace by adopting path and continuing the same session id', async () => {
  let recovery: Extract<GitRecovery, { kind: 'rollback-create' }> | undefined
  try {
    await runCreateSaga({
      hostCreate: async () => createResult('op-fixed'),
      hostRollback: async () => { throw new Error('rollback-has-workspace') },
      workspaceCreate: async () => { throw new TypeError('workspace response dropped') },
      sessionCreate: async () => { assert.fail('session waits for ownership recovery') },
      isAmbiguousHostFailure: () => false,
    }, preview('p'), { operationId: 'op-fixed', sessionId: 'session-fixed' })
  } catch (error) {
    assert.ok(error instanceof GitSagaError)
    if (error.recovery?.kind !== 'rollback-create') assert.fail('expected rollback recovery')
    recovery = error.recovery
  }
  assert.ok(recovery !== undefined)
  const calls: string[] = []
  const result = await runRollbackRecovery({
    hostRollback: async operationId => { calls.push(`rollback:${operationId}`); throw new Error('rollback-has-workspace') },
    isWorkspaceOwnershipConflict: error => (error as Error).message === 'rollback-has-workspace',
    workspaceCreate: async path => {
      calls.push(`workspace:${path}`)
      return { workspaceId: 'ws-adopted', path, created: false }
    },
    sessionCreate: async (workspaceId, sessionId) => {
      calls.push(`session:${workspaceId}:${sessionId}`)
      return sessionId
    },
  }, recovery)
  assert.deepEqual(result, { committed: true, sessionId: 'session-fixed' })
  assert.deepEqual(calls, [
    'rollback:op-fixed',
    'workspace:/feature',
    'session:ws-adopted:session-fixed',
  ])
})

test('uncertain create provenance never authorizes rollback and recovers forward by workspace adoption', async () => {
  let rollbackCalls = 0
  let recovery: Extract<GitRecovery, { kind: 'workspace-adopt' }> | undefined
  try {
    await runCreateSaga({
      hostCreate: async () => createResult('op-uncertain', false),
      hostRollback: async () => { rollbackCalls += 1 },
      workspaceCreate: async () => { throw new TypeError('workspace response dropped') },
      sessionCreate: async () => { assert.fail('session waits for workspace adoption') },
      isAmbiguousHostFailure: isAmbiguousGitRpcFailure,
    }, PREVIEW, { operationId: 'op-uncertain', sessionId: 'session-fixed' })
    assert.fail('expected forward recovery')
  } catch (error) {
    assert.ok(error instanceof GitSagaError)
    if (error.recovery?.kind !== 'workspace-adopt') assert.fail('expected workspace-adopt recovery')
    recovery = error.recovery
  }
  assert.equal(rollbackCalls, 0)
  assert.ok(recovery !== undefined)
  const calls: string[] = []
  const result = await runWorkspaceAdoptRecovery({
    workspaceCreate: async path => {
      calls.push(`workspace:${path}`)
      return { workspaceId: 'ws-adopted', path, created: false }
    },
    sessionCreate: async (workspaceId, sessionId) => {
      calls.push(`session:${workspaceId}:${sessionId}`)
      return sessionId
    },
  }, recovery)
  assert.deepEqual(result, { sessionId: 'session-fixed' })
  assert.deepEqual(calls, ['workspace:/feature', 'session:ws-adopted:session-fixed'])
})

test('mismatched rollback response preserves complete recovery facts and never adopts a workspace', async () => {
  const recovery: Extract<GitRecovery, { kind: 'rollback-create' }> = {
    kind: 'rollback-create', operationId: 'op-create', repoId: REPO_ID, worktreeId: WORKTREE_ID,
    commonDir: PREVIEW.commonDir, path: PREVIEW.targetPath, branch: PREVIEW.branch,
    head: PREVIEW.baseHead, sessionId: 'session-fixed', message: 'rollback response dropped',
  }
  let workspaceCalls = 0
  try {
    await runRollbackRecovery({
      hostRollback: async (operationId, expected) => decodeRollbackCreateValue({
        operationId, removed: true, replayed: false, ...expected,
        path: '/different', branchPreserved: true,
      }, { operationId }, expected),
      workspaceCreate: async path => {
        workspaceCalls += 1
        return { workspaceId: 'ws-2', path, created: false }
      },
      sessionCreate: async (_workspaceId, sessionId) => sessionId,
      isWorkspaceOwnershipConflict: () => false,
    }, recovery)
    assert.fail('expected rollback correlation failure')
  } catch (error) {
    assert.ok(error instanceof GitSagaError)
    assert.equal(error.recovery?.kind, 'rollback-create')
    if (error.recovery?.kind !== 'rollback-create') assert.fail('expected rollback recovery')
    assert.equal(error.recovery.repoId, REPO_ID)
    assert.equal(error.recovery.path, PREVIEW.targetPath)
  }
  assert.equal(workspaceCalls, 0)
})

test('malformed create success is ambiguous and invokes neither workspace nor session', async () => {
  let workspaceCalls = 0
  let sessionCalls = 0
  try {
    await runCreateSaga({
      hostCreate: async input => decodeCreateValue(
        { ...createResult(input.operationId), path: '/wrong-target' }, input, PREVIEW,
      ),
      hostRollback: async () => { assert.fail('an untrusted create result cannot authorize rollback') },
      workspaceCreate: async path => {
        workspaceCalls += 1
        return { workspaceId: 'ws-2', path, created: true }
      },
      sessionCreate: async (_workspaceId, sessionId) => {
        sessionCalls += 1
        return sessionId
      },
      isAmbiguousHostFailure: isAmbiguousGitRpcFailure,
    }, PREVIEW, { operationId: 'op-malformed', sessionId: 'session-fixed' })
    assert.fail('expected malformed success failure')
  } catch (error) {
    assert.ok(error instanceof GitSagaError)
    assert.equal(error.recovery?.kind, 'git-create')
  }
  assert.equal(workspaceCalls, 0)
  assert.equal(sessionCalls, 0)
})

test('a mismatched preallocated session id remains session recovery and never rolls back', async () => {
  let rolledBack = false
  try {
    await runCreateSaga({
      hostCreate: async () => createResult('op-session-mismatch'),
      hostRollback: async () => { rolledBack = true },
      workspaceCreate: async path => ({ workspaceId: 'ws-2', path, created: true }),
      sessionCreate: async () => 'different-session',
      isAmbiguousHostFailure: isAmbiguousGitRpcFailure,
    }, PREVIEW, { operationId: 'op-session-mismatch', sessionId: 'session-fixed' })
    assert.fail('expected session correlation failure')
  } catch (error) {
    assert.ok(error instanceof GitSagaError)
    assert.equal(error.recovery?.kind, 'session-create')
    assert.equal(error.recovery?.sessionId, 'session-fixed')
  }
  assert.equal(rolledBack, false)
})

test('a definitive retry error does not erase an older unknown-operation recovery', () => {
  const previous: GitRecovery = {
    kind: 'git-create', preview: preview('p'), operationId: 'op', sessionId: 's', message: 'response dropped',
    createSession: true,
  }
  assert.deepEqual(recoveryForFailure(new GitSagaError(new Error('preview token lost after restart')), previous), {
    ...previous,
    message: 'preview token lost after restart',
  })
  assert.equal(
    recoveryForFailure(new GitSagaError(new Error('workspace failed'), undefined, true, false), previous),
    undefined,
  )
})

test('remove is Git-first; ambiguous response retains the exact operation and opaque expectation', async () => {
  const request = {
    operationId: 'op-remove', workspaceId: 'ws-2',
    expected: { repoId: REPO_ID, worktreeId: WORKTREE_ID, branch: null, head: HEAD },
    path: '/feature',
  }
  const calls: string[] = []
  try {
    await runRemoveSaga({
      hostRemove: async () => { calls.push('git'); throw new TypeError('response dropped') },
      verifyTerminalRemove: async () => { calls.push('verify'); return removeResult },
      workspaceDelete: async () => { calls.push('workspace') },
      ambiguousRecovery: error => ({ kind: 'git-remove', ...request, message: String((error as Error).message) }),
    })
    assert.fail('expected failure')
  } catch (error) {
    assert.ok(error instanceof GitSagaError)
    assert.deepEqual(error.recovery, { kind: 'git-remove', ...request, message: 'response dropped' })
  }
  assert.deepEqual(calls, ['git'])

  await runRemoveSaga({
    hostRemove: async () => { calls.push('git-retry'); return removeResult },
    verifyTerminalRemove: async () => { calls.push('git-verify'); return { ...removeResult, replayed: true } },
    workspaceDelete: async id => { calls.push(`workspace:${id}`) },
    ambiguousRecovery: () => undefined,
  })
  assert.deepEqual(calls, ['git', 'git-retry', 'git-verify', 'workspace:ws-2'])
})

test('malformed remove success invokes no workspace deletion and keeps the same operation recoverable', async () => {
  const request = {
    operationId: 'op-malformed-remove', workspaceId: 'ws-2',
    expected: { repoId: REPO_ID, worktreeId: WORKTREE_ID, branch: null, head: HEAD },
    path: '/feature',
  }
  let deleteCalls = 0
  try {
    await runRemoveSaga({
      hostRemove: async () => decodeRemoveValue({
        ...removeResult,
        operationId: request.operationId,
        path: '/different',
        sessionIds: [],
      }, request, request.path),
      verifyTerminalRemove: async () => removeResult,
      workspaceDelete: async () => { deleteCalls += 1 },
      ambiguousRecovery: error => isAmbiguousGitRpcFailure(error)
        ? { kind: 'git-remove', ...request, message: String((error as Error).message) }
        : undefined,
    })
    assert.fail('expected malformed success failure')
  } catch (error) {
    assert.ok(error instanceof GitSagaError)
    assert.equal(error.recovery?.kind, 'git-remove')
    assert.equal(error.recovery?.operationId, request.operationId)
  }
  assert.equal(deleteCalls, 0)
})

test('workspace delete failure keeps retry-only recovery and never reverses Git', async () => {
  try {
    await runRemoveSaga({
      hostRemove: async () => removeResult,
      verifyTerminalRemove: async () => ({ ...removeResult, replayed: true }),
      workspaceDelete: async () => { throw new Error('registry unavailable') },
      ambiguousRecovery: () => undefined,
    })
    assert.fail('expected failure')
  } catch (error) {
    assert.ok(error instanceof GitSagaError)
    assert.deepEqual(error.recovery, {
      kind: 'workspace-delete', operationId: 'op-remove', workspaceId: 'ws-2',
      expected: { repoId: REPO_ID, worktreeId: WORKTREE_ID, branch: null, head: HEAD },
      path: '/feature', message: 'registry unavailable',
    })
  }
})

test('first successful remove never deletes the registry when terminal replay no longer verifies', async () => {
  let deleteCalls = 0
  try {
    await runRemoveSaga({
      hostRemove: async () => removeResult,
      verifyTerminalRemove: async () => { throw new Error('workspace-membership-changed') },
      workspaceDelete: async () => { deleteCalls += 1 },
      ambiguousRecovery: () => undefined,
    })
    assert.fail('expected terminal verifier conflict')
  } catch (error) {
    assert.ok(error instanceof GitSagaError)
    assert.deepEqual(error.recovery, {
      kind: 'workspace-delete', operationId: 'op-remove', workspaceId: 'ws-2',
      expected: { repoId: REPO_ID, worktreeId: WORKTREE_ID, branch: null, head: HEAD },
      path: '/feature', message: 'workspace-membership-changed',
    })
  }
  assert.equal(deleteCalls, 0)
})

test('workspace-delete recovery treats workspace-not-found as an idempotent committed delete', async () => {
  const notFound = Object.assign(new Error('gone'), { code: 'workspace-not-found' })
  const calls: string[] = []
  assert.equal(await runWorkspaceDeleteRecovery(
    async () => { calls.push('verify'); return removeResult },
    async () => { calls.push('delete'); throw notFound },
    error => (error as { code?: string }).code === 'workspace-not-found',
  ), 'already-deleted')
  assert.deepEqual(calls, ['verify', 'delete'])
  await assert.rejects(
    runWorkspaceDeleteRecovery(
      async () => removeResult,
      async () => { throw Object.assign(new Error('offline'), { code: 'transport' }) },
      error => (error as { code?: string }).code === 'workspace-not-found',
    ),
    /offline/,
  )
})

test('workspace-delete recovery never deletes the registry when terminal replay no longer verifies', async () => {
  let deleteCalls = 0
  await assert.rejects(
    runWorkspaceDeleteRecovery(
      async () => { throw new Error('worktree-reappeared') },
      async () => { deleteCalls += 1 },
      () => false,
    ),
    /worktree-reappeared/,
  )
  assert.equal(deleteCalls, 0)
})

test('adopt-only saga orders workspace -> preallocated session and reuses an existing workspace', async () => {
  const calls: string[] = []
  const result = await runAdoptSessionSaga({
    workspaceCreate: async path => { calls.push(`workspace:${path}`); return { workspaceId: 'ws-existing', path, created: false } },
    sessionCreate: async (workspaceId, sessionId) => { calls.push(`session:${workspaceId}:${sessionId}`); return sessionId },
  }, '/existing-wt', 'session-fixed')
  assert.deepEqual(calls, ['workspace:/existing-wt', 'session:ws-existing:session-fixed'])
  assert.deepEqual(result, { sessionId: 'session-fixed', workspaceId: 'ws-existing', path: '/existing-wt' })
})

test('adopt-only workspace failure keeps session-adopt recovery and never calls session', async () => {
  const calls: string[] = []
  await assert.rejects(
    runAdoptSessionSaga({
      workspaceCreate: async () => { calls.push('workspace'); throw Object.assign(new Error('transport down'), { code: 'offline' }) },
      sessionCreate: async () => { calls.push('session'); return 'session-fixed' },
    }, '/existing-wt', 'session-fixed'),
    (error: unknown) => {
      assert.ok(error instanceof GitSagaError)
      assert.equal(error.recovery?.kind, 'session-adopt')
      const recovery = error.recovery as Extract<GitRecovery, { kind: 'session-adopt' }>
      assert.equal(recovery.path, '/existing-wt')
      assert.equal(recovery.sessionId, 'session-fixed')
      return true
    },
  )
  assert.deepEqual(calls, ['workspace'])
})

test('adopt-only session failure retains session-create recovery with the same preallocated id', async () => {
  const calls: string[] = []
  await assert.rejects(
    runAdoptSessionSaga({
      workspaceCreate: async path => { calls.push('workspace'); return { workspaceId: 'ws-2', path, created: false } },
      sessionCreate: async () => { calls.push('session'); throw Object.assign(new Error('busy'), { code: 'agent-busy' }) },
    }, '/existing-wt', 'session-fixed'),
    (error: unknown) => {
      assert.ok(error instanceof GitSagaError)
      assert.equal(error.recovery?.kind, 'session-create')
      const recovery = error.recovery as Extract<GitRecovery, { kind: 'session-create' }>
      assert.equal(recovery.workspaceId, 'ws-2')
      assert.equal(recovery.path, '/existing-wt')
      assert.equal(recovery.sessionId, 'session-fixed')
      return true
    },
  )
  assert.deepEqual(calls, ['workspace', 'session'])
})

test('adopt-only correlation mismatch never calls session', async () => {
  const calls: string[] = []
  await assert.rejects(
    runAdoptSessionSaga({
      workspaceCreate: async () => { calls.push('workspace'); return { workspaceId: 'ws-2', path: '/OTHER-PATH', created: false } },
      sessionCreate: async () => { calls.push('session'); return 'session-fixed' },
    }, '/existing-wt', 'session-fixed'),
    /不匹配/,
  )
  assert.deepEqual(calls, ['workspace'])
})

test('session-adopt recovery reuses workspace-adopt execution and commits the same session id', async () => {
  const calls: string[] = []
  const result = await runWorkspaceAdoptRecovery({
    workspaceCreate: async path => { calls.push(`workspace:${path}`); return { workspaceId: 'ws-adopted', path, created: false } },
    sessionCreate: async (workspaceId, sessionId) => { calls.push(`session:${workspaceId}:${sessionId}`); return sessionId },
  }, { kind: 'session-adopt', path: '/existing-wt', sessionId: 'session-fixed', message: 'retry' })
  assert.deepEqual(calls, ['workspace:/existing-wt', 'session:ws-adopted:session-fixed'])
  assert.equal(result.sessionId, 'session-fixed')
})

test('pre-remove archive archives the whole session closure in order', async () => {
  const calls: string[] = []
  const archived = await runPreRemoveArchive({
    fetchSessions: async () => ({
      sessions: [
        { sessionId: 'root-a' },
        { sessionId: 'sub-a1', parentSessionId: 'root-a' },
        { sessionId: 'sub-a2', parentSessionId: 'sub-a1' },
        { sessionId: 'unrelated' },
      ],
    }),
    archiveSession: async sessionId => { calls.push(sessionId) },
  }, ['root-a'])
  assert.deepEqual(archived, ['root-a', 'sub-a1', 'sub-a2'])
  assert.deepEqual(calls, ['root-a', 'sub-a1', 'sub-a2'])
})

test('pre-remove archive with no roots archives nothing', async () => {
  let fetched = 0
  const calls: string[] = []
  const archived = await runPreRemoveArchive({
    fetchSessions: async () => { fetched += 1; return { sessions: [] } },
    archiveSession: async sessionId => { calls.push(sessionId) },
  }, [])
  assert.deepEqual(archived, [])
  assert.deepEqual(calls, [])
  assert.equal(fetched, 1)
})

test('pre-remove archive skips already-archived sessions on a retry', async () => {
  const calls: string[] = []
  const archived = await runPreRemoveArchive({
    fetchSessions: async () => ({
      sessions: [
        { sessionId: 'root-a' },
        { sessionId: 'sub-a1', parentSessionId: 'root-a' },
      ],
      archivedSessionIds: ['root-a'],
    }),
    archiveSession: async sessionId => { calls.push(sessionId) },
  }, ['root-a'])
  assert.deepEqual(archived, ['sub-a1'])
  assert.deepEqual(calls, ['sub-a1'])
})

test('pre-remove archive aborts on session fetch failure without archiving', async () => {
  const calls: string[] = []
  await assert.rejects(
    runPreRemoveArchive({
      fetchSessions: async () => { throw new Error('offline') },
      archiveSession: async sessionId => { calls.push(sessionId) },
    }, ['root-a']),
    /offline/,
  )
  assert.deepEqual(calls, [])
})

test('pre-remove archive stops at the first archive failure, earlier archives stay committed', async () => {
  const calls: string[] = []
  await assert.rejects(
    runPreRemoveArchive({
      fetchSessions: async () => ({
        sessions: [
          { sessionId: 'root-a' },
          { sessionId: 'sub-a1', parentSessionId: 'root-a' },
        ],
      }),
      archiveSession: async sessionId => {
        calls.push(sessionId)
        if (sessionId === 'sub-a1') throw new Error('archive rejected')
      },
    }, ['root-a']),
    /archive rejected/,
  )
  assert.deepEqual(calls, ['root-a', 'sub-a1'])
})

test('rollback success resolves committed:false and never adopts a workspace', async () => {
  const calls: string[] = []
  const result = await runRollbackRecovery({
    hostRollback: async operationId => { calls.push(`rollback:${operationId}`) },
    workspaceCreate: async path => { calls.push(`workspace:${path}`); return { workspaceId: 'ws-x', path, created: true } },
    sessionCreate: async (workspaceId, sessionId) => { calls.push(`session:${workspaceId}:${sessionId}`); return sessionId },
    isWorkspaceOwnershipConflict: () => false,
  }, {
    kind: 'rollback-create', operationId: 'op-r', repoId: REPO_ID, worktreeId: WORKTREE_ID,
    commonDir: PREVIEW.commonDir, path: PREVIEW.targetPath, branch: PREVIEW.branch, head: PREVIEW.baseHead,
    sessionId: 'session-fixed', message: '',
  })
  assert.deepEqual(result, { committed: false })
  assert.deepEqual(calls, ['rollback:op-r'])
})

test('a definitive 404 host error surfaces as a no-recovery failure, never a recovery entry', async () => {
  // 404 = the host Remote is not loaded (host package missing / restart
  // pending): a definitive error — retrying the same create cannot help, so
  // the saga must throw without minting a recovery entry (design 08 §11).
  const deps = {
    fetchGitFacts: async () => ({ repos: [], errors: [] }),
    hostCreate: async () => {
      const error = new Error('git-host-not-loaded: Git 插件未在该实例加载（host 包缺失或未生效）。本地实例请重启桌面端；远程实例请在连接设置中重新下发 chamber host 包并点击“重启生效”后重试。')
      ;(error as { code?: string }).code = 'git-host-not-loaded'
      throw error
    },
    createWorktreeResult: decodeCreateValue,
    // hostCreate throws before anything is created — rollback must never run.
    hostRollback: async () => { throw new Error('rollback must not run for a definitive 404') },
    workspaceCreate: async () => ({ workspaceId: 'ws-404', path: '/feature', created: true }),
    sessionCreate: async (_workspaceId: string, sessionId: string) => sessionId,
    snapshotWorkspace: async () => ({ workspaceId: 'ws-404', path: '/feature', title: 'feature' }),
    snapshotSessions: async () => ({ sessionIds: [] }),
    resolveRecoveryWorkspaceId: async () => 'ws-404',
    // The browser-facing client classifies git-host-not-loaded as definitive
    // (isAmbiguousGitRpcFailure excludes it) — mirror that here.
    isAmbiguousHostFailure: () => false,
  }
  await assert.rejects(
    runCreateSaga(deps, PREVIEW, { operationId: 'op-404', sessionId: 'session-404' }),
    (error: unknown) => {
      assert.ok(error instanceof GitSagaError)
      assert.equal(error.recovery, undefined, 'a definitive host failure must not mint a recovery entry')
      return true
    },
  )
})

test('create saga with createSession:false commits the worktree + workspace but no session', async () => {
  const calls: string[] = []
  const result = await runCreateSaga({
    hostCreate: async input => { calls.push(`git:${input.operationId}`); return createResult(input.operationId) },
    hostRollback: async () => { calls.push('rollback') },
    workspaceCreate: async path => { calls.push(`workspace:${path}`); return { workspaceId: 'ws-2', path, created: true } },
    sessionCreate: async (workspaceId, sessionId) => { calls.push(`session:${workspaceId}:${sessionId}`); return sessionId },
    isAmbiguousHostFailure: () => false,
  }, PREVIEW, { operationId: 'op-nosession', sessionId: 'session-unused' }, { createSession: false })
  // OpenChamber-aligned: the empty worktree workspace appears without a
  // session; the preallocated session id is simply unused.
  assert.deepEqual(calls, ['git:op-nosession', 'workspace:/feature'])
  assert.equal(result.workspaceId, 'ws-2')
  assert.equal(result.path, '/feature')
})
