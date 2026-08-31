/**
 * Session index (design 17 §8.2): a DERIVED projection over the dsh unary
 * read faces — session presence + the lightweight `session/projection` facts
 * (sessionListMetadata). The index is never authoritative: `session/list`
 * remains the reconnect authority (chamber discipline); this module only
 * caches a projection and replays it after a dsh restart.
 *
 * dsh 0.1.2 wire note: the `events.mux`/`events.host` downlink WS frames
 * (`session/subscribed`, `session/projection`, `host/session-*`) were REMOVED
 * upstream and replaced by Remote streams over `/api/remote.mux`
 * (`session/control` baseline + replacement frames, `$events`; the 0.1.2
 * `session/follow` stream is the TODO restoration). The index consumes the
 * `session/control` Remote stream (baseline + live replacement frames) for
 * queues/jobs/projections and runs a bounded `session/list` poll cadence for
 * the row set; when the stream is unavailable the index degrades to polling
 * only (documented). Projection freshness is bounded by `pollIntervalMs` in
 * the degraded path; live in the healthy one.
 *
 * It consumes projection facts ONLY — it never parses session event
 * body (session business belongs to the dsh frontend runtime).
 */

import { call, type Logger } from '@dsh-chamber/control-plane'
import { openRemoteStream } from './remote-stream.ts'

export interface SessionProjection {
  sessionId: string
  title?: string
  /** sessionListMetadata object (design 17 §8.2; the api contract key). */
  metadata?: Record<string, unknown>
  /** Authoritative on every session/list baseline; host stream updates live. */
  running: boolean
  blank: boolean
  cwd?: string
  updatedAt: number
}

export interface SessionIndex {
  start(): void
  stop(): void
  list(): SessionProjection[]
  get(sessionId: string): SessionProjection | undefined
  /** Live session control queues (0.1.2 session/control stream baseline;
   * opaque JSON copies, never host objects). */
  getQueues(): ReadonlyMap<string, readonly unknown[]>
  /** Live session control jobs (0.1.2 session/control stream baseline). */
  getJobs(): ReadonlyMap<string, readonly unknown[]>
  /** Reset after a reconnect (design 17 §8.2: refetch session/list, replay). */
  clear(): void
}

const MAX_SESSION_ID_CHARS = 512
const MAX_TITLE_CHARS = 4_096
const MAX_CWD_CHARS = 32_768

interface SessionListMetadata extends Record<string, unknown> {
  blank: boolean
  lastPromptAt: number | null
}

function boundedText(value: unknown, maxChars: number): value is string {
  return typeof value === 'string' && value !== '' && value.length <= maxChars
}

/** Display fields are truncated to the projection bound instead of rejecting
 * the row: an overlong title/cwd must not erase the session from the index. */
function truncatedText(value: unknown, maxChars: number): string | null {
  return typeof value === 'string' && value !== '' ? value.slice(0, maxChars) : null
}

/** Copy the complete, deliberately tiny session-list projection vocabulary.
 * Never retain the host object: unknown keys could carry session content.
 * Unknown FUTURE keys are dropped, not rejected — a host schema addition must
 * degrade the projection, never wedge the whole generation (forward compat). */
function decodeListMetadata(value: unknown): SessionListMetadata | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as { blank?: unknown; lastPromptAt?: unknown }
  if (typeof row.blank !== 'boolean'
    || !(row.lastPromptAt === null || (typeof row.lastPromptAt === 'number' && Number.isFinite(row.lastPromptAt)))) return null
  return { blank: row.blank, lastPromptAt: row.lastPromptAt as number | null }
}

/** Decode one session-list row (the 0.1.2 session/control baseline is a stream
 * Remote with no unary form, so only session/list rows are decoded here)
 * row) into the projection copy. Never retains the host object. */
