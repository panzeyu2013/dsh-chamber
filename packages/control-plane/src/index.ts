/**
 * @dsh-chamber/control-plane — the control-plane package root.
 *
 * createControlPlane assembles the v4 connection-manager core: the catalog
 * (single local connection row), the managed local dsh host (web profile spawn +
 * readiness + health + reaper), the management REST surface, the per-instance
 * reverse proxy, and the optional static frontend service. start() binds HTTP and
 * stops() tears down the connection before the server.
 *
 * Options: stateDir ($DSH_CHAMBER_STATE or ~/.dsh-chamber); dshWorkspacePath
 * (dsh install root, default $DSH_CHAMBER_DSH_PATH or <repo>/ref-dsh then the
 * vendor bundle); port/host; webDistDir (optional static frontend dist, API-only
 * when unset); logger; corsOrigins. The installed layout spawns with the managed
 * dsh home as cwd — an in-place app update must never unlink the host's cwd.
 */

import { createServer, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, statSync } from 'node:fs'
import type { ConnectionRowView } from './api.ts'
import { createCatalog } from './catalog.ts'
import { createLocalConnection } from './local-connection.ts'
import type { LocalConnectionDeps } from './local-connection.ts'
import { createApi } from './api.ts'
import { runReaper, type ReaperEntryOutcome } from './reaper.ts'
import {
  createInstanceProxy,
  type InstanceProxy,
  type InstanceTransportRegistrationOptions,
} from './instance-proxy.ts'
import { ensureInstanceId } from './instance-id.ts'
import { ensurePrivateDirectoryNoFollow } from './private-file.ts'
import {
  acquireStateRootLease,
  resolveStateRoot,
  type StateRootLease,
  type StateRootLeaseFlavor,
} from './state-root-lease.ts'
import { hostLogs } from './host-logs.ts'
import { createStaticServing } from './static-serving.ts'
import {
  assertHostSeedEntryNaming,
  CHAMBER_HOST_PACKAGES,
  HOST_ARCHIVE_CLEANUP_INSERT,
  HOST_GIT_WORKTREE_INSERT,
  HOST_GRAPH_INSERT,
  HOST_OPEN_IN_INSERT,
  type SeedEntry,
} from './host-graph-seed.ts'
import { resolveLocalHostGraphOverlay, seedDshHomeDefaults } from './local-host-seeding.ts'
import { withControlLogFile } from './log-file.ts'
import type { Logger } from './types.ts'
import type { ApiCorsEvaluator, ApiRequest, ApiResponse, ApiSurface } from './api.ts'

/** Browser hardening shared by static, API, proxy and error responses.
 *
 * `referrer-policy` is `same-origin`, deliberately NOT `no-referrer`: under
 * no-referrer a document serializes the Origin of same-origin form submissions as
 * `null`, which the chamber origin fences reject fail-closed (self-inflicted 403
 * on gateway login / runtime actions). `same-origin` keeps the privacy intent
 * without nulling form-POST Origins; JSON/fetch traffic is unaffected. */
const CONTROL_PLANE_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'cross-origin-opener-policy': 'same-origin',
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
})

// DEFAULT_STATE_DIR and the state-root resolution live in state-root-lease.ts
// (the single source re-exported below) so every shape resolves one root alike.

/**
 * Default for the control plane's own HTTP bind: desktop, CLI and frontend URLs
 * derive their default origin from it; distant from DEFAULT_DSH_START_PORT (17510)
 * so the two surfaces never collide.
 */
export const DEFAULT_CONTROL_PLANE_PORT = 17500

/** This package's repo root (<repo>/packages/control-plane/src → <repo>). */
const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

/**
 * Default module-A host package source dir: the chamber host package whose
 * dist/index.js + package.json the plane seeds into the local profile. Dev and CI
 * ship it at <repo>/packages/dsh-chamber-seed-client-graph; packaged runtimes pass
 * the bundled location (an absent source is skipped, never an error).
 */
const DEFAULT_HOST_GRAPH_PACKAGE_SOURCE_DIR = join(REPO_ROOT, 'packages', 'dsh-chamber-seed-client-graph')

/** Default source for the chamber in-host Git worktree service package. */
const DEFAULT_HOST_GIT_WORKTREE_PACKAGE_SOURCE_DIR = join(REPO_ROOT, 'packages', 'dsh-chamber-seed-git-worktree')

/** Default source for the chamber in-host archived-session cleanup domain package. */
const DEFAULT_HOST_ARCHIVE_CLEANUP_PACKAGE_SOURCE_DIR = join(REPO_ROOT, 'packages', 'dsh-chamber-seed-archive-cleanup')

/**
 * Default source for the chamber in-host open-in domain package (fork of
 * upstream's open-in host half; packaged runtimes pass the bundled location).
 * LOCAL shape only: the row is `localOnly`, so no remote target or gateway
 * receives it.
 */
const DEFAULT_HOST_OPEN_IN_PACKAGE_SOURCE_DIR = join(REPO_ROOT, 'packages', 'dsh-chamber-seed-open-in')

/**
 * Default dsh workspace: <repo root>/ref-dsh when present, else the desktop vendor
 * bundle. When neither exists it still returns the ref-dsh path — the caller
 * decides how to surface the absence.
 */
export function defaultDshWorkspacePath() {
  const refDsh = join(REPO_ROOT, 'ref-dsh')
  if (existsSync(refDsh)) return refDsh
  const vendorDsh = join(REPO_ROOT, 'packages', 'desktop', 'vendor', 'dsh')
  if (existsSync(vendorDsh)) return vendorDsh
  return refDsh
}

/**
 * createControlPlane options (all optional; see the module docblock).
 * `corsOrigins` is the explicit cross-origin allowlist.
 */
