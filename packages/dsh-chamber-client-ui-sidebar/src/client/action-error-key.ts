/**
 * The not-ready action-error copy key: ONE mapping from the local connection
 * phase (`details.state` on the proxy's 503) to the sidebar's localized row
 * error. Kept as a pure leaf so plain-node tests can exercise it without React,
 * and so the hook runner cannot grow a second hand-written branch.
 */
import type { SidebarKey } from './locales.ts'

/** Map a not-ready phase to its localized row-error key (design 02 §3.5). */
export function actionErrorKeyForState(state: string | undefined): SidebarKey {
  if (state === 'starting' || state === 'restarting') return 'action.instanceStarting'
  if (state === 'degraded') return 'action.instanceDegraded'
  if (state === 'restart-exhausted') return 'action.instanceRestartExhausted'
  return 'action.instanceUnavailable'
}
