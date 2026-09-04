/**
 * Gateway configuration (design 17 §3.1): the parsed config of the
 * server-side access shape — bind host/port, state/dsh roots, auth kind,
 * CORS origins, optional TLS. `parseGatewayConfig` enforces
 * the S1 exposure guard at config time: a non-loopback bind without auth is a
 * configuration error (the CLI surfaces it as exit 2).
 */

import { isIP } from 'node:net'
import {
  GATEWAY_PASSWORD_MAX_CHARS,
  GATEWAY_PASSWORD_MIN_CHARS,
  GATEWAY_TOKEN_MAX_CHARS,
  GATEWAY_TOKEN_MIN_CHARS,
} from '@dsh-chamber/control-plane'

export type GatewayBindHost = '127.0.0.1' | '0.0.0.0'
export type GatewayAuthKind = 'none' | 'password' | 'token' | 'password+token'
// Credential bounds = the shared wire-protocol single source
// (control-plane gateway-session-protocol.ts, design 17 §5.2/§7.1) — the
// same values the proxy injection gate and the desktop client enforce.
// Local names stay as aliases for CLI/config call sites and their tests.
export const MIN_GATEWAY_PASSWORD_CHARS = GATEWAY_PASSWORD_MIN_CHARS
export const MAX_GATEWAY_PASSWORD_CHARS = GATEWAY_PASSWORD_MAX_CHARS
export const MIN_GATEWAY_TOKEN_CHARS = GATEWAY_TOKEN_MIN_CHARS
export const MAX_GATEWAY_TOKEN_CHARS = GATEWAY_TOKEN_MAX_CHARS
/** Default target of the mobile UA experience shunting (design 17 §18): the
 * chamber surface's mobile entry placeholder. */
export const DEFAULT_MOBILE_ENTRY_PATH = '/chamber/mobile.html'

export interface GatewayConfig {
  plane: {
    port: number
    host: GatewayBindHost
    stateDir: string
    dshWorkspacePath: string
    /** First port attempted for the managed dsh host (design 17 §3 server
     *  deployments; default 17510). Server installs commonly set 30800 so the
     *  gateway listens on 30801 right next to the managed dsh. */
    dshPort?: number
  }
  auth: {
    kind: GatewayAuthKind
    /** scrypt-verified browser credential (design 17 §5). */
    password?: string
    /** shared bearer token (design 17 §5.2). May coexist with password. */
    token?: string
  }
  corsOrigins: string[]
  /** Exact proxy peer IPs whose Forwarded/X-Forwarded facts may be trusted.
   * Empty by default: a direct client can never self-assert its address/TLS. */
  trustedProxies: string[]
  /** The operator's expected public authority (design 17 §6 request policy /
   * S3 族), e.g. `https://gateway.example.com`. When set, requests with an
   * unrecognized Host are rejected (421). */
  publicOrigin?: string
  tls?: { cert: string; key: string }
  /** Explicit operator opt-in (design 17 §3.1 S1 deviation): bind externally
   * with NO authentication. Default false — the S1 exposure guard stays hard.
   * The CLI surfaces this as --no-auth. */
  allowAnonymousExternal?: boolean
  /** UA experience shunting (design 17 §18; default OFF): an authenticated
   * mobile-browser GET/HEAD of `/` answers 302 → mobileEntryPath instead of
   * the desktop frontend. UA sniffing is forgeable and carries NO security
   * semantics — the auth gate stays the only boundary (S1/S2). */
  mobileUaRedirect?: boolean
  /** Origin-form target of the mobile UA redirect (default
   * '/chamber/mobile.html' — validated, never absolute, never `/`). */
  mobileEntryPath?: string
}

/** Raw config input (CLI flags already resolved by the CLI entry; env fallback
 * applied here). Every field is optional — defaults fill the rest. */
