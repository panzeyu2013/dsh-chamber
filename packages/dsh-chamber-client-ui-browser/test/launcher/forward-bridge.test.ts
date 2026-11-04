/**
 * Forward-bridge contract tests: the local record/result guards that keep an
 * untrusted IPC projection out of the launcher, and the display-only URL rule
 * (the renderer never receives a URL it can pass back to openInBrowser).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  asBrowserForwardBridge,
  forwardDisplayUrl,
  isBrowserAliasHost,
  parseForwardAck,
  parseForwardListResult,
  parseForwardRecord,
  parseForwardRecords,
  parseForwardRequestResult,
} from '../../src/shared/forward-bridge.ts'

const RECORD = {
  id: 'fwd-1',
  remotePort: 5173,
  localPort: 41000,
  scheme: 'http',
  aliasHost: '127.0.0.2',
  state: 'bound',
  stale: false,
}

test('a well-formed record projects unchanged', () => {
  assert.deepEqual(parseForwardRecord(RECORD), RECORD)
})

test('invalid records are dropped one by one', () => {
  const cases: unknown[] = [
    null,
    {},
    { ...RECORD, id: '' },
    { ...RECORD, remotePort: 0 },
    { ...RECORD, remotePort: 1.5 },
    { ...RECORD, localPort: 80 },
    { ...RECORD, localPort: 65536 },
    { ...RECORD, scheme: 'ftp' },
    { ...RECORD, aliasHost: '127.0.0.1' },
    { ...RECORD, aliasHost: '127.0.0.0' },
    { ...RECORD, aliasHost: '127.0.0.255' },
    { ...RECORD, aliasHost: 'localhost' },
    { ...RECORD, state: 'unknown' },
    { ...RECORD, stale: 'yes' },
    { ...RECORD, error: '' },
  ]
  for (const value of cases) {
    assert.equal(parseForwardRecord(value), null, JSON.stringify(value))
  }
})

test('hostile getters are one malformed record, not a throw', () => {
  const hostile = new Proxy({}, {
    get() { throw new Error('boom') },
  })
  assert.equal(parseForwardRecord(hostile), null)
})

test('the alias range is exactly 127.0.0.2-254', () => {
  assert.equal(isBrowserAliasHost('127.0.0.2'), true)
  assert.equal(isBrowserAliasHost('127.0.0.254'), true)
  assert.equal(isBrowserAliasHost('127.0.0.1'), false)
  assert.equal(isBrowserAliasHost('127.0.0.0'), false)
  assert.equal(isBrowserAliasHost('127.0.0.255'), false)
  assert.equal(isBrowserAliasHost('127.0.1.2'), false)
  assert.equal(isBrowserAliasHost('localhost'), false)
})

test('records are de-duplicated by id and malformed entries dropped', () => {
  const records = parseForwardRecords([RECORD, RECORD, { ...RECORD, id: 'fwd-2', remotePort: 8080 }, null])
  assert.deepEqual(records.map((record) => record.id), ['fwd-1', 'fwd-2'])
})

test('non-array record lists project to an empty list', () => {
  assert.deepEqual(parseForwardRecords(undefined), [])
  assert.deepEqual(parseForwardRecords({ length: 1 }), [])
})

test('list envelopes are validated', () => {
  assert.deepEqual(parseForwardListResult({ ok: true, records: [RECORD] }), { ok: true, records: [RECORD] })
  assert.deepEqual(parseForwardListResult({ ok: true, records: 'nope' }), { ok: false, code: 'unknown' })
  assert.deepEqual(parseForwardListResult({ ok: false, code: 'limit' }), { ok: false, code: 'limit' })
  assert.deepEqual(parseForwardListResult({ ok: false, code: 'not-a-code' }), { ok: false, code: 'unknown' })
  assert.deepEqual(parseForwardListResult(null), { ok: false, code: 'unknown' })
})

test('request envelopes require a valid record', () => {
  assert.deepEqual(parseForwardRequestResult({ ok: true, record: RECORD }), { ok: true, record: RECORD })
  assert.deepEqual(parseForwardRequestResult({ ok: true, record: { ...RECORD, aliasHost: '127.0.0.1' } }), { ok: false, code: 'unknown' })
  assert.deepEqual(parseForwardRequestResult({ ok: false, code: 'bind-failed', message: 'in use' }), {
    ok: false,
    code: 'bind-failed',
    message: 'in use',
  })
})

test('acks only accept a literal true', () => {
  assert.deepEqual(parseForwardAck({ ok: true }), { ok: true })
  assert.deepEqual(parseForwardAck({ ok: 'true' }), { ok: false, code: 'unknown' })
  assert.deepEqual(parseForwardAck({ ok: false, code: 'stale' }), { ok: false, code: 'stale' })
})

test('the bridge probe requires all four methods', () => {
  const full = {
    request: async () => ({ ok: true }),
    release: async () => ({ ok: true }),
    list: async () => ({ ok: true, records: [] }),
    openInBrowser: async () => ({ ok: true }),
  }
  assert.equal(asBrowserForwardBridge(full), full)
  assert.equal(asBrowserForwardBridge({ ...full, list: undefined }), null)
  assert.equal(asBrowserForwardBridge({}), null)
  assert.equal(asBrowserForwardBridge(null), null)
  assert.equal(asBrowserForwardBridge('bridge'), null)
})

test('the display URL is derived, never echoed from the record', () => {
  assert.equal(forwardDisplayUrl(parseForwardRecord({ ...RECORD, scheme: 'https' })!), 'https://127.0.0.2:41000')
})
