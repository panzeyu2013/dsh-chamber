/**
 * P2-4 concurrency isolation (plan §4.12): per-connectionId fair shares inside
 * one instance proxy, the local HTTP reserve, and the long-RPC pool.
 *
 * Every assertion uses the REAL default constants (16 HTTP / 16 WS / 4 pending
 * per connection, 64/64/16 owner-wide, 8 long-RPC) unless the case explicitly
 * overrides a cap to make the GLOBAL ceiling observable in a small fixture.
 * Run with `node packages/control-plane/test/proxy/concurrency-isolation.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOCAL_HTTP_RESERVED_SLOTS,
  LONG_RPC_PATHS,
  MAX_CONCURRENT_HTTP_REQUESTS,
  MAX_CONCURRENT_HTTP_REQUESTS_PER_CONNECTION,
  MAX_CONCURRENT_LONG_RPC_REQUESTS,
  MAX_CONCURRENT_WS_STREAMS,
  MAX_CONCURRENT_WS_STREAMS_PER_CONNECTION,
  MAX_PENDING_WS_HANDSHAKES,
  MAX_PENDING_WS_HANDSHAKES_PER_CONNECTION,
} from '../../src/proxy-forward.ts'
import type { InstanceProxyDeps } from '../../src/instance-proxy.ts'
import {
  fakeHttpRequest,
  fakeRequest,
  fakeResponse,
  fakeSocket,
  proxyFor,
} from '../support/proxy-fakes.ts'

const LONG_RPC_URL = '/api/i/local/api/commands/execute'

/** A proxy whose upstream never answers the HTTP request (so the slot stays
 *  held until the test destroys the downstream response). */
function hangingHttpProxy(overrides: Partial<InstanceProxyDeps> = {}) {
  const upstream = fakeHttpRequest(() => undefined)
  const proxy = proxyFor(upstream.fn, { getLocalDshPort: () => 17510, upstreamTimeoutMs: 5_000, ...overrides })
  return { proxy, upstream }
}

/** A proxy whose upstream completes every WS upgrade with a 101. */
function acceptingUpgradeProxy() {
  const upstream = fakeHttpRequest(() => ({
    upgrade: { status: 101, headers: { upgrade: 'websocket', connection: 'Upgrade' } },
  }))
  const proxy = proxyFor(upstream.fn, { getLocalDshPort: () => 17510, upstreamTimeoutMs: 5_000 })
  return { proxy, upstream }
}

function refusalOf(body: string): { code?: string; details?: { kind?: string; scope?: string } } {
  return JSON.parse(body) as { code?: string; details?: { kind?: string; scope?: string } }
}

test('default isolation budget: per-connection fair shares sit below the owner-wide ceilings', () => {
  assert.equal(MAX_CONCURRENT_HTTP_REQUESTS, 64)
  assert.equal(MAX_CONCURRENT_WS_STREAMS, 64)
  assert.equal(MAX_PENDING_WS_HANDSHAKES, 16)
  assert.equal(MAX_CONCURRENT_HTTP_REQUESTS_PER_CONNECTION, 16)
  assert.equal(MAX_CONCURRENT_WS_STREAMS_PER_CONNECTION, 16)
  assert.equal(MAX_PENDING_WS_HANDSHAKES_PER_CONNECTION, 4)
  assert.equal(LOCAL_HTTP_RESERVED_SLOTS, 1)
  assert.equal(MAX_CONCURRENT_LONG_RPC_REQUESTS, 8)
  assert.deepEqual(LONG_RPC_PATHS, ['/api/commands/execute', '/api/archiveCleanup/purge'])
})

