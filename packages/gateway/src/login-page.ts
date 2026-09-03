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
 * Request-boundary error page: dispatch.ts renders renderBoundaryErrorPage
 * when a request is rejected at the gateway request policy (400/403/421)
 * and the visitor is a browser (HTML Accept, GET/HEAD/POST). JSON/API
 * clients keep the plain JSON error + a non-secret `detail`. The page reuses
 * the same token layer/component styles and shares every invariant above:
 * no scripts, no echoed credentials (there are none), echoed request
 * values are HTML-escaped, and the copy tables stay in sync (en/zh).
 *
 * Appearance (2026-07 user request; 2026-09 restyle): the page follows the
 * browser display mode — a `prefers-color-scheme: light` palette override on
 * top of the dark design-token layer — plus autofill styling, focus rings,
 * reduced motion, and mobile viewport handling. Both palettes are sampled
 * from the official `@deepseek-ai/dsh-client-ui-theme` static scales/alias
 * maps (bluish neutrals + deepseek-blue brand/primary — the "dsh blue" look;
 * the earlier GitHub-dark/green palette was replaced 2026-09 per user
 * request). Self-declared so the pre-auth page depends on nothing beyond
 * this file (C5).
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
  /** The mobile-UA shunting escape (design 17 §18): true when the visitor
   * arrived via /?desktop=1, carried through the login round-trip so the
   * post-login redirect lands back on the desktop entry instead of being
   * shunted again. Boolean marker only — no free-form return path (no
   * open-redirect surface). */
  desktop?: boolean
}

/** Login-page CSP (design 21 §7.2): `img-src data:` is the only sanctioned
 * increment over design 17 §7.1 — the inline SVG favicon/brand marks.
 * `script-src` stays absent (C1). Shared by the boundary error page. */
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

/** Boundary error page copy (en/zh). The reason templates interpolate the
 * request's own non-secret values (Host/Origin) — never configuration or
 * credentials. The values are HTML-escaped by the renderer before
 * substitution. Kept as one typed table per language like COPY. */
interface BoundaryCopy {
  deniedTitle: string
  explainMalformed: string
  explainHostNone: string
  explainHost: string // {host}
  explainOriginInvalid: string // {origin}
  explainOriginMismatch: string // {origin} {authority}
  explainCrossSite: string
  tipAddress: string
  tipProxy: string
  tipCors: string
  tipDirect: string
}

const BOUNDARY_COPY: Record<Lang, BoundaryCopy> = {
  en: {
    deniedTitle: 'Access denied',
    explainMalformed: 'This gateway rejected the request because its header lines were malformed or duplicated. Duplicate security-sensitive headers are always refused.',
    explainHostNone: 'The request did not carry a Host header this gateway can accept.',
    explainHost: 'The requested host <code>{host}</code> is not an address this gateway serves. Only its own loopback or private-network address on the gateway port is accepted — or the exact <code>--public-origin</code> when a reverse proxy fronts it.',
    explainOriginInvalid: 'The origin <code>{origin}</code> sent with this request is not a valid browser origin.',
    explainOriginMismatch: 'This page is being loaded from <code>{origin}</code>, but the request reaches the gateway at <code>{authority}</code>. The gateway only accepts same-origin browser requests; cross-site callers need an explicit <code>--cors-origin</code> entry.',
    explainCrossSite: 'This request came from another site and carried no Origin header. Cross-site requests without an Origin cannot be told apart from attacks and are rejected.',
    tipAddress: 'Check that the address in the browser matches the address shown by the gateway installer, including the port.',
    tipProxy: 'When the gateway sits behind a reverse proxy, start it with <code>--public-origin</code> and <code>--trusted-proxy</code>, and make the proxy forward the original Host and X-Forwarded-* headers.',
    tipCors: 'Automated cross-site callers must be allow-listed with <code>--cors-origin</code>.',
    tipDirect: 'Open the gateway by typing its address into the address bar (or from a bookmark) instead of following links on other sites.',
  },
  zh: {
    deniedTitle: '访问被拒绝',
    explainMalformed: '网关拒绝了该请求：请求头存在重复或畸形字段。涉及安全的请求头不允许重复出现。',
    explainHostNone: '请求未携带网关可接受的 Host 头。',
    explainHost: '请求的 Host <code>{host}</code> 不是本网关服务的地址。仅接受网关端口上的本机或内网地址；若置于反向代理之后，则需精确配置 <code>--public-origin</code>。',
    explainOriginInvalid: '请求携带的 Origin “<code>{origin}</code>” 不是合法的浏览器来源。',
    explainOriginMismatch: '页面来源是 <code>{origin}</code>，而请求到达网关的地址是 <code>{authority}</code>。网关只接受同源浏览器请求；跨站调用方需要显式 <code>--cors-origin</code> 配置。',
    explainCrossSite: '该请求来自其他站点且未携带 Origin 头。无 Origin 的跨站请求无法与攻击行为区分，因此被拒绝。',
    tipAddress: '请确认浏览器中的地址与网关安装脚本输出的地址一致（含端口）。',
    tipProxy: '若网关位于反向代理之后，需要以 <code>--public-origin</code> 和 <code>--trusted-proxy</code> 启动，并确保代理传递原始 Host 与 X-Forwarded-* 请求头。',
    tipCors: '自动化跨站调用方需通过 <code>--cors-origin</code> 显式加入允许列表。',
    tipDirect: '请在地址栏直接输入网关地址或从书签打开，而不要从其它站点的链接进入。',
  },
}

