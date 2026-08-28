/**
 * Instance-proxy unit tests (fake upstream injection): path mapping
 * (local / ssh-<id>), unregistered-tunnel 503, prefix stripping, response
 * header whitelist, body caps, and WS stream-path recognition. The outbound
 * request factory (deps.httpRequest) is injected — no real dsh, no fixed
 * ports. No authentication: /api/i/* is directly reachable (v1).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  createInstanceProxy,
  parseInstancePath,
  MAX_REQUEST_BODY_BYTES,
} from '../src/instance-proxy.ts'
import { startWsHeartbeat } from '../src/ws-heartbeat.ts'
import { DEFAULT_DSH_START_PORT } from '../src/spawn-dsh.ts'
import type { InstanceProxy, ProxyRequest, ProxyResponse, ProxySocket } from '../src/instance-proxy.ts'

const quietLogger = { log: () => {}, warn: () => {}, error: () => {} }

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A fake outbound http.request: records every call and plays behaviors. */
interface UpstreamBehavior {
  response?: { status: number; headers: Record<string, string>; body?: string | null }
  upgrade?: { status: number; headers: Record<string, string>; head?: Buffer }
  error?: Error
}

interface UpstreamCall {
  url: URL
  options: Record<string, unknown>
  body: Buffer[]
}

function fakeHttpRequest(handler: (url: URL, options: any) => UpstreamBehavior | undefined) {
  const calls: UpstreamCall[] = []
  const fn: any = (url: URL, options: any) => {
    const call: UpstreamCall = { url, options, body: [] }
    calls.push(call)
    const req = new EventEmitter() as any
    req.write = (chunk: Buffer) => {
      call.body.push(Buffer.from(chunk))
      return true
    }
    req.end = () => {
      const behavior = handler(url, options)
      if (behavior === undefined) return // hang
      if (behavior.error !== undefined) {
        // Synchronous emission: the proxy registers its handlers before
        // end(), so the verdict lands before handleHttp resolves.
        req.emit('error', behavior.error)
        return
      }
      if (behavior.upgrade !== undefined) {
        const upstreamRes = new EventEmitter() as any
        upstreamRes.statusCode = behavior.upgrade.status
        upstreamRes.headers = behavior.upgrade.headers
        const upstreamSocket = new EventEmitter() as any
        upstreamSocket.write = () => true
        upstreamSocket.pipe = (target: unknown) => target
        upstreamSocket.destroy = () => {}
        req.emit('upgrade', upstreamRes, upstreamSocket, behavior.upgrade.head ?? Buffer.alloc(0))
        return
      }
      if (behavior.response !== undefined) {
        const res = new EventEmitter() as any
        res.statusCode = behavior.response.status
        res.headers = behavior.response.headers
        res.destroy = () => res.emit('close')
        req.emit('response', res)
        if (typeof behavior.response.body === 'string') {
          res.emit('data', Buffer.from(behavior.response.body))
          res.emit('end')
        }
        return
      }
    }
    const signal: AbortSignal | undefined = options?.signal
    if (signal !== undefined) {
      if (signal.aborted) process.nextTick(() => req.emit('error', new Error('Aborted')))
      else signal.addEventListener('abort', () => req.emit('error', new Error('Aborted')), { once: true })
    }
    return req
  }
  return { fn, calls }
}

