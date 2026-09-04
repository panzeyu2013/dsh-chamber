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
import { RECOVERABLE_METADATA_BLOCKS, type GatewayRuntimeManager } from './runtime-manager.ts'

function json(res: ApiResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
  return true
}

function readJsonBody(req: ApiRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let finished = false
    const fail = (error: unknown): void => {
      if (finished) return
      finished = true
      // Release retained input immediately and make every later stream event
      // a no-op. The caller writes the 413 before destroying the socket.
      chunks.length = 0
      reject(error)
    }
    req.on('data', (chunk: Buffer) => {
      if (finished) return
      size += chunk.length
      if (size > 64 * 1024) {
        // No destroy here: the caller must WRITE the 413 first, then destroy
        // the socket (dispatch.ts does the same) — destroying first drops the
        // response on a real socket (review fix).
        fail(Object.assign(new Error('request body too large'), { code: 'body_too_large' }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (finished) return
      finished = true
      if (chunks.length === 0) { resolve(undefined); return }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { code: 'bad_request' }))
      }
    })
    req.on('error', fail)
  })
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

type RuntimeMutationAction =
  | 'select'
  | 'apply'
  | 'apply-now'
  | 'rollback'
  | 'cleanup-version'
  | 'restore-pre-rollback'
  | 'recover-metadata'
  | 'retry-apply'
  | 'retry-restore'
  | 'restore-builtin'
  | 'restart'
  | 'start'
  | 'registry'

const APPLY_RECOVERY_PHASES = new Set(['snapshot-failed', 'swap-attempted'])

/**
 * Durable recovery state is an authoritative terminal gate, not merely UI
 * copy. A recovery phase takes precedence over a lingering `pending` value:
 * it exposes exactly its matching retry (desktop parity, 2026 audit R2 —
 * restore-builtin is NOT offered inside an interrupted apply/restore: the
 * shared core re-blocks an armed reset against durable swap/snapshot/restore
 * markers, stopping the dsh for nothing and leaving an armed reset intent
 * that would hijack the later retry's semantics). Ordinary pending exposes
 * only restore-builtin; healthy idle selections keep the full surface
 * (design 18 §9.3).
 *
 * Mid-run metadata drift (2026 audit R4): when the process stays alive past
 * a healthy startup and the CURRENT/OVERRIDE/JOURNAL files go corrupt
 * afterwards, no in-memory block exists yet — status() projects the
 * resolveWorkspace error text as startupBlockedReason AND reports
 * canRecoverMetadata=true (the manager's own recover gate accepts). The
 * free-text blockedReason is not a canonical sentinel, so this gate
 * classifies by the authoritative `canRecoverMetadata` flag: a flagged
 * state opens recover-metadata (and only it) regardless of the reason text
 * or a lingering pending, keeping status/canRecoverMetadata/manager/UI and
 * the recovery route mutually consistent.
 */
