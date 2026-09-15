/**
 * Public request boundary: the no-listen policy/dispatch matrix plus the single
 * real-socket proof that the same evaluator threads through the control-plane
 * shell (design 17 sections 5-6).
 *
 * Merged from test/request-policy.test.ts and test/public-http.test.ts. Both
 * sources cover the same wiring chain (createGatewayRequestPolicy ->
 * createGatewayDispatch -> control-plane middleware); every test title,
 * assertion and behaviour is carried over verbatim. The only unified text is
 * the duplicated "const TOKEN" declaration, hoisted once to the shared header
 * below.
 */

import { request as httpRequest } from 'node:http'
import { createConnection } from 'node:net'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlPlane } from '@dsh-chamber/control-plane'
import type { ApiRequest } from '@dsh-chamber/control-plane'
import type { AuthProvider } from '../../src/auth.ts'
import { parseGatewayConfig } from '../../src/config.ts'
import { createGatewayDispatch } from '../../src/dispatch.ts'
import { createGatewayRequestPolicy } from '../../src/middleware.ts'

const TOKEN = '0123456789abcdef0123456789abcdef'

// --- merged from test/request-policy.test.ts ---

/** Gateway public-boundary matrix: one policy covers HTTP, preflight and WS. */


const STATE = '/tmp/dsh-gateway-policy-state'
const DSH = '/tmp/dsh-workspace'

function request(
  headers: Record<string, string>,
  remoteAddress: string,
  rawHeaders?: string[],
): ApiRequest {
  return {
    headers,
    socket: { remoteAddress },
    ...(rawHeaders === undefined ? {} : { rawHeaders }),
  } as unknown as ApiRequest
}

function policy(input: Parameters<typeof parseGatewayConfig>[0]) {
  return createGatewayRequestPolicy(parseGatewayConfig({ apiToken: TOKEN, ...input }, STATE, DSH))
}

test('exact public authority and same origin are allowed', () => {
  const boundary = policy({ host: '0.0.0.0', port: 3000, publicOrigin: 'http://gateway.example:3000' })
  const decision = boundary.evaluate(request({ host: 'gateway.example:3000', origin: 'http://gateway.example:3000' }, '203.0.113.8'))
  assert.equal(decision.allowed, true)
  assert.equal(decision.clientAddress, '203.0.113.8')
  assert.equal(decision.headers['access-control-allow-origin'], 'http://gateway.example:3000')
})

test('an http(s) CORS origin is a caller origin, not a Host authority', () => {
  const boundary = policy({
    host: '0.0.0.0',
    port: 3000,
    publicOrigin: 'https://gateway.example',
    corsOrigins: ['https://alternate.example'],
    trustedProxies: ['127.0.0.1'],
  })
  const allowedCaller = boundary.evaluate(request({
    host: '127.0.0.1:3000',
    'x-forwarded-host': 'gateway.example',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '203.0.113.8',
    origin: 'https://alternate.example',
  }, '127.0.0.1'))
  assert.equal(allowedCaller.allowed, true)
  assert.equal(allowedCaller.clientAddress, '203.0.113.8')

  const rejectedAuthority = boundary.evaluate(request({
    host: '127.0.0.1:3000',
    'x-forwarded-host': 'alternate.example',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '203.0.113.8',
    origin: 'https://alternate.example',
  }, '127.0.0.1'))
  assert.equal(rejectedAuthority.status, 421)
})

test('a public peer cannot assert a private authority', () => {
  const boundary = policy({ host: '0.0.0.0', port: 3000 })
  const decision = boundary.evaluate(request({ host: '192.168.1.10:3000' }, '203.0.113.8'))
  assert.deepEqual({ allowed: decision.allowed, status: decision.status, code: decision.code }, {
    allowed: false,
    status: 421,
    code: 'misdirected_request',
  })
})

test('a private peer may use a same-port private authority', () => {
  const boundary = policy({ host: '0.0.0.0', port: 3000 })
  const decision = boundary.evaluate(request({ host: '192.168.1.10:3000' }, '192.168.1.20'))
  assert.equal(decision.allowed, true)
})

