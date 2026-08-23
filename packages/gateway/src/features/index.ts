/**
 * Session index (design 16 §8.2): a DERIVED projection over the dsh mux/host
 * streams — session presence + the lightweight `session/projection` facts
 * (sessionListMetadata). The index is never authoritative: `session.list`
 * remains the reconnect authority (chamber discipline); this module only
 * caches a projection and replays it after a dsh restart.
 *
 * It consumes control/projection frames ONLY — it never parses the
 * `session/event` body (session business belongs to the dsh frontend runtime).
 */

import { openEventStream, type Logger } from '@dsh-chamber/control-plane'

export interface SessionProjection {
  sessionId: string
  title?: string
  /** sessionListMetadata object (design 16 §8.2; the api contract key). */
  metadata?: Record<string, unknown>
  updatedAt: number
}

export interface SessionIndex {
  start(): void
  stop(): void
  list(): SessionProjection[]
  get(sessionId: string): SessionProjection | undefined
  /** Reset after a reconnect (design 16 §8.2: refetch session.list, replay). */
  clear(): void
}

export function createSessionIndex(deps: {
  getDshBaseUrl(): string | null
  logger: Logger
}): SessionIndex {
  const projections = new Map<string, SessionProjection>()
  let abort: AbortController | null = null

  async function consume(baseUrl: string, signal: AbortSignal): Promise<void> {
    try {
      for await (const frame of openEventStream(baseUrl, '/api/events.mux', signal)) {
        if (frame.method === 'session/subscribed') {
          const p = frame.payload
          if (typeof p.sessionId === 'string') {
            projections.set(p.sessionId, { sessionId: p.sessionId, updatedAt: Date.now() })
          }
        } else if (frame.method === 'session/projection') {
          const p = frame.payload
          if (typeof p.sessionId === 'string') {
            const prev = projections.get(p.sessionId) ?? { sessionId: p.sessionId, updatedAt: Date.now() }
            projections.set(p.sessionId, {
              ...prev,
              ...(typeof p.title === 'string' ? { title: p.title } : {}),
              ...(typeof p.sessionListMetadata === 'object' && p.sessionListMetadata !== null
                ? { metadata: p.sessionListMetadata as Record<string, unknown> } : {}),
              updatedAt: Date.now(),
            })
          }
        }
        // session/event and approval/question frames are deliberately NOT
        // consumed here (session business / notifier's domain).
      }
    } catch (error) {
      if (!signal.aborted) deps.logger.warn(`session-index: mux stream ended: ${String(error)}`)
    }
  }

  return {
    start(): void {
      if (abort !== null) return
      const baseUrl = deps.getDshBaseUrl()
      if (baseUrl === null) return
      const controller = new AbortController()
      abort = controller
      void consume(baseUrl, controller.signal)
    },
    stop(): void {
      if (abort !== null) {
        abort.abort()
        abort = null
      }
    },
    list(): SessionProjection[] {
      return [...projections.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    },
    get(sessionId: string): SessionProjection | undefined {
      return projections.get(sessionId)
    },
    clear(): void {
      projections.clear()
    },
  }
}
