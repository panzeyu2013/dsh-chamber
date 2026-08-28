/**
 * Gateway transport registration + extraHeaders injection tests (design 17
 * §9.3): the `gateway:` kind (http(s) direct origin, non-loopback) with
 * 0..2 whitelisted bounded headers (Authorization Bearer / Cookie
 * dsh_gateway_session) injected at forward time, and the legacy `ssh:`
 * spelling of the dsh kind. Run with
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
      req.emit('finish')
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

function makeGatewayProxy() {
  const upstream = fakeHttpRequest()
  const proxy = createInstanceProxy({ logger: quietLogger, getLocalState: () => 'ready', getLocalDshPort: () => 17510, httpRequest: upstream.fn })
  return { proxy, upstream }
}

test('registerTransport accepts a gateway https non-loopback origin + Authorization', () => {
  const { proxy } = makeGatewayProxy()
  // Non-loopback https origin with an Authorization header (design 17 §9.3).
  proxy.registerTransport('gateway:server-1', 'https://gateway.example.com:8443', { authorization: 'Bearer secret' })
  assert.equal(proxy.getDiagnostics().transports, 1)
})

test('registerTransport accepts a gateway http origin (insecureHttp direct)', () => {
  const { proxy } = makeGatewayProxy()
  // http direct is the user's explicit insecureHttp choice (design 17 §9.3) —
  // origin constraints still apply, only the protocol is relaxed.
  proxy.registerTransport('gateway:plain', 'http://gw.internal:8080')
  assert.equal(proxy.getDiagnostics().transports, 1)
})

test('registerTransport rejects a gateway non-http(s) URL', () => {
  const { proxy } = makeGatewayProxy()
  assert.throws(() => proxy.registerTransport('gateway:x', 'ftp://example.com'), /http\(s\)/)
  assert.throws(() => proxy.registerTransport('gateway:x', 'file:///etc/passwd'), /http\(s\)/)
})

test('registerTransport rejects a gateway URL with a path/credentials', () => {
  const { proxy } = makeGatewayProxy()
  assert.throws(() => proxy.registerTransport('gateway:x', 'https://example.com/path'), /origin/)
  assert.throws(() => proxy.registerTransport('gateway:x', 'https://user:pw@example.com'), /origin/)
})

test('registerTransport still rejects a non-loopback ssh baseUrl', () => {
  const { proxy } = makeGatewayProxy()
  assert.throws(() => proxy.registerTransport('ssh:x', 'https://example.com'), /loopback/)
})

test('gateway transport injects 0..2 bounded whitelist headers (Authorization/Cookie) and rejects the rest', () => {
  const { proxy } = makeGatewayProxy()
  // 0 headers: a credential-less gateway target is legal — the probe/forward
  // answers whatever the server enforces (design 17 §2.3, no upfront reject).
  proxy.registerTransport('gateway:none', 'https://gateway.example.com')
  assert.equal(proxy.getDiagnostics().transports, 1)

  // 1 header: either Authorization or Cookie alone.
  proxy.registerTransport('gateway:auth', 'https://gateway.example.com', { authorization: 'Bearer secret' })
  proxy.registerTransport('gateway:cookie', 'https://gateway.example.com', { cookie: 'dsh_gateway_session=abc.def' })
  assert.equal(proxy.getDiagnostics().transports, 3)

  // 2 headers: Authorization + Cookie together.
  proxy.registerTransport('gateway:both', 'https://gateway.example.com', {
    authorization: 'Bearer secret',
    cookie: 'dsh_gateway_session=abc.def',
  })
  assert.equal(proxy.getDiagnostics().transports, 4)

  // Anything outside the whitelist is rejected.
  assert.throws(
    () => proxy.registerTransport('gateway:multi', 'https://gateway.example.com', { authorization: 'Bearer secret', host: 'evil' }),
    /Authorization\/Cookie/,
  )
  assert.throws(
    () => proxy.registerTransport('gateway:host', 'https://gateway.example.com', { cookie: 'dsh_gateway_session=abc', host: 'evil' }),
    /Authorization\/Cookie/,
  )
  assert.throws(
    () => proxy.registerTransport('gateway:basic', 'https://gateway.example.com', { authorization: 'Basic secret' }),
    /Bearer credential/,
  )
  assert.throws(
    () => proxy.registerTransport('gateway:crlf', 'https://gateway.example.com', { authorization: 'Bearer good\r\nx-evil: yes' }),
    /Bearer credential/,
  )
  // Cookie bounds: wrong name, CRLF, extra cookie pair, overlong value.
  assert.throws(
    () => proxy.registerTransport('gateway:badname', 'https://gateway.example.com', { cookie: 'evil=1' }),
    /dsh_gateway_session/,
  )
  assert.throws(
    () => proxy.registerTransport('gateway:crlf-cookie', 'https://gateway.example.com', { cookie: 'dsh_gateway_session=ab\r\nx-evil: yes' }),
    /dsh_gateway_session/,
  )
  assert.throws(
    () => proxy.registerTransport('gateway:extra-pair', 'https://gateway.example.com', { cookie: 'dsh_gateway_session=ab; evil=1' }),
    /dsh_gateway_session/,
  )
  assert.throws(
    () => proxy.registerTransport('gateway:dup', 'https://gateway.example.com', { authorization: 'Bearer a', Authorization: 'Bearer b' }),
    /at most once/,
  )
  // dsh targets (incl. the legacy ssh spelling) never inject headers.
  assert.throws(
    () => proxy.registerTransport('ssh:inject', 'http://127.0.0.1:22001', { authorization: 'Bearer secret' }),
    /cannot inject/,
  )
  assert.throws(
    () => proxy.registerTransport('dsh:inject', 'http://127.0.0.1:22001', { cookie: 'dsh_gateway_session=abc' }),
    /cannot inject/,
  )
})

test('validated Authorization is injected at forward time without changing authority', async () => {
  const { proxy, upstream } = makeGatewayProxy()
  proxy.registerTransport('gateway:server-1', 'https://gateway.example.com:8443', { Authorization: 'Bearer secret' })
  await proxy.handleHttp(fakeRequest('/api/i/gateway-server-1/api/session.list'), fakeResponse())
  assert.equal(upstream.calls.length, 1)
  const headers = upstream.calls[0].options.headers as Record<string, string>
  assert.equal(headers.authorization, 'Bearer secret')
  assert.equal(headers.host, 'gateway.example.com:8443')
  assert.equal(headers.origin, undefined)
})

test('Authorization + Cookie both ride the forward, and a 0-header gateway injects neither', async () => {
  const { proxy, upstream } = makeGatewayProxy()
  proxy.registerTransport('gateway:both', 'https://gateway.example.com', {
    authorization: 'Bearer secret',
    cookie: 'dsh_gateway_session=abc.def',
  })
  await proxy.handleHttp(fakeRequest('/api/i/gateway-both/api/session.list'), fakeResponse())
  assert.equal(upstream.calls.length, 1)
  const headers = upstream.calls[0].options.headers as Record<string, string>
  assert.equal(headers.authorization, 'Bearer secret')
  assert.equal(headers.cookie, 'dsh_gateway_session=abc.def')

  // A credential-less gateway target injects neither header.
  proxy.registerTransport('gateway:anon', 'http://gw.internal:8080')
  await proxy.handleHttp(fakeRequest('/api/i/gateway-anon/api/session.list'), fakeResponse())
  const anonHeaders = upstream.calls[1].options.headers as Record<string, string>
  assert.equal(anonHeaders.authorization, undefined)
  assert.equal(anonHeaders.cookie, undefined)
})

test('an ssh-tunneled gateway transport overrides the upstream Host with the remote authority (design 17 §9.3 隧道 Host 覆盖)', async () => {
  const { proxy, upstream } = makeGatewayProxy()
  // Tunnel shape: loopback baseUrl + the REMOTE gateway authority override.
  proxy.registerTransport('gateway:tunnel', 'http://127.0.0.1:43123', { authorization: 'Bearer secret' }, { authority: '192.168.110.172:30801' })
  await proxy.handleHttp(fakeRequest('/api/i/gateway-tunnel/api/host.describe'), fakeResponse())
  assert.equal(upstream.calls.length, 1)
  const headers = upstream.calls[0].options.headers as Record<string, string>
  assert.equal(headers.host, '192.168.110.172:30801', 'the remote authority rides the Host header')
  assert.equal(headers.authorization, 'Bearer secret', 'the credential still rides')
})

test('registerTransport authority validation: gateway-only, host[:port] shape (design 17 §9.3)', () => {
  const { proxy } = makeGatewayProxy()
  // Bracket-free IPv6 is accepted like the host whitelists.
  proxy.registerTransport('gateway:v6', 'http://127.0.0.1:43124', undefined, { authority: '[2001:db8::1]:30801' })
  // dsh targets can never override the Host (no Host policy to satisfy).
  assert.throws(() => proxy.registerTransport('dsh:x', 'http://127.0.0.1:43125', undefined, { authority: 'gw:30801' }), /cannot override/)
  // Shape gates: path, scheme, credentials, spaces, oversized.
  assert.throws(() => proxy.registerTransport('gateway:x', 'http://127.0.0.1:43126', undefined, { authority: 'gw.example.com/path' }), /host\[:port\]/)
  assert.throws(() => proxy.registerTransport('gateway:x', 'http://127.0.0.1:43127', undefined, { authority: 'https://gw.example.com' }), /host\[:port\]/)
  assert.throws(() => proxy.registerTransport('gateway:x', 'http://127.0.0.1:43128', undefined, { authority: 'user@host:30801' }), /host\[:port\]/)
  assert.throws(() => proxy.registerTransport('gateway:x', 'http://127.0.0.1:43129', undefined, { authority: 'a b:30801' }), /host\[:port\]/)
  assert.throws(() => proxy.registerTransport('gateway:x', 'http://127.0.0.1:43130', undefined, { authority: 'h'.repeat(300) }), /host\[:port\]/)
})
