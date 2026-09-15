/**
 * WS upgrade forwarding (part 3 of the test/proxy split): stream-path
 * recognition, upstream-leg TCP keepalive arming, explicit upgrade
 * rejections, splice teardown on either leg, diagnostics counters,
 * registerTransport validation and handshake header filtering.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createInstanceProxy } from '../../src/instance-proxy.ts'
import { DEFAULT_DSH_START_PORT } from '../../src/spawn-dsh.ts'
import {
  fakeHttpRequest,
  fakeRequest,
  fakeResponse,
  fakeSocket,
  makeProxy,
  quietLogger,
} from '../support/proxy-fakes.ts'

// ---------------------------------------------------------------------------
// WS upgrade: stream-path recognition + forward shape
// ---------------------------------------------------------------------------

test('upgrade: only the remote.mux stream path forwards; other WS paths answer 404', async () => {
  const { proxy, upstream } = makeProxy()
  const muxSocket = fakeSocket()
  await proxy.handleUpgrade(
    fakeRequest('/api/i/local/api/remote.mux', 'GET', { upgrade: 'websocket', 'sec-websocket-key': 'k' }),
    muxSocket,
    Buffer.alloc(0),
  )
  assert.equal(upstream.calls.length, 1)
  const call = upstream.calls[0]
  // The upstream target stays http(s): node's http.request performs the
  // upgrade handshake itself and rejects ws: URLs (real-runtime regression:
  // ERR_INVALID_PROTOCOL on every forwarded WS upgrade).
  assert.equal(call.url.protocol, 'http:')
  assert.equal(call.url.pathname, '/api/remote.mux')
  assert.equal((call.options.headers as Record<string, string>).upgrade, 'websocket')
  assert.equal((call.options.headers as Record<string, string>).host, `127.0.0.1:${DEFAULT_DSH_START_PORT}`)

  proxy.registerTransport('ssh:rem', 'http://127.0.0.1:22003')
  const hostSocket = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/ssh-rem/api/remote.mux', 'GET'), hostSocket, Buffer.alloc(0))
  assert.equal(upstream.calls.length, 2)
  assert.equal(upstream.calls[1].url.pathname, '/api/remote.mux')

  // The deleted upstream downlinks (events.mux / events.host, dsh
  // 0.1.2-alpha.1) are now "other" paths: the proxy gate answers 404 instead
  // of forwarding a doomed upgrade.
  const other = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/events.mux', 'GET'), other, Buffer.alloc(0))
  assert.match(other.written, /404/)
  assert.ok(other.closed)
  assert.equal(upstream.calls.length, 2)
})

// ---------------------------------------------------------------------------
// S2: upstream-leg TCP keepalive (direct-http liveness)
// ---------------------------------------------------------------------------

/** An upgrade factory exposing every spliced upstream socket with its
 * TCP-keepalive configuration (S2: net.Socket.setKeepAlive recording). */
function keepAliveUpgradeFactory() {
  const upstreamSockets: any[] = []
  const fn: any = () => {
    const req = new EventEmitter() as any
    req.write = () => true
    req.end = () => {
      const upstreamRes = new EventEmitter() as any
      upstreamRes.statusCode = 101
      upstreamRes.headers = { upgrade: 'websocket', connection: 'Upgrade' }
      const upstreamSocket = new EventEmitter() as any
      upstreamSocket.write = () => true
      upstreamSocket.destroy = () => { upstreamSocket.destroyed = true }
      upstreamSocket.pipe = (target: unknown) => target
      upstreamSocket.keepAliveCalls = []
      upstreamSocket.setKeepAlive = (enable: boolean, delay?: number) => {
        upstreamSocket.keepAliveCalls.push({ enable, delay })
      }
      upstreamSockets.push(upstreamSocket)
      req.emit('upgrade', upstreamRes, upstreamSocket, Buffer.alloc(0))
    }
    return req
  }
  return { fn, upstreamSockets }
}

test('S2: a gateway-<id> WS upgrade arms TCP keepalive on the upstream leg before the splice', async () => {
  // gateway-<id> is the desktop's http(s) direct shape: no ssh keepalive
  // covers its upstream leg, so the proxy arms OS-level TCP keepalive so a
  // half-open connection eventually surfaces (or stays NAT-alive) instead of
  // freezing the splice silently.
  const factory = keepAliveUpgradeFactory()
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => 17510,
    httpRequest: factory.fn,
  })
  proxy.registerTransport('gateway:gw-s2', 'http://192.0.2.10:30801', undefined, { transport: 'http' })
  const down = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/gateway-gw-s2/api/remote.mux', 'GET'), down, Buffer.alloc(0))
  assert.equal(proxy.getDiagnostics().activeStreams, 1)
  assert.equal(factory.upstreamSockets.length, 1)
  assert.deepEqual(factory.upstreamSockets[0].keepAliveCalls, [{ enable: true, delay: 30_000 }])
})

