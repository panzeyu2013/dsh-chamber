/** gateway provider — part 2: password-session hooks (ensureSession login, 401 re-login once,
 *  Bearer+Cookie coexistence, inert default) and the S23 SPKI-pinned https probe/login over real
 *  TLS (siblings: gateway-provider / gateway-chamber-sync / gateway-chamber-apply-materialize). */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { configureGatewaySessionProvider, gatewayProvider, getGatewaySessionHooks, setGatewayPassword, setGatewayToken } from '../../gateway-provider.ts'
import { completeGatewaySessionHooks as completeTestSessionHooks, GATEWAY_RUNTIME_STATUS } from '../support/gateway-session-test-hooks.ts'
import type { GatewaySessionProviderHooks } from '../../gateway-provider.ts'
import type { GatewaySessionOrigin, GatewaySessionResult } from '../../gateway-session.ts'
import { createGatewaySessionManager } from '../../gateway-session.ts'
import { CERT_A, KEY_A, PIN_A, CERT_B, PIN_B } from '../support/gateway-tls-fixtures.ts'
import { startHttpProbeServer, startHttpsProbeServer } from '../support/gateway-test-servers.ts'

const TOKEN = '0123456789abcdef0123456789abcdef'
const PASSWORD = 'gateway-login-password-123'

function httpSpec(id: string, port: number, extra: Record<string, unknown> = {}): ReturnType<typeof gatewayProvider.validateSpec> {
  return gatewayProvider.validateSpec({ id, label: 'g', kind: 'gateway', transport: 'http', host: '127.0.0.1', remotePort: port, insecureHttp: true, ...extra })
}

// ---------------------------------------------------------------------------
// Password-session flow (design 17 §7.3/§9.3): verifyUp consults the
// injected session hooks (configureGatewaySessionProvider) for a password-
// configured gateway target with no token — login → probe WITH the Cookie,
// cached-session fast path, probe-401 → invalidate + terminal, independent
// Bearer+Cookie coexistence/fallback, inert default.
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'dsh_gateway_session=fake-jwt'

/** A real gateway stub answering the gateway runtime identity endpoint,
 * recording the probe's cookie/authorization headers. */
function envelopeHandler(seen: { cookie?: string; authorization?: string }) {
  return (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
    seen.cookie = req.headers.cookie
    seen.authorization = req.headers.authorization
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  }
}

test('verifyUp: a password-configured gateway with session hooks logs in once and probes WITH the Cookie (design 17 §7/§9.3)', async () => {
  const seen: { cookie?: string; authorization?: string } = {}
  const server = await startHttpProbeServer(envelopeHandler(seen))
  const exchanged: Array<{ origin: GatewaySessionOrigin; password: string }> = []
  let cached: string | null = null
  const hooks: GatewaySessionProviderHooks = {
    ensureSession: (origin, password) => { exchanged.push({ origin, password }); return Promise.resolve({ ok: true, cookie: SESSION_COOKIE }) },
    cachedCookie: () => cached,
    invalidate: () => {},
  }
  configureGatewaySessionProvider(completeTestSessionHooks(hooks))
  try {
    setGatewayPassword('pw-probe-1', PASSWORD)
    const spec = httpSpec('pw-probe-1', server.port)
    assert.ok(spec !== null)
    // First verifyUp: no cached session → the stored password is exchanged,
    // the probe rides the session Cookie (never a credential header value).
    const first = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(first.ok, true)
    assert.equal(seen.cookie, SESSION_COOKIE, 'the probe carries the session Cookie')
    assert.equal(seen.authorization, undefined, 'no Authorization when the session authenticates')
    assert.equal(exchanged.length, 1)
    assert.equal(exchanged[0].password, PASSWORD, 'the STORED password is what the login exchanges — never the cookie')
    assert.equal(exchanged[0].origin.baseUrl, `http://127.0.0.1:${server.port}`, 'the session is keyed to the target origin')
    // Second verifyUp with a live cached session: NO re-login — the cookie is
    // reused (bounded reconnect cycles must never hammer the login endpoint,
    // 429 backoff discipline, design 17 §9.3).
    cached = SESSION_COOKIE
    const second = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(second.ok, true)
    assert.equal(seen.cookie, SESSION_COOKIE)
    assert.equal(exchanged.length, 1, 'a live cached session is never re-exchanged')
  } finally {
    setGatewayPassword('pw-probe-1', null)
    configureGatewaySessionProvider({})
    await server.close()
  }
})

