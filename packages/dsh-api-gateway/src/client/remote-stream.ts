/**
 * Reconnecting lifecycle for one single-consumer Remote stream.
 * chamber fork patch (design 14 §D4): carrier failures inside a LIVE connection
 * generation are paced and reopened with a bounded backoff instead of escaping
 * as a terminal stream error. Upstream threw the carrier error on the second
 * rapid failure (`waitForRemoteStreamRetry`); the gateway wrapped it as
 * `gateway/internal`, and the session controller latched it on
 * `failEventStream()` — which froze the conversation surface with no retry.
 * The pacing math and the abortable backoff wait live in
 * `./remote-retry-policy.ts` (pure, zero-import, unit-tested); the patch's shape
 * is pinned by `test/patch-lock/remote-stream-carrier-retry-lock.test.ts`.
 */

import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  delayRemoteStreamRetry,
  remoteStreamRetryDelayMs,
  REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS,
} from './remote-retry-policy.ts'
import { RemoteStreamCarrierError } from './stream-client.ts'
import { withDeadline } from '@dsh-chamber/dsh-stream-state'

/** The real clock, injected: the package itself imports nothing. Only the bound's
 *  SCHEDULING moves to the primitive; the bound's VALUE stays the local constant. */
const RETRY_SCHEDULER = {
  setTimeout: (run: () => void, ms: number): unknown => setTimeout(run, ms),
  clearTimeout: (handle: unknown): void => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

/** One item annotated with the physical Remote-stream generation that delivered it. */
export interface RemoteStreamItem<Item> {
  /** Monotone physical generation number within this logical stream. */
  readonly generation: number
  /** Decoded item yielded by the generated Remote method. */
  readonly value: Item
  /** Cancellation lifetime of the generation that delivered this item. */
  readonly signal: AbortSignal
  /** Mark this generation's opening baseline or cursor as accepted. */
  accept(): void
}

/** Domain-owned operations used by {@link RemoteStream}. */
export interface RemoteStreamOptions<Item> {
  /** Diagnostic owner name used for cancellation failures. */
  readonly name: string
  /** Open one physical generation of the logical stream. */
  readonly open: (signal: AbortSignal) => AsyncIterable<Item>
  /** Classify a normal generation end after or before its opening item was accepted. */
  readonly ended: (accepted: boolean) => Error
  /** Observe a retryable carrier loss before the supervisor waits or reopens. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
}

/**
 * Reopens one logical Remote stream across carrier generations.
 * Connection owns physical retry timing; Gateway performs each requested
 * replacement. The domain consumer owns its opening item and every later
 * item, and calls {@link RemoteStreamItem.accept} only after validating the
 * opening baseline or cursor.
 */
export class RemoteStream<Item> implements AsyncIterable<RemoteStreamItem<Item>> {
  private readonly lifetime = new AbortController()
  private generationAbort: AbortController | undefined
  private iterator: AsyncGenerator<RemoteStreamItem<Item>> | undefined
  private closing: Promise<void> | undefined
  private revision = 0
  private taken = false

  /**
   * @param connection - observable Host generation source used to pace retries.
   * @param options - domain stream opener, end classification, and diagnostics.
   */
  constructor(
    private readonly connection: Pick<ConnectionHandle, 'generation'>,
    private readonly options: RemoteStreamOptions<Item>,
  ) {}

  /** Cancellation lifetime shared by the stream and sibling page requests. */
  get signal(): AbortSignal {
    return this.lifetime.signal
  }

  /** Interrupt the current generation and immediately request a replacement. */
  restart(): void {
    if (this.lifetime.signal.aborted) return
    this.revision++
    this.generationAbort?.abort(new Error(`${this.options.name} generation restarted`))
  }

  /**
   * Permanently stop this stream and wait for its iterator to close.
   * @returns when the active generation and consumer iterator are quiescent.
   */
  dispose(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    if (!this.lifetime.signal.aborted) {
      const reason = new Error(`${this.options.name} disposed`)
      this.lifetime.abort(reason)
      this.generationAbort?.abort(reason)
    }
    const iterator = this.iterator
    if (iterator === undefined) return Promise.resolve()
    const closing = closeRemoteStreamIterator(iterator)
    this.closing = closing
    return closing
  }

  /** @inheritdoc */
  [Symbol.asyncIterator](): AsyncIterator<RemoteStreamItem<Item>> {
    if (this.taken) throw new Error(`${this.options.name} already has a consumer`)
    this.taken = true
    const iterator = this.read()
    this.iterator = iterator
    return iterator
  }

  private async * read(): AsyncGenerator<RemoteStreamItem<Item>> {
    let attempt = 0
    let generation = 0
    let observedRevision = this.revision
    try {
      while (!isAborted(this.lifetime.signal)) {
        if (observedRevision !== this.revision) {
          observedRevision = this.revision
          attempt = 0
        }
        const revision = this.revision
        const generationAbort = new AbortController()
        this.generationAbort = generationAbort
        const signal = AbortSignal.any([this.lifetime.signal, generationAbort.signal])
        const generationId = ++generation
        let accepted = false
        try {
          for await (const value of this.options.open(signal)) {
            if (isAborted(this.lifetime.signal)) return
            if (revision !== this.revision) break
            yield {
              generation: generationId,
              value,
              signal,
              accept: () => {
                if (this.generationAbort !== generationAbort || revision !== this.revision) return
                accepted = true
                attempt = 0
              },
            }
          }
          if (isAborted(this.lifetime.signal)) return
          if (revision !== this.revision) continue
          throw this.options.ended(accepted)
        } catch (error) {
          if (isAborted(this.lifetime.signal)) return
          if (revision !== this.revision) continue
          if (!(error instanceof RemoteStreamCarrierError)) throw terminalStreamFailure(error)
          this.options.carrierFailed?.(error)
          if (revision !== this.revision) continue
          attempt++
          try {
            const retryOutcome = await waitForRemoteStreamRetry(this.connection, attempt, signal)
            // chamber (): the retry lane's wait for a
            // live generation is now bounded; when the bound fires, the reopen
            // below is the recovery attempt and the state is published on the
            // SAME seam a carrier loss uses, so the page fact (and the health
            // arm reading it) sees "waiting with no progress" instead of an
            // invisible, error-less stall.
            if (retryOutcome === 'expired') {
              this.options.carrierFailed?.(
                new RemoteStreamCarrierError(
                  `${this.options.name}: retry lane waited ${REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS}ms without a connection generation`,
                ),
              )
            }
          } catch (retryError) {
            if (isAborted(this.lifetime.signal)) return
            if (revision !== this.revision) continue
            throw terminalStreamFailure(retryError)
          }
        } finally {
          this.generationAbort = undefined
          if (!generationAbort.signal.aborted) {
            generationAbort.abort(new Error(`${this.options.name} generation ended`))
          }
        }
      }
    } finally {
      if (!this.lifetime.signal.aborted) {
        this.lifetime.abort(new Error(`${this.options.name} consumer closed`))
      }
      this.generationAbort?.abort(this.lifetime.signal.reason)
      this.generationAbort = undefined
    }
  }
}

/**
 * How the retry lane's wait ended — the caller publishes an expired wait as a
 * carrier condition (bounded, observable) instead of a silent stall.
 */
type RemoteStreamRetryOutcome = 'generation' | 'expired'

/**
 * Pace the next reopen after a carrier failure.
 * - LIVE generation (the connection lane is up): wait the bounded episode
 *   backoff and reopen. A second failure is still a transport hiccup — it must
 *   NOT escape as a terminal stream outcome (the chamber fork patch).
 * - NO generation: wait for the connection to publish one, **bounded** by
 *   {@link REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS}. Upstream waited without a
 *   timer, so a parked lane parked every logical stream on this page forever
 *   (no error edge, no reopen attempt, nothing in the UI but the loading hint).
 *   On expiry the wait resolves with `'expired'` so the caller reopens — the
 *   one action that recovers when the mux itself is still usable — and publishes
 *   the condition through `carrierFailed`. The abort path still ends the stream
 *   terminally.
 * @param connection - observable Host generation source used to pace retries.
 * @param attempt - 1-based consecutive carrier-failure count for this episode.
 * @param signal - generation cancellation lifetime.
 * @returns `'generation'` when a live generation paced the wait, `'expired'`
 *   when the wait hit its bound and the caller should reopen anyway.
 */
async function waitForRemoteStreamRetry(
  connection: Pick<ConnectionHandle, 'generation'>,
  attempt: number,
  signal: AbortSignal,
): Promise<RemoteStreamRetryOutcome> {
  signal.throwIfAborted()
  if (connection.generation.getSnapshot() !== undefined) {
    const delayMs = remoteStreamRetryDelayMs(attempt)
    if (delayMs > 0) await delayRemoteStreamRetry(delayMs, signal)
    return 'generation'
  }
  //  (W1): this is a PUSH wait, not a poll - the generation announcement arrives
  // through `subscribe`, so the condition must never be re-inspected on a timer
  // (waitForCondition would delay detection by up to one poll interval). The shared
  // primitive therefore wraps the SUBSCRIPTION as the operation and races it against
  // the same single bound as before; abort keeps rejecting, expiry keeps resolving
  // 'expired', and dispose still runs on every path.
  let dispose: (() => void) | undefined
  let onAbort: (() => void) | undefined
  const generationArrived = new Promise<void>((resolve, reject) => {
    onAbort = (): void => {
      reject(new Error('Remote stream retry aborted', { cause: signal.reason }))
    }
    const inspect = (): void => {
      if (connection.generation.getSnapshot() !== undefined) resolve()
    }
    dispose = connection.generation.subscribe(inspect)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    else inspect()
  })
  try {
    const raced = await withDeadline(generationArrived, {
      ms: REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS,
      onExpire: () => 'expired' as const,
      scheduler: RETRY_SCHEDULER,
    })
    return raced.settled === 'deadline' ? 'expired' : 'generation'
  } finally {
    dispose?.()
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Mark a terminal escape before it crosses the stream boundary: consumers
 * discriminate failures by code, so an unmarked throw reads as a local bug.
 * Marked failures pass through verbatim. The carrier class never escapes as a
 * terminal outcome — it stays the retry-internal signal fed to `carrierFailed`
 * and the `ended(true)` retry trigger. Enforced by the retry policy above: the
 * only terminal escapes left are a non-carrier error, an aborted lifetime or
 * generation signal, and `ended()`'s own classification.
 */
function terminalStreamFailure(error: unknown): Error {
  return remoteErrorOf(error) ?? new RemoteError(
    'gateway/internal',
    error instanceof Error ? error.message : String(error),
    {},
    { cause: error },
  )
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

async function closeRemoteStreamIterator<Item>(
  iterator: AsyncIterator<RemoteStreamItem<Item>>,
): Promise<void> {
  try {
    await iterator.return?.()
  } catch {
    // The disposed logical stream has no remaining consumer for cancellation failures.
  }
}