test('S2: a dsh-<id> direct-http (non-loopback) WS upgrade also arms TCP keepalive', async () => {
  // M1 review fix: the discriminator is the RESOLVED upstream host, not the
  // source-id kind — a dsh-kind target with the http transport (registered at
  // a non-loopback base URL) has the same no-ssh-keepalive freeze class as a
  // gateway-kind direct target and must arm keepalive too.
  const factory = keepAliveUpgradeFactory()
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => 17510,
    httpRequest: factory.fn,
  })
  proxy.registerTransport('dsh:direct-http', 'http://192.0.2.20:30800', undefined, { transport: 'http' })
  const down = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/dsh-direct-http/api/remote.mux', 'GET'), down, Buffer.alloc(0))
  assert.equal(proxy.getDiagnostics().activeStreams, 1)
  assert.equal(factory.upstreamSockets.length, 1)
  assert.deepEqual(factory.upstreamSockets[0].keepAliveCalls, [{ enable: true, delay: 30_000 }])
})

test('S2: local / dsh-<id> / ssh-<id> WS upgrades leave the upstream leg keepalive-free', async () => {
  // ssh tunnels are covered by ssh keepalive and loopback (local) legs
  // cannot die half-open — those splices keep the documented no-heartbeat
  // design (proxy-forward.ts WS_PING_* note); the keepalive must only be
  // armed when tcpKeepAliveMs is configured.
  const factory = keepAliveUpgradeFactory()
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: factory.fn,
  })
  proxy.registerTransport('dsh:rem', 'http://127.0.0.1:22011')
  proxy.registerTransport('ssh:legacy', 'http://127.0.0.1:22012')
  const localSocket = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux', 'GET'), localSocket, Buffer.alloc(0))
  const dshSocket = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/dsh-rem/api/remote.mux', 'GET'), dshSocket, Buffer.alloc(0))
  const sshSocket = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/ssh-legacy/api/remote.mux', 'GET'), sshSocket, Buffer.alloc(0))
  assert.equal(proxy.getDiagnostics().activeStreams, 3)
  assert.equal(factory.upstreamSockets.length, 3)
  for (const upstreamSocket of factory.upstreamSockets) {
    assert.deepEqual(upstreamSocket.keepAliveCalls, [], 'local/dsh/ssh legs must not arm TCP keepalive')
  }
})

test('upgrade: a 503 instance resolution rejects the socket explicitly', async () => {
  const { proxy, upstream } = makeProxy({ state: 'stopped', port: null })
  const socket = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux', 'GET'), socket, Buffer.alloc(0))
  assert.match(socket.written, /503 Service Unavailable/)
  assert.match(socket.written, /instance_unavailable/)
  assert.ok(socket.closed)
  assert.equal(upstream.calls.length, 0)
})

test('upgrade: a non-101 upstream reply rejects explicitly (no unhandled stream)', async () => {
  // The instance answers the WS upgrade with a plain HTTP response (unknown
  // path / connection plugin not mounted): the proxy must drain-and-destroy
  // the reply and reject the client — never leave an unlistened stream whose
  // late RST would become an uncaught ECONNRESET.
  const upstream = fakeHttpRequest(() => ({
    response: { status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":"nope"}' },
  }))
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: upstream.fn,
  })
  const socket = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux', 'GET'), socket, Buffer.alloc(0))
  assert.match(socket.written, /502 Bad Gateway/)
  assert.match(socket.written, /upstream_failed/)
  assert.ok(socket.closed)
})

test('upgrade: an upstream connect failure rejects 502 upstream_failed (matches the HTTP path)', async () => {
  // Design 04 §4.2: upstream connect refusal → 502 upstream_failed — the WS
  // leg used to answer 503 instance_unavailable (reserved for "no tunnel /
  // not ready"), which misled operators into debugging the wrong layer.
  const upstream = fakeHttpRequest(() => ({ error: new Error('ECONNREFUSED 127.0.0.1:17510') }))
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => 17510,
    httpRequest: upstream.fn,
  })
  const socket = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux', 'GET'), socket, Buffer.alloc(0))
  assert.match(socket.written, /502 Bad Gateway/)
  assert.match(socket.written, /upstream_failed/)
  assert.ok(socket.closed)
})

