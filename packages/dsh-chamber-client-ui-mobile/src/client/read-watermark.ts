/**
 * Mobile read-watermark reporter (design 17 §18).
 *
 * THE GAP. When the user reads a session on the gateway-hosted phone client,
 * the desktop must stop showing that session's completed-unread dot. The two
 * surfaces share ONE comparison domain — the gateway's session-state mirror —
 * but nothing on the phone ever told the mirror that the reader caught up, so
 * "phone read it, desktop still lights" was the documented asymmetry.
 *
 * THIS MODULE closes it with three deliberately small pieces:
 *   1. the current session id comes from the OFFICIAL session list service
 *      (`ctx.sessions.list.getSnapshot()` — the only authoritative source; the
 *      mobile DOM carries no session-id anchor, see markup.ts), and the plugin
 *      therefore injects `sessions` (an official service, no new dependency);
 *   2. the read watermark comes from the GATEWAY MIRROR row
 *      (`GET /chamber/session-state` → `max(updatedAt, completedAt)`), NEVER
 *      from the phone's wall clock: read marks and the unread comparison live
 *      in the host domain only (§5-13);
 *   3. the mark is POSTed to `/chamber/session-state/read` with a per-install
 *      client id, monotonically (same/lower watermark is dropped) and throttled.
 *
 * FAIL-CLOSED, LIKE EVERYTHING ELSE IN THIS PACKAGE: an absent service, a
 * missing row, a rejected fetch or a non-2xx response is silently ignored —
 * read marks are an optimisation of the OTHER surface, never a dependency of
 * this one. Nothing here throws into the shell.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'

/** Layout-independent slice of one mirror row we need (host domain). */
export interface ReadWatermarkRow {
  updatedAt?: number
  completedAt?: number
}

/** The official session list face (structural slice; no provider types needed). */
export interface OfficialSessionsFace {
  list?: {
    getSnapshot?: () => { current?: string; sessions?: Array<{ sessionId?: string } & ReadWatermarkRow> } | undefined
    subscribe?: (listener: () => void) => (() => void) | undefined
  }
}

export const READ_CLIENT_ID_KEY = 'dsh-chamber.mobile.read-client'
/** Re-report the same session at most this often (visibility flips are chatty). */
export const MIN_REPORT_INTERVAL_MS = 5_000
export const SNAPSHOT_PATH = '/chamber/session-state'
export const READ_PATH = '/chamber/session-state/read'

/** Host-domain watermark of one mirror row: `max(updatedAt, completedAt)`, 0 = unknown. */
export function rowWatermark(row: ReadWatermarkRow | undefined): number {
  if (row === undefined) return 0
  const updated = typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0
  const completed = typeof row.completedAt === 'number' && Number.isFinite(row.completedAt) ? row.completedAt : 0
  return Math.max(updated, completed)
}

export interface ReadStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Per-install client id, persisted; `makeId` is injected so tests stay pure. */
export function resolveReadClientId(storage: ReadStorage, makeId: () => string): string {
  try {
    const existing = storage.getItem(READ_CLIENT_ID_KEY)
    if (existing !== null && /^[a-z0-9-]{8,64}$/.test(existing)) return existing
    const created = makeId()
    storage.setItem(READ_CLIENT_ID_KEY, created)
    return created
  } catch {
    // Private mode / disabled storage: still works, just not stable across loads.
    return makeId()
  }
}

export interface ReadReporter {
  /** Report a watermark for a session; same-or-lower marks are dropped. */
  report(sessionId: string, watermark: number): void
  dispose(): void
}

/**
 * Monotonic + throttled reporter. A session's watermark may only increase
 * (the mirror merges with max anyway — this just avoids pointless traffic),
 * and repeated reports of the same session inside `minIntervalMs` are dropped.
 */
export function createReadWatermarkReporter(deps: {
  post: (sessionId: string, watermark: number) => void
  now?: () => number
  minIntervalMs?: number
}): ReadReporter {
  const now = deps.now ?? (() => Date.now())
  const minInterval = deps.minIntervalMs ?? MIN_REPORT_INTERVAL_MS
  const seen = new Map<string, number>()
  const lastAt = new Map<string, number>()
  let disposed = false
  return {
    report(sessionId: string, watermark: number): void {
      if (disposed || sessionId === '' || watermark <= 0) return
      const previous = seen.get(sessionId) ?? 0
      if (watermark <= previous) return
      const at = now()
      const last = lastAt.get(sessionId)
      if (last !== undefined && at - last < minInterval) {
        // Inside the throttle window: remember the higher mark so a later
        // report can still land, but do not send now.
        seen.set(sessionId, Math.min(watermark, previous))
        return
      }
      seen.set(sessionId, watermark)
      lastAt.set(sessionId, at)
      try {
        deps.post(sessionId, watermark)
      } catch {
        // A throwing transport must never reach the shell.
      }
    },
    dispose(): void {
      disposed = true
      seen.clear()
      lastAt.clear()
    },
  }
}

