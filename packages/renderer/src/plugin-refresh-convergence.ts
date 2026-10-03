/**
 * Plugin-refresh convergence policy (design 09 §3.7): one settled plugin/bundle change of
 * THIS page re-subscribes the instance's client-plugin graph UNCONDITIONALLY — a frame
 * that arrived during the action does not prove the FINAL graph arrived (see the resync
 * call below) — and watches a bounded window for the page-level `restart-required` fact
 * that only a document reload can end.
 *
 * Provenance: the window's floor is the action's START time on the page wall clock (the
 * settled edge of plugin-action-tracker carries it). The host pushes its graph frame —
 * and live-graph writes the fact — DURING the action, before the manager's RPC answer
 * settles the store, and live-graph dedupes an identical fact in its slot (sameFact
 * ignores updatedAt), so a resync cannot be expected to re-emit anything. The triage is
 * therefore "this fact is not older than this action", applied to the synchronous
 * replay and to later writes alike; an older fact belongs to an earlier change and must
 * not reload the page.
 *
 * Two deliberate guards around the window itself:
 * - a new action START closes the open window (`notifyActionStart`): a fact written
 *   while a later action runs must never reload the page mid-flight;
 * - the deadline is re-checked against the wall clock when a fact arrives, because a
 *   throttled background timer can fire late.
 *
 * The fact is read through the bridge's diagnostic subscription, which replays the current
 * records SYNCHRONOUSLY (aggregate-store `onPluginDiagnostic`): the arm path depends on it,
 * because a fact written while the action ran is only ever seen through that replay. If the
 * bridge ever turns the replay async, this policy needs an explicit read step instead.
 */
import type { PluginGraphDiagnostic } from '@dsh-chamber/dsh-chamber-client-core'

/** Bounded watch after one settled change; a fact outside it is a later action's own. */
const PLUGIN_REFRESH_WINDOW_MS = 5_000

export interface PluginRefreshConvergenceDeps {
  /** Re-subscribe the page-channel `pluginGraph` topic (the shell's live-graph resync). */
  resync(): boolean
  subscribeDiagnostic(listener: (diagnostic: PluginGraphDiagnostic | undefined) => void): () => void
  /** Fire the reload; false when it was denied (budget/single-flight/no window) — the
   *  window then stays open so a later fact can still try. Must not re-enter
   *  `notifyChange` (the shell's reload never does). */
  requestReload(): boolean
  now?(): number
  windowMs?: number
  setTimeout?(handler: () => void, ms: number): unknown
  clearTimeout?(handle: unknown): void
  warn?(message: string): void
}

interface PluginRefreshConvergence {
  /** A settled change whose action began at `startedAt` (page wall clock). */
  notifyChange(startedAt: number): void
  /** A new action began: the open window can no longer answer for it. */
  notifyActionStart(): void
  dispose(): void
}

/** Build the per-boot convergence policy (see the module header). */
export function createPluginRefreshConvergence(deps: PluginRefreshConvergenceDeps): PluginRefreshConvergence {
  const now = deps.now ?? (() => Date.now())
  const warn = deps.warn ?? ((message: string) => { console.warn(message) })
  const schedule = deps.setTimeout ?? ((handler: () => void, ms: number) => setTimeout(handler, ms))
  const cancel = deps.clearTimeout ?? ((handle: unknown) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
  const windowMs = deps.windowMs ?? PLUGIN_REFRESH_WINDOW_MS
  let disposed = false
  let timer: unknown
  let unsubscribe: (() => void) | undefined

  const end = (): void => {
    if (timer !== undefined) {
      cancel(timer)
      timer = undefined
    }
    unsubscribe?.()
    unsubscribe = undefined
  }

  return {
    notifyChange(startedAt: number): void {
      if (disposed) return
      end()
      const openedAt = now()
      let closed = false
      const handle = deps.subscribeDiagnostic((diagnostic) => {
        if (closed) return
        if (diagnostic?.state !== 'restart-required') return
        // Triage, not "ignore the replay": a fact written during this action (the common
        // case — the host frame lands before the RPC answer) is accepted; one from an
        // earlier change is not.
        if (diagnostic.updatedAt < startedAt) return
        if (now() - openedAt > windowMs) return
        // A denied reload (budget exhausted, single-flight, no window object) must not
        // consume the window: keep observing until the deadline so a later fact can try.
        if (!deps.requestReload()) return
        closed = true
        end()
      })
      unsubscribe = handle
      if (closed) {
        // The replay already ended this window (the subscription replays synchronously),
        // so the handle assigned above is the only thing left to close.
        handle()
        unsubscribe = undefined
        return
      }
      // Always re-subscribe. A frame that arrived during the action only proves the topic
      // delivered SOMETHING — the host sends one frame per rebuilt entry and the topic can
      // freeze afterwards — so "a frame arrived" cannot stand in for "the final graph
      // arrived"; gating the resync on it would reproduce the original silent-stale
      // symptom (no row, no fact, no button). The cost is one subscription rebuild per
      // settled user action, which is bounded and rare.
      if (!deps.resync()) {
        warn('[dsh-chamber] plugin refresh: no live client-plugin subscription to resync')
      }
      timer = schedule(() => { end() }, windowMs)
    },
    notifyActionStart(): void {
      if (disposed) return
      end()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      end()
    },
  }
}
