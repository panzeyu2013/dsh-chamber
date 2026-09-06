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
  getInstanceClient,
  InstanceUnavailableError,
  isInstanceDomainMissing,
  previewArchiveCleanup,
  purgeArchivedSessions,
  type ArchiveCleanupPurgeResult,
} from '../src/shared/instance-api.ts'

const PREVIEW_VALUE = {
  archived: 4,
  deletableSessions: 2,
  deletableSubagents: 2,
  skippedRunning: 1,
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
