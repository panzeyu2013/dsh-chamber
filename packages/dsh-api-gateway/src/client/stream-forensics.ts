/**
 * Page-level stream-lifecycle forensics (chamber fork): no durable surface can say
 * who closed the control plane's splices or why a generation ended — the renderer
 * console is not persisted and the native shell exposes no DevTools. This publishes
 * one bounded page event per lifecycle transition and also retains every fact in the
 * shared bounded ring (survives until a probe requests it, flushed through the single
 * ForensicsSink port). Imports only the pure chamber package; dispatch and the ring
 * are injected seams. Facts carry a kind plus a short cause — never a payload,
 * prompt, path or credential.
 */

import {
  FORENSICS_DETAIL_MAX,
  createForensicsRing,
  type ForensicsEntry,
  type ForensicsRing,
  type ForensicsSink,
} from '@dsh-chamber/dsh-stream-state'

/** Window-level event name (globalThis; the page consumer listens on window) carrying one {@link StreamForensicsFact}. */
export const STREAM_FORENSICS_EVENT = 'dsh-chamber:stream-forensics'

/** Probe request: flush the retained tail through the snapshot sink. */
export const STREAM_FORENSICS_REQUEST_EVENT = 'dsh-chamber:stream-forensics-request'

/** One retained entry delivered to a registered probe (detail: { instanceId, entry }). */
export const STREAM_FORENSICS_SNAPSHOT_EVENT = 'dsh-chamber:stream-forensics-snapshot'

/** Lifecycle transitions the fork can attribute without renderer tooling. */
export type StreamForensicsKind =
  | 'socket-lost'
  | 'socket-reconnect'
  | 'socket-attempt-failed'
  | 'socket-disposed'
  | 'socket-silent'
  | 'opening-timeout'
  /** F1: one widening rung expired while the retry lane continues - a diagnostic, never a verdict. */
  | 'opening-miss'
  /** F1: the consumer accepted the opening item (the only transition that settles an opening). */
  | 'opening-accepted'
  /** F1 terminal: frames arrived but the consumer never accepted across the WHOLE ladder. */
  | 'opening-orphaned'
  /** F1 terminal: every rung of the opening ladder was spent without acceptance. */
  | 'opening-budget-exhausted'
  | 'opening-stall-escalation'
  | 'generation-ready'
  | 'generation-lost'
  /** The reducer authorized a physical replacement. */
  | 'carrier-rebuild'
  /** The reducer denied a replacement and paired it with a reopen (never a silent drop). */
  | 'carrier-throttled'

/**
 * Structured attribution carried by the opening facts (F1). Every field is optional
 * and only present when the opener actually derived it; a fact's `cause` keeps the
 * same values in bounded prose for readers that only persist strings.
 */
export interface StreamForensicsDetail {
  /** The logical stream's endpoint (e.g. session/follow). */
  readonly endpoint?: string | undefined
  /** The carrier attempt's stream id (one per open frame, not one per logical stream). */
  readonly streamId?: string | undefined
  /** Milliseconds the opening waited on the carrier when the fact was emitted. */
  readonly waitedMs?: number | undefined
  /** Best-effort session attribution read from the request payload; absent otherwise. */
  readonly sessionId?: string | undefined
}

/** One bounded, non-secret lifecycle fact. */
export interface StreamForensicsFact {
  readonly instanceId: string | undefined
  /** Which transition happened. */
  readonly kind: StreamForensicsKind
  /** Short bounded cause (diagnostic copy only, never a payload). */
  readonly cause: string
  readonly at: number
  /** 1-based counts this page has observed: all kinds / this kind. */
  readonly count: number
  readonly kindCount: number
  /** F1 attribution, present only when the opening fact carried it. */
  readonly endpoint?: string | undefined
  readonly streamId?: string | undefined
  readonly waitedMs?: number | undefined
  readonly sessionId?: string | undefined
}

/** Environment seams for {@link createStreamForensicsReporter}. */
export interface StreamForensicsEnvironment {
  readonly instanceId?: string | undefined
  readonly now?: (() => number) | undefined
  readonly dispatch?: ((fact: StreamForensicsFact) => void) | undefined
  /** Retained-tail buffer seam. */
  readonly ring?: ForensicsRing | undefined
}

/** Longest cause string copied into a fact (the ring owns the same bound). */
export const STREAM_FORENSICS_CAUSE_MAX = FORENSICS_DETAIL_MAX

/** Publish one bounded lifecycle fact and retain it: the callable half is the hot
 *  path; `snapshot`/`flush` are the export half. */