/** A fake incoming request: url/method/headers + an async-iterable body. */
function fakeRequest(url: string, method = 'GET', headers: Record<string, string> = {}, body?: string): ProxyRequest {
  const emitter = new EventEmitter()
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return Object.assign(emitter, {
    url,
    method,
    headers,
    async * [Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }) as unknown as ProxyRequest
}

/** A fake response recording writeHead/end/write calls. */
function fakeResponse(): ProxyResponse & { status: number | null; headers: Record<string, unknown>; body: string } {
  const emitter = new EventEmitter()
  const res = Object.assign(emitter, {
    status: null as number | null,
    headers: {} as Record<string, unknown>,
    body: '',
    headersSent: false,
    writeHead(status: number, headers?: Record<string, unknown>) {
      this.status = status
      this.headers = { ...(headers ?? {}) }
      this.headersSent = true
      return undefined
    },
    write(chunk: unknown) {
      this.body += String(chunk)
      return true
    },
    end(payload?: unknown) {
      if (payload !== undefined) this.body += String(payload)
      return undefined
    },
    setHeader() {},
    destroy() {},
  })
  return res as any
}

/** A fake upgrade socket recording writes (string view + raw buffers). */
function fakeSocket(): ProxySocket & { written: string; writtenBuffers: Buffer[]; closed: boolean } {
  const emitter = new EventEmitter()
  const socket = Object.assign(emitter, {
    written: '',
    writtenBuffers: [] as Buffer[],
    closed: false,
    write(data: unknown) {
      this.written += String(data)
      this.writtenBuffers.push(Buffer.from(data as Buffer))
      return true
    },
    end() { this.closed = true; return undefined },
    destroy() { this.closed = true },
    pipe(target: unknown) { return target },
  })
  return socket as any
}

/** A default local-instance deps set. */
function makeProxy(options: { state?: string; port?: number | null } = {}) {
  const { state = 'ready', port = DEFAULT_DSH_START_PORT } = options
  const upstream = fakeHttpRequest(() => ({
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
  }))
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => state,
    getLocalDshPort: () => port,
    httpRequest: upstream.fn,
  })
  return { proxy, upstream }
}

// ---------------------------------------------------------------------------
// Path parsing
// ---------------------------------------------------------------------------

test('parseInstancePath maps local and ssh-<id> and strips the prefix', () => {
  assert.deepEqual(parseInstancePath('/api/i/local/api/session.list'), { id: 'local', rest: '/api/session.list', search: '' })
  assert.deepEqual(parseInstancePath('/api/i/ssh-srv-7/api/events.host?x=1'), { id: 'ssh-srv-7', rest: '/api/events.host', search: '?x=1' })
  assert.deepEqual(parseInstancePath('/api/i/local'), { id: 'local', rest: '/', search: '' })
  assert.equal(parseInstancePath('/api/i/ssh-/x'), null)
  assert.equal(parseInstancePath(`/api/i/ssh-${'x'.repeat(65)}/x`), null)
  assert.equal(parseInstancePath('/api/i/other/api/session.list'), null)
  assert.equal(parseInstancePath('/api/projects/p1/runtime/api/session.list'), null)
  assert.equal(parseInstancePath('/api/i'), null)
})

// ---------------------------------------------------------------------------
// Path mapping: local + ssh-<id>
// ---------------------------------------------------------------------------

test('local mapping: prefix stripped, forwarded to the derived baseUrl with the instance Host', async () => {
  const { proxy, upstream } = makeProxy({ state: 'ready', port: DEFAULT_DSH_START_PORT })
  const res = fakeResponse()
  await proxy.handleHttp(
    fakeRequest('/api/i/local/api/session.list?foo=bar', 'POST', { 'content-type': 'application/json' }, '{"rpcId":"r1","method":"session.list"}'),
    res,
  )
  assert.equal(res.status, 200)
  assert.equal(upstream.calls.length, 1)
  const call = upstream.calls[0]
  assert.equal(call.url.origin, `http://127.0.0.1:${DEFAULT_DSH_START_PORT}`)
  assert.equal(call.url.pathname, '/api/session.list')
  assert.equal(call.url.search, '?foo=bar')
  assert.equal(call.options.method, 'POST')
  assert.equal((call.options.headers as Record<string, string>).host, `127.0.0.1:${DEFAULT_DSH_START_PORT}`)
  assert.equal(call.body.join(''), '{"rpcId":"r1","method":"session.list"}')
})

