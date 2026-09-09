import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchInstanceSnapshot } from '../src/shared/instance-api.ts'

/** One wire summary row (SessionSummary shape the unary client decodes). */
function summary(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: 's1',
    updatedAt: 100,
    running: false,
    blank: false,
    ...overrides,
  }
}

test('fetchInstanceSnapshot derives workspace groups from session cwd facts', async () => {
  const client = {
    session: {
      list: async () => ({
        ok: true as const,
        value: {
          items: [
            summary({ sessionId: 's1', cwd: '/work/a', updatedAt: 300, running: true }),
            summary({ sessionId: 's2', cwd: '/work/a', updatedAt: 200 }),
            summary({ sessionId: 's3', cwd: '/work/b', updatedAt: 400 }),
            summary({ sessionId: 's4' }), // no cwd → ungrouped
            summary({ sessionId: 'sub', origin: 'subagent', cwd: '/work/a' }),
          ],
        },
      }),
    },
  }
  const snapshot = await fetchInstanceSnapshot(client as never)
  // Groups ordered by newest session (/work/b has s3@400 first).
  assert.equal(snapshot.workspaces.length, 2)
  assert.deepEqual(snapshot.workspaces.map(w => w.title), ['b', 'a'])
  assert.equal(snapshot.workspaces[0].sessionIds.join(','), 's3')
  assert.equal(snapshot.workspaces[1].sessionIds.join(','), 's1,s2')
  // cwd-derived groups are DISPLAY-ONLY: every row carries the synthetic
  // marker so the sidebar disables its host-scoped mutations (2026-11 fix).
  assert.ok(snapshot.workspaces.every(workspace => workspace.synthetic === true))
  // Subagent rows never surface.
  assert.deepEqual(snapshot.sessions.map(row => row.sessionId), ['s1', 's2', 's3', 's4'])
  // Archive set has no unary wire source — documented degradation. The
  // snapshot must mark its archive set NOT known so consumers never read the
  // empty set as "no archived sessions" (2026-09 review round).
  assert.deepEqual(snapshot.archivedSessionIds, [])
  assert.equal(snapshot.archiveSetKnown, false)
})

test('fetchInstanceSnapshot surfaces no-cwd sessions ungrouped and keeps wire rows', async () => {
  const client = {
    session: {
      list: async () => ({
        ok: true as const,
        value: { items: [summary({ sessionId: 's1' }), summary({ sessionId: 's2', cwd: '/x' })] },
      }),
    },
  }
  const snapshot = await fetchInstanceSnapshot(client as never)
  assert.equal(snapshot.workspaces.length, 1)
  assert.equal(snapshot.workspaces[0].title, 'x')
  assert.deepEqual(snapshot.workspaces[0].sessionIds, ['s2'])
  assert.equal(snapshot.workspaces[0].synthetic, true)
  assert.deepEqual(snapshot.sessions.map(row => row.sessionId), ['s1', 's2'])
})

test('fetchInstanceSnapshot cwd grouping titles handle Windows separators, trailing slashes and the root', async () => {
  // Grouping keys are the EXACT cwd strings: a Windows drive path and a
  // POSIX path are distinct directories even when their basenames agree, so
  // they must never merge into one group. What the derivation DOES handle is
  // the TITLE presentation: backslash separators ('C:\work\proj' → 'proj'),
  // trailing separators ('/work/proj/' → 'proj'), and the root ('' after the
  // trim falls back to the raw cwd '/' — never an empty title). All three
  // sessions share the default updatedAt, so the stable recency sort keeps
  // insertion order.
  const client = {
    session: {
      list: async () => ({
        ok: true as const,
        value: {
          items: [
            summary({ sessionId: 's1', cwd: 'C:\\work\\proj' }),
            summary({ sessionId: 's2', cwd: '/work/proj/' }),
            summary({ sessionId: 's3', cwd: '/' }),
          ],
        },
      }),
    },
  }
  const snapshot = await fetchInstanceSnapshot(client as never)
  assert.equal(snapshot.workspaces.length, 3)
  assert.deepEqual(snapshot.workspaces.map(w => w.title), ['proj', 'proj', '/'])
  assert.deepEqual(snapshot.workspaces.map(w => w.workspaceId), [
    '__cwd__:C:\\work\\proj',
    '__cwd__:/work/proj/',
    '__cwd__:/',
  ])
  assert.deepEqual(snapshot.workspaces.map(w => w.sessionIds), [['s1'], ['s2'], ['s3']])
})

