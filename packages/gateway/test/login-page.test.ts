/**
 * Gateway login page tests: the pure rendering helpers behind the /auth/login
 * browser face. Covers the en/zh copy tables, the error/expired/plaintext
 * banner states, S5 (no echoed password anywhere), the
 * wantsHtmlLoginResponse content-negotiation matrix, Accept-Language
 * detection, the token-only/no-auth explanation pages, and the LOGIN_PAGE_CSP
 * no-script invariant.
 * Run with `node packages/gateway/test/login-page.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOGIN_PAGE_CSP,
  detectLoginLang,
  renderLoginPage,
  renderTokenOnlyPage,
  wantsHtmlLoginResponse,
} from '../src/login-page.ts'

test('renderLoginPage renders the pristine en form with full input hygiene', () => {
  const html = renderLoginPage({ lang: 'en', secure: true })
  assert.match(html, /<html lang="en">/)
  assert.match(html, /action="\/auth\/login"/)
  assert.match(html, /name="password"/)
  assert.match(html, /type="password"/)
  assert.match(html, /autocomplete="current-password"/)
  assert.match(html, /\brequired\b/)
  assert.match(html, /maxlength="1024"/)
  assert.match(html, /autocapitalize="off"/)
  assert.match(html, /spellcheck="false"/)
  assert.match(html, /autocorrect="off"/)
  assert.match(html, /\bautofocus\b/)
  // The token layer is self-declared in the page's own <style>.
  assert.match(html, /--dsw-alias-bg-base:\s*#0b0f14/)
  // Inline SVG favicon — the one `img-src data:` consumer.
  assert.match(html, /data:image\/svg\+xml/)
  // No-script invariant (C1): the page carries zero script elements.
  assert.doesNotMatch(html, /<script/i)
  // S5: a pristine page never carries an echoed value attribute.
  assert.doesNotMatch(html, /value="/)
})

test('renderLoginPage renders the zh form with lang="zh" and the zh copy', () => {
  const html = renderLoginPage({ lang: 'zh', secure: true })
  assert.match(html, /<html lang="zh">/)
  // Exact copy for the label and submit (not loose substring matches).
  assert.ok(html.includes('>密码</label>'))
  assert.ok(html.includes('>登录</button>'))
})

test('invalid errors render the banner and mark the input (en)', () => {
  const html = renderLoginPage({ lang: 'en', secure: true, error: 'invalid' })
  assert.ok(html.includes('Incorrect password.'))
  // Input-scoped: the stylesheet legitimately contains an
  // `#password[aria-invalid="true"]` styling hook, so the bare attribute
  // string would match even on a pristine page — target the rendered input.
  assert.match(html, /<input[^>]*aria-invalid="true"/)
  assert.match(html, /<input[^>]*aria-describedby="login-error"/)
  assert.match(html, /role="alert"/)
})

test('invalid errors render the banner and mark the input (zh)', () => {
  const html = renderLoginPage({ lang: 'zh', secure: true, error: 'invalid' })
  assert.ok(html.includes('密码不正确。'))
  assert.match(html, /<input[^>]*aria-invalid="true"/)
  assert.match(html, /<input[^>]*aria-describedby="login-error"/)
  assert.match(html, /role="alert"/)
})

test('rate_limited and busy also mark the input; pristine never does', () => {
  for (const error of ['rate_limited', 'busy'] as const) {
    const html = renderLoginPage({ lang: 'en', secure: true, error })
    assert.match(html, /<input[^>]*aria-invalid="true"/, `${error} must mark the input`)
    assert.match(html, /<input[^>]*aria-describedby="login-error"/, `${error} must wire the error banner`)
  }
  const pristine = renderLoginPage({ lang: 'en', secure: true })
  assert.doesNotMatch(pristine, /<input[^>]*aria-invalid/, 'pristine input carries no invalid marking')
})

test('rate_limited renders the retry-after seconds in the copy (en + zh)', () => {
  const en = renderLoginPage({ lang: 'en', secure: true, error: 'rate_limited', retryAfterSec: 900 })
  assert.ok(en.includes('Too many attempts. Try again in ~900s.'))
  const zh = renderLoginPage({ lang: 'zh', secure: true, error: 'rate_limited', retryAfterSec: 900 })
  assert.ok(zh.includes('请在约 900 秒后重试。'))
})

test('rate_limited without retryAfterSec falls back to a generic wait message', () => {
  const en = renderLoginPage({ lang: 'en', secure: true, error: 'rate_limited' })
  assert.ok(en.includes('Too many attempts. Try again later.'))
  const zh = renderLoginPage({ lang: 'zh', secure: true, error: 'rate_limited' })
  assert.ok(zh.includes('尝试次数过多，请稍后重试。'))
})

test('rate_limited with a non-finite or sub-1 retryAfterSec falls back (never renders Infinity)', () => {
  // Defense-in-depth for the exported render function: dispatch always sends
  // `Math.max(1, Math.ceil(retryAfterMs / 1000))` (finite, >= 1), but a
  // direct caller must not be able to render "~Infinitys" or "~0s".
  for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
    const en = renderLoginPage({ lang: 'en', secure: true, error: 'rate_limited', retryAfterSec: bad })
    assert.ok(en.includes('Too many attempts. Try again later.'), `retryAfterSec ${bad} must fall back`)
    assert.ok(!en.includes('Infinity'), `retryAfterSec ${bad} must never render Infinity`)
    assert.ok(!/~\d+s/.test(en), `retryAfterSec ${bad} must not render a seconds template`)
  }
})

test('busy renders the service-busy banner (en + zh)', () => {
  const en = renderLoginPage({ lang: 'en', secure: true, error: 'busy' })
  assert.ok(en.includes('Authentication service is busy. Try again shortly.'))
  const zh = renderLoginPage({ lang: 'zh', secure: true, error: 'busy' })
  assert.ok(zh.includes('认证服务繁忙，请稍后重试。'))
})

test('expired renders the subtle session-expired hint without marking the input invalid', () => {
  // The input must not carry the invalid marking in the expired state. (The
  // page's stylesheet legitimately contains the #password[aria-invalid]
  // styling hook, so the check targets the rendered input element.)
  const en = renderLoginPage({ lang: 'en', secure: true, error: 'expired' })
  assert.ok(en.includes('Your session expired. Sign in again.'))
  assert.doesNotMatch(en, /<input[^>]*aria-invalid/)
  const zh = renderLoginPage({ lang: 'zh', secure: true, error: 'expired' })
  assert.ok(zh.includes('会话已过期，请重新登录。'))
  assert.doesNotMatch(zh, /<input[^>]*aria-invalid/)
})

test('secure:false renders the plaintext warning and never claims encryption', () => {
  const en = renderLoginPage({ lang: 'en', secure: false })
  assert.ok(en.includes('Unencrypted connection — your password will be sent in plain text.'))
  assert.ok(!en.includes('Encrypted connection'))
  const zh = renderLoginPage({ lang: 'zh', secure: false })
  assert.ok(zh.includes('未加密连接——密码将以明文传输。'))
  assert.ok(!zh.includes('Encrypted connection'))
})

test('secure:true renders the encrypted badge and no plaintext warning', () => {
  const en = renderLoginPage({ lang: 'en', secure: true })
  assert.ok(en.includes('✓ Encrypted connection'))
  assert.ok(!en.includes('Unencrypted'))
  const zh = renderLoginPage({ lang: 'zh', secure: true })
  assert.ok(zh.includes('加密连接'))
  assert.ok(!zh.includes('Unencrypted'))
})

test('invalid on an unencrypted connection renders both the warn and error banners', () => {
  const html = renderLoginPage({ lang: 'en', secure: false, error: 'invalid' })
  assert.ok(html.includes('Unencrypted connection — your password will be sent in plain text.'))
  assert.ok(html.includes('Incorrect password.'))
})

test('S5: no error state ever echoes a value attribute (both languages, both secure values)', () => {
  for (const lang of ['en', 'zh'] as const) {
    for (const secure of [true, false] as const) {
      for (const error of ['invalid', 'rate_limited', 'busy', 'expired'] as const) {
        const html = renderLoginPage({ lang, secure, error })
        assert.doesNotMatch(html, /value="/, `${lang}/${secure}/${error} leaked a value attribute`)
      }
    }
  }
})

test('wantsHtmlLoginResponse matrix: form-urlencoded + Accept text/html', () => {
  assert.equal(wantsHtmlLoginResponse({
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'text/html,application/xhtml+xml',
  }), true)
  assert.equal(wantsHtmlLoginResponse({
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  }), false)
  assert.equal(wantsHtmlLoginResponse({
    'content-type': 'application/x-www-form-urlencoded',
  }), false)
  assert.equal(wantsHtmlLoginResponse({
    'content-type': 'application/json',
    accept: 'text/html',
  }), false)
  assert.equal(wantsHtmlLoginResponse({
    accept: 'text/html',
  }), false)
  assert.equal(wantsHtmlLoginResponse({
    'content-type': 'application/x-www-form-urlencoded',
    accept: ['text/html', 'application/xhtml+xml'],
  }), true)
  assert.equal(wantsHtmlLoginResponse({
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    accept: 'text/html',
  }), true)
})

test('detectLoginLang maps zh-* to zh and everything else to en', () => {
  assert.equal(detectLoginLang('zh-CN,zh;q=0.9,en;q=0.8'), 'zh')
  assert.equal(detectLoginLang('zh-TW'), 'zh')
  assert.equal(detectLoginLang('zh'), 'zh')
  assert.equal(detectLoginLang('en-US,en;q=0.9'), 'en')
  assert.equal(detectLoginLang('fr-FR'), 'en')
  assert.equal(detectLoginLang(undefined), 'en')
  assert.equal(detectLoginLang(''), 'en')
})

test('renderTokenOnlyPage explains token auth for browsers without a form', () => {
  const en = renderTokenOnlyPage('en')
  assert.match(en, /<html lang="en">/)
  assert.ok(en.includes('This gateway uses token authentication'))
  assert.ok(en.includes('Open dsh'))
  assert.match(en, /href="\/"/)
  assert.doesNotMatch(en, /<form/)
  const zh = renderTokenOnlyPage('zh')
  assert.match(zh, /<html lang="zh">/)
  assert.ok(zh.includes('此 gateway 使用共享 token 认证'))
  assert.ok(zh.includes('打开 dsh'))
  assert.doesNotMatch(zh, /<form/)
})

test('renderTokenOnlyPage no-auth variant never claims a token (honest posture)', () => {
  const en = renderTokenOnlyPage('en', 'none')
  assert.ok(en.includes('This gateway has no password login'))
  assert.ok(!en.includes('token'), 'a --no-auth deployment must not claim token auth')
  assert.ok(en.includes('Open dsh'))
  assert.doesNotMatch(en, /<form/)
  const zh = renderTokenOnlyPage('zh', 'none')
  assert.ok(zh.includes('此 gateway 未配置密码登录'))
  assert.ok(!zh.includes('token'), 'zh no-auth copy must not mention a token')
  assert.ok(zh.includes('打开 dsh'))
})

test('LOGIN_PAGE_CSP allows only self forms and data images — never scripts', () => {
  assert.match(LOGIN_PAGE_CSP, /form-action 'self'/)
  assert.match(LOGIN_PAGE_CSP, /img-src data:/)
  assert.doesNotMatch(LOGIN_PAGE_CSP, /script-src/)
})
