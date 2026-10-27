/**
 * /chamber/session-state SSE surface: the bounded per-stream backpressure queue,
 * keepalive comments that never carry an id, close on response teardown, the stream
 * cap and the idempotent closeAllStreams. Split out of session-state.ts (B3-1); the
 * factory and its three limits are the whole module.
 */
import {
  SESSION_STATE_PATH, SESSION_STATE_STREAM_PATH,
  type ApiRequest, type ApiResponse, type SessionStateDelta, type SessionStateMode,
  type SessionStateSnapshot,
} from '@dsh-chamber/control-plane'
import { jsonResponse } from '../http-utils.ts'
import type { ChamberSessionState, ChamberSessionStateDeps } from '../session-state-types.ts'

/** Concurrent SSE streams per surface. */
export const MAX_SSE_STREAMS = 32
/** Queued frames for one backpressured SSE stream. */
export const MAX_SSE_PENDING_FRAMES = 32
/** SSE keepalive cadence. */
export const SSE_KEEPALIVE_MS = 20_000
/**
 * The /chamber/session-state surface, mirroring the control-plane SSE discipline:
 * a bounded per-stream backpressure queue, keepalive comments that never carry an
 * id, close on response teardown, a 32-stream cap and an idempotent closeAllStreams.
 * The SSE id is the store cursor: a satisfiable Last-Event-ID resumes from the ring,
 * anything else (expired, ahead, forged) falls back to a snapshot.
 */
