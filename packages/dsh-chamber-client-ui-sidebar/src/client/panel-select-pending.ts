/**
 * Boot-race-safe holder for ONE page-level panel-select intent (per shell).
 *
 * The sidebar is first-screen sync while the panellist registrants are host-graph
 * extra rows, so the target shell's apply can run before the panel axis carries the
 * entry. The intent therefore arms locally and resolves on the axis change; only the
 * core TTL (measured from the ORIGINAL click instant) discards it. Pure: the clock,
 * the axis membership read and the selection callback are injected, so the two
 * windows (intent before registration / intent handed off during teardown) are
 * behavior-testable without React or DOM.
 */

export interface PanelSelectPendingOptions {
  /** The core one-shot intent lifetime (design 05 §2). */
  readonly ttlMs: number
  /** Monotonic clock in milliseconds. */
  readonly now: () => number
  /** Whether the panel id is registered on THIS shell's axis right now. */
  readonly isRegistered: (panelId: string) => boolean
  /** Select one registered panel on this shell's layout. */
  readonly selectPanel: (panelId: string) => void
}

export interface PanelSelectPending {
  /** Arm an intent and try it immediately (a registered panel hits at once). */
  arm(panelId: string, at?: number): void
  /** Resolve the held intent if its panel is now registered; returns whether it ran. */
  tryResolve(): boolean
  /** The unresolved intent, for the teardown handoff back to the core pending slot. */
  pending(): { readonly panelId: string; readonly at: number } | undefined
  /** Drop any held intent without selecting. */
  clear(): void
}

export function createPanelSelectPending(options: PanelSelectPendingOptions): PanelSelectPending {
  let held: { panelId: string; at: number } | undefined
  const tryResolve = (): boolean => {
    if (held === undefined) return false
    // ONLY the core TTL discards a held intent (checked when the axis changes).
    if (options.now() - held.at > options.ttlMs) {
      held = undefined
      return false
    }
    // 面板尚未注册（extra row 还没 apply）：保持挂起，等面板轴的下一次变化。
    if (!options.isRegistered(held.panelId)) return false
    const panelId = held.panelId
    held = undefined
    options.selectPanel(panelId)
    return true
  }
  return {
    arm: (panelId, at = options.now()) => {
      held = { panelId, at }
      tryResolve()
    },
    tryResolve,
    pending: () => held,
    clear: () => { held = undefined },
  }
}