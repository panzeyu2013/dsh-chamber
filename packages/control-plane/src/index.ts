/**
 * @dsh-chamber/control-plane — the control-plane package root.
 *
 * createControlPlane assembles the v4 connection-manager core: the catalog
 * (single local connection row), the managed local dsh host (web profile
 * spawn + readiness + health + reaper), the management REST surface, the
 * per-instance reverse proxy, and the optional static frontend service. The
 * server and the connection are owned together: start() binds HTTP and
 * stops() tears down the connection before the server.
 *
 * Options:
 * - stateDir: control-plane state root; defaults to $DSH_CHAMBER_STATE or
 *   ~/.dsh-chamber. Holds catalog.json and managed-dsh/ (pid records).
 * - dshWorkspacePath: working directory of the spawned dsh host (cwd of the
 *   spawned `dsh` process); defaults to $DSH_CHAMBER_DSH_PATH or
 *   <repo>/ref-dsh (falling back to the desktop vendor bundle when absent).
 * - port/host: the control plane's own HTTP bind (standalone default
 *   DEFAULT_CONTROL_PLANE_PORT).
 * - webDistDir: optional static frontend dist directory (design 05 §3.3).
 *   When set, the plane serves / (index.html with the __DSH_BOOT__ manifest
 *   injected from <dist>/manifest.json) and the dist assets (index.html,
 *   /assets/*, /manifest.json, SPA fallback); when unset (standalone dev)
 *   those paths answer 404 and the plane runs API-only.
 * - logger: {log, warn, error} sink; defaults to console.
 * - corsOrigins: explicit cross-origin allowlist for the CORS decision.
 */

import { createServer, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createCatalog } from './catalog.ts'
import { createLocalConnection } from './local-connection.ts'
import type { LocalConnectionDeps } from './local-connection.ts'
import { createApi } from './api.ts'
import { runReaper } from './reaper.ts'
import {
  createInstanceProxy,
  type InstanceProxy,
  type InstanceTransportRegistrationOptions,
} from './instance-proxy.ts'
import { ensureInstanceId } from './instance-id.ts'
import {
  createPrivateFileExclusiveNoFollow,
  ensurePrivateDirectoryNoFollow,
} from './private-file.ts'
import { hostLogs } from './host-logs.ts'
import { createStaticServing } from './static-serving.ts'
import {
  buildPatchOverlay,
  ensureSeedPackage,
  missingHostPackageInserts,
  HOST_GIT_WORKTREE_INSERT,
  HOST_GRAPH_INSERT,
  type SeedEntry,
} from './host-graph-seed.ts'
import type { Logger } from './types.ts'
import type { ApiCorsEvaluator, ApiRequest, ApiResponse, ApiSurface } from './api.ts'

/** Browser hardening shared by static, API, proxy, and error responses.
 *
 * `referrer-policy` is `same-origin`, deliberately NOT `no-referrer` (live
 * finding 2026-09, reproduced on Chrome 151): per the fetch spec "append a
 * request Origin header" algorithm (2019; Chromium and WebKit
 * r259036/2020 — Safari — compliant), a document with no-referrer policy
 * serializes the Origin of same-origin HTML form submissions as `null`,
 * which the chamber origin fences (loopback API + gateway request policy)
 * reject fail-closed — a self-inflicted 403 on any same-origin form
 * (gateway login, /chamber/runtime actions). `same-origin` preserves the
 * privacy intent (referers never leave the origin; these surfaces have no
 * cross-site outbound document requests) without nulling the Origin of form
 * POSTs. JSON/fetch traffic is unaffected by the policy either way. */
export const CONTROL_PLANE_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'cross-origin-opener-policy': 'same-origin',
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
})

/** Default control-plane state root when DSH_CHAMBER_STATE is unset. */
export const DEFAULT_STATE_DIR = join(homedir(), '.dsh-chamber')

/**
 * Baseline default for the control plane's own HTTP bind: the port desktop
 * (main.ts), CLI (serve), and frontend URLs (renderer/settings connections)
 * all derive from as their default origin. Distant from
 * DEFAULT_DSH_START_PORT (17510) so the two surfaces never collide.
 */