function projectionOf(summary: unknown): { projection: SessionProjection; asOfSeq: number } | null {
  const row = summary as {
    sessionId?: unknown
    updatedAt?: unknown
    running?: unknown
    blank?: unknown
    cwd?: unknown
    projections?: { asOfSeq?: unknown; values?: { title?: unknown; sessionListMetadata?: unknown } } | null
  } | null
  if (!boundedText(row?.sessionId, MAX_SESSION_ID_CHARS)
    || typeof row.running !== 'boolean' || typeof row.blank !== 'boolean'
    || (row.cwd !== undefined && typeof row.cwd !== 'string')) return null
  // A forward-incompatible nullable projection container is a bad row, not a
  // generation-ending TypeError (origin/main 0.2.0-beta.4 hardening).
  const projectionState = row.projections
  if (projectionState !== undefined
    && (projectionState === null || typeof projectionState !== 'object' || Array.isArray(projectionState))) return null
  const values = projectionState?.values
  const asOfSeq = projectionState === undefined ? -1 : projectionState.asOfSeq
  if (!Number.isInteger(asOfSeq) || (asOfSeq as number) < -1
    || (projectionState !== undefined && (values === null || typeof values !== 'object' || Array.isArray(values)))) return null
  const title = values?.title
  // Upstream types title as `string | null` — a blank title is a legitimate
  // row (new session), never a drop reason (review-round4c P2).
  const titleValue = title === undefined || title === null || title === ''
    ? undefined
    : truncatedText(title, MAX_TITLE_CHARS)
  if (titleValue === null) return null
  const rawMetadata = values?.sessionListMetadata
  const metadata = rawMetadata === undefined ? undefined : decodeListMetadata(rawMetadata)
  if (metadata === null) return null
  const cwd = row.cwd === undefined ? undefined : truncatedText(row.cwd, MAX_CWD_CHARS)
  if (cwd === null) return null
  return { projection: {
    sessionId: row.sessionId,
    ...(titleValue === undefined ? {} : { title: titleValue }),
    ...(metadata === undefined ? {} : { metadata }),
    running: row.running,
    blank: row.blank,
    ...(cwd === undefined ? {} : { cwd }),
    updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt)
      ? row.updatedAt : Date.now(),
  }, asOfSeq: asOfSeq as number }
}

