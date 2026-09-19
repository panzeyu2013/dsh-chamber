/**
 * Response convergence and encoding policy (part 2 of the test/proxy split):
 * header/metadata preservation, redirect rewriting, accept-encoding identity
 * rules, the response-header seam, the 300MiB body cap, quarantine and
 * masked upstream failures.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  convergeLocation,
  createInstanceProxy,
  MAX_REQUEST_BODY_BYTES,
} from '../../src/instance-proxy.ts'
import {
  acceptsEventStream,
  forwardHttp,
  isHashedStaticAssetPath,
  isHtmlDocumentNavigation,
  MAX_BUFFERED_REQUEST_BYTES,
  requiresIdentityUpstreamEncoding,
} from '../../src/proxy-forward.ts'
import type { ProxyForwardCounters, ProxyForwardDeps } from '../../src/proxy-forward.ts'
import { DEFAULT_DSH_START_PORT } from '../../src/spawn-dsh.ts'
import {
  fakeHttpRequest,
  fakeRequest,
  fakeResponse,
  fakeSocket,
  makeProxy,
  quietLogger,
  proxyFor,
} from '../support/proxy-fakes.ts'

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
  const proxy = proxyFor(upstream.fn)
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

// ---------------------------------------------------------------------------
// M3-2' (revising the 2026 audit M3b verdict): only the requests that MUST stay
// identity keep accept-encoding stripped — HTML document navigations (their
// upstream reply must stay unencoded for the S0 trust injection: proxy-forward
// htmlInjectable → gateway html-inject.ts) and text/event-stream requests
// (transport insurance: a remote/older upstream need not carry the pinned gzip
// filter). Every other request — /api, /plugins, /auth, /chamber/<subpath>,
// hashed assets, XHR/fetch — forwards the negotiation to the upstream gzip
// middleware (dsh-host-webserver createGzipMiddleware, which itself refuses
// text/event-stream and content-range responses), and the representation label
// rides back through RESPONSE_HEADER_WHITELIST.
// ---------------------------------------------------------------------------

test("http: an HTML document navigation keeps accept-encoding stripped (M3-2')", async () => {
  const { proxy, upstream } = makeProxy()
  const res = fakeResponse()
  await proxy.handleHttp(
    fakeRequest('/api/i/local/', 'GET', {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-encoding': 'gzip, deflate, br',
    }),
    res,
  )
  assert.equal(upstream.calls.length, 1)
  assert.equal(upstream.calls[0].url.pathname, '/', 'the prefix is stripped: the navigation is the upstream document')
  const headers = upstream.calls[0].options.headers as Record<string, string>
  assert.equal(headers['accept-encoding'], undefined, 'the S0-injectable document must come back identity')
  assert.equal(res.status, 200)
})

test("http: only the identity classes keep identity — every other request negotiates compression (M3-2')", async () => {
  const { proxy, upstream } = makeProxy()
  // The /chamber namespace is a gateway-kind capability (design 17 §6): only a
  // gateway registration forwards it, and for a local target the proxy core
  // refuses it before any upstream (capability_not_found, covered above), so
  // the navigation semantics of /chamber are exercised through a gateway
  // transport.
  proxy.registerTransport('gateway:docnav', 'https://gw.example.com')
  const html = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  const cases: Array<{ path: string; method?: string; accept: string; stripped: boolean; note: string }> = [
    { path: '/api/i/local/', accept: html, stripped: true, note: 'frontend index document' },
    { path: '/api/i/gateway-docnav/chamber', accept: html, stripped: true, note: 'chamber dashboard document' },
    { path: '/api/i/gateway-docnav/chamber/', accept: html, stripped: true, note: 'chamber dashboard trailing slash' },
    { path: '/api/i/local/', method: 'HEAD', accept: html, stripped: true, note: 'HEAD is the no-body twin' },
    { path: '/api/i/local/', accept: 'application/json', stripped: false, note: 'no text/html in Accept' },
    { path: '/api/i/local/', method: 'POST', accept: html, stripped: false, note: 'POST is never a document navigation' },
    { path: '/api/i/local/api/session/list', accept: html, stripped: false, note: 'JSON RPC surface (text/html Accept is irrelevant)' },
    { path: '/api/i/local/plugins/bundle.js', accept: html, stripped: false, note: 'plugin bundle surface' },
    { path: '/api/i/local/auth/login', accept: html, stripped: false, note: 'auth surface' },
    { path: '/api/i/gateway-docnav/chamber/runtime/status', accept: html, stripped: false, note: 'chamber JSON endpoint' },
    { path: '/api/i/local/assets/index-BKQ_L1z6.js', accept: html, stripped: false, note: 'hashed build asset (never an injectable document)' },
    { path: '/api/i/local/api/session/stream', accept: 'text/event-stream', stripped: true, note: 'SSE (transport insurance, never compressed)' },
    { path: '/api/i/local/api/remote.mux', accept: 'text/event-stream', stripped: true, note: 'mux stream path, same insurance' },
    { path: '/api/i/local/api/session/list', method: 'POST', accept: 'text/event-stream', stripped: true, note: 'SSE insurance is path- and method-independent' },
    { path: '/api/i/local/api/session/stream', accept: 'application/json', stripped: false, note: 'no text/event-stream in Accept → ordinary negotiation' },
  ]
  for (const [index, entry] of cases.entries()) {
    await proxy.handleHttp(
      fakeRequest(entry.path, entry.method ?? 'GET', { accept: entry.accept, 'accept-encoding': 'gzip, deflate, br' }),
      fakeResponse(),
    )
    const headers = upstream.calls[index].options.headers as Record<string, string>
    assert.equal(headers['accept-encoding'], entry.stripped ? undefined : 'gzip, deflate, br', entry.note)
  }
  assert.equal(upstream.calls.length, cases.length)
})

test("http: a compressed non-document reply keeps its content-encoding + vary, an SSE reply streams unencoded (M3-2')", async () => {
  // An SSE request is stripped to identity (transport insurance, see the
  // predicate below), so the upstream answers it unencoded; the upstream gzip
  // middleware's OWN filter (text/event-stream, content-range) stays the second
  // line of defense for fetch-based streams whose Accept is generic. Either way
  // the proxy relays the representation label verbatim.
  let contentType = 'application/javascript'
  const upstream = fakeHttpRequest(() => ({
    response: {
      status: 200,
      headers: { 'content-type': contentType, 'content-encoding': 'gzip', vary: 'accept-encoding' },
      body: 'compressed-bytes',
    },
  }))
  const proxy = proxyFor(upstream.fn)
  const asset = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/assets/index-BKQ_L1z6.js', 'GET', { 'accept-encoding': 'gzip' }), asset)
  assert.equal(asset.headers['content-encoding'], 'gzip')
  assert.equal(asset.headers.vary, 'accept-encoding')
  contentType = 'text/event-stream'
  const sse = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/stream', 'GET', { accept: 'text/event-stream', 'accept-encoding': 'gzip' }), sse)
  assert.equal(sse.headers['content-type'], 'text/event-stream')
  assert.equal(sse.body, 'compressed-bytes', 'SSE bodies stream through byte for byte')
})

test("upgrade: accept-encoding never rides the WS handshake (M3-2' leaves the 101 allowlist unchanged)", async () => {
  const upstream = fakeHttpRequest(() => ({
    upgrade: { status: 101, headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-accept': 'accepted' } },
  }))
  const proxy = proxyFor(upstream.fn)
  const socket = fakeSocket()
  await proxy.handleUpgrade(
    fakeRequest('/api/i/local/api/remote.mux', 'GET', {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'k',
      'sec-websocket-version': '13',
      'accept-encoding': 'gzip, deflate, br',
    }),
    socket,
    Buffer.alloc(0),
  )
  const headers = upstream.calls[0].options.headers as Record<string, string>
  assert.equal(headers['accept-encoding'], undefined, 'a 101 has no body to negotiate; the allowlist stays as-is')
  assert.equal(headers['sec-websocket-key'], 'k', 'the handshake itself is untouched')
  assert.match(socket.written, /101 Switching Protocols/)
})

test("isHtmlDocumentNavigation: decision table (mirrors gateway dispatch.ts semantics)", () => {
  const html = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
  // Navigations: GET/HEAD + text/html + outside the JSON/SSE surfaces.
  assert.equal(isHtmlDocumentNavigation('GET', '/', html), true)
  assert.equal(isHtmlDocumentNavigation('HEAD', '/index.html', html), true)
  assert.equal(isHtmlDocumentNavigation('get', '/chamber', html), true)
  assert.equal(isHtmlDocumentNavigation('GET', '/chamber/', html), true)
  assert.equal(isHtmlDocumentNavigation('GET', '/assets/index-BKQ_L1z6.js', html), false) // content-addressed asset: never the document
  // ...including the nested asset directories the pinned dist actually ships.
  assert.equal(isHtmlDocumentNavigation('GET', '/assets/fonts/KaTeX_AMS-Regular-BQhdFMY1.woff2', html), false)
  assert.equal(isHtmlDocumentNavigation('GET', '/assets/langs/cpp-DIPi6g--.js', html), false)
  assert.equal(isHtmlDocumentNavigation('GET', '/assets/foo.js', html), true) // not content-addressed → conservative identity
  assert.equal(isHtmlDocumentNavigation('GET', '/favicon.svg', html), true) // conservative: unhashed root file
  assert.equal(isHtmlDocumentNavigation('GET', '/index.html', html), true) // the injectable document itself
  assert.equal(isHtmlDocumentNavigation('GET', '/auth', html), true) // bare /auth mirrors dispatch.ts (only /auth/… is a surface)
  // Surface paths that a client may still advertise HTML for.
  assert.equal(isHtmlDocumentNavigation('GET', '/api', html), false)
  assert.equal(isHtmlDocumentNavigation('GET', '/api/session/list', html), false)
  assert.equal(isHtmlDocumentNavigation('GET', '/plugins', html), false)
  assert.equal(isHtmlDocumentNavigation('GET', '/plugins/x.js', html), false)
  assert.equal(isHtmlDocumentNavigation('GET', '/auth/login', html), false)
  assert.equal(isHtmlDocumentNavigation('GET', '/chamber/runtime/status', html), false)
  // Method + Accept gates.
  assert.equal(isHtmlDocumentNavigation('POST', '/', html), false)
  assert.equal(isHtmlDocumentNavigation('GET', '/', 'application/json'), false)
  assert.equal(isHtmlDocumentNavigation('GET', '/', undefined), false)
  assert.equal(isHtmlDocumentNavigation('GET', '/', []), false)
  assert.equal(isHtmlDocumentNavigation(undefined, '/', html), false)
  // Accept as a duplicated header (node gives an array).
  assert.equal(isHtmlDocumentNavigation('GET', '/', ['application/json', 'text/html']), true)
})

test("accept-encoding policy: SSE keeps identity as transport insurance, not as a navigation (M3-2' follow-up)", () => {
  const sse = 'text/event-stream'
  // The SSE class is independent of the document-navigation predicate …
  assert.equal(isHtmlDocumentNavigation('GET', '/api/session/stream', sse), false, 'SSE is NOT a document navigation')
  assert.equal(acceptsEventStream(sse), true)
  assert.equal(acceptsEventStream('text/event-stream;q=1'), true)
  assert.equal(acceptsEventStream('TEXT/EVENT-STREAM'), true, 'Accept matching is case-insensitive')
  assert.equal(acceptsEventStream(['application/json', 'text/event-stream']), true)
  assert.equal(acceptsEventStream(undefined), false)
  assert.equal(acceptsEventStream([]), false)
  assert.equal(acceptsEventStream('application/json'), false)
  // … and the strip decision is their union, path- and method-independent for
  // the SSE half (`/api/remote.mux` and a POST stream are both covered).
  assert.equal(requiresIdentityUpstreamEncoding('GET', '/api/remote.mux', sse), true)
  assert.equal(requiresIdentityUpstreamEncoding('POST', '/api/session/stream', sse), true)
  assert.equal(requiresIdentityUpstreamEncoding('GET', '/', 'text/html'), true)
  assert.equal(requiresIdentityUpstreamEncoding('GET', '/assets/index-BKQ_L1z6.js', 'text/html'), false)
  assert.equal(requiresIdentityUpstreamEncoding('GET', '/api/session/list', 'application/json'), false)
  assert.equal(requiresIdentityUpstreamEncoding('POST', '/api/session/list', 'application/json'), false)
})

test('isHashedStaticAssetPath: content-addressed Vite output only (never favicon/manifest/index.html)', () => {
  // Measured 2026-12 upstream names.
  assert.equal(isHashedStaticAssetPath('/assets/index-BKQ_L1z6.js'), true)
  assert.equal(isHashedStaticAssetPath('/assets/cpp-DIPi6g--.js'), true)
  assert.equal(isHashedStaticAssetPath('/assets/KaTeX_AMS-Regular-BQhdFMY1.woff2'), true)
  assert.equal(isHashedStaticAssetPath('/assets/main-AbCdEf12.css'), true)
  assert.equal(isHashedStaticAssetPath('/assets/logo-AbCdEf12.svg'), true)
  assert.equal(isHashedStaticAssetPath('/assets/font-AbCdEf12.woff'), true)
  assert.equal(isHashedStaticAssetPath('/assets/a-12345678.js'), true)
  // The unhashed root files the M3-3 gate must never cache as immutable.
  assert.equal(isHashedStaticAssetPath('/favicon.svg'), false)
  assert.equal(isHashedStaticAssetPath('/manifest.webmanifest'), false)
  assert.equal(isHashedStaticAssetPath('/index.html'), false)
  assert.equal(isHashedStaticAssetPath('/assets/favicon.svg'), false)
  assert.equal(isHashedStaticAssetPath('/assets/index.html'), false)
  // Not content-addressed / not in the extension set / not under /assets.
  assert.equal(isHashedStaticAssetPath('/assets/index-BKQ_L1z6.html'), false)
  assert.equal(isHashedStaticAssetPath('/assets/foo.js'), false)
  assert.equal(isHashedStaticAssetPath('/assets/my-super-long-file.js'), false) // last '-' token is the 4-char 'file'
  assert.equal(isHashedStaticAssetPath('/assets/index-BKQ_L1z6.js.map'), false)
  assert.equal(isHashedStaticAssetPath('/other/index-BKQ_L1z6.js'), false)
  // Nested asset directories are REAL at the pin (assets/fonts/*.woff2|ttf,
  // assets/langs/*.js), so exactly one level is accepted — without it the rule
  // could only ever reach the four top-level files (2026-12 review).
  assert.equal(isHashedStaticAssetPath('/assets/fonts/KaTeX_AMS-Regular-BQhdFMY1.woff2'), true)
  assert.equal(isHashedStaticAssetPath('/assets/sub/index-BKQ_L1z6.js'), true, 'one nested level is the real shape')
  assert.equal(isHashedStaticAssetPath('/assets/a/b/index-BKQ_L1z6.js'), false, 'two levels is not a Vite layout')
  // Hash-SHAPED but decoded by the upstream before it resolves: the same bytes
  // can name a different file, so no caller may treat them as an asset (this
  // guard lives in the predicate precisely so all three callers agree).
  assert.equal(isHashedStaticAssetPath('/assets/..%2f..%2fsec-12345678.js'), false)
  assert.equal(isHashedStaticAssetPath('/assets/sec%2Fret-12345678.js'), false)
  // This one is the guard's real discriminator: the pattern alone ACCEPTS it
  // (`../` is the optional nested segment), so only the `..` refusal makes it false.
  assert.equal(isHashedStaticAssetPath('/assets/../ok-12345678.js'), false)
  assert.equal(isHashedStaticAssetPath('/assets/../assets/ok-12345678.js'), false)
})

// Direct forwardHttp calls: the M3-3 seam lives on ProxyForwardDeps, which the
// gateway composes itself (gateway-proxy.ts forwardDeps) — the instance proxy
// owner never sets it, so these tests drive the shared core directly.

function forwardCounters(): ProxyForwardCounters {
  return { requests: 0, failures: 0, activeStreams: 0, bufferedRequestBytes: 0, longRpcRequests: 0, longRpcTimeouts: 0 }
}

function forwardDepsFor(httpRequest: unknown, overrides: Partial<ProxyForwardDeps> = {}): ProxyForwardDeps {
  return {
    id: 'local',
    logPrefix: 'forward-test',
    upstreamTimeoutMs: 5_000,
    clientBodyIdleTimeoutMs: 5_000,
    wsPingIntervalMs: 30_000,
    wsPingMissesBeforeTeardown: 1,
    maxBufferedRequestBytes: MAX_BUFFERED_REQUEST_BYTES,
    liveStreams: new Set(),
    httpRequest: httpRequest as ProxyForwardDeps['httpRequest'],
    ...overrides,
  }
}

test('response-header seam (M3-3): absent by default, an injected callback adds cache metadata for a hashed asset', async () => {
  const upstream = fakeHttpRequest(() => ({
    response: { status: 200, headers: { 'content-type': 'application/javascript' }, body: 'console.log(1)' },
  }))
  const target = new URL('http://127.0.0.1:17510/assets/index-BKQ_L1z6.js')
  // Default (the control-plane instance proxy): zero change, byte for byte.
  const untouched = fakeResponse()
  await forwardHttp(fakeRequest('/assets/index-BKQ_L1z6.js', 'GET'), untouched, target, () => {}, quietLogger, forwardCounters(), forwardDepsFor(upstream.fn))
  assert.deepEqual(untouched.headers, { 'content-type': 'application/javascript' })
  // Injected (the gateway owner): the callback sees the RESOLVED pathname, the
  // upstream status and the whitelisted header map, and its mutation ships.
  const seen: Array<{ pathname: string; status: number; headers: Record<string, string | string[]> }> = []
  const res = fakeResponse()
  await forwardHttp(
    fakeRequest('/assets/index-BKQ_L1z6.js', 'GET'),
    res,
    target,
    () => {},
    quietLogger,
    forwardCounters(),
    forwardDepsFor(upstream.fn, {
      onUpstreamResponseHeaders: (pathname, status, headers) => {
        seen.push({ pathname, status, headers: { ...headers } })
        if (status === 200 && isHashedStaticAssetPath(pathname)) headers['cache-control'] = 'public, max-age=31536000, immutable'
      },
    }),
  )
  assert.deepEqual(seen, [{ pathname: '/assets/index-BKQ_L1z6.js', status: 200, headers: { 'content-type': 'application/javascript' } }])
  assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable')
  assert.equal(res.headers['content-type'], 'application/javascript')
})

test('response-header seam (M3-3): runs once per response including SSE, and a throwing callback is fail-soft', async () => {
  let contentType = 'application/javascript'
  const upstream = fakeHttpRequest(() => ({
    response: { status: 200, headers: { 'content-type': contentType }, body: 'body-bytes' },
  }))
  const seenPaths: string[] = []
  const warnings: string[] = []
  const logger = {
    log: () => {},
    warn: (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) },
    error: () => {},
  }
  const deps = forwardDepsFor(upstream.fn, {
    onUpstreamResponseHeaders: pathname => {
      seenPaths.push(pathname)
      throw new Error('seam boom')
    },
  })
  const first = fakeResponse()
  await forwardHttp(fakeRequest('/assets/index-BKQ_L1z6.js', 'GET'), first, new URL('http://127.0.0.1:17510/assets/index-BKQ_L1z6.js'), () => {}, logger, forwardCounters(), deps)
  assert.equal(first.status, 200, 'a faulty seam must never break the request')
  assert.equal(first.body, 'body-bytes')
  assert.deepEqual(first.headers, { 'content-type': 'application/javascript' })
  contentType = 'text/event-stream'
  const second = fakeResponse()
  await forwardHttp(fakeRequest('/api/session/stream', 'GET'), second, new URL('http://127.0.0.1:17510/api/session/stream'), () => {}, logger, forwardCounters(), deps)
  assert.deepEqual(seenPaths, ['/assets/index-BKQ_L1z6.js', '/api/session/stream'], 'the seam runs for SSE responses too')
  assert.equal(warnings.length, 2, 'every failure is logged, never thrown')
  assert.match(warnings[0], /header seam failed: Error: seam boom/)
})

test('response-header seam (M3-3): the whitelist is re-applied after the callback, so framing cannot be injected', async () => {
  // A callback that writes framing/hop-by-hop headers must not reach the wire:
  // content-length is NOT in RESPONSE_HEADER_WHITELIST and is re-derived by the
  // proxy, so a stale value would truncate or hang the browser. Chunked (no
  // upstream content-length) and SSE are the two shapes where the proxy emits
  // no length of its own — exactly where an injected one would survive.
  const upstream = fakeHttpRequest(() => ({
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
  }))
  const injectFraming = {
    onUpstreamResponseHeaders: (_pathname: string, _status: number, headers: Record<string, string | string[]>) => {
      headers['content-length'] = '3'
      headers['transfer-encoding'] = 'chunked'
      headers['x-seam-private'] = 'nope'
      headers['cache-control'] = 'no-store'
    },
  }
  const chunked = fakeResponse()
  await forwardHttp(fakeRequest('/api/session/list', 'GET'), chunked, new URL('http://127.0.0.1:17510/api/session/list'), () => {}, quietLogger, forwardCounters(), forwardDepsFor(upstream.fn, injectFraming))
  assert.equal(chunked.headers['content-length'], undefined, 'an injected content-length must not survive a chunked response')
  assert.equal(chunked.headers['transfer-encoding'], undefined, 'framing headers stay the proxy\'s')
  assert.equal(chunked.headers['x-seam-private'], undefined, 'a non-whitelisted header never reaches the wire')
  assert.equal(chunked.headers['cache-control'], 'no-store', 'whitelisted representation metadata still ships')
  assert.equal(chunked.body, '{"ok":true}')

  const sseUpstream = fakeHttpRequest(() => ({
    response: { status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'data: x\n\n' },
  }))
  const sse = fakeResponse()
  await forwardHttp(fakeRequest('/api/session/stream', 'GET'), sse, new URL('http://127.0.0.1:17510/api/session/stream'), () => {}, quietLogger, forwardCounters(), forwardDepsFor(sseUpstream.fn, injectFraming))
  assert.equal(sse.headers['content-length'], undefined, 'an injected content-length must not survive an SSE response')
  assert.equal(sse.headers['transfer-encoding'], undefined)
  assert.equal(sse.headers['cache-control'], 'no-store')
})

test('http: a content-encoding upstream header rides through so the browser decodes correctly (M3b)', async () => {
  const upstream = fakeHttpRequest(() => ({
    response: { status: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: 'gzipped-bytes' },
  }))
  const proxy = proxyFor(upstream.fn)
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
  const proxy = proxyFor(upstream.fn)
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), res)
  assert.equal(res.status, 502)
  assert.equal(JSON.parse(res.body).code, 'upstream_failed')
  // Masked: the upstream host:port never rides the wire.
  assert.ok(!res.body.includes(String(DEFAULT_DSH_START_PORT)))
})

