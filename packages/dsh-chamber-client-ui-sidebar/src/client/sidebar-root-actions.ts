/** The shell keyed-action runner and row-error store: one key discipline + rowErrors
 *  surface shared by every row action; runActionWithOutcome also reports the outcome. */

import { useState } from 'react'
import { HttpBudgetUnscheduledError } from '@dsh-chamber/dsh-chamber-client-core/http-budget'
import { MutationOutcomeUnknownError, ResponseLostError } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import type { SidebarKey } from './locales.ts'

/** Signature of the shell keyed action runner (rowErrors reporting). */
export type RunAction = (key: string, action: () => Promise<void>) => Promise<void>

/** runActionWithOutcome: identical surface, resolving whether the action settled cleanly. */
export type RunActionWithOutcome = (key: string, action: () => Promise<void>) => Promise<boolean>

export function useSidebarActions(t: (key: SidebarKey) => string) {
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  /** Run one keyed action; resolves AFTER it settled (a rejection already wrote rowErrors), so callers can serialize dependent commits. */
  const runAction = (key: string, action: () => Promise<void>): Promise<void> =>
    runActionWithOutcome(key, action).then(() => {})

  /** runAction's outcome-reporting twin: same key discipline and rowErrors surface, but
   *  resolves whether the action settled WITHOUT error — the workspace-delete confirm
   *  needs that to close its pending Modal; runAction keeps its settle-promise contract. */
  const runActionWithOutcome = (key: string, action: () => Promise<void>): Promise<boolean> => {
    setRowErrors((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    return action().then(
      () => true,
      (reason: unknown) => {
        // A page-local dispatch refusal is not the source failing: localize it
        // through the same dictionary every other row error uses (design 26 §D7).
        const message = reason instanceof HttpBudgetUnscheduledError
          ? t('action.notDispatched')
          : reason instanceof MutationOutcomeUnknownError
            ? t('action.outcomeUnknown')
            : reason instanceof ResponseLostError
              // The body reached the instance and the answer was lost; unlike an
              // unknown mutation this is safe to retry, but the raw English
              // sentence must not leak into a localized row error.
              ? t('action.responseLost')
              : reason instanceof Error ? reason.message : String(reason)
        setRowErrors((prev) => ({ ...prev, [key]: message }))
        return false
      },
    )
  }
  return { rowErrors, setRowErrors, runAction, runActionWithOutcome }
}
