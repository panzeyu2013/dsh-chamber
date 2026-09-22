/**
 * Login-page pre-warm rendering tests (design 17 §10.6): the optional
 * <link rel="prefetch" as="script"> block inside <head>, the byte-identical
 * no-warm-up output (hashes pinned below), and the
 * connect-src 'self' CSP increment.
 *
 * Plain node:test + node:assert, no new deps; imports ONLY src/login-page.ts
 * (zero imports), so it runs without the workspace node_modules link.
 * Run with `node packages/gateway/test/auth/warmup-login-page.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { LOGIN_PAGE_CSP, renderLoginPage } from '../../src/login-page.ts'

/** sha256 of the no-warm-up renders. Any non-warm-up byte drift turns these
 * red — that is the "without data the output equals the template" lock. */
const PRE_WARMUP_SHA256 = {
  enPristine: 'b969f4efd53780ec095c406ad01ad67b25094e9d4f8d824d4ee6dfa324be89a5',
  zhPristine: '4f854d80676b46f3f69764001d7a094695761909678acc813027417820ba494b',
  enInvalid: '24623ee8a14f2d3162ec4f200cfbaf3f811d2663d352f2e73e68acc6d2795029',
} as const

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

test('without warm-up data the login page is byte-identical to the pre-warm template', () => {
  const en = renderLoginPage({ lang: 'en', secure: true })
  assert.equal(sha256(en), PRE_WARMUP_SHA256.enPristine)
  assert.equal(sha256(renderLoginPage({ lang: 'zh', secure: true })), PRE_WARMUP_SHA256.zhPristine)
  assert.equal(sha256(renderLoginPage({ lang: 'en', secure: true, error: 'invalid' })), PRE_WARMUP_SHA256.enInvalid)
  assert.doesNotMatch(en, /prefetch/i)
  assert.doesNotMatch(en, /connect-src/)
  // An explicit empty list is the same as omitting the option.
  assert.equal(renderLoginPage({ lang: 'en', secure: true, warmupUrls: [] }), en)
})

test('with warm-up data one prefetch link per REAL bundle URL lands inside <head>, script-free', () => {
  const urls = [
    '/plugins/??a/client.js,b/client.js&rev=z',
    '/plugins/??dsh-chamber-mcp/client.js&rev=deadbeef',
  ]
  const html = renderLoginPage({ lang: 'en', secure: true, warmupUrls: urls })
  const headEnd = html.indexOf('</head>')
  assert.ok(headEnd > 0)
  for (const url of urls) {
    const link = '<link rel="prefetch" as="script" href="' + url.replace(/&/g, '&amp;') + '">'
    const at = html.indexOf(link)
    assert.ok(at > 0, 'renders ' + link)
    assert.ok(at < headEnd, 'the link lives inside <head>')
    assert.equal(html.indexOf(link, at + 1), -1, 'exactly one link per URL')
  }
  assert.equal(html.split('rel="prefetch"').length - 1, urls.length)
  // The cache-key contract (measured in Chrome): the href is the REAL url the
  // shell itself will request — no /chamber/warmup/ wrapper, no ?u= parameter
  // and no crossorigin attribute that could split the HTTP cache entry.
  assert.doesNotMatch(html, /\/chamber\/warmup\//)
  assert.doesNotMatch(html, /\?u=/)
  assert.doesNotMatch(html, /crossorigin/)
  // The no-script invariant (C1) survives the feature: prefetch is a link,
  // never a script element, and the attribute values are HTML-escaped.
  assert.doesNotMatch(html, /<script/i)
  assert.doesNotMatch(html, /value="/)
})

test('warm-up URLs are HTML-escaped in the href attribute', () => {
  const html = renderLoginPage({ lang: 'en', secure: true, warmupUrls: ['/plugins/??x"><script>alert(1)</script>'] })
  assert.doesNotMatch(html, /<script/i)
  assert.ok(html.includes('href="/plugins/??x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'), 'the quote and angle brackets in the URL are escaped')
})

test('the login-page CSP adds exactly connect-src \'self\' and keeps every other directive', () => {
  assert.equal(
    LOGIN_PAGE_CSP,
    "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'",
  )
  // The original directives are untouched and script-src is still absent (C1).
  for (const directive of ["default-src 'none'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'", "style-src 'unsafe-inline'", 'img-src data:']) {
    assert.ok(LOGIN_PAGE_CSP.includes(directive), `keeps ${directive}`)
  }
  const additions = LOGIN_PAGE_CSP.split(';').map(part => part.trim()).filter(part => ![
    "default-src 'none'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'",
    "form-action 'self'", "style-src 'unsafe-inline'", 'img-src data:',
  ].includes(part))
  assert.deepEqual(additions, ["connect-src 'self'"], 'connect-src is the only addition')
  assert.doesNotMatch(LOGIN_PAGE_CSP, /script-src/)
})