// ---------------------------------------------------------------------------
// Splice teardown: peer-FIN write errors must be consumed, never uncaught
// ---------------------------------------------------------------------------

/** A captured-upgrade http.request factory: exposes the spliced upstream
 * socket so tests can drive its error/close events. */
function fakeUpgradeRequest() {
  let captured: EventEmitter | null = null
  const fn: any = () => {
    const req = new EventEmitter() as any
    req.write = () => true
    req.end = () => {
      const upstreamRes = new EventEmitter() as any
      upstreamRes.statusCode = 101
      upstreamRes.headers = { upgrade: 'websocket', connection: 'Upgrade' }
      const upstreamSocket = new EventEmitter() as any
      upstreamSocket.write = () => true
      upstreamSocket.pipe = (target: unknown) => target
      upstreamSocket.destroy = () => { upstreamSocket.destroyed = true }
      captured = upstreamSocket
      req.emit('upgrade', upstreamRes, upstreamSocket, Buffer.alloc(0))
    }
    return req
  }
  return { fn, get upstreamSocket() { return captured } }
}

test('upgrade splice: an error on the upstream end tears both down exactly once', async () => {
  const factory = fakeUpgradeRequest()
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: factory.fn,
  })
  const down = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux', 'GET'), down, Buffer.alloc(0))
  const up = factory.upstreamSocket
  assert.ok(up !== null)
  assert.equal(proxy.getDiagnostics().activeStreams, 1)
  // The peer FIN'd this socket (app exit): writeAfterFIN destroys with an
  // EPIPE "ended by the other party" 'error' — must be consumed and tear
  // down both ends, never surface as an uncaught exception.
  up.emit('error', new Error('This socket has been ended by the other party'))
  assert.equal(proxy.getDiagnostics().activeStreams, 0)
  assert.ok(down.closed)
  assert.ok((up as any).destroyed)
  // The destroy triggers 'close' on both ends: teardown stays single.
  up.emit('close')
  ;(down as unknown as EventEmitter).emit('close')
  assert.equal(proxy.getDiagnostics().activeStreams, 0)
})

test('upgrade splice: an error on the downstream end tears both down exactly once', async () => {
  const factory = fakeUpgradeRequest()
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: factory.fn,
  })
  const down = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux', 'GET'), down, Buffer.alloc(0))
  const up = factory.upstreamSocket
  assert.ok(up !== null)
  assert.equal(proxy.getDiagnostics().activeStreams, 1)
  ;(down as unknown as EventEmitter).emit('error', new Error('EPIPE'))
  assert.equal(proxy.getDiagnostics().activeStreams, 0)
  assert.ok((up as any).destroyed)
  assert.ok(down.closed)
  up.emit('close')
  ;(down as unknown as EventEmitter).emit('close')
  assert.equal(proxy.getDiagnostics().activeStreams, 0)
})

test('http stream: a client response error aborts the upstream, never uncaught', async () => {
  const captured = { signal: null as AbortSignal | null }
  const fn: any = (_url: URL, options: { signal: AbortSignal }) => {
    captured.signal = options.signal
    const request = new EventEmitter() as any
    request.write = () => true
    request.end = () => {
      request.emit('finish')
      const upstreamResponse = new EventEmitter() as any
      upstreamResponse.statusCode = 200
      upstreamResponse.headers = { 'content-type': 'text/event-stream' }
      upstreamResponse.destroy = () => upstreamResponse.emit('close')
      upstreamResponse.pause = () => {}
      upstreamResponse.resume = () => {}
      request.emit('response', upstreamResponse)
      upstreamResponse.emit('data', Buffer.from('data: live\n\n'))
    }
    return request
  }
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => 17510,
    httpRequest: fn,
  })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), res)
  assert.equal(captured.signal?.aborted, false)
  // The client connection died mid-stream (app exit): res.write becomes
  // writeAfterFIN — the 'error' must be consumed and abort the upstream.
  ;(res as unknown as EventEmitter).emit('error', new Error('This socket has been ended by the other party'))
  assert.equal(captured.signal?.aborted, true)
})

test('diagnostics: plain counters, no sensitive data', async () => {
  const { proxy } = makeProxy()
  proxy.registerTransport('ssh:srv2', 'http://127.0.0.1:22002')
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), res)
  const diag = proxy.getDiagnostics()
  assert.equal(diag.requests, 1)
  assert.equal(diag.failures, 0)
  assert.equal(diag.activeStreams, 0)
  assert.equal(diag.transports, 1)
  assert.equal(JSON.stringify(diag).includes('22002'), false)
})

