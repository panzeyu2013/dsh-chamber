/**
 * Gateway single-target proxy unit tests (design 17 §6): the SSRF guard
 * (non-origin-form targets rejected), the loud 503 (dsh not ready), the WS
 * path whitelist, and the S0 HTML trust-injection seam (a small text/html
 * upstream document is rewritten through html-inject.ts before reaching the
 * browser). Run with `node packages/gateway/test/gateway-proxy.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import type { HttpRequestFactory, ProxyRequest, ProxyResponse, ProxySocket } from '@dsh-chamber/control-plane'
import { clearAuthCookie, registerAuthCookie } from '@dsh-chamber/control-plane'
import { createGatewayProxy } from '../src/gateway-proxy.ts'
import { TRUST_DECLARATION_SCRIPT } from '../src/html-inject.ts'
import { FakeRequest, FakeResponse } from './utils.ts'

const quietLogger = { log() {}, warn() {}, error() {} }

function fakeRequest(url: string, method = 'GET', body?: string): ProxyRequest {
  const emitter = new EventEmitter()
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return Object.assign(emitter, {
    url,
    method,
    headers: {},
    async * [Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }) as unknown as ProxyRequest
}

function fakeResponse(): ProxyResponse & { status: number | null; body: string; destroyed: boolean } {
  const emitter = new EventEmitter()
  const res = Object.assign(emitter, {
    status: null as number | null,
    body: '',
    destroyed: false,
    headersSent: false,
    writeHead(status: number, _headers?: Record<string, unknown>) {
      this.status = status
      this.headersSent = true
      return undefined
    },
    write(chunk: unknown) { this.body += String(chunk); return true },
    end(payload?: unknown) { if (payload !== undefined) this.body += String(payload); return undefined },
    setHeader() {},
    destroy() { this.destroyed = true },
  })
  return res as any
}

function fakeSocket(): ProxySocket & { written: string; destroyed: boolean } {
  const emitter = new EventEmitter()
  const socket = Object.assign(emitter, {
    written: '',
    destroyed: false,
    write(data: unknown) { this.written += String(data); return true },
    end(data?: unknown) { if (data !== undefined) this.written += String(data); return undefined },
    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      emitter.emit('close')
    },
    pipe(target: unknown) { return target },
  })
  return socket as any
}

test('SSRF: an absolute-form request target is rejected with 400 (no upstream hit)', async () => {
  const proxy = createGatewayProxy({ logger: quietLogger, getLocalDshPort: () => 17510, getLocalState: () => 'ready' })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('http://evil.com/x'), res)
  assert.equal(res.status, 400)
})

test('SSRF: a protocol-relative request target is rejected with 400', async () => {
  const proxy = createGatewayProxy({ logger: quietLogger, getLocalDshPort: () => 17510, getLocalState: () => 'ready' })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('//evil.com/x'), res)
  assert.equal(res.status, 400)
})

test('SSRF: a backslash authority request target is rejected for HTTP and WebSocket', async () => {
  const proxy = createGatewayProxy({ logger: quietLogger, getLocalDshPort: () => 17510, getLocalState: () => 'ready' })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/\\evil.example/api/session/list'), res)
  assert.equal(res.status, 400)

  const socket = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/\\evil.example/api/remote.mux'), socket, Buffer.alloc(0))
  assert.match(socket.written, /400/)
})

test('HTTP forward carries the 0.1.2 browser-auth cookie for the managed dsh', async () => {
  // review-round4 P1 / round5 coverage: the gateway's own proxy must inject
  // the spawn-minted cookie — a real upstream records what it received.
  const seen: string[] = []
  const server = createServer((req, res) => {
    seen.push(String(req.headers.cookie ?? ''))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`
  try {
    registerAuthCookie(base, 'browser-auth=sess')
    const proxy = createGatewayProxy({ logger: quietLogger, getLocalDshPort: () => port, getLocalState: () => 'ready' })
    const res = fakeResponse()
    await proxy.handleHttp(fakeRequest('/api/session/list', 'POST'), res)
    // The forward dispatches asynchronously — wait for the upstream hit.
    const deadline = Date.now() + 3_000
    while (seen.length === 0) {
      if (Date.now() >= deadline) throw new Error('upstream never received the forward')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(seen[0], 'browser-auth=sess')
  } finally {
    clearAuthCookie(base)
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('an origin-form request target is accepted (no 400 before forwarding)', async () => {
  const proxy = createGatewayProxy({ logger: quietLogger, getLocalDshPort: () => 17510, getLocalState: () => 'ready' })
  const res = fakeResponse()
  // dsh is "ready" but the real upstream (127.0.0.1:17510) is not listening —
  // the request must NOT be rejected as a bad target (it should reach the
  // upstream setup and fail later as 502/503, not 400).
  await proxy.handleHttp(fakeRequest('/api/session/list'), res)
  assert.notEqual(res.status, 400)
})

test('not ready → 503 instance_unavailable (proxy honesty)', async () => {
  const proxy = createGatewayProxy({ logger: quietLogger, getLocalDshPort: () => null, getLocalState: () => 'stopped' })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/'), res)
  assert.equal(res.status, 503)
})

test('WS: an unknown WebSocket path is rejected with 404', async () => {
  const proxy = createGatewayProxy({ logger: quietLogger, getLocalDshPort: () => 17510, getLocalState: () => 'ready' })
  const socket = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/not-a-stream'), socket, Buffer.alloc(0))
  assert.match(socket.written, /404/)
})

test('activation window: canExposeLocal=false refuses HTTP and WS upgrade with 503 instance_unavailable', async () => {
  const proxy = createGatewayProxy({
    logger: quietLogger,
    getLocalDshPort: () => 17510,
    getLocalState: () => 'ready',
    canExposeLocal: () => false,
  })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/'), res)
  assert.equal(res.status, 503)
  assert.match(res.body, /instance_unavailable/)
  const socket = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/remote.mux'), socket, Buffer.alloc(0))
  assert.match(socket.written, /503/)
  assert.match(socket.written, /instance_unavailable/)
})

test('canExposeLocal=true keeps the ready proxy behavior unchanged', async () => {
  const proxy = createGatewayProxy({
    logger: quietLogger,
    getLocalDshPort: () => 17510,
    getLocalState: () => 'ready',
    canExposeLocal: () => true,
  })
  const res = fakeResponse()
  // dsh is "ready" but the real upstream (127.0.0.1:17510) is not listening —
  // the request must NOT be rejected by the activation gate (it should reach
  // the upstream setup and fail later as 502/503, not a target rejection).
  await proxy.handleHttp(fakeRequest('/api/session/list'), res)
  assert.notEqual(res.status, 503)
  assert.notEqual(res.status, 400)
})

test('closeAllStreams revokes an authenticated HTTP request before its body finishes', async () => {
  const proxy = createGatewayProxy({ logger: quietLogger, getLocalDshPort: () => 17510, getLocalState: () => 'ready' })
  const req = Object.assign(new PassThrough(), {
    url: '/api/session.create', method: 'POST', headers: { 'content-length': '1' },
  }) as unknown as ProxyRequest & PassThrough
  const res = fakeResponse()
  const forwarding = proxy.handleHttp(req, res)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 1)
  proxy.closeAllStreams()
  assert.equal(req.destroyed, true, 'a slow authenticated upload is aborted before it can reach dsh')
  assert.equal(res.destroyed, true,
    'credential rotation tears down active HTTP/SSE responses, not only upgraded WebSockets')
  await forwarding
})

test('closeAllStreams aborts a WebSocket while its upstream handshake is pending', async () => {
  let upstreamSignal: AbortSignal | null = null
  const httpRequest = ((_url: URL, options: { signal: AbortSignal }) => {
    upstreamSignal = options.signal
    const request = new EventEmitter() as any
    request.destroyed = false
    request.write = () => true
    request.end = () => {}
    options.signal.addEventListener('abort', () => request.emit('error', Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    return request
  }) as unknown as HttpRequestFactory
  const proxy = createGatewayProxy({
    logger: quietLogger,
    getLocalDshPort: () => 17510,
    getLocalState: () => 'ready',
    httpRequest,
    upstreamTimeoutMs: 5_000,
  })
  const socket = fakeSocket()
  // 0.1.2 wire: the mux is the only stream path (events.mux/events.host
  // were deleted upstream).
  await proxy.handleUpgrade(fakeRequest('/api/remote.mux'), socket, Buffer.alloc(0))
  assert.equal(proxy.getDiagnostics().pendingUpgrades, 1)

  proxy.closeAllStreams()

  assert.equal(socket.destroyed, true)
  assert.equal((upstreamSignal as AbortSignal | null)?.aborted, true,
    'destroying the downstream aborts the pending upstream request')
  assert.equal(proxy.getDiagnostics().pendingUpgrades, 0)
})

// ---------------------------------------------------------------------------
// S0 HTML trust-injection seam: the gateway forwards a small text/html
// upstream document through html-inject.ts before it reaches the browser.
// The shared forwarding core is driven with an injected request factory whose
// fake ClientRequest answers `response` synchronously; the test then emits
// the upstream body chunks and `end` on the fake IncomingMessage.
// ---------------------------------------------------------------------------

interface HtmlUpstreamFixture {
  /** The fake upstream IncomingMessage (emits 'data'/'end' from the test). */
  upstreamRes: EventEmitter & { headers: Record<string, string>; statusCode: number; destroy(): void }
  proxy: ReturnType<typeof createGatewayProxy>
}

