/**
 * Gateway configuration (design 17 §3.1): the parsed config of the
 * server-side access shape — bind host/port, state/dsh roots, auth kind,
 * channels/ui flags, CORS origins, optional TLS. `parseGatewayConfig` enforces
 * the S1 exposure guard at config time: a non-loopback bind without auth is a
 * configuration error (the CLI surfaces it as exit 2).
 */

import { isIP } from 'node:net'

export type GatewayBindHost = '127.0.0.1' | '0.0.0.0'
export type GatewayAuthKind = 'none' | 'password' | 'token' | 'password+token'
export const MIN_GATEWAY_PASSWORD_CHARS = 12
export const MAX_GATEWAY_PASSWORD_CHARS = 1024
export const MIN_GATEWAY_TOKEN_CHARS = 32
export const MAX_GATEWAY_TOKEN_CHARS = 4096

export interface GatewayConfig {
  plane: {
    port: number
    host: GatewayBindHost
    stateDir: string
    dshWorkspacePath: string
  }
  auth: {
    kind: GatewayAuthKind
    /** scrypt-verified browser credential (design 17 §5). */
    password?: string
    /** shared bearer token (design 17 §6.4 D7). May coexist with password. */
    token?: string
  }
  channels: { direct: boolean; ssh: boolean }
  corsOrigins: string[]
  /** Exact proxy peer IPs whose Forwarded/X-Forwarded facts may be trusted.
   * Empty by default: a direct client can never self-assert its address/TLS. */
  trustedProxies: string[]
  /** The operator's expected public authority (S11), e.g. `https://gateway.example.com`.
   * When set, requests with an unrecognized Host are rejected (421). */
  publicOrigin?: string
  tls?: { cert: string; key: string }
  /** Explicit operator opt-in (design 17 §3.1 S1 deviation): bind externally
   * with NO authentication. Default false — the S1 exposure guard stays hard.
   * The CLI surfaces this as --allow-anonymous-external. */
  allowAnonymousExternal?: boolean
}

/** Raw config input (CLI flags already resolved by the CLI entry; env fallback
 * applied here). Every field is optional — defaults fill the rest. */
export interface GatewayConfigInput {
  host?: string
  port?: number
  stateDir?: string
  dshWorkspacePath?: string
  uiPassword?: string
  apiToken?: string
  corsOrigins?: string[]
  tlsCert?: string
  tlsKey?: string
  publicOrigin?: string
  trustedProxies?: string[]
  allowAnonymousExternal?: boolean
}

/** Configuration error (surfaced as exit 2 by the CLI). */
export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GatewayConfigError'
  }
}

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

function canonicalOrigin(value: string, label: string): string {
  try {
    const parsed = new URL(value)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || value !== parsed.origin) {
      throw new Error('not a canonical HTTP origin')
    }
    return parsed.origin
  } catch {
    throw new GatewayConfigError(`${label} must be a canonical http(s) origin (scheme + authority only), got ${JSON.stringify(value)}`)
  }
}

function canonicalCorsOrigin(value: string): string {
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return canonicalOrigin(value, '--cors-origin')
    // Packaged clients use opaque custom schemes (design 17 §5.2). URL.origin
    // is the literal "null" for these, so validate the exact scheme+authority
    // string instead of normalizing through `.origin`.
    if ((parsed.protocol === 'capacitor:' || parsed.protocol === 'openchamber-ui:')
      && parsed.username === '' && parsed.password === ''
      && (parsed.pathname === '' || parsed.pathname === '/')
      && parsed.search === '' && parsed.hash === ''
      && value === `${parsed.protocol}//${parsed.host}`) return value
  } catch { /* mapped to the stable config error below */ }
  throw new GatewayConfigError(`--cors-origin must be a canonical http(s) or supported packaged-app origin, got ${JSON.stringify(value)}`)
}

function trustedProxyList(input: string[] | undefined): string[] {
  const fromEnv = firstEnv('DSH_GATEWAY_TRUSTED_PROXIES')
  const values = input ?? (fromEnv === undefined ? [] : fromEnv.split(',').map(value => value.trim()).filter(Boolean))
  const unique = new Set<string>()
  for (const value of values) {
    if (isIP(value) === 0) {
      throw new GatewayConfigError(`trusted proxy must be an exact IP address, got ${JSON.stringify(value)}`)
    }
    unique.add(value)
  }
  return [...unique]
}

/**
 * Parse + validate the gateway config. Throws GatewayConfigError on any
 * invalid value (S1 exposure guard included). stateDir/dshWorkspacePath are
 * required here — the caller resolves their defaults (DEFAULT_STATE_DIR /
 * defaultDshWorkspacePath from @dsh-chamber/control-plane) before calling.
 */