export interface ControlPlaneOptions {
  port?: number
  host?: string
  stateDir?: string
  /**
   * Caller-held state-root lease (the gateway acquires it before its first store
   * write). When provided it is adopted — same root verified plus assertCurrent —
   * and never released by the plane; when absent the plane acquires its own,
   * reacquires it in start() and releases it in stop().
   */
  stateLease?: StateRootLease
  /** Diagnostic writer label for the plane-owned lease record. */
  stateWriter?: StateRootLeaseFlavor
  dshWorkspacePath?: string
  /** Resolve the workspace for each local spawn/restart (runtime switching). */
  getDshWorkspacePath?: () => string
  /** Optional dynamic lifecycle gate, checked at management entry and again before every start/restart seed and spawn. */
  canStartLocal?: () => { ok: true } | { ok: false; reason: string }
  /** Dynamic public exposure gate. The desktop keeps this closed from spawn
   * through the full activation-probe verdict. */
  canExposeLocal?: () => boolean
  /** First port attempted for the managed dsh host (absent = BASE_DHSPORT 17510). */
  dshPortBase?: number
  webDistDir?: string
  logger?: Logger
  corsOrigins?: string[]
  /** Explicit request boundary for an authenticated external composer; its
   *  presence is also the opt-in permitting a non-loopback bind. */
  corsEvaluator?: ApiCorsEvaluator
  /** Injectable local-connection wire deps (test seams: fake spawn/probe). */
  localConnectionDeps?: LocalConnectionDeps
  /** Injectable orphan reaper (test seam for lifecycle interleavings). */
  reaper?: typeof runReaper
  /**
   * Module-A host package source dir: seeded into the local profile so the spawned
   * host resolves the client-graph row. Defaults to
   * <repo>/packages/dsh-chamber-seed-client-graph; packaged runtimes pass the
   * bundled location. An absent source or missing built dist/index.js is skipped,
   * never an error.
   */
  hostGraphPackageSourceDir?: string
  /** Chamber in-host Git worktree package source; same built-artifact gate and profile seed lifecycle as hostGraphPackageSourceDir. */
  hostGitWorktreePackageSourceDir?: string
  /** Chamber in-host archived-session cleanup domain package source; same
   *  built-artifact gate and seed lifecycle (absent source or dist = skipped). */
  hostArchiveCleanupPackageSourceDir?: string
  /** Chamber in-host open-in domain package source; same built-artifact gate and
   *  seed lifecycle. This row is `localOnly`: the local profile is the only shape
   *  that receives it. */
  hostOpenInPackageSourceDir?: string
  /**
   * Seed registry: additional chamber seed entries beyond the four base host
   * packages — the seam for browser-side client plugins in hosted frontends (e.g.
   * the gateway mobile slot). Every entry rides the same built-artifact gate,
   * profile seed lifecycle and `--patch` overlay as the host packages; kind 'client'
   * entries carry no probe coupling, and an absent sourceDir is a warned stub skip,
   * never an error.
   */
  extraSeedEntries?: readonly SeedEntry[]
  /**
   * Optional request middleware: runs after security headers + CSP + URL parse and
   * BEFORE the default dispatch. A truthy return CLAIMS the request; falsy falls
   * through. The gateway uses it for its auth gate and route handling while letting
   * the management surface fall through.
   */
  middleware?: (
    req: ApiRequest,
    res: ApiResponse,
    url: URL,
    ctx: PlaneMiddlewareContext,
  ) => boolean | void | Promise<boolean | void>
  /** Optional upgrade middleware running BEFORE the default origin fence + instance-proxy dispatch; a truthy return CLAIMS the upgrade. */
  upgradeMiddleware?: (
    req: ApiRequest,
    socket: Duplex,
    head: Buffer,
    ctx: PlaneMiddlewareContext,
  ) => boolean | void | Promise<boolean | void>
}

/** Internal surfaces handed to a composing gateway's middleware: management REST + CORS decision + per-instance proxy. */
export interface PlaneMiddlewareContext {
  api: ApiSurface
  instanceProxy: InstanceProxy
}

/** The assembled control-plane handle returned by createControlPlane. */
export interface PlaneHandle {
  start(): Promise<void>
  stop(): Promise<void>
  readonly port: number | null
  readonly connectionState: string
  /** Whether a real dsh process is currently alive under the local connection (state-string independent). */
  readonly localProcessAlive: boolean
  /** True only when startup reaping proved no kept/failed managed host records could still write the shared DSH_HOME. */
  readonly localWritersQuiescent: boolean
  /** Live port of the managed local host; null while it is not serving. */
  readonly localDshPort: number | null
  readonly instanceId: string
  /**
   * The activation-probe domains backed by the host packages actually seeded into
   * the local profile: the desktop derives its expectation set from this, so a
   * missing host package cannot cause an exact-set activation failure and rollback.
   */
  readonly seededProbeDomains: readonly string[]
  /** The managed local dsh host's port, or null when not ready (used by the gateway-proxy's single-target resolution). */
  getLocalDshPort(): number | null
  /** The target kind lives in connectionId; `opts.transport` carries the
   *  independent SSH/HTTP dimension. TLS pin and Host authority stay gateway-only. */
  registerInstanceTransport(connectionId: string, baseUrl: string, extraHeaders?: Record<string, string>, opts?: InstanceTransportRegistrationOptions): void
  unregisterInstanceTransport(connectionId: string): void
  /**
   * Pre-start the local instance (desktop pre-spawn): idempotent — a
   * running/starting instance resolves immediately. Called before the window loads
   * so the first screen finds the instance ready.
   */
  startLocal(): Promise<void>
  /** Stop the managed local host without tearing down the control plane; resolves after queued/in-flight start and restart writers settle. */
  stopLocal(): Promise<void>
  /**
   * Transactional user-triggered dsh restart: refresh mounted plugins without a
   * stopLocal()+startLocal() pairing. Shares the health state machine's restart
   * single-flight; rejects (connection_busy) when the runtime gate is closed or a
   * stop is in progress, or from restart-exhausted.
   */
  restartLocal(): Promise<void>
  /** Re-publish the public local lifecycle after canExposeLocal changes. */
  refreshLocalExposure(): void
  /**
   * Writer-quiescence diagnosis: the last scan's verdict plus per-record detail,
   * WITHOUT acting; the connections page uses it to name what blocks the local
   * instance.
   */
  localWriterDiagnosis?(): { quiescent: boolean; writers: ReaperEntryOutcome[]; errors: string[] }
  /**
   * Explicit takeover: clear this state directory's own stale or orphaned managed
   * host writers (a writer whose control plane is still alive is never touched, no
   * unverified process is signalled), then start the local connection. Throws
   * connection_busy (with detail) when a live writer remains.
   */
  reclaimLocal?(): Promise<{ reclaimed: number[]; connection: ConnectionRowView | null; spawned: boolean }>
  /** Subscribe to authoritative local-host lifecycle transitions (gateway attaches
   *  only while ready; the desktop uses it for delayed rollback policy). */
  onLocalStateChange(listener: (snapshot: { status: string; port: number | null; error: string | null }) => void): () => void
}

