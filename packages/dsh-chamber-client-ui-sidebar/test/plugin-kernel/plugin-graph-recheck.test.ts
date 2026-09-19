/**
 * plugin-graph-recheck unit tests (design 09 §3.5 recheck contract): the channel-class self-heal pass must touch
 * ONLY `not-injected` / `graph-unreachable` diagnostics, write back only when the verdict changed (loop-freedom),
 * and mirror the boot fetch's status/envelope classification and message literals. Plain node:test, no dsh, no React.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chamberBridge, type PluginGraphDiagnostic } from '../../src/shared/aggregate-store.ts'
import { isChannelClassDiagnostic, recheckPluginGraphDiagnostic } from '../../src/shared/plugin-graph-recheck.ts'

const CP = 'http://cp'
const HTTP_404 = '宿主启动图不可达：HTTP 404'

/** One recorded diagnostic for a source (report through the real store). */
const record = (sourceId: string, state: PluginGraphDiagnostic['state'], message?: string, updatedAt = 1): void =>
  chamberBridge.reportPluginDiagnostic(sourceId, { state, message, updatedAt })

/** The recorded diagnostic for a source. */
const diag = (sourceId: string): PluginGraphDiagnostic | undefined => chamberBridge.getPluginDiagnostics()[sourceId]

/** Recheck one source against a canned fetch on the shared control-plane origin. */
const recheck = (sourceId: string, fetchImpl: typeof fetch) => recheckPluginGraphDiagnostic(sourceId, { fetchImpl, origin: CP })

/** The boot's server-response envelope around a `result` payload. */
const envelope = (result: unknown): unknown => ({ type: 'server-response', rpcId: 'any', result })
const validEnvelope = (): unknown => envelope({ ok: true, value: { rev: 'rev-1', entries: [] } })

