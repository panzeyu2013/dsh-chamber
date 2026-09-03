/**
 * @dsh-chamber/gateway — the server-side access gateway (design 17).
 *
 * createGateway assembles: the control-plane core (local dsh hosting +
 * management REST + per-instance proxy), the pluggable auth provider (§5),
 * the single-target gateway-proxy (§6), and the chamber surface (§10). The auth
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
  DEFAULT_MOBILE_ENTRY_PATH,
  GatewayConfigError,
  MAX_GATEWAY_PASSWORD_CHARS,
  MAX_GATEWAY_TOKEN_CHARS,
  MIN_GATEWAY_PASSWORD_CHARS,
  MIN_GATEWAY_TOKEN_CHARS,
  normalizeMobileEntryPath,
  parseGatewayConfig,
  type GatewayConfig,
  type GatewayConfigInput,
} from './config.ts'
import { createAuth, type AuthProvider } from './auth.ts'
import { createGatewayProxy, type GatewayProxy } from './gateway-proxy.ts'
import { createGatewayDispatch } from './dispatch.ts'
import { createGatewayRequestPolicy } from './middleware.ts'
import { createChamberSurface, type ChamberSurface } from './routes.ts'
import { createChamberPlugins, syncedSourceDir } from './plugins.ts'
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
    createChamberSurface?: (options: Parameters<typeof createChamberSurface>[0]) => ChamberSurface
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
  // A forged mobile entry could turn the UA shunting into an open redirect
  // (absolute URL) or a self-loop ('/') — the same origin-form guard the
  // parser applies, for programmatic constructors.
  if (config.mobileUaRedirect === true) {
    normalizeMobileEntryPath(config.mobileEntryPath ?? DEFAULT_MOBILE_ENTRY_PATH)
  }
}

export function createGateway(options: GatewayOptions): GatewayHandle {
  validateMaterializedConfig(options.config)
  const logger = options.logger ?? console
  // Mutable holders: the dispatch middleware and chamber surface are wired
  // into createControlPlane BEFORE the plane/proxy exist (the proxy + chamber
  // surface need createdPlane.getLocalDshPort()). They dereference lazily at request time.
  let proxy: GatewayProxy | null = null
  let runtimeManager: GatewayRuntimeManager | null = null
  let createdPlane!: PlaneHandle
  let chamberSurface!: ChamberSurface
  let dispatch!: ReturnType<typeof createGatewayDispatch>
  let started = false
  let startPromise: Promise<void> | null = null
  let stopPromise: Promise<void> | null = null
  let lifecycleEpoch = 0
  let stopping = false
  let unsubscribeLocalState: (() => void) | null = null
  const runtimeExposureQuarantined = (): boolean => {
    if (runtimeManager === null) return false
    // Keep narrow structural lifecycle fakes compatible while the production
    // manager supplies the sticky post-verdict quarantine.
    return runtimeManager.exposureQuarantined?.() ?? runtimeManager.activationInProgress()
  }
  // The whole synchronous construction is one transaction: any failure after
  // the store is created must release the stateDir exclusive lock (a leaked
  // lock would block every later start on the same directory for the process
  // lifetime). `store!` is safe past the try — every later use is reachable
  // only after construction succeeded.
  let store!: GatewayStore
  let auth!: AuthProvider
  try {
    // The gateway store (design 17 §10) owns tokens/jwt-secret (the
    // orchestration docs were removed with the 2026-12 strip); auth needs it
    // for the token hash + session secret
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
          + 'unauthenticated access to the managed dsh instance and its /chamber/ '
          + 'management surface. This overrides design 17 S1 — use only on trusted networks.',
        )
      } else if (options.config.auth.kind === 'none') {
        logger.log('gateway: authentication is enabled by a runtime-managed credential (source: runtime)')
      }
    }
    const requestPolicy = createGatewayRequestPolicy(options.config)
    const channels = createChannelRegistry()
    // Desktop-synced host-package seed cache (2026-12 Phase 3): the two
    // chamber host packages come from a connecting desktop's upload; the
    // mobile client-plugin slot stays packaged in the gateway distribution.
    const plugins = createChamberPlugins(options.config.plane.stateDir, logger)
    // The chamber surface (2026-12 strip): channels projection + browser
    // dashboard assets + plugin-sync cache — no feature host, no readiness
    // coupling. The runtime controller below is the gateway's only other
    // /chamber writer surface besides credentials (auth.ts).
    chamberSurface = (options.deps?.createChamberSurface ?? createChamberSurface)({
      logger,
      channels,
      plugins,
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
    dispatch = createGatewayDispatch(
      auth,
      () => proxy as GatewayProxy,
      () => chamberSurface,
      () => runtimeRoutes,
      logger,
      requestPolicy,
      auditFile,
      // Design 17 §18 UA shunting (default off; the entry path is always
      // validated/materialized by parseGatewayConfig).
      options.config.mobileUaRedirect === true,
      options.config.mobileEntryPath ?? DEFAULT_MOBILE_ENTRY_PATH,
    )
    // Chamber seed registry (2026-12): the two host packages are DESKTOP-
    // SYNCED — the control-plane seeds them into the managed dsh profile from
    // the chamber-plugins cache, which a connecting desktop populates through
    // PUT /chamber/plugins (Phase 3). Until the first sync the cache is
    // empty, the seed skips both entries, and the activation probe runs
    // without the chamber host domains (runtime-manager hostDomains). The
    // mobile slot (@dsh-chamber/dsh-client-ui-mobile, kind 'client') stays
    // PACKAGED: mobile access is bound to the gateway (no desktop in the
    // chain), so its seed MUST ship inside this package (design 17 §18) — the
    // gateway build copies package.json + dist/index.js + lib/client.js(+.map)
    // into host-packages/. The client half is served by the host
    // ClientModuleRegistry at /plugins/<pkg>/client.js (exports["./client"]),
    // so the seed extends the default file set with lib/client.js. Runtime
    // version switches follow automatically: the overlay + seed re-run at
    // every spawn (design 18 §9.3), so a switched/rolled-back instance
    // carries the entries.
    const gatewayHostPackagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'host-packages')
    createdPlane = (options.deps?.createPlane ?? createControlPlane)({
      host: options.config.plane.host,
      port: options.config.plane.port,
      stateDir: options.config.plane.stateDir,
      // Static anchor for fakes/boot log; the live spawn path resolves per-spawn
      // through the runtime manager (env → override → anchor, design 18 §9.3).
      dshWorkspacePath: options.config.plane.dshWorkspacePath,
      extraSeedEntries: [
        {
          insert: { id: 'client-graph', name: '@dsh-chamber/dsh-host-client-graph' },
          kind: 'host',
          source: 'desktop-synced',
          sourceDir: syncedSourceDir(options.config.plane.stateDir, '@dsh-chamber/dsh-host-client-graph'),
          probeDomains: ['clientGraph/graph'],
        },
        {
          insert: { id: 'git-worktree', name: '@dsh-chamber/dsh-host-git-worktree' },
          kind: 'host',
          source: 'desktop-synced',
          sourceDir: syncedSourceDir(options.config.plane.stateDir, '@dsh-chamber/dsh-host-git-worktree'),
          probeDomains: ['gitWorktree/previewCreate'],
        },
        {
          insert: { id: 'mobile', name: '@dsh-chamber/dsh-client-ui-mobile' },
          kind: 'client',
          source: 'packaged',
          sourceDir: join(gatewayHostPackagesDir, 'dsh-chamber-client-ui-mobile'),
          seedFiles: ['package.json', 'dist/index.js', 'lib/index.js', 'lib/client.js', 'lib/client.js.map'],
        },
      ],
      getDshWorkspacePath: () => {
        if (runtimeManager === null) return options.config.plane.dshWorkspacePath
        if (runtimeManager.transactionWorkspace !== null) return runtimeManager.transactionWorkspace
        return runtimeManager.resolveWorkspace().path
      },
      canStartLocal: () => {
        const internalSpawn = runtimeManager?.internalSpawnActive() ?? false
        if (stopping && !internalSpawn) {
          return { ok: false, reason: 'gateway is stopping' }
        }
        if (runtimeManager === null) return { ok: true }
        if (runtimeExposureQuarantined() && !internalSpawn) {
          return { ok: false, reason: 'dsh runtime exposure is quarantined' }
        }
        return { ok: true }
      },
      canExposeLocal: () => !stopping && !runtimeExposureQuarantined(),
      ...(options.config.plane.dshPort === undefined ? {} : { dshPortBase: options.config.plane.dshPort }),
      logger,
      corsOrigins: options.config.corsOrigins,
      corsEvaluator: requestPolicy.corsEvaluator,
      middleware: dispatch.middleware,
      upgradeMiddleware: dispatch.upgradeMiddleware,
    })
    proxy = (options.deps?.createProxy ?? createGatewayProxy)({
      logger,
      getLocalDshPort: () => createdPlane.getLocalDshPort(),
      getLocalState: () => createdPlane.connectionState,
      // D3/F4 (design 18 addendum §5.3): while an activation transaction is in
      // flight the candidate tree must not serve online users — the same
      // predicate the control plane uses for local exposure.
      canExposeLocal: () => !stopping && !runtimeExposureQuarantined(),
    })
  } catch (error) {
    store?.close()
    throw error
  }
  function syncFeatures(status: string): void {
    // 2026-12 strip: the chamber surface is read-only and has no readiness
    // coupling — the ready-transition subscription now only forwards the
    // authoritative state to the runtime manager (design 18 §9.3).
    runtimeManager?.observeLocalState?.(status)
  }

  function assertStartEpoch(epoch: number): void {
    if (stopping || lifecycleEpoch !== epoch) {
      throw Object.assign(new Error('gateway start cancelled by stop'), { code: 'gateway_start_cancelled' })
    }
  }

  async function start(): Promise<void> {
    if (stopPromise !== null) await stopPromise
    if (started) return
    if (startPromise !== null) return startPromise
    stopping = false
    const epoch = ++lifecycleEpoch
    const operation = (async () => {
      try {
        // Design 17 §4.1: a failed start (or a stop) releases the stateDir
        // exclusive lock; a retry must re-take it (fail-closed with a loud
        // 'gateway_locked' error if another process grabbed the directory in
        // between — M3 fix round).
        store.reacquire()
        dispatch.resume()
        await createdPlane.start()
        assertStartEpoch(epoch)
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
        assertStartEpoch(epoch)
        // Desktop-mirror blocked startups (design 18 §3.6/§9.3 review fix):
        // FATAL metadata corruption (journal/current/override corrupt,
        // journal-mismatch), a mid-transaction pointer switch (swap-attempted)
        // or an interrupted snapshot restore (restore-half / restore-
        // incomplete) must NOT be exposed — keep the gateway up with the
        // managed dsh stopped so the runtime controller (mounted and not
        // ready-gated) can serve the recovery surface. FATAL is resumable via
        // POST /chamber/runtime/recover-metadata (2026-12 desktop parity);
        // swap/restore blocks resume via retry-apply | retry-restore.
        if (startup.blockedReason !== null && (FATAL_RUNTIME_BLOCKS.has(startup.blockedReason)
          || startup.blockedReason === 'swap-attempted'
          || startup.blockedReason === 'restore-half'
          || startup.blockedReason === 'restore-incomplete')) {
          const resume = FATAL_RUNTIME_BLOCKS.has(startup.blockedReason)
            ? 'recover-metadata'
            : 'retry-apply|retry-restore'
          logger.error(`gateway runtime startup blocked: ${startup.blockedReason}; managed dsh left stopped — resume via POST /chamber/runtime/${resume}`)
          // Production startupTransaction already stops a probe-left process
          // before releasing activation quarantine. Repeat the idempotent stop
          // at the composition boundary so a future/custom manager cannot turn
          // a blocked-but-ready verdict into public exposure.
          await createdPlane.stopLocal()
          assertStartEpoch(epoch)
          unsubscribeLocalState = createdPlane.onLocalStateChange(snapshot => syncFeatures(snapshot.status))
          started = true
          return
        }
        // H1 review fix (desktop parity): a durable metadata-recovery
        // transaction mid-flight (record not finalized) or a corrupt recovery
        // marker must NEVER serve DSH_HOME through the builtin anchor without
        // the probe gate — the startup transaction sees archived metadata as
        // clean and would otherwise bypass it. Keep the gateway up with the
        // managed dsh stopped and resume via recover-metadata. (Duck-typed:
        // composition tests inject fake managers without the new seam.)
        const recoveryPreflight = (runtimeManager as { metadataRecoveryPending?: () => boolean }).metadataRecoveryPending
        if (startup.blockedReason === null
          && typeof recoveryPreflight === 'function'
          && recoveryPreflight.call(runtimeManager)) {
          logger.error('gateway runtime metadata recovery is pending (mid-recovery record or corrupt marker); managed dsh left stopped — resume via POST /chamber/runtime/recover-metadata')
          await createdPlane.stopLocal()
          assertStartEpoch(epoch)
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
        assertStartEpoch(epoch)
        syncFeatures(createdPlane.connectionState)
        createdPlane.refreshLocalExposure()
        // L1 review fix (desktop parity): eviction on the startup path writes
        // the durable store-prune marker — consume it at the boot boundary
        // (never inside the shared transaction, which tests exercise heavily).
        const pruneBoot = (runtimeManager as { pruneStoreIfNeeded?: () => Promise<void> }).pruneStoreIfNeeded
        if (typeof pruneBoot === 'function') void pruneBoot.call(runtimeManager)
        started = true
      } catch (error) {
        // The HTTP server is opened before the runtime startup transaction.
        // Fence credential writers and break authenticated requests that are
        // still waiting for body bytes. Mutations beyond that boundary remain
        // tracked until their complete route tail has settled. (Since the
        // 2026-12 orchestration strip the only other /chamber writer is the
        // synchronous plugin-sync cache put, which completes before its route
        // tail settles — no drain entry needed.)
        const dispatchQuiescence = dispatch.quiesce()
        syncFeatures('error')
        unsubscribeLocalState?.()
        unsubscribeLocalState = null
        let runtimeDisposalError: unknown = null
        try {
          await runtimeManager?.dispose()
        } catch (stopError) {
          runtimeDisposalError = stopError
          logger.warn(`gateway runtime disposal failed; stateDir lock retained: ${String(stopError)}`)
        }
        if (runtimeDisposalError === null) runtimeManager = null
        let dispatchQuiescenceError: unknown = null
        try {
          await dispatchQuiescence
        } catch (drainError) {
          dispatchQuiescenceError = drainError
          logger.warn(`gateway credential mutation drain failed; stateDir lock retained: ${String(drainError)}`)
        }
        await createdPlane.stop().catch(stopError => logger.warn(`gateway startup rollback failed: ${String(stopError)}`))
        // Release the stateDir exclusive lock on the rollback path so a retry
        // (or another process) can take over the directory (Phase 1 close).
        // If runtime disposal could not prove every writer quiescent, retain
        // the outer state lock and owner record: allowing another gateway to
        // enter would turn a cleanup failure into concurrent state mutation.
        if (runtimeDisposalError === null && dispatchQuiescenceError === null) store.close()
        if (runtimeDisposalError !== null || dispatchQuiescenceError !== null) {
          throw new AggregateError(
            [error, runtimeDisposalError, dispatchQuiescenceError].filter(reason => reason !== null),
            'gateway startup rollback could not prove all state writers quiescent; stateDir lock retained',
          )
        }
        throw error
      }
    })()
    const tracked = operation.finally(() => {
      if (startPromise === tracked) startPromise = null
    })
    startPromise = tracked
    return startPromise
  }

  function stop(): Promise<void> {
    if (stopPromise !== null) return stopPromise
    // Fence every continuation of the current start before invoking any
    // asynchronous cleanup. The runtime manager's dispose() aborts an active
    // startup transaction/probe; when the manager does not exist yet, an
    // immediate plane.stop() interrupts a deferred listen instead.
    stopping = true
    lifecycleEpoch += 1
    // Admission closes synchronously inside quiesce(), before any async
    // teardown can release the state lock or stop the dsh dependency of an
    // already-entered saga. (Since the 2026-12 orchestration strip the
    // credential/runtime writers remain behind the dispatch fence, plus the
    // synchronous plugin-sync cache put — the drain tracks the credential/
    // runtime writers; the plugin put is synchronous and completes before
    // quiesce observes it.)
    const dispatchQuiescence = dispatch.quiesce()
    const pendingStart = startPromise
    const managerAtStop = runtimeManager
    unsubscribeLocalState?.()
    unsubscribeLocalState = null
    proxy?.closeAllStreams()
    syncFeatures('stopped')

    // Start quiescing immediately instead of waiting for startPromise. A real
    // manager makes this the lifecycle-abort + writer barrier. The async IIFE
    // invokes dispose() synchronously up to its first await.
    const runtimeDisposal = (async (): Promise<unknown> => {
      try {
        await managerAtStop?.dispose()
        return null
      } catch (stopError) {
        logger.warn(`gateway runtime disposal failed; stateDir lock retained: ${String(stopError)}`)
        return stopError
      }
    })()

    // There is no runtime abort controller before manager construction. Ask
    // the plane to interrupt a pending listen now; a final stop below remains
    // the authoritative cleanup proof after the start continuation settles.
    const listenInterruption = managerAtStop === null
      ? createdPlane.stop().catch(error => {
          logger.warn(`gateway plane start interruption failed: ${String(error)}`)
        })
      : Promise.resolve()

    const operation = (async () => {
      await pendingStart?.catch(() => {})
      const runtimeDisposalError = await runtimeDisposal
      await listenInterruption

      let dispatchQuiescenceError: unknown = null
      try {
        await dispatchQuiescence
      } catch (error) {
        dispatchQuiescenceError = error
        logger.warn(`gateway credential mutation drain failed; stateDir lock retained: ${String(error)}`)
      }

      // Streams were synchronously detached above, and runtime disposal plus
      // the credential-mutation barrier have settled. Only then do we prove
      // the complete control plane is stopped; no public exposure or
      // gateway-document writer survives the drain window.
      let planeStopError: unknown = null
      try {
        await createdPlane.stop()
      } catch (error) {
        planeStopError = error
      }
      started = false
      if (runtimeDisposalError === null && runtimeManager === managerAtStop) runtimeManager = null
      // A plane-listener failure alone does not imply a surviving runtime writer,
      // so preserve the existing retryability rule for that case. A failed
      // runtime writer proof is categorically different: never release the
      // stateDir lock even though the outer plane has been asked to stop.
      if (runtimeDisposalError === null && dispatchQuiescenceError === null) store.close()
      const writerErrors = [runtimeDisposalError, dispatchQuiescenceError]
        .filter((error): error is {} => error !== null)
      if (writerErrors.length > 0 && planeStopError !== null) {
        throw new AggregateError(
          [...writerErrors, planeStopError],
          'gateway stop failed and state writer ownership was retained',
        )
      }
      if (writerErrors.length === 1) throw writerErrors[0]
      if (writerErrors.length > 1) {
        throw new AggregateError(writerErrors, 'gateway state writers could not be proven quiescent; ownership retained')
      }
      if (planeStopError !== null) throw planeStopError
    })()
    const tracked = operation.finally(() => {
      if (stopPromise === tracked) stopPromise = null
    })
    stopPromise = tracked
    return tracked
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
export { createChamberSurface } from './routes.ts'
export type { ChamberSurface, ChamberSurfaceDeps } from './routes.ts'
export { createGatewayStore, hashCredential, verifyCredential } from './store.ts'
export type { GatewayStore } from './store.ts'
export { createChannelRegistry } from './channels.ts'
export type { ChannelKind, ChannelHealth, ChannelProvider, ChannelInstance, ChannelRegistry, ChannelListEntry } from './channels.ts'
export { createGatewayRequestPolicy, GATEWAY_VIEWPORT_META } from './middleware.ts'
export type { GatewayRequestDecision, GatewayRequestPolicy } from './middleware.ts'
