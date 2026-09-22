/**
 * Login-phase background pre-warm (design 17 §10.6, 2026-12 revision): the ONE
 * pre-auth route that may touch the managed dsh.
 *
 * While an unauthenticated visitor sits on /auth/login typing the password,
 * the login page's <head> carries one <link rel="prefetch" as="script"> per
 * discovered client-bundle URL — the REAL /plugins/... URL the shell fetches
 * after login. The browser downloads the managed dsh's static frontend bundle
 * off the critical path, so the post-login boot is served from the HTTP cache
 * instead of paying the measured ~4.35 MiB gzip download.
 *
 * WHY THE URL IS THE REAL ONE (measured, Chrome 152): the HTTP cache is
 * URL-keyed. The previous token wrapper /chamber/warmup/<token>?u=<url> stored
 * a DIFFERENT cache entry than the app's own fetch of the real URL, so the app
 * still hit the server and the pre-warm bought nothing. Keeping the real URL
 * makes the prefetch and the app's own <script src> share one cache entry. The
 * capability that lets the anonymous prefetch through therefore travels as a
 * short-lived COOKIE, never in the URL.
 *
 * The boundary discipline (the reason this is allowed to exist pre-auth):
 *
 *  - CAPABILITY COOKIE: GET /auth/login sets dsh_gateway_warmup — an
 *    HMAC-SHA256 over exp|warmup|<client address>, domain-separated from both
 *    the session signing key and the retired URL token. HttpOnly,
 *    SameSite=Lax, Secure when the request is secure, Max-Age 120 s. The
 *    cookie is NOT path-bound: one grant covers every prefetched URL, and the
 *    path allowlist lives on the route. A request without a valid grant is
 *    NOT refused here — it falls through to the auth gate, so an existing
 *    session still works and an anonymous request gets the gate's uniform 401
 *    and audit line.
 *  - SHAPE ALLOWLIST: only the roster's two real shapes may be proxied
 *    pre-auth — the shared combination '/plugins/??<rows>&rev=...' and one
 *    single-row client bundle '/plugins/<pkg>/client.js|client.css'. EVERY
 *    other /plugins/** path (plugin HTTP routes) stays authenticated. The
 *    target must carry no percent-encoding, backslash, '//', '#', control
 *    character, whitespace, dot segment or over-length run, and must
 *    round-trip through the URL parser unchanged.
 *  - RATE LIMIT: a bounded per-client-address token bucket keeps anonymous
 *    traffic from abusing the route (429 warmup_rate_limited).
 *  - AGGREGATE BUDGET: a max concurrent upstream-fetch count and a global
 *    buffered-byte cap bound the reviewer-measured multi-hundred-MiB replay
 *    (40 concurrent 8 MiB bundles); over budget answers 503 warmup_capacity.
 *  - KILL SWITCH: config.warmup (DSH_GATEWAY_WARMUP / --no-warmup, default
 *    ON) disables discovery, rendering and the route.
 *  - FAIL CLOSED: port missing / dsh not ready => 503 instance_unavailable;
 *    upstream failure => 502 upstream_failed.
 *  - NO USER CREDENTIALS UPSTREAM: the managed dsh request carries only the
 *    caller's accept-encoding plus the spawn-minted browser-auth cookie that
 *    reaches the loopback static surface — never the caller's cookie, never
 *    authorization. The spawn-minted cookie is an internal host credential; it
 *    is never returned to the pre-auth client.
 *
 * Discovery (the bundle roster) reads the managed dsh's own index document
 * over loopback with that same spawn-minted cookie (upstream's Connection
 * authorizes every index response, while non-index assets stay public), and
 * fails soft, is bounded by AbortSignal.timeout (about 500 ms) and cached
 * in-process for 60 s per dsh port, so a login page can never be held longer
 * than that and a down/slow dsh is not re-probed on every visit. The login
 * page renders byte-identical output whenever discovery fails or the switch
 * is off.
 *
 * This module deliberately imports only node builtins: it is the standalone
 * unit-testable half of the route (no @dsh-chamber/control-plane coupling).
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { request as httpRequest } from 'node:http'

/** The warm-up capability cookie name (design 17 §10.6). */
export const WARMUP_COOKIE_NAME = 'dsh_gateway_warmup'

/** Capability cookie lifetime / Max-Age (seconds). Short by design: the grant
 * only has to live through "browser parsed the login page -> prefetch
 * started", and a stolen grant can do nothing beyond re-fetching the public
 * static roster. */
export const WARMUP_COOKIE_TTL_SECONDS = 120

/** Cookie Path: the whole gateway origin. A Path attribute is browser-scoping
 * only — the route's shape allowlist is the actual boundary — and a narrow
 * Path would silently miss a future prefetched URL. */
export const WARMUP_COOKIE_PATH = '/'

/** Only this path prefix may ever be proxied pre-auth (design 17 §10.6). */
export const WARMUP_ALLOWED_PATH_PREFIX = '/plugins/'

