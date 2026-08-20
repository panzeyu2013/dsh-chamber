import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeCreateValue, decodeRemoveValue, decodeRollbackCreateValue, GitWorktreeRpcError, gitWorktreeApi,
  isAmbiguousGitRpcFailure,
} from '../src/shared/git-api.ts'
import type { PreviewCreateResult } from '../src/shared/types.ts'

const REPO_ID = `repo_${'a'.repeat(64)}`
const WORKTREE_ID = `worktree_${'b'.repeat(64)}`
const HEAD = 'c'.repeat(40)
const PREVIEW: PreviewCreateResult = {
  previewToken: 'preview-fixed', expiresAt: 1_800_000_000_000, repoId: REPO_ID,
  commonDir: '/repo/.git', mainPath: '/repo', targetPath: '/feature', branch: 'feature', baseHead: HEAD,
}

function response(domain: unknown): Response {
  return new Response(JSON.stringify({ result: { ok: true, value: domain } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('snapshot sends exact no-argument Typert args while mutations use the one named input', async () => {
  const original = globalThis.fetch
  const bodies: any[] = []
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    return response({
      ok: true,
      value: body.method === 'gitWorktree/snapshot' ? { repos: [], errors: [] } : PREVIEW,
    })
  }) as typeof fetch
  try {
    await gitWorktreeApi.snapshot('local')
    await gitWorktreeApi.previewCreate('local', {
      sourceWorkspaceId: 'ws-1', basename: 'feature', branch: { kind: 'new', name: 'feature' },
    })
  } finally {
    globalThis.fetch = original
  }
  assert.deepEqual(bodies[0].payload, { args: {} })
  assert.deepEqual(bodies[1].payload, {
    args: { input: { sourceWorkspaceId: 'ws-1', basename: 'feature', branch: { kind: 'new', name: 'feature' } } },
  })
})

test('all methods unwrap the explicit domain result and preserve stable domain error fields', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => response({
    ok: false,
    error: { code: 'preview-stale', message: 'preview moved', retryable: false, details: { field: 'head' } },
  })) as typeof fetch
  try {
    await assert.rejects(
      gitWorktreeApi.create('local', { previewToken: 'p', operationId: 'op' }, PREVIEW),
      (error: unknown) => {
        assert.ok(error instanceof GitWorktreeRpcError)
        assert.equal(error.code, 'preview-stale')
        assert.equal(error.retryable, false)
        assert.deepEqual(error.details, { field: 'head' })
        return true
      },
    )
  } finally {
    globalThis.fetch = original
  }
})

test('create decoder requires full preview correlation and treats malformed success as ambiguous', () => {
  const input = { previewToken: PREVIEW.previewToken, operationId: 'op-create' }
  const raw = {
    operationId: input.operationId, created: true, replayed: false,
    repoId: REPO_ID, worktreeId: WORKTREE_ID, commonDir: PREVIEW.commonDir,
    path: '/wrong-target', branch: PREVIEW.branch, head: PREVIEW.baseHead,
    branchCreated: true, rollbackAuthorized: true,
  }
  assert.throws(
    () => decodeCreateValue(raw, input, PREVIEW),
    (error: unknown) => {
      assert.ok(error instanceof GitWorktreeRpcError)
      assert.equal(error.code, 'invalid-domain-value')
      assert.equal(isAmbiguousGitRpcFailure(error), true)
      return true
    },
  )
})

test('remove decoder requires exact opaque expectation and a concrete membership array', () => {
  const input = {
    operationId: 'op-remove', workspaceId: 'ws-2',
    expected: { repoId: REPO_ID, worktreeId: WORKTREE_ID, branch: null, head: HEAD },
  }
  const base = {
    operationId: input.operationId, removed: true, replayed: false,
    workspaceId: input.workspaceId, repoId: REPO_ID, worktreeId: WORKTREE_ID,
    commonDir: '/repo/.git', path: '/feature', branch: null, head: HEAD,
    next: 'delete-workspace', branchPreserved: true,
  }
  assert.throws(
    () => decodeRemoveValue(base, input, '/feature'),
    (error: unknown) => error instanceof GitWorktreeRpcError && error.code === 'invalid-domain-value',
  )
  assert.throws(
    () => decodeRemoveValue({ ...base, path: '/different', sessionIds: [] }, input, '/feature'),
    (error: unknown) => error instanceof GitWorktreeRpcError && error.code === 'invalid-domain-value',
  )
})

test('rollback decoder correlates the complete locally retained create facts', () => {
  const expected = {
    repoId: REPO_ID, worktreeId: WORKTREE_ID, commonDir: '/repo/.git',
    path: '/feature', branch: 'feature', head: HEAD,
  }
  assert.throws(() => decodeRollbackCreateValue({
    operationId: 'op-create', removed: true, replayed: false,
    ...expected, path: '/different', branchPreserved: true,
  }, { operationId: 'op-create' }, expected), (error: unknown) => (
    error instanceof GitWorktreeRpcError && error.code === 'invalid-domain-value'
  ))
})

test('missing domain envelope fails ambiguous instead of masquerading as a successful value', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ result: { ok: true, value: { repos: [], errors: [] } } }), { status: 200 })) as typeof fetch
  try {
    await assert.rejects(
      gitWorktreeApi.snapshot('local'),
      (error: unknown) => error instanceof GitWorktreeRpcError && error.code === 'invalid-domain-result',
    )
  } finally {
    globalThis.fetch = original
  }
})
