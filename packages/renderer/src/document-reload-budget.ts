/**
 * Persistent page-reload budgets (two independent domains).
 *
 * WHY persistent: an automatic reload quota that lives in the document dies with the
 * document it just reloaded — the next document would start with a full budget and a
 * still-broken page could reload forever. sessionStorage is per tab and survives
 * reloads, so each domain's rolling window is enforced across documents. Storage
 * failure fails CLOSED: without a place to record the window, no automatic reload is
 * authorized.
 *
 * TWO DOMAINS, TWO KEYS: the stream-recovery ladder (LADDER_TABLES.delivery) and the
 * plugin-refresh closure (design 09 §3.7) must not starve each other — a plugin reload
 * is a user-action consequence, while a stream reload is recovery from a broken
 * stream; one quota shared by both would let a plugin install consume the recovery
 * budget (and vice versa). Each domain therefore owns its key and window.
 */
import { LADDER_TABLES } from '@dsh-chamber/dsh-stream-state'

export const DOCUMENT_RELOAD_BUDGET_KEY = 'dsh-chamber.document-reloads.v1'

/** The plugin-refresh domain's persistent key (never the stream-recovery one). */
const PLUGIN_RELOAD_BUDGET_KEY = 'dsh-chamber.plugin-reloads.v1'

/** Plugin-refresh window/quota. Same order of magnitude as the stream ladder's document
 *  tier on purpose (three repair rounds per ten minutes), but a renderer-local policy,
 *  not a stream value: dsh-stream-state's tables own the session/stream chain (design 14
 *  §D4), while this domain isolates a user-action consequence from stream recovery. */
const PLUGIN_RELOAD_WINDOW_MS = 600_000
const PLUGIN_RELOAD_MAX = 3

export interface ReloadBudgetStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * Record one automatic reload if the key's rolling window still has room.
 * @param storage - sessionStorage-shaped handle; undefined fails closed.
 * @param now - WALL clock (Date.now): the window must survive a document reload,
 *   and the page's monotonic clock restarts with every document.
 * @param key - the domain's storage key.
 * @param windowMs - rolling window length.
 * @param max - reloads allowed inside the window.
 */
function recordReload(
  storage: ReloadBudgetStorage | undefined,
  now: number,
  key: string,
  windowMs: number,
  max: number,
): boolean {
  if (storage === undefined) return false
  let history: number[] = []
  try {
    const raw = storage.getItem(key)
    const parsed: unknown = raw === null || raw === '' ? [] : JSON.parse(raw)
    if (Array.isArray(parsed)) {
      history = parsed.filter((at): at is number => typeof at === 'number' && Number.isSafeInteger(at) && at >= 0)
    }
  } catch {
    return false
  }
  const within = history.filter(at => now - at < windowMs)
  if (within.length >= max) return false
  try {
    storage.setItem(key, JSON.stringify([...within, now]))
  } catch {
    return false
  }
  return true
}

/** Stream-recovery document tier: the delivery ladder's own window/quota. */
export function shouldReloadDocument(storage: ReloadBudgetStorage | undefined, now: number): boolean {
  const table = LADDER_TABLES.delivery
  return recordReload(storage, now, DOCUMENT_RELOAD_BUDGET_KEY, table.rebootWindowMs, table.reloadMax)
}

/**
 * Plugin-refresh tier: one automatic page reload after a settled plugin/bundle change
 * that the page-level kernel cannot apply without replacing already-loaded builds.
 * @param storage - sessionStorage-shaped handle; undefined fails closed.
 * @param now - WALL clock.
 */
export function shouldReloadForPluginRefresh(storage: ReloadBudgetStorage | undefined, now: number): boolean {
  return recordReload(storage, now, PLUGIN_RELOAD_BUDGET_KEY, PLUGIN_RELOAD_WINDOW_MS, PLUGIN_RELOAD_MAX)
}

/** The sessionStorage-shaped handle, or undefined when the page cannot persist. */
export function documentReloadBudgetStorage(): ReloadBudgetStorage | undefined {
  try {
    return (globalThis as { sessionStorage?: ReloadBudgetStorage }).sessionStorage ?? undefined
  } catch {
    return undefined
  }
}
