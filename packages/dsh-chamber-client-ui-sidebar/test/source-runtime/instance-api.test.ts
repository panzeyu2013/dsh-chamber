import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchInstanceSnapshot } from '../../src/shared/instance-api.ts'

/** One wire summary row (SessionSummary shape the unary client decodes). */
function summary(overrides: Record<string, unknown>): Record<string, unknown> {
  return { sessionId: 's1', updatedAt: 100, running: false, blank: false, ...overrides }
}

/** Minimal unary client whose `session.list` answers `items`. */
function listClient(items: readonly unknown[]) {
  return { session: { list: async () => ({ ok: true as const, value: { items } }) } }
}

test('fetchInstanceSnapshot derives workspace groups from session cwd facts', async () => {
  const client = listClient([
    summary({ sessionId: 's1', cwd: '/work/a', updatedAt: 300, running: true }),
    summary({ sessionId: 's2', cwd: '/work/a', updatedAt: 200 }),
    summary({ sessionId: 's3', cwd: '/work/b', updatedAt: 400 }),
    summary({ sessionId: 's4' }), // no cwd → ungrouped
    summary({ sessionId: 'sub', origin: 'subagent', cwd: '/work/a' }),
  ])
  const snapshot = await fetchInstanceSnapshot(client as never)
  // Groups ordered by newest session (/work/b has s3@400 first).
  assert.equal(snapshot.workspaces.length, 2)
  assert.deepEqual(snapshot.workspaces.map(w => w.title), ['b', 'a'])
  assert.equal(snapshot.workspaces[0].sessionIds.join(','), 's3')
  assert.equal(snapshot.workspaces[1].sessionIds.join(','), 's1,s2')
  // cwd-derived groups are DISPLAY-ONLY: every row carries the synthetic
  // marker so the sidebar disables its host-scoped mutations.
  assert.ok(snapshot.workspaces.every(workspace => workspace.synthetic === true))
  // Subagent rows never surface.
  assert.deepEqual(snapshot.sessions.map(row => row.sessionId), ['s1', 's2', 's3', 's4'])
  // Archive set has no unary wire source — documented degradation. The
  // snapshot must mark its archive set NOT known so consumers never read the
  // empty set as "no archived sessions".
  assert.deepEqual(snapshot.archivedSessionIds, [])
  assert.equal(snapshot.archiveSetKnown, false)
})

test('fetchInstanceSnapshot resolves the official display label on the unary path', async () => {
  // I3: the unary wire carries no displayTitle, so the builder applies the
  // ladder itself — durable title, then the cwd basename, then the id. A row
  // whose title the host could not read (title projection empty) must NOT
  // arrive labelless: the sidebar would render 「未命名会话」 for it.
  // The REAL shape of a label-less predecessor record: the official title unit
  // serves `null` (schema `string().min(1).nullable()`), and an empty string is
  // impossible on the wire — both must resolve by the same ladder.
  const client = listClient([
    summary({ sessionId: 'titled', cwd: '/work/a', projections: { values: { title: 'Real title' } } }),
    summary({ sessionId: 'untitled', cwd: '/work/dsh-chamber', projections: { values: { title: null } } }),
    summary({ sessionId: 'empty-title', cwd: '/work/dsh-chamber', projections: { values: { title: '' } } }),
    summary({ sessionId: 'nowhere' }),
  ])
  const snapshot = await fetchInstanceSnapshot(client as never)
  const byId = new Map(snapshot.sessions.map(row => [row.sessionId, row]))
  assert.equal(byId.get('titled')?.displayTitle, 'Real title')
  assert.equal(byId.get('titled')?.title, 'Real title', 'the durable title still rides alongside')
  assert.equal(byId.get('untitled')?.title, undefined, 'an empty wire title is dropped from the durable field')
  assert.equal(byId.get('untitled')?.displayTitle, 'dsh-chamber', 'the official label is the directory name')
  assert.equal(byId.get('empty-title')?.displayTitle, 'dsh-chamber', 'an empty wire title resolves the same way')
  assert.equal(byId.get('nowhere')?.displayTitle, 'nowhere', 'last resort: the raw session id')
})