test('request convergence strips framing and proxy headers, then emits the accepted body length', async () => {
  const { proxy, upstream } = makeProxy({ state: 'ready', port: DEFAULT_DSH_START_PORT })
  const res = fakeResponse()
  await proxy.handleHttp(
    fakeRequest('/api/i/local/api/upload', 'POST', {
      'content-length': '999',
      connection: 'keep-alive',
      expect: '100-continue',
      'proxy-authenticate': 'secret',
      te: 'trailers',
      trailer: 'x-secret',
    }, 'abc'),
    res,
  )
  const headers = upstream.calls[0].options.headers as Record<string, string>
  assert.equal(headers['content-length'], '3')
  assert.equal(headers.connection, undefined)
  assert.equal(headers.expect, undefined)
  assert.equal(headers['proxy-authenticate'], undefined)
  assert.equal(headers.te, undefined)
  assert.equal(headers.trailer, undefined)
})

test('ssh-<id> mapping: registered transport baseUrl wins; unregistered answers 503', async () => {
  const { proxy, upstream } = makeProxy()
  proxy.registerTransport('ssh:srv1', 'http://127.0.0.1:22001')
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/ssh-srv1/api/session.list', 'GET'), res)
  assert.equal(res.status, 200)
  assert.equal(upstream.calls.length, 1)
  assert.equal(upstream.calls[0].url.origin, 'http://127.0.0.1:22001')
  assert.equal(upstream.calls[0].url.pathname, '/api/session.list')

  // Unregistered ssh id → explicit 503 instance_unavailable (proxy honesty).
  const missing = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/ssh-ghost/api/session.list', 'GET'), missing)
  assert.equal(missing.status, 503)
  assert.equal(JSON.parse(missing.body).code, 'instance_unavailable')
  assert.equal(upstream.calls.length, 1)

  // Unregister → the tunnel is gone, the instance becomes unavailable.
  proxy.unregisterTransport('ssh:srv1')
  const gone = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/ssh-srv1/api/session.list', 'GET'), gone)
  assert.equal(gone.status, 503)
  assert.equal(JSON.parse(gone.body).code, 'instance_unavailable')
})

test('local instance not ready → explicit 503, never a silent empty success', async () => {
  const { proxy, upstream } = makeProxy({ state: 'starting', port: null })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session.list', 'GET'), res)
  assert.equal(res.status, 503)
  assert.equal(JSON.parse(res.body).code, 'instance_unavailable')
  assert.equal(upstream.calls.length, 0)
})

test('unknown id answers 404 instance_not_found', async () => {
  const { proxy, upstream } = makeProxy()
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/foo/api/session.list', 'GET'), res)
  assert.equal(res.status, 404)
  assert.equal(JSON.parse(res.body).code, 'instance_not_found')
  assert.equal(upstream.calls.length, 0)
})

// ---------------------------------------------------------------------------
// Response convergence
// ---------------------------------------------------------------------------

test('response header whitelist: only content-type/cache-control/x-* ride through', async () => {
  const upstream = fakeHttpRequest(() => ({
    response: {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-next-cursor': 'abc',
        'x-ratelimit-limit': '10',
        'set-cookie': 'leak=1',
        'x-custom-secret': 'nope',
      },
      body: '{}',
    },
  }))
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: upstream.fn,
  })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session.list', 'GET'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(Object.keys(res.headers).sort(), ['cache-control', 'content-type', 'x-next-cursor', 'x-ratelimit-limit'])
  assert.equal(res.headers['set-cookie'], undefined)
  assert.equal(res.headers['x-custom-secret'], undefined)
})

test('http: accept-encoding is stripped upstream — the proxy never negotiates compression (M3b)', async () => {
  const { proxy, upstream } = makeProxy()
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session.list', 'GET', { 'accept-encoding': 'gzip, br' }), res)
  const headers = upstream.calls[0].options.headers as Record<string, string>
  assert.equal(headers['accept-encoding'], undefined, 'the upstream must receive identity')
  assert.equal(res.status, 200)
})

