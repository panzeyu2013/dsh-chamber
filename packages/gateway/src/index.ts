/**
 * @dsh-chamber/gateway — the server-side access gateway (design 17).
 *
 * createGateway assembles: the control-plane core (local dsh hosting +
 * management REST + per-instance proxy), the pluggable auth provider (§5),
 * the single-target gateway-proxy (§6), and the feature host (§8). The auth
 * gate + dispatch + upgradeMiddleware are mounted on the HTTP surface via the
 * control-plane's middleware hooks (design 17 §2.1 改动③ / §4).
 */

import {
  DEFAULT_STATE_DIR,
  createControlPlane,
  defaultDshWorkspacePath,
  type Logger,
  type PlaneHandle,
} from '@dsh-chamber/control-plane'
import {
  GatewayConfigError,
  MAX_GATEWAY_PASSWORD_CHARS,
  MAX_GATEWAY_TOKEN_CHARS,
  MIN_GATEWAY_PASSWORD_CHARS,
  MIN_GATEWAY_TOKEN_CHARS,
  parseGatewayConfig,
  type GatewayConfig,
  type GatewayConfigInput,
} from './config.ts'
import { createAuth, type AuthProvider, type AuthPrincipal } from './auth.ts'
import { createGatewayProxy, type GatewayProxy, type GatewayProxyDeps } from './gateway-proxy.ts'
import { createGatewayDispatch } from './dispatch.ts'
import { createGatewayRequestPolicy } from './middleware.ts'
import { createFeatureHost, type FeatureHost } from './routes.ts'
import { createGatewayStore } from './store.ts'
import { createChannelRegistry } from './channels.ts'

export interface GatewayOptions {
  config: GatewayConfig
  logger?: Logger
  /** Narrow construction seams for no-listen lifecycle composition tests. */
  deps?: {
    createPlane?: typeof createControlPlane
    createProxy?: typeof createGatewayProxy
    createFeatures?: (options: Parameters<typeof createFeatureHost>[0]) => FeatureHost
  }
}

export interface GatewayHandle {
  start(): Promise<void>
  stop(): Promise<void>
  readonly port: number | null
  readonly connectionState: string
  readonly localProcessAlive: boolean
  readonly instanceId: string
}

/**
 * Build a validated GatewayConfig from raw input + resolved roots (CLI entry
 * resolves the stateDir/dshWorkspacePath defaults, then calls this).
 */
export function buildGatewayConfig(input: GatewayConfigInput, stateDir = DEFAULT_STATE_DIR, dshWorkspacePath = defaultDshWorkspacePath()): GatewayConfig {
  return parseGatewayConfig(input, stateDir, dshWorkspacePath)
}

/** Defend the public programmatic constructor as well as the CLI parser.
 * GatewayConfig is a structural TypeScript type, so JavaScript callers can
 * otherwise forge `kind:'token'` without a token or request unimplemented TLS
 * and accidentally expose the anonymous provider over plaintext. */
