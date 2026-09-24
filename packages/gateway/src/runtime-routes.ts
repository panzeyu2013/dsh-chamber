/**
 * /chamber/runtime controller (design 18 §9.3): the gateway-owned runtime
 * management surface, mounted BEFORE the feature host and NOT ready-gated —
 * dsh-down windows must keep `status` pollable, so it never detaches with the
 * feature consumers.
 */
import type { ApiRequest, ApiResponse, Logger } from '@dsh-chamber/control-plane'
import { sanitizeRouteError } from './sanitize-route-error.ts'
import type { GatewayRuntimeManager } from './runtime-manager.ts'
import {
  applyNowNotRunningRefusal,
  envPinnedRefusal,
  mutationBusyRefusal,
  profileWriteBusyRefusal,
  startAlreadyInFlightRefusal,
  startNotApplicableRefusal,
} from './runtime-refusals.ts'
import { recoveryGateRefusal, type RuntimeMutationAction } from './runtime-gate.ts'
import { codedError, jsonResponse, readBoundedBody } from './http-utils.ts'

/** Read a bounded JSON body (64 KiB cap): an empty body is a JSON `undefined`
 * (no body), a parse failure is a 400, and an oversize body is answered 413 by
 * the caller, which destroys the socket only AFTER writing the response. */
async function readJsonBody(req: ApiRequest): Promise<unknown> {
  const outcome = await readBoundedBody(req, 64 * 1024)
  if (outcome.kind === 'oversize') throw codedError('body_too_large', 'request body too large')
  // The kernel settles aborted/closed connections too; the stream error is forwarded unchanged.
  if (outcome.kind === 'aborted' || outcome.kind === 'closed') {
    throw codedError('request_aborted', 'request body aborted')
  }
  if (outcome.kind === 'stream-error') throw outcome.error
  if (outcome.buffer.length === 0) return undefined
  try {
    return JSON.parse(outcome.buffer.toString('utf8'))
  } catch {
    throw codedError('bad_request', 'invalid JSON body')
  }
}

function codeToStatus(code: string | undefined): number {
  switch (code) {
    case 'runtime_busy': return 409
    case 'runtime_pending': return 409
    case 'runtime_recovery_required': return 409
    case 'connection_busy': return 409
    case 'no_retry_target': return 409
    case 'invalid_target': return 409
    case 'noop_target': return 409
    case 'platform_read_only': return 403
    case 'bad_registry_origin': return 400
    case 'no_selection': return 409
    case 'env_override_active': return 409
    case 'version_still_protected': return 409
    case 'restore_failed': return 409
    case 'runtime_disk_unavailable': return 409
    case 'runtime_disk_limit': return 409
    case 'runtime_activation_failed': return 409
    case 'runtime_no_override': return 409
    case 'body_too_large': return 413
    case 'bad_request': return 400
    default: return 500
  }
}

