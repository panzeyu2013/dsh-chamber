/**
 * Login-phase pre-warm tests (design 17 §10.6): the
 * capability-cookie mint/verify pair, the two REAL bundle shapes, the pre-auth
 * route (405/429/503/502/upstream), the bounded aggregate budget, discovery
 * extraction + the spawn-minted browser-auth cookie + the split in-process
 * cache (60 s success / 10 s failure), and the bounded per-client rate limiter.
 *
 * Plain node:test + node:assert, no new deps. This file imports ONLY
 * src/warmup.ts (node builtins) so it runs even in a checkout without the
 * workspace node_modules link; the dispatch-level wiring (pre-auth claim,
 * 405 audit, login→href join) lives in boundary-login-page.test.ts.
 * Run with `node packages/gateway/test/boundary/warmup.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  MAX_WARMUP_BUNDLE_URLS,
  MAX_WARMUP_CONCURRENT_FETCHES,
  MAX_WARMUP_TARGET_CHARS,
  WARMUP_CAPACITY_CODE,
  WARMUP_COOKIE_NAME,
  WARMUP_COOKIE_PATH,
  WARMUP_COOKIE_TTL_SECONDS,
  WARMUP_DISCOVERY_CACHE_TTL_MS,
  WARMUP_DISCOVERY_FAILURE_TTL_MS,
  WARMUP_RATE_LIMIT_CAPACITY,
  buildWarmupCookieHeader,
  createWarmupController,
  createWarmupCookie,
  createWarmupRateLimiter,
  extractWarmupBundleUrls,
  isWarmupPathAllowed,
  isValidDshPort,
  mergeVary,
  readWarmupCookie,
  verifyWarmupCookie,
  type WarmupController,
  type WarmupHttpRequest,
  type WarmupHttpResponse,
} from '../../src/warmup.ts'

const SECRET = 'test-jwt-secret-DO-NOT-LOG'
const BUNDLE = '/plugins/??@dsh-chamber/dsh-client-ui-mobile/client.js,@scope/pkg/client.js&rev=abc123'
const SINGLE_BUNDLE = '/plugins/dsh-chamber-mcp/client.js'
const NOW = 1_700_000_000
const CLIENT = '203.0.113.8'
/** The spawn-minted browser-auth cookie the internal loopback legs carry. */
const BROWSER_AUTH = 'browser-auth=spawn-minted'
const ORIGIN = 'http://gateway.example:3000'

class FakeResponse implements WarmupHttpResponse {
  status = 0
  headers: Record<string, string> = {}
  body: Buffer = Buffer.alloc(0)
  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value
    return this
  }
  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.status = status
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
    return this
  }
  end(chunk?: unknown): this {
    this.body = chunk === undefined ? Buffer.alloc(0)
      : Buffer.isBuffer(chunk) ? chunk
        : Buffer.from(String(chunk), 'utf8')
    return this
  }
  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()]
  }
  json(): any {
    return JSON.parse(this.body.toString('utf8'))
  }
}

function fakeRequest(
  method: string,
  headers: Record<string, string | string[] | undefined> = {},
  remoteAddress = CLIENT,
  url = BUNDLE,
): WarmupHttpRequest {
  return { method, url, headers, socket: { remoteAddress } }
}

function bundleUrl(url = BUNDLE): URL {
  return new URL(url, ORIGIN)
}

/** A realistic prefetch request: the browser sends its cookies for the page
 * (the capability grant) and would send any session cookie too. */
function grantedRequest(method = 'GET', nowSeconds = NOW, client = CLIENT, url = BUNDLE): WarmupHttpRequest {
  return fakeRequest(method, { cookie: WARMUP_COOKIE_NAME + '=' + createWarmupCookie(SECRET, nowSeconds, client) }, client, url)
}

interface ControllerOptions {
  enabled?: boolean
  port?: number | null
  state?: string
  secret?: string | null
  authCookie?: string | undefined
  budget?: { maxConcurrentFetches?: number; maxTotalBufferedBytes?: number }
  fetchIndex?: (url: string, signal: AbortSignal, authCookie: string | undefined) => Promise<string>
  now?: () => number
}

function createController(options: ControllerOptions = {}): { warmup: WarmupController; warnings: string[] } {
  const warnings: string[] = []
  const warmup = createWarmupController({
    enabled: options.enabled ?? true,
    getLocalDshPort: () => options.port ?? null,
    getLocalState: () => options.state ?? 'ready',
    getSecret: () => {
      if (options.secret === null) throw new Error('secret unavailable')
      return options.secret ?? SECRET
    },
    getAuthCookie: () => options.authCookie,
    logger: { warn: message => { warnings.push(message) } },
    now: options.now ?? (() => NOW * 1000),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.fetchIndex === undefined ? {} : { fetchIndex: options.fetchIndex }),
  })
  return { warmup, warnings }
}

function controller(options: ControllerOptions = {}): WarmupController {
  return createController(options).warmup
}

/** Mint base64url(payload).base64url(HMAC(HMAC(secret,label),payload)) — the
 *  shared warm-up envelope under an arbitrary domain label, used to prove the
 *  label separation (no exported signer can mint a foreign-universe value). */
function mintUnderLabel(label: string, payload: string): string {
  const key = createHmac('sha256', SECRET).update(label, 'utf8').digest()
  const mac = createHmac('sha256', key).update(payload, 'utf8').digest()
  return Buffer.from(payload, 'utf8').toString('base64url') + '.' + mac.toString('base64url')
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function close(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()))
}

