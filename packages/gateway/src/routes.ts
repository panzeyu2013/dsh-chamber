/**
 * Gateway chamber surface: the gateway-owned `/chamber/*` routes behind the
 * auth gate (dispatch.ts) — channels projection, the desktop-synced
 * host-package seed cache, the managed-profile plugin READ projection
 * (installed), the read-only session-state watcher, the browser dashboard, and
 * the separately dispatched `/chamber/runtime/*` controller. The user plugin
 * write surface (install / materialize / remove / undo / tasks) was retired
 * with the 2026-09 C layering ruling. Every route reads/writes gateway-owned
 * state; authoritative dsh facts stay on dsh.
 */

import {
  SESSION_STATE_PATH,
  type ApiRequest,
  type ApiResponse,
  type Logger,
} from '@dsh-chamber/control-plane'
import type { ChannelRegistry } from './channels.ts'
import type { ChamberPlugins } from './plugins.ts'
import type { ChamberInstalled } from './plugins-installed.ts'
import { sanitizeRouteError } from './sanitize-route-error.ts'
import { CHAMBER_APP_HTML, CHAMBER_APP_JS, MOBILE_HTML } from './chamber-assets.ts'
import type { ChamberSessionState } from './session-state.ts'
import { codedError, jsonResponse, readBoundedBody } from './http-utils.ts'

export interface ChamberSurfaceDeps {
  logger: Logger
  /** The channel registry (MVP empty). */
  channels: ChannelRegistry
  /** The desktop-synced host-package seed cache. */
  plugins: ChamberPlugins
  /** The managed web-profile plugin read projection (read-only). */
  installed: ChamberInstalled
  /** The read-only session-state watcher: snapshot, SSE deltas and read marks
   * under /chamber/session-state*. Optional so the surface stays additive; when
   * absent the prefix falls through to this surface's own 404. */
  sessionState?: ChamberSessionState
}

export interface ChamberSurface {
  /** Handle a `/chamber/*` request. Returns true when the path was claimed
   * (including a 404 for an unknown /chamber route). */
  handle(req: ApiRequest, res: ApiResponse, pathname: string): Promise<boolean>
}

/** Bounded JSON body reader for the plugin-sync upload. Cap: 8 MiB — a host
 * package's artifact (up to 4 MiB) + manifest as JSON strings. An oversized
 * body is answered 413 and the socket destroyed rather than drained, so a slow
 * authenticated upload cannot pin the connection. */
async function readUploadJsonBody(req: ApiRequest): Promise<unknown> {
  const outcome = await readBoundedBody(req, 8 * 1024 * 1024)
  if (outcome.kind === 'oversize') throw codedError('body_too_large', 'request body exceeds 8 MiB')
  if (outcome.kind === 'aborted') throw codedError('request_aborted', 'request body was aborted')
  if (outcome.kind === 'closed') throw codedError('request_aborted', 'request body was closed')
  if (outcome.kind === 'stream-error') throw codedError('request_aborted', 'request body stream failed')
  try {
    return outcome.buffer.length === 0 ? {} : JSON.parse(outcome.buffer.toString('utf8'))
  } catch {
    throw codedError('bad_request', 'request body is not valid JSON')
  }
}

// Gateway-owned browser assets: the full dsh frontend stays proxied at `/`;
// `/chamber/` is a deliberately small gateway-owned operations surface.

const CHAMBER_APP_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'"

function serveAsset(
  res: ApiResponse,
  contentType: string,
  body: string,
  head: boolean,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
    ...extraHeaders,
  })
  res.end(head ? undefined : body)
}

function isAssetMethod(method: string | undefined): boolean {
  return method === 'GET' || method === 'HEAD'
}