/** The two REAL bundle shapes this route may serve pre-auth (the measured
 * roster shapes): the shared combination request and one single-row client
 * bundle. A plugin HTTP route such as /plugins/<pkg>/api/x matches neither. */
const WARMUP_COMBO_PATH_RE = /^\/plugins\/\?\?[^?#]*$/
const WARMUP_SINGLE_ROW_PATH_RE = /^\/plugins\/[^/]+\/client\.(?:js|css)$/

/** How long one SUCCESSFUL discovery result is reused (ms). */
export const WARMUP_DISCOVERY_CACHE_TTL_MS = 60_000

/** How long a FAILED discovery is remembered (ms). Short on purpose: a dsh that
 *  becomes serviceable while the visitor sits on the login page gets its links
 *  on a later render instead of staying link-less for a full minute, while the
 *  failure path still cannot re-probe the loopback host on every request. */
export const WARMUP_DISCOVERY_FAILURE_TTL_MS = 10_000

/** Hard ceiling on one index-document discovery read (ms). The login page
 * awaits discovery, so this is the page's worst-case added latency. */
export const WARMUP_DISCOVERY_TIMEOUT_MS = 500

/** Cap on one upstream bundle response (bytes); long enough for the measured
 * ~4.35 MiB gzip combo and for an identity-encoding retry, bounded so a
 * misbehaving upstream cannot pin the process. */
export const MAX_WARMUP_RESPONSE_BYTES = 32 * 1024 * 1024

/** Aggregate budget: how many warm-up upstream fetches may be in flight at
 * once. The browser itself opens about six parallel prefetches per host, so
 * eight keeps a legitimate login page unimpeded while a replay burst is
 * refused (503 warmup_capacity) instead of multiplying peak RSS. */
export const MAX_WARMUP_CONCURRENT_FETCHES = 8

/** Aggregate budget: total bytes buffered across ALL in-flight warm-up
 * fetches. The security review measured +581 MiB RSS from 40 concurrent
 * replays of an 8 MiB bundle; this cap bounds the whole feature's buffer
 * (release happens on every settle, including failures). */
export const MAX_WARMUP_TOTAL_BUFFERED_BYTES = 64 * 1024 * 1024

/** Cap on the discovered bundle URLs rendered per login page.
 *
 *  Sized from the REAL roster, not a guess: the managed index of the measured
 *  deployment carries 59 distinct quoted /plugins/??... URLs (one ~2.6 KiB
 *  application combo in a <link rel="preload">, plus the per-row url fields of
 *  the boot manifest — among them rows such as the seeded dsh-chamber-mcp
 *  bundle that the combo does NOT contain). The cap keeps a pathological
 *  upstream document bounded while covering the whole real roster. */
export const MAX_WARMUP_BUNDLE_URLS = 64

/** Cap on one index document parsed for bundle URLs (characters). */
export const MAX_WARMUP_INDEX_CHARS = 4 * 1024 * 1024

/** Cap on one warm-up route target / token subject (characters). 8 KiB is far
 * beyond any real plugin combo URL (the measured roster is hundreds of bytes)
 * and keeps the base64url token below the 16 KiB request-line budget Node's
 * HTTP parser enforces. */
export const MAX_WARMUP_TARGET_CHARS = 8 * 1024

/** Cap on a presented capability cookie value before it is parsed. The
 * payload is exp|warmup|<client address>, so a few hundred bytes is already
 * far above anything legitimately minted. */
export const MAX_WARMUP_COOKIE_CHARS = 256

/** Cap on the discovery cache entries (one per dsh port; bounded anyway). */
export const MAX_WARMUP_DISCOVERY_KEYS = 8

/** Per-client token bucket: burst size and sustained refill rate. The burst
 * must exceed one login page's own need (one link per discovered bundle, up to
 * MAX_WARMUP_BUNDLE_URLS) or the page would throttle itself; the sustained
 * rate stays low, so anonymous abuse is still bounded. */
export const WARMUP_RATE_LIMIT_CAPACITY = 128
export const WARMUP_RATE_LIMIT_REFILL_PER_SECOND = 5
/** Cap on simultaneously tracked client buckets (bounded map; the oldest
 * bucket is dropped when the cap is reached). */
export const MAX_WARMUP_RATE_LIMIT_KEYS = 1024

/** Upstream request timeout (ms). */
export const WARMUP_UPSTREAM_TIMEOUT_MS = 30_000

/** Capacity-refusal code for the bounded aggregate budget. */
export const WARMUP_CAPACITY_CODE = 'warmup_capacity'

/** The only response headers that cross back to the pre-auth caller. */
export const WARMUP_PASSED_RESPONSE_HEADERS = [
  'content-type',
  'content-encoding',
  'cache-control',
  'vary',
  'content-length',
] as const

/** Domain label for the capability cookie grant: the signing key is derived
 * from the store's jwt secret through this label, so a grant can never be a
 * session token and a session JWT can never satisfy the grant verifier. (The
 * retired URL-bound token universe was removed together with its route.) */
const WARMUP_COOKIE_DOMAIN_LABEL = 'dsh-gateway/warmup-cookie/v1'

/** The cookie payload subject marker; a token blindly replayed as a cookie
 * (or the reverse) fails on the marker before any cryptographic check could
 * matter. */
const WARMUP_COOKIE_SUBJECT = 'warmup'

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

/** Derive one warm-up signing key for a domain label. */
function signingKey(secret: string, label: string): Buffer {
  return createHmac('sha256', secret).update(label, 'utf8').digest()
}

/** Mint base64url(payload) + '.' + base64url(mac) under one derived key. */
function mintWarmupPayload(key: Buffer, payload: string): string {
  const mac = createHmac('sha256', key).update(payload, 'utf8').digest()
  return Buffer.from(payload, 'utf8').toString('base64url') + '.' + mac.toString('base64url')
}

/** Verify one presented value under one derived key and return its payload,
 * or null: strict structure (exactly one dot, canonical unpadded base64url on
 * both halves), constant-time MAC compare, then expiry (exp inclusive). */
function openWarmupPayload(key: Buffer, token: string, nowSeconds: number, maxChars: number): string | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > maxChars) return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot !== token.lastIndexOf('.') || dot === token.length - 1) return null
  const payloadPart = token.slice(0, dot)
  const macPart = token.slice(dot + 1)
  if (!BASE64URL_RE.test(payloadPart) || !BASE64URL_RE.test(macPart)) return null
  const payloadBytes = Buffer.from(payloadPart, 'base64url')
  const macBytes = Buffer.from(macPart, 'base64url')
  // Reject non-canonical encodings: Buffer.from is lenient about trailing
  // bits, and a value that does not round-trip is malformed by definition.
  if (payloadBytes.toString('base64url') !== payloadPart) return null
  if (macBytes.toString('base64url') !== macPart) return null
  const payload = payloadBytes.toString('utf8')
  const sep = payload.indexOf('|')
  if (sep <= 0 || sep === payload.length - 1) return null
  const expRaw = payload.slice(0, sep)
  if (!/^\d{1,15}$/.test(expRaw)) return null
  const exp = Number(expRaw)
  if (!Number.isSafeInteger(exp)) return null
  const expected = createHmac('sha256', key).update(payload, 'utf8').digest()
  if (macBytes.length !== expected.length || !timingSafeEqual(macBytes, expected)) return null
  if (Math.floor(nowSeconds) > exp) return null
  return payload
}

