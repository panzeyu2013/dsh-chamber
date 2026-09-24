/**
 * Authority action log persisted into the page's Local Storage (LevelDB under the profile, shared
 * by both flavors since both run this web renderer), bounded per source so the executor's action
 * ring cannot grow without limit. DISCIPLINE: diagnostics must never break the authority chain —
 * every storage failure (absent localStorage, quota, corrupt JSON, hostile shape) degrades to "no
 * evidence" and never throws; the versioned key drops unknown shapes rather than migrating.
 */
export interface AuthorityLogStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** One persisted authority act (mirrors the executor's AuthorityActionLogEntry). */
export interface AuthorityLogEntry {
  readonly at: number
  readonly kind: string
  readonly detail?: string
}

export const AUTHORITY_LOG_KEY = 'dsh-chamber.authority-log.v1'
export const AUTHORITY_LOG_MAX_PER_SOURCE = 32
export const AUTHORITY_LOG_MAX_SOURCES = 16

/** The browser seam; undefined when localStorage is absent or hostile (fail soft). */
export function authorityLogStorage(): AuthorityLogStorage | undefined {
  try {
    const storage = (globalThis as { localStorage?: AuthorityLogStorage }).localStorage
    if (storage === undefined) return undefined
    return typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
      ? storage
      : undefined
  } catch {
    return undefined
  }
}

function parseEntry(value: unknown): AuthorityLogEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { at?: unknown; kind?: unknown; detail?: unknown }
  if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) return undefined
  if (typeof candidate.kind !== 'string' || candidate.kind === '') return undefined
  return {
    at: candidate.at,
    kind: candidate.kind,
    ...(typeof candidate.detail === 'string' ? { detail: candidate.detail } : {}),
  }
}

/** Read the bounded per-source table; anything malformed reads as empty. */
export function loadAuthorityLog(
  storage: AuthorityLogStorage,
): Record<string, AuthorityLogEntry[]> {
  let raw: string | null
  try {
    raw = storage.getItem(AUTHORITY_LOG_KEY)
  } catch {
    return {}
  }
  if (raw === null || raw === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const result: Record<string, AuthorityLogEntry[]> = {}
  for (const [sourceId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue
    const entries: AuthorityLogEntry[] = []
    for (const item of value) {
      const entry = parseEntry(item)
      if (entry !== undefined) entries.push(entry)
    }
    if (entries.length > 0) result[sourceId] = entries.slice(-AUTHORITY_LOG_MAX_PER_SOURCE)
  }
  return result
}

/** Keep the newest last-entry sources when the table exceeds the source bound. */
function boundSources(table: Record<string, AuthorityLogEntry[]>): Record<string, AuthorityLogEntry[]> {
  const sourceIds = Object.keys(table)
  if (sourceIds.length <= AUTHORITY_LOG_MAX_SOURCES) return table
  const byRecency = sourceIds.sort((a, b) => {
    const lastA = table[a]?.[table[a]!.length - 1]?.at ?? 0
    const lastB = table[b]?.[table[b]!.length - 1]?.at ?? 0
    return lastB - lastA
  })
  const kept = byRecency.slice(0, AUTHORITY_LOG_MAX_SOURCES)
  const result: Record<string, AuthorityLogEntry[]> = {}
  for (const sourceId of kept) result[sourceId] = table[sourceId]!
  return result
}

/** Append one act; callers must append each produced act exactly once. */
export function appendAuthorityLog(
  storage: AuthorityLogStorage,
  sourceId: string,
  entry: AuthorityLogEntry,
): void {
  try {
    const table = loadAuthorityLog(storage)
    const entries = table[sourceId] ?? []
    entries.push(entry)
    table[sourceId] = entries.slice(-AUTHORITY_LOG_MAX_PER_SOURCE)
    storage.setItem(AUTHORITY_LOG_KEY, JSON.stringify(boundSources(table)))
  } catch {
    // Diagnostics never break the chain.
  }
}