test('verifyUp: a probe 401 with the session cookie invalidates, re-logs in ONCE, and reports the terminal password-refused state only after the fresh session is refused too (design 17 §7.3/§9.3)', async () => {
  const invalidated: GatewaySessionOrigin[] = []
  let logins = 0
  const server = await startHttpProbeServer((_req, res) => {
    res.writeHead(401)
    res.end()
  })
  const hooks: GatewaySessionProviderHooks = {
    ensureSession: () => { logins += 1; return Promise.resolve({ ok: true, cookie: SESSION_COOKIE }) },
    cachedCookie: () => null,
    invalidate: origin => { invalidated.push(origin) },
  }
  configureGatewaySessionProvider(completeTestSessionHooks(hooks))
  try {
    setGatewayPassword('pw-401-1', PASSWORD)
    const spec = httpSpec('pw-401-1', server.port)
    assert.ok(spec !== null)
    const result = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.terminal, true, 'a session rejected even after the one re-login is deterministic — retrying cannot change the answer')
      assert.match(result.detail ?? '', /rejected the password authentication \(401\) — re-enter the password/)
    }
    assert.equal(logins, 2, 'the 401 triggered exactly ONE automatic re-login (bounded, §9.3 重登一次)')
    assert.equal(invalidated.length, 2, 'both the stale and the freshly minted session are invalidated (the fresh one was refused too)')
    assert.equal(invalidated[0].baseUrl, `http://127.0.0.1:${server.port}`, 'the invalidation targets the probe origin')
  } finally {
    setGatewayPassword('pw-401-1', null)
    configureGatewaySessionProvider({})
    await server.close()
  }
})

test('verifyUp: a probe 401 self-heals through the one automatic re-login — the fresh session probes ok (design 17 §9.3)', async () => {
  // The gateway answers the FIRST probe with 401 (stale/revoked session) and
  // the re-probe with the 200 envelope — the stored password is still valid,
  // so the single re-login recovers without any terminal state.
  let probes = 0
  const server = await startHttpProbeServer((_req, res) => {
    probes += 1
    if (probes === 1) {
      res.writeHead(401)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  })
  const invalidated: GatewaySessionOrigin[] = []
  let logins = 0
  const hooks: GatewaySessionProviderHooks = {
    ensureSession: () => { logins += 1; return Promise.resolve({ ok: true, cookie: SESSION_COOKIE }) },
    cachedCookie: () => null,
    invalidate: origin => { invalidated.push(origin) },
  }
  configureGatewaySessionProvider(completeTestSessionHooks(hooks))
  try {
    setGatewayPassword('pw-relogin-1', PASSWORD)
    const spec = httpSpec('pw-relogin-1', server.port)
    assert.ok(spec !== null)
    const result = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(result.ok, true, 'the fresh session after the one automatic re-login is accepted')
    assert.equal(probes, 2, 'exactly two probes: the stale-cookie probe and the fresh-session re-probe')
    assert.equal(logins, 2, 'the initial login plus exactly ONE automatic re-login')
    assert.equal(invalidated.length, 1, 'only the stale session was invalidated — the fresh one is kept')
  } finally {
    setGatewayPassword('pw-relogin-1', null)
    configureGatewaySessionProvider({})
    await server.close()
  }
})

test('verifyUp: token and password are independent — with both configured the probe carries Bearer AND Cookie (design 17 §2.3)', async () => {
  const seen: { cookie?: string; authorization?: string } = {}
  const server = await startHttpProbeServer((req, res) => {
    seen.cookie = req.headers.cookie
    seen.authorization = req.headers.authorization
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  })
  let sessionConsulted = 0
  const hooks: GatewaySessionProviderHooks = {
    ensureSession: () => { sessionConsulted += 1; return Promise.resolve({ ok: true, cookie: SESSION_COOKIE }) },
    cachedCookie: () => null,
    invalidate: () => { sessionConsulted += 1 },
  }
  configureGatewaySessionProvider(completeTestSessionHooks(hooks))
  try {
    setGatewayToken('pw-both-1', TOKEN)
    setGatewayPassword('pw-both-1', PASSWORD)
    const spec = httpSpec('pw-both-1', server.port)
    assert.ok(spec !== null)
    const result = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(result.ok, true)
    assert.equal(seen.authorization, `Bearer ${TOKEN}`, 'the Bearer token rides the probe')
    assert.equal(seen.cookie, SESSION_COOKIE, 'the independently configured password session also rides the probe')
    assert.equal(sessionConsulted, 1, 'the password/session flow is not shadowed by the token')
  } finally {
    setGatewayToken('pw-both-1', null)
    setGatewayPassword('pw-both-1', null)
    configureGatewaySessionProvider({})
    await server.close()
  }
})

test('verifyUp: a refused password login still falls back to a valid configured Bearer', async () => {
  let probes = 0
  let sawAuthorization: string | undefined
  let sawCookie: string | undefined
  const server = await startHttpProbeServer((req, res) => {
    probes += 1
    sawAuthorization = req.headers.authorization
    sawCookie = req.headers.cookie
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  })
  configureGatewaySessionProvider(completeTestSessionHooks({
    ensureSession: async () => ({ ok: false, code: 'invalid_credentials', error: 'password rejected' }),
    cachedCookie: () => null,
  }))
  try {
    setGatewayToken('pw-bearer-fallback', TOKEN)
    setGatewayPassword('pw-bearer-fallback', PASSWORD)
    const spec = httpSpec('pw-bearer-fallback', server.port)
    assert.ok(spec !== null)
    assert.deepEqual(await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port }), { ok: true })
    assert.equal(sawAuthorization, `Bearer ${TOKEN}`, 'the bearer fallback probe carries the token')
    assert.equal(sawCookie, undefined, 'no cookie leaks into the bearer fallback probe')
    assert.equal(probes, 1, 'one bearer-only fallback probe is sufficient')
  } finally {
    setGatewayToken('pw-bearer-fallback', null)
    setGatewayPassword('pw-bearer-fallback', null)
    configureGatewaySessionProvider({})
    await server.close()
  }
})

