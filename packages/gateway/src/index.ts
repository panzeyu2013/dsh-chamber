/**
 * @dsh-chamber/gateway — the server-side access gateway (design 17).
 *
 * createGateway assembles: the control-plane core (local dsh hosting +
 * management REST + per-instance proxy), the pluggable auth provider (§5),
 * the single-target gateway-proxy (§6), and the feature host (§8). The auth
 * gate + dispatch + upgradeMiddleware are mounted on the HTTP surface via the
 * control-plane's middleware hooks (design 17 §2.1 改动③ / §4).
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import { createGatewayStore, type GatewayStore } from './store.ts'
import { createChannelRegistry } from './channels.ts'
import { createGatewayRuntimeManager, type GatewayRuntimeManager } from './runtime-manager.ts'
import { createRuntimeRoutes } from './runtime-routes.ts'

/** Startup-block reasons that fail gateway boot loudly (design 18 §9.3).
 * Metadata corruption is a hard boot failure — DSH_HOME stays protected and
 * the operator must intervene. swap-attempted and restore-half/incomplete are
 * NOT fatal (review fix): they keep the gateway up with the managed dsh
 * stopped and are resumable via POST /chamber/runtime/retry-apply |
 * retry-restore, mirroring the desktop's blocked-but-alive app semantics. */
const FATAL_RUNTIME_BLOCKS = new Set<string>([
  'journal-corrupt',
  'current-corrupt',
  'override-corrupt',
  'journal-mismatch',
])

export interface GatewayOptions {
  config: GatewayConfig
  logger?: Logger
  /** Narrow construction seams for no-listen lifecycle composition tests. */
  deps?: {
    createPlane?: typeof createControlPlane
    createProxy?: typeof createGatewayProxy
    createFeatures?: (options: Parameters<typeof createFeatureHost>[0]) => FeatureHost
    createRuntimeManager?: typeof createGatewayRuntimeManager
  }
}

export interface GatewayHandle {
  start(): Promise<void>
  stop(): Promise<void>
  readonly port: number | null
  readonly connectionState: string
  readonly localProcessAlive: boolean
  readonly instanceId: string
  /** Effective auth kind AFTER config seeding (design 17 §7.4): reflects
   * runtime-managed credentials, unlike the deployment-config kind. */
  readonly authKind: string
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
    throw new GatewayConfigError('refusing externally reachable gateway configuration without authentication (or --no-auth to override)')
  }
  if (config.tls !== undefined) {
    throw new GatewayConfigError('materialized TLS config is not implemented; terminate TLS at a trusted reverse proxy')
  }
}

