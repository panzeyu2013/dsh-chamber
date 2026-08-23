/**
 * Frontend middleware (design 16 §9): the HTML injection points for the
 * proxied dsh frontend. Because the gateway streams dsh's HTML (no buffer/
 * rewrite), the injection surface is deliberately minimal:
 *
 *   - viewport: dsh's index.html already carries `<meta name="viewport">`
 *     (the design's own note), so injection is an idempotent no-op.
 *   - CSP nonce (S14): handled in dispatch.ts as a scoped `script-src`
 *     relax — the proxy cannot backfill the per-response nonce into dsh's
 *     streamed HTML, so it MUST NOT send the nonce CSP (relax instead).
 *   - PWA link / theme-color / sw-register / shellNav: P4 (the design marks
 *     these 远期). The static assets they point to are served at /chamber/*
 *     (routes.ts); the HTML `<link>`/`<script>` injection itself is a buffer+
 *     rewrite on `</head>`/`</body>` anchors and is deferred with P4.
 */

/** The canonical viewport meta (for completeness; dsh already emits one). */
export const GATEWAY_VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1">'
