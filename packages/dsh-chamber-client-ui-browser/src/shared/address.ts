/**
 * Remote Browser address-bar parser — the pure host/scheme table of design 28
 * (W0 skeleton).
 *
 * ONE function decides what a typed address means for the launcher, so the
 * classification cannot drift between the UI, the forward request and the
 * tests:
 *
 *   - only http(s) is accepted; a missing scheme defaults to `http` (report v4
 *     §1) — a bare `host:port` is NOT read as a custom protocol;
 *   - `127.0.0.1` / `localhost` are the ONLY remote forward targets and are
 *     canonicalised to `127.0.0.1` (`kind: 'remote-loopback'`);
 *   - every other address is a public/system-browser URL (`kind: 'public'`),
 *     including RFC1918, other 127/8 spellings and hostnames — these are
 *     explicitly NOT remote targets, because the forward target is always the
 *     remote 127.0.0.1 (report v4 §1);
 *   - `[::1]` (and its IPv4-mapped forms) is refused in v1, which only
 *     guarantees the IPv4 loopback; `[::]` / `0.0.0.0` are refused as
 *     unspecified hosts;
 *   - userinfo, non-http(s) schemes, port 0, and the application's own origin
 *     (including its canonical loopback aliases on the same port) are refused;
 *   - path and query are preserved; the fragment never reaches a forward.
 *
 * Pure: no DOM, no Node APIs, no imports. Node's type stripping can run this
 * module directly (see test/address).
 *
 * TODO(W0/pin): the report v4 host/scheme table freezes this behaviour; once
 * vendor/harness-checkout is populated, re-check the pinned official
 * ui-sidebar-browser `parseBrowserAddress` (0.2.1-rc.2 used here as the API
 * shape: it defaults to HTTPS and refuses the app origin only by exact origin)
 * and record the deliberate differences (default http, loopback-alias origin
 * rejection, IPv6 refusal) in design 28.
 */

/** The two schemes the launcher may hand to the system browser or a forward. */
export type BrowserAddressScheme = 'http' | 'https'

/** Why an input is not a usable browser address. */
export type AddressRefusalReason =
  | 'empty'
  | 'too-long'
  | 'invalid'
  | 'protocol'
  | 'credentials'
  | 'application-origin'
  | 'ipv6-loopback'
  | 'unspecified-host'
  | 'alias-host'
  | 'loopback-other'
  | 'port'

/**
 * Where a public URL will actually be opened.
 *  - `local-machine`: the address is this machine's loopback (another 127/8
 *    spelling or a `*.localhost` name) — the system browser reaches the USER's
 *    machine, never the remote source;
 *  - `private-network`: RFC1918 / link-local / CGNAT — likely the user's LAN,
 *    with no guarantee the remote can reach it;
 *  - `public`: anything else (resolved hostnames are treated as public; this
 *    module deliberately never resolves names).
 */
export type PublicReachability = 'public' | 'local-machine' | 'private-network'

/** Fields shared by both accepted kinds (canonical URL, path and query). */
export interface BrowserAddressBase {
  scheme: BrowserAddressScheme
  /** Canonical URL without fragment and without userinfo. */
  url: string
  /** URL hostname as canonicalised by the URL parser (bracketed for IPv6). */
  host: string
  /** Effective port: explicit, or the scheme default (80/443). */
  port: number
  /** Pathname beginning with `/`. */
  path: string
  /** Search string WITHOUT the leading `?`; `''` when absent. */
  query: string
  /** `path` + `?query` — the only path form a forward may open. */
  requestPath: string
  /** True when the input carried a fragment that was dropped before the forward. */
  fragmentDropped: boolean
}

/** A URL the launcher hands to the system-browser link leg. */
export interface PublicBrowserAddress extends BrowserAddressBase {
  kind: 'public'
  reachability: PublicReachability
}

/** A remote loopback target: the launcher MUST request a forward for it. */
export interface RemoteLoopbackBrowserAddress extends BrowserAddressBase {
  kind: 'remote-loopback'
  /** Always the remote target host; the browser opens an alias, not this host. */
  host: '127.0.0.1'
}