test('http: a content-encoding upstream header rides through so the browser decodes correctly (M3b)', async () => {
  const upstream = fakeHttpRequest(() => ({
    response: { status: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: 'gzipped-bytes' },
  }))
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: upstream.fn,
  })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session.list', 'GET'), res)
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-encoding'], 'gzip', 'the compression label must never be dropped')
})

test('request body over the 300MiB cap answers 413 body_too_large', async () => {
  const { proxy, upstream } = makeProxy()
  const res = fakeResponse()
  await proxy.handleHttp(
    fakeRequest('/api/i/local/api/session.list', 'POST', { 'content-length': String(MAX_REQUEST_BODY_BYTES + 1) }, 'x'),
    res,
  )
  assert.equal(res.status, 413)
  assert.equal(JSON.parse(res.body).code, 'body_too_large')
  assert.equal(upstream.calls.length, 0)
})

test('upstream connect failure answers 502 upstream_failed (masked)', async () => {
  const upstream = fakeHttpRequest(() => ({ error: new Error(`ECONNREFUSED 127.0.0.1:${DEFAULT_DSH_START_PORT}`) }))
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: upstream.fn,
  })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session.list', 'GET'), res)
  assert.equal(res.status, 502)
  assert.equal(JSON.parse(res.body).code, 'upstream_failed')
  // Masked: the upstream host:port never rides the wire.
  assert.ok(!res.body.includes(String(DEFAULT_DSH_START_PORT)))
})

// ---------------------------------------------------------------------------
// WS upgrade: stream-path recognition + forward shape
// ---------------------------------------------------------------------------

test('upgrade: only the two downlink stream paths forward; others answer 404', async () => {
  const { proxy, upstream } = makeProxy()
  const muxSocket = fakeSocket()
  await proxy.handleUpgrade(
    fakeRequest('/api/i/local/api/events.mux', 'GET', { upgrade: 'websocket', 'sec-websocket-key': 'k' }),
    muxSocket,
    Buffer.alloc(0),
  )
  assert.equal(upstream.calls.length, 1)
  const call = upstream.calls[0]
  // The upstream target stays http(s): node's http.request performs the
  // upgrade handshake itself and rejects ws: URLs (real-runtime regression:
  // ERR_INVALID_PROTOCOL on every forwarded WS upgrade).
  assert.equal(call.url.protocol, 'http:')
  assert.equal(call.url.pathname, '/api/events.mux')
  assert.equal((call.options.headers as Record<string, string>).upgrade, 'websocket')
  assert.equal((call.options.headers as Record<string, string>).host, `127.0.0.1:${DEFAULT_DSH_START_PORT}`)

  proxy.registerTransport('ssh:rem', 'http://127.0.0.1:22003')
  const hostSocket = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/ssh-rem/api/events.host', 'GET'), hostSocket, Buffer.alloc(0))
  assert.equal(upstream.calls.length, 2)
  assert.equal(upstream.calls[1].url.pathname, '/api/events.host')

  const other = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/events.other', 'GET'), other, Buffer.alloc(0))
  assert.match(other.written, /404/)
  assert.ok(other.closed)
  assert.equal(upstream.calls.length, 2)
})

test('upgrade: a 503 instance resolution rejects the socket explicitly', async () => {
  const { proxy, upstream } = makeProxy({ state: 'stopped', port: null })
  const socket = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/events.mux', 'GET'), socket, Buffer.alloc(0))
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
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/events.mux', 'GET'), socket, Buffer.alloc(0))
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
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/events.mux', 'GET'), down, Buffer.alloc(0))
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
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/events.mux', 'GET'), down, Buffer.alloc(0))
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
  const { proxy, upstream } = makeProxy()
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session.list', 'GET'), res)
  assert.equal(upstream.calls.length, 1)
  const signal = upstream.calls[0].options.signal as AbortSignal
  assert.equal(signal.aborted, false)
  // The client connection died mid-stream (app exit): res.write becomes
  // writeAfterFIN — the 'error' must be consumed and abort the upstream.
  ;(res as unknown as EventEmitter).emit('error', new Error('This socket has been ended by the other party'))
  assert.equal(signal.aborted, true)
})