/** Create the control plane; returns the assembled PlaneHandle. */
export function createControlPlane(options: ControlPlaneOptions = {}): PlaneHandle {
  const port = options.port ?? DEFAULT_CONTROL_PLANE_PORT
  const host = options.host ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== '::1'
    && (options.corsEvaluator === undefined || options.middleware === undefined || options.upgradeMiddleware === undefined)) {
    // loopback-only is a v1 invariant: a non-loopback bind would expose the
    // anonymous management API + reverse proxy, and the Host/Origin fence is browser-only.
    throw new Error(`control plane refuses non-loopback bind ${JSON.stringify(host)} without an external request-boundary evaluator plus HTTP/upgrade middleware; loopback-only is the anonymous v1 invariant`)
  }
  const stateDir = resolveStateRoot({ explicit: options.stateDir, env: process.env })
  // The state root has exactly one writer. A caller that already holds the lease
  // (gateway shape) passes it in and the plane adopts it — same root verified plus
  // assertCurrent, never released here. Otherwise the plane takes its own,
  // reacquires in start() and releases in stop() after the quiescence proof.
  const providedStateLease = options.stateLease
  const stateLease = providedStateLease ?? acquireStateRootLease(stateDir, {
    scope: 'state-root',
    flavor: options.stateWriter ?? 'control-plane',
    logger: options.logger ?? console,
  })
  const ownsStateLease = providedStateLease === undefined
  if (providedStateLease !== undefined) {
    if (providedStateLease.stateRoot !== stateDir) {
      throw new Error(
        'control plane stateLease root ' + providedStateLease.stateRoot + ' does not match stateDir ' + stateDir,
      )
    }
    providedStateLease.assertCurrent()
  }
  const defaultWorkspacePath = options.dshWorkspacePath ?? process.env.DSH_CHAMBER_DSH_PATH ?? defaultDshWorkspacePath()
  const getDshWorkspacePath = options.getDshWorkspacePath ?? (() => defaultWorkspacePath)
  const webDistDir = options.webDistDir === undefined ? undefined : options.webDistDir
  // The console default satisfies every module's logger option. Control-plane logs
  // also land in <stateDir>/logs/control-plane.log (bounded rotation) because
  // packaged stdout/stderr is not persisted; a write failure only degrades.
  const logger = withControlLogFile((options.logger ?? console) as Logger, stateDir)
  // logger.reopen() 在 start() 里调用（stop 后重启必须重开句柄）。
  const reapManagedHosts = options.reaper ?? runReaper
  let localWritersQuiescent = false
  /**
   * Why the writer-quiescence latch is closed, as of the last scan. Published so a
   * blocked local instance names its blocker instead of a bare 409.
   */
  let writerScan: { quiescent: boolean; writers: ReaperEntryOutcome[]; errors: string[] } = {
    quiescent: false, writers: [], errors: [],
  }
  /**
   * The latch has TWO closure causes and only one is re-provable: a SCAN verdict is
   * cleared by a fresh scan, while a write-time termination failure means a process
   * group could not be confirmed gone — no scan can prove that absent, so it stays
   * closed for this plane's lifetime and only an app restart re-proves it.
   */
  let writerLatchSticky = false
  /** In-session re-proof bookkeeping (single-flight + cooldown). */
  let writerReproveInFlight: Promise<void> | null = null
  let writerReprovedAt = 0
  const WRITER_REPROVE_COOLDOWN_MS = 2000

  /**
   * Combine the external runtime-apply gate with the internal process-writer safety
   * latch. The latch begins closed until startup reaping succeeds and closes
   * permanently if any termination cannot prove the detached process group is gone.
   */
  function localStartGate(): { ok: true } | { ok: false; reason: string } {
    if (!localWritersQuiescent) {
      const blockers = writerBlockers()
      const detail = blockers.map(b => `pid ${String(b.pid)} (${b.reason})`).join(', ')
      return {
        ok: false,
        reason: writerLatchSticky
          ? 'local DSH_HOME writer quiescence is not proven: a previous termination could not be confirmed; restart the app to re-prove it'
          : 'local DSH_HOME writer quiescence is not proven'
            + (detail === '' ? '' : `: ${detail}`),
      }
    }
    return options.canStartLocal?.() ?? { ok: true }
  }

  /**
   * Run one writer-quiescence scan and publish its verdict + per-entry detail.
   * `takeover` is the explicit user action; the automatic paths (startup, a
   * refused start, the diagnosis read) stay fail-closed.
   */
  async function scanLocalWriters(takeover: boolean): Promise<ReaperEntryOutcome[]> {
    const writers: ReaperEntryOutcome[] = []
    const reaped = await reapManagedHosts({
      stateDir,
      logger,
      ...(takeover ? { takeover: true } : {}),
      onEntry: outcome => writers.push(outcome),
    })
    localWritersQuiescent = !writerLatchSticky && reaped.kept === 0 && reaped.errors.length === 0
    writerScan = {
      quiescent: localWritersQuiescent,
      writers,
      errors: writerLatchSticky
        ? [...reaped.errors, 'a previous termination could not be confirmed; restart the app to re-prove writer quiescence']
        : [...reaped.errors],
    }
    if (reaped.reclaimed > 0) logger.log(`reaper: reclaimed ${reaped.reclaimed} orphaned dsh host(s)`)
    for (const reaperError of reaped.errors) logger.error(`reaper: ${String(reaperError)}`)
    return writers
  }

  function writerBlockers(): ReaperEntryOutcome[] {
    return writerScan.writers.filter(entry => entry.status === 'kept')
  }

  /**
   * The 409 payload for a closed latch: the bare reason plus the structured
   * blockers. Every other 409 on this surface keeps its plain shape.
   */
  function writerBusyError(): Error & { code: string; details?: unknown } {
    const blockers = writerBlockers()
    const error = new Error(
      'local DSH_HOME writer quiescence is not proven'
      + (blockers.length === 0 ? '' : `: ${blockers.map(b => `pid ${String(b.pid)} (${b.reason})`).join(', ')}`),
    ) as Error & { code: string; details?: unknown }
    error.code = 'connection_busy'
    error.details = { writers: blockers, errors: writerScan.errors, sticky: writerLatchSticky }
    return error
  }

  /**
   * Re-prove writer quiescence inside a running plane: the startup scan runs once,
   * so a record that only BECOMES stale later would keep the latch closed for the
   * whole session and every start would answer 409 until an app restart.
   * Single-flight + a short cooldown bound the scan cost.
   */
  async function reproveLocalWriters(): Promise<void> {
    // A sticky latch is not a scan verdict: re-proving would only "clear" it by
    // forgetting why it closed (see writerLatchSticky).
    if (writerLatchSticky) return
    if (writerReproveInFlight !== null) return await writerReproveInFlight
    if (Date.now() - writerReprovedAt < WRITER_REPROVE_COOLDOWN_MS) return
    writerReproveInFlight = scanLocalWriters(false)
      .then(() => { writerReprovedAt = Date.now() })
      .finally(() => { writerReproveInFlight = null })
    return await writerReproveInFlight
  }

  function localExposureAllowed(): boolean {
    return localWritersQuiescent && (options.canExposeLocal?.() ?? true)
  }

  // Module-A host package source; may be absent — the seed skips it and the plane keeps working.
  const hostGraphPackageSourceDir = options.hostGraphPackageSourceDir ?? DEFAULT_HOST_GRAPH_PACKAGE_SOURCE_DIR
  const hostGitWorktreePackageSourceDir = options.hostGitWorktreePackageSourceDir
    ?? DEFAULT_HOST_GIT_WORKTREE_PACKAGE_SOURCE_DIR
  const hostArchiveCleanupPackageSourceDir = options.hostArchiveCleanupPackageSourceDir
    ?? DEFAULT_HOST_ARCHIVE_CLEANUP_PACKAGE_SOURCE_DIR
  const hostOpenInPackageSourceDir = options.hostOpenInPackageSourceDir
    ?? DEFAULT_HOST_OPEN_IN_PACKAGE_SOURCE_DIR
  // Seed registry: base chamber host packages are DERIVED from the authoritative
  // registry (CHAMBER_HOST_PACKAGES — insert row, package name and probe domain all
  // come from that one list; a hand-written parallel table is the defect the
  // registry prevents). The only per-package desktop input is its packaged source
  // dir, looked up by insert id. Any extra entry is appended; an extra that
  // re-declares a base id WINS (the gateway passes its synced host packages as
  // desktop-synced extras, replacing the packaged defaults).
  const hostPackageSourceDirs: ReadonlyMap<string, string> = new Map([
    [HOST_GRAPH_INSERT.id, hostGraphPackageSourceDir],
    [HOST_GIT_WORKTREE_INSERT.id, hostGitWorktreePackageSourceDir],
    [HOST_ARCHIVE_CLEANUP_INSERT.id, hostArchiveCleanupPackageSourceDir],
    [HOST_OPEN_IN_INSERT.id, hostOpenInPackageSourceDir],
  ])
  /** 最近一次 seed 实际落地的探针域（seed 时刷新；见 PlaneHandle 注释）。 */
  let seededProbeDomains: readonly string[] = []
  const seedEntries = (): SeedEntry[] => {
    const byId = new Map<string, SeedEntry>()
    for (const descriptor of CHAMBER_HOST_PACKAGES) {
      const sourceDir = hostPackageSourceDirs.get(descriptor.insert.id)
      if (sourceDir === undefined) {
        // A registry row with no packaged source mapped on this owner is a code
        // defect, never a runtime condition — fail loud rather than seed partially.
        throw new Error(
          `chamber seed registry: no packaged sourceDir mapped for host package `
          + `'${descriptor.insert.name}' (insert id '${descriptor.insert.id}')`,
        )
      }
      byId.set(descriptor.insert.id, {
        insert: descriptor.insert,
        kind: 'host',
        source: 'packaged',
        sourceDir,
        probeDomains: [descriptor.probe.method],
      })
    }
    for (const entry of options.extraSeedEntries ?? []) byId.set(entry.insert.id, entry)
    const entries = [...byId.values()]
    // Fail-loud naming pin: every host-kind entry lives in the canonical
    // `@dsh-chamber/dsh-chamber-seed-<loader-id>` namespace, so a rename that
    // forgets one call site cannot reach the profile seed at all.
    assertHostSeedEntryNaming(entries)
    return entries
  }
  // The seed gate is the BUILT artifact (dist/index.js), not the package dir: the
  // dir exists in any checkout, the esbuild output is the shipped artifact. MISSING
  // is skipped gracefully; a PRESENT-but-damaged artifact is seeded and the host
  // boot fails loud (shipped-but-broken is a packaging bug).

  // Establish the durable plane identity before any other persisted module can
  // write; a new state root is created 0700, an existing caller-selected root keeps its mode.
  const instanceId = ensureInstanceId(stateDir)
  const dshHome = join(stateDir, 'dsh-home')
  const catalog = createCatalog({ stateDir, logger })
  catalog.load()

  // Explicit-origin allowlist for the API's CORS decision (v1 has no other cross-origin control).
  const explicitOrigins = Array.isArray(options.corsOrigins) ? options.corsOrigins : []

  // Health-events SSE subscribers; the stream snapshots on subscribe too, so no transition is missed.
  const healthListeners = new Set<(snapshot: { status: string; port: number | null; error: string | null }) => void>()

  /**
   * Idempotent host-graph seed, resolved at every spawn (initial and restart): the
   * seeded package is extraneous to the web profile's dependency graph, and
   * `dsh plugin add/remove` re-links profile node_modules and prunes it, so without
   * the per-spawn re-seed the next restart would boot with an unresolvable --patch
   * row. Returns the overlay path, or null when this spawn passes none (a leftover
   * overlay is removed so the file's presence keeps meaning "this spawn passes
   * it"). A seed throw lands the instance in error state on initial spawn, and in
   * restart-exhausted after bounded retries.
   */
  function resolveHostGraphPatch(): string | null {
    return resolveLocalHostGraphOverlay({
      stateDir,
      dshHome,
      entries: seedEntries(),
      log: message => logger.log(message),
      warn: message => logger.warn(message),
      error: message => logger.error(message),
      // The opt-in host-log bridge switch is read from the plane's own environment at
      // each spawn (the managed host inherits it); the resolver's default stays "off".
      env: process.env,
      // 宿主期望集必须跟随本次实际 seed 的条目，否则 host 包缺失时 exact-set 裁决会误判激活失败。
      onSeededProbeDomains: domains => { seededProbeDomains = domains },
    })
  }

  // The managed local connection adapter: spawn/health/reaper owner; readiness =
  // TCP + unified host-identity probe inside spawn-dsh. Runtime state is
  // process-local and is merged with durable catalog metadata only at the wire projection.
  const local = createLocalConnection({
    stateDir, dshHome, dshWorkspacePath: getDshWorkspacePath, logger,
    // patchPath is a thunk resolved only behind the per-spawn fence. Re-read it for
    // starts and restarts so a profile-internal prune self-heals without a DSH_HOME write during runtime apply/restore.
    options: {
      ...(options.dshPortBase === undefined ? {} : { dshPortBase: options.dshPortBase }),
      ownerInstanceId: instanceId,
      canSpawn: localStartGate,
      onWriterQuiescenceUnknown: (writerError) => {
        localWritersQuiescent = false
        writerLatchSticky = true
        writerScan = {
          quiescent: false,
          writers: [],
          errors: [
            `writer quiescence unknown: ${writerError.message}`,
            'restart the app to re-prove writer quiescence',
          ],
        }
        logger.error(`local writer quiescence became unknown; further starts are blocked until an app restart re-proves it: ${writerError.message}`)
      },
      patchPath: () => {
        // Reached only after local-connection's spawn fence; keeping every DSH_HOME
        // seed here prevents snapshot/restore from racing a start that passed an earlier check.
        if (seedDshHomeDefaults(dshHome)) {
          logger.log('dsh-home: seeded default settings.yaml (locale: zh)')
        }
        return resolveHostGraphPatch()
      },
    },
    deps: options.localConnectionDeps,
  })
  // Candidate lifecycle is an internal fact until the desktop's full probe verdict
  // opens exposure: ready→degraded/restarting/error and the candidate port never
  // escape public REST/SSE. One exception: a start that terminally failed before
  // ever reaching ready projects the honest 'error' status with its concrete reason
  // (spawn errors already carry per-port causes and stderr digests).
  const publicLocalSnapshot = (snapshot: { status: string; port: number | null; error: string | null }) => {
    if (!localExposureAllowed()) {
      const startFailure = local.getStartFailure()
      if (startFailure !== null) {
        return { status: 'error', port: null, error: startFailure }
      }
      return { status: 'starting', port: null, error: null }
    }
    return snapshot
  }
  const currentPublicLocalSnapshot = () => publicLocalSnapshot({
    status: local.getState(),
    port: local.getDshPort(),
    error: local.getError(),
  })
  const publishPublicLocalSnapshot = () => {
    const snapshot = currentPublicLocalSnapshot()
    for (const listener of healthListeners) listener(snapshot)
  }
  // Health-events push fan-out reaches every SSE client through the same quarantine view.
  local.onStateChange((snapshot) => {
    const projected = publicLocalSnapshot(snapshot)
    for (const listener of healthListeners) listener(projected)
  })

  // Managed-host rolling logs: the read side of the per-port JSONL files. While the
  // activation verdict is pending, the 'local' alias resolves to the most recent
  // spawn record and its log contains the candidate port — an internal fact, so the
  // alias read is gated by the same exposure latch (an explicit port query stays available).
  const hostLogsModule = hostLogs({ stateDir, logger })

  // Per-instance reverse proxy: /api/i/<id>/* HTTP/WS/SSE passthrough, reachable
  // without any session; ssh transports are registered by the desktop main process.
  const instanceProxy = createInstanceProxy({
    logger,
    getLocalState: () => local.getState(),
    getLocalDshPort: () => local.getDshPort(),
    canExposeLocal: localExposureAllowed,
  })

  /** The connection-row projection on the wire: status/dshPort/error are LIVE
   *  projections (a stale persisted "ready" must not masquerade as running);
   *  label/accentColor are the persisted user-editable fields. */
  function connectionRowView() {
    const row = catalog.getConnection('local')
    if (row === null) return null
    const publicSnapshot = currentPublicLocalSnapshot()
    const view: { id: string; label?: string; accentColor?: string; status: string; dshPort?: number; error?: string } = {
      id: row.connectionId,
      status: publicSnapshot.status,
    }
    if (typeof row.label === 'string' && row.label !== '') view.label = row.label
    if (typeof row.accentColor === 'string' && row.accentColor !== '') view.accentColor = row.accentColor
    const livePort = publicSnapshot.port
    if (Number.isInteger(livePort) && livePort !== null && livePort > 0) view.dshPort = livePort
    const liveError = publicSnapshot.error
    if (typeof liveError === 'string' && liveError !== '') view.error = liveError
    return view
  }

  /** Idempotent local start: a running instance answers with the existing state,
   *  never a duplicate spawn. Shared by the POST route and startLocal pre-spawn. */
  const startLocalConnection = async (label?: string, accentColor?: string) => {
    // A closed writer latch is re-proven before refusing: the usual cause is a
    // managed-host record whose orphan has since exited, invisible to the startup scan.
    if (!localWritersQuiescent) await reproveLocalWriters()
    const gate = localStartGate()
    if (gate?.ok === false) {
      if (!localWritersQuiescent) throw writerBusyError()
      const error = new Error(gate.reason) as Error & { code: string }
      error.code = 'connection_busy'
      throw error
    }
    let row = catalog.getConnection('local')
    if (row === null) {
      row = { connectionId: 'local', kind: 'local' }
      if (typeof label === 'string' && label !== '') row.label = label
      if (typeof accentColor === 'string' && accentColor !== '') row.accentColor = accentColor
      catalog.upsertConnection(row)
    }
    if (local.getState() === 'ready') return { connection: connectionRowView(), spawned: false }
    await local.start()
    return { connection: connectionRowView(), spawned: true }
  }

  /**
   * Explicit takeover: one takeover scan (records that provably belong to this state
   * directory and whose owning control plane is gone), then the ordinary start. A
   * still-live foreign writer surfaces as connection_busy with structured detail.
   */
  const reclaimLocalConnection = async () => {
    const before = new Set(writerScan.writers.filter(entry => entry.status === 'reclaimed').map(entry => entry.name))
    await scanLocalWriters(true)
    const reclaimed = writerScan.writers
      .filter(entry => entry.status === 'reclaimed' && !before.has(entry.name) && entry.pid !== null)
      .map(entry => entry.pid as number)
    const started = await startLocalConnection()
    return { reclaimed, connection: started.connection, spawned: started.spawned }
  }

  const api = createApi({
    logger,
    corsOrigins: explicitOrigins,
    ...(options.corsEvaluator !== undefined ? { corsEvaluator: options.corsEvaluator } : {}),
    getHealth: () => {
      const snapshot = currentPublicLocalSnapshot()
      return { ok: true, dsh: { status: snapshot.status, port: snapshot.port ?? 0, error: snapshot.error ?? undefined } }
    },
    subscribeHealthEvents: (listener) => {
      healthListeners.add(listener)
      return () => { healthListeners.delete(listener) }
    },
    getConnectionRow: connectionRowView,
    startConnection: ({ kind, label, accentColor }) => {
      if (kind !== 'local') {
        const error = new Error(`unknown connection kind: ${String(kind)}`) as Error & { code: string }
        error.code = 'connection_kind_unsupported'
        throw error
      }
      return startLocalConnection(label, accentColor)
    },
    localWriterDiagnosis: () => ({
      quiescent: writerScan.quiescent,
      writers: [...writerScan.writers],
      errors: [...writerScan.errors],
    }),
    reclaimConnection: () => reclaimLocalConnection(),
    updateConnectionProfile: async ({ connectionId, label, accentColor }) => {
      const row = catalog.getConnection(connectionId)
      if (row === null) {
        const error = new Error('connection not found') as Error & { code: string }
        error.code = 'not_found'
        throw error
      }
      if (label !== undefined && (typeof label !== 'string' || label === '')) {
        const error = new Error('label must be a non-empty string') as Error & { code: string }
        error.code = 'connection_invalid_input'
        throw error
      }
      if (accentColor !== undefined && typeof accentColor !== 'string') {
        const error = new Error('accentColor must be a string') as Error & { code: string }
        error.code = 'connection_invalid_input'
        throw error
      }
      const outcome = catalog.updateConnectionFields(connectionId, { label, accentColor })
      if (outcome === null) return null
      return connectionRowView()
    },
    stopConnection: async (connectionId: string) => {
      if (connectionId !== 'local') {
        const error = new Error('connection not found') as Error & { code: string }
        error.code = 'not_found'
        throw error
      }
      if (catalog.getConnection('local') === null) {
        const error = new Error('connection not found') as Error & { code: string }
        error.code = 'not_found'
        throw error
      }
      // A restart in flight rejects the stop with 409 connection_busy.
      if (local.getState() === 'restarting') {
        const error = new Error('connection is restarting; wait for it to settle before stopping') as Error & { code: string }
        error.code = 'connection_busy'
        throw error
      }
      await local.stop()
      // The row stays (03 §2.1: DELETE stops the instance, the row persists).
    },
    hostLogs: (query: { port?: number; limit?: number; offset?: number }) => {
      // An explicit port is an internal/diagnostic read; the 'local' alias is the
      // public surface and must not leak the quarantined candidate's port/ready state
      // before the activation verdict. Fail closed with a loud 503.
      if (query?.port === undefined && !localExposureAllowed()) {
        const error = new Error('local instance is quarantined behind activation probes') as Error & { code: string }
        error.code = 'quarantined'
        throw error
      }
      return hostLogsModule.readManagedLog(query?.port ?? 'local', { limit: query?.limit, offset: query?.offset })
    },
    instanceProxy,
  })

  let server: Server | null = null
  let serverPort: number | null = null
  let startPromise: Promise<void> | null = null
  let stopPromise: Promise<void> | null = null
  let lifecycleEpoch = 0

  // Static frontend service: dist/ + __DSH_BOOT__, assembled in static-serving.ts;
  // anonymous like every other surface, disabled when webDistDir is unset.

  const staticServing = webDistDir === undefined
    ? null
    : createStaticServing({ webDistDir, logger })

  /** Close one candidate/active server without letting long-lived proxy streams strand stop(). */
  async function closeHttpServer(srv: Server, closeProxyStreams: boolean): Promise<void> {
    if (closeProxyStreams) instanceProxy.closeAllStreams()
    if (!srv.listening) return
    await new Promise<void>(resolveClose => {
      const force = setTimeout(resolveClose, 500)
      force.unref?.()
      srv.close(() => {
        clearTimeout(force)
        resolveClose()
      })
      // `close()` synchronously stops accepting new connections; force-close only
      // after that fence (the inverse order is racy in Node).
      srv.closeAllConnections?.()
      srv.closeIdleConnections?.()
    })
  }

  return {
    /** Bind the HTTP surface and prepare the state layout. */

    async start() {
      if (stopPromise !== null) await stopPromise
      if (server !== null) return
      if (startPromise !== null) return startPromise
      // stop() releases the plane-owned lease after the quiescence proof; stop→start
      // must re-prove writer authority before any state write (fail-closed on takeover).
      if (ownsStateLease && !stateLease.held()) stateLease.reacquire()
      // stop() closes the log handle; a stop→start restart must reopen it here or the
      // restarted plane silently forwards without persisting.
      logger.reopen()

      const epoch = ++lifecycleEpoch
      let candidate: Server | null = null
      const pending = (async () => {
        try {
          ensurePrivateDirectoryNoFollow(join(stateDir, 'managed-dsh'), 0o700)
          ensurePrivateDirectoryNoFollow(dshHome, 0o700)
          // DSH_HOME writes stay behind the per-spawn runtime gate. At startup only
          // report unavailable optional packages; the patch thunk seeds after reaper quiescence.
          for (const entry of seedEntries()) {
            const artifact = join(entry.sourceDir ?? '', 'dist', 'index.js')
            if (!existsSync(artifact)) {
              logger.log(`seed '${entry.insert.id}': build artifact ${artifact} not present; seed skipped (${entry.insert.name} not built)`)
            }
          }
          if (webDistDir !== undefined) {
            try {
              if (!statSync(webDistDir).isDirectory()) throw new Error('not a directory')
            } catch (distError) {
              throw new Error(`webDistDir is not a directory: ${String(distError)}`)
            }
          }

          await scanLocalWriters(false)
          if (epoch !== lifecycleEpoch) throw new Error('control plane start cancelled by stop')

          const middlewareCtx: PlaneMiddlewareContext = { api, instanceProxy }
          function dispatchRest(req: ApiRequest, res: ApiResponse, url: URL): void {
            const surface = url.pathname.split('/').filter(Boolean)[0] ?? ''
            if (surface === 'api' || surface === 'health') {
              void api.handle(req, res).catch(error => {
                logger.error(`api handler failure: ${String(error)}`)
                if (!res.headersSent) {
                  res.writeHead(500, { 'content-type': 'application/json' })
                  res.end('{"error":"internal"}')
                } else {
                  res.end()
                }
              })
              return
            }
            if (staticServing !== null) {
              // serve is async (fs/promises + async zlib): a rejection takes the same 500 fallback.
              void staticServing.serve(req, res, url.pathname).catch((staticError: unknown) => {
                logger.error(`static handler failure: ${String(staticError)}`)
                if (!res.headersSent) {
                  res.writeHead(500, { 'content-type': 'application/json' })
                  res.end('{"error":"internal"}')
                } else {
                  res.end()
                }
              })
              return
            }
            res.writeHead(404, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'not_found', code: 'not_found' }))
          }

          candidate = createServer((req, res) => {
            for (const [name, value] of Object.entries(CONTROL_PLANE_SECURITY_HEADERS)) {
              res.setHeader(name, value)
            }
            const cspNonce = randomBytes(18).toString('base64')
            ;(res as ApiResponse)._cspNonce = cspNonce
            res.setHeader(
              'content-security-policy',
              // frame-src blob: — document previews inject HTML/PDF/image content into
              // blob: iframes; without an explicit frame-src, default-src 'self' rejects
              // them (both flavors). Only blob: is opened.
              // style-src 'unsafe-inline' is a runtime precondition for the macOS shell's
              // overscroll policy: the injected <style> has no nonce, so removing it,
              // adding a nonce/hash, or adding style-src-elem all re-break the policy silently.
              `default-src 'self'; base-uri 'none'; object-src 'none'; frame-src blob:; frame-ancestors 'none'; form-action 'none'; script-src 'self' 'unsafe-eval' 'nonce-${cspNonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:`,
            )
            let url: URL
            try {
              const rawTarget = req.url ?? '/'
              if (!rawTarget.startsWith('/') || rawTarget.startsWith('//')
                || rawTarget.includes('\\') || rawTarget.includes('#')) {
                throw new Error('non-origin-form request target')
              }
              url = new URL(rawTarget, 'http://localhost')
            } catch {
              res.writeHead(400, { 'content-type': 'application/json' })
              res.end('{"error":"invalid-url"}')
              return
            }
            if (options.middleware !== undefined) {
              void Promise.resolve(options.middleware(req as ApiRequest, res as ApiResponse, url, middlewareCtx)).then(claimed => {
                if (!claimed) dispatchRest(req as ApiRequest, res as ApiResponse, url)
              }).catch((middlewareError: unknown) => {
                logger.error(`middleware failure: ${String(middlewareError)}`)
                if (!res.headersSent) {
                  res.writeHead(500, { 'content-type': 'application/json' })
                  res.end('{"error":"internal"}')
                } else {
                  res.end()
                }
              })
              return
            }
            dispatchRest(req as ApiRequest, res as ApiResponse, url)
          })
          const listeningServer = candidate
          listeningServer.headersTimeout = 10_000
          listeningServer.requestTimeout = 35_000
          listeningServer.keepAliveTimeout = 5_000
          listeningServer.maxRequestsPerSocket = 1_000
          listeningServer.maxConnections = 192

          function defaultUpgrade(req: ApiRequest, socket: Duplex, head: Buffer): void {
            if (!api.getCorsHeaders(req).allowed) {
              socket.end(
                'HTTP/1.1 403 Forbidden\r\n'
                + 'Content-Type: application/json\r\n'
                + 'Connection: close\r\n'
                + '\r\n'
                + '{"error":"request origin is not allowed","code":"origin_forbidden"}',
              )
              return
            }
            void instanceProxy.handleUpgrade(req as never, socket as never, head).catch((error: unknown) => {
              logger.error(`upgrade handler failure: ${String(error)}`)
              socket.destroy()
            })
          }

          listeningServer.on('upgrade', (req, socket, head) => {
            const rawTarget = req.url ?? '/'
            if (!rawTarget.startsWith('/') || rawTarget.startsWith('//')
              || rawTarget.includes('\\') || rawTarget.includes('#')) {
              socket.end(
                'HTTP/1.1 400 Bad Request\r\n'
                + 'Content-Type: application/json\r\n'
                + 'Connection: close\r\n'
                + '\r\n'
                + '{"error":"invalid-url","code":"bad_request"}',
              )
              return
            }
            if (options.upgradeMiddleware !== undefined) {
              void Promise.resolve(options.upgradeMiddleware(req as ApiRequest, socket as Duplex, head, middlewareCtx)).then(claimed => {
                if (!claimed) defaultUpgrade(req as ApiRequest, socket as Duplex, head)
              }).catch((middlewareError: unknown) => {
                logger.error(`upgrade middleware failure: ${String(middlewareError)}`)
                socket.destroy()
              })
              return
            }
            defaultUpgrade(req as ApiRequest, socket as Duplex, head)
          })

          await new Promise<void>((resolveListen, rejectListen) => {
            const onListenError = (error: Error): void => rejectListen(error)
            listeningServer.once('error', onListenError)
            listeningServer.listen(port, host, () => {
              listeningServer.removeListener('error', onListenError)
              resolveListen()
            })
          })
          if (epoch !== lifecycleEpoch) throw new Error('control plane start cancelled by stop')
          const address = listeningServer.address()
          serverPort = typeof address === 'object' && address !== null ? address.port : null
          server = listeningServer
          candidate = null
          listeningServer.on('error', error => logger.error(`control plane server error: ${String(error)}`))
          logger.log(`control plane listening on http://${host}:${serverPort}`)
        } finally {
          if (candidate !== null) await closeHttpServer(candidate, false)
        }
      })()
      startPromise = pending
      try {
        await pending
      } finally {
        if (startPromise === pending) startPromise = null
      }
    },

    /** Stop every local writer before releasing the HTTP surface. */
    async stop() {
      if (stopPromise !== null) return stopPromise
      lifecycleEpoch += 1
      const pending = (async () => {
        const starting = startPromise
        if (starting !== null) {
          try { await starting } catch { /* failed/cancelled start already settled */ }
        }
        let localStopError: unknown
        try {
          await local.stop()
        } catch (error) {
          localStopError = error
        }
        if (server !== null) {
          const srv = server
          server = null
          serverPort = null
          await closeHttpServer(srv, true)
        }
        if (localStopError !== undefined) throw localStopError
        // Only a proven-quiescent stop releases writer authority; a failed local stop
        // retains the lease so no successor can write behind it.
        if (ownsStateLease) stateLease.release()
      })()
      stopPromise = pending
      try {
        await pending
      } finally {
        // 停止后不再写日志文件（文件保留，供事后检索）。
        logger.close()
        if (stopPromise === pending) stopPromise = null
      }
    },

    /** The bound HTTP port (the OS-assigned value when options.port was 0). */
    get port() {
      return serverPort
    },

    /** The dsh connection state: the design-03 seven-state machine. */
    get connectionState() {
      return local.getState()
    },

    /** Whether the local dsh process is actually alive (see hasLiveProcess). */
    get localProcessAlive() {
      return local.hasLiveProcess()
    },

    get localWritersQuiescent() {
      return localWritersQuiescent
    },

    localWriterDiagnosis: () => ({
      quiescent: writerScan.quiescent,
      writers: [...writerScan.writers],
      errors: [...writerScan.errors],
    }),

    reclaimLocal: reclaimLocalConnection,

    /** The live local dsh port, used only by main-process activation probes. */
    get localDshPort() {
      return local.getDshPort()
    },

    /** The control-plane instance identity; spawn records carry it for multi-instance diagnostics. */
    get instanceId() {
      return instanceId
    },

    /** The managed local dsh host's port (design 17 §2.1). */
    getLocalDshPort() {
      return local.getDshPort()
    },

    /**
     * Register a remote instance transport: the desktop main process reports a ready
     * target as connectionId `dsh:<id>`/`gateway:<id>` plus `opts.transport` — the
     * /api/i/<kind>-<id>/* proxy target. `extraHeaders`/`opts.tls.spkiPin` ride into
     * the proxy's validated gateway record; tunnel URLs never leave the main
     * process / proxy.
     */
    registerInstanceTransport(connectionId: string, baseUrl: string, extraHeaders?: Record<string, string>, opts?: InstanceTransportRegistrationOptions) {
      instanceProxy.registerTransport(connectionId, baseUrl, extraHeaders, opts)
    },

    /** Unregister a remote instance transport (tunnel torn down). */
    unregisterInstanceTransport(connectionId: string) {
      instanceProxy.unregisterTransport(connectionId)
    },

    /** Pre-spawn the local instance (desktop form; idempotent). */
    startLocal: async () => {
      await startLocalConnection()
    },

    /** Stop only the local managed host (the HTTP control plane stays up). */
    stopLocal: async () => {
      await local.stop()
    },

    /** Transactional user-triggered dsh restart (design 18 §9.3). */
    restartLocal: async () => {
      await local.restartLocal()
    },

    refreshLocalExposure() {
      publishPublicLocalSnapshot()
    },

    get seededProbeDomains() {
      return seededProbeDomains
    },

    /** Subscribe to the authoritative local-host lifecycle stream. */
    onLocalStateChange(listener) {
      return local.onStateChange(listener)
    },
  } satisfies PlaneHandle
}