test('fetchInstanceSnapshot surfaces no-cwd sessions ungrouped and keeps wire rows', async () => {
  const client = listClient([summary({ sessionId: 's1' }), summary({ sessionId: 's2', cwd: '/x' })])
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
  const client = listClient([
    summary({ sessionId: 's1', cwd: 'C:\\work\\proj' }),
    summary({ sessionId: 's2', cwd: '/work/proj/' }),
    summary({ sessionId: 's3', cwd: '/' }),
  ])
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
  isSessionNotAttached,
  purgeArchivedSessions,
  sessionPurgeClosure,
  stopArchivedSubtree,
  stopSessionsForPurge,
  upwardChainComplete,
  type SessionRunningLineage,
  type ArchiveCleanupPurgeResult,
} from '../../src/shared/instance-api.ts'

function cleanupClient(overrides: Record<string, unknown> = {}) {
  const nested = (payload: unknown) => ({ ok: true as const, value: { ok: true as const, value: payload } })
  return {
    archiveCleanup: {
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

/** JSON response carrying the wire content type. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Run `body` with globalThis.fetch stubbed, restoring it on every path. */
async function withFetch<T>(stub: typeof fetch, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = stub
  try { return await body() } finally { globalThis.fetch = original }
}

/** Stub answering every unary RPC with the generic carrier `{ok:true,value:result}`, recording bodies. */
function rpcStub(result: unknown, bodies: string[] = []): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(init?.body ?? '')
    bodies.push(raw)
    const envelope = JSON.parse(raw) as { rpcId?: string }
    return jsonResponse({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: result } })
  }) as typeof fetch
}

test('purgeArchivedSessions decodes counts and per-item errors (partial failure is visible)', async () => {
  const client = cleanupClient({
    deletedSessions: 1,
    errors: [
      { sessionId: 's2', code: 'storage', message: 'fake failure' },
      { sessionId: 'bad' }, // malformed record dropped
      'not-an-object',
    ],
  })
  const result: ArchiveCleanupPurgeResult = await purgeArchivedSessions(client as never, ['s1'])
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.deletedSubagents, 2)
  assert.equal(result.skippedRunning, 1)
  assert.deepEqual(result.errors, [{ sessionId: 's2', code: 'storage', message: 'fake failure' }])
  // The host's registry-global orphan sweep count (design 24 §12)
  // is absent when the host did not report it.
  assert.equal(result.clearedOrphanMembers, undefined)
})

test('purgeArchivedSessions carries the orphan-sweep count when the host reports it', async () => {
  const client = cleanupClient({ deletedSessions: 0, clearedOrphanMembers: 3 })
  const result: ArchiveCleanupPurgeResult = await purgeArchivedSessions(client as never, ['s1'])
  assert.equal(result.deletedSessions, 0)
  assert.equal(result.clearedOrphanMembers, 3)
  // A malformed/negative count degrades to absent, never to a fabricated zero.
  const malformed = await purgeArchivedSessions(cleanupClient({ clearedOrphanMembers: -2 }) as never, ['s1'])
  assert.equal(malformed.clearedOrphanMembers, undefined)
})

