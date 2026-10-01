/**
 * Gateway configuration of the server-side access shape (bind host/port,
 * state/dsh roots, auth kind, CORS origins, TLS). `parseGatewayConfig` refuses
 * a non-loopback bind without auth (exposure guard; CLI exit 2).
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
// Credential bounds come from the shared wire protocol (control-plane
// gateway-session-protocol.ts), enforced by the proxy gate and the desktop too.
export const MIN_GATEWAY_PASSWORD_CHARS = GATEWAY_PASSWORD_MIN_CHARS
export const MAX_GATEWAY_PASSWORD_CHARS = GATEWAY_PASSWORD_MAX_CHARS
export const MIN_GATEWAY_TOKEN_CHARS = GATEWAY_TOKEN_MIN_CHARS
export const MAX_GATEWAY_TOKEN_CHARS = GATEWAY_TOKEN_MAX_CHARS
/** Default target of the mobile UA shunting: the chamber mobile entry placeholder. */
export const DEFAULT_MOBILE_ENTRY_PATH = '/chamber/mobile.html'

export interface GatewayConfig {
  plane: {
    port: number
    host: GatewayBindHost
    stateDir: string
    dshWorkspacePath: string
    /** First port attempted for the managed dsh host (default 17510; server installs commonly 30800). */
    dshPort?: number
  }
  auth: {
    kind: GatewayAuthKind
    /** scrypt-verified browser credential. */
    password?: string
    /** Shared bearer token; may coexist with password. */
    token?: string
  }
  corsOrigins: string[]
  /** Exact proxy peer IPs whose Forwarded/X-Forwarded facts may be trusted; empty = never self-asserted. */
  trustedProxies: string[]
  /** Operator's expected public authority (e.g. `https://gateway.example.com`); unrecognized Host → 421. */
  publicOrigin?: string
  tls?: { cert: string; key: string }
  /** Explicit operator opt-in to bind externally with NO auth (default false; CLI --no-auth). */
  allowAnonymousExternal?: boolean
  /** UA experience shunting (default OFF; DEPRECATED — the mobile client plugin
   * is injected on every device now, so this remains only as a compatibility
   * surface): authenticated mobile-browser GET/HEAD of `/` answers 302 →
   * mobileEntryPath; UA sniffing is not security. Explicitly enabling it prints
   * a one-time deprecation warning (never an error). */
  mobileUaRedirect?: boolean
  /** Origin-form target of the mobile UA redirect (default '/chamber/mobile.html'; never absolute, never '/'). */
  mobileEntryPath?: string
  /** Login-phase background pre-warm (default ON): the login page prefetches the
   * REAL /plugins bundle URLs behind a short-lived HttpOnly capability cookie, so
   * post-login boot comes from the HTTP cache; `false` (--no-warmup /
   * DSH_GATEWAY_WARMUP=0) is the kill switch — no discovery, links, cookie or route. */
  warmup?: boolean
  /** Read-only session-state watcher (default ON). false kills the whole
   * observer: every /chamber/session-state* route answers 503
   * session_state_disabled and no mux socket to the local dsh is opened. */
  sessionState?: boolean
}

/** Raw config input (CLI flags already resolved; env fallback applied here); every field optional. */
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
  warmup?: boolean
  sessionState?: boolean
}

/** Configuration error (surfaced as exit 2 by the CLI). */
export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GatewayConfigError'
  }
}

/** One-shot latch for the mobile-UA shunting deprecation notice: the config is
 * parsed more than once in one process (tests, CLI re-entry), the operator sees
 * the warning at most once. */
let mobileUaRedirectDeprecationWarned = false

/** The UA shunting is a compatibility surface only after the mobile client
 * plugin became an always-injected packaged plugin: an explicit opt-in warns —
 * never throws. Latching keeps repeated parses silent. */
function warnMobileUaRedirectDeprecated(): void {
  if (mobileUaRedirectDeprecationWarned) return
  mobileUaRedirectDeprecationWarned = true
  console.warn(
    'gateway: --mobile-ua-redirect / DSH_GATEWAY_MOBILE_UA_REDIRECT is deprecated; '
    + 'the mobile client plugin is injected on every device, so UA shunting remains only as a compatibility surface. '
    + 'Serve / directly instead — the plugin is already injected into every managed instance.',
  )
}

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

/** Lenient-but-loud env boolean (DSH_GATEWAY_MOBILE_UA_REDIRECT,
 * DSH_GATEWAY_WARMUP): an unrecognized value is a config error, never silent. */
function envBoolean(name: string): boolean | undefined {
  const raw = firstEnv(name)
  if (raw === undefined) return undefined
  const value = raw.trim().toLowerCase()
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  throw new GatewayConfigError(`${name} must be a boolean (1/true or 0/false), got ${JSON.stringify(raw)}`)
}