/** The gateway reason kinds produced by middleware.ts's request policy. The
 * login page stays dependency-free, so dispatch maps the middleware's typed
 * reason onto this enum + optional values. */
export type BoundaryReasonKind =
  | 'malformed_headers'
  | 'host_rejected'
  | 'origin_invalid'
  | 'origin_mismatch'
  | 'cross_site_no_origin'

export interface BoundaryErrorPageOptions {
  lang: 'en' | 'zh'
  /** The rejection status: 400 | 403 | 421. */
  status: number
  code: 'bad_request' | 'misdirected_request' | 'origin_forbidden'
  reasonKind: BoundaryReasonKind
  /** Request-supplied values echoed back (non-secret, HTML-escaped). */
  host?: string
  origin?: string
  authority?: string
}

/** dsh design-token layer: values sampled from the official
 * `@deepseek-ai/dsh-client-ui-theme` static scales and alias maps — the bluish
 * neutral ramp for surfaces/labels, the deepseek-blue ramp for brand and the
 * primary action, amber/red/green ramps for the semantic states. Self-declared
 * so the pre-auth page depends on nothing beyond this file (C5). The page
 * follows the browser display mode: `prefers-color-scheme: light` swaps in
 * the full light palette (same variable names) and flips `color-scheme` so
 * native widgets match. Browsers without media-query color-scheme support
 * keep the dark layer. */
const TOKEN_LAYER = `:root {
  color-scheme: dark;
  --dsw-alias-bg-base: #151517;
  --dsw-alias-bg-layer-1: #232324;
  --dsw-alias-bg-layer-2: #2c2c2e;
  --dsw-alias-bg-layer-3: #353638;
  --dsw-alias-border-l2: rgba(97, 102, 107, 0.35);
  --dsw-alias-border-l3: rgba(97, 102, 107, 0.55);
  --dsw-alias-label-primary: #f9fafb;
  --dsw-alias-label-tertiary: #adb2b8;
  --dsw-alias-state-error-primary: #f25a5a;
  --dsw-alias-state-error-bg: #f25a5a;
  --dsw-alias-state-warn-primary: #f59e0b;
  --dsw-alias-brand-primary: #679efe;
  --dsw-alias-button-primary-fill: #679efe;
  --dsw-alias-button-primary-hover: #5686fe;
  --dsw-alias-state-success-primary: #22c55e;
  --dsw-login-label-secondary: #cfd3d6;
  --dsw-login-warn-text: #f59e0b;
  --dsw-login-control-border: rgba(97, 102, 107, 0.6);
  --dsw-login-button-text: #0f1115;
  --dsw-login-card-shadow: 0 24px 48px -24px rgba(0, 0, 0, 0.55);
  --dsw-login-glow-a: rgba(103, 158, 254, 0.14);
  --dsw-login-glow-b: rgba(86, 134, 254, 0.06);
  --dsw-login-focus-ring: rgba(103, 158, 254, 0.42);
  --dsw-login-focus-ring-error: rgba(242, 90, 90, 0.4);
  --dsw-login-error-border: rgba(242, 90, 90, 0.45);
  --dsw-login-error-bg: rgba(242, 90, 90, 0.12);
  --dsw-login-warn-border: rgba(245, 158, 11, 0.45);
  --dsw-login-warn-bg: rgba(245, 158, 11, 0.12);
  --dsw-login-neutral-border: rgba(249, 250, 251, 0.16);
  --dsw-login-neutral-bg: rgba(249, 250, 251, 0.05);
  --dsw-login-code-bg: rgba(249, 250, 251, 0.08);
}
@media (prefers-color-scheme: light) {
:root {
  color-scheme: light;
  --dsw-alias-bg-base: #f9fafb;
  --dsw-alias-bg-layer-1: #ffffff;
  --dsw-alias-bg-layer-2: #ffffff;
  --dsw-alias-bg-layer-3: #e9ecf2;
  --dsw-alias-border-l2: #e1e5ee;
  --dsw-alias-border-l3: #cfd3d6;
  --dsw-alias-label-primary: #0f1115;
  --dsw-alias-label-tertiary: #81858c;
  --dsw-alias-state-error-primary: #ec1313;
  --dsw-alias-state-error-bg: #ec1313;
  --dsw-alias-state-warn-primary: #dd8629;
  --dsw-alias-brand-primary: #4176e6;
  --dsw-alias-button-primary-fill: #4176e6;
  --dsw-alias-button-primary-hover: #4868b2;
  --dsw-alias-state-success-primary: #22c55e;
  --dsw-login-label-secondary: #61666b;
  --dsw-login-warn-text: #dd8629;
  --dsw-login-control-border: #cfd3d6;
  --dsw-login-button-text: #ffffff;
  --dsw-login-card-shadow: 0 16px 40px -18px rgba(15, 17, 21, 0.16);
  --dsw-login-glow-a: rgba(65, 118, 230, 0.09);
  --dsw-login-glow-b: rgba(86, 134, 254, 0.06);
  --dsw-login-focus-ring: rgba(65, 118, 230, 0.3);
  --dsw-login-focus-ring-error: rgba(236, 19, 19, 0.24);
  --dsw-login-error-border: rgba(236, 19, 19, 0.35);
  --dsw-login-error-bg: rgba(236, 19, 19, 0.07);
  --dsw-login-warn-border: rgba(221, 134, 41, 0.4);
  --dsw-login-warn-bg: rgba(221, 134, 41, 0.1);
  --dsw-login-neutral-border: rgba(15, 17, 21, 0.14);
  --dsw-login-neutral-bg: rgba(15, 17, 21, 0.04);
  --dsw-login-code-bg: rgba(15, 17, 21, 0.06);
}
}`