test('purgeArchivedSessions carries the resident-retained id list (design 24 §4 step 9) and never fabricates ids', async () => {
  // The host kept these roots archived because the instance process still
  // serves them: the manager labels exactly those rows.
  const client = cleanupClient({
    deletedSessions: 2,
    forcedLoaded: 2,
    residentRetainedRoots: ['s1', 's2'],
  })
  const result = await purgeArchivedSessions(client as never, ['s1', 's2'])
  assert.deepEqual(result.residentRetainedRoots, ['s1', 's2'])
  // Older hosts / zero-retention runs omit the field entirely.
  const absent = await purgeArchivedSessions(cleanupClient({ deletedSessions: 1 }) as never, ['s1'])
  assert.equal(absent.residentRetainedRoots, undefined)
  // Malformed shapes degrade to absent or drop the bad entries — an id list is
  // only a row LABEL, and a fabricated one would label the wrong row.
  assert.equal((await purgeArchivedSessions(cleanupClient({ residentRetainedRoots: 's1' }) as never, ['s1'])).residentRetainedRoots, undefined)
  assert.equal((await purgeArchivedSessions(cleanupClient({ residentRetainedRoots: [] }) as never, ['s1'])).residentRetainedRoots, undefined)
  const mixed = await purgeArchivedSessions(
    cleanupClient({ residentRetainedRoots: ['s1', 7, '', null, 's2'] }) as never,
    ['s1', 's2'],
  )
  assert.deepEqual(mixed.residentRetainedRoots, ['s1', 's2'])
  // Duplicates collapse: the list feeds a count AND a label set, and a
  // duplicated id would make the note over-count the rows it labels.
  const dupes = await purgeArchivedSessions(
    cleanupClient({ residentRetainedRoots: ['s1', 's1', 's2', 's1'] }) as never,
    ['s1', 's2'],
  )
  assert.deepEqual(dupes.residentRetainedRoots, ['s1', 's2'])
})

test('archiveCleanup business failures decode the NESTED domain carrier (security review Major-1)', async () => {
  // Realistic two-level wire: the generic RPC layer answers ok:true and the
  // host domain carrier rides nested in `value` ({ok:false,error}). A busy
  // or registry-unreadable answer must surface as a thrown `${code}: …`
  // message — NEVER decode into empty counts (a second shell would otherwise
  // show "没有可删除的已归档会话" while another purge is running).
  const client = {
    archiveCleanup: {
      purge: async () => ({ ok: true as const, value: { ok: false as const, error: { code: 'registry-unreadable', message: 'unreadable', details: {} } } }),
    },
  }
  await assert.rejects(() => purgeArchivedSessions(client as never, ['s1']), (error: unknown) => {
    return error instanceof Error && error.message.startsWith('registry-unreadable:')
  })
  // RPC-level ok:false (transport refusal) keeps the same shape.
  const refusedTransport = {
    archiveCleanup: {
      purge: async () => ({ ok: false as const, error: { code: 'unclaimed', message: 'x', details: {} } }),
    },
  }
  await assert.rejects(() => purgeArchivedSessions(refusedTransport as never, ['s1']), (error: unknown) => {
    return error instanceof Error && error.message.startsWith('unclaimed:')
  })
})

test('malformed nested domain carriers FAIL LOUD — never decode into empty counts (review follow-up F1)', async () => {
  // decodeDomainResult's fail-closed shape contract: the nested carrier must
  // be an object carrying a boolean ok, and ok:true must carry an OBJECT
  // value (purge domain values are always objects). Every other shape —
  // value 42 / null / missing, an array or absent carrier, non-boolean ok —
  // throws the loud zh malformed-domain error, never a silent empty purge
  // result.
  const resolveAs = (payload: unknown) => ({ ok: true as const, value: payload })
  const shapes: Array<{ name: string; shape: unknown }> = [
    { name: 'purge ok:true value is a number (7)', shape: resolveAs({ ok: true as const, value: 7 }) },
    { name: 'purge ok:true value is null', shape: resolveAs({ ok: true as const, value: null }) },
    { name: 'purge ok:true value is undefined', shape: resolveAs({ ok: true as const, value: undefined }) },
    { name: 'purge carrier is an array', shape: resolveAs([{ ok: true, value: {} }]) },
    { name: 'purge carrier absent (no value slot)', shape: { ok: true as const } },
    { name: 'purge ok is not boolean (string)', shape: resolveAs({ ok: 'yes', value: {} }) },
    { name: 'purge ok is not boolean (number)', shape: resolveAs({ ok: 1, value: {} }) },
  ]
  for (const c of shapes) {
    const client = {
      archiveCleanup: {
        purge: async () => c.shape,
      },
    }
    await assert.rejects(() => purgeArchivedSessions(client as never, ['s1']), (error: unknown) => {
      return error instanceof Error && error.message.startsWith('归档清理域返回了畸形结果')
    }, c.name)
  }
})