/** Origin-form path validation; a same-origin target only — starts with '/',
 * no '//' prefix, no backslash, never the bare root (which would loop the
 * shunting), and never a query/fragment (URL parsing would silently drop them
 * while the dispatch compares pathnames only). Control characters and
 * dot-segments that URL-normalize back to '/' are rejected (browsers would
 * re-enter the loop), and the auth surface is off-limits (shunting '/' to
 * /auth/login would bounce a fresh login straight back to the form). Returns
 * the NORMALIZED pathname: the dispatch compares it against request pathnames,
 * which `URL` has already normalized, so `/./x` must round-trip as `/x`. A
 * normalized pathname that starts with `//` (e.g. `/.//x`, `/%2e%2e//x`) is
 * rejected — resolving it would switch authority, turning the entry into an
 * off-origin redirect. */
export function normalizeMobileEntryPath(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value === '/') {
    throw new GatewayConfigError(`mobile entry path must be an origin-form path (starts with '/', no '//' prefix, no backslash, and not '/'), got ${JSON.stringify(value)}`)
  }
  // `new URL()` would move a query/fragment out of the pathname (the dispatch
  // compares pathnames only), so a '?' or '#' is a typo that must fail loudly
  // rather than silently truncate the configured entry.
  if (value.includes('?') || value.includes('#')) {
    throw new GatewayConfigError(`mobile entry path must not contain a query or fragment ('?' or '#'), got ${JSON.stringify(value)}`)
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
  if (normalized.startsWith('//')) {
    throw new GatewayConfigError(`mobile entry path must not normalize to a protocol-relative path (authority switch), got ${JSON.stringify(value)}`)
  }
  // Checked AFTER normalization so dot-segment spellings (`/auth/./login`) are
  // caught too: the entry sits one hop before the login form, so pointing it at
  // the auth surface would loop every fresh login back to /auth/login.
  if (normalized === '/auth' || normalized.startsWith('/auth/')) {
    throw new GatewayConfigError(`mobile entry path must not target the auth surface (login self-loop), got ${JSON.stringify(value)}`)
  }
  return normalized
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
    // Packaged clients use opaque custom schemes; URL.origin is the literal
    // "null" for these, so validate the exact scheme+authority string.
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
 * Parse + validate the gateway config; throws GatewayConfigError on any invalid
 * value (exposure guard included). stateDir/dshWorkspacePath are required — the
 * caller resolves them first (resolveStateRoot / defaultDshWorkspacePath).
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
  // An empty credential is not auth (S1): reject loudly, never a satisfied kind.
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
  // plaintext while the operator believes TLS is on.
  if (tlsCert !== undefined && tlsKey !== undefined) {
    throw new GatewayConfigError('--tls-cert/--tls-key are not implemented yet (HTTPS server is pending); use a reverse proxy for TLS termination')
  }
  const publicOriginInput = input.publicOrigin ?? firstEnv('DSH_GATEWAY_PUBLIC_ORIGIN')
  const publicOrigin = publicOriginInput === undefined ? undefined : canonicalOrigin(publicOriginInput, '--public-origin')
  const corsOrigins = [...new Set((input.corsOrigins ?? []).map(canonicalCorsOrigin))]
  const trustedProxies = trustedProxyList(input.trustedProxies)
  const allowAnonymousExternal = input.allowAnonymousExternal === true
  // The entry path is validated even when the redirect stays disabled, so a
  // mistyped --mobile-entry cannot surface later as a misdirecting 302.
  // Explicit opt-in (input or env) prints the one-time deprecation warning.
  const mobileUaRedirect = input.mobileUaRedirect ?? envBoolean('DSH_GATEWAY_MOBILE_UA_REDIRECT') ?? false
  // Normalize (and validate) the entry BEFORE the notice: a bad --mobile-entry
  // must surface as the config error, not behind a deprecation line. The latch
  // stays process-level on purpose (one notice per process).
  const mobileEntryPath = normalizeMobileEntryPath(input.mobileEntryPath ?? DEFAULT_MOBILE_ENTRY_PATH)
  if (mobileUaRedirect === true) warnMobileUaRedirectDeprecated()
  // Login-phase pre-warm ON by default; the kill switch exists for operators
  // who do not want the pre-auth route at all.
  const warmup = input.warmup ?? envBoolean('DSH_GATEWAY_WARMUP') ?? true
  // The read-only session-state watcher is ON by default (additive routes,
  // read-only observer); DSH_GATEWAY_SESSION_STATE=0 disables the whole face.
  const sessionState = input.sessionState ?? envBoolean('DSH_GATEWAY_SESSION_STATE') ?? true
  // Exposure is a semantic deployment fact, not just the socket bind: a
  // loopback listener behind a public origin or trusted proxy is still public
  // and needs auth. --no-auth is an explicit, loudly-warned override.
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
    warmup,
    sessionState,
  }
}