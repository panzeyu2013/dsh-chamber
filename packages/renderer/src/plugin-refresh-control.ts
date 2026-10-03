/**
 * Shell-side glue for plugin-refresh convergence (design 09 §3.7 / design 15 §6).
 *
 * Extracted from shell.ts so the boot fence, the reload single-flight and the persistent
 * budget are unit-testable without a live document:
 * - `createPluginRefreshReloadGate`: the page-wide single-flight + plugin-refresh budget
 *   gate around the automatic document reload;
 * - `createPluginRefreshControl`: the per-boot control face provided as
 *   `ctx.chamberPluginRefresh` (structural consumers only — no cross-package type is
 *   needed, matching the `chamberInstanceId` seam), fenced on the boot generation so a
 *   superseded boot can never act.
 */
import type { PluginGraphDiagnostic } from '@dsh-chamber/dsh-chamber-client-core'
import { createPluginRefreshConvergence } from './plugin-refresh-convergence.ts'
import {
  documentReloadBudgetStorage, shouldReloadForPluginRefresh, type ReloadBudgetStorage,
} from './document-reload-budget.ts'

/**
 * How long a requested navigation is given to unload the document before the
 * single-flight flag is released again: a reload the host silently ignores must not
 * disable the automatic closure for the rest of this document. The attempt's budget slot
 * stays consumed — attempts, not navigations, are what must stay bounded.
 */
const RELOAD_IGNORED_GRACE_MS = 2_000

export interface PluginRefreshReloadDeps {
  /** Perform the navigation (shell wires `window.location.reload()`). */
  reload(): void
  /** Budget storage; defaults to the plugin-refresh domain's sessionStorage handle. */
  storage?(): ReloadBudgetStorage | undefined
  now?(): number
  schedule?(handler: () => void, ms: number): unknown
  clearSchedule?(handle: unknown): void
  warn?(message: string): void
}

/** One automatic plugin-refresh reload at a time, bounded by the plugin-refresh budget. */
export function createPluginRefreshReloadGate(deps: PluginRefreshReloadDeps): {
  /** Ask for one automatic reload; false when denied (single-flight / budget / throw). */
  request(instanceId: string): boolean
  /** Release a pending ignored-navigation probe (boot teardown; state is page-wide). */
  dispose(): void
} {
  const now = deps.now ?? (() => Date.now())
  const schedule = deps.schedule ?? ((handler: () => void, ms: number) => setTimeout(handler, ms))
  const cancel = deps.clearSchedule ?? ((handle: unknown) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
  const storage = deps.storage ?? documentReloadBudgetStorage
  const warn = deps.warn ?? ((message: string) => { console.warn(message) })
  let inFlight = false
  let pendingReset: unknown
  return {
    request(instanceId: string): boolean {
      if (inFlight) return false
      if (!shouldReloadForPluginRefresh(storage(), now())) {
        warn(`[dsh-chamber] plugin-refresh reload for ${instanceId} denied by the reload budget`)
        return false
      }
      inFlight = true
      try {
        deps.reload()
      } catch (error) {
        // A blocked navigation must not leave the single-flight flag armed forever.
        inFlight = false
        warn(`[dsh-chamber] plugin-refresh reload for ${instanceId} failed: ${String(error)}`)
        return false
      }
      pendingReset = schedule(() => {
        pendingReset = undefined
        if (!inFlight) return
        inFlight = false
        warn(`[dsh-chamber] plugin-refresh reload for ${instanceId} did not navigate; re-armed`)
      }, RELOAD_IGNORED_GRACE_MS)
      return true
    },
    dispose(): void {
      if (pendingReset !== undefined) {
        cancel(pendingReset)
        pendingReset = undefined
      }
    },
  }
}

/** The per-boot control face handed to chamber client plugins (see the module header). */
export interface PluginRefreshControl {
  requestRefresh(startedAt: number): void
  actionStarted(): void
  dispose(): void
}

export interface PluginRefreshControlDeps {
  /** Current-boot fence; every entry checks it. */
  isCurrentBoot(): boolean
  resync(): boolean
  subscribeDiagnostic(listener: (diagnostic: PluginGraphDiagnostic | undefined) => void): () => void
  requestReload(): boolean
}

/** Build the per-boot control; the reload call itself stays behind the caller's gate. */
export function createPluginRefreshControl(deps: PluginRefreshControlDeps): PluginRefreshControl {
  const convergence = createPluginRefreshConvergence({
    resync: deps.resync,
    subscribeDiagnostic: deps.subscribeDiagnostic,
    requestReload: () => deps.isCurrentBoot() && deps.requestReload(),
  })
  return {
    requestRefresh: (startedAt: number) => { if (deps.isCurrentBoot()) convergence.notifyChange(startedAt) },
    actionStarted: () => { if (deps.isCurrentBoot()) convergence.notifyActionStart() },
    dispose: () => { convergence.dispose() },
  }
}
