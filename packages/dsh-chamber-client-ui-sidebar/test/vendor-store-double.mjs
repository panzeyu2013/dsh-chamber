/**
 * Test-only stand-in for the vendored `@deepseek-ai/dsh-client-store`
 * (2026-09-12 CI fix), used ONLY by this package's node unit tests.
 *
 * WHY: the real factory lives in vendor source whose module imports bare
 * `zustand`/`immer`. Whether those resolve depends on the install shape of the
 * vendored workspace member, which differs between a developer machine and CI
 * (run 34667681904: `ERR_MODULE_NOT_FOUND: Cannot find package 'zustand'`
 * imported from the vendor store's `src/index.ts`, both through the raw
 * submodule path and through the workspace member path). A unit test must not
 * depend on that: this file implements the ONE contract
 * `src/client/panel-source.ts` consumes — `createSnapshotStore(initial)` and its
 * `getSnapshot()` / `subscribe()` / `set()` — with the engine's observable
 * semantics (sync notify, and notification only when the value reference
 * actually changed).
 *
 * What still guarantees production rides the REAL engine:
 *   1. a source lock in `test/upstream-alignment.test.ts` (A5) pins
 *      `panel-source.ts` to `import { createSnapshotStore } from
 *      '@deepseek-ai/dsh-client-store'` and to `set()` as the write path, with
 *      the hand-rolled listener Set / observable forbidden;
 *   2. `pnpm run build:renderer` resolves that same specifier to the vendor
 *      source through vite's deepseekSource alias — a broken import fails the
 *      build, not a test;
 *   3. `test/panel-source.test.ts` keeps asserting the contract shape
 *      (`set`/`update` present, plain arrays, notify-only-on-change), so a
 *      return to a hand-rolled observable still fails.
 *
 * Never imported by `src`, the bundle or the typecheck.
 */

/**
 * Minimal engine double: contract-compatible with the vendored
 * `createSnapshotStore` for the surface this package uses.
 * @param initial - the initial snapshot value.
 * @returns `{ getSnapshot, subscribe, set, update }`.
 */
export function createSnapshotStore(initial) {
  let current = initial
  const listeners = new Set()
  const notify = () => { for (const listener of [...listeners]) listener(current) }
  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** Wholesale replace (the engine's plain-array write path). */
    set: (next) => {
      if (Object.is(next, current)) return
      current = next
      notify()
    },
    /** Shallow merge, the engine's `update` analogue without immer drafts. */
    update: (patch) => {
      const next = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) }
      current = next
      notify()
    },
  }
}