test('untrusted X-Forwarded facts cannot change the peer or TLS decision', () => {
  const boundary = policy({ host: '0.0.0.0', port: 3000 })
  const decision = boundary.evaluate(request({
    host: '192.168.1.10:3000',
    'x-forwarded-for': '192.168.1.20',
    'x-forwarded-proto': 'https',
  }, '203.0.113.8'))
  assert.equal(decision.allowed, false)
  assert.equal(decision.secure, false)
})

test('an explicitly trusted proxy may supply public host, TLS and client IP', () => {
  const boundary = policy({
    host: '0.0.0.0',
    port: 3000,
    publicOrigin: 'https://gateway.example',
    trustedProxies: ['127.0.0.1'],
  })
  const decision = boundary.evaluate(request({
    host: '127.0.0.1:3000',
    'x-forwarded-host': 'gateway.example',
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '203.0.113.8',
    origin: 'https://gateway.example',
  }, '127.0.0.1'))
  assert.equal(decision.allowed, true)
  assert.equal(decision.secure, true)
  assert.equal(decision.clientAddress, '203.0.113.8')
})

test('a trusted proxy cannot turn malformed XFF into its own private peer identity', () => {
  const boundary = policy({
    host: '0.0.0.0',
    port: 3000,
    trustedProxies: ['127.0.0.1'],
  })
  for (const forwardedFor of ['203.0.113.8, 192.168.1.20', 'not-an-ip']) {
    const decision = boundary.evaluate(request({
      host: '192.168.1.10:3000',
      'x-forwarded-for': forwardedFor,
    }, '127.0.0.1'))
    assert.deepEqual({ allowed: decision.allowed, status: decision.status, code: decision.code }, {
      allowed: false,
      status: 421,
      code: 'misdirected_request',
    })
  }
  const missing = boundary.evaluate(request({ host: '192.168.1.10:3000' }, '127.0.0.1'))
  assert.equal(missing.status, 421)
})

test('missing, duplicate and malformed authority values fail closed', () => {
  const boundary = policy({ host: '0.0.0.0', port: 3000, publicOrigin: 'http://gateway.example:3000' })
  assert.equal(boundary.evaluate(request({}, '203.0.113.8')).status, 421)
  assert.equal(boundary.evaluate(request({ host: 'user@gateway.example:3000' }, '203.0.113.8')).status, 421)
  const duplicate = boundary.evaluate(request(
    { host: 'gateway.example:3000' },
    '203.0.113.8',
    ['Host', 'gateway.example:3000', 'Host', 'attacker.example'],
  ))
  assert.equal(duplicate.status, 421)
})

test('duplicate raw Authorization fails closed before a normalized first value can authenticate', () => {
  const boundary = policy({ host: '0.0.0.0', port: 3000, publicOrigin: 'http://gateway.example:3000' })
  const decision = boundary.evaluate(request(
    { host: 'gateway.example:3000', authorization: `Bearer ${TOKEN}` },
    '203.0.113.8',
    [
      'Host', 'gateway.example:3000',
      'Authorization', `Bearer ${TOKEN}`,
      'Authorization', 'Bearer attacker-controlled-second-value',
    ],
  ))
  assert.deepEqual({ allowed: decision.allowed, status: decision.status, code: decision.code }, {
    allowed: false,
    status: 400,
    code: 'bad_request',
  })
})

test('packaged origins require explicit allowlisting and literal null is rejected', () => {
  const boundary = policy({
    host: '0.0.0.0',
    port: 3000,
    publicOrigin: 'http://gateway.example:3000',
    corsOrigins: ['capacitor://localhost', 'openchamber-ui://app'],
  })
  const packaged = boundary.evaluate(request({ host: 'gateway.example:3000', origin: 'capacitor://localhost' }, '203.0.113.8'))
  assert.equal(packaged.allowed, true)
  assert.equal(packaged.headers['access-control-allow-origin'], 'capacitor://localhost')
  const opaque = boundary.evaluate(request({ host: 'gateway.example:3000', origin: 'null' }, '203.0.113.8'))
  assert.equal(opaque.status, 403)
})

test('an https public origin rejects a direct plaintext request', () => {
  const boundary = policy({ host: '0.0.0.0', port: 3000, publicOrigin: 'https://gateway.example' })
  const decision = boundary.evaluate(request({ host: 'gateway.example' }, '203.0.113.8'))
  assert.equal(decision.status, 421)
})

