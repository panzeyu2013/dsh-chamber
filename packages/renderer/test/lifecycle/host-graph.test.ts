import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectExtraRows, fetchHostGraph, findUnsatisfiableExternalDependencies, normalizeBundleUrl, toExtraRows, type ExtraModuleRow, type HostGraphRow } from '../../src/host-graph.ts'
import {
  BundleLoadTimeoutError, dedupeCoveredRows,
} from '@dsh-chamber/dsh-chamber-client-core/client-plugin-loader'
// The channel-classification single source (audit arch-03 P2-2): the boot
// fetch's expected state/message copy is asserted AGAINST it, never re-spelled.
import {
 classifyPluginGraphOutcome, graphEntryImmediatelyMessage,
} from '@dsh-chamber/dsh-chamber-client-core/plugin-graph-classify'
import { CHAMBER_COVERED_FACTORY_IDS, CHAMBER_COVERED_IDS } from '../../src/chamber-covered.ts'
import { DEFERRED_EXTRA_ROW_IDS } from '../../src/required-extra-rows.ts'
// The kernel-adopted ids are imported BY VALUE from the boot source: KERNEL_ADOPTED_IDS
// keys on them, so a wrong literal in host-graph.ts must fail the behavior test below
// (a text regex over boot-rows.ts would pin spelling, not the coupling).
import { MODULES_ID, UI_RENDERER_ID } from '../../../dsh-client-web/src/boot-rows.ts'
import { normalize, stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

// Extra-bundle URLs are `/plugins/??<id>&rev=…` combos, so the fixture and the
// main-path assertions must pin the combo form.
const row = (id: string, over: Partial<HostGraphRow> = {}): HostGraphRow => ({
  id,
  url: `/plugins/??${id}&rev=abc123`,
  rev: 'abc123',
  ...over,
})

/** Stub globalThis.fetch for one case: records the wire call, body may be an Error, t.after restores it. */
function stubFetch(t: TestContext, status: number, body: unknown): { calls: { url: string; init: RequestInit }[] } {
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
  t.after(() => { globalThis.fetch = original })
  return { calls }
}

/** Install an arbitrary fetch implementation for one test; t.after restores the original. */
function stubFetchImpl(t: TestContext, impl: typeof fetch): void {
  const original = globalThis.fetch
  globalThis.fetch = impl
  t.after(() => { globalThis.fetch = original })
}

const envelope = (entries: unknown) => ({
  rpcId: 'r1',
  result: { ok: true, value: { rev: 'graph-rev', entries } },
})

/** A merged kernel row for `id` under basePath (combo-form url, rev abc123). */
const extra = (id: string, basePath = '/api/i/local', over: Partial<ExtraModuleRow> = {}): ExtraModuleRow => {
  const url = `${basePath}/plugins/??${id}&rev=abc123`
  return { id, url, initialUrl: url, rev: 'abc123', inject: [], external: [], ...over }
}

test('fetchHostGraph: success resolves the entries, carrying optional fields', async (t) => {
  stubFetch(t, 200, envelope([
    row('@scope/pkg-a', { inject: ['@deepseek-ai/dsh-client-store'], immediately: true }),
    row('@deepseek-ai/dsh-client-hmr'),
  ]))
  const rows = await fetchHostGraph('/api/i/local')
  assert.deepEqual(rows, [
    { id: '@scope/pkg-a', url: '/plugins/??@scope/pkg-a&rev=abc123', rev: 'abc123', inject: ['@deepseek-ai/dsh-client-store'], immediately: true },
    { id: '@deepseek-ai/dsh-client-hmr', url: '/plugins/??@deepseek-ai/dsh-client-hmr&rev=abc123', rev: 'abc123' },
  ])
})

test('fetchHostGraph: carries the row `external` requests (BootModuleRow parity)', async (t) => {
  // The wire `external` field must be preserved at parse: an extra row's exact
  // non-inject module requests must reach the merge, since the cases the chamber
  // merge cannot satisfy (a request onto a covered id no registration answers)
  // are otherwise invisible. The unsatisfiable-dependency diagnostic below
  // matches against it.
  stubFetch(t, 200, envelope([
    row('@scope/pkg-ext', { external: ['@deepseek-ai/dsh-client-ui-tool/client', '@deepseek-ai/dsh-client-ui-dockkit'] }),
    row('@scope/pkg-no-ext'),
  ]))
  const rows = await fetchHostGraph('/api/i/local')
  assert.ok(rows !== null, 'a 200 envelope with entries never resolves null')
  assert.deepEqual(rows[0]!.external, [
    '@deepseek-ai/dsh-client-ui-tool/client', '@deepseek-ai/dsh-client-ui-dockkit',
  ])
  assert.equal(rows[1]!.external, undefined, 'an omitted wire field stays omitted')
})

test('fetchHostGraph: a malformed optional field throws (A4: upstream optionalStringArray)', async (t) => {
  // The optional string-array fields are
  // validated by upstream's own helper (manifest.ts `optionalStringArray`), the
  // one its `parseBootManifest` uses for this same wire. A present-but-malformed
  // field therefore fails the fetch LOUD (the boot then degrades to no profile
  // plugins with a named diagnostic) instead of being dropped silently — a
  // silently dropped `external` would erase the unsatisfiable require edges the
  // diagnostic below exists to name.
  for (const bad of [
    { external: ['ok', 7] as unknown as string[] },
    { inject: 'slots' as unknown as string[] },
  ]) {
    stubFetch(t, 200, envelope([row('@scope/pkg-bad', bad)]))
    await assert.rejects(
      () => fetchHostGraph('/api/i/local'),
      /must be a string array/,
      `a malformed ${Object.keys(bad)[0]} must throw, never merge`,
    )
  }
  // A malformed `immediately` is the same class of wire error.
  stubFetch(t, 200, envelope([row('@scope/pkg-bad-flag', { immediately: 'yes' as unknown as boolean })]))
  await assert.rejects(() => fetchHostGraph('/api/i/local'), /immediately/)
})

test('fetchHostGraph: wire call targets the per-instance proxy with a client-request envelope', async (t) => {
  const stub = stubFetch(t, 200, envelope([]))
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
})

test('fetchHostGraph: 503 instance_unavailable resolves null (instance not ready)', async (t) => {
  stubFetch(t, 503, { code: 'instance_unavailable', error: 'instance not ready' })
  assert.equal(await fetchHostGraph('/api/i/local'), null)
})

test('fetchHostGraph: 503 without instance_unavailable throws', async (t) => {
  stubFetch(t, 503, { code: 'other' })
  await assert.rejects(fetchHostGraph('/api/i/local'), /HTTP 503/)
})

test('fetchHostGraph: other non-2xx throws', async (t) => {
  stubFetch(t, 500, {})
  await assert.rejects(fetchHostGraph('/api/i/local'), /HTTP 500/)
})

test('fetchHostGraph: transport failure throws', async (t) => {
  stubFetch(t, 200, new Error('network down'))
  await assert.rejects(fetchHostGraph('/api/i/local'), /宿主启动图不可达：network down/)
})

test('fetchHostGraph: business failure (result.ok false) throws with the host error', async (t) => {
  stubFetch(t, 200, { rpcId: 'r1', result: { ok: false, error: { code: 'boom', message: 'graph exploded' } } })
  await assert.rejects(fetchHostGraph('/api/i/local'), /graph 调用失败：graph exploded/)
})

test('collectExtraRows: an RPC missing-method message reports not-injected even with a generic code', async (t) => {
  stubFetch(t, 200, {
    rpcId: 'r1',
    result: { ok: false, error: { code: 'rpc_failed', message: 'unknown method clientGraph/graph' } },
  })
  captureConsoleError(t)
  let diagnostic: { state: string } | undefined
  assert.deepEqual(await collectExtraRows('legacy-rpc', '/api/i/legacy-rpc', {
    loadModuleBundle: async () => {},
    reportDiagnostic: (_sourceId, next) => { diagnostic = next },
  }), [])
  assert.equal(diagnostic?.state, 'not-injected')
})

test('collectExtraRows: concurrent consumers await one shared bundle load', async (t) => {
  const id = '@scope/concurrent-shared-load'
  stubFetch(t, 200, envelope([row(id)]))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let loads = 0
  const loadModuleBundle = async (): Promise<void> => {
    loads += 1
    await gate
  }
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
})

test('collectExtraRows: a shared concurrent rejection fails every waiter and remains retryable', async (t) => {
  const id = '@scope/concurrent-shared-failure'
  stubFetch(t, 200, envelope([row(id)]))
  let loads = 0
  let shouldFail = true
  const loadModuleBundle = async (): Promise<void> => {
    loads += 1
    if (shouldFail) throw new Error('shared load failed')
  }
  const results = await Promise.allSettled([
    collectExtraRows('failure-a', '/api/i/local', { loadModuleBundle }),
    collectExtraRows('failure-b', '/api/i/ssh-b', { loadModuleBundle }),
  ])
  // The owner's ordinary failure runs its bounded recovery retry (load 2)
  // before failing loud; the shared-load waiter fails loud immediately.
  assert.equal(loads, 2)
  assert.ok(results.every(result => result.status === 'rejected'))
  shouldFail = false
  await collectExtraRows('failure-retry', '/api/i/local', { loadModuleBundle })
  assert.equal(loads, 3)
})

test('collectExtraRows: a timed-out script is not duplicated and a late load converges to success', async (t) => {
  const id = '@scope/late-timeout-tombstone'
  stubFetch(t, 200, envelope([row(id)]))
  let loads = 0
  let settleOutcome!: (loaded: boolean) => void
  const bundleOutcome = new Promise<boolean>(resolve => { settleOutcome = resolve })
  const timeout = new BundleLoadTimeoutError('bundle timed out', bundleOutcome)
  const loadModuleBundle = async (): Promise<void> => {
    loads += 1
    throw timeout
  }
  await assert.rejects(collectExtraRows('timeout-a', '/api/i/local', { loadModuleBundle }), /timed out/)
  await assert.rejects(collectExtraRows('timeout-b', '/api/i/ssh-b', { loadModuleBundle }), /timed out/)
  assert.equal(loads, 1, 'a second source must reuse the tombstone, not execute another URL')
  settleOutcome(true)
  await bundleOutcome
  await new Promise(resolve => setTimeout(resolve, 0))
  await collectExtraRows('timeout-recovered', '/api/i/local', { loadModuleBundle })
  assert.equal(loads, 1, 'the late script registered the factory; recovery must reuse it')
})

test('collectExtraRows: a timed-out script that later errors becomes retryable', async (t) => {
  const id = '@scope/late-timeout-error'
  stubFetch(t, 200, envelope([row(id)]))
  let loads = 0
  let settleOutcome!: (loaded: boolean) => void
  const bundleOutcome = new Promise<boolean>(resolve => { settleOutcome = resolve })
  const timeout = new BundleLoadTimeoutError('bundle timed out', bundleOutcome)
  const loadModuleBundle = async (): Promise<void> => {
    loads += 1
    if (loads === 1) throw timeout
  }
  await assert.rejects(collectExtraRows('timeout-error-a', '/api/i/local', { loadModuleBundle }), /timed out/)
  settleOutcome(false)
  await bundleOutcome
  await new Promise(resolve => setTimeout(resolve, 0))
  await collectExtraRows('timeout-error-retry', '/api/i/local', { loadModuleBundle })
  assert.equal(loads, 2)
})

test('fetchHostGraph: malformed envelope/rows throw loud (never silently merged)', async (t) => {
  const cases: { status: number; body: unknown; match: RegExp }[] = [
    { status: 200, body: 'not-json', match: /envelope 不是合法 JSON/ },
    { status: 200, body: { rpcId: 'r1' }, match: /envelope 缺少 result/ },
    { status: 200, body: envelope('not-an-array'), match: /result.value.entries 必须是数组/ },
    { status: 200, body: envelope([row('a', { rev: 7 as unknown as string })]), match: /必须携带 string id\/url\/rev/ },
    { status: 200, body: envelope([42]), match: /entry 不是对象/ },
  ]
  for (const c of cases) {
    stubFetch(t, c.status, c.body)
    await assert.rejects(fetchHostGraph('/api/i/local'), c.match)
  }
})

test('fetchHostGraph: every channel verdict equals the shared classifier single source', async (t) => {
  // The boot fetch and client-core's recheck must answer the same wire question
  // identically (audit arch-03 P2-2). For every branch, the thrown error's
  // message/state is compared with the shared classifier's verdict verbatim; a
  // local re-spelling or a re-grown status branch fails this test.
  const cases: { status: number; body: unknown }[] = [
    { status: 404, body: {} },
    { status: 500, body: {} },
    { status: 200, body: { rpcId: 'r1', result: { ok: false, error: { code: 'boom', message: 'graph exploded' } } } },
    { status: 200, body: { rpcId: 'r1', result: { ok: false, error: { code: 'rpc_failed', message: 'unknown method clientGraph/graph' } } } },
    { status: 200, body: { rpcId: 'r1' } },
    { status: 200, body: envelope('not-an-array') },
    { status: 200, body: envelope([42]) },
    { status: 200, body: envelope([{ id: 'x', url: '/plugins/x' }]) },
  ]
  let current = cases[0]!
  stubFetchImpl(t, (async () => new Response(JSON.stringify(current.body), {
    status: current.status,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch)
  for (const c of cases) {
    current = c
    const verdict = classifyPluginGraphOutcome({
      status: c.status,
      ok: c.status >= 200 && c.status < 300,
      body: c.status === 200 ? c.body : undefined,
      jsonError: undefined,
    })
    assert.ok(verdict.kind === 'channel' || verdict.kind === 'malformed', JSON.stringify(c))
    const expectedMessage = verdict.message
    const expectedState = verdict.kind === 'channel' ? verdict.state : undefined
    await assert.rejects(fetchHostGraph('/api/i/local'), (error: unknown) => {
      const thrown = error as Error & { diagnosticState?: string }
      assert.equal(thrown.message, expectedMessage, JSON.stringify(c))
      if (expectedState !== undefined) {
        assert.equal(thrown.diagnosticState, expectedState, JSON.stringify(c))
      }
      return true
    })
  }
  // The renderer-only optional-field gate takes its copy from the same source.
  current = { status: 200, body: envelope([row('@scope/bad-flag', { immediately: 'yes' as unknown as boolean })]) }
  await assert.rejects(fetchHostGraph('/api/i/local'), (error: unknown) => {
    assert.equal((error as Error).message, graphEntryImmediatelyMessage({ id: '@scope/bad-flag' }))
    return true
  })
  // The pre-ready 503 probe stays null — no channel classification is thrown.
  current = { status: 503, body: { code: 'instance_unavailable' } }
  assert.equal(await fetchHostGraph('/api/i/local'), null)
})
test('dedupeCoveredRows: drops covered ids, keeps extras, preserves optional fields', () => {
  const covered = ['@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-session']
  const entries = [
    row('@deepseek-ai/dsh-client-ui-sidebar'),
    row('@deepseek-ai/dsh-client-ui-session'),
    row('@scope/user-plugin', { immediately: true }),
  ]
  assert.deepEqual(dedupeCoveredRows(entries, covered), [
    { id: '@scope/user-plugin', url: '/plugins/??@scope/user-plugin&rev=abc123', rev: 'abc123', immediately: true },
  ])
})

test('dedupeCoveredRows: covered set is O(1) per row and tolerates duplicate covered ids', () => {
  const covered = ['a', 'a', 'b']
  assert.deepEqual(dedupeCoveredRows([row('a'), row('b'), row('c')], covered).map(r => r.id), ['c'])
})

test('toExtraRows: normalizes root-relative and document-relative bundle urls, drops unsafe ones', () => {
  const rows = [
    row('@scope/pkg', { inject: ['x'], immediately: true }),
    row('pkg-absolute', { url: 'https://cdn.example/plugins/p/client.js?rev=r', rev: 'r' }),
    row('pkg-protocol-relative', { url: '//cdn.example/plugins/p/client.js?rev=r', rev: 'r' }),
    row('pkg-relative', { url: 'plugins/p/client.js?rev=r', rev: 'r' }),
    row('pkg-traversal', { url: '../../outside/p.js', rev: 'r' }),
    row('pkg-doc-combo', { url: 'plugins/??a.js,b.js&rev=r', rev: 'r' }),
  ]
  const out: ExtraModuleRow[] = toExtraRows(rows, '/api/i/ssh-42')
  assert.deepEqual(out.map((r) => r.id), ['@scope/pkg', 'pkg-relative', 'pkg-doc-combo'])
  assert.equal(out[0].url, '/api/i/ssh-42/plugins/??@scope/pkg&rev=abc123')
  // 0.1.7：document-relative 行必须归一进实例前缀（此前被整行丢弃 = 实例丢光 profile 插件）
  assert.equal(out[1].url, '/api/i/ssh-42/plugins/p/client.js?rev=r')
  assert.equal(out[2].url, '/api/i/ssh-42/plugins/??a.js,b.js&rev=r', 'combo 语法原样随行')
})

test('normalizeBundleUrl: 两种相对形态都接，scheme/协议相对/穿越/反斜杠一律拒', () => {
  assert.equal(normalizeBundleUrl('/plugins/p/x.js?rev=r', '/api/i/one'), '/api/i/one/plugins/p/x.js?rev=r')
  assert.equal(normalizeBundleUrl('plugins/p/x.js?rev=r', '/api/i/one'), '/api/i/one/plugins/p/x.js?rev=r')
  assert.equal(normalizeBundleUrl('https://evil/x.js', '/api/i/one'), null)
  assert.equal(normalizeBundleUrl('//evil/x.js', '/api/i/one'), null)
  assert.equal(normalizeBundleUrl('data:text/javascript,1', '/api/i/one'), null)
  assert.equal(normalizeBundleUrl('../../x.js', '/api/i/one'), null)
  assert.equal(normalizeBundleUrl('a/../../x.js', '/api/i/one'), null)
  assert.equal(normalizeBundleUrl('plugins\\p\\x.js', '/api/i/one'), null)
  assert.equal(normalizeBundleUrl('', '/api/i/one'), null)
})

test('toExtraRows: passes `external` through to the kernel row (never dropped, never invented)', () => {
  // The kernel row type (BootModuleRow) carries `external` as a
  // required array; the merge mirrors it exactly — the parsed requests when the
  // wire had them, [] when it did not.
  const out = toExtraRows([
    row('@scope/ext', { external: ['@deepseek-ai/dsh-client-ui-tool/client'] }),
    row('@scope/no-ext'),
    // A poisoned host graph must not steer the loader off-origin: the row is
    // still dropped whole, external or not.
    row('@scope/bad-url', { url: 'https://cdn.example/plugins/p.js', external: ['x'] }),
  ], '/api/i/local')
  assert.deepEqual(out, [
    extra('@scope/ext', '/api/i/local', { external: ['@deepseek-ai/dsh-client-ui-tool/client'] }),
    extra('@scope/no-ext'),
  ])
})

test('findUnsatisfiableExternalDependencies: names covered requires no registration answers', () => {
  // Covered rows are filtered out of the host graph, so the module table is the
  // only possible source — and it answers the composite's first-screen factories
  // plus the two kernel-adopted ids, NOTHING else covered: the deliberate skips
  // are never loaded, the deferred families are mounted via `ctx.plugin` but
  // never registered, and page-own / replaced official rows register nothing.
  // Not a timing distinction: those requires miss at create AND later.
  const deferredId = DEFERRED_EXTRA_ROW_IDS[0]!
  const otherDeferredId = DEFERRED_EXTRA_ROW_IDS[1]!
  const coveredFactoryId = CHAMBER_COVERED_FACTORY_IDS[0]!
  const skipId = '@deepseek-ai/dsh-client-ui-settings-account'
  const kernelAdoptedId = UI_RENDERER_ID
  assert.ok(CHAMBER_COVERED_IDS.includes(skipId), 'the fixture skip is a covered id')
  assert.ok(!CHAMBER_COVERED_FACTORY_IDS.includes(skipId), 'the fixture skip has no factory')
  assert.ok(CHAMBER_COVERED_IDS.includes(kernelAdoptedId), 'the kernel-adopted id is a covered id')
  assert.ok(!CHAMBER_COVERED_FACTORY_IDS.includes(kernelAdoptedId), 'and has no composite factory')
  const rows: ExtraModuleRow[] = [
    {
      id: 'a', url: '/plugins/a', initialUrl: '/plugins/a', rev: 'r', inject: [],
      // The `/client` subpath form (upstream stripClientSuffix) and the bare id are
      // the SAME dependency: reported once, stripped. A first-screen factory and a
      // kernel-adopted id are satisfied; the kept peer is outside the judged domain.
      external: [
        `${deferredId}/client`, deferredId, `${coveredFactoryId}/client`, `${skipId}/client`,
        `${kernelAdoptedId}/client`, '@scope/kept-peer',
      ],
    },
    {
      id: 'b', url: '/plugins/b', initialUrl: '/plugins/b', rev: 'r', inject: [],
      external: [otherDeferredId, MODULES_ID],
    },
    { id: 'c', url: '/plugins/c', initialUrl: '/plugins/c', rev: 'r', inject: [], external: [] },
  ]
  assert.deepEqual(findUnsatisfiableExternalDependencies(rows), [
    { rowId: 'a', dependencies: [deferredId, skipId] },
    { rowId: 'b', dependencies: [otherDeferredId] },
  ])
  assert.ok(!CHAMBER_COVERED_FACTORY_IDS.includes(deferredId), 'a deferred id must NOT be a registered factory')
})

test('the kernel-adopted id set stays lockstep with boot-rows.ts / boot.ts (the predicate keys on it)', () => {
  // findUnsatisfiableExternalDependencies treats `dsh-client-modules` and
  // `dsh-client-ui-renderer` as resolvable because the boot kernel registers both
  // BEFORE any extra row runs. If that registration or the id constants move, the
  // predicate would report a satisfiable require as `bundle-load-failed`.
  assert.equal(MODULES_ID, '@deepseek-ai/dsh-client-modules', 'the imported constant is the id the predicate names')
  assert.equal(UI_RENDERER_ID, '@deepseek-ai/dsh-client-ui-renderer')
  const root = join(import.meta.dirname, '..', '..', '..', '..')
  const boot = stripComments(readFileSync(join(root, 'packages/dsh-client-web/src/boot.ts'), 'utf8'))
  // The registration SET, not just presence: a third `target.load` would adopt
  // another row and invalidate the predicate until KERNEL_ADOPTED_IDS grows too.
  // Tolerant of whitespace/extra keys after `id`: a third registration must not slip
// past merely because its options line reformatted.
const registered = [...boot.matchAll(/target\.load\(\{\s*id:\s*(\w+)/g)].map(match => match[1]!)
  assert.deepEqual(
    [...new Set(registered)].sort(),
    ['MODULES_ID', 'UI_RENDERER_ID'],
    'the kernel adopts exactly these two rows',
  )
  for (const constant of ['MODULES_ID', 'UI_RENDERER_ID']) {
    assert.match(boot, new RegExp(`registration\\.id === ${constant}`), `${constant} presence check`)
  }
})

test('no platform seed word is a covered id without a composite factory (predicate safety)', () => {
  // The kernel resolves seed words BEFORE registered factories, so a seed word that
  // is covered but NOT factory-answered would still resolve — the predicate must
  // never name it. Today the only covered seed word (`dsh-client-store`) has a
  // factory; this pins that no future platform word lands in the gap.
  const root = join(import.meta.dirname, '..', '..', '..', '..')
  const platform = stripComments(readFileSync(join(root, 'packages/dsh-client-web/src/platform.ts'), 'utf8'))
  const words = [...platform.matchAll(/'([^']+)'/g)].map(match => match[1]!)
  assert.ok(words.length > 0, 'platform seed words extracted from the pinned source')
  const covered = new Set(CHAMBER_COVERED_IDS)
  const factories = new Set(CHAMBER_COVERED_FACTORY_IDS)
  assert.deepEqual(
    words.filter(word => covered.has(word) && !factories.has(word)),
    [],
    'a covered seed word without a factory would resolve through the seed, not the module table',
  )
})

test('collectExtraRows: a require onto a skipped covered id is named with the real reason', async (t) => {
  const id = '@scope/f1-needs-account-skip'
  const skipId = '@deepseek-ai/dsh-client-ui-settings-account'
  stubFetch(t, 200, envelope([row(id, { external: [`${skipId}/client`] })]))
  const consoleCapture = captureConsoleError(t)
  const diagnostics: { state: string; pluginId?: string; message?: string }[] = []
  await collectExtraRows('local', '/api/i/local', {
    loadModuleBundle: async () => {},
    reportDiagnostic: (_sourceId, next) => { diagnostics.push(next) },
  })
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0]!.state, 'bundle-load-failed')
  assert.equal(diagnostics[0]!.pluginId, id)
  assert.match(diagnostics[0]!.message ?? '', new RegExp(`${id} → ${skipId}`), 'the row→id edge is named')
  assert.match(diagnostics[0]!.message ?? '', /任何时刻都拿不到/)
  assert.doesNotMatch(diagnostics[0]!.message ?? '', /延迟注册者|永不加载\)/, 'no non-existent timing claim')
  assert.match(consoleCapture.messages.join('\n'), /settings-account/)
})

test('collectExtraRows: an `external` request onto a deferred family id reports the NAMED diagnostic', async (t) => {
  const id = '@scope/f1-needs-deferred-tool'
  stubFetch(t, 200, envelope([
    row(id, { external: ['@deepseek-ai/dsh-client-ui-tool/client'] }),
  ]))
  const consoleCapture = captureConsoleError(t)
  const diagnostics: { state: string; pluginId?: string; message?: string }[] = []
  const rows = await collectExtraRows('local', '/api/i/local', {
    loadModuleBundle: async () => {},
    reportDiagnostic: (_sourceId, next) => { diagnostics.push(next) },
  })
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0]!.external, ['@deepseek-ai/dsh-client-ui-tool/client'], 'the field survives the merge')
  // Not the silent 'ok': the page-level diagnostic names the row and the
  // dependency this boot can never satisfy (bundle-load-failed is the only
  // "this row cannot materialize" state in the shared diagnostic union, and
  // it is a boot fact — a channel recheck must never heal it away).
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0]!.state, 'bundle-load-failed')
  assert.equal(diagnostics[0]!.pluginId, id)
  assert.match(diagnostics[0]!.message ?? '', /@deepseek-ai\/dsh-client-ui-tool/)
  // The deferred cluster is NOT "late": its chunk is mounted with `ctx.plugin` and
  // never registers a module-table factory, so the require misses at every moment —
  // the copy must not claim a delayed registration that never happens.
  assert.match(diagnostics[0]!.message ?? '', /任何时刻都拿不到/)
  assert.match(diagnostics[0]!.message ?? '', /ctx\.plugin/)
  assert.doesNotMatch(diagnostics[0]!.message ?? '', /延迟注册者|boot 之后|永不加载\)/)
  // The copy must NAME the ids it means: dropping the interpolation would leave a
  // message that still reads plausibly while pointing at nothing.
  assert.match(
    diagnostics[0]!.message ?? '',
    new RegExp(MODULES_ID + ' / ' + UI_RENDERER_ID),
    'the copy interpolates both kernel-adopted ids',
  )
  // The console line is the operator's copy of the same fact — never the
  // ONLY channel (the diagnostic above is the durable one).
  assert.match(consoleCapture.messages.join('\n'), /@scope\/f1-needs-deferred-tool/)
  assert.match(consoleCapture.messages.join('\n'), /@deepseek-ai\/dsh-client-ui-tool/)
})

