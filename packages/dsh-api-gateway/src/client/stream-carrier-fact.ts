/**
 * Page-level carrier-churn fact. Upstream plumbs `carrierFailed` through the
 * gateway and the session controller but nothing consumes it, so a sustained
 * carrier fault inside a live generation is otherwise silent. This turns that seam
 * into an addressable page fact (zero imports: dispatch is injected; the browser
 * default only touches globals the page already owns).
 */

/** Document-level event name carrying one {@link CarrierFailureFact}. */
export const STREAM_CARRIER_FAILED_EVENT = 'dsh-chamber:stream-carrier-failed'

/** One bounded, non-secret carrier-failure fact. */
export interface CarrierFailureFact {
  readonly instanceId: string | undefined
  /** Carrier error name; never a payload or credential. */
  readonly stream: string
  readonly at: number
  /** 1-based count of carrier failures this page has observed. */
  readonly count: number
  /** Truncated gateway-internal message. */
  readonly message: string
}

/** Environment seams for {@link createCarrierFailureReporter}. */
export interface CarrierFailureEnvironment {
  readonly instanceId?: string | undefined
  readonly now?: (() => number) | undefined
  /** Dispatch seam; defaults to the page-level CustomEvent. */
  readonly dispatch?: ((fact: CarrierFailureFact) => void) | undefined
}

/** Longest carrier message copied into a fact. */
export const CARRIER_FACT_MESSAGE_MAX = 200

/** Build the per-ctx reporter: counts, bounds and publishes every carrier failure. */
export function createCarrierFailureReporter(
  env: CarrierFailureEnvironment = {},
): (error: unknown) => void {
  const now = env.now ?? ((): number => Date.now())
  const dispatch = env.dispatch ?? dispatchPageEvent
  let count = 0
  return (error: unknown): void => {
    count += 1
    const name = typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name?: unknown }).name ?? '')
      : ''
    const message = error instanceof Error ? error.message : String(error ?? '')
    const fact: CarrierFailureFact = {
      instanceId: env.instanceId,
      stream: name === '' ? 'RemoteStreamCarrierError' : name,
      at: now(),
      count,
      message: message.slice(0, CARRIER_FACT_MESSAGE_MAX),
    }
    // A page listener must never be able to break the reconnect loop.
    try {
      dispatch(fact)
    } catch {
      // Swallowed by contract: the stream's retry lane decides on the carrier error alone.
    }
  }
}

/** Default dispatch: one CustomEvent on the page (no-op outside a DOM). */
function dispatchPageEvent(fact: CarrierFailureFact): void {
  const page = globalThis as {
    dispatchEvent?: (event: unknown) => boolean
    CustomEvent?: new (type: string, init: { detail: CarrierFailureFact }) => unknown
  }
  if (page.dispatchEvent === undefined || page.CustomEvent === undefined) return
  page.dispatchEvent(new page.CustomEvent(STREAM_CARRIER_FAILED_EVENT, { detail: fact }))
}
