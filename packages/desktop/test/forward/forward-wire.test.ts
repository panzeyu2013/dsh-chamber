/**
 * Wire-contract tests for remote-browser forwards (W0/S1).
 *
 * Two jobs:
 *   1. the guards are the IPC boundary: every hostile shape the renderer or a
 *      single-realm plugin can send must be rejected (extra keys, 127.0.0.1
 *      aliases, impossible ports, error/state mismatch, timestamp lies);
 *   2. the wire tables are the SINGLE vocabulary: the desktop manager's local
 *      mirror must agree with them exactly until the desktop takes the type-only
 *      dependency (TODO W0), and the alias table must agree with the namespace
 *      allocator. A drift here would either ship an enum the renderer drops or
 *      an alias range the manager never allocates.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FORWARD_ALIAS_OCTETS,
  FORWARD_CONSUMER_PATTERN as WIRE_CONSUMER_PATTERN,
  FORWARD_ERROR_CODES as WIRE_ERROR_CODES,
  FORWARD_FRAME_ERRORS as WIRE_FRAME_ERRORS,
  FORWARD_LIMITS,
  FORWARD_SCHEMES as WIRE_SCHEMES,
  FORWARD_STATES as WIRE_STATES,
  FORWARD_WIRE_VERSION as WIRE_VERSION,
  forwardAliasHost,
  forwardLocalOrigin,
  isForwardAliasHost as isWireAliasHost,
  isForwardChangedEvent,
  isForwardConsumer,
  isForwardEmbeddingSnapshot,
  isForwardError,
  isForwardFrameError,
  isForwardFrameUrl,
  isForwardListArgs,
  isForwardListResult,
  isForwardOpenArgs,
  isForwardOpenResult,
  isForwardRecord,
  isForwardReleaseArgs,
  isForwardRequestArgs,
  isForwardRequestResult,
  isForwardTarget,
} from '../../../dsh-chamber-wire/src/forward.ts'
import {
  FORWARD_CONSUMER_PATTERN as MANAGER_CONSUMER_PATTERN,
  FORWARD_ERROR_CODES as MANAGER_ERROR_CODES,
  FORWARD_FRAME_ERRORS as MANAGER_FRAME_ERRORS,
  FORWARD_MAX_GLOBAL,
  FORWARD_MAX_LOCAL_PORT,
  FORWARD_MAX_PER_SOURCE,
  FORWARD_MAX_TARGET_PORT,
  FORWARD_MIN_LOCAL_PORT,
  FORWARD_MIN_TARGET_PORT,
  FORWARD_SCHEMES as MANAGER_SCHEMES,
  FORWARD_STATES as MANAGER_STATES,
  FORWARD_WIRE_VERSION as MANAGER_WIRE_VERSION,
} from '../../remote-forward-manager.ts'
import {
  FORWARD_ALIAS_CAPACITY,
  FORWARD_ALIAS_MAX_OCTET,
  FORWARD_ALIAS_MIN_OCTET,
  isForwardAliasHost as isNamespaceAliasHost,
} from '../../remote-forward-namespace.ts'

/** A minimal valid record (the happy path all negative cases mutate). */
function validRecord(): Record<string, unknown> {
  return {
    id: 'fwd-0123456789abcdef',
    sourceId: 'dsh-web-1',
    namespace: 4919,
    aliasHost: '127.0.0.7',
    localPort: 5173,
    scheme: 'http',
    targetHost: '127.0.0.1',
    targetPort: 5173,
    state: 'bound',
    stale: false,
    error: null,
    createdAt: 1_000,
    updatedAt: 1_002,
    boundAt: 1_001,
  }
}

test('the error-code and state tables are exactly the manager mirror', () => {
  assert.deepEqual([...WIRE_STATES], [...MANAGER_STATES])
  assert.deepEqual([...WIRE_ERROR_CODES], [...MANAGER_ERROR_CODES])
  assert.equal(new Set(WIRE_STATES).size, WIRE_STATES.length)
  assert.equal(new Set(WIRE_ERROR_CODES).size, WIRE_ERROR_CODES.length)
})

test('v2 mirror: wire version, schemes, frame errors and consumer grammar agree', () => {
  assert.equal(WIRE_VERSION, 2)
  assert.equal(MANAGER_WIRE_VERSION, WIRE_VERSION)
  assert.deepEqual([...WIRE_SCHEMES], [...MANAGER_SCHEMES])
  assert.deepEqual([...WIRE_FRAME_ERRORS], [...MANAGER_FRAME_ERRORS])
  assert.equal(WIRE_CONSUMER_PATTERN.source, MANAGER_CONSUMER_PATTERN.source)
  assert.equal(WIRE_CONSUMER_PATTERN.flags, MANAGER_CONSUMER_PATTERN.flags)
  for (const consumer of ['abcdefgh', 'crypto-randomUUID-123456', 'A_b-9'.repeat(8)]) {
    assert.equal(isForwardConsumer(consumer), true, consumer)
  }
  for (const consumer of ['short', 'has space here', 'x'.repeat(65), '', 42, null]) {
    assert.equal(isForwardConsumer(consumer), false, String(consumer))
  }
})

