/**
 * Gateway single-target proxy unit tests (design 17 §6): the SSRF guard
 * (non-origin-form targets rejected), the loud 503 (dsh not ready), and the WS
 * path whitelist. Run with `node packages/gateway/test/gateway-proxy.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { HttpRequestFactory, ProxyRequest, ProxyResponse, ProxySocket } from '@dsh-chamber/control-plane'
import { createGatewayProxy } from '../src/gateway-proxy.ts'

const quietLogger = { log() {}, warn() {}, error() {} }

function fakeRequest(url: string, method = 'GET'): ProxyRequest {
  const emitter = new EventEmitter()
  return Object.assign(emitter, { url, method, headers: {} }) as unknown as ProxyRequest
}

function fakeResponse(): ProxyResponse & { status: number | null; body: string; destroyed: boolean } {
  const emitter = new EventEmitter()
  const res = Object.assign(emitter, {
    status: null as number | null,
    body: '',
    destroyed: false,
    headersSent: false,
    writeHead(status: number, headers?: Record<string, unknown>) {
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
  await proxy.handleHttp(fakeRequest('/\\evil.example/api/session.list'), res)
  assert.equal(res.status, 400)

  const socket = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/\\evil.example/api/events.mux'), socket, Buffer.alloc(0))
  assert.match(socket.written, /400/)
})

test('an origin-form request target is accepted (no 400 before forwarding)', async () => {
  const proxy = createGatewayProxy({ logger: quietLogger, getLocalDshPort: () => 17510, getLocalState: () => 'ready' })
  const res = fakeResponse()
  // dsh is "ready" but the real upstream (127.0.0.1:17510) is not listening —
  // the request must NOT be rejected as a bad target (it should reach the
  // upstream setup and fail later as 502/503, not 400).
  await proxy.handleHttp(fakeRequest('/api/session.list'), res)
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
  await proxy.handleUpgrade(fakeRequest('/api/events.mux'), socket, Buffer.alloc(0))
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
  await proxy.handleHttp(fakeRequest('/api/session.list'), res)
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
  await proxy.handleUpgrade(fakeRequest('/api/events.mux'), socket, Buffer.alloc(0))
  assert.equal(proxy.getDiagnostics().pendingUpgrades, 1)

  proxy.closeAllStreams()

  assert.equal(socket.destroyed, true)
  assert.equal((upstreamSignal as AbortSignal | null)?.aborted, true,
    'destroying the downstream aborts the pending upstream request')
  assert.equal(proxy.getDiagnostics().pendingUpgrades, 0)
})