/** A refused input: the launcher renders `reason` as copy and opens nothing. */
export interface UnsupportedBrowserAddress {
  kind: 'unsupported'
  reason: AddressRefusalReason
}

export type BrowserAddress =
  | PublicBrowserAddress
  | RemoteLoopbackBrowserAddress
  | UnsupportedBrowserAddress

/** Caller-supplied context (the app origin is never inferred here). */
export interface BrowserAddressOptions {
  /** The dsh document origin; a URL matching it (or a loopback alias on its port) is refused. */
  applicationOrigin?: string | undefined
}

/** Length ceiling mirroring the official address parser. */
export const MAX_BROWSER_ADDRESS_LENGTH = 16384

const DEFAULT_PORTS: Record<BrowserAddressScheme, number> = { http: 80, https: 443 }
const SCHEME_WITH_AUTHORITY = /^([A-Za-z][A-Za-z\d+.-]*):\/\//u
const SCHEME_PREFIX = /^([A-Za-z][A-Za-z\d+.-]*):/u
/** `host:port` (a bare default-http address), never a custom scheme. */
const HOST_PORT = /^[A-Za-z0-9._-]+:\d+(?:[/?#]|$)/u
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u

/** Host spellings that reach the SAME application on one port. */
const APPLICATION_LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Parse one address-bar value into the fixed host/scheme table.
 *
 * @param input - the raw address-bar value (untrusted).
 * @param options - the caller's application origin (document origin).
 * @returns a remote-loopback target, a public URL, or a refusal reason.
 */
export function parseBrowserAddress(
  input: unknown,
  options: BrowserAddressOptions = {},
): BrowserAddress {
  if (typeof input !== 'string') return refuse('invalid')
  const trimmed = input.trim()
  if (trimmed === '') return refuse('empty')
  if (trimmed.length > MAX_BROWSER_ADDRESS_LENGTH) return refuse('too-long')
  if (CONTROL_CHARS.test(trimmed)) return refuse('invalid')

  let candidate: string
  const withAuthority = SCHEME_WITH_AUTHORITY.exec(trimmed)
  if (withAuthority !== null) {
    const scheme = withAuthority[1].toLowerCase()
    if (scheme !== 'http' && scheme !== 'https') return refuse('protocol')
    candidate = trimmed
  } else {
    const prefix = SCHEME_PREFIX.exec(trimmed)
    // A bare `host:port` is not a scheme: `localhost:3000` must default to http,
    // not be read as the custom protocol `localhost:`.
    if (prefix !== null && !HOST_PORT.test(trimmed)) return refuse('protocol')
    candidate = `http://${trimmed}`
  }

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return refuse('invalid')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return refuse('protocol')
  // Credentials cannot be represented on the forward leg (main builds the URL
  // from an alias + path), so accepting them would silently drop them.
  if (parsed.username !== '' || parsed.password !== '') return refuse('credentials')
  if (isApplicationOrigin(parsed, options.applicationOrigin)) return refuse('application-origin')

  const scheme: BrowserAddressScheme = parsed.protocol === 'https:' ? 'https' : 'http'
  const port = parsed.port === '' ? DEFAULT_PORTS[scheme] : Number(parsed.port)
  // Port 0 is not a service and the forward gate only accepts 1..65535.
  if (!Number.isInteger(port) || port < 1 || port > 65535) return refuse('port')

  const fragmentDropped = parsed.hash !== ''
  // The fragment is never sent to the remote: it addresses a document position
  // in the LOCAL system browser, and main only ever builds scheme/host/port/path.
  parsed.hash = ''

  const hostname = normalizeHostname(parsed.hostname)
  if (hostname === '[::]') return refuse('unspecified-host')
  if (hostname === '[::1]' || hostname.startsWith('[::ffff:7f')) return refuse('ipv6-loopback')
  if (hostname === '0.0.0.0') return refuse('unspecified-host')
  const loopbackOctets = parseIpv4(hostname)
  if (loopbackOctets !== null && loopbackOctets[0] === 127 && hostname !== '127.0.0.1') {
    // 127.0.0.2..254 are our own browser aliases; any other 127/8 is a local
    // loopback spelling we never forward. Opening either would bypass the
    // per-source isolation (and the alias would point at another source).
    if (loopbackOctets[1] === 0 && loopbackOctets[2] === 0 && loopbackOctets[3] >= 2 && loopbackOctets[3] <= 254) {
      return refuse('alias-host')
    }
    return refuse('loopback-other')
  }

  const pathname = parsed.pathname === '' ? '/' : parsed.pathname
  const query = parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search
  const base = {
    scheme,
    port,
    path: pathname,
    query,
    requestPath: query === '' ? pathname : `${pathname}?${query}`,
    fragmentDropped,
  }

  if (hostname === '127.0.0.1' || hostname === 'localhost') {
    // Canonicalise the remote target: both spellings mean the remote's IPv4
    // loopback, and main must never see `localhost` as the forward target.
    parsed.hostname = '127.0.0.1'
    return {
      kind: 'remote-loopback',
      host: '127.0.0.1',
      url: parsed.href,
      ...base,
    }
  }

  return {
    kind: 'public',
    host: parsed.hostname,
    reachability: reachabilityFor(hostname),
    url: parsed.href,
    ...base,
  }
}

/** Build the refusal value (single shape, so every early return agrees). */
function refuse(reason: AddressRefusalReason): UnsupportedBrowserAddress {
  return { kind: 'unsupported', reason }
}

/** Lower-case and drop the DNS trailing dot (the URL parser already canonicalises most forms). */
function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/u, '')
}

