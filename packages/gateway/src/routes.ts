/**
 * Feature-host routes (design 17 §8.5): the gateway's own orchestration
 * surface `/chamber/*`, all behind the auth gate (dispatch.ts). Wires the git
 * worktree offload (features/git.ts), the session index, approvals/questions,
 * scheduler, settings, notifications, and the browser dashboard.
 *
 * Every route reads/writes gateway-owned state; the authoritative dsh facts
 * come from dsh `/api` through features/git.ts — the gateway never becomes
 * authoritative over host business (design 17 §10, chamber discipline).
 */

import {
  call,
  respond,
  type ApiRequest,
  type ApiResponse,
  type Logger,
  type ServerRequest,
} from '@dsh-chamber/control-plane'
import {
  GitFeatureError,
  createWorktree,
  deleteWorktree,
  type WorktreeRecord,
} from './features/git.ts'
import {
  AnswerRejectedError,
  createApprovalNotifier,
  type ApprovalRequest,
  type QuestionRequest,
} from './features/notify.ts'
import { MAX_TIMER_DELAY_MS, createScheduler } from './features/schedule.ts'
import { createSessionIndex } from './features/index.ts'
import type { ChannelRegistry } from './channels.ts'
import type { GatewayStore, ScheduleStoreRecord, WorktreeStoreRecord } from './store.ts'

export interface FeatureHostDeps {
  /** The managed local dsh loopback origin (http://127.0.0.1:<port>); null when not ready. */
  getDshBaseUrl(): string | null
  logger: Logger
  /** The gateway persistence layer (design 17 §10). */
  store: GatewayStore
  /** The channel registry (design 17 §7; MVP empty). */
  channels: ChannelRegistry
  /** Narrow test/runtime seams shared by the index and notifier. */
  featureTransport?: {
    callDsh?: typeof call
    respondDsh?: typeof respond
    openStream?: (
      baseUrl: string,
      path: string,
      signal?: AbortSignal,
      onOpen?: () => void,
    ) => AsyncIterable<ServerRequest>
    reconnectDelayMs?: number
  }
}

export interface FeatureHost {
  /** Handle a `/chamber/*` request. Returns true when the path was claimed
   * (including a 404 for an unknown /chamber route). */
  handle(req: ApiRequest, res: ApiResponse, pathname: string): Promise<boolean>
  /** Attach background consumers/timers. Safe before readiness and idempotent. */
  start(): void
  /** Detach consumers and timers. Job definitions remain for reconnect. */
  stop(): void
}

function json(res: ApiResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readJsonBody(req: ApiRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    const MAX = 1024 * 1024 // 1 MiB, ample for orchestration payloads
    req.on('data', (chunk: Buffer) => {
      if (failed) return
      size += chunk.length
      if (size > MAX) {
        failed = true
        chunks.length = 0
        reject(new GitFeatureError('body_too_large', 'request body exceeds 1 MiB'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (failed) return
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new GitFeatureError('bad_request', 'request body is not valid JSON'))
      }
    })
    req.on('error', error => {
      if (failed) return
      failed = true
      chunks.length = 0
      reject(error)
    })
  })
}

