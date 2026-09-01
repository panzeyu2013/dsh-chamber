/**
 * Plugin-inventory read face tests (plain node:test, no dsh, no React):
 * the unary wire client (plugin-inventory-api.ts) envelope parsing +
 * transport failure folding, and the pure display projections
 * (plugin-inventory-text.ts: third-party filter + chamber remote state).
 * The read face is the connections-section plugin surface for gateway /
 * http-direct targets (design 17 §9.3).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPluginInventory, type PluginInventorySnapshot } from '../src/client/plugin-inventory-api.ts'
import {
  GIT_WORKTREE_PACKAGE,
  HOST_GRAPH_PACKAGE,
  chamberRemoteKey,
  thirdPartyEntries,
} from '../src/client/plugin-inventory-text.ts'

function withPageOrigin(origin: string): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin },
  })
  return () => {
    if (previous === undefined) delete (globalThis as { location?: unknown }).location
    else Object.defineProperty(globalThis, 'location', previous)
  }
}

interface FetchCall { url: string; init: RequestInit }

function stubFetch(status: number, body: unknown, reject = false): { calls: FetchCall[]; restore(): void } {
  const calls: FetchCall[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    if (reject) return Promise.reject(new TypeError('fetch failed'))
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

function serverResponse(rpcId: string, result: unknown): unknown {
  return { type: 'server-response', rpcId, result }
}

const okSnapshot: PluginInventorySnapshot = {
  entries: [
    { entryId: 'p1', moduleName: '@deepseek-ai/dsh-demo', enabled: true, fiberPhase: 'active' },
    { entryId: 'p2', moduleName: '@deepseek-ai/dsh-broken', enabled: true, fiberPhase: 'failed' },
    { entryId: 'p3', moduleName: '@deepseek-ai/dsh-off', enabled: false, fiberPhase: null },
    { entryId: 'p4', moduleName: HOST_GRAPH_PACKAGE, enabled: true, fiberPhase: 'active' },
    { entryId: 'p5', moduleName: GIT_WORKTREE_PACKAGE, enabled: true, fiberPhase: 'active' },
    { entryId: 'p6', moduleName: '@dsh-chamber/user-tool', enabled: true, fiberPhase: 'loading' },
    { entryId: 'p7', moduleName: 'my-third-party-plugin', enabled: false, fiberPhase: 'failed' },
  ],
}

test('loadPluginInventory: posts the client-request envelope to the per-instance proxy and parses the snapshot', async () => {
  const restoreOrigin = withPageOrigin('http://127.0.0.1:17500')
  const stub = stubFetch(200, serverResponse('rpc-1', { ok: true, value: okSnapshot }))
  try {
    const snapshot = await loadPluginInventory('gateway-west')
    assert.equal(stub.calls.length, 1)
    const call = stub.calls[0]!
    assert.equal(call.url, 'http://127.0.0.1:17500/api/i/gateway-west/api/pluginInventory/list')
    assert.equal(call.init.method, 'POST')
    const envelope = JSON.parse(String(call.init.body)) as { type: string; method: string; payload: unknown }
    assert.equal(envelope.type, 'client-request')
    assert.equal(envelope.method, 'pluginInventory/list')
    assert.deepEqual(envelope.payload, { args: {} })
    assert.deepEqual(snapshot, okSnapshot)
  } finally {
    stub.restore()
    restoreOrigin()
  }
})

test('loadPluginInventory: a business failure throws a loud message with code, never a silent empty list', async () => {
  const stub = stubFetch(200, serverResponse('rpc-2', {
    ok: false,
    error: { code: 'gateway/not-found', message: 'pluginInventory/list is not mounted' },
  }))
  try {
    await assert.rejects(loadPluginInventory('gateway-west'), /pluginInventory\/list failed: gateway\/not-found: pluginInventory\/list is not mounted/)
  } finally {
    stub.restore()
  }
})

test('loadPluginInventory: the proxy explicit 503 instance_unavailable folds into an honest not-ready error', async () => {
  const stub = stubFetch(503, { code: 'instance_unavailable', error: 'no transport is available for this instance' })
  try {
    await assert.rejects(loadPluginInventory('gateway-west'), /实例未就绪：no transport is available for this instance/)
  } finally {
    stub.restore()
  }
})

test('loadPluginInventory: a non-2xx answer and a network failure both fold as transport errors (never empty)', async () => {
  const stub = stubFetch(500, { error: 'boom' })
  try {
    await assert.rejects(loadPluginInventory('gateway-west'), /实例不可达：HTTP 500/)
  } finally {
    stub.restore()
  }
  const rejected = stubFetch(0, null, true)
  try {
    await assert.rejects(loadPluginInventory('gateway-west'), /实例不可达：fetch failed/)
  } finally {
    rejected.restore()
  }
})

test('loadPluginInventory: malformed envelopes and invalid snapshots are loud TypeErrors, never silent', async () => {
  const cases: Array<[unknown, RegExp]> = [
    [serverResponse('rpc-3', { ok: true, value: { entries: [{ entryId: 7, moduleName: 'x', enabled: true, fiberPhase: 'active' }] } }), /invalid inventory entry/],
    [serverResponse('rpc-3', { ok: true, value: { entries: 'nope' } }), /invalid snapshot/],
    [serverResponse('rpc-3', { ok: false, error: { code: 7, message: 'x' } }), /invalid server-response failure/],
    [{ type: 'other', rpcId: 'rpc-3', result: {} }, /invalid server-response envelope/],
  ]
  for (const [body, expected] of cases) {
    const stub = stubFetch(200, body)
    try {
      await assert.rejects(loadPluginInventory('gateway-west'), expected)
    } finally {
      stub.restore()
    }
  }
})

test('thirdPartyEntries: official and chamber packages are excluded, everything else stays', () => {
  const rows = thirdPartyEntries(okSnapshot)
  assert.deepEqual(rows.map(row => row.moduleName), ['@dsh-chamber/user-tool', 'my-third-party-plugin'])
})

test('chamberRemoteKey: live Loader state derives the remote label, never a constant claim', () => {
  const { entries } = okSnapshot
  // Present + enabled + active → 已注入并已生效; failed → 加载失败; other
  // phases → 生效状态未知; present-but-DISABLED is never claimed live.
  assert.equal(chamberRemoteKey(entries, HOST_GRAPH_PACKAGE), 'chamberRemoteLive')
  const failed = entries.map(entry => entry.moduleName === GIT_WORKTREE_PACKAGE
    ? { ...entry, fiberPhase: 'failed' as const }
    : entry)
  assert.equal(chamberRemoteKey(failed, GIT_WORKTREE_PACKAGE), 'chamberRemoteFailed')
  const pending = entries.map(entry => entry.moduleName === HOST_GRAPH_PACKAGE
    ? { ...entry, fiberPhase: 'loading' as const }
    : entry)
  assert.equal(chamberRemoteKey(pending, HOST_GRAPH_PACKAGE), 'chamberRemoteInjectedUnknown')
  const disabled = entries.map(entry => entry.moduleName === HOST_GRAPH_PACKAGE
    ? { ...entry, enabled: false, fiberPhase: 'active' as const }
    : entry)
  assert.equal(chamberRemoteKey(disabled, HOST_GRAPH_PACKAGE), 'chamberRemoteInjectedUnknown')
  // Absent → 未注入.
  assert.equal(chamberRemoteKey(entries, '@dsh-chamber/never-installed'), 'chamberRemoteNotInjected')
})