/**
 * Mint the warm-up capability cookie value: HMAC over
 * 'exp|warmup|<client address>' with the distinct cookie domain label. The
 * payload deliberately carries NO path — one grant has to cover every
 * prefetched URL — so the path allowlist is enforced by the route, not by the
 * token. The client address is optional: when present it binds the grant to
 * the address that rendered the login page (the caller passes the same
 * boundary-derived address on both legs).
 */
export function createWarmupCookie(secret: string, nowSeconds: number, clientAddress?: string): string {
  const exp = Math.floor(nowSeconds) + WARMUP_COOKIE_TTL_SECONDS
  const payload = exp + '|' + WARMUP_COOKIE_SUBJECT + '|' + (clientAddress ?? '')
  return mintWarmupPayload(signingKey(secret, WARMUP_COOKIE_DOMAIN_LABEL), payload)
}

/**
 * Verify one presented capability cookie value at nowSeconds. Structural,
 * MAC, expiry and subject checks come from the shared core; when the mint
 * bound a client address, the verifier must present the SAME non-empty
 * address (a bound grant is refused when the verifier has no address at all).
 * An unbound grant verifies from anywhere.
 */
export function verifyWarmupCookie(secret: string, value: string, nowSeconds: number, clientAddress?: string): boolean {
  const payload = openWarmupPayload(signingKey(secret, WARMUP_COOKIE_DOMAIN_LABEL), value, nowSeconds, MAX_WARMUP_COOKIE_CHARS)
  if (payload === null) return false
  const parts = payload.split('|')
  if (parts.length !== 3) return false
  if (parts[1] !== WARMUP_COOKIE_SUBJECT) return false
  const bound = parts[2]
  if (bound === '') return true
  return clientAddress !== undefined && clientAddress !== '' && clientAddress === bound
}

/** Build the full Set-Cookie header value for one minted grant. */
export function buildWarmupCookieHeader(value: string, secure: boolean): string {
  return WARMUP_COOKIE_NAME + '=' + value
    + '; Path=' + WARMUP_COOKIE_PATH
    + '; Max-Age=' + WARMUP_COOKIE_TTL_SECONDS
    + '; HttpOnly; SameSite=Lax'
    + (secure ? '; Secure' : '')
}

/** Read the warm-up capability cookie out of one Cookie header. Exact name
 * match; an empty value is treated as absent. */
export function readWarmupCookie(cookieHeader: string | undefined): string | undefined {
  if (typeof cookieHeader !== 'string' || cookieHeader === '') return undefined
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== WARMUP_COOKIE_NAME) continue
    const value = part.slice(eq + 1).trim()
    return value === '' ? undefined : value
  }
  return undefined
}

