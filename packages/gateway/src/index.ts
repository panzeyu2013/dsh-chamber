/**
 * @dsh-chamber/gateway — the server-side access gateway (design 17).
 * createGateway assembles the control-plane core (local dsh hosting + management
 * REST + per-instance proxy), the pluggable auth provider, the single-target
 * gateway-proxy and the chamber surface; auth, dispatch and upgradeMiddleware
 * mount through the control-plane's middleware hooks.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FATAL_STARTUP_BLOCK_REASONS } from '@dsh-chamber/dsh-runtime'
import {
  CHAMBER_HOST_PACKAGES,
  HOST_PACKAGE_SEED_FILES,
  acquireStateRootLease,
  authCookieFor,
  createControlPlane,
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
  type GatewayConfig,
} from './config.ts'
import { createAuth, type AuthProvider } from './auth.ts'
import { createGatewayProxy, type GatewayProxy } from './gateway-proxy.ts'
import { createGatewayDispatch } from './dispatch.ts'
import { createGatewayRequestPolicy } from './middleware.ts'
import { createChamberSurface, type ChamberSurface } from './routes.ts'
import { createSessionStateService, type SessionStateService } from './session-state.ts'
import { createChamberPlugins, syncedSourceDir } from './plugins.ts'
import { createChamberInstalled } from './plugins-installed.ts'
import { createGatewayStore, type GatewayStore } from './store.ts'
import { createChannelRegistry } from './channels.ts'
import { createGatewayRuntimeManager, type GatewayRuntimeManager } from './runtime-manager.ts'
import { createRuntimeRoutes } from './runtime-routes.ts'
import { createPluginWriteCheckpoint } from './spawn-checkpoint.ts'
import { resolvePnpmEntry } from './pnpm-entry.ts'

/** Startup-block reasons that fail gateway boot loudly. Metadata corruption (the
 * shared dsh-runtime FATAL set, also the desktop main's) is a hard boot failure;
 * swap-attempted and restore-half/incomplete leave the gateway up with the
 * managed dsh stopped, resumable via the runtime recovery routes. */
const FATAL_RUNTIME_BLOCKS = new Set<string>(FATAL_STARTUP_BLOCK_REASONS)

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
  /** Effective auth kind AFTER config seeding — reflects runtime-managed
   * credentials, unlike the deployment-config kind. */
  readonly authKind: string
}

/** Defend the programmatic constructor as well as the CLI parser: the structural
 * GatewayConfig type lets plain-JS callers forge `kind:'token'` without a token
 * or request unimplemented TLS and expose the anonymous provider over plaintext. */
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
  // A forged mobile entry could turn UA shunting into an open redirect or a
  // self-loop — the origin-form guard the parser applies to constructors.
  if (config.mobileUaRedirect === true) {
    normalizeMobileEntryPath(config.mobileEntryPath ?? DEFAULT_MOBILE_ENTRY_PATH)
  }
}