function htmlUpstreamFixture(headers: Record<string, string>): HtmlUpstreamFixture {
  const upstreamRes = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>
    statusCode: number
    destroy(): void
  }
  upstreamRes.headers = headers
  upstreamRes.statusCode = 200
  upstreamRes.destroy = () => {}
  const httpRequest = (() => {
    const upstream = new EventEmitter() as EventEmitter & {
      destroyed: boolean
      write(chunk: unknown): boolean
      end(): void
      destroy(): void
    }
    upstream.destroyed = false
    upstream.write = () => true
    upstream.destroy = () => { upstream.destroyed = true }
    // The shared core attaches its 'response' listener before dispatching, so
    // answering synchronously from end() is safe and deterministic.
    upstream.end = () => { upstream.emit('response', upstreamRes) }
    return upstream
  }) as unknown as HttpRequestFactory
  const proxy = createGatewayProxy({
    logger: quietLogger,
    getLocalDshPort: () => 17510,
    getLocalState: () => 'ready',
    httpRequest,
    upstreamTimeoutMs: 1_000,
  })
  return { upstreamRes, proxy }
}

test('S0: a text/html upstream document is trust-injected and content-length is rewritten', async () => {
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>dsh</title></head><body>ok</body></html>'
  const declared = Buffer.byteLength(html)
  const { upstreamRes, proxy } = htmlUpstreamFixture({
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(declared),
  })
  const res = new FakeResponse()
  await proxy.handleHttp(new FakeRequest('GET', '/'), res)
  // Delivered in two chunks — the buffered path must reassemble the document.
  const middle = Math.floor(html.length / 2)
  upstreamRes.emit('data', Buffer.from(html.slice(0, middle)))
  upstreamRes.emit('data', Buffer.from(html.slice(middle)))
  upstreamRes.emit('end')

  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8')
  assert.ok(res.body.includes(TRUST_DECLARATION_SCRIPT), 'the trust declaration is present')
  assert.ok(res.body.indexOf(TRUST_DECLARATION_SCRIPT) < res.body.indexOf('</head>'),
    'the declaration is inserted before </head>')
  assert.equal(res.body.split('__DSH_TRANSPORT__').length, 2, 'injected exactly once')
  assert.equal(Buffer.byteLength(res.body), declared + Buffer.byteLength(TRUST_DECLARATION_SCRIPT))
  assert.equal(res.headers['content-length'], String(Buffer.byteLength(res.body)),
    'content-length reflects the injected document')
  assert.equal(res.endCalls, 1)
})