// ---------------------------------------------------------------------------
// Capability cookie
// ---------------------------------------------------------------------------

test('warmup cookie: a minted grant verifies, expires, and is a different token universe from the URL token', () => {
  const grant = createWarmupCookie(SECRET, NOW, CLIENT)
  assert.equal(verifyWarmupCookie(SECRET, grant, NOW, CLIENT), true)
  assert.equal(verifyWarmupCookie(SECRET, grant, NOW + WARMUP_COOKIE_TTL_SECONDS, CLIENT), true)
  assert.equal(verifyWarmupCookie(SECRET, grant, NOW + WARMUP_COOKIE_TTL_SECONDS + 1, CLIENT), false)
  assert.equal(verifyWarmupCookie('another-secret', grant, NOW, CLIENT), false)
  // Domain separation (the retired URL token's label is kept here as the
  // concrete foreign universe): a value carrying the RIGHT payload shape but
  // signed under any other label is not a grant, so a token minted for another
  // purpose can never be replayed as one.
  const foreign = mintUnderLabel('dsh-gateway/warmup-token/v1', (NOW + WARMUP_COOKIE_TTL_SECONDS) + '|warmup|' + CLIENT)
  assert.equal(verifyWarmupCookie(SECRET, foreign, NOW, CLIENT), false, 'another label is another token universe')
})

test('warmup cookie: the client-address binding is enforced when the grant is bound', () => {
  const bound = createWarmupCookie(SECRET, NOW, CLIENT)
  assert.equal(verifyWarmupCookie(SECRET, bound, NOW, CLIENT), true)
  assert.equal(verifyWarmupCookie(SECRET, bound, NOW, '198.51.100.7'), false)
  assert.equal(verifyWarmupCookie(SECRET, bound, NOW), false, 'a bound grant never verifies without an address')
  assert.equal(verifyWarmupCookie(SECRET, bound, NOW, ''), false)
  const unbound = createWarmupCookie(SECRET, NOW)
  assert.equal(verifyWarmupCookie(SECRET, unbound, NOW), true)
  assert.equal(verifyWarmupCookie(SECRET, unbound, NOW, CLIENT), true)
})

test('warmup cookie: malformed and tampered values fail', () => {
  const valid = createWarmupCookie(SECRET, NOW, CLIENT)
  const [payload, mac] = valid.split('.')
  const flipped = (value: string): string => {
    const at = Math.floor(value.length / 2)
    const replacement = value[at] === 'A' ? 'B' : 'A'
    return value.slice(0, at) + replacement + value.slice(at + 1)
  }
  for (const malformed of [
    '',
    'AAAA',
    '.',
    '.' + mac,
    payload + '.',
    payload + '.' + mac + '.',
    payload + '=' + '.' + mac,
    'x'.repeat(4096) + '.' + mac,
    flipped(payload) + '.' + mac,
    payload + '.' + flipped(mac),
    valid.replace('.', '='),
  ]) {
    assert.equal(verifyWarmupCookie(SECRET, malformed, NOW, CLIENT), false, 'malformed grant must fail: ' + JSON.stringify(malformed.slice(0, 24)))
  }
})

test('warmup cookie: attributes are HttpOnly/SameSite=Lax/Path=/ and Secure only when the request is secure', () => {
  const value = createWarmupCookie(SECRET, NOW, CLIENT)
  const plain = buildWarmupCookieHeader(value, false)
  assert.equal(
    plain,
    WARMUP_COOKIE_NAME + '=' + value + '; Path=' + WARMUP_COOKIE_PATH + '; Max-Age=' + WARMUP_COOKIE_TTL_SECONDS + '; HttpOnly; SameSite=Lax',
  )
  const secure = buildWarmupCookieHeader(value, true)
  assert.equal(secure, plain + '; Secure')
  // Parsing round-trips through a realistic Cookie header with other cookies.
  assert.equal(readWarmupCookie('other=1; ' + WARMUP_COOKIE_NAME + '=' + value + '; gateway-session=x'), value)
  assert.equal(readWarmupCookie(WARMUP_COOKIE_NAME + '='), undefined)
  assert.equal(readWarmupCookie('other=1'), undefined)
  assert.equal(readWarmupCookie(''), undefined)
  assert.equal(readWarmupCookie(undefined), undefined)
})

// ---------------------------------------------------------------------------
// Shape allowlist
// ---------------------------------------------------------------------------

