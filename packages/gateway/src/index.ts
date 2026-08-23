/**
 * @dsh-chamber/gateway — the server-side access gateway (design 16).
 *
 * createGateway assembles: the control-plane core (local dsh hosting +
 * management REST + per-instance proxy), the pluggable auth provider (§5),
 * the single-target gateway-proxy (§6), and the feature host (§8). The auth
 * gate + dispatch + upgradeMiddleware are mounted on the HTTP surface via the
 * control-plane's middleware hooks (design 16 §2.1 改动③ / §4).
 */

import {
  DEFAULT_STATE_DIR,
  createControlPlane,
  defaultDshWorkspacePath,
  type Logger,
  type PlaneHandle,
} from '@dsh-chamber/control-plane'
import { parseGatewayConfig, type GatewayConfig, type GatewayConfigInput } from './config.ts'
import { createAuth, type AuthProvider, type AuthPrincipal } from './auth.ts'
import { createGatewayProxy, type GatewayProxy, type GatewayProxyDeps } from './gateway-proxy.ts'
import { createGatewayDispatch } from './dispatch.ts'
import { createFeatureHost } from './routes.ts'
import { createGatewayStore } from './store.ts'
import { createChannelRegistry } from './channels.ts'

export interface GatewayOptions {
  config: GatewayConfig
  logger?: Logger
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

export function createGateway(options: GatewayOptions): GatewayHandle {
  const logger = options.logger ?? console
  // The gateway store (design 16 §10) owns tokens/jwt-secret + the orchestration
  // docs; auth needs it for the token hash + session secret (S5/S13).
  const store = createGatewayStore(options.config.plane.stateDir, logger)
  const auth = createAuth(options.config.auth, store)
  // Mutable holders: the dispatch middleware and feature host are wired into
  // createControlPlane BEFORE the plane/proxy exist (the proxy + feature host
  // need plane.getLocalDshPort()). They dereference lazily at request time.
  let plane: PlaneHandle | null = null
  let proxy: GatewayProxy | null = null
  const channels = createChannelRegistry()
  const features = createFeatureHost({
    logger,
    getDshBaseUrl: () => {
      const port = plane?.getLocalDshPort() ?? null
      return port === null || !Number.isInteger(port) ? null : `http://127.0.0.1:${port}`
    },
    store,
    channels,
  })
  const dispatch = createGatewayDispatch(auth, () => proxy as GatewayProxy, () => features, logger, options.config.publicOrigin)
  const createdPlane = createControlPlane({
    host: options.config.plane.host,
    port: options.config.plane.port,
    stateDir: options.config.plane.stateDir,
    dshWorkspacePath: options.config.plane.dshWorkspacePath,
    logger: options.logger,
    corsOrigins: options.config.corsOrigins,
    middleware: dispatch.middleware,
    upgradeMiddleware: dispatch.upgradeMiddleware,
  })
  plane = createdPlane
  proxy = createGatewayProxy({
    logger,
    getLocalDshPort: () => createdPlane.getLocalDshPort(),
    getLocalState: () => createdPlane.connectionState,
  })
  // Start the feature-host stream consumers NOW that `plane` is assigned
  // (getDshBaseUrl resolves) — starting earlier no-ops on a null base URL.
  features.start()

  return {
    start: () => createdPlane.start(),
    stop: () => {
      // Close the gateway's own WS splices + feature consumers before the
      // control-plane tears down its instance-proxy streams (design 16 review
      // M2: a dirty close otherwise leaks streams to the server close timeout).
      proxy?.closeAllStreams()
      features.stop()
      return createdPlane.stop()
    },
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
export { GATEWAY_VIEWPORT_META } from './middleware.ts'
