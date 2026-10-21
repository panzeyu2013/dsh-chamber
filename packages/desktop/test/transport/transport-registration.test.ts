import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyTransportRegistration, authHeadersFingerprint, registrationKey, sanitizedRegistrationHeaders, transportRegistrationAction } from '../../transport-registration.ts'

test('same registration key is health-only; every real target change is a register edge', () => {
  const base = registrationKey('http://127.0.0.1:22001', 'ssh', undefined, undefined, undefined)
  assert.equal(transportRegistrationAction(base, base), 'health-only')
  assert.equal(transportRegistrationAction(undefined, base), 'register')
  assert.equal(transportRegistrationAction(base, registrationKey('http://127.0.0.1:22002', 'ssh', undefined, undefined, undefined)), 'register')
  assert.equal(transportRegistrationAction(base, registrationKey('https://dsh.example.com', 'http', undefined, undefined, undefined)), 'register')
  assert.equal(transportRegistrationAction(base, registrationKey('http://127.0.0.1:22001', 'ssh', undefined, 'spki', undefined)), 'register')
  assert.equal(transportRegistrationAction(base, registrationKey('http://127.0.0.1:22001', 'ssh', undefined, undefined, 'tunnel.example:8443')), 'register')
})

test('a health-only edge runs only the health effect; a key change runs register', () => {
  const effects = { setHealth: 0, register: 0 }
  const sink = {
    setHealth: () => { effects.setHealth += 1 },
    register: () => { effects.register += 1 },
  }
  assert.equal(applyTransportRegistration('same', 'same', sink), 'health-only')
  assert.deepEqual(effects, { setHealth: 1, register: 0 })
  assert.equal(applyTransportRegistration('old', 'new', sink), 'register')
  assert.deepEqual(effects, { setHealth: 1, register: 1 })
})

test('registration key includes the auth header fingerprint, order-insensitively', () => {
  const headers = { authorization: 'Bearer a', cookie: 'sid=1' }
  const reversed = { cookie: 'sid=1', authorization: 'Bearer a' }
  assert.equal(authHeadersFingerprint(headers), authHeadersFingerprint(reversed))
  const key = registrationKey('https://gw.example.com', 'http', headers, undefined, undefined)
  assert.equal(transportRegistrationAction(key, registrationKey('https://gw.example.com', 'http', reversed, undefined, undefined)), 'health-only')
  assert.equal(transportRegistrationAction(key, registrationKey('https://gw.example.com', 'http', { ...headers, cookie: 'sid=2' }, undefined, undefined)), 'register')
  assert.equal(sanitizedRegistrationHeaders({}), undefined)
  assert.deepEqual(sanitizedRegistrationHeaders(headers), headers)
})
