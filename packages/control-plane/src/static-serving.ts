/**
 * Static frontend service (design 05 §3.3 / 04 §5): dist/ + __DSH_BOOT__.
 *
 * createStaticServing assembles the pure static-serve surface over a
 * webDistDir: MIME resolution, on-the-fly gzip (with a tiny per-file cache),
 * the SPA fallback to the injected shell, and the __DSH_BOOT__ manifest
 * injection. Anonymous like every other surface (v1 has no authentication).
 *
 * The module owns no HTTP server and no security-header policy — those stay
 * with the control-plane request handler (index.ts), which mints the
 * per-response CSP nonce (`res._cspNonce`) and sets the browser boundary
 * headers before dispatch. It only reads the two private per-request
 * channels: `_cspNonce` (the __DSH_BOOT__ inline-script nonce) and
 * `_corsHeaders` (the CORS decision spread on every write).
 *
 * Response behavior is byte-identical to the pre-extraction inline service.
 */

import { extname, join, resolve, sep } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import type { Logger } from './types.ts'
import type { ApiRequest, ApiResponse } from './api.ts'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/**
 * Static types gzip'd on the fly (text-like payloads where gzip helps —
 * html/css/js/map/json/svg; woff2 rides along for literal compliance, it is
 * already brotli-compressed so gzip gains nothing but costs ~nothing on a
 * loopback server, and each file is compressed once per relaunch). Binary
 * image formats are excluded (already compressed; gzip would waste CPU).
 */
const COMPRESSIBLE_TYPES = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map', '.woff2'])

/** FIFO cap of the per-file gzip cache (memory bound: one compressed asset). */
const GZIP_CACHE_MAX = 64

/** createStaticServing options. */
export interface StaticServingOptions {
  /** The built frontend dist directory (must exist; the plane validates it). */
  webDistDir: string
  /** Sink for gzip-failure warnings (optional; absent = silent). */
  logger?: Logger
}

/** The assembled static-serve surface. */
export interface StaticServing {
  /**
   * Serve a static path (or the injected index.html SPA fallback) on the
   * response. Throws on a missing CSP nonce for the manifest-injected shell;
   * the owning handler answers 500 for any throw beyond the guarded races.
   */
  serve(req: ApiRequest, res: ApiResponse, pathname: string): void
}

/**
 * Assemble the static frontend service over one dist directory.
 * @param options - {webDistDir, logger?}.
 * @returns {serve(req, res, pathname)} — the static dispatch.
 */