function methodNotAllowed(res: ApiResponse): true {
  jsonResponse(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
  return true
}



/**
 * The gateway's own `/chamber/*` surface: channels projection + plugin-sync
 * seed cache (chamber provisioning, not a user plugin write face) + the
 * managed-profile plugin read projection + browser dashboard assets (GET/HEAD
 * reads) + the read-only session-state routes.
 */
export function createChamberSurface(deps: ChamberSurfaceDeps): ChamberSurface {
  const { channels, logger } = deps
  async function handleRoute(req: ApiRequest, res: ApiResponse, pathname: string): Promise<boolean> {
    // /chamber/channels: the channel registry projection (MVP empty).
    if (pathname === '/chamber/channels') {
      if (req.method !== 'GET') {
        jsonResponse(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
        return true
      }
      jsonResponse(res, 200, { items: channels.list() })
      return true
    }

    // /chamber/plugins: the desktop-synced host-package seed cache. GET = the
    // non-secret projection (name + version); PUT = upload one syncable host
    // package (validated + atomically cached; the next dsh spawn re-seeds it,
    // and the syncing desktop triggers /chamber/runtime/restart to refresh).
    if (pathname === '/chamber/plugins' || pathname === '/chamber/plugins/') {
      if (req.method === 'GET') {
        jsonResponse(res, 200, { items: deps.plugins.list() })
        return true
      }
      if (req.method === 'PUT') {
        try {
          const body = (await readUploadJsonBody(req)) as { name?: unknown; files?: unknown }
          const name = typeof body?.name === 'string' ? body.name : null
          if (name === null || body?.files === null || typeof body?.files !== 'object' || Array.isArray(body.files)) {
            jsonResponse(res, 400, { error: 'invalid_input', code: 'invalid_input' })
            return true
          }
          const files = body.files as Record<string, unknown>
          const packageJson = typeof files['package.json'] === 'string' ? files['package.json'] : null
          const distIndex = typeof files['dist/index.js'] === 'string' ? files['dist/index.js'] : null
          if (packageJson === null || distIndex === null) {
            jsonResponse(res, 400, { error: 'invalid_input', code: 'invalid_input' })
            return true
          }
          const outcome = await deps.plugins.put(name, { 'package.json': packageJson, 'dist/index.js': distIndex })
          jsonResponse(res, 200, { ok: true, changed: outcome.changed })
        } catch (error) {
          const code = (error as { code?: unknown })?.code
          if (code === 'body_too_large') {
            jsonResponse(res, 413, { error: 'body_too_large', code: 'body_too_large' })
            req.destroy?.()
            return true
          }
          if (code === 'bad_request') {
            jsonResponse(res, 400, { error: 'bad_request', code: 'bad_request' })
            return true
          }
          if (code === 'request_aborted') return true
          if (code === 'invalid_input') {
            // Echo the sanitized REASON (names/size bounds only, never a path
            // or credential), not a bare code, so a syncing desktop meeting an
            // older gateway sees why its package was refused. The thrower may
            // hand over its own non-secret vocabulary (`error.keep`): a scoped
            // package name is path-shaped and would otherwise be redacted to
            // `[path]`, erasing exactly the fact this message carries.
            const detail = error instanceof Error && error.message !== '' ? error.message : 'invalid_input'
            const keep = (error as { keep?: unknown }).keep
            jsonResponse(res, 400, {
              error: sanitizeRouteError(detail, Array.isArray(keep) ? keep.filter(entry => typeof entry === 'string') as string[] : []),
              code: 'invalid_input',
            })
            return true
          }
          // Any other throw is a persistence failure (fs write, permissions,
          // disk full …): the client must distinguish "your input was bad" from
          // "the gateway could not write" (proxy honesty).
          logger.warn(`chamber-plugins: persistence failure: ${String(error)}`)
          jsonResponse(res, 500, { error: 'persistence_failed', code: 'persistence_failed' })
          return true
        }
        return true
      }
      jsonResponse(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
      return true
    }

    // GET /chamber/plugins/installed: the gateway readManifest projection of the
    // MANAGED dsh web profile manifest the desktop's localPluginList reads.
    // Read-only; the user plugin write surface was retired with the 2026-09
    // C layering ruling, so no writer fence is consulted. Status matrix:
    //   200 profile present (ok + dependencies/rows/profileExists)
    //   404 profile_absent (not made)
    //   500 profile_corrupt (unreadable; detail logged, not echoed — it may
    //       name stateDir-internal paths)
    // A stopped/error instance still reads 200/404 (this is a manifest read,
    // not the runtime's connection state).
    if (pathname === '/chamber/plugins/installed' || pathname === '/chamber/plugins/installed/') {
      if (req.method !== 'GET') return methodNotAllowed(res)
      const projection = deps.installed.read()
      if (!projection.ok) {
        if (projection.code === 'profile_absent') {
          jsonResponse(res, 404, { error: 'managed profile is not initialized', code: 'profile_absent' })
        } else {
          logger.warn(`chamber-plugins-installed: ${projection.error ?? projection.code}`)
          jsonResponse(res, 500, { error: 'managed profile is corrupted', code: 'profile_corrupt' })
        }
        return true
      }
      jsonResponse(res, 200, projection)
      return true
    }


    // Gateway-owned browser operations surface, already behind dispatch.ts's
    // mandatory auth gate. The document uses an external same-origin script so
    // the control-plane CSP can keep inline script closed; no credentials in URLs.
    if (pathname === '/chamber/') {
      if (!isAssetMethod(req.method)) return methodNotAllowed(res)
      serveAsset(res, 'text/html; charset=utf-8', CHAMBER_APP_HTML, req.method === 'HEAD', {
        'content-security-policy': CHAMBER_APP_CSP,
      })
      return true
    }
    if (pathname === '/chamber/app.js') {
      if (!isAssetMethod(req.method)) return methodNotAllowed(res)
      serveAsset(res, 'application/javascript; charset=utf-8', CHAMBER_APP_JS, req.method === 'HEAD')
      return true
    }

    // Mobile light surface. The PWA trio (manifest.webmanifest /
    // sw-register.js / sw.js) is deliberately NOT served: nothing references
    // those URLs — the HTML link/registration injection is deferred
    // (middleware.ts), so serving them would have no consumer.
    if (pathname === '/chamber/mobile.html') {
      if (!isAssetMethod(req.method)) return methodNotAllowed(res)
      serveAsset(res, 'text/html; charset=utf-8', MOBILE_HTML, req.method === 'HEAD')
      return true
    }

    // /chamber/session-state*: snapshot / SSE / read / read-all. Exact-prefix
    // match only — '/chamber/session-stateevil' must NOT be claimed. Host-down
    // still answers 200 with host.serviceable=false; the disabled switch answers
    // 503 session_state_disabled.
    if (deps.sessionState !== undefined
      && (pathname === SESSION_STATE_PATH || pathname.startsWith(SESSION_STATE_PATH + '/'))) {
      return await deps.sessionState.handle(req, res, pathname)
    }

    // Unknown /chamber/* → 404 (claimed, so the default dispatch does not run).
    jsonResponse(res, 404, { error: 'not_found', code: 'not_found' })
    return true
  }

  // The public boundary is the `/` proxy to the managed dsh
  // (gateway-proxy.ts), the READ routes above, the desktop-synced seed cache
  // (PUT /chamber/plugins — chamber provisioning), and the separately
  // dispatched /chamber/runtime controller. No user plugin write route exists:
  // the install/materialize/remove/undo/tasks surface was retired with the
  // 2026-09 C layering ruling.
  return {
    async handle(req, res, pathname): Promise<boolean> {
      return handleRoute(req, res, pathname)
    },
  }
}
