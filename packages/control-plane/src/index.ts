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
 * - port/host: the control plane's own HTTP bind (standalone default 17500).
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
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { createCatalog } from './catalog.ts'
import { createLocalConnection } from './local-connection.ts'
import type { LocalConnectionDeps } from './local-connection.ts'
import { createApi } from './api.ts'
import { runReaper } from './reaper.ts'
import { createInstanceProxy, type InstanceProxy } from './instance-proxy.ts'
import { ensureInstanceId } from './instance-id.ts'
import { hostLogs } from './host-logs.ts'
import {
  buildPatchOverlay,
  ensureHostPackage,
  missingHostPackageInserts,
  HOST_GIT_WORKTREE_INSERT,
  HOST_GIT_WORKTREE_PACKAGE_NAME,
  HOST_GRAPH_INSERT,
  HOST_GRAPH_PACKAGE_NAME,
} from './host-graph-seed.ts'
import type { Logger } from './types.ts'
import type { ApiRequest, ApiResponse, ApiSurface } from './api.ts'

/** Browser hardening shared by static, API, proxy, and error responses. */
export const CONTROL_PLANE_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'cross-origin-opener-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
})

/** Default control-plane state root when DSH_CHAMBER_STATE is unset. */
export const DEFAULT_STATE_DIR = join(homedir(), '.dsh-chamber')

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
  if (existsSync(documentPath)) return false
  try {
    writeFileSync(documentPath, 'locale:\n  preference: zh\n', { flag: 'wx', mode: 0o600 })
    return true
  } catch (error) {
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
  webDistDir?: string
  logger?: Logger
  corsOrigins?: string[]
  /** Injectable local-connection wire deps (test seams: fake spawn/describe). */
  localConnectionDeps?: LocalConnectionDeps
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
   * Optional request middleware (design 16 §2.1 改动③): runs after the
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

/** The internal surfaces handed to a composing gateway's middleware (design 16
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
  readonly instanceId: string
  /** The managed local dsh host's port, or null when not ready (design 16
   * §2.1 改动①: exposed for the gateway-proxy's single-target resolution). */
  getLocalDshPort(): number | null
  registerInstanceTransport(connectionId: string, baseUrl: string, extraHeaders?: Record<string, string>): void
  unregisterInstanceTransport(connectionId: string): void
  /**
   * Pre-start the local instance (desktop pre-spawn, 05 §7.5): idempotent —
   * a running/starting instance resolves immediately; the renderer's own
   * POST /api/connections rides the same path afterwards. The desktop main
   * calls this before the window loads so the first screen finds the
   * instance already ready.
   */
  startLocal(): Promise<void>
}

/**
 * Create the control plane.
 * @param options - {port?, host?, stateDir?, dshWorkspacePath?, webDistDir?,
 *   logger?, corsOrigins?}.
 * @returns {start(), stop(), port, connectionState, instanceId,
 *   registerInstanceTransport, unregisterInstanceTransport}.
 */