test('collectExtraRows: external edges this page CAN satisfy stay unflagged (diagnostic ok)', async (t) => {
  // A first-screen covered id (the composite registers its factory before any
  // row materializes) and a kept peer extra (preloaded by this very call) are
  // both resolvable — no diagnostic, no console noise.
  const peerId = '@scope/f1-kept-peer'
  const consumerId = '@scope/f1-kept-consumer'
  stubFetch(t, 200, envelope([
    row(consumerId, { external: [`${CHAMBER_COVERED_FACTORY_IDS[0]!}/client`, peerId] }),
    row(peerId),
  ]))
  const consoleCapture = captureConsoleError(t)
  const diagnostics: { state: string }[] = []
  const rows = await collectExtraRows('local', '/api/i/local', {
    loadModuleBundle: async () => {},
    reportDiagnostic: (_sourceId, next) => { diagnostics.push(next) },
  })
  assert.equal(rows.length, 2)
  assert.deepEqual(diagnostics.map(diagnostic => diagnostic.state), ['ok'])
  assert.deepEqual(consoleCapture.messages, [])
})

test('dedupe + toExtraRows compose into the shell merge (covered rows never leak to preload)', () => {
  const entries = [
    row('@deepseek-ai/dsh-client-ui-sidebar'), // page-own: replaced by the chamber sidebar
    row('@deepseek-ai/dsh-client-modules'), // page-own: kernel adopts it
    row('@deepseek-ai/dsh-client-ui-conversation'), // composite-covered
    row('@deepseek-ai/dsh-client-ui-cordis'), // not covered → extra
  ]
  const covered = ['@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-client-ui-conversation']
  const extras = toExtraRows(dedupeCoveredRows(entries, covered), '/api/i/local')
  assert.deepEqual(extras, [extra('@deepseek-ai/dsh-client-ui-cordis')])
})