export function createFeatureHost(deps: FeatureHostDeps): FeatureHost {
  const { getDshBaseUrl, logger, store, channels } = deps
  function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
    const v = headers[name]
    return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined
  }
  // Worktree records persist in gateway/worktrees.json (§10); a live lookup
  // overlays the in-memory set (recovered on load) with the just-created row.
  store.settings.load()
  store.worktrees.load()
  const worktrees = new Map<string, WorktreeRecord>(
    store.worktrees.get().items.map(r => [r.workspaceId, r] as const),
  )

  // Route mutations share one tail: each response observes its own durable
  // write, concurrent requests cannot overwrite a newer in-memory snapshot,
  // and a rejected write does not poison later writes.
  let persistenceTail: Promise<void> = Promise.resolve()
  async function serializePersistence(operation: () => Promise<void>): Promise<void> {
    const run = persistenceTail.then(operation, operation)
    persistenceTail = run.catch(() => {})
    await run
  }

  async function persistWorktree(record: WorktreeRecord): Promise<void> {
    await serializePersistence(() => store.worktrees.mutate(doc => ({
      next: { items: [...doc.items.filter(item => item.workspaceId !== record.workspaceId), record] },
      changed: true,
    })))
    worktrees.set(record.workspaceId, record)
  }

  async function persistWorktreeRemoval(workspaceId: string): Promise<void> {
    await serializePersistence(() => store.worktrees.mutate(doc => ({
      next: { items: doc.items.filter(item => item.workspaceId !== workspaceId) },
      changed: doc.items.some(item => item.workspaceId === workspaceId),
    })))
    worktrees.delete(workspaceId)
  }

  function writeScheduleItems(items: ScheduleStoreRecord[]): Promise<void> {
    return store.schedule.mutate(() => ({ next: { items }, changed: true }))
  }

  async function persistScheduleItems(items: ScheduleStoreRecord[]): Promise<void> {
    await serializePersistence(() => writeScheduleItems(items))
  }

  function requireDsh(): string {
    const baseUrl = getDshBaseUrl()
    if (baseUrl === null) throw new GitFeatureError('instance_unavailable', 'the local dsh instance is not ready')
    return baseUrl
  }

  // Approval/notification + cron + session-index (design 17 §8.3/§8.4/§8.2).
  // The notifier + index start lazily here; they no-op until dsh is ready.
  const pendingApprovals = new Map<string, ApprovalRequest>()
  const pendingQuestions = new Map<string, QuestionRequest>()
  // SSE clients for /chamber/notifications + /chamber/approvals (EventSource).
  const sseClients = new Set<ApiResponse>()
  function attachSse(client: ApiResponse): void {
    sseClients.add(client)
    const remove = () => sseClients.delete(client)
    client.on('close', remove)
    client.on('error', remove)
  }
  function writeSse(client: ApiResponse, frame: string): boolean {
    try {
      if (client.write(frame)) return true
    } catch { /* close below */ }
    sseClients.delete(client)
    try { client.end() } catch { /* already closed */ }
    return false
  }
  function broadcastSse(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of [...sseClients]) {
      writeSse(client, frame)
    }
  }
  const notifier = createApprovalNotifier({
    getDshBaseUrl,
    logger,
    ...(deps.featureTransport?.openStream === undefined ? {} : { openStream: deps.featureTransport.openStream }),
    ...(deps.featureTransport?.respondDsh === undefined ? {} : { respondDsh: deps.featureTransport.respondDsh }),
    ...(deps.featureTransport?.reconnectDelayMs === undefined ? {} : { reconnectDelayMs: deps.featureTransport.reconnectDelayMs }),
    onApproval: req => {
      pendingApprovals.set(req.rpcId, req)
      broadcastSse('approval', req)
    },
    onQuestion: req => {
      pendingQuestions.set(req.rpcId, req)
      broadcastSse('question', req)
    },
    onApprovalResolved: (sessionId, approvalId) => {
      for (const [rpcId, request] of pendingApprovals) {
        if (request.sessionId === sessionId && request.approvalId === approvalId) {
          pendingApprovals.delete(rpcId)
          broadcastSse('approval-resolved', { rpcId, sessionId, approvalId })
        }
      }
    },
    onQuestionResolved: questionRpcId => {
      if (pendingQuestions.delete(questionRpcId)) {
        broadcastSse('question-resolved', { rpcId: questionRpcId })
      }
    },
    onGenerationStart: () => {
      pendingApprovals.clear()
      pendingQuestions.clear()
      broadcastSse('pending-reset', {})
    },
  })
  const scheduler = createScheduler({
    getDshBaseUrl,
    logger,
    ...(deps.featureTransport?.callDsh === undefined ? {} : { callDsh: deps.featureTransport.callDsh }),
    onJobsChanged: jobs => persistScheduleItems(jobs),
  })
  const sessionIndex = createSessionIndex({
    getDshBaseUrl,
    logger,
    ...(deps.featureTransport?.callDsh === undefined ? {} : { callDsh: deps.featureTransport.callDsh }),
    ...(deps.featureTransport?.openStream === undefined ? {} : { openStream: deps.featureTransport.openStream }),
    ...(deps.featureTransport?.reconnectDelayMs === undefined ? {} : { reconnectDelayMs: deps.featureTransport.reconnectDelayMs }),
  })

  // Restore exact ids; definitions are armed only by FeatureHost.start(), and
  // survive a dsh detach/reattach cycle.
  store.schedule.load()
  for (const job of store.schedule.get().items) {
    if (isStoredSchedule(job)) scheduler.restore(job)
    else logger.warn(`feature-host: ignored invalid persisted schedule ${String(job?.id)}`)
  }

  type FeatureFlags = { git: boolean; notifications: boolean; schedule: boolean }
  const readFeatureFlags = (): FeatureFlags => {
    const settings = store.settings.get()
    return {
      git: settings.git?.enabled === true,
      notifications: settings.notifications?.enabled === true,
      schedule: settings.schedule?.enabled === true,
    }
  }
  const featureEnabled = (feature: keyof FeatureFlags): boolean => readFeatureFlags()[feature]
  let hostStarted = false

  function detachNotifications(): void {
    notifier.stop()
    if (pendingApprovals.size > 0 || pendingQuestions.size > 0 || sseClients.size > 0) {
      broadcastSse('pending-reset', {})
    }
    pendingApprovals.clear()
    pendingQuestions.clear()
    for (const client of [...sseClients]) {
      try { client.end() } catch { /* already closed */ }
    }
    sseClients.clear()
  }

  function applyFeatureFlags(previous: FeatureFlags, next: FeatureFlags): void {
    if (previous.notifications !== next.notifications) {
      if (next.notifications) {
        if (hostStarted) notifier.start()
      } else {
        detachNotifications()
      }
    }
    if (previous.schedule !== next.schedule) {
      if (next.schedule) {
        if (hostStarted) scheduler.start()
      } else {
        scheduler.stop()
      }
    }
  }

  async function handle(req: ApiRequest, res: ApiResponse, pathname: string): Promise<boolean> {
    // /chamber/git/worktrees
    if (pathname === '/chamber/git/worktrees' || pathname === '/chamber/git/worktrees/') {
      if (!featureEnabled('git')) return featureDisabled(res)
      if (req.method === 'GET') {
        json(res, 200, { items: [...worktrees.values()] })
        return true
      }
      if (req.method === 'POST') {
        try {
          const body = await readJsonBody(req) as { repo?: unknown; branch?: unknown; newPath?: unknown; agentPreset?: unknown }
          // repo/newPath must be absolute filesystem paths; branch must be a
          // safe git ref (no leading '-', no shell/option metacharacters) —
          // a token holder must not drive `git` against arbitrary repos/args.
          if (!isSafeAbsolutePath(body.repo) || !isSafeBranch(body.branch) || !isSafeAbsolutePath(body.newPath)) {
            json(res, 400, { error: 'invalid_input', code: 'invalid_input' })
            return true
          }
          let record: WorktreeRecord
          try {
            record = await createWorktree({
              dshBaseUrl: requireDsh(),
              repo: body.repo,
              branch: body.branch,
              newPath: body.newPath,
              ...(typeof body.agentPreset === 'string' ? { agentPreset: body.agentPreset } : {}),
            })
          } catch (createError) {
            if (createError instanceof GitFeatureError && createError.recovery !== undefined) {
              try {
                await persistWorktree(createError.recovery)
              } catch (persistError) {
                worktrees.set(createError.recovery.workspaceId, createError.recovery)
                logger.warn(`feature-host: failed to persist recovery record: ${String(persistError)}`)
              }
            }
            throw createError
          }
          try {
            await persistWorktree(record)
          } catch (persistError) {
            // The session is already published. A storage failure cannot
            // authorize deleting user work; retain an in-memory recovery row.
            worktrees.set(record.workspaceId, record)
            throw new GitFeatureError('persistence_failed', `failed to persist worktree: ${String(persistError)}`)
          }
          json(res, 200, record)
        } catch (error) {
          featureError(res, error, logger)
        }
        return true
      }
      json(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
      return true
    }

    // /chamber/git/worktrees/<workspaceId> (DELETE)
    const worktreeMatch = /^\/chamber\/git\/worktrees\/([a-zA-Z0-9_-]+)$/.exec(pathname)
    if (worktreeMatch !== null && req.method === 'DELETE') {
      if (!featureEnabled('git')) return featureDisabled(res)
      const workspaceId = worktreeMatch[1]
      const record = worktrees.get(workspaceId)
      if (record === undefined) {
        json(res, 404, { error: 'not_found', code: 'not_found' })
        return true
      }
      try {
        const body = await readJsonBody(req)
        if (body === null || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body as Record<string, unknown>).length !== 0) {
          json(res, 400, { error: 'delete_body_not_allowed', code: 'delete_body_not_allowed' })
          return true
        }
        if (typeof record.repo !== 'string' || record.repo === '') {
          throw new GitFeatureError('unsafe_legacy_record', 'worktree record predates server-derived repository authority')
        }
        if (record.ownership !== 'owned') {
          throw new GitFeatureError(
            'unsafe_recovery_record',
            'worktree ownership is not verified; explicit reconciliation is required before deletion',
          )
        }
        const resumeAfterGitRemoval = record.state === 'deleting'
        const deleting: WorktreeRecord = { ...record, state: 'deleting' }
        await persistWorktree(deleting)
        await deleteWorktree({
          dshBaseUrl: requireDsh(),
          workspaceId: record.workspaceId,
          repo: record.repo,
          path: record.path,
          branch: record.branch,
          ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
          ...(resumeAfterGitRemoval ? { resumeAfterGitRemoval: true } : {}),
        })
        await persistWorktreeRemoval(workspaceId)
        json(res, 200, { deleted: true })
      } catch (error) {
        featureError(res, error, logger)
      }
      return true
    }

    // /chamber/approvals: GET (JSON poll | SSE when Accept: text/event-stream),
    // POST answer.
    if (pathname === '/chamber/approvals') {
      if (!featureEnabled('notifications')) return featureDisabled(res)
      if (req.method === 'GET') {
        const accept = headerValue(req.headers, 'accept') ?? ''
        if (accept.includes('text/event-stream')) {
          // SSE mode (design 17 §8.5): replay the pending queue, then push.
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
          if (!writeSse(res, 'retry: 3000\n\n')) return true
          for (const a of pendingApprovals.values()) {
            if (!writeSse(res, `event: approval\ndata: ${JSON.stringify(a)}\n\n`)) return true
          }
          for (const question of pendingQuestions.values()) {
            if (!writeSse(res, `event: question\ndata: ${JSON.stringify(question)}\n\n`)) return true
          }
          attachSse(res)
          return true
        }
        json(res, 200, {
          items: [
            ...[...pendingApprovals.values()].map(request => ({ kind: 'approval', ...request })),
            ...[...pendingQuestions.values()].map(request => ({ kind: 'question', ...request })),
          ],
        })
        return true
      }
      if (req.method === 'POST') {
        try {
          const body = await readJsonBody(req) as { rpcId?: unknown; outcome?: unknown; answer?: unknown }
          const rpcId = typeof body.rpcId === 'string' ? body.rpcId : null
          const approval = rpcId === null ? undefined : pendingApprovals.get(rpcId)
          const question = rpcId === null ? undefined : pendingQuestions.get(rpcId)
          if (approval !== undefined && (body.outcome === 'allowed-once' || body.outcome === 'rejected')) {
            await notifier.answerApproval(approval, body.outcome)
            pendingApprovals.delete(approval.rpcId)
            broadcastSse('approval-resolved', {
              rpcId: approval.rpcId,
              sessionId: approval.sessionId,
              approvalId: approval.approvalId,
            })
            json(res, 200, { answered: true, kind: 'approval' })
            return true
          }
          if (question !== undefined && isQuestionAnswer(body.answer)) {
            await notifier.answerQuestion(question, body.answer)
            pendingQuestions.delete(question.rpcId)
            broadcastSse('question-resolved', { rpcId: question.rpcId })
            json(res, 200, { answered: true, kind: 'question' })
            return true
          }
          {
            json(res, 400, { error: 'invalid_input', code: 'invalid_input' })
            return true
          }
        } catch (error) {
          featureError(res, error, logger)
        }
        return true
      }
      json(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
      return true
    }

    // /chamber/sessions: the derived session-index projection.
    if (pathname === '/chamber/sessions') {
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
        return true
      }
      json(res, 200, { items: sessionIndex.list() })
      return true
    }

    // /chamber/schedule: GET list, POST schedule, DELETE /:id cancel.
    if (pathname === '/chamber/schedule') {
      if (!featureEnabled('schedule')) return featureDisabled(res)
      if (req.method === 'GET') {
        json(res, 200, { items: scheduler.list() })
        return true
      }
      if (req.method === 'POST') {
        try {
          const body = await readJsonBody(req) as { delayMs?: unknown; intervalMs?: unknown; targetSessionId?: unknown; prompt?: unknown }
          const delayMs = body.delayMs
          const validIntervalShape = body.intervalMs === undefined || body.intervalMs === null || typeof body.intervalMs === 'number'
          const intervalMs = typeof body.intervalMs === 'number' ? body.intervalMs : null
          // delayMs must be a finite non-negative number; intervalMs (when
          // present) a finite number ≥ 1s — a zero/negative/NaN interval would
          // otherwise busy-loop session.prompt (review M6).
          if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_TIMER_DELAY_MS
            || typeof body.targetSessionId !== 'string' || typeof body.prompt !== 'string'
            || !validIntervalShape
            || (intervalMs !== null && (!Number.isFinite(intervalMs) || intervalMs < 1000 || intervalMs > MAX_TIMER_DELAY_MS))) {
            json(res, 400, { error: 'invalid_input', code: 'invalid_input' })
            return true
          }
          let job!: ReturnType<typeof scheduler.schedule>
          await serializePersistence(async () => {
            job = scheduler.schedule({
              delayMs,
              intervalMs,
              targetSessionId: body.targetSessionId as string,
              prompt: body.prompt as string,
            })
            try {
              await writeScheduleItems(scheduler.list())
            } catch (persistError) {
              scheduler.cancel(job.id)
              throw new GitFeatureError('persistence_failed', `failed to persist schedule: ${String(persistError)}`)
            }
          })
          json(res, 200, job)
        } catch (error) {
          featureError(res, error, logger)
        }
        return true
      }
      json(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
      return true
    }
    const scheduleMatch = /^\/chamber\/schedule\/([a-zA-Z0-9_-]+)$/.exec(pathname)
    if (scheduleMatch !== null && req.method === 'DELETE') {
      if (!featureEnabled('schedule')) return featureDisabled(res)
      try {
        const id = scheduleMatch[1]
        let exists = false
        await serializePersistence(async () => {
          exists = scheduler.list().some(job => job.id === id)
          if (!exists) return
          await writeScheduleItems(scheduler.list().filter(job => job.id !== id))
          scheduler.cancel(id)
        })
        json(res, 200, { cancelled: exists })
      } catch (error) {
        featureError(res, error, logger)
      }
      return true
    }

    // /chamber/channels: the channel registry projection (§7; MVP empty).
    if (pathname === '/chamber/channels') {
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
        return true
      }
      json(res, 200, { items: channels.list() })
      return true
    }

    // /chamber/settings: the gateway's own orchestration settings (§8.5/§10).
    if (pathname === '/chamber/settings' || pathname === '/chamber/settings/') {
      if (req.method === 'GET') {
        json(res, 200, store.settings.get())
        return true
      }
      if (req.method === 'PUT') {
        try {
          const body = await readJsonBody(req)
          const patch = decodeSettingsPatch(body)
          if (patch === null) {
            json(res, 400, { error: 'invalid_input', code: 'invalid_input' })
            return true
          }
          await serializePersistence(async () => {
            const previous = readFeatureFlags()
            await store.settings.mutate(current => {
              const changed = (patch.git !== undefined && patch.git.enabled !== current.git?.enabled)
                || (patch.notifications !== undefined && patch.notifications.enabled !== current.notifications?.enabled)
                || (patch.schedule !== undefined && patch.schedule.enabled !== current.schedule?.enabled)
              return { next: { ...current, ...patch }, changed }
            })
            applyFeatureFlags(previous, readFeatureFlags())
          })
          json(res, 200, store.settings.get())
        } catch (error) {
          featureError(res, error, logger)
        }
        return true
      }
      json(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
      return true
    }

    // /chamber/notifications: SSE push of approval/question events (§8.5/§8.3).
    if (pathname === '/chamber/notifications') {
      if (!featureEnabled('notifications')) return featureDisabled(res)
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
        return true
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      if (!writeSse(res, 'retry: 3000\n\n')) return true
      attachSse(res)
      return true
    }

    // Gateway-owned browser orchestration surface (design 17 D6 / §8.5).
    // It is already behind dispatch.ts's mandatory auth gate. The document
    // uses an external same-origin script so the control-plane CSP can keep
    // inline script closed; neither asset accepts credentials in its URL.
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

    // P4 static assets (design 17 §8.5/§9): PWA manifest + SW registration +
    // mobile light surface + the (empty) service worker.
    if (pathname === '/chamber/manifest.webmanifest') {
      if (!isAssetMethod(req.method)) return methodNotAllowed(res)
      serveAsset(res, 'application/manifest+json', MANIFEST_WEBMANIFEST, req.method === 'HEAD')
      return true
    }
    if (pathname === '/chamber/sw-register.js') {
      if (!isAssetMethod(req.method)) return methodNotAllowed(res)
      serveAsset(res, 'application/javascript', SW_REGISTER_JS, req.method === 'HEAD')
      return true
    }
    if (pathname === '/chamber/sw.js') {
      if (!isAssetMethod(req.method)) return methodNotAllowed(res)
      serveAsset(res, 'application/javascript', '/* dsh gateway service worker (empty) */\n', req.method === 'HEAD')
      return true
    }
    if (pathname === '/chamber/mobile.html') {
      if (!isAssetMethod(req.method)) return methodNotAllowed(res)
      serveAsset(res, 'text/html; charset=utf-8', MOBILE_HTML, req.method === 'HEAD')
      return true
    }

    // Unknown /chamber/* → 404 (claimed, so the default dispatch does not run).
    json(res, 404, { error: 'not_found', code: 'not_found' })
    return true
  }

  return {
    handle,
    start(): void {
      if (hostStarted) return
      hostStarted = true
      sessionIndex.start()
      const flags = readFeatureFlags()
      if (flags.notifications) notifier.start()
      if (flags.schedule) scheduler.start()
    },
    stop(): void {
      hostStarted = false
      detachNotifications()
      sessionIndex.stop()
      scheduler.stop()
    },
  }
}

