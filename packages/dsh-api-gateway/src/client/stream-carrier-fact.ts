/**
 * Page-level carrier-churn fact (design 14 §D4).
 *
 * Upstream plumbs `carrierFailed` through the gateway and the session controller
 * but NOTHING consumes it, so a sustained carrier fault inside a live connection
 * generation is silent: the
 * transport lane is healthy, the stream keeps reopening every ≤10s, and no user
 * surface says a word. This module turns that seam into an addressable page fact.
 *
 * Zero imports on purpose: the counter/payload/dispatch contract is testable in
 * plain Node (dispatch is injected) and the browser default only touches the
 * globals the page already owns.
 */

/** Document-level event name carrying one {@link CarrierFailureFact}. */
export const STREAM_CARRIER_FAILED_EVENT = 'dsh-chamber:stream-carrier-failed'

/** One bounded, non-secret carrier-failure fact. */
export interface CarrierFailureFact {
  /** Chamber source id of the boot ctx that owns the stream, when published. */
  readonly instanceId: string | undefined
  /** Carrier error name (diagnostic; never a payload or credential). */
  readonly stream: string
  /** Wall-clock milliseconds of this failure. */
  readonly at: number
  /** 1-based count of carrier failures this page has observed. */
  readonly count: number
  /** Truncated carrier message (gateway-internal English copy only). */
  readonly message: string
}

/** Environment seams for {@link createCarrierFailureReporter}. */
export interface CarrierFailureEnvironment {
  /** Chamber source id of the owning boot ctx. */
  readonly instanceId?: string | undefined
  /** Clock seam (tests). */
  readonly now?: (() => number) | undefined
  /** Dispatch seam (tests); defaults to the page-level CustomEvent. */
  readonly dispatch?: ((fact: CarrierFailureFact) => void) | undefined
}

/** Longest carrier message copied into a fact. */
export const CARRIER_FACT_MESSAGE_MAX = 200

/**
 * Build the per-ctx carrier-failure reporter.
 *
 * The returned handler is idempotent per failure OBJECT: one physical carrier
 * fault can cross more than one reporting boundary (a generated stream nested
 * inside the `$stream` RemoteStream), and this page fact counts faults, not
 * boundaries. Distinct failures always count, even when their messages match.
 * @param env - instance id plus the clock/dispatch seams.
 * @returns a handler that counts, bounds and publishes every distinct carrier failure.
 */
export function createCarrierFailureReporter(
  env: CarrierFailureEnvironment = {},
): (error: unknown) => void {
  const now = env.now ?? ((): number => Date.now())
  const dispatch = env.dispatch ?? dispatchPageEvent
  const reported = new WeakSet<object>()
  let count = 0
  return (error: unknown): void => {
    if (typeof error === 'object' && error !== null) {
      if (reported.has(error)) return
      reported.add(error)
    }
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

/**
 * Forward a stream source, reporting one escaped carrier failure before it
 * reaches the consumer.
 *
 * This is the boundary for streams that never pass through `RemoteStream`:
 * generated endpoint streams (`invokeStream`) and the forwarded Remote event
 * stream. Their carrier failures are already classified, but only the `$stream`
 * construction had a reporter, so the page-level content-churn fact missed them.
 * A non-carrier escape (protocol fault, cancellation) is rethrown untouched and
 * publishes nothing, because only the caller can classify its own error type.
 * @param source - the stream source being consumed.
 * @param isCarrierFailure - classifies an escaped error as a carrier failure.
 * @param report - the owning client's one carrier-failure reporter (idempotent per failure).
 * @returns a generator forwarding every item and reporting one escaped carrier failure.
 */
export async function* reportStreamCarrierFailures<Item>(
  source: AsyncIterable<Item>,
  isCarrierFailure: (error: unknown) => boolean,
  report: (error: unknown) => void,
): AsyncGenerator<Item> {
  try {
    yield * source
  } catch (error) {
    if (isCarrierFailure(error)) report(error)
    throw error
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
