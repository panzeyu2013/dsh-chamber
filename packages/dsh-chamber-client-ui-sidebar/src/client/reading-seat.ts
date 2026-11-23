/**
 * Page-level reading seats (design 06 §4.1; alpha.1 session-status).
 *
 * WHAT: every mounted sidebar shell (one per N-ctx instance) publishes ONE seat for
 * its own source: whether that source's Host reading baseline has arrived
 * (`uiSession.sessionStatus.readingReady`). Rows are rendered by EVERY shell — the
 * page-level aggregate lists all sources — so a row's mark menu must consult the
 * seat of the row's own source, not the rendering shell's state. A source whose
 * shell is not mounted has no seat and its rows offer no mark (the transport is
 * per-instance, and the unread bit would have no authority).
 *
 * WHAT IT IS NOT: the write path. Marks go through the page-level unary
 * (`session-status-marks.ts`, `sessionStatus/mark`) so a foreign source's row is
 * actionable without borrowing another ctx's remote namespace; the seat only gates.
 *
 * LIFECYCLE: publish → re-publish on every `readingReady` change → retire on shell
 * teardown. The page-level map is a module singleton like `panel-axis`, because the
 * shells of one page share one document and one aggregate.
 */

/** One mounted shell's reading readiness for its own source. */
export interface ReadingSeat {
  /** Whether marks can be sent: the Host reading baseline for this source arrived. */
  readonly ready: boolean
}

const seats = new Map<string, ReadingSeat>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/**
 * Publish (or refresh) one source's seat.
 * @param sourceId - the shell's `chamberInstanceId` (also the aggregate source id).
 * @param seat - current readiness of that source.
 * @returns a disposer retiring the seat (only when it is still THIS publication).
 */
export function publishReadingSeat(sourceId: string, seat: ReadingSeat): () => void {
  seats.set(sourceId, seat)
  notify()
  return () => {
    if (seats.get(sourceId) !== seat) return
    seats.delete(sourceId)
    notify()
  }
}

/** The seat of one source, or undefined when its shell is not mounted. */
export function readingSeatOf(sourceId: string): ReadingSeat | undefined {
  return seats.get(sourceId)
}

/** Whether a source's reading baseline arrived (false when it has no mounted shell). */
export function readingReadyOf(sourceId: string): boolean {
  return seats.get(sourceId)?.ready === true
}

/** Subscribe to seat publication/retirement (react `useSyncExternalStore` input). */
export function subscribeReadingSeats(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