/** Effective port of a parsed URL (the URL parser elides scheme defaults). */
function effectivePort(value: URL): number {
  if (value.port !== '') return Number(value.port)
  return value.protocol === 'https:' ? 443 : 80
}

/**
 * Whether a URL is the application itself.
 *
 * Exact origin equality is the stated rule; the loopback-alias arm additionally
 * covers `localhost:<port>` / `[::1]:<port>` against a `127.0.0.1:<port>`
 * document origin (review round-2 security I7): the control plane accepts any
 * loopback Host spelling, so an alias would open a preload-less duplicate shell.
 */
function isApplicationOrigin(parsed: URL, applicationOrigin: string | undefined): boolean {
  if (applicationOrigin === undefined || applicationOrigin === '') return false
  let app: URL
  try {
    app = new URL(applicationOrigin)
  } catch {
    return false
  }
  if (app.protocol !== 'http:' && app.protocol !== 'https:') return false
  if (parsed.origin === app.origin) return true

  const parsedHost = normalizeHostname(parsed.hostname)
  const appHost = normalizeHostname(app.hostname)
  if (!APPLICATION_LOOPBACK_HOSTS.has(parsedHost) || !APPLICATION_LOOPBACK_HOSTS.has(appHost)) {
    return false
  }
  return parsed.protocol === app.protocol && effectivePort(parsed) === effectivePort(app)
}

/** Classify where a PUBLIC URL will actually open (never a remote target). */
function reachabilityFor(hostname: string): PublicReachability {
  const octets = parseIpv4(hostname)
  if (octets !== null) {
    if (octets[0] === 127) return 'local-machine'
    if (isPrivateIpv4(octets)) return 'private-network'
    return 'public'
  }
  // `*.localhost` is defined to resolve to the user's loopback (RFC 6761), but it
  // is still not a remote target: the forward target is only 127.0.0.1.
  if (hostname.endsWith('.localhost')) return 'local-machine'
  return 'public'
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
  const match = IPV4.exec(hostname)
  if (match === null) return null
  const octets: number[] = []
  for (let index = 1; index <= 4; index += 1) {
    const octet = Number(match[index])
    if (octet > 255) return null
    octets.push(octet)
  }
  return octets as [number, number, number, number]
}

/** RFC1918 + link-local + CGNAT + `0.0.0.0/8`: local-network evidence only. */
function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 0) return true
  return false
}