export { resolveNodeExecutable, sanitizeManagedDshEnv, spawnDsh } from './spawn-dsh.ts'
// Unary RPC remains the ordinary control-plane client; the gateway composes the
// same client. The client-response/event-stream helpers belong to the removed
// session-runtime domain and are not part of this export surface.
export { call, probeHostIdentity, RpcBusinessError, RpcTransportError } from './dsh-client.ts'
// The dsh RPC wire envelope single source shared with the desktop probes; the
// unified host-identity probe constants live here too (HOST_IDENTITY_METHOD /
// LEGACY_HOST_PROBE_METHOD / HOST_PROBE_MAX_RESPONSE_BYTES).
export {
  buildClientRequest,
  buildHostIdentityProbePayload,
  buildLegacyHostProbePayload,
  HOST_IDENTITY_METHOD,
  HOST_PROBE_MAX_RESPONSE_BYTES,
  isLegacyHostProbeValue,
  LEGACY_HOST_PROBE_METHOD,
  mintRpcId,
  parseServerResponse,
  postClientRequest,
} from './rpc-envelope.ts'
export type {
  ClientRequestEnvelope,
  RawUnaryOutcome,
  ServerResponseEnvelope,
  ServerResponseParse,
} from './rpc-envelope.ts'
// The cordis loader `insert` row render/parse/conflict single source, shared with
// the desktop remote seed and the local overlay seed.
export {
  fieldCount,
  hasExactInsert,
  insertConflict,
  parseLoaderRows,
  renderCordisInserts,
} from './cordis-inserts.ts'
export type {
  CordisInsert,
  InsertConflictKind,
  ParsedInsertRow,
} from './cordis-inserts.ts'
export type { Logger } from './types.ts'
export {
  assertChamberHostRegistry,
  assertHostSeedEntryNaming,
  assertHostSeedInsertNaming,
  CHAMBER_HOST_PACKAGES,
  HOST_ARCHIVE_CLEANUP_INSERT,
  HOST_GIT_WORKTREE_INSERT,
  HOST_GRAPH_INSERT,
  // The seeded file set + overlay filename, forwarded so every naming of either fact
  // derives from host-graph-seed.ts instead of re-typing a literal.
  HOST_GRAPH_PATCH_FILENAME,
  HOST_OPEN_IN_INSERT,
  HOST_PACKAGE_SEED_FILES,
  HOST_SEED_PACKAGE_PREFIX,
} from './host-graph-seed.ts'
export type { ChamberHostPackageDescriptor, HostPackageInsert, HostPackageSeedFile } from './host-graph-seed.ts'
export type { ApiCorsEvaluator, ApiRequest, ApiResponse } from './api.ts'
// Shared forwarding core: the Host/Origin rewrite + WS splice + limits/errors
// shared by instance-proxy.ts and gateway-proxy.ts without forking.
export {
  CLIENT_BODY_IDLE_TIMEOUT_MS,
  convergeLocation,
  createPendingUpgradeTracker,
  forwardHttp,
  forwardUpgrade,
  getProcessBufferedRequestBytes,
  isHashedStaticAssetPath,
  LONG_RPC_PATHS,
  LONG_RPC_UPSTREAM_TIMEOUT_MS,
  MAX_BUFFERED_REQUEST_BYTES,
  MAX_CONCURRENT_HTTP_REQUESTS,
  MAX_CONCURRENT_WS_STREAMS,
  MAX_HTML_INJECTION_BYTES,
  MAX_PENDING_WS_HANDSHAKES,
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_BODY_BYTES,
  rejectUpgrade,
  RESPONSE_HEADER_WHITELIST,
  UPSTREAM_TIMEOUT_MS,
  writeError,
  WS_PING_INTERVAL_MS,
  WS_PING_MISSES_BEFORE_TEARDOWN,
  WS_STREAM_PATHS,
} from './proxy-forward.ts'
export type {
  HttpRequestFactory,
  ProxyForwardCounters,
  ProxyForwardDeps,
  ProxyRequest,
  ProxyResponse,
  ProxySocket,
} from './proxy-forward.ts'
// SPKI pin helpers live in spki-pin.ts and reach consumers through
// proxy-forward.ts (which re-exports them).
export {
  attachSpkiPinVerifier,
  spkiPinOfPeerCertificate,
  SPKI_PIN_MISMATCH_CODE,
  SPKI_PIN_PATTERN,
} from './spki-pin.ts'
export * from './browser-auth-cookie.ts'
// Node-side primitives shared with the desktop main process and the gateway server.
export * from './error-text.ts'
export { createJsonStore, JsonStorePersistError, JsonStoreRevisionConflictError } from './json-store.ts'
export type { JsonStore, JsonStoreMutator } from './json-store.ts'
export {
  atomicWritePrivateFileNoFollow,
  createPrivateFileExclusiveNoFollow,
  ensurePrivateDirectoryNoFollow,
  readPrivateFileNoFollow,
  removePrivateFileNoFollow,
  syncPrivateDirectoryNoFollow,
} from './private-file.ts'
export type {
  PrivateFileIdentity,
  PrivateFileRead,
  PrivateFileReadOptions,
} from './private-file.ts'
// The shared owner-only audit-trail core: one serializer + append/rotate
// implementation for the gateway audit and the desktop audit log.
export { AUDIT_TRAIL_MAX_BYTES, appendAuditTrailLine, serializeAuditEvent } from './audit-trail.ts'
export type { AuditTrailEvent } from './audit-trail.ts'
// The plugin spec/name whitelist family (the reserved-name DENY predicate lives in
// protected-plugins.ts) — single source for the desktop main and the gateway.
// Renderer mirrors are hand-written and must stay in lockstep.
export {
  extractSpecName,
  MATERIALIZE_FILE_SPEC_PATTERN,
  MAX_PLUGIN_SPEC_CHARS,
  PLUGIN_NAME_PATTERN,
  PLUGIN_SPEC_PATTERN,
  RUN_STDOUT_MAX_BYTES,
  WRITE_FILE_MAX_BYTES,
} from './plugin-spec.ts'
// The restricted plugin-mutation child executor: the single env-scrubbed /
// bounded-output / timeout-killed child protocol shared by the gateway server and
// the desktop main process. INSTALL_ENV_WHITELIST stays dsh-runtime's single source
// and is passed in by each caller — this package deliberately does not depend on it.
export { runPluginMutation, scrubMutationEnv, spawnMutationChild } from './plugin-mutation-executor.ts'
export type {
  MutationChild,
  MutationChildExecutor,
  MutationChildOutcome,
  MutationProcessStream,
  MutationSpawnFn,
  PluginMutationParams,
  PluginMutationResult,
} from './plugin-mutation-executor.ts'
// The protected-plugin set + generation coupling: P = B₀ ∪ S ∪ F derivation, the
// op-phased write-face decision (install/remove judge P alike; remove never judges a
// version; official-scope installs must pin the instance's exact generation) and the
// read-face row projection — single source for the desktop main and the gateway.
export {
  CHAMBER_SCOPE,
  decidePluginMutation,
  derivePluginRows,
  deriveProtectedSet,
  familyNamesFromLockfileClosure,
  familyNamesFromRuntimeTree,
  isExactVersion,
  OFFICIAL_SCOPE,
  officialScope,
  parseExactVersion,
  PLUGIN_MATERIALIZED_VALUE_MASK,
  PROFILE_BUNDLES_SNAPSHOT,
  describeFamilyFindings,
  protectedReason,
  readInstalledVersion,
  registrySpecVersion,
  resolveRuntimeFamily,
  sameGeneration,
  suggestExactSpec,
  verifyProfileFamilyConsistency,
} from './protected-plugins.ts'
export type {
  DecidePluginMutationInput,
  FamilyConsistencyFinding,
  FamilyConsistencyVerdict,
  FamilyVersions,
  DerivePluginRowsInput,
  ParsedVersion,
  PluginMutationDecision,
  PluginMutationOp,
  PluginRefusalCode,
  PluginRow,
  PluginRowRole,
  ProtectedDerivation,
  ProtectedFacts,
  ProtectedSet,
  ProtectedSource,
  RuntimeFamilyResolution,
} from './protected-plugins.ts'
// The plugin-manifest read algorithm + materialize ruler (single source =
// @dsh-chamber/dsh-chamber-wire/plugin-manifest), re-exported because the packaged
// desktop must consume them from the esbuild-bundled entry (bare wire specifiers are
// not type-strippable), so dev source and packaged bundle resolve the same definitions.
export {
  isMaterializedValue,
  parsePluginManifest,
  readManifestVersion,
} from '@dsh-chamber/dsh-chamber-wire/plugin-manifest'
export type {
  PluginManifestFault,
  PluginManifestModel,
  PluginManifestParseResult,
} from '@dsh-chamber/dsh-chamber-wire/plugin-manifest'
// Gateway wire-protocol credential/session facts + SPKI pin helpers — single source
// for the gateway server, the proxy injection gate and the desktop client;
// spki-pin.ts exports ride the proxy-forward `export *` above.
export {
  GATEWAY_PASSWORD_MAX_CHARS,
  GATEWAY_PASSWORD_MIN_CHARS,
  GATEWAY_SESSION_COOKIE_NAME,
  GATEWAY_SESSION_COOKIE_VALUE_MAX_CHARS,
  GATEWAY_SESSION_TTL_SECONDS,
  GATEWAY_TOKEN_MAX_CHARS,
  GATEWAY_TOKEN_MIN_CHARS,
  GATEWAY_TOKEN_VISIBLE_ASCII_PATTERN,
} from './gateway-session-protocol.ts'

