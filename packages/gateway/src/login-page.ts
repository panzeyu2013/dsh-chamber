/**
 * Gateway login page rendering (design 21): the self-contained pre-auth
 * browser surface for `/auth/login`, replacing the minimal LOGIN_PAGE_HTML
 * in dispatch.ts. Pure string builder — zero imports, zero DOM, no runtime
 * dependencies; the page ships inline with the gateway (design 17 §7.1).
 *
 *   - No scripts (C1): the page CSP never allows script-src, so the output
 *     must never contain a `<script` element; all behavior is browser-native
 *     form submission (password managers provide their own reveal).
 *   - Credentials never echo (S5/C4): the render functions take no password
 *     and the output never contains a `value="` attribute.
 *   - Failure states keep the exact status-code matrix (401/429/503) with the
 *     form re-rendered in HTML for browsers; JSON clients are negotiated out
 *     via wantsHtmlLoginResponse and keep the existing JSON shape (design 21 §6).
 *   - `secure` mirrors the request policy's `decision.secure` (same fact as
 *     the conditional `; Secure` cookie attribute): plaintext connections get
 *     an honest warning, never a TLS claim (C8).
 *   - en/zh copy tables are kept in sync here (design 21 §8); `{n}` is the
 *     server-ceiled retryAfterSec, substituted only for rate_limited.
 *
 * NOTE: the design-21 document (docs/design/21-gateway-login-page.md) was
 * removed by user decision after implementation (2026-10). The contract is
 * recorded in CHANGELOG [Unreleased] and the invariants re-stated here.
 */

export interface LoginPageOptions {
  lang: 'en' | 'zh'
  secure: boolean
  error?: 'invalid' | 'rate_limited' | 'busy' | 'expired' | null
  retryAfterSec?: number // whole seconds, already ceiling'd; only meaningful when error === 'rate_limited'
}

/** Login-page CSP (design 21 §7.2): `img-src data:` is the only sanctioned
 * increment over design 17 §7.1 — the inline SVG favicon. `script-src` stays
 * absent (C1). */
export const LOGIN_PAGE_CSP: string = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'unsafe-inline'; img-src data:"

type Lang = 'en' | 'zh'

interface LoginPageCopy {
  title: string
  wordmarkSub: string
  subtitle: string
  passwordLabel: string
  submit: string
  errorInvalid: string
  errorRateLimited: string
  errorRateLimitedFallback: string
  errorBusy: string
  hintExpired: string
  warnPlaintext: string
  badgeSecure: string
  tokenOnlyTitle: string
  tokenOnlyBody: string
  tokenOnlyBack: string
  tokenOnlyTitleNone: string
  tokenOnlyBodyNone: string
}

/** en/zh copy (design 21 §8). Kept as one typed table so a missing key is a
 * compile error, never a silent mismatch between the two languages. */
const COPY: Record<Lang, LoginPageCopy> = {
  en: {
    title: 'dsh gateway',
    wordmarkSub: 'gateway',
    subtitle: 'Gateway access',
    passwordLabel: 'Password',
    submit: 'Sign in',
    errorInvalid: 'Incorrect password.',
    errorRateLimited: 'Too many attempts. Try again in ~{n}s.',
    errorRateLimitedFallback: 'Too many attempts. Try again later.',
    errorBusy: 'Authentication service is busy. Try again shortly.',
    hintExpired: 'Your session expired. Sign in again.',
    warnPlaintext: 'Unencrypted connection — your password will be sent in plain text.',
    badgeSecure: '✓ Encrypted connection',
    tokenOnlyTitle: 'This gateway uses token authentication',
    tokenOnlyBody: 'Sign in with the desktop app or an API client using the shared token.',
    tokenOnlyBack: 'Open dsh',
    tokenOnlyTitleNone: 'This gateway has no password login',
    tokenOnlyBodyNone: 'Connect with the desktop app or an API client.',
  },
  zh: {
    title: 'dsh gateway',
    wordmarkSub: 'gateway',
    subtitle: '网关接入',
    passwordLabel: '密码',
    submit: '登录',
    errorInvalid: '密码不正确。',
    errorRateLimited: '尝试次数过多，请在约 {n} 秒后重试。',
    errorRateLimitedFallback: '尝试次数过多，请稍后重试。',
    errorBusy: '认证服务繁忙，请稍后重试。',
    hintExpired: '会话已过期，请重新登录。',
    warnPlaintext: '未加密连接——密码将以明文传输。',
    badgeSecure: '✓ 加密连接',
    tokenOnlyTitle: '此 gateway 使用共享 token 认证',
    tokenOnlyBody: '请使用桌面端应用或 API 客户端以共享 token 访问。',
    tokenOnlyBack: '打开 dsh',
    tokenOnlyTitleNone: '此 gateway 未配置密码登录',
    tokenOnlyBodyNone: '请使用桌面端应用或 API 客户端访问。',
  },
}