test('verifyUp: a refused login is terminal, rate_limited stays transient (design 17 §7.3 three-state)', async () => {
  const failures: Extract<GatewaySessionResult, { ok: false }>[] = [
    { ok: false, code: 'invalid_credentials', error: 'the gateway rejected the password login (HTTP 401) — re-enter the password' },
    { ok: false, code: 'rate_limited', error: 'the gateway is rate-limiting login attempts (429) — back off before retrying' },
  ]
  const server = await startHttpProbeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  const hooks: GatewaySessionProviderHooks = {
    ensureSession: () => Promise.resolve(failures.shift() ?? { ok: false, code: 'network', error: 'the gateway did not answer the login request' }),
    cachedCookie: () => null,
  }
  configureGatewaySessionProvider(completeTestSessionHooks(hooks))
  try {
    const spec = httpSpec('pw-fail-1', server.port)
    assert.ok(spec !== null)
    setGatewayPassword('pw-fail-1', PASSWORD)
    // Refused password → terminal (the stored password cannot authenticate;
    // the user must re-enter it — no retry can change the answer).
    const refused = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(refused.ok, false)
    if (!refused.ok) {
      assert.equal(refused.terminal, true, 'a refused password is deterministic')
      assert.match(refused.detail ?? '', /rejected the password login \(HTTP 401\)/)
    }
    // Rate-limited login → transient (the bounded reconnect/backoff path
    // applies — retrying after backoff can recover).
    const limited = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(limited.ok, false)
    if (!limited.ok) {
      assert.notEqual(limited.terminal, true, 'a rate-limited login is transient (absent/false = transient)')
      assert.match(limited.detail ?? '', /rate-limiting/)
    }
  } finally {
    setGatewayPassword('pw-fail-1', null)
    configureGatewaySessionProvider({})
    await server.close()
  }
})

test('verifyUp: without session hooks a password-configured target probes WITHOUT auth (inert default, design 17 §2.3)', async () => {
  const seen: { cookie?: string; authorization?: string } = {}
  const server = await startHttpProbeServer((req, res) => {
    seen.cookie = req.headers.cookie
    seen.authorization = req.headers.authorization
    res.writeHead(401)
    res.end()
  })
  configureGatewaySessionProvider({})
  try {
    setGatewayPassword('pw-inert-1', PASSWORD)
    const spec = httpSpec('pw-inert-1', server.port)
    assert.ok(spec !== null)
    const result = await gatewayProvider.verifyUp!(spec!, { host: '127.0.0.1', port: server.port })
    assert.equal(seen.cookie, undefined, 'no hooks → the probe carries no Cookie')
    assert.equal(seen.authorization, undefined, 'no hooks → the probe carries no Authorization')
    assert.equal(result.ok, false, 'the password-gated endpoint must reject the probe')
    assert.match(result.detail ?? '', /requires authentication/)
  } finally {
    setGatewayPassword('pw-inert-1', null)
    configureGatewaySessionProvider({})
    await server.close()
  }
})

