/**
 * Session index (design 17 §8.2): a DERIVED projection over the dsh mux/host
 * streams — session presence + the lightweight `session/projection` facts
 * (sessionListMetadata). The index is never authoritative: `session.list`
 * remains the reconnect authority (chamber discipline); this module only
 * caches a projection and replays it after a dsh restart.
 *
 * It consumes control/projection frames ONLY — it never parses the
 * `session/event` body (session business belongs to the dsh frontend runtime).
 */

import { call, openEventStream, type Logger, type ServerRequest } from '@dsh-chamber/control-plane'

export interface SessionProjection {
  sessionId: string
  title?: string
  /** sessionListMetadata object (design 17 §8.2; the api contract key). */
  metadata?: Record<string, unknown>
  /** Authoritative on every session.list baseline; host stream updates live. */
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
  /** Reset after a reconnect (design 17 §8.2: refetch session.list, replay). */
  clear(): void
}

/** The snapshot cut is normally milliseconds, but it is still an attacker-
 * controllable wait when the local dsh is unhealthy. Retain only a bounded
 * number of already-sanitized control frames during that window. */
const MAX_BASELINE_CONTROL_FRAMES = 4_096
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

/** Filter and sanitize mux frames before the snapshot buffer sees them. In
 * particular, session/event and approval/question payloads are never retained
 * by the session index. */
function decodeMuxIndexFrame(frame: ServerRequest): ServerRequest | null {
  const p = frame.payload
  if (frame.method === 'session/subscribed') {
    if (!boundedText(p.sessionId, MAX_SESSION_ID_CHARS)) return null
    return { type: 'server-request', rpcId: '', method: frame.method, payload: { sessionId: p.sessionId } }
  }
  if (frame.method !== 'session/projection' || !boundedText(p.sessionId, MAX_SESSION_ID_CHARS)
    || !Number.isInteger(p.seq) || (p.seq as number) < 0) return null
  if (p.key === 'title') {
    if (!boundedText(p.value, MAX_TITLE_CHARS)) return null
    return {
      type: 'server-request', rpcId: '', method: frame.method,
      payload: { sessionId: p.sessionId, key: 'title', value: p.value, seq: p.seq },
    }
  }
  if (p.key === 'sessionListMetadata') {
    const metadata = decodeListMetadata(p.value)
    if (metadata === null) return null
    return {
      type: 'server-request', rpcId: '', method: frame.method,
      payload: { sessionId: p.sessionId, key: 'sessionListMetadata', value: metadata, seq: p.seq },
    }
  }
  return null
}

/** Host index frames have a similarly narrow copy boundary. Workspace frames
 * and any future host payloads remain somebody else's domain. */
function decodeHostIndexFrame(frame: ServerRequest): ServerRequest | null {
  const p = frame.payload
  if (!boundedText(p.sessionId, MAX_SESSION_ID_CHARS)) return null
  if (frame.method === 'host/session-added' && typeof p.blank === 'boolean'
    && (p.cwd === undefined || (typeof p.cwd === 'string' && p.cwd.length <= MAX_CWD_CHARS))) {
    return {
      type: 'server-request', rpcId: '', method: frame.method,
      payload: { sessionId: p.sessionId, blank: p.blank, ...(typeof p.cwd === 'string' ? { cwd: p.cwd } : {}) },
    }
  }
  if (frame.method === 'host/session-status' && typeof p.running === 'boolean') {
    return { type: 'server-request', rpcId: '', method: frame.method, payload: { sessionId: p.sessionId, running: p.running } }
  }
  if (frame.method === 'host/session-removed') {
    return { type: 'server-request', rpcId: '', method: frame.method, payload: { sessionId: p.sessionId } }
  }
  return null
}

