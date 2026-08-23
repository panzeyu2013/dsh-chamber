/**
 * Gateway single-target proxy unit tests (design 16 §6): the SSRF guard
 * (non-origin-form targets rejected), the loud 503 (dsh not ready), and the WS
 * path whitelist. Run with `node packages/gateway/test/gateway-proxy.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ProxyRequest, ProxyResponse, ProxySocket } from '@dsh-chamber/control-plane'
import { createGatewayProxy } from '../src/gateway-proxy.ts'

const quietLogger = { log() {}, warn() {}, error() {} }

function fakeRequest(url: string, method = 'GET'): ProxyRequest {
  const emitter = new EventEmitter()
  return Object.assign(emitter, { url, method, headers: {} }) as unknown as ProxyRequest
}

function fakeResponse(): ProxyResponse & { status: number | null; body: string } {
  const emitter = new EventEmitter()
  const res = Object.assign(emitter, {
    status: null as number | null,
    body: '',
    headersSent: false,
    writeHead(status: number, headers?: Record<string, unknown>) {
      this.status = status
      this.headersSent = true
      return undefined
    },
    write(chunk: unknown) { this.body += String(chunk); return true },
    end(payload?: unknown) { if (payload !== undefined) this.body += String(payload); return undefined },
    setHeader() {},
    destroy() {},
  })
  return res as any
}

function fakeSocket(): ProxySocket & { written: string } {
  const emitter = new EventEmitter()
  const socket = Object.assign(emitter, {
    written: '',
    write(data: unknown) { this.written += String(data); return true },
    end(data?: unknown) { if (data !== undefined) this.written += String(data); return undefined },
    destroy() {},
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
