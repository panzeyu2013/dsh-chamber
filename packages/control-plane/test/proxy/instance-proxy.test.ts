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
import { EventEmitter } from 'node:events'
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
  makeProxy,
  proxyFor,
  sleep,
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
  // A non-loopback upstream is the desktop's direct-http(s) shape (the
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
  // Extra-bundle URLs are `/plugins/??<id>/client.js&rev=…`
  // — the upstream serveBundle keys by the EXACT pathname+search, so a lost
  // trailing slash 404s every extra preload (boot failure on that wire).
  const parsed = parseInstancePath('/api/i/local/plugins/??abc/client.js&rev=1')
  assert.ok(parsed !== null)
  assert.equal(parsed.rest, '/plugins/')
  assert.equal(parsed.search, '??abc/client.js&rev=1')
  // The no-trailing-slash shape is unchanged.
  const plain = parseInstancePath('/api/i/local/api/session/list')
  assert.equal(plain?.rest, '/api/session/list')
})

test('local mapping forwards the 0.1.2 browser-auth cookie when bootstrapped', async () => {
  // The renderer's unary + mux calls reach the instance
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
  // The mux upgrade to the LOCAL instance must ride the
  // spawn-minted cookie — the stream gate 401s without it.
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

test('transport health: suspect forwards, down fails new requests without revoking in-flight traffic', async () => {
  const upstream = fakeHttpRequest(() => ({
    response: { status: 200, headers: { 'content-type': 'text/event-stream' }, body: null },
  }))
  const proxy = proxyFor(upstream.fn, { getLocalDshPort: () => 17510 })
  proxy.registerTransport('dsh:link', 'http://127.0.0.1:22021', undefined, { health: 'healthy' })

  const live = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/dsh-link/api/session/list'), live)
  assert.equal(live.status, 200)

  // Suspect still forwards: one probe failure must not fail user traffic.
  proxy.setTransportHealth('dsh:link', 'suspect')
  const suspect = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/dsh-link/api/session/list'), suspect)
  assert.equal(suspect.status, 200)
  assert.equal(live.destroyed, false, 'suspect must not revoke the in-flight stream')

  // Down fast-fails NEW requests with the existing code, but leaves in-flight work
  // for its own timeout/grace (the transport manager will unregister on confirm).
  proxy.setTransportHealth('dsh:link', 'down')
  const down = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/dsh-link/api/session/list'), down)
  assert.equal(down.status, 503)
  // Same wire shape as every pre-existing instance_unavailable answer: the four
  // client classifiers key on status+code and must never see a new details field.
  assert.deepEqual(JSON.parse(down.body), {
    error: 'the instance link is down',
    code: 'instance_unavailable',
  })
  assert.equal(live.destroyed, false, 'health-only down must not revoke in-flight traffic')

  // Recovery flips forwarding back without re-registering.
  proxy.setTransportHealth('dsh:link', 'healthy')
  const recovered = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/dsh-link/api/session/list'), recovered)
  assert.equal(recovered.status, 200)
  proxy.closeAllStreams()
})

test('revoking a transport after the request body finished answers after-body, not a bare destroy', async () => {
  const fn: any = () => {
    const req = new EventEmitter() as any
    req.write = () => true
    req.end = () => { req.emit('finish') }
    req.destroy = () => req.emit('close')
    return req
  }
  const proxy = proxyFor(fn, { getLocalDshPort: () => 17510 })
  proxy.registerTransport('dsh:body', 'http://127.0.0.1:22031')
  const response = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/dsh-body/api/session/create', 'POST', { 'content-length': '5' }, 'hello'), response)
  assert.equal(response.status, null, 'the upstream has not answered yet')
  proxy.unregisterTransport('dsh:body')
  assert.equal(response.status, 502)
  const body = JSON.parse(response.body) as { code: string; details?: { phase?: string } }
  assert.equal(body.code, 'upstream_failed')
  assert.equal(body.details?.phase, 'after-body')
})

test('revoking a body-less in-flight request never reports after-body', async () => {
  const upstream = fakeHttpRequest(() => undefined) // never answers
  const proxy = proxyFor(upstream.fn, { getLocalDshPort: () => 17510, upstreamTimeoutMs: 5_000 })
  proxy.registerTransport('dsh:get', 'http://127.0.0.1:22032')
  const response = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/dsh-get/api/session/list'), response)
  assert.equal(response.status, null)
  proxy.unregisterTransport('dsh:get')
  assert.equal(response.status, null, 'a body-less request has no after-body answer to give')
  assert.equal(response.destroyed, true, 'revocation tears the response down instead')
})

test('local instance not ready → explicit 503, never a silent empty success', async () => {
  const { proxy, upstream } = makeProxy({ state: 'starting', port: null })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), res)
  assert.equal(res.status, 503)
  assert.equal(JSON.parse(res.body).code, 'instance_unavailable')
  assert.equal(upstream.calls.length, 0)
})