test('diagnostics: plain counters, no sensitive data', async () => {
  const { proxy } = makeProxy()
  proxy.registerTransport('ssh:srv2', 'http://127.0.0.1:22002')
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session.list', 'GET'), res)
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
  assert.throws(() => proxy.registerTransport('ssh:x', 'http://example.com:8080'), /loopback/)
  assert.throws(() => proxy.registerTransport('ssh:x', 'http://127.0.0.1:8080/path'), /loopback/)
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
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/events.mux', 'GET'), socket, Buffer.alloc(0))
  assert.match(socket.written, /sec-websocket-accept: accepted/i)
  assert.doesNotMatch(socket.written, /set-cookie|x-upstream-secret/i)
})

// ---------------------------------------------------------------------------
// Upstream timeout (design 03 §3.3: silence → explicit 504, never a hang)
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

test('http: an upstream that never answers headers → explicit 504 upstream_timeout', async () => {
  const upstream = fakeHttpRequest(() => undefined) // hang: no response, no error
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: upstream.fn,
    upstreamTimeoutMs: 40,
  })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session.list', 'GET'), res)
  assert.equal(res.status, null) // not answered synchronously — the timeout decides
  await sleep(80)
  assert.equal(res.status, 504)
  assert.equal(res.headers['content-type'], 'application/json')
  assert.ok(res.body.includes('upstream_timeout'))
  assert.ok(res.body.includes('timed out'))
  // The hung upstream was aborted, not left streaming into the void.
  assert.equal((upstream.calls[0].options.signal as AbortSignal).aborted, true)
})

test('http: a responding upstream stays unaffected by the timeout guard', async () => {
  const { proxy } = makeProxy()
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session.list', 'GET'), res)
  await sleep(80)
  assert.equal(res.status, 200) // fast upstream: timeout guard cleared, no 504
})

test('http: concurrent request budget rejects excess work before opening another upstream', async () => {
  const upstream = fakeHttpRequest(() => undefined)
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: upstream.fn,
    maxConcurrentHttpRequests: 1,
    upstreamTimeoutMs: 30,
  })
  const first = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session.list', 'GET'), first)
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 1)
  const second = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session.list', 'GET'), second)
  assert.equal(second.status, 503)
  assert.match(second.body, /resource_exhausted/)
  assert.equal(upstream.calls.length, 1)
  await sleep(50)
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 0)
})

test('http: a stalled client upload releases its body and request budgets with 408', async () => {
  const upstream = fakeHttpRequest(() => ({
    response: { status: 200, headers: {}, body: 'unexpected' },
  }))
  const emitter = new EventEmitter()
  let iteratorReturned = false
  const stalled = Object.assign(emitter, {
    url: '/api/i/local/api/upload',
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<Buffer>>(() => {}),
        return: async () => {
          iteratorReturned = true
          return { done: true, value: undefined }
        },
      }
    },
  }) as unknown as ProxyRequest
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: upstream.fn,
    clientBodyIdleTimeoutMs: 30,
  })
  const response = fakeResponse()
  await proxy.handleHttp(stalled, response)
  assert.equal(response.status, 408)
  assert.match(response.body, /request_timeout/)
  assert.equal(upstream.calls.length, 0)
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 0)
  assert.equal(proxy.getDiagnostics().bufferedRequestBytes, 0)
  assert.equal(iteratorReturned, true)
})