export function createChamberSessionState(deps: ChamberSessionStateDeps): ChamberSessionState {
  const enabled = deps.enabled
  const maxStreams = deps.maxStreams ?? MAX_SSE_STREAMS
  const keepaliveMs = deps.keepaliveMs ?? SSE_KEEPALIVE_MS
  const activeStreams = new Set<() => void>()
  let streamCount = 0

  function mode(): SessionStateMode {
    return deps.observer.status().mode
  }

  function snapshot(): SessionStateSnapshot {
    const base = deps.store.snapshotFor(mode(), deps.observer.hostInfo())
    const observer = deps.observer.status()
    const storeStatus = deps.store.status()
    // 只读自诊断骑在描述符的加法字段上：丢帧/重连/follow 失败可见，不必从沉默推断。
    return {
      ...base,
      diagnostics: {
        eventsReceived: observer.eventsReceived,
        lastEventAt: observer.lastEventAt ?? 0,
        // S4/T2：listComplete 闩锁的唯一来源是 store 的完整基线计数——observer 的
        // muxBaselines 只覆盖 sse 档 reconcile，poll 档（无 ready 帧）永远为 0。
        baselines: storeStatus.baselines,
        reconnects: observer.reconnects,
        followReads: observer.followReads,
        followFailures: observer.followFailures,
        heldWaterfalls: observer.heldWaterfalls,
        mode: observer.mode,
        degraded: observer.degraded,
        turnEnds: storeStatus.turnEnds,
        dropped: storeStatus.dropped,
        cursor: storeStatus.cursor,
      },
    }
  }

  function parseLastEventId(req: ApiRequest): number | null {
    const headers = req.headers ?? {}
    const raw = headers['last-event-id'] ?? headers['Last-Event-ID']
    const value = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined
    if (value === undefined) return null
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
  }

  function openStream(req: ApiRequest, res: ApiResponse): boolean {
    if (streamCount >= maxStreams) {
      res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: 'resource_exhausted', code: 'resource_exhausted' }))
      return true
    }
    const lastEventId = parseLastEventId(req)
    streamCount += 1
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      ...((res as ApiResponse & { _corsHeaders?: Record<string, string> })._corsHeaders ?? {}),
    })
    let tornDown = false
    let backpressured = false
    let keepalive: ReturnType<typeof setInterval> | null = null
    let release: (() => void) | null = null
    let live = false
    let overflow = false
    const buffered: SessionStateDelta[] = []
    const pendingFrames: string[] = []
    const teardown = (): void => {
      if (tornDown) return
      tornDown = true
      streamCount = Math.max(0, streamCount - 1)
      activeStreams.delete(teardown)
      if (keepalive !== null) clearInterval(keepalive)
      pendingFrames.length = 0
      buffered.length = 0
      res.removeListener('drain', flushPending)
      const unsubscribe = release
      release = null
      try {
        unsubscribe?.()
      } catch { /* subscriber cleanup is isolated */ }
      try {
        res.end()
      } catch { /* already gone */ }
    }
    const writeFrame = (frame: string): void => {
      if (tornDown) return
      if (backpressured) {
        if (pendingFrames.length >= MAX_SSE_PENDING_FRAMES) teardown()
        else pendingFrames.push(frame)
        return
      }
      try {
        // Node accepted this frame even when write() returns false; pause only
        // subsequent frames until drain.
        if (!res.write(frame)) {
          backpressured = true
          res.once('drain', flushPending)
        }
      } catch {
        teardown()
      }
    }
    function flushPending(): void {
      if (tornDown) return
      backpressured = false
      while (!tornDown && !backpressured && pendingFrames.length > 0) {
        const frame = pendingFrames.shift()
        if (frame === undefined) break
        writeFrame(frame)
      }
    }
    const frameFor = (delta: SessionStateDelta): string =>
      'id: ' + delta.cursor + '\nevent: delta\ndata: ' + JSON.stringify(delta) + '\n\n'
    const snapshotFrame = (body: SessionStateSnapshot): string =>
      'id: ' + body.cursor + '\nevent: snapshot\ndata: ' + JSON.stringify(body) + '\n\n'
    // Subscribe BEFORE the snapshot/replay so no delta can fall between the two; newer buffered deltas flush after.
    release = deps.store.subscribe(delta => {
      if (live) {
        writeFrame(frameFor(delta))
        return
      }
      if (buffered.length >= MAX_SSE_PENDING_FRAMES) {
        overflow = true
        return
      }
      buffered.push(delta)
    })
    // Node 16+: the request close event fires once the body is consumed, so detect disconnects on the response leg.
    res.on('close', () => { if (!res.writableEnded) teardown() })
    let deliveredCursor = -1
    const replay = lastEventId === null ? null : deps.store.replayFrom(lastEventId)
    if (replay !== null) {
      for (const delta of replay) {
        writeFrame(frameFor(delta))
        deliveredCursor = delta.cursor
      }
      // replay !== null implies lastEventId !== null; this guard only keeps the narrowing local.
      if (deliveredCursor < 0 && lastEventId !== null) deliveredCursor = lastEventId
    } else {
      const body = snapshot()
      writeFrame(snapshotFrame(body))
      deliveredCursor = body.cursor
    }
    if (overflow) {
      teardown()
      return true
    }
    for (const delta of buffered) {
      if (delta.cursor > deliveredCursor) {
        writeFrame(frameFor(delta))
        deliveredCursor = delta.cursor
      }
    }
    buffered.length = 0
    live = true
    if (tornDown) return true
    keepalive = setInterval(() => {
      // Keepalives carry no state and must not consume the bounded queue while real frames wait for drain.
      if (!tornDown && !backpressured) writeFrame(': keepalive\n\n')
    }, keepaliveMs)
    keepalive.unref?.()
    activeStreams.add(teardown)
    return true
  }

  function methodNotAllowed(res: ApiResponse): true {
    return jsonResponse(res, 405, { error: 'method_not_allowed', code: 'method_not_allowed' })
  }

  async function handle(req: ApiRequest, res: ApiResponse, pathname: string): Promise<boolean> {
    if (!enabled) {
      // The desktop distinguishes 404 (no surface) from 503 session_state_disabled (this exact body).
      return jsonResponse(res, 503, { error: 'session_state_disabled', code: 'session_state_disabled' })
    }
    if (pathname === SESSION_STATE_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res)
      return jsonResponse(res, 200, snapshot())
    }
    if (pathname === SESSION_STATE_STREAM_PATH) {
      if (req.method !== 'GET') return methodNotAllowed(res)
      return openStream(req, res)
    }
    return jsonResponse(res, 404, { error: 'not_found', code: 'not_found' })
  }

  return {
    handle,
    closeAllStreams(): void {
      for (const teardown of [...activeStreams]) teardown()
    },
  }
}