function isStoredSchedule(value: ScheduleStoreRecord): boolean {
  return typeof value?.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(value.id)
    && typeof value.delayMs === 'number' && Number.isFinite(value.delayMs)
    && value.delayMs >= 0 && value.delayMs <= MAX_TIMER_DELAY_MS
    && (value.intervalMs === null || (typeof value.intervalMs === 'number' && Number.isFinite(value.intervalMs)
      && value.intervalMs >= 1_000 && value.intervalMs <= MAX_TIMER_DELAY_MS))
    && typeof value.targetSessionId === 'string' && value.targetSessionId !== ''
    && typeof value.prompt === 'string'
}

interface SettingsPatch {
  git?: { enabled: boolean }
  notifications?: { enabled: boolean }
  schedule?: { enabled: boolean }
}

/** Decode the complete public settings write vocabulary. Store-owned
 * schemaVersion/revision and unknown future namespaces are never writable
 * through this endpoint. */
function decodeSettingsPatch(value: unknown): SettingsPatch | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  const patch: SettingsPatch = {}
  for (const key of Object.keys(body)) {
    if (key !== 'git' && key !== 'notifications' && key !== 'schedule') return null
    const section = body[key]
    if (section === null || typeof section !== 'object' || Array.isArray(section)) return null
    const fields = Object.keys(section as Record<string, unknown>)
    if (fields.length !== 1 || fields[0] !== 'enabled') return null
    const enabled = (section as { enabled?: unknown }).enabled
    if (typeof enabled !== 'boolean') return null
    if (key === 'git') patch.git = { enabled }
    else if (key === 'notifications') patch.notifications = { enabled }
    else patch.schedule = { enabled }
  }
  return patch
}

