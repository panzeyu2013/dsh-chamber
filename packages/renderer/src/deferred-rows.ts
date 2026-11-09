/**
 * Deferred-chunk row settlement: a bounded wait per chunk.
 *
 * The deferred cluster loads PER ROW after the boot settles; a chunk that never
 * arrives (proxy stall, dropped response, hung fetch) used to hang the `Promise.all`
 * forever, so the whole cluster stayed unmounted and the shell got NO diagnostic
 * (the per-row catch only witnesses rejections). This leaf gives every row a
 * deadline: a row whose chunk never settles is reported as a failed id like a rejection,
 * and the shell re-boots the instance to retry (design 09 §3.5 — deferred failures
 * are diagnostics, never a boot gate).
 *
 * Pure timers, no DOM: the caller keeps the roster and owns the report.
 */

/** How long one deferred chunk may take before its row is reported as failed (ms).
 *  Generous on purpose: the wave is same-origin but a slow SSH/WAN link legitimately needs
 *  seconds per chunk, and a FALSE timeout costs the auto re-boot path (one banner + a fresh
 *  boot). 30 s still turns a true hang into a reportable failure well inside a page session. */
export const DEFERRED_ROW_DEADLINE_MS = 30_000

/** The row's deadline expired before its chunk settled (the chunk was never witnessed). */
export class DeferredRowTimeoutError extends Error {
  readonly id: string
  readonly deadlineMs: number

  constructor(id: string, deadlineMs: number) {
    super(`deferred chunk ${id} did not settle within ${deadlineMs}ms`)
    this.name = 'DeferredRowTimeoutError'
    this.id = id
    this.deadlineMs = deadlineMs
  }
}

/**
 * Resolve `load` on arrival, or reject with {@link DeferredRowTimeoutError} at the
 * deadline. The load promise is never cancelled (an import cannot be aborted); a
 * chunk arriving after the deadline is simply not mounted — the shell re-boots the
 * instance on the reported failure, which retries the cluster from a fresh boot.
 */
export function withDeferredRowDeadline<T>(
  id: string,
  load: Promise<T>,
  deadlineMs: number = DEFERRED_ROW_DEADLINE_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeferredRowTimeoutError(id, deadlineMs)), deadlineMs)
    load.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}
