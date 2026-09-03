/**
 * HTML trust declaration for the proxied dsh frontend (S0).
 *
 * Product decision at the gateway trust boundary: a browser that reaches the
 * proxied HTML has already passed the gateway's login/credential gate, so the
 * document is served to a trusted viewer. The official dsh frontend keys its
 * settings/models/plugins host persistence off a documented client hook —
 * `transport.ownsHost` (where `transport = globalThis.__DSH_TRANSPORT__`,
 * isLoopback = ownsHost || …) — and this module declares that hook by
 * injecting a tiny inline script into the proxied index document before it is
 * streamed to the browser.
 *
 * This is NOT an auth bypass: the declaration only tells the official
 * frontend it may treat the page as host-owned; every request still crosses
 * the gateway's authenticated boundary, and no management surface is opened
 * on the managed dsh. The gateway's proxy CSP (dispatch.ts
 * GATEWAY_PROXY_CSP) already allows 'unsafe-inline' script-src, and upstream
 * response headers only cross via RESPONSE_HEADER_WHITELIST
 * (proxy-forward.ts, design 04 §4.3 — content-security-policy is not
 * forwarded), so the injected inline script is never blocked by an upstream
 * CSP. If upstream ever removes or renames the hook the injection silently
 * stops applying (fail-soft, page left untouched) and the settings surface
 * returns to its restricted state — nothing else breaks.
 */

/** The injected declaration: marks the page host-owned for the official dsh
 * frontend (ownsHost:true → isLoopback → 'host' persistence). Pure ASCII —
 * the proxy's content-length rewrite is an exact byte delta of this script. */
export const TRUST_DECLARATION_SCRIPT = '<script>window.__DSH_TRANSPORT__={ownsHost:true}</script>'

/** Documents larger than this are never rewritten (proxy-forward.ts
 * MAX_HTML_INJECTION_BYTES must stay equal — control-plane cannot import the
 * gateway package). */
export const HTML_INJECT_MAX_BYTES = 64 * 1024

export interface HtmlInjectResult {
  /** The document to serve: the injected document when `injected`, the
   * untouched original otherwise. */
  html: string
  /** Whether the trust declaration was inserted. */
  injected: boolean
}

/**
 * Insert TRUST_DECLARATION_SCRIPT before the first `</head>` (matched
 * case-insensitively). Fail-soft by design — every non-injectable input
 * returns the input untouched and never throws:
 *
 *  a. documents over HTML_INJECT_MAX_BYTES are skipped (the proxy streams
 *     them instead of buffering);
 *  b. documents that already carry `__DSH_TRANSPORT__` are skipped
 *     (idempotent — a re-injected page must not double-declare);
 *  c. documents without a `</head>` close tag are skipped;
 *  d. otherwise the declaration is inserted right before `</head>`.
 */
export function injectTrustDeclaration(html: string): HtmlInjectResult {
  if (html.length > HTML_INJECT_MAX_BYTES) return { html, injected: false }
  if (html.includes('__DSH_TRANSPORT__')) return { html, injected: false }
  const headClose = /<\/head>/i.exec(html)
  if (headClose === null) return { html, injected: false }
  const injected = `${html.slice(0, headClose.index)}${TRUST_DECLARATION_SCRIPT}${html.slice(headClose.index)}`
  return { html: injected, injected: true }
}
