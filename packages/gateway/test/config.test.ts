/**
 * Gateway config unit tests (design 16 §3.1): the S1 exposure guard, host
 * validation, tls pairing, and the auth-kind resolution. Pure functions — no
 * I/O, deterministic. (Written structure-correct; run with `node --test`.)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GatewayConfigError, parseGatewayConfig } from '../src/config.ts'

const STATE = '/tmp/dsh-gateway-state'
const DSH = '/tmp/dsh-workspace'

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

test('0.0.0.0 + api-token resolves kind token', () => {
  const config = parseGatewayConfig({ host: '0.0.0.0', apiToken: 'secret' }, STATE, DSH)
  assert.equal(config.auth.kind, 'token')
  assert.equal(config.auth.token, 'secret')
})

test('0.0.0.0 + ui-password resolves kind password', () => {
  const config = parseGatewayConfig({ host: '0.0.0.0', uiPassword: 'pwd' }, STATE, DSH)
  assert.equal(config.auth.kind, 'password')
  assert.equal(config.auth.password, 'pwd')
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