test('v2 guards: consumer/path arguments, frameUrl, frameError', () => {
  const args = { sourceId: 'dsh-a', sourceFingerprint: 'abcdefgh', port: 5173 }
  assert.equal(isForwardRequestArgs({ ...args, consumer: 'abcdefgh' }), true)
  assert.equal(isForwardRequestArgs({ ...args, consumer: 'nope' }), false)
  assert.equal(isForwardRequestArgs({ ...args, path: '/app?x=1' }), true)
  assert.equal(isForwardRequestArgs({ ...args, path: 'http://evil.example' }), false)
  assert.equal(isForwardRequestArgs({ ...args, path: '//evil.example' }), false)
  assert.equal(isForwardRequestArgs({ ...args, path: '/a#frag' }), false)
  assert.equal(isForwardReleaseArgs({ sourceId: 'dsh-a', sourceFingerprint: 'abcdefgh', id: 'fwd-0123456789abcdef', consumer: 'abcdefgh' }), true)
  assert.equal(isForwardReleaseArgs({ sourceId: 'dsh-a', sourceFingerprint: 'abcdefgh', id: 'fwd-0123456789abcdef', consumer: 'x' }), false)

  // frameError is optional/nullable; a foreign string is refused.
  assert.equal(isForwardRecord({ ...validRecord(), frameError: 'blocked_by_response' }), true)
  assert.equal(isForwardRecord({ ...validRecord(), frameError: null }), true)
  assert.equal(isForwardRecord({ ...validRecord(), frameError: 'nope' }), false)
  assert.equal(isForwardFrameError('certificate_error'), true)
  assert.equal(isForwardFrameError('weird'), false)

  // frameUrl is main-composed: absolute http(s), no credentials/control bytes.
  assert.equal(isForwardFrameUrl('http://127.0.0.2:5173/app?x=1'), true)
  assert.equal(isForwardFrameUrl('https://127.0.0.2:443/'), true)
  assert.equal(isForwardFrameUrl('http://user:pw@127.0.0.2:1/'), false)
  assert.equal(isForwardFrameUrl('/relative'), false)
  assert.equal(isForwardFrameUrl('http://127.0.0.2:5173/a#frag'), false)
  assert.equal(isForwardRequestResult({ ok: true, record: validRecord(), frameUrl: 'http://127.0.0.2:5173/' }), true)
  assert.equal(isForwardRequestResult({ ok: true, record: validRecord(), frameUrl: 'javascript:alert(1)' }), false)

  // embedding/frameErrors are RETIRED list fields (design 28 v3 §3): the guard
  // must ignore unknown extra keys on the result and keep accepting records.
  // (The former v2 assertions for both were removed in the same change.)
  const limits = { perSource: 8, global: 32, perSourceUsed: 1, globalUsed: 1 }
  assert.equal(isForwardListResult({ ok: true, records: [], limits }), true)
  // Retired paper fields are ignored (no longer part of the shape): extra keys pass.
  assert.equal(isForwardListResult({ ok: true, records: [], limits, embedding: { enabled: true } }), true)
  assert.equal(isForwardListResult({ ok: true, records: [], limits, frameErrors: 'nope' }), true)
})

test('v2 local list identity: only list accepts {local,local}; request/release still refuse it', () => {
  assert.equal(isForwardListArgs({ sourceId: 'local', sourceFingerprint: 'local' }), true)
  assert.equal(isForwardListArgs({ sourceId: 'local', sourceFingerprint: 'a'.repeat(64) }), false)
  assert.equal(isForwardListArgs({ sourceId: 'dsh-web-1', sourceFingerprint: 'local' }), false)
  assert.equal(isForwardListArgs({ sourceId: 'local', sourceFingerprint: 'local', port: 5173 }), true)
  assert.equal(isForwardListArgs(null), false)
  assert.equal(isForwardListArgs({ sourceId: 'dsh-a', sourceFingerprint: 'abcdefgh' }), true)
  // The local identity is a LIST-only arm; the forward actions keep the remote grammar.
  assert.equal(isForwardRequestArgs({ sourceId: 'local', sourceFingerprint: 'local', port: 5173 }), false)
  assert.equal(isForwardReleaseArgs({ sourceId: 'local', sourceFingerprint: 'local', id: 'fwd-0123456789abcdef' }), false)
  assert.equal(isForwardOpenArgs({ sourceId: 'local', sourceFingerprint: 'local', id: 'fwd-0123456789abcdef' }), false)
})

