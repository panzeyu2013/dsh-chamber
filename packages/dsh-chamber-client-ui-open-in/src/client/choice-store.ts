/**
 * Persisted open-in choice (Batch 3 Phase 2, absorbed from the official
 * client's persisted snapshot store): the last app the user picked, shared by
 * every session header on the page and surviving a page reload.
 *
 * The storage key is the official key (`dsh.open-in-app.choice`), so the two
 * implementations would agree on the choice if both ever mounted. Persistence
 * is best-effort: an opaque origin or disabled storage degrades to the
 * in-memory value instead of throwing (the button always works, the choice
 * just does not outlive the page).
 */
export const OPEN_IN_CHOICE_STORAGE_KEY = 'dsh.open-in-app.choice'

interface ChoiceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

let choice = ''
let loaded = false
const listeners = new Set<() => void>()

function storage(): ChoiceStorage | null {
  try {
    return (globalThis as { localStorage?: ChoiceStorage }).localStorage ?? null
  } catch {
    // Accessing localStorage can throw (sandboxed/opaque origin).
    return null
  }
}

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  try {
    const stored = storage()?.getItem(OPEN_IN_CHOICE_STORAGE_KEY)
    choice = typeof stored === 'string' ? stored : ''
  } catch {
    choice = ''
  }
}

/** The remembered app id, or '' before the first choice. */
export function getOpenInChoice(): string {
  ensureLoaded()
  return choice
}

/** Remember one picked app id (no-op for an empty/unchanged value). */
export function setOpenInChoice(appId: string): void {
  ensureLoaded()
  if (typeof appId !== 'string' || appId === '' || appId === choice) return
  choice = appId
  try {
    storage()?.setItem(OPEN_IN_CHOICE_STORAGE_KEY, appId)
  } catch {
    // Memory-only fallback: the current page keeps the choice.
  }
  for (const listener of [...listeners]) listener()
}

export function subscribeOpenInChoice(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Test-only: reset the module-level choice state for isolation. */
export function __resetOpenInChoiceForTests(): void {
  choice = ''
  loaded = false
  listeners.clear()
}