test('404 discrimination: instance_not_found stays a generic transport failure; other 404s map to domain missing', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  // First call: control-plane unknown-instance 404 (body code present). Second:
  // a host 404 with no instance_not_found code (a domain the runtime tree does
  // not mount).
  const responses = [
    jsonResponse({ code: 'instance_not_found', error: 'unknown instance path' }, 404),
    jsonResponse({ error: 'method not registered' }, 404),
  ]
  await withFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return responses.shift() as Response
  }) as typeof fetch, async () => {
    const client = getInstanceClient('local')
    await assert.rejects(
      () => client.archiveCleanup.purge(['s1'], true, []),
      (error: unknown) => error instanceof Error && error.message.includes('HTTP 404')
        && error.name !== 'InstanceDomainMissingError',
    )
    await assert.rejects(
      () => client.archiveCleanup.purge(['s1'], true, []),
      (error: unknown) => error instanceof Error && error.name === 'InstanceDomainMissingError',
    )
  })
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.url.includes('/api/i/local/api/archiveCleanup/purge')))
  const body = JSON.parse(String(calls[0]?.init?.body)) as { method?: string; payload?: unknown }
  assert.equal(body.method, 'archiveCleanup/purge')
  assert.deepEqual(body.payload, { args: { sessionIds: ['s1'], force: true, protectSessionIds: [] } })
})

test('404 discrimination: oversized 404 bodies stay safe under the bounded read (review follow-up F10)', async () => {
  // A body far beyond the 4 KiB cap is never fully consumed: the bounded probe
  // resolves null and the conservative domain-missing throw follows — no crash.
  const oversized = 'x'.repeat(64 * 1024)
  const responses = [
    // Even an oversized body that WOULD carry instance_not_found past the cap
    // is not trusted — the discrimination only reads a tiny code JSON.
    jsonResponse({ code: 'instance_not_found', error: oversized }, 404),
    new Response(oversized, { status: 404 }),
  ]
  await withFetch((async () => responses.shift() as Response) as typeof fetch, async () => {
    const client = getInstanceClient('local')
    await assert.rejects(
      () => client.archiveCleanup.purge(['s1'], true, []),
      (error: unknown) => error instanceof Error && error.name === 'InstanceDomainMissingError',
    )
    await assert.rejects(
      () => client.archiveCleanup.purge(['s1'], true, []),
      (error: unknown) => error instanceof Error && error.name === 'InstanceDomainMissingError',
    )
  })
})

test('purge wrapper maps no-response outcomes to honest retry copy (design 24 §5)', async () => {
  const timeout = new Error('signal timed out')
  timeout.name = 'TimeoutError'
  const network = new TypeError('fetch failed')
  const timeoutClient = {
    archiveCleanup: {
      purge: async () => { throw timeout },
    },
  }
  const networkClient = {
    archiveCleanup: {
      purge: async () => { throw network },
    },
  }
  await assert.rejects(() => purgeArchivedSessions(timeoutClient as never, ['s1']), /可能仍在进行.*重复执行是安全的/)
  await assert.rejects(() => purgeArchivedSessions(networkClient as never, ['s1']), /可能仍在进行.*重复执行是安全的/)
  // A deterministic business failure still surfaces verbatim (never remapped).
  const refused = {
    archiveCleanup: {
      purge: async () => ({ ok: true as const, value: { ok: false as const, error: { code: 'registry-unreadable', message: 'unreadable', details: {} } } }),
    },
  }
  await assert.rejects(() => purgeArchivedSessions(refused as never, ['s1']), (error: unknown) => {
    return error instanceof Error && error.message.startsWith('registry-unreadable:')
  })
  // A proxy 504 upstream_timeout is an uncertain outcome (the host may still
  // be purging) — the honest "may still be running" copy, never "不可达".
  const proxiedTimeout = {
    archiveCleanup: {
      purge: async () => { throw new Error('实例不可达：transport failure for endpoint: HTTP 504 upstream_timeout') },
    },
  }
  await assert.rejects(() => purgeArchivedSessions(proxiedTimeout as never, ['s1']), /可能仍在进行.*重复执行是安全的/)
})

