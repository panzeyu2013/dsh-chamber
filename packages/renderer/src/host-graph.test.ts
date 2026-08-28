import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BundleLoadTimeoutError, collectExtraRows, dedupeHostEntries, fetchHostGraph, toExtraRows,
  type ExtraModuleRow, type HostGraphRow,
} from './host-graph.ts'
import { CHAMBER_COVERED_FACTORY_IDS, CHAMBER_COVERED_IDS } from './chamber-covered.ts'

const row = (id: string, over: Partial<HostGraphRow> = {}): HostGraphRow => ({
  id,
  url: `/plugins/${id}/client.js?rev=abc123`,
  rev: 'abc123',
  ...over,
})

/** Stub globalThis.fetch; records the wire call; body may be an Error (transport rejection). */
function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    if (body instanceof Error) return Promise.reject(body)
    return Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }))
  }) as typeof fetch
  return {
    calls,
    restore(): void { globalThis.fetch = original },
  }
}

const envelope = (entries: unknown) => ({
  rpcId: 'r1',
  result: { ok: true, value: { rev: 'graph-rev', entries } },
})

test('fetchHostGraph: success resolves the entries, carrying optional fields', async () => {
  const stub = stubFetch(200, envelope([
    row('@scope/pkg-a', { inject: ['@deepseek-ai/dsh-client-runtime'], immediately: true }),
    row('@deepseek-ai/dsh-client-hmr'),
  ]))
  try {
    const rows = await fetchHostGraph('/api/i/local')
    assert.deepEqual(rows, [
      { id: '@scope/pkg-a', url: '/plugins/@scope/pkg-a/client.js?rev=abc123', rev: 'abc123', inject: ['@deepseek-ai/dsh-client-runtime'], immediately: true },
      { id: '@deepseek-ai/dsh-client-hmr', url: '/plugins/@deepseek-ai/dsh-client-hmr/client.js?rev=abc123', rev: 'abc123' },
    ])
  } finally {
    stub.restore()
  }
})

test('fetchHostGraph: wire call targets the per-instance proxy with a client-request envelope', async () => {
  const stub = stubFetch(200, envelope([]))
  try {
    await fetchHostGraph('/api/i/ssh-42')
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0].url, '/api/i/ssh-42/api/clientGraph/graph')
    const init = stub.calls[0].init
    assert.equal(init.method, 'POST')
    assert.deepEqual((init.headers as Record<string, string>)['content-type'], 'application/json')
    assert.ok(init.signal instanceof AbortSignal)
    const body = JSON.parse(String(init.body))
    assert.equal(body.type, 'client-request')
    assert.equal(body.method, 'clientGraph/graph')
    assert.deepEqual(body.payload, { args: {} })
    assert.equal(typeof body.rpcId, 'string')
  } finally {
    stub.restore()
  }
})

test('fetchHostGraph: 503 instance_unavailable resolves null (instance not ready)', async () => {
  const stub = stubFetch(503, { code: 'instance_unavailable', error: 'instance not ready' })
  try {
    assert.equal(await fetchHostGraph('/api/i/local'), null)
  } finally {
    stub.restore()
  }
})

test('fetchHostGraph: 503 without instance_unavailable throws', async () => {
  const stub = stubFetch(503, { code: 'other' })
  try {
    await assert.rejects(fetchHostGraph('/api/i/local'), /HTTP 503/)
  } finally {
    stub.restore()
  }
})

test('fetchHostGraph: other non-2xx throws', async () => {
  const stub = stubFetch(500, {})
  try {
    await assert.rejects(fetchHostGraph('/api/i/local'), /HTTP 500/)
  } finally {
    stub.restore()
  }
})

test('fetchHostGraph: transport failure throws', async () => {
  const stub = stubFetch(200, new Error('network down'))
  try {
    await assert.rejects(fetchHostGraph('/api/i/local'), /宿主启动图不可达：network down/)
  } finally {
    stub.restore()
  }
})

