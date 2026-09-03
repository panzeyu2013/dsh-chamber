/**
 * plugin-graph-recheck unit tests (design 09 §3.5 recheck contract): the
 * channel-class self-heal pass must (a) touch ONLY `not-injected` /
 * `graph-unreachable` diagnostics, (b) write back only when the verdict
 * changed (loop-freedom — a still-broken channel re-verifies silently), and
 * (c) mirror the boot fetch's status/envelope classification and message
 * literals. Plain node:test, no dsh, no React — mirror of the
 * aggregate-store.test.ts style.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chamberBridge } from '../src/shared/aggregate-store.ts'
import type { PluginGraphDiagnostic } from '../src/shared/aggregate-store.ts'
import {
  isChannelClassDiagnostic,
  recheckPluginGraphDiagnostic,
} from '../src/shared/plugin-graph-recheck.ts'

/** One recorded diagnostic for a source (report through the real store). */
function record(sourceId: string, state: PluginGraphDiagnostic['state'], message?: string, updatedAt = 1): void {
  chamberBridge.reportPluginDiagnostic(sourceId, { state, message, updatedAt })
}

/** Fake fetch answering one canned response; live views of the captured
 *  request (getters — the closure bindings, not creation-time copies). */
function fakeFetchFor(status: number, body: unknown): { fetch: typeof fetch; readonly url: string; readonly bodyText: string } {
  let url = ''
  let bodyText = ''
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    url = String(input)
    bodyText = typeof init?.body === 'string' ? init.body : ''
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return {
    fetch: fetchImpl,
    get url() { return url },
    get bodyText() { return bodyText },
  }
}

function validEnvelope(): unknown {
  return {
    type: 'server-response',
    rpcId: 'any',
    result: { ok: true, value: { rev: 'rev-1', entries: [] } },
  }
}

/** A fetch that always throws (network-down case). */
const networkDownFetch: typeof fetch = (async () => {
  throw new Error('network down')
}) as typeof fetch

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
  record('gateway-test-http', 'not-injected', '宿主启动图不可达：HTTP 404')
  const fake = fakeFetchFor(200, validEnvelope())
  await recheckPluginGraphDiagnostic('gateway-test-http', {
    fetchImpl: fake.fetch,
    origin: 'https://cp.example',
  })
  assert.equal(fake.url, 'https://cp.example/api/i/gateway-test-http/api/clientGraph/graph')
  const request = JSON.parse(fake.bodyText) as { type?: string; method?: string; payload?: { args?: object } }
  assert.equal(request.type, 'client-request')
  assert.equal(request.method, 'clientGraph/graph')
  assert.deepEqual(request.payload, { args: {} })
})

test('recheck heals a stale 404 diagnostic to ok when the graph answers', async () => {
  record('recheck-heal', 'not-injected', '宿主启动图不可达：HTTP 404')
  const fake = fakeFetchFor(200, validEnvelope())
  const outcome = await recheckPluginGraphDiagnostic('recheck-heal', { fetchImpl: fake.fetch, origin: 'http://cp' })
  assert.equal(outcome, 'reported-ok')
  const after = chamberBridge.getPluginDiagnostics()['recheck-heal']
  assert.equal(after?.state, 'ok')
  assert.equal(after?.message, undefined)
  assert.equal(typeof after?.updatedAt, 'number')
})

test('recheck on a still-broken channel writes nothing (no verdict change, no loop)', async () => {
  record('recheck-still-404', 'not-injected', '宿主启动图不可达：HTTP 404')
  const fake = fakeFetchFor(404, { error: 'not found' })
  const outcome = await recheckPluginGraphDiagnostic('recheck-still-404', { fetchImpl: fake.fetch, origin: 'http://cp' })
  assert.equal(outcome, 'unchanged')
  const after = chamberBridge.getPluginDiagnostics()['recheck-still-404']
  assert.equal(after?.state, 'not-injected')
  assert.equal(after?.updatedAt, 1, 'unchanged verdict must not churn updatedAt')
})