test('local degraded still forwards (design 02 §3.5: degraded is still serving)', async () => {
  const { proxy, upstream } = makeProxy({ state: 'degraded', port: 17510 })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), res)
  assert.equal(res.status, 200)
  assert.equal(upstream.calls.length, 1, 'one failed probe must not black out local traffic')
})

test('local restarting stays 503 and carries the state detail', async () => {
  const { proxy, upstream } = makeProxy({ state: 'restarting', port: 17510 })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), res)
  assert.equal(res.status, 503)
  assert.deepEqual(JSON.parse(res.body), {
    error: 'the local instance is not ready',
    code: 'instance_unavailable',
    details: { state: 'restarting' },
  })
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


test('a bulk upload marks the link busy until its body transfer ends', async () => {
  // The manager suppresses probe failures while this is true: our own upload owns
  // the tunnel's single TCP, so a probe timeout inside the window is congestion.
  const fn: any = (_url: URL, options: { signal?: AbortSignal }) => {
    const req = new EventEmitter() as any
    req.write = () => false // backpressure forever: the flush cannot finish
    req.end = () => {}
    req.destroy = () => req.emit('close')
    options.signal?.addEventListener('abort', () => req.emit('error', new Error('Aborted')), { once: true })
    return req
  }
  const proxy = proxyFor(fn, { getLocalDshPort: () => 17510, uploadIdleTimeoutMs: 30, uploadMaxBudgetMs: 60 })
  proxy.registerTransport('dsh:busy', 'http://127.0.0.1:22050')
  assert.equal(proxy.isLinkBusy('dsh:busy'), false, 'idle before the request')
  const body = 'x'.repeat(300 * 1024)
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/dsh-busy/api/upload', 'POST', { 'content-length': String(body.length) }, body), res)
  assert.equal(proxy.isLinkBusy('dsh:busy'), true, 'a >=256KiB body owns the link while it flushes')
  assert.equal(proxy.isLinkBusy('local'), false, 'the local pool has no connectionId and no WAN link')
  await sleep(80)
  assert.equal(res.status, 504)
  assert.equal(proxy.isLinkBusy('dsh:busy'), false, 'the transfer ended with the abort')
  // A small RPC body never sets the flag: normal traffic must not mask link death.
  const small: any = (_url: URL) => {
    const req = new EventEmitter() as any
    req.write = () => true
    req.end = () => { req.emit('finish'); req.emit('error', new Error('boom')) }
    req.destroy = () => {}
    return req
  }
  const smallProxy = proxyFor(small, { getLocalDshPort: () => 17510 })
  smallProxy.registerTransport('dsh:small', 'http://127.0.0.1:22051')
  await smallProxy.handleHttp(fakeRequest('/api/i/dsh-small/api/session/create', 'POST', { 'content-length': '5' }, 'hello'), fakeResponse())
  assert.equal(smallProxy.isLinkBusy('dsh:small'), false)
  proxy.closeAllStreams()
  smallProxy.closeAllStreams()
})