test('configureGatewaySessionProvider accepts only disabled or complete security hooks', async () => {
  const complete = completeTestSessionHooks({
    ensureSession: async () => ({ ok: true, cookie: SESSION_COOKIE }),
  })
  configureGatewaySessionProvider(complete)
  assert.throws(
    () => configureGatewaySessionProvider({ ensureSession: async () => ({ ok: false, code: 'network', error: 'unused' }) }),
    /all-or-none/,
    'a partial hook update cannot silently remove generation/proof fences',
  )
  assert.equal(getGatewaySessionHooks(), complete, 'a rejected partial update leaves the previous complete hooks installed')
  assert.equal(await getGatewaySessionHooks().ensureSession!({ baseUrl: 'http://gw.example.com:3080', insecureHttp: true, scope: 'test:complete-hooks' }, PASSWORD).then(result => result.ok), true,
    'the previously installed complete hooks remain usable after a rejected partial update')
  configureGatewaySessionProvider({})
  assert.deepEqual(getGatewaySessionHooks(), {}, 'an empty hook object explicitly disables integration')
})

// ---------------------------------------------------------------------------
// SPKI certificate pinning (design 17 §13.4.2 / S23): self-signed fixture
// certificates EMBEDDED as test constants (no openssl dependency at test
// time), served by a real node:https server. The pin IS the trust anchor: a
// pinned probe succeeds against the matching certificate without any CA
// trust, fails TERMINAL on mismatch (「证书固定不匹配（SPKI）——gateway 证书已更换
// 或 pin 错误」), and an unpinned probe keeps the legacy behavior — against a
// self-signed chain that is a transient connection failure, proving the pin
// machinery is inert without a configured pin.
// ---------------------------------------------------------------------------


test('the embedded SPKI pin fixtures are self-consistent (cert A/B → pins A/B)', () => {
  const pinOf = (pem: string) =>
    createHash('sha256').update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  assert.equal(pinOf(CERT_A), PIN_A, 'cert A computes to its pinned digest')
  assert.equal(pinOf(CERT_B), PIN_B, 'cert B computes to its pinned digest')
  assert.notEqual(PIN_A, PIN_B, 'two distinct keys — the mismatch case is a real other-key pin')
})

test('validateSpec: an SPKI pin must be a 64-hex sha256, https-only AND gateway-kind-only (S23/P2-2)', () => {
  // A valid pin is normalized into the spec.
  const valid = gatewayProvider.validateSpec({ id: 'pin-ok', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 443, spkiPin: PIN_A })
  assert.ok(valid !== null)
  if (valid !== null) assert.equal(valid.spkiPin, PIN_A, 'a valid pin is carried into the normalized spec')
  // Uppercase hex is a valid pin (the verify-time compare is case-insensitive).
  const upper = gatewayProvider.validateSpec({ id: 'pin-upper', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 443, spkiPin: PIN_A.toUpperCase() })
  assert.ok(upper !== null, 'uppercase hex is accepted')
  if (upper !== null) assert.equal(upper.spkiPin, PIN_A.toUpperCase(), 'the pin is preserved verbatim')
  // Format gate: anything other than ^[0-9a-fA-F]{64}$ is refused.
  assert.equal(gatewayProvider.validateSpec({ id: 'pin-short', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 443, spkiPin: 'abc' }), null)
  assert.equal(gatewayProvider.validateSpec({ id: 'pin-63', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 443, spkiPin: 'a'.repeat(63) }), null)
  assert.equal(gatewayProvider.validateSpec({ id: 'pin-65', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 443, spkiPin: 'a'.repeat(65) }), null)
  assert.equal(gatewayProvider.validateSpec({ id: 'pin-nonhex', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 443, spkiPin: 'g'.repeat(64) }), null, 'non-hex characters are refused')
  assert.equal(gatewayProvider.validateSpec({ id: 'pin-num', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 443, spkiPin: 123456 }), null, 'a non-string pin is refused')
  // http mode + pin → refused: TLS 保护不存在时 pin 无意义，不得声称任何 TLS
  // 保护（design 17 §13.4.2 / S23）.
  assert.equal(gatewayProvider.validateSpec({ id: 'pin-http', label: 'g', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 8080, insecureHttp: true, spkiPin: PIN_A }), null)
  // P2-2: the pin is a GATEWAY-kind-only gate — a non-gateway kind over https
  // carrying a pin would HALF-execute (the identity probe pins, the reverse
  // proxy refuses pins for non-gateway transports), so the spec is refused
  // outright instead of claiming protection that never happens.
  assert.equal(gatewayProvider.validateSpec({ id: 'pin-dsh', label: 'g', kind: 'dsh', transport: 'http', host: 'gw.example.com', remotePort: 443, spkiPin: PIN_A }), null, 'a dsh-kind target is refused outright (dsh×http disabled 2026-09)')
  assert.equal(gatewayProvider.validateSpec({ id: 'pin-future', label: 'g', kind: 'future-target', transport: 'http', host: 'gw.example.com', remotePort: 443, spkiPin: PIN_A }), null, 'any non-gateway kind refuses a pin')
})