test('a cross-site request without Origin is rejected via sec-fetch-site', () => {
  const boundary = policy({ host: '0.0.0.0', port: 3000, publicOrigin: 'http://gateway.example:3000' })
  // A cross-site browser navigation/media load carries no Origin, so the
  // sec-fetch-site signal is the only way to detect it — reject, never
  // bypass the Origin check.
  const decision = boundary.evaluate(request({
    host: 'gateway.example:3000',
    'sec-fetch-site': 'cross-site',
  }, '203.0.113.8'))
  assert.deepEqual({ allowed: decision.allowed, status: decision.status, code: decision.code }, {
    allowed: false,
    status: 403,
    code: 'origin_forbidden',
  })
  // Same-origin / absent sec-fetch-site must not be affected by the branch.
  const sameOrigin = boundary.evaluate(request({
    host: 'gateway.example:3000',
    'sec-fetch-site': 'same-origin',
  }, '203.0.113.8'))
  assert.equal(sameOrigin.allowed, true)
  const absent = boundary.evaluate(request({ host: 'gateway.example:3000' }, '203.0.113.8'))
  assert.equal(absent.allowed, true)
})

test('every rejection carries the failing-check reason for diagnostics; allowances never do', () => {
  const boundary = policy({ host: '0.0.0.0', port: 3000, publicOrigin: 'http://gateway.example:3000' })
  const mismatch = boundary.evaluate(request({ host: 'gateway.example:3000', origin: 'http://evil.example' }, '203.0.113.8'))
  assert.deepEqual(mismatch.reason, { kind: 'origin_mismatch', origin: 'http://evil.example', authority: 'http://gateway.example:3000' })
  const opaque = boundary.evaluate(request({ host: 'gateway.example:3000', origin: 'null' }, '203.0.113.8'))
  assert.deepEqual(opaque.reason, { kind: 'origin_invalid', origin: 'null' })
  const crossSite = boundary.evaluate(request({ host: 'gateway.example:3000', 'sec-fetch-site': 'cross-site' }, '203.0.113.8'))
  assert.deepEqual(crossSite.reason, { kind: 'cross_site_no_origin' })
  const duplicateAuth = boundary.evaluate(request(
    { host: 'gateway.example:3000', authorization: 'Bearer x' },
    '203.0.113.8',
    ['Host', 'gateway.example:3000', 'Authorization', 'Bearer x', 'Authorization', 'Bearer y'],
  ))
  assert.deepEqual(duplicateAuth.reason, { kind: 'malformed_headers' })
  // A public peer cannot use a public authority: the host value is echoed.
  const rejectedAuthority = boundary.evaluate(request({ host: '203.0.113.9:3000' }, '203.0.113.8'))
  assert.deepEqual(rejectedAuthority.reason, { kind: 'host_rejected', host: '203.0.113.9:3000' })
  // Missing Host → host_rejected without a value (nothing to echo).
  const missing = boundary.evaluate(request({}, '203.0.113.8'))
  assert.deepEqual(missing.reason, { kind: 'host_rejected' })
  // Allowed decisions never carry a reason.
  const allowed = boundary.evaluate(request({ host: 'gateway.example:3000' }, '203.0.113.8'))
  assert.equal(allowed.reason, undefined)
})

// --- merged from test/public-http.test.ts ---

/** One real-socket proof that the gateway evaluator threads through the
 * control-plane shell; the rest of the boundary matrix stays no-listen. */


const silentLogger = { log() {}, warn() {}, error() {} }

test('anonymous control-plane cannot opt into a network bind with only a permissive CORS callback', () => {
  assert.throws(() => createControlPlane({
    host: '0.0.0.0',
    corsEvaluator: () => ({ allowed: true }),
  }), /HTTP\/upgrade middleware/)
})