/** Fake fetch answering one canned response; live getters view the captured request (not creation-time copies). */
function fakeFetchFor(status: number, body: unknown): { fetch: typeof fetch; readonly url: string; readonly bodyText: string } {
  let url = ''
  let bodyText = ''
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    url = String(input)
    bodyText = typeof init?.body === 'string' ? init.body : ''
    const payload = typeof body === 'string' ? body : JSON.stringify(body)
    return new Response(payload, { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { fetch: fetchImpl, get url() { return url }, get bodyText() { return bodyText } }
}

/** A fetch that always throws (network-down case). */
const networkDownFetch: typeof fetch = (async () => { throw new Error('network down') }) as typeof fetch

test('isChannelClassDiagnostic admits only the two channel states', () => {
  assert.equal(isChannelClassDiagnostic('not-injected'), true)
  assert.equal(isChannelClassDiagnostic('graph-unreachable'), true)
  assert.equal(isChannelClassDiagnostic('ok'), false)
  assert.equal(isChannelClassDiagnostic('bundle-load-failed'), false)
  assert.equal(isChannelClassDiagnostic('restart-required'), false)
  assert.equal(isChannelClassDiagnostic('instance-version-conflict'), false)
  assert.equal(isChannelClassDiagnostic(undefined), false)
})

test('recheck skips absent diagnostics and boot-fact states without fetching', async () => {
  let fetched = false
  const fetchImpl = (async (): Promise<Response> => {
    fetched = true
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  assert.equal(await recheckPluginGraphDiagnostic('recheck-absent', { fetchImpl }), 'skipped')
  assert.equal(fetched, false)
  for (const state of ['ok', 'bundle-load-failed', 'restart-required', 'instance-version-conflict'] as const) {
    record('recheck-boot-fact', state, 'boot fact')
    assert.equal(await recheckPluginGraphDiagnostic('recheck-boot-fact', { fetchImpl }), 'skipped', state)
  }
  assert.equal(fetched, false)
})

test('recheck hits the exact proxy endpoint the boot fetch uses', async () => {
  record('gateway-test-http', 'not-injected', HTTP_404)
  const fake = fakeFetchFor(200, validEnvelope())
  await recheckPluginGraphDiagnostic('gateway-test-http', { fetchImpl: fake.fetch, origin: 'https://cp.example' })
  assert.equal(fake.url, 'https://cp.example/api/i/gateway-test-http/api/clientGraph/graph')
  const request = JSON.parse(fake.bodyText) as { type?: string; method?: string; payload?: { args?: object } }
  assert.equal(request.type, 'client-request')
  assert.equal(request.method, 'clientGraph/graph')
  assert.deepEqual(request.payload, { args: {} })
})

test('recheck heals a stale 404 diagnostic to ok when the graph answers', async () => {
  record('recheck-heal', 'not-injected', HTTP_404)
  const fake = fakeFetchFor(200, validEnvelope())
  assert.equal(await recheck('recheck-heal', fake.fetch), 'reported-ok')
  const after = diag('recheck-heal')
  assert.equal(after?.state, 'ok')
  assert.equal(after?.message, undefined)
  assert.equal(typeof after?.updatedAt, 'number')
})

test('recheck on a still-broken channel writes nothing (no verdict change, no loop)', async () => {
  record('recheck-still-404', 'not-injected', HTTP_404)
  const fake = fakeFetchFor(404, { error: 'not found' })
  assert.equal(await recheck('recheck-still-404', fake.fetch), 'unchanged')
  const after = diag('recheck-still-404')
  assert.equal(after?.state, 'not-injected')
  assert.equal(after?.updatedAt, 1, 'unchanged verdict must not churn updatedAt')
})

test('recheck classifies an unknown-method envelope answer as not-injected', async () => {
  record('recheck-envelope-404', 'graph-unreachable', '宿主启动图不可达：HTTP 500')
  const fake = fakeFetchFor(200, envelope({ ok: false, error: { code: 'unknown_method', message: 'method clientGraph/graph not found' } }))
  assert.equal(await recheck('recheck-envelope-404', fake.fetch), 'reported-not-injected')
  assert.equal(diag('recheck-envelope-404')?.state, 'not-injected')
})

test('recheck reports graph-unreachable for other HTTP statuses and network failure', async () => {
  record('recheck-http-500', 'not-injected', HTTP_404)
  const fake = fakeFetchFor(500, { error: 'boom' })
  assert.equal(await recheck('recheck-http-500', fake.fetch), 'reported-graph-unreachable')
  assert.equal(diag('recheck-http-500')?.state, 'graph-unreachable')
  assert.equal(diag('recheck-http-500')?.message, '宿主启动图不可达：HTTP 500')
  record('recheck-network', 'not-injected', HTTP_404)
  assert.equal(await recheck('recheck-network', networkDownFetch), 'reported-graph-unreachable')
  assert.equal(diag('recheck-network')?.message, '宿主启动图不可达：network down')
})

test('recheck reports graph-unreachable for malformed envelopes and non-array entries', async () => {
  record('recheck-bad-envelope', 'not-injected', HTTP_404)
  const fake = fakeFetchFor(200, { type: 'server-response', rpcId: 'any' })
  assert.equal(await recheck('recheck-bad-envelope', fake.fetch), 'reported-graph-unreachable')
  assert.equal(diag('recheck-bad-envelope')?.message, '宿主启动图：envelope 缺少 result')
  record('recheck-bad-entries', 'not-injected', HTTP_404)
  const fakeEntries = fakeFetchFor(200, envelope({ ok: true, value: { rev: 'rev', entries: 'nope' } }))
  assert.equal(await recheck('recheck-bad-entries', fakeEntries.fetch), 'reported-graph-unreachable')
  assert.equal(diag('recheck-bad-entries')?.message, '宿主启动图：result.value.entries 必须是数组')
})

test('recheck never writes on the 503 instance_unavailable pre-ready signal', async () => {
  record('recheck-503', 'not-injected', HTTP_404)
  const fake = fakeFetchFor(503, { code: 'instance_unavailable', error: 'the local instance is not ready' })
  assert.equal(await recheck('recheck-503', fake.fetch), 'unchanged')
  const after = diag('recheck-503')
  assert.equal(after?.state, 'not-injected')
  assert.equal(after?.updatedAt, 1, 'a 503 must not rewrite the recorded diagnostic')
})

test('recheck reports graph-unreachable for a 503 that is NOT instance_unavailable', async () => {
  record('recheck-503-other', 'not-injected', HTTP_404)
  const fake = fakeFetchFor(503, { code: 'resource_exhausted' })
  assert.equal(await recheck('recheck-503-other', fake.fetch), 'reported-graph-unreachable')
  assert.equal(diag('recheck-503-other')?.message, '宿主启动图不可达：HTTP 503')
})

test('recheck reports graph-unreachable for a non-JSON 200 body', async () => {
  record('recheck-non-json', 'not-injected', HTTP_404)
  const fake = fakeFetchFor(200, 'not json at all')
  assert.equal(await recheck('recheck-non-json', fake.fetch), 'reported-graph-unreachable')
  assert.match(diag('recheck-non-json')?.message ?? '', /^宿主启动图：envelope 不是合法 JSON：/)
})

test('recheck mirrors the boot ?? chain for code-only and empty-message failures', async () => {
  // ok:false with only a code → hostError falls back to the code.
  record('recheck-code-only', 'not-injected', HTTP_404)
  const fake = fakeFetchFor(200, envelope({ ok: false, error: { code: 'internal_error' } }))
  assert.equal(await recheck('recheck-code-only', fake.fetch), 'reported-graph-unreachable')
  assert.equal(diag('recheck-code-only')?.message, '宿主启动图：graph 调用失败：internal_error')
  // An ARRAY result passes the boot's typeof-object gate and falls into the ok !== true branch — never "缺少 result".
  record('recheck-array-result', 'not-injected', HTTP_404)
  const fakeArray = fakeFetchFor(200, envelope(['not', 'a', 'record']))
  assert.equal(await recheck('recheck-array-result', fakeArray.fetch), 'reported-graph-unreachable')
  assert.equal(diag('recheck-array-result')?.message, '宿主启动图：graph 调用失败：unknown')
})

test('recheck never heals malformed graph rows to ok (boot mirror)', async () => {
  record('recheck-bad-row-obj', 'not-injected', HTTP_404)
  const fakeObj = fakeFetchFor(200, envelope({ ok: true, value: { rev: 'rev', entries: ['junk'] } }))
  assert.equal(await recheck('recheck-bad-row-obj', fakeObj.fetch), 'reported-graph-unreachable')
  assert.equal(diag('recheck-bad-row-obj')?.message, '宿主启动图：entry 不是对象')
  record('recheck-bad-row-fields', 'not-injected', HTTP_404)
  const fakeFields = fakeFetchFor(200, envelope({ ok: true, value: { rev: 'rev', entries: [{ id: 'x', url: '/plugins/??x/client.js' }] } }))
  assert.equal(await recheck('recheck-bad-row-fields', fakeFields.fetch), 'reported-graph-unreachable')
  assert.equal(diag('recheck-bad-row-fields')?.message,
    '宿主启动图：entry {"id":"x","url":"/plugins/??x/client.js"} 必须携带 string id/url/rev')
  // An ok:true value that is not an object/array still answers the entries message (boot's combined gate).
  record('recheck-bad-value', 'not-injected', HTTP_404)
  const fakeValue = fakeFetchFor(200, envelope({ ok: true, value: 'nope' }))
  assert.equal(await recheck('recheck-bad-value', fakeValue.fetch), 'reported-graph-unreachable')
  assert.equal(diag('recheck-bad-value')?.message, '宿主启动图：result.value.entries 必须是数组')
})

test('recheck never clobbers a fresher authoritative record written mid-flight', async () => {
  record('recheck-midflight', 'not-injected', HTTP_404)
  // The fake fetch answers ok BUT, before resolving, an authoritative writer (a shell boot) records a boot fact.
  const fetchImpl = (async (): Promise<Response> => {
    chamberBridge.reportPluginDiagnostic('recheck-midflight', { state: 'bundle-load-failed', message: 'bundle boom', updatedAt: 2 })
    return new Response(JSON.stringify(envelope({ ok: true, value: { rev: 'rev', entries: [] } })), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  assert.equal(await recheck('recheck-midflight', fetchImpl), 'unchanged', 'a stale verdict must not overwrite the fresher boot record')
  const after = diag('recheck-midflight')
  assert.equal(after?.state, 'bundle-load-failed')
  assert.equal(after?.message, 'bundle boom')
})

test('recheck never writes on a message-only drift (same state, different error text)', async () => {
  record('recheck-msg-drift', 'graph-unreachable', '宿主启动图不可达：network down A')
  // The channel still fails, but with different (non-deterministic) error text — state is unchanged, so the
  // recorded message must survive and no write may churn the store (no ping-pong).
  assert.equal(await recheck('recheck-msg-drift', networkDownFetch), 'unchanged')
  const after = diag('recheck-msg-drift')
  assert.equal(after?.state, 'graph-unreachable')
  assert.equal(after?.message, '宿主启动图不可达：network down A')
  assert.equal(after?.updatedAt, 1)
})

test('recheck reports a not-injected verdict when the recorded state was graph-unreachable', async () => {
  record('recheck-reclassify', 'graph-unreachable', '宿主启动图不可达：network down')
  const fake = fakeFetchFor(404, { error: 'not found' })
  assert.equal(await recheck('recheck-reclassify', fake.fetch), 'reported-not-injected')
  const after = diag('recheck-reclassify')
  assert.equal(after?.state, 'not-injected')
  assert.equal(after?.message, '宿主启动图不可达：HTTP 404')
})