/** Capture console.error into strings for one test; t.after restores it. */
function captureConsoleError(t: TestContext): { messages: string[] } {
  const messages: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => { messages.push(args.map(String).join(' ')) }
  t.after(() => { console.error = original })
  return { messages }
}

test('collectExtraRows: graph channel failure degrades to [] with a console.error', async (t) => {
  stubFetch(t, 200, new Error('network down'))
  const consoleCapture = captureConsoleError(t)
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
})

test('collectExtraRows: a missing graph endpoint reports not-injected', async (t) => {
  stubFetch(t, 404, {})
  captureConsoleError(t)
  let diagnostic: { state: string } | undefined
  assert.deepEqual(await collectExtraRows('legacy', '/api/i/legacy', {
    loadModuleBundle: async () => {},
    reportDiagnostic: (_sourceId, next) => { diagnostic = next },
  }), [])
  assert.equal(diagnostic?.state, 'not-injected')
})

test('collectExtraRows: a local 404 is a chamber-side gap; a remote 404 keeps the no-graph exemption (FIX 6)', async (t) => {
  // The chamber-managed local host always injects its client graph (seed row):
  // a 404 / method-missing answer on `local` is an installation/seed fact, so it
  // must reach the App with its OWN kind and the self-heal. A remote/gateway
  // source may legitimately serve no graph at all — its 404 stays fact-free.
  const localGaps: { message: string; kind: string }[] = []
  stubFetch(t, 404, {})
  captureConsoleError(t)
  assert.deepEqual(await collectExtraRows('local', '/api/i/local', {
    loadModuleBundle: async () => {},
    onGraphUnavailable: (message, kind) => localGaps.push({ message, kind }),
  }), [])
  assert.equal(localGaps.length, 1, 'the local 404 must not stay silent any more')
  assert.equal(localGaps[0]!.kind, 'local-graph-not-injected')
  assert.match(localGaps[0]!.message, /no profile client plugins/)
  // Same for the envelope's "unknown method" classification (not only HTTP 404).
  const methodGaps: string[] = []
  stubFetch(t, 200, {
    rpcId: 'r1',
    result: { ok: false, error: { code: 'rpc_failed', message: 'unknown method clientGraph/graph' } },
  })
  captureConsoleError(t)
  assert.deepEqual(await collectExtraRows('local', '/api/i/local', {
    loadModuleBundle: async () => {},
    onGraphUnavailable: (_message, kind) => methodGaps.push(kind),
  }), [])
  assert.deepEqual(methodGaps, ['local-graph-not-injected'])
  const remoteGaps: string[] = []
  stubFetch(t, 404, {})
  captureConsoleError(t)
  assert.deepEqual(await collectExtraRows('ssh-remote', '/api/i/ssh-remote', {
    loadModuleBundle: async () => {},
    onGraphUnavailable: (message) => remoteGaps.push(message),
  }), [])
  assert.deepEqual(remoteGaps, [], 'a remote 404 is the legitimate no-endpoint shape — never a degrade')
})