export function createGateway(options: GatewayOptions): GatewayHandle {
  validateMaterializedConfig(options.config)
  const logger = options.logger ?? console
  // R2 state-root writer lease: THIS process is the only writer of this state
  // root while it runs; taken BEFORE the first store write, shared with the
  // store/plane/manager, released only by stop() after quiescence.
  const stateLease = acquireStateRootLease(options.config.plane.stateDir, {
    scope: 'state-root',
    flavor: 'gateway',
    logger,
  })
  // Mutable holders: dispatch middleware and chamber surface are wired into createControlPlane BEFORE the plane/proxy exist and dereference lazily.
  let proxy: GatewayProxy | null = null
  let runtimeManager: GatewayRuntimeManager | null = null
  // Getter-backed lazy manager reference for the plane's spawn checkpoint:
  // localConnectionDeps is captured BEFORE the manager exists; `current` reads it live.
  const runtimeManagerRef: { current: GatewayRuntimeManager | null } = {
    get current() { return runtimeManager },
  }
  let createdPlane!: PlaneHandle
  let chamberSurface!: ChamberSurface
  // Read-only session-state watcher built below; getters dereference createdPlane/proxy lazily like the proxy.
  let sessionState!: SessionStateService
  let dispatch!: ReturnType<typeof createGatewayDispatch>
  let started = false
  let startPromise: Promise<void> | null = null
  let stopPromise: Promise<void> | null = null
  let lifecycleEpoch = 0
  let stopping = false
  let unsubscribeLocalState: (() => void) | null = null
  const runtimeExposureQuarantined = (): boolean => {
    if (runtimeManager === null) return false
    // Structural lifecycle fakes may omit the seam; the production manager supplies the sticky post-verdict quarantine.
    return runtimeManager.exposureQuarantined?.() ?? runtimeManager.activationInProgress()
  }
  // The whole construction is one transaction: any failure after the lease is
  // taken must release it, or a leaked lease blocks every later start on this root
  // for the process lifetime.
  let store!: GatewayStore
  let auth!: AuthProvider
  try {
    // The gateway store owns tokens/jwt-secret; auth needs it for the token hash + session secret, and the store only asserts the caller's lease.
    store = createGatewayStore(options.config.plane.stateDir, logger, { stateLease })
    // The seeding logger is the gateway logger: without it the loud config-ignored warnings for runtime credentials stay silent.
    auth = createAuth(options.config.auth, store, logger)
    // Loud warning for the explicit anonymous-external override. The verdict uses
    // the EFFECTIVE kind AFTER seeding: a persisted runtime credential makes the
    // deployment authenticated even though config.auth.kind is 'none'.
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
    // Desktop-synced host-package seed cache: chamber host packages come from a connecting desktop's upload; the mobile slot stays packaged.
    const plugins = createChamberPlugins(options.config.plane.stateDir, logger)
    // Managed-profile plugin read projection: readManifest over
    // <stateDir>/dsh-home/profiles/web/package.json (bounded no-follow read;
    // file: values masked), judged with the SAME runtime facts as the write face.
    const installed = createChamberInstalled(
      options.config.plane.stateDir,
      () => {
        if (runtimeManager === null) return null
        const workspace = runtimeManager.resolveWorkspace()
        return { path: workspace.path, version: workspace.version }
      },
    )
    // The read-only session-state watcher: lazy getters like the proxy/chamber
    // surface, started only on the ready/degraded host edge and gated by the same
    // exposure quarantine (never a quarantined candidate tree). The waterfall
    // delegate counts the proxy's downstream WS streams, not the watcher's own
    // loopback mux socket.
    sessionState = createSessionStateService({
      stateDir: options.config.plane.stateDir,
      logger,
      enabled: options.config.sessionState !== false,
      getLocalDshPort: () => createdPlane.getLocalDshPort(),
      getConnectionState: () => createdPlane.connectionState,
      canExposeLocal: () => !stopping && !runtimeExposureQuarantined(),
      otherMuxClientsConnected: () => (proxy?.getDiagnostics().activeStreams ?? 0) > 0,
    })
    // The chamber surface: channels + dashboard assets + plugin-sync cache +
    // the installed read projection + read-only session-state routes — no
    // feature host, no readiness coupling; with auth.ts one of its two writers.
    chamberSurface = (options.deps?.createChamberSurface ?? createChamberSurface)({
      logger,
      channels,
      plugins,
      installed,
      sessionState: sessionState.surface,
    })
    // The runtime controller is gateway-owned and NOT ready-gated: its manager dereference stays lazy so dsh-down windows stay pollable.
    const runtimeRoutes = createRuntimeRoutes(() => {
      if (runtimeManager === null) throw new Error('gateway runtime manager not initialized')
      return runtimeManager
    }, logger)
    // Non-secret audit projection: JSONL append at <stateDir>/audit.log (0600, 5 MiB rotation) for login results — never a secret or session body.
    const auditFile = join(options.config.plane.stateDir, 'audit.log')
    dispatch = createGatewayDispatch(
      auth,
      () => proxy as GatewayProxy,
      () => chamberSurface,
      () => runtimeRoutes,
      logger,
      requestPolicy,
      auditFile,
      // UA shunting (default off; entry path validated by parseGatewayConfig).
      options.config.mobileUaRedirect === true,
      options.config.mobileEntryPath ?? DEFAULT_MOBILE_ENTRY_PATH,
      // Production debounce defaults (undefined = module constant + unref'd timer).
      undefined,
      // Login-phase pre-warm, ON by default (--no-warmup / DSH_GATEWAY_WARMUP=0 off); port/state dereference stays lazy, createdPlane coming later here.
      {
        enabled: options.config.warmup !== false,
        getLocalDshPort: () => createdPlane.getLocalDshPort(),
        getLocalState: () => createdPlane.connectionState,
        canExposeLocal: () => !stopping && !runtimeExposureQuarantined(),
        getSecret: () => store.getJwtSecret(),
        // The spawn-minted browser-auth cookie opens the loopback static surface:
        // upstream's Connection authorizes EVERY index response while non-index
        // assets stay public. An internal host credential, never returned to clients.
        getAuthCookie: port => authCookieFor('http://127.0.0.1:' + port),
        logger,
      },
    )
    // Chamber seed registry: the syncable host packages are DESKTOP-SYNCED (cache
    // filled via PUT /chamber/plugins); until the first sync the seed skips every
    // entry and the probe uses the reduced base set. The mobile slot stays PACKAGED
    // — no desktop in the chain — so its seed MUST ship here, its client half served
    // at /plugins/<pkg>/client.js; overlay + seed re-run each spawn.
    const gatewayHostPackagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'host-packages')
    createdPlane = (options.deps?.createPlane ?? createControlPlane)({
      host: options.config.plane.host,
      port: options.config.plane.port,
      stateDir: options.config.plane.stateDir,
      // 宿主 PATH 无 pnpm 时供给随包 launcher（design 02 §3.1）。
      pnpmEntry: resolvePnpmEntry(),
      // Same handle: the control plane adopts it (root check + assertCurrent) rather than acquiring a second lease on this root.
      stateLease,
      // Static anchor for fakes/boot log; the live spawn path resolves through the runtime manager (env → override → anchor).
      dshWorkspacePath: options.config.plane.dshWorkspacePath,
      extraSeedEntries: [
        // Host packages are DERIVED from the control-plane registry
        // (CHAMBER_HOST_PACKAGES): insert row, name, probe domain and sync-cache
        // source dir all follow from one row — no hand-maintained parallel list.
        // A new row must also land in the probe-domain/name tables.
        ...CHAMBER_HOST_PACKAGES.map(descriptor => ({
          insert: descriptor.insert,
          kind: 'host' as const,
          source: 'desktop-synced' as const,
          sourceDir: syncedSourceDir(options.config.plane.stateDir, descriptor.insert.name),
          probeDomains: [descriptor.probe.method],
        })),
        {
          insert: { id: 'mobile', name: '@dsh-chamber/dsh-client-ui-mobile' },
          kind: 'client',
          source: 'packaged',
          sourceDir: join(gatewayHostPackagesDir, 'dsh-chamber-client-ui-mobile'),
          // The base set is the SHARED seed tuple (control-plane
          // HOST_PACKAGE_SEED_FILES, the same set the desktop PUTs into the sync
          // cache); only the client half's extra files are declared here.
          seedFiles: [...HOST_PACKAGE_SEED_FILES, 'lib/index.js', 'lib/client.js', 'lib/client.js.map'],
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
      // The A1 managed profile-write lease makes beforeSpawnCheckpoint PRODUCTION:
      // every spawn (manual start and health auto-restart) refuses while the lease is
      // held, closing the DSH_HOME TOCTOU between the `dsh plugin` child and the seed.
      localConnectionDeps: {
        beforeSpawnCheckpoint: createPluginWriteCheckpoint(runtimeManagerRef),
      },
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
      // While an activation transaction is in flight the candidate tree must not serve online users — the same predicate the control plane uses.
      canExposeLocal: () => !stopping && !runtimeExposureQuarantined(),
    })
  } catch (error) {
    try {
      stateLease.release()
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'gateway construction failed and the state-root lease could not be released',
      )
    }
    throw error
  }
  function syncFeatures(status: string): void {
    // Readiness coupling is real: that surface carries the /chamber/runtime
    // controller and the seed-cache reads, so this subscription forwards the
    // authoritative state to the runtime manager.
    runtimeManager?.observeLocalState?.(status)
    // Session-state watcher edge: observe only while the managed host is exposed
    // and ready/degraded; every other edge pauses the observer, the routes keeping
    // the last snapshot with host.serviceable=false. start/stop are idempotent.
    if ((status === 'ready' || status === 'degraded') && !stopping) sessionState.start()
    else sessionState.stop()
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
        // A failed start (or a stop) releases the state-root lease; a retry must re-take it, failing closed with 'state_root_locked' on contention.
        stateLease.reacquire()
        dispatch.resume()
        await createdPlane.start()
        assertStartEpoch(epoch)
        // Runtime manager construction (single-owner guard + state root).
        runtimeManager = (options.deps?.createRuntimeManager ?? createGatewayRuntimeManager)({
          config: options.config,
          plane: createdPlane,
          logger,
          // Same handle: the manager adopts it and never releases it; stop() does.
          stateLease,
          onActivationQuarantineChange: () => syncFeatures(createdPlane.connectionState),
        })
        // The runtime startup transaction runs BEFORE the first startLocal(): cleanup → eviction → restore → snapshot → pointer switch → probe gate.
        const startup = await runtimeManager.startupTransaction()
        assertStartEpoch(epoch)
        // Blocked startups must NOT be exposed: keep the gateway up with the managed
        // dsh stopped so the runtime controller can serve the recovery surface. FATAL
        // metadata resumes via recover-metadata; swap/restore blocks via their retries.
        if (startup.blockedReason !== null && (FATAL_RUNTIME_BLOCKS.has(startup.blockedReason)
          || startup.blockedReason === 'swap-attempted'
          || startup.blockedReason === 'restore-half'
          || startup.blockedReason === 'restore-incomplete'
          // Desktop parity: an env-override runtime that failed the activation
          // probe gate must NOT be exposed. Env is externally pinned: fix
          // DSH_GATEWAY_DSH_PATH and restart, since no recovery route exists.
          || startup.blockedReason === 'env-probe-failed')) {
          const resume = startup.blockedReason === 'env-probe-failed'
            ? null
            : FATAL_RUNTIME_BLOCKS.has(startup.blockedReason)
              ? 'recover-metadata'
              : 'retry-apply|retry-restore'
          logger.error(`gateway runtime startup blocked: ${startup.blockedReason}; managed dsh left stopped${resume === null ? ' — fix the DSH_GATEWAY_DSH_PATH runtime target and restart the gateway' : ` — resume via POST /chamber/runtime/${resume}`}`)
          // Production startupTransaction already stops a probe-left process;
          // repeat it so a custom manager cannot expose a blocked-but-ready verdict.
          await createdPlane.stopLocal()
          assertStartEpoch(epoch)
          unsubscribeLocalState = createdPlane.onLocalStateChange(snapshot => syncFeatures(snapshot.status))
          started = true
          return
        }
        // A durable metadata-recovery transaction mid-flight or a corrupt
        // recovery marker must NEVER serve DSH_HOME through the builtin anchor
        // without the probe gate: keep the gateway up and resume via
        // recover-metadata. The preflight is fail-closed — ONLY `false` reaches
        // startLocal(), `'unknown'` counting as true.
        const recoveryPreflight = (runtimeManager as { metadataRecoveryPending?: () => boolean | 'unknown' }).metadataRecoveryPending
        if (startup.blockedReason === null && typeof recoveryPreflight === 'function') {
          const metadataRecovery = recoveryPreflight.call(runtimeManager)
          if (metadataRecovery !== false) {
            logger.error(metadataRecovery === 'unknown'
              ? 'gateway runtime metadata is unreadable (the recovery preflight could not read the state directory); managed dsh left stopped — fix the runtime state directory and restart the gateway'
              : 'gateway runtime metadata recovery is pending (mid-recovery record or corrupt marker); managed dsh left stopped — resume via POST /chamber/runtime/recover-metadata')
            await createdPlane.stopLocal()
            assertStartEpoch(epoch)
            unsubscribeLocalState = createdPlane.onLocalStateChange(snapshot => syncFeatures(snapshot.status))
            started = true
            return
          }
        }
        // The candidate spawn emits transient ready transitions, so the feature-consumer
        // subscription attaches only AFTER the verdict, never against a doomed candidate.
        unsubscribeLocalState = createdPlane.onLocalStateChange(snapshot => syncFeatures(snapshot.status))
        // Gateway is a managed local-dsh deployment, not API-only: readiness is part of successful startup.
        await createdPlane.startLocal()
        assertStartEpoch(epoch)
        syncFeatures(createdPlane.connectionState)
        createdPlane.refreshLocalExposure()
        // Eviction on the startup path writes the durable store-prune marker; consume it at boot, never inside the shared transaction.
        const pruneBoot = (runtimeManager as { pruneStoreIfNeeded?: () => Promise<void> }).pruneStoreIfNeeded
        if (typeof pruneBoot === 'function') void pruneBoot.call(runtimeManager)
        started = true
      } catch (error) {
        // The HTTP server is opened before the runtime startup transaction: fence
        // credential writers and break requests still waiting for body bytes; mutations
        // stay tracked until their route tail settles.
        const dispatchQuiescence = dispatch.quiesce()
        syncFeatures('error')
        unsubscribeLocalState?.()
        unsubscribeLocalState = null
        let runtimeDisposalError: unknown = null
        try {
          await runtimeManager?.dispose()
        } catch (stopError) {
          runtimeDisposalError = stopError
          logger.warn(`gateway runtime disposal failed; state-root lease retained: ${String(stopError)}`)
        }
        if (runtimeDisposalError === null) runtimeManager = null
        let dispatchQuiescenceError: unknown = null
        try {
          await dispatchQuiescence
        } catch (drainError) {
          dispatchQuiescenceError = drainError
          logger.warn(`gateway credential mutation drain failed; state-root lease retained: ${String(drainError)}`)
        }
        await createdPlane.stop().catch(stopError => logger.warn(`gateway startup rollback failed: ${String(stopError)}`))
        // Release the state-root lease on the rollback path so a retry (or another
        // process) can take over the root. A failed runtime disposal retains it: letting
        // another gateway in would turn a cleanup failure into concurrent mutation.
        let leaseReleaseError: unknown = null
        if (runtimeDisposalError === null && dispatchQuiescenceError === null) {
          try {
            stateLease.release()
          } catch (releaseError) {
            leaseReleaseError = releaseError
          }
        }
        if (runtimeDisposalError !== null || dispatchQuiescenceError !== null || leaseReleaseError !== null) {
          throw new AggregateError(
            [error, runtimeDisposalError, dispatchQuiescenceError, leaseReleaseError].filter(reason => reason !== null),
            'gateway startup rollback could not prove all state writers quiescent; state-root lease retained',
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
    // Fence every continuation of the current start before invoking cleanup: the
    // manager's dispose() aborts an active startup transaction/probe; with no
    // manager yet, an immediate plane.stop() interrupts a deferred listen.
    stopping = true
    lifecycleEpoch += 1
    // Admission closes synchronously inside quiesce(), before any async teardown can
    // release the state-root lease or stop the dsh dependency of an already-entered
    // saga. Credential/runtime writers stay behind the dispatch fence.
    const dispatchQuiescence = dispatch.quiesce()
    const pendingStart = startPromise
    const managerAtStop = runtimeManager
    unsubscribeLocalState?.()
    unsubscribeLocalState = null
    // Session-state watcher teardown (end SSE → stop mux → flush the snapshot): synchronous here, awaited below BEFORE the lease release.
    const sessionStateShutdown = sessionState.shutdown()
    proxy?.closeAllStreams()
    syncFeatures('stopped')

    // Start quiescing immediately instead of waiting for startPromise: with a real
    // manager this is the lifecycle-abort + writer barrier, and the async IIFE invokes
    // dispose() synchronously up to its first await.
    const runtimeDisposal = (async (): Promise<unknown> => {
      try {
        await managerAtStop?.dispose()
        return null
      } catch (stopError) {
        logger.warn(`gateway runtime disposal failed; state-root lease retained: ${String(stopError)}`)
        return stopError
      }
    })()

    // With no manager there is no runtime abort controller: ask the plane to interrupt a pending listen now; the final stop below stays authoritative.
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
        logger.warn(`gateway credential mutation drain failed; state-root lease retained: ${String(error)}`)
      }

      // The watcher is fully stopped and its snapshot flushed before the managed dsh stops; a flush failure must not retain the root lease.
      await sessionStateShutdown.catch(error => {
        logger.warn(`gateway session-state shutdown failed: ${String(error)}`)
      })

      // Streams were synchronously detached above, and runtime disposal plus the credential-mutation barrier have settled — only then is the plane stopped.
      let planeStopError: unknown = null
      try {
        await createdPlane.stop()
      } catch (error) {
        planeStopError = error
      }
      // The listener is closed now, so no NEW request can be accepted: publish
      // whatever the fence-time drain could not see. One window still opens — a
      // handler inside `await auth.verify()` resumes and records its rejection —
      // and that count rides the unref'd debounce timer: a diagnostic count only.
      dispatch.flushAuditWindows()
      started = false
      if (runtimeDisposalError === null && runtimeManager === managerAtStop) runtimeManager = null
      // A plane-listener failure alone leaves retryability intact; a failed runtime writer proof is different — retain the lease.
      let leaseReleaseError: unknown = null
      if (runtimeDisposalError === null && dispatchQuiescenceError === null) {
        try {
          stateLease.release()
        } catch (error) {
          leaseReleaseError = error
        }
      }
      const writerErrors = [runtimeDisposalError, dispatchQuiescenceError, leaseReleaseError]
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

// The bundle's public surface: the control plane consumes createGateway (defined here) plus these two re-exports.
export { createChamberSurface } from './routes.ts'
export { createGatewayStore } from './store.ts'