/** dsh design-token layer (design 21 §4.1): values identical to the gateway's
 * own `/chamber/` orchestration page, self-declared so the pre-auth page
 * depends on nothing beyond this file (C5). */
const TOKEN_LAYER = `:root {
  color-scheme: dark;
  --dsw-alias-bg-base: #0b0f14;
  --dsw-alias-bg-layer-1: #0d1117;
  --dsw-alias-bg-layer-2: #161b22;
  --dsw-alias-bg-layer-3: #21262d;
  --dsw-alias-border-l2: #30363d;
  --dsw-alias-border-l3: #484f58;
  --dsw-alias-label-primary: #e6edf3;
  --dsw-alias-label-tertiary: #8b949e;
  --dsw-alias-state-error-primary: #ff7b72;
  --dsw-alias-state-error-bg: #da3633;
  --dsw-alias-state-warn-primary: #d29922;
  --dsw-alias-brand-primary: #58a6ff;
  --dsw-alias-button-primary-fill: #238636;
  --dsw-alias-button-primary-hover: #2ea043;
  --dsw-alias-state-success-primary: #3fb950;
}`

/** Component styles (design 21 §4.2): mirrors the `/chamber/` page's values —
 * card = .panel, input = .custom input, button = button.primary. */
const COMPONENT_STYLES = `*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;padding:1rem}
main.card{width:100%;max-width:22rem;display:flex;flex-direction:column;gap:1rem;padding:1.25rem;border:1px solid var(--dsw-alias-border-l2);border-radius:.75rem;background:var(--dsw-alias-bg-layer-2)}
h1{margin:0;font-size:1.15rem;font-weight:600}
.wordmark-sub{color:var(--dsw-alias-label-tertiary)}
.subtitle{margin:0;font-size:.85rem;color:var(--dsw-alias-label-tertiary)}
.banner{margin:0;padding:.6rem .75rem;border-radius:.5rem;font-size:.85rem;border:1px solid}
.banner.error{border-color:var(--dsw-alias-state-error-bg);background:rgba(255,123,114,.1);color:var(--dsw-alias-state-error-primary)}
.banner.warn{border-color:var(--dsw-alias-state-warn-primary);background:rgba(210,153,34,.1);color:var(--dsw-alias-state-warn-primary)}
.hint{margin:0;font-size:.8rem;color:var(--dsw-alias-label-tertiary)}
.badge{margin:0;font-size:.75rem;color:var(--dsw-alias-label-tertiary)}
label.field{display:flex;flex-direction:column;gap:.35rem;font-size:.85rem;color:var(--dsw-alias-label-tertiary)}
#password{width:100%;min-height:2rem;padding:.45rem .55rem;border:1px solid var(--dsw-alias-border-l3);border-radius:.4rem;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}
#password:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
#password[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-bg)}
button[type="submit"]{width:100%;min-height:2rem;padding:.35rem .75rem;border:1px solid var(--dsw-alias-button-primary-fill);border-radius:1rem;background:var(--dsw-alias-button-primary-fill);color:#fff;font:inherit;cursor:pointer}
button[type="submit"]:hover{border-color:var(--dsw-alias-button-primary-hover);background:var(--dsw-alias-button-primary-hover)}
button[type="submit"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
@media (max-width:480px){main.card{padding:1rem}}`

/** Full self-contained document shell: charset, viewport, title, inline SVG
 * data: favicon (the `img-src data:` CSP increment, design 21 §7.2), inline
 * styles, and the given body. Never emits external URLs or script elements. */
