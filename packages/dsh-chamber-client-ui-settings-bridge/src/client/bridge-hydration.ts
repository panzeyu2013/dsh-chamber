/**
 * Shared singleton + hydration + subscription skeleton for the settings bridge's
 * app-global stores — the settings-store / update-store twin skeleton. Shared contract:
 * one stable useSyncExternalStore snapshot per module, ONE permanent bridge
 * subscription, hydration via a bounded 100ms×20 fast re-probe chain with subscriber
 * re-arm, push-wins-over-stale-query, and a PURE snapshot() (all hydration from
 * subscribe/commit or module load, never getSnapshot).
 *
 * Divergences are config members with per-store values, never behavior options on a
 * shared call path: settings keeps slow-probing (backoff 100ms→2s) while subscribers
 * wait after the fast chain exhausts; update stays quiet after both (the next subscriber
 * re-arms). Every stateful field lives in the closure of one createBridgeHydration
 * call — this module holds NO module-level mutable state.
 */

export interface BridgeHydrationConfig<TState, TSurface> {
  /** Bridge accessor: window.dshChamber?.<surface> ?? null, window-guarded (node-importable). */
  surface: () => TSurface | null
  /** Attach the bridge's PERMANENT onChanged push listener and return its unsubscribe handle. */
  onChanged: (api: TSurface, listener: (state: TState) => void) => () => void
  /** The bridge's one-shot authoritative state query (settings get() / update state()). */
  query: (api: TSurface) => Promise<TState>
  /** Store body of one BRIDGE PUSH — runs after the skeleton assigned the authoritative
   *  snapshot and before the notify. Must stay side-effect-free w.r.t. the ordering
   *  contract (the skeleton assigns `current` first). */
  onPush: (state: TState) => void
  /** Store body of a QUERY result landing while no push has arrived yet (current ===
   *  null — the push-wins rule): settings recomputes its optimistic overlay here too;
   *  update has no extra shaping. */
  onQuery: (state: TState) => void
  /** Slow re-probe chain toggle: settings keeps probing (backoff, capped at 2s) while
   *  subscribers wait; update re-arms only from its next subscriber. */
  slowReProbe: boolean
}

/** One bridge-hydration singleton instance (see file header). */
export interface BridgeHydrationHost<TState, TSurface> {
  /** The authoritative snapshot or null (bridge absent / not hydrated yet).
   *  PURE — no side effects. */
  snapshot: () => TState | null
  /** useSyncExternalStore subscribe: adds the listener, re-arms hydration while unhydrated, returns the remover. */
  subscribe: (listener: () => void) => () => void
  /** Kick off hydration (both twins call it at module load — the bundle loads before
   *  the preload bridge resolves; the retry chains cover the gap). */
  hydrate: () => void
  /** Wake subscribers without changing the snapshot (settings drops a failed save from its overlay). */
  notify: () => void
  /** Replace the authoritative snapshot and wake subscribers (newest-save settle writes the result directly). */
  replace: (state: TState) => void
  /** The bridge accessor (window.dshChamber.<surface> ?? null) — shared by the stores' action functions. */
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
  /** The active hydration timer, or null when no chain is running (fast chain and
   *  slow probe share one slot — mutually exclusive by construction). */
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  /** Slow-probe backoff: fast 100ms while the bridge is expected imminently, capped
   *  at 2s so a late bridge or query failure can never strand the section disabled. */
  let retryDelayMs = 100
  /** 连续「surface 已在但 attach 失败」次数：一次性失败快速自愈（首次仍 100ms），
   *  但持续失败必须收敛——否则每次 fire 重置背退会退化成 ~10Hz 的 invoke 风暴。 */
  let attachFailureStreak = 0

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
        // 成功即清连续失败计数并复位背退（一次失败后的自愈仍是 100ms 级）。
        attachFailureStreak = 0
        retryDelayMs = 100
        // Push wins over a stale query snapshot: apply the query result only when no push has landed yet.
        if (current === null) {
          current = state
          config.onQuery(state)
          notify()
        }
      })
      .catch(() => {
        attachFailureStreak += 1
        if (!config.slowReProbe) return
        // A one-shot query failure must not leave the store unhydrated forever (the
        // section stays permanently disabled with no error): release the latch, drop
        // the listener, and re-arm the slow probe chain.
        bridgeUnsubscribe?.()
        bridgeUnsubscribe = null
        bridgeSubscribed = false
        // 一次性失败不得把 section 永久停在 disabled——重探必须继续（即使无订阅者）。
        // 收敛性由连续失败计数 + 成功才复位背退保证：100→200→…→2s（≤0.5Hz）。
        scheduleSlowProbe()
      })
  }

  /** Schedule one slow re-probe fire (backoff doubles per schedule, resets once a
   *  fire finds the bridge). The timer slot is shared with the fast chain. */
  function scheduleSlowProbe(): void {
    if (retryTimer !== null) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      const api = config.surface()
      if (api === null) {
        // Keep probing only while a subscriber waits for a snapshot; otherwise the next subscriber re-arms.
        if (current === null && listeners.size > 0) scheduleSlowProbe()
        return
      }
      // 找到 surface 时通常立刻恢复 100ms 快节奏；连续失败 ≥2 次停止重置背退，
      // 延迟按 100→200→…→2s 收敛，风暴被压在 0.5Hz。
      if (attachFailureStreak < 2) retryDelayMs = 100
      attachBridge(api)
    }, retryDelayMs)
    retryDelayMs = Math.min(retryDelayMs * 2, 2_000)
  }

  /** Bounded fast re-probe chain (100ms × 20): the preload exposes the bridge
   *  asynchronously, so hydration retries briefly; on exhaustion settings falls back
   *  to the slow probe (while subscribers wait), update to the next subscriber's re-arm. */
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
    // Re-arm hydration when the bridge never landed (a failed chain retries on the next subscriber).
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
