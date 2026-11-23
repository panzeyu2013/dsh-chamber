/**
 * React binding for the page-level reading seats (`reading-seat.ts`).
 *
 * A session row is rendered by every shell, but its mark menu is only actionable
 * when the row's OWN source has a mounted shell whose status service received the
 * Host reading baseline. Seat publication/retirement and the readiness flip both
 * notify page-level subscribers, so one `useSyncExternalStore` per row is enough;
 * seat changes are rare (mount/unmount/baseline), so the shared listener set is
 * cheap even with a full list of rows.
 */
import { useSyncExternalStore } from 'react'
import { readingReadyOf, subscribeReadingSeats } from './reading-seat.ts'

/**
 * Subscribe to one source's reading readiness.
 * @param sourceId - the row's aggregate source id.
 * @returns true only when that source's shell published a ready seat.
 */
export function useReadingReady(sourceId: string): boolean {
  return useSyncExternalStore(
    subscribeReadingSeats,
    () => readingReadyOf(sourceId),
    () => readingReadyOf(sourceId),
  )
}
