/**
 * HTML head patch for the proxied dsh frontend.
 *
 * TRUST: the official frontend keys host persistence off the
 * `transport.ownsHost` hook (transport = globalThis.__DSH_TRANSPORT__),
 * declared by injecting a tiny inline script into the index document before
 * it is streamed.
 *
 * The former second patch (WebKit `Function.prototype.toString` normalization,
 * design 14 §D4 / design 17 §10.5) was DELETED when the minimum supported
 * runtime was raised to 0.2.0-rc.1: that runtime's `hasIntrinsicConstructor`
 * compares engine-independently, so the proxied official frontend no longer
 * needs the page-level shim (the chamber-built frontend's build-time vendor
 * patch was retired with the same upstream fix). The trade-off — native sources
 * printed canonically instead of engine-native — is gone with it.
 *
 * NOT an auth bypass: the browser already passed the gateway's credential gate.
 * The proxy CSP allows 'unsafe-inline' script-src and upstream headers only cross
 * via the response-header whitelist (CSP is not forwarded), so the script is
 * never blocked; if upstream renames the hook the injection fail-softly stops
 * applying.
 */

import { MAX_HTML_INJECTION_BYTES } from '@dsh-chamber/control-plane'

/** The injected declaration (ownsHost:true → isLoopback → 'host' persistence).
 *  Pure ASCII: the content-length rewrite is this exact byte delta. */
export const TRUST_DECLARATION_SCRIPT = '<script>window.__DSH_TRANSPORT__={ownsHost:true}</script>'

export interface HtmlInjectResult {
  /** The document to serve: injected when `injected`, untouched otherwise. */
  html: string
  /** Whether the head patch was inserted. */
  injected: boolean
}

/**
 * Insert the missing head patch before the first `</head>` (case-insensitive).
 * Idempotent, so a document that already declares the transport hook is
 * forwarded untouched. Fail-soft by design — never throws, every non-injectable
 * input returns the input untouched: oversized documents (the proxy streams
 * them) and documents without a `</head>` close tag.
 */
export function injectDocumentHeadPatches(html: string): HtmlInjectResult {
  if (html.length > MAX_HTML_INJECTION_BYTES) return { html, injected: false }
  const headClose = /<\/head>/i.exec(html)
  if (headClose === null) return { html, injected: false }
  if (html.includes('__DSH_TRANSPORT__')) return { html, injected: false }
  const injected = `${html.slice(0, headClose.index)}${TRUST_DECLARATION_SCRIPT}${html.slice(headClose.index)}`
  return { html: injected, injected: true }
}