function get(port: number, path: string, headers: Record<string, string>, method: 'GET' | 'OPTIONS' | 'HEAD' | 'POST' = path === '/chamber/settings' ? 'OPTIONS' : 'GET'): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let response = ''
    let settled = false
    const socket = createConnection({ host: '127.0.0.1', port }, () => socket.write(payload))
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve(response)
    }
    socket.setTimeout(5_000, () => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error('raw gateway request timed out'))
    })
    socket.on('data', chunk => { response += chunk.toString('utf8') })
    socket.on('end', finish)
    socket.on('close', hadError => { if (!hadError) finish() })
    socket.on('error', error => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

test('public Host health/preflight pass while an unknown authority is rejected', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-public-http-'))
  const config = parseGatewayConfig({
    host: '0.0.0.0',
    port: 3000,
    apiToken: TOKEN,
    publicOrigin: 'http://gateway.example:3000',
    corsOrigins: ['capacitor://localhost'],
  }, stateDir, '/tmp/dsh')
  const policy = createGatewayRequestPolicy(config)
  const auth: AuthProvider = {
    kind: 'token',
    async verify(req) { return req.headers.authorization === 'Bearer secret' ? { kind: 'token', id: 'test', issuedAt: 0 } : null },
  }
  const proxy = { async handleHttp() {}, async handleUpgrade() {}, getDiagnostics() { return { requests: 0, failures: 0, activeStreams: 0, activeHttpRequests: 0, pendingUpgrades: 0, bufferedRequestBytes: 0, longRpcRequests: 0, longRpcTimeouts: 0 } }, closeAllStreams() {} }
  const features = { async handle() { return true }, start() {}, stop() {}, async quiesce() {} }
  const dispatch = createGatewayDispatch(auth, () => proxy, () => features, () => ({ async handle() { return false } }), silentLogger, policy)
  const plane = createControlPlane({
    host: '0.0.0.0',
    port: 0,
    stateDir,
    dshWorkspacePath: '/tmp/dsh',
    logger: silentLogger,
    corsEvaluator: policy.corsEvaluator,
    middleware: dispatch.middleware,
    upgradeMiddleware: dispatch.upgradeMiddleware,
  })
  try {
    await plane.start()
    const health = await get(plane.port!, '/health', {
      host: 'gateway.example:3000',
      origin: 'http://gateway.example:3000',
    })
    assert.equal(health.status, 200)
    assert.equal(health.headers['access-control-allow-origin'], 'http://gateway.example:3000')

    // HEAD /health is public like GET /health (isPublicRequest exempts both)
    // and must reach the plane's 200 twin, not a 404 — the full chain from
    // the gateway boundary through the auth gate to api.handle.
    const head = await get(plane.port!, '/health', {
      host: 'gateway.example:3000',
      origin: 'http://gateway.example:3000',
    }, 'HEAD')
    assert.equal(head.status, 200)
    assert.equal(head.body, '', 'HEAD /health carries no body')

    const rejected = await get(plane.port!, '/health', { host: 'attacker.example' })
    assert.equal(rejected.status, 421)

    const invalidTarget = await get(plane.port!, '//attacker.example/health', {
      host: 'gateway.example:3000',
    })
    assert.equal(invalidTarget.status, 400)

    const backslashTarget = await get(plane.port!, '/\\\\attacker.example/health', {
      host: 'gateway.example:3000',
    })
    assert.equal(backslashTarget.status, 400)

    const preflight = await get(plane.port!, '/chamber/settings', {
      host: 'gateway.example:3000',
      origin: 'capacitor://localhost',
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'authorization, content-type',
    })
    assert.equal(preflight.status, 204)
    assert.match(String(preflight.headers['access-control-allow-headers']), /authorization/)

    // Use literal duplicate field lines rather than node:http's normalized
    // header object: Node keeps a single Authorization value, so only the
    // shared raw request policy can prevent first-value masking.
    const duplicateHttp = await rawRequest(plane.port!, [
      'GET /health HTTP/1.1',
      'Host: gateway.example:3000',
      'Authorization: Bearer secret',
      'Authorization: Bearer attacker-controlled-second-value',
      'Connection: close',
      '',
      '',
    ].join('\r\n'))
    assert.match(duplicateHttp, /^HTTP\/1\.1 400 Bad Request/)
    assert.match(duplicateHttp, /"code":"bad_request"/)

    const duplicateWs = await rawRequest(plane.port!, [
      'GET /api/i/missing/api/remote.mux HTTP/1.1',
      'Host: gateway.example:3000',
      'Origin: http://gateway.example:3000',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Authorization: Bearer secret',
      'Authorization: Bearer attacker-controlled-second-value',
      '',
      '',
    ].join('\r\n'))
    assert.match(duplicateWs, /^HTTP\/1\.1 400 Bad Request/)
    assert.match(duplicateWs, /"code":"bad_request"/)
  } finally {
    await plane.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})