test('fetchHostGraph: business failure (result.ok false) throws with the host error', async () => {
  const stub = stubFetch(200, { rpcId: 'r1', result: { ok: false, error: { code: 'boom', message: 'graph exploded' } } })
  try {
    await assert.rejects(fetchHostGraph('/api/i/local'), /graph 调用失败：graph exploded/)
  } finally {
    stub.restore()
  }
})

test('collectExtraRows: an RPC missing-method message reports not-injected even with a generic code', async () => {
  const stub = stubFetch(200, {
    rpcId: 'r1',
    result: { ok: false, error: { code: 'rpc_failed', message: 'unknown method clientGraph/graph' } },
  })
  const consoleCapture = captureConsoleError()
  let diagnostic: { state: string } | undefined
  try {
    assert.deepEqual(await collectExtraRows('legacy-rpc', '/api/i/legacy-rpc', {
      loadModuleBundle: async () => {},
      reportDiagnostic: (_sourceId, next) => { diagnostic = next },
    }), [])
    assert.equal(diagnostic?.state, 'not-injected')
  } finally {
    stub.restore()
    consoleCapture.restore()
  }
})

test('collectExtraRows: concurrent consumers await one shared bundle load', async () => {
  const id = '@scope/concurrent-shared-load'
  const stub = stubFetch(200, envelope([row(id)]))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let loads = 0
  const loadModuleBundle = async (): Promise<void> => {
    loads += 1
    await gate
  }
  try {
    const first = collectExtraRows('concurrent-a', '/api/i/local', { loadModuleBundle })
    const second = collectExtraRows('concurrent-b', '/api/i/ssh-b', { loadModuleBundle })
    let secondSettled = false
    void second.finally(() => { secondSettled = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(loads, 1)
    assert.equal(secondSettled, false, 'a duplicate consumer must wait until the shared bundle is actually loaded')
    release()
    await Promise.all([first, second])
    assert.equal(loads, 1)
  } finally {
    stub.restore()
  }
})

test('collectExtraRows: a shared concurrent rejection fails every waiter and remains retryable', async () => {
  const id = '@scope/concurrent-shared-failure'
  const stub = stubFetch(200, envelope([row(id)]))
  let loads = 0
  let shouldFail = true
  const loadModuleBundle = async (): Promise<void> => {
    loads += 1
    if (shouldFail) throw new Error('shared load failed')
  }
  try {
    const results = await Promise.allSettled([
      collectExtraRows('failure-a', '/api/i/local', { loadModuleBundle }),
      collectExtraRows('failure-b', '/api/i/ssh-b', { loadModuleBundle }),
    ])
    assert.equal(loads, 1)
    assert.ok(results.every(result => result.status === 'rejected'))
    shouldFail = false
    await collectExtraRows('failure-retry', '/api/i/local', { loadModuleBundle })
    assert.equal(loads, 2)
  } finally {
    stub.restore()
  }
})

test('collectExtraRows: a timed-out script is not duplicated and a late load converges to success', async () => {
  const id = '@scope/late-timeout-tombstone'
  const stub = stubFetch(200, envelope([row(id)]))
  let loads = 0
  let settleOutcome!: (loaded: boolean) => void
  const bundleOutcome = new Promise<boolean>(resolve => { settleOutcome = resolve })
  const timeout = new BundleLoadTimeoutError('bundle timed out', bundleOutcome)
  const loadModuleBundle = async (): Promise<void> => {
    loads += 1
    throw timeout
  }
  try {
    await assert.rejects(collectExtraRows('timeout-a', '/api/i/local', { loadModuleBundle }), /timed out/)
    await assert.rejects(collectExtraRows('timeout-b', '/api/i/ssh-b', { loadModuleBundle }), /timed out/)
    assert.equal(loads, 1, 'a second source must reuse the tombstone, not execute another URL')
    settleOutcome(true)
    await bundleOutcome
    await new Promise(resolve => setTimeout(resolve, 0))
    await collectExtraRows('timeout-recovered', '/api/i/local', { loadModuleBundle })
    assert.equal(loads, 1, 'the late script registered the factory; recovery must reuse it')
  } finally {
    stub.restore()
  }
})

test('collectExtraRows: a timed-out script that later errors becomes retryable', async () => {
  const id = '@scope/late-timeout-error'
  const stub = stubFetch(200, envelope([row(id)]))
  let loads = 0
  let settleOutcome!: (loaded: boolean) => void
  const bundleOutcome = new Promise<boolean>(resolve => { settleOutcome = resolve })
  const timeout = new BundleLoadTimeoutError('bundle timed out', bundleOutcome)
  const loadModuleBundle = async (): Promise<void> => {
    loads += 1
    if (loads === 1) throw timeout
  }
  try {
    await assert.rejects(collectExtraRows('timeout-error-a', '/api/i/local', { loadModuleBundle }), /timed out/)
    settleOutcome(false)
    await bundleOutcome
    await new Promise(resolve => setTimeout(resolve, 0))
    await collectExtraRows('timeout-error-retry', '/api/i/local', { loadModuleBundle })
    assert.equal(loads, 2)
  } finally {
    stub.restore()
  }
})

test('fetchHostGraph: malformed envelope/rows throw loud (never silently merged)', async () => {
  const cases: { status: number; body: unknown; match: RegExp }[] = [
    { status: 200, body: 'not-json', match: /envelope 不是合法 JSON/ },
    { status: 200, body: { rpcId: 'r1' }, match: /envelope 缺少 result/ },
    { status: 200, body: envelope('not-an-array'), match: /result.value.entries 必须是数组/ },
    { status: 200, body: envelope([row('a', { rev: 7 as unknown as string })]), match: /必须携带 string id\/url\/rev/ },
    { status: 200, body: envelope([42]), match: /entry 不是对象/ },
  ]
  for (const c of cases) {
    const stub = stubFetch(c.status, c.body)
    try {
      await assert.rejects(fetchHostGraph('/api/i/local'), c.match)
    } finally {
      stub.restore()
    }
  }
})

test('dedupeHostEntries: drops covered ids, keeps extras, preserves optional fields', () => {
  const covered = ['@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-runtime']
  const entries = [
    row('@deepseek-ai/dsh-client-ui-sidebar'),
    row('@deepseek-ai/dsh-client-runtime'),
    row('@scope/user-plugin', { immediately: true }),
  ]
  assert.deepEqual(dedupeHostEntries(entries, covered), [
    { id: '@scope/user-plugin', url: '/plugins/@scope/user-plugin/client.js?rev=abc123', rev: 'abc123', immediately: true },
  ])
})

test('dedupeHostEntries: covered set is O(1) per row and tolerates duplicate covered ids', () => {
  const covered = ['a', 'a', 'b']
  assert.deepEqual(dedupeHostEntries([row('a'), row('b'), row('c')], covered).map(r => r.id), ['c'])
})

test('toExtraRows: injects the per-instance base path into root-relative urls and drops non-root-relative urls', () => {
  const rows = [
    row('@scope/pkg', { inject: ['x'], immediately: true }),
    row('pkg-absolute', { url: 'https://cdn.example/plugins/p/client.js?rev=r', rev: 'r' }),
    row('pkg-protocol-relative', { url: '//cdn.example/plugins/p/client.js?rev=r', rev: 'r' }),
    row('pkg-relative', { url: 'plugins/p/client.js?rev=r', rev: 'r' }),
  ]
  const out: ExtraModuleRow[] = toExtraRows(rows, '/api/i/ssh-42')
  assert.deepEqual(out, [
    { id: '@scope/pkg', url: '/api/i/ssh-42/plugins/@scope/pkg/client.js?rev=abc123', rev: 'abc123' },
  ])
})

test('dedupe + toExtraRows compose into the shell merge (covered rows never leak to preload)', () => {
  const entries = [
    row('@deepseek-ai/dsh-client-ui-sidebar'), // page-own: replaced by the chamber sidebar
    row('@deepseek-ai/dsh-client-modules'), // page-own: kernel adopts it
    row('@deepseek-ai/dsh-client-ui-conversation'), // composite-covered
    row('@deepseek-ai/dsh-client-ui-cordis'), // not covered → extra
  ]
  const covered = ['@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-client-ui-conversation']
  const extras = toExtraRows(dedupeHostEntries(entries, covered), '/api/i/local')
  assert.deepEqual(extras, [
    { id: '@deepseek-ai/dsh-client-ui-cordis', url: '/api/i/local/plugins/@deepseek-ai/dsh-client-ui-cordis/client.js?rev=abc123', rev: 'abc123' },
  ])
})

/** Capture console.error into strings; restore via the returned fn (try/finally). */
function captureConsoleError(): { messages: string[]; restore(): void } {
  const messages: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => { messages.push(args.map(String).join(' ')) }
  return { messages, restore: () => { console.error = original } }
}

test('collectExtraRows: graph channel failure degrades to [] with a console.error', async () => {
  const stub = stubFetch(200, new Error('network down'))
  const consoleCapture = captureConsoleError()
  try {
    let diagnostic: { state: string } | undefined
    const rows = await collectExtraRows('local', '/api/i/local', {
      loadModuleBundle: async () => {},
      reportDiagnostic: (_sourceId, next) => { diagnostic = next },
    })
    assert.deepEqual(rows, [])
    assert.equal(consoleCapture.messages.length, 1)
    assert.match(consoleCapture.messages[0], /instance local host boot-graph fetch failed/)
    assert.match(consoleCapture.messages[0], /network down/)
    assert.equal(diagnostic?.state, 'graph-unreachable')
  } finally {
    stub.restore()
    consoleCapture.restore()
  }
})

test('collectExtraRows: a missing graph endpoint reports not-injected', async () => {
  const stub = stubFetch(404, {})
  const consoleCapture = captureConsoleError()
  let diagnostic: { state: string } | undefined
  try {
    assert.deepEqual(await collectExtraRows('legacy', '/api/i/legacy', {
      loadModuleBundle: async () => {},
      reportDiagnostic: (_sourceId, next) => { diagnostic = next },
    }), [])
    assert.equal(diagnostic?.state, 'not-injected')
  } finally {
    stub.restore()
    consoleCapture.restore()
  }
})

test('collectExtraRows: 503 instance_unavailable retries on the bounded budget, then stays silent and returns []', async () => {
  const stub = stubFetch(503, { code: 'instance_unavailable', error: 'instance not ready' })
  const consoleCapture = captureConsoleError()
  const noSleep = async () => {}
  try {
    assert.deepEqual(await collectExtraRows('local', '/api/i/local', {
      loadModuleBundle: async () => {},
      retry: { attempts: 3, delayMs: 1, sleep: noSleep },
    }), [])
    // The transient pre-ready 503 is retried up to the budget, not one-shot.
    assert.equal(stub.calls.length, 3)
    assert.equal(consoleCapture.messages.length, 0)
  } finally {
    stub.restore()
    consoleCapture.restore()
  }
})

test('collectExtraRows: a 503 that resolves on retry loads the rows (spawn-window race)', async () => {
  // First call answers the pre-ready 503, the retry answers a real graph.
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = (() => {
    calls += 1
    const status = calls === 1 ? 503 : 200
    const body = calls === 1
      ? { code: 'instance_unavailable', error: 'instance not ready' }
      : envelope([row('@scope/race-p1')])
    return Promise.resolve(new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }))
  }) as typeof fetch
  const loaded: string[] = []
  try {
    const rows = await collectExtraRows('local', '/api/i/local', {
      loadModuleBundle: async (url: string) => { loaded.push(url) },
      retry: { attempts: 4, delayMs: 1, sleep: async () => {} },
    })
    assert.equal(calls, 2)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.id, '@scope/race-p1')
    assert.equal(loaded.length, 1)
    assert.ok(loaded[0]!.includes('@scope/race-p1'))
  } finally {
    globalThis.fetch = original
  }
})