/** An https gateway spec (no insecureHttp → https): the S23 pin probes. */
function httpsSpec(id: string, port: number, extra: Record<string, unknown> = {}): ReturnType<typeof gatewayProvider.validateSpec> {
  return gatewayProvider.validateSpec({ id, label: 'g', kind: 'gateway', transport: 'http', host: '127.0.0.1', remotePort: port, ...extra })
}

test('verifyUp over https: pin match probes ok, pin mismatch is terminal, no pin keeps the legacy path (S23)', async () => {
  let receivedRequests = 0
  const handleEnvelope = envelopeHandler({})
  const server = await startHttpsProbeServer(KEY_A, CERT_A, (req, res) => {
    receivedRequests += 1
    handleEnvelope(req, res)
  })
  try {
    // Pin match: the fixture cert's own pin is the trust anchor — the probe
    // succeeds against the self-signed server with NO CA trust (the Caddy
    // `tls internal` use case: no NODE_EXTRA_CA_CERTS needed).
    const specOk = httpsSpec('tls-pin-ok', server.port, { spkiPin: PIN_A })
    assert.ok(specOk !== null)
    const ok = await gatewayProvider.verifyUp!(specOk!, { host: '127.0.0.1', port: server.port })
    assert.equal(ok.ok, true, 'a peer whose SPKI matches the pin is trusted')
    assert.equal(receivedRequests, 1)

    // Pin mismatch: the server presents cert A, the pin is cert B's — the
    // peer's key is not the pinned key → TERMINAL with the S23 detail.
    const specBad = httpsSpec('tls-pin-bad', server.port, { spkiPin: PIN_B })
    assert.ok(specBad !== null)
    setGatewayToken('tls-pin-bad', TOKEN)
    const bad = await gatewayProvider.verifyUp!(specBad!, { host: '127.0.0.1', port: server.port })
    assert.equal(bad.ok, false)
    if (!bad.ok) {
      assert.equal(bad.terminal, true, 'a pinned mismatch is deterministic — retrying cannot change the answer')
      assert.match(bad.detail ?? '', /证书固定不匹配（SPKI）——gateway 证书已更换或 pin 错误/)
    }
    assert.equal(receivedRequests, 1, 'a wrong-key peer receives zero HTTP requests or credential headers')

    // No pin: the pin machinery is inert — the legacy https probe runs, and
    // against this self-signed server the unpinned chain is untrusted →
    // transient connection failure, never the terminal pin verdict.
    const specPlain = httpsSpec('tls-pin-none', server.port)
    assert.ok(specPlain !== null)
    const plain = await gatewayProvider.verifyUp!(specPlain!, { host: '127.0.0.1', port: server.port })
    assert.equal(plain.ok, false)
    if (!plain.ok) {
      assert.notEqual(plain.terminal, true, 'an unpinned untrusted chain is a transient connection failure, not a pin verdict')
      assert.match(plain.detail ?? '', /did not answer/)
    }
  } finally {
    setGatewayToken('tls-pin-bad', null)
    await server.close()
  }
})

