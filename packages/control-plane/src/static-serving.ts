/**
 * Static frontend service: dist/ + __DSH_BOOT__.
 *
 * createStaticServing assembles the pure static-serve surface over a
 * webDistDir: MIME resolution, on-the-fly gzip (with a tiny per-file cache),
 * the SPA fallback to the injected shell, and __DSH_BOOT__ manifest injection.
 * Anonymous like every other surface. It owns no HTTP server and no
 * security-header policy — index.ts mints the per-response CSP nonce
 * (`res._cspNonce`) and sets the browser boundary headers before dispatch; this
 * module only reads `_cspNonce` and `_corsHeaders`.
 */

import { extname, join, resolve, sep } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { gzip } from 'node:zlib'
import { isHashedStaticAssetPath } from './proxy-forward.ts'
import { SAFE_MODE_GLOBAL } from './safe-mode.ts'
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
 * Static types gzip'd on the fly (html/css/js/map/json/svg; woff2 rides along
 * for literal compliance — already brotli-compressed, so gzip gains nothing).
 * Binary image formats are excluded (already compressed).
 */
const COMPRESSIBLE_TYPES = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map', '.woff2'])

/** FIFO cap of the per-file gzip cache (memory bound: one compressed asset). */
const GZIP_CACHE_MAX = 64

/** zlib.gzip's callback API as a promise: no sync compression on the serve path. */
function gzipAsync(source: Buffer): Promise<Buffer> {
  return new Promise((resolveGzip, rejectGzip) => {
    gzip(source, (error, compressed) => {
      if (error !== null) rejectGzip(error)
      else resolveGzip(compressed)
    })
  })
}

/** createStaticServing options. */
export interface StaticServingOptions {
  /** The built frontend dist directory (must exist; the plane validates it). */
  webDistDir: string
  /** Sink for gzip-failure warnings (optional; absent = silent). */
  logger?: Logger
  /**
   * 安全模式（C4）：true = index.html 头部额外注入
   * `window.__DSH_CHAMBER_SAFE_MODE__ = true`（渲染端据此跳过 extra rows）。
   * 缺省 false —— 普通启动的响应逐字节不变。
   */
  safeMode?: boolean
}

/** The assembled static-serve surface. */
export interface StaticServing {
  /**
   * Serve a static path (or the injected index.html SPA fallback) on the
   * response; rejects on a missing CSP nonce for the manifest-injected shell.
   */
  serve(req: ApiRequest, res: ApiResponse, pathname: string): Promise<void>
}

/** Assemble the static frontend service over one dist directory; returns the
 *  serve(req, res, pathname) dispatch. */