test('allowlist accepts the two real bundle shapes and rejects traversal/authority/non-bundle forms', () => {
  assert.equal(isWarmupPathAllowed(BUNDLE), true)
  assert.equal(isWarmupPathAllowed(SINGLE_BUNDLE), true)
  assert.equal(isWarmupPathAllowed('/plugins/pkg/client.css'), true)
  assert.equal(isWarmupPathAllowed('/plugins/??pkg/client.js&rev=1'), true)
  const rejected = [
    '/api/secret',
    '/plugins',                       // no trailing slash / not under the prefix
    '/plugins/',                      // no bundle
    '/plugins/pkg/api/x',             // plugin HTTP route: NOT a bundle shape
    '/plugins/pkg/client.js.map',     // only the .js/.css client bundles
    '/plugins/pkg/nested/client.js',  // exactly one package segment
    '/plugins/pkg/client.js?rev=1',   // single-row bundles carry no query
    '/plugins/pkg?/client.js',        // '?' smuggled INTO the single-row shape: the raw target's
    '/plugins/pkg?x=y/client.js',     // `[^/]+` must not swallow it, or any visitor with an
    '/plugins/?/client.js',           // auto-issued login cookie could probe arbitrary one-segment
                                      // /plugins paths and read the upstream 404 instead of our 401
    '/plugins/pkg/client.js/x',       // trailing segment
    '/plugins/@scope/pkg/client.js',  // scoped single-row (two segments) is outside the prescribed shape;
                                      // such modules travel through the /plugins/?? combo instead
    '/plugins/../api/secret',         // dot-dot segment
    '/plugins/./x',                   // dot segment
    '/plugins/%2e%2e/api',            // percent-encoded dots
    '/plugins/%2E%2E/api',
    '/plugins/%2f..%2fapi',           // any percent-encoding is refused
    '/plugins//evil.example/x',       // double slash
    '//evil.example/plugins/x',       // protocol-relative
    'https://evil.example/plugins/x', // absolute-form / host part
    '/plugins\\..\\api',          // backslash
    '/plugins/??pkg/client.js#frag',  // fragment
    '/plugins/??pkg/client .js',      // whitespace
    '/plugins/??pkg/client.js\u0000',
    '',
  ]
  for (const value of rejected) assert.equal(isWarmupPathAllowed(value), false, 'must reject ' + JSON.stringify(value))
})

test('a maximum-length allowlisted target stays deliverable and carries no capability in the URL', () => {
  // The retired URL-bound token could mint a ~19 KB link the browser never got
  // through (measured 431). The grant now travels in a cookie, so the href IS
  // the target: the cap only has to stay inside the request-line budget, and
  // the grant length is independent of the target.
  const prefix = '/plugins/??'
  const suffix = '&rev=z'
  const maximal = prefix + 'pkg/client.js,'.repeat(600).slice(0, MAX_WARMUP_TARGET_CHARS - prefix.length - suffix.length) + suffix
  assert.equal(maximal.length, MAX_WARMUP_TARGET_CHARS)
  assert.equal(isWarmupPathAllowed(maximal), true)
  assert.ok(maximal.length < 16 * 1024, 'the target cap must stay inside the request-line budget')
  const shortGrant = createWarmupCookie(SECRET, NOW, CLIENT)
  const longGrant = createWarmupCookie(SECRET, NOW, 'x'.repeat(200))
  assert.ok(shortGrant.length < 1024, 'the rendered link never carries the grant')
  assert.ok(longGrant.length > shortGrant.length, 'grant length tracks the client binding, not the URL')
})

test('discovery extraction keeps real bundle URLs in order, deduplicated and capped', () => {
  const html = [
    '<html><head>',
    '<script src="/plugins/??a/client.js,b/client.js&amp;rev=z"></script>',
    '<script src="/plugins/??a/client.js,b/client.js&rev=z"></script>', // duplicate after entity decode
    '<link rel="modulepreload" href="/plugins/??c/client.js&rev=z">',
    '<link rel="stylesheet" href="/plugins/theme/client.css">',
    '<script>window.__DSH_BOOT__={"bundles":["/plugins/??d/client.js&rev=z"]}</script>',
    '<a href="/api/secret">no</a>',
    '<a href="/plugins/pkg/api/x">no</a>',
    '<a href="/plugins/%2e%2e/evil">no</a>',
    '</head></html>',
  ].join('\n')
  assert.deepEqual(extractWarmupBundleUrls(html), [
    '/plugins/??a/client.js,b/client.js&rev=z',
    '/plugins/??c/client.js&rev=z',
    '/plugins/theme/client.css',
    '/plugins/??d/client.js&rev=z',
  ])
  // Every extracted URL is a route target by construction.
  for (const url of extractWarmupBundleUrls(html)) assert.equal(isWarmupPathAllowed(url), true, url)
  const many = Array.from({ length: MAX_WARMUP_BUNDLE_URLS + 5 }, (_, i) => '<script src="/plugins/??p' + i + '/client.js&rev=z"></script>').join('')
  assert.equal(extractWarmupBundleUrls(many).length, MAX_WARMUP_BUNDLE_URLS)
  assert.deepEqual(extractWarmupBundleUrls(''), [])
})

test('discovery prioritizes the document-loaded URLs over manifest rows (measured index shape)', () => {
  // The measured index: the ~2.6 KiB application combo rides a
  // <link rel="preload"> while the inline boot manifest lists ~57 per-row
  // urls (rows the combo does NOT contain included). Document order alone
  // would spend the cap on manifest rows and could drop the combo — the
  // payload the whole warm-up exists for — so the two forms are ordered:
  // <script src> / <link href> first, manifest rows after.
  const rows = Array.from({ length: 40 }, (_, i) => '{"id":"row' + i + '","url":"/plugins/??row' + i + '/client.js&rev=z"}').join(',')
  const html = '<script>window.__DSH_BOOT__={"bundles":[' + rows + ']}</script>'
    + '<link rel="preload" as="script" href="/plugins/??app/client.js&rev=z">'
    + '<script src="/plugins/??boot/client.js&amp;rev=z"></script>'
  const urls = extractWarmupBundleUrls(html)
  assert.deepEqual(urls.slice(0, 2), ['/plugins/??app/client.js&rev=z', '/plugins/??boot/client.js&rev=z'])
  assert.equal(urls.length, 42, 'every real roster entry still fits under the cap')
  // The cap still bounds a pathological document.
  const pathological = Array.from({ length: MAX_WARMUP_BUNDLE_URLS + 5 }, (_, i) => '<script>{"url":"/plugins/??p' + i + '/client.js&rev=z"}</script>').join('')
  assert.equal(extractWarmupBundleUrls(pathological).length, MAX_WARMUP_BUNDLE_URLS)
  // MAX_WARMUP_BUNDLE_URLS must cover the measured roster (59 unique URLs).
  assert.ok(MAX_WARMUP_BUNDLE_URLS >= 59, 'the cap must cover the measured real roster')
})

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