export const DEFAULT_CONTROL_PLANE_PORT = 17500

/** This package's repo root (<repo>/packages/control-plane/src → <repo>). */
const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))

/**
 * Default module-A host package source dir (design 09 方案 A, module B): the
 * chamber host package whose dist/index.js + package.json the plane seeds
 * into the local profile so the spawned host exposes the boot graph. Dev and
 * CI layouts ship it at <repo>/packages/dsh-host-client-graph; packaged
 * runtimes pass the bundled location through ControlPlaneOptions (an absent
 * source is skipped, never an error).
 */
export const DEFAULT_HOST_GRAPH_PACKAGE_SOURCE_DIR = join(REPO_ROOT, 'packages', 'dsh-host-client-graph')

/** Default source for the chamber in-host Git worktree service package. */
export const DEFAULT_HOST_GIT_WORKTREE_PACKAGE_SOURCE_DIR = join(REPO_ROOT, 'packages', 'dsh-chamber-host-git-worktree')

/**
 * Default dsh workspace: <repo root>/ref-dsh when present, otherwise the
 * desktop vendor bundle <repo root>/packages/desktop/vendor/dsh (this package
 * lives at <root>/packages/control-plane). When neither exists, still returns
 * the ref-dsh path — the caller decides how to surface the absence
 * (main.ts passes null explicitly in that case).
 */
export function defaultDshWorkspacePath() {
  const refDsh = join(REPO_ROOT, 'ref-dsh')
  if (existsSync(refDsh)) return refDsh
  const vendorDsh = join(REPO_ROOT, 'packages', 'desktop', 'vendor', 'dsh')
  if (existsSync(vendorDsh)) return vendorDsh
  return refDsh
}

/**
 * Seed first-run defaults into the managed dsh home ($DSH_HOME of the
 * spawned local host, design 02 §3.1). The dsh web UI derives its locale
 * from the settings document (`locale.preference`, dsh-settings-file) and
 * otherwise falls back to the browser/OS language — seed `zh` so the local
 * instance defaults to Chinese regardless of the system language. Absent
 * file only: an existing document (the user's own edit or an explicit
 * choice) is never touched.
 */
export function seedDshHomeDefaults(dshHome: string): boolean {
  const documentPath = join(dshHome, 'settings.yaml')
  ensurePrivateDirectoryNoFollow(dshHome, 0o700)
  try {
    createPrivateFileExclusiveNoFollow(documentPath, 'locale:\n  preference: zh\n', { mode: 0o600 })
    return true
  } catch (error) {
    // O_EXCL refuses every existing leaf, including a symlink, without
    // opening or modifying it. The dsh settings service owns existing
    // documents, so seeding must not impose a new content/size/type policy.
    if ((error as { code?: unknown } | null)?.code === 'EEXIST') return false
    throw error
  }
}

/**
 * createControlPlane options (all optional; see the module docblock).
 * `corsOrigins` is the explicit cross-origin allowlist; `webDistDir`
 * enables the static frontend service (design 05 §3.3).
 */