test('collectExtraRows: keeps non-covered rows and preloads each once (real covered list)', async () => {
  const stub = stubFetch(200, envelope([
    row('@deepseek-ai/dsh-client-ui-conversation'), // composite-covered → dropped by the merge
    row('@scope/p1'),
    row('@scope/p2'),
  ]))
  const loaded: string[] = []
  try {
    const rows = await collectExtraRows('local', '/api/i/local', { loadModuleBundle: async url => { loaded.push(url) } })
    assert.deepEqual(rows, [
      { id: '@scope/p1', url: '/api/i/local/plugins/@scope/p1/client.js?rev=abc123', rev: 'abc123' },
      { id: '@scope/p2', url: '/api/i/local/plugins/@scope/p2/client.js?rev=abc123', rev: 'abc123' },
    ])
    assert.deepEqual(loaded.sort(), [
      '/api/i/local/plugins/@scope/p1/client.js?rev=abc123',
      '/api/i/local/plugins/@scope/p2/client.js?rev=abc123',
    ])
  } finally {
    stub.restore()
  }
})

test('collectExtraRows: a failing bundle load rejects loud (never degrades)', async () => {
  const stub = stubFetch(200, envelope([row('@scope/bad-plugin')]))
  const loaded: string[] = []
  try {
    let diagnostic: { state: string } | undefined
    await assert.rejects(
      collectExtraRows('local', '/api/i/local', { loadModuleBundle: async url => {
        loaded.push(url)
        throw new Error(`bundle ${url} exploded`)
      }, reportDiagnostic: (_sourceId, next) => { diagnostic = next } }),
      /bundle .* exploded/,
    )
    assert.deepEqual(loaded, ['/api/i/local/plugins/@scope/bad-plugin/client.js?rev=abc123'])
    assert.equal(diagnostic?.state, 'bundle-load-failed')
  } finally {
    stub.restore()
  }
})