test('route: non-GET/HEAD on a real bundle shape is 405 before any cookie or proxy work', async () => {
  const w = controller({ port: 1 })
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const res = new FakeResponse()
    const outcome = await w.handle(fakeRequest(method, {}, CLIENT, BUNDLE), res, bundleUrl())
    assert.deepEqual(outcome, { kind: 'rejected', code: 'method_not_allowed' })
    assert.equal(res.status, 405)
    assert.equal(res.json().code, 'method_not_allowed')
    assert.equal(res.headers.allow, 'GET, HEAD')
  }
})

test('route: a real bundle shape without a valid capability cookie is unclaimed (no proxy, no route verdict)', async () => {
  let upstreamHits = 0
  const server = createServer((_req, res) => { upstreamHits += 1; res.writeHead(200); res.end('nope') })
  const port = await listen(server)
  try {
    const cases: Array<[string, WarmupHttpRequest]> = [
      ['absent', fakeRequest('GET', {})],
      ['tampered', fakeRequest('GET', { cookie: WARMUP_COOKIE_NAME + '=AAAA.BBBB' })],
      ['expired', fakeRequest('GET', { cookie: WARMUP_COOKIE_NAME + '=' + createWarmupCookie(SECRET, NOW - WARMUP_COOKIE_TTL_SECONDS - 1, CLIENT) })],
      ['bound elsewhere', fakeRequest('GET', { cookie: WARMUP_COOKIE_NAME + '=' + createWarmupCookie(SECRET, NOW, '198.51.100.7') })],
      ['wrong secret', fakeRequest('GET', { cookie: WARMUP_COOKIE_NAME + '=' + createWarmupCookie('some-other-secret', NOW, CLIENT) })],
    ]
    for (const [name, req] of cases) {
      const res = new FakeResponse()
      const outcome = await controller({ port }).handle(req, res, bundleUrl())
      assert.deepEqual(outcome, { kind: 'unclaimed' }, name)
      assert.equal(res.status, 0, name + ': the route writes nothing and the auth gate decides')
    }
    assert.equal(upstreamHits, 0, 'nothing is proxied without the grant')
  } finally { await close(server) }
})

test('route: non-bundle /plugins targets are unclaimed and never proxied (plugin routes stay authenticated)', async () => {
  const rejectedTargets = [
    '/plugins/pkg/api/x',
    '/plugins/pkg/client.js.map',
    '/plugins/pkg/nested/client.js',
    '/plugins/pkg/client.js?rev=1',
    '/plugins/%2e%2e/api/x',
    '/plugins//evil.example/x',
    '/plugins/../api/x',
    '/plugins\\..\\api',
    '//evil.example/plugins/pkg/client.js',
    'http://evil.example/plugins/pkg/client.js',
    '/api/session/create',
  ]
  const w = controller({ port: 1 })
  for (const target of rejectedTargets) {
    const res = new FakeResponse()
    const outcome = await w.handle(grantedRequest('GET', NOW, CLIENT, target), res, bundleUrl(target))
    assert.deepEqual(outcome, { kind: 'unclaimed' }, target)
    assert.equal(res.status, 0, target + ': no route answer, so no proxy attempt')
  }
})

test('route: a valid grant fails closed with 503 instance_unavailable when the dsh is not ready', async () => {
  for (const options of [{ port: null, state: 'ready' }, { port: 17510, state: 'starting' }, { port: 17510, state: 'error' }]) {
    const res = new FakeResponse()
    const outcome = await controller(options).handle(grantedRequest(), res, bundleUrl())
    assert.deepEqual(outcome, { kind: 'proxied' })
    assert.equal(res.status, 503)
    assert.deepEqual(res.json(), { error: 'instance_unavailable', code: 'instance_unavailable' })
  }
})

test('route: the dsh port bound keeps out-of-range ports fail-closed (no spurious refusal)', async () => {
  assert.equal(isValidDshPort(1), true)
  assert.equal(isValidDshPort(65535), true)
  for (const port of [null, undefined, 0, -1, 65536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(isValidDshPort(port), false, String(port))
  }
  for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
    const res = new FakeResponse()
    const outcome = await controller({ port, state: 'ready' }).handle(grantedRequest(), res, bundleUrl())
    assert.deepEqual(outcome, { kind: 'proxied' }, String(port))
    assert.equal(res.status, 503, String(port))
    assert.deepEqual(res.json(), { error: 'instance_unavailable', code: 'instance_unavailable' })
  }
})

