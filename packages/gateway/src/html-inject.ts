/**
 * HTML trust declaration for the proxied dsh frontend: the official frontend
 * keys host persistence off the `transport.ownsHost` hook (transport =
 * globalThis.__DSH_TRANSPORT__), declared by injecting a tiny inline script
 * into the index document before it is streamed.
 *
 * NOT an auth bypass: the browser already passed the gateway's credential gate.
 * The proxy CSP allows 'unsafe-inline' script-src and upstream headers only cross
 * via the response-header whitelist (CSP is not forwarded), so the script is never
 * blocked; if upstream renames the hook the injection fail-softly stops applying.
 */

import { MAX_HTML_INJECTION_BYTES } from '@dsh-chamber/control-plane'

/** The injected declaration (ownsHost:true → isLoopback → 'host' persistence).
 * Pure ASCII: the content-length rewrite is this exact byte delta. */
export const TRUST_DECLARATION_SCRIPT = '<script>window.__DSH_TRANSPORT__={ownsHost:true}</script>'

export interface HtmlInjectResult {
  /** The document to serve: injected when `injected`, untouched otherwise. */
  html: string
  /** Whether the trust declaration was inserted. */
  injected: boolean
}

/**
 * Insert TRUST_DECLARATION_SCRIPT before the first `</head>` (case-insensitive).
 * Fail-soft by design — never throws, every non-injectable input returns the
 * input untouched: oversized documents (the proxy streams them), documents
 * already carrying `__DSH_TRANSPORT__` (idempotent), and documents without a
 * `</head>` close tag are all skipped.
 */
export function injectTrustDeclaration(html: string): HtmlInjectResult {
  if (html.length > MAX_HTML_INJECTION_BYTES) return { html, injected: false }
  if (html.includes('__DSH_TRANSPORT__')) return { html, injected: false }
  const headClose = /<\/head>/i.exec(html)
  if (headClose === null) return { html, injected: false }
  const injected = `${html.slice(0, headClose.index)}${TRUST_DECLARATION_SCRIPT}${html.slice(headClose.index)}`
  return { html: injected, injected: true }
}