/** Absolute-filesystem-path check: no relative form, no option injection, no
 * NUL (the git argv boundaries). */
function isSafeAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0')
}

/** Branch name: no leading '-' (git option injection), restricted charset. */
function isSafeBranch(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
    && !value.startsWith('-') && /^[a-zA-Z0-9._/-]+$/.test(value)
}

/** Cheap route-boundary validation for the public question response shape.
 * The dsh host remains authoritative and validates ids/options against the
 * exact pending question before returning an accepted receipt. */
function isQuestionAnswer(value: unknown): value is {
  answers: Array<{ id: string; selected: string[]; custom?: string }>
} {
  if (value === null || typeof value !== 'object' || !Array.isArray((value as { answers?: unknown }).answers)) return false
  return (value as { answers: unknown[] }).answers.every(item => {
    if (item === null || typeof item !== 'object') return false
    const row = item as { id?: unknown; selected?: unknown; custom?: unknown }
    return typeof row.id === 'string' && row.id !== ''
      && Array.isArray(row.selected) && row.selected.every(option => typeof option === 'string')
      && new Set(row.selected).size === row.selected.length
      && (row.custom === undefined || (typeof row.custom === 'string' && row.custom.trim() !== ''))
  })
}

// ---------------------------------------------------------------------------
// Gateway-owned browser assets (design 17 D6 / §8.5/§9). The full dsh frontend
// remains proxied at `/`; `/chamber/` is a deliberately small orchestration
// control surface backed only by gateway-owned routes.
// ---------------------------------------------------------------------------

