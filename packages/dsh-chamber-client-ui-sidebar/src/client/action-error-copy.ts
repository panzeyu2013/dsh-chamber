/**
 * The row-error copy for one failed keyed action: ONE pure decision, kept out of
 * the React hook so plain-node tests exercise the runtime path (a source-text
 * lock cannot prove the branch is reachable), and so the runner cannot grow a
 * second hand-written branch.
 */
import { HttpBudgetUnscheduledError } from '@dsh-chamber/dsh-chamber-client-core/http-budget'
import {
  isInstanceUnavailable,
  MutationOutcomeUnknownError,
  ResponseLostError,
} from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import type { SidebarKey } from './locales.ts'

/** Map a not-ready phase to its localized row-error key (design 02 §3.5). */
export function actionErrorKeyForState(state: string | undefined): SidebarKey {
  if (state === 'starting' || state === 'restarting') return 'action.instanceStarting'
  if (state === 'degraded') return 'action.instanceDegraded'
  if (state === 'restart-exhausted') return 'action.instanceRestartExhausted'
  // stopped/error are TERMINAL: no retry turns them ready, so the copy must name
  // the manual start instead of "retry shortly".
  if (state === 'stopped' || state === 'error') return 'action.instanceNotRunning'
  return 'action.instanceUnavailable'
}

/** The row error for one rejected action — every failure class gets copy. */
export function actionErrorText(reason: unknown, t: (key: SidebarKey) => string): string {
  // A page-local dispatch refusal is not the source failing: localize it through
  // the same dictionary every other row error uses (design 26 §D7).
  if (reason instanceof HttpBudgetUnscheduledError) return t('action.notDispatched')
  if (reason instanceof MutationOutcomeUnknownError) return t('action.outcomeUnknown')
  // The body reached the instance and the answer was lost; unlike an unknown
  // mutation this is safe to retry, but the raw English sentence must not leak
  // into a localized row error.
  if (reason instanceof ResponseLostError) return t('action.responseLost')
  // The proxy's not-ready 503 is a phase, not a row failure: show a localized
  // recovery line, never the raw gateway body (design 02 §3.5).
  if (isInstanceUnavailable(reason)) return t(actionErrorKeyForState(reason.state))
  return reason instanceof Error ? reason.message : String(reason)
}