test('HTTP: a saturated instance (16) never 503s another instance; its 17th is refused', async () => {
  const { proxy } = hangingHttpProxy()
  proxy.registerTransport('dsh:a', 'http://127.0.0.1:22031')
  proxy.registerTransport('dsh:b', 'http://127.0.0.1:22032')
  const held: Array<ReturnType<typeof fakeResponse>> = []
  try {
    // Real default fair share: exactly 16 ordinary requests may occupy ONE
    // connection, even though the owner-wide ceiling is 64.
    for (let index = 0; index < MAX_CONCURRENT_HTTP_REQUESTS_PER_CONNECTION; index += 1) {
      const response = fakeResponse()
      await proxy.handleHttp(fakeRequest('/api/i/dsh-a/api/session/list'), response)
      assert.equal(response.status, null)
      held.push(response)
    }
    assert.equal(proxy.getDiagnostics().activeHttpRequests, 16)

    const seventeenth = fakeResponse()
    await proxy.handleHttp(fakeRequest('/api/i/dsh-a/api/session/list'), seventeenth)
    assert.equal(seventeenth.status, 503)
    const refusal = refusalOf(seventeenth.body)
    assert.equal(refusal.code, 'resource_exhausted')
    assert.deepEqual(refusal.details, { kind: 'http', scope: 'connection' })

    // The other instance has its OWN 16-slot share: the first instance's
    // saturation must not surface as a 503 here.
    const other = fakeResponse()
    await proxy.handleHttp(fakeRequest('/api/i/dsh-b/api/session/list'), other)
    assert.equal(other.status, null, 'instance B must not inherit instance A\'s saturation')
    assert.equal(proxy.getDiagnostics().activeHttpRequests, 17)
    held.push(other)
  } finally {
    for (const response of held) response.destroy()
  }
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 0, 'destroying the downstream releases every slot')
})

test('HTTP: the local instance keeps a reserved global slot when remote transports fill their share', async () => {
  // Small fixture so the owner-wide ceiling is reachable: 3 slots, 2 per
  // connection, 1 reserved for local. Registered transports may therefore use
  // only 2 global slots; local may use the last one.
  const { proxy } = hangingHttpProxy({ maxConcurrentHttpRequests: 3, maxConcurrentHttpRequestsPerConnection: 2 })
  proxy.registerTransport('dsh:a', 'http://127.0.0.1:22033')
  proxy.registerTransport('dsh:b', 'http://127.0.0.1:22034')
  const held: Array<ReturnType<typeof fakeResponse>> = []
  try {
    for (let index = 0; index < 2; index += 1) {
      const response = fakeResponse()
      await proxy.handleHttp(fakeRequest('/api/i/dsh-a/api/session/list'), response)
      assert.equal(response.status, null)
      held.push(response)
    }
    const remote = fakeResponse()
    await proxy.handleHttp(fakeRequest('/api/i/dsh-b/api/session/list'), remote)
    assert.equal(remote.status, 503)
    assert.deepEqual(refusalOf(remote.body).details, { kind: 'http', scope: 'global' })

    const local = fakeResponse()
    await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list'), local)
    assert.equal(local.status, null, 'the last global slot is reserved for local')
    assert.equal(proxy.getDiagnostics().activeHttpRequests, 3)
    held.push(local)

    // Per-connection fairness is still the more specific verdict for A.
    const sameConnection = fakeResponse()
    await proxy.handleHttp(fakeRequest('/api/i/dsh-a/api/session/list'), sameConnection)
    assert.equal(sameConnection.status, 503)
    assert.deepEqual(refusalOf(sameConnection.body).details, { kind: 'http', scope: 'connection' })
  } finally {
    for (const response of held) response.destroy()
  }
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 0)
})