const CHAMBER_APP_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'"

const CHAMBER_APP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>dsh gateway orchestration</title>
  <style>
    :root{color-scheme:dark;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#0b0f14;color:#e6edf3}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:#0b0f14}header{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem max(1rem,calc((100vw - 74rem)/2));border-bottom:1px solid #30363d;background:rgba(11,15,20,.96)}
    h1,h2,h3,p{margin:0}h1{font-size:1.15rem}h2{font-size:1rem}h3{font-size:.9rem}.subtle,.status,small{color:#8b949e}.header-actions,.actions{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
    main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;max-width:74rem;margin:0 auto;padding:1rem}.panel{min-width:0;display:flex;flex-direction:column;gap:.75rem;padding:1rem;border:1px solid #30363d;border-radius:.75rem;background:#161b22}.wide{grid-column:1/-1}
    button,a.button{display:inline-flex;align-items:center;justify-content:center;min-height:2rem;padding:.35rem .75rem;border:1px solid #484f58;border-radius:1rem;background:#21262d;color:#e6edf3;font:inherit;font-size:.82rem;text-decoration:none;cursor:pointer}button.primary{border-color:#238636;background:#238636}button.danger{border-color:#da3633;color:#ff7b72}button:disabled{opacity:.5;cursor:default}button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid #58a6ff;outline-offset:2px}
    fieldset{display:flex;flex-direction:column;gap:.55rem;margin:0;padding:.75rem;border:1px solid #30363d;border-radius:.6rem}legend{padding:0 .3rem;font-weight:600}.toggle,.choice{display:flex;align-items:flex-start;gap:.5rem;font-size:.9rem}.choice small{display:block;margin-top:.15rem}.custom{display:flex;flex-direction:column;gap:.3rem;font-size:.8rem;color:#8b949e}.custom input{width:100%;padding:.45rem .55rem;border:1px solid #484f58;border-radius:.4rem;background:#0d1117;color:#e6edf3}
    .list{display:flex;flex-direction:column;gap:.6rem}.item{display:flex;flex-direction:column;gap:.35rem;padding:.75rem;border-radius:.55rem;background:#0d1117;overflow-wrap:anywhere}.item-head{display:flex;justify-content:space-between;gap:.75rem;align-items:baseline}.item-head strong{min-width:0}.meta,code{color:#8b949e;font-size:.75rem;overflow-wrap:anywhere;white-space:pre-wrap}.body{font-size:.86rem;white-space:pre-wrap;overflow-wrap:anywhere}.status{min-height:1.2rem;font-size:.8rem}.status.error,.error{color:#ff7b72}.empty{padding:.5rem 0;color:#8b949e;font-size:.85rem}
    @media(max-width:760px){header{align-items:flex-start}main{grid-template-columns:1fr}.wide{grid-column:auto}.header-actions{justify-content:flex-end}}
  </style>
</head>
<body>
  <header>
    <div><h1>dsh gateway</h1><p class="subtle">Authenticated orchestration</p></div>
    <div class="header-actions"><a class="button" href="/">Open dsh</a><button id="refresh" type="button">Refresh</button></div>
  </header>
  <main>
    <section class="panel" aria-labelledby="settings-title">
      <h2 id="settings-title">Feature settings</h2>
      <p id="settings-status" class="status" role="status">Loading…</p>
      <fieldset id="settings-fields" disabled>
        <label class="toggle"><input id="setting-git" type="checkbox">Git worktree orchestration</label>
        <label class="toggle"><input id="setting-notifications" type="checkbox">Notifications</label>
        <label class="toggle"><input id="setting-schedule" type="checkbox">Cross-session scheduling</label>
      </fieldset>
      <div class="actions"><button id="save-settings" class="primary" type="button" disabled>Save settings</button></div>
    </section>
    <section class="panel" aria-labelledby="sessions-title">
      <h2 id="sessions-title">Sessions</h2><p id="sessions-status" class="status" role="status">Loading…</p><div id="sessions" class="list"></div>
    </section>
    <section class="panel wide" aria-labelledby="approvals-title">
      <h2 id="approvals-title">Pending approvals and questions</h2><p id="approvals-status" class="status" role="status">Loading…</p><div id="approvals" class="list"></div>
    </section>
    <section class="panel" aria-labelledby="schedule-title">
      <h2 id="schedule-title">Schedule</h2><p id="schedule-status" class="status" role="status">Loading…</p><div id="schedule" class="list"></div>
    </section>
    <section class="panel" aria-labelledby="worktrees-title">
      <h2 id="worktrees-title">Worktrees</h2><p id="worktrees-status" class="status" role="status">Loading…</p><div id="worktrees" class="list"></div>
    </section>
  </main>
  <script defer src="/chamber/app.js"></script>
</body>
</html>
`

const CHAMBER_APP_JS = `(function () {
  'use strict';
  var MAX_ROWS = 200;
  var liveRefreshRunning = false;
  function byId(id) { return document.getElementById(id); }
  function ownRecord(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed ' + label + ' response');
    return value;
  }
  function ownItems(value, label) {
    var rows = ownRecord(value, label).items;
    if (!Array.isArray(rows)) throw new Error('Malformed ' + label + ' response');
    return rows;
  }
  function requiredText(row, key, label) {
    if (typeof row[key] !== 'string' || row[key].length === 0) throw new Error('Malformed ' + label + ' response');
    return row[key];
  }
  function optionalText(row, key, label) {
    if (row[key] === undefined) return undefined;
    if (typeof row[key] !== 'string') throw new Error('Malformed ' + label + ' response');
    return row[key];
  }
  function bounded(value, limit) {
    var text = typeof value === 'string' ? value : String(value);
    return text.length <= limit ? text : text.slice(0, limit) + '…';
  }
  function element(tag, text, className) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = bounded(text, 4000);
    if (className) node.className = className;
    return node;
  }
  function status(name, text, failed) {
    var node = byId(name + '-status');
    node.textContent = text;
    node.className = failed ? 'status error' : 'status';
  }
  function renderList(name, rows, render, emptyText) {
    var root = byId(name);
    var fragment = document.createDocumentFragment();
    rows.slice(0, MAX_ROWS).forEach(function (row) { fragment.appendChild(render(row)); });
    if (rows.length === 0) fragment.appendChild(element('p', emptyText, 'empty'));
    if (rows.length > MAX_ROWS) fragment.appendChild(element('p', String(rows.length - MAX_ROWS) + ' more rows not shown', 'empty'));
    root.replaceChildren(fragment);
  }
  async function request(path, options) {
    var input = options || {};
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    var hasBody = Object.prototype.hasOwnProperty.call(input, 'body');
    try {
      var response = await fetch(path, {
        method: input.method || 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: Object.assign({ accept: 'application/json' }, hasBody ? { 'content-type': 'application/json' } : {}),
        body: hasBody ? JSON.stringify(input.body) : undefined,
        signal: controller.signal
      });
      if (!response.ok) throw new Error('Request failed (HTTP ' + response.status + ')');
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }
  function itemShell(title, meta) {
    var item = element('article', undefined, 'item');
    var head = element('div', undefined, 'item-head');
    head.appendChild(element('strong', title));
    if (meta) head.appendChild(element('span', meta, 'meta'));
    item.appendChild(head);
    return item;
  }
  function appendMeta(item, text) { if (text) item.appendChild(element('code', text)); }

  function applySettings(value) {
    var row = ownRecord(value, 'settings');
    function enabled(key) {
      var group = row[key];
      return group !== null && typeof group === 'object' && !Array.isArray(group) && group.enabled === true;
    }
    byId('setting-git').checked = enabled('git');
    byId('setting-notifications').checked = enabled('notifications');
    byId('setting-schedule').checked = enabled('schedule');
    byId('settings-fields').disabled = false;
    byId('save-settings').disabled = false;
    status('settings', typeof row.revision === 'number' ? 'Revision ' + row.revision : 'Ready', false);
  }
  async function loadSettings() {
    status('settings', 'Loading…', false);
    try { applySettings(await request('/chamber/settings')); }
    catch (error) { status('settings', error instanceof Error ? error.message : 'Settings unavailable', true); }
  }
  async function saveSettings() {
    var button = byId('save-settings');
    button.disabled = true;
    status('settings', 'Saving…', false);
    try {
      applySettings(await request('/chamber/settings', { method: 'PUT', body: {
        git: { enabled: byId('setting-git').checked === true },
        notifications: { enabled: byId('setting-notifications').checked === true },
        schedule: { enabled: byId('setting-schedule').checked === true }
      } }));
    } catch (error) {
      status('settings', error instanceof Error ? error.message : 'Save failed', true);
      button.disabled = false;
    }
  }

  async function loadSessions() {
    try {
      var rows = ownItems(await request('/chamber/sessions'), 'sessions').map(function (value) {
        var row = ownRecord(value, 'session');
        if (typeof row.running !== 'boolean' || typeof row.blank !== 'boolean' || typeof row.updatedAt !== 'number') throw new Error('Malformed session response');
        return { sessionId: requiredText(row, 'sessionId', 'session'), title: optionalText(row, 'title', 'session'), cwd: optionalText(row, 'cwd', 'session'), running: row.running, updatedAt: row.updatedAt };
      });
      renderList('sessions', rows, function (row) {
        var item = itemShell(row.title || row.sessionId, row.running ? 'running' : 'stopped');
        if (row.title) appendMeta(item, row.sessionId);
        appendMeta(item, row.cwd);
        if (Number.isFinite(row.updatedAt)) item.appendChild(element('small', new Date(row.updatedAt).toLocaleString()));
        return item;
      }, 'No sessions.');
      status('sessions', String(rows.length) + ' session(s)', false);
    } catch (error) { status('sessions', error instanceof Error ? error.message : 'Sessions unavailable', true); }
  }

  function setCardBusy(card, busy) {
    card.querySelectorAll('button,input').forEach(function (control) { control.disabled = busy; });
  }
  async function submitInteraction(card, body) {
    var localStatus = element('p', 'Submitting…', 'status');
    card.appendChild(localStatus);
    setCardBusy(card, true);
    try {
      await request('/chamber/approvals', { method: 'POST', body: body });
      await loadApprovals();
    } catch (error) {
      localStatus.textContent = error instanceof Error ? error.message : 'Answer failed';
      localStatus.className = 'status error';
      setCardBusy(card, false);
    }
  }
  function normalizeQuestion(value) {
    var row = ownRecord(value, 'question');
    if (!Array.isArray(row.options)) throw new Error('Malformed question response');
    var options = row.options.map(function (value) {
      var option = ownRecord(value, 'question option');
      return { label: requiredText(option, 'label', 'question option'), description: optionalText(option, 'description', 'question option') };
    });
    return { id: requiredText(row, 'id', 'question'), header: optionalText(row, 'header', 'question'), question: requiredText(row, 'question', 'question'), detail: optionalText(row, 'detail', 'question'), multiSelect: row.multiSelect === true, options: options };
  }
  function renderApproval(row) {
    var card = itemShell('Approval: ' + requiredText(row, 'toolName', 'approval'), requiredText(row, 'sessionId', 'approval'));
    var reason = optionalText(row, 'reason', 'approval');
    if (reason) card.appendChild(element('p', reason, 'body'));
    var actions = element('div', undefined, 'actions');
    var reject = element('button', 'Reject', 'danger'); reject.type = 'button';
    var allow = element('button', 'Allow once', 'primary'); allow.type = 'button';
    var rpcId = requiredText(row, 'rpcId', 'approval');
    reject.addEventListener('click', function () { void submitInteraction(card, { rpcId: rpcId, outcome: 'rejected' }); });
    allow.addEventListener('click', function () { void submitInteraction(card, { rpcId: rpcId, outcome: 'allowed-once' }); });
    actions.append(reject, allow); card.appendChild(actions); return card;
  }
  function renderQuestion(row) {
    var rpcId = requiredText(row, 'rpcId', 'question');
    var card = itemShell('Question', requiredText(row, 'sessionId', 'question'));
    if (!Array.isArray(row.questions)) throw new Error('Malformed question response');
    var questions = row.questions.map(normalizeQuestion);
    var states = questions.map(function (question) {
      var fieldset = element('fieldset');
      fieldset.appendChild(element('legend', question.header || question.question));
      if (question.header) fieldset.appendChild(element('p', question.question, 'body'));
      if (question.detail) fieldset.appendChild(element('p', question.detail, 'subtle'));
      var inputs = [];
      question.options.forEach(function (option) {
        var label = element('label', undefined, 'choice');
        var input = document.createElement('input'); input.type = question.multiSelect ? 'checkbox' : 'radio'; input.name = 'q-' + rpcId + '-' + question.id; input.value = option.label;
        var text = element('span', option.label); if (option.description) text.appendChild(element('small', option.description));
        label.append(input, text); fieldset.appendChild(label); inputs.push(input);
      });
      var customLabel = element('label', undefined, 'custom'); customLabel.appendChild(element('span', 'Additional answer (optional)'));
      var custom = document.createElement('input'); custom.type = 'text'; customLabel.appendChild(custom); fieldset.appendChild(customLabel); card.appendChild(fieldset);
      return { id: question.id, inputs: inputs, custom: custom };
    });
    var submit = element('button', 'Submit answer', 'primary'); submit.type = 'button';
    submit.addEventListener('click', function () {
      var answers = states.map(function (state) {
        var answer = { id: state.id, selected: state.inputs.filter(function (input) { return input.checked; }).map(function (input) { return input.value; }) };
        var custom = state.custom.value.trim(); if (custom) answer.custom = custom; return answer;
      });
      void submitInteraction(card, { rpcId: rpcId, answer: { answers: answers } });
    });
    card.appendChild(submit); return card;
  }
  async function loadApprovals() {
    try {
      var rows = ownItems(await request('/chamber/approvals'), 'approvals').map(function (value) {
        var row = ownRecord(value, 'interaction');
        if (row.kind !== 'approval' && row.kind !== 'question') throw new Error('Malformed interaction response');
        return row;
      });
      renderList('approvals', rows, function (row) { return row.kind === 'approval' ? renderApproval(row) : renderQuestion(row); }, 'No pending interactions.');
      status('approvals', String(rows.length) + ' pending', false);
    } catch (error) { status('approvals', error instanceof Error ? error.message : 'Interactions unavailable', true); }
  }

  async function loadSchedule() {
    try {
      var rows = ownItems(await request('/chamber/schedule'), 'schedule').map(function (value) {
        var row = ownRecord(value, 'scheduled job');
        if (typeof row.delayMs !== 'number' || (row.intervalMs !== null && typeof row.intervalMs !== 'number')) throw new Error('Malformed schedule response');
        return { id: requiredText(row, 'id', 'scheduled job'), target: requiredText(row, 'targetSessionId', 'scheduled job'), prompt: requiredText(row, 'prompt', 'scheduled job'), delayMs: row.delayMs, intervalMs: row.intervalMs };
      });
      renderList('schedule', rows, function (row) {
        var item = itemShell(row.target, row.intervalMs === null ? 'once' : 'repeats');
        item.appendChild(element('p', row.prompt, 'body')); appendMeta(item, 'delay ' + row.delayMs + 'ms' + (row.intervalMs === null ? '' : ' · interval ' + row.intervalMs + 'ms')); return item;
      }, 'No scheduled jobs.');
      status('schedule', String(rows.length) + ' job(s)', false);
    } catch (error) { status('schedule', error instanceof Error ? error.message : 'Schedule unavailable', true); }
  }

  async function loadWorktrees() {
    try {
      var rows = ownItems(await request('/chamber/git/worktrees'), 'worktrees').map(function (value) {
        var row = ownRecord(value, 'worktree');
        return { workspaceId: requiredText(row, 'workspaceId', 'worktree'), branch: requiredText(row, 'branch', 'worktree'), path: requiredText(row, 'path', 'worktree'), state: requiredText(row, 'state', 'worktree'), sessionId: optionalText(row, 'sessionId', 'worktree'), error: optionalText(row, 'error', 'worktree') };
      });
      renderList('worktrees', rows, function (row) {
        var item = itemShell(row.branch, row.state); appendMeta(item, row.path); appendMeta(item, row.sessionId ? 'session ' + row.sessionId : undefined); if (row.error) item.appendChild(element('p', row.error, 'error')); return item;
      }, 'No worktree records.');
      status('worktrees', String(rows.length) + ' worktree(s)', false);
    } catch (error) { status('worktrees', error instanceof Error ? error.message : 'Worktrees unavailable', true); }
  }

  async function refreshLive() {
    if (liveRefreshRunning) return;
    liveRefreshRunning = true;
    try { await Promise.allSettled([loadSessions(), loadApprovals(), loadSchedule(), loadWorktrees()]); }
    finally { liveRefreshRunning = false; }
  }
  byId('save-settings').addEventListener('click', function () { void saveSettings(); });
  byId('refresh').addEventListener('click', function () { void Promise.allSettled([loadSettings(), refreshLive()]); });
  void Promise.allSettled([loadSettings(), refreshLive()]);
  setInterval(function () { void refreshLive(); }, 10000);
}());
`

const MANIFEST_WEBMANIFEST = JSON.stringify({
  name: 'dsh gateway',
  short_name: 'dsh',
  start_url: '/',
  display: 'standalone',
  background_color: '#0b0f14',
  theme_color: '#0b0f14',
})

const SW_REGISTER_JS = `// dsh gateway service-worker registration (design 17 §9, P4).
// No-op for now: registers an empty worker so the PWA installs and later
// offline/cache behavior can be added without changing the registration point.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/chamber/sw.js').catch(() => {})
}
`

const MOBILE_HTML = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh gateway</title>
<style>body{font-family:system-ui;background:#0b0f14;color:#e6edf3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}</style>
<main style="text-align:center;padding:2rem">
  <h1>dsh gateway</h1>
  <p>Mobile light surface (design 17 §9, P4).</p>
  <p><a href="/" style="color:#58a6ff">Open the full dsh frontend →</a></p>
</main>
`

/** Serve a gateway-owned static asset at a /chamber/* path. */
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
  json(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
  return true
}

function featureDisabled(res: ApiResponse): true {
  json(res, 403, { error: 'feature_disabled', code: 'feature_disabled' })
  return true
}

function featureError(res: ApiResponse, error: unknown, logger: Logger): void {
  // Upstream-unavailable (managed dsh not ready): explicit 503, never a
  // misleading 500 internal (S4). Shared by the notifier and git feature.
  if ((error as { code?: unknown })?.code === 'instance_unavailable') {
    json(res, 503, { error: 'instance_unavailable', code: 'instance_unavailable' })
    return
  }
  if (error instanceof AnswerRejectedError) {
    json(res, 409, { error: error.message, code: error.code, reason: error.reason })
    return
  }
  if (error instanceof GitFeatureError) {
    const status = error.code === 'instance_unavailable' ? 503
      : error.code === 'bad_request' || error.code === 'body_too_large' || error.code === 'invalid_input'
        || error.code === 'invalid_target' ? 400
        : error.code === 'target_exists' || error.code === 'unsafe_legacy_record'
          || error.code === 'unsafe_recovery_record' || error.code === 'worktree_in_use' ? 409
          : error.code === 'session_list_failed' || error.code === 'session_liveness_unknown' ? 503
          : error.code === 'repo_not_allowed' || error.code === 'worktree_not_allowed' ? 403
        : error.code === 'not_found' ? 404
          : 500
    json(res, status, { error: error.message, code: error.code })
    return
  }
  logger.warn(`feature-host: ${String(error)}`)
  json(res, 500, { error: 'internal', code: 'internal' })
}