// ---------------------------------------------------------------------------
// archiveCleanup (design 24): wrapper decode, error classes and the 404
// discrimination rule. HTTP legs stub globalThis.fetch (node has fetch).
// ---------------------------------------------------------------------------

import {
  cancelSession,
  fetchSessionRunningLineage,
  getInstanceClient,
  InstanceUnavailableError,
  isInstanceDomainMissing,
  isSessionNotAttached,
  previewArchiveCleanup,
  purgeArchivedSessions,
  sessionPurgeClosure,
  stopSessionsForPurge,
  upwardChainComplete,
  type SessionRunningLineage,
  type ArchiveCleanupPurgeResult,
} from '../src/shared/instance-api.ts'

const PREVIEW_VALUE = {
  archived: 4,
  deletableSessions: 2,
  deletableSubagents: 2,
  skippedRunning: 1,
  skippedLoaded: 0,
}

function cleanupClient(overrides: Record<string, unknown> = {}) {
  const nested = (payload: unknown) => ({ ok: true as const, value: { ok: true as const, value: payload } })
  return {
    archiveCleanup: {
      preview: async () => nested({ ...PREVIEW_VALUE, ...overrides }),
      purge: async () => nested({
        deletedSessions: 2,
        deletedSubagents: 2,
        skippedRunning: 1,
        errors: [],
        ...overrides,
      }),
    },
  }
}

test('previewArchiveCleanup decodes the domain counts', async () => {
  const preview = await previewArchiveCleanup(cleanupClient() as never)
  assert.deepEqual(preview, PREVIEW_VALUE)
})

test('purgeArchivedSessions decodes counts and per-item errors (partial failure is visible)', async () => {
  const client = cleanupClient({
    deletedSessions: 1,
    errors: [
      { sessionId: 's2', code: 'storage', message: 'fake failure' },
      { sessionId: 'bad' }, // malformed record dropped
      'not-an-object',
    ],
  })
  const result: ArchiveCleanupPurgeResult = await purgeArchivedSessions(client as never)
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.deletedSubagents, 2)
  assert.equal(result.skippedRunning, 1)
  assert.deepEqual(result.errors, [{ sessionId: 's2', code: 'storage', message: 'fake failure' }])
})

test('archiveCleanup business failures decode the NESTED domain carrier (security review Major-1)', async () => {
  // Realistic two-level wire: the generic RPC layer answers ok:true and the
  // host domain carrier rides nested in `value` ({ok:false,error}). A busy
  // or registry-unreadable answer must surface as a thrown `${code}: …`
  // message — NEVER decode into empty counts (a second shell would otherwise
  // show "没有可删除的已归档会话" while another purge is running).
  const client = {
    archiveCleanup: {
      preview: async () => ({ ok: true as const, value: { ok: false as const, error: { code: 'busy', message: 'busy message', details: {} } } }),
      purge: async () => ({ ok: true as const, value: { ok: false as const, error: { code: 'registry-unreadable', message: 'unreadable', details: {} } } }),
    },
  }
  await assert.rejects(() => previewArchiveCleanup(client as never), (error: unknown) => {
    return error instanceof Error && error.message.startsWith('busy:')
  })
  await assert.rejects(() => purgeArchivedSessions(client as never), (error: unknown) => {
    return error instanceof Error && error.message.startsWith('registry-unreadable:')
  })
  // RPC-level ok:false (transport refusal) keeps the same shape.
  const refusedTransport = {
    archiveCleanup: {
      purge: async () => ({ ok: false as const, error: { code: 'unclaimed', message: 'x', details: {} } }),
    },
  }
  await assert.rejects(() => purgeArchivedSessions(refusedTransport as never), (error: unknown) => {
    return error instanceof Error && error.message.startsWith('unclaimed:')
  })
})

