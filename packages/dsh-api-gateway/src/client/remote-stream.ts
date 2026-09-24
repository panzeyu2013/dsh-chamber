/**
 * Reconnecting lifecycle for one single-consumer Remote stream: carrier failures
 * inside a LIVE connection generation are paced and reopened with bounded backoff
 * instead of escaping as a terminal error (upstream threw on the second rapid
 * failure and the controller latched it, freezing the surface). The pacing math and
 * abortable wait live in `./remote-retry-policy.ts` (pure, zero-import).
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

/** Real clock, injected: the bound's SCHEDULING lives in the primitive; its VALUE stays local. */
const RETRY_SCHEDULER = {
  setTimeout: (run: () => void, ms: number): unknown => setTimeout(run, ms),
  clearTimeout: (handle: unknown): void => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

// A cancelled source can ignore AbortSignal and leave its pending next()/return()
// unresolved. The logical stream must release Session.resync() even then; the
// lifetime signal and revision fence below prevent a late source item from being
// published after this bounded drain.
const SOURCE_CANCEL_DRAIN_MS = 2_000
const SOURCE_ABORTED = Symbol('remote stream source aborted')

/** One item annotated with the physical Remote-stream generation that delivered it. */
export interface RemoteStreamItem<Item> {
  readonly generation: number
  readonly value: Item
  /** Cancellation lifetime of the generation that delivered this item. */
  readonly signal: AbortSignal
  /** Mark this generation's opening baseline or cursor as accepted. */
  accept(): void
}

/** Domain-owned operations used by {@link RemoteStream}. */
export interface RemoteStreamOptions<Item> {
  readonly name: string
  readonly open: (signal: AbortSignal) => AsyncIterable<Item>
  /** Classify a normal generation end after or before its opening item was accepted. */
  readonly ended: (accepted: boolean) => Error
  /** Observe a retryable carrier loss before the supervisor waits or reopens. */
  readonly carrierFailed?: (error: RemoteStreamCarrierError) => void
}

/**
 * Reopens one logical Remote stream across carrier generations. Connection owns
 * physical retry timing; Gateway performs each requested replacement; the domain
 * consumer calls {@link RemoteStreamItem.accept} only after validating the opening
 * baseline or cursor.
 */
export class RemoteStream<Item> implements AsyncIterable<RemoteStreamItem<Item>> {
  private readonly lifetime = new AbortController()
  private generationAbort: AbortController | undefined
  private iterator: AsyncGenerator<RemoteStreamItem<Item>> | undefined
  private closing: Promise<void> | undefined
  private revision = 0
  private taken = false

  /** @param connection - observable Host generation source used to pace retries. */
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

  /** Permanently stop this stream and wait for its iterator to close. */
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
        let source: AsyncIterator<Item> | undefined
        let sourceEnded = false
        try {
          source = this.options.open(signal)[Symbol.asyncIterator]()
          while (true) {
            // A plain for-await waits forever if a source ignores abort while its
            // next() is pending. Race that wait with this generation's signal so
            // cancellation remains owned by RemoteStream rather than by every
            // generated endpoint implementation.
            const next = await sourceNextOrAbort(source, signal)
            if (next === SOURCE_ABORTED) break
            if (next.done) {
              sourceEnded = true
              break
            }
            if (isAborted(this.lifetime.signal)) return
            if (revision !== this.revision) break
            yield {
              generation: generationId,
              value: next.value,
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
            // The wait for a live generation is bounded; on expiry the reopen below
            // IS the recovery attempt, published on the same seam a carrier loss uses
            // so the page fact sees "waiting with no progress", not an error-less stall.
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
          if (source !== undefined && !sourceEnded) await closeRemoteSource(source)
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

/** One source read that settles when its generation is cancelled, even if the
 * underlying async iterator ignores AbortSignal. Promise.race observes a late
 * rejection from next(); no unhandled rejection escapes after cancellation. */
async function sourceNextOrAbort<Item>(
  source: AsyncIterator<Item>, signal: AbortSignal,
): Promise<IteratorResult<Item> | typeof SOURCE_ABORTED> {
  if (signal.aborted) return SOURCE_ABORTED
  let onAbort: (() => void) | undefined
  const aborted = new Promise<typeof SOURCE_ABORTED>((resolve) => {
    onAbort = (): void => { resolve(SOURCE_ABORTED) }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    return await Promise.race([source.next(), aborted])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/** Abort was already signalled by the owner. A cooperative source drains fully;
 * a stuck return() cannot hold the replacement generation or Session.resync(). */
async function closeRemoteSource<Item>(source: AsyncIterator<Item>): Promise<void> {
  try {
    const closing = Promise.resolve().then(() => source.return?.())
    await withDeadline(closing, {
      ms: SOURCE_CANCEL_DRAIN_MS,
      onExpire: () => undefined,
      scheduler: RETRY_SCHEDULER,
    })
  } catch {
    // The source has no remaining consumer after its generation is cancelled.
  }
}

/**
 * How the retry lane's wait ended — the caller publishes an expired wait as a
 * carrier condition (bounded, observable) instead of a silent stall.
 */
type RemoteStreamRetryOutcome = 'generation' | 'expired'

/**
 * Pace the next reopen after a carrier failure. With a LIVE generation, wait the
 * bounded episode backoff and reopen — a second failure is still a transport hiccup,
 * never terminal. With NO generation, wait for one bounded by
 * {@link REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS} (upstream waited without a timer,
 * parking every stream forever): on expiry the caller reopens and publishes the
 * condition through `carrierFailed`. Abort still ends the stream terminally.
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
  // A PUSH wait, not a poll: the announcement arrives through subscribe, so the
  // condition is never re-inspected on a timer (which would delay detection).
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
 * Mark a terminal escape before it crosses the stream boundary (consumers
 * discriminate by code). The carrier class never escapes — it stays the
 * retry-internal signal; only non-carrier errors, aborts and `ended()` are terminal.
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