export interface ControlPlaneOptions {
  port?: number
  host?: string
  stateDir?: string
  dshWorkspacePath?: string
  /** Resolve the workspace for each local spawn/restart (runtime switching). */
  getDshWorkspacePath?: () => string
  /**
   * Optional dynamic lifecycle gate. It is checked at management entry and
   * again before every start/restart seed and process spawn.
   */
  canStartLocal?: () => { ok: true } | { ok: false; reason: string }
  /** Dynamic public exposure gate. The desktop keeps this closed from spawn
   * through the full activation-probe verdict. */
  canExposeLocal?: () => boolean
  /** First port attempted for the managed dsh host (design 17 §3 server
   *  deployments; absent = BASE_DHSPORT 17510). */
  dshPortBase?: number
  webDistDir?: string
  logger?: Logger
  corsOrigins?: string[]
  /** Explicit request boundary for an authenticated external composer. Its
   * presence is also the opt-in that permits a non-loopback bind; the normal
   * anonymous control plane never supplies it and remains loopback-only. */
  corsEvaluator?: ApiCorsEvaluator
  /** Injectable local-connection wire deps (test seams: fake spawn/describe). */
  localConnectionDeps?: LocalConnectionDeps
  /** Injectable orphan reaper (test seam for lifecycle interleavings). */
  reaper?: typeof runReaper
  /**
   * Module-A host package source dir (design 09 方案 A, module B): the package
   * seeded into the local profile so the spawned host resolves the
   * client-graph row. Defaults to <repo>/packages/dsh-host-client-graph;
   * packaged runtimes pass the bundled location. An absent source — or a
   * source without its built dist/index.js artifact (module A not built in
   * this runtime) — is skipped (nothing to seed), never an error.
   */
  hostGraphPackageSourceDir?: string
  /**
   * Chamber in-host Git worktree package source. It follows the same built-
   * artifact gate and profile seed lifecycle as hostGraphPackageSourceDir.
   */
  hostGitWorktreePackageSourceDir?: string
  /**
   * Seed registry (2026-12 interface): additional chamber seed entries beyond
   * the two host packages — the seam for browser-side chamber client plugins
   * in hosted frontends (e.g. the gateway mobile slot). Every entry rides the
   * same built-artifact gate, profile seed lifecycle and `--patch` overlay as
   * the host packages; kind 'client' entries carry no probe coupling. A null/
   * absent sourceDir is a warned stub skip (the mobile package ships on the
   * mobile branch), never an error.
   */
  extraSeedEntries?: readonly SeedEntry[]
  /**
   * Optional request middleware (design 17 §2.1 改动③): runs after the
   * security headers + CSP + URL parse and BEFORE the default dispatch. A
   * truthy return CLAIMS the request (the default dispatch is skipped); a
   * falsy return falls through. The gateway uses it to inject its auth gate
   * and route `/auth/*`, `/chamber/*`, `/plugins/*`, `/` and non-management
   * `/api/*` to its own handlers while letting the management surface fall
   * through to the default dispatch.
   */
  middleware?: (
    req: ApiRequest,
    res: ApiResponse,
    url: URL,
    ctx: PlaneMiddlewareContext,
  ) => boolean | void | Promise<boolean | void>
  /**
   * Optional upgrade middleware: runs BEFORE the default origin fence +
   * instance-proxy upgrade dispatch. A truthy return CLAIMS the upgrade.
   */
  upgradeMiddleware?: (
    req: ApiRequest,
    socket: Duplex,
    head: Buffer,
    ctx: PlaneMiddlewareContext,
  ) => boolean | void | Promise<boolean | void>
}

/** The internal surfaces handed to a composing gateway's middleware (design 17
 * §2.1 改动③): the management REST handle + CORS decision + per-instance proxy. */
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
  /**
   * Whether a real dsh process is currently alive under the local connection
   * (state-string independent — see local-connection hasLiveProcess).
   */
  readonly localProcessAlive: boolean
  /** True only when startup reaping proved there are no kept/failed managed
   * host records that could still be writing the shared DSH_HOME. */
  readonly localWritersQuiescent: boolean
  /** Live port of the managed local host; null while it is not serving. */
  readonly localDshPort: number | null
  readonly instanceId: string
  /** The managed local dsh host's port, or null when not ready (design 17
   * §2.1 改动①: exposed for the gateway-proxy's single-target resolution). */
  getLocalDshPort(): number | null
  /** The target kind lives in connectionId; `opts.transport` carries the
   * independent SSH/HTTP dimension. TLS pin and Host authority remain
   * gateway-only bounded capabilities. */
  registerInstanceTransport(connectionId: string, baseUrl: string, extraHeaders?: Record<string, string>, opts?: InstanceTransportRegistrationOptions): void
  unregisterInstanceTransport(connectionId: string): void
  /**
   * Pre-start the local instance (desktop pre-spawn, 05 §7.5): idempotent —
   * a running/starting instance resolves immediately; the renderer's own
   * POST /api/connections rides the same path afterwards. The desktop main
   * calls this before the window loads so the first screen finds the
   * instance already ready.
   */
  startLocal(): Promise<void>
  /** Stop the managed local host without tearing down the control plane.
   * Resolves only after queued/in-flight start and restart writers settle. */
  stopLocal(): Promise<void>
  /**
   * Transactional user-triggered dsh restart (design 18 §9.3): refresh
   * mounted plugins without a stopLocal()+startLocal() pairing. Shares the
   * health state machine's restart single-flight; rejects (connection_busy)
   * when the runtime gate (canStartLocal — applying/restore) is closed, when
   * a stop is in progress, or from restart-exhausted.
   */
  restartLocal(): Promise<void>
  /** Re-publish the public local lifecycle after canExposeLocal changes. */
  refreshLocalExposure(): void
  /** Subscribe to authoritative local-host lifecycle transitions. Gateway
   * consumers use this to attach only while the managed dsh is ready; the
   * desktop also uses it for delayed rollback policy. */
  onLocalStateChange(listener: (snapshot: { status: string; port: number | null; error: string | null }) => void): () => void
}