test('P1-2: the password LOGIN is SPKI-pinned exactly like the probe — a mismatched peer login is terminal (never forever-network), a matching pin succeeds (design 17 §7.3/§13.4.2/S23)', async () => {
  // A real gateway stub over the self-signed fixture cert: POST /auth/login
  // answers the 3xx + session cookie, everything else (the gateway-owned
  // runtime identity probe) answers 200 — so the whole password flow is real TLS.
  const receivedLoginBodies: string[] = []
  const server = await startHttpsProbeServer(KEY_A, CERT_A, (req, res) => {
    if (req.url === '/auth/login') {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
      req.on('end', () => {
        receivedLoginBodies.push(body)
        res.writeHead(302, { 'set-cookie': [`dsh_gateway_session=fake-jwt; HttpOnly; Path=/; SameSite=Strict`] })
        res.end()
      })
      return
    }
    envelopeHandler({})(req, res)
  })
  const mgr = createGatewaySessionManager()
  const origin: GatewaySessionOrigin = { baseUrl: `https://127.0.0.1:${server.port}`, insecureHttp: false, scope: 'test:tls-login' }
  try {
    // Matching pin: the login succeeds against the self-signed server — the
    // pin IS the trust anchor (the internal-CA case that used to fail as
    // 'network' and could never reach ready).
    const match = await mgr.ensureSession({ ...origin, spkiPin: PIN_A }, PASSWORD)
    assert.equal(match.ok, true, 'a login against the pinned peer succeeds')
    if (match.ok) assert.equal(match.cookie, SESSION_COOKIE)
    assert.deepEqual(receivedLoginBodies, [JSON.stringify({ password: PASSWORD })])
    assert.equal(mgr.cachedCookie(origin), SESSION_COOKIE, 'the pinned login caches the session like any other')
    mgr.invalidate(origin)

    // Mismatched pin: the login is destroyed by the socket verifier →
    // classified 'other' (deterministic protocol evidence — the verifyUp flow
    // maps 'other' TERMINAL, so the password flow never spins as 'network').
    const mismatch = await mgr.ensureSession({ ...origin, spkiPin: PIN_B }, PASSWORD)
    assert.equal(mismatch.ok, false)
    if (!mismatch.ok) {
      assert.equal(mismatch.code, 'other', 'a pin mismatch is deterministic protocol evidence, not a transient network failure')
      assert.match(mismatch.error, /证书固定不匹配（SPKI）——gateway 证书已更换或 pin 错误/)
    }
    assert.equal(mgr.cachedCookie(origin), null, 'a failed pinned login caches nothing')
    assert.equal(receivedLoginBodies.length, 1, 'a wrong-key peer receives zero login requests or password-body bytes')

    // No pin: the legacy unpinned login runs — against the self-signed server
    // the untrusted chain is a transient network failure (the pin is what
    // enables the internal-CA login).
    const unpinned = await mgr.ensureSession(origin, PASSWORD)
    assert.equal(unpinned.ok, false)
    if (!unpinned.ok) assert.equal(unpinned.code, 'network', 'an unpinned login against an untrusted chain stays the legacy transient network failure')

    // End-to-end verifyUp with the REAL session manager wired as the hooks: a
    // pin-mismatched login is TERMINAL — the connect verdict lands immediately
    // instead of cycling 'network' forever (the 永不 ready bug P1-2 fixes).
    configureGatewaySessionProvider({
      ensureSession: (o, password) => mgr.ensureSession(o, password),
      generation: o => mgr.generation(o),
      registrationAuthProof: o => mgr.registrationAuthProof(o),
      setRegistrationAuthProof: (o, proof) => mgr.setRegistrationAuthProof(o, proof),
      cachedCookie: o => mgr.cachedCookie(o),
      invalidate: o => mgr.invalidate(o),
    })
    setGatewayPassword('tls-login-pin', PASSWORD)
    const specBad = httpsSpec('tls-login-pin', server.port, { spkiPin: PIN_B })
    assert.ok(specBad !== null)
    const verdictBad = await gatewayProvider.verifyUp!(specBad!, { host: '127.0.0.1', port: server.port })
    assert.equal(verdictBad.ok, false)
    if (!verdictBad.ok) {
      assert.equal(verdictBad.terminal, true, 'a pin-mismatched login is terminal — the three-state password flow never spins as network')
      assert.match(verdictBad.detail ?? '', /证书固定不匹配（SPKI）/)
    }
    assert.equal(receivedLoginBodies.length, 1, 'end-to-end mismatch also keeps the stored password behind the pin gate')
    // Matching pin end-to-end: the pinned login mints the session and the
    // pinned probe answers the envelope → ready.
    setGatewayPassword('tls-login-ok', PASSWORD)
    const specOk = httpsSpec('tls-login-ok', server.port, { spkiPin: PIN_A })
    assert.ok(specOk !== null)
    const verdictOk = await gatewayProvider.verifyUp!(specOk!, { host: '127.0.0.1', port: server.port })
    assert.equal(verdictOk.ok, true, 'the pinned login + pinned probe succeed end-to-end')
  } finally {
    setGatewayPassword('tls-login-pin', null)
    setGatewayPassword('tls-login-ok', null)
    configureGatewaySessionProvider({})
    mgr.dispose()
    await server.close()
  }
})
