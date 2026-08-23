/**
 * Feature-host routes (design 16 §8.5): the gateway's own orchestration
 * surface `/chamber/*`, all behind the auth gate (dispatch.ts). Wires the git
 * worktree offload (features/git.ts) and leaves the remaining orchestration
 * features (session index, approvals, cron, settings) as clear placeholders.
 *
 * Every route reads/writes gateway-owned state; the authoritative dsh facts
 * come from dsh `/api` through features/git.ts — the gateway never becomes
 * authoritative over host business (design 16 §10, chamber discipline).
 */

import type { ApiRequest, ApiResponse, Logger } from '@dsh-chamber/control-plane'
import {
  GitFeatureError,
  createWorktree,
  deleteWorktree,
  type WorktreeRecord,
} from './features/git.ts'
import { createApprovalNotifier, type ApprovalRequest } from './features/notify.ts'
import { createScheduler } from './features/schedule.ts'
import { createSessionIndex } from './features/index.ts'
import type { ChannelRegistry } from './channels.ts'
import type { GatewayStore, ScheduleStoreRecord, WorktreeStoreRecord } from './store.ts'

export interface FeatureHostDeps {
  /** The managed local dsh loopback origin (http://127.0.0.1:<port>); null when not ready. */
  getDshBaseUrl(): string | null
  logger: Logger
  /** The gateway persistence layer (design 16 §10). */
  store: GatewayStore
  /** The channel registry (design 16 §7; MVP empty). */
  channels: ChannelRegistry
}

