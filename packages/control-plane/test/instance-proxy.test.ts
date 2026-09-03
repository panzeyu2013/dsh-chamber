/**
 * Instance-proxy unit tests (fake upstream injection): path mapping
 * (local / dsh-<id> / legacy ssh-<id> / gateway-<id>), unregistered-tunnel
 * 503, prefix stripping, response header whitelist, body caps, gateway
 * http(s) registration with 0..2 bounded injected headers, and WS
 * stream-path recognition. The outbound request factory (deps.httpRequest)
 * is injected — no real dsh, no fixed ports. No authentication on the
 * control plane itself: /api/i/* is directly reachable (v1).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer as createHttpsServer } from 'node:https'
import { createHash, X509Certificate } from 'node:crypto'
import {
  convergeLocation,
  createInstanceProxy,
  parseInstanceId,
  parseInstancePath,
  tcpKeepAliveMsForUpstream,
  isLoopbackUpstreamBaseUrl,
  MAX_REQUEST_BODY_BYTES,
  getProcessBufferedRequestBytes,
} from '../src/instance-proxy.ts'
import { startWsHeartbeat } from '../src/ws-heartbeat.ts'
import { clearAuthCookie, registerAuthCookie } from '../src/browser-auth-cookie.ts'
import { DEFAULT_DSH_START_PORT } from '../src/spawn-dsh.ts'
import type { ProxyRequest, ProxyResponse, ProxySocket } from '../src/instance-proxy.ts'

const quietLogger = { log: () => {}, warn: () => {}, error: () => {} }
const GATEWAY_AUTHORIZATION = `Bearer ${'t'.repeat(32)}`

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
        // S2: NON-loopback (direct-http) splices arm OS-level TCP keepalive
        // on the upstream leg — real node sockets carry net.Socket.setKeepAlive;
        // record the configuration here so wiring tests can assert it.
        upstreamSocket.keepAliveCalls = []
        upstreamSocket.setKeepAlive = (enable: boolean, delay?: number) => {
          upstreamSocket.keepAliveCalls.push({ enable, delay })
        }
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

test('parseInstancePath maps local, dsh-<id>, legacy ssh-<id> and gateway-<id> and strips the prefix', () => {
  assert.deepEqual(parseInstancePath('/api/i/local/api/session/list'), { id: 'local', rest: '/api/session/list', search: '' })
  assert.deepEqual(parseInstancePath('/api/i/dsh-srv-7/api/session/list'), { id: 'dsh-srv-7', rest: '/api/session/list', search: '' })
  assert.deepEqual(parseInstancePath('/api/i/ssh-srv-7/api/remote.mux?x=1'), { id: 'ssh-srv-7', rest: '/api/remote.mux', search: '?x=1' })
  assert.deepEqual(parseInstancePath('/api/i/gateway-gw-1/api/session/list'), { id: 'gateway-gw-1', rest: '/api/session/list', search: '' })
  assert.deepEqual(parseInstancePath('/api/i/local'), { id: 'local', rest: '/', search: '' })
  assert.equal(parseInstancePath('/api/i/ssh-/x'), null)
  assert.equal(parseInstancePath(`/api/i/ssh-${'x'.repeat(65)}/x`), null)
  assert.equal(parseInstancePath('/api/i/dsh-/x'), null)
  assert.equal(parseInstancePath(`/api/i/dsh-${'x'.repeat(65)}/x`), null)
  assert.equal(parseInstancePath('/api/i/other/api/session/list'), null)
  assert.equal(parseInstancePath('/api/projects/p1/runtime/api/session/list'), null)
  assert.equal(parseInstancePath('/api/i'), null)
})

test('parseInstanceId: dsh-<id> and gateway-<id> map to their kinds; ssh-<id> is a legacy dsh alias', () => {
  // Direct contract assertions for the segment parser (design 17 §2.2).
  assert.equal(parseInstanceId('dsh-srv-7'), 'dsh')
  assert.equal(parseInstanceId('ssh-srv-7'), 'dsh') // legacy alias
  assert.equal(parseInstanceId('gateway-gw-1'), 'gateway')
  assert.equal(parseInstanceId('local'), 'local')
  assert.equal(parseInstanceId('other'), null)
  assert.equal(parseInstanceId('ssh-'), null)
})

test('tcpKeepAliveMsForUpstream: non-loopback upstreams get the direct-http TCP keepalive cadence', () => {
  // S2: a non-loopback upstream is the desktop's direct-http(s) shape (the
  // id kind cannot see the transport dimension, the resolved target can) —
  // no ssh keepalive covers its upstream WS leg, so the proxy arms OS-level
  // TCP keepalive. gateway-kind AND dsh-kind direct targets both qualify.
  assert.equal(tcpKeepAliveMsForUpstream('http://192.168.110.172:30801'), 30_000)
  assert.equal(tcpKeepAliveMsForUpstream('https://dsh.example.com:8443'), 30_000)
  assert.equal(tcpKeepAliveMsForUpstream('http://10.0.0.7:30800'), 30_000)
})

test('tcpKeepAliveMsForUpstream: loopback upstreams (ssh tunnels / local) stay keepalive-free', () => {
  // ssh tunnels resolve to loopback base URLs (ssh keepalive covers them),
  // loopback (local) legs cannot die half-open, and unparseable targets fail
  // toward no keepalive — all keep the documented no-heartbeat upstream
  // design (design 03 §3.4).
  assert.equal(tcpKeepAliveMsForUpstream('http://127.0.0.1:56001'), undefined)
  assert.equal(tcpKeepAliveMsForUpstream('http://localhost:56001'), undefined)
  assert.equal(tcpKeepAliveMsForUpstream('http://[::1]:56001'), undefined)
  assert.equal(tcpKeepAliveMsForUpstream('http://127.8.8.8:30800'), undefined)
  assert.equal(tcpKeepAliveMsForUpstream('not a url'), undefined)
  assert.equal(tcpKeepAliveMsForUpstream(''), undefined)
})

test('isLoopbackUpstreamBaseUrl: loopback spellings and malformed targets', () => {
  assert.equal(isLoopbackUpstreamBaseUrl('http://127.0.0.1:1'), true)
  assert.equal(isLoopbackUpstreamBaseUrl('http://localhost:1'), true)
  assert.equal(isLoopbackUpstreamBaseUrl('http://[::1]:1'), true)
  assert.equal(isLoopbackUpstreamBaseUrl('http://[::ffff:127.0.0.1]:1'), true) // IPv4-mapped IPv6 loopback
  assert.equal(isLoopbackUpstreamBaseUrl('http://::1:1'), true) // unbracketed → invalid URL → loopback fail-safe
  assert.equal(isLoopbackUpstreamBaseUrl('http://192.168.110.172:30801'), false)
  assert.equal(isLoopbackUpstreamBaseUrl('nonsense'), true)
})

// ---------------------------------------------------------------------------
// Path mapping: local + ssh-<id>
// ---------------------------------------------------------------------------

test('0.1.2 combo URLs keep their trailing slash through parseInstancePath', async () => {
  // review-round7b P1-1: extra-bundle URLs are `/plugins/??<id>/client.js&rev=…`
  // — the upstream serveBundle keys by the EXACT pathname+search, so a lost
  // trailing slash 404s every extra preload (boot failure on the new wire).
  const parsed = parseInstancePath('/api/i/local/plugins/??abc/client.js&rev=1')
  assert.ok(parsed !== null)
  assert.equal(parsed.rest, '/plugins/')
  assert.equal(parsed.search, '??abc/client.js&rev=1')
  // The no-trailing-slash shape is unchanged.
  const plain = parseInstancePath('/api/i/local/api/session/list')
  assert.equal(plain?.rest, '/api/session/list')
})

test('local mapping forwards the 0.1.2 browser-auth cookie when bootstrapped', async () => {
  // review-round3c P0: the renderer's unary + mux calls reach the instance
  // through the proxy, which injects the spawn-minted cookie.
  const host = `http://127.0.0.1:${DEFAULT_DSH_START_PORT}`
  const { proxy, upstream } = makeProxy({ state: 'ready', port: DEFAULT_DSH_START_PORT })
  try {
    registerAuthCookie(host, 'browser-auth=session-value')
    const res = fakeResponse()
    await proxy.handleHttp(
      fakeRequest('/api/i/local/api/session/list', 'POST', { 'content-type': 'application/json' }, '{"rpcId":"r1","method":"session/list"}'),
      res,
    )
    assert.equal(res.status, 200)
    const call = upstream.calls[0]
    assert.equal((call.options.headers as Record<string, string>).cookie, 'browser-auth=session-value')
  } finally {
    clearAuthCookie(host)
  }
})

test('local mapping: prefix stripped, forwarded to the derived baseUrl with the instance Host', async () => {
  const { proxy, upstream } = makeProxy({ state: 'ready', port: DEFAULT_DSH_START_PORT })
  const res = fakeResponse()
  await proxy.handleHttp(
    fakeRequest('/api/i/local/api/session/list?foo=bar', 'POST', { 'content-type': 'application/json' }, '{"rpcId":"r1","method":"session/list"}'),
    res,
  )
  assert.equal(res.status, 200)
  assert.equal(upstream.calls.length, 1)
  const call = upstream.calls[0]
  assert.equal(call.url.origin, `http://127.0.0.1:${DEFAULT_DSH_START_PORT}`)
  assert.equal(call.url.pathname, '/api/session/list')
  assert.equal(call.url.search, '?foo=bar')
  assert.equal(call.options.method, 'POST')
  assert.equal((call.options.headers as Record<string, string>).host, `127.0.0.1:${DEFAULT_DSH_START_PORT}`)
  assert.equal(call.body.join(''), '{"rpcId":"r1","method":"session/list"}')
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

test('framed GET and HEAD request bodies are preserved instead of silently discarded', async () => {
  const { proxy, upstream } = makeProxy({ state: 'ready', port: DEFAULT_DSH_START_PORT })

  for (const method of ['GET', 'HEAD']) {
    const response = fakeResponse()
    await proxy.handleHttp(
      fakeRequest('/api/i/local/api/framed', method, { 'content-length': '3' }, 'abc'),
      response,
    )
  }

  assert.equal(upstream.calls.length, 2)
  for (const call of upstream.calls) {
    assert.equal(call.body.join(''), 'abc')
    assert.equal((call.options.headers as Record<string, string>)['content-length'], '3')
  }
})

test('ssh-<id> mapping: registered transport baseUrl wins; unregistered answers 503', async () => {
  const { proxy, upstream } = makeProxy()
  proxy.registerTransport('ssh:srv1', 'http://127.0.0.1:22001')
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/ssh-srv1/api/session/list', 'GET'), res)
  assert.equal(res.status, 200)
  assert.equal(upstream.calls.length, 1)
  assert.equal(upstream.calls[0].url.origin, 'http://127.0.0.1:22001')
  assert.equal(upstream.calls[0].url.pathname, '/api/session/list')

  // Unregistered ssh id → explicit 503 instance_unavailable (proxy honesty).
  const missing = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/ssh-ghost/api/session/list', 'GET'), missing)
  assert.equal(missing.status, 503)
  assert.equal(JSON.parse(missing.body).code, 'instance_unavailable')
  assert.equal(upstream.calls.length, 1)

  // Unregister → the tunnel is gone, the instance becomes unavailable.
  proxy.unregisterTransport('ssh:srv1')
  const gone = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/ssh-srv1/api/session/list', 'GET'), gone)
  assert.equal(gone.status, 503)
  assert.equal(JSON.parse(gone.body).code, 'instance_unavailable')
})

test('dsh-<id> mapping: the dsh kind resolves via dsh:<id>, legacy ssh-<id> via ssh:<id>', async () => {
  const { proxy, upstream } = makeProxy()
  // dsh kind under its canonical source-id spelling.
  proxy.registerTransport('dsh:box1', 'http://127.0.0.1:22011')
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/dsh-box1/api/session/list', 'GET'), res)
  assert.equal(res.status, 200)
  assert.equal(upstream.calls.length, 1)
  assert.equal(upstream.calls[0].url.origin, 'http://127.0.0.1:22011')
  assert.equal(upstream.calls[0].url.pathname, '/api/session/list')
  // The same dsh target registered under the legacy ssh:<id> spelling is
  // still reachable through the legacy ssh-<id> source id (design 17 §2.2).
  proxy.registerTransport('ssh:box1', 'http://127.0.0.1:22012')
  const legacy = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/ssh-box1/api/session/list', 'GET'), legacy)
  assert.equal(legacy.status, 200)
  assert.equal(upstream.calls[1].url.origin, 'http://127.0.0.1:22012')
  // The two spellings are distinct registrations; unregistering the dsh one
  // leaves the legacy spelling live.
  proxy.unregisterTransport('dsh:box1')
  const missing = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/dsh-box1/api/session/list', 'GET'), missing)
  assert.equal(missing.status, 503)
})

test('dsh and local targets reject the gateway-owned /chamber namespace in the proxy core', async () => {
  const { proxy, upstream } = makeProxy()
  proxy.registerTransport('dsh:direct', 'https://dsh.example.com', undefined, { transport: 'http' })
  proxy.registerTransport('ssh:legacy', 'http://127.0.0.1:22012')

  // Alternate spellings are normalized before the capability decision: URL
  // dot segments, percent encoding and backslashes cannot bypass the gate.
  const refused = [
    '/api/i/dsh-direct/chamber/runtime/status',
    '/api/i/dsh-direct/%63hamber/runtime/status',
    '/api/i/dsh-direct/%2fchamber/runtime/status',
    '/api/i/dsh-direct/x/../chamber/runtime/status',
    '/api/i/dsh-direct/x/%2e%2e/chamber/runtime/status',
    '/api/i/ssh-legacy/\\chamber/runtime/status',
    '/api/i/local/chamber/settings',
  ]
  for (const path of refused) {
    const res = fakeResponse()
    await proxy.handleHttp(fakeRequest(path, 'GET'), res)
    assert.equal(res.status, 404, path)
    assert.equal(JSON.parse(res.body).code, 'capability_not_found', path)
  }
  assert.equal(upstream.calls.length, 0, 'no dsh/local chamber request reaches an upstream')

  // The same namespace is a first-class gateway capability and remains a
  // generic passthrough for a gateway-kind registration.
  proxy.registerTransport('gateway:allowed', 'https://gateway.example.com', undefined, { transport: 'http' })
  const allowed = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/gateway-allowed/chamber/runtime/status', 'GET'), allowed)
  assert.equal(allowed.status, 200)
  assert.equal(upstream.calls.length, 1)
  assert.equal(upstream.calls[0].url.pathname, '/chamber/runtime/status')
})

test('gateway http direct origin: registered and forwarded with its injected headers', async () => {
  const { proxy, upstream } = makeProxy()
  // http direct = the user-configurable insecureHttp origin (design 17 §9.3),
  // non-loopback allowed — plus both sanctioned headers.
  proxy.registerTransport('gateway:gw-http', 'http://gw.internal:8080', {
    authorization: GATEWAY_AUTHORIZATION,
    cookie: 'dsh_gateway_session=abc.def',
  })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/gateway-gw-http/api/session/list', 'GET'), res)
  assert.equal(res.status, 200)
  assert.equal(upstream.calls.length, 1)
  const call = upstream.calls[0]
  assert.equal(call.url.origin, 'http://gw.internal:8080')
  assert.equal(call.url.pathname, '/api/session/list')
  const headers = call.options.headers as Record<string, string>
  assert.equal(headers.authorization, GATEWAY_AUTHORIZATION)
  assert.equal(headers.cookie, 'dsh_gateway_session=abc.def')
  assert.equal(headers.host, 'gw.internal:8080')
})

test('gateway 0-header registration forwards without any injected credential', async () => {
  const { proxy, upstream } = makeProxy()
  // A credential-less gateway target is legal: the probe/forward answers
  // whatever the server enforces (design 17 §2.3 — no upfront rejection).
  proxy.registerTransport('gateway:anon', 'https://gw.example.com')
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/gateway-anon/api/session/list', 'GET'), res)
  assert.equal(res.status, 200)
  const headers = upstream.calls[0].options.headers as Record<string, string>
  assert.equal(headers.authorization, undefined)
  assert.equal(headers.cookie, undefined)
})

test('gateway WS upgrade: the sanctioned Cookie rides the handshake too', async () => {
  const upstream = fakeHttpRequest(url => url.pathname.startsWith('/api/remote.mux')
    ? { upgrade: { status: 101, headers: { upgrade: 'websocket', connection: 'Upgrade' } } }
    : undefined)
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => 17510,
    httpRequest: upstream.fn,
  })
  proxy.registerTransport('gateway:gws', 'https://gw.example.com', { cookie: 'dsh_gateway_session=abc.def' })
  const socket = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/gateway-gws/api/remote.mux', 'GET'), socket, Buffer.alloc(0))
  assert.equal(upstream.calls.length, 1)
  const headers = upstream.calls[0].options.headers as Record<string, string>
  assert.equal(headers.cookie, 'dsh_gateway_session=abc.def')
})

test('local WS upgrade carries the 0.1.2 browser-auth cookie when bootstrapped', async () => {
  // review-round4 P1/P2: the mux upgrade to the LOCAL instance must ride the
  // spawn-minted cookie — the 0.1.2 stream gate 401s without it.
  const upstream = fakeHttpRequest(url => url.pathname.startsWith('/api/remote.mux')
    ? { upgrade: { status: 101, headers: { upgrade: 'websocket', connection: 'Upgrade' } } }
    : undefined)
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => 17510,
    httpRequest: upstream.fn,
  })
  try {
    registerAuthCookie('http://127.0.0.1:17510', 'browser-auth=sess')
    const socket = fakeSocket()
    await proxy.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux', 'GET'), socket, Buffer.alloc(0))
    assert.equal(upstream.calls.length, 1)
    const headers = upstream.calls[0].options.headers as Record<string, string>
    assert.equal(headers.cookie, 'browser-auth=sess')
  } finally {
    clearAuthCookie('http://127.0.0.1:17510')
  }
})

test('transport replacement and unregister revoke already-open HTTP/SSE and WS channels', async () => {
  const upstream = fakeHttpRequest(url => url.pathname.startsWith('/api/remote.mux')
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
  await proxy.handleHttp(fakeRequest('/api/i/ssh-rotating/api/session/list'), oldSse)
  const oldWs = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/ssh-rotating/api/remote.mux'), oldWs, Buffer.alloc(0))
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 1)
  assert.equal(proxy.getDiagnostics().activeStreams, 1)

  proxy.registerTransport('ssh:rotating', 'http://127.0.0.1:22002')
  assert.equal(oldSse.destroyed, true, 'replacement closes responses authenticated/routed through the old record')
  assert.equal(oldWs.closed, true, 'replacement closes WebSockets authenticated/routed through the old record')
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 0)
  assert.equal(proxy.getDiagnostics().activeStreams, 0)

  const newSse = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/ssh-rotating/api/session/list'), newSse)
  assert.equal(upstream.calls.at(-1)?.url.origin, 'http://127.0.0.1:22002')
  proxy.unregisterTransport('ssh:rotating')
  assert.equal(newSse.destroyed, true, 'unregister closes an existing long HTTP/SSE response')
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 0)

  const gone = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/ssh-rotating/api/session/list'), gone)
  assert.equal(gone.status, 503)
})

test('local instance not ready → explicit 503, never a silent empty success', async () => {
  const { proxy, upstream } = makeProxy({ state: 'starting', port: null })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), res)
  assert.equal(res.status, 503)
  assert.equal(JSON.parse(res.body).code, 'instance_unavailable')
  assert.equal(upstream.calls.length, 0)
})

test('unknown id answers 404 instance_not_found', async () => {
  const { proxy, upstream } = makeProxy()
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/foo/api/session/list', 'GET'), res)
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
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: upstream.fn,
  })
  const res = fakeResponse()
  res._corsHeaders = { 'access-control-allow-origin': 'https://client.example', vary: 'Origin' }
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), res)
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

test('http: accept-encoding is stripped upstream — the proxy never negotiates compression (M3b)', async () => {
  const { proxy, upstream } = makeProxy()
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET', { 'accept-encoding': 'gzip, br' }), res)
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
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), res)
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-encoding'], 'gzip', 'the compression label must never be dropped')
})

test('request body over the 300MiB cap answers 413 body_too_large', async () => {
  const { proxy, upstream } = makeProxy()
  const res = fakeResponse()
  await proxy.handleHttp(
    fakeRequest('/api/i/local/api/session/list', 'POST', { 'content-length': String(MAX_REQUEST_BODY_BYTES + 1) }, 'x'),
    res,
  )
  assert.equal(res.status, 413)
  assert.equal(JSON.parse(res.body).code, 'body_too_large')
  assert.equal(upstream.calls.length, 0)
})

test('local activation quarantine rejects HTTP and WebSocket before either reaches upstream', async () => {
  const upstream = fakeHttpRequest(() => ({
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' },
  }))
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => 17510,
    canExposeLocal: () => false,
    httpRequest: upstream.fn,
  })
  const response = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'POST', {}, '{}'), response)
  assert.equal(response.status, 503)
  assert.equal(JSON.parse(response.body).code, 'instance_unavailable')

  const socket = fakeSocket()
  await proxy.handleUpgrade(
    fakeRequest('/api/i/local/api/remote.mux', 'GET', { upgrade: 'websocket', 'sec-websocket-key': 'k' }),
    socket,
    Buffer.alloc(0),
  )
  assert.ok(socket.written.includes('503'))
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
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), res)
  assert.equal(res.status, 502)
  assert.equal(JSON.parse(res.body).code, 'upstream_failed')
  // Masked: the upstream host:port never rides the wire.
  assert.ok(!res.body.includes(String(DEFAULT_DSH_START_PORT)))
})

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
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), res)
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
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), res)
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
  const request = fakeRequest('/api/i/local/api/session/list', 'GET')
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
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), response)
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
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: upstream.fn,
    maxConcurrentHttpRequests: 1,
    upstreamTimeoutMs: 30,
  })
  const first = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), first)
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 1)
  const second = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), second)
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
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: fn,
    // 20ms chunk cadence against a 100ms idle window: a 5x margin so a CI
    // pause between chunks can never trip the idle timeout spuriously.
    upstreamTimeoutMs: 100,
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
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux'), socket, Buffer.alloc(0))
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
  const request = fakeRequest('/api/i/local/api/remote.mux')
  const socket = fakeSocket()
  await proxy.handleUpgrade(request, socket, Buffer.alloc(0))
  ;(request as unknown as EventEmitter).emit('close')
  assert.equal(captured.signal?.aborted, false)
  ;(socket as unknown as EventEmitter).emit('close')
  assert.equal(captured.signal?.aborted, true)
})

test('transport revoke is owner-scoped and closeAllStreams aborts every remaining pending WebSocket handshake', async () => {
  const upstream = fakeHttpRequest(() => undefined)
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: upstream.fn,
    upstreamTimeoutMs: 5_000,
  })
  proxy.registerTransport('dsh:pending', 'http://127.0.0.1:19191')
  const local = fakeSocket()
  const remote = fakeSocket()
  // 0.1.2 wire: the mux is the only stream path (events.mux/events.host
  // were deleted upstream) — both pending handshakes ride /api/remote.mux.
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux'), local, Buffer.alloc(0))
  await proxy.handleUpgrade(fakeRequest('/api/i/dsh-pending/api/remote.mux'), remote, Buffer.alloc(0))
  assert.equal(proxy.getDiagnostics().pendingUpgrades, 2)

  proxy.unregisterTransport('dsh:pending')
  assert.equal(remote.closed, true)
  assert.equal(local.closed, false, 'revoking one remote transport must not close the local handshake')
  assert.equal((upstream.calls[1]?.options.signal as AbortSignal | undefined)?.aborted, true)
  assert.equal((upstream.calls[0]?.options.signal as AbortSignal | undefined)?.aborted, false)
  assert.equal(proxy.getDiagnostics().pendingUpgrades, 1)

  proxy.closeAllStreams()

  assert.equal(local.closed, true)
  assert.equal((upstream.calls[0]?.options.signal as AbortSignal | undefined)?.aborted, true)
  assert.equal(proxy.getDiagnostics().pendingUpgrades, 0)
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
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux', 'GET'), down, Buffer.alloc(0))
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
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux', 'GET'), down, Buffer.alloc(0))
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
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux', 'GET'), down, Buffer.alloc(0))
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
        path: '/api/i/local/api/remote.mux',
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

// ---------------------------------------------------------------------------
// SPKI certificate pinning forwarding (design 17 §13.4.2 / S23): the same
// embedded self-signed fixture certs as gateway-provider.test.ts (test
// constants — no openssl at test time), served by a REAL node:https server.
// With a pinned gateway transport the proxy's outbound https connection is
// gated on the pin: a matching peer forwards normally, a mismatching peer is
// an explicit 502 upstream_failed (proxy honesty — never a silent pass), and
// an unpinned transport keeps the legacy behavior.
// ---------------------------------------------------------------------------

const CERT_A = `-----BEGIN CERTIFICATE-----
MIICyTCCAbGgAwIBAgIJAMuxiI8oRgl7MA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCTEyNy4wLjAuMTAeFw0yNjA4MjgwNDM4MDRaFw0zNjA4MjUwNDM4MDRaMBQx
EjAQBgNVBAMMCTEyNy4wLjAuMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBALYDiUAFkzdtkyjr/VrNpyfe3p5c0lLWSy+OtqeRK4db2toYN8aWr+vxFMYT
4HqF/VW0ByfOAl0Mfi3kCZPbAFShUY11oYtoHCIGNyQIP6sf+Uc8a2zjodcm67yG
uS980hNK7e1v19B1L/kIZXncrkS7acXbC905GOihh6U3ZQyAGNva/CRlV4fdn2N2
Ti27Hy2xek9S8guA5/Ck+IEAq1iR0KwVNYcYd1yNBYwOGHCbNoSv+bOS2dKNurB0
SgolQYO7FFHWFCDO1dtPbwZfe8B1ucGCQSrgvSEELMjucaZxKMlRh4odH35Asxo8
ldUIdAwEqMK0rDdVmlDWWcEpQGECAwEAAaMeMBwwGgYDVR0RBBMwEYcEfwAAAYIJ
bG9jYWxob3N0MA0GCSqGSIb3DQEBCwUAA4IBAQB1f5w9ld+gR42JDBgqy/UM8eI4
StDLYWNcOrImEV+OiCwhYDs/zXLk4CH9/MGTK3dypCY8nrfRiQ+JRfZf05sWeTyx
vFUu+tfaAKRiNQ39t+//josjJ2CuZeMctPap+F+YwxpxsDdQIEuAELgdWYAVvog4
nYQ7wAd7xngG/RoHv8hoXN7r+ZBk8+hU53YQ4o8xg5gTw6PFG7fVJ4YUxZC8uK72
yld1ntC7f8QDh0iHd9OEz3a+gs1ygsElBO49Rj58JgZLMBsOOOroowhnIsbVR/hN
E0KrcDN2oPfeHsQOarolqSXpNbJJF+Ue+Xlf9RfZNYLc6z2ntclmBAOHr14l
-----END CERTIFICATE-----
`
const KEY_A = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC2A4lABZM3bZMo
6/1azacn3t6eXNJS1ksvjrankSuHW9raGDfGlq/r8RTGE+B6hf1VtAcnzgJdDH4t
5AmT2wBUoVGNdaGLaBwiBjckCD+rH/lHPGts46HXJuu8hrkvfNITSu3tb9fQdS/5
CGV53K5Eu2nF2wvdORjooYelN2UMgBjb2vwkZVeH3Z9jdk4tux8tsXpPUvILgOfw
pPiBAKtYkdCsFTWHGHdcjQWMDhhwmzaEr/mzktnSjbqwdEoKJUGDuxRR1hQgztXb
T28GX3vAdbnBgkEq4L0hBCzI7nGmcSjJUYeKHR9+QLMaPJXVCHQMBKjCtKw3VZpQ
1lnBKUBhAgMBAAECggEAQVaHoInfzRfyqc/9ROlqRe/FbofXoJD4sHvEqeZ8/7xD
leL3srxJLqN+V5SvEoyi4m8b2ngjdQ+VBBhGL+N//OFkCync8dRPtQ8SIEctw9pY
e+/+iDo20KtSGH0sYRWnu/E78+4gRN6sd/NBqjtD+7xjPfliCuoCPRAvR2nZRmDh
/dyg73uq7CFmZb0Xj5E8+sDLsvgEiJ0ZTsxrR197ga72vSVa703iCdXDK1J03ZMd
3TOJAvbOuyn86KADoXkfss6ZL2422/TZ1F8X/gfs4fZs5aRzFoC+cjpzkkptPJxZ
UcDDa9CyxeFotm3E++HRl2xaqwFjpIS6vYr6O2PT+QKBgQDrSG6jh9pStgA9dCXw
3Y0VJyQRbhjEz13rgD7qCvCHRPoM1MYFg2fQ7sFWEq1sByDV0d8qQIKJ/evohlAe
tgw/5fxpW1/9h8LELmTNqP7eqIyVdPikugOmuo7NgdfhfZIr7O9gIOKlntAiKPgG
silO0WEK6WTUUmwcT85gbHo28wKBgQDGClokuhdBla+nBTwndsdrgLux62TLW+/H
OrCud1a7JMfV0PQWCzYQvraWBW132omu7v9Q3pjxuh3kVIafe+qB6SahaIzfA0xL
YMdp4NPnp7qrCK/oA5IliWwPSj5qpoOmBleFUBGkWSMl703LCD8gbXp7tZ6kAwc6
jpqB+kdoWwKBgGRSNhq0SnsJ74BEjgjt7sIeNlrYPudsI/fObwUMNRL4bkYaU3T2
WsXTh8xTmm59e5qwKh+x8fc0teonmvH9XavBPKcPtxY7VOihf4nRjRsTcx4nCf3y
8quc0FcADjSvfiwMkuTCIOHNnaFzJo50WPiqfl5QthVyL3bC8JRcrJ/RAoGBALBs
Infba8JaZdullzwU3XyQdyT97ZIYOdhDGYii+ZnIH1oERp2oqSZrr16gQS/neIZl
lP9m/dtCEUUKY8+J5ZSLroVWDUDSwFHaSmuxBTW2v12EZKiNHdHgxWotmsMJyffK
aIdzl/PQELbHo4a+tvXdcaLpXgUASZ1J0qz92EVHAoGBANabVLiKqQwy4sN4iwT0
5hmnDnsJgOPgydCv8BOXRl7kFu/qVJuv5t+ENERiOrkFbsGGu3ws1HAXPhZckidF
fQQAwvxZjbNVVo4umyxyqUmZyIgLWVxfWABr30wb35RVK+BdAzk1TANpvPTsAt0I
SGO6VATS9KOAchJ/HFfHpRWb
-----END PRIVATE KEY-----
`
const PIN_A = '74f9461a9ae839c59a07e0d7639bc2c6daa4e97d104b1c3a3076a0f2fcb30d33'
const CERT_B = `-----BEGIN CERTIFICATE-----
MIICyTCCAbGgAwIBAgIJALk7aVPu4lYVMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCTEyNy4wLjAuMTAeFw0yNjA4MjgwNDQ0MjVaFw0zNjA4MjUwNDQ0MjVaMBQx
EjAQBgNVBAMMCTEyNy4wLjAuMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBAL7IlWIk7pbIcXeTVCa3phs9N1BZQMquAgsgfg8yXwqyIioSPvF2K+6PiwxP
7gqbir+vVLDwBcvlShXOmShxz6P714AbmsheBAwyX/Gz7uyOoeRo2v0Z42HFe3I2
qWLtHwwGR2UFgEHpHoUKPhft6pW6d5G82YJxOfE0UtgSYDjUFFwiHdzBLepeo6F7
KN7+qXUEZbOe0m7vsWB0+LoU33kQayLTu/pQUMd0Sg+jdNXAczr2MKhvRpESt6l0
ryvezeNqu2cwCmzkuD6mdMHS8O8WDJoaPcxYOgFlAJasiWnRcw0yQZt9nfNsirSt
KqgHTdO5iZdxY80Xn0FpWF4jZusCAwEAAaMeMBwwGgYDVR0RBBMwEYcEfwAAAYIJ
bG9jYWxob3N0MA0GCSqGSIb3DQEBCwUAA4IBAQCJAFkG3Nkf9qdcakZR9q3MLtPI
dElNqw2toAKkgslNEDi68NhI4oHdy/VWUvjv+Io77UR625zXgee4Off+A0Q4+rKC
MSnV+L3vKzVXmQiJe1keSRsJRhHJ5lyCWLQC0cXA8hi2VlhsH3zjsxdss+OkbpVA
cRF/0Zrf8vWmuLvIEHUECDS9FhhK06Ck53MtH4ylUHk1/GYWgxx4fJO5rn5ICGld
GEh/5hgbSIerocTVqopN2wRAwKk6sDi8Mj357LsqBXjOxiG9wM7/970q7HG2wPMD
It601afsP0WIHRkByyugcKQsBIIEPg9XdCP54SymB1Kxa8g9OWzJWNPyCdlg
-----END CERTIFICATE-----
`
const PIN_B = '087ee792a02c84ba6e994244a28449d7ece7ab6cd86b8d4c0c50dafa887d3478'

test('the SPKI pin fixtures are self-consistent in the proxy tests too', () => {
  const pinOf = (pem: string) =>
    createHash('sha256').update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  assert.equal(pinOf(CERT_A), PIN_A)
  assert.equal(pinOf(CERT_B), PIN_B)
})

test('gateway https forward with SPKI pin: match forwards, mismatch is an explicit 502 (S23)', async () => {
  let handlerCalls = 0
  let receivedBodyBytes = 0
  const receivedCredentials: Array<{ authorization?: string; cookie?: string }> = []
  const tlsApplicationBytes: number[] = []
  let tcpConnections = 0
  const server = createHttpsServer({ key: KEY_A, cert: CERT_A }, (req, res) => {
    handlerCalls += 1
    receivedCredentials.push({
      ...(typeof req.headers.authorization === 'string' ? { authorization: req.headers.authorization } : {}),
      ...(typeof req.headers.cookie === 'string' ? { cookie: req.headers.cookie } : {}),
    })
    req.on('data', chunk => { receivedBodyBytes += chunk.length })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  // `secureConnection` exposes decrypted TLS application data. Recording it
  // proves the negative case did not merely avoid the HTTP handler: no
  // request line/header/body byte was written after the mismatched handshake.
  server.on('secureConnection', tlsSocket => {
    const index = tlsApplicationBytes.push(0) - 1
    tlsSocket.on('data', chunk => { tlsApplicationBytes[index] += chunk.length })
  })
  server.on('connection', () => { tcpConnections += 1 })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    // NO injected httpRequest → the real node:https request path runs. The
    // real upstream answers asynchronously (unlike the fake, which emits
    // synchronously inside end()), so each case awaits the response/error
    // completion before asserting.
    const proxy = createInstanceProxy({
      logger: quietLogger,
      getLocalState: () => 'ready',
      getLocalDshPort: () => 17510,
      upstreamTimeoutMs: 2000,
    })
    // Pin match → the request rides through (the pin is the trust anchor —
    // the self-signed chain alone would fail, but the pinned key is trusted).
    proxy.registerTransport('gateway:pinned', `https://127.0.0.1:${port}`, undefined, { tls: { spkiPin: PIN_A } })
    const okRes = fakeResponse()
    const okDone = new Promise<void>(resolve => (okRes as unknown as EventEmitter).once('finish', () => resolve()))
    await proxy.handleHttp(fakeRequest('/api/i/gateway-pinned/api/session/list', 'GET'), okRes)
    await okDone
    assert.equal(okRes.status, 200)
    assert.equal(handlerCalls, 1)

    // Pin mismatch → explicit 502 upstream_failed (proxy honesty: a peer that
    // does not match the pinned key is an upstream failure, never a silent
    // pass-through). Include both sanctioned credentials and a business body:
    // the pre-write gate must hold all of them behind the pin verdict.
    handlerCalls = 0
    receivedBodyBytes = 0
    receivedCredentials.length = 0
    const tlsConnectionsBeforeMismatch = tlsApplicationBytes.length
    const tcpConnectionsBeforeMismatch = tcpConnections
    proxy.registerTransport('gateway:pinned', `https://127.0.0.1:${port}`, {
      authorization: GATEWAY_AUTHORIZATION,
      cookie: 'dsh_gateway_session=must-not-reach-the-wrong-peer',
    }, { tls: { spkiPin: PIN_B } })
    const businessBody = '{"secret":"must-not-reach-the-wrong-peer"}'
    const badRes = fakeResponse()
    let badFinishes = 0
    ;(badRes as unknown as EventEmitter).on('finish', () => { badFinishes += 1 })
    const badDone = new Promise<void>(resolve => (badRes as unknown as EventEmitter).once('finish', () => resolve()))
    await proxy.handleHttp(fakeRequest('/api/i/gateway-pinned/api/session/list', 'POST', {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(businessBody)),
    }, businessBody), badRes)
    await badDone
    await sleep(20)
    assert.equal(badRes.status, 502)
    assert.equal(JSON.parse(badRes.body).code, 'upstream_failed')
    assert.equal(handlerCalls, 0, 'a mismatched pin never reaches the TLS server HTTP handler')
    assert.equal(receivedBodyBytes, 0, 'no business body byte reaches a mismatched peer')
    assert.deepEqual(receivedCredentials, [], 'Authorization/Cookie never reach a mismatched peer')
    assert.equal(tcpConnections, tcpConnectionsBeforeMismatch + 1, 'the negative case reached a real TLS server connection')
    assert.equal(
      tlsApplicationBytes.slice(tlsConnectionsBeforeMismatch).reduce((total, bytes) => total + bytes, 0),
      0,
      'no decrypted HTTP request byte is written before the pin matches',
    )
    assert.equal(proxy.getDiagnostics().activeHttpRequests, 0, 'the failed request lease is released exactly once')
    assert.equal(proxy.getDiagnostics().bufferedRequestBytes, 0, 'the rejected body reservation is released')
    assert.equal(proxy.getDiagnostics().failures, 1, 'the pin failure is counted once')
    assert.equal(badFinishes, 1, 'the loud 502 response is finished once')

    // No pin → the pin machinery is inert: the unpinned https forward against
    // this self-signed chain fails chain validation (502) — the unpinned
    // SUCCESS path is the http tests above; here the point is that an
    // unpinned transport never engages the pin gate.
    proxy.registerTransport('gateway:plain', `https://127.0.0.1:${port}`)
    const plainRes = fakeResponse()
    const plainDone = new Promise<void>(resolve => (plainRes as unknown as EventEmitter).once('finish', () => resolve()))
    await proxy.handleHttp(fakeRequest('/api/i/gateway-plain/api/session/list', 'GET'), plainRes)
    await plainDone
    assert.equal(plainRes.status, 502)
    assert.equal(JSON.parse(plainRes.body).code, 'upstream_failed')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('gateway WS upgrade with SPKI pin: match upgrades, mismatch rejects with 502 (S23)', async () => {
  const server = createHttpsServer({ key: KEY_A, cert: CERT_A })
  let upgradeCalls = 0
  const receivedCredentials: Array<{ authorization?: string; cookie?: string }> = []
  const tlsApplicationBytes: number[] = []
  let tcpConnections = 0
  server.on('secureConnection', tlsSocket => {
    const index = tlsApplicationBytes.push(0) - 1
    tlsSocket.on('data', chunk => { tlsApplicationBytes[index] += chunk.length })
  })
  server.on('connection', () => { tcpConnections += 1 })
  server.on('upgrade', (req, socket) => {
    upgradeCalls += 1
    receivedCredentials.push({
      ...(typeof req.headers.authorization === 'string' ? { authorization: req.headers.authorization } : {}),
      ...(typeof req.headers.cookie === 'string' ? { cookie: req.headers.cookie } : {}),
    })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const proxy = createInstanceProxy({
      logger: quietLogger,
      getLocalState: () => 'ready',
      getLocalDshPort: () => 17510,
      upstreamTimeoutMs: 2000,
    })
    // The real upstream handshake answers asynchronously (the fake emits the
    // upgrade synchronously inside end()); await the socket write. The real
    // node:https server only upgrades when the request carries the WebSocket
    // handshake headers (the fake upstream ignored them).
    const wsHeaders = {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    }
    const waitForWrite = async (socket: ReturnType<typeof fakeSocket>): Promise<void> => {
      const deadline = Date.now() + 2000
      while (socket.written === '' && Date.now() < deadline) await sleep(5)
    }
    // Pin match → the upgrade handshake rides through.
    proxy.registerTransport('gateway:pinned-ws', `https://127.0.0.1:${port}`, undefined, { tls: { spkiPin: PIN_A } })
    const okSocket = fakeSocket()
    await proxy.handleUpgrade(fakeRequest('/api/i/gateway-pinned-ws/api/remote.mux', 'GET', wsHeaders), okSocket, Buffer.alloc(0))
    await waitForWrite(okSocket)
    assert.match(okSocket.written, /101/)
    assert.equal(upgradeCalls, 1)

    // Pin mismatch → the handshake is rejected with an explicit 502, and no
    // HTTP upgrade line/header (including credentials) reaches the peer.
    upgradeCalls = 0
    receivedCredentials.length = 0
    const tlsConnectionsBeforeMismatch = tlsApplicationBytes.length
    const tcpConnectionsBeforeMismatch = tcpConnections
    proxy.registerTransport('gateway:pinned-ws', `https://127.0.0.1:${port}`, {
      authorization: GATEWAY_AUTHORIZATION,
      cookie: 'dsh_gateway_session=must-not-reach-the-wrong-peer',
    }, { tls: { spkiPin: PIN_B } })
    const badSocket = fakeSocket()
    await proxy.handleUpgrade(fakeRequest('/api/i/gateway-pinned-ws/api/remote.mux', 'GET', wsHeaders), badSocket, Buffer.alloc(0))
    await waitForWrite(badSocket)
    await sleep(20)
    assert.match(badSocket.written, /502/)
    assert.equal((badSocket.written.match(/HTTP\/1\.1 502/g) ?? []).length, 1, 'the loud WS rejection is written once')
    assert.equal(upgradeCalls, 0, 'a mismatched pin never reaches the TLS server upgrade handler')
    assert.deepEqual(receivedCredentials, [], 'Authorization/Cookie never reach a mismatched WS peer')
    assert.equal(tcpConnections, tcpConnectionsBeforeMismatch + 1, 'the negative case reached a real TLS server connection')
    assert.equal(
      tlsApplicationBytes.slice(tlsConnectionsBeforeMismatch).reduce((total, bytes) => total + bytes, 0),
      0,
      'no decrypted WS handshake byte is written before the pin matches',
    )
    assert.equal(proxy.getDiagnostics().pendingUpgrades, 0, 'the rejected handshake lease is released exactly once')
    assert.equal(proxy.getDiagnostics().failures, 1, 'the pin failure is counted once')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