test('a transport-level upstream failure notifies the failure seam; an HTTP answer never does', async () => {
  const failures: string[] = []
  // 1) Socket error: no HTTP answer at all -> the failure seam fires once.
  const erroring: any = (_url: URL) => {
    const req = new EventEmitter() as any
    req.write = () => true
    req.end = () => { req.emit('finish'); queueMicrotask(() => req.emit('error', new Error('socket hang up'))) }
    req.destroy = () => req.emit('close')
    return req
  }
  const proxy = proxyFor(erroring, { getLocalDshPort: () => 17510, upstreamTimeoutMs: 200 })
  proxy.registerTransport('dsh:seam', 'http://127.0.0.1:22060')
  proxy.onUpstreamFailure(id => failures.push(id))
  const failed = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/dsh-seam/api/session/list'), failed)
  await sleep(30)
  assert.equal(failed.status, 502)
  assert.deepEqual(failures, ['dsh:seam'], 'one transport failure names the connection exactly once')

  // 2) A host HTTP answer (even 5xx) is evidence the path WORKS: never notify.
  const answering: any = () => {
    const req = new EventEmitter() as any
    req.write = () => true
    req.end = () => {
      req.emit('finish')
      const upstream = new EventEmitter() as any
      upstream.statusCode = 503
      upstream.headers = { 'content-type': 'application/json' }
      upstream.destroy = () => upstream.emit('close')
      req.emit('response', upstream)
      upstream.emit('data', Buffer.from('{"error":"busy"}'))
      upstream.emit('end')
    }
    return req
  }
  const answerProxy = proxyFor(answering, { getLocalDshPort: () => 17510 })
  answerProxy.registerTransport('dsh:seam2', 'http://127.0.0.1:22061')
  const seen: string[] = []
  answerProxy.onUpstreamFailure(id => seen.push(id))
  await answerProxy.handleHttp(fakeRequest('/api/i/dsh-seam2/api/session/list'), fakeResponse())
  await sleep(20)
  assert.deepEqual(seen, [], 'a reachable answer is never link-failure evidence')

  // 3) A client abort is not link evidence either.
  const hanging: any = (_url: URL, options: { signal?: AbortSignal }) => {
    const req = new EventEmitter() as any
    req.write = () => true
    req.end = () => {}
    req.destroy = () => req.emit('close')
    options.signal?.addEventListener('abort', () => req.emit('error', new Error('Aborted')), { once: true })
    return req
  }
  const abortProxy = proxyFor(hanging, { getLocalDshPort: () => 17510, upstreamTimeoutMs: 5_000 })
  abortProxy.registerTransport('dsh:seam3', 'http://127.0.0.1:22062')
  const aborts: string[] = []
  abortProxy.onUpstreamFailure(id => aborts.push(id))
  const request = fakeRequest('/api/i/dsh-seam3/api/session/list')
  const response = fakeResponse()
  const pending = abortProxy.handleHttp(request, response)
  ;(request as unknown as EventEmitter).emit('aborted')
  await pending
  await sleep(20)
  assert.deepEqual(aborts, [], 'the page closing its request says nothing about the link')
  proxy.closeAllStreams()
  answerProxy.closeAllStreams()
  abortProxy.closeAllStreams()
})


test('a response body that stops flowing is link evidence (idle after headers)', async () => {
  // The contract's "never for a completed HTTP answer": headers arriving is not a
  // completed answer. A body that stalls says the path stopped carrying bytes.
  const failures: string[] = []
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
      res.emit('data', Buffer.from('{"partial":')) // headers + one chunk, then silence
    }
    return req
  }
  const proxy = proxyFor(fn, { getLocalDshPort: () => 17510, upstreamTimeoutMs: 40 })
  proxy.registerTransport('dsh:stall', 'http://127.0.0.1:22070')
  proxy.onUpstreamFailure(connectionId => failures.push(connectionId))
  await proxy.handleHttp(fakeRequest('/api/i/dsh-stall/api/session/list'), fakeResponse())
  await sleep(90)
  assert.deepEqual(failures, ['dsh:stall'], 'a stalled body is link-level evidence')
  proxy.closeAllStreams()
})


