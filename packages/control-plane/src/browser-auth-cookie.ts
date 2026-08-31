/**
 * Browser-auth cookie bootstrap for the 0.1.2 wire (review-round3c P0).
 *
 * Upstream dsh-v0.1.2-alpha.1 added an unconditional browser-auth gate to the
 * web-profile host: every `/api` request and every `/api/remote.mux` upgrade
 * must carry a signed cookie minted through the process launch-token exchange
 * (`GET /?token=<launchToken>` → Set-Cookie; browser-auth.ts). The web
 * profile prints `dsh web: <url>?token=<launchToken>` at readiness
 * (printUrl defaults true), so the control plane — which spawns the local
 * instance and proxies every renderer call through
 * `/api/i/local/<api-path>` — can:
 *
 *   1. parse the launch token from the spawned child's stdout line;
 *   2. perform the token exchange once per spawn;
 *   3. keep the resulting cookie IN MEMORY (never persisted, never logged,
 *      never returned to the renderer — AGENTS.md credential discipline) and
 *      inject it into every proxied request / upgrade and every direct probe
 *      call for that instance.
 *
 * Old hosts (0.1.1-rc.2, no auth gate) print the URL line without a token —
 * the bootstrap then yields no cookie and operation continues as before.
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

/**
 * Parse the first URL from one `dsh web: <url>...` readiness line. Returns
 * undefined for any other line shape (log noise, old layouts).
 */
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
 * disabled. The host answers the index request with 303 + Set-Cookie; the
 * cookie name derives from the request authority, which is the same
 * `127.0.0.1:<port>` authority the proxy forwards with. Returns the
 * `name=value` cookie pair, or null when the host did not mint one.
 */
export async function exchangeLaunchToken(
  baseUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const url = new URL('/', baseUrl)
  url.searchParams.set('token', token)
  const response = await fetch(url, { redirect: 'manual', signal })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie === null || setCookie === '') return null
  const pair = setCookie.split(';', 1)[0]
  return pair === '' ? null : pair
}