export function createSessionIndex(deps: {
  getDshBaseUrl(): string | null
  logger: Logger
  /** Test seams; production uses the shared dsh wire implementation. */
  callDsh?: typeof call
  openRemoteStream?: (
    baseUrl: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ) => AsyncIterable<unknown>
  reconnectDelayMs?: number
  /** Bounded unary polling cadence for the incremental row refresh (used when
   * the session/control stream is unavailable). */
  pollIntervalMs?: number
}): SessionIndex {
  const projections = new Map<string, SessionProjection>()
  const queues = new Map<string, readonly unknown[]>()
  const jobs = new Map<string, readonly unknown[]>()
  let abort: AbortController | null = null
  let lifecycleEpoch = 0
  const callDsh = deps.callDsh ?? call
  const openControlStream = deps.openRemoteStream ?? openRemoteStream
  const reconnectDelayMs = deps.reconnectDelayMs ?? 1_000
  const pollIntervalMs = deps.pollIntervalMs ?? 10_000

  /** Decode baseline rows into a fresh projection map. One
   * malformed/forward-incompatible row must degrade the projection, never
   * fail the whole generation: a hard throw would wedge the index in a
   * permanent reconnect loop (every reconnect hits the same row). Returns the
   * accepted row count without mutating the live map. */
  function decodeBaselineRows(items: unknown[]): { next: Map<string, SessionProjection>; accepted: number } {
    const next = new Map<string, SessionProjection>()
    let accepted = 0
    for (const item of items) {
      const decoded = projectionOf(item)
      if (decoded === null) {
        deps.logger.warn('session-index: skipping a malformed session/list row')
        continue
      }
      next.set(decoded.projection.sessionId, decoded.projection)
      accepted += 1
    }
    return { next, accepted }
  }

  /** The authoritative `session/list` (slash) baseline: the session list IS
   * the session authority, so the map is always replaced (stale sessions
   * vanish even when a malformed row is skipped). */
  function installBaseline(items: unknown[]): void {
    const { next } = decodeBaselineRows(items)
    projections.clear()
    for (const [sessionId, projection] of next) projections.set(sessionId, projection)
  }

  /** Merge one 0.1.2 `session/control` projection value into an existing row
   * (the stream's projection values carry title/metadata; the row facts come
   * from the session/list baseline). Unknown sessions are ignored — the
   * session/list poll brings their rows. */
  function applyProjectionUpdate(sessionId: string, key: string, value: unknown, seq: number): void {
    void seq
    const row = projections.get(sessionId)
    if (row === undefined) return
    if (key === 'title') {
      const title = truncatedText(value, MAX_TITLE_CHARS)
      if (title === null) return
      row.title = title
    } else if (key === 'sessionListMetadata') {
      const metadata = decodeListMetadata(value)
      if (metadata !== null) row.metadata = metadata
    }
  }

  /** Apply one 0.1.2 `session/control` frame (baseline/queue/jobs/projection).
   * The baseline replaces queues/jobs wholesale and merges projection values
   * into existing rows; live frames update per session. */
  function applyControlFrame(value: unknown): void {
    const frame = value as { type?: unknown; value?: unknown; sessionId?: unknown; items?: unknown; jobs?: unknown; key?: unknown; seq?: unknown } | null
    if (frame === null || typeof frame !== 'object' || typeof frame.type !== 'string') return
    if (frame.type === 'baseline') {
      const base = frame.value as { queues?: unknown; jobs?: unknown; projections?: unknown } | null
      if (base === null || typeof base !== 'object') return
      queues.clear()
      jobs.clear()
      if (typeof base.queues === 'object' && base.queues !== null && !Array.isArray(base.queues)) {
        for (const [sessionId, items] of Object.entries(base.queues)) {
          queues.set(sessionId, Array.isArray(items) ? items : [])
        }
      }
      if (typeof base.jobs === 'object' && base.jobs !== null && !Array.isArray(base.jobs)) {
        for (const [sessionId, items] of Object.entries(base.jobs)) {
          jobs.set(sessionId, Array.isArray(items) ? items : [])
        }
      }
      if (typeof base.projections === 'object' && base.projections !== null && !Array.isArray(base.projections)) {
        for (const [sessionId, projection] of Object.entries(base.projections)) {
          const proj = projection as { values?: { title?: unknown; sessionListMetadata?: unknown } } | null
          if (proj === null || typeof proj !== 'object') continue
          if (proj.values !== undefined && typeof proj.values === 'object' && proj.values !== null) {
            if (proj.values.title !== undefined) applyProjectionUpdate(sessionId, 'title', proj.values.title, -1)
            if (proj.values.sessionListMetadata !== undefined) applyProjectionUpdate(sessionId, 'sessionListMetadata', proj.values.sessionListMetadata, -1)
          }
        }
      }
      return
    }
    if (frame.type === 'queue' && typeof frame.sessionId === 'string') {
      queues.set(frame.sessionId, Array.isArray(frame.items) ? frame.items : [])
      return
    }
    if (frame.type === 'jobs' && typeof frame.sessionId === 'string') {
      jobs.set(frame.sessionId, Array.isArray(frame.jobs) ? frame.jobs : [])
      return
    }
    if (frame.type === 'projection' && typeof frame.sessionId === 'string' && typeof frame.key === 'string') {
      applyProjectionUpdate(frame.sessionId, frame.key, frame.value, typeof frame.seq === 'number' ? frame.seq : -1)
    }
  }

  /** Consume the live 0.1.2 `session/control` stream (endpoint 'session/control',
   * zero-arg Remote): one baseline frame followed by live replacement frames.
   * Returns when the host ends the stream; throws on carrier failure — the
   * caller falls back to bounded session/list polling. */
  async function consumeControlStream(baseUrl: string, signal: AbortSignal, epoch: number): Promise<void> {
    for await (const value of openControlStream(baseUrl, 'session/control', { args: {} }, signal)) {
      if (epoch !== lifecycleEpoch) return
      applyControlFrame(value)
    }
  }

  async function rebuildSessionListBaseline(baseUrl: string, signal: AbortSignal): Promise<boolean> {
    const { result } = await callDsh(baseUrl, 'session/list', { args: { _request: {} } }, { signal })
    const items = (result.value as { items?: unknown } | null)?.items
    if (!Array.isArray(items)) throw new Error('session/list returned no items array')
    installBaseline(items)
    return true
  }

  function waitFor(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise(resolve => {
      const timer = setTimeout(done, delayMs)
      function done(): void {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      signal.addEventListener('abort', done, { once: true })
    })
  }

  async function consumeGeneration(baseUrl: string, outerSignal: AbortSignal, epoch: number): Promise<void> {
    const generation = new AbortController()
    const signal = AbortSignal.any([outerSignal, generation.signal])
    try {
      // One-shot baseline: session/list (slash) is the reconnect authority
      // (design 17 §8.2) and provides the row facts (running/blank/cwd/...).
      await rebuildSessionListBaseline(baseUrl, signal)
      if (signal.aborted || epoch !== lifecycleEpoch) return
      // Live layer: the 0.1.2 `session/control` Remote stream (baseline +
      // replacement frames) carries queues/jobs and projection updates. It
      // runs CONCURRENTLY with the bounded session/list polling loop — the
      // poll keeps the ROW set fresh (new/removed sessions) while the stream
      // updates projections/queues/jobs live; a stream failure degrades to
      // polling only (documented) without wedging the generation.
      const controlLayer = (async () => {
        // The control stream is LIVE — a failure or host-side end must
        // reconnect with the same backoff as the generation loop (the old
        // events.mux carrier reconnected immediately; a permanent degradation
        // would freeze queues/jobs/projections on the polling path). The
        // epoch check fences a concurrent stop()/restart.
        while (!signal.aborted && epoch === lifecycleEpoch) {
          try {
            await consumeControlStream(baseUrl, signal, epoch)
            // Clean host end — reconnect after the backoff.
          } catch (error) {
            if (!signal.aborted) {
              deps.logger.warn(`session-index: session/control stream unavailable (${String(error)}); polling session/list only`)
            }
          }
          // The stream is gone: queues/jobs are stale (the degraded path has
          // no control facts). Clear them so a later healthy reconnect does
          // not merge old frames into the new baseline.
          queues.clear()
          jobs.clear()
          if (signal.aborted || epoch !== lifecycleEpoch) return
          await waitFor(reconnectDelayMs, signal)
        }
      })()
      while (!signal.aborted && epoch === lifecycleEpoch) {
        await waitFor(pollIntervalMs, signal)
        if (signal.aborted || epoch !== lifecycleEpoch) return
        await rebuildSessionListBaseline(baseUrl, signal)
      }
      await controlLayer
    } finally {
      generation.abort()
      // A derived liveness view cannot survive its transport generation.
      // Publish an empty view until the next ready generation installs a fresh
      // authoritative baseline.
      if (epoch === lifecycleEpoch) {
        projections.clear()
      }
    }
  }

  async function run(signal: AbortSignal, epoch: number): Promise<void> {
    while (!signal.aborted && epoch === lifecycleEpoch) {
      const baseUrl = deps.getDshBaseUrl()
      if (baseUrl === null) {
        await waitFor(reconnectDelayMs, signal)
        continue
      }
      try {
        await consumeGeneration(baseUrl, signal, epoch)
      } catch (error) {
        if (!signal.aborted) deps.logger.warn(`session-index: reconnecting after failure: ${String(error)}`)
      }
      if (!signal.aborted && epoch === lifecycleEpoch) await waitFor(reconnectDelayMs, signal)
    }
  }

  return {
    start(): void {
      if (abort !== null) return
      const controller = new AbortController()
      const epoch = ++lifecycleEpoch
      abort = controller
      void run(controller.signal, epoch)
    },
    stop(): void {
      if (abort !== null) {
        lifecycleEpoch += 1
        abort.abort()
        abort = null
      }
      projections.clear()
      queues.clear()
      jobs.clear()
    },
    list(): SessionProjection[] {
      return [...projections.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    },
    get(sessionId: string): SessionProjection | undefined {
      return projections.get(sessionId)
    },
    getQueues(): ReadonlyMap<string, readonly unknown[]> {
      return queues
    },
    getJobs(): ReadonlyMap<string, readonly unknown[]> {
      return jobs
    },
    clear(): void {
      projections.clear()
    },
  }
}
