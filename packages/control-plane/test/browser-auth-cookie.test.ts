/**
 * Browser-auth cookie bootstrap unit tests (browser-auth-cookie.ts) —
 * review-round3c P0: the 0.1.2 launch-token exchange + in-memory cookie
 * registry the control plane uses to pass the upstream BrowserAuth gate.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import {
  authCookieFor,
  clearAuthCookie,
  exchangeLaunchToken,
  extractLaunchToken,
  parseDshWebUrlLine,
  registerAuthCookie,
} from '../src/browser-auth-cookie.ts'

test('parseDshWebUrlLine extracts the URL from the web-profile readiness line', () => {
  assert.equal(parseDshWebUrlLine('dsh web: http://127.0.0.1:17510/?token=abc123'), 'http://127.0.0.1:17510/?token=abc123')
  assert.equal(parseDshWebUrlLine('dsh web: http://127.0.0.1:17510 (LAN: http://10.0.0.5:17510)'), 'http://127.0.0.1:17510')
  // rc.2 layout: no token, LAN note
  assert.equal(parseDshWebUrlLine('dsh web: http://127.0.0.1:17510 (LAN: http://10.0.0.5:17510)'), 'http://127.0.0.1:17510')
  assert.equal(parseDshWebUrlLine('[dsh:17510] some log noise'), undefined)
  assert.equal(parseDshWebUrlLine(''), undefined)
})

test('extractLaunchToken reads the token query value only', () => {
  assert.equal(extractLaunchToken('http://127.0.0.1:17510/?token=launch-1'), 'launch-1')
  assert.equal(extractLaunchToken('http://127.0.0.1:17510/'), undefined)
  assert.equal(extractLaunchToken('not a url'), undefined)
})

test('exchangeLaunchToken mints the cookie from the 303 + Set-Cookie exchange', async () => {
  const server = createServer((req, res) => {
    assert.equal(req.url, '/?token=launch-1')
    res.writeHead(303, {
      'cache-control': 'no-store',
      location: '/',
      'set-cookie': 'browser-auth=session-value; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict',
    })
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  try {
    const cookie = await exchangeLaunchToken(`http://127.0.0.1:${port}`, 'launch-1')
    assert.equal(cookie, 'browser-auth=session-value')
  } finally {
    server.close()
  }
})

test('exchangeLaunchToken returns null when the host mints no cookie', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(303, { location: '/', 'cache-control': 'no-store' })
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  try {
    const cookie = await exchangeLaunchToken(`http://127.0.0.1:${port}`, 'launch-1')
    assert.equal(cookie, null)
  } finally {
    server.close()
  }
})

test('registry keeps the cookie in memory and clears on demand', () => {
  const base = 'http://127.0.0.1:17510'
  clearAuthCookie(base)
  assert.equal(authCookieFor(base), undefined)
  registerAuthCookie(base, 'browser-auth=v')
  assert.equal(authCookieFor(base), 'browser-auth=v')
  // Empty cookies are never recorded.
  registerAuthCookie(base, '')
  assert.equal(authCookieFor(base), 'browser-auth=v')
  clearAuthCookie(base)
  assert.equal(authCookieFor(base), undefined)
})