test('S0: a non-text/html response is forwarded untouched (no injection)', async () => {
  const body = '{"ok":1}'
  const { upstreamRes, proxy } = htmlUpstreamFixture({
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  })
  const res = new FakeResponse()
  await proxy.handleHttp(new FakeRequest('GET', '/'), res)
  upstreamRes.emit('data', Buffer.from(body))
  upstreamRes.emit('end')

  assert.equal(res.statusCode, 200)
  assert.equal(res.body, body)
  assert.equal(res.body.includes('__DSH_TRANSPORT__'), false)
  assert.equal(res.headers['content-type'], 'application/json')
  assert.equal(res.headers['content-length'], String(Buffer.byteLength(body)))
  assert.equal(res.endCalls, 1)
})

test('S0: html without a </head> close tag is forwarded untouched (injector returned null)', async () => {
  const body = '<html><body><p>no head close tag here</p></body></html>'
  const { upstreamRes, proxy } = htmlUpstreamFixture({
    'content-type': 'text/html',
    'content-length': String(Buffer.byteLength(body)),
  })
  const res = new FakeResponse()
  await proxy.handleHttp(new FakeRequest('GET', '/'), res)
  upstreamRes.emit('data', Buffer.from(body))
  upstreamRes.emit('end')

  assert.equal(res.statusCode, 200)
  assert.equal(res.body, body, 'the buffered body is forwarded byte for byte')
  assert.equal(res.body.includes('__DSH_TRANSPORT__'), false)
  assert.equal(res.headers['content-length'], String(Buffer.byteLength(body)),
    'the original content-length is kept')
  assert.equal(res.endCalls, 1)
})