/**
 * Create the control plane.
 * @param options - {port?, host?, stateDir?, dshWorkspacePath?, webDistDir?,
 *   logger?, corsOrigins?}.
 * @returns {start(), stop(), port, connectionState, instanceId,
 *   registerInstanceTransport, unregisterInstanceTransport}.
 */
export function createControlPlane(options: ControlPlaneOptions = {}): PlaneHandle {
  const port = options.port ?? DEFAULT_CONTROL_PLANE_PORT
  const host = options.host ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== '::1'
    && (options.corsEvaluator === undefined || options.middleware === undefined || options.upgradeMiddleware === undefined)) {
    // loopback-only is a v1 invariant, not merely a default: a non-loopback
    // bind would expose the anonymous management API + reverse proxy to the
    // network, and the Host/Origin fence (api.ts corsFor) is browser-only.
    throw new Error(`control plane refuses non-loopback bind ${JSON.stringify(host)} without an external request-boundary evaluator plus HTTP/upgrade middleware; loopback-only is the anonymous v1 invariant`)
  }
  const stateDir = options.stateDir ?? process.env.DSH_CHAMBER_STATE ?? DEFAULT_STATE_DIR
  const defaultWorkspacePath = options.dshWorkspacePath ?? process.env.DSH_CHAMBER_DSH_PATH ?? defaultDshWorkspacePath()
  const getDshWorkspacePath = options.getDshWorkspacePath ?? (() => defaultWorkspacePath)
  const webDistDir = options.webDistDir === undefined ? undefined : options.webDistDir
  // The console default satisfies every module's logger option ({log,warn,error}).
  const logger = (options.logger ?? console) as Logger
  const reapManagedHosts = options.reaper ?? runReaper
  let localWritersQuiescent = false

  /**
   * Combine the external runtime-apply gate with the internal process-writer
   * safety latch. The latch begins closed until startup reaping succeeds and
   * closes permanently for this plane lifecycle if any termination cannot
   * prove the detached process group is gone.
   */
  function localStartGate(): { ok: true } | { ok: false; reason: string } {
    if (!localWritersQuiescent) {
      return {
        ok: false,
        reason: 'local DSH_HOME writer quiescence is not proven; restart and reaper recovery are required',
      }
    }
    return options.canStartLocal?.() ?? { ok: true }
  }

  function localExposureAllowed(): boolean {
    return localWritersQuiescent && (options.canExposeLocal?.() ?? true)
  }

  // Module-A host package source (design 09 module B); may be absent — the seed
  // skips it gracefully and the plane keeps working without the host graph.
  const hostGraphPackageSourceDir = options.hostGraphPackageSourceDir ?? DEFAULT_HOST_GRAPH_PACKAGE_SOURCE_DIR
  const hostGitWorktreePackageSourceDir = options.hostGitWorktreePackageSourceDir
    ?? DEFAULT_HOST_GIT_WORKTREE_PACKAGE_SOURCE_DIR
  // Seed registry (2026-12): the two legacy host packages plus any extra
  // entries (client-plugin slots like the gateway mobile stub). An extra
  // entry that re-declares a base package's id WINS over the base entry
  // (last-writer-wins by loader id): the gateway passes the two host packages
  // as desktop-synced extra entries, so once its seed cache is populated the
  // synced copies replace the packaged defaults — the base rows exist only to
  // preserve the legacy desktop shape (no extraSeedEntries → no shadowing).
  const seedEntries = (): SeedEntry[] => {
    const byId = new Map<string, SeedEntry>()
    for (const entry of [
      {
        insert: HOST_GRAPH_INSERT,
        kind: 'host' as const,
        source: 'packaged' as const,
        sourceDir: hostGraphPackageSourceDir,
        probeDomains: ['clientGraph/graph'],
      },
      {
        insert: HOST_GIT_WORKTREE_INSERT,
        kind: 'host' as const,
        source: 'packaged' as const,
        sourceDir: hostGitWorktreePackageSourceDir,
        probeDomains: ['gitWorktree/previewCreate'],
      },
      ...(options.extraSeedEntries ?? []),
    ]) {
      byId.set(entry.insert.id, entry)
    }
    return [...byId.values()]
  }
  // The seed gate is the BUILT artifact (dist/index.js), not the package
  // directory: the dir exists in any checkout of this repo, while the esbuild
  // output is the shipped artifact — committed via the .gitignore negation
  // (design 09 §3.5), so a fresh clone HAS it and absence here means the entry
  // is not built/bundled in this runtime (packaged desktop without the bundle).
  // MISSING is skipped gracefully (v4 base command line, no overlay); a
  // PRESENT-but-damaged artifact is NOT skipped — it is seeded and the host
  // boot fails loud if the overlay row cannot resolve (shipped-but-broken
  // entries are a packaging bug: fail-loud on purpose; ensureSeedPackage
  // throws on a missing declared file rather than silently skipping).

  // Establish the durable plane identity before any other persisted module
  // can write. The helper creates a new state root as 0700, but preserves the
  // mode of an existing caller-selected root.
  const instanceId = ensureInstanceId(stateDir)
  const dshHome = join(stateDir, 'dsh-home')
  const catalog = createCatalog({ stateDir, logger })
  catalog.load()

  // Explicit-origin allowlist: the API's CORS decision reads it; v1 keeps
  // no other cross-origin control (loopback-only origins plus this list).
  const explicitOrigins = Array.isArray(options.corsOrigins) ? options.corsOrigins : []

  // Health-events SSE subscribers (GET /api/host/health-events, design 05
  // §3): the stream also snapshots on subscribe, so no transition is missed.
  const healthListeners = new Set<(snapshot: { status: string; port: number | null; error: string | null }) => void>()

  /**
   * Idempotent host-graph seed, resolved at every spawn (design 09 module B).
   * The local connection resolves this thunk at spawn time — initial spawns
   * and restarts alike — so a seed that a profile-internal pnpm operation
   * pruned is re-seeded right before the next spawn. The seeded package is
   * extraneous to the web profile's dependency graph (it is not declared in
   * profiles/web/package.json), and `dsh plugin add/remove` (chamber M4's
   * runLocalDshPlugin included) re-links profile node_modules, which prunes
   * such packages: without the per-spawn re-seed the next instance restart
   * would boot with a --patch row that cannot resolve and fail loudly, the
   * only self-heal being a desktop-app restart. This thunk is idempotent
   * (content-hash skip in ensureHostGraphPackage, content-compare in
   * buildPatchOverlay). Returns the --patch overlay path, or null when
   * module A's built artifact is absent (v4 baseline command line, nothing
   * to mount). Failure semantics: a seed throw on the initial-spawn path
   * lands the instance in error state (the next local start retries); on the
   * restart path it rides the connection's existing bounded backoff loop and
   * ends in restart-exhausted — the same fail-loud surface as any spawn
   * failure (a broken shipped module A is a packaging bug, never silent).
   */
  function resolveHostGraphPatch(): string | null {
    // An extra entry with no packaged source is warned, never fatal — but the
    // wording distinguishes a true stub (packaged entry whose package has not
    // shipped yet, e.g. the gateway mobile slot) from a desktop-synced entry
    // merely awaiting its first sync (an expected pre-sync state, logged once
    // per spawn as informational). The two legacy dirs keep their documented
    // silent-skip behavior.
    for (const entry of options.extraSeedEntries ?? []) {
      if (entry.sourceDir === null || !existsSync(entry.sourceDir)) {
        const message = `seed entry '${entry.insert.id}' (${entry.insert.name}): source absent; skipped`
        if (entry.source === 'desktop-synced') logger.log(`${message} (awaiting the first desktop sync)`)
        else logger.warn(`${message} (stub: package not shipped in this runtime)`)
      }
    }
    const available = seedEntries()
      .filter(entry => entry.sourceDir !== null && existsSync(join(entry.sourceDir, 'dist', 'index.js')))
      .map(entry => ({
        label: entry.insert.id,
        sourceDir: entry.sourceDir as string,
        seedFiles: entry.seedFiles,
        insert: entry.insert,
        packageName: entry.insert.name,
      }))

    if (available.length === 0) return null
    // Preflight every declared package before writing any of them. A damaged
    // second artifact must not leave the first package partially refreshed.
    for (const entry of available) {
      const manifest = join(entry.sourceDir, 'package.json')
      if (!existsSync(manifest)) {
        throw new Error(`${entry.label}: built seed package is missing ${manifest}`)
      }
    }
    // Loader identities are global across the profile patch and this
    // external overlay. Reuse an exact user-owned row, but fail before any
    // package write when an id/name is duplicated or bound differently.
    const profilePatchPath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
    const overlayInserts = missingHostPackageInserts(
      existsSync(profilePatchPath) ? readFileSync(profilePatchPath, 'utf8') : null,
      available.map(entry => entry.insert),
    )
    for (const entry of available) {
      if (ensureSeedPackage(dshHome, entry.packageName, entry.sourceDir, entry.seedFiles)) {
        logger.log(`${entry.label}: seeded ${entry.packageName} into the local web profile`)
      }
    }
    return overlayInserts.length === 0 ? null : buildPatchOverlay(stateDir, overlayInserts)
  }

  // The managed local connection adapter (design 02): spawn/health/reaper
  // owner; readiness = TCP + session/list probe inside spawn-dsh (0.1.2
  // wire; host.describe was deleted upstream). Runtime state is process-local
  // and is merged with durable catalog metadata only at the management/wire
  // projection below (design 03 §2.1).
  const local = createLocalConnection({
    stateDir, dshHome, dshWorkspacePath: getDshWorkspacePath, logger,
    // patchPath is a thunk resolved only behind the per-spawn fence. Re-read
    // it for starts and restarts so a profile-internal prune self-heals
    // without allowing a DSH_HOME write during runtime apply/restore.
    options: {
      ...(options.dshPortBase === undefined ? {} : { dshPortBase: options.dshPortBase }),
      ownerInstanceId: instanceId,
      canSpawn: localStartGate,
      onWriterQuiescenceUnknown: (writerError) => {
        localWritersQuiescent = false
        logger.error(`local writer quiescence became unknown; further starts are blocked until restart/reaper: ${writerError.message}`)
      },
      patchPath: () => {
        // This thunk is reached only after local-connection's spawn fence.
        // Keeping every DSH_HOME seed here prevents runtime snapshot/restore
        // from racing a start that passed an earlier API-entry check.
        if (seedDshHomeDefaults(dshHome)) {
          logger.log('dsh-home: seeded default settings.yaml (locale: zh)')
        }
        return resolveHostGraphPatch()
      },
    },
    deps: options.localConnectionDeps,
  })
  // Candidate lifecycle is an internal fact until the desktop's full probe
  // verdict opens exposure. A candidate can move from ready to degraded,
  // restarting, or error while the full probe is still running; none of those
  // states (nor its port/error detail) may escape through public REST/SSE.
  const publicLocalSnapshot = (snapshot: { status: string; port: number | null; error: string | null }) => {
    if (!localExposureAllowed()) {
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
  // Health-events push fan-out (05 §3): the connection's lifecycle
  // subscription reaches every SSE client through the same quarantine view.
  local.onStateChange((snapshot) => {
    const projected = publicLocalSnapshot(snapshot)
    for (const listener of healthListeners) listener(projected)
  })

  // Managed-host rolling logs (design 02 §3.8): the read side of the
  // per-port JSONL files written by spawn-dsh.ts / local-connection.ts.
  // While the desktop activation verdict is pending, the 'local' alias
  // resolves to the most recent spawn record — the quarantined candidate —
  // and its rolling log contains the candidate port and a "ready" line.
  // That is an internal fact like every other public surface, so the alias
  // read is gated by the same exposure latch (an explicit port query is an
  // internal/diagnostic read and stays available).
  const hostLogsModule = hostLogs({ stateDir, logger })

  // Per-instance reverse proxy (design 03 §3): /api/i/<id>/* HTTP/WS/SSE
  // passthrough, reachable without any session (v1); ssh transports are
  // registered by the desktop main process through the handle (design 05
  // §3.3).
  const instanceProxy = createInstanceProxy({
    logger,
    getLocalState: () => local.getState(),
    getLocalDshPort: () => local.getDshPort(),
    canExposeLocal: localExposureAllowed,
  })

  /** The connection-row projection on the wire (04 §3.2): status/dshPort/error
   * are LIVE machine projections — liveness never rides persisted history (a
   * stale persisted "ready" from a previous run must not masquerade as a
   * running instance); label/accentColor are the persisted user-editable
   * fields. */
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

  /** Idempotent local start (04 §3.2): a running instance answers with the
   * existing state — never a duplicate spawn. Shared by the POST route and
   * the handle's startLocal pre-spawn. */
  const startLocalConnection = async (label?: string, accentColor?: string) => {
    const gate = localStartGate()
    if (gate?.ok === false) {
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
      // 04 §3.2: a restart in flight rejects the stop with 409 connection_busy
      // (the restart sequence owns the child until it settles).
      if (local.getState() === 'restarting') {
        const error = new Error('connection is restarting; wait for it to settle before stopping') as Error & { code: string }
        error.code = 'connection_busy'
        throw error
      }
      await local.stop()
      // The row stays (03 §2.1: DELETE stops the instance, the row persists).
    },
    hostLogs: (query: { port?: number; limit?: number; offset?: number }) => {
      // An explicit port is an internal/diagnostic read; the 'local' alias is
      // the public surface and must not leak the quarantined candidate's
      // port/ready state before the activation verdict (same latch as the
      // proxy and health surfaces). Fail closed with a loud 503 rather than a
      // silent empty log.
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

  // ---------------------------------------------------------------------------
  // Static frontend service (design 05 §3.3 / 04 §5): dist/ + __DSH_BOOT__,
  // assembled in static-serving.ts. Anonymous like every other surface (v1
  // has no authentication). Disabled when webDistDir is not configured.
  // ---------------------------------------------------------------------------

  const staticServing = webDistDir === undefined
    ? null
    : createStaticServing({ webDistDir, logger })

  /** Close one candidate/active server without letting long-lived proxy
   * streams strand stop(). Candidate failures do not own proxy streams. */
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
      // `close()` synchronously stops accepting new connections. Force-close
      // only after that fence; Node documents the inverse order as racy because
      // a new connection can arrive between closeAllConnections() and close().
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

      const epoch = ++lifecycleEpoch
      let candidate: Server | null = null
      const pending = (async () => {
        try {
          ensurePrivateDirectoryNoFollow(join(stateDir, 'managed-dsh'), 0o700)
          ensurePrivateDirectoryNoFollow(dshHome, 0o700)
          // DSH_HOME writes stay behind the per-spawn runtime gate. At plane
          // startup only report unavailable optional packages; the spawn-time
          // patch thunk seeds them after the reaper has proved quiescence.
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

          const reaped = await reapManagedHosts({ stateDir, logger })
          localWritersQuiescent = reaped.kept === 0 && reaped.errors.length === 0
          if (reaped.reclaimed > 0) logger.log(`reaper: reclaimed ${reaped.reclaimed} orphaned dsh host(s)`)
          if (reaped.errors.length > 0) {
            for (const reaperError of reaped.errors) logger.error(`reaper: ${String(reaperError)}`)
          }
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
              try {
                staticServing.serve(req, res, url.pathname)
              } catch (staticError) {
                logger.error(`static handler failure: ${String(staticError)}`)
                if (!res.headersSent) {
                  res.writeHead(500, { 'content-type': 'application/json' })
                  res.end('{"error":"internal"}')
                } else {
                  res.end()
                }
              }
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
              `default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self' 'unsafe-eval' 'nonce-${cspNonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:`,
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
      })()
      stopPromise = pending
      try {
        await pending
      } finally {
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

    /** The live local dsh port, used only by main-process activation probes. */
    get localDshPort() {
      return local.getDshPort()
    },

    /**
     * The control-plane instance identity (design 02 §2.5); spawn records
     * carry it for multi-instance diagnostics.
     */
    get instanceId() {
      return instanceId
    },

    /** The managed local dsh host's port (design 17 §2.1 改动①). */
    getLocalDshPort() {
      return local.getDshPort()
    },

    /**
     * Register a remote instance transport (design 05 §3.3 + design 17 §9.3):
     * the desktop main process reports a ready target as connectionId
     * `dsh:<id>` or `gateway:<id>` plus `opts.transport` (legacy
     * `ssh:<id>` spelling remains SSH-only) — the
     * /api/i/<kind>-<id>/* proxy target. `extraHeaders`/`opts.tls.spkiPin`
     * ride through to the instance proxy's validated gateway record. Tunnel
     * URLs never leave the main process / proxy.
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

    /** Subscribe to the authoritative local-host lifecycle stream. */
    onLocalStateChange(listener) {
      return local.onStateChange(listener)
    },
  } satisfies PlaneHandle
}

export { resolveNodeExecutable, sanitizeManagedDshEnv, spawnDsh } from './spawn-dsh.ts'
// Unary RPC remains the ordinary control-plane client. Design 17's separately
// invoked gateway also composes the bounded server-response and event-stream
// helpers; exporting those helpers does not add a desktop session consumer.
export { call, respond, openEventStream, RpcBusinessError, RpcTransportError } from './dsh-client.ts'
export type { ServerRequest } from './dsh-client.ts'
// The dsh RPC wire envelope single source (A2 cross-package protocol
// single-sourcing): envelope construction, server-response parse/validation
// and the raw node:http unary carrier shared with the desktop probes
// (ssh-provider.ts consumes them through desktop/control-plane-module.ts).
export {
  buildClientRequest,
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
// The cordis loader `insert` row render/parse/conflict single source (A2):
// shared with the desktop remote seed (plugin-sync.ts) and the local overlay
// seed above (host-graph-seed.ts).
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
export type { ApiCorsDecision, ApiCorsEvaluator, ApiRequest, ApiResponse, ApiSurface } from './api.ts'
// Shared forwarding core (design 17 §6.2, 方案 A): extracted from
// instance-proxy.ts so `gateway-proxy.ts` reuses the same Host/Origin
// rewrite + WS splice + limits/errors without forking.
export * from './proxy-forward.ts'
export * from './browser-auth-cookie.ts'
export { createJsonStore, JsonStorePersistError, JsonStoreRevisionConflictError } from './json-store.ts'
export type { JsonStore, JsonStoreDocument, JsonStoreMutator, JsonStoreOptions } from './json-store.ts'
export {
  atomicWritePrivateFileNoFollow,
  createPrivateFileExclusiveNoFollow,
  ensurePrivateDirectoryNoFollow,
  readPrivateFileNoFollow,
  removePrivateFileNoFollow,
  syncPrivateDirectoryNoFollow,
} from './private-file.ts'
export type {
  PrivateDirectoryOptions,
  PrivateFileIdentity,
  PrivateFileModeOptions,
  PrivateFileRead,
  PrivateFileReadOptions,
} from './private-file.ts'
// The plugin spec/name whitelist family + reserved-name deny predicate
// (design 21 §6.2/§6.7 — single source for the desktop main via
// control-plane-module.ts and the gateway executor). Renderer mirrors stay
// hand-written and are pinned by the gateway lockstep test
// (plugin-spec-lockstep.test.ts).
export {
  isDeniedPluginName,
  MATERIALIZE_FILE_SPEC_PATTERN,
  MAX_PLUGIN_SPEC_CHARS,
  PLUGIN_NAME_PATTERN,
  PLUGIN_SPEC_PATTERN,
  RUN_STDOUT_MAX_BYTES,
  WRITE_FILE_MAX_BYTES,
} from './plugin-spec.ts'
