/**
 * npm registry URL whitelist for the dsh runtime version channel. The main process only
 * ever fetches metadata (`/{packageName}`), tarballs (`/{package}/-/{file}.tgz`) and
 * search (`/-/v1/search`) from these origins, so the trust anchor stays explicit
 * (切换源即切换信任边界): a custom registry origin only becomes reachable after it passes
 * this same validation. The structure mirrors main.ts `isAllowedReleaseUrl` (new URL +
 * origin whitelist + userinfo rejection + decode-then-re-normalize); `desktop_npm_search`
 * folds onto the same gate. Pure logic, no IPC.
 */
/** npm 官方 registry origin —— 默认源与白名单首项的单一来源（gateway 也消费它）。 */
export const DEFAULT_REGISTRY_ORIGIN = 'https://registry.npmjs.org'

export const ALLOWED_REGISTRY_ORIGINS: readonly string[] = [
  DEFAULT_REGISTRY_ORIGIN,
  'https://registry.npmmirror.com',
]

/** npmmirror's tarball CDN host (its metadata host 302-redirects downloads here). */
export const NPMIRROR_CDN_ORIGIN = 'https://cdn.npmmirror.com'

/**
 * The origins a registry's tarball download may legitimately touch (the registry itself
 * plus any CDN it redirects to): npmmirror serves metadata from registry.npmmirror.com but
 * 302-redirects tarballs to cdn.npmmirror.com, and both the initial-URL check and the
 * per-hop gate must allow that CDN. SRI is still enforced after download, so the CDN
 * cannot substitute bytes.
 */
export function registryRedirectOrigins(origin: string): readonly string[] {
  if (origin === 'https://registry.npmmirror.com') {
    return ['https://registry.npmmirror.com', NPMIRROR_CDN_ORIGIN]
  }
  return [origin]
}

/** Canonicalize a registry setting to an exact origin (never a path/query). */
export function canonicalRegistryOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const url = new URL(raw)
    const loopbackHttp = url.protocol === 'http:'
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
    if (url.protocol !== 'https:' && !loopbackHttp) return null
    if (url.username !== '' || url.password !== '') return null
    if (url.pathname !== '' && url.pathname !== '/') return null
    if (url.search !== '' || url.hash !== '') return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * Whether `raw` is a URL the dsh runtime channel may fetch: it parses, its origin is in
 * `origins` (default ALLOWED_REGISTRY_ORIGINS), it carries no userinfo, and its pathname —
 * after percent-decoding and re-normalizing through a fresh URL (the encoding-traversal
 * defense) — is an allowed shape: metadata `/name` or `/@scope/name`, tarball
 * `/name/-/file.tgz` (scoped too), search `/-/v1/search`, or the npmmirror CDN tarball
 * layout on the CDN origin. Anything unparsable, off-origin, credentialed or off-shape
 * returns false.
 */
export function isAllowedRegistryUrl(raw: unknown, origins?: readonly string[]): boolean {
  if (typeof raw !== 'string') return false
  const allowed = origins ?? ALLOWED_REGISTRY_ORIGINS
  try {
    const url = new URL(raw)
    if (!allowed.includes(url.origin)) return false
    // `new URL` ignores userinfo for `origin`; reject any credentialed URL so the
    // whitelist can never be pointed at a user:pass@ registry URL.
    if (url.username !== '' || url.password !== '') return false
    // `new URL` does NOT decode percent-encoded path segments, so an encoded
    // `..%2f..%2f` traversal would pass a raw shape check yet land on an arbitrary path.
    // Decode and re-normalize through a fresh URL: it resolves like a literal one and
    // fails the shape check below.
    const normalized = new URL(`${url.origin}${decodeURIComponent(url.pathname)}`).pathname
    return isAllowedRegistryPath(normalized, url.origin)
  } catch {
    // Unparsable URL, malformed percent-encoding or a re-normalization failure — never allowed.
    return false
  }
}

/**
 * The allowed path shapes under a whitelisted origin: search `/-/v1/search`; metadata
 * `/name` or `/@scope/name`; tarball `/name/-/file.tgz` (scoped too); and, ONLY on the
 * npmmirror CDN origin, `/packages/[<@scope>/]<name>/<version>/<file>.tgz`. Any other
 * path (including one a traversal resolved to) is rejected.
 */
function isAllowedRegistryPath(pathname: string, origin: string): boolean {
  if (pathname === '/-/v1/search' || pathname.startsWith('/-/v1/search/')) return true
  if (origin === NPMIRROR_CDN_ORIGIN
    && /^\/packages\/(?:@[^/]+\/)?[^/]+\/[^/]+\/[^/]+\.tgz$/.test(pathname)) return true
  return /^\/(?:@[^/]+\/)?[^/]+(?:\/-\/[^/]+)?$/.test(pathname)
}
