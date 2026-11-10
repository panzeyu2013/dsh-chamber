/**
 * Forward-bridge contract tests: the local record/result guards that keep an
 * untrusted IPC projection out of the launcher, and the display-only URL rule
 * (the renderer never receives a URL it can pass back to openInBrowser).
 *
 * v2 additions: the consumer grammar, the main-composed frameUrl guard, the
 * envelope shapes and the release-timeout failure code. The v2 list paper fields
 * (embedding/frameErrors) are retired (design 28 v3 §3).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  asBrowserForwardBridge,
  forwardDisplayUrl,
  isBrowserAliasHost,
  isForwardConsumer,
  isForwardFrameError,
  isForwardFrameUrl,
  parseForwardAck,
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
    { ...RECORD, frameError: 'future_error_code' },
    { ...RECORD, frameError: 7 },
  ]
  for (const value of cases) {
    assert.equal(parseForwardRecord(value), null, JSON.stringify(value))
  }
})

test('a projected frame failure survives the guard (v2 additive field)', () => {
  const record = { ...RECORD, state: 'error', error: 'stale', frameError: 'blocked_by_response' }
  assert.deepEqual(parseForwardRecord(record), record)
  const absent = parseForwardRecord(RECORD)
  assert.equal('frameError' in (absent as object), false, 'an absent frameError must not become a key')
})

test('the frame-failure table is the closed wire set', () => {
  for (const code of ['blocked_by_response', 'certificate_error', 'load_failed', 'timeout']) {
    assert.equal(isForwardFrameError(code), true, code)
  }
  for (const value of ['', 'future', 1, null, undefined]) {
    assert.equal(isForwardFrameError(value), false, String(value))
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



test('the consumer grammar matches the wire pattern', () => {
  for (const value of ['a'.repeat(8), 'a'.repeat(64), '9f8e7d6c-5b4a-3210-9876-543210fedcba']) {
    assert.equal(isForwardConsumer(value), true, value)
  }
  for (const value of ['a'.repeat(7), 'a'.repeat(65), 'has space', 'bad/dot', 7, null]) {
    assert.equal(isForwardConsumer(value), false, String(value))
  }
})

test('the frameUrl guard only accepts bounded absolute http(s) URLs', () => {
  assert.equal(isForwardFrameUrl('http://127.0.0.2:41000/app?x=1'), true)
  assert.equal(isForwardFrameUrl('https://localhost:8443/'), true)
  assert.equal(isForwardFrameUrl('http://user:pw@127.0.0.2:41000/'), false)
  assert.equal(isForwardFrameUrl('http://127.0.0.2:41000/#frag'), false)
  assert.equal(isForwardFrameUrl('file:///etc/passwd'), false)
  assert.equal(isForwardFrameUrl('http://127.0.0.2:41000/a b'), false)
  assert.equal(isForwardFrameUrl('http://127.0.0.2/' + 'a'.repeat(5000)), false)
  assert.equal(isForwardFrameUrl(null), false)
})

test('request envelopes require a valid record and accept the optional frameUrl', () => {
  assert.deepEqual(parseForwardRequestResult({ ok: true, record: RECORD }), { ok: true, record: RECORD })
  assert.deepEqual(
    parseForwardRequestResult({ ok: true, record: RECORD, frameUrl: 'http://127.0.0.2:41000/' }),
    { ok: true, record: RECORD, frameUrl: 'http://127.0.0.2:41000/' },
  )
  assert.deepEqual(
    parseForwardRequestResult({ ok: true, record: RECORD, frameUrl: 'javascript:alert(1)' }),
    { ok: true, record: RECORD },
    'a malformed frameUrl is dropped, never trusted',
  )
  assert.deepEqual(parseForwardRequestResult({ ok: true, record: { ...RECORD, aliasHost: '127.0.0.1' } }), { ok: false, code: 'unknown' })
  assert.deepEqual(parseForwardRequestResult({ ok: false, code: 'bind-failed', message: 'in use' }), {
    ok: false,
    code: 'bind-failed',
    message: 'in use',
  })
  assert.deepEqual(parseForwardRequestResult({ ok: false, code: 'release-timeout' }), { ok: false, code: 'release-timeout' })
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