function pageShell(lang: Lang, body: string): string {
  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${COPY[lang].title}</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%23238636'/%3E%3Ccircle cx='8' cy='8' r='3.2' fill='%23e6edf3'/%3E%3C/svg%3E">
  <style>
${TOKEN_LAYER}

${COMPONENT_STYLES}
  </style>
</head>
<body>
${body}
</body>
</html>
`
}

function indentLines(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return text.split('\n').map(line => pad + line).join('\n')
}

/** Error-banner copy for the three error states. The rate_limited template
 * carries the server-ceiled seconds; anything that is not a number >= 1 falls
 * back to the generic copy so NaN/undefined can never reach the output. */
function errorBannerCopy(opts: LoginPageOptions, copy: LoginPageCopy): string {
  if (opts.error === 'rate_limited') {
    const retryAfterSec = opts.retryAfterSec
    if (typeof retryAfterSec === 'number' && Number.isFinite(retryAfterSec) && retryAfterSec >= 1) {
      return copy.errorRateLimited.replace('{n}', String(retryAfterSec))
    }
    return copy.errorRateLimitedFallback
  }
  return opts.error === 'busy' ? copy.errorBusy : copy.errorInvalid
}

/** The login form (design 21 §5.1/§7.3): browser-native POST to /auth/login,
 * autofocus on the single input, full credential-input hygiene, and the a11y
 * attributes wired to the error banner only when one is shown. The password
 * input is never pre-filled (S5). */
function loginForm(opts: LoginPageOptions, copy: LoginPageCopy): string {
  const showError = opts.error === 'invalid' || opts.error === 'rate_limited' || opts.error === 'busy'
  const invalidAttrs = showError ? ' aria-invalid="true" aria-describedby="login-error"' : ''
  return '<form method="post" action="/auth/login">\n'
    + '  <label class="field" for="password">' + copy.passwordLabel + '</label>\n'
    + '  <input id="password" name="password" type="password" autocomplete="current-password"'
    + ' required maxlength="1024" autocapitalize="off" spellcheck="false" autocorrect="off"'
    + ' autofocus' + invalidAttrs + '>\n'
    + '  <button type="submit">' + copy.submit + '</button>\n'
    + '</form>'
}

/** Render the pre-auth login page (design 21 §5.2). Stacking order: wordmark →
 * plaintext warning (secure=false) → error banner (invalid/rate_limited/busy)
 * → expired hint (expired) → form → secure badge (secure=true). */
export function renderLoginPage(opts: LoginPageOptions): string {
  const copy = COPY[opts.lang]
  const showError = opts.error === 'invalid' || opts.error === 'rate_limited' || opts.error === 'busy'
  const parts: string[] = []

  parts.push('<h1>dsh <span class="wordmark-sub">' + copy.wordmarkSub + '</span></h1>')
  parts.push('<p class="subtitle">' + copy.subtitle + '</p>')

  if (opts.secure === false) {
    parts.push('<p class="banner warn" role="alert">' + copy.warnPlaintext + '</p>')
  }
  if (showError) {
    parts.push('<p id="login-error" class="banner error" role="alert">' + errorBannerCopy(opts, copy) + '</p>')
  }
  if (opts.error === 'expired') {
    parts.push('<p class="hint">' + copy.hintExpired + '</p>')
  }

  parts.push(loginForm(opts, copy))

  if (opts.secure === true) {
    parts.push('<p class="badge">' + copy.badgeSecure + '</p>')
  }

  const body = '  <main class="card">\n' + indentLines(parts.join('\n'), 4) + '\n  </main>'
  return pageShell(opts.lang, body)
}

/** Content negotiation for the login page (design 21 §6.1): a browser-native
 * form POST (form-urlencoded body) that advertises HTML in Accept. JSON
 * clients — including the desktop main process — never match and keep the
 * existing JSON error shape. */
export function wantsHtmlLoginResponse(headers: Record<string, string | string[] | undefined>): boolean {
  const contentType = String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  const rawAccept = headers['accept']
  const accept = (Array.isArray(rawAccept) ? rawAccept.join(',') : String(rawAccept ?? '')).toLowerCase()
  return contentType === 'application/x-www-form-urlencoded' && accept.includes('text/html')
}

/** Accept-Language → render language (design 21 §8): first comma-separated
 * tag; `zh`/`zh-*` (zh-CN, zh-TW, …) → 'zh', everything else (including a
 * missing header) → 'en'. */
export function detectLoginLang(acceptLanguage: string | undefined): 'en' | 'zh' {
  if (acceptLanguage === undefined || acceptLanguage === '') return 'en'
  const first = acceptLanguage.split(',')[0].trim().toLowerCase()
  return first.startsWith('zh') ? 'zh' : 'en'
}

/** Token-only / no-auth deployments (design 21 §5.3): a minimal HTML
 * explanation page (no form) served with the same 404 status for browsers;
 * API clients still receive the JSON 404. The back link reuses the same-origin
 * `/`, whose reachability under token auth is unchanged. `variant` keeps the
 * copy honest per auth kind: 'token' deployments point at the shared token;
 * 'none' (`--no-auth`) deployments have no token and must not claim one
 * (design 17 §13.1 honest posture). */
export function renderTokenOnlyPage(lang: 'en' | 'zh', variant: 'token' | 'none' = 'token'): string {
  const copy = COPY[lang]
  const title = variant === 'none' ? copy.tokenOnlyTitleNone : copy.tokenOnlyTitle
  const body = variant === 'none' ? copy.tokenOnlyBodyNone : copy.tokenOnlyBody
  const pageBody = '  <main class="card">\n'
    + '    <h1>' + title + '</h1>\n'
    + '    <p class="subtitle">' + body + '</p>\n'
    + '    <a href="/" style="color:var(--dsw-alias-brand-primary)">' + copy.tokenOnlyBack + '</a>\n'
    + '  </main>'
  return pageShell(lang, pageBody)
}