test('HTTP: long-RPC requests occupy a SEPARATE pool and never starve ordinary unary', async () => {
  const { proxy } = hangingHttpProxy()
  const held: Array<ReturnType<typeof fakeResponse>> = []
  try {
    for (let index = 0; index < MAX_CONCURRENT_LONG_RPC_REQUESTS; index += 1) {
      const response = fakeResponse()
      await proxy.handleHttp(fakeRequest(LONG_RPC_URL, 'POST'), response)
      assert.equal(response.status, null)
      held.push(response)
    }
    let diagnostics = proxy.getDiagnostics()
    assert.equal(diagnostics.activeLongRpcRequests, MAX_CONCURRENT_LONG_RPC_REQUESTS)
    assert.equal(diagnostics.activeHttpRequests, 0, 'long-RPC work must not occupy an ordinary slot')
    assert.equal(diagnostics.longRpcRequests, MAX_CONCURRENT_LONG_RPC_REQUESTS)

    // The ordinary pool is still completely empty: an ordinary unary is admitted.
    const unary = fakeResponse()
    await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list'), unary)
    assert.equal(unary.status, null)
    diagnostics = proxy.getDiagnostics()
    assert.equal(diagnostics.activeHttpRequests, 1)
    assert.equal(diagnostics.activeLongRpcRequests, MAX_CONCURRENT_LONG_RPC_REQUESTS)
    held.push(unary)

    // The long-RPC pool binds at 8 independently of the ordinary pool.
    const ninth = fakeResponse()
    await proxy.handleHttp(fakeRequest(LONG_RPC_URL, 'POST'), ninth)
    assert.equal(ninth.status, 503)
    const refusal = refusalOf(ninth.body)
    assert.equal(refusal.code, 'resource_exhausted')
    assert.deepEqual(refusal.details, { kind: 'long-rpc', scope: 'global' })
    assert.equal(proxy.getDiagnostics().activeLongRpcRequests, MAX_CONCURRENT_LONG_RPC_REQUESTS)
  } finally {
    for (const response of held) response.destroy()
  }
  const diagnostics = proxy.getDiagnostics()
  assert.equal(diagnostics.activeLongRpcRequests, 0)
  assert.equal(diagnostics.activeHttpRequests, 0)
})

test('WS: pending handshakes are bounded per connection (4) and do not touch another instance', async () => {
  const upstream = fakeHttpRequest(() => undefined) // handshake never gets a verdict
  const proxy = proxyFor(upstream.fn, { getLocalDshPort: () => 17510, upstreamTimeoutMs: 5_000 })
  proxy.registerTransport('dsh:a', 'http://127.0.0.1:22035')
  proxy.registerTransport('dsh:b', 'http://127.0.0.1:22036')
  try {
    for (let index = 0; index < MAX_PENDING_WS_HANDSHAKES_PER_CONNECTION; index += 1) {
      const socket = fakeSocket()
      await proxy.handleUpgrade(fakeRequest('/api/i/dsh-a/api/remote.mux'), socket, Buffer.alloc(0))
      assert.equal(socket.closed, false)
    }
    assert.equal(proxy.getDiagnostics().pendingUpgrades, 4)

    const fifth = fakeSocket()
    await proxy.handleUpgrade(fakeRequest('/api/i/dsh-a/api/remote.mux'), fifth, Buffer.alloc(0))
    assert.equal(fifth.closed, true)
    assert.match(fifth.written, /503 Service Unavailable/)
    assert.match(fifth.written, /resource_exhausted/)
    assert.match(fifth.written, /"kind":"ws-pending"/)

    // Another instance still has its own pending pool.
    const other = fakeSocket()
    await proxy.handleUpgrade(fakeRequest('/api/i/dsh-b/api/remote.mux'), other, Buffer.alloc(0))
    assert.equal(other.closed, false)
    assert.equal(proxy.getDiagnostics().pendingUpgrades, 5)
  } finally {
    proxy.closeAllStreams()
  }
  assert.equal(proxy.getDiagnostics().pendingUpgrades, 0)
})

