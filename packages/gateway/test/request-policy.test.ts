/** Gateway public-boundary matrix: one policy covers HTTP, preflight and WS. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiRequest } from '@dsh-chamber/control-plane'
import { parseGatewayConfig } from '../src/config.ts'
import { createGatewayRequestPolicy } from '../src/middleware.ts'

const STATE = '/tmp/dsh-gateway-policy-state'
const DSH = '/tmp/dsh-workspace'
const TOKEN = '0123456789abcdef0123456789abcdef'

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
