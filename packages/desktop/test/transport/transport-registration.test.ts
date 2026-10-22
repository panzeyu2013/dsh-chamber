import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyTransportRegistration, authHeadersFingerprint, registrationKey, sanitizedRegistrationHeaders, transportRegistrationAction } from '../../transport-registration.ts'

const TARGET = { url: 'http://127.0.0.1:22001', transport: 'ssh' }

test('same registration key is health-only; every real target change is a register edge', () => {
  const base = registrationKey(TARGET)
  assert.equal(transportRegistrationAction(base, base), 'health-only')
  assert.equal(transportRegistrationAction(undefined, base), 'register')
  assert.equal(transportRegistrationAction(base, registrationKey({ ...TARGET, url: 'http://127.0.0.1:22002' })), 'register')
  assert.equal(transportRegistrationAction(base, registrationKey({ url: 'https://dsh.example.com', transport: 'http' })), 'register')
  assert.equal(transportRegistrationAction(base, registrationKey({ ...TARGET, spkiPin: 'spki' })), 'register')
  assert.equal(transportRegistrationAction(base, registrationKey({ ...TARGET, authority: 'tunnel.example:8443' })), 'register')
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

test('a delimiter inside a header value cannot collide with a different header set', () => {
  // The old ':'/'|' join made these two sets hash identically, which would keep a
  // CHANGED credential registered under a health-only update.
  const oneValue = { authorization: 'Bearer x|b:y' }
  const twoValues = { authorization: 'Bearer x', b: 'y' }
  assert.notEqual(authHeadersFingerprint(oneValue), authHeadersFingerprint(twoValues))
  assert.notEqual(
    registrationKey({ url: 'https://gw.example.com', transport: 'http', headers: oneValue }),
    registrationKey({ url: 'https://gw.example.com', transport: 'http', headers: twoValues }),
  )
  // The same collision must not exist in the key fields either.
  assert.notEqual(
    registrationKey({ url: 'https://a|b', transport: 'http' }),
    registrationKey({ url: 'https://a', transport: 'http', authority: 'b' }),
  )
})

test('registration key includes the auth header fingerprint, order-insensitively', () => {
  const headers = { authorization: 'Bearer a', cookie: 'sid=1' }
  const reversed = { cookie: 'sid=1', authorization: 'Bearer a' }
  assert.equal(authHeadersFingerprint(headers), authHeadersFingerprint(reversed))
  const key = registrationKey({ url: 'https://gw.example.com', transport: 'http', headers })
  assert.equal(transportRegistrationAction(key, registrationKey({ url: 'https://gw.example.com', transport: 'http', headers: reversed })), 'health-only')
  assert.equal(transportRegistrationAction(key, registrationKey({ url: 'https://gw.example.com', transport: 'http', headers: { ...headers, cookie: 'sid=2' } })), 'register')
  assert.equal(sanitizedRegistrationHeaders({}), undefined)
  assert.deepEqual(sanitizedRegistrationHeaders(headers), headers)
})

test('the object signature removes POSITIONAL drift; field identity is still asserted by the key', () => {
  // Five positional strings allowed an accidental pin/authority swap at any call site
  // (type-compatible, silently a different key). The object signature makes the
  // position unambiguous; because every field is still a string, a deliberate field
  // swap remains legal TypeScript — so the key encoding is what proves the fields
  // stay independent. Pin and authority must each move the key on their own.
  const withPin = registrationKey({ url: 'https://gw.example.com', transport: 'ssh', spkiPin: 'PIN' })
  const withAuthority = registrationKey({ url: 'https://gw.example.com', transport: 'ssh', authority: 'PIN' })
  assert.notEqual(withPin, withAuthority)
  // Field identity is positional-free: the same fact in a different order is the
  // same key, and a missing/empty transport is the same absence.
  assert.equal(registrationKey({ url: 'https://gw.example.com' }), registrationKey({ url: 'https://gw.example.com', transport: '' }))
})