test('http: non-SSE timeout is idle-based and re-arms on every body chunk', async () => {
  const fn: any = () => {
    const req = new EventEmitter() as any
    req.write = () => true
    req.end = () => {
      const res = new EventEmitter() as any
      res.statusCode = 200
      res.headers = { 'content-type': 'application/json' }
      res.destroy = () => {}
      res.pause = () => {}
      res.resume = () => {}
      req.emit('response', res)
      let count = 0
      const interval = setInterval(() => {
        count += 1
        res.emit('data', Buffer.from('x'))
        if (count === 4) {
          clearInterval(interval)
          res.emit('end')
        }
      }, 20)
    }
    return req
  }
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: fn,
    upstreamTimeoutMs: 35,
  })
  const response = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/slow', 'GET'), response)
  await sleep(110)
  assert.equal(response.status, 200)
  assert.equal(response.body, 'xxxx')
  assert.equal(proxy.getDiagnostics().failures, 0)
})

test('upgrade: a WebSocket handshake that never completes → explicit 504 on the socket', async () => {
  const upstream = fakeHttpRequest(() => undefined) // hang
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: upstream.fn,
    upstreamTimeoutMs: 40,
  })
  const socket = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/events.mux'), socket, Buffer.alloc(0))
  await sleep(80)
  assert.ok(socket.closed)
  assert.ok(socket.written.includes('504'), `socket got: ${socket.written}`)
  assert.ok(socket.written.includes('upstream_timeout'))
})

// ---------------------------------------------------------------------------
// WebSocket heartbeat (design 14 extension: sleep/wake silent-death recovery)
// ---------------------------------------------------------------------------

/** Build a complete pong frame (opcode 0xA) to feed the heartbeat scanners. */
function pongFrame(payload: Buffer, masked: boolean): Buffer {
  const header = Buffer.allocUnsafe(masked ? 6 : 2)
  header[0] = 0x80 | 0xa
  if (!masked) {
    header[1] = payload.length
    return Buffer.concat([header, payload])
  }
  header[1] = 0x80 | payload.length
  const key = Buffer.from([1, 2, 3, 4])
  key.copy(header, 2)
  const maskedPayload = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) maskedPayload[i] = payload[i] ^ key[i % 4]
  return Buffer.concat([header, maskedPayload])
}

/** An upgrade factory that exposes the spliced upstream socket and records its writes. */
function heartbeatUpgradeFactory() {
  let captured: any = null
  const fn: any = () => {
    const req = new EventEmitter() as any
    req.write = () => true
    req.end = () => {
      const upstreamRes = new EventEmitter() as any
      upstreamRes.statusCode = 101
      upstreamRes.headers = { upgrade: 'websocket', connection: 'Upgrade' }
      const upstreamSocket = new EventEmitter() as any
      upstreamSocket.writes = []
      upstreamSocket.write = (data: unknown) => {
        upstreamSocket.writes.push(Buffer.from(data as Buffer))
        return true
      }
      upstreamSocket.destroy = () => { upstreamSocket.destroyed = true }
      upstreamSocket.pipe = (target: unknown) => target
      captured = upstreamSocket
      req.emit('upgrade', upstreamRes, upstreamSocket, Buffer.alloc(0))
    }
    return req
  }
  return { fn, get upstreamSocket() { return captured } }
}

