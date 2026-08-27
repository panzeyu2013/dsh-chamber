/**
 * /chamber/runtime controller (design 18 §9.3): the gateway-owned runtime
 * management surface. Mounted in the dispatch middleware BEFORE the feature
 * host and NOT ready-gated — dsh-down windows (restart/applying) must keep
 * `status` pollable, so this controller never detaches with the dsh-derived
 * feature consumers.
 */
import type { ApiRequest, ApiResponse, Logger } from '@dsh-chamber/control-plane'
import { sanitizeRouteError } from './sanitize-route-error.ts'
export { sanitizeRouteError }
import type { GatewayRuntimeManager } from './runtime-manager.ts'

function json(res: ApiResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
  return true
}

function readJsonBody(req: ApiRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      if (chunks.reduce((sum, c) => sum + c.length, 0) > 64 * 1024) {
        // No destroy here: the caller must WRITE the 413 first, then destroy
        // the socket (dispatch.ts does the same) — destroying first drops the
        // response on a real socket (review fix).
        reject(Object.assign(new Error('request body too large'), { code: 'body_too_large' }))
      }
    })
    req.on('end', () => {
      if (chunks.length === 0) { resolve(undefined); return }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { code: 'bad_request' }))
      }
    })
    req.on('error', reject)
  })
}

function codeToStatus(code: string | undefined): number {
  switch (code) {
    case 'runtime_busy': return 409
    case 'connection_busy': return 409
    case 'no_retry_target': return 409
    case 'invalid_target': return 409
    case 'platform_read_only': return 403
    case 'bad_registry_origin': return 400
    case 'no_selection': return 409
    case 'env_override_active': return 409
    case 'body_too_large': return 413
    case 'bad_request': return 400
    default: return 500
  }
}

export interface RuntimeRoutes {
  handle(req: ApiRequest, res: ApiResponse, pathname: string): Promise<boolean>
}