export interface StreamForensicsReporter {
  (kind: StreamForensicsKind, cause: string, detail?: StreamForensicsDetail): void
  /** Non-destructive copy of the retained tail, oldest first. */
  snapshot(): readonly ForensicsEntry[]
  /** Transfer the retained tail to a sink (the only export port). */
  flush(sink: ForensicsSink): number
}

/** Build the per-ctx reporter: counts, bounds, publishes and retains every transition. */
export function createStreamForensicsReporter(env: StreamForensicsEnvironment = {}): StreamForensicsReporter {
  const now = env.now ?? ((): number => Date.now())
  const dispatch = env.dispatch ?? dispatchPageEvent
  const ring = env.ring ?? createForensicsRing()
  const kindCounts = new Map<StreamForensicsKind, number>()
  let count = 0
  const report = ((kind: StreamForensicsKind, cause: string, detail?: StreamForensicsDetail): void => {
    count += 1
    const kindCount = (kindCounts.get(kind) ?? 0) + 1
    kindCounts.set(kind, kindCount)
    const fact: StreamForensicsFact = {
      instanceId: env.instanceId,
      kind,
      cause: String(cause ?? '').slice(0, STREAM_FORENSICS_CAUSE_MAX),
      at: now(),
      count,
      kindCount,
      // Optional keys are OMITTED when absent (not set to undefined): a fact that
      // could not derive an attribution must keep the exact shape it always had.
      ...(detail?.endpoint === undefined ? {} : { endpoint: detail.endpoint }),
      ...(detail?.streamId === undefined ? {} : { streamId: detail.streamId }),
      ...(detail?.waitedMs === undefined ? {} : { waitedMs: detail.waitedMs }),
      ...(detail?.sessionId === undefined ? {} : { sessionId: detail.sessionId }),
    }
    // Retain BEFORE the live dispatch: a throwing listener must not erase the fact
    // from the resident tail. The ring owns the bound and redaction (no-throw).
    ring.record(fact.kind, fact.cause, fact.at)
    // A page listener must never be able to break the stream lifecycle.
    try {
      dispatch(fact)
    } catch {
      // Swallowed by contract: forensics never decide behaviour.
    }
  }) as StreamForensicsReporter
  report.snapshot = (): readonly ForensicsEntry[] => ring.snapshot()
  report.flush = (sink: ForensicsSink): number => ring.flush(sink)
  return report
}

/**
 * Best-effort session attribution for one opening fact. The request payload belongs to
 * the DOMAIN call (its `args.request.address.sessionId` path is the session
 * controller's own shape), NOT to this carrier's protocol, so every access is guarded,
 * a missing/renamed path yields `undefined`, and this never throws: attribution is a
 * diagnostic nicety, never a reason for a stream to fail.
 */
export function sessionIdOfPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const request = (payload as { args?: { request?: { address?: { sessionId?: unknown } } } }).args?.request
  const sessionId = request?.address?.sessionId
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
}

/** Install the probe bridge: a page dispatch of {@link STREAM_FORENSICS_REQUEST_EVENT}
 *  flushes the retained tail through the sink. No-op outside a DOM. */
export function installStreamForensicsSnapshotBridge(
  reporter: StreamForensicsReporter,
  instanceId?: string,
  sink: ForensicsSink = pageSnapshotSink(instanceId),
): void {
  const page = pageGlobal()
  if (page?.addEventListener === undefined) return
  page.addEventListener(STREAM_FORENSICS_REQUEST_EVENT, () => {
    try {
      reporter.flush(sink)
    } catch {
      // A probe must never be able to break the lifecycle it is inspecting.
    }
  })
}

/** Default dispatch: one CustomEvent on the page (no-op outside a DOM). */
function dispatchPageEvent(fact: StreamForensicsFact): void {
  const page = pageGlobal()
  if (page?.dispatchEvent === undefined || page.CustomEvent === undefined) return
  page.dispatchEvent(new page.CustomEvent(STREAM_FORENSICS_EVENT, { detail: fact }))
}

/** Default snapshot sink: one bounded entry event per retained fact. */
function pageSnapshotSink(instanceId?: string): ForensicsSink {
  return (entry: ForensicsEntry): void => {
    const page = pageGlobal()
    if (page?.dispatchEvent === undefined || page.CustomEvent === undefined) return
    page.dispatchEvent(new page.CustomEvent(STREAM_FORENSICS_SNAPSHOT_EVENT, {
      detail: { instanceId, entry },
    }))
  }
}

interface StreamForensicsPage {
  addEventListener?: (type: string, listener: () => void) => void
  dispatchEvent?: (event: unknown) => boolean
  CustomEvent?: new (type: string, init: { detail: unknown }) => unknown
}

function pageGlobal(): StreamForensicsPage {
  return globalThis as StreamForensicsPage
}
