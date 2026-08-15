/**
 * Minimal immutable snapshot store for the bridge rows (self-contained:
 * the official `createSnapshotStore` lives in the dsh client runtime whose
 * bare deps (zustand/immer) are not resolvable from this package's test
 * tree — the rows only need the HostObservable face (getSnapshot/subscribe)
 * plus plain update/set for the bridge-outlet kit).
 */

/** Writable observable snapshot source (the bridge rows' data face). */
export interface SnapshotStore<T> {
  /** Current snapshot (stable reference until the next change). */
  getSnapshot(): T
  /** Observe snapshot replacements. */
  subscribe(fn: () => void): () => void
  /** Mutate a draft copy and publish it (shallow-clone semantics). */
  update(mutator: (draft: T) => void): void
  /** Replace the state wholesale. */
  set(next: T): void
}

/** Clone one flat state value (arrays/objects shallow-copied; scalars returned). */
function cloneState<T>(value: T): T {
  if (Array.isArray(value)) return [...value] as T
  if (typeof value === 'object' && value !== null) return { ...value } as T
  return value
}

/**
 * Create a snapshot store over an initial state. Every publish replaces the
 * snapshot reference, so uSES-style consumers (the bridge outlet's
 * bindSnapshotSelector) re-render exactly on change.
 */
export function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void): () => void {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },
    update(mutator: (draft: T) => void): void {
      const draft = cloneState(state)
      mutator(draft)
      this.set(draft)
    },
    set(next: T): void {
      state = next
      for (const fn of listeners) fn()
    },
  }
}