test('collectExtraRows: an exhausted 503 budget names itself, publishes the diagnostic and returns []', async (t) => {
  // Degrading in TOTAL silence leaves the operator seeing nothing, the
  // connections page still saying 正常, and the App with no fact to self-heal
  // from. A source that only needs longer is recoverable; a source that never
  // serves is at least visible.
  const stub = stubFetch(t, 503, { code: 'instance_unavailable', error: 'instance not ready' })
  const consoleCapture = captureConsoleError(t)
  const noSleep = async () => {}
  const diagnostics: { sourceId: string; state: string }[] = []
  const unavailable: string[] = []
  const gapKinds: string[] = []
  assert.deepEqual(await collectExtraRows('local', '/api/i/local', {
    loadModuleBundle: async () => {},
    retry: { attempts: 3, delayMs: 1, sleep: noSleep },
    reportDiagnostic: (sourceId, diagnostic) => diagnostics.push({ sourceId, state: diagnostic.state }),
    onGraphUnavailable: (message, kind) => { unavailable.push(message); gapKinds.push(kind) },
  }), [])
  // The transient pre-ready 503 is retried up to the budget, not one-shot.
  assert.equal(stub.calls.length, 3)
  assert.equal(consoleCapture.messages.length, 1)
  assert.match(consoleCapture.messages[0], /boot-graph unavailable/)
  assert.deepEqual(diagnostics, [{ sourceId: 'local', state: 'graph-unreachable' }])
  assert.equal(unavailable.length, 1)
  assert.match(unavailable[0], /no profile client plugins/)
  // The 503 exhaustion is a channel failure, never the local-404 kind.
  assert.deepEqual(gapKinds, ['graph-unavailable'])
})

