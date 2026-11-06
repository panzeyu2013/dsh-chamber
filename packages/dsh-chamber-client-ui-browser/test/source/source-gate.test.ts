/**
 * Source-gate unit tests: every source except a plain-HTTP one registers the
 * Browser tab — the local instance, dsh over ssh and gateway over ssh. The
 * forward leg exists only where an SSH tunnel does (`mayForward`), and the
 * fingerprint rule follows the boot fact (the literal `local` for the local
 * instance, 64-hex for a remote source).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBrowserSource,
  parseBrowserSourceFingerprint,
  resolveBrowserEntry,
  sourceMayForward,
} from '../../src/shared/source.ts'

const FINGERPRINT = 'a'.repeat(64)

test('the local instance registers the tab without a forward leg', () => {
  const source = resolveBrowserEntry('local', 'local')
  assert.deepEqual(source, {
    sourceId: 'local',
    instanceId: 'local',
    kind: 'local',
    transport: 'local',
    mayForward: false,
  })
  assert.equal(sourceMayForward(source!), false)
})

test('dsh and gateway over ssh both register, with the forward leg', () => {
  const dsh = resolveBrowserEntry('dsh-alpha', 'ssh')
  assert.deepEqual(dsh, {
    sourceId: 'dsh-alpha',
    instanceId: 'alpha',
    kind: 'dsh',
    transport: 'ssh',
    mayForward: true,
  })
  assert.equal(sourceMayForward(dsh!), true)

  const gateway = resolveBrowserEntry('gateway-alpha', 'ssh')
  assert.deepEqual(gateway, {
    sourceId: 'gateway-alpha',
    instanceId: 'alpha',
    kind: 'gateway',
    transport: 'ssh',
    mayForward: true,
  })
  assert.equal(sourceMayForward(gateway!), true)
})

test('http sources never qualify', () => {
  const cases: Array<[unknown, unknown]> = [
    ['gateway-alpha', 'http'],
    ['dsh-alpha', 'http'],
    ['local', 'http'],
  ]
  for (const [value, transport] of cases) {
    assert.equal(resolveBrowserEntry(value, transport), null, JSON.stringify([value, transport]))
  }
})

test('a source id and a transport word must agree', () => {
  const cases: Array<[unknown, unknown]> = [
    ['local', 'ssh'],
    ['dsh-alpha', 'local'],
    ['gateway-alpha', 'local'],
    [undefined, 'ssh'],
    ['dsh-alpha', undefined],
    ['dsh-alpha', 'ws'],
  ]
  for (const [value, transport] of cases) {
    assert.equal(resolveBrowserEntry(value, transport), null, JSON.stringify([value, transport]))
  }
})

test('malformed ids and the legacy ssh- spelling are refused', () => {
  for (const value of ['dsh-', 'dsh-a/b', 'dsh-a b', 'dsh-' + 'x'.repeat(65), 'dsh-local', 'ssh-alpha', 'unknown-alpha', 'alpha', 'Local']) {
    assert.equal(parseBrowserSource(value, 'ssh'), null, value)
  }
})

test('the fingerprint rule follows the boot fact', () => {
  const dsh = parseBrowserSource('dsh-alpha', 'ssh')!
  const gateway = parseBrowserSource('gateway-alpha', 'ssh')!
  const local = parseBrowserSource('local', 'local')!
  for (const source of [dsh, gateway]) {
    assert.equal(parseBrowserSourceFingerprint(source, FINGERPRINT), FINGERPRINT)
    for (const value of ['', 'local', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 42, undefined]) {
      assert.equal(parseBrowserSourceFingerprint(source, value), null, String(value))
    }
  }
  assert.equal(parseBrowserSourceFingerprint(local, 'local'), 'local')
  for (const value of ['', FINGERPRINT, 'LOCAL', 42, undefined]) {
    assert.equal(parseBrowserSourceFingerprint(local, value), null, String(value))
  }
})