/** A managed dsh port is a TCP port: 1..65535. An out-of-range value must
 * fail closed BEFORE any loopback URL or request is built, so a validly
 * signed request can never surface as a spurious refusal. */
export function isValidDshPort(port: number | null | undefined): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
}

/**
 * The pre-auth path allowlist (design 17 §10.6): the target must be under
 * /plugins/, carry none of the rejected byte/segment forms, match ONE of the
 * two real bundle shapes, and round-trip through the URL parser unchanged.
 * Rejected: backslashes, '//' (protocol-relative / authority smuggling), ANY
 * percent-encoding (a %2e/%2f/%25 could decode to a dot or slash at a later
 * hop — the dsh bundle names are plain ASCII), whitespace/control characters,
 * fragments, dot segments, over-length targets, every non-bundle /plugins
 * shape, and anything that parses to an absolute or authority-form URL.
 */
export function isWarmupPathAllowed(pathAndQuery: string): boolean {
  if (typeof pathAndQuery !== 'string' || pathAndQuery.length === 0 || pathAndQuery.length > MAX_WARMUP_TARGET_CHARS) return false
  if (!pathAndQuery.startsWith(WARMUP_ALLOWED_PATH_PREFIX)) return false
  if (pathAndQuery.includes('\\')) return false
  if (pathAndQuery.includes('//')) return false
  if (pathAndQuery.includes('%')) return false
  if (pathAndQuery.includes('#')) return false
  if (/[\u0000-\u0020\u007f]/.test(pathAndQuery)) return false
  const queryAt = pathAndQuery.indexOf('?')
  const path = queryAt === -1 ? pathAndQuery : pathAndQuery.slice(0, queryAt)
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '..') return false
  }
  // The single-row shape is judged on the PATH only (2026-09 review): the raw
  // target's `[^/]+` used to swallow a '?' — `/plugins/foo?x=y/client.js`
  // passed and reached the loopback as `/plugins/foo`, so any visitor holding
  // an auto-issued login cookie could probe arbitrary one-segment /plugins
  // paths (upstream 404) instead of this gateway's uniform 401. A query is a
  // COMBO-only form; the combination request keeps its query.
  if (WARMUP_COMBO_PATH_RE.test(pathAndQuery)) {
    // combination request: `/plugins/??<rows>` (+ the rev query)
  } else if (queryAt === -1 && WARMUP_SINGLE_ROW_PATH_RE.test(path)) {
    // single-row bundle: path-only, no query
  } else {
    return false
  }
  try {
    const parsed = new URL(pathAndQuery, 'http://warmup.invalid')
    if (parsed.origin !== 'http://warmup.invalid') return false
    if (parsed.hash !== '') return false
    // A string the parser normalizes (dot segments, encoded slashes) is not
    // the origin-form target it appears to be: refuse rather than forward a
    // second, differently-interpreted path.
    if (parsed.pathname + parsed.search !== pathAndQuery) return false
    if (!parsed.pathname.startsWith(WARMUP_ALLOWED_PATH_PREFIX)) return false
  } catch {
    return false
  }
  return true
}

/** Decode the few HTML entities an attribute can carry around '&' before the
 * extracted URL is treated as a real URL. */
function decodeHtmlAmpersands(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&#x26;/gi, '&')
}

/** Attribute-value form of a bundle URL: the match starts at the opening
 *  quote, so the text before it ends with src= / href=. */
const WARMUP_ATTRIBUTE_FORM_TAIL = /(?:src|href)\s*=\s*$/