test('collectExtraRows: a slow source is waited for, then served on a fresh budget (2026-09-10)', async (t) => {
  // Cold local start / restart-straddled attach: the 503 budget alone is far
  // shorter than the spawn, so the boot would lose its whole profile
  // client-plugin set (ui-chat pends on sidebarRight → no conversation view).
  let calls = 0
  stubFetchImpl(t, (() => {
    calls += 1
    // 1..2: still starting (exhausts the 2-attempt budget); 3: after the wait.
    const starting = calls <= 2
    const body = starting
      ? { code: 'instance_unavailable', error: 'instance not ready' }
      : envelope([row('@scope/slow-p1')])
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: starting ? 503 : 200,
      headers: { 'content-type': 'application/json' },
    }))
  }) as typeof fetch)
  const waits: string[] = []
  const rows = await collectExtraRows('local', '/api/i/local', {
    loadModuleBundle: async () => {},
    retry: { attempts: 2, delayMs: 1, sleep: async () => {} },
    waitForServing: async (instanceId) => { waits.push(instanceId); return true },
  })
  assert.deepEqual(rows.map(entry => entry.id), ['@scope/slow-p1'])
  assert.deepEqual(waits, ['local'], 'the gate is asked exactly once before the fresh budget')
  assert.ok(calls >= 3, 'the fetch runs again after the source started serving')
})

test('collectExtraRows: a gate that never sees the source serve ends degraded (no infinite wait)', async (t) => {
  stubFetch(t, 503, { code: 'instance_unavailable', error: 'instance not ready' })
  const unavailable: string[] = []
  const rows = await collectExtraRows('local', '/api/i/local', {
    loadModuleBundle: async () => {},
    retry: { attempts: 2, delayMs: 1, sleep: async () => {} },
    waitForServing: async () => false,
    onGraphUnavailable: (message) => unavailable.push(message),
  })
  assert.deepEqual(rows, [])
  assert.equal(unavailable.length, 1)
})

test('collectExtraRows: a REMOTE 404 endpoint (no graph injected) stays a documented non-degrade', async (t) => {
  // The gateway/mobile shape legitimately runs without the graph — that is not
  // a degrade, and the App must NOT be asked to re-boot for it. This boundary is
  // the 404 shape ONLY: every other channel failure reports the degrade fact,
  // because that mount ships a plugin-less shell whose only explanation would be
  // a diagnostic rendered by the packages this very boot failed to load (see the
  // sibling test below).
  // The exemption is REMOTE-only — the chamber-managed local
  // instance's 404 is its own local-graph-not-injected fact, owned by the
  // sibling test below through the same onGraphUnavailable seam.
  stubFetch(t, 404, { code: 'not_found', error: 'unknown method' })
  const unavailable: string[] = []
  captureConsoleError(t)
  assert.deepEqual(await collectExtraRows('gateway-test-404', '/api/i/gateway-test-404', {
    loadModuleBundle: async () => {},
    retry: { attempts: 2, delayMs: 1, sleep: async () => {} },
    onGraphUnavailable: (message) => unavailable.push(message),
  }), [])
  assert.deepEqual(unavailable, [], 'a remote missing graph endpoint is not a serving degrade')
})

test('collectExtraRows: a local 404 surfaces the local-graph-not-injected gap through the seam (FIX 6)', async (t) => {
  // Same 404 wire answer as the REMOTE case above — only the SOURCE differs.
  // The chamber-managed local host always injects its client graph (seed row),
  // so a 404 / method-missing answer on 'local' is a chamber-side
  // installation/seed fact: it must reach the App as local-graph-not-injected
  // through the SAME onGraphUnavailable(message, kind) seam every degrade kind
  // uses (the App mirrors that fact into the boot-gap banner and the
  // self-heal), while the connections-page diagnostic stays the raw channel
  // classification.
  stubFetch(t, 404, { code: 'not_found', error: 'unknown method' })
  captureConsoleError(t)
  const gaps: { message: string; kind: string }[] = []
  const diagnostics: { state: string }[] = []
  assert.deepEqual(await collectExtraRows('local', '/api/i/local', {
    loadModuleBundle: async () => {},
    retry: { attempts: 2, delayMs: 1, sleep: async () => {} },
    reportDiagnostic: (_sourceId, diagnostic) => { diagnostics.push({ state: diagnostic.state }) },
    onGraphUnavailable: (message, kind) => gaps.push({ message, kind }),
  }), [])
  assert.deepEqual(gaps.map(gap => gap.kind), ['local-graph-not-injected'])
  assert.match(gaps[0]!.message, /did not answer its client plugin graph request/)
  assert.match(gaps[0]!.message, /404/)
  assert.deepEqual(diagnostics, [{ state: 'not-injected' }])
})

test('collectExtraRows: a 502/504 channel failure reports the App-facing degrade fact (W3)', async (t) => {
  // 隧道活着而远端 dsh 端口死了：本轮挂载缺掉整套 profile 客户端插件，只发一条
  // "由没被加载的包渲染"的诊断会让用户侧零解释。通道失败（非 404）必须上浮
  // onGraphUnavailable，让 App 的 boot-gap 横幅说得出话。
  stubFetch(t, 502, { code: 'upstream_failed', error: 'upstream request failed' })
  captureConsoleError(t)
  const unavailable: string[] = []
  const diagnostics: { state: string }[] = []
  assert.deepEqual(await collectExtraRows('local', '/api/i/local', {
    loadModuleBundle: async () => {},
    retry: { attempts: 2, delayMs: 1, sleep: async () => {} },
    reportDiagnostic: (_sourceId, diagnostic) => { diagnostics.push({ state: diagnostic.state }) },
    onGraphUnavailable: (message) => unavailable.push(message),
  }), [])
  assert.equal(unavailable.length, 1, 'a 502 must reach the App as a degrade fact')
  assert.match(unavailable[0], /did not answer its client plugin graph request/)
  assert.match(unavailable[0], /502/)
  assert.deepEqual(diagnostics, [{ state: 'graph-unreachable' }])
})

test('collectExtraRows: a 503 that resolves on retry loads the rows (spawn-window race)', async (t) => {
  // First call answers the pre-ready 503, the retry answers a real graph.
  let calls = 0
  stubFetchImpl(t, (() => {
    calls += 1
    const status = calls === 1 ? 503 : 200
    const body = calls === 1
      ? { code: 'instance_unavailable', error: 'instance not ready' }
      : envelope([row('@scope/race-p1')])
    return Promise.resolve(new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }))
  }) as typeof fetch)
  const loaded: string[] = []
  const rows = await collectExtraRows('local', '/api/i/local', {
    loadModuleBundle: async (url: string) => { loaded.push(url) },
    retry: { attempts: 4, delayMs: 1, sleep: async () => {} },
  })
  assert.equal(calls, 2)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.id, '@scope/race-p1')
  assert.equal(loaded.length, 1)
  assert.ok(loaded[0]!.includes('@scope/race-p1'))
})

