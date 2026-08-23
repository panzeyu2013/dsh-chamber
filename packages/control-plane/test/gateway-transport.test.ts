/**
 * Gateway transport registration + extraHeaders injection tests (design 16
 * §6.4 / D8): the new `gateway:` kind (https, non-loopback) and the per-
 * transport Authorization injection at forward time. Run with
 * `node packages/control-plane/test/gateway-transport.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createInstanceProxy } from '../src/instance-proxy.ts'
import type { ProxyRequest, ProxyResponse } from '../src/proxy-forward.ts'

const quietLogger = { log() {}, warn() {}, error() {} }

function fakeHttpRequest() {
  const calls: Array<{ url: URL; options: Record<string, unknown> }> = []
  const fn: any = (url: URL, options: Record<string, unknown>) => {
    calls.push({ url, options })
    const req = new EventEmitter() as any
    req.write = () => true
    req.end = () => {
      const res = new EventEmitter() as any
      res.statusCode = 200
      res.headers = { 'content-type': 'application/json' }
      res.destroy = () => res.emit('close')
      req.emit('response', res)
      res.emit('data', Buffer.from('{"ok":true}'))
      res.emit('end')
    }
    const signal = options?.signal as AbortSignal | undefined
    if (signal !== undefined) {
      if (signal.aborted) process.nextTick(() => req.emit('error', new Error('Aborted')))
      else signal.addEventListener('abort', () => req.emit('error', new Error('Aborted')), { once: true })
    }
    return req
  }
  return { fn, calls }
}

function fakeRequest(url: string, method = 'POST'): ProxyRequest {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    url,
    method,
    headers: {},
    async * [Symbol.asyncIterator]() {
      // empty body (POST with no chunks — readBody returns an empty buffer)
    },
  }) as unknown as ProxyRequest
}

function fakeResponse(): ProxyResponse & { status: number | null } {
  const emitter = new EventEmitter()
  const res = Object.assign(emitter, {
    status: null as number | null,
    headersSent: false,
    writeHead(status: number) { this.status = status; this.headersSent = true; return undefined },
    write() { return true },
    end() { return undefined },
    setHeader() {},
    destroy() {},
  })
  return res as any
}

test('registerTransport accepts a gateway https non-loopback origin + extraHeaders', () => {
  const upstream = fakeHttpRequest()
  const proxy = createInstanceProxy({ logger: quietLogger, getLocalState: () => 'ready', getLocalDshPort: () => 17510, httpRequest: upstream.fn })
  // Non-loopback https origin with an Authorization header (design 16 §6.4).
  proxy.registerTransport('gateway:server-1', 'https://gateway.example.com:8443', { authorization: 'Bearer secret' })
  assert.equal(proxy.getDiagnostics().transports, 1)
})

test('registerTransport rejects a gateway http (not https) URL', () => {
  const upstream = fakeHttpRequest()
  const proxy = createInstanceProxy({ logger: quietLogger, getLocalState: () => 'ready', getLocalDshPort: () => 17510, httpRequest: upstream.fn })
  assert.throws(() => proxy.registerTransport('gateway:x', 'http://example.com'), /https/)
})

test('registerTransport rejects a gateway URL with a path/credentials', () => {
  const upstream = fakeHttpRequest()
  const proxy = createInstanceProxy({ logger: quietLogger, getLocalState: () => 'ready', getLocalDshPort: () => 17510, httpRequest: upstream.fn })
  assert.throws(() => proxy.registerTransport('gateway:x', 'https://example.com/path'), /origin/)
})

test('registerTransport still rejects a non-loopback ssh baseUrl', () => {
  const upstream = fakeHttpRequest()
  const proxy = createInstanceProxy({ logger: quietLogger, getLocalState: () => 'ready', getLocalDshPort: () => 17510, httpRequest: upstream.fn })
  assert.throws(() => proxy.registerTransport('ssh:x', 'https://example.com'), /loopback/)
})

test('extraHeaders are injected at forward time and never override host/origin', async () => {
  const upstream = fakeHttpRequest()
  const proxy = createInstanceProxy({ logger: quietLogger, getLocalState: () => 'ready', getLocalDshPort: () => 17510, httpRequest: upstream.fn })
  proxy.registerTransport('gateway:server-1', 'https://gateway.example.com:8443', {
    authorization: 'Bearer secret',
    host: 'evil.injected',
    origin: 'https://evil.injected',
  })
  await proxy.handleHttp(fakeRequest('/api/i/gateway-server-1/api/session.list'), fakeResponse())
  assert.equal(upstream.calls.length, 1)
  const headers = upstream.calls[0].options.headers as Record<string, string>
  // The Authorization header rides through; host must NOT be overridden by the
  // injected extraHeaders, and the injected origin is dropped (the request had
  // no origin to rewrite, so none may appear).
  assert.equal(headers.authorization, 'Bearer secret')
  assert.equal(headers.host, 'gateway.example.com:8443')
  assert.equal(headers.origin, undefined)
})