test('503 classification: not-ready answers surface as InstanceUnavailableError (not-ready prefix)', async () => {
  const notReady = (async () => jsonResponse({ code: 'instance_unavailable', error: 'instance is still starting' }, 503)) as typeof fetch
  await withFetch(notReady, async () => {
    const client = getInstanceClient('local')
    // The prefix comes from the wrapper-level wrapWireError.
    await assert.rejects(
      () => client.archiveCleanup.purge(['s1'], true, []),
      (error: unknown) => error instanceof InstanceUnavailableError,
    )
  })
})

test('purgeArchivedSessions always sends {sessionIds, force:true, protectSessionIds} — one shape, no legacy legs (2026-09 protection amendment)', async () => {
  const bodies: string[] = []
  const client = getInstanceClient('local')
  const result = await withFetch(rpcStub({
    ok: true,
    value: {
      deletedSessions: 1, deletedSubagents: 0, skippedRunning: 0, skippedLoaded: 0,
      forcedLoaded: 1, skippedProtected: 2, errors: [],
    },
  }, bodies), () => purgeArchivedSessions(client, ['s1', 's2'], ['s9']))
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.forcedLoaded, 1)
  assert.equal(result.skippedProtected, 2, 'the host-reported protected-tree count is decoded')
  assert.equal(bodies.length, 1, 'exactly one call — no skew retry leg exists')
  const argsOf = (raw: string): unknown => (JSON.parse(raw) as { payload?: unknown }).payload
  assert.deepEqual(argsOf(bodies[0] as string), {
    args: { sessionIds: ['s1', 's2'], force: true, protectSessionIds: ['s9'] },
  })
})

test('purgeArchivedSessions: no protectable session still sends the same shape with an empty protected set', async () => {
  const bodies: string[] = []
  const client = getInstanceClient('local')
  const result = await withFetch(
    rpcStub({ ok: true, value: { deletedSessions: 0, deletedSubagents: 0, skippedRunning: 0, errors: [] } }, bodies),
    () => purgeArchivedSessions(client, []),
  )
  assert.equal(result.deletedSessions, 0)
  assert.equal(result.skippedProtected, 0, 'an absent count decodes to 0, never undefined')
  const payload = (JSON.parse(bodies[0] as string) as { payload?: unknown }).payload
  // [] is the delimiter for "delete nothing" and MUST NOT be normalized to a
  // whole-set request; the protected set is explicit and empty.
  assert.deepEqual(payload, { args: { sessionIds: [], force: true, protectSessionIds: [] } })
})

test('purgeArchivedSessions surfaces a host args refusal verbatim (no compatibility fallback exists)', async () => {
  const refused = {
    archiveCleanup: {
      purge: async () => ({
        ok: true as const,
        value: { ok: false as const, error: { code: 'gateway/arguments-invalid', message: 'unexpected "protectSessionIds"', details: {} } },
      }),
    },
  }
  await assert.rejects(() => purgeArchivedSessions(refused as never, ['s1'], ['s9']), (error: unknown) => {
    return error instanceof Error && error.message.startsWith('gateway/arguments-invalid:')
  })
})

