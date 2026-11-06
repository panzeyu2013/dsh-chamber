/**
 * Address-table unit tests for the Remote Browser launcher.
 *
 * Pins the report v4 §1 host/scheme table: http(s) only, default http,
 * 127.0.0.1/localhost normalisation, https passthrough, fragment drop,
 * public-vs-remote classification, and every refusal reason.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_BROWSER_ADDRESS_LENGTH, parseBrowserAddress } from '../../src/shared/address.ts'

const APP_ORIGIN = 'http://127.0.0.1:30800'

test('a bare host defaults to http and keeps the default port', () => {
  const result = parseBrowserAddress('example.com')
  assert.equal(result.kind, 'public')
  if (result.kind !== 'public') return
  assert.equal(result.scheme, 'http')
  assert.equal(result.host, 'example.com')
  assert.equal(result.port, 80)
  assert.equal(result.path, '/')
  assert.equal(result.query, '')
  assert.equal(result.url, 'http://example.com/')
  assert.equal(result.reachability, 'public')
})

test('path and query are preserved, the scheme is passed through', () => {
  const result = parseBrowserAddress('https://example.com:8443/a/b?q=1&x=2')
  assert.equal(result.kind, 'public')
  if (result.kind !== 'public') return
  assert.equal(result.scheme, 'https')
  assert.equal(result.port, 8443)
  assert.equal(result.path, '/a/b')
  assert.equal(result.query, 'q=1&x=2')
  assert.equal(result.requestPath, '/a/b?q=1&x=2')
})

test('127.0.0.1 is the remote loopback target', () => {
  const result = parseBrowserAddress('http://127.0.0.1:5173/app?debug=1')
  assert.equal(result.kind, 'remote-loopback')
  if (result.kind !== 'remote-loopback') return
  assert.equal(result.host, '127.0.0.1')
  assert.equal(result.port, 5173)
  assert.equal(result.path, '/app')
  assert.equal(result.query, 'debug=1')
  assert.equal(result.requestPath, '/app?debug=1')
})

test('localhost keeps its typed spelling for the link leg but forwards to 127.0.0.1', () => {
  const result = parseBrowserAddress('localhost:5173')
  assert.equal(result.kind, 'remote-loopback')
  if (result.kind !== 'remote-loopback') return
  assert.equal(result.port, 5173)
  // A local service (or its certificate) may answer only as localhost — the
  // system-browser URL keeps the typed host; the forward target is canonical.
  assert.equal(result.url, 'http://localhost:5173/')
  assert.equal(result.host, '127.0.0.1')
  assert.equal(result.requestPath, '/')
})

test('an https localhost URL keeps localhost for the link leg', () => {
  const result = parseBrowserAddress('https://localhost:8443/secure')
  assert.equal(result.kind, 'remote-loopback')
  if (result.kind !== 'remote-loopback') return
  assert.equal(result.url, 'https://localhost:8443/secure')
  assert.equal(result.host, '127.0.0.1')
})

test('a trailing-dot loopback is still the remote target', () => {
  const result = parseBrowserAddress('http://127.0.0.1.:3000')
  assert.equal(result.kind, 'remote-loopback')
})

test('numeric IPv4 spellings normalise to the loopback target', () => {
  for (const input of ['2130706433:3000', '0x7f.1:3000']) {
    const result = parseBrowserAddress(input)
    assert.equal(result.kind, 'remote-loopback', input)
  }
})

test('https is passed through for a remote loopback target', () => {
  const result = parseBrowserAddress('https://127.0.0.1:8443/secure')
  assert.equal(result.kind, 'remote-loopback')
  if (result.kind !== 'remote-loopback') return
  assert.equal(result.scheme, 'https')
  assert.equal(result.port, 8443)
  assert.equal(result.url, 'https://127.0.0.1:8443/secure')
})

test('the fragment is dropped before any forward', () => {
  const result = parseBrowserAddress('http://127.0.0.1:5173/a#section-2')
  assert.equal(result.kind, 'remote-loopback')
  if (result.kind !== 'remote-loopback') return
  assert.equal(result.fragmentDropped, true)
  assert.equal(result.requestPath, '/a')
  assert.equal(result.url.includes('#'), false)
})

test('percent-encoded paths survive unchanged', () => {
  const result = parseBrowserAddress('http://127.0.0.1:5173/a%20b?q=x%20y')
  assert.equal(result.kind, 'remote-loopback')
  if (result.kind !== 'remote-loopback') return
  assert.equal(result.requestPath, '/a%20b?q=x%20y')
})

test('IPv6 loopback and unspecified hosts are refused', () => {
  const cases: Array<[string, string]> = [
    ['http://[::1]:5173', 'ipv6-loopback'],
    ['http://[::ffff:127.0.0.1]:5173', 'ipv6-loopback'],
    ['http://[::]:5173', 'unspecified-host'],
    ['0.0.0.0:3000', 'unspecified-host'],
    ['http://127.0.0.2:5173', 'alias-host'],
    ['http://127.0.0.254:5173', 'alias-host'],
    ['http://127.1.1.1:5173', 'loopback-other'],
    ['http://127.0.0.255:5173', 'loopback-other'],
  ]
  for (const [input, reason] of cases) {
    const result = parseBrowserAddress(input)
    assert.deepEqual(result, { kind: 'unsupported', reason }, input)
  }
})

test('RFC1918 / link-local / CGNAT are public but flagged as private-network', () => {
  for (const input of ['10.0.0.5:3000', '172.20.0.1:3000', '192.168.1.5:3000', '169.254.1.1:3000', '100.64.0.1:3000']) {
    const result = parseBrowserAddress(input)
    assert.equal(result.kind, 'public', input)
    if (result.kind !== 'public') continue
    assert.equal(result.reachability, 'private-network', input)
  }
})

test('chamber alias hosts and other 127/8 spellings are refused, never forwarded', () => {
  assert.deepEqual(parseBrowserAddress('http://127.0.0.2:5173'), { kind: 'unsupported', reason: 'alias-host' })
  assert.deepEqual(parseBrowserAddress('http://127.1.1.1:5173'), { kind: 'unsupported', reason: 'loopback-other' })
})

test('*.localhost is local-machine, not the forward target', () => {
  const result = parseBrowserAddress('app.localhost:3000')
  assert.equal(result.kind, 'public')
  if (result.kind !== 'public') return
  assert.equal(result.reachability, 'local-machine')
})

test('a LAN hostname is treated as a public URL', () => {
  const result = parseBrowserAddress('my-nas.local:5000')
  assert.equal(result.kind, 'public')
  if (result.kind !== 'public') return
  assert.equal(result.reachability, 'public')
})

test('non-http(s) schemes are refused', () => {
  for (const input of ['mailto:a@b.c', 'file:///etc/passwd', 'ftp://example.com', 'javascript:alert(1)', 'data:text/html,x']) {
    const result = parseBrowserAddress(input)
    assert.equal(result.kind, 'unsupported', input)
    if (result.kind !== 'unsupported') continue
    assert.equal(result.reason, 'protocol', input)
  }
})

test('userinfo is refused', () => {
  const result = parseBrowserAddress('http://user:pass@127.0.0.1:3000')
  assert.deepEqual(result, { kind: 'unsupported', reason: 'credentials' })
})

test('the application origin is refused, including loopback aliases on its port', () => {
  for (const input of [
    'http://127.0.0.1:30800',
    'http://localhost:30800',
    'http://127.0.0.1:30800/some/path',
  ]) {
    const result = parseBrowserAddress(input, { applicationOrigin: APP_ORIGIN })
    assert.deepEqual(result, { kind: 'unsupported', reason: 'application-origin' }, input)
  }
})

test('the application-origin alias rule is symmetric and port-scoped', () => {
  const localhostOrigin = 'http://localhost:30800'
  assert.deepEqual(
    parseBrowserAddress('http://127.0.0.1:30800', { applicationOrigin: localhostOrigin }),
    { kind: 'unsupported', reason: 'application-origin' },
  )

  const aliasHost = parseBrowserAddress('http://127.0.0.2:30800', { applicationOrigin: APP_ORIGIN })
  assert.deepEqual(aliasHost, { kind: 'unsupported', reason: 'alias-host' })
})

test('the same loopback port with another scheme or another port is not the application', () => {
  const otherScheme = parseBrowserAddress('https://127.0.0.1:30800', { applicationOrigin: APP_ORIGIN })
  assert.equal(otherScheme.kind, 'remote-loopback')

  const otherPort = parseBrowserAddress('http://127.0.0.1:5173', { applicationOrigin: APP_ORIGIN })
  assert.equal(otherPort.kind, 'remote-loopback')
})

test('empty, over-long and control-character inputs are refused', () => {
  assert.deepEqual(parseBrowserAddress(''), { kind: 'unsupported', reason: 'empty' })
  assert.deepEqual(parseBrowserAddress('   '), { kind: 'unsupported', reason: 'empty' })
  assert.deepEqual(
    parseBrowserAddress('http://example.com/' + 'a'.repeat(MAX_BROWSER_ADDRESS_LENGTH)),
    { kind: 'unsupported', reason: 'too-long' },
  )
  assert.deepEqual(parseBrowserAddress('http://example.com/\r\nX'), { kind: 'unsupported', reason: 'invalid' })
})

test('an unparsable URL is refused', () => {
  assert.deepEqual(parseBrowserAddress('http://'), { kind: 'unsupported', reason: 'invalid' })
  assert.deepEqual(parseBrowserAddress('http://x.com:70000'), { kind: 'unsupported', reason: 'invalid' })
})

test('port 0 is refused', () => {
  assert.deepEqual(parseBrowserAddress('http://127.0.0.1:0'), { kind: 'unsupported', reason: 'port' })
})

test('non-string input is refused without throwing', () => {
  for (const value of [undefined, null, 42, {}, []]) {
    assert.deepEqual(parseBrowserAddress(value), { kind: 'unsupported', reason: 'invalid' })
  }
})

test('an upper-case scheme and host are canonicalised', () => {
  const result = parseBrowserAddress('HTTP://EXAMPLE.COM/Path')
  assert.equal(result.kind, 'public')
  if (result.kind !== 'public') return
  assert.equal(result.scheme, 'http')
  assert.equal(result.host, 'example.com')
  assert.equal(result.path, '/Path')
})