function validateMaterializedConfig(config: GatewayConfig): void {
  if (config.plane.host !== '127.0.0.1' && config.plane.host !== '0.0.0.0') {
    throw new GatewayConfigError(`invalid materialized gateway host: ${String(config.plane.host)}`)
  }
  if (!Number.isInteger(config.plane.port) || config.plane.port < 1 || config.plane.port > 65535) {
    throw new GatewayConfigError(`invalid materialized gateway port: ${String(config.plane.port)}`)
  }
  const hasPassword = typeof config.auth.password === 'string' && config.auth.password !== ''
  const hasToken = typeof config.auth.token === 'string' && config.auth.token !== ''
  const actualKind = hasPassword && hasToken ? 'password+token'
    : hasPassword ? 'password' : hasToken ? 'token' : 'none'
  if (config.auth.kind !== actualKind) {
    throw new GatewayConfigError(`materialized auth kind ${config.auth.kind} does not match its credentials`)
  }
  if (hasPassword && (config.auth.password!.length < MIN_GATEWAY_PASSWORD_CHARS
    || config.auth.password!.length > MAX_GATEWAY_PASSWORD_CHARS)) {
    throw new GatewayConfigError(`materialized password must be ${MIN_GATEWAY_PASSWORD_CHARS}-${MAX_GATEWAY_PASSWORD_CHARS} characters`)
  }
  if (hasToken && (config.auth.token!.length < MIN_GATEWAY_TOKEN_CHARS
    || config.auth.token!.length > MAX_GATEWAY_TOKEN_CHARS || !/^[\x20-\x7e]+$/.test(config.auth.token!))) {
    throw new GatewayConfigError(`materialized token must be ${MIN_GATEWAY_TOKEN_CHARS}-${MAX_GATEWAY_TOKEN_CHARS} visible ASCII characters`)
  }
  if ((config.plane.host !== '127.0.0.1' || config.publicOrigin !== undefined || config.trustedProxies.length > 0)
    && actualKind === 'none' && config.allowAnonymousExternal !== true) {
    throw new GatewayConfigError('refusing externally reachable gateway configuration without authentication')
  }
  if (config.tls !== undefined) {
    throw new GatewayConfigError('materialized TLS config is not implemented; terminate TLS at a trusted reverse proxy')
  }
}

export function createGateway(options: GatewayOptions): GatewayHandle {
  validateMaterializedConfig(options.config)
  const logger = options.logger ?? console
  // Loud, unmissable warning for the explicit S1 override (design 17 §3.1
  // deviation): anonymous external exposure is operator-opted-in.
  if (options.config.allowAnonymousExternal === true
    && options.config.auth.kind === 'none'
    && (options.config.plane.host !== '127.0.0.1'
      || options.config.publicOrigin !== undefined
      || options.config.trustedProxies.length > 0)) {
    logger.warn(
      'SECURITY WARNING: gateway is externally reachable with NO authentication '
      + '(--no-auth). Any host that can reach this port has full, '
      + 'unauthenticated access to the managed dsh instance and its orchestration '
      + 'surface. This overrides design 17 S1 — use only on trusted networks.',
    )
  }
  // The gateway store (design 17 §10) owns tokens/jwt-secret + the orchestration
  // docs; auth needs it for the token hash + session secret (S5/S13).
  const store = createGatewayStore(options.config.plane.stateDir, logger)
  const auth = createAuth(options.config.auth, store)
  const requestPolicy = createGatewayRequestPolicy(options.config)
  // Mutable holders: the dispatch middleware and feature host are wired into
  // createControlPlane BEFORE the plane/proxy exist (the proxy + feature host
  // need plane.getLocalDshPort()). They dereference lazily at request time.
  let plane: PlaneHandle | null = null
  let proxy: GatewayProxy | null = null
  const channels = createChannelRegistry()
  const features = (options.deps?.createFeatures ?? createFeatureHost)({
    logger,
    getDshBaseUrl: () => {
      const port = plane?.getLocalDshPort() ?? null
      return port === null || !Number.isInteger(port) ? null : `http://127.0.0.1:${port}`
    },
    store,
    channels,
  })
  const dispatch = createGatewayDispatch(auth, () => proxy as GatewayProxy, () => features, logger, requestPolicy)
  const createdPlane = (options.deps?.createPlane ?? createControlPlane)({
    host: options.config.plane.host,
    port: options.config.plane.port,
    stateDir: options.config.plane.stateDir,
    dshWorkspacePath: options.config.plane.dshWorkspacePath,
    logger,
    corsOrigins: options.config.corsOrigins,
    corsEvaluator: requestPolicy.corsEvaluator,
    middleware: dispatch.middleware,
    upgradeMiddleware: dispatch.upgradeMiddleware,
  })
  plane = createdPlane
  proxy = (options.deps?.createProxy ?? createGatewayProxy)({
    logger,
    getLocalDshPort: () => createdPlane.getLocalDshPort(),
    getLocalState: () => createdPlane.connectionState,
  })
  let started = false
  let startPromise: Promise<void> | null = null
  let unsubscribeLocalState: (() => void) | null = null
  let featuresAttached = false

  function syncFeatures(status: string): void {
    if (status === 'ready') {
      if (featuresAttached) return
      features.start()
      featuresAttached = true
      return
    }
    if (!featuresAttached) return
    features.stop()
    featuresAttached = false
  }

  async function start(): Promise<void> {
    if (started) return
    if (startPromise !== null) return startPromise
    startPromise = (async () => {
      try {
        await createdPlane.start()
        unsubscribeLocalState = createdPlane.onLocalStateChange(snapshot => syncFeatures(snapshot.status))
        // Gateway is a managed local-dsh deployment, not API-only: readiness is
        // part of successful startup. The lifecycle subscription above starts
        // feature consumers only after the authoritative ready transition.
        await createdPlane.startLocal()
        syncFeatures(createdPlane.connectionState)
        started = true
      } catch (error) {
        syncFeatures('error')
        unsubscribeLocalState?.()
        unsubscribeLocalState = null
        await createdPlane.stop().catch(stopError => logger.warn(`gateway startup rollback failed: ${String(stopError)}`))
        throw error
      }
    })().finally(() => { startPromise = null })
    return startPromise
  }

  async function stop(): Promise<void> {
    await startPromise?.catch(() => {})
    unsubscribeLocalState?.()
    unsubscribeLocalState = null
    // Close the gateway's own WS splices + feature consumers before the
    // control-plane tears down its instance-proxy streams.
    proxy?.closeAllStreams()
    syncFeatures('stopped')
    await createdPlane.stop()
    started = false
  }

  return {
    start,
    stop,
    get port() { return createdPlane.port },
    get connectionState() { return createdPlane.connectionState },
    get localProcessAlive() { return createdPlane.localProcessAlive },
    get instanceId() { return createdPlane.instanceId },
  }
}