function recoveryGateRefusal(
  status: {
    phase?: unknown
    pending?: unknown
    startupBlockedReason?: unknown
    canRecoverMetadata?: unknown
  },
  action: RuntimeMutationAction,
): { error: string; code: 'runtime_pending' | 'runtime_recovery_required' } | null {
  const phase = typeof status.phase === 'string' ? status.phase : 'unknown'
  const retryAction = APPLY_RECOVERY_PHASES.has(phase)
    ? 'retry-apply'
    : phase === 'restore-blocked'
      ? 'retry-restore'
      : null

  if (retryAction !== null) {
    if (action === retryAction) return null
    return {
      error: `runtime recovery ${phase} is required; only ${retryAction} is allowed`,
      code: 'runtime_recovery_required',
    }
  }

  // 2026-12 (M1 review fix): any projected startup block (FATAL metadata or
  // a swap/restore recovery phase projected through startupBlockedReason)
  // closes every ordinary mutation — desktop parity: only the exact recovery
  // surface stays open. Retry routes keep their phase-driven gates above.
  const blockedReason = typeof status.startupBlockedReason === 'string'
    && status.startupBlockedReason !== ''
    ? status.startupBlockedReason
    : null
  // Authoritative recoverability: the status projection derives this from
  // the durable metadata health, not from the (possibly free-text) blocked
  // reason above (R4 mid-run drift classification).
  const canRecoverMetadata = status.canRecoverMetadata === true
  if (blockedReason !== null) {
    const swapLike = blockedReason === 'swap-attempted' || blockedReason === 'snapshot-failed'
    const restoreLike = blockedReason === 'restore-half' || blockedReason === 'restore-incomplete'
    const fatalLike = RECOVERABLE_METADATA_BLOCKS.has(blockedReason)
    // An UNRECOGNIZED blockedReason (free-text resolution error from
    // mid-run metadata drift) must not lock out the very recovery route the
    // projection advertises — recover-metadata opens whenever the status
    // reports canRecoverMetadata, for canonical FATAL sentinels and for
    // drifted free-text reasons alike. Everything else stays closed.
    const recoverOpen = fatalLike
      || (canRecoverMetadata && !swapLike && !restoreLike && blockedReason !== 'env-probe-failed')
    const allowed = (action === 'retry-apply' && swapLike)
      || (action === 'retry-restore' && restoreLike)
      || (action === 'recover-metadata' && recoverOpen)
    if (allowed) {
      // 2026 audit R3 (FATAL + stale pending deadlock): an allowed recovery
      // action returns HERE — a startup block OUTRANKS a lingering pending
      // value. Falling through to the pending terminal gate below would
      // refuse recover-metadata with runtime_pending while restore-builtin
      // (pending's own escape) is simultaneously refused by this block
      // branch — the recovery surface would be fully locked behind a block
      // that only the recovery route can clear (H2: blockOutranksPending
      // only re-labels the projected phase; the gate itself must honor it).
      return null
    }
    // env-probe-failed has NO matching recovery route (the runtime is
    // externally pinned) — say so instead of promising a route that does
    // not exist (A-U2 review): the operator must fix the
    // DSH_GATEWAY_DSH_PATH target and restart the gateway.
    if (blockedReason === 'env-probe-failed') {
      return {
        error: 'runtime startup block env-probe-failed: the DSH_GATEWAY_DSH_PATH runtime failed activation probes; fix the target and restart the gateway (no recovery route applies)',
        code: 'runtime_recovery_required',
      }
    }
    return {
      error: canRecoverMetadata
        ? `runtime startup block ${blockedReason} requires recovery first; only recover-metadata is allowed`
        : `runtime startup block ${blockedReason} requires recovery first; no recovery route matches (restart the gateway if this persists)`,
      code: 'runtime_recovery_required',
    }
  }

  // Same mid-run drift with no projected block text: FATAL metadata
  // corruption beneath an armed pending must not hide recover-metadata
  // behind the pending terminal gate (the pending escape restore-builtin is
  // refused by the manager's durable guard for corrupt metadata —
  // recover-metadata is the actual recovery surface; R4).
  if (action === 'recover-metadata' && canRecoverMetadata) return null

  // The ordinary-pending terminal gate applies only when NO startup block is
  // armed — a blocked startup projects its own recovery surface above and a
  // stale pending must not relabel refusals (H2/2026 audit R3).
  if (blockedReason === null
    && ((status.pending !== null && status.pending !== undefined) || phase === 'pending')) {
    if (action === 'restore-builtin') return null
    // apply-now's semantic premise is exactly this pending/selection state —
    // it is the in-session execution of the armed switch, not a competing
    // mutation (design 18 addendum §5.1). Recovery phases above still refuse it.
    if (action === 'apply-now') return null
    const version = typeof status.pending === 'string' && status.pending !== ''
      ? status.pending
      : 'unknown'
    return {
      error: `runtime version ${version} is pending; only restore-builtin is allowed until the next startup`,
      code: 'runtime_pending',
    }
  }

  return null
}