test('route: a valid grant proxies the exact real target, keeps the spawn cookie, and merges the policy vary', async () => {
  const body = Buffer.from('console.log("bundle")', 'utf8')
  const seen: Array<{ url: string | undefined; headers: Record<string, string | string[] | undefined> }> = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers })
    res.writeHead(200, {
      'content-type': 'text/javascript',
      'content-encoding': 'gzip',
      'cache-control': 'public, max-age=60',
      vary: 'accept-encoding',
      'content-length': String(body.length),
      'set-cookie': 'session=nope',
      'x-secret': 'nope',
    })
    res.end(body)
  })
  const port = await listen(server)
  try {
    const res = new FakeResponse()
    // The request policy already set its own Vary before the route runs.
    res.setHeader('vary', 'Origin')
    const outcome = await controller({ port, authCookie: BROWSER_AUTH }).handle(
      fakeRequest('GET', {
        'accept-encoding': 'gzip, br',
        cookie: WARMUP_COOKIE_NAME + '=' + createWarmupCookie(SECRET, NOW, CLIENT) + '; gateway-session=nope',
        authorization: 'Bearer nope',
      }),
      res,
      bundleUrl(),
    )
    assert.deepEqual(outcome, { kind: 'proxied' })
    assert.equal(res.status, 200)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, BUNDLE)
    assert.equal(seen[0].headers['accept-encoding'], 'gzip, br', 'the caller accept-encoding is forwarded')
    assert.equal(seen[0].headers.cookie, BROWSER_AUTH, 'only the spawn-minted browser-auth cookie goes upstream')
    assert.equal(seen[0].headers.authorization, undefined, 'no caller authorization goes upstream')
    assert.equal(res.body.toString('utf8'), body.toString('utf8'))
    assert.equal(res.headers['content-type'], 'text/javascript')
    assert.equal(res.headers['content-encoding'], 'gzip')
    assert.equal(res.headers['cache-control'], 'public, max-age=60')
    assert.equal(res.headers.vary, 'Origin, accept-encoding', 'the policy Vary is merged, never clobbered')
    assert.equal(res.headers['content-length'], String(body.length))
    assert.equal(res.headers['set-cookie'], undefined)
    assert.equal(res.headers['x-secret'], undefined)

    // Without the spawn cookie the caller's own cookie still never crosses.
    const bare = new FakeResponse()
    await controller({ port }).handle(grantedRequest(), bare, bundleUrl())
    assert.equal(bare.status, 200)
    assert.equal(seen[1].headers.cookie, undefined, 'the caller cookie is never forwarded')
  } finally { await close(server) }
})

test('vary merge: keeps the policy header, appends upstream, case-insensitively deduplicated', () => {
  assert.equal(mergeVary('Origin', 'accept-encoding'), 'Origin, accept-encoding')
  assert.equal(mergeVary('origin, Accept-Encoding', 'accept-encoding'), 'origin, Accept-Encoding')
  assert.equal(mergeVary(undefined, 'accept-encoding'), 'accept-encoding')
  assert.equal(mergeVary('Origin', undefined), 'Origin')
  assert.equal(mergeVary(undefined, undefined), undefined)
  assert.equal(mergeVary(['Origin', 'Accept-Encoding'], 'origin'), 'Origin, Accept-Encoding')
  assert.equal(mergeVary('', '  '), undefined)
})

test('route: an upstream failure answers 502 upstream_failed', async () => {
  // A listener that immediately destroys the connection: the proxy must not
  // hang and must not invent a success response.
  const server = createServer((_req, res) => { res.destroy() })
  const port = await listen(server)
  try {
    const res = new FakeResponse()
    const outcome = await controller({ port }).handle(grantedRequest(), res, bundleUrl())
    assert.deepEqual(outcome, { kind: 'proxied' })
    assert.equal(res.status, 502)
    assert.deepEqual(res.json(), { error: 'upstream_failed', code: 'upstream_failed' })
  } finally { await close(server) }
})

test('route: over-budget anonymous traffic is refused with 429 warmup_rate_limited', async () => {
  const w = controller({ port: 17510, state: 'starting' }) // 503 path: no upstream needed
  for (let i = 0; i < WARMUP_RATE_LIMIT_CAPACITY; i++) {
    const res = new FakeResponse()
    const outcome = await w.handle(grantedRequest(), res, bundleUrl())
    assert.deepEqual(outcome, { kind: 'proxied' })
    assert.equal(res.status, 503, 'request ' + (i + 1) + ' is inside the budget')
  }
  const refused = new FakeResponse()
  const outcome = await w.handle(grantedRequest(), refused, bundleUrl())
  assert.deepEqual(outcome, { kind: 'rejected', code: 'warmup_rate_limited' })
  assert.equal(refused.status, 429)
  assert.equal(refused.json().code, 'warmup_rate_limited')
  // A different client address has its own bucket.
  const other = new FakeResponse()
  await w.handle(grantedRequest('GET', NOW, '198.51.100.7'), other, bundleUrl())
  assert.equal(other.status, 503)
})

