export type GatewayUrlError = 'required' | 'https' | 'origin' | 'host'

export type GatewayUrlResult =
  | { ok: true; host: string; port: number; origin: string }
  | { ok: false; error: GatewayUrlError }

/** Parse the user-facing gateway URL into the existing non-secret registry
 * shape (`host` + `remotePort`). Only a credential-free HTTPS origin is
 * accepted; paths/query/fragments must never be silently discarded. */
export function parseGatewayUrl(raw: string): GatewayUrlResult {
  const value = raw.trim()
  if (value === '') return { ok: false, error: 'required' }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, error: 'origin' }
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'https' }
  if (url.username !== '' || url.password !== '' || url.pathname !== '/'
    || url.search !== '' || url.hash !== '') return { ok: false, error: 'origin' }
  if (url.hostname === '' || url.hostname.length > 253) return { ok: false, error: 'host' }
  const port = url.port === '' ? 443 : Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'origin' }
  return {
    ok: true,
    host: url.hostname,
    port,
    origin: port === 443 ? `https://${url.hostname}` : `https://${url.hostname}:${port}`,
  }
}

/** Renderer display projection; no secret is involved. */
export function formatGatewayUrl(host: string, port: number): string {
  return port === 443 ? `https://${host}` : `https://${host}:${port}`
}