test('limits/alias tables agree with the manager and namespace leaf constants', () => {
  assert.equal(FORWARD_LIMITS.maxPerSource, FORWARD_MAX_PER_SOURCE)
  assert.equal(FORWARD_LIMITS.maxGlobal, FORWARD_MAX_GLOBAL)
  assert.equal(FORWARD_LIMITS.minLocalPort, FORWARD_MIN_LOCAL_PORT)
  assert.equal(FORWARD_LIMITS.maxLocalPort, FORWARD_MAX_LOCAL_PORT)
  assert.equal(FORWARD_LIMITS.minTargetPort, FORWARD_MIN_TARGET_PORT)
  assert.equal(FORWARD_LIMITS.maxTargetPort, FORWARD_MAX_TARGET_PORT)
  assert.equal(FORWARD_ALIAS_OCTETS.min, FORWARD_ALIAS_MIN_OCTET)
  assert.equal(FORWARD_ALIAS_OCTETS.max, FORWARD_ALIAS_MAX_OCTET)
  assert.equal(FORWARD_ALIAS_OCTETS.capacity, FORWARD_ALIAS_CAPACITY)
  assert.equal(FORWARD_ALIAS_CAPACITY, 253)
})

test('the wire alias predicate and the allocator predicate agree on the full 0..255 grid', () => {
  for (let octet = 0; octet <= 255; octet += 1) {
    const host = '127.0.0.' + String(octet)
    const expected = octet >= 2 && octet <= 254
    assert.equal(isWireAliasHost(host), expected, host)
    assert.equal(isNamespaceAliasHost(host), expected, host)
  }
  for (const hostile of ['127.0.0.01', '127.0.0.001', '127.0.1.1', '10.0.0.1', 'localhost', '127.0.0.256', '']) {
    assert.equal(isWireAliasHost(hostile), false, hostile)
    assert.equal(isNamespaceAliasHost(hostile), false, hostile)
  }
  assert.equal(forwardAliasHost(2), '127.0.0.2')
  assert.equal(forwardAliasHost(254), '127.0.0.254')
  for (const bad of [0, 1, 255, 1.5, Number.NaN]) {
    assert.throws(() => forwardAliasHost(bad), RangeError)
  }
})

test('forwardLocalOrigin composes the display origin only (never a path)', () => {
  assert.equal(forwardLocalOrigin({ scheme: 'http', aliasHost: '127.0.0.9', localPort: 5173 }), 'http://127.0.0.9:5173')
  assert.equal(forwardLocalOrigin({ scheme: 'https', aliasHost: '127.0.0.9', localPort: 8443 }), 'https://127.0.0.9:8443')
})

test('isForwardRecord accepts a fully valid record', () => {
  assert.equal(isForwardRecord(validRecord()), true)
  assert.equal(isForwardRecord({ ...validRecord(), state: 'error', error: { code: 'auth_failed', detail: null } }), true)
})

test('isForwardRecord rejects every hostile or inconsistent shape', () => {
  const cases: unknown[] = [
    { ...validRecord(), extra: true },
    { ...validRecord(), aliasHost: '127.0.0.1' },
    { ...validRecord(), aliasHost: '127.0.0.0' },
    { ...validRecord(), aliasHost: '127.0.0.255' },
    { ...validRecord(), localPort: 1023 },
    { ...validRecord(), localPort: 65536 },
    { ...validRecord(), localPort: 5173.5 },
    { ...validRecord(), targetPort: 0 },
    { ...validRecord(), targetPort: 65536 },
    { ...validRecord(), targetHost: '10.0.0.1' },
    { ...validRecord(), scheme: 'ftp' },
    { ...validRecord(), state: 'ready' },
    { ...validRecord(), namespace: 65536 },
    { ...validRecord(), namespace: -1 },
    { ...validRecord(), id: 'fwd-XYZ' },
    { ...validRecord(), sourceId: 'local' },
    { ...validRecord(), sourceId: 'gateway-bad/id' },
    { ...validRecord(), stale: 'no' },
    { ...validRecord(), createdAt: -1 },
    { ...validRecord(), updatedAt: 999 },
    { ...validRecord(), boundAt: 900 },
    { ...validRecord(), boundAt: 5000 },
    { ...validRecord(), error: { code: 'nope', detail: null } },
    { ...validRecord(), state: 'error' },
    { ...validRecord(), state: 'bound', error: { code: 'open_failed', detail: null } },
    { ...validRecord(), error: { code: 'open_failed', detail: 42 } },
    null,
    [],
    'record',
  ]
  cases.forEach((value, index) => assert.equal(isForwardRecord(value), false, 'case ' + String(index)))
})