test('collectExtraRows: keeps non-covered rows and preloads each once (real covered list)', async (t) => {
  stubFetch(t, 200, envelope([
    row('@deepseek-ai/dsh-client-ui-conversation'), // composite-covered → dropped by the merge
    row('@deepseek-ai/dsh-client-hmr'), // page-own covered → dropped: its document-relative EventSource would hit the control-plane origin (SPA fallback text/html); the host route is consumed by the chamber's own instance-prefixed subscriber instead
    row('@scope/p1'),
    row('@scope/p2'),
  ]))
  const loaded: string[] = []
  const rows = await collectExtraRows('local', '/api/i/local', { loadModuleBundle: async url => { loaded.push(url) } })
  assert.deepEqual(rows, [extra('@scope/p1'), extra('@scope/p2')])
  assert.deepEqual(loaded.sort(), [
    '/api/i/local/plugins/??@scope/p1&rev=abc123',
    '/api/i/local/plugins/??@scope/p2&rev=abc123',
  ])
})

test('collectExtraRows: a bundle load failing BOTH attempts rejects loud (never degrades)', async (t) => {
  stubFetch(t, 200, envelope([row('@scope/bad-plugin')]))
  const loaded: string[] = []
  let diagnostic: { state: string } | undefined
  await assert.rejects(
    collectExtraRows('local', '/api/i/local', { loadModuleBundle: async url => {
      loaded.push(url)
      throw new Error(`bundle ${url} exploded`)
    }, reportDiagnostic: (_sourceId, next) => { diagnostic = next } }),
    /bundle .* exploded/)
  // One bounded recovery cycle: the refetched graph carries the same rev
  // (no restart), the retried load fails identically, and the boot fails
  // loud — a broken plugin never silently disappears.
  assert.deepEqual(loaded, [
    '/api/i/local/plugins/??@scope/bad-plugin&rev=abc123',
    '/api/i/local/plugins/??@scope/bad-plugin&rev=abc123',
  ])
  assert.equal(diagnostic?.state, 'bundle-load-failed')
})

test('collectExtraRows: a bundle rewritten between fetch and load recovers — stale-rev failures reload at the fresh graph rev', async (t) => {
  // A bundle rev derives from the file's filesystem metadata
  // (dsh-client-modules `artifactRevision` = sha1(mtimeMs, ctimeMs, size)): an
  // untouched bundle keeps its rev across host restarts, while a rebuild or
  // replacement between the graph fetch and the bundle loads 404s every
  // not-yet-loaded row on its stale rev. The bounded recovery pass re-fetches
  // the graph and reloads the failed row at the fresh rev, so the boot proceeds
  // instead of failing loud.
  const id = '@scope/restart-straddle'
  let calls = 0
  stubFetchImpl(t, (() => {
    calls += 1
    const rev = calls === 1 ? 'stale-rev' : 'fresh-rev'
    const body = envelope([row(id, { rev, url: `/plugins/??${id}&rev=${rev}` })])
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  }) as typeof fetch)
  const loaded: string[] = []
  let diagnostic: { state: string } | undefined
  const rows = await collectExtraRows('local', '/api/i/local', {
    loadModuleBundle: async url => {
      if (url.includes('stale-rev')) throw new Error(`stale rev bundle 404: ${url}`)
      loaded.push(url)
    },
    reportDiagnostic: (_sourceId, next) => { diagnostic = next },
  })
  assert.equal(calls, 2, 'one bounded recovery refetch, no more')
  assert.deepEqual(loaded, [`/api/i/local/plugins/??${id}&rev=fresh-rev`])
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.rev, 'fresh-rev')
  assert.equal(diagnostic?.state, 'ok')
})