test('recheck classifies an unknown-method envelope answer as not-injected', async () => {
  record('recheck-envelope-404', 'graph-unreachable', '宿主启动图不可达：HTTP 500')
  const fake = fakeFetchFor(200, {
    type: 'server-response',
    rpcId: 'any',
    result: { ok: false, error: { code: 'unknown_method', message: 'method clientGraph/graph not found' } },
  })
  const outcome = await recheckPluginGraphDiagnostic('recheck-envelope-404', { fetchImpl: fake.fetch, origin: 'http://cp' })
  assert.equal(outcome, 'reported-not-injected')
  assert.equal(chamberBridge.getPluginDiagnostics()['recheck-envelope-404']?.state, 'not-injected')
})

test('recheck reports graph-unreachable for other HTTP statuses and network failure', async () => {
  record('recheck-http-500', 'not-injected', '宿主启动图不可达：HTTP 404')
  const fake = fakeFetchFor(500, { error: 'boom' })
  const outcome = await recheckPluginGraphDiagnostic('recheck-http-500', { fetchImpl: fake.fetch, origin: 'http://cp' })
  assert.equal(outcome, 'reported-graph-unreachable')
  assert.equal(chamberBridge.getPluginDiagnostics()['recheck-http-500']?.state, 'graph-unreachable')
  assert.equal(chamberBridge.getPluginDiagnostics()['recheck-http-500']?.message, '宿主启动图不可达：HTTP 500')

  record('recheck-network', 'not-injected', '宿主启动图不可达：HTTP 404')
  const outcomeNetwork = await recheckPluginGraphDiagnostic('recheck-network', { fetchImpl: networkDownFetch, origin: 'http://cp' })
  assert.equal(outcomeNetwork, 'reported-graph-unreachable')
  assert.equal(
    chamberBridge.getPluginDiagnostics()['recheck-network']?.message,
    '宿主启动图不可达：network down',
  )
})

test('recheck reports graph-unreachable for malformed envelopes and non-array entries', async () => {
  record('recheck-bad-envelope', 'not-injected', '宿主启动图不可达：HTTP 404')
  const fake = fakeFetchFor(200, { type: 'server-response', rpcId: 'any' })
  const outcome = await recheckPluginGraphDiagnostic('recheck-bad-envelope', { fetchImpl: fake.fetch, origin: 'http://cp' })
  assert.equal(outcome, 'reported-graph-unreachable')
  assert.equal(chamberBridge.getPluginDiagnostics()['recheck-bad-envelope']?.message, '宿主启动图：envelope 缺少 result')

  record('recheck-bad-entries', 'not-injected', '宿主启动图不可达：HTTP 404')
  const fakeEntries = fakeFetchFor(200, {
    type: 'server-response',
    rpcId: 'any',
    result: { ok: true, value: { rev: 'rev', entries: 'nope' } },
  })
  const outcomeEntries = await recheckPluginGraphDiagnostic('recheck-bad-entries', { fetchImpl: fakeEntries.fetch, origin: 'http://cp' })
  assert.equal(outcomeEntries, 'reported-graph-unreachable')
  assert.equal(chamberBridge.getPluginDiagnostics()['recheck-bad-entries']?.message, '宿主启动图：result.value.entries 必须是数组')
})

test('recheck never writes on the 503 instance_unavailable pre-ready signal', async () => {
  record('recheck-503', 'not-injected', '宿主启动图不可达：HTTP 404')
  const fake = fakeFetchFor(503, { code: 'instance_unavailable', error: 'the local instance is not ready' })
  const outcome = await recheckPluginGraphDiagnostic('recheck-503', { fetchImpl: fake.fetch, origin: 'http://cp' })
  assert.equal(outcome, 'unchanged')
  const after = chamberBridge.getPluginDiagnostics()['recheck-503']
  assert.equal(after?.state, 'not-injected')
  assert.equal(after?.updatedAt, 1, 'a 503 must not rewrite the recorded diagnostic')
})

