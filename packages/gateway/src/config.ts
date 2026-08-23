/**
 * Gateway configuration (design 16 §3.1): the parsed config of the
 * server-side access shape — bind host/port, state/dsh roots, auth kind,
 * channels/ui flags, CORS origins, optional TLS. `parseGatewayConfig` enforces
 * the S1 exposure guard at config time: a non-loopback bind without auth is a
 * configuration error (the CLI surfaces it as exit 2).
 */

export type GatewayBindHost = '127.0.0.1' | '0.0.0.0'
export type GatewayAuthKind = 'none' | 'password' | 'token'

export interface GatewayConfig {
  plane: {
    port: number
    host: GatewayBindHost
    stateDir: string
    dshWorkspacePath: string
  }
  auth: {
    kind: GatewayAuthKind
    /** scrypt-verified (MVP 占位, design 16 §5); present only when kind==='password'. */
    password?: string
    /** shared bearer token (design 16 §6.4 D7); present only when kind==='token'. */
    token?: string
  }
  channels: { direct: boolean; ssh: boolean }
  ui: { pwa: boolean; shellNav: boolean }
  corsOrigins: string[]
  /** The operator's expected public authority (S11), e.g. `https://gateway.example.com`.
   * When set, requests with an unrecognized Host are rejected (421). */
  publicOrigin?: string
  tls?: { cert: string; key: string }
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
  noPwa?: boolean
  tlsCert?: string
  tlsKey?: string
  publicOrigin?: string
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
  const kind: GatewayAuthKind = password !== undefined ? 'password' : token !== undefined ? 'token' : 'none'
  // S1 (design 16 §11): a network-exposed bind without auth refuses to start.
  if (host !== '127.0.0.1' && kind === 'none') {
    throw new GatewayConfigError('refusing to bind 0.0.0.0 without authentication: pass --ui-password or --api-token')
  }
  const tlsCert = input.tlsCert ?? firstEnv('DSH_GATEWAY_TLS_CERT')
  const tlsKey = input.tlsKey ?? firstEnv('DSH_GATEWAY_TLS_KEY')
  if ((tlsCert === undefined) !== (tlsKey === undefined)) {
    throw new GatewayConfigError('--tls-cert and --tls-key must be provided together')
  }
  // HTTPS server is not implemented: refuse rather than silently serving
  // plaintext while the operator believes TLS is on (design 16 §6.6 pending).
  if (tlsCert !== undefined && tlsKey !== undefined) {
    throw new GatewayConfigError('--tls-cert/--tls-key are not implemented yet (HTTPS server is pending); use a reverse proxy for TLS termination')
  }
  const publicOrigin = input.publicOrigin ?? firstEnv('DSH_GATEWAY_PUBLIC_ORIGIN')
  return {
    plane: { port: portRaw, host, stateDir, dshWorkspacePath },
    auth: {
      kind,
      ...(password !== undefined ? { password } : {}),
      ...(token !== undefined ? { token } : {}),
    },
    channels: { direct: host === '0.0.0.0', ssh: false },
    ui: { pwa: !(input.noPwa ?? false), shellNav: false },
    corsOrigins: input.corsOrigins ?? [],
    ...(publicOrigin !== undefined ? { publicOrigin } : {}),
    ...(tlsCert !== undefined && tlsKey !== undefined ? { tls: { cert: tlsCert, key: tlsKey } } : {}),
  }
}