/** Inline SVG brand mark (data URI — the only sanctioned image source beyond
 * the favicon). Rounded tile with the dsh deepseek-blue gradient and a light
 * ring, echoing the favicon shape. */
const BRAND_MARK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='b' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23679efe'/%3E%3Cstop offset='1' stop-color='%234176e6'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='32' height='32' rx='9' fill='url(%23b)'/%3E%3Ccircle cx='16' cy='16' r='6.5' fill='none' stroke='%23f9fafb' stroke-opacity='0.95' stroke-width='2.6'/%3E%3C/svg%3E"

/** Inline SVG mark for the boundary (denied) page: amber rounded tile with
 * an exclamation — neutral enough for both display modes. */
const DENIED_MARK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='w' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23f59e0b'/%3E%3Cstop offset='1' stop-color='%23dd8629'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='32' height='32' rx='9' fill='url(%23w)'/%3E%3Cpath d='M16 9.5v9.5' stroke='%23fff' stroke-width='3' stroke-linecap='round'/%3E%3Ccircle cx='16' cy='23.4' r='1.7' fill='%23fff'/%3E%3C/svg%3E"

/** Component styles (design 21 §4.2): card = .panel, input = .custom input,
 * button = button.primary equivalents over the dsh token layer, extended
 * with the light-mode palette variables, autofill theming, focus rings, the
 * brand header and the boundary-page elements. */
