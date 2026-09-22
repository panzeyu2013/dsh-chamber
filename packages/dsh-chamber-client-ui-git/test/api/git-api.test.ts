import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  decodeCreateValue, decodeRemoveValue, decodeRollbackCreateValue, GitWorktreeRpcError, gitWorktreeApi,
  isAmbiguousGitRpcFailure, isDeterministicGitRejection,
} from '../../src/shared/git-api.ts'
import type { PreviewCreateResult } from '../../src/shared/types.ts'
import { HEAD, PREVIEW_BASE, REPO_ID, WORKTREE_ID } from '../support/fixtures.ts'

const PREVIEW: PreviewCreateResult = { ...PREVIEW_BASE, previewToken: 'preview-fixed' }

/**
 * One carrier envelope: the git client posts through the shared sidebar
 * carrier, whose `server-response` requires the rpcId to ECHO the request body —
 * a mismatch rejects before any git decode.
 */
function carrierEnvelope(requestBody: string, result: unknown): Response {
  const body = JSON.parse(requestBody) as { rpcId?: string }
  return new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Run against a stubbed global fetch, always restoring the real one. */
async function withFetch(impl: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    await run()
  } finally {
    globalThis.fetch = original
  }
}

test('snapshot sends exact no-argument Typert args while mutations use the one named input', async () => {
  const bodies: any[] = []
  await withFetch((async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    return carrierEnvelope(String(init?.body), {
      ok: true,
      // The transport result carries the host domain's own envelope.
      value: {
        ok: true,
        value: body.method === 'gitWorktree/snapshot' ? { repos: [], errors: [] } : PREVIEW,
      },
    })
  }) as typeof fetch, async () => {
    await gitWorktreeApi.snapshot('local')
    await gitWorktreeApi.previewCreate('local', {
      sourceWorkspaceId: 'ws-1', basename: 'feature', branch: { kind: 'new', name: 'feature' },
    })
  })
  assert.deepEqual(bodies[0].payload, { args: {} })
  assert.deepEqual(bodies[1].payload, {
    args: { input: { sourceWorkspaceId: 'ws-1', basename: 'feature', branch: { kind: 'new', name: 'feature' } } },
  })
  // The shared carrier owns the envelope, the endpoint spelling and the base path.
  assert.equal(bodies[0].type, 'client-request')
  assert.equal(bodies[0].method, 'gitWorktree/snapshot')
  assert.equal(typeof bodies[0].rpcId, 'string')
})

test('all methods unwrap the explicit domain result and preserve stable domain error fields', async () => {
  await withFetch((async (_url: string | URL | Request, init?: RequestInit) => carrierEnvelope(String(init?.body), {
    ok: true,
    value: { ok: false, error: { code: 'preview-stale', message: 'preview moved', retryable: false, details: { field: 'head' } } },
  })) as typeof fetch, async () => {
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
  })
})

test('missing domain envelope fails ambiguous instead of masquerading as a successful value', async () => {
  await withFetch((async (_url: string | URL | Request, init?: RequestInit) => carrierEnvelope(
    String(init?.body),
    { ok: true, value: { repos: [], errors: [] } },
  )) as typeof fetch, async () => {
    await assert.rejects(
      gitWorktreeApi.snapshot('local'),
      (error: unknown) => error instanceof GitWorktreeRpcError && error.code === 'invalid-domain-result',
    )
  })
})

test('a 404 from the gitWorktree namespace maps to a definitive host-not-loaded error', async () => {
  await withFetch((async () => new Response('not found', { status: 404 })) as typeof fetch, async () => {
    await assert.rejects(
      gitWorktreeApi.snapshot('local'),
      (error: unknown) => {
        assert.ok(error instanceof GitWorktreeRpcError)
        assert.equal(error.code, 'git-host-not-loaded')
        // A missing host package is NOT ambiguous: retrying the same mutation
        // cannot help until the instance loads the Remote, so recovery entries
        // must not be minted from it.
        assert.equal(isAmbiguousGitRpcFailure(error), false)
        return true
      },
    )
  })
})

test('a carrier transport failure is ambiguous (the mutation may have committed)', async () => {
  await withFetch((async () => { throw new TypeError('fetch failed') }) as typeof fetch, async () => {
    await assert.rejects(gitWorktreeApi.snapshot('local'), (error: unknown) => {
      assert.ok(error instanceof GitWorktreeRpcError)
      assert.equal(error.code, 'http-error')
      assert.match(error.message, /fetch failed/)
      assert.equal(isAmbiguousGitRpcFailure(error), true)
      return true
    })
  })
})

