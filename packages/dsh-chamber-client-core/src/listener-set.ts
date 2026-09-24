/**
 * One listener set per store: identity-preserving {@link ListenerSet.subscribe}
 * plus a {@link ListenerSet.notify} drain.
 *
 * Every chamber client store repeats this pair (client-core's own stores, the
 * renderer host stores, the client-plugin stores). One implementation keeps the
 * subscribe contract (the returned function removes exactly this listener) and
 * the iteration discipline (snapshot the set before notifying, so a listener
 * that subscribes/unsubscribes during the drain cannot corrupt it) identical
 * everywhere. Generic over the emit arguments so the aggregate channel can use
 * it unchanged.
 */
export interface ListenerSet<Args extends unknown[] = []> {
  subscribe(listener: (...args: Args) => void): () => void
  notify(...args: Args): void
  /** Drop every listener (teardown / test-reset); the set stays usable. */
  clear(): void
}

export function createListenerSet<Args extends unknown[] = []>(): ListenerSet<Args> {
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    notify(...args) {
      for (const listener of [...listeners]) listener(...args)
    },
    clear() {
      listeners.clear()
    },
  }
}
