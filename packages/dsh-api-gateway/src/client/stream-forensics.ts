/**
 * Page-level stream-lifecycle forensics (chamber fork, design 14 §D4, 2026-09/P5).
 *
 * WHY THIS EXISTS. The 2026-09 ui-chat freeze investigation could count the
 * control plane's splices ("WebSocket stream local closed (browser close, ~19s)"
 * every ~20 s) but could NOT see, from any durable surface, WHO closed them or
 * WHY a generation ended: the renderer console is not persisted, the Swift shell
 * exposes no DevTools, and the mux client kept its own reasons in a closure. The
 * fix for the freeze makes that churn survivable; this fact makes the next
 * investigation answerable — one bounded page event per lifecycle transition
 * (socket lost/reconnect/replaced-while-silent/dispose, opening-item timeout,
 * generation ready/lost).
 *
 * P5: RETENTION. A live page event is gone the moment nobody listens, so every fact
 * is also recorded into the shared bounded ring (@dsh-chamber/dsh-stream-state
 * forensics): the resident tail survives until a probe requests it, and the request
 * path flushes it through the single ForensicsSink port. The module imports only the
 * pure chamber package - no vendor runtime and no DOM at module scope - so it stays
 * testable in plain Node (dispatch and the ring are injected seams).
 *
 * Facts carry a kind plus a short cause string - never a payload, prompt, path or
 * credential.
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
  | 'opening-stall-escalation'
  | 'generation-ready'
  | 'generation-lost'
  /** The reducer authorized a physical replacement (P5: the effect trace, not just the callback). */
  | 'carrier-rebuild'
  /** The reducer denied a replacement and paired it with a reopen (never a silent drop). */
  | 'carrier-throttled'

/** One bounded, non-secret lifecycle fact. */
export interface StreamForensicsFact {
  readonly instanceId: string | undefined
  /** Which transition happened. */
  readonly kind: StreamForensicsKind
  /** Short bounded cause (diagnostic copy only, never a payload). */
  readonly cause: string
  /** Wall-clock milliseconds of this transition. */
  readonly at: number
  /** 1-based count of transitions this page has observed (all kinds). */
  readonly count: number
  /** 1-based count of transitions of this kind. */
  readonly kindCount: number
}

/** Environment seams for {@link createStreamForensicsReporter}. */
export interface StreamForensicsEnvironment {
  readonly instanceId?: string | undefined
  /** Clock seam (tests). */
  readonly now?: (() => number) | undefined
  readonly dispatch?: ((fact: StreamForensicsFact) => void) | undefined
  /** Retained-tail buffer seam (tests inject a small cap). */
  readonly ring?: ForensicsRing | undefined
}

/** Longest cause string copied into a fact (the ring owns the same bound). */
export const STREAM_FORENSICS_CAUSE_MAX = FORENSICS_DETAIL_MAX

/**
 * Publish one bounded lifecycle fact and retain it.
 * The callable half is the hot path; `snapshot`/`flush` are the export half.
 */
export interface StreamForensicsReporter {
  (kind: StreamForensicsKind, cause: string): void
  /** Non-destructive copy of the retained tail, oldest first. */
  snapshot(): readonly ForensicsEntry[]
  /** Transfer the retained tail to a sink (the only export port). */
  flush(sink: ForensicsSink): number
}

/**
 * Build the per-ctx lifecycle reporter.
 * @param env - instance id plus the clock/dispatch/ring seams.
 * @returns a handler that counts, bounds, publishes and retains every transition.
 */
export function createStreamForensicsReporter(env: StreamForensicsEnvironment = {}): StreamForensicsReporter {
  const now = env.now ?? ((): number => Date.now())
  const dispatch = env.dispatch ?? dispatchPageEvent
  const ring = env.ring ?? createForensicsRing()
  const kindCounts = new Map<StreamForensicsKind, number>()
  let count = 0
  const report = ((kind: StreamForensicsKind, cause: string): void => {
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
    }
    // Retain BEFORE the live dispatch: a listener throwing (or a crash during the
    // dispatch) must not erase the fact from the resident tail. The ring owns the
    // bound and the redaction; both are no-throw by contract.
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
 * Install the probe bridge: a page dispatch of {@link STREAM_FORENSICS_REQUEST_EVENT}
 * flushes the reporter's retained tail through the sink (default: one
 * {@link STREAM_FORENSICS_SNAPSHOT_EVENT} per entry). No-op outside a DOM.
 */
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