/** Fire-and-forget POST; resolves false on any failure (never rejects). */
export async function postReadMark(
  fetchImpl: typeof fetch,
  url: string,
  body: { clientId: string; sessionId: string; readThrough: number },
): Promise<boolean> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return response.ok === true
  } catch {
    return false
  }
}

export interface ReadWatermarkDeps {
  sessions: OfficialSessionsFace | undefined
  fetchImpl: typeof fetch
  getClientId: () => string
  reporter: ReadReporter
  /** Base URL for the mirror ('' = same origin, the gateway deployment). */
  base?: string
}

/**
 * One reconciliation pass: current session (official list) → its watermark
 * (gateway mirror) → mark. Returns the reported session id or null.
 */
export async function reportCurrentSession(deps: ReadWatermarkDeps): Promise<string | null> {
  const snapshot = deps.sessions?.list?.getSnapshot?.()
  const current = snapshot?.current
  if (typeof current !== 'string' || current === '') return null
  let row: ReadWatermarkRow | undefined
  try {
    const response = await deps.fetchImpl((deps.base ?? '') + SNAPSHOT_PATH + '?clientId=' + encodeURIComponent(deps.getClientId()), { method: 'GET' })
    if (!response.ok) return null
    const body = await response.json() as { sessions?: Record<string, ReadWatermarkRow> } | null
    row = body?.sessions?.[current]
  } catch {
    return null
  }
  const watermark = rowWatermark(row)
  if (watermark <= 0) return null
  deps.reporter.report(current, watermark)
  return current
}

/**
 * Install the mobile read-watermark loop: it reconciles when the page becomes
 * visible/focused and whenever the official list changes (if it is observable).
 * Returns a disposer; every path is exception-safe.
 */
export function installMobileReadWatermark(
  ctx: ClientContext,
  deps: {
    doc?: Document
    window?: Window
    fetchImpl?: typeof fetch
    storage?: ReadStorage
    base?: string
    now?: () => number
    /** Test seam: called instead of the real fetch for the mark POST. */
    postMark?: (body: { clientId: string; sessionId: string; readThrough: number }) => void
  } = {},
): () => void {
  const doc = deps.doc ?? document
  const win = deps.window ?? window
  const fetchImpl = deps.fetchImpl ?? fetch
  let storage: ReadStorage | undefined = deps.storage
  if (storage === undefined) {
    try { storage = win.localStorage } catch { storage = undefined }
  }
  let clientId: string | null = null
  const getClientId = (): string => {
    if (clientId === null) {
      clientId = storage === undefined
        ? 'mobile-' + Math.random().toString(36).slice(2, 12)
        : resolveReadClientId(storage, () => 'mobile-' + Math.random().toString(36).slice(2, 12))
    }
    return clientId
  }
  const reporter = createReadWatermarkReporter({
    now: deps.now,
    post: (sessionId, watermark) => {
      const body = { clientId: getClientId(), sessionId, readThrough: watermark }
      if (deps.postMark !== undefined) {
        deps.postMark(body)
        return
      }
      void postReadMark(fetchImpl, (deps.base ?? '') + READ_PATH, body)
    },
  })
  const sessions = (() => {
    try {
      return (ctx as unknown as { sessions?: OfficialSessionsFace }).sessions
    } catch {
      return undefined
    }
  })()
  const pass = (): void => {
    void reportCurrentSession({ sessions, fetchImpl, getClientId, reporter, base: deps.base }).catch(() => {})
  }
  const onVisibility = (): void => { if (doc.visibilityState === 'visible') pass() }
  doc.addEventListener('visibilitychange', onVisibility)
  win.addEventListener('focus', pass)
  let unsubscribe: (() => void) | undefined
  try {
    unsubscribe = sessions?.list?.subscribe?.(pass) ?? undefined
  } catch {
    unsubscribe = undefined
  }
  pass()
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility)
    win.removeEventListener('focus', pass)
    if (typeof unsubscribe === 'function') unsubscribe()
    reporter.dispose()
  }
}
