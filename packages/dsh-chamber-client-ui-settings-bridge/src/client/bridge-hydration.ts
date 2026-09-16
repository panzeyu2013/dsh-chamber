/**
 * Shared singleton + hydration + subscription skeleton for the settings
 * bridge's app-global stores — the settings-store.ts (design 14 D7) /
 * update-store.ts (design 11) twin skeleton (settings-store.ts:17 says the
 * same: "Same design notes as update-store.ts"). Shared contract: one stable
 * useSyncExternalStore snapshot per module, ONE permanent bridge
 * subscription, hydration via a bounded 100ms×20 fast re-probe chain with
 * subscriber re-arm, push-wins-over-stale-query, and a PURE snapshot() (all
 * hydration from subscribe/commit or module load, never getSnapshot).
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
  /** 连续「surface 已在但 attach 失败」次数（2026-12 审查）：一次性失败要快速
   *  自愈（首次失败仍按 100ms 重试），但持续失败必须收敛——否则每次 fire 都重置背退
   *  会退化成 ~10Hz 的 invoke 风暴（Swift ready 前的 ipc_not_ready 即此形态）。 */
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
        // 成功即清连续失败计数并复位背退（一次失败后的自愈仍然是 100ms 级）。
        attachFailureStreak = 0
        retryDelayMs = 100
        // Push wins over a stale query snapshot: only apply the query result
        // when no push has landed yet.
        if (current === null) {
          current = state
          config.onQuery(state)
          notify()
        }
      })
      .catch(() => {
        attachFailureStreak += 1
        if (!config.slowReProbe) return
        // A one-shot query failure must not leave the store unhydrated
        // forever (the section would stay permanently disabled with no
        // error): release the latch, drop the listener, and re-arm the slow
        // probe chain.
        bridgeUnsubscribe?.()
        bridgeUnsubscribe = null
        bridgeSubscribed = false
        // 存储契约要求「一次性失败不得把 section 永久停在 disabled」——重探必须继续
        // （即使当前没有订阅者：settings-store 在模块加载时就开始水化）。收敛性由
        // 连续失败计数 + 成功才复位背退保证：100→200→…→2s（≤0.5Hz），不会退化成
        // 固定 100ms 的风暴。
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
      // 找到 surface 时通常立刻恢复 100ms 快节奏（一次性失败的自愈语义），但连续
      // 失败 ≥2 次就不再重置背退：延迟按 100→200→…→2s 收敛，风暴被压在 0.5Hz。
      if (attachFailureStreak < 2) retryDelayMs = 100
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