export function createStaticServing({ webDistDir, logger }: StaticServingOptions): StaticServing {
  /**
   * Tiny on-the-fly gzip cache keyed by path+mtime (LCP perf pass): immutable
   * hash-named assets under /assets/ are gzipped once per build — the default
   * Electron session keeps a disk HTTP cache, so the immutable policy below
   * serves those assets from cache across relaunches and the server re-encodes
   * one only when a request actually misses that cache; the path+mtime key
   * makes that a single gzipSync per file per server lifetime. FIFO cap
   * bounds memory (each entry is one compressed asset). index.html is NOT
   * served through this cache: its content is re-injected with __DSH_BOOT__
   * per request (manifest rev can change without index.html's mtime moving),
   * so it is gzipped per request from the in-memory (already-injected) buffer
   * instead.
  */
  const gzipCache = new Map<string, Buffer>()
  function readGzipCached(path: string): { data: Buffer; encoded: boolean; error?: unknown } {
    const stat = statSync(path)
    const key = `${path}:${stat.mtimeMs}:${stat.size}`
    const hit = gzipCache.get(key)
    if (hit !== undefined) return { data: hit, encoded: true }
    const source = readFileSync(path)
    let compressed: Buffer
    try {
      compressed = gzipSync(source)
    } catch (error) {
      return { data: source, encoded: false, error }
    }
    if (gzipCache.size >= GZIP_CACHE_MAX) {
      const oldest = gzipCache.keys().next().value
      if (oldest !== undefined) gzipCache.delete(oldest)
    }
    gzipCache.set(key, compressed)
    return { data: compressed, encoded: true }
  }

  /**
   * Whether the request's Accept-Encoding accepts gzip (RFC 9110 q-value
   * aware): a bare `gzip` (or `gzip;q=0.5`) accepts it, `gzip;q=0` explicitly
   * refuses it, and anything else (deflate/br-only, identity, absent) does not
   * accept it.
   */
  function acceptsGzip(req: ApiRequest): boolean {
    const header = req.headers['accept-encoding']
    if (typeof header !== 'string') return false
    for (const part of header.split(',')) {
      const [token, ...params] = part.split(';').map(s => s.trim().toLowerCase())
      if (token !== 'gzip') continue
      let quality = 1
      for (const param of params) {
        const match = /^q=([0-9.]+)$/.exec(param)
        if (match !== null) {
          const parsed = Number(match[1])
          if (Number.isFinite(parsed)) quality = parsed
        }
      }
      return quality > 0
    }
    return false
  }

  /** Resolve a static path inside webDistDir; null on any escape. */
  function resolveStatic(filePath: string): string | null {
    const resolved = resolve(webDistDir, `.${filePath}`)
    if (resolved !== resolve(webDistDir) && !resolved.startsWith(`${resolve(webDistDir)}${sep}`)) return null
    return resolved
  }

  /** Read the __DSH_BOOT__ manifest (<dist>/manifest.json); null when absent. */
  function readBootManifest(): unknown | null {
    try {
      return JSON.parse(readFileSync(join(webDistDir, 'manifest.json'), 'utf8'))
    } catch {
      return null
    }
  }

  /** Serve a static file (or index.html fallback) on the response. */
  function serveStatic(req: ApiRequest, res: ApiResponse, pathname: string) {
    let candidate = pathname === '/' ? '/index.html' : pathname
    // SPA fallback: unknown paths render index.html (04 §5), except paths
    // that look like real assets (missing assets answer 404 — a frontend
    // build error must not masquerade as the shell).
    const path = resolveStatic(candidate)
    if (path === null) {
      jsonStaticError(res, 404, 'not_found')
      return
    }
    let data: Buffer | null = null
    let gzipAttempted = false
    let gzipEncoded = false
    try {
      const wantsCachedGzip = candidate !== '/index.html'
        && COMPRESSIBLE_TYPES.has(extname(candidate).toLowerCase())
        && acceptsGzip(req)
      if (wantsCachedGzip) {
        gzipAttempted = true
        const payload = readGzipCached(path)
        data = payload.data
        gzipEncoded = payload.encoded
        if (payload.error !== undefined) {
          logger?.warn(`static gzip failed for ${candidate}: ${String(payload.error)}`)
        }
      } else {
        data = readFileSync(path)
      }
    } catch {
      const ext = extname(candidate)
      if (ext !== '' && ext !== '.html') {
        jsonStaticError(res, 404, 'not_found')
        return
      }
      const fallback = resolveStatic('/index.html')
      if (fallback === null) {
        jsonStaticError(res, 404, 'not_found')
        return
      }
      try {
        data = readFileSync(fallback)
      } catch {
        jsonStaticError(res, 404, 'not_found')
        return
      }
      candidate = '/index.html'
      gzipAttempted = false
      gzipEncoded = false
    }
    const type = MIME_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream'
    if (candidate === '/index.html') {
      // __DSH_BOOT__ injection (04 §5 / 05 §2): the manifest (rendered by
      // the renderer build chain) becomes window.__DSH_BOOT__ inline —
      // parseBootManifest contract, served from <dist>/manifest.json.
      const manifest = readBootManifest()
      if (manifest !== null) {
        const nonce = res._cspNonce
        if (nonce === undefined) throw new Error('missing CSP nonce for static response')
        // JSON is embedded in an HTML script data block: `<` must never form
        // `</script>` (manifest values are build inputs, not trusted HTML).
        // Escape JavaScript's two legacy line separators as well.
        const serializedManifest = JSON.stringify(manifest)
          .replace(/</g, '\\u003c')
          .replace(/\u2028/g, '\\u2028')
          .replace(/\u2029/g, '\\u2029')
        const script = `<script nonce="${nonce}">window.__DSH_BOOT__=${serializedManifest};</script>`
        const text = data.toString('utf8')
        if (text.includes('</head>')) data = Buffer.from(text.replace('</head>', `${script}</head>`))
        else data = Buffer.from(`${text}${script}`)
      }
    }
    const headers: Record<string, string> = { 'content-type': type, ...(res._corsHeaders ?? {}) }
    // Cache policy (LCP perf pass): hash-named build assets under /assets/
    // are immutable — one year, no revalidation, so a relaunch serves them
    // from the Electron HTTP cache instead of re-fetching ~2.75MB. index.html
    // keeps no-cache (the __DSH_BOOT__ manifest moves every build). Other
    // paths (e.g. /manifest.json) keep their previous no-header behavior.
    if (candidate === '/index.html') {
      headers['cache-control'] = 'no-cache'
    } else if (candidate.startsWith('/assets/')) {
      headers['cache-control'] = 'public, max-age=31536000, immutable'
    }
    // On-the-fly gzip for text-like types (only when the client accepts it).
    // Vary is set for every compressible response (gzip or not) so the HTTP
    // cache never serves a negotiated variant to a mismatched client.
    const compressible = COMPRESSIBLE_TYPES.has(extname(candidate).toLowerCase())
    if (compressible) headers['vary'] = 'accept-encoding'
    if (compressible && acceptsGzip(req)) {
      if (gzipEncoded) {
        headers['content-encoding'] = 'gzip'
      } else if (!gzipAttempted) {
        try {
          data = gzipSync(data)
          headers['content-encoding'] = 'gzip'
        } catch (gzipError) {
          // index.html is injected per request and cannot use the file cache.
          // If that one compression fails, serve the already-read identity
          // bytes so the shell remains available.
          logger?.warn(`static gzip failed for ${candidate}: ${String(gzipError)}`)
        }
      }
    }
    // Explicit Content-Length: keeps static responses non-chunked and gives
    // HEAD requests a real length (the immutable-cache client relies on it).
    headers['content-length'] = String(data.length)
    res.writeHead(200, headers)
    res.end(data)
  }

  function jsonStaticError(res: ApiResponse, status: number, code: string) {
    const body = JSON.stringify({ error: code, code })
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      ...(res._corsHeaders ?? {}),
    })
    res.end(body)
  }

  return { serve: serveStatic }
}