test('the carrier rejects a drifted envelope before the git domain decode', async () => {
  await withFetch((async () => new Response(JSON.stringify({
    type: 'server-response',
    rpcId: 'not-the-request-rpcId',
    result: { ok: true, value: { ok: true, value: { repos: [], errors: [] } } },
  }), { status: 200 })) as typeof fetch, async () => {
    await assert.rejects(gitWorktreeApi.snapshot('local'), (error: unknown) => {
      assert.ok(error instanceof GitWorktreeRpcError)
      assert.equal(error.code, 'http-error')
      assert.match(error.message, /rpcId mismatch/)
      assert.equal(isAmbiguousGitRpcFailure(error), true)
      return true
    })
  })
})

test('a carrier RPC-layer refusal keeps the rpc-failed vocabulary and its details', async () => {
  await withFetch((async (_url: string | URL | Request, init?: RequestInit) => carrierEnvelope(
    String(init?.body),
    { ok: false, error: { code: 'internal', message: 'remote threw', details: { phase: 'open' } } },
  )) as typeof fetch, async () => {
    await assert.rejects(gitWorktreeApi.snapshot('local'), (error: unknown) => {
      assert.ok(error instanceof GitWorktreeRpcError)
      assert.equal(error.code, 'rpc-failed')
      // GitWorktreeRpcError.message carries the code prefix.
      assert.equal(error.message, 'rpc-failed: remote threw')
      assert.deepEqual(error.details, { phase: 'open' })
      assert.equal(isAmbiguousGitRpcFailure(error), true)
      return true
    })
  })
})

test('the not-ready 503 class stays an ambiguous transport failure', async () => {
  await withFetch((async () => new Response(JSON.stringify({
    code: 'instance_unavailable',
    error: 'the instance is not ready',
  }), { status: 503 })) as typeof fetch, async () => {
    await assert.rejects(gitWorktreeApi.snapshot('local'), (error: unknown) => {
      assert.ok(error instanceof GitWorktreeRpcError)
      assert.equal(error.code, 'http-error')
      assert.match(error.message, /not ready/)
      assert.equal(isAmbiguousGitRpcFailure(error), true)
      return true
    })
  })
})

test('worktree-submodules is a deterministic pre-mutation rejection; git refusals stay ambiguous unless the host proves otherwise', () => {
  // The typed submodule refusal can NEVER have committed a mutation: like
  // worktree-dirty it must surface as a plain dismissible error.
  assert.equal(
    isDeterministicGitRejection(new GitWorktreeRpcError('worktree-submodules', 'refused')),
    true,
  )
  // A reclassified pre-mutation refusal keeps the git-command-failed code;
  // only the host's EXPLICIT retryable: false marks the proof ("target still
  // exists, nothing removed"). Without that proof the code must stay
  // ambiguous-capable — a post-mutation failure of the same command has to
  // remain recoverable through the same-operation replay.
  const unproven = new GitWorktreeRpcError('git-command-failed', 'failed')
  assert.equal(isDeterministicGitRejection(unproven), false)
  assert.equal(isAmbiguousGitRpcFailure(unproven), false)
  assert.equal(
    isAmbiguousGitRpcFailure(new GitWorktreeRpcError('git-command-failed', 'failed', undefined, true)),
    true,
  )
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

test('the git transport is the shared carrier: no self-made fetch envelope remains', () => {
  const source = readFileSync(new URL('../../src/shared/git-api.ts', import.meta.url), 'utf8')
  // Comment-stripped: the lock must be satisfied by CODE, never by prose.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /fetch\(/, 'git-api must not call fetch directly')
  assert.doesNotMatch(code, /client-request/, 'the client-request envelope belongs to the carrier')
  assert.doesNotMatch(code, /AbortSignal\.timeout/, 'the timeout budget belongs to the carrier')
  assert.doesNotMatch(code, /rpcId/, 'rpcId correlation belongs to the carrier')
  assert.match(code, /getInstanceClient\(sourceId\)\.callUnary\(/, 'the shared carrier is the only transport')
  assert.match(code, /timeoutMs: RPC_TIMEOUT_MS/, 'the 60s budget must be handed to the carrier')
  assert.match(code, /notFoundAsDomainMissing: true/, 'the 404 domain discrimination must be requested')
})