export function createControlPlane(options: ControlPlaneOptions = {}): PlaneHandle {
  const port = options.port ?? 17500
  const host = options.host ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== '::1') {
    // loopback-only is a v1 invariant, not merely a default: a non-loopback
    // bind would expose the anonymous management API + reverse proxy to the
    // network, and the Host/Origin fence (api.ts corsFor) is browser-only.
    throw new Error(`control plane refuses non-loopback bind ${JSON.stringify(host)}; loopback-only is a v1 invariant`)
  }
  const stateDir = options.stateDir ?? process.env.DSH_CHAMBER_STATE ?? DEFAULT_STATE_DIR
  const dshWorkspacePath = options.dshWorkspacePath ?? process.env.DSH_CHAMBER_DSH_PATH ?? defaultDshWorkspacePath()
  const webDistDir = options.webDistDir === undefined ? undefined : options.webDistDir
  // The console default satisfies every module's logger option ({log,warn,error}).
  const logger = (options.logger ?? console) as Logger

  // Module-A host package source (design 09 module B); may be absent — the seed
  // skips it gracefully and the plane keeps working without the host graph.
  const hostGraphPackageSourceDir = options.hostGraphPackageSourceDir ?? DEFAULT_HOST_GRAPH_PACKAGE_SOURCE_DIR
  const hostGitWorktreePackageSourceDir = options.hostGitWorktreePackageSourceDir
    ?? DEFAULT_HOST_GIT_WORKTREE_PACKAGE_SOURCE_DIR
  // The seed gate is the BUILT artifact (dist/index.js), not the package
  // directory: the dir exists in any checkout of this repo, while the esbuild
  // output is the shipped artifact — committed via the .gitignore negation
  // (design 09 §3.5), so a fresh clone HAS it and absence here means module A
  // is not built/bundled in this runtime (packaged desktop without the bundle).
  // MISSING is skipped gracefully (v4 base command line, no overlay); a
  // PRESENT-but-damaged artifact is NOT skipped — it is seeded and the host
  // boot fails loud if the overlay row cannot resolve (shipped-but-broken
  // module A is a packaging bug: fail-loud on purpose; ensureHostGraphPackage
  // throws on a missing declared file rather than silently skipping).
  const hostGraphArtifact = join(hostGraphPackageSourceDir, 'dist', 'index.js')
  const hostGitWorktreeArtifact = join(hostGitWorktreePackageSourceDir, 'dist', 'index.js')

  // The state root must exist before any persisted module constructs.
  mkdirSync(stateDir, { recursive: true })

  const dshHome = join(stateDir, 'dsh-home')
  const catalog = createCatalog({ stateDir, logger })
  catalog.load()

  // Control-plane instance identity (design 02 §2.5): a UUID persisted at
  // <stateDir>/instance-id on first run; every spawn record carries it.
  const instanceId = ensureInstanceId(stateDir)

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
   * only self-heal being a desktop-app restart (plane start()). Both this
   * thunk and the plane's start() initial run are idempotent (content-hash
   * skip in ensureHostGraphPackage, content-compare in buildPatchOverlay), so
   * they never conflict. Returns the --patch overlay path, or null when
   * module A's built artifact is absent (v4 baseline command line, nothing
   * to mount). Failure semantics: a seed throw on the initial-spawn path
   * lands the instance in error state (next plane start() retries); on the
   * restart path it rides the connection's existing bounded backoff loop and
   * ends in restart-exhausted — the same fail-loud surface as any spawn
   * failure (a broken shipped module A is a packaging bug, never silent).
   */
  function resolveHostGraphPatch(): string | null {
    const available = [
      {
        label: 'host-graph',
        sourceDir: hostGraphPackageSourceDir,
        artifact: hostGraphArtifact,
        insert: HOST_GRAPH_INSERT,
        packageName: HOST_GRAPH_PACKAGE_NAME,
      },
      {
        label: 'git-worktree',
        sourceDir: hostGitWorktreePackageSourceDir,
        artifact: hostGitWorktreeArtifact,
        insert: HOST_GIT_WORKTREE_INSERT,
        packageName: HOST_GIT_WORKTREE_PACKAGE_NAME,
      },
    ].filter(entry => existsSync(entry.artifact))

    if (available.length === 0) return null
    // Preflight every declared package before writing any of them. A damaged
    // second artifact must not leave the first package partially refreshed.
    for (const entry of available) {
      const manifest = join(entry.sourceDir, 'package.json')
      if (!existsSync(manifest)) {
        throw new Error(`${entry.label}: built host package is missing ${manifest}`)
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
      if (ensureHostPackage(dshHome, entry.packageName, entry.sourceDir)) {
        logger.log(`${entry.label}: seeded ${entry.packageName} into the local web profile`)
      }
    }
    return overlayInserts.length === 0 ? null : buildPatchOverlay(stateDir, overlayInserts)
  }

  // The managed local connection adapter (design 02): spawn/health/reaper
  // owner; readiness = TCP + host.describe inside spawn-dsh.
  const local = createLocalConnection({
    stateDir, dshHome, dshWorkspacePath, catalog, logger,
    // patchPath is a thunk: the seed may land after construction (the plane's
    // start()), and resolving it per spawn (restarts included) re-runs the
    // idempotent seed, self-healing a pruned one (see resolveHostGraphPatch).
    options: { patchPath: resolveHostGraphPatch },
    deps: options.localConnectionDeps,
  })
  // Health-events push fan-out (05 §3): the connection's lifecycle
  // subscription reaches every SSE client of GET /api/host/health-events.
  local.onStateChange((snapshot) => {
    for (const listener of healthListeners) listener(snapshot)
  })

  // Managed-host rolling logs (design 02 §3.8): the read side of the
  // per-port JSONL files written by spawn-dsh.ts / local-connection.ts.
  const hostLogsModule = hostLogs({ stateDir, logger })

  // Per-instance reverse proxy (design 03 §3): /api/i/<id>/* HTTP/WS/SSE
  // passthrough, reachable without any session (v1); ssh transports are
  // registered by the desktop main process through the handle (design 05
  // §3.3).
  const instanceProxy = createInstanceProxy({
    logger,
    getLocalState: () => local.getState(),
    getLocalDshPort: () => local.getDshPort(),
  })

  /** The connection-row projection on the wire (04 §3.2): status/dshPort/error
   * are LIVE machine projections — liveness never rides persisted history (a
   * stale persisted "ready" from a previous run must not masquerade as a
   * running instance); label/accentColor are the persisted user-editable
   * fields. */
  function connectionRowView() {
    const row = catalog.getConnection('local')
    if (row === null) return null
    const view: { id: string; label?: string; accentColor?: string; status: string; dshPort?: number; error?: string } = {
      id: row.connectionId,
      status: local.getState(),
    }
    if (typeof row.label === 'string' && row.label !== '') view.label = row.label
    if (typeof row.accentColor === 'string' && row.accentColor !== '') view.accentColor = row.accentColor
    const livePort = local.getDshPort()
    if (Number.isInteger(livePort) && livePort !== null && livePort > 0) view.dshPort = livePort
    const liveError = local.getError()
    if (typeof liveError === 'string' && liveError !== '') view.error = liveError
    return view
  }

  /** Idempotent local start (04 §3.2): a running instance answers with the
   * existing state — never a duplicate spawn. Shared by the POST route and
   * the handle's startLocal pre-spawn. */
  const startLocalConnection = async (label?: string, accentColor?: string) => {
    let row = catalog.getConnection('local')
    if (row === null) {
      row = { connectionId: 'local', kind: 'local', status: 'starting', dshPort: null }
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
    getHealth: () => ({ ok: true, dsh: { status: local.getState(), port: local.getDshPort() ?? 0, error: local.getError() ?? undefined } }),
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
    hostLogs: (query: { port?: number; limit?: number; offset?: number }) => hostLogsModule.readManagedLog(query?.port ?? 'local', { limit: query?.limit, offset: query?.offset }),
    instanceProxy,
  })

  let server: Server | null = null
  let serverPort: number | null = null

  // ---------------------------------------------------------------------------
  // Static frontend service (design 05 §3.3 / 04 §5): dist/ + __DSH_BOOT__.
  // Anonymous like every other surface (v1 has no authentication).
  // Disabled when webDistDir is not configured.
  // ---------------------------------------------------------------------------

  const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8',
  }

  /**
   * Static types gzip'd on the fly (text-like payloads where gzip helps —
   * html/css/js/map/json/svg; woff2 rides along for literal compliance, it is
   * already brotli-compressed so gzip gains nothing but costs ~nothing on a
   * loopback server, and each file is compressed once per relaunch). Binary
   * image formats are excluded (already compressed; gzip would waste CPU).
   */
  const COMPRESSIBLE_TYPES = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map', '.woff2'])

  /**
   * Tiny on-the-fly gzip cache keyed by path+mtime (LCP perf pass): immutable
   * hash-named assets under /assets/ are gzipped once per build — the default
   * Electron session keeps a disk HTTP cache, so the immutable policy below
   * serves those assets from cache across relaunches and the server re-encodes
   * one only when a request actually misses that cache; the path+mtime key
   * makes that a single gzipSync per file per server lifetime. FIFO cap
   * bounds memory (each entry is one compressed asset). index.html is NOT
   * served through this cache: its content is re-injected with __DSH_BOOT__
   * per request (manifest rev can change without index.html's mtime moving),
   * so it is gzipped per request from the in-memory (already-injected) buffer
   * instead.
   */
  const GZIP_CACHE_MAX = 64
  const gzipCache = new Map<string, Buffer>()
  function gzipCached(path: string): Buffer {
    const stat = statSync(path)
    const key = `${path}:${stat.mtimeMs}:${stat.size}`
    const hit = gzipCache.get(key)
    if (hit !== undefined) return hit
    const compressed = gzipSync(readFileSync(path))
    if (gzipCache.size >= GZIP_CACHE_MAX) {
      const oldest = gzipCache.keys().next().value
      if (oldest !== undefined) gzipCache.delete(oldest)
    }
    gzipCache.set(key, compressed)
    return compressed
  }

  /**
   * Whether the request's Accept-Encoding accepts gzip (RFC 9110 q-value
   * aware): a bare `gzip` (or `gzip;q=0.5`) accepts it, `gzip;q=0` explicitly
   * refuses it, and anything else (deflate/br-only, identity, absent) does not
   * accept it.
   */
  function acceptsGzip(req: ApiRequest): boolean {
    const header = req.headers['accept-encoding']
    if (typeof header !== 'string') return false
    for (const part of header.split(',')) {
      const [token, ...params] = part.split(';').map(s => s.trim().toLowerCase())
      if (token !== 'gzip') continue
      let quality = 1
      for (const param of params) {
        const match = /^q=([0-9.]+)$/.exec(param)
        if (match !== null) {
          const parsed = Number(match[1])
          if (Number.isFinite(parsed)) quality = parsed
        }
      }
      return quality > 0
    }
    return false
  }

  /** Resolve a static path inside webDistDir; null on any escape. */
  function resolveStatic(filePath: string): string | null {
    const resolved = resolve(webDistDir as string, `.${filePath}`)
    if (resolved !== resolve(webDistDir as string) && !resolved.startsWith(`${resolve(webDistDir as string)}${sep}`)) return null
    return resolved
  }

  /** Read the __DSH_BOOT__ manifest (<dist>/manifest.json); null when absent. */
  function readBootManifest(): unknown | null {
    if (webDistDir === undefined) return null
    try {
      return JSON.parse(readFileSync(join(webDistDir, 'manifest.json'), 'utf8'))
    } catch {
      return null
    }
  }

  /** Serve a static file (or index.html fallback) on the response. */
  function serveStatic(req: ApiRequest, res: ApiResponse, pathname: string) {
    let candidate = pathname === '/' ? '/index.html' : pathname
    // SPA fallback: unknown paths render index.html (04 §5), except paths
    // that look like real assets (missing assets answer 404 — a frontend
    // build error must not masquerade as the shell).
    const path = resolveStatic(candidate)
    if (path === null) {
      jsonStaticError(res, 404, 'not_found')
      return
    }
    let data: Buffer | null = null
    try {
      data = readFileSync(path)
    } catch {
      const ext = extname(candidate)
      if (ext !== '' && ext !== '.html') {
        jsonStaticError(res, 404, 'not_found')
        return
      }
      const fallback = resolveStatic('/index.html')
      if (fallback === null) {
        jsonStaticError(res, 404, 'not_found')
        return
      }
      try {
        data = readFileSync(fallback)
      } catch {
        jsonStaticError(res, 404, 'not_found')
        return
      }
      candidate = '/index.html'
    }
    const type = MIME_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream'
    if (candidate === '/index.html') {
      // __DSH_BOOT__ injection (04 §5 / 05 §2): the manifest (rendered by
      // the renderer build chain) becomes window.__DSH_BOOT__ inline —
      // parseBootManifest contract, served from <dist>/manifest.json.
      const manifest = readBootManifest()
      if (manifest !== null) {
        const nonce = res._cspNonce
        if (nonce === undefined) throw new Error('missing CSP nonce for static response')
        // JSON is embedded in an HTML script data block: `<` must never form
        // `</script>` (manifest values are build inputs, not trusted HTML).
        // Escape JavaScript's two legacy line separators as well.
        const serializedManifest = JSON.stringify(manifest)
          .replace(/</g, '\\u003c')
          .replace(/\u2028/g, '\\u2028')
          .replace(/\u2029/g, '\\u2029')
        const script = `<script nonce="${nonce}">window.__DSH_BOOT__=${serializedManifest};</script>`
        const text = data.toString('utf8')
        if (text.includes('</head>')) data = Buffer.from(text.replace('</head>', `${script}</head>`))
        else data = Buffer.from(`${text}${script}`)
      }
    }
    const headers: Record<string, string> = { 'content-type': type, ...(res._corsHeaders ?? {}) }
    // Cache policy (LCP perf pass): hash-named build assets under /assets/
    // are immutable — one year, no revalidation, so a relaunch serves them
    // from the Electron HTTP cache instead of re-fetching ~2.75MB. index.html
    // keeps no-cache (the __DSH_BOOT__ manifest moves every build). Other
    // paths (e.g. /manifest.json) keep their previous no-header behavior.
    if (candidate === '/index.html') {
      headers['cache-control'] = 'no-cache'
    } else if (candidate.startsWith('/assets/')) {
      headers['cache-control'] = 'public, max-age=31536000, immutable'
    }
    // On-the-fly gzip for text-like types (only when the client accepts it).
    // Vary is set for every compressible response (gzip or not) so the HTTP
    // cache never serves a negotiated variant to a mismatched client.
    const compressible = COMPRESSIBLE_TYPES.has(extname(candidate).toLowerCase())
    if (compressible) headers['vary'] = 'accept-encoding'
    if (compressible && acceptsGzip(req)) {
      try {
        headers['content-encoding'] = 'gzip'
        data = candidate === '/index.html' ? gzipSync(data) : gzipCached(path)
      } catch (gzipError) {
        // Rare file race (the asset vanished between read and gzip) or a
        // corrupt asset: serve the already-read bytes identity-compressed
        // rather than crash the plane — the frontend still loads, just
        // without gzip. The outer handler catch below is the last-resort
        // 500 for anything else that throws in the static path.
        logger.warn(`static gzip failed for ${candidate}: ${String(gzipError)}`)
        delete headers['content-encoding']
      }
    }
    // Explicit Content-Length: keeps static responses non-chunked and gives
    // HEAD requests a real length (the immutable-cache client relies on it).
    headers['content-length'] = String(data.length)
    res.writeHead(200, headers)
    res.end(data)
  }

  function jsonStaticError(res: ApiResponse, status: number, code: string) {
    const body = JSON.stringify({ error: code, code })
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      ...(res._corsHeaders ?? {}),
    })
    res.end(body)
  }

  return {
    /** Bind the HTTP surface and prepare the state layout. */
    async start() {
      if (server !== null) return
      mkdirSync(join(stateDir, 'managed-dsh'), { recursive: true })
      mkdirSync(join(stateDir, 'dsh-home'), { recursive: true })
      // First-run default locale for the managed local host (zh); the user's
      // explicit settings choice always wins from then on.
      if (seedDshHomeDefaults(dshHome)) {
        logger.log('dsh-home: seeded default settings.yaml (locale: zh)')
      }
      // Host-graph seed (design 09 方案 A, module B): distribute the chamber
      // host package into the local profile (idempotent, content-hash skip)
      // and materialize the --patch overlay that mounts it. The initial run
      // here is for early exposure (logs + fail-loud on a broken module A);
      // the spawn-time thunk re-runs the same idempotent seed before every
      // spawn, restarts included — a seed pruned by a profile-internal pnpm
      // operation self-heals on the next spawn, not only at plane start.
      // dist/index.js is a COMMITTED artifact (design 09 §3.5, .gitignore
      // negation), so a fresh clone has it; the gate only skips when the
      // artifact is genuinely absent (module A not built/bundled in this
      // runtime) or damaged — the overlay is gated on the artifact because a
      // --patch overlay whose inserted row cannot resolve fails the host boot
      // loudly (dsh-app-boot loadOverlayPatches): an absent module A must
      // leave the spawn command line exactly the v4 base. A pre-existing
      // running local instance is unaffected until its next restart — the
      // overlay applies at host boot, the official plugin-set-change cadence.
      resolveHostGraphPatch()
      if (!existsSync(hostGraphArtifact)) {
        logger.log(`host-graph: host package build artifact ${hostGraphArtifact} not present; seed skipped (module A not built)`)
      }
      if (!existsSync(hostGitWorktreeArtifact)) {
        logger.log(`git-worktree: host package build artifact ${hostGitWorktreeArtifact} not present; seed skipped (package not built)`)
      }
      if (webDistDir !== undefined) {
        try {
          if (!statSync(webDistDir).isDirectory()) {
            throw new Error('not a directory')
          }
        } catch (distError) {
          // Fail-loud: a configured-but-missing dist is a packaging bug,
          // never a silent empty shell.
          throw new Error(`webDistDir is not a directory: ${String(distError)}`)
        }
      }
      // Orphan reclamation (design 02 §3.4): a control plane that died and
      // restarted reclaims its detached hosts before any new spawn — safe by
      // construction (triple verification, owner-dead only).
      const reaped = await runReaper({ stateDir, logger })
      if (reaped.reclaimed > 0) logger.log(`reaper: reclaimed ${reaped.reclaimed} orphaned dsh host(s)`)
      // Failure isolation must be visible: entry errors are surfaced, never
      // silently dropped (one bad record never blocks the rest).
      if (Array.isArray(reaped.errors) && reaped.errors.length > 0) {
        for (const reaperError of reaped.errors) logger.error(`reaper: ${String(reaperError)}`)
      }
      // Gateway middleware context (design 16 改动③): the management REST +
      // per-instance proxy surfaces handed to a composing gateway's middleware.
      const middlewareCtx: PlaneMiddlewareContext = { api, instanceProxy }

      /** The default request dispatch (the surface routing the gateway's
       * middleware falls through to): /api + /health → api.handle; static dist
       * → serveStatic; else 404. */
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
        if (webDistDir !== undefined) {
          try {
            serveStatic(req, res, url.pathname)
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

      await new Promise<void>((resolveListen, reject) => {
        server = createServer((req, res) => {
          // Set before dispatch so proxy and every early/error response inherit
          // the same browser boundary. Route-specific writeHead calls retain
          // headers already set on ServerResponse.
          for (const [name, value] of Object.entries(CONTROL_PLANE_SECURITY_HEADERS)) {
            res.setHeader(name, value)
          }
          const cspNonce = randomBytes(18).toString('base64')
          ;(res as ApiResponse)._cspNonce = cspNonce
          // script-src keeps 'unsafe-inline' closed (every inline script must
          // carry the per-response nonce) but MUST open 'unsafe-eval': the
          // official dsh module loader (vendored @deepseek-ai/loader, config
          // utils) evaluates boot-manifest `__jsExpr` config via
          // `new Function('ctx','expr', 'with (ctx) { return eval(expr) }')`
          // at module evaluation time — without 'unsafe-eval' the renderer
          // bundle dies with an EvalError and the skeleton never boots.
          res.setHeader(
            'content-security-policy',
            `default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self' 'unsafe-eval' 'nonce-${cspNonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:`,
          )
          // A malformed request line (e.g. a `//`-leading path — treated as a
          // protocol-relative URL with an empty host, which `new URL` rejects)
          // must never take the whole control plane down: answer 400 and keep
          // serving (proxy honesty — an invalid request is an explicit
          // rejection, never a crash or a silent empty success).
          let url: URL
          try {
            url = new URL(req.url ?? '/', 'http://localhost')
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end('{"error":"invalid-url"}')
            return
          }
          // Gateway middleware (design 16 改动③): a truthy return claims the
          // request; falsy falls through to dispatchRest below.
          if (options.middleware !== undefined) {
            void Promise.resolve(options.middleware(req as ApiRequest, res as ApiResponse, url, middlewareCtx)).then((claimed) => {
              if (claimed) return
              dispatchRest(req as ApiRequest, res as ApiResponse, url)
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
        // Bound pre-routing slowloris/socket pressure as well as route-level
        // work. requestTimeout covers receiving the request, while the proxy
        // adds a stricter 30s inter-chunk body idle timeout. The connection
        // ceiling still leaves headroom for the documented HTTP/WS/SSE caps.
        server.headersTimeout = 10_000
        server.requestTimeout = 35_000
        server.keepAliveTimeout = 5_000
        server.maxRequestsPerSocket = 1_000
        server.maxConnections = 192
        // WS upgrade dispatcher (design 03 §3.1/§3.2): the instance proxy
        // handles /api/i/<id>/api/events.mux|host — explicit rejections
        // only, never a silent drop.
        function defaultUpgrade(req: ApiRequest, socket: Duplex, head: Buffer): void {
          // WebSocket ignores browser CORS response handling. Apply the same
          // origin fence before the proxy replaces Host and strips browser
          // markers; otherwise the upstream sees a trusted loopback request.
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
        server.on('upgrade', (req, socket, head) => {
          // Gateway upgrade middleware (design 16 改动③): truthy claims.
          if (options.upgradeMiddleware !== undefined) {
            void Promise.resolve(options.upgradeMiddleware(req as ApiRequest, socket as Duplex, head, middlewareCtx)).then((claimed) => {
              if (claimed) return
              defaultUpgrade(req as ApiRequest, socket as Duplex, head)
            }).catch((middlewareError: unknown) => {
              logger.error(`upgrade middleware failure: ${String(middlewareError)}`)
              socket.destroy()
            })
            return
          }
          defaultUpgrade(req as ApiRequest, socket as Duplex, head)
        })
        server.once('error', reject)
        server.listen(port, host, () => {
          const address = server!.address()
          serverPort = typeof address === 'object' && address !== null ? address.port : null
          logger.log(`control plane listening on http://${host}:${serverPort}`)
          resolveListen()
        })
      })
    },

    /** Stop the local dsh connection and close the HTTP surface. */
    async stop() {
      await local.stop()
      if (server !== null) {
        const srv = server
        server = null
        // Node's server.close() waits for every active connection to end — a
        // lingering renderer SSE/WS/proxy connection (e.g. after a crashed
        // local host left the page mid-reconnect) would otherwise hang the
        // close forever and strand the desktop app in a half-exited state.
        // Force-close first so close() resolves promptly: spliced WS streams
        // are tracked by the proxy (upgraded sockets leave the HTTP server's
        // connection tracking), HTTP/SSE/keep-alive by closeAllConnections/
        // closeIdleConnections. The 500ms window is a last-resort against any
        // straggler — the process exit then releases the remaining fds.
        instanceProxy.closeAllStreams()
        srv.closeAllConnections?.()
        srv.closeIdleConnections?.()
        await new Promise<void>(resolve => {
          const force = setTimeout(resolve, 500)
          force.unref?.()
          srv.close(() => {
            clearTimeout(force)
            resolve()
          })
        })
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

    /**
     * The control-plane instance identity (design 02 §2.5); spawn records
     * carry it for multi-instance diagnostics.
     */
    get instanceId() {
      return instanceId
    },

    /** The managed local dsh host's port (design 16 §2.1 改动①). */
    getLocalDshPort() {
      return local.getDshPort()
    },

    /**
     * Register a remote instance transport (design 05 §3.3): the desktop
     * main process reports a ready tunnel as connectionId `ssh:<id>` with
     * baseUrl `http://127.0.0.1:<tunnel localPort>` — the /api/i/ssh-<id>/*
     * proxy target. Tunnel URLs never leave the main process / proxy.
     */
    registerInstanceTransport(connectionId: string, baseUrl: string, extraHeaders?: Record<string, string>) {
      instanceProxy.registerTransport(connectionId, baseUrl, extraHeaders)
    },

    /** Unregister a remote instance transport (tunnel torn down). */
    unregisterInstanceTransport(connectionId: string) {
      instanceProxy.unregisterTransport(connectionId)
    },

    /** Pre-spawn the local instance (desktop form; idempotent). */
    startLocal: async () => {
      await startLocalConnection()
    },
  } satisfies PlaneHandle
}

export { spawnDsh } from './spawn-dsh.ts'
export { call, respond, openEventStream, RpcBusinessError, RpcTransportError } from './dsh-client.ts'
export type { ServerRequest } from './dsh-client.ts'
export type { Logger } from './types.ts'
export type { ApiRequest, ApiResponse, ApiSurface } from './api.ts'
// Shared forwarding core (design 16 §6.2, 方案 A): extracted from
// instance-proxy.ts so `gateway-proxy.ts` reuses the same Host/Origin
// rewrite + WS splice + limits/errors without forking.
export * from './proxy-forward.ts'
export { createJsonStore, JsonStorePersistError, JsonStoreRevisionConflictError } from './json-store.ts'
export type { JsonStore, JsonStoreDocument, JsonStoreMutator, JsonStoreOptions } from './json-store.ts'