test('S0: a content-encoded text/html response bypasses the injection buffer', async () => {
  const chunks = [Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]), Buffer.from('gzip-ish payload bytes')]
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const { upstreamRes, proxy } = htmlUpstreamFixture({
    'content-type': 'text/html',
    'content-encoding': 'gzip',
    'content-length': String(total),
  })
  const res = new FakeResponse()
  await proxy.handleHttp(new FakeRequest('GET', '/'), res)
  for (const chunk of chunks) upstreamRes.emit('data', chunk)
  upstreamRes.emit('end')

  assert.equal(res.body.includes('__DSH_TRANSPORT__'), false)
  assert.equal(res.headers['content-length'], String(total))
  assert.equal(res.chunks.length, chunks.length)
  assert.deepEqual(res.chunks, chunks.map(chunk => String(chunk)),
    'compressed bytes are streamed through untouched')
})

test('S0: an html body over the 64KiB injection budget is flushed and streamed untouched', async () => {
  const body = '<html><head><title>big</title></head><body>' + 'x'.repeat(70_000) + '</body></html>'
  const { upstreamRes, proxy } = htmlUpstreamFixture({
    // No content-length: the upstream frames the body itself (chunked), so
    // only the actual byte count can drive the overflow.
    'content-type': 'text/html',
  })
  const res = new FakeResponse()
  await proxy.handleHttp(new FakeRequest('GET', '/'), res)
  upstreamRes.emit('data', Buffer.from(body.slice(0, 30_000)))
  upstreamRes.emit('data', Buffer.from(body.slice(30_000, 60_000)))
  upstreamRes.emit('data', Buffer.from(body.slice(60_000)))
  upstreamRes.emit('end')

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.includes('__DSH_TRANSPORT__'), false)
  assert.equal(res.headers['content-length'], undefined)
  assert.equal(res.body, body, 'every byte is forwarded exactly once')
  assert.equal(res.endCalls, 1)
})
