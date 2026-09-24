/**
 * Persistent page-reload budget for the delivery ladder's document-reload tier.
 *
 * WHY persistent: the ladder's quota lives in the delivery owner, which dies with
 * the document - the reload it just authorized would hand the next document a full
 * budget and a still-broken stream could reload forever. sessionStorage is per tab
 * and survives reloads, so the rolling window (LADDER_TABLES.delivery.rebootWindowMs
 * / reloadMax) is enforced across documents. Storage failure fails CLOSED: without a
 * place to record the window, no automatic reload is authorized.
 */
import { LADDER_TABLES } from '@dsh-chamber/dsh-stream-state'

export const DOCUMENT_RELOAD_BUDGET_KEY = 'dsh-chamber.document-reloads.v1'

export interface ReloadBudgetStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * Record one automatic reload if the rolling window still has room.
 * @param storage - sessionStorage-shaped handle; undefined fails closed.
 * @param now - WALL clock (Date.now): the window must survive a document reload,
 *   and the page's monotonic clock restarts with every document.
 */
export function shouldReloadDocument(storage: ReloadBudgetStorage | undefined, now: number): boolean {
  if (storage === undefined) return false
  const table = LADDER_TABLES.delivery
  let history: number[] = []
  try {
    const raw = storage.getItem(DOCUMENT_RELOAD_BUDGET_KEY)
    const parsed: unknown = raw === null || raw === '' ? [] : JSON.parse(raw)
    if (Array.isArray(parsed)) {
      history = parsed.filter((at): at is number => typeof at === 'number' && Number.isSafeInteger(at) && at >= 0)
    }
  } catch {
    return false
  }
  const within = history.filter(at => now - at < table.rebootWindowMs)
  if (within.length >= table.reloadMax) return false
  try {
    storage.setItem(DOCUMENT_RELOAD_BUDGET_KEY, JSON.stringify([...within, now]))
  } catch {
    return false
  }
  return true
}

/** The sessionStorage-shaped handle, or undefined when the page cannot persist. */
export function documentReloadBudgetStorage(): ReloadBudgetStorage | undefined {
  try {
    return (globalThis as { sessionStorage?: ReloadBudgetStorage }).sessionStorage ?? undefined
  } catch {
    return undefined
  }
}