test('WS: the owner-wide live-stream ceiling still binds across connections', async () => {
  const limited = proxyFor(
    fakeHttpRequest(() => ({
      upgrade: { status: 101, headers: { upgrade: 'websocket', connection: 'Upgrade' } },
    })).fn,
    { getLocalDshPort: () => 17510, maxConcurrentWsStreams: 4, maxConcurrentWsStreamsPerConnection: 2 },
  )
  limited.registerTransport('dsh:a', 'http://127.0.0.1:22039')
  limited.registerTransport('dsh:b', 'http://127.0.0.1:22040')
  limited.registerTransport('dsh:c', 'http://127.0.0.1:22041')
  try {
    for (const id of ['a', 'a', 'b']) {
      const socket = fakeSocket()
      await limited.handleUpgrade(fakeRequest(`/api/i/dsh-${id}/api/remote.mux`), socket, Buffer.alloc(0))
      assert.match(socket.written, /101/)
    }
    // One of the four owner-wide slots is reserved for the local instance.
    const local = fakeSocket()
    await limited.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux'), local, Buffer.alloc(0))
    assert.match(local.written, /101/, 'the local instance keeps its reserved slot')
    const refused = fakeSocket()
    await limited.handleUpgrade(fakeRequest('/api/i/dsh-c/api/remote.mux'), refused, Buffer.alloc(0))
    assert.equal(refused.closed, true)
    assert.match(refused.written, /"kind":"ws"/)
    assert.match(refused.written, /"scope":"global"/)
  } finally {
    limited.closeAllStreams()
  }
})

test('WS: the owner-wide pending-handshake ceiling still binds across connections', async () => {
  const upstream = fakeHttpRequest(() => undefined)
  const proxy = proxyFor(upstream.fn, {
    getLocalDshPort: () => 17510,
    upstreamTimeoutMs: 5_000,
    maxPendingWsHandshakes: 2,
    maxPendingWsHandshakesPerConnection: 2,
  })
  proxy.registerTransport('dsh:a', 'http://127.0.0.1:22042')
  proxy.registerTransport('dsh:b', 'http://127.0.0.1:22043')
  proxy.registerTransport('dsh:c', 'http://127.0.0.1:22044')
  try {
    for (const id of ['a', 'b']) {
      const socket = fakeSocket()
      await proxy.handleUpgrade(fakeRequest(`/api/i/dsh-${id}/api/remote.mux`), socket, Buffer.alloc(0))
      assert.equal(socket.closed, false)
    }
    const refused = fakeSocket()
    await proxy.handleUpgrade(fakeRequest('/api/i/dsh-c/api/remote.mux'), refused, Buffer.alloc(0))
    assert.equal(refused.closed, true)
    assert.match(refused.written, /"kind":"ws-pending"/)
    assert.match(refused.written, /"scope":"global"/)
  } finally {
    proxy.closeAllStreams()
  }
})

test('WS: live streams are bounded per connection (16); another instance keeps its own share', async () => {
  const { proxy } = acceptingUpgradeProxy()
  proxy.registerTransport('dsh:a', 'http://127.0.0.1:22037')
  proxy.registerTransport('dsh:b', 'http://127.0.0.1:22038')
  try {
    for (let index = 0; index < MAX_CONCURRENT_WS_STREAMS_PER_CONNECTION; index += 1) {
      const socket = fakeSocket()
      await proxy.handleUpgrade(fakeRequest('/api/i/dsh-a/api/remote.mux'), socket, Buffer.alloc(0))
      assert.match(socket.written, /101/)
    }
    assert.equal(proxy.getDiagnostics().activeStreams, 16)

    const seventeenth = fakeSocket()
    await proxy.handleUpgrade(fakeRequest('/api/i/dsh-a/api/remote.mux'), seventeenth, Buffer.alloc(0))
    assert.equal(seventeenth.closed, true)
    assert.match(seventeenth.written, /503 Service Unavailable/)
    assert.match(seventeenth.written, /"kind":"ws"/)
    assert.match(seventeenth.written, /"scope":"connection"/)

    const other = fakeSocket()
    await proxy.handleUpgrade(fakeRequest('/api/i/dsh-b/api/remote.mux'), other, Buffer.alloc(0))
    assert.match(other.written, /101/)
    assert.equal(proxy.getDiagnostics().activeStreams, 17)
  } finally {
    proxy.closeAllStreams()
  }
  assert.equal(proxy.getDiagnostics().activeStreams, 0)
})
