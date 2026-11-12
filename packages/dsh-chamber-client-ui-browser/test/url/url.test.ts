/**
 * Upstream Browser address policy (fork: copied verbatim from
 * ui-sidebar-browser 0.2.2-rc.2 tests/url.client.spec.ts, node:test dialect).
 *
 * The fork keeps the upstream HTTP(S) allowlist byte for byte: bare input
 * defaults to HTTPS (NOT the v1 chamber default-http table), explicit
 * credentials/app-origin/other protocols are refused, and only the first
 * application-origin mismatch is invisible for an unusable app origin.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_BROWSER_URL_LENGTH, parseBrowserAddress } from '../../src/client/browser/url.ts'

const APP = 'https://dsh.example'

test('normalizes host names and HTTPS addresses (bare input defaults to https)', () => {
  assert.deepEqual(parseBrowserAddress('example.com/path', APP), {
    ok: true, target: { kind: 'https', url: 'https://example.com/path', title: 'example.com' },
  })
  assert.deepEqual(parseBrowserAddress('https://docs.example/a?q=1#x', APP), {
    ok: true, target: { kind: 'https', url: 'https://docs.example/a?q=1#x', title: 'docs.example' },
  })
  assert.deepEqual(parseBrowserAddress('example.com:8443/path', APP), {
    ok: true, target: { kind: 'https', url: 'https://example.com:8443/path', title: 'example.com' },
  })
})

test('accepts HTTP including loopback hosts', () => {
  assert.deepEqual(parseBrowserAddress('http://localhost:5173/app', APP), {
    ok: true, target: { kind: 'http', url: 'http://localhost:5173/app', title: 'localhost' },
  })
  assert.equal(parseBrowserAddress('http://127.42.0.9/', APP).ok, true)
  assert.equal(parseBrowserAddress('http://[::1]:8080/', APP).ok, true)
  assert.deepEqual(parseBrowserAddress('http://example.com/', APP), {
    ok: true, target: { kind: 'http', url: 'http://example.com/', title: 'example.com' },
  })
  assert.equal(parseBrowserAddress('http://128.0.0.1/', APP).ok, true)
  assert.deepEqual(parseBrowserAddress('http:/example.com/path', APP), {
    ok: true, target: { kind: 'http', url: 'http://example.com/path', title: 'example.com' },
  })
  assert.deepEqual(parseBrowserAddress('https:/example.com/path', APP), {
    ok: true, target: { kind: 'https', url: 'https://example.com/path', title: 'example.com' },
  })
})

test('rejects every undeclared or privileged form', () => {
  assert.deepEqual(parseBrowserAddress('', APP), { ok: false, reason: 'empty' })
  assert.deepEqual(parseBrowserAddress('javascript:alert(1)', APP), { ok: false, reason: 'protocol' })
  assert.deepEqual(parseBrowserAddress('https://user:secret@example.com', APP), { ok: false, reason: 'credentials' })
  assert.deepEqual(parseBrowserAddress(`${APP}/session`, APP), { ok: false, reason: 'application-origin' })
  assert.deepEqual(parseBrowserAddress(`https://${'a'.repeat(17_000)}.example`, APP), { ok: false, reason: 'invalid' })
  assert.deepEqual(parseBrowserAddress('file:///work/index.html', APP), { ok: false, reason: 'protocol' })
  assert.deepEqual(parseBrowserAddress('file:////server/share/index.html', APP), { ok: false, reason: 'protocol' })
  assert.deepEqual(parseBrowserAddress('file:/work/index.html', APP), { ok: false, reason: 'protocol' })
  assert.deepEqual(parseBrowserAddress('ftp:/example.com/file', APP), { ok: false, reason: 'protocol' })
  assert.deepEqual(parseBrowserAddress(':::', APP), { ok: false, reason: 'invalid' })
  // An unusable application origin cannot grant access to a target.
  assert.equal(parseBrowserAddress('https://example.test', 'not an origin').ok, true)
  assert.equal(parseBrowserAddress('https://example.test').ok, true)
  assert.equal(parseBrowserAddress('https://example.test', 'null').ok, true)
})

test('the length ceiling matches the upstream constant', () => {
  assert.equal(MAX_BROWSER_URL_LENGTH, 16 * 1024)
  const tooLong = 'https://' + 'a'.repeat(MAX_BROWSER_URL_LENGTH) + '.example/'
  assert.deepEqual(parseBrowserAddress(tooLong, APP), { ok: false, reason: 'invalid' })
})
