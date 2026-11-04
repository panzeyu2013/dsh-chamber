/**
 * Source-gate unit tests: only a dsh-kind SSH source may register the Browser
 * tab. local / gateway / http and malformed ids must return null so apply()
 * leaves no trace (report v4 decision 2, review round-2 B1/I5).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isBrowserEligible,
  parseBrowserSource,
  parseBrowserSourceFingerprint,
  resolveBrowserEntry,
} from '../../src/shared/source.ts'

const FINGERPRINT = 'a'.repeat(64)

test('dsh over ssh is the eligible source', () => {
  const source = resolveBrowserEntry('dsh-alpha', 'ssh')
  assert.notEqual(source, null)
  assert.deepEqual(source, {
    sourceId: 'dsh-alpha',
    instanceId: 'alpha',
    kind: 'dsh',
  })
  assert.equal(isBrowserEligible(source!), true)
})

test('the legacy ssh- spelling is refused (main proveSource uses the kind-prefixed id)', () => {
  assert.equal(resolveBrowserEntry('ssh-alpha', 'ssh'), null)
})

test('local, gateway and http sources never qualify', () => {
  const cases: Array<[unknown, unknown]> = [
    ['local', 'local'],
    ['local', 'ssh'],
    ['gateway-alpha', 'ssh'],
    ['gateway-alpha', 'http'],
    ['dsh-alpha', 'http'],
    ['dsh-alpha', 'local'],
    [undefined, 'ssh'],
    ['dsh-alpha', undefined],
  ]
  for (const [value, transport] of cases) {
    assert.equal(resolveBrowserEntry(value, transport), null, JSON.stringify([value, transport]))
  }
})

test('malformed instance ids are refused (no privileged local masquerade)', () => {
  for (const value of ['dsh-', 'dsh-a/b', 'dsh-a b', 'dsh-' + 'x'.repeat(65), 'dsh-local', 'ssh-alpha', 'unknown-alpha', 'alpha']) {
    assert.equal(parseBrowserSource(value, 'ssh'), null, value)
  }
})

test('a gateway source parses but is not eligible', () => {
  const source = parseBrowserSource('gateway-alpha', 'ssh')
  assert.notEqual(source, null)
  assert.equal(source!.kind, 'gateway')
  assert.equal(isBrowserEligible(source!), false)
})

test('the fingerprint must be the 64-hex boot proof', () => {
  const source = parseBrowserSource('dsh-alpha', 'ssh')!
  assert.equal(parseBrowserSourceFingerprint(source, FINGERPRINT), FINGERPRINT)
  for (const value of ['', 'local', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 42, undefined]) {
    assert.equal(parseBrowserSourceFingerprint(source, value), null, String(value))
  }
})

test('a gateway source has no eligible fingerprint', () => {
  const gateway = parseBrowserSource('gateway-alpha', 'ssh')!
  assert.equal(parseBrowserSourceFingerprint(gateway, FINGERPRINT), null)
})