export { parseGatewayConfig, GatewayConfigError } from './config.ts'
export type { GatewayConfig, GatewayConfigInput } from './config.ts'
export { createAuth } from './auth.ts'
export type { AuthProvider, AuthPrincipal } from './auth.ts'
export { createGatewayProxy } from './gateway-proxy.ts'
export type { GatewayProxy, GatewayProxyDeps } from './gateway-proxy.ts'
export { createFeatureHost } from './routes.ts'
export type { FeatureHost, FeatureHostDeps } from './routes.ts'
export { createWorktree, deleteWorktree, GitFeatureError } from './features/git.ts'
export type { CreateWorktreeInput, DeleteWorktreeInput, WorktreeRecord } from './features/git.ts'
export { createApprovalNotifier } from './features/notify.ts'
export type { ApprovalNotifier, ApprovalRequest, QuestionRequest } from './features/notify.ts'
export { createSessionIndex } from './features/index.ts'
export type { SessionIndex, SessionProjection } from './features/index.ts'
export { createScheduler } from './features/schedule.ts'
export type { Scheduler, ScheduledJob } from './features/schedule.ts'
export { createGatewayStore, hashCredential, verifyCredential } from './store.ts'
export type { GatewayStore, GatewayDocument, DeviceRecord, WorktreeStoreRecord, ScheduleStoreRecord, GatewaySettingsDoc } from './store.ts'
export { createChannelRegistry } from './channels.ts'
export type { ChannelKind, ChannelHealth, ChannelProvider, ChannelInstance, ChannelRegistry, ChannelListEntry } from './channels.ts'
export { createGatewayRequestPolicy, GATEWAY_VIEWPORT_META } from './middleware.ts'
export type { GatewayRequestDecision, GatewayRequestPolicy } from './middleware.ts'
