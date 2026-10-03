/**
 * One settled plugin/bundle mutation of THIS page's embedded manager.
 *
 * WHY the controller's own store instead of `plugin-manager/changed`: that host event
 * carries no provenance (another window, or a change made elsewhere on the same host,
 * fires it too) and no ordering against the client graph push. The controller store is
 * this page's action ledger — `busy` (enable/disable/uninstall/remove) and `install`
 * (install dialog: phase, enabling) are set for the whole action and cleared at settle.
 *
 * The settled transition carries the action's START time on the page wall clock: the
 * shell uses it as the provenance floor for the restart fact, because the host's graph
 * frame (and the diagnostic it writes) usually arrives BEFORE the RPC answer that clears
 * these fields — see plugin-refresh-convergence.ts.
 *
 * The pending-phase predicate is INJECTED (`isInstallPending` from the vendor manager
 * store, which this plugin already imports) instead of restated here: a vendor pin that
 * adds a pending phase must not silently turn into an early 'settled' (the window would
 * close before the host applied the change and no new fact would follow).
 *
 * If this tracker is created while an action is already in flight (no store edge was
 * observed), the first in-flight snapshot announces 'started' at that moment, so the
 * provenance floor is late for that one action: its own earlier restart fact is rejected
 * and the closure waits for a later change. That is the conservative direction (a missed
 * auto-reload keeps the manual button); flooring at 0 instead would let a previous
 * action's fact reload the page.
 */
import type { InstallState } from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/manager-store.ts'

/** Vendor predicate over the install dialog phases (manager-store `isInstallPending`). */
type InstallPendingPredicate = (phase: InstallState['phase']) => boolean

/** The controller-store fields this tracker reads (structural subset of PluginManagerState). */
export interface PluginManagerActionSnapshot {
  readonly busy: readonly unknown[]
  readonly install: { readonly phase: InstallState['phase']; readonly enabling?: boolean }
}

/** One edge of the in-flight bit; `settled` names when the action began (page clock). */
type PluginActionTransition =
  | { readonly kind: 'started' }
  | { readonly kind: 'settled'; readonly startedAt: number }
  | null

/** Whether the upstream snapshot reports one manager action in flight. */
function actionInFlight(state: PluginManagerActionSnapshot, isInstallPending: InstallPendingPredicate): boolean {
  return state.busy.length > 0
    || state.install.enabling === true
    || isInstallPending(state.install.phase)
}

/**
 * Edge detector over the in-flight bit: 'started' / 'settled', null on no change.
 * @param isInstallPending - vendor pending-phase predicate (see the module header).
 * @param now - wall clock used to stamp the action start (injectable for tests).
 */
export function createPluginActionTracker(
  isInstallPending: InstallPendingPredicate,
  now: () => number = Date.now,
): {
  observe(state: PluginManagerActionSnapshot): PluginActionTransition
} {
  let inFlight = false
  let startedAt = now()
  return {
    observe(state: PluginManagerActionSnapshot): PluginActionTransition {
      const active = actionInFlight(state, isInstallPending)
      if (active === inFlight) return null
      inFlight = active
      if (active) {
        startedAt = now()
        return { kind: 'started' }
      }
      return { kind: 'settled', startedAt }
    },
  }
}
