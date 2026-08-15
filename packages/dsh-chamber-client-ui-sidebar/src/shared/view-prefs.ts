/**
 * Sidebar view preferences persisted in page-wide localStorage under one
 * versioned key (design 06 §3). All instance ctxs share the value; writes are
 * idempotent and last-writer-wins is harmless. Every read/write is guarded —
 * corrupt JSON, a version mismatch or a wrong shape falls back to defaults,
 * and storage failures never throw. The default storage is resolved lazily
 * inside the call (never in a default-argument), so an accessor that throws
 * on opaque origins / sandboxed webviews degrades to defaults / no-op.
 */
export interface ChamberSidebarViewPrefs {
  v: 1
  /** key: `${sourceId}/${workspaceId}` */
  folded: Record<string, boolean>
  /** key: sourceId */
  ungroupedOrder: Record<string, string[]>
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const VIEW_PREFS_KEY = 'dsh-chamber.sidebar.v1'

const DEFAULTS: ChamberSidebarViewPrefs = { v: 1, folded: {}, ungroupedOrder: {} }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Lenient structural validation: drop malformed entries, keep valid ones. */
function sanitizePrefs(raw: unknown): ChamberSidebarViewPrefs {
  if (!isPlainObject(raw) || raw.v !== 1) return { ...DEFAULTS }
  const folded: Record<string, boolean> = {}
  if (isPlainObject(raw.folded)) {
    for (const [key, value] of Object.entries(raw.folded)) {
      if (typeof value === 'boolean') folded[key] = value
    }
  }
  const ungroupedOrder: Record<string, string[]> = {}
  if (isPlainObject(raw.ungroupedOrder)) {
    for (const [key, value] of Object.entries(raw.ungroupedOrder)) {
      if (Array.isArray(value)) ungroupedOrder[key] = value.filter((entry): entry is string => typeof entry === 'string')
    }
  }
  return { v: 1, folded, ungroupedOrder }
}

/**
 * Resolve the default page storage lazily; returns null when the accessor
 * itself throws (opaque origins, blocked storage, sandboxed webviews).
 */
function safeLocalStorage(): StorageLike | null {
  try {
    return globalThis.localStorage
  } catch {
    return null
  }
}

/** Read + sanitize the persisted prefs; never throws. */
export function loadViewPrefs(storage?: StorageLike): ChamberSidebarViewPrefs {
  const store = storage ?? safeLocalStorage()
  if (store === null) return { ...DEFAULTS }
  let raw: unknown
  try {
    const text = store.getItem(VIEW_PREFS_KEY)
    if (text === null) return { ...DEFAULTS }
    raw = JSON.parse(text)
  } catch {
    return { ...DEFAULTS }
  }
  return sanitizePrefs(raw)
}

/** Persist the prefs; never throws (storage failure is non-fatal). */
export function saveViewPrefs(prefs: ChamberSidebarViewPrefs, storage?: StorageLike): void {
  const store = storage ?? safeLocalStorage()
  if (store === null) return
  try {
    store.setItem(VIEW_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // non-fatal
  }
}
