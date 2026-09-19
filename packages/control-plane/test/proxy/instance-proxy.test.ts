/**
 * Instance-proxy unit tests (fake upstream injection), part 1: path mapping
 * (local / dsh-<id> / legacy ssh-<id> / gateway-<id>), local/dsh/gateway
 * routing, request convergence, cookie/header forwarding and 503/404.
 *
 * Siblings in this split (test/proxy/): response-encoding.test.ts (response
 * convergence, encoding policy, body caps), ws-upgrade.test.ts (WS
 * recognition, TCP keepalive, splice teardown), liveness-timeout.test.ts
 * (upstream/idle timeouts, long-RPC window, heartbeat), real-node-spki.test.ts
 * (real-Node stream regressions, SPKI pinning).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  parseInstanceId,
  parseInstancePath,
  tcpKeepAliveMsForUpstream,
} from '../../src/instance-proxy.ts'
import { isLoopbackUpstreamBaseUrl } from '../../src/loopback.ts'
import { clearAuthCookie, registerAuthCookie } from '../../src/browser-auth-cookie.ts'
import { DEFAULT_DSH_START_PORT } from '../../src/spawn-dsh.ts'
import {
  fakeHttpRequest,
  fakeRequest,
  fakeResponse,
  fakeSocket,
  GATEWAY_AUTHORIZATION,
  makeProxy,
  proxyFor,
} from '../support/proxy-fakes.ts'

/**
 * The upstream browser-auth cookie NAME for one request authority
 * (harness `packages/client/connection/src/browser-auth.ts` cookieName):
 * `dsh-auth-` + base64url(sha256(authority)), authority = the request Host.
 * Written per the upstream algorithm here — never copied from what the proxy
 * happens to send — so an upstream rename, or a Host rewrite that no longer
 * matches the authority the cookie was minted for, turns these tests red.
 */
function browserAuthCookieName(authority: string): string {
  return `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}`
}

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
  // through the proxy, which injects the spawn-minted cookie. The upstream
  // gate keys the cookie NAME to the request authority, so the injected name
  // must be the name derived from the Host the proxy forwards — the same
  // authority the launch-token exchange was minted for (design 03 §3.1).
  const authority = `127.0.0.1:${DEFAULT_DSH_START_PORT}`
  const host = `http://${authority}`
  const { proxy, upstream } = makeProxy({ state: 'ready', port: DEFAULT_DSH_START_PORT })
  try {
    registerAuthCookie(host, `${browserAuthCookieName(authority)}=session-value`)
    const res = fakeResponse()
    await proxy.handleHttp(
      fakeRequest('/api/i/local/api/session/list', 'POST', { 'content-type': 'application/json' }, '{"rpcId":"r1","method":"session/list"}'),
      res,
    )
    assert.equal(res.status, 200)
    const headers = upstream.calls[0].options.headers as Record<string, string>
    assert.equal(headers.host, authority, 'the upstream Host is the instance authority')
    assert.equal(headers.cookie, `${browserAuthCookieName(headers.host)}=session-value`)
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
  const proxy = proxyFor(upstream.fn, { getLocalDshPort: () => 17510 })
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
  const proxy = proxyFor(upstream.fn, { getLocalDshPort: () => 17510 })
  try {
    registerAuthCookie('http://127.0.0.1:17510', `${browserAuthCookieName('127.0.0.1:17510')}=sess`)
    const socket = fakeSocket()
    await proxy.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux', 'GET'), socket, Buffer.alloc(0))
    assert.equal(upstream.calls.length, 1)
    const headers = upstream.calls[0].options.headers as Record<string, string>
    assert.equal(headers.cookie, `${browserAuthCookieName(headers.host)}=sess`)
  } finally {
    clearAuthCookie('http://127.0.0.1:17510')
  }
})

test('transport replacement and unregister revoke already-open HTTP/SSE and WS channels', async () => {
  const upstream = fakeHttpRequest(url => url.pathname.startsWith('/api/remote.mux')
    ? { upgrade: { status: 101, headers: { upgrade: 'websocket', connection: 'Upgrade' } } }
    : { response: { status: 200, headers: { 'content-type': 'text/event-stream' }, body: null } })
  const proxy = proxyFor(upstream.fn, { getLocalDshPort: () => 17510 })
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

