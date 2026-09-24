/**
 * Frontend middleware: the HTML injection points for the proxied dsh frontend.
 * Because the gateway streams dsh's HTML (no buffer/rewrite), the surface is
 * deliberately minimal: viewport injection is an idempotent no-op (dsh's
 * index.html already carries the meta), CSP is relaxed in dispatch.ts as
 * GATEWAY_PROXY_CSP `script-src` (a nonce CSP MUST NOT be sent — it cannot be
 * backfilled into streamed HTML), and PWA link/shellNav injection stays deferred.
 */

import { isIP } from 'node:net'
import type { ApiCorsEvaluator, ApiRequest } from '@dsh-chamber/control-plane'
import type { GatewayConfig } from './config.ts'
import { headerValueAnyCase } from './http-utils.ts'

/** Non-secret facts about WHY a request failed the public boundary: only the
 * request's own values (Host/Origin) are ever echoed, never configuration. */
export type GatewayRejectionReason =
  | { kind: 'malformed_headers' }
  | { kind: 'host_rejected'; host?: string }
  | { kind: 'origin_invalid'; origin: string }
  | { kind: 'origin_mismatch'; origin: string; authority: string }
  | { kind: 'cross_site_no_origin' }

export interface GatewayRequestDecision {
  allowed: boolean
  /** Malformed headers are 400; Host/authority failures 421; origin failures 403. */
  status: 200 | 400 | 403 | 421
  code: 'ok' | 'bad_request' | 'misdirected_request' | 'origin_forbidden'
  headers: Record<string, string>
  /** Boundary-derived facts consumed by auth. Never read XFF again downstream. */
  clientAddress: string
  secure: boolean
  /** Present exactly when `allowed` is false: the failing check for diagnostics. */
  reason?: GatewayRejectionReason
}

export interface GatewayRequestPolicy {
  evaluate(req: ApiRequest): GatewayRequestDecision
  corsEvaluator: ApiCorsEvaluator
}

function hasDuplicateRawHeader(req: ApiRequest, name: string): boolean {
  if (req.rawHeaders === undefined) return false
  let count = 0
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === name) count += 1
  }
  return count > 1
}

function normalizeIp(raw: string | undefined): string {
  if (raw === undefined) return ''
  let value = raw.trim().toLowerCase()
  const zone = value.indexOf('%')
  if (zone !== -1) value = value.slice(0, zone)
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) value = value.slice(7)
  return isIP(value) === 0 ? '' : value
}

function ipv4Octets(address: string): number[] | null {
  if (isIP(address) !== 4) return null
  return address.split('.').map(Number)
}

function isLoopbackIp(address: string): boolean {
  const v4 = ipv4Octets(address)
  return v4 !== null ? v4[0] === 127 : address === '::1'
}

function isPrivateIp(address: string): boolean {
  const v4 = ipv4Octets(address)
  if (v4 !== null) {
    return v4[0] === 10
      || (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31)
      || (v4[0] === 192 && v4[1] === 168)
      || (v4[0] === 169 && v4[1] === 254)
      || (v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127)
  }
  if (isIP(address) !== 6) return false
  return /^f[cd]/.test(address) || /^fe[89ab]/.test(address)
}

function hostIp(hostname: string): string {
  const unbracketed = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return normalizeIp(unbracketed)
}

function parseAuthority(protocol: 'http:' | 'https:', rawHost: string | undefined): URL | null {
  if (rawHost === undefined || rawHost === '' || rawHost.includes(',') || /[\s/@]/.test(rawHost)) return null
  try {
    const parsed = new URL(`${protocol}//${rawHost}`)
    if (parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/'
      || parsed.search !== '' || parsed.hash !== '' || parsed.host !== rawHost.toLowerCase()) return null
    return parsed
  } catch {
    return null
  }
}

function canonicalOrigin(raw: string | undefined): string | null {
  if (raw === undefined || raw === '' || raw.includes(',')) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return raw === parsed.origin ? parsed.origin : null
    if ((parsed.protocol === 'capacitor:' || parsed.protocol === 'openchamber-ui:')
      && parsed.username === '' && parsed.password === ''
      && (parsed.pathname === '' || parsed.pathname === '/')
      && parsed.search === '' && parsed.hash === ''
      && raw === `${parsed.protocol}//${parsed.host}`) return raw
    return null
  } catch {
    return null
  }
}

/** Build the one public request boundary shared by HTTP, OPTIONS and WS.
 * Forwarded facts are ignored unless the immediate peer is a trusted proxy;
 * private/loopback authorities are accepted only from private peers. */
