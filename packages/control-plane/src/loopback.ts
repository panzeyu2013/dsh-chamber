/**
 * Loopback hostname classification — the single leaf for the hostname tests
 * that used to live in api.ts and instance-proxy.ts (A2 single-sourcing):
 *
 * - the CORS/Host fence exact-membership test (api.ts corsFor);
 * - the ssh/gateway transport loopback-origin gates (instance-proxy.ts
 *   registerTransport) — the same exact-membership test;
 * - the upstream TCP-keepalive decision (isLoopbackUpstreamBaseUrl, backing
 *   instance-proxy.ts tcpKeepAliveMsForUpstream), which also recognizes
 *   IPv4-mapped IPv6 spellings and dotted-quad 127.* prefixes.
 *
 * NOTE — sibling leaf with the SAME function name and DIFFERENT semantics:
 * dsh-client-connection/src/loopback-hostname.ts `isLoopbackHostname`
 * (upstream-shaped browser copy) treats localhost, '[::1]' AND ANY dotted-quad
 * 127/8 as loopback, and does NOT include the bare '::1'. This module's
 * exact-membership test is deliberately narrower (it guards the CORS/Host
 * fence and transport gates). Do NOT merge the two without deciding which
 * rule each call site needs.
 */

/** Hostnames treated as loopback (any port) by the EXACT membership test.
 *  Module-private on purpose: single-sourcing must not widen three
 *  security-relevant gates through a mutable shared container — only
 *  isLoopbackHostname below is exported. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Exact loopback-hostname membership test (LOOPBACK_HOSTNAMES.has): the
 * test used by the api.ts Host/CORS fence and the instance-proxy transport
 * loopback-origin gates. Callers pass a URL-normalized hostname — WHATWG
 * serializes an IPv6 literal BRACKETED ('[::1]'), which is the reachable
 * member here; the bare '::1' member is kept defensively. Dotted-quad
 * 127.* prefixes and IPv4-mapped IPv6 spellings are intentionally NOT part
 * of this exact test (isLoopbackUpstreamBaseUrl owns those semantics). */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname)
}

/** True when an upstream base URL points at the loopback interface — the
 * local instance and every ssh-tunnel local leg. Such legs cannot die
 * half-open on their own (loopback), and tunnels are covered by ssh keepalive
 * (proxy-forward.ts WS_PING_* note), so they keep the documented no-heartbeat
 * design. Anything unparseable fails toward loopback (no keepalive). */
export function isLoopbackUpstreamBaseUrl(baseUrl: string): boolean {
  let hostname: string
  try {
    hostname = new URL(baseUrl).hostname
  } catch {
    return true
  }
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true
  // IPv4-mapped IPv6 loopback spellings are loopback too — without this a
  // loopback-routed leg would get a pointless keepalive arm (harmless
  // over-arm, but wrong). WHATWG serializes mapped addresses canonically:
  // '[::ffff:127.0.0.1]' arrives as '[::ffff:7f00:1]' (hex), so match both
  // canonical forms.
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  if (/^::ffff:(127\.|7f00)/.test(bare)) return true
  return /^127\./.test(hostname)
}
