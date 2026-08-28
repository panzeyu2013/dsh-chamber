export type GatewayUrlError = 'required' | 'https' | 'origin' | 'host'

export type GatewayUrlResult =
  | { ok: true; scheme: 'http' | 'https'; host: string; port: number; origin: string }
  | { ok: false; error: GatewayUrlError }

/**
 * Parse the user-facing gateway URL into the existing non-secret registry
 * shape (`host` + `remotePort`) plus the explicit scheme (design 17 §9.1:
 * `http://` is an explicit user decision, never pre-blocked — §13.1 S21).
 * A credential-free `http://` or `https://` origin is accepted; ports default
 * https→443 / http→80; paths/query/fragments must never be silently
 * discarded. The `'https'` error code is retained for legacy copy/callers but
 * is no longer produced (http is accepted) — the form never triggers it.
 */
export function parseGatewayUrl(raw: string): GatewayUrlResult {
  const value = raw.trim()
  if (value === '') return { ok: false, error: 'required' }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, error: 'origin' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'origin' }
  if (url.username !== '' || url.password !== '' || url.pathname !== '/'
    || url.search !== '' || url.hash !== '') return { ok: false, error: 'origin' }
  if (url.hostname === '' || url.hostname.length > 253) return { ok: false, error: 'host' }
  const scheme = url.protocol === 'https:' ? 'https' : 'http'
  const defaultPort = scheme === 'https' ? 443 : 80
  const port = url.port === '' ? defaultPort : Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'origin' }
  return {
    ok: true,
    scheme,
    host: url.hostname,
    port,
    origin: port === defaultPort ? `${scheme}://${url.hostname}` : `${scheme}://${url.hostname}:${port}`,
  }
}

/** Renderer display projection; no secret is involved. `insecureHttp` picks
 * the http:// scheme (design 17 §9.1 — the honest 明文 display stays visible
 * after configuring, §13.1 S21). */
export function formatGatewayUrl(host: string, port: number, insecureHttp: boolean): string {
  const scheme = insecureHttp ? 'http' : 'https'
  const defaultPort = insecureHttp ? 80 : 443
  return port === defaultPort ? `${scheme}://${host}` : `${scheme}://${host}:${port}`
}