/** The two real roster shapes, as they appear quoted in the managed index. */
const WARMUP_BUNDLE_URL_RE = /["'](\/plugins\/(?:\?\?[^"'\s<>\\]*|[^/?#"'\s<>\\]+\/client\.(?:js|css)))["']/g

/**
 * Extract the real bundle URLs from the managed dsh index document,
 * allowlist-filtered (the route's exact shapes) and deduplicated, capped at
 * MAX_WARMUP_BUNDLE_URLS. Mirrors html-inject.ts's document handling
 * (fail-soft, regex-based, no DOM).
 *
 * ORDER IS THE POINT (measured on the real index): the URLs the document
 * itself loads — <script src> / <link ... href>, i.e. the parser-preload and
 * application batches the shell AWAITS before mount — come FIRST, then the
 * remaining quoted URLs of the inline boot manifest (per-row url fields,
 * which include rows outside the shared combo, e.g. the seeded
 * dsh-chamber-mcp bundle). A pure document-order pass spends the cap on
 * manifest rows first and can drop the heavy application combo — exactly the
 * payload the warm-up exists for. Document order is preserved within each
 * class.
 */
export function extractWarmupBundleUrls(html: string): string[] {
  if (typeof html !== 'string' || html.length === 0) return []
  const attributeForm: string[] = []
  const manifestForm: string[] = []
  const seen = new Set<string>()
  const pattern = new RegExp(WARMUP_BUNDLE_URL_RE.source, 'g')
  for (const match of html.matchAll(pattern)) {
    const url = decodeHtmlAmpersands(match[1])
    if (!isWarmupPathAllowed(url) || seen.has(url)) continue
    seen.add(url)
    const at = match.index ?? 0
    const before = html.slice(Math.max(0, at - 120), at)
    if (WARMUP_ATTRIBUTE_FORM_TAIL.test(before)) attributeForm.push(url)
    else manifestForm.push(url)
  }
  return [...attributeForm, ...manifestForm].slice(0, MAX_WARMUP_BUNDLE_URLS)
}

/** Bounded per-key token bucket (documented in WARMUP_RATE_LIMIT_*). */
export interface WarmupRateLimiter {
  /** Consume one token for key; false = over budget (caller answers 429). */
  consume(key: string, nowMs: number): boolean
}

export function createWarmupRateLimiter(options: {
  capacity?: number
  refillPerSecond?: number
  maxKeys?: number
} = {}): WarmupRateLimiter {
  const capacity = options.capacity ?? WARMUP_RATE_LIMIT_CAPACITY
  const refillPerSecond = options.refillPerSecond ?? WARMUP_RATE_LIMIT_REFILL_PER_SECOND
  const maxKeys = options.maxKeys ?? MAX_WARMUP_RATE_LIMIT_KEYS
  const buckets = new Map<string, { tokens: number; updatedAt: number }>()
  return {
    consume(key: string, nowMs: number): boolean {
      let bucket = buckets.get(key)
      if (bucket === undefined) {
        if (buckets.size >= maxKeys) {
          // Bounded map: drop the oldest bucket, never grow without limit.
          const oldest = buckets.keys().next().value
          if (oldest !== undefined) buckets.delete(oldest)
        }
        bucket = { tokens: capacity, updatedAt: nowMs }
        buckets.set(key, bucket)
      }
      const elapsedSec = Math.max(0, (nowMs - bucket.updatedAt) / 1000)
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSecond)
      bucket.updatedAt = nowMs
      if (bucket.tokens < 1) return false
      bucket.tokens -= 1
      return true
    },
  }
}

/** Merge the whitelisted upstream Vary with any Vary already on the response
 * (the request policy sets 'Origin' for an allowed CORS origin). writeHead
 * must never clobber that policy header: the merged value is comma-joined,
 * order-preserving and case-insensitively deduplicated. */
export function mergeVary(existing: unknown, upstream: string | undefined): string | undefined {
  const parts: string[] = []
  const push = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) push(entry)
      return
    }
    const text = typeof value === 'number' ? String(value) : value
    if (typeof text !== 'string') return
    for (const part of text.split(',')) {
      const token = part.trim()
      if (token === '') continue
      if (parts.some(seen => seen.toLowerCase() === token.toLowerCase())) continue
      parts.push(token)
    }
  }
  push(existing)
  push(upstream)
  return parts.length === 0 ? undefined : parts.join(', ')
}

/** Minimal structural request/response surface the route drives (the real
 * IncomingMessage/ServerResponse are richer; dispatch adapts them at the call
 * site so this module stays free of control-plane types). */
export interface WarmupHttpRequest {
  method?: string
  /** The RAW request target (origin-form path+query). Preferred over the
   * parsed URL so a dot-segment target cannot be normalized into the
   * allowlist before it is checked; forwarded upstream byte-for-byte. */
  url?: string
  headers: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string } | null
}

export interface WarmupHttpResponse {
  writeHead(status: number, headers?: Record<string, string>): unknown
  end(chunk?: unknown): unknown
  /** Present on the real ServerResponse (and the test double): used to merge
   * an already-set Vary instead of overwriting it. */
  getHeader?(name: string): unknown
}

/** Route outcome. 'rejected' carries the machine code the client received so
 * dispatch audits exactly that code (never the token/cookie value, never the
 * URL); 'unclaimed' means the request is not the route's to answer — no
 * capability cookie, not a bundle shape, or the kill switch — and the auth
 * gate below owns the verdict. */
export type WarmupHandleOutcome =
  | { kind: 'proxied' }
  | { kind: 'rejected'; code: string }
  | { kind: 'unclaimed' }

/** Links() result: the REAL bundle URLs to prefetch plus, when at least one
 * URL was discovered, the full Set-Cookie value of the capability grant. */
export interface WarmupLinks {
  urls: string[]
  cookie?: string
}

export interface WarmupLinkOptions {
  /** Boundary-derived client address to bind the grant to (optional). */
  clientAddress?: string
  /** Secure request => Secure cookie attribute. */
  secure?: boolean
}