test('collectExtraRows: a cross-instance plugin revision conflict requires restart', async () => {
  const id = '@scope/revision-conflict-test'
  let stub = stubFetch(200, envelope([row(id, { rev: 'rev-one' })]))
  try {
    await collectExtraRows('revision-source-one', '/api/i/local', { loadModuleBundle: async () => {} })
  } finally {
    stub.restore()
  }
  stub = stubFetch(200, envelope([row(id, { rev: 'rev-two' })]))
  try {
    let diagnostic: { state: string; pluginId?: string } | undefined
    await collectExtraRows('revision-source-two', '/api/i/ssh-two', {
      loadModuleBundle: async () => {},
      reportDiagnostic: (_sourceId, next) => { diagnostic = next },
    })
    assert.equal(diagnostic?.state, 'restart-required')
    assert.equal(diagnostic?.pluginId, id)
  } finally {
    stub.restore()
  }
})

test('collectExtraRows: a failed preload is NOT marked — a retry re-triggers the loader; success marks once', async () => {
  const stub = stubFetch(200, envelope([row('@scope/retry-plugin')]))
  let calls = 0
  const loadModuleBundle = async (): Promise<void> => {
    calls += 1
    if (calls === 1) throw new Error('first attempt failed')
  }
  try {
    // First boot: the load fails → collectExtraRows rejects (fail loud) and
    // the id must NOT stay marked.
    await assert.rejects(collectExtraRows('local', '/api/i/local', { loadModuleBundle }), /first attempt failed/)
    assert.equal(calls, 1)
    // Retry boot: not permanently marked → the loader runs again and succeeds.
    const rows = await collectExtraRows('local', '/api/i/local', { loadModuleBundle })
    assert.equal(calls, 2)
    assert.deepEqual(rows, [{ id: '@scope/retry-plugin', url: '/api/i/local/plugins/@scope/retry-plugin/client.js?rev=abc123', rev: 'abc123' }])
    // Third boot: marked after the success → the loader is not re-triggered.
    await collectExtraRows('local', '/api/i/local', { loadModuleBundle })
    assert.equal(calls, 2)
  } finally {
    stub.restore()
  }
})