test('collectExtraRows: a recovery-refetch channel failure keeps the original bundle failure loud', async (t) => {
  const id = '@scope/recovery-channel-down'
  let calls = 0
  stubFetchImpl(t, (() => {
    calls += 1
    if (calls === 1) {
      return Promise.resolve(new Response(JSON.stringify(envelope([row(id)])), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    }
    return Promise.reject(new Error('network down on refetch'))
  }) as typeof fetch)
  let diagnostic: { state: string; pluginId?: string } | undefined
  await assert.rejects(
    collectExtraRows('local', '/api/i/local', {
      loadModuleBundle: async () => { throw new Error('bundle exploded') },
      reportDiagnostic: (_sourceId, next) => { diagnostic = next },
    }),
    /bundle exploded/)
  assert.equal(calls, 2)
  assert.equal(diagnostic?.state, 'bundle-load-failed')
  assert.equal(diagnostic?.pluginId, id)
})

test('collectExtraRows: a cross-instance plugin revision conflict reports instance-version-conflict (version drift, not a restart)', async (t) => {
  const id = '@scope/revision-conflict-test'
  stubFetch(t, 200, envelope([row(id, { rev: 'rev-one' })]))
  await collectExtraRows('revision-source-one', '/api/i/local', { loadModuleBundle: async () => {} })
  stubFetch(t, 200, envelope([row(id, { rev: 'rev-two' })]))
  let diagnostic: { state: string; pluginId?: string; message?: string } | undefined
  await collectExtraRows('revision-source-two', '/api/i/ssh-two', {
    loadModuleBundle: async () => {},
    reportDiagnostic: (_sourceId, next) => { diagnostic = next },
  })
  // A DIFFERENT instance owns the id at another rev: no app restart can
  // switch the loaded factory — the honest diagnostic names the owner
  // instance and the OBSERVABLE rev/build-artifact difference (never a version
  // claim: a same-version plugin still differs across hosts by build metadata —
  // measured 11 bytes in the bundle's own sourceMappingURL).
  assert.equal(diagnostic?.state, 'instance-version-conflict')
  assert.equal(diagnostic?.pluginId, id)
  assert.match(diagnostic?.message ?? '', /bundle rev 不同/)
  assert.match(diagnostic?.message ?? '', /mtime\/ctime\/size/, 'the copy names the real rev derivation')
  assert.match(diagnostic?.message ?? '', /已沿用实例 revision-source-one 先加载的版本/)
  assert.doesNotMatch(diagnostic?.message ?? '', /插件版本不同/)
})

test('collectExtraRows: same id across instances at the SAME rev reuses without any conflict', async (t) => {
  const id = '@scope/cross-instance-same-rev'
  stubFetch(t, 200, envelope([row(id, { rev: 'rev-one' })]))
  await collectExtraRows('same-rev-source-one', '/api/i/one', { loadModuleBundle: async () => {} })
  stubFetch(t, 200, envelope([row(id, { rev: 'rev-one' })]))
  let diagnostic: { state: string } | undefined
  const rows = await collectExtraRows('same-rev-source-two', '/api/i/two', {
    loadModuleBundle: async () => {},
    reportDiagnostic: (_sourceId, next) => { diagnostic = next },
  })
  // Same id + same rev = the same factory, whatever instance proxy it was
  // fetched through (module table is page-level): reuse, no conflict.
  assert.equal(rows.length, 1)
  assert.equal(diagnostic?.state, 'ok')
})

test('collectExtraRows: versionConflict outranks restartConflict within one boot', async (t) => {
  const driftId = '@scope/dual-drift'
  const rebuiltId = '@scope/dual-rebuilt'
  // Boot 1: a DIFFERENT instance ('dual-other') claims driftId.
  stubFetch(t, 200, envelope([row(driftId, { rev: 'drift-one' })]))
  await collectExtraRows('dual-other', '/api/i/other', { loadModuleBundle: async () => {} })
  // Boot 2: 'dual-owner' claims rebuiltId.
  stubFetch(t, 200, envelope([row(rebuiltId, { rev: 'rebuild-one' })]))
  await collectExtraRows('dual-owner', '/api/i/one', { loadModuleBundle: async () => {} })
  // Boot 3 (dual-owner): driftId at a new rev (owner dual-other → version
  // conflict) AND rebuiltId at a new rev (owner dual-owner itself → restart
  // conflict) in the same boot.
  stubFetch(t, 200, envelope([
    row(driftId, { rev: 'drift-two' }),
    row(rebuiltId, { rev: 'rebuild-two' }),
  ]))
  let diagnostic: { state: string; pluginId?: string; message?: string } | undefined
  await collectExtraRows('dual-owner', '/api/i/one', {
    loadModuleBundle: async () => {},
    reportDiagnostic: (_sourceId, next) => { diagnostic = next },
  })
  // One boot reports one diagnostic; the cross-instance drift (unfixable by
  // any restart) outranks the same-instance rebuild (fixable by restart).
  assert.equal(diagnostic?.state, 'instance-version-conflict')
  assert.equal(diagnostic?.pluginId, driftId)
  // The message states the OBSERVABLE fact (a rev/build-artifact difference) and
  // the first-load-wins owner — never a version claim (same-version plugins differ
  // across hosts by build metadata, measured: 11 bytes in sourceMappingURL).
  assert.match(diagnostic?.message ?? '', /bundle rev 不同/)
  assert.match(diagnostic?.message ?? '', /dual-other/)
  assert.doesNotMatch(diagnostic?.message ?? '', /插件版本不同/)
})

test('collectExtraRows: a rev conflict still logs an unsatisfiable-require fact instead of hiding it', async (t) => {
  // One diagnostic slot per boot, and a conflict wins it. The BOOT fact (a kept row
  // whose create-time require can never be answered) must still reach the console:
  // it never heals and would otherwise be invisible until the conflict disappears.
  const missing = '@deepseek-ai/dsh-client-ui-jobs'
  const conflicted = '@scope/precedence-conflicted'
  const needy = '@scope/precedence-needy'
  assert.ok(CHAMBER_COVERED_IDS.includes(missing), 'fixture: the missing id is a covered id')
  assert.ok(!CHAMBER_COVERED_FACTORY_IDS.includes(missing), 'fixture: no factory answers it')
  stubFetch(t, 200, envelope([row(conflicted, { rev: 'rev-one' })]))
  await collectExtraRows('precedence-other', '/api/i/other', { loadModuleBundle: async () => {} })
  stubFetch(t, 200, envelope([
    row(conflicted, { rev: 'rev-two' }),
    row(needy, { external: [`${missing}/client`] }),
  ]))
  const consoleCapture = captureConsoleError(t)
  let diagnostic: { state: string; pluginId?: string; message?: string } | undefined
  await collectExtraRows('precedence-owner', '/api/i/one', {
    loadModuleBundle: async () => {},
    reportDiagnostic: (_sourceId, next) => { diagnostic = next },
  })
  assert.equal(diagnostic?.state, 'instance-version-conflict')
  assert.equal(diagnostic?.pluginId, conflicted, 'the conflict owns the single diagnostic slot')
  assert.doesNotMatch(diagnostic?.message ?? '', /无法满足/, 'the conflict message stays about the conflict')
  const logged = consoleCapture.messages.join('\n')
  assert.match(logged, /无法满足/, 'the boot fact is still logged')
  assert.match(logged, new RegExp(`${needy} → ${missing}`), 'the console names the row→id edge')
})

test('collectExtraRows: a failed owner preload rolls the id back so ANOTHER instance re-claims and owns it', async (t) => {
  const id = '@scope/owner-transfer'
  stubFetch(t, 200, envelope([row(id, { rev: 'rev-one' })]))
  // Owner A claims the id but its bundle load fails → clearCombo removes
  // the id record (owner included) and the boot fails loud.
  await assert.rejects(
    collectExtraRows('owner-a', '/api/i/a', { loadModuleBundle: async () => { throw new Error('bundle exploded') } }),
    /bundle exploded/)
  // Instance B (a different source) re-preloads the same id at a new rev:
  // the rollback cleared A's ownership, so B claims it as the owner — no
  // conflict diagnostic, the merged row surfaces.
  stubFetch(t, 200, envelope([row(id, { rev: 'rev-two' })]))
  let diagnostic: { state: string } | undefined
  const rows = await collectExtraRows('owner-b', '/api/i/b', {
    loadModuleBundle: async () => {},
    reportDiagnostic: (_sourceId, next) => { diagnostic = next },
  })
  assert.equal(rows.length, 1)
  assert.equal(diagnostic?.state, 'ok', 'after A failed, B owns the id: no version-conflict')
})

test('collectExtraRows: a transient load failure is healed inside the same boot; success marks once', async (t) => {
  stubFetch(t, 200, envelope([row('@scope/retry-plugin')]))
  let calls = 0
  const loadModuleBundle = async (): Promise<void> => {
    calls += 1
    if (calls === 1) throw new Error('first attempt failed (transient)')
  }
  // First boot: the fresh load fails once (a network blip, or a bundle URL
  // invalidated by an instance restart — the recovery refetch returns the
  // same rev here, so the retried load runs against the same URL and
  // succeeds). The boot proceeds; the failure is never silently dropped —
  // it was retried once before it healed.
  let diagnostic: { state: string } | undefined
  const rows = await collectExtraRows('local', '/api/i/local', {
    loadModuleBundle,
    reportDiagnostic: (_sourceId, next) => { diagnostic = next },
  })
  assert.equal(calls, 2)
  assert.equal(diagnostic?.state, 'ok')
  assert.deepEqual(rows, [extra('@scope/retry-plugin')])
  // Second boot: marked after the success → the loader is not re-triggered.
  await collectExtraRows('local', '/api/i/local', { loadModuleBundle })
  assert.equal(calls, 2)
})

test('collectExtraRows: SAME instance id at a different rev reuses the loaded factory and reports restart-required', async (t) => {
  // Boot 1 preloads revA.
  stubFetch(t, 200, envelope([row('@scope/rev-plugin', { rev: 'revA', url: '/plugins/@scope/rev-plugin/client.js?rev=revA' })]))
  const loaded: string[] = []
  await collectExtraRows('local', '/api/i/local', { loadModuleBundle: async url => { loaded.push(url) } })
  assert.deepEqual(loaded, ['/api/i/local/plugins/@scope/rev-plugin/client.js?rev=revA'])
  // Boot 2 carries the same id at revB: already marked → no second load; the
  // merged row still surfaces revB (the id wins, the rev is informational).
  stubFetch(t, 200, envelope([row('@scope/rev-plugin', { rev: 'revB', url: '/plugins/@scope/rev-plugin/client.js?rev=revB' })]))
  let diagnostic: { state: string } | undefined
  const rows = await collectExtraRows('local', '/api/i/local', {
    loadModuleBundle: async url => { loaded.push(url) },
    reportDiagnostic: (_sourceId, next) => { diagnostic = next },
  })
  const revBUrl = '/api/i/local/plugins/@scope/rev-plugin/client.js?rev=revB'
  assert.deepEqual(rows, [
    { ...extra('@scope/rev-plugin'), url: revBUrl, initialUrl: revBUrl, rev: 'revB' },
  ])
  assert.deepEqual(loaded, ['/api/i/local/plugins/@scope/rev-plugin/client.js?rev=revA'])
  assert.equal(diagnostic?.state, 'restart-required')
})

test('collectExtraRows: a duplicate id within one graph preloads once', async (t) => {
  stubFetch(t, 200, envelope([row('@scope/dup'), row('@scope/dup')]))
  const loaded: string[] = []
  const rows = await collectExtraRows('local', '/api/i/local', { loadModuleBundle: async url => { loaded.push(url) } })
  assert.equal(loaded.length, 1)
  assert.equal(rows.length, 2) // both rows still surface as extras (union)
})

test('collectExtraRows: rows sharing one combo url preload that combo exactly once (dsh-v0.1.2-alpha.1)', async (t) => {
  // Combo endpoints: one script URL registers EVERY id its query names, so
  // multiple graph rows can share a url. Each unique combo url must execute
  // once — a second execution would re-register the same factories into the
  // shared module table (duplicate-registration sink).
  const comboUrl = '/plugins/??@scope/combo-a/client.js,@scope/combo-b/client.js&rev=combo1'
  stubFetch(t, 200, envelope([
    row('@scope/combo-a', { url: comboUrl, rev: 'combo1' }),
    row('@scope/combo-b', { url: comboUrl, rev: 'combo1' }),
  ]))
  const loaded: string[] = []
  const rows = await collectExtraRows('local', '/api/i/local', { loadModuleBundle: async url => { loaded.push(url) } })
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0], '/api/i/local/plugins/??@scope/combo-a/client.js,@scope/combo-b/client.js&rev=combo1')
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(r => r.id), ['@scope/combo-a', '@scope/combo-b'])
})