export interface GatewayConfigInput {
  host?: string
  port?: number
  dshPort?: number
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
  mobileUaRedirect?: boolean
  mobileEntryPath?: string
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

/** Lenient-but-loud env boolean (used for DSH_GATEWAY_MOBILE_UA_REDIRECT): an
 * unrecognized value is a configuration error, never a silent default. */
function envBoolean(name: string): boolean | undefined {
  const raw = firstEnv(name)
  if (raw === undefined) return undefined
  const value = raw.trim().toLowerCase()
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  throw new GatewayConfigError(`${name} must be a boolean (1/true or 0/false), got ${JSON.stringify(raw)}`)
}

/** Origin-form path validation shared by parseGatewayConfig and the
 * materialized-config guard (design 17 §18): a same-origin target only —
 * starts with '/', no '//' prefix, no backslash, and never the bare root
 * (which would loop the shunting back onto itself). Control characters are
 * rejected outright (Node's writeHead would 500 per request on them), and
 * literal dot-segments that URL-normalize back to '/' are rejected too (a
 * `Location: /..` would be normalized by browsers to '/' and re-enter the
 * shunting loop). */
export function normalizeMobileEntryPath(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value === '/') {
    throw new GatewayConfigError(`mobile entry path must be an origin-form path (starts with '/', no '//' prefix, no backslash, and not '/'), got ${JSON.stringify(value)}`)
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new GatewayConfigError(`mobile entry path must contain no control characters, got ${JSON.stringify(value)}`)
  }
  let normalized = value
  try {
    normalized = new URL(value, 'http://chamber.invalid').pathname
  } catch {
    // Unreachable for origin-form input; fail closed on any parser surprise.
    throw new GatewayConfigError(`mobile entry path cannot be parsed, got ${JSON.stringify(value)}`)
  }
  if (normalized === '/') {
    throw new GatewayConfigError(`mobile entry path must not normalize to the root (shunting loop), got ${JSON.stringify(value)}`)
  }
  return value
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
  const dshPortEnv = firstEnv('DSH_GATEWAY_DSH_PORT')
  const dshPortRaw = input.dshPort ?? (dshPortEnv === undefined ? undefined : Number(dshPortEnv))
  if (dshPortRaw !== undefined
    && (!Number.isInteger(dshPortRaw) || dshPortRaw < 1 || dshPortRaw > 65535)) {
    throw new GatewayConfigError(`invalid dsh port: ${String(dshPortRaw)}`)
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
  // plaintext while the operator believes TLS is on (design 17 §3.1).
  if (tlsCert !== undefined && tlsKey !== undefined) {
    throw new GatewayConfigError('--tls-cert/--tls-key are not implemented yet (HTTPS server is pending); use a reverse proxy for TLS termination')
  }
  const publicOriginInput = input.publicOrigin ?? firstEnv('DSH_GATEWAY_PUBLIC_ORIGIN')
  const publicOrigin = publicOriginInput === undefined ? undefined : canonicalOrigin(publicOriginInput, '--public-origin')
  const corsOrigins = [...new Set((input.corsOrigins ?? []).map(canonicalCorsOrigin))]
  const trustedProxies = trustedProxyList(input.trustedProxies)
  const allowAnonymousExternal = input.allowAnonymousExternal === true
  // Design 17 §18 UA shunting (default OFF): the entry path is validated even
  // when the redirect stays disabled, so a mistyped --mobile-entry cannot
  // silently surface later as a misdirecting 302 once the flag is flipped.
  const mobileUaRedirect = input.mobileUaRedirect ?? envBoolean('DSH_GATEWAY_MOBILE_UA_REDIRECT') ?? false
  const mobileEntryPath = normalizeMobileEntryPath(input.mobileEntryPath ?? DEFAULT_MOBILE_ENTRY_PATH)
  // S1 (design 17 §17 安全不变量摘要): exposure is a semantic deployment
  // fact, not just the socket bind. A loopback listener behind an explicitly
  // configured public origin or trusted reverse proxy is still public and
  // therefore needs auth. --no-auth is an explicit, loudly-warned operator
  // override (documented deviation) for trusted networks only.
  if ((host !== '127.0.0.1' || publicOrigin !== undefined || trustedProxies.length > 0)
    && kind === 'none' && !allowAnonymousExternal) {
    throw new GatewayConfigError('refusing externally reachable gateway configuration without authentication: pass --ui-password or --api-token (or --no-auth to override)')
  }
  return {
    plane: {
      port: portRaw,
      host,
      stateDir,
      dshWorkspacePath,
      ...(dshPortRaw === undefined ? {} : { dshPort: dshPortRaw as number }),
    },
    auth: {
      kind,
      ...(password !== undefined ? { password } : {}),
      ...(token !== undefined ? { token } : {}),
    },
    corsOrigins,
    trustedProxies,
    ...(publicOrigin !== undefined ? { publicOrigin } : {}),
    ...(tlsCert !== undefined && tlsKey !== undefined ? { tls: { cert: tlsCert, key: tlsKey } } : {}),
    allowAnonymousExternal,
    mobileUaRedirect,
    mobileEntryPath,
  }
}