test('route: the aggregate concurrency budget refuses excess warm-up fetches and releases the slot', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const server = createServer((_req, res) => {
    void gate.then(() => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('ok') })
  })
  const port = await listen(server)
  try {
    const w = controller({ port, budget: { maxConcurrentFetches: 2 } })
    const first = w.handle(grantedRequest(), new FakeResponse(), bundleUrl())
    const second = w.handle(grantedRequest(), new FakeResponse(), bundleUrl())
    await new Promise<void>(resolve => setTimeout(resolve, 25))
    const refused = new FakeResponse()
    const outcome = await w.handle(grantedRequest(), refused, bundleUrl())
    assert.deepEqual(outcome, { kind: 'proxied' })
    assert.equal(refused.status, 503)
    assert.deepEqual(refused.json(), { error: 'warm-up capacity exhausted', code: WARMUP_CAPACITY_CODE })
    release()
    await Promise.all([first, second])
    // The slot is free again after the held fetches settle.
    const after = new FakeResponse()
    await w.handle(grantedRequest(), after, bundleUrl())
    assert.equal(after.status, 200)
    // Production sizing: at least the browser's per-host parallel prefetch run.
    assert.ok(MAX_WARMUP_CONCURRENT_FETCHES >= 6, 'the budget must not throttle one login page')
  } finally { await close(server) }
})

test('route: the aggregate buffered-byte budget refuses an oversized fetch and releases the held bytes', async () => {
  const big = Buffer.alloc(4096, 1)
  const small = Buffer.from('small', 'utf8')
  let calls = 0
  const server = createServer((_req, res) => {
    calls += 1
    const body = calls === 1 ? big : small
    res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': String(body.length) })
    res.end(body)
  })
  const port = await listen(server)
  try {
    const w = controller({ port, budget: { maxTotalBufferedBytes: 1024 } })
    const refused = new FakeResponse()
    const outcome = await w.handle(grantedRequest(), refused, bundleUrl())
    assert.deepEqual(outcome, { kind: 'proxied' })
    assert.equal(refused.status, 503)
    assert.deepEqual(refused.json(), { error: 'warm-up capacity exhausted', code: WARMUP_CAPACITY_CODE })
    // The bytes held by the failed fetch were released: a small body now fits.
    const after = new FakeResponse()
    await w.handle(grantedRequest(), after, bundleUrl())
    assert.equal(after.status, 200)
    assert.equal(after.body.toString('utf8'), 'small')
  } finally { await close(server) }
})

test('rate limiter: buckets refill and the map stays bounded', () => {
  const limiter = createWarmupRateLimiter({ capacity: 2, refillPerSecond: 1, maxKeys: 2 })
  assert.equal(limiter.consume('a', 0), true)
  assert.equal(limiter.consume('a', 0), true)
  assert.equal(limiter.consume('a', 0), false)
  assert.equal(limiter.consume('a', 1000), true, 'one token refilled after one second')
  assert.equal(limiter.consume('b', 1000), true)
  assert.equal(limiter.consume('c', 1000), true, 'the bounded map drops the oldest bucket')
  assert.equal(limiter.consume('a', 1000), true, 'the dropped bucket starts fresh')
})

// ---------------------------------------------------------------------------
// Discovery, caching and the kill switch
// ---------------------------------------------------------------------------

test('discovery is cached per dsh port (60 s success / 10 s failure), mints the grant only with links, and fails soft', async () => {
  let fetches = 0
  let fail = false
  let clock = NOW * 1000
  let seenCookie: string | undefined
  const html = '<script src="' + BUNDLE + '"></script>'
  const { warmup } = createController({
    port: 17510,
    state: 'ready',
    authCookie: BROWSER_AUTH,
    now: () => clock,
    fetchIndex: async (_url, _signal, authCookie) => {
      fetches += 1
      seenCookie = authCookie
      if (fail) throw Object.assign(new Error('boom'), { name: 'TimeoutError' })
      return html
    },
  })
  const first = await warmup.links({ clientAddress: CLIENT, secure: true })
  assert.deepEqual(first.urls, [BUNDLE], 'the REAL discovered URL is rendered, with no wrapper and no ?u=')
  assert.equal(fetches, 1)
  assert.equal(seenCookie, BROWSER_AUTH, 'discovery carries the spawn-minted browser-auth cookie')
  const grantValue = first.cookie === undefined ? '' : first.cookie.slice((WARMUP_COOKIE_NAME + '=').length).split(';')[0]
  assert.equal(verifyWarmupCookie(SECRET, grantValue, Math.floor(clock / 1000), CLIENT), true)
  assert.equal(first.cookie === undefined ? true : first.cookie.endsWith('; Secure'), true)
  assert.equal(readWarmupCookie(first.cookie === undefined ? '' : first.cookie.split(';')[0]), grantValue)

  await warmup.links()
  assert.equal(fetches, 1, 'a second login page inside the TTL reuses the cache')
  clock += WARMUP_DISCOVERY_CACHE_TTL_MS + 1
  await warmup.links()
  assert.equal(fetches, 2, 'the cache expires after 60 s')

  fail = true
  clock += WARMUP_DISCOVERY_CACHE_TTL_MS + 1
  const failing = await warmup.links()
  assert.deepEqual(failing, { urls: [] }, 'discovery failure renders no links and mints no grant')
  assert.equal(fetches, 3)
  clock += WARMUP_DISCOVERY_FAILURE_TTL_MS - 1
  await warmup.links()
  assert.equal(fetches, 3, 'a failed discovery is cached too (no login-page hammering)')
  clock += 2
  await warmup.links()
  assert.equal(fetches, 4, 'the negative entry expires on the SHORT TTL: a dsh that becomes ready is not hidden for a minute')
})