export interface WarmupDeps {
  /** Kill switch (config.warmup; default ON). */
  enabled: boolean
  /** The managed local dsh port; null = not ready. */
  getLocalDshPort(): number | null
  getLocalState(): string
  /** Activation-aware exposure gate (defaults open). */
  canExposeLocal?: () => boolean
  /** The store's jwt secret (the same source auth.ts reads). */
  getSecret(): string
  logger: { warn(message: string): void }
  /** The spawn-minted browser-auth cookie for one managed loopback port
   * (authCookieFor('http://127.0.0.1:<port>')). This is an internal host
   * credential — never a user credential, never the caller's cookie — and it
   * never reaches the pre-auth client. */
  getAuthCookie?: (port: number) => string | undefined
  /** Discovery seam used by tests; defaults to a loopback GET / with the
   * spawn-minted cookie attached. */
  fetchIndex?: (url: string, signal: AbortSignal, authCookie: string | undefined) => Promise<string>
  /** Clock seam used by tests; defaults to Date.now. */
  now?: () => number
  /** Bounded aggregate budget seam (test only; production constants). */
  budget?: {
    maxConcurrentFetches?: number
    maxTotalBufferedBytes?: number
  }
}

export interface WarmupController {
  /** The login page's real bundle URLs (discovery order) and the capability
   * grant Set-Cookie. Empty/absent when the switch is off, the dsh is not
   * serviceable or discovery found nothing. Never throws and never exceeds
   * the discovery budget. */
  links(options?: WarmupLinkOptions): Promise<WarmupLinks>
  /** Claim the route: 'proxied' (bytes streamed or a route answer written),
   * 'rejected' (405/429 — dispatch audits the code), 'unclaimed' (switch off,
   * not a bundle shape, or no valid capability cookie). */
  handle(req: WarmupHttpRequest, res: WarmupHttpResponse, url: URL, clientAddress?: string): Promise<WarmupHandleOutcome>
}

/** Default discovery read: loopback index document with the spawn-minted
 * browser-auth cookie (upstream authorizes EVERY index response, while
 * non-index assets stay public), redirects refused (the target is the managed
 * dsh itself, never a redirect chain) and a bounded body. */
async function fetchIndexDocument(url: string, signal: AbortSignal, authCookie: string | undefined): Promise<string> {
  const headers: Record<string, string> = { accept: 'text/html' }
  if (authCookie !== undefined && authCookie !== '') headers.cookie = authCookie
  const response = await fetch(url, { method: 'GET', redirect: 'manual', signal, headers })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  if (response.body === null) return ''
  // Streaming bound (2026-09 review, MAJOR): `response.text()` read the WHOLE
  // body before the cap was checked — a 12.5 MiB index was fully delivered
  // (measured +32.9 MiB RSS for one request) and only then rejected. Cancel as
  // soon as the cap is crossed, so the memory cost is one chunk over it.
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done === true) break
      text += decoder.decode(value, { stream: true })
      if (text.length > MAX_WARMUP_INDEX_CHARS) throw new Error('index document too large')
    }
    text += decoder.decode()
  } finally {
    // Releases the socket on every path (over-cap throw included).
    reader.cancel().catch(() => {})
  }
  return text
}

function writeJson(res: WarmupHttpResponse, status: number, body: Record<string, string>, extra?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra })
  res.end(JSON.stringify(body))
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined
}

