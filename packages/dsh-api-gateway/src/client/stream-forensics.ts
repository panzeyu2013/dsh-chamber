/**
 * Page-level stream-lifecycle forensics (chamber fork, design 14 §D4, 2026-09).
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
 * Zero imports on purpose: the counter/payload/dispatch contract is testable in
 * plain Node (dispatch is injected) and the browser default only touches the
 * globals the page already owns. Facts carry a kind plus a short cause string —
 * never a payload, prompt, path or credential.
 */

/** Window-level event name (globalThis; the page consumer listens on window) carrying one {@link StreamForensicsFact}. */
export const STREAM_FORENSICS_EVENT = 'dsh-chamber:stream-forensics'

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

/** One bounded, non-secret lifecycle fact. */
export interface StreamForensicsFact {
  /** Chamber source id of the boot ctx that owns the stream, when published. */
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
  /** Chamber source id of the owning boot ctx. */
  readonly instanceId?: string | undefined
  /** Clock seam (tests). */
  readonly now?: (() => number) | undefined
  /** Dispatch seam (tests); defaults to the page-level CustomEvent. */
  readonly dispatch?: ((fact: StreamForensicsFact) => void) | undefined
}

/** Longest cause string copied into a fact. */
export const STREAM_FORENSICS_CAUSE_MAX = 120

/** Publish one bounded lifecycle fact. */
export type StreamForensicsReporter = (kind: StreamForensicsKind, cause: string) => void

/**
 * Build the per-ctx lifecycle reporter.
 * @param env - instance id plus the clock/dispatch seams.
 * @returns a handler that counts, bounds and publishes every transition.
 */
export function createStreamForensicsReporter(env: StreamForensicsEnvironment = {}): StreamForensicsReporter {
  const now = env.now ?? ((): number => Date.now())
  const dispatch = env.dispatch ?? dispatchPageEvent
  const kindCounts = new Map<StreamForensicsKind, number>()
  let count = 0
  return (kind: StreamForensicsKind, cause: string): void => {
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
    // A page listener must never be able to break the stream lifecycle.
    try {
      dispatch(fact)
    } catch {
      // Swallowed by contract: forensics never decide behaviour.
    }
  }
}

/** Default dispatch: one CustomEvent on the page (no-op outside a DOM). */
function dispatchPageEvent(fact: StreamForensicsFact): void {
  const page = globalThis as {
    dispatchEvent?: (event: unknown) => boolean
    CustomEvent?: new (type: string, init: { detail: StreamForensicsFact }) => unknown
  }
  if (page.dispatchEvent === undefined || page.CustomEvent === undefined) return
  page.dispatchEvent(new page.CustomEvent(STREAM_FORENSICS_EVENT, { detail: fact }))
}
