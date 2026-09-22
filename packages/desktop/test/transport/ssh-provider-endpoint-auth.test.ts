/**
 * ssh provider — part 3: probeDshSignature classification and verifyUp auth (dsh vs gateway
 * targets, tokens, password sessions through a real loopback tunnel, SPKI-pinned TLS login).
 * Sibling parts: ssh-provider.test.ts, ssh-provider-exec.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { probeDshSignature, verifyDshEndpoint, sshProvider, verifyGatewayEndpointViaTunnel } from '../../ssh-provider.ts'
import { configureGatewaySessionProvider, setGatewayPassword, setGatewayToken } from '../../gateway-provider.ts'
import type { GatewaySessionProviderHooks } from '../../gateway-provider.ts'
import type { GatewaySessionOrigin } from '../../gateway-session.ts'
import { completeGatewaySessionHooks as completeTestGatewaySessionHooks, GATEWAY_RUNTIME_STATUS } from '../support/gateway-session-test-hooks.ts'
import { closeLoopbackServer, listenEphemeral } from '../../loopback-http-test-server.ts'
import type { TransportInstanceSpec } from '../../transport-provider.ts'

// ---------------------------------------------------------------------------
// probeDshSignature: the dsh-signature classification over a REAL loopback
// HTTP server (valid identity boolean envelope / ok:false envelope / non-
// boolean value / wrong content type / 404 → legacy session/list re-answer /
// timeout / refused).
// ---------------------------------------------------------------------------
test('probeDshSignature classifies the dsh identity signature (boolean value)', async () => {
  const behaviors: Array<(req: any, res: any) => void> = [
    // A valid server-response envelope echoing the identity request with a
    // BOOLEAN value → positive dsh signature (the fixed-size identity wire
    // evidence, dsh ≥ 0.1.2-rc.1 — the events.mux arms are gone).
    (req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += String(chunk) })
      req.on('end', () => {
        const envelope = JSON.parse(body) as { rpcId?: unknown }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: true } }))
      })
    },
    // A server-response envelope with result.ok !== true: NOT a dsh signature
    // (the identity method ANSWERED — no legacy re-answer against a host
    // that answered).
    (req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += String(chunk) })
      req.on('end', () => {
        const envelope = JSON.parse(body) as { rpcId?: unknown }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: false, error: { code: 'forbidden' } } }))
      })
    },
    // An ok:true envelope whose value is NOT a boolean contradicts the
    // identity method contract: NOT a dsh signature.
    (req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += String(chunk) })
      req.on('end', () => {
        const envelope = JSON.parse(body) as { rpcId?: unknown }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { items: [] } } }))
      })
    },
    // 200 with another content type: NOT a dsh signature.
    (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>') },
    // 404: no signature (the legacy re-answer hits the exhausted behavior
    // table → 500 → still no signature).
    (_req, res) => { res.writeHead(404); res.end('nope') },
  ]
  let call = 0
  const server = createServer((req, res) => {
    const behavior = behaviors[call++]
    if (behavior === undefined) { res.writeHead(500); res.end() }
    else behavior(req, res)
  })
  await withLoopbackServer(server, async port => {
    assert.equal(await probeDshSignature({ host: '127.0.0.1', port }), 'dsh')
    assert.equal(await probeDshSignature({ host: '127.0.0.1', port }), 'none')
    assert.equal(await probeDshSignature({ host: '127.0.0.1', port }), 'none')
    assert.equal(await probeDshSignature({ host: '127.0.0.1', port }), 'none')
    // The final 404 re-answers the legacy session/list probe (behavior
    // table exhausted → 500) — still no signature.
    assert.equal(await probeDshSignature({ host: '127.0.0.1', port }), 'none')
  })
})
test('probeDshSignature: an identity 404 re-answers the legacy session/list probe (old runtime tree)', async () => {
  let sessionListCalls = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += String(chunk) })
    req.on('end', () => {
      if (req.url === '/api/session/canOpenWorkspacePath') {
        // The runtime tree predates the identity method (dsh < 0.1.2-rc.1).
        res.writeHead(404)
        res.end('nope')
        return
      }
      if (req.url === '/api/session/list') {
        sessionListCalls += 1
        const envelope = JSON.parse(body) as { rpcId?: unknown }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { items: [] } } }))
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await withLoopbackServer(server, async port => {
    assert.equal(await probeDshSignature({ host: '127.0.0.1', port }), 'dsh')
    assert.equal(sessionListCalls, 1, 'the legacy session/list arm is re-answered exactly once')
  })
})
test('probeDshSignature: a malformed legacy session/list answer is NOT a dsh signature (2.1 canonical predicate)', async () => {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += String(chunk) })
    req.on('end', () => {
      if (req.url === '/api/session/canOpenWorkspacePath') {
        res.writeHead(404)
        res.end('nope')
        return
      }
      if (req.url === '/api/session/list') {
        const envelope = JSON.parse(body) as { rpcId?: unknown }
        // ok:true WITHOUT the {items} session list = a damaged old host, not
        // a healthy old tree (the pre-fix arm accepted any ok:true).
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: {} } }))
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await withLoopbackServer(server, async port => {
    assert.equal(await probeDshSignature({ host: '127.0.0.1', port }), 'none')
  })
})
test('probeDshSignature: a non-404 identity failure never re-answers the legacy probe', async () => {
  let sessionListCalls = 0
  const server = createServer((req, res) => {
    if (req.url === '/api/session/canOpenWorkspacePath') {
      res.writeHead(503)
      res.end('down')
      return
    }
    if (req.url === '/api/session/list') {
      sessionListCalls += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await withLoopbackServer(server, async port => {
    assert.equal(await probeDshSignature({ host: '127.0.0.1', port }), 'none')
    assert.equal(sessionListCalls, 0, '5xx on the identity method is not a legacy-fallback trigger')
  })
})
test('verifyDshEndpoint: a 401 answer is the 0.1.2 browser-auth gate — terminal with the honest reason', async () => {
  // review-round3c P0: a 0.1.2 web-profile host answers 401 without the
  // signed cookie; the launch token is unrecoverable over the tunnel, so the
  // probe must fail loud with the auth-required reason (never "not a dsh").
  // The identity probe (session/canOpenWorkspacePath) AND the signature probe
  // both hit the 401 gate; a bare 401 from a NON-dsh server keeps the neutral
  // message (round4 P2).
  const server = createServer((_req, res) => { res.writeHead(401); res.end('unauthorized') })
  await withLoopbackServer(server, async port => {
    const result = await verifyDshEndpoint({ host: '127.0.0.1', port })
    assert.equal(result.ok, false)
    assert.equal(result.terminal, true)
    // The signature probe is gated the same way → the hedged 401 message.
    assert.match(result.detail ?? '', /answered HTTP 401/)
  })
})
test('probeDshSignature: the identity arm cap is the 64 KiB default (a >64 KiB padded envelope is no signature)', async () => {
  // Discriminating pin for the signature arm's cap VALUE: the answer is a
  // VALID identity envelope (ok:true + boolean) padded past 64 KiB but far
  // under 1 MiB. Under the true 64 KiB arm cap it is oversized → 'none';
  // if the arm cap were ever raised to the legacy 1 MiB value, the envelope
  // would parse and classify 'dsh' — this test would go red.
  let sessionListCalls = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += String(chunk) })
    req.on('end', () => {
      if (req.url === '/api/session/canOpenWorkspacePath') {
        const envelope = JSON.parse(body) as { rpcId?: unknown }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          type: 'server-response',
          rpcId: envelope.rpcId,
          result: { ok: true, value: true },
          padding: 'x'.repeat(70 * 1024),
        }))
        return
      }
      if (req.url === '/api/session/list') {
        sessionListCalls += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await withLoopbackServer(server, async port => {
    assert.equal(await probeDshSignature({ host: '127.0.0.1', port }), 'none')
    assert.equal(sessionListCalls, 0, 'an answered identity arm never re-answers the legacy probe')
  })
})
test('probeDshSignature answers none on connection failure and timeout', async () => {
  // A refused port (server closed): the probe must resolve 'none', never
  // reject or hang.
  const server = createServer(() => {})
  const port = await listenEphemeral(server)
  await closeLoopbackServer(server)
  assert.equal(await probeDshSignature({ host: '127.0.0.1', port }), 'none', 'ECONNREFUSED → none')

  // A silent server: the request timeout resolves 'none'.
  const silent = createServer(() => { /* never answers */ })
  await withLoopbackServer(silent, async silentPort => {
    assert.equal(await probeDshSignature({ host: '127.0.0.1', port: silentPort }, 120), 'none', 'timeout → none')
  })
})

