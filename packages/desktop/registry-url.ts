/**
 * npm registry URL whitelist for the dsh runtime version channel (design 16
 * §4/§6). The main process only ever fetches from these registry domains —
 * metadata (`/{packageName}`), tarballs (`/{package}/-/{file}.tgz`) and the
 * search endpoint (`/-/v1/search`) — so the trust anchor stays explicit
 * (「切换源即切换信任边界」, design §3.6): a custom registry origin only
 * becomes reachable after it passes this same validation.
 *
 * Same validation structure as main.ts `isAllowedReleaseUrl` (new URL +
 * origin whitelist + userinfo rejection + decode-then-re-normalize), newly
 * written for the registry domain because the GitHub-hardcoded instance is
 * not reusable (design 16 §6). `desktop_npm_search` is folded onto this same
 * gate in the M2 wiring; this module itself is pure logic with no IPC.
 */
export const ALLOWED_REGISTRY_ORIGINS: readonly string[] = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
]

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
 * Whether `raw` is a URL the dsh runtime channel may fetch: it parses with
 * `new URL`, its origin is in `origins` (defaults to
 * `ALLOWED_REGISTRY_ORIGINS`), it carries no userinfo, and its pathname —
 * after percent-decoding and re-normalizing through a fresh URL (the
 * encoding-traversal defense) — is one of the allowed registry shapes:
 * metadata `/@scope/name` or `/name`, tarball `/@scope/name/-/file.tgz` or
 * `/name/-/file.tgz`, or the search endpoint `/-/v1/search`. Anything
 * unparsable, off-origin, credentialed or off-shape returns false.
 */
export function isAllowedRegistryUrl(raw: unknown, origins?: readonly string[]): boolean {
  if (typeof raw !== 'string') return false
  const allowed = origins ?? ALLOWED_REGISTRY_ORIGINS
  try {
    const url = new URL(raw)
    if (!allowed.includes(url.origin)) return false
    // `new URL` ignores userinfo for `origin`; reject any credentialed URL so
    // the whitelist can never be pointed at a user:pass@ registry URL.
    if (url.username !== '' || url.password !== '') return false
    // `new URL` does NOT decode percent-encoded path segments, so an encoded
    // `..%2f..%2f` traversal would pass a raw pathname shape check yet land
    // on an arbitrary path under the registry. Decode the pathname and
    // re-normalize through a fresh URL — the traversal then resolves like a
    // literal one and fails the shape check below.
    const normalized = new URL(`${url.origin}${decodeURIComponent(url.pathname)}`).pathname
    return isAllowedRegistryPath(normalized)
  } catch {
    // Unparsable URL, malformed percent-encoding (decodeURIComponent throws),
    // or a re-normalization failure — never allowed.
    return false
  }
}

/**
 * The three allowed path shapes under a whitelisted registry origin:
 * - search endpoint: `/-/v1/search` (npm's `/-/v1/search?text=…` API);
 * - metadata: `/name` or `/@scope/name`;
 * - tarball: `/name/-/file.tgz` or `/@scope/name/-/file.tgz`.
 * Any other path (including one a traversal resolved to) is rejected.
 */
function isAllowedRegistryPath(pathname: string): boolean {
  if (pathname === '/-/v1/search' || pathname.startsWith('/-/v1/search/')) return true
  return /^\/(?:@[^/]+\/)?[^/]+(?:\/-\/[^/]+)?$/.test(pathname)
}