export function createRuntimeRoutes(manager: () => GatewayRuntimeManager, logger: Logger): RuntimeRoutes {
  const fail = (res: ApiResponse, error: unknown): void => {
    const message = sanitizeRouteError(error instanceof Error ? error.message : String(error))
    const code = (error as Error & { code?: string }).code
    const status = codeToStatus(code)
    logger.warn(`/chamber/runtime request failed (${status}): ${message}`)
    json(res, status, { error: message, code: code ?? 'internal_error' })
  }

  async function handle(req: ApiRequest, res: ApiResponse, pathname: string): Promise<boolean> {
    // Exact-prefix boundary: /chamber/runtime and /chamber/runtime/<suffix>
    // only; /chamber/runtimeevil falls through to the feature host.
    if (pathname !== '/chamber/runtime' && !pathname.startsWith('/chamber/runtime/')) return false
    const m = manager()
    const suffix = pathname.slice('/chamber/runtime'.length) || '/'
    try {
      if (suffix === '/status' && req.method === 'GET') {
        return json(res, 200, m.status())
      }
      if (suffix === '/versions' && req.method === 'GET') {
        return json(res, 200, await m.listVersions())
      }
      if (suffix === '/select' && req.method === 'POST') {
        const body = (await readJsonBody(req)) as { version?: unknown } | undefined
        if (body === undefined || typeof body.version !== 'string' || body.version === '') {
          return json(res, 400, { error: 'version is required', code: 'bad_request' })
        }
        // Honest acceptance (R7 review): synchronous refusals are answered
        // synchronously, not swallowed behind a fake 202.
        if (m.activationInProgress()) {
          return json(res, 409, { error: 'runtime activation in progress', code: 'runtime_busy' })
        }
        // Review fix: a select clicked during a restart (up to ~90s window)
        // must refuse synchronously — the fire-and-forget 202 path below would
        // otherwise 'accept' a job the manager fence then rejects silently.
        if (m.restartInFlight()) {
          return json(res, 409, { error: 'a restart is in flight; runtime mutations are refused', code: 'runtime_busy' })
        }
        if (m.status().source === 'env') {
          return json(res, 409, { error: 'runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled', code: 'env_override_active' })
        }
        if (m.status().mutationsAllowed === false) {
          return json(res, 403, { error: 'runtime mutations are read-only on this platform', code: 'platform_read_only' })
        }
        // Async install job: 202 immediately; progress/failure surfaces via
        // /status (operationError).
        void m.select(body.version).catch(error => logger.error(`runtime select failed: ${sanitizeRouteError(error instanceof Error ? error.message : String(error))}`))
        return json(res, 202, { accepted: true, version: body.version })
      }
      if (suffix === '/apply' && req.method === 'POST') {
        return json(res, 200, await m.apply())
      }
      if (suffix === '/rollback' && req.method === 'POST') {
        const body = (await readJsonBody(req)) as { version?: unknown } | undefined
        if (body === undefined || typeof body.version !== 'string' || body.version === '') {
          return json(res, 400, { error: 'version is required', code: 'bad_request' })
        }
        return json(res, 200, await m.rollback(body.version))
      }
      if (suffix === '/retry-apply' && req.method === 'POST') {
        // Resume an interrupted pointer switch (swap-attempted): the startup
        // transaction re-runs and, on a clean verdict, the managed dsh comes
        // up; a still-blocked retry reports the blockedReason honestly.
        return json(res, 200, await m.retryApply())
      }
      if (suffix === '/retry-restore' && req.method === 'POST') {
        // Resume an interrupted snapshot restore (restore-half / restore-
        // incomplete) from the durable journal.
        return json(res, 200, await m.retryRestore())
      }
      if (suffix === '/restore-builtin' && req.method === 'POST') {
        return json(res, 200, await m.restoreBuiltin())
      }
      if (suffix === '/restart' && req.method === 'POST') {
        // 202: restart acceptance never blocks on readiness (design 18 §9.3);
        // the transactional restart runs in the background and progress is
        // polled via /status. Synchronous refusals are answered synchronously:
        // applying refuses 409; a dsh that never reached ready refuses 409
        // (an in-flight restart is single-flight merged by restartLocal).
        if (m.status().phase === 'applying') {
          return json(res, 409, { error: 'runtime activation in progress; restart refused', code: 'runtime_busy' })
        }
        if (m.status().connectionState !== 'ready' && m.status().connectionState !== 'degraded') {
          // Round-4 wording: no start route exists — recovery is restore-builtin
          // / retry-apply / retry-restore (or a gateway restart), not a start.
          return json(res, 409, { error: `managed dsh is not running (${m.status().connectionState}); restore the builtin or retry the interrupted apply/restore before restarting`, code: 'runtime_busy' })
        }
        if (m.restartInFlight()) {
          return json(res, 409, { error: 'a restart is already in flight', code: 'runtime_busy' })
        }
        void m.restart().catch(error => logger.error(`runtime restart failed: ${sanitizeRouteError(error instanceof Error ? error.message : String(error))}`))
        return json(res, 202, { accepted: true })
      }
      if (suffix === '/registry' && req.method === 'GET') {
        return json(res, 200, m.getRegistry())
      }
      if (suffix === '/registry' && req.method === 'PUT') {
        const body = (await readJsonBody(req)) as { origin?: unknown } | undefined
        if (body === undefined || typeof body.origin !== 'string' || body.origin === '') {
          return json(res, 400, { error: 'origin is required', code: 'bad_request' })
        }
        return json(res, 200, await m.setRegistry(body.origin))
      }
      if (suffix === '/' || suffix === '') {
        return json(res, 200, { routes: ['status', 'versions', 'select', 'apply', 'rollback', 'restore-builtin', 'restart', 'retry-apply', 'retry-restore', 'registry'] })
      }
      return json(res, 404, { error: 'unknown /chamber/runtime route', code: 'not_found' })
    } catch (error) {
      fail(res, error)
      if ((error as Error & { code?: string }).code === 'body_too_large') {
        // The 413 was written above; the oversized body may still be
        // streaming — destroy the socket instead of draining it, exactly like
        // dispatch's readBody path (review fix: response first, then destroy).
        try { req.destroy?.() } catch { /* socket already gone */ }
      }
      return true
    }
  }

  return { handle }
}