test('malformed nested domain carriers FAIL LOUD — never decode into empty counts (review follow-up F1)', async () => {
  // decodeDomainResult's fail-closed shape contract: the nested carrier must
  // be an object carrying a boolean ok, and ok:true must carry an OBJECT
  // value (preview/purge domain values are always objects). Every other
  // shape — value 42 / null / missing, an array or absent carrier, non-
  // boolean ok — throws the loud zh malformed-domain error on BOTH wrappers,
  // never a silent zero-count preview or an empty purge result.
  const resolveAs = (payload: unknown) => ({ ok: true as const, value: payload })
  const shapes: Array<{ name: string; via: 'preview' | 'purge'; shape: unknown }> = [
    { name: 'preview ok:true value is a number (42)', via: 'preview', shape: resolveAs({ ok: true as const, value: 42 }) },
    { name: 'preview ok:true value is null', via: 'preview', shape: resolveAs({ ok: true as const, value: null }) },
    { name: 'preview ok:true value is undefined', via: 'preview', shape: resolveAs({ ok: true as const, value: undefined }) },
    { name: 'preview carrier is an array', via: 'preview', shape: resolveAs([{ ok: true, value: {} }]) },
    { name: 'preview carrier absent (no value slot)', via: 'preview', shape: { ok: true as const } },
    { name: 'preview ok is not boolean (string)', via: 'preview', shape: resolveAs({ ok: 'yes', value: {} }) },
    { name: 'preview ok is not boolean (number)', via: 'preview', shape: resolveAs({ ok: 1, value: {} }) },
    { name: 'purge ok:true value is a number (7)', via: 'purge', shape: resolveAs({ ok: true as const, value: 7 }) },
    { name: 'purge carrier is an array', via: 'purge', shape: resolveAs([{ ok: true, value: {} }]) },
    { name: 'purge carrier absent (no value slot)', via: 'purge', shape: { ok: true as const } },
    { name: 'purge ok is not boolean', via: 'purge', shape: resolveAs({ ok: 'yes', value: {} }) },
  ]
  for (const c of shapes) {
    const client = {
      archiveCleanup: {
        preview: async () => c.shape,
        purge: async () => c.shape,
      },
    }
    const run = c.via === 'preview'
      ? () => previewArchiveCleanup(client as never)
      : () => purgeArchivedSessions(client as never)
    await assert.rejects(run, (error: unknown) => {
      return error instanceof Error && error.message.startsWith('归档清理域返回了畸形结果')
    }, c.name)
  }
})