const COMPONENT_STYLES = `*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;padding:2rem 1.25rem;background-color:var(--dsw-alias-bg-base);background-image:radial-gradient(56rem 34rem at 50% -14rem,var(--dsw-login-glow-a),transparent 70%),radial-gradient(40rem 26rem at 88% 112%,var(--dsw-login-glow-b),transparent 72%);background-repeat:no-repeat;background-attachment:fixed;color:var(--dsw-alias-label-primary);font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
main.card{width:100%;max-width:24rem;margin:auto;display:flex;flex-direction:column;gap:1.05rem;padding:1.75rem;border:1px solid var(--dsw-alias-border-l2);border-radius:1rem;background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-login-card-shadow)}
.brand{display:flex;flex-direction:column;align-items:center;gap:.85rem;text-align:center}
.brand .mark{width:2.75rem;height:2.75rem;display:block}
h1{margin:0;display:flex;align-items:baseline;justify-content:center;gap:.45rem;font-size:1.35rem;font-weight:650;letter-spacing:-.01em;line-height:1.25}
.wordmark-sub{font-weight:500;color:var(--dsw-alias-label-tertiary)}
.subtitle{margin:0;font-size:.88rem;line-height:1.5;color:var(--dsw-alias-label-tertiary);text-align:center}
.banner{margin:0;padding:.65rem .8rem;border:1px solid var(--dsw-login-neutral-border);border-radius:.65rem;background:var(--dsw-login-neutral-bg);font-size:.875rem;line-height:1.5;color:var(--dsw-alias-label-primary)}
.banner.error{border-color:var(--dsw-login-error-border);background:var(--dsw-login-error-bg);color:var(--dsw-alias-state-error-primary)}
.banner.warn{border-color:var(--dsw-login-warn-border);background:var(--dsw-login-warn-bg);color:var(--dsw-login-warn-text)}
.hint{margin:0;font-size:.82rem;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
form{display:flex;flex-direction:column;gap:.6rem}
label.field{display:flex;flex-direction:column;gap:.35rem;font-size:.83rem;font-weight:500;color:var(--dsw-login-label-secondary)}
#password{width:100%;min-height:2.5rem;padding:.55rem .7rem;border:1px solid var(--dsw-login-control-border);border-radius:.55rem;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:1rem;caret-color:var(--dsw-alias-brand-primary);transition:border-color .12s ease,box-shadow .12s ease}
#password:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px var(--dsw-login-focus-ring)}
#password[aria-invalid="true"]{border-color:var(--dsw-login-error-border)}
#password[aria-invalid="true"]:focus{border-color:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 3px var(--dsw-login-focus-ring-error)}
#password:-webkit-autofill,#password:-webkit-autofill:hover,#password:-webkit-autofill:focus{-webkit-text-fill-color:var(--dsw-alias-label-primary);-webkit-box-shadow:0 0 0 1000px var(--dsw-alias-bg-layer-1) inset;box-shadow:0 0 0 1000px var(--dsw-alias-bg-layer-1) inset;transition:background-color 999999s ease-in-out 0s}
button[type="submit"]{width:100%;min-height:2.5rem;padding:.55rem .8rem;border:1px solid transparent;border-radius:.55rem;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-login-button-text);font:inherit;font-weight:600;letter-spacing:.01em;cursor:pointer;transition:background-color .12s ease}
button[type="submit"]:hover{background:var(--dsw-alias-button-primary-hover)}
button[type="submit"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
button[type="submit"]:active{transform:translateY(1px)}
.badge{margin:0;font-size:.78rem;text-align:center;color:var(--dsw-alias-state-success-primary)}
a.back-link{display:inline-flex;align-items:center;justify-content:center;align-self:center;min-height:2.25rem;padding:.45rem 1rem;border:1px solid var(--dsw-login-control-border);border-radius:.55rem;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:.85rem;text-decoration:none;transition:border-color .12s ease}
a.back-link:hover{border-color:var(--dsw-alias-brand-primary)}
a.back-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85em;padding:.1rem .35rem;border-radius:.3rem;background:var(--dsw-login-code-bg);color:var(--dsw-alias-label-primary);word-break:break-all}
.tips{margin:0;padding-left:1.15rem;display:flex;flex-direction:column;gap:.5rem;font-size:.82rem;line-height:1.55;color:var(--dsw-login-label-secondary)}
.meta{margin:0;padding-top:.8rem;border-top:1px solid var(--dsw-alias-border-l2);font-size:.72rem;letter-spacing:.03em;text-align:center;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
@media (max-width:480px){body{padding:1rem .75rem}main.card{padding:1.35rem;border-radius:.8rem}}
@media (max-height:560px){body{padding:1.25rem .75rem}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}`

/** Full self-contained document shell: charset, viewport, theme-color for
 * both display modes, title, inline SVG data: favicon (the `img-src data:`
 * CSP increment, design 21 §7.2), inline styles, and the given body. Never
 * emits external URLs or script elements. */