test('collectExtraRows: a shared combo url failure is healed by the in-boot recovery; success marks once', async (t) => {
  const comboUrl = '/plugins/??@scope/combo-fail-a/client.js,@scope/combo-fail-b/client.js&rev=combo-fail'
  stubFetch(t, 200, envelope([
    row('@scope/combo-fail-a', { url: comboUrl, rev: 'combo-fail' }),
    row('@scope/combo-fail-b', { url: comboUrl, rev: 'combo-fail' }),
  ]))
  let calls = 0
  const loadModuleBundle = async (): Promise<void> => {
    calls += 1
    if (calls === 1) throw new Error('combo exploded')
  }
  // One failed attempt, then the recovery pass re-preloads the single combo
  // script (the whole combo was cleared, so the retry is safe) — the boot
  // proceeds with both rows.
  const rows = await collectExtraRows('local', '/api/i/local', { loadModuleBundle })
  assert.equal(calls, 2)
  assert.equal(rows.length, 2)
  // Both rows are marked: a later boot does not re-trigger the loader.
  await collectExtraRows('local', '/api/i/local', { loadModuleBundle })
  assert.equal(calls, 2)
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
  const id = '@dsh-chamber/dsh-chamber-client-ui-git'
  assert.ok(CHAMBER_COVERED_IDS.includes(id))
  assert.ok(CHAMBER_COVERED_FACTORY_IDS.includes(id))
})

test('D2: the official open-in client row stays uncovered; chamber open-in stays a covered factory', () => {
  // D2: the official @deepseek-ai/dsh-client-ui-open-in-app row loads from the
  // host graph so its file-level seats register (the right-sidebar document
  // actions and the deliverables file actions, both over the per-instance
  // session Remote). Its own header entry stays inert on this page — its
  // document-relative `open-in-app/*` routes resolve to the control-plane origin
  // and the official host half is disabled by the per-spawn overlay — so the
  // effective directory-open entry remains chamber's own `open-in` family.
  assert.ok(!CHAMBER_COVERED_IDS.includes('@deepseek-ai/dsh-client-ui-open-in-app'),
    'the official open-in client row must stay uncovered so its file-level seats load')
  assert.ok(CHAMBER_COVERED_IDS.includes('@dsh-chamber/dsh-chamber-client-ui-open-in'))
  assert.ok(CHAMBER_COVERED_FACTORY_IDS.includes('@dsh-chamber/dsh-chamber-client-ui-open-in'))
})

test('desktop-only account family stays skipped: no body-level onboarding takeover', async (t) => {
  // Mechanism, cost and rejected alternatives: chamber-covered.ts (the skip entry)
  // and design 09 §3.5 有意跳过名单③.
  const id = '@deepseek-ai/dsh-client-ui-settings-account'
  assert.ok(CHAMBER_COVERED_IDS.includes(id),
    id + ' must stay covered: its desktop onboarding overlay hijacks the entire page (design 09 有意跳过名单)')
  assert.ok(!CHAMBER_COVERED_FACTORY_IDS.includes(id),
    id + ' is a skip, not a composite family: no factory may ever load it')
  assert.ok(!DEFERRED_EXTRA_ROW_IDS.includes(id),
    id + ' must not be listed as a deferred covered row — a deferred id IS loaded after settle')
  // End to end through the real merge (`collectExtraRows`): if the row ever
  // reaches the preload pass again, the body-level takeover re-arms.
  stubFetch(t, 200, envelope([row(id)]))
  let loaded = false
  const rows = await collectExtraRows('account-skip', '/api/i/local', {
    loadModuleBundle: async () => { loaded = true },
  })
  assert.deepEqual(rows, [])
  assert.equal(loaded, false, 'the covered account row must never be preloaded')
})

// ── `awaitBeforeLoad` must settle before the
// first extra-bundle load pass when rows exist, and be skipped entirely when
// dedupe leaves nothing to load (an absent gate starts the load pass immediately).
test('collectExtraRows: awaitBeforeLoad settles before the first bundle load pass (rows>0)', async (t) => {
  stubFetch(t, 200, envelope([row('@scope/c3-gate-a')]))
  const order: string[] = []
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const loading = collectExtraRows('c3-gate-a', '/api/i/local', {
    loadModuleBundle: async () => { order.push('load'); release() },
    awaitBeforeLoad: async () => { order.push('gate-before'); await gate },
  })
  // Give the collector a few turns to reach the gate without releasing it:
  // the load must NOT start while the gate is pending.
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(order, ['gate-before'], 'the gate is awaited before any bundle load')
  release()
  const rows = await loading
  assert.equal(rows.length, 1)
  assert.deepEqual(order, ['gate-before', 'load'], 'the load pass runs only after the gate settles')
})

test('collectExtraRows: awaitBeforeLoad is skipped when the graph has no kept rows', async (t) => {
  stubFetch(t, 200, envelope([]))
  let gated = false
  const rows = await collectExtraRows('c3-gate-empty', '/api/i/local', {
    loadModuleBundle: async () => { throw new Error('must not load with zero rows') },
    awaitBeforeLoad: async () => { gated = true },
  })
  assert.deepEqual(rows, [])
  assert.equal(gated, false)
})

test('collectExtraRows: awaitBeforeLoad is skipped when dedupe drops every row (covered-only graph)', async (t) => {
  stubFetch(t, 200, envelope([
    row('@deepseek-ai/dsh-client-ui-sidebar'),
    row('@deepseek-ai/dsh-client-ui-conversation'),
  ]))
  let gated = false
  const rows = await collectExtraRows('c3-gate-covered', '/api/i/local', {
    loadModuleBundle: async () => { throw new Error('must not load covered rows') },
    awaitBeforeLoad: async () => { gated = true },
  })
  assert.deepEqual(rows, [])
  assert.equal(gated, false)
})

test('collectExtraRows: an awaitBeforeLoad rejection fails the boot loud without loading bundles', async (t) => {
  stubFetch(t, 200, envelope([row('@scope/c3-gate-c')]))
  let loaded = false
  await assert.rejects(
    collectExtraRows('c3-gate-c', '/api/i/local', {
      loadModuleBundle: async () => { loaded = true },
      awaitBeforeLoad: async () => { throw new Error('chamber eval gate failed') },
    }),
    /chamber eval gate failed/)
  assert.equal(loaded, false)
})

test('A4: the wire helpers are upstream\'s own and the parse stays entries-only', async (t) => {
  const source = normalize(stripComments(
    readFileSync(new URL('../../src/host-graph.ts', import.meta.url), 'utf8')))
  // The deep vendor specifier is deliberate: manifest.ts is the browser-safe
  // contract face of the pinned dsh-client-modules (zero runtime imports), and
  // the renderer has no install-tree copy of it — the plain-node run of this
  // very file must resolve the real module without a bundler or ambient table.
  assert.match(
    source,
    /import \{ optionalStringArray, stripClientSuffix \} from '\.\.\/\.\.\/\.\.\/vendor\/harness-packages\/@deepseek-ai\/dsh-client-modules\/src\/client\/manifest\.ts'/,
    'the row validators must come from upstream, not from a local copy')
  assert.match(source, /optionalStringArray\(subject, 'inject', row\.inject\)/)
  assert.match(source, /optionalStringArray\(subject, 'external', row\.external\)/)
  assert.match(source, /const id = stripClientSuffix\(request\)/, 'the kernel-key normalization is upstream\'s helper')
  assert.doesNotMatch(source, /endsWith\('\/client'\)/, 'the previously inlined suffix strip is retired')

  // The LOCAL parse stays deliberately looser than upstream's
  // `parseBootManifest` (manifest.ts:167-256): it reads the wire's `entries`
  // only, so neither a missing graph-level `rev` nor the absent `batches` /
  // per-entry batch membership (:238-253) may fail a chamber boot's plugin set.
  stubFetch(t, 200, {
    rpcId: 'r1',
    result: { ok: true, value: { entries: [{ id: '@scope/only', url: '/plugins/only', rev: 'r1' }] } },
  })
  assert.deepEqual(await fetchHostGraph('/api/i/local'), [
    { id: '@scope/only', url: '/plugins/only', rev: 'r1' },
  ], 'an entries-only graph is a usable chamber graph')
})