export function createSessionIndex(deps: {
  getDshBaseUrl(): string | null
  logger: Logger
  /** Test seams; production uses the shared dsh wire implementation. */
  callDsh?: typeof call
  openStream?: (
    baseUrl: string,
    path: string,
    signal?: AbortSignal,
    onOpen?: () => void,
  ) => AsyncIterable<ServerRequest>
  reconnectDelayMs?: number
  /** Test seam: the dual-stream open barrier deadline (see below). */
  barrierOpenTimeoutMs?: number
}): SessionIndex {
  const projections = new Map<string, SessionProjection>()
  /** Per-key projection watermarks implement the host contract's
   * higher-seq-wins rule across list baselines and mux replay/live frames. */
  const projectionSeqs = new Map<string, Map<string, number>>()
  const removedSessionIds = new Set<string>()
  let abort: AbortController | null = null
  let lifecycleEpoch = 0
  const callDsh = deps.callDsh ?? call
  const openStream = deps.openStream ?? openEventStream
  const reconnectDelayMs = deps.reconnectDelayMs ?? 1_000
  /** A dsh that accepts TCP but never completes a WS upgrade (hung instance,
   * wedged proxy) used to stall the ready barrier forever: the generation
   * kept buffering, /chamber/sessions stayed empty and nothing recovered.
   * The open barrier now fails after this window and the reconnect loop
   * retries a fresh generation. */
  const barrierOpenTimeoutMs = deps.barrierOpenTimeoutMs ?? 30_000

  function projectionOf(summary: unknown): { projection: SessionProjection; asOfSeq: number } | null {
    const row = summary as {
      sessionId?: unknown
      updatedAt?: unknown
      running?: unknown
      blank?: unknown
      cwd?: unknown
      projections?: { asOfSeq?: unknown; values?: { title?: unknown; sessionListMetadata?: unknown } }
    } | null
    if (!boundedText(row?.sessionId, MAX_SESSION_ID_CHARS)
      || typeof row.running !== 'boolean' || typeof row.blank !== 'boolean'
      || (row.cwd !== undefined && typeof row.cwd !== 'string')) return null
    const values = row.projections?.values
    const asOfSeq = row.projections === undefined ? -1 : row.projections.asOfSeq
    if (!Number.isInteger(asOfSeq) || (asOfSeq as number) < -1
      || (row.projections !== undefined && (values === null || typeof values !== 'object'))) return null
    const title = values?.title
    const titleValue = title === undefined ? undefined : truncatedText(title, MAX_TITLE_CHARS)
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

  async function rebuildBaseline(baseUrl: string, signal: AbortSignal, epoch: number): Promise<boolean> {
    const { result } = await callDsh(baseUrl, 'session.list', {}, { signal })
    const items = (result.value as { items?: unknown } | null)?.items
    if (!Array.isArray(items)) throw new Error('session.list returned no items array')
    const next = new Map<string, SessionProjection>()
    const nextSeqs = new Map<string, Map<string, number>>()
    for (const item of items) {
      const decoded = projectionOf(item)
      // One malformed/forward-incompatible row must degrade the projection,
      // never fail the whole generation: a hard throw would wedge the index
      // in a permanent reconnect loop (every reconnect hits the same row).
      if (decoded === null) {
        deps.logger.warn('session-index: skipping a malformed session.list row')
        continue
      }
      next.set(decoded.projection.sessionId, decoded.projection)
      const values = (item as { projections?: { values?: Record<string, unknown> } }).projections?.values
      const keys = values === undefined ? [] : Object.keys(values)
      nextSeqs.set(decoded.projection.sessionId, new Map(keys.map(key => [key, decoded.asOfSeq])))
    }
    if (signal.aborted || epoch !== lifecycleEpoch) return false
    projections.clear()
    for (const [sessionId, projection] of next) projections.set(sessionId, projection)
    projectionSeqs.clear()
    for (const [sessionId, seqs] of nextSeqs) projectionSeqs.set(sessionId, seqs)
    removedSessionIds.clear()
    return true
  }

  function waitForRetry(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise(resolve => {
      const timer = setTimeout(done, reconnectDelayMs)
      function done(): void {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        resolve()
      }
      signal.addEventListener('abort', done, { once: true })
    })
  }

  function applyMuxFrame(frame: ServerRequest): void {
    const p = frame.payload
    if (frame.method === 'session/subscribed') {
      if (typeof p.sessionId === 'string' && !removedSessionIds.has(p.sessionId)) {
        const prev = projections.get(p.sessionId)
        projections.set(p.sessionId, prev ?? {
          // subscribed proves attachment/replay membership, not that an agent
          // is currently running or that a turn has started.
          sessionId: p.sessionId, running: false, blank: true, updatedAt: Date.now(),
        })
      }
      return
    }
    if (frame.method !== 'session/projection' || typeof p.sessionId !== 'string'
      || typeof p.key !== 'string' || !Number.isInteger(p.seq) || (p.seq as number) < 0
      || removedSessionIds.has(p.sessionId)) return
    if (p.key !== 'title' && p.key !== 'sessionListMetadata') return
    const seqs = projectionSeqs.get(p.sessionId) ?? new Map<string, number>()
    if ((seqs.get(p.key) ?? -1) >= (p.seq as number)) return
    const prev = projections.get(p.sessionId) ?? {
      sessionId: p.sessionId, running: false, blank: true, updatedAt: Date.now(),
    }
    const listMetadata = p.key === 'sessionListMetadata' && p.value !== null && typeof p.value === 'object'
      && typeof (p.value as { blank?: unknown }).blank === 'boolean'
      && ((p.value as { lastPromptAt?: unknown }).lastPromptAt === null
        || (typeof (p.value as { lastPromptAt?: unknown }).lastPromptAt === 'number'
          && Number.isFinite((p.value as { lastPromptAt: number }).lastPromptAt)))
      ? p.value as { blank: boolean; lastPromptAt: number | null } : null
    if ((p.key === 'title' && typeof p.value !== 'string')
      || (p.key === 'sessionListMetadata' && listMetadata === null)) return
    projections.set(p.sessionId, {
      ...prev,
      ...(p.key === 'title' && typeof p.value === 'string' ? { title: p.value } : {}),
      ...(listMetadata === null ? {} : {
        metadata: listMetadata,
        blank: listMetadata.blank,
        ...(listMetadata.lastPromptAt === null ? {} : { updatedAt: listMetadata.lastPromptAt }),
      }),
    })
    seqs.set(p.key, p.seq as number)
    projectionSeqs.set(p.sessionId, seqs)
  }

  function applyHostFrame(frame: ServerRequest): void {
    const p = frame.payload
    if (frame.method === 'host/session-added' && typeof p.sessionId === 'string' && typeof p.blank === 'boolean') {
      removedSessionIds.delete(p.sessionId)
      const prev = projections.get(p.sessionId)
      projections.set(p.sessionId, {
        ...(prev ?? { sessionId: p.sessionId, running: false, updatedAt: Date.now() }),
        blank: p.blank,
        ...(typeof p.cwd === 'string' ? { cwd: p.cwd } : {}),
      })
    } else if (frame.method === 'host/session-status' && typeof p.sessionId === 'string' && typeof p.running === 'boolean'
      && !removedSessionIds.has(p.sessionId)) {
      const prev = projections.get(p.sessionId) ?? {
        sessionId: p.sessionId, running: false, blank: true, updatedAt: Date.now(),
      }
      projections.set(p.sessionId, {
        ...prev,
        running: p.running,
        ...(p.running ? { blank: false } : {}),
      })
    } else if (frame.method === 'host/session-removed' && typeof p.sessionId === 'string') {
      removedSessionIds.add(p.sessionId)
      projections.delete(p.sessionId)
      projectionSeqs.delete(p.sessionId)
    }
  }

  async function consumeMux(
    baseUrl: string,
    signal: AbortSignal,
    onFrame: (frame: ServerRequest) => void = applyMuxFrame,
    onOpen?: () => void,
  ): Promise<void> {
    for await (const frame of openStream(baseUrl, '/api/events.mux', signal, onOpen)) {
      const decoded = decodeMuxIndexFrame(frame)
      if (decoded !== null) onFrame(decoded)
    }
  }

  async function consumeHost(
    baseUrl: string,
    signal: AbortSignal,
    onFrame: (frame: ServerRequest) => void = applyHostFrame,
    onOpen?: () => void,
  ): Promise<void> {
    for await (const frame of openStream(baseUrl, '/api/events.host', signal, onOpen)) {
      const decoded = decodeHostIndexFrame(frame)
      if (decoded !== null) onFrame(decoded)
      // Workspace increments are intentionally not indexed: session.list is
      // the session authority and host/session-* carries every live field this
      // projection exposes. The stream is still consumed as the reconnect and
      // running-state channel required by the contract.
    }
  }

  async function consumeGeneration(baseUrl: string, outerSignal: AbortSignal, epoch: number): Promise<void> {
    const generation = new AbortController()
    const signal = AbortSignal.any([outerSignal, generation.signal])
    const buffered: Array<{ source: 'mux' | 'host'; frame: ServerRequest }> = []
    let buffering = true
    const buffer = (source: 'mux' | 'host', frame: ServerRequest): void => {
      if (buffered.length >= MAX_BASELINE_CONTROL_FRAMES) {
        throw new Error(`session-index: baseline control buffer exceeded ${MAX_BASELINE_CONTROL_FRAMES} frames`)
      }
      buffered.push({ source, frame })
    }
    const collectMux = (frame: ServerRequest): void => {
      if (epoch !== lifecycleEpoch) return
      if (buffering) buffer('mux', frame)
      else applyMuxFrame(frame)
    }
    const collectHost = (frame: ServerRequest): void => {
      if (epoch !== lifecycleEpoch) return
      if (buffering) buffer('host', frame)
      else applyHostFrame(frame)
    }
    let openMux!: () => void
    let openHost!: () => void
    const muxReady = new Promise<void>(resolve => { openMux = resolve })
    const hostReady = new Promise<void>(resolve => { openHost = resolve })
    // Start both downlinks before requesting the snapshot. Frames racing the
    // unary response are buffered, then replayed over the authoritative cut.
    const mux = consumeMux(baseUrl, signal, collectMux, openMux).then(
      () => ({ ok: true as const }), error => ({ ok: false as const, error }),
    )
    const host = consumeHost(baseUrl, signal, collectHost, openHost).then(
      () => ({ ok: true as const }), error => ({ ok: false as const, error }),
    )
    const awaitReady = async (
      ready: Promise<void>,
      outcome: typeof mux,
      name: string,
    ): Promise<void> => {
      // Watchdog: without a handshake deadline a hung upstream (TCP accepted,
      // upgrade never completed) wedges the generation in buffering forever.
      let timer: ReturnType<typeof setTimeout> | null = null
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${name} open barrier timed out after ${barrierOpenTimeoutMs}ms`)),
          barrierOpenTimeoutMs,
        )
        timer.unref?.()
      })
      try {
        await Promise.race([
          ready,
          outcome.then(result => {
            if (!result.ok) throw result.error
            throw new Error(`${name} stream ended before its open barrier`)
          }),
          timeout,
        ])
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }
    try {
      await Promise.all([
        awaitReady(muxReady, mux, 'mux'),
        awaitReady(hostReady, host, 'host'),
      ])
      if (!await rebuildBaseline(baseUrl, signal, epoch)) return
      if (signal.aborted || epoch !== lifecycleEpoch) return
      for (const item of buffered) {
        if (item.source === 'mux') applyMuxFrame(item.frame)
        else applyHostFrame(item.frame)
      }
      buffering = false
      buffered.length = 0
      const outcome = await Promise.race([mux, host])
      if (!outcome.ok) throw outcome.error
    } finally {
      generation.abort()
      await Promise.allSettled([mux, host])
      // A derived liveness view cannot survive its transport generation.
      // Publish an empty view until the next ready generation installs a fresh
      // authoritative baseline.
      if (epoch === lifecycleEpoch) {
        projections.clear()
        projectionSeqs.clear()
        removedSessionIds.clear()
      }
    }
  }

  async function run(signal: AbortSignal, epoch: number): Promise<void> {
    while (!signal.aborted && epoch === lifecycleEpoch) {
      const baseUrl = deps.getDshBaseUrl()
      if (baseUrl === null) {
        await waitForRetry(signal)
        continue
      }
      try {
        // Every generation opens both streams before taking the authoritative
        // list cut, closing the snapshot -> stream event-loss window.
        await consumeGeneration(baseUrl, signal, epoch)
      } catch (error) {
        if (!signal.aborted) deps.logger.warn(`session-index: reconnecting after failure: ${String(error)}`)
      }
      if (!signal.aborted && epoch === lifecycleEpoch) await waitForRetry(signal)
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
      projectionSeqs.clear()
      removedSessionIds.clear()
    },
    list(): SessionProjection[] {
      return [...projections.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    },
    get(sessionId: string): SessionProjection | undefined {
      return projections.get(sessionId)
    },
    clear(): void {
      projections.clear()
      projectionSeqs.clear()
      removedSessionIds.clear()
    },
  }
}