test('a request with no capability never spends the rate bucket (2026-09 review, MAJOR)', async () => {
  // The bucket must not be consumed BEFORE the cookie is read: a caller
  // holding no grant could drain it (5 req/s keeps it empty) and every bundle
  // request from that client address — including a legitimately logged-in
  // session behind the same NAT — would get 429 from this PRE-AUTH leg, with
  // the auth gate never consulted and its audit never written. design 17 §10.6: an
  // absent/stale/tampered/foreign cookie ⇒ unclaimed, so this route may not
  // answer at all.
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/javascript' })
    res.end('/* bundle */')
  })
  const port = await listen(server)
  try {
    const warmup = controller({ port, state: 'ready' })
    for (let i = 0; i < 200; i += 1) {
      const refusal = new FakeResponse()
      const outcome = await warmup.handle(fakeRequest('GET'), refusal, bundleUrl())
      assert.deepEqual(outcome, { kind: 'unclaimed' }, 'no grant ⇒ unclaimed (never a 429)')
      assert.equal(refusal.status, 0, 'the pre-auth leg must not answer at all')
    }
    const served = new FakeResponse()
    const outcome = await warmup.handle(grantedRequest(), served, bundleUrl())
    assert.deepEqual(outcome, { kind: 'proxied' }, '200 cookie-less requests must not exhaust the bucket')
    assert.equal(served.status, 200)
  } finally {
    await close(server)
  }
})

test('concurrent login-page renders share ONE discovery fetch (2026-09 review, MAJOR)', async () => {
  // The login page AWAITS discovery and one unauthenticated connection can
  // pipeline many index requests, so without single-flight N renders would
  // issue N concurrent loopback index fetches against the managed dsh (measured 100 on
  // a single socket).
  let fetches = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const warmup = controller({
    port: 17510,
    state: 'ready',
    fetchIndex: async () => {
      fetches += 1
      await gate
      return '<script src="' + BUNDLE + '"></script>'
    },
  })
  const renders = Array.from({ length: 32 }, () => warmup.links({ clientAddress: CLIENT }))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(fetches, 1, '32 concurrent renders must issue ONE loopback index fetch')
  release?.()
  const results = await Promise.all(renders)
  assert.equal(fetches, 1, 'the shared fetch is not repeated when it settles')
  for (const result of results) assert.deepEqual(result.urls, [BUNDLE], 'every render gets the shared result')
})

test('an oversized index is cancelled at the cap instead of drained (2026-09 review, MAJOR)', async () => {
  // The default read used `response.text()`: a 12.5 MiB index was fully
  // delivered (measured +32.9 MiB RSS for one request) and only then rejected.
  // The reader must stop the moment the cap is crossed and cancel the body.
  const originalFetch = globalThis.fetch
  let pulls = 0
  let cancelled = false
  try {
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(stream) {
        pulls += 1
        stream.enqueue(new Uint8Array(1024 * 1024))
        if (pulls > 8) stream.close()
      },
      cancel() { cancelled = true },
    }), { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch
    const result = await controller({ port: 17510, state: 'ready' }).links()
    assert.deepEqual(result, { urls: [] }, 'an over-cap index yields no links')
    assert.ok(pulls <= 6, 'must stop pulling once the cap is crossed (pulls=' + pulls + ')')
    assert.equal(cancelled, true, 'the body must be cancelled, not drained')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('default discovery attaches the spawn-minted cookie to the loopback index read (401 without it)', async () => {
  const indexHtml = '<script src="/plugins/??a/client.js,b/client.js&amp;rev=r1"></script>'
  const seen: Array<{ url: string | undefined; cookie: string | undefined }> = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie })
    if (req.url !== '/') { res.writeHead(404); res.end(); return }
    if (req.headers.cookie !== BROWSER_AUTH) { res.writeHead(401); res.end('unauthorized'); return }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(indexHtml)
  })
  const port = await listen(server)
  try {
    const authorized = createController({ port, state: 'ready', authCookie: BROWSER_AUTH })
    const links = await authorized.warmup.links({ clientAddress: CLIENT })
    assert.deepEqual(links.urls, ['/plugins/??a/client.js,b/client.js&rev=r1'])
    assert.deepEqual(authorized.warnings, [])
    assert.equal(seen[0].url, '/')
    assert.equal(seen[0].cookie, BROWSER_AUTH, 'the cookie is what makes the index read answer')

    // The same fixture without the cookie 401s: discovery fails soft with no
    // links and no grant, and the failure is logged by name only.
    const anonymous = createController({ port, state: 'ready' })
    assert.deepEqual(await anonymous.warmup.links(), { urls: [] })
    assert.equal(anonymous.warnings.length, 1)
    // The failure is logged by error NAME only (never a status line that
    // could carry upstream text).
    assert.match(anonymous.warnings[0], /bundle discovery failed on port \d+ \(Error\)/)
    assert.equal(seen[1].cookie, undefined)
  } finally { await close(server) }
})

