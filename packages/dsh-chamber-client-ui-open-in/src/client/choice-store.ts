/**
 * Persisted open-in choice — the last app the user picked, remembered PER SOURCE
 * and surviving a page reload.
 *
 * WHY PER SOURCE: the unified entry serves every source from one page, so a
 * shared key would let a remote target’s choice overwrite the local one and would
 * remember ids that do not exist in the context being viewed. A stale or foreign
 * memory can still never point the entry at an impossible app: the button falls
 * back to the view-model default when the remembered id is not among the current
 * entries.
 *
 * Persistence is best-effort: an opaque origin or disabled storage degrades to
 * the in-memory value instead of throwing.
 */

import { createListenerSet } from '@dsh-chamber/dsh-chamber-client-core'

/** Per-source storage key prefix. */
export const OPEN_IN_CHOICE_STORAGE_PREFIX = 'dsh-chamber.open-in.choice.'

/** The page-wide key earlier builds used; read once as the LOCAL source’s initial value, never written. */
export const LEGACY_OPEN_IN_CHOICE_STORAGE_KEY = 'dsh.open-in-app.choice'

/** Source ids the store will build a key for (no whitespace, no separators). */
const SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/

interface ChoiceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const choices = new Map<string, string>()
const loaded = new Set<string>()
const listeners = createListenerSet()

function storage(): ChoiceStorage | null {
  try {
    return (globalThis as { localStorage?: ChoiceStorage }).localStorage ?? null
  } catch {
    // Accessing localStorage can throw (sandboxed/opaque origin).
    return null
  }
}

/** The key for one source; null when the id cannot own a key. */
function keyFor(sourceId: string): string | null {
  if (typeof sourceId !== 'string' || !SOURCE_ID_PATTERN.test(sourceId)) return null
  return `${OPEN_IN_CHOICE_STORAGE_PREFIX}${sourceId}`
}

function read(sourceId: string): string {
  const key = keyFor(sourceId)
  if (key === null) return ''
  try {
    const stored = storage()?.getItem(key)
    if (typeof stored === 'string' && stored !== '') return stored
    // One-time migration of the page-wide key into the LOCAL source’s slot.
    if (sourceId !== 'local') return ''
    const legacy = storage()?.getItem(LEGACY_OPEN_IN_CHOICE_STORAGE_KEY)
    return typeof legacy === 'string' ? legacy : ''
  } catch {
    return ''
  }
}

function ensureLoaded(sourceId: string): void {
  if (loaded.has(sourceId)) return
  loaded.add(sourceId)
  choices.set(sourceId, read(sourceId))
}

/** The remembered app id for one source, or '' before the first choice. */
export function getOpenInChoice(sourceId: string): string {
  const key = keyFor(sourceId)
  if (key === null) return ''
  ensureLoaded(sourceId)
  return choices.get(sourceId) ?? ''
}

/** Remember one picked app id for one source (no-op when empty/unchanged or unkeyable). */
export function setOpenInChoice(sourceId: string, appId: string): void {
  const key = keyFor(sourceId)
  if (key === null) return
  ensureLoaded(sourceId)
  if (typeof appId !== 'string' || appId === '' || appId === choices.get(sourceId)) return
  choices.set(sourceId, appId)
  try {
    storage()?.setItem(key, appId)
  } catch {
    // Memory-only fallback: the current page keeps the choice.
  }
  listeners.notify()
}

/** Subscribe to any source's choice change; returns the unsubscribe. */
export function subscribeOpenInChoice(listener: () => void): () => void {
  return listeners.subscribe(listener)
}

/** Test-only: reset the module-level choice state for isolation. */
export function __resetOpenInChoiceForTests(): void {
  choices.clear()
  loaded.clear()
  listeners.clear()
}
