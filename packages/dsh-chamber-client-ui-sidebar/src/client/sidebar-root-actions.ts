/**
 * The shell keyed-action runner and its row-error store (extracted verbatim
 * from SidebarRoot, 2026-12 split): one key discipline + rowErrors surface
 * shared by every row action; runActionWithOutcome additionally reports the
 * outcome to the workspace-delete confirm.
 */

import { useState } from 'react'

/** Signature of the shell keyed action runner (rowErrors reporting). */
export type RunAction = (key: string, action: () => Promise<void>) => Promise<void>

/** runActionWithOutcome: identical surface, resolving whether the action settled cleanly. */
export type RunActionWithOutcome = (key: string, action: () => Promise<void>) => Promise<boolean>

export function useSidebarActions() {
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  /** Run one keyed action; the returned promise resolves AFTER the action
   *  settled (a rejection already wrote its message into rowErrors) — callers
   *  use it to serialize dependent commits. */
  const runAction = (key: string, action: () => Promise<void>): Promise<void> =>
    runActionWithOutcome(key, action).then(() => {})

  /**
   * runAction's outcome-reporting twin (2026-09-11 upstream-alignment T2b):
   * identical key discipline and rowErrors surface, but it resolves with
   * whether the action settled WITHOUT error — the workspace-delete confirm
   * needs that to know when its pending Modal may close. runAction keeps its
   * settle-promise contract for every existing caller (the per-source order
   * commit chain `await`s it).
   */
  const runActionWithOutcome = (key: string, action: () => Promise<void>): Promise<boolean> => {
    setRowErrors((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    return action().then(
      () => true,
      (reason: unknown) => {
        const message = reason instanceof Error ? reason.message : String(reason)
        setRowErrors((prev) => ({ ...prev, [key]: message }))
        return false
      },
    )
  }
  return { rowErrors, setRowErrors, runAction, runActionWithOutcome }
}
