/**
 * Shared singleton + hydration + subscription skeleton for the settings
 * bridge's app-global stores — the settings-store.ts (design 14 D7) /
 * update-store.ts (design 11) twin skeleton (settings-store.ts:17 says the
 * same: "Same design notes as update-store.ts"). Both stores implement the
 * same module-level singleton over window.dshChamber.<surface>:
 *
 * - module-level singleton (the settings shell mounts per-ctx, but the state
 *   is app-global — one desktop main process), one stable snapshot for
 *   useSyncExternalStore, ONE permanent bridge subscription across all shell
 *   instances (zero listeners while idle — a push only wakes subscribers;
 *   assumes one module instance per page/shared chunk),
 * - hydration from the preload bridge (query + push): the bridge is exposed
 *   asynchronously (≤~500ms), so a bounded 100ms×20 fast re-probe chain
 *   retries briefly and the next subscriber re-arms a fresh chain,
 * - the push wins over a stale query snapshot (a push arriving between the
 *   query invoke and its resolution is never overwritten by the older query
 *   result),
 * - snapshot() is PURE (no side effects) — it must stay that way:
 *   useSyncExternalStore's getSnapshot runs during the render phase. All
 *   hydration is triggered from subscribe() (commit phase) and the
 *   module-load kick, never from getSnapshot.
 *
 * Parameterization covers only what the twin files genuinely share; where
 * the stores diverge the difference is a config member with per-store
 * values, never a behavior option on a shared call path:
 * - settings keeps slow-probing (backoff 100ms→2s, cap) while subscribers
 *   wait after the fast chain exhausts or a one-shot query fails (releasing
 *   the attach latch and dropping the listener first); update stays quiet
 *   after both — its permanent push listener stays attached and the next
 *   subscriber re-arms the fast chain (slowReProbe toggle).
 * - onPush/onQuery hold the stores' own acceptance bodies (settings
 *   recomputes its optimistic-save overlay on BOTH paths; update runs its
 *   restart single-flight release rule on pushes only).
 *
 * Every stateful field lives in the closure of one createBridgeHydration
 * call: each twin store module owns exactly one instance, and a
 * query-busted module re-import (the node:test fresh-store pattern) gets an
 * independent singleton — this module holds NO module-level mutable state.
 * Zero runtime dependencies, zero ambient imports: the surface accessor is
 * the store's own (its window.dshChamber typing comes from the ambient
 * declaration each store already imports).
 */

export interface BridgeHydrationConfig<TState, TSurface> {
  /** Bridge accessor: window.dshChamber?.<surface> ?? null, window-guarded
   *  (the twin stores are node-importable without a DOM). */
  surface: () => TSurface | null
  /** Attach the bridge's PERMANENT onChanged push listener and return its
   *  unsubscribe handle (both twins: api.onChanged(listener)). */
  onChanged: (api: TSurface, listener: (state: TState) => void) => () => void
  /** The bridge's one-shot authoritative state query (settings get() /
   *  update state()). */
  query: (api: TSurface) => Promise<TState>
  /** Store body of one BRIDGE PUSH — runs after the skeleton assigned the
   *  authoritative snapshot and before the notify: settings recomputes its
   *  optimistic overlay, update runs the restart single-flight release rule.
   *  Must stay side-effect-free w.r.t. the snapshot ordering contract (the
   *  skeleton assigned `current` first, exactly like the twin files did). */
  onPush: (state: TState) => void
  /** Store body of a QUERY result landing while no push has arrived yet
   *  (current === null — the push-wins rule): settings recomputes its
   *  optimistic overlay here too (an in-flight patch overlays the fresh
   *  authoritative base); update has no extra shaping. */
  onQuery: (state: TState) => void
  /** Slow re-probe chain toggle: settings keeps probing (backoff, capped at
   *  2s) while subscribers wait after the fast chain exhausts or a one-shot
   *  query failure (the failure also releases the attach latch and drops the
   *  push listener); update re-arms only from its next subscriber. */
  slowReProbe: boolean
}