test('404 discrimination: instance_not_found stays a generic transport failure; other 404s map to domain missing', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init?: RequestInit }> = []
  try {
    // First call: control-plane unknown-instance 404 (body code present).
    // Second call: host answered 404 with no instance_not_found code (a
    // chamber host domain the runtime tree does not mount).
    const responses = [
      new Response(JSON.stringify({ code: 'instance_not_found', error: 'unknown instance path' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(JSON.stringify({ error: 'method not registered' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    ]
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return responses.shift() as Response
    }) as typeof fetch

    const client = getInstanceClient('local')
    await assert.rejects(
      () => client.archiveCleanup.preview({}),
      (error: unknown) => {
        return error instanceof Error
          && error.message.includes('HTTP 404')
          && !isInstanceDomainMissing(error)
      },
    )
    await assert.rejects(
      () => client.archiveCleanup.preview({}),
      (error: unknown) => isInstanceDomainMissing(error),
    )
    assert.equal(calls.length, 2)
    assert.ok(calls.every(call => call.url.includes('/api/i/local/api/archiveCleanup/preview')))
    const body = JSON.parse(String(calls[0]?.init?.body)) as { method?: string; payload?: unknown }
    assert.equal(body.method, 'archiveCleanup/preview')
    assert.deepEqual(body.payload, { args: {} })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('404 discrimination: oversized 404 bodies stay safe under the bounded read (review follow-up F10)', async () => {
  const originalFetch = globalThis.fetch
  try {
    // A body far beyond the 4 KiB cap is never fully consumed: the bounded
    // probe resolves null and the branch keeps its conservative domain-
    // missing throw — no crash, no misread of a huge page.
    const oversized = 'x'.repeat(64 * 1024)
    const responses = [
      // Even an oversized body that WOULD carry instance_not_found past the
      // cap is not trusted — the discrimination only reads a tiny code JSON.
      new Response(JSON.stringify({ code: 'instance_not_found', error: oversized }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(oversized, { status: 404 }),
    ]
    globalThis.fetch = (async () => responses.shift() as Response) as typeof fetch
    const client = getInstanceClient('local')
    // Both oversized shapes fall to the conservative domain-missing outcome
    // (payload404 null → domain-missing throw) instead of crashing or
    // resolving an empty success.
    await assert.rejects(
      () => client.archiveCleanup.preview({}),
      (error: unknown) => isInstanceDomainMissing(error),
    )
    await assert.rejects(
      () => client.archiveCleanup.preview({}),
      (error: unknown) => isInstanceDomainMissing(error),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('purge/preview wrappers map no-response outcomes to honest retry copy (design 24 §5)', async () => {
  const timeout = new Error('signal timed out')
  timeout.name = 'TimeoutError'
  const network = new TypeError('fetch failed')
  const timeoutClient = {
    archiveCleanup: {
      preview: async () => { throw timeout },
      purge: async () => { throw timeout },
    },
  }
  const networkClient = {
    archiveCleanup: {
      preview: async () => { throw network },
      purge: async () => { throw network },
    },
  }
  await assert.rejects(() => previewArchiveCleanup(timeoutClient as never), /预览超时或网络中断，请重试/)
  await assert.rejects(() => purgeArchivedSessions(timeoutClient as never), /可能仍在进行.*重复执行是安全的/)
  await assert.rejects(() => previewArchiveCleanup(networkClient as never), /预览超时或网络中断，请重试/)
  await assert.rejects(() => purgeArchivedSessions(networkClient as never), /可能仍在进行.*重复执行是安全的/)
  // A deterministic business failure still surfaces verbatim (never remapped).
  const refused = {
    archiveCleanup: {
      purge: async () => ({ ok: true as const, value: { ok: false as const, error: { code: 'registry-unreadable', message: 'unreadable', details: {} } } }),
    },
  }
  await assert.rejects(() => purgeArchivedSessions(refused as never), (error: unknown) => {
    return error instanceof Error && error.message.startsWith('registry-unreadable:')
  })
  // A proxy 504 upstream_timeout is an uncertain outcome (the host may still
  // be purging) — the honest "may still be running" copy, never "不可达".
  const proxiedTimeout = {
    archiveCleanup: {
      purge: async () => { throw new Error('实例不可达：transport failure for endpoint: HTTP 504 upstream_timeout') },
    },
  }
  await assert.rejects(() => purgeArchivedSessions(proxiedTimeout as never), /可能仍在进行.*重复执行是安全的/)
})

test('503 classification: not-ready answers surface as InstanceUnavailableError (not-ready prefix)', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ code: 'instance_unavailable', error: 'instance is still starting' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch
    const client = getInstanceClient('local')
    await assert.rejects(
      () => client.archiveCleanup.preview({}),
      (error: unknown) => error instanceof InstanceUnavailableError, // prefix added by the wrapper-level wrapWireError
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('purgeArchivedSessions forwards the optional subset filter; no filter keeps the zero-arg shape (2026-09 wire amendment)', async () => {
  const originalFetch = globalThis.fetch
  const bodies: string[] = []
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const raw = String(init?.body ?? '')
      bodies.push(raw)
      const envelope = JSON.parse(raw) as { rpcId?: string }
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: {
          ok: true,
          value: { ok: true, value: { deletedSessions: 1, deletedSubagents: 0, skippedRunning: 0, errors: [] } },
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const client = getInstanceClient('local')
    const withFilter = await purgeArchivedSessions(client, ['s1', 's2'])
    assert.equal(withFilter.deletedSessions, 1)
    const all = await purgeArchivedSessions(client)
    assert.equal(all.deletedSessions, 1)
    assert.equal(bodies.length, 2)
    const argsOf = (raw: string): unknown => (JSON.parse(raw) as { payload?: unknown }).payload
    assert.deepEqual(argsOf(bodies[0] as string), { args: { sessionIds: ['s1', 's2'] } })
    assert.deepEqual(argsOf(bodies[1] as string), { args: {} })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('purgeArchivedSessions: an explicit EMPTY selection sends the subset shape (never the zero-arg all)', async () => {
  const originalFetch = globalThis.fetch
  const bodies: string[] = []
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const raw = String(init?.body ?? '')
      bodies.push(raw)
      const envelope = JSON.parse(raw) as { rpcId?: string }
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: {
          ok: true,
          value: { ok: true, value: { deletedSessions: 0, deletedSubagents: 0, skippedRunning: 0, errors: [] } },
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const client = getInstanceClient('local')
    const result = await purgeArchivedSessions(client, [])
    assert.equal(result.deletedSessions, 0)
    assert.equal(bodies.length, 1)
    const payload = (JSON.parse(bodies[0] as string) as { payload?: unknown }).payload
    // [] is the client/host delimiter for "delete nothing" — it MUST NOT be
    // normalized to the undefined (delete ALL) shape.
    assert.deepEqual(payload, { args: { sessionIds: [] } })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('purgeArchivedSessions: an OLD zero-param host refuses the subset filter with an honest restart hint (2026-09 review round)', async () => {
  const originalFetch = globalThis.fetch
  const seenArgs: unknown[] = []
  try {
    // Host answers the RPC-level business refusal the generic gateway
    // produces for an unknown args key on a zero-param method.
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body ?? '{}')) as { payload?: { args?: unknown }; rpcId?: string }
      seenArgs.push(envelope.payload?.args)
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: {
          ok: false,
          error: {
            code: 'gateway/arguments-invalid',
            message: 'typert gateway: archiveCleanup/purge: args fields do not match the descriptor: unexpected "sessionIds"',
            details: {},
          },
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const client = getInstanceClient('local')
    await assert.rejects(
      () => purgeArchivedSessions(client, ['s1']),
      (error: unknown) => error instanceof Error && error.message.includes('版本过旧'),
    )
    assert.deepEqual(seenArgs, [{ sessionIds: ['s1'] }])
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------------------
// 2026-09 revision ("已归档的对话应该终止"): stop-then-purge. The manager
// cancels the selected sessions' running turns through the OFFICIAL
// session/cancel wire, waits for them to leave the running set, and then
// purges with force so the host may delete merely LOADED content.
// ---------------------------------------------------------------------------

test('purgeArchivedSessions forwards force and decodes the split skip counts', async () => {
  const originalFetch = globalThis.fetch
  const bodies: string[] = []
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const raw = String(init?.body ?? '')
      bodies.push(raw)
      const envelope = JSON.parse(raw) as { rpcId?: string }
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: {
          ok: true,
          value: {
            ok: true,
            value: {
              deletedSessions: 2,
              deletedSubagents: 1,
              skippedRunning: 0,
              skippedLoaded: 1,
              forcedLoaded: 2,
              errors: [],
            },
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const client = getInstanceClient('local')
    const result = await purgeArchivedSessions(client, ['s1'], true)
    assert.equal(result.forcedLoaded, 2)
    assert.equal(result.skippedLoaded, 1)
    assert.equal(result.forceUnsupported, false, 'a host that accepts force is never marked as refusing it')
    const payload = (JSON.parse(bodies[0] as string) as { payload?: unknown }).payload
    assert.deepEqual(payload, { args: { sessionIds: ['s1'], force: true } })
  } finally {
    globalThis.fetch = originalFetch
  }
})

// 2026-09 P1 round: an instance whose dsh predates the force flag refuses the
// WHOLE call. Dropping force (the shape that host accepts) keeps deletion
// working; the result must MARK it so the manager can say honestly that
// loaded-but-idle subtrees were skipped.
test('purgeArchivedSessions retries ONCE without force when an old host refuses the flag, and marks the result', async () => {
  const originalFetch = globalThis.fetch
  const payloads: unknown[] = []
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body ?? '{}')) as { rpcId?: string; payload?: { args?: Record<string, unknown> } }
      payloads.push(envelope.payload)
      if (envelope.payload?.args?.force === true) {
        return new Response(JSON.stringify({
          type: 'server-response',
          rpcId: envelope.rpcId,
          result: {
            ok: false,
            error: {
              code: 'gateway/arguments-invalid',
              message: 'typert gateway: archiveCleanup/purge: args fields do not match the descriptor: unexpected "force"',
              details: {},
            },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: {
          ok: true,
          value: {
            ok: true,
            value: { deletedSessions: 1, deletedSubagents: 0, skippedRunning: 0, skippedLoaded: 3, forcedLoaded: 0, errors: [] },
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const result = await purgeArchivedSessions(getInstanceClient('local'), ['s1'], true)
    assert.equal(result.forceUnsupported, true, 'the caller must be able to tell the user force was not honored')
    assert.equal(result.skippedLoaded, 3, 'the legacy run skipped the loaded-but-idle subtree')
    assert.deepEqual(payloads, [
      { args: { sessionIds: ['s1'], force: true } },
      { args: { sessionIds: ['s1'] } },
    ], 'exactly one legacy-shape retry, never a silent drop of the force shape')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('purgeArchivedSessions: a host too old for force AND the subset filter still gets the honest restart hint', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      const envelope = JSON.parse(String(init?.body ?? '{}')) as { rpcId?: string }
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: {
          ok: false,
          error: { code: 'gateway/arguments-invalid', message: 'args fields do not match the descriptor', details: {} },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    await assert.rejects(
      () => purgeArchivedSessions(getInstanceClient('local'), ['s1'], true),
      (error: unknown) => error instanceof Error && error.message.includes('不支持强制删除'),
    )
    assert.equal(calls, 2, 'one force attempt + one legacy retry, then the honest refusal')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('purgeArchivedSessions: an OLD host without the force flag answers an honest restart hint', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body ?? '{}')) as { rpcId?: string }
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: {
          ok: false,
          error: {
            code: 'gateway/arguments-invalid',
            message: 'typert gateway: archiveCleanup/purge: args fields do not match the descriptor: unexpected "force"',
            details: {},
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const client = getInstanceClient('local')
    await assert.rejects(
      () => purgeArchivedSessions(client, ['s1'], true),
      (error: unknown) => error instanceof Error && error.message.includes('不支持强制删除'),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('cancelSession posts the official session/cancel request shape', async () => {
  const originalFetch = globalThis.fetch
  const bodies: string[] = []
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const raw = String(init?.body ?? '')
      bodies.push(raw)
      const envelope = JSON.parse(raw) as { rpcId?: string }
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: { ok: true, value: { accepted: true } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    await cancelSession(getInstanceClient('local'), 's1')
    const envelope = JSON.parse(bodies[0] as string) as { method?: string; payload?: unknown }
    assert.equal(envelope.method, 'session/cancel')
    assert.deepEqual(envelope.payload, { args: { request: { sessionId: 's1' } } })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchSessionRunningLineage keeps subagent rows but only SUBAGENT-origin edges (fork rows carry none)', async () => {
  const client = {
    session: {
      list: async () => ({
        ok: true as const,
        value: {
          items: [
            { sessionId: 's1', running: true },
            { sessionId: 'a1', running: true, origin: 'subagent', parentSessionId: 's1' },
            { sessionId: 'fork1', running: true, parentSessionId: 's1' },
            { sessionId: 's2', running: false },
            { sessionId: 's3' },
          ],
        },
      }),
    },
  }
  const lineage = await fetchSessionRunningLineage(client as never)
  assert.deepEqual([...lineage.running].sort(), ['a1', 'fork1', 's1'],
    'a running fork is a real running session (its own guards must see it)')
  assert.deepEqual([...lineage.parents.entries()], [['a1', 's1']],
    'only origin === "subagent" is lineage: the fork edge is never followed')
})

test('stopSessionsForPurge: cancels only running ids, waits for settle, reports leftovers', async () => {
  const cancelled: string[] = []
  let running = new Set(['s1', 's2', 'child-1'])
  const client = {} as never
  const result = await stopSessionsForPurge(client, ['s1', 's2', 's3'], {
    fetchRunning: async () => lineageOf(running, new Map()),
    cancel: async (_client, sessionId) => { cancelled.push(sessionId) },
    delay: async () => { running = new Set(['child-1']) },
    attempts: 3,
    intervalMs: 1,
  })
  assert.deepEqual(cancelled, ['s1', 's2'])
  assert.deepEqual(result.cancelled, ['s1', 's2'])
  assert.deepEqual(result.stillRunning, [])
  assert.deepEqual(result.failures, [])
  assert.equal(result.unavailable, false)
  assert.deepEqual(result.refusedRoots, [])
})

test('stopSessionsForPurge: session/not-found is an already-settled success; other failures are reported', async () => {
  const client = {} as never
  const result = await stopSessionsForPurge(client, ['gone', 'broken'], {
    fetchRunning: async () => lineageOf(new Set(['gone', 'broken']), new Map()),
    cancel: async (_client, sessionId) => {
      if (sessionId === 'gone') {
        const { InstanceRpcError: RpcError } = await import('../src/shared/instance-rpc-error.ts')
        throw new RpcError('session/not-found', `session "${sessionId}" not found (not attached)`)
      }
      throw new Error('boom')
    },
    delay: async () => {},
    attempts: 1,
  })
  assert.deepEqual(result.cancelled, [])
  assert.deepEqual(result.failures, [{ sessionId: 'broken', message: 'boom' }])
  assert.deepEqual(result.stillRunning, ['gone', 'broken'])
  assert.equal(isSessionNotAttached(new Error('boom')), false)
})

test('stopSessionsForPurge catches a failed session/list read (never throws) and reports unavailable (F4)', async () => {
  const client = {} as never
  const result = await stopSessionsForPurge(client, ['root'], {
    fetchRunning: async () => { throw new Error('session/list exploded: raw wire text') },
    cancel: async () => { assert.fail('nothing may be cancelled when the read failed') },
    attempts: 1,
  })
  assert.deepEqual(result.cancelled, [])
  assert.deepEqual(result.stillRunning, [])
  assert.deepEqual(result.failures, [])
  assert.equal(result.unavailable, true,
    'caught, never thrown — the caller refuses the force path on an unknown closure')
  assert.equal(result.lineage, null, 'no lineage facts were read')
  assert.deepEqual(result.refusedRoots, [])
})

// ---------------------------------------------------------------------------
// 2026-09 P1 round: the pre-purge stop pass covers the CLOSURE of the
// selected roots. The host skips an archived tree whose ANY member runs, and
// a running subagent descendant has no row in the manager — roots-only
// cancels can never settle such a tree.
// 2026-09 fail-open fix: the closure follows SUBAGENT-origin edges only (a
// running FORK of a selected root is never cancelled — the purge tree never
// contains it), and the currently-viewed session is excluded from the CLOSURE.
// ---------------------------------------------------------------------------

function lineageClient(items: readonly unknown[]) {
  return { session: { list: async () => ({ ok: true as const, value: { items } }) } }
}

/** A hand-built lineage for the stop-pass seams: `listed`/`subagentIds` default
 *  to what the rows imply (edge keys are subagent rows; every referenced id is
 *  listed), so the E-#1 completeness rule sees a resolvable chain unless a test
 *  deliberately omits a row. */
function lineageOf(
  running: ReadonlySet<string>,
  parents: ReadonlyMap<string, string>,
  overrides: Partial<SessionRunningLineage> = {},
): SessionRunningLineage {
  const listed = new Set<string>([...running, ...parents.keys(), ...parents.values()])
  return { running, parents, listed, subagentIds: new Set(parents.keys()), ...overrides }
}

const LINEAGE_ROWS = [
  { sessionId: 'root', running: false, parentSessionId: null },
  { sessionId: 'child', running: true, origin: 'subagent', parentSessionId: 'root' },
  { sessionId: 'grand', running: true, origin: 'subagent', parentSessionId: 'child' },
  { sessionId: 'fork', running: true, parentSessionId: 'root' },
  { sessionId: 'fork-grand', running: true, origin: 'subagent', parentSessionId: 'fork' },
  { sessionId: 'unrelated', running: true, parentSessionId: null },
  { sessionId: 'self', running: false, parentSessionId: 'self' },
]

test('fetchSessionRunningLineage reads running ids AND the SUBAGENT parent edges of one session/list call', async () => {
  const lineage = await fetchSessionRunningLineage(lineageClient(LINEAGE_ROWS) as never)
  assert.deepEqual([...lineage.running].sort(), ['child', 'fork', 'fork-grand', 'grand', 'unrelated'])
  assert.deepEqual([...lineage.parents.entries()], [['child', 'root'], ['grand', 'child'], ['fork-grand', 'fork']],
    'subagent edges only; the fork row and the self-referencing row contribute no edge')
  assert.deepEqual([...lineage.subagentIds].sort(), ['child', 'fork-grand', 'grand'],
    'subagent ROW presence is tracked separately from edge usability (E-#1)')
  assert.deepEqual([...lineage.listed].sort(),
    ['child', 'fork', 'fork-grand', 'grand', 'root', 'self', 'unrelated'],
    'every listed row is recorded so a MISSING row is detectable')
  assert.equal(upwardChainComplete('grand', lineage), true, 'the full chain resolves')
  assert.equal(upwardChainComplete('fork-grand', lineage), true, 'the chain ends at the fork edge')
})

test('sessionPurgeClosure follows subagent-origin edges only (a fork subtree is NOT the root tree)', async () => {
  const lineage = await fetchSessionRunningLineage(lineageClient(LINEAGE_ROWS) as never)
  assert.deepEqual(sessionPurgeClosure(['root'], lineage), ['root', 'child', 'grand'],
    'the fork child (and everything under it) is outside the purge tree')
  assert.deepEqual(sessionPurgeClosure(['root'], null), ['root'], 'no lineage facts => roots only, never a guess')
})

test('stopSessionsForPurge cancels the running CLOSURE and waits for the whole closure to settle', async () => {
  const cancelled: string[] = []
  const parents = new Map([['child', 'root'], ['grand', 'child']])
  let running = new Set(['child', 'grand', 'unrelated'])
  const result = await stopSessionsForPurge(lineageClient(LINEAGE_ROWS) as never, ['root'], {
    fetchRunning: async () => lineageOf(running, parents),
    cancel: async (_client, sessionId) => { cancelled.push(sessionId) },
    delay: async () => { running = new Set(['unrelated']) },
    attempts: 3,
    intervalMs: 1,
  })
  assert.deepEqual(cancelled, ['child', 'grand'],
    'an invisible running descendant (and its own child) is cancelled; unrelated running ids are never touched')
  assert.deepEqual(result.cancelled, ['child', 'grand'])
  assert.deepEqual(result.stillRunning, [], 'the wait covers every closure member')
  assert.deepEqual(result.failures, [])
})

test('stopSessionsForPurge never cancels a running FORK of the selected root (F3)', async () => {
  const cancelled: string[] = []
  const lineage = await fetchSessionRunningLineage(lineageClient(LINEAGE_ROWS) as never)
  const result = await stopSessionsForPurge(lineageClient(LINEAGE_ROWS) as never, ['root'], {
    fetchRunning: async () => lineage,
    cancel: async (_client, sessionId) => { cancelled.push(sessionId) },
    delay: async () => {},
    attempts: 1,
  })
  assert.deepEqual(cancelled, ['child', 'grand'],
    'only the subagent closure is cancelled: the fork (and its own subagent child) live in another tree')
  assert.deepEqual(result.cancelled, ['child', 'grand'])
})

test('stopSessionsForPurge refuses roots whose CLOSURE contains the excluded viewed session (F2)', async () => {
  const cancelled: string[] = []
  const parents = new Map([['child', 'root'], ['grand', 'child']])
  const running = new Set(['child', 'grand', 'sibling'])
  const lineage = lineageOf(running, parents)
  const result = await stopSessionsForPurge(lineageClient(LINEAGE_ROWS) as never, ['root', 'sibling'], {
    fetchRunning: async () => lineage,
    cancel: async (_client, sessionId) => { cancelled.push(sessionId) },
    delay: async () => { running.clear() },
    attempts: 2,
    intervalMs: 1,
    exclude: ['grand'],
  })
  assert.deepEqual(result.refusedRoots, ['root'],
    'the viewed session sits in root\'s closure => root is refused whole')
  assert.deepEqual(cancelled, ['sibling'],
    'the refused root is never cancelled and the viewed id itself is excluded from the pass')
  assert.deepEqual(result.stillRunning, [], 'the refused root is not part of the wait set')
})

test('stopSessionsForPurge reports a lingering closure descendant in stillRunning (fail-closed)', async () => {
  const parents = new Map([['child', 'root'], ['grand', 'child']])
  let running = new Set(['child', 'grand'])
  const result = await stopSessionsForPurge(lineageClient(LINEAGE_ROWS) as never, ['root'], {
    fetchRunning: async () => lineageOf(running, parents),
    cancel: async () => {},
    delay: async () => { running = new Set(['grand']) },
    attempts: 2,
    intervalMs: 1,
  })
  assert.deepEqual(result.cancelled, ['child', 'grand'])
  assert.deepEqual(result.stillRunning, ['grand'],
    'a descendant that did not settle is reported so the caller stays fail-closed')
})

test('stopSessionsForPurge without lineage facts stays roots-only (a parent is never guessed)', async () => {
  const cancelled: string[] = []
  let running = new Set(['root', 'child'])
  const result = await stopSessionsForPurge({} as never, ['root'], {
    fetchRunning: async () => lineageOf(running, new Map()),
    cancel: async (_client, sessionId) => { cancelled.push(sessionId) },
    delay: async () => { running = new Set(['child']) },
    attempts: 2,
    intervalMs: 1,
  })
  assert.deepEqual(cancelled, ['root'], 'no edges => only the requested roots are cancelled')
  assert.deepEqual(result.stillRunning, [])
})