export interface FeatureHost {
  /** Handle a `/chamber/*` request. Returns true when the path was claimed
   * (including a 404 for an unknown /chamber route). */
  handle(req: ApiRequest, res: ApiResponse, pathname: string): Promise<boolean>
  /** Start the background stream consumers (notifier + index). Must be called
   * AFTER the control plane is assigned (getDshBaseUrl resolves), else they
   * no-op on a null base URL and never reconnect. */
  start(): void
  /** Stop the background stream consumers + scheduler (gateway stop). */
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
    const MAX = 1024 * 1024 // 1 MiB, ample for orchestration payloads
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX) {
        reject(new GitFeatureError('body_too_large', 'request body exceeds 1 MiB'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new GitFeatureError('bad_request', 'request body is not valid JSON'))
      }
    })
    req.on('error', reject)
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
  store.worktrees.load()
  const worktrees = new Map<string, WorktreeRecord>(
    store.worktrees.get().items.map(r => [r.workspaceId, r] as const),
  )

  function persistWorktrees(): void {
    const items = [...worktrees.values()]
    void store.worktrees.mutate(() => ({ next: { items }, changed: true }))
  }

  function requireDsh(): string {
    const baseUrl = getDshBaseUrl()
    if (baseUrl === null) throw new GitFeatureError('instance_unavailable', 'the local dsh instance is not ready')
    return baseUrl
  }

  // Approval/notification + cron + session-index (design 16 §8.3/§8.4/§8.2).
  // The notifier + index start lazily here; they no-op until dsh is ready.
  const pendingApprovals: ApprovalRequest[] = []
  // SSE clients for /chamber/notifications + /chamber/approvals (EventSource).
  const sseClients = new Set<ApiResponse>()
  function broadcastSse(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of [...sseClients]) {
      try { client.write(frame) } catch { sseClients.delete(client) }
    }
  }
  const notifier = createApprovalNotifier({
    getDshBaseUrl,
    logger,
    onApproval: req => {
      pendingApprovals.push(req)
      broadcastSse('approval', req)
    },
    onQuestion: req => { broadcastSse('question', req) },
  })
  const scheduler = createScheduler({ getDshBaseUrl, logger })
  const sessionIndex = createSessionIndex({ getDshBaseUrl, logger })
  // NOTE: notifier/sessionIndex are started lazily via FeatureHost.start() —
  // starting here (before the plane holder is assigned) would no-op on a null
  // base URL and never reconnect (design 16 review H4).

  // Persist the schedule to gateway/schedule.json (§10) + re-arm persisted
  // jobs on startup (ids are regenerated; a job's identity is its target+prompt).
  function persistSchedule(): void {
    const items: ScheduleStoreRecord[] = scheduler.list().map(j => ({
      id: j.id, delayMs: j.delayMs, intervalMs: j.intervalMs, targetSessionId: j.targetSessionId, prompt: j.prompt,
    }))
    void store.schedule.mutate(() => ({ next: { items }, changed: true }))
  }
  store.schedule.load()
  for (const job of store.schedule.get().items) {
    scheduler.schedule({ delayMs: job.delayMs, intervalMs: job.intervalMs, targetSessionId: job.targetSessionId, prompt: job.prompt })
  }

  async function handle(req: ApiRequest, res: ApiResponse, pathname: string): Promise<boolean> {
    // /chamber/git/worktrees
    if (pathname === '/chamber/git/worktrees' || pathname === '/chamber/git/worktrees/') {
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
          const record = await createWorktree({
            dshBaseUrl: requireDsh(),
            repo: body.repo,
            branch: body.branch,
            newPath: body.newPath,
            ...(typeof body.agentPreset === 'string' ? { agentPreset: body.agentPreset } : {}),
          })
          worktrees.set(record.workspaceId, record)
          persistWorktrees()
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
      const workspaceId = worktreeMatch[1]
      const record = worktrees.get(workspaceId)
      if (record === undefined) {
        json(res, 404, { error: 'not_found', code: 'not_found' })
        return true
      }
      try {
        const body = await readJsonBody(req) as { repo?: unknown; deleteBranch?: unknown }
        if (!isSafeAbsolutePath(body.repo)) {
          json(res, 400, { error: 'invalid_input', code: 'invalid_input' })
          return true
        }
        await deleteWorktree({
          dshBaseUrl: requireDsh(),
          workspaceId: record.workspaceId,
          repo: body.repo,
          path: record.path,
          branch: record.branch,
          ...(body.deleteBranch === true ? { deleteBranch: true } : {}),
        })
        worktrees.delete(workspaceId)
        persistWorktrees()
        json(res, 200, { deleted: true })
      } catch (error) {
        featureError(res, error, logger)
      }
      return true
    }

    // /chamber/approvals: GET (JSON poll | SSE when Accept: text/event-stream),
    // POST answer.
    if (pathname === '/chamber/approvals') {
      if (req.method === 'GET') {
        const accept = headerValue(req.headers, 'accept') ?? ''
        if (accept.includes('text/event-stream')) {
          // SSE mode (design 16 §8.5): replay the pending queue, then push.
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
          res.write('retry: 3000\n\n')
          for (const a of [...pendingApprovals]) res.write(`event: approval\ndata: ${JSON.stringify(a)}\n\n`)
          sseClients.add(res)
          req.on('close', () => sseClients.delete(res))
          return true
        }
        json(res, 200, { items: pendingApprovals })
        return true
      }
      if (req.method === 'POST') {
        try {
          const body = await readJsonBody(req) as { rpcId?: unknown; outcome?: unknown }
          const target = pendingApprovals.find(a => a.rpcId === body.rpcId)
          if (target === undefined || (body.outcome !== 'allowed-once' && body.outcome !== 'rejected')) {
            json(res, 400, { error: 'invalid_input', code: 'invalid_input' })
            return true
          }
          await notifier.answerApproval(target, body.outcome)
          pendingApprovals.splice(pendingApprovals.indexOf(target), 1)
          json(res, 200, { answered: true })
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
      json(res, 200, { items: sessionIndex.list() })
      return true
    }

    // /chamber/schedule: GET list, POST schedule, DELETE /:id cancel.
    if (pathname === '/chamber/schedule') {
      if (req.method === 'GET') {
        json(res, 200, { items: scheduler.list() })
        return true
      }
      if (req.method === 'POST') {
        try {
          const body = await readJsonBody(req) as { delayMs?: unknown; intervalMs?: unknown; targetSessionId?: unknown; prompt?: unknown }
          const delayMs = body.delayMs
          const intervalMs = typeof body.intervalMs === 'number' ? body.intervalMs : null
          // delayMs must be a finite non-negative number; intervalMs (when
          // present) a finite number ≥ 1s — a zero/negative/NaN interval would
          // otherwise busy-loop session.prompt (review M6).
          if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0
            || typeof body.targetSessionId !== 'string' || typeof body.prompt !== 'string'
            || (intervalMs !== null && (!Number.isFinite(intervalMs) || intervalMs < 1000))) {
            json(res, 400, { error: 'invalid_input', code: 'invalid_input' })
            return true
          }
          const job = scheduler.schedule({
            delayMs,
            intervalMs,
            targetSessionId: body.targetSessionId,
            prompt: body.prompt,
          })
          persistSchedule()
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
      const cancelled = scheduler.cancel(scheduleMatch[1])
      persistSchedule()
      json(res, 200, { cancelled })
      return true
    }

    // /chamber/channels: the channel registry projection (§7; MVP empty).
    if (pathname === '/chamber/channels') {
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
          if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            json(res, 400, { error: 'invalid_input', code: 'invalid_input' })
            return true
          }
          const next = { ...(store.settings.get()), ...(body as Record<string, unknown>) }
          await store.settings.mutate(() => ({ next, changed: true }))
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
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write('retry: 3000\n\n')
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return true
    }

    // P4 static assets (design 16 §8.5/§9): PWA manifest + SW registration +
    // mobile light surface + the (empty) service worker.
    if (pathname === '/chamber/manifest.webmanifest') {
      serveAsset(res, 'application/manifest+json', MANIFEST_WEBMANIFEST)
      return true
    }
    if (pathname === '/chamber/sw-register.js') {
      serveAsset(res, 'application/javascript', SW_REGISTER_JS)
      return true
    }
    if (pathname === '/chamber/sw.js') {
      serveAsset(res, 'application/javascript', '/* dsh gateway service worker (empty) */\n')
      return true
    }
    if (pathname === '/chamber/mobile.html') {
      serveAsset(res, 'text/html; charset=utf-8', MOBILE_HTML)
      return true
    }

    // Unknown /chamber/* → 404 (claimed, so the default dispatch does not run).
    json(res, 404, { error: 'not_found', code: 'not_found' })
    return true
  }

  return {
    handle,
    start(): void {
      notifier.start()
      sessionIndex.start()
    },
    stop(): void {
      notifier.stop()
      sessionIndex.stop()
      scheduler.stop()
    },
  }
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

// ---------------------------------------------------------------------------
// P4 static assets (design 16 §8.5/§9): the gateway's own minimal PWA +
// mobile light surface. Served at /chamber/* — the ONLY gateway-owned frontend
// assets besides the login page.
// ---------------------------------------------------------------------------

const MANIFEST_WEBMANIFEST = JSON.stringify({
  name: 'dsh gateway',
  short_name: 'dsh',
  start_url: '/',
  display: 'standalone',
  background_color: '#0b0f14',
  theme_color: '#0b0f14',
})

const SW_REGISTER_JS = `// dsh gateway service-worker registration (design 16 §9, P4).
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
  <p>Mobile light surface (design 16 §9, P4).</p>
  <p><a href="/" style="color:#58a6ff">Open the full dsh frontend →</a></p>
</main>
`

/** Serve a gateway-owned static asset at a /chamber/* path. */
function serveAsset(res: ApiResponse, contentType: string, body: string): void {
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
  res.end(body)
}

function featureError(res: ApiResponse, error: unknown, logger: Logger): void {
  if (error instanceof GitFeatureError) {
    const status = error.code === 'instance_unavailable' ? 503
      : error.code === 'bad_request' || error.code === 'body_too_large' ? 400
        : error.code === 'not_found' ? 404
          : 500
    json(res, status, { error: error.message, code: error.code })
    return
  }
  logger.warn(`feature-host: ${String(error)}`)
  json(res, 500, { error: 'internal', code: 'internal' })
}
