/**
 * Browser-auth cookie bootstrap for the web-profile wire.
 *
 * The upstream web-profile host enforces a browser-auth gate: every `/api`
 * request and `/api/remote.mux` upgrade must carry a signed cookie minted
 * through the launch-token exchange (`GET /?token=<launchToken>` →
 * Set-Cookie). The control plane parses the launch token from the spawned
 * child's `dsh web: <url>` readiness line, performs the exchange once per
 * spawn, and keeps the resulting cookie IN MEMORY only — never persisted,
 * never logged, never returned to the renderer — injecting it into every
 * proxied request/upgrade and direct probe. Hosts with no auth gate print the
 * URL without a token: no cookie, and operation continues without one.
 */

/** In-memory per-instance browser-auth cookie registry (baseUrl → cookie). */
const AUTH_COOKIES = new Map<string, string>()

/** The cookie for one instance baseUrl, or undefined when not bootstrapped. */
export function authCookieFor(baseUrl: string): string | undefined {
  return AUTH_COOKIES.get(baseUrl)
}

/** Record the minted browser-auth cookie for one instance baseUrl. */
export function registerAuthCookie(baseUrl: string, cookie: string): void {
  if (cookie !== '') AUTH_COOKIES.set(baseUrl, cookie)
}

/** Drop the cookie (instance reaped / spawn failed). */
export function clearAuthCookie(baseUrl: string): void {
  AUTH_COOKIES.delete(baseUrl)
}

/** Parse the first URL from one `dsh web: <url>...` readiness line; undefined
 *  for any other line shape (log noise, old layouts). */
export function parseDshWebUrlLine(line: string): string | undefined {
  // Both http and https shapes; the URL run stops at whitespace, so a
  // `(LAN: …)` suffix (and any `?token=…` query) is part of the captured URL.
  const match = /dsh web:\s*(https?:\/\/\S+)/.exec(line)
  return match === null ? undefined : match[1].trim()
}

/** Extract the launch token query value from an authenticated URL. */
export function extractLaunchToken(url: string): string | undefined {
  try {
    const token = new URL(url).searchParams.get('token')
    return token === null || token === '' ? undefined : token
  } catch {
    return undefined
  }
}

/**
 * Perform the launch-token exchange: `GET /?token=<token>` with redirects
 * disabled. Only the upstream acceptance answer counts as a mint: a correct
 * token gets 303 + `location: '/'` + Set-Cookie, every other index request a
 * plain-text 401 — any other status, unusable Location, or a redirect that
 * does not normalize to the clean index path yields null instead of
 * registering a credential the host never issued. The cookie name derives from
 * the request authority, the same `127.0.0.1:<port>` the proxy forwards as
 * Host.
 */
export async function exchangeLaunchToken(
  baseUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const url = new URL('/', baseUrl)
  url.searchParams.set('token', token)
  const response = await fetch(url, { redirect: 'manual', signal })
  if (response.status !== 303) return null
  const location = response.headers.get('location')
  if (location === null || location === '') return null
  let redirectPath: string
  try {
    redirectPath = new URL(location, url).pathname
  } catch {
    // An unparseable Location is not the documented clean-index redirect.
    return null
  }
  if (redirectPath !== '/') return null
  const setCookie = response.headers.get('set-cookie')
  if (setCookie === null || setCookie === '') return null
  const pair = setCookie.split(';', 1)[0]
  return pair === '' ? null : pair
}