// ---------------------------------------------------------------------------
// verifyUp kind branching (design 17 §9.2): dsh targets never carry auth
// headers; gateway targets may — a stored token rides the tunnel probe as
// Bearer, a missing token is NO pre-flight refusal (the probe goes out
// without a header and the gateway's own 401 is classified terminal, §2.3).
// ---------------------------------------------------------------------------

/** A gateway-over-ssh spec (kind 'gateway', transport 'ssh'). */
function gatewaySshSpec(id: string): TransportInstanceSpec {
  return { id, label: 'h', kind: 'gateway', transport: 'ssh', host: 'h.example.com', user: 'u', sshPort: null, remotePort: 30801, serviceName: null, remoteDshHome: null, insecureHttp: false }
}

/** A loopback server that collects the request body and delegates to a
 * handler (probe handlers echo the client-request rpcId in their
 * server-response / gateway-status bodies). */
function describeServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string) => void) {
  return createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => handler(req, res, body))
  })
}

/** Listen on an ephemeral port, run `body` with it, and always close the server. */
async function withLoopbackServer<T>(server: Server, body: (port: number) => Promise<T>): Promise<T> {
  const port = await listenEphemeral(server)
  try { return await body(port) } finally { await closeLoopbackServer(server) }
}
test('ssh provider verifyUp: a gateway target with a stored token probes WITH an Authorization header', async () => {
  const TOKEN = 'x'.repeat(32)
  setGatewayToken('gw-auth', TOKEN)
  try {
    let seenAuth: string | null = null
    const server = describeServer((req, res, _body) => {
      seenAuth = req.headers.authorization ?? null
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
    })
    await withLoopbackServer(server, async port => {
      const result = await sshProvider.verifyUp!(gatewaySshSpec('gw-auth'), { host: '127.0.0.1', port })
      assert.deepEqual(result, { ok: true })
      assert.equal(seenAuth, `Bearer ${TOKEN}`, 'the stored token rides the tunnel probe as Authorization')
    })
  } finally {
    setGatewayToken('gw-auth', null)
  }
})
test('ssh provider verifyUp: a gateway target WITHOUT a token probes with NO header; a 401 is terminal', async () => {
  setGatewayToken('gw-noauth', null)
  let seenAuth: string | null = null
  const server = describeServer((req, res) => {
    seenAuth = req.headers.authorization ?? null
    res.writeHead(401)
    res.end('unauthorized')
  })
  await withLoopbackServer(server, async port => {
    const result = await sshProvider.verifyUp!(gatewaySshSpec('gw-noauth'), { host: '127.0.0.1', port })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.terminal, true, '401 = deterministic (terminal), never auto-retried')
      assert.match(result.detail ?? '', /requires authentication \(401\) — configure the shared token/)
    }
    assert.equal(seenAuth, null, 'no credentials → the probe carries NO Authorization header (no pre-flight refusal)')
  })
})
test('ssh provider verifyUp: a rejected token answers 401 terminal with the token message', async () => {
  setGatewayToken('gw-bad', 'z'.repeat(32))
  try {
    const server = describeServer((_req, res) => {
      res.writeHead(401)
      res.end('unauthorized')
    })
    await withLoopbackServer(server, async port => {
      const result = await sshProvider.verifyUp!(gatewaySshSpec('gw-bad'), { host: '127.0.0.1', port })
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.equal(result.terminal, true)
        assert.match(result.detail ?? '', /rejected the token \(401\) — check the shared token/)
      }
    })
  } finally {
    setGatewayToken('gw-bad', null)
  }
})
test('ssh provider verifyUp: a dsh target NEVER carries an auth header, even when a token exists for its id', async () => {
  const TOKEN = 'y'.repeat(32)
  setGatewayToken('dsh-with-token', TOKEN)
  try {
    let seenAuth: string | null = null
    const server = describeServer((req, res, body) => {
      seenAuth = req.headers.authorization ?? null
      let rpcId: string | null = null
      try { rpcId = (JSON.parse(body) as { rpcId?: unknown }).rpcId as string | null } catch { /* ignore */ }
      // A real dsh host answers the identity method (session/canOpenWorkspacePath)
      // with a BOOLEAN value — ok:true alone is no longer a positive identity.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: true } }))
    })
    await withLoopbackServer(server, async port => {
      // A dsh-kind spec whose id happens to have a stored token: dsh target
      // semantics forbid auth injection (design 17 §2.1) — the header must
      // never leak even in the collision case.
      const dshSpec: TransportInstanceSpec = { id: 'dsh-with-token', label: 'h', kind: 'dsh', transport: 'ssh', host: 'h.example.com', user: 'u', sshPort: null, remotePort: 3080, serviceName: null, remoteDshHome: null, insecureHttp: false }
      const result = await sshProvider.verifyUp!(dshSpec, { host: '127.0.0.1', port })
      assert.deepEqual(result, { ok: true })
      assert.equal(seenAuth, null, 'dsh targets never inject auth headers')
    })
  } finally {
    setGatewayToken('dsh-with-token', null)
  }
})
test('verifyGatewayEndpointViaTunnel classifies a 403 origin/Host policy rejection as terminal', async () => {
  const server = describeServer((_req, res) => {
    res.writeHead(403)
    res.end('forbidden')
  })
  await withLoopbackServer(server, async port => {
    const result = await verifyGatewayEndpointViaTunnel({ host: '127.0.0.1', port }, null)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.terminal, true, '403 origin/Host policy rejection = terminal')
      assert.match(result.detail ?? '', /origin\/Host policy \(403\)/)
      // The ssh tunnel probe's legacy shape carries statusCode on 403/non-200
      // answers (the direct-endpoint probe does not) — pinned so the shared
      // probe core's carryStatusCodes wiring cannot silently flip.
      assert.equal(result.statusCode, 403, 'tunnel probe carries statusCode on a 403')
    }
  })
})
test('verifyGatewayEndpointViaTunnel keeps 5xx transient and carries its statusCode (legacy shape)', async () => {
  const server = describeServer((_req, res) => {
    res.writeHead(503)
    res.end('busy')
  })
  await withLoopbackServer(server, async port => {
    const result = await verifyGatewayEndpointViaTunnel({ host: '127.0.0.1', port }, null)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.terminal, false, '503 = transient (the bounded retry recovers)')
      assert.match(result.detail ?? '', /HTTP 503/)
      assert.equal(result.statusCode, 503, 'tunnel probe carries statusCode on a non-200 answer')
    }
  })
})