function rejectRecoveryGate(
  res: ApiResponse,
  status: { phase?: unknown; pending?: unknown; startupBlockedReason?: unknown; canRecoverMetadata?: unknown },
  action: RuntimeMutationAction,
): boolean {
  const refusal = recoveryGateRefusal(status, action)
  if (refusal === null) return false
  jsonResponse(res, 409, refusal)
  return true
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
    jsonResponse(res, status, { error: message, code: code ?? 'internal_error' })
  }

  async function handle(req: ApiRequest, res: ApiResponse, pathname: string): Promise<boolean> {
    // Exact-prefix boundary: /chamber/runtime and /chamber/runtime/<suffix> only; /chamber/runtimeevil falls through to the chamber surface.
    if (pathname !== '/chamber/runtime' && !pathname.startsWith('/chamber/runtime/')) return false
    const m = manager()
    const suffix = pathname.slice('/chamber/runtime'.length) || '/'
    try {
      if (suffix === '/status' && req.method === 'GET') {
        return jsonResponse(res, 200, await m.status())
      }
      if (suffix === '/versions' && req.method === 'GET') {
        return jsonResponse(res, 200, await m.listVersions())
      }
      if (suffix === '/select' && req.method === 'POST') {
        const body = (await readJsonBody(req)) as { version?: unknown } | undefined
        if (body === undefined || typeof body.version !== 'string' || body.version === '') {
          return jsonResponse(res, 400, { error: 'version is required', code: 'bad_request' })
        }
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'select')) return true
        // Honest acceptance: refusals are answered synchronously, never swallowed behind a fake 202; a held profile-write lease is refused before the 202.
        if (m.profileWriteInFlight?.()) {
          // Same code/message as the manager's assertMutationIdle lease branch.
          return jsonResponse(res, 409, profileWriteBusyRefusal('runtime mutations'))
        }
        if (m.mutationInProgress()) {
          return jsonResponse(res, 409, mutationBusyRefusal())
        }
        if (status.source === 'env') {
          return jsonResponse(res, 409, envPinnedRefusal('version mutations'))
        }
        if (status.mutationsAllowed === false) {
          return jsonResponse(res, 403, { error: 'runtime mutations are read-only on this platform', code: 'platform_read_only' })
        }
        // Async install job: 202 immediately; progress/failure via /status.
        void m.select(body.version).catch(error => logger.error(`runtime select failed: ${sanitizeRouteError(error instanceof Error ? error.message : String(error))}`))
        return jsonResponse(res, 202, { accepted: true, version: body.version })
      }
      if (suffix === '/apply' && req.method === 'POST') {
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'apply')) return true
        return jsonResponse(res, 200, await m.apply())
      }
      if (suffix === '/apply-now' && req.method === 'POST') {
        // 202: apply-now accepts immediately (mirrors /restart); the version-switch
        // activation transaction runs in the background, polled via /status. The
        // manager's synchronous preflight runs INSIDE this try, so any throw lands in
        // the outer catch and 409/403 is written BEFORE a 202.
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'apply-now')) return true
        if (m.mutationInProgress()) {
          return jsonResponse(res, 409, mutationBusyRefusal())
        }
        if (status.source === 'env') {
          return jsonResponse(res, 409, envPinnedRefusal('version mutations'))
        }
        if (status.mutationsAllowed === false) {
          return jsonResponse(res, 403, { error: 'runtime mutations are read-only on this platform', code: 'platform_read_only' })
        }
        if (status.connectionState !== 'ready' && status.connectionState !== 'degraded') {
          // Mirror /restart: a never-ready dsh cannot be switched in-session
          // (restart-exhausted included). Same code/message as the manager's
          // applyNowPreflight parity.
          return jsonResponse(res, 409, applyNowNotRunningRefusal(status.connectionState))
        }
        if (m.applyNowInFlight()) {
          return jsonResponse(res, 409, { error: 'a runtime apply-now is already in flight', code: 'runtime_busy' })
        }
        const target = m.applyNowPreflight()
        void m.applyNow().catch(error => logger.error(`runtime apply-now failed: ${sanitizeRouteError(error instanceof Error ? error.message : String(error))}`))
        return jsonResponse(res, 202, { accepted: true, version: target })
      }
      if (suffix === '/rollback' && req.method === 'POST') {
        const body = (await readJsonBody(req)) as { version?: unknown } | undefined
        if (body === undefined || typeof body.version !== 'string' || body.version === '') {
          return jsonResponse(res, 400, { error: 'version is required', code: 'bad_request' })
        }
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'rollback')) return true
        return jsonResponse(res, 200, await m.rollback(body.version))
      }
      if (suffix === '/cleanup-version' && req.method === 'POST') {
        // Desktop-parity cleanup: ledger-gated deletion of one explicitly installed
        // version tree + store prune. Synchronous 200 like /apply; throws map through.
        const body = (await readJsonBody(req)) as { version?: unknown } | undefined
        if (body === undefined || typeof body.version !== 'string' || body.version === '') {
          return jsonResponse(res, 400, { error: 'version is required', code: 'bad_request' })
        }
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'cleanup-version')) return true
        if (m.mutationInProgress()) {
          return jsonResponse(res, 409, mutationBusyRefusal())
        }
        return jsonResponse(res, 200, await m.cleanupVersion(body.version))
      }
      if (suffix === '/restore-pre-rollback' && req.method === 'POST') {
        // Desktop-parity pre-rollback data restore: stash-name whitelist + re-listing live in the manager; env stays allowed.
        const body = (await readJsonBody(req)) as { stashName?: unknown } | undefined
        if (body === undefined || typeof body.stashName !== 'string' || body.stashName === '') {
          return jsonResponse(res, 400, { error: 'stashName is required', code: 'bad_request' })
        }
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'restore-pre-rollback')) return true
        if (m.mutationInProgress()) {
          return jsonResponse(res, 409, mutationBusyRefusal())
        }
        return jsonResponse(res, 200, await m.restorePreRollback(body.stashName))
      }
      if (suffix === '/recover-metadata' && req.method === 'POST') {
        // Metadata FATAL rescue (desktop parity): archives corrupt selection
        // metadata with a full DSH_HOME copy and runs the builtin anchor through the
        // probe gate; synchronous refusals come from the manager.
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'recover-metadata')) return true
        if (m.mutationInProgress()) {
          return jsonResponse(res, 409, mutationBusyRefusal())
        }
        return jsonResponse(res, 200, await m.recoverMetadata())
      }
      if (suffix === '/retry-apply' && req.method === 'POST') {
        // Resume an interrupted pointer switch (swap-attempted): the startup
        // transaction re-runs; a still-blocked retry reports the blockedReason.
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'retry-apply')) return true
        return jsonResponse(res, 200, await m.retryApply())
      }
      if (suffix === '/retry-restore' && req.method === 'POST') {
        // Resume an interrupted snapshot restore (restore-half / restore-incomplete) from the durable journal.
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'retry-restore')) return true
        return jsonResponse(res, 200, await m.retryRestore())
      }
      if (suffix === '/restore-builtin' && req.method === 'POST') {
        // Route-level gate (desktop parity): restore-builtin is the escape for a
        // PENDING or HEALTHY-with-override selection only. Inside an interrupted
        // apply/restore the shared core re-blocks an armed reset against the durable
        // markers, so only the matching retry is exposed; a FATAL metadata block or
        // in-flight writer resumes through its own surface (manager: hasOverride).
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'restore-builtin')) return true
        return jsonResponse(res, 200, await m.restoreBuiltin())
      }
      if (suffix === '/restart' && req.method === 'POST') {
        // 202: restart acceptance never blocks on readiness; the transactional
        // restart runs in the background, polled via /status. Installing/applying/
        // pending and a never-ready dsh refuse 409 (restartLocal single-flight).
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'restart')) return true
        if (status.phase === 'applying' || status.phase === 'installing') {
          return jsonResponse(res, 409, { error: 'runtime mutation in progress; restart refused', code: 'runtime_busy' })
        }
        if (status.connectionState !== 'ready' && status.connectionState !== 'degraded') {
          // restartLocal rejects every non-ready state: the recovery surface for
          // stopped/error/restart-exhausted is POST /chamber/runtime/start, while
          // interrupted apply/restore windows keep their retry/restore routes.
          return jsonResponse(res, 409, { error: `managed dsh is not running (${status.connectionState}); start the managed dsh (start applies to stopped/error/restart-exhausted) or retry the interrupted apply/restore`, code: 'runtime_busy' })
        }
        if (m.profileWriteInFlight?.()) {
          // A restart respawns the managed dsh and its seed thunk writes DSH_HOME — never while a plugin pnpm child holds the profile-write lease.
          return jsonResponse(res, 409, profileWriteBusyRefusal('restart'))
        }
        if (m.restartInFlight()) {
          return jsonResponse(res, 409, { error: 'a restart is already in flight', code: 'runtime_busy' })
        }
        void m.restart().catch(error => logger.error(`runtime restart failed: ${sanitizeRouteError(error instanceof Error ? error.message : String(error))}`))
        return jsonResponse(res, 202, { accepted: true })
      }
      if (suffix === '/start' && req.method === 'POST') {
        // Start primitive: bring the managed dsh up from stopped/error/
        // restart-exhausted. 202 semantics mirror /restart, every synchronous refusal
        // answered before any 202 — the recovery gate refuses every
        // startupBlockedReason and exposes only the matching retry, while
        // installing/applying, a held lease and a running/starting dsh refuse.
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'start')) return true
        if (status.phase === 'applying' || status.phase === 'installing') {
          return jsonResponse(res, 409, { error: 'runtime mutation in progress; start refused', code: 'runtime_busy' })
        }
        if (m.profileWriteInFlight?.()) {
          return jsonResponse(res, 409, profileWriteBusyRefusal('start'))
        }
        if (m.startInFlight?.()) {
          // Same code/message as the manager start() head single-flight check.
          return jsonResponse(res, 409, startAlreadyInFlightRefusal())
        }
        if (status.connectionState !== 'stopped' && status.connectionState !== 'error'
          && status.connectionState !== 'restart-exhausted') {
          // Same code/message as the manager start() connection gate.
          return jsonResponse(res, 409, startNotApplicableRefusal(status.connectionState))
        }
        void m.start().catch(error => logger.error(`runtime start failed: ${sanitizeRouteError(error instanceof Error ? error.message : String(error))}`))
        return jsonResponse(res, 202, { accepted: true })
      }
      if (suffix === '/registry' && req.method === 'GET') {
        return jsonResponse(res, 200, m.getRegistry())
      }
      if (suffix === '/registry' && req.method === 'PUT') {
        const body = (await readJsonBody(req)) as { origin?: unknown } | undefined
        if (body === undefined || typeof body.origin !== 'string' || body.origin === '') {
          return jsonResponse(res, 400, { error: 'origin is required', code: 'bad_request' })
        }
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'registry')) return true
        return jsonResponse(res, 200, await m.setRegistry(body.origin))
      }
      if (suffix === '/' || suffix === '') {
        return jsonResponse(res, 200, { routes: ['status', 'versions', 'select', 'apply', 'apply-now', 'rollback', 'cleanup-version', 'restore-pre-rollback', 'recover-metadata', 'restore-builtin', 'restart', 'start', 'retry-apply', 'retry-restore', 'registry'] })
      }
      return jsonResponse(res, 404, { error: 'unknown /chamber/runtime route', code: 'not_found' })
    } catch (error) {
      fail(res, error)
      if ((error as Error & { code?: string }).code === 'body_too_large') {
        // The 413 was written above; the oversized body may still be streaming —
        // destroy the socket instead of draining it, like dispatch's readBody path.
        try { req.destroy?.() } catch { /* socket already gone */ }
      }
      return true
    }
  }

  return { handle }
}