export function parseGatewayConfig(input: GatewayConfigInput, stateDir: string, dshWorkspacePath: string): GatewayConfig {
  const host = input.host ?? firstEnv('DSH_GATEWAY_HOST') ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== '0.0.0.0') {
    throw new GatewayConfigError(`host must be '127.0.0.1' or '0.0.0.0', got ${JSON.stringify(host)}`)
  }
  const portRaw = input.port ?? Number(firstEnv('DSH_GATEWAY_PORT') ?? 3000)
  if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
    throw new GatewayConfigError(`invalid port: ${String(portRaw)}`)
  }
  const password = input.uiPassword ?? firstEnv('DSH_GATEWAY_PASSWORD')
  const token = input.apiToken ?? firstEnv('DSH_GATEWAY_TOKEN')
  // An empty credential is not auth (S1): reject loudly, never treat it as a
  // satisfied password/token kind that would silently fail-closed.
  if (password === '') throw new GatewayConfigError('--ui-password must not be empty')
  if (token === '') throw new GatewayConfigError('--api-token must not be empty')
  if (password !== undefined && (password.length < MIN_GATEWAY_PASSWORD_CHARS || password.length > MAX_GATEWAY_PASSWORD_CHARS)) {
    throw new GatewayConfigError(`--ui-password must be ${MIN_GATEWAY_PASSWORD_CHARS}-${MAX_GATEWAY_PASSWORD_CHARS} characters`)
  }
  if (token !== undefined && (token.length < MIN_GATEWAY_TOKEN_CHARS || token.length > MAX_GATEWAY_TOKEN_CHARS
    || !/^[\x20-\x7e]+$/.test(token))) {
    throw new GatewayConfigError(`--api-token must be ${MIN_GATEWAY_TOKEN_CHARS}-${MAX_GATEWAY_TOKEN_CHARS} visible ASCII characters; generate it with a CSPRNG`)
  }
  const kind: GatewayAuthKind = password !== undefined && token !== undefined
    ? 'password+token'
    : password !== undefined ? 'password' : token !== undefined ? 'token' : 'none'
  const tlsCert = input.tlsCert ?? firstEnv('DSH_GATEWAY_TLS_CERT')
  const tlsKey = input.tlsKey ?? firstEnv('DSH_GATEWAY_TLS_KEY')
  if ((tlsCert === undefined) !== (tlsKey === undefined)) {
    throw new GatewayConfigError('--tls-cert and --tls-key must be provided together')
  }
  // HTTPS server is not implemented: refuse rather than silently serving
  // plaintext while the operator believes TLS is on (design 17 §6.6 pending).
  if (tlsCert !== undefined && tlsKey !== undefined) {
    throw new GatewayConfigError('--tls-cert/--tls-key are not implemented yet (HTTPS server is pending); use a reverse proxy for TLS termination')
  }
  const publicOriginInput = input.publicOrigin ?? firstEnv('DSH_GATEWAY_PUBLIC_ORIGIN')
  const publicOrigin = publicOriginInput === undefined ? undefined : canonicalOrigin(publicOriginInput, '--public-origin')
  const corsOrigins = [...new Set((input.corsOrigins ?? []).map(canonicalCorsOrigin))]
  const trustedProxies = trustedProxyList(input.trustedProxies)
  const allowAnonymousExternal = input.allowAnonymousExternal === true
  // S1 (design 17 §11): exposure is a semantic deployment fact, not just the
  // socket bind. A loopback listener behind an explicitly configured public
  // origin or trusted reverse proxy is still public and therefore needs auth.
  // --allow-anonymous-external is an explicit, loudly-warned operator override
  // (documented deviation) for trusted networks only.
  if ((host !== '127.0.0.1' || publicOrigin !== undefined || trustedProxies.length > 0)
    && kind === 'none' && !allowAnonymousExternal) {
    throw new GatewayConfigError('refusing externally reachable gateway configuration without authentication: pass --ui-password or --api-token (or --allow-anonymous-external to override)')
  }
  return {
    plane: { port: portRaw, host, stateDir, dshWorkspacePath },
    auth: {
      kind,
      ...(password !== undefined ? { password } : {}),
      ...(token !== undefined ? { token } : {}),
    },
    channels: { direct: host === '0.0.0.0', ssh: false },
    corsOrigins,
    trustedProxies,
    ...(publicOrigin !== undefined ? { publicOrigin } : {}),
    ...(tlsCert !== undefined && tlsKey !== undefined ? { tls: { cert: tlsCert, key: tlsKey } } : {}),
    allowAnonymousExternal,
  }
}
