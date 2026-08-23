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
  convergeLocation,
  createInstanceProxy,
  parseInstancePath,
  MAX_REQUEST_BODY_BYTES,
  getProcessBufferedRequestBytes,
} from '../src/instance-proxy.ts'
import { startWsHeartbeat } from '../src/ws-heartbeat.ts'
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
      req.emit('finish')
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
function fakeResponse(): ProxyResponse & { status: number | null; headers: Record<string, unknown>; body: string; destroyed: boolean } {
  const emitter = new EventEmitter()
  const res = Object.assign(emitter, {
    status: null as number | null,
    headers: {} as Record<string, unknown>,
    body: '',
    destroyed: false,
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
      emitter.emit('finish')
      return undefined
    },
    setHeader() {},
    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      emitter.emit('close')
    },
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
    destroy() {
      if (this.closed) return
      this.closed = true
      emitter.emit('close')
    },
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
  assert.equal(parseInstancePath(`/api/i/ssh-${'x'.repeat(65)}/x`), null)
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

test('request convergence strips framing and proxy headers, then emits the accepted body length', async () => {
  const { proxy, upstream } = makeProxy({ state: 'ready', port: 17510 })
  const res = fakeResponse()
  await proxy.handleHttp(
    fakeRequest('/api/i/local/api/upload', 'POST', {
      'content-length': '999',
      connection: 'keep-alive',
      expect: '100-continue',
      'proxy-authenticate': 'secret',
      forwarded: 'for=203.0.113.7;host=evil.example',
      via: '1.1 attacker',
      'x-forwarded-for': '203.0.113.7',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
      'x-forwarded-port': '443',
      'x-real-ip': '203.0.113.7',
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
  assert.equal(headers.forwarded, undefined)
  assert.equal(headers.via, undefined)
  assert.equal(headers['x-forwarded-for'], undefined)
  assert.equal(headers['x-forwarded-host'], undefined)
  assert.equal(headers['x-forwarded-proto'], undefined)
  assert.equal(headers['x-forwarded-port'], undefined)
  assert.equal(headers['x-real-ip'], undefined)
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

test('transport replacement and unregister revoke already-open HTTP/SSE and WS channels', async () => {
  const upstream = fakeHttpRequest(url => url.pathname.startsWith('/api/events.')
    ? { upgrade: { status: 101, headers: { upgrade: 'websocket', connection: 'Upgrade' } } }
    : { response: { status: 200, headers: { 'content-type': 'text/event-stream' }, body: null } })
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => 17510,
    httpRequest: upstream.fn,
  })
  proxy.registerTransport('ssh:rotating', 'http://127.0.0.1:22001')

  const oldSse = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/ssh-rotating/api/session.list'), oldSse)
  const oldWs = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/ssh-rotating/api/events.mux'), oldWs, Buffer.alloc(0))
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 1)
  assert.equal(proxy.getDiagnostics().activeStreams, 1)

  proxy.registerTransport('ssh:rotating', 'http://127.0.0.1:22002')
  assert.equal(oldSse.destroyed, true, 'replacement closes responses authenticated/routed through the old record')
  assert.equal(oldWs.closed, true, 'replacement closes WebSockets authenticated/routed through the old record')
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 0)
  assert.equal(proxy.getDiagnostics().activeStreams, 0)

  const newSse = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/ssh-rotating/api/session.list'), newSse)
  assert.equal(upstream.calls.at(-1)?.url.origin, 'http://127.0.0.1:22002')
  proxy.unregisterTransport('ssh:rotating')
  assert.equal(newSse.destroyed, true, 'unregister closes an existing long HTTP/SSE response')
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 0)

  const gone = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/ssh-rotating/api/session.list'), gone)
  assert.equal(gone.status, 503)
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

test('response header convergence preserves representation metadata and rewrites same-origin redirects', async () => {
  const upstream = fakeHttpRequest(() => ({
    response: {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-language': 'en',
        'cache-control': 'no-store',
        etag: '"v1"',
        location: '/login?next=%2F',
        vary: 'accept-encoding',
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
  res._corsHeaders = { 'access-control-allow-origin': 'https://client.example', vary: 'Origin' }
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session.list', 'GET'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(Object.keys(res.headers).sort(), [
    'access-control-allow-origin',
    'cache-control',
    'content-encoding',
    'content-language',
    'content-type',
    'etag',
    'location',
    'vary',
    'x-next-cursor',
    'x-ratelimit-limit',
  ])
  assert.equal(res.headers.location, '/api/i/local/login?next=%2F')
  assert.equal(res.headers.vary, 'accept-encoding, Origin')
  assert.equal(res.headers['access-control-allow-origin'], 'https://client.example')
  assert.equal(res.headers['set-cookie'], undefined)
  assert.equal(res.headers['x-custom-secret'], undefined)
})

test('convergeLocation: undefined passthrough, root mount strips origin, prefixed mount prepends', () => {
  const target = new URL('http://127.0.0.1:17510')
  // No mounted prefix: the raw Location rides through unchanged (owner opts out).
  assert.equal(convergeLocation('http://127.0.0.1:17510/login?next=%2F', target, undefined), 'http://127.0.0.1:17510/login?next=%2F')
  // Root mount (the gateway): same-origin absolute redirects are stripped to
  // their path so the internal loopback origin never escapes the public one.
  assert.equal(convergeLocation('http://127.0.0.1:17510/login?next=%2F', target, ''), '/login?next=%2F')
  // Relative Location resolves against the target and is rewritten too.
  assert.equal(convergeLocation('/login', target, ''), '/login')
  // Prefixed mount (instance proxy): the browser-visible prefix is prepended.
  assert.equal(convergeLocation('http://127.0.0.1:17510/login', target, '/api/i/local'), '/api/i/local/login')
  // A different origin is never rewritten (external redirects stay absolute).
  assert.equal(convergeLocation('https://other.example/login', target, ''), 'https://other.example/login')
  // An unparseable Location is passed through untouched.
  assert.equal(convergeLocation('http://[', target, ''), 'http://[')
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
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session.list', 'GET'), res)
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
    getLocalDshPort: () => 17510,
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

test('http: IncomingMessage close after parsing does not abort a live upstream request', async () => {
  let pending: EventEmitter | null = null
  const captured = { signal: null as AbortSignal | null }
  const fn: any = (_url: URL, options: { signal: AbortSignal }) => {
    captured.signal = options.signal
    const request = new EventEmitter() as any
    request.write = () => true
    request.end = () => { pending = request }
    return request
  }
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => 17510,
    httpRequest: fn,
    upstreamTimeoutMs: 200,
  })
  const request = fakeRequest('/api/i/local/api/session.list', 'GET')
  const response = fakeResponse()
  await proxy.handleHttp(request, response)
  ;(request as unknown as EventEmitter).emit('close')
  assert.equal(captured.signal?.aborted, false)
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 1)

  const upstream = pending as EventEmitter | null
  assert.ok(upstream !== null)
  const upstreamResponse = new EventEmitter() as any
  upstreamResponse.statusCode = 200
  upstreamResponse.headers = { 'content-type': 'application/json' }
  upstreamResponse.destroy = () => upstreamResponse.emit('close')
  upstreamResponse.pause = () => {}
  upstreamResponse.resume = () => {}
  upstream.emit('response', upstreamResponse)
  upstreamResponse.emit('data', Buffer.from('{"ok":true}'))
  upstreamResponse.emit('end')
  assert.equal(response.status, 200)
  assert.equal(response.body, '{"ok":true}')
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 0)
})

test('http: unfinished downstream response close aborts upstream and clears timeout', async () => {
  const captured = { signal: null as AbortSignal | null }
  const fn: any = (_url: URL, options: { signal: AbortSignal }) => {
    captured.signal = options.signal
    const request = new EventEmitter() as any
    request.write = () => true
    request.end = () => {}
    return request
  }
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => 17510,
    httpRequest: fn,
    upstreamTimeoutMs: 30,
  })
  const response = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session.list', 'GET'), response)
  ;(response as unknown as EventEmitter).emit('close')
  assert.equal(captured.signal?.aborted, true)
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 0)
  await sleep(60)
  assert.equal(response.status, null, 'a cleared timeout must not write after the client disconnected')
})

