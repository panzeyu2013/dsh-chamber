/**
 * Gateway config unit tests (design 17 §3.1): the S1 exposure guard, host
 * validation, tls pairing, and the auth-kind resolution. Pure functions — no
 * I/O, deterministic. (Written structure-correct; run with `node --test`.)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GatewayConfigError, parseGatewayConfig } from '../src/config.ts'

const STATE = '/tmp/dsh-gateway-state'
const DSH = '/tmp/dsh-workspace'
const TOKEN = '0123456789abcdef0123456789abcdef'
const PASSWORD = 'correct-horse-battery'

test('S1: a non-loopback bind without auth is a config error', () => {
  assert.throws(
    () => parseGatewayConfig({ host: '0.0.0.0' }, STATE, DSH),
    GatewayConfigError,
  )
})

test('a loopback bind with no auth resolves kind none', () => {
  const config = parseGatewayConfig({ host: '127.0.0.1' }, STATE, DSH)
  assert.equal(config.plane.host, '127.0.0.1')
  assert.equal(config.auth.kind, 'none')
})

test('S1: loopback behind a public origin or trusted proxy still requires auth', () => {
  assert.throws(
    () => parseGatewayConfig({ host: '127.0.0.1', publicOrigin: 'https://gateway.example' }, STATE, DSH),
    /without authentication/,
  )
  assert.throws(
    () => parseGatewayConfig({ host: '127.0.0.1', trustedProxies: ['127.0.0.1'] }, STATE, DSH),
    /without authentication/,
  )
})

test('S1 override: --no-auth permits an anonymous external bind', () => {
  const config = parseGatewayConfig({ host: '0.0.0.0', allowAnonymousExternal: true }, STATE, DSH)
  assert.equal(config.auth.kind, 'none')
  assert.equal(config.allowAnonymousExternal, true)
  assert.equal(config.plane.host, '0.0.0.0')
})

test('S1 override: also permits anonymous loopback behind a public origin or trusted proxy', () => {
  assert.doesNotThrow(
    () => parseGatewayConfig({ host: '127.0.0.1', publicOrigin: 'https://gateway.example', allowAnonymousExternal: true }, STATE, DSH),
  )
  assert.doesNotThrow(
    () => parseGatewayConfig({ host: '127.0.0.1', trustedProxies: ['127.0.0.1'], allowAnonymousExternal: true }, STATE, DSH),
  )
})

test('0.0.0.0 + api-token resolves kind token', () => {
  const config = parseGatewayConfig({ host: '0.0.0.0', apiToken: TOKEN }, STATE, DSH)
  assert.equal(config.auth.kind, 'token')
  assert.equal(config.auth.token, TOKEN)
})

test('0.0.0.0 + ui-password resolves kind password', () => {
  const config = parseGatewayConfig({ host: '0.0.0.0', uiPassword: PASSWORD }, STATE, DSH)
  assert.equal(config.auth.kind, 'password')
  assert.equal(config.auth.password, PASSWORD)
})

test('password and token compose instead of shadowing the bearer credential', () => {
  const config = parseGatewayConfig({ host: '0.0.0.0', uiPassword: PASSWORD, apiToken: TOKEN }, STATE, DSH)
  assert.equal(config.auth.kind, 'password+token')
  assert.equal(config.auth.password, PASSWORD)
  assert.equal(config.auth.token, TOKEN)
})

test('public/cors origins and trusted proxy peers are canonicalized and validated', () => {
  const config = parseGatewayConfig({
    uiPassword: PASSWORD,
    publicOrigin: 'https://gateway.example',
    corsOrigins: ['https://client.example', 'capacitor://localhost', 'openchamber-ui://app'],
    trustedProxies: ['127.0.0.1', '::1'],
  }, STATE, DSH)
  assert.equal(config.publicOrigin, 'https://gateway.example')
  assert.deepEqual(config.corsOrigins, ['https://client.example', 'capacitor://localhost', 'openchamber-ui://app'])
  assert.deepEqual(config.trustedProxies, ['127.0.0.1', '::1'])
  assert.throws(() => parseGatewayConfig({ publicOrigin: 'https://gateway.example/path' }, STATE, DSH), GatewayConfigError)
  assert.throws(() => parseGatewayConfig({ corsOrigins: ['null'] }, STATE, DSH), GatewayConfigError)
  assert.throws(() => parseGatewayConfig({ trustedProxies: ['proxy.local'] }, STATE, DSH), GatewayConfigError)
})

test('an invalid host is a config error', () => {
  assert.throws(() => parseGatewayConfig({ host: 'example.com' }, STATE, DSH), GatewayConfigError)
  assert.throws(() => parseGatewayConfig({ host: '::1' }, STATE, DSH), GatewayConfigError)
})

test('an invalid port is a config error', () => {
  assert.throws(() => parseGatewayConfig({ port: 0 }, STATE, DSH), GatewayConfigError)
  assert.throws(() => parseGatewayConfig({ port: 70000 }, STATE, DSH), GatewayConfigError)
})

test('--tls-cert and --tls-key must be paired', () => {
  assert.throws(() => parseGatewayConfig({ tlsCert: '/c.pem' }, STATE, DSH), GatewayConfigError)
  assert.throws(() => parseGatewayConfig({ tlsKey: '/k.pem' }, STATE, DSH), GatewayConfigError)
})

test('a paired tls cert+key is rejected (HTTPS server not implemented)', () => {
  assert.throws(() => parseGatewayConfig({ tlsCert: '/c.pem', tlsKey: '/k.pem' }, STATE, DSH), GatewayConfigError)
})

test('an empty password is rejected (not a credential)', () => {
  assert.throws(() => parseGatewayConfig({ uiPassword: '' }, STATE, DSH), GatewayConfigError)
})

test('an empty token is rejected (not a credential)', () => {
  assert.throws(() => parseGatewayConfig({ apiToken: '' }, STATE, DSH), GatewayConfigError)
})

test('weak browser and bearer credentials are rejected before exposure', () => {
  assert.throws(() => parseGatewayConfig({ uiPassword: 'short' }, STATE, DSH), /12-1024/)
  assert.throws(() => parseGatewayConfig({ apiToken: 'predictable' }, STATE, DSH), /32-4096/)
})