test('heartbeat: pings the browser only and keeps a ponging stream alive', async () => {
  const factory = heartbeatUpgradeFactory()
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: factory.fn,
    wsPingIntervalMs: 20,
    wsPingMissesBeforeTeardown: 1,
  })
  const down = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/events.mux', 'GET'), down, Buffer.alloc(0))
  const up = factory.upstreamSocket
  assert.ok(up !== null)
  assert.equal(proxy.getDiagnostics().activeStreams, 1)

  // The browser answers with masked pongs (client→server).
  const respond = () => {
    ;(down as unknown as EventEmitter).emit('data', pongFrame(Buffer.from('down'), true))
  }
  respond() // answer the immediate first ping
  const responder = setInterval(respond, 15)
  await sleep(120) // ~6 ping cycles
  clearInterval(responder)

  assert.equal(proxy.getDiagnostics().activeStreams, 1, 'a ponging stream must stay spliced')
  assert.equal(down.closed, false)
  assert.equal((up as any).destroyed, undefined)
  // Downstream pings are unmasked (the proxy is the ws server to the browser);
  // the upstream leg deliberately gets NO pings (SSH keepalive / socket
  // events own its liveness).
  const downPing = down.writtenBuffers.find(chunk => chunk.length >= 2 && chunk[0] === 0x89)
  assert.ok(downPing !== undefined, 'downstream got a ping frame')
  assert.equal(downPing[1] & 0x80, 0, 'downstream pings are unmasked (server role)')
  const upPing = up.writes.find((chunk: Buffer) => chunk.length >= 2 && chunk[0] === 0x89)
  assert.equal(upPing, undefined, 'upstream must receive no pings (downstream-only heartbeat)')
})

test('heartbeat: missed pongs tear the splice down so the browser reconnects', async () => {
  const factory = heartbeatUpgradeFactory()
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: factory.fn,
    wsPingIntervalMs: 20,
    wsPingMissesBeforeTeardown: 1,
  })
  const down = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/events.host', 'GET'), down, Buffer.alloc(0))
  const up = factory.upstreamSocket
  assert.ok(up !== null)
  assert.equal(proxy.getDiagnostics().activeStreams, 1)
  // No browser pongs: the leg is silently dead — the heartbeat must tear it down.
  await sleep(90)
  assert.equal(proxy.getDiagnostics().activeStreams, 0)
  assert.equal(down.closed, true, 'the browser socket must be closed (pump reconnects)')
  assert.equal((up as any).destroyed, true, 'the upstream socket must be destroyed')
})

test('heartbeat: teardown by other means stops the heartbeat (no stray pings after)', async () => {
  const factory = heartbeatUpgradeFactory()
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: factory.fn,
    wsPingIntervalMs: 20,
    wsPingMissesBeforeTeardown: 1,
  })
  const down = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/events.mux', 'GET'), down, Buffer.alloc(0))
  const up = factory.upstreamSocket
  assert.ok(up !== null)
  const pingsBefore = down.writtenBuffers.filter(chunk => chunk.length >= 2 && chunk[0] === 0x89).length
  ;(down as unknown as EventEmitter).emit('error', new Error('EPIPE')) // browser-side splice error
  assert.equal(proxy.getDiagnostics().activeStreams, 0)
  await sleep(70)
  const pingsAfter = down.writtenBuffers.filter(chunk => chunk.length >= 2 && chunk[0] === 0x89).length
  assert.equal(pingsAfter, pingsBefore, 'no pings may be injected after teardown')
})

test('heartbeat: a throwing write self-cleans (onDead once, interval stopped)', async () => {
  // The first ping write fails synchronously (socket already destroyed): the
  // heartbeat must tear itself down — onDead exactly once, never an armed
  // interval firing onDead every cycle.
  const down = new EventEmitter() as any
  down.write = () => { throw new Error('socket destroyed') }
  let dead = 0
  const heartbeat = startWsHeartbeat({
    downstream: down,
    intervalMs: 20,
    missesBeforeTeardown: 1,
    onDead: () => { dead += 1 },
  })
  await sleep(100)
  assert.equal(dead, 1, 'onDead must fire exactly once (the interval is stopped)')
  heartbeat.stop()
})

// ---------------------------------------------------------------------------
// Real-Node integration regression (2026-08): IncomingMessage 'close' fires
// as soon as the request body is consumed — immediately for a bodyless
// GET/HEAD — NOT on client disconnect. The proxy's disconnect detection must
// therefore hang off the RESPONSE leg (res 'close' + writableEnded) and the
// upgrade path off the raw socket; a req 'close' listener would abort every
// bodyless forward / WS handshake right after it starts (fake-request unit
// tests never exercise real Node stream semantics — this block does).
// ---------------------------------------------------------------------------