function pageShell(lang: Lang, title: string, body: string): string {
  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f9fafb">
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#151517">
  <title>${title}</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cdefs%3E%3ClinearGradient id='b' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23679efe'/%3E%3Cstop offset='1' stop-color='%234176e6'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='16' height='16' rx='4.5' fill='url(%23b)'/%3E%3Ccircle cx='8' cy='8' r='3.2' fill='none' stroke='%23f9fafb' stroke-width='1.6'/%3E%3C/svg%3E">
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

/** Minimal HTML escaping for every echoed request value (Host/Origin). The
 * values originate from untrusted HTTP headers, so `&<>"'` must never reach
 * the output unescaped (an Origin value that looks like markup is text). */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Cap echoed header values: they are diagnostic-only and could be long. */
function shortValue(value: string, max = 160): string {
  return value.length <= max ? value : value.slice(0, max) + '…'
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
  // The action carries the desktop marker when present: the POST URL's query
  // is what the dispatch success handler reads to redirect back to /?desktop=1.
  const action = opts.desktop === true ? '/auth/login?desktop=1' : '/auth/login'
  return '<form method="post" action="' + action + '">\n'
    + '  <label class="field" for="password">' + copy.passwordLabel + '</label>\n'
    + '  <input id="password" name="password" type="password" autocomplete="current-password"'
    + ' required maxlength="1024" autocapitalize="off" spellcheck="false" autocorrect="off"'
    + ' autofocus' + invalidAttrs + '>\n'
    + '  <button type="submit">' + copy.submit + '</button>\n'
    + '</form>'
}

/** Brand header block (mark + wordmark) shared by the login and token-only
 * cards. The mark is decorative (alt="") — the h1 is the real label. */
function brandHeader(inner: string, mark: string): string {
  return '<div class="brand">\n'
    + '  <img class="mark" src="' + mark + '" width="44" height="44" alt="">\n'
    + '  <h1>' + inner + '</h1>\n'
    + '</div>'
}

/** Render the pre-auth login page (design 21 §5.2). Stacking order: brand →
 * plaintext warning (secure=false) → error banner (invalid/rate_limited/busy)
 * → expired hint (expired) → form → secure badge (secure=true). */
export function renderLoginPage(opts: LoginPageOptions): string {
  const copy = COPY[opts.lang]
  const showError = opts.error === 'invalid' || opts.error === 'rate_limited' || opts.error === 'busy'
  const parts: string[] = []

  parts.push(brandHeader('dsh <span class="wordmark-sub">' + copy.wordmarkSub + '</span>', BRAND_MARK))
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
  return pageShell(opts.lang, copy.title, body)
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
    + indentLines(brandHeader(title, BRAND_MARK), 4) + '\n'
    + '    <p class="subtitle">' + body + '</p>\n'
    + '    <a class="back-link" href="/">' + copy.tokenOnlyBack + '</a>\n'
    + '  </main>'
  return pageShell(lang, copy.title, pageBody)
}

/** Render the request-boundary error page (400/403/421) for browsers whose
 * request was rejected at the gateway request policy. Only request-supplied
 * non-secret values are echoed, HTML-escaped and length-capped; the page
 * carries the same no-script CSP and never contains a form or a value=
 * attribute. See dispatch.ts for the content negotiation that selects it. */
export function renderBoundaryErrorPage(opts: BoundaryErrorPageOptions): string {
  const copy = COPY[opts.lang]
  const boundary = BOUNDARY_COPY[opts.lang]
  const parts: string[] = []

  parts.push(brandHeader(boundary.deniedTitle, DENIED_MARK))

  const host = opts.host === undefined ? undefined : escapeHtml(shortValue(opts.host))
  const origin = opts.origin === undefined ? undefined : escapeHtml(shortValue(opts.origin))
  const authority = opts.authority === undefined ? undefined : escapeHtml(shortValue(opts.authority))

  let explanation: string
  switch (opts.reasonKind) {
    case 'malformed_headers':
      explanation = boundary.explainMalformed
      break
    case 'host_rejected':
      explanation = host === undefined
        ? boundary.explainHostNone
        : boundary.explainHost.replace('{host}', host)
      break
    case 'origin_invalid':
      explanation = boundary.explainOriginInvalid.replace('{origin}', origin ?? '')
      break
    case 'origin_mismatch':
      explanation = boundary.explainOriginMismatch
        .replace('{origin}', origin ?? '')
        .replace('{authority}', authority ?? '')
      break
    case 'cross_site_no_origin':
      explanation = boundary.explainCrossSite
      break
  }
  parts.push('<p class="banner">' + explanation + '</p>')

  const tips: string[] = [boundary.tipAddress]
  if (opts.reasonKind === 'host_rejected') tips.push(boundary.tipProxy)
  if (opts.reasonKind === 'origin_mismatch' || opts.reasonKind === 'origin_invalid') tips.push(boundary.tipCors)
  if (opts.reasonKind === 'cross_site_no_origin') tips.push(boundary.tipDirect)
  parts.push('<ul class="tips">\n'
    + tips.map(tip => '    <li>' + tip + '</li>').join('\n')
    + '\n  </ul>')
  parts.push('<p class="meta">HTTP ' + opts.status + ' &middot; ' + opts.code + ' &middot; dsh gateway</p>')

  const body = '  <main class="card">\n' + indentLines(parts.join('\n'), 4) + '\n  </main>'
  return pageShell(opts.lang, copy.title, body)
}