test('collectExtraRows: same id at a different rev reuses the loaded factory and reports restart-required', async () => {
  // Boot 1 preloads revA.
  const stubA = stubFetch(200, envelope([row('@scope/rev-plugin', { rev: 'revA', url: '/plugins/@scope/rev-plugin/client.js?rev=revA' })]))
  const loaded: string[] = []
  try {
    await collectExtraRows('local', '/api/i/local', { loadModuleBundle: async url => { loaded.push(url) } })
    assert.deepEqual(loaded, ['/api/i/local/plugins/@scope/rev-plugin/client.js?rev=revA'])
  } finally {
    stubA.restore()
  }
  // Boot 2 carries the same id at revB: already marked → no second load; the
  // merged row still surfaces revB (the id wins, the rev is informational).
  const stubB = stubFetch(200, envelope([row('@scope/rev-plugin', { rev: 'revB', url: '/plugins/@scope/rev-plugin/client.js?rev=revB' })]))
  try {
    let diagnostic: { state: string } | undefined
    const rows = await collectExtraRows('local', '/api/i/local', {
      loadModuleBundle: async url => { loaded.push(url) },
      reportDiagnostic: (_sourceId, next) => { diagnostic = next },
    })
    assert.deepEqual(rows, [{ id: '@scope/rev-plugin', url: '/api/i/local/plugins/@scope/rev-plugin/client.js?rev=revB', rev: 'revB' }])
    assert.deepEqual(loaded, ['/api/i/local/plugins/@scope/rev-plugin/client.js?rev=revA'])
    assert.equal(diagnostic?.state, 'restart-required')
  } finally {
    stubB.restore()
  }
})