test('cancelSession posts the official session/cancel request shape', async () => {
  const bodies: string[] = []
  await withFetch(rpcStub({ ok: true, value: { accepted: true } }, bodies), async () => {
    await cancelSession(getInstanceClient('local'), 's1')
  })
  const envelope = JSON.parse(bodies[0] as string) as { method?: string; payload?: unknown }
  assert.equal(envelope.method, 'session/cancel')
  assert.deepEqual(envelope.payload, { args: { request: { sessionId: 's1' } } })
})

test('fetchSessionRunningLineage keeps subagent rows but only SUBAGENT-origin edges (fork rows carry none)', async () => {
  const client = listClient([
    { sessionId: 's1', running: true },
    { sessionId: 'a1', running: true, origin: 'subagent', parentSessionId: 's1' },
    { sessionId: 'fork1', running: true, parentSessionId: 's1' },
    { sessionId: 's2', running: false },
    { sessionId: 's3' },
  ])
  const lineage = await fetchSessionRunningLineage(client as never)
  assert.deepEqual([...lineage.running].sort(), ['a1', 'fork1', 's1'],
    'a running fork is a real running session (its own guards must see it)')
  assert.deepEqual([...lineage.parents.entries()], [['a1', 's1']],
    'only origin === "subagent" is lineage: the fork edge is never followed')
})

test('stopSessionsForPurge asks EVERY closure member to cancel; only observed-running ones count as stopped (2026-09 maintenance-phase scope)', async () => {
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
  // s3 is NOT running, yet it is asked to cancel: a maintenance phase
  // (compaction/schedule) reports `idle` while it still appends to the log, and
  // a cancel is the only client-side way to abort it before a content purge.
  assert.deepEqual(cancelled, ['s1', 's2', 's3'])
  assert.deepEqual(result.cancelled, ['s1', 's2'], 'the user-visible count stays honest')
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
        const { InstanceRpcError: RpcError } = await import('../../src/shared/instance-rpc-error.ts')
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
    'caught, never thrown — the caller proceeds with the purge and the host running guard is the safety net')
  assert.equal(result.lineage, null, 'no lineage facts were read')
  assert.deepEqual(result.refusedRoots, [])
})

// ---------------------------------------------------------------------------
// The pre-purge stop pass covers the CLOSURE of the
// selected roots. The host skips an archived tree whose ANY member runs, and
// a running subagent descendant has no row in the manager — roots-only
// cancels can never settle such a tree.
// The closure follows SUBAGENT-origin edges only (a
// running FORK of a selected root is never cancelled — the purge tree never
// contains it), and the currently-viewed session is excluded from the CLOSURE.
// ---------------------------------------------------------------------------

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
  const lineage = await fetchSessionRunningLineage(listClient(LINEAGE_ROWS) as never)
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
  const lineage = await fetchSessionRunningLineage(listClient(LINEAGE_ROWS) as never)
  assert.deepEqual(sessionPurgeClosure(['root'], lineage), ['root', 'child', 'grand'],
    'the fork child (and everything under it) is outside the purge tree')
  assert.deepEqual(sessionPurgeClosure(['root'], null), ['root'], 'no lineage facts => roots only, never a guess')
})

test('stopSessionsForPurge cancels the running CLOSURE and waits for the whole closure to settle', async () => {
  const cancelled: string[] = []
  const parents = new Map([['child', 'root'], ['grand', 'child']])
  let running = new Set(['child', 'grand', 'unrelated'])
  const result = await stopSessionsForPurge(listClient(LINEAGE_ROWS) as never, ['root'], {
    fetchRunning: async () => lineageOf(running, parents),
    cancel: async (_client, sessionId) => { cancelled.push(sessionId) },
    delay: async () => { running = new Set(['unrelated']) },
    attempts: 3,
    intervalMs: 1,
  })
  assert.deepEqual(cancelled, ['root', 'child', 'grand'],
    'every closure member is asked (the root included); unrelated running ids are never touched')
  assert.deepEqual(result.cancelled, ['child', 'grand'])
  assert.deepEqual(result.stillRunning, [], 'the wait covers every closure member')
  assert.deepEqual(result.failures, [])
})

