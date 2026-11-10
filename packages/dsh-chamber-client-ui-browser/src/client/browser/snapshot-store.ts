/**
 * Minimal observable snapshot store (carrier-local).
 *
 * The launcher only needs `getSnapshot/subscribe/set`. Keeping this in the package
 * (instead of importing the vendor store kernel) makes the native-guest provider
 * testable under plain node:test and keeps the carrier bundle self-contained.
 */

/** Immutable snapshot subscriber. */
export type SnapshotListener = () => void

/** Snapshot holder with invalidation. */
export interface SnapshotStore<T> {
  getSnapshot(): T
  set(value: T): void
  subscribe(listener: SnapshotListener): () => void
}

/**
 * Create a snapshot store.
 * @param initial - first value.
 * @returns the store.
 */
export function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let value = initial
  const listeners = new Set<SnapshotListener>()
  return {
    getSnapshot: () => value,
    set: (next: T) => {
      value = next
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener: SnapshotListener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