test('recheck reports graph-unreachable for a 503 that is NOT instance_unavailable', async () => {
  record('recheck-503-other', 'not-injected', '宿主启动图不可达：HTTP 404')
  const fake = fakeFetchFor(503, { code: 'resource_exhausted' })
  const outcome = await recheckPluginGraphDiagnostic('recheck-503-other', { fetchImpl: fake.fetch, origin: 'http://cp' })
  assert.equal(outcome, 'reported-graph-unreachable')
  assert.equal(chamberBridge.getPluginDiagnostics()['recheck-503-other']?.message, '宿主启动图不可达：HTTP 503')
})

test('recheck reports graph-unreachable for a non-JSON 200 body', async () => {
  record('recheck-non-json', 'not-injected', '宿主启动图不可达：HTTP 404')
  const fake = fakeFetchFor(200, 'not json at all')
  const outcome = await recheckPluginGraphDiagnostic('recheck-non-json', { fetchImpl: fake.fetch, origin: 'http://cp' })
  assert.equal(outcome, 'reported-graph-unreachable')
  assert.match(chamberBridge.getPluginDiagnostics()['recheck-non-json']?.message ?? '', /^宿主启动图：envelope 不是合法 JSON：/)
})

test('recheck mirrors the boot ?? chain for code-only and empty-message failures', async () => {
  // ok:false with only a code → hostError falls back to the code.
  record('recheck-code-only', 'not-injected', '宿主启动图不可达：HTTP 404')
  const fakeCode = fakeFetchFor(200, { type: 'server-response', rpcId: 'any', result: { ok: false, error: { code: 'internal_error' } } })
  const outcomeCode = await recheckPluginGraphDiagnostic('recheck-code-only', { fetchImpl: fakeCode.fetch, origin: 'http://cp' })
  assert.equal(outcomeCode, 'reported-graph-unreachable')
  assert.equal(chamberBridge.getPluginDiagnostics()['recheck-code-only']?.message, '宿主启动图：graph 调用失败：internal_error')

  // An ARRAY result passes the boot's typeof-object gate and falls into the
  // ok !== true branch — never "缺少 result".
  record('recheck-array-result', 'not-injected', '宿主启动图不可达：HTTP 404')
  const fakeArray = fakeFetchFor(200, { type: 'server-response', rpcId: 'any', result: ['not', 'a', 'record'] })
  const outcomeArray = await recheckPluginGraphDiagnostic('recheck-array-result', { fetchImpl: fakeArray.fetch, origin: 'http://cp' })
  assert.equal(outcomeArray, 'reported-graph-unreachable')
  assert.equal(chamberBridge.getPluginDiagnostics()['recheck-array-result']?.message, '宿主启动图：graph 调用失败：unknown')
})

