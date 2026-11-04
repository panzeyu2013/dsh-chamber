/**
 * Launcher-model unit tests: the plan for one submit (report v4 §1 table),
 * row projection/ordering, poll deltas, the forward limits, and the exhaustive
 * refusal/failure → locale-key maps.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBrowserAddress } from '../../src/shared/address.ts'
import { parseBrowserSource } from '../../src/shared/source.ts'
import type { BrowserSource } from '../../src/shared/source.ts'
import { PER_SOURCE_FORWARD_LIMIT, type ForwardRecord } from '../../src/shared/forward-bridge.ts'
import {
  addressErrorKey,
  buildRemoteRows,
  diffForwardRecords,
  forwardErrorKey,
  mergeForwardRecord,
  planAddressSubmit,
  sourceForwardLimitReached,
} from '../../src/shared/launcher-model.ts'
import { en, zh, type BrowserKey } from '../../src/locales.ts'

const DSH: BrowserSource = parseBrowserSource('dsh-alpha', 'ssh')!
const GATEWAY: BrowserSource = parseBrowserSource('gateway-alpha', 'ssh')!
const APP = 'http://127.0.0.1:30800'

function plan(input: string, source: BrowserSource = DSH) {
  return planAddressSubmit(parseBrowserAddress(input, { applicationOrigin: APP }), source)
}

function record(overrides: Partial<ForwardRecord> = {}): ForwardRecord {
  return {
    id: 'fwd-1',
    remotePort: 5173,
    localPort: 41000,
    scheme: 'http',
    aliasHost: '127.0.0.2',
    state: 'bound',
    stale: false,
    ...overrides,
  }
}

test('an empty input rejects with the empty reason', () => {
  assert.deepEqual(planAddressSubmit(null, DSH), { kind: 'reject', reason: 'empty' })
})

test('a refused address maps to its reason', () => {
  assert.deepEqual(plan('mailto:a@b.c'), { kind: 'reject', reason: 'protocol' })
  assert.deepEqual(plan('http://127.0.0.1:30800'), { kind: 'reject', reason: 'application-origin' })
  assert.deepEqual(plan('http://[::1]:5173'), { kind: 'reject', reason: 'ipv6-loopback' })
})

test('a public URL goes to the system-browser link leg', () => {
  assert.deepEqual(plan('example.com/a?b=1'), {
    kind: 'system-browser',
    url: 'http://example.com/a?b=1',
    reachability: 'public',
  })
  assert.deepEqual(plan('10.0.0.5:3000'), {
    kind: 'system-browser',
    url: 'http://10.0.0.5:3000/',
    reachability: 'private-network',
  })
})

test('a remote loopback target asks for a forward', () => {
  assert.deepEqual(plan('127.0.0.1:5173/app?x=1'), {
    kind: 'forward',
    port: 5173,
    scheme: 'http',
    path: '/app',
    requestPath: '/app?x=1',
    certificateWarning: false,
  })
})

test('remote https passes the scheme through and flags the certificate', () => {
  assert.deepEqual(plan('https://localhost:8443'), {
    kind: 'forward',
    port: 8443,
    scheme: 'https',
    path: '/',
    requestPath: '/',
    certificateWarning: true,
  })
})

test('an ineligible source refuses the remote branch instead of opening another machine', () => {
  assert.deepEqual(plan('127.0.0.1:5173', GATEWAY), { kind: 'reject', reason: 'source-ineligible' })
})

test('rows are ordered by remote port then id, with resolved state/action copy', () => {
  const rows = buildRemoteRows([
    record({ id: 'b', remotePort: 8080 }),
    record({ id: 'a', remotePort: 5173 }),
    record({ id: 'c', remotePort: 5173, state: 'error', stale: false }),
    record({ id: 'd', remotePort: 3000, stale: true }),
    record({ id: 'e', remotePort: 9000, state: 'binding' }),
  ])
  assert.deepEqual(rows.map((row) => row.id), ['d', 'a', 'c', 'b', 'e'])
  assert.deepEqual(rows.map((row) => row.stateKey), [
    'remote.stale', 'remote.bound', 'remote.failed', 'remote.bound', 'remote.binding',
  ])
  assert.deepEqual(rows.map((row) => row.openable), [false, true, false, true, false])
  assert.deepEqual(rows.map((row) => row.reissuable), [true, false, true, false, false])
  assert.deepEqual(rows.map((row) => row.closable), [true, true, true, true, true], 'binding rows are releasable too')
  assert.equal(rows[0].actionKey, 'remote.reopen')
  assert.equal(rows[1].actionKey, 'remote.open')
  assert.equal(rows[0].displayUrl, 'http://127.0.0.2:41000')
})

test('poll deltas report added / removed / changed by record id', () => {
  const first = record({ id: 'one' })
  const gone = record({ id: 'two', remotePort: 8080 })
  const delta = diffForwardRecords(
    [first, gone],
    [record({ id: 'one', state: 'error' }), record({ id: 'three', remotePort: 3000 })],
  )
  assert.deepEqual(delta.added.map((entry) => entry.id), ['three'])
  assert.deepEqual(delta.removed.map((entry) => entry.id), ['two'])
  assert.deepEqual(delta.changed.map((entry) => entry.id), ['one'])
})

test('an unchanged poll produces an empty delta', () => {
  assert.deepEqual(diffForwardRecords([record()], [record()]), { added: [], removed: [], changed: [] })
})

test('merge replaces by id and appends otherwise', () => {
  const merged = mergeForwardRecord([record()], record({ state: 'binding' }))
  assert.equal(merged.length, 1)
  assert.equal(merged[0].state, 'binding')
  assert.equal(mergeForwardRecord([record()], record({ id: 'fwd-2' })).length, 2)
})

test('the per-source forward cap is 8 and counts every record', () => {
  const many = Array.from({ length: PER_SOURCE_FORWARD_LIMIT }, (_, index) => record({ id: `fwd-${index}` }))
  assert.equal(sourceForwardLimitReached(many.slice(0, PER_SOURCE_FORWARD_LIMIT - 1)), false)
  assert.equal(sourceForwardLimitReached(many), true)
})

test('every address refusal reason has a locale key that exists in zh and en', () => {
  const reasons = [
    'empty', 'too-long', 'invalid', 'protocol', 'credentials', 'application-origin',
    'ipv6-loopback', 'unspecified-host', 'alias-host', 'loopback-other', 'port', 'source-ineligible',
  ] as const
  for (const reason of reasons) {
    const key: BrowserKey = addressErrorKey(reason)
    assert.equal(typeof zh[key], 'string', reason)
    assert.notEqual(en[key], '', reason)
  }
})

test('every forward failure code has a locale key that exists in zh and en', () => {
  const codes = [
    'forbidden-source', 'invalid-port', 'limit', 'stale', 'not-found',
    'spawn-failed', 'bind-failed', 'confirm-declined', 'unavailable', 'unknown',
  ] as const
  for (const code of codes) {
    const key: BrowserKey = forwardErrorKey(code)
    assert.equal(typeof zh[key], 'string', code)
    assert.notEqual(en[key], '', code)
  }
})

test('the English dictionary covers exactly the Chinese key set', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort())
  for (const key of Object.keys(zh) as BrowserKey[]) {
    assert.notEqual(zh[key].trim(), '', key)
    assert.notEqual(en[key].trim(), '', key)
  }
})

test('the guide and title copy is present in both languages', () => {
  for (const key of ['title', 'guide.title', 'guide.description'] as const) {
    assert.notEqual(zh[key].trim(), '')
    assert.notEqual(en[key].trim(), '')
  }
})