import { createServer, get, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'

/** Boot a real proxy instance + real upstream, returns their ports. */
function bootRealProxy(): Promise<{ proxyPort: number; upstreamPort: number; upstream: ReturnType<typeof createServer>; server: ReturnType<typeof createServer> }> {
  return new Promise((resolve) => {
    const upstream = createServer((req, res) => {
      res.setHeader('content-type', 'text/plain')
      res.end(`upstream-ok:${req.method}`)
    })
    const proxy = createInstanceProxy({
      logger: quietLogger,
      getLocalState: () => 'ready',
      getLocalDshPort: () => upstreamPort,
    })
    let upstreamPort = 0
    let server: ReturnType<typeof createServer> | null = null
    upstream.listen(0, '127.0.0.1', () => {
      upstreamPort = (upstream.address() as AddressInfo).port
      server = createServer((req, res) => { void proxy.handleHttp(req as any, res as any) })
      server.on('upgrade', (req, socket, head) => { void proxy.handleUpgrade(req as any, socket as any, head) })
      server.listen(0, '127.0.0.1', () => {
        resolve({ proxyPort: (server!.address() as AddressInfo).port, upstreamPort, upstream, server: server! })
      })
    })
  })
}

test('real Node streams: bodyless GET forwards (req close must not abort the upstream)', async () => {
  const { proxyPort, upstream, server } = await bootRealProxy()
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = get(`http://127.0.0.1:${proxyPort}/api/i/local/some/path?q=1`, res => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => resolve(data))
      })
      req.on('error', reject)
    })
    assert.equal(body, 'upstream-ok:GET')
  } finally {
    server.close()
    upstream.close()
  }
})

test('real Node streams: bodyless HEAD forwards', async () => {
  const { proxyPort, upstream, server } = await bootRealProxy()
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${proxyPort}/api/i/local/head-target`, { method: 'HEAD' }, res => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 200)
  } finally {
    server.close()
    upstream.close()
  }
})

test('real Node streams: POST with body still forwards', async () => {
  const { proxyPort, upstream, server } = await bootRealProxy()
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${proxyPort}/api/i/local/post-target`, { method: 'POST' }, res => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => resolve(data))
      })
      req.on('error', reject)
      req.end('payload')
    })
    assert.equal(body, 'upstream-ok:POST')
  } finally {
    server.close()
    upstream.close()
  }
})

test('real Node streams: WS upgrade handshake is not aborted by req close', async () => {
  const upstream = createServer(() => {})
  upstream.on('upgrade', (_req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    )
    socket.end()
  })
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => upstreamPort,
  })
  let upstreamPort = 0
  let server: ReturnType<typeof createServer> | null = null
  await new Promise<void>((resolve) => {
    upstream.listen(0, '127.0.0.1', () => {
      upstreamPort = (upstream.address() as AddressInfo).port
      server = createServer((req, res) => { void proxy.handleHttp(req as any, res as any) })
      server.on('upgrade', (req, socket, head) => { void proxy.handleUpgrade(req as any, socket as any, head) })
      server.listen(0, '127.0.0.1', () => resolve())
    })
  })
  try {
    const got101 = await new Promise<boolean>((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: (server!.address() as AddressInfo).port,
        path: '/api/i/local/api/events.mux',
        headers: {
          connection: 'upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
        },
      })
      req.on('upgrade', () => {
        req.destroy()
        resolve(true)
      })
      req.on('response', () => resolve(false))
      req.on('error', () => resolve(false))
      req.end()
    })
    assert.equal(got101, true, 'the WS handshake must reach the upstream (req close must not abort it)')
  } finally {
    server!.close()
    upstream.close()
  }
})