export function createGateway(options: GatewayOptions): GatewayHandle {
  validateMaterializedConfig(options.config)
  const logger = options.logger ?? console
  // Mutable holders: the dispatch middleware and feature host are wired into
  // createControlPlane BEFORE the plane/proxy exist (the proxy + feature host
  // need plane.getLocalDshPort()). They dereference lazily at request time.
  let plane: PlaneHandle | null = null
  let proxy: GatewayProxy | null = null
  let runtimeManager: GatewayRuntimeManager | null = null
  let createdPlane!: PlaneHandle
  let features!: FeatureHost
  // The whole synchronous construction is one transaction: any failure after
  // the store is created must release the stateDir exclusive lock (a leaked
  // lock would block every later start on the same directory for the process
  // lifetime). `store!` is safe past the try — every later use is reachable
  // only after construction succeeded.
  let store!: GatewayStore
  let auth!: AuthProvider
  try {
    // The gateway store (design 17 §10) owns tokens/jwt-secret + the
    // orchestration docs; auth needs it for the token hash + session secret
    // (S5/S13).
    store = createGatewayStore(options.config.plane.stateDir, logger)
    // The seeding logger is the gateway logger: without it the loud
    // config-ignored warnings for authoritative runtime credentials stay
    // silent.
    auth = createAuth(options.config.auth, store, logger)
    // Loud, unmissable warning for the explicit S1 override (design 17 §3.1
    // deviation): anonymous external exposure is operator-opted-in. The
    // verdict is decided by the EFFECTIVE kind AFTER seeding (Phase 1/2): a
    // persisted runtime credential (source 'runtime') makes the deployment
    // authenticated even though config.auth.kind is 'none' — no warning then,
    // only an informational line. The old pre-store check could not see that
    // state.
    if (options.config.allowAnonymousExternal === true
      && (options.config.plane.host !== '127.0.0.1'
        || options.config.publicOrigin !== undefined
        || options.config.trustedProxies.length > 0)) {
      if (auth.kind === 'none') {
        logger.warn(
          'SECURITY WARNING: gateway is externally reachable with NO authentication '
          + '(--no-auth). Any host that can reach this port has full, '
          + 'unauthenticated access to the managed dsh instance and its orchestration '
          + 'surface. This overrides design 17 S1 — use only on trusted networks.',
        )
      } else if (options.config.auth.kind === 'none') {
        logger.log('gateway: authentication is enabled by a runtime-managed credential (source: runtime)')
      }
    }
    const requestPolicy = createGatewayRequestPolicy(options.config)
    const channels = createChannelRegistry()
    features = (options.deps?.createFeatures ?? createFeatureHost)({
      logger,
      getDshBaseUrl: () => {
        const port = plane?.getLocalDshPort() ?? null
        return port === null || !Number.isInteger(port) ? null : `http://127.0.0.1:${port}`
      },
      store,
      channels,
    })
    // The runtime controller is gateway-owned and NOT ready-gated (design 18
    // §9.3): it dereferences the manager lazily so dsh-down windows stay pollable.
    const runtimeRoutes = createRuntimeRoutes(() => {
      if (runtimeManager === null) throw new Error('gateway runtime manager not initialized')
      return runtimeManager
    }, logger)
    // S24 lightweight non-secret audit projection (design 17 §13.4.4): JSONL
    // append at <stateDir>/audit.log (0600, 5 MiB rotation) recording login
    // results (success/invalid/rate-limited/busy) — never a password, cookie or
    // session body. The file lives under the 0700 stateDir discipline (S15).
    const auditFile = join(options.config.plane.stateDir, 'audit.log')
    const dispatch = createGatewayDispatch(auth, () => proxy as GatewayProxy, () => features, () => runtimeRoutes, logger, requestPolicy, auditFile)
    // Chamber host packages ship inside the gateway package (build.mjs copies
    // them into host-packages/); the control-plane seeds them into the managed
    // dsh profile so the full runtime activation probe set (which verifies
    // their RPC domains) can pass — design 18 §9.3. A packaged gateway without
    // them silently skips the seed and every switch probe-fails (2026-09
    // real-machine finding).
    const gatewayHostPackagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'host-packages')
    createdPlane = (options.deps?.createPlane ?? createControlPlane)({
      host: options.config.plane.host,
      port: options.config.plane.port,
      stateDir: options.config.plane.stateDir,
      // Static anchor for fakes/boot log; the live spawn path resolves per-spawn
      // through the runtime manager (env → override → anchor, design 18 §9.3).
      dshWorkspacePath: options.config.plane.dshWorkspacePath,
      hostGraphPackageSourceDir: join(gatewayHostPackagesDir, 'dsh-host-client-graph'),
      hostGitWorktreePackageSourceDir: join(gatewayHostPackagesDir, 'dsh-chamber-host-git-worktree'),
      getDshWorkspacePath: () => {
        if (runtimeManager === null) return options.config.plane.dshWorkspacePath
        if (runtimeManager.transactionWorkspace !== null) return runtimeManager.transactionWorkspace
        return runtimeManager.resolveWorkspace().path
      },
      canStartLocal: () => {
        if (runtimeManager === null) return { ok: true }
        if (runtimeManager.activationInProgress() && !runtimeManager.internalSpawnActive()) {
          return { ok: false, reason: 'dsh runtime activation in progress' }
        }
        return { ok: true }
      },
      canExposeLocal: () => runtimeManager === null || !runtimeManager.activationInProgress(),
      ...(options.config.plane.dshPort === undefined ? {} : { dshPortBase: options.config.plane.dshPort }),
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
  } catch (error) {
    store?.close()
    throw error
  }
  let started = false
  let startPromise: Promise<void> | null = null
  let unsubscribeLocalState: (() => void) | null = null
  let featuresAttached = false

  function syncFeatures(status: string): void {
    // A candidate (and any rollback candidate) may emit ready before the
    // activation probe verdict. Keep every dsh-derived consumer detached for
    // the full quarantine window; the manager explicitly calls back after the
    // verdict so a consumed ready edge is never the only attach trigger.
    if (status === 'ready' && !(runtimeManager?.activationInProgress() ?? false)) {
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
        // Design 17 §4.1: a failed start (or a stop) releases the stateDir
        // exclusive lock; a retry must re-take it (fail-closed with a loud
        // 'gateway_locked' error if another process grabbed the directory in
        // between — M3 fix round).
        store.reacquire()
        await createdPlane.start()
        // Runtime manager construction (single-owner guard + state root).
        runtimeManager = (options.deps?.createRuntimeManager ?? createGatewayRuntimeManager)({
          config: options.config,
          plane: createdPlane,
          logger,
          onActivationQuarantineChange: () => syncFeatures(createdPlane.connectionState),
        })
        // design 17 §2.1 step 4: the runtime startup transaction runs BEFORE the
        // first startLocal() — cleanup → eviction → restore completion →
        // (pending) snapshot → pointer switch → spawn candidate → probe gate.
        const startup = await runtimeManager.startupTransaction()
        if (startup.blockedReason !== null && FATAL_RUNTIME_BLOCKS.has(startup.blockedReason)) {
          throw new Error(`gateway runtime startup blocked: ${startup.blockedReason}`)
        }
        // Desktop-mirror blocked startups (design 18 §3.6/§9.3 review fix): a
        // mid-transaction pointer switch (swap-attempted) or an interrupted
        // snapshot restore (restore-half / restore-incomplete) must NOT be
        // exposed — keep the gateway up with the managed dsh stopped and let
        // the operator resume via POST /chamber/runtime/retry-apply |
        // retry-restore (the runtime controller is mounted and not
        // ready-gated, so the recovery surface stays reachable).
        if (startup.blockedReason === 'swap-attempted' || startup.blockedReason === 'restore-half' || startup.blockedReason === 'restore-incomplete') {
          logger.error(`gateway runtime startup blocked: ${startup.blockedReason}; managed dsh left stopped — resume via POST /chamber/runtime/retry-apply|retry-restore`)
          unsubscribeLocalState = createdPlane.onLocalStateChange(snapshot => syncFeatures(snapshot.status))
          started = true
          return
        }
        // The transaction's candidate spawn emits transient ready transitions;
        // the feature-consumer subscription attaches only AFTER the verdict,
        // so consumers never start against a candidate that is about to be
        // rolled back (R7 review). The explicit sync below covers the first
        // authoritative transition, and startLocal() re-publishes exposure
        // once the transaction's quarantine window has closed.
        unsubscribeLocalState = createdPlane.onLocalStateChange(snapshot => syncFeatures(snapshot.status))
        // Gateway is a managed local-dsh deployment, not API-only: readiness is
        // part of successful startup.
        await createdPlane.startLocal()
        syncFeatures(createdPlane.connectionState)
        createdPlane.refreshLocalExposure()
        started = true
      } catch (error) {
        syncFeatures('error')
        unsubscribeLocalState?.()
        unsubscribeLocalState = null
        await runtimeManager?.dispose().catch(stopError => logger.warn(`gateway runtime disposal failed: ${String(stopError)}`))
        runtimeManager = null
        await createdPlane.stop().catch(stopError => logger.warn(`gateway startup rollback failed: ${String(stopError)}`))
        // Release the stateDir exclusive lock on the rollback path so a retry
        // (or another process) can take over the directory (Phase 1 close).
        store.close()
        throw error
      }
    })().finally(() => { startPromise = null })
    return startPromise
  }

  async function stop(): Promise<void> {
    await startPromise?.catch(() => {})
    unsubscribeLocalState?.()
    unsubscribeLocalState = null
    // Reap runtime install children first (design 18 §9.3 stop order), then the
    // gateway's own WS splices + feature consumers, then the control plane.
    await runtimeManager?.dispose().catch(stopError => logger.warn(`gateway runtime disposal failed: ${String(stopError)}`))
    proxy?.closeAllStreams()
    syncFeatures('stopped')
    try {
      await createdPlane.stop()
    } finally {
      // Release the stateDir exclusive lock last, even if the plane stop
      // failed (idempotent; Phase 1 close) — a locked directory would block
      // every restart until the process exits.
      store.close()
    }
    started = false
  }

  return {
    start,
    stop,
    get port() { return createdPlane.port },
    get connectionState() { return createdPlane.connectionState },
    get localProcessAlive() { return createdPlane.localProcessAlive },
    get instanceId() { return createdPlane.instanceId },
    get authKind() { return auth.kind },
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
