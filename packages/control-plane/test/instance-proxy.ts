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

/** A fake upgrade socket recording writes. */
function fakeSocket(): ProxySocket & { written: string; closed: boolean } {
  const emitter = new EventEmitter()
  const socket = Object.assign(emitter, {
    written: '',
    closed: false,
    write(data: unknown) {
      this.written += String(data)
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
  const { state = 'ready', port = 17510 } = options
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
  assert.equal(parseInstancePath('/api/i/other/api/session.list'), null)
  assert.equal(parseInstancePath('/api/projects/p1/runtime/api/session.list'), null)
  assert.equal(parseInstancePath('/api/i'), null)
})

// ---------------------------------------------------------------------------
// Path mapping: local + ssh-<id>
// ---------------------------------------------------------------------------

test('local mapping: prefix stripped, forwarded to the derived baseUrl with the instance Host', async () => {
  const { proxy, upstream } = makeProxy({ state: 'ready', port: 17510 })
  const res = fakeResponse()
  await proxy.handleHttp(
    fakeRequest('/api/i/local/api/session.list?foo=bar', 'POST', { 'content-type': 'application/json' }, '{"rpcId":"r1","method":"session.list"}'),
    res,
  )
  assert.equal(res.status, 200)
  assert.equal(upstream.calls.length, 1)
  const call = upstream.calls[0]
  assert.equal(call.url.origin, 'http://127.0.0.1:17510')
  assert.equal(call.url.pathname, '/api/session.list')
  assert.equal(call.url.search, '?foo=bar')
  assert.equal(call.options.method, 'POST')
  assert.equal((call.options.headers as Record<string, string>).host, '127.0.0.1:17510')
  assert.equal(call.body.join(''), '{"rpcId":"r1","method":"session.list"}')
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
    getLocalDshPort: () => 17510,
    httpRequest: upstream.fn,
  })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session.list', 'GET'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(Object.keys(res.headers).sort(), ['cache-control', 'content-type', 'x-next-cursor', 'x-ratelimit-limit'])
  assert.equal(res.headers['set-cookie'], undefined)
  assert.equal(res.headers['x-custom-secret'], undefined)
})

test('request body over the 50MiB cap answers 413 body_too_large', async () => {
  const { proxy, upstream } = makeProxy()
  const huge = 'x'.repeat(MAX_REQUEST_BODY_BYTES + 1)
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session.list', 'POST', {}, huge), res)
  assert.equal(res.status, 413)
  assert.equal(JSON.parse(res.body).code, 'body_too_large')
  assert.equal(upstream.calls.length, 0)
})

test('upstream connect failure answers 502 upstream_failed (masked)', async () => {
  const upstream = fakeHttpRequest(() => ({ error: new Error('ECONNREFUSED 127.0.0.1:17510') }))
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => 17510,
    httpRequest: upstream.fn,
  })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session.list', 'GET'), res)
  assert.equal(res.status, 502)
  assert.equal(JSON.parse(res.body).code, 'upstream_failed')
  // Masked: the upstream host:port never rides the wire.
  assert.ok(!res.body.includes('17510'))
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
  assert.equal((call.options.headers as Record<string, string>).host, '127.0.0.1:17510')

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
    getLocalDshPort: () => 17510,
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
    getLocalDshPort: () => 17510,
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
    getLocalDshPort: () => 17510,
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
    getLocalDshPort: () => 17510,
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

test('upgrade: a WebSocket handshake that never completes → explicit 504 on the socket', async () => {
  const upstream = fakeHttpRequest(() => undefined) // hang
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => 17510,
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