test('isForwardTarget pins the remote loopback and the scheme', () => {
  assert.equal(isForwardTarget({ host: '127.0.0.1', port: 5173, scheme: 'http' }), true)
  assert.equal(isForwardTarget({ host: '127.0.0.2', port: 5173, scheme: 'http' }), false)
  assert.equal(isForwardTarget({ host: '127.0.0.1', port: 5173, scheme: 'https', x: 1 }), false)
  assert.equal(isForwardTarget({ host: '127.0.0.1', port: 0, scheme: 'http' }), false)
})

test('argument guards enforce source/id/port/path shapes', () => {
  assert.equal(isForwardRequestArgs({ sourceId: 'dsh-a', sourceFingerprint: 'abcdefgh', port: 5173 }), true)
  assert.equal(isForwardRequestArgs({ sourceId: 'dsh-a', sourceFingerprint: 'abcdefgh', port: 5173, scheme: 'https' }), true)
  assert.equal(isForwardRequestArgs({ sourceId: 'dsh-a', sourceFingerprint: 'abcdefgh', port: 5173, scheme: 'ftp' }), false)
  assert.equal(isForwardRequestArgs({ sourceId: 'local', sourceFingerprint: 'abcdefgh', port: 5173 }), false)
  assert.equal(isForwardRequestArgs({ sourceId: 'dsh-a', sourceFingerprint: 'bad fp', port: 5173 }), false)
  assert.equal(isForwardRequestArgs({ sourceId: 'dsh-a', sourceFingerprint: 'abcdefgh', port: 1024.5 }), false)
  assert.equal(isForwardReleaseArgs({ sourceId: 'dsh-a', sourceFingerprint: 'abcdefgh', id: 'fwd-0123456789abcdef' }), true)
  assert.equal(isForwardReleaseArgs({ sourceId: 'dsh-a', sourceFingerprint: 'abcdefgh', id: 'x' }), false)
  assert.equal(isForwardOpenArgs({ sourceId: 'dsh-a', sourceFingerprint: 'abcdefgh', id: 'fwd-0123456789abcdef', path: '/app?x=1' }), true)
  assert.equal(isForwardOpenArgs({ sourceId: 'dsh-a', sourceFingerprint: 'abcdefgh', id: 'fwd-0123456789abcdef', path: 42 }), false)
  assert.equal(isForwardOpenArgs({ sourceId: 'dsh-a', sourceFingerprint: 'abcdefgh', id: 'fwd-0123456789abcdef', path: 'x'.repeat(2049) }), false)
})

test('result guards are exact unions (never "ok with garbage")', () => {
  assert.equal(isForwardRequestResult({ ok: true, record: validRecord() }), true)
  assert.equal(isForwardRequestResult({ ok: false, error: { code: 'auth_failed', detail: null } }), true)
  assert.equal(isForwardRequestResult({ ok: true, record: { ...validRecord(), aliasHost: '127.0.0.1' } }), false)
  assert.equal(isForwardRequestResult({ ok: true }), false)
  assert.equal(isForwardOpenResult({ ok: true }), true)
  assert.equal(isForwardOpenResult({ ok: true, error: { code: 'open_failed', detail: null } }), true)
  assert.equal(isForwardOpenResult({ ok: false }), false)
  assert.equal(isForwardError({ code: 'open_failed', detail: null }), true)
  assert.equal(isForwardError({ code: 'open_failed' }), false)
})

test('list result guard enforces the cap snapshot causality', () => {
  const limits = { perSource: 8, global: 32, perSourceUsed: 1, globalUsed: 1 }
  assert.equal(isForwardListResult({ ok: true, records: [validRecord()], limits }), true)
  assert.equal(isForwardListResult({ ok: true, records: [], limits }), true)
  // v2 paper list fields (embedding/frameErrors) are RETIRED (design 28 v3 §3):
  // the guard no longer validates them — unknown extra keys are simply ignored.
  assert.equal(isForwardListResult({ ok: true, records: [], limits, frameErrors: [{ bad: true }] }), true)
  assert.equal(isForwardListResult({ ok: true, records: [], limits: { ...limits, perSourceUsed: 9 } }), false)
  assert.equal(isForwardListResult({ ok: true, records: [validRecord()], limits: { ...limits, globalUsed: 33 } }), false)
  assert.equal(isForwardListResult({ ok: false, error: { code: 'source_unknown', detail: null } }), true)
  assert.equal(isForwardListResult({ ok: true, records: [{ bad: true }], limits }), false)
})

test('the reserved change event is a complete snapshot shape', () => {
  assert.equal(isForwardChangedEvent({ sourceId: 'dsh-a', revision: 3, records: [validRecord()] }), true)
  assert.equal(isForwardChangedEvent({ sourceId: 'dsh-a', revision: -1, records: [] }), false)
  assert.equal(isForwardChangedEvent({ sourceId: 'dsh-a', revision: 3, records: [], extra: 1 }), false)
})
