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
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createCatalog } from './catalog.ts'
import { createLocalConnection } from './local-connection.ts'
import type { LocalConnectionDeps } from './local-connection.ts'
import { createApi } from './api.ts'
import { runReaper } from './reaper.ts'
import { createInstanceProxy } from './instance-proxy.ts'
import { ensureInstanceId } from './instance-id.ts'
import { hostLogs } from './host-logs.ts'
import type { Logger } from './types.ts'
import type { ApiRequest, ApiResponse } from './api.ts'

/** Default control-plane state root when DSH_CHAMBER_STATE is unset. */
export const DEFAULT_STATE_DIR = join(homedir(), '.dsh-chamber')

/**
 * Default dsh workspace: <repo root>/ref-dsh when present, otherwise the
 * desktop vendor bundle <repo root>/packages/desktop/vendor/dsh (this package
 * lives at <root>/packages/control-plane). When neither exists, still returns
 * the ref-dsh path — the caller decides how to surface the absence
 * (main.ts passes null explicitly in that case).
 */
export function defaultDshWorkspacePath() {
  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
  const refDsh = join(repoRoot, 'ref-dsh')
  if (existsSync(refDsh)) return refDsh
  const vendorDsh = join(repoRoot, 'packages', 'desktop', 'vendor', 'dsh')
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
}

/** The assembled control-plane handle returned by createControlPlane. */
export interface PlaneHandle {
  start(): Promise<void>
  stop(): Promise<void>
  readonly port: number | null
  readonly connectionState: string
  readonly instanceId: string
  registerInstanceTransport(connectionId: string, baseUrl: string): void
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
  const stateDir = options.stateDir ?? process.env.DSH_CHAMBER_STATE ?? DEFAULT_STATE_DIR
  const dshWorkspacePath = options.dshWorkspacePath ?? process.env.DSH_CHAMBER_DSH_PATH ?? defaultDshWorkspacePath()
  const webDistDir = options.webDistDir === undefined ? undefined : options.webDistDir
  // The console default satisfies every module's logger option ({log,warn,error}).
  const logger = (options.logger ?? console) as Logger

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

  // The managed local connection adapter (design 02): spawn/health/reaper
  // owner; readiness = TCP + host.describe inside spawn-dsh.
  const local = createLocalConnection({
    stateDir, dshHome, dshWorkspacePath, catalog, logger,
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
        const script = `<script>window.__DSH_BOOT__=${JSON.stringify(manifest)};</script>`
        const text = data.toString('utf8')
        if (text.includes('</head>')) data = Buffer.from(text.replace('</head>', `${script}</head>`))
        else data = Buffer.from(`${text}${script}`)
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...(res._corsHeaders ?? {}) })
    } else {
      res.writeHead(200, { 'content-type': type, ...(res._corsHeaders ?? {}) })
    }
    res.end(data)
  }

  function jsonStaticError(res: ApiResponse, status: number, code: string) {
    const body = JSON.stringify({ error: code, code })
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(res._corsHeaders ?? {}) })
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
      await new Promise<void>((resolveListen, reject) => {
        server = createServer((req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const surface = url.pathname.split('/').filter(Boolean)[0] ?? ''
          if (surface === 'api' || surface === 'health') {
            void api.handle(req as ApiRequest, res as ApiResponse).catch(error => {
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
            serveStatic(req as ApiRequest, res as ApiResponse, url.pathname)
            return
          }
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'not_found', code: 'not_found' }))
        })
        // WS upgrade dispatcher (design 03 §3.1/§3.2): the instance proxy
        // handles /api/i/<id>/api/events.mux|host — explicit rejections
        // only, never a silent drop.
        server.on('upgrade', (req, socket, head) => {
          // WebSocket ignores browser CORS response handling. Apply the same
          // origin fence before the proxy replaces Host and strips browser
          // markers; otherwise the upstream sees a trusted loopback request.
          if (!api.getCorsHeaders(req as ApiRequest).allowed) {
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
        await new Promise(resolve => srv.close(resolve))
        server = null
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

    /**
     * The control-plane instance identity (design 02 §2.5); spawn records
     * carry it for multi-instance diagnostics.
     */
    get instanceId() {
      return instanceId
    },

    /**
     * Register a remote instance transport (design 05 §3.3): the desktop
     * main process reports a ready tunnel as connectionId `ssh:<id>` with
     * baseUrl `http://127.0.0.1:<tunnel localPort>` — the /api/i/ssh-<id>/*
     * proxy target. Tunnel URLs never leave the main process / proxy.
     */
    registerInstanceTransport(connectionId: string, baseUrl: string) {
      instanceProxy.registerTransport(connectionId, baseUrl)
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