// Session-state wire contract — single source for the gateway watcher and the
// desktop probe; the Typert mux client is the client half of the same contract.
export {
  clampReadThrough,
  classifyTurnEnd,
  mergeReadMark,
  SESSION_STATE_CLIENT_ID_PATTERN,
  SESSION_STATE_FEATURES,
  SESSION_STATE_HANDSHAKE_WINDOW_MS,
  SESSION_STATE_PATH,
  SESSION_STATE_PROTOCOL_VERSION,
  SESSION_STATE_READ_ALL_PATH,
  SESSION_STATE_READ_BODY_MAX_BYTES,
  SESSION_STATE_READ_PATH,
  SESSION_STATE_SESSION_ID_MAX_CHARS,
  SESSION_STATE_STREAM_PATH,
} from './session-state-protocol.ts'
export type {
  ReadAllRequest,
  ReadRequest,
  SessionStateCapability,
  SessionStateCapabilityKind,
  SessionStateCompletedAtSource,
  SessionStateDegradationCode,
  SessionStateDelta,
  SessionStateDescriptor,
  SessionStateDiagnostics,
  SessionStateFeature,
  SessionStateHostInfo,
  SessionStateHostState,
  SessionStateMode,
  SessionStatePendingKind,
  SessionStateProbeFailureReason,
  SessionStateProbeOutcome,
  SessionStateReadState,
  SessionStateRow,
  SessionStateSnapshot,
  SessionTurnEnd,
  SessionTurnEndCause,
  SessionTurnEndDisposition,
  SessionTurnEndKind,
} from './session-state-protocol.ts'
export {
  createSessionMux,
  DEFAULT_BASELINE_TIMEOUT_MS,
  DEFAULT_FOLLOW_TIMEOUT_MS,
  DEFAULT_MUX_RECONNECT_MAX_MS,
  DEFAULT_MUX_RECONNECT_MIN_MS,
  DEFAULT_WATERFALL_GRACE_MS,
  parseSessionListBaselineItems,
  SESSION_LIST_MAX_RESPONSE_BYTES,
  SESSION_LIST_PAYLOAD,
} from './session-mux.ts'
export type {
  MuxKickReason,
  MuxSocket,
  MuxUnaryCall,
  SessionListBaselineItem,
  SessionMux,
  SessionMuxStatus,
} from './session-mux.ts'

// state-root writer lease: createControlPlane is the production importer; the
// gateway/desktop shapes consume the same contract through this package entry.
export {
  acquireStateRootLease,
  assertDedicatedStateRoot,
  DEFAULT_STATE_DIR,
  LEGACY_STATE_ROOT_LOCK_PATHS,
  resolveStateRoot,
  retireLegacyStateLocks,
  STATE_ROOT_LEASE_FILENAME,
  StateRootLeaseError,
} from './state-root-lease.ts'
export type {
  ResolveStateRootOptions,
  StateRootLease,
  StateRootLeaseFlavor,
  StateRootLeaseOptions,
  StateRootLeaseScope,
} from './state-root-lease.ts'