test('collectExtraRows: a duplicate id within one graph preloads once', async () => {
  const stub = stubFetch(200, envelope([row('@scope/dup'), row('@scope/dup')]))
  const loaded: string[] = []
  try {
    const rows = await collectExtraRows('local', '/api/i/local', { loadModuleBundle: async url => { loaded.push(url) } })
    assert.equal(loaded.length, 1)
    assert.equal(rows.length, 2) // both rows still surface as extras (union)
  } finally {
    stub.restore()
  }
})

test('CHAMBER_COVERED_IDS: no duplicates and every id is a legal package name', () => {
  assert.equal(new Set(CHAMBER_COVERED_IDS).size, CHAMBER_COVERED_IDS.length)
  // The module-table key IS the package name: lowercase letters/digits plus
  // -, ., _, ~ per segment, with an optional @scope/ prefix.
  const pkgName = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
  for (const id of CHAMBER_COVERED_IDS) {
    assert.match(id, pkgName, `covered id ${JSON.stringify(id)} is not a legal package name`)
  }
})

test('CHAMBER_COVERED_FACTORY_IDS: no duplicates, legal names, and every factory id is covered (union-table lockstep)', () => {
  // The composite registers a module-table factory per first-screen family
  // (chamber-entry.ts COVERED_FACTORIES, design 09 §3.2). Every such id MUST be
  // in the covered dedupe set: an uncovered id would execute its official
  // bundle as an extra row and double-register against the composite's own
  // factory (chamber-entry asserts the map matches this list exactly at boot —
  // this CI check covers the list against the dedupe set).
  assert.equal(new Set(CHAMBER_COVERED_FACTORY_IDS).size, CHAMBER_COVERED_FACTORY_IDS.length)
  assert.ok(CHAMBER_COVERED_FACTORY_IDS.length > 0, 'factory id contract must not be empty')
  const covered = new Set(CHAMBER_COVERED_IDS)
  const pkgName = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
  for (const id of CHAMBER_COVERED_FACTORY_IDS) {
    assert.match(id, pkgName, `factory id ${JSON.stringify(id)} is not a legal package name`)
    assert.ok(covered.has(id), `factory id ${JSON.stringify(id)} is missing from CHAMBER_COVERED_IDS — add it there (a non-covered factory id would double-register)`)
  }
})

test('Git worktree client is a first-screen covered factory (static composite lockstep)', () => {
  const id = '@dsh-chamber/dsh-client-ui-git'
  assert.ok(CHAMBER_COVERED_IDS.includes(id))
  assert.ok(CHAMBER_COVERED_FACTORY_IDS.includes(id))
})
