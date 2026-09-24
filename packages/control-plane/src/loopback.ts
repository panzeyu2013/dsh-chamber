/**
 * Loopback hostname classification. The exact-membership test below guards the
 * CORS/Host fence and the ssh/gateway transport loopback-origin gates;
 * isLoopbackUpstreamBaseUrl additionally recognizes IPv4-mapped IPv6 spellings
 * and dotted-quad 127.* prefixes for the TCP-keepalive decision.
 *
 * Deliberately narrower than dsh-client-connection's same-named
 * isLoopbackHostname (localhost, '[::1]', any 127/8, no bare '::1'): do not
 * merge the two without deciding which rule each call site needs.
 */

/** Loopback hostnames (any port) for the EXACT membership test. Module-private
 *  on purpose: exporting must not widen three security-relevant gates. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Exact loopback-hostname membership test used by the api.ts Host/CORS fence
 *  and the instance-proxy transport gates. Callers pass a URL-normalized
 *  hostname — WHATWG serializes IPv6 literals BRACKETED ('[::1]'), which is the
 *  reachable member; the bare '::1' member is kept defensively. Dotted-quad
 *  127.* prefixes and IPv4-mapped spellings are intentionally NOT part of this
 *  exact test (isLoopbackUpstreamBaseUrl owns those semantics). */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname)
}

/** True when an upstream base URL points at the loopback interface — the
 *  local instance and every ssh-tunnel local leg. Loopback cannot die
 *  half-open and tunnels are covered by ssh keepalive, so these legs keep the
 *  no-heartbeat design. Unparseable input fails toward loopback (no keepalive). */
export function isLoopbackUpstreamBaseUrl(baseUrl: string): boolean {
  let hostname: string
  try {
    hostname = new URL(baseUrl).hostname
  } catch {
    return true
  }
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true
  // IPv4-mapped IPv6 loopback spellings are loopback too, else a loopback-routed
  // leg gets a pointless keepalive arm. WHATWG serializes them canonically as
  // '[::ffff:7f00:1]', so match both dotted-quad and hex forms.
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  if (/^::ffff:(127\.|7f00)/.test(bare)) return true
  return /^127\./.test(hostname)
}