test('recheck never heals malformed graph rows to ok (boot mirror)', async () => {
  record('recheck-bad-row-obj', 'not-injected', '宿主启动图不可达：HTTP 404')
  const fakeObj = fakeFetchFor(200, {
    type: 'server-response', rpcId: 'any',
    result: { ok: true, value: { rev: 'rev', entries: ['junk'] } },
  })
  const outcomeObj = await recheckPluginGraphDiagnostic('recheck-bad-row-obj', { fetchImpl: fakeObj.fetch, origin: 'http://cp' })
  assert.equal(outcomeObj, 'reported-graph-unreachable')
  assert.equal(chamberBridge.getPluginDiagnostics()['recheck-bad-row-obj']?.message, '宿主启动图：entry 不是对象')

  record('recheck-bad-row-fields', 'not-injected', '宿主启动图不可达：HTTP 404')
  const fakeFields = fakeFetchFor(200, {
    type: 'server-response', rpcId: 'any',
    result: { ok: true, value: { rev: 'rev', entries: [{ id: 'x', url: '/plugins/??x/client.js' }] } },
  })
  const outcomeFields = await recheckPluginGraphDiagnostic('recheck-bad-row-fields', { fetchImpl: fakeFields.fetch, origin: 'http://cp' })
  assert.equal(outcomeFields, 'reported-graph-unreachable')
  assert.equal(
    chamberBridge.getPluginDiagnostics()['recheck-bad-row-fields']?.message,
    '宿主启动图：entry {"id":"x","url":"/plugins/??x/client.js"} 必须携带 string id/url/rev',
  )

  // An ok:true value that is not an object/array still answers the entries
  // message (boot's combined gate).
  record('recheck-bad-value', 'not-injected', '宿主启动图不可达：HTTP 404')
  const fakeValue = fakeFetchFor(200, { type: 'server-response', rpcId: 'any', result: { ok: true, value: 'nope' } })
  const outcomeValue = await recheckPluginGraphDiagnostic('recheck-bad-value', { fetchImpl: fakeValue.fetch, origin: 'http://cp' })
  assert.equal(outcomeValue, 'reported-graph-unreachable')
  assert.equal(chamberBridge.getPluginDiagnostics()['recheck-bad-value']?.message, '宿主启动图：result.value.entries 必须是数组')
})

test('recheck never clobbers a fresher authoritative record written mid-flight', async () => {
  record('recheck-midflight', 'not-injected', '宿主启动图不可达：HTTP 404')
  // The fake fetch answers ok BUT, before resolving, an authoritative writer
  // (a shell boot) records a boot-fact diagnostic for the same source.
  const fetchImpl = (async (): Promise<Response> => {
    chamberBridge.reportPluginDiagnostic('recheck-midflight', { state: 'bundle-load-failed', message: 'bundle boom', updatedAt: 2 })
    return new Response(JSON.stringify({
      type: 'server-response', rpcId: 'any',
      result: { ok: true, value: { rev: 'rev', entries: [] } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const outcome = await recheckPluginGraphDiagnostic('recheck-midflight', { fetchImpl, origin: 'http://cp' })
  assert.equal(outcome, 'unchanged', 'a stale verdict must not overwrite the fresher boot record')
  const after = chamberBridge.getPluginDiagnostics()['recheck-midflight']
  assert.equal(after?.state, 'bundle-load-failed')
  assert.equal(after?.message, 'bundle boom')
})

test('recheck never writes on a message-only drift (same state, different error text)', async () => {
  record('recheck-msg-drift', 'graph-unreachable', '宿主启动图不可达：network down A')
  // The channel still fails, but with a different (non-deterministic) error
  // text — state is unchanged, so the recorded message must survive and no
  // write may churn the store (no ping-pong).
  const outcome = await recheckPluginGraphDiagnostic('recheck-msg-drift', { fetchImpl: networkDownFetch, origin: 'http://cp' })
  assert.equal(outcome, 'unchanged')
  const after = chamberBridge.getPluginDiagnostics()['recheck-msg-drift']
  assert.equal(after?.state, 'graph-unreachable')
  assert.equal(after?.message, '宿主启动图不可达：network down A')
  assert.equal(after?.updatedAt, 1)
})

test('recheck reports a not-injected verdict when the recorded state was graph-unreachable', async () => {
  record('recheck-reclassify', 'graph-unreachable', '宿主启动图不可达：network down')
  const fake = fakeFetchFor(404, { error: 'not found' })
  const outcome = await recheckPluginGraphDiagnostic('recheck-reclassify', { fetchImpl: fake.fetch, origin: 'http://cp' })
  assert.equal(outcome, 'reported-not-injected')
  const after = chamberBridge.getPluginDiagnostics()['recheck-reclassify']
  assert.equal(after?.state, 'not-injected')
  assert.equal(after?.message, '宿主启动图不可达：HTTP 404')
})
