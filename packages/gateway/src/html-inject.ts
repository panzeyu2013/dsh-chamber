/**
 * HTML head patches for the proxied dsh frontend.
 *
 * 1. TRUST: the official frontend keys host persistence off the
 *    `transport.ownsHost` hook (transport = globalThis.__DSH_TRANSPORT__),
 *    declared by injecting a tiny inline script into the index document before
 *    it is streamed.
 * 2. WEBKIT NORMALIZATION (design 14 §D4, design 17 §10.5): JavaScriptCore
 *    prints the source of BUILT-IN functions across multiple lines, while the
 *    pinned `@deepseek-ai/dsh-util-values` `hasIntrinsicConstructor` compares
 *    that text against a single-line template. Under WebKit the comparison is
 *    always false, so `snapshotJsonValue` returns `undefined` for plain
 *    objects/arrays, the session's raw-chunk guard throws a plain TypeError, and
 *    the official frontend parks on `loadingHistory` forever. The chamber-built
 *    frontend carries a build-time vendor patch
 *    (`packages/renderer/scripts/vendor-patches.mjs`, third class); the proxied
 *    OFFICIAL frontend cannot be rebuilt here, so this page-level normalization
 *    makes the engine print the canonical single-line form for native code only
 *    (V8 already does). User functions are returned untouched: the rewrite fires
 *    only when the WHOLE source is a native-code marker.
 *
 * TRADE-OFF: the page's `Function.prototype.toString` output for native
 * functions becomes canonical instead of engine-native. DELETE CONDITION:
 * upstream carries an engine-independent predicate
 * (`docs/progress/todo/upstream-proposals.md` §9) or the supported WebKit
 * baseline prints the single-line form; the shim is then dead weight.
 *
 * NOT an auth bypass: the browser already passed the gateway's credential gate.
 * The proxy CSP allows 'unsafe-inline' script-src and upstream headers only cross
 * via the response-header whitelist (CSP is not forwarded), so the scripts are
 * never blocked; if upstream renames the hook the injection fail-softly stops
 * applying.
 */

import { MAX_HTML_INJECTION_BYTES } from '@dsh-chamber/control-plane'

/** The injected declaration (ownsHost:true → isLoopback → 'host' persistence).
 *  Pure ASCII: the content-length rewrite is this exact byte delta. */
export const TRUST_DECLARATION_SCRIPT = '<script>window.__DSH_TRANSPORT__={ownsHost:true}</script>'

/** Idempotence marker, unique to {@link NATIVE_STRING_NORMALIZER_SCRIPT}. */
const NATIVE_STRING_MARKER = '__dshNativeToStringGuard'

/**
 * Canonicalize a native-code source whichever way the engine prints it. Pure
 * ASCII and free of `</script>`; a no-op on V8, a whitespace normalization on
 * WebKit. The regex admits only a source that IS a native-code marker, so user
 * function sources pass through untouched.
 */
export const NATIVE_STRING_NORMALIZER_SCRIPT =
  '<script>(function(){var ' + NATIVE_STRING_MARKER + '=Function.prototype.toString,'
  + '__dshNativeForm=/^\\s*function[^{]*\\{\\s*\\[native code\\]\\s*\\}\\s*$/;'
  + 'Function.prototype.toString=function(){var __dshText=' + NATIVE_STRING_MARKER + '.call(this);'
  + 'return typeof __dshText==="string"&&__dshNativeForm.test(__dshText)'
  + '?__dshText.replace(/\\s+/g," ").trim():__dshText}})()</script>'

export interface HtmlInjectResult {
  /** The document to serve: injected when `injected`, untouched otherwise. */
  html: string
  /** Whether at least one head patch was inserted. */
  injected: boolean
}

/**
 * Insert the missing head patches before the first `</head>`
 * (case-insensitive). Each patch is independently idempotent, so a document that
 * already declares the transport hook still receives the WebKit normalization.
 * Fail-soft by design — never throws, every non-injectable input returns the
 * input untouched: oversized documents (the proxy streams them), documents
 * without a `</head>` close tag, and documents already carrying every patch.
 */
export function injectDocumentHeadPatches(html: string): HtmlInjectResult {
  if (html.length > MAX_HTML_INJECTION_BYTES) return { html, injected: false }
  const headClose = /<\/head>/i.exec(html)
  if (headClose === null) return { html, injected: false }
  const missing = [
    ...(html.includes('__DSH_TRANSPORT__') ? [] : [TRUST_DECLARATION_SCRIPT]),
    ...(html.includes(NATIVE_STRING_MARKER) ? [] : [NATIVE_STRING_NORMALIZER_SCRIPT]),
  ]
  if (missing.length === 0) return { html, injected: false }
  const injected = `${html.slice(0, headClose.index)}${missing.join('')}${html.slice(headClose.index)}`
  return { html: injected, injected: true }
}