test('a response reset mid-body is link evidence (headers arrived, body died)', async () => {
  const failures: string[] = []
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
      res.emit('data', Buffer.from('{"partial":'))
      // Node delivers a mid-body RST on the IncomingMessage, NOT on the request.
      queueMicrotask(() => res.emit('error', new Error('ECONNRESET')))
    }
    return req
  }
  const proxy = proxyFor(fn, { getLocalDshPort: () => 17510, upstreamTimeoutMs: 5_000 })
  proxy.registerTransport('dsh:rst', 'http://127.0.0.1:22071')
  proxy.onUpstreamFailure(connectionId => failures.push(connectionId))
  await proxy.handleHttp(fakeRequest('/api/i/dsh-rst/api/session/list'), fakeResponse())
  await sleep(30)
  assert.deepEqual(failures, ['dsh:rst'], 'the mid-body reset is the half-open signature we need')
  proxy.closeAllStreams()
})


test('a flowing downstream body keeps the link busy; a quiet one does not', async () => {
  // A 20MB download saturates the tunnel exactly like a bulk upload: the busy
  // window must cover DOWNSTREAM progress too (design 27 §6.16).
  const fn: any = (_url: URL) => {
    const req = new EventEmitter() as any
    req.write = () => true
    req.end = () => {
      const upstream = new EventEmitter() as any
      upstream.statusCode = 200
      upstream.headers = { 'content-type': 'application/octet-stream' }
      upstream.destroy = () => upstream.emit('close')
      req.emit('response', upstream)
      upstream.emit('data', Buffer.alloc(64 * 1024, 1))
      setTimeout(() => upstream.emit('end'), 20)
    }
    return req
  }
  const proxy = proxyFor(fn, { getLocalDshPort: () => 17510, busyActivityWindowMs: 40 })
  proxy.registerTransport('dsh:down', 'http://127.0.0.1:22080')
  assert.equal(proxy.isLinkBusy('dsh:down'), false, 'a quiet connection is not busy')
  const response = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/dsh-down/api/files/blob'), response)
  assert.equal(proxy.isLinkBusy('dsh:down'), true, 'downlink bytes in the window own the link')
  await sleep(80)
  assert.equal(proxy.isLinkBusy('dsh:down'), false, 'the window closes once the downlink stops')
  proxy.unregisterTransport('dsh:down')
  proxy.closeAllStreams()
})


test('a response-cap 413 after a fully sent body carries the after-body marker', async () => {
  // Upstream declares a response body over the cap. The request body left the proxy
  // before that answer, so the mutation may have applied: the client must not be told
  // "not forwarded".
  const fn: any = (_url: URL) => {
    const req = new EventEmitter() as any
    req.write = () => true
    req.end = () => {
      req.emit('finish')
      const upstream = new EventEmitter() as any
      upstream.statusCode = 200
      upstream.headers = { 'content-type': 'application/json', 'content-length': String(301 * 1024 * 1024) }
      upstream.destroy = () => upstream.emit('close')
      req.emit('response', upstream)
    }
    return req
  }
  const proxy = proxyFor(fn, { getLocalDshPort: () => 17510 })
  proxy.registerTransport('dsh:cap', 'http://127.0.0.1:22100')
  const response = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/dsh-cap/api/session/rename', 'POST', { 'content-length': '5' }), response)
  await sleep(20)
  assert.equal(response.status, 413)
  const body = JSON.parse(String(response.body))
  assert.equal(body.code, 'body_too_large')
  assert.deepEqual(body.details, { phase: 'after-body' }, 'a fully sent body makes the cap answer uncertain')
  proxy.closeAllStreams()
})