test('registerTransport validates connectionId/baseUrl fail-loud', () => {
  const { proxy } = makeProxy()
  assert.throws(() => proxy.registerTransport('', 'http://127.0.0.1:1'), TypeError)
  assert.throws(() => proxy.registerTransport('ssh:x', 'not-a-url'), TypeError)
  assert.throws(() => proxy.registerTransport('ssh:x', 'file:///etc/passwd'), TypeError)
  assert.throws(() => proxy.registerTransport('ssh:x', 'https://127.0.0.1:8080'), /HTTP loopback origin/)
  assert.throws(() => proxy.registerTransport('ssh:x', 'http://example.com:8080'), /loopback/)
  assert.throws(() => proxy.registerTransport('ssh:x', 'http://127.0.0.1:8080/path'), /loopback/)
  assert.throws(() => proxy.registerTransport('dsh:x', 'http://127.0.0.1:8080', undefined, { transport: 'ftp' as 'http' }), /transport/)
  // dsh:<id> is the canonical dsh-kind connectionId; ssh:<id> is its legacy
  // alias; both are accepted, everything else fails.
  assert.throws(() => proxy.registerTransport('weird:x', 'http://127.0.0.1:1'), /connectionId/)
  proxy.registerTransport('dsh:ok', 'http://127.0.0.1:22001')
  proxy.registerTransport('ssh:ok', 'http://127.0.0.1:22002')
  proxy.registerTransport('gateway:ok', 'http://gw.example.com:8080')
  proxy.registerTransport('dsh:http-direct', 'https://dsh.example.com:8443', undefined, { transport: 'http' })
  // dsh targets (incl. the legacy ssh spelling) never accept headers.
  assert.throws(() => proxy.registerTransport('dsh:x', 'http://127.0.0.1:1', { authorization: 'Bearer s' }), /cannot inject/)
  assert.throws(() => proxy.registerTransport('ssh:x', 'http://127.0.0.1:1', { cookie: 'dsh_gateway_session=a' }), /cannot inject/)
})

test('registerTransport validates the SPKI pin: gateway+https only, 64-hex format (S23)', () => {
  const { proxy } = makeProxy()
  const PIN = 'a'.repeat(64)
  // gateway + https + valid pin → accepted.
  proxy.registerTransport('gateway:pinned', 'https://gw.example.com', undefined, { tls: { spkiPin: PIN } })
  // Format gate: ^[0-9a-fA-F]{64}$.
  assert.throws(() => proxy.registerTransport('gateway:x', 'https://gw.example.com', undefined, { tls: { spkiPin: 'xyz' } }), /spkiPin/)
  assert.throws(() => proxy.registerTransport('gateway:x', 'https://gw.example.com', undefined, { tls: { spkiPin: 'a'.repeat(63) } }), /spkiPin/)
  assert.throws(() => proxy.registerTransport('gateway:x', 'https://gw.example.com', undefined, { tls: { spkiPin: 'g'.repeat(64) } }), /spkiPin/)
  assert.throws(() => proxy.registerTransport('gateway:x', 'https://gw.example.com', undefined, { tls: { spkiPin: 'abc' } }), /spkiPin/)
  // http + pin → refused: TLS 保护不存在时 pin 无意义（S23）.
  assert.throws(() => proxy.registerTransport('gateway:x', 'http://gw.internal:8080', undefined, { tls: { spkiPin: PIN } }), /https gateway origin/)
  // dsh/ssh targets never carry a pin (no TLS trust decision to pin).
  assert.throws(() => proxy.registerTransport('dsh:x', 'http://127.0.0.1:1', undefined, { tls: { spkiPin: PIN } }), /cannot use an SPKI/)
  assert.throws(() => proxy.registerTransport('ssh:x', 'http://127.0.0.1:1', undefined, { tls: { spkiPin: PIN } }), /cannot use an SPKI/)
  // An empty opts bag is a no-op.
  proxy.registerTransport('gateway:noopts', 'https://gw.example.com', undefined, {})
  proxy.registerTransport('gateway:noopts2', 'https://gw.example.com', undefined, { tls: {} })
})

test('upgrade response forwards only WebSocket handshake headers', async () => {
  const upstream = fakeHttpRequest(() => ({
    upgrade: {
      status: 101,
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-accept': 'accepted',
        'set-cookie': 'secret=remote',
        'x-upstream-secret': 'nope',
      },
    },
  }))
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: upstream.fn,
  })
  const socket = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux', 'GET'), socket, Buffer.alloc(0))
  assert.match(socket.written, /sec-websocket-accept: accepted/i)
  assert.doesNotMatch(socket.written, /set-cookie|x-upstream-secret/i)
})