test('end-to-end: default discovery reads the authorized index and the minted grant proxies the real bundle', async () => {
  const bundleBody = Buffer.from('globalThis.__bundle = 1', 'utf8')
  const indexHtml = '<script src="/plugins/??a/client.js,b/client.js&amp;rev=r1"></script>'
  const upstreamPaths: string[] = []
  const server = createServer((req, res) => {
    if (req.url === '/') {
      if (req.headers.cookie !== BROWSER_AUTH) { res.writeHead(401); res.end(); return }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(indexHtml)
      return
    }
    upstreamPaths.push(req.url ?? '')
    res.writeHead(200, {
      'content-type': 'text/javascript',
      'cache-control': 'public, max-age=31536000, immutable',
      'content-length': String(bundleBody.length),
    })
    res.end(bundleBody)
  })
  const port = await listen(server)
  try {
    const { warmup, warnings } = createController({ port, state: 'ready', authCookie: BROWSER_AUTH })
    const links = await warmup.links({ clientAddress: CLIENT })
    assert.deepEqual(links.urls, ['/plugins/??a/client.js,b/client.js&rev=r1'], 'the real index document yields the one combo URL')
    assert.deepEqual(warnings, [])
    const grant = links.cookie === undefined ? '' : links.cookie.slice((WARMUP_COOKIE_NAME + '=').length).split(';')[0]
    const res = new FakeResponse()
    const outcome = await warmup.handle(fakeRequest('GET', { 'accept-encoding': 'gzip', cookie: WARMUP_COOKIE_NAME + '=' + grant }, CLIENT, links.urls[0]), res, bundleUrl(links.urls[0]))
    assert.deepEqual(outcome, { kind: 'proxied' })
    assert.equal(res.status, 200)
    assert.equal(res.body.toString('utf8'), bundleBody.toString('utf8'))
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable')
    assert.deepEqual(upstreamPaths, ['/plugins/??a/client.js,b/client.js&rev=r1'])
  } finally { await close(server) }
})

test('discovery timeout bounds the login page wait to about 500 ms', async () => {
  // A listener that accepts but never answers: fetch must abort via
  // AbortSignal.timeout(WARMUP_DISCOVERY_TIMEOUT_MS) instead of hanging the
  // login page forever.
  const server = createServer(() => { /* deliberately no response */ })
  const port = await listen(server)
  try {
    const { warmup, warnings } = createController({ port, state: 'ready', authCookie: BROWSER_AUTH })
    const startedAt = Date.now()
    assert.deepEqual(await warmup.links(), { urls: [] })
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < 2000, 'discovery must fail soft within its timeout (took ' + elapsed + 'ms)')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /TimeoutError/)
  } finally { await close(server) }
})

test('the kill switch disables links, the grant and the route', async () => {
  let fetches = 0
  const { warmup } = createController({
    enabled: false,
    port: 17510,
    state: 'ready',
    fetchIndex: async () => { fetches += 1; return '<script src="' + BUNDLE + '"></script>' },
  })
  assert.deepEqual(await warmup.links({ clientAddress: CLIENT, secure: true }), { urls: [] })
  assert.equal(fetches, 0)
  const res = new FakeResponse()
  const outcome = await warmup.handle(grantedRequest(), res, bundleUrl())
  assert.deepEqual(outcome, { kind: 'unclaimed' })
  assert.equal(res.status, 0, 'the disabled route writes nothing')
})

test('no log line ever carries the grant, the secret or the bundle URL', async () => {
  const { warmup, warnings } = createController({ secret: null })
  const grant = createWarmupCookie(SECRET, NOW, CLIENT)
  const res = new FakeResponse()
  const outcome = await warmup.handle(fakeRequest('GET', { cookie: WARMUP_COOKIE_NAME + '=' + grant }), res, bundleUrl())
  assert.deepEqual(outcome, { kind: 'unclaimed' })
  assert.equal(res.status, 0)
  assert.equal(warnings.length > 0, true, 'the failure is loud somewhere')
  for (const line of warnings) {
    assert.equal(line.includes(SECRET), false)
    assert.equal(line.includes(grant), false)
    assert.equal(line.includes(BUNDLE), false)
  }
})
test('a failed discovery is remembered briefly; a success for a minute', async () => {
  // A down dsh must not be re-probed on every render (that would put a loopback
  // request on the login page), but a dsh that becomes serviceable while the
  // visitor is still typing must get its links soon: the negative entry expires
  // on the short failure TTL, the positive one on the long success TTL.
  let nowMs = NOW * 1000
  let failing = true
  let fetches = 0
  const { warmup } = createController({
    port: 17510,
    now: () => nowMs,
    fetchIndex: async () => {
      fetches += 1
      if (failing) throw new Error('browser-auth gate')
      return '<script src="' + BUNDLE + '"></script>'
    },
  })
  assert.deepEqual((await warmup.links({ clientAddress: CLIENT })).urls, [])
  assert.equal(fetches, 1)
  assert.deepEqual((await warmup.links({ clientAddress: CLIENT })).urls, [], 'the failure is cached, not re-probed')
  assert.equal(fetches, 1)
  nowMs += WARMUP_DISCOVERY_FAILURE_TTL_MS + 1
  failing = false
  assert.deepEqual((await warmup.links({ clientAddress: CLIENT })).urls, [BUNDLE], 'a serviceable dsh gets its links on the next render')
  assert.equal(fetches, 2)
  nowMs += WARMUP_DISCOVERY_CACHE_TTL_MS - 1
  await warmup.links({ clientAddress: CLIENT })
  assert.equal(fetches, 2, 'the success is cached for the long TTL')
})