export function createWarmupController(deps: WarmupDeps): WarmupController {
  /** Clock seam in MILLISECONDS (Date.now shape); tokens and TTLs are in
   * epoch SECONDS, so every token/TTL use goes through nowSeconds(). */
  const now = deps.now ?? Date.now
  const nowSeconds = (): number => Math.floor(now() / 1000)
  const limiter = createWarmupRateLimiter()
  const maxConcurrentFetches = deps.budget?.maxConcurrentFetches ?? MAX_WARMUP_CONCURRENT_FETCHES
  const maxTotalBufferedBytes = deps.budget?.maxTotalBufferedBytes ?? MAX_WARMUP_TOTAL_BUFFERED_BYTES
  /** per-dsh-port discovery result: urls (empty on failure) + fetch time. */
  const discoveryCache = new Map<number, { urls: string[]; at: number; ok: boolean }>()
  /** In-flight discovery per dsh port (2026-09 review, MAJOR): the login page
   *  AWAITS discovery and one unauthenticated connection can pipeline many
   *  index requests, so without single-flight N concurrent renders issued N
   *  concurrent loopback index fetches against the managed dsh (measured 100
   *  on one socket). Concurrent callers share ONE fetch, and the map's size
   *  is the aggregate concurrency bound for this leg. */
  const discoveryInflight = new Map<number, Promise<string[]>>()
  /** Bounded aggregate budget state (concurrency + buffered bytes). */
  let activeFetches = 0
  let bufferedBytes = 0

  function readyPort(): number | null {
    const port = deps.getLocalDshPort()
    if (deps.getLocalState() !== 'ready') return null
    if (!isValidDshPort(port)) return null
    if (!(deps.canExposeLocal?.() ?? true)) return null
    return port
  }

  function authCookieFor(port: number): string | undefined {
    try {
      const cookie = deps.getAuthCookie?.(port)
      return cookie === undefined || cookie === '' ? undefined : cookie
    } catch (error) {
      deps.logger.warn('gateway warmup: browser-auth cookie unavailable (' + (error instanceof Error ? error.name : 'unknown') + ')')
      return undefined
    }
  }

  async function discover(port: number): Promise<string[]> {
    const at = now()
    const cached = discoveryCache.get(port)
    if (cached !== undefined) {
      const ttl = cached.ok ? WARMUP_DISCOVERY_CACHE_TTL_MS : WARMUP_DISCOVERY_FAILURE_TTL_MS
      if (at - cached.at < ttl) return cached.urls
    }
    const inflight = discoveryInflight.get(port)
    if (inflight !== undefined) return inflight
    // Past the aggregate cap the login page renders without links (fail-soft
    // and bounded — never a queue of pending loopback fetches).
    if (discoveryInflight.size >= maxConcurrentFetches) return cached?.urls ?? []
    const pending = (async (): Promise<string[]> => {
      let urls: string[] = []
      let ok = true
      try {
        const authCookie = authCookieFor(port)
        const html = await (deps.fetchIndex ?? fetchIndexDocument)('http://127.0.0.1:' + port + '/', AbortSignal.timeout(WARMUP_DISCOVERY_TIMEOUT_MS), authCookie)
        urls = extractWarmupBundleUrls(html)
      } catch (error) {
        // Fail soft: no warm-up is a performance loss, never an error surface
        // on the login page. The error name only — no response body, no secret.
        const name = error instanceof Error ? error.name : 'unknown'
        deps.logger.warn('gateway warmup: bundle discovery failed on port ' + port + ' (' + name + ')')
        urls = []
        ok = false
      }
      if (discoveryCache.size >= MAX_WARMUP_DISCOVERY_KEYS && !discoveryCache.has(port)) {
        const oldest = discoveryCache.keys().next().value
        if (oldest !== undefined) discoveryCache.delete(oldest)
      }
      discoveryCache.set(port, { urls, at, ok })
      return urls
    })()
    discoveryInflight.set(port, pending)
    try {
      return await pending
    } finally {
      discoveryInflight.delete(port)
    }
  }

  /** Forward one allowlisted bundle request to the managed dsh. Buffered
   * (bounded by the per-response cap AND the global aggregate byte budget);
   * headers are written only once the upstream response ended, so an upstream
   * failure can still answer 502. The concurrency slot is held for the whole
   * upstream leg and released on every settle path. */
  function proxyBundle(
    res: WarmupHttpResponse,
    req: WarmupHttpRequest,
    port: number,
    target: string,
  ): Promise<void> {
    return new Promise<void>(resolve => {
      let settled = false
      let held = 0
      activeFetches += 1
      const settle = (): void => {
        if (settled) return
        settled = true
        activeFetches -= 1
        bufferedBytes -= held
        held = 0
        resolve()
      }
      const failUpstream = (): void => {
        if (settled) return
        try {
          writeJson(res, 502, { error: 'upstream_failed', code: 'upstream_failed' })
        } catch (error) {
          deps.logger.warn('gateway warmup: failure response write failed (' + (error instanceof Error ? error.name : 'unknown') + ')')
        }
        settle()
      }
      const failCapacity = (): void => {
        if (settled) return
        try {
          writeJson(res, 503, { error: 'warm-up capacity exhausted', code: WARMUP_CAPACITY_CODE })
        } catch (error) {
          deps.logger.warn('gateway warmup: capacity response write failed (' + (error instanceof Error ? error.name : 'unknown') + ')')
        }
        settle()
      }
      const headers: Record<string, string> = {}
      const acceptEncoding = headerValue(req.headers, 'accept-encoding')
      if (acceptEncoding !== undefined && acceptEncoding !== '') headers['accept-encoding'] = acceptEncoding
      // The spawn-minted browser-auth cookie is an INTERNAL host credential:
      // it is what makes the loopback static surface answer, it is not a user
      // credential, and the caller's own Cookie/Authorization never crosses.
      const authCookie = authCookieFor(port)
      if (authCookie !== undefined) headers.cookie = authCookie
      let upstream: ReturnType<typeof httpRequest>
      try {
        upstream = httpRequest({
          host: '127.0.0.1',
          port,
          method: req.method === 'HEAD' ? 'HEAD' : 'GET',
          path: target,
          headers,
        }, upstreamRes => {
          const chunks: Buffer[] = []
          let total = 0
          upstreamRes.on('data', (chunk: Buffer) => {
            if (settled) return
            total += chunk.length
            if (total > MAX_WARMUP_RESPONSE_BYTES) {
              upstreamRes.destroy()
              failUpstream()
              return
            }
            if (bufferedBytes + chunk.length > maxTotalBufferedBytes) {
              upstreamRes.destroy()
              failCapacity()
              return
            }
            bufferedBytes += chunk.length
            held += chunk.length
            chunks.push(chunk)
          })
          upstreamRes.on('error', failUpstream)
          upstreamRes.on('end', () => {
            if (settled) return
            const out: Record<string, string> = {}
            for (const name of WARMUP_PASSED_RESPONSE_HEADERS) {
              // unknown, not the declared header union: TS 7 narrows an
              // annotated string|string[]|undefined through Array.isArray to
              // never for the string-typed header keys.
              const raw: unknown = upstreamRes.headers[name]
              const value = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join(', ') : undefined
              if (value === undefined) continue
              if (name === 'vary') {
                const merged = mergeVary(res.getHeader?.('vary'), value)
                if (merged !== undefined) out.vary = merged
                continue
              }
              out[name] = value
            }
            try {
              res.writeHead(upstreamRes.statusCode ?? 502, out)
              res.end(Buffer.concat(chunks))
            } catch (error) {
              deps.logger.warn('gateway warmup: response write failed (' + (error instanceof Error ? error.name : 'unknown') + ')')
            } finally {
              settle()
            }
          })
        })
      } catch (error) {
        deps.logger.warn('gateway warmup: upstream request setup failed (' + (error instanceof Error ? error.name : 'unknown') + ')')
        failUpstream()
        return
      }
      upstream.on('error', failUpstream)
      upstream.setTimeout(WARMUP_UPSTREAM_TIMEOUT_MS, () => { upstream.destroy(new Error('warm-up upstream timeout')) })
      upstream.end()
    })
  }

  return {
    async links(options: WarmupLinkOptions = {}): Promise<WarmupLinks> {
      if (!deps.enabled) return { urls: [] }
      const port = readyPort()
      if (port === null) return { urls: [] }
      let secret: string
      try {
        secret = deps.getSecret()
      } catch (error) {
        deps.logger.warn('gateway warmup: session secret unavailable (' + (error instanceof Error ? error.name : 'unknown') + ')')
        return { urls: [] }
      }
      try {
        const discovered = await discover(port)
        if (discovered.length === 0) return { urls: [] }
        const grant = createWarmupCookie(secret, nowSeconds(), options.clientAddress)
        return { urls: discovered, cookie: buildWarmupCookieHeader(grant, options.secure === true) }
      } catch (error) {
        // The login page must never fail because of warm-up.
        deps.logger.warn('gateway warmup: link build failed (' + (error instanceof Error ? error.name : 'unknown') + ')')
        return { urls: [] }
      }
    },

    async handle(req: WarmupHttpRequest, res: WarmupHttpResponse, url: URL, clientAddress?: string): Promise<WarmupHandleOutcome> {
      if (!deps.enabled) return { kind: 'unclaimed' }
      // The RAW target when the adapter provides it: a dot-segment target must
      // not be normalized into the allowlist before it is checked. The parsed
      // URL is the fallback for structural callers.
      const rawTarget = typeof req.url === 'string' && req.url !== '' ? req.url : url.pathname + url.search
      if (!isWarmupPathAllowed(rawTarget)) return { kind: 'unclaimed' }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { error: 'method not allowed', code: 'method_not_allowed' }, { allow: 'GET, HEAD' })
        return { kind: 'rejected', code: 'method_not_allowed' }
      }
      // The boundary-derived client address, falling back to the socket peer
      // (the same identity the login-page mint used): the rate bucket and the
      // cookie binding must agree with dispatch's decision.
      const requestClient = clientAddress !== undefined && clientAddress !== '' ? clientAddress : (req.socket?.remoteAddress ?? '')
      // CAPABILITY FIRST (2026-09 review, MAJOR): the bucket used to be spent
      // before the cookie was looked at, so a caller WITHOUT any grant could
      // drain it (5 req/s keeps it empty) and every bundle request from that
      // client address — including a legitimately logged-in session on a NAT —
      // got 429 from this pre-auth leg, never reaching the auth gate's verdict
      // or its audit. design 17 §10.6: absent/stale/tampered/foreign cookie ⇒
      // unclaimed, so the route may not answer at all.
      const presented = readWarmupCookie(headerValue(req.headers, 'cookie'))
      if (presented === undefined) return { kind: 'unclaimed' }
      let granted = false
      // Only a PRESENTED capability pays for the HMAC (≤256 bytes).
      try {
        granted = verifyWarmupCookie(deps.getSecret(), presented, nowSeconds(), requestClient)
      } catch (error) {
        deps.logger.warn('gateway warmup: cookie verification unavailable (' + (error instanceof Error ? error.name : 'unknown') + ')')
        granted = false
      }
      if (!granted) return { kind: 'unclaimed' }
      // A verified capability still gets the per-client sustained cap: the
      // bucket is the abuse bound for the exfil leg, not an auth verdict.
      if (!limiter.consume(requestClient, now())) {
        // Documented refusal: 429 warmup_rate_limited (design 17 §10.6).
        writeJson(res, 429, { error: 'too many warm-up requests', code: 'warmup_rate_limited' }, { 'retry-after': '1' })
        return { kind: 'rejected', code: 'warmup_rate_limited' }
      }
      const port = readyPort()
      if (port === null) {
        writeJson(res, 503, { error: 'instance_unavailable', code: 'instance_unavailable' })
        return { kind: 'proxied' }
      }
      if (activeFetches >= maxConcurrentFetches) {
        writeJson(res, 503, { error: 'warm-up capacity exhausted', code: WARMUP_CAPACITY_CODE })
        return { kind: 'proxied' }
      }
      await proxyBundle(res, req, port, rawTarget)
      return { kind: 'proxied' }
    },
  }
}