test('http: concurrent request budget rejects excess work before opening another upstream', async () => {
  const upstream = fakeHttpRequest(() => undefined)
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => 17510,
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
    getLocalDshPort: () => 17510,
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

test('http: request-body bytes stay reserved while upstream write is backpressured', async () => {
  let pendingRequest: EventEmitter | null = null
  let first = true
  const fn: any = () => {
    const req = new EventEmitter() as any
    req.write = () => {
      if (first) {
        first = false
        pendingRequest = req
        return false
      }
      return true
    }
    req.end = () => {
      req.emit('finish')
      const upstreamRes = new EventEmitter() as any
      upstreamRes.statusCode = 200
      upstreamRes.headers = { 'content-type': 'application/json' }
      upstreamRes.destroy = () => upstreamRes.emit('close')
      req.emit('response', upstreamRes)
      upstreamRes.emit('data', Buffer.from('{}'))
      upstreamRes.emit('end')
    }
    return req
  }
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => 17510,
    httpRequest: fn,
    maxBufferedRequestBytes: 3,
  })
  const response = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/upload', 'POST', { 'content-length': '3' }, 'abc'), response)
  assert.equal(response.status, null)
  assert.equal(proxy.getDiagnostics().bufferedRequestBytes, 3)
  assert.equal(getProcessBufferedRequestBytes(), 3, 'the reservation is shared process-wide, not only per proxy owner')

  const rejected = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/upload', 'POST', { 'content-length': '1' }, 'x'), rejected)
  assert.equal(rejected.status, 503)
  assert.match(rejected.body, /resource_exhausted/)

  const blocked = pendingRequest as EventEmitter | null
  assert.ok(blocked !== null)
  blocked.emit('drain')
  assert.equal(response.status, 200)
  assert.equal(proxy.getDiagnostics().bufferedRequestBytes, 0)
  assert.equal(getProcessBufferedRequestBytes(), 0)
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
    getLocalDshPort: () => 17510,
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

test('upgrade: request close does not abort the handshake; downstream socket close does', async () => {
  const captured = { signal: null as AbortSignal | null }
  const fn: any = (_url: URL, options: { signal: AbortSignal }) => {
    captured.signal = options.signal
    const request = new EventEmitter() as any
    request.write = () => true
    request.end = () => {}
    return request
  }
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => 17510,
    httpRequest: fn,
    upstreamTimeoutMs: 200,
  })
  const request = fakeRequest('/api/i/local/api/events.mux')
  const socket = fakeSocket()
  await proxy.handleUpgrade(request, socket, Buffer.alloc(0))
  ;(request as unknown as EventEmitter).emit('close')
  assert.equal(captured.signal?.aborted, false)
  ;(socket as unknown as EventEmitter).emit('close')
  assert.equal(captured.signal?.aborted, true)
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
    getLocalDshPort: () => 17510,
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
    getLocalDshPort: () => 17510,
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
    getLocalDshPort: () => 17510,
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