test('stopSessionsForPurge never cancels a running FORK of the selected root (F3)', async () => {
  const cancelled: string[] = []
  const lineage = await fetchSessionRunningLineage(listClient(LINEAGE_ROWS) as never)
  const result = await stopSessionsForPurge(listClient(LINEAGE_ROWS) as never, ['root'], {
    fetchRunning: async () => lineage,
    cancel: async (_client, sessionId) => { cancelled.push(sessionId) },
    delay: async () => {},
    attempts: 1,
  })
  assert.deepEqual(cancelled, ['root', 'child', 'grand'],
    'only the subagent closure is asked: the fork (and its own subagent child) live in another tree')
  assert.deepEqual(result.cancelled, ['child', 'grand'])
})

test('stopSessionsForPurge refuses roots whose CLOSURE contains the excluded viewed session (F2)', async () => {
  const cancelled: string[] = []
  const parents = new Map([['child', 'root'], ['grand', 'child']])
  const running = new Set(['child', 'grand', 'sibling'])
  const lineage = lineageOf(running, parents)
  const result = await stopSessionsForPurge(listClient(LINEAGE_ROWS) as never, ['root', 'sibling'], {
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
  const result = await stopSessionsForPurge(listClient(LINEAGE_ROWS) as never, ['root'], {
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

test('stopSessionsForPurge surfaces a LISTED member\'s failed cancel (a maintenance phase reports idle, so its failure must not be swallowed)', async () => {
  // `idle-listed` is not in the running set, but it HAS a list row — i.e. it can
  // be mid-maintenance (vendor agent loop reports `idle` during compaction) and
  // still appending to the log. Its cancel failure is the dangerous case.
  const parents = new Map<string, string>()
  const lineage: SessionRunningLineage = {
    running: new Set(['root']),
    parents,
    listed: new Set(['root', 'idle-listed']),
    subagentIds: new Set(),
  }
  const result = await stopSessionsForPurge({} as never, ['root', 'idle-listed', 'cold-gone'], {
    fetchRunning: async () => lineage,
    cancel: async (_client, sessionId) => {
      if (sessionId === 'root') return
      throw new Error(`refused: ${sessionId}`)
    },
    delay: async () => {},
    attempts: 1,
    intervalMs: 1,
  })
  assert.deepEqual(result.cancelled, ['root'])
  assert.deepEqual(result.failures.map(failure => failure.sessionId), ['idle-listed'],
    'a listed member\'s failure is surfaced; the unlisted (cold) member\'s is a documented no-op')
})

test('stopSessionsForPurge keeps INPUT order under the bounded cancel fan-out', async () => {
  const ids = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8']
  const lineage: SessionRunningLineage = {
    running: new Set(ids),
    parents: new Map(),
    listed: new Set(ids),
    subagentIds: new Set(),
  }
  const result = await stopSessionsForPurge({} as never, ids, {
    fetchRunning: async () => lineage,
    // Reverse completion order: the last id resolves first. Accounting must
    // still follow the requested order (the note/counts stay deterministic).
    cancel: async (_client, sessionId) => {
      const reverseDelay = (ids.length - ids.indexOf(sessionId)) * 2
      await new Promise<void>(resolve => { setTimeout(resolve, reverseDelay) })
    },
    delay: async () => {},
    attempts: 1,
    intervalMs: 1,
  })
  assert.deepEqual(result.cancelled, ids, 'input order, not completion order')
})

test('stopSessionsForPurge: requireCompleteExcludeChain cancels NOTHING when the viewed session\'s upward chain is unresolvable (2026-09)', async () => {
  const cancelled: string[] = []
  // `grand` is a subagent whose parent ROW IS MISSING from this read (the
  // vendor session list skips cwd-less cold records): the client cannot prove
  // which selected roots contain it, so no tree may be cancelled (the host
  // protects it anyway; cancelling would abort a live turn of a tree that will
  // not be deleted).
  const lineage: SessionRunningLineage = {
    running: new Set(['root', 'child']),
    parents: new Map([['grand', 'child']]),
    listed: new Set(['root', 'grand']),
    subagentIds: new Set(['grand', 'child']),
  }
  const result = await stopSessionsForPurge(listClient(LINEAGE_ROWS) as never, ['root'], {
    fetchRunning: async () => lineage,
    cancel: async (_client, sessionId) => { cancelled.push(sessionId) },
    delay: async () => {},
    attempts: 1,
    exclude: ['grand'],
    requireCompleteExcludeChain: true,
  })
  assert.deepEqual(cancelled, [], 'an unresolvable viewed-session chain cancels nothing')
  assert.deepEqual(result.cancelled, [])
  assert.deepEqual(result.refusedRoots, [])
  assert.equal(result.unavailable, false, 'the read itself succeeded — this is a scope decision, not a failure')
})

test('stopSessionsForPurge: a COMPLETE viewed-session chain keeps the cancel pass running (2026-09)', async () => {
  const cancelled: string[] = []
  // Real rows: grand → child → root, so the chain resolves and root's closure
  // is known not to contain `sibling`.
  const lineage = await fetchSessionRunningLineage(listClient(LINEAGE_ROWS) as never)
  const result = await stopSessionsForPurge(listClient(LINEAGE_ROWS) as never, ['sibling'], {
    fetchRunning: async () => lineage,
    cancel: async (_client, sessionId) => { cancelled.push(sessionId) },
    delay: async () => {},
    attempts: 1,
    exclude: ['grand'],
    requireCompleteExcludeChain: true,
  })
  assert.deepEqual(cancelled, ['sibling'], 'the unrelated root is still stopped')
  assert.deepEqual(result.refusedRoots, [])
})

test('stopArchivedSubtree: the archive-time stop is the exclusion-free closure pass (advisory, never throws)', async () => {
  // A failed lineage read must resolve to the advisory `unavailable` outcome —
  // the archive already happened, so the stop never throws and never rolls it
  // back (the delete-time pass tries again later).
  const result = await stopArchivedSubtree({
    session: { list: async () => { throw new Error('session/list exploded') } },
  } as never, 'root')
  assert.equal(result.unavailable, true)
  assert.deepEqual(result.cancelled, [])
  assert.equal(result.lineage, null)
})

// The unary fallback publishes the session's
// registered projections (`projections.values` — the same block `titleOf`
// reads), so an unmounted source's rows carry the active-Schedule fact exactly
// like the mounted-store projection (derive.ts projectInstanceSnapshot) does.
test('fetchInstanceSnapshot carries the active-Schedule fact from the wire projections block', async () => {
  const client = listClient([
    summary({ sessionId: 'scheduled', projections: { values: { schedule: [{ id: 'sch1' }] } } }),
    summary({ sessionId: 'idle-empty', projections: { values: { schedule: [] } } }),
    summary({ sessionId: 'no-bag' }),
    // Defensive: a non-array projection value is not an active set.
    summary({ sessionId: 'odd', projections: { values: { schedule: 'sch1' } } }),
  ])
  const snapshot = await fetchInstanceSnapshot(client as never)
  const byId = new Map(snapshot.sessions.map(row => [row.sessionId, row]))
  assert.equal(byId.get('scheduled')?.hasActiveSchedule, true, 'a non-empty schedule marks the row')
  assert.equal('hasActiveSchedule' in (byId.get('idle-empty') ?? {}), false, 'an empty schedule stays key-free')
  assert.equal('hasActiveSchedule' in (byId.get('no-bag') ?? {}), false, 'a missing bag stays key-free')
  assert.equal('hasActiveSchedule' in (byId.get('odd') ?? {}), false, 'a non-array value stays key-free')
})