function rejectRecoveryGate(
  res: ApiResponse,
  status: { phase?: unknown; pending?: unknown; startupBlockedReason?: unknown; canRecoverMetadata?: unknown },
  action: RuntimeMutationAction,
): boolean {
  const refusal = recoveryGateRefusal(status, action)
  if (refusal === null) return false
  json(res, 409, refusal)
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
    json(res, status, { error: message, code: code ?? 'internal_error' })
  }

  async function handle(req: ApiRequest, res: ApiResponse, pathname: string): Promise<boolean> {
    // Exact-prefix boundary: /chamber/runtime and /chamber/runtime/<suffix>
    // only; /chamber/runtimeevil falls through to the chamber surface.
    if (pathname !== '/chamber/runtime' && !pathname.startsWith('/chamber/runtime/')) return false
    const m = manager()
    const suffix = pathname.slice('/chamber/runtime'.length) || '/'
    try {
      if (suffix === '/status' && req.method === 'GET') {
        return json(res, 200, await m.status())
      }
      if (suffix === '/versions' && req.method === 'GET') {
        return json(res, 200, await m.listVersions())
      }
      if (suffix === '/select' && req.method === 'POST') {
        const body = (await readJsonBody(req)) as { version?: unknown } | undefined
        if (body === undefined || typeof body.version !== 'string' || body.version === '') {
          return json(res, 400, { error: 'version is required', code: 'bad_request' })
        }
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'select')) return true
        // Honest acceptance (R7 review): synchronous refusals are answered
        // synchronously, not swallowed behind a fake 202. A managed profile
        // write is a lifecycle writer (design 21 §6.3 decision 6/17): the
        // install window is refused here so select's 202 never precedes the
        // manager fence throw.
        if (m.profileWriteInFlight?.()) {
          return json(res, 409, { error: 'managed profile write in flight (plugin mutation); runtime mutations are refused', code: 'runtime_busy' })
        }
        if (m.mutationInProgress()) {
          return json(res, 409, { error: 'another runtime mutation is in flight', code: 'runtime_busy' })
        }
        if (status.source === 'env') {
          return json(res, 409, { error: 'runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled', code: 'env_override_active' })
        }
        if (status.mutationsAllowed === false) {
          return json(res, 403, { error: 'runtime mutations are read-only on this platform', code: 'platform_read_only' })
        }
        // Async install job: 202 immediately; progress/failure surfaces via
        // /status (operationError).
        void m.select(body.version).catch(error => logger.error(`runtime select failed: ${sanitizeRouteError(error instanceof Error ? error.message : String(error))}`))
        return json(res, 202, { accepted: true, version: body.version })
      }
      if (suffix === '/apply' && req.method === 'POST') {
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'apply')) return true
        return json(res, 200, await m.apply())
      }
      if (suffix === '/apply-now' && req.method === 'POST') {
        // 202: apply-now accepts immediately (mirrors /restart) — the
        // version-switch activation transaction runs in the background and
        // progress is polled via /status (phase 'applying' + honest
        // connectionState). Synchronous refusals are answered synchronously.
        // The manager's synchronous preflight runs INSIDE this try so any
        // throw (platform/env/busy/no_selection/invalid_target/noop_target)
        // lands in the outer catch → fail() writes the 409/403 BEFORE a 202
        // can ever go out (F3 review fix: a preflight throw must project into
        // the response, never be swallowed into a fake 202 whose status never
        // settles). The status-based no_selection precheck is gone: the
        // preflight filters invalidated selections/trees itself.
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'apply-now')) return true
        if (m.mutationInProgress()) {
          return json(res, 409, { error: 'another runtime mutation is in flight', code: 'runtime_busy' })
        }
        if (status.source === 'env') {
          return json(res, 409, { error: 'runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled', code: 'env_override_active' })
        }
        if (status.mutationsAllowed === false) {
          return json(res, 403, { error: 'runtime mutations are read-only on this platform', code: 'platform_read_only' })
        }
        if (status.connectionState !== 'ready' && status.connectionState !== 'degraded') {
          // Mirror /restart: a dsh that never reached ready cannot be switched
          // in-session; recovery is restore-builtin / retry-apply / retry-restore.
          // restart-exhausted is NOT a dedicated refusal (D2) — this gate covers it.
          return json(res, 409, { error: `managed dsh is not running (${status.connectionState}); restore the builtin or retry the interrupted apply/restore before applying now`, code: 'runtime_busy' })
        }
        if (m.applyNowInFlight()) {
          return json(res, 409, { error: 'a runtime apply-now is already in flight', code: 'runtime_busy' })
        }
        const target = m.applyNowPreflight()
        void m.applyNow().catch(error => logger.error(`runtime apply-now failed: ${sanitizeRouteError(error instanceof Error ? error.message : String(error))}`))
        return json(res, 202, { accepted: true, version: target })
      }
      if (suffix === '/rollback' && req.method === 'POST') {
        const body = (await readJsonBody(req)) as { version?: unknown } | undefined
        if (body === undefined || typeof body.version !== 'string' || body.version === '') {
          return json(res, 400, { error: 'version is required', code: 'bad_request' })
        }
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'rollback')) return true
        return json(res, 200, await m.rollback(body.version))
      }
      if (suffix === '/cleanup-version' && req.method === 'POST') {
        // Desktop-parity cleanup (2026-12): ledger-gated deletion of one
        // explicitly installed version tree + store prune. Synchronous 200
        // like /apply; refusals (pending/recovery/env/win32/busy/protected)
        // answer their mapped status synchronously through the manager throw.
        const body = (await readJsonBody(req)) as { version?: unknown } | undefined
        if (body === undefined || typeof body.version !== 'string' || body.version === '') {
          return json(res, 400, { error: 'version is required', code: 'bad_request' })
        }
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'cleanup-version')) return true
        if (m.mutationInProgress()) {
          return json(res, 409, { error: 'another runtime mutation is in flight', code: 'runtime_busy' })
        }
        return json(res, 200, await m.cleanupVersion(body.version))
      }
      if (suffix === '/restore-pre-rollback' && req.method === 'POST') {
        // Desktop-parity pre-rollback data restore (2026-12): stash-name
        // whitelist + re-listing live in the manager; env stays allowed.
        const body = (await readJsonBody(req)) as { stashName?: unknown } | undefined
        if (body === undefined || typeof body.stashName !== 'string' || body.stashName === '') {
          return json(res, 400, { error: 'stashName is required', code: 'bad_request' })
        }
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'restore-pre-rollback')) return true
        if (m.mutationInProgress()) {
          return json(res, 409, { error: 'another runtime mutation is in flight', code: 'runtime_busy' })
        }
        return json(res, 200, await m.restorePreRollback(body.stashName))
      }
      if (suffix === '/recover-metadata' && req.method === 'POST') {
        // Metadata FATAL rescue (2026-12 desktop parity): archives corrupt
        // selection metadata with a full DSH_HOME copy and runs the builtin
        // anchor through the probe gate. Synchronous refusals come from the
        // manager (platform/env/busy/wrong-recovery-phase/no-corruption).
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'recover-metadata')) return true
        if (m.mutationInProgress()) {
          return json(res, 409, { error: 'another runtime mutation is in flight', code: 'runtime_busy' })
        }
        return json(res, 200, await m.recoverMetadata())
      }
      if (suffix === '/retry-apply' && req.method === 'POST') {
        // Resume an interrupted pointer switch (swap-attempted): the startup
        // transaction re-runs and, on a clean verdict, the managed dsh comes
        // up; a still-blocked retry reports the blockedReason honestly.
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'retry-apply')) return true
        return json(res, 200, await m.retryApply())
      }
      if (suffix === '/retry-restore' && req.method === 'POST') {
        // Resume an interrupted snapshot restore (restore-half / restore-
        // incomplete) from the durable journal.
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'retry-restore')) return true
        return json(res, 200, await m.retryRestore())
      }
      if (suffix === '/restore-builtin' && req.method === 'POST') {
        // Route-level gate (desktop parity, A-U4 + R2): restore-builtin is
        // the escape for a PENDING selection or a HEALTHY selection with an
        // override only. Inside an interrupted apply (swap-attempted /
        // snapshot-failed) or data restore (restore-blocked) the shared core
        // re-blocks an armed reset against the durable markers — the gate
        // therefore exposes only the matching retry there (never a reset
        // that would stop the dsh for nothing and leave an armed reset
        // intent behind). A FATAL metadata block or an in-flight writer must
        // resume through its own surface (recover-metadata / mutation
        // completion). The manager adds the hasOverride preflight
        // (runtime_no_override) and the durable-marker guard.
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'restore-builtin')) return true
        return json(res, 200, await m.restoreBuiltin())
      }
      if (suffix === '/restart' && req.method === 'POST') {
        // 202: restart acceptance never blocks on readiness (design 18 §9.3);
        // the transactional restart runs in the background and progress is
        // polled via /status. Synchronous refusals are answered synchronously:
        // installing/applying/pending refuse 409; a dsh that never reached
        // ready refuses 409 (an in-flight restart is single-flight merged by
        // restartLocal).
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'restart')) return true
        if (status.phase === 'applying' || status.phase === 'installing') {
          return json(res, 409, { error: 'runtime mutation in progress; restart refused', code: 'runtime_busy' })
        }
        if (status.connectionState !== 'ready' && status.connectionState !== 'degraded') {
          // Round-4 wording updated for decision 12: restartLocal rejects every
          // non-ready state — the r1 recovery surface is POST
          // /chamber/runtime/start (stopped/error/restart-exhausted), while
          // interrupted apply/restore windows keep their retry/restore routes.
          return json(res, 409, { error: `managed dsh is not running (${status.connectionState}); start the managed dsh (start applies to stopped/error/restart-exhausted) or retry the interrupted apply/restore`, code: 'runtime_busy' })
        }
        if (m.profileWriteInFlight?.()) {
          // design 21 §6.3 (decision 6/17): a restart respawns the managed dsh
          // and its seed thunk writes DSH_HOME — never while a plugin pnpm
          // child holds the profile-write lease.
          return json(res, 409, { error: 'managed profile write in flight (plugin mutation); restart refused', code: 'runtime_busy' })
        }
        if (m.restartInFlight()) {
          return json(res, 409, { error: 'a restart is already in flight', code: 'runtime_busy' })
        }
        void m.restart().catch(error => logger.error(`runtime restart failed: ${sanitizeRouteError(error instanceof Error ? error.message : String(error))}`))
        return json(res, 202, { accepted: true })
      }
      if (suffix === '/start' && req.method === 'POST') {
        // Decision-12 start primitive (design 21 §6.3 r1): bring the managed
        // dsh up from stopped/error/restart-exhausted. 202 semantics mirror
        // /restart: the guarded startLocal runs in the background and progress
        // is polled via /status (start running/ok/failed + operationError).
        // Every synchronous refusal is answered synchronously before any 202:
        // the recovery gate (M1, 2026-12) refuses every startupBlockedReason —
        // phase-less FATAL metadata blocks (journal-corrupt / current-corrupt /
        // override-corrupt / journal-mismatch) included — and recovery phases
        // only expose their matching retry — restore-builtin applies to pending/healthy selections only (2026 audit R2), and a start never
        // bypasses the recovery gate), installing/applying windows refuse
        // busy, a held profile-write lease defers, a second start refuses, and
        // a running/starting dsh is not a start target.
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'start')) return true
        if (status.phase === 'applying' || status.phase === 'installing') {
          return json(res, 409, { error: 'runtime mutation in progress; start refused', code: 'runtime_busy' })
        }
        if (m.profileWriteInFlight?.()) {
          return json(res, 409, { error: 'managed profile write in flight (plugin mutation); start refused', code: 'runtime_busy' })
        }
        if (m.startInFlight?.()) {
          return json(res, 409, { error: 'a start is already in flight', code: 'runtime_busy' })
        }
        if (status.connectionState !== 'stopped' && status.connectionState !== 'error'
          && status.connectionState !== 'restart-exhausted') {
          return json(res, 409, { error: `managed dsh is running (${status.connectionState}); start applies to stopped/error/restart-exhausted`, code: 'runtime_busy' })
        }
        void m.start().catch(error => logger.error(`runtime start failed: ${sanitizeRouteError(error instanceof Error ? error.message : String(error))}`))
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
        const status = await m.status()
        if (rejectRecoveryGate(res, status, 'registry')) return true
        return json(res, 200, await m.setRegistry(body.origin))
      }
      if (suffix === '/' || suffix === '') {
        return json(res, 200, { routes: ['status', 'versions', 'select', 'apply', 'apply-now', 'rollback', 'cleanup-version', 'restore-pre-rollback', 'recover-metadata', 'restore-builtin', 'restart', 'start', 'retry-apply', 'retry-restore', 'registry'] })
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