/** One bridge-hydration singleton instance (see file header). */
export interface BridgeHydrationHost<TState, TSurface> {
  /** The authoritative snapshot or null (bridge absent / not hydrated yet).
   *  PURE — no side effects. */
  snapshot: () => TState | null
  /** useSyncExternalStore subscribe: adds the listener and re-arms hydration
   *  while the store is still unhydrated; returns the remover. */
  subscribe: (listener: () => void) => () => void
  /** Kick off hydration (both twin stores call it at module load — the
   *  bundle loads before the preload bridge resolves; the retry chains cover
   *  the gap). */
  hydrate: () => void
  /** Wake subscribers without changing the snapshot (settings drops a failed
   *  save from its optimistic overlay). */
  notify: () => void
  /** Replace the authoritative snapshot and wake subscribers (settings'
   *  newest-save settle writes the main-process result directly). */
  replace: (state: TState) => void
  /** The bridge accessor (window.dshChamber.<surface> ?? null) — shared by
   *  the stores' action functions (applySettingsPatch / requestUpdate*). */
  surface: () => TSurface | null
}

export function createBridgeHydration<TState, TSurface>(
  config: BridgeHydrationConfig<TState, TSurface>,
): BridgeHydrationHost<TState, TSurface> {
  let current: TState | null = null
  const listeners = new Set<() => void>()
  /** True once the bridge onChanged subscription is attached (module-wide, once). */
  let bridgeSubscribed = false
  /** Unsubscribe handle of the attached onChanged listener, or null. */
  let bridgeUnsubscribe: (() => void) | null = null
  /** The active hydration timer, or null when no chain is running (the fast
   *  re-probe chain and the slow probe share one slot — mutually exclusive
   *  by construction, exactly like the twin files' retryTimer). */
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  /** Slow-probe backoff: fast 100ms while the bridge is expected imminently,
   *  capped at 2s so a late bridge or a one-shot query failure can never
   *  strand the section permanently disabled. */
  let retryDelayMs = 100

  function notify(): void {
    for (const listener of listeners) listener()
  }

  function attachBridge(api: TSurface): void {
    if (bridgeSubscribed) return
    bridgeSubscribed = true
    bridgeUnsubscribe = config.onChanged(api, (state) => {
      current = state
      config.onPush(state)
      notify()
    })
    void config.query(api)
      .then((state) => {
        // Push wins over a stale query snapshot: only apply the query result
        // when no push has landed yet.
        if (current === null) {
          current = state
          config.onQuery(state)
          notify()
        }
      })
      .catch(() => {
        if (!config.slowReProbe) return
        // A one-shot query failure must not leave the store unhydrated
        // forever (the section would stay permanently disabled with no
        // error): release the latch, drop the listener, and re-arm the slow
        // probe chain.
        bridgeUnsubscribe?.()
        bridgeUnsubscribe = null
        bridgeSubscribed = false
        scheduleSlowProbe()
      })
  }

  /** Schedule one slow re-probe fire (the backoff doubles per schedule and
   *  resets once a fire finds the bridge — the twin bytes of settings-store
   *  retryLater). One at a time: the timer slot is shared with the fast
   *  chain. */
  function scheduleSlowProbe(): void {
    if (retryTimer !== null) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      const api = config.surface()
      if (api === null) {
        // Keep probing only while a subscriber is actually waiting for a
        // snapshot; otherwise the next subscriber re-arms a fresh chain.
        if (current === null && listeners.size > 0) scheduleSlowProbe()
        return
      }
      retryDelayMs = 100
      attachBridge(api)
    }, retryDelayMs)
    retryDelayMs = Math.min(retryDelayMs * 2, 2_000)
  }

  /** Bounded fast re-probe chain (100ms × 20): the preload exposes the
   *  bridge asynchronously, so hydration retries briefly; on exhaustion the
   *  store either falls back to the slow probe (settings — while
   *  subscribers wait) or to the next subscriber's re-arm (update). */
  function hydrate(): void {
    if (bridgeSubscribed || retryTimer !== null) return
    const tryAttach = (attempt: number): void => {
      const api = config.surface()
      if (api === null) {
        if (attempt < 20) {
          retryTimer = setTimeout(() => tryAttach(attempt + 1), 100)
        } else {
          retryTimer = null
          if (config.slowReProbe && listeners.size > 0) scheduleSlowProbe()
        }
        return
      }
      retryTimer = null
      attachBridge(api)
    }
    tryAttach(0)
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    // Re-arm hydration when the bridge never landed (a failed chain retries
    // on the next subscriber instead of giving up forever).
    if (current === null) hydrate()
    return () => {
      listeners.delete(listener)
    }
  }

  return {
    snapshot: () => current,
    subscribe,
    hydrate,
    notify,
    replace: (state: TState): void => {
      current = state
      notify()
    },
    surface: () => config.surface(),
  }
}