export function createGatewayRequestPolicy(config: GatewayConfig): GatewayRequestPolicy {
  const allowedOrigins = new Set(config.corsOrigins)
  const explicitAuthorities = new Map<string, URL>()
  if (config.publicOrigin !== undefined) {
    explicitAuthorities.set(config.publicOrigin, new URL(config.publicOrigin))
  }
  const trustedProxies = new Set(config.trustedProxies.map(value => normalizeIp(value)).filter(Boolean))
  const listenPort = config.plane.port
  const cache = new WeakMap<object, GatewayRequestDecision>()

  function evaluateUncached(req: ApiRequest): GatewayRequestDecision {
    const peerAddress = normalizeIp(req.socket?.remoteAddress)
    const trustedProxy = peerAddress !== '' && trustedProxies.has(peerAddress)
    // Node keeps only one normalized Authorization value for duplicate field
    // lines, so inspect the original pairs before any auth work: a valid first
    // value must never mask a second attacker-controlled one.
    if (hasDuplicateRawHeader(req, 'authorization')) {
      return { allowed: false, status: 400, code: 'bad_request', headers: {}, clientAddress: '', secure: false, reason: { kind: 'malformed_headers' } }
    }
    if (hasDuplicateRawHeader(req, 'host')
      || (trustedProxy && (hasDuplicateRawHeader(req, 'x-forwarded-host')
        || hasDuplicateRawHeader(req, 'x-forwarded-proto')
        || hasDuplicateRawHeader(req, 'x-forwarded-for')))) {
      return { allowed: false, status: 421, code: 'misdirected_request', headers: {}, clientAddress: '', secure: false, reason: { kind: 'host_rejected' } }
    }
    const forwardedHost = trustedProxy ? headerValueAnyCase(req.headers, 'x-forwarded-host') : undefined
    const forwardedProto = trustedProxy ? headerValueAnyCase(req.headers, 'x-forwarded-proto') : undefined
    const forwardedFor = trustedProxy ? headerValueAnyCase(req.headers, 'x-forwarded-for') : undefined
    if ((forwardedHost !== undefined && forwardedHost.includes(','))
      || (forwardedProto !== undefined && forwardedProto.includes(','))
      || (forwardedFor !== undefined && (forwardedFor.includes(',') || normalizeIp(forwardedFor) === ''))) {
      return { allowed: false, status: 421, code: 'misdirected_request', headers: {}, clientAddress: '', secure: false, reason: { kind: 'host_rejected' } }
    }

    const socketSecure = req.socket?.encrypted === true
    const protocol: 'http:' | 'https:' = socketSecure || forwardedProto?.toLowerCase() === 'https' ? 'https:' : 'http:'
    if (forwardedProto !== undefined && forwardedProto !== 'http' && forwardedProto !== 'https') {
      return { allowed: false, status: 421, code: 'misdirected_request', headers: {}, clientAddress: '', secure: false, reason: { kind: 'host_rejected' } }
    }
    const rawHost = forwardedHost ?? headerValueAnyCase(req.headers, 'host')
    const authority = parseAuthority(protocol, rawHost)
    const forwardedClient = normalizeIp(forwardedFor)
    // A declared reverse proxy's socket address is never a client identity;
    // missing XFF is unknown, not a loopback/private fallback.
    const clientAddress = trustedProxy ? forwardedClient : peerAddress
    if (authority === null) {
      return { allowed: false, status: 421, code: 'misdirected_request', headers: {}, clientAddress, secure: protocol === 'https:', reason: { kind: 'host_rejected', ...(rawHost !== undefined && rawHost !== '' ? { host: rawHost } : {}) } }
    }

    let requestOrigin: string | null = null
    const explicitAuthority = explicitAuthorities.get(authority.origin)
    if (explicitAuthority !== undefined) {
      const publicAddress = hostIp(explicitAuthority.hostname)
      const publicIsLoopback = explicitAuthority.hostname === 'localhost' || isLoopbackIp(publicAddress)
      const publicIsPrivate = isPrivateIp(publicAddress)
      if ((!publicIsLoopback || isLoopbackIp(clientAddress))
        && (!publicIsPrivate || isLoopbackIp(clientAddress) || isPrivateIp(clientAddress))) {
        requestOrigin = explicitAuthority.origin
      }
    } else {
      const authorityAddress = hostIp(authority.hostname)
      const authorityLoopback = authority.hostname === 'localhost' || isLoopbackIp(authorityAddress)
      const authorityPrivate = isPrivateIp(authorityAddress)
      const peerLoopback = isLoopbackIp(clientAddress)
      const peerPrivate = isPrivateIp(clientAddress)
      const effectivePort = authority.port === '' ? (protocol === 'https:' ? 443 : 80) : Number(authority.port)
      const localPortMatches = effectivePort === listenPort
      if (localPortMatches && ((authorityLoopback && peerLoopback)
        || (authorityPrivate && (peerLoopback || peerPrivate)))) {
        requestOrigin = authority.origin
      }
    }
    if (requestOrigin === null) {
      return { allowed: false, status: 421, code: 'misdirected_request', headers: {}, clientAddress, secure: protocol === 'https:', reason: { kind: 'host_rejected', host: authority.host } }
    }

    const originHeader = headerValueAnyCase(req.headers, 'origin')
    const origin = canonicalOrigin(originHeader)
    if (originHeader !== undefined && (origin === null || (origin !== requestOrigin && !allowedOrigins.has(origin)))) {
      return {
        allowed: false, status: 403, code: 'origin_forbidden', headers: {}, clientAddress, secure: protocol === 'https:',
        reason: origin === null
          ? { kind: 'origin_invalid', origin: originHeader }
          : { kind: 'origin_mismatch', origin, authority: requestOrigin },
      }
    }
    // A cross-site browser request without an Origin must not bypass the Origin
    // check via a navigation or media load; allowlisted CORS calls carry Origin.
    if (originHeader === undefined && headerValueAnyCase(req.headers, 'sec-fetch-site') === 'cross-site') {
      return { allowed: false, status: 403, code: 'origin_forbidden', headers: {}, clientAddress, secure: protocol === 'https:', reason: { kind: 'cross_site_no_origin' } }
    }
    const headers: Record<string, string> = origin === null ? {} : {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      vary: 'Origin',
    }
    return { allowed: true, status: 200, code: 'ok', headers, clientAddress, secure: protocol === 'https:' }
  }

  function evaluate(req: ApiRequest): GatewayRequestDecision {
    const cached = cache.get(req as object)
    if (cached !== undefined) return cached
    const decision = evaluateUncached(req)
    cache.set(req as object, decision)
    return decision
  }

  return {
    evaluate,
    corsEvaluator: req => {
      const decision = evaluate(req)
      return { allowed: decision.allowed, headers: decision.headers }
    },
  }
}