// ---------------------------------------------------------------------------
// verifyUp password-session flow over the SSH TUNNEL (design 17 §9.2/§9.3,
// S1 gap): a gateway-over-ssh target with a stored password and NO token
// uses the SAME session-hook pattern as the direct-endpoint gateway provider
// — ensure a login session keyed to the TUNNEL origin, probe WITH its
// Cookie, and on a rejected 401 invalidate + re-login exactly once before the
// terminal password-refused state. main.ts wires configureGatewaySessionProvider
// once; the ssh provider reads the SAME hooks (getGatewaySessionHooks).
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'dsh_gateway_session=fake-jwt-for-tunnel'
const GATEWAY_PASSWORD = 'gateway-login-password-456'

/** A loopback gateway stub recording the probe's cookie/authorization. */
function tunnelGatewayServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string) => void) {
  return describeServer(handler)
}
test('ssh provider verifyUp: a password-configured gateway-over-ssh target (no token) logs in via the TUNNEL origin and probes WITH the Cookie (design 17 §9.2/§9.3, S1)', async () => {
  const seen: { cookie?: string; authorization?: string } = {}
  const exchanged: Array<{ origin: GatewaySessionOrigin; password: string }> = []
  let cached: string | null = null
  const hooks: GatewaySessionProviderHooks = {
    ensureSession: (origin: GatewaySessionOrigin, password: string) => {
      exchanged.push({ origin, password })
      return Promise.resolve({ ok: true, cookie: SESSION_COOKIE } as const)
    },
    cachedCookie: () => cached,
    invalidate: () => {},
  }
  configureGatewaySessionProvider(completeTestGatewaySessionHooks(hooks))
  const server = tunnelGatewayServer((req, res, _body) => {
    seen.cookie = req.headers.cookie
    seen.authorization = req.headers.authorization
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  })
  const port = await listenEphemeral(server)
  try {
    setGatewayPassword('gw-tunnel-pw-1', GATEWAY_PASSWORD)
    const spec = gatewaySshSpec('gw-tunnel-pw-1')
    const endpoint = { host: '127.0.0.1', port }
    // First verifyUp: no cached session → the STORED password is exchanged
    // against the LOOPBACK tunnel origin (NOT the remote spec host:port) and
    // the probe rides the session Cookie.
    const first = await sshProvider.verifyUp!(spec, endpoint)
    assert.equal(first.ok, true)
    assert.equal(seen.cookie, SESSION_COOKIE, 'the tunnel probe carries the session Cookie')
    assert.equal(seen.authorization, undefined, 'no Authorization when the session authenticates')
    assert.equal(exchanged.length, 1)
    assert.equal(exchanged[0].password, GATEWAY_PASSWORD, 'the STORED password is what the login exchanges — never the cookie')
    assert.equal(exchanged[0].origin.baseUrl, `http://127.0.0.1:${port}`, 'the session is keyed to the TUNNEL endpoint origin')
    assert.equal(exchanged[0].origin.insecureHttp, true, 'the tunnel origin is plain http (the session manager scheme selector)')
    assert.equal(exchanged[0].origin.authority, '127.0.0.1:30801', 'the session key uses the remote loopback HTTP authority, not the SSH alias')
    assert.match(exchanged[0].origin.scope, /^v1:gw-tunnel-pw-1:/, 'the session key is owned by this exact connection and SSH target binding')
    // Second verifyUp with a live cached session: NO re-login — bounded
    // reconnect cycles must never hammer the login endpoint (429 discipline).
    cached = SESSION_COOKIE
    const second = await sshProvider.verifyUp!(spec, endpoint)
    assert.equal(second.ok, true)
    assert.equal(seen.cookie, SESSION_COOKIE)
    assert.equal(exchanged.length, 1, 'a live cached session is never re-exchanged')
  } finally {
    setGatewayPassword('gw-tunnel-pw-1', null)
    configureGatewaySessionProvider({})
    await closeLoopbackServer(server)
  }
})
test('ssh provider verifyUp: a tunnel-probe 401 with the session cookie invalidates, re-logs in ONCE, and only then reports the terminal password-refused state (design 17 §7.3/§9.3)', async () => {
  const invalidated: GatewaySessionOrigin[] = []
  let logins = 0
  const server = tunnelGatewayServer((_req, res) => {
    res.writeHead(401)
    res.end('unauthorized')
  })
  const hooks: GatewaySessionProviderHooks = {
    ensureSession: (_origin: GatewaySessionOrigin) => {
      logins += 1
      return Promise.resolve({ ok: true, cookie: SESSION_COOKIE } as const)
    },
    cachedCookie: () => null,
    invalidate: origin => { invalidated.push(origin) },
  }
  configureGatewaySessionProvider(completeTestGatewaySessionHooks(hooks))
  const port = await listenEphemeral(server)
  try {
    setGatewayPassword('gw-tunnel-401-1', GATEWAY_PASSWORD)
    const result = await sshProvider.verifyUp!(gatewaySshSpec('gw-tunnel-401-1'), { host: '127.0.0.1', port })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.terminal, true, 'a session rejected even after the one re-login is deterministic')
      assert.match(result.detail ?? '', /rejected the password authentication \(401\) — re-enter the password/)
    }
    assert.equal(logins, 2, 'the 401 triggered exactly ONE automatic re-login (bounded, §9.3 重登一次)')
    assert.equal(invalidated.length, 2, 'both the stale and the freshly minted session are invalidated')
    assert.equal(invalidated[0].baseUrl, `http://127.0.0.1:${port}`, 'the invalidation targets the tunnel origin')
  } finally {
    setGatewayPassword('gw-tunnel-401-1', null)
    configureGatewaySessionProvider({})
    await closeLoopbackServer(server)
  }
})
test('ssh provider verifyUp: a tunnel-probe 401 self-heals through the one automatic re-login — the fresh session probes ok (design 17 §9.3)', async () => {
  let probes = 0
  const server = tunnelGatewayServer((_req, res, _body) => {
    probes += 1
    if (probes === 1) {
      res.writeHead(401)
      res.end('unauthorized')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  })
  const invalidated: GatewaySessionOrigin[] = []
  let logins = 0
  const hooks: GatewaySessionProviderHooks = {
    ensureSession: (_origin: GatewaySessionOrigin) => {
      logins += 1
      return Promise.resolve({ ok: true, cookie: SESSION_COOKIE } as const)
    },
    cachedCookie: () => null,
    invalidate: origin => { invalidated.push(origin) },
  }
  configureGatewaySessionProvider(completeTestGatewaySessionHooks(hooks))
  const port = await listenEphemeral(server)
  try {
    setGatewayPassword('gw-tunnel-relogin-1', GATEWAY_PASSWORD)
    const result = await sshProvider.verifyUp!(gatewaySshSpec('gw-tunnel-relogin-1'), { host: '127.0.0.1', port })
    assert.equal(result.ok, true, 'the fresh session after the one automatic re-login is accepted')
    assert.equal(probes, 2, 'exactly two probes: the stale-cookie probe and the fresh-session re-probe')
    assert.equal(logins, 2, 'the initial login plus exactly ONE automatic re-login')
    assert.equal(invalidated.length, 1, 'only the stale session was invalidated — the fresh one is kept')
  } finally {
    setGatewayPassword('gw-tunnel-relogin-1', null)
    configureGatewaySessionProvider({})
    await closeLoopbackServer(server)
  }
})
test('ssh provider verifyUp: token and password coexist — the tunnel probe carries Bearer AND Cookie (design 17 §2.3)', async () => {
  const TOKEN = 'q'.repeat(32)
  setGatewayToken('gw-tunnel-both-1', TOKEN)
  let sessionConsulted = 0
  const hooks: GatewaySessionProviderHooks = {
    ensureSession: () => { sessionConsulted += 1; return Promise.resolve({ ok: true, cookie: SESSION_COOKIE } as const) },
    cachedCookie: () => null,
    invalidate: () => { sessionConsulted += 1 },
  }
  configureGatewaySessionProvider(completeTestGatewaySessionHooks(hooks))
  let seenAuth: string | null = null
  let seenCookie: string | null = null
  const server = tunnelGatewayServer((req, res) => {
    seenAuth = req.headers.authorization ?? null
    seenCookie = req.headers.cookie ?? null
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  })
  const port = await listenEphemeral(server)
  try {
    setGatewayPassword('gw-tunnel-both-1', GATEWAY_PASSWORD)
    const result = await sshProvider.verifyUp!(gatewaySshSpec('gw-tunnel-both-1'), { host: '127.0.0.1', port })
    assert.equal(result.ok, true)
    assert.equal(seenAuth, `Bearer ${TOKEN}`, 'the Bearer token rides the tunnel probe')
    assert.equal(seenCookie, SESSION_COOKIE, 'the independent password session also rides the tunnel probe')
    assert.equal(sessionConsulted, 1, 'the token never shadows the password/session flow')
  } finally {
    setGatewayToken('gw-tunnel-both-1', null)
    setGatewayPassword('gw-tunnel-both-1', null)
    configureGatewaySessionProvider({})
    await closeLoopbackServer(server)
  }
})
test('ssh provider verifyUp: a refused password login falls back to a valid tunnel Bearer', async () => {
  const TOKEN = 'r'.repeat(32)
  configureGatewaySessionProvider(completeTestGatewaySessionHooks({
    ensureSession: async () => ({ ok: false, code: 'invalid_credentials', error: 'password rejected' }),
    cachedCookie: () => null,
  }))
  let probes = 0
  const server = tunnelGatewayServer((req, res) => {
    probes += 1
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(req.headers.cookie, undefined)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  })
  const port = await listenEphemeral(server)
  try {
    setGatewayToken('gw-tunnel-fallback', TOKEN)
    setGatewayPassword('gw-tunnel-fallback', GATEWAY_PASSWORD)
    assert.deepEqual(await sshProvider.verifyUp!(gatewaySshSpec('gw-tunnel-fallback'), { host: '127.0.0.1', port }), { ok: true })
    assert.equal(probes, 1)
  } finally {
    setGatewayToken('gw-tunnel-fallback', null)
    setGatewayPassword('gw-tunnel-fallback', null)
    configureGatewaySessionProvider({})
    await closeLoopbackServer(server)
  }
})
test('ssh provider verifyUp: a token cleared during the login exchange is never sent by the bearer fallback (4.3 live read)', async () => {
  const id = 'gw-tunnel-live-clear'
  configureGatewaySessionProvider(completeTestGatewaySessionHooks({
    ensureSession: async () => {
      // The credential store is mutated while verifyUp is in flight. The
      // fallback must observe the LIVE value: a cleared token means "no
      // bearer principal to try", never a credential-free probe whose 200
      // (a --no-auth deployment) would be misreported as a bearer success.
      setGatewayToken(id, null)
      return { ok: false, code: 'invalid_credentials', error: 'password rejected' }
    },
    cachedCookie: () => null,
  }))
  let probes = 0
  const server = tunnelGatewayServer((_req, res) => {
    probes += 1
    res.writeHead(401)
    res.end('unauthorized')
  })
  const port = await listenEphemeral(server)
  try {
    setGatewayToken(id, 'r'.repeat(32))
    setGatewayPassword(id, GATEWAY_PASSWORD)
    const result = await sshProvider.verifyUp!(gatewaySshSpec(id), { host: '127.0.0.1', port })
    assert.equal(result.ok, false)
    assert.equal(probes, 0, 'a cleared token must not degrade the fallback into an unauthenticated probe')
    if (!result.ok) assert.equal(result.terminal, true, 'the password failure classification stays authoritative')
  } finally {
    setGatewayToken(id, null)
    setGatewayPassword(id, null)
    configureGatewaySessionProvider({})
    await closeLoopbackServer(server)
  }
})
test('ssh provider verifyUp: a token rotated during the login exchange rides the SAME-cycle cookie probe (4.3 live read)', async () => {
  const id = 'gw-tunnel-live-rotate'
  const ROTATED = 'n'.repeat(32)
  const seen: Array<string | undefined> = []
  configureGatewaySessionProvider(completeTestGatewaySessionHooks({
    ensureSession: async () => {
      setGatewayToken(id, ROTATED)
      return { ok: true, cookie: SESSION_COOKIE }
    },
    cachedCookie: () => null,
  }))
  const server = tunnelGatewayServer((req, res) => {
    seen.push(req.headers.authorization)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  })
  const port = await listenEphemeral(server)
  try {
    setGatewayToken(id, 'o'.repeat(32))
    setGatewayPassword(id, GATEWAY_PASSWORD)
    assert.deepEqual(await sshProvider.verifyUp!(gatewaySshSpec(id), { host: '127.0.0.1', port }), { ok: true })
    assert.deepEqual(seen, [`Bearer ${ROTATED}`], 'each exchange reads the live token, never the verifyUp-entry snapshot')
  } finally {
    setGatewayToken(id, null)
    setGatewayPassword(id, null)
    configureGatewaySessionProvider({})
    await closeLoopbackServer(server)
  }
})
test('ssh provider verifyUp: without session hooks a password-configured gateway-over-ssh target probes WITHOUT auth (inert default, design 17 §2.3)', async () => {
  const seen: { cookie?: string; authorization?: string } = {}
  const server = tunnelGatewayServer((req, res) => {
    seen.cookie = req.headers.cookie
    seen.authorization = req.headers.authorization
    res.writeHead(401)
    res.end('unauthorized')
  })
  configureGatewaySessionProvider({})
  const port = await listenEphemeral(server)
  try {
    setGatewayPassword('gw-tunnel-inert-1', GATEWAY_PASSWORD)
    const result = await sshProvider.verifyUp!(gatewaySshSpec('gw-tunnel-inert-1'), { host: '127.0.0.1', port })
    assert.equal(seen.cookie, undefined, 'no hooks → the tunnel probe carries no Cookie')
    assert.equal(seen.authorization, undefined, 'no hooks → the tunnel probe carries no Authorization')
    assert.equal(result.ok, false, 'the password-gated tunnel endpoint must reject the probe')
    assert.match(result.detail ?? '', /requires authentication/)
  } finally {
    setGatewayPassword('gw-tunnel-inert-1', null)
    configureGatewaySessionProvider({})
    await closeLoopbackServer(server)
  }
})
test('verifyGatewayEndpointViaTunnel: a 401 with a session Cookie is classified as the password being refused, never as a token problem', async () => {
  const server = tunnelGatewayServer((_req, res) => {
    res.writeHead(401)
    res.end('unauthorized')
  })
  await withLoopbackServer(server, async port => {
    // Cookie-carrying probe: password-refused message (design 17 §7.3 密码被拒).
    const withCookie = await verifyGatewayEndpointViaTunnel({ host: '127.0.0.1', port }, null, undefined, undefined, SESSION_COOKIE)
    assert.equal(withCookie.ok, false)
    assert.equal(withCookie.terminal, true)
    assert.equal(withCookie.statusCode, 401, 'the raw status rides the result for the session flow')
    assert.match(withCookie.detail ?? '', /rejected the password authentication \(401\) — re-enter the password/)
    // Cookie-less, token-less probe: "configure the shared token or password".
    const noCredential = await verifyGatewayEndpointViaTunnel({ host: '127.0.0.1', port }, null)
    assert.equal(noCredential.ok, false)
    assert.match(noCredential.detail ?? '', /requires authentication \(401\) — configure the shared token/)
    // Token-carrying probe: "check the shared token".
    const withToken = await verifyGatewayEndpointViaTunnel({ host: '127.0.0.1', port }, 'z'.repeat(32))
    assert.equal(withToken.ok, false)
    assert.match(withToken.detail ?? '', /rejected the token \(401\) — check the shared token/)
  })
})
test('ssh provider verifyUp: a gateway-over-ssh probe presents the remote loopback authority, never the SSH hostname/alias (design 17 §9.3)', async () => {
  setGatewayToken('gw-host', null)
  let seenHost: string | null = null
  const server = describeServer((req, res, _body) => {
    seenHost = req.headers.host ?? null
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  })
  await withLoopbackServer(server, async port => {
    const result = await sshProvider.verifyUp!(gatewaySshSpec('gw-host'), { host: '127.0.0.1', port })
    assert.deepEqual(result, { ok: true })
    assert.equal(seenHost, '127.0.0.1:30801', 'the forward terminates at remote loopback; an SSH alias is not an HTTP authority')
  })
})
