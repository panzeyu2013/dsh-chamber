/** The shell keyed-action runner and row-error store: one key discipline + rowErrors
 *  surface shared by every row action; runActionWithOutcome also reports the outcome. */

import { useState } from 'react'
import { actionErrorText } from './action-error-copy.ts'
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
        // ONE copy decision (action-error-copy.ts) — the next same-key action
        // clears the row error (the key is deleted above).
        setRowErrors((prev) => ({ ...prev, [key]: actionErrorText(reason, t) }))
        return false
      },
    )
  }
  return { rowErrors, setRowErrors, runAction, runActionWithOutcome }
}