export function createStaticServing({ webDistDir, logger, safeMode = false }: StaticServingOptions): StaticServing {
  /**
   * Tiny on-the-fly gzip cache keyed by path+mtime: immutable hash-named assets
   * under /assets/ are gzipped once per build snapshot, and the FIFO cap bounds
   * memory. index.html is NOT served through this cache — its content is
   * re-injected with __DSH_BOOT__ per request (the manifest rev can change
   * without its mtime moving), so it is gzipped per request. Read+gzip runs off
   * the event loop and cold misses of one snapshot are single-flighted by the
   * same path+mtime+size key; a rejected flight is forgotten and a failed gzip
   * falls back to identity bytes.
   */
  const gzipCache = new Map<string, Buffer>()
  const gzipFlights = new Map<string, Promise<{ data: Buffer; encoded: boolean; error?: unknown }>>()
  async function readGzipCached(path: string): Promise<{ data: Buffer; encoded: boolean; error?: unknown }> {
    const info = await stat(path)
    const key = `${path}:${info.mtimeMs}:${info.size}`
    const hit = gzipCache.get(key)
    if (hit !== undefined) return { data: hit, encoded: true }
    const existing = gzipFlights.get(key)
    if (existing !== undefined) return existing
    const flight = (async (): Promise<{ data: Buffer; encoded: boolean; error?: unknown }> => {
      const source = await readFile(path)
      let compressed: Buffer
      try {
        compressed = await gzipAsync(source)
      } catch (error) {
        return { data: source, encoded: false, error }
      }
      if (gzipCache.size >= GZIP_CACHE_MAX) {
        const oldest = gzipCache.keys().next().value
        if (oldest !== undefined) gzipCache.delete(oldest)
      }
      gzipCache.set(key, compressed)
      return { data: compressed, encoded: true }
    })()
    const tracked = flight.finally(() => {
      if (gzipFlights.get(key) === tracked) gzipFlights.delete(key)
    })
    gzipFlights.set(key, tracked)
    return tracked
  }

  /**
   * Whether the request's Accept-Encoding accepts gzip (RFC 9110 q-value aware):
   * a bare `gzip` (or `gzip;q=0.5`) accepts, `gzip;q=0` explicitly refuses, and
   * anything else (deflate/br-only, identity, absent) does not accept.
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
  async function readBootManifest(): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(join(webDistDir, 'manifest.json'), 'utf8'))
    } catch {
      return null
    }
  }

  /** Serve a static file (or index.html fallback) on the response. */
  async function serveStatic(req: ApiRequest, res: ApiResponse, pathname: string): Promise<void> {
    let candidate = pathname === '/' ? '/index.html' : pathname
    // SPA fallback: unknown paths render index.html, except asset-looking paths
    // (a missing asset answers 404 — a build error must not masquerade as the shell).
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
        const payload = await readGzipCached(path)
        data = payload.data
        gzipEncoded = payload.encoded
        if (payload.error !== undefined) {
          logger?.warn(`static gzip failed for ${candidate}: ${String(payload.error)}`)
        }
      } else {
        data = await readFile(path)
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
        data = await readFile(fallback)
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
      // __DSH_BOOT__ injection: the manifest becomes window.__DSH_BOOT__ inline,
      // served from <dist>/manifest.json.
      const manifest = await readBootManifest()
      const scripts: string[] = []
      if (manifest !== null || safeMode) {
        const nonce = res._cspNonce
        if (nonce === undefined) throw new Error('missing CSP nonce for static response')
        // C4 safe mode: the page reads this global before booting its shell and
        // skips extra-row (profile client-plugin) loading. Injected BEFORE the
        // __DSH_BOOT__ script; absent entirely on normal launches.
        if (safeMode) scripts.push(`<script nonce="${nonce}">window.${SAFE_MODE_GLOBAL}=true;</script>`)
        if (manifest !== null) {
          // JSON embedded in an HTML script block: `<` must never form `</script>`,
          // and JavaScript's two legacy line separators are escaped too.
          const serializedManifest = JSON.stringify(manifest)
            .replace(/</g, '\\u003c')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029')
          scripts.push(`<script nonce="${nonce}">window.__DSH_BOOT__=${serializedManifest};</script>`)
        }
      }
      if (scripts.length > 0) {
        const script = scripts.join('')
        const text = data.toString('utf8')
        if (text.includes('</head>')) data = Buffer.from(text.replace('</head>', `${script}</head>`))
        else data = Buffer.from(`${text}${script}`)
      }
    }
    const headers: Record<string, string> = { 'content-type': type, ...(res._corsHeaders ?? {}) }
    // Cache policy: hash-named build assets under /assets/ are immutable (one
    // year, no revalidation) so a relaunch serves them from the Electron HTTP
    // cache; index.html keeps no-cache (the __DSH_BOOT__ manifest moves every
    // build); other paths get no cache-control header. The predicate is the SAME
    // one proxy-forward.ts uses (isHashedStaticAssetPath): a bare `/assets/`
    // prefix would pin a future unhashed entry for a year.
    if (candidate === '/index.html') {
      headers['cache-control'] = 'no-cache'
    } else if (isHashedStaticAssetPath(candidate)) {
      headers['cache-control'] = 'public, max-age=31536000, immutable'
    }
    // On-the-fly gzip for text-like types; Vary is set for every compressible
    // response so no cache serves a negotiated variant to a mismatched client.
    const compressible = COMPRESSIBLE_TYPES.has(extname(candidate).toLowerCase())
    if (compressible) headers['vary'] = 'accept-encoding'
    if (compressible && acceptsGzip(req)) {
      if (gzipEncoded) {
        headers['content-encoding'] = 'gzip'
      } else if (!gzipAttempted) {
        try {
          data = await gzipAsync(data)
          headers['content-encoding'] = 'gzip'
        } catch (gzipError) {
          // index.html is injected per request and cannot use the file cache; if
          // that compression fails, serve the already-read identity bytes.
          logger?.warn(`static gzip failed for ${candidate}: ${String(gzipError)}`)
        }
      }
    }
    // Explicit Content-Length: non-chunked static responses and a real length for HEAD.
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
