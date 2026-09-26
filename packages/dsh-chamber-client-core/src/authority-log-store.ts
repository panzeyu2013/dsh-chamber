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
/**
 * facts-health 保底名额（W0 诊断保底）：高频 kinds（probe / status-divergence）会把低频但关键的
 * 状态时间线挤出环（实测 facts-health 被挤出后「观察者其实一直失败」在盘上不可见）。
 * 淘汰时先保最新 (MAX-RESERVE) 条任意 kind，再用剩余名额保最新 RESERVE 条 facts-health；
 * 环未超限时逐字不变（零行为变化）。
 */
export const AUTHORITY_LOG_FACTS_HEALTH_RESERVE = 8
/** 保底 kind 字面量：持久化契约（renderer facts-health.ts 的 FACTS_HEALTH_KIND 与之同源）。 */
const AUTHORITY_LOG_RESERVED_KIND = 'facts-health'

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
    if (entries.length > 0) result[sourceId] = trimEntries(entries)
  }
  return result
}

/**
 * 每来源淘汰：超限时保留「最新 MAX-RESERVE 条（任意 kind）+ 最新 RESERVE 条保底 kind」，
 * 输出保持原时序（调用方只 append，顺序即时间线）。
 */
export function trimEntries(entries: readonly AuthorityLogEntry[]): AuthorityLogEntry[] {
  const max = AUTHORITY_LOG_MAX_PER_SOURCE
  if (entries.length <= max) return [...entries]
  const reserve = Math.min(AUTHORITY_LOG_FACTS_HEALTH_RESERVE, max)
  const keep = new Set<number>()
  for (let index = entries.length - 1; index >= 0 && keep.size < max - reserve; index -= 1) keep.add(index)
  for (let index = entries.length - 1; index >= 0 && keep.size < max; index -= 1) {
    if (entries[index]?.kind === AUTHORITY_LOG_RESERVED_KIND) keep.add(index)
  }
  // 保底 kind 不足 reserve 条时按 recency 补齐（不空转名额）。
  for (let index = entries.length - 1; index >= 0 && keep.size < max; index -= 1) keep.add(index)
  return entries.filter((_, index) => keep.has(index))
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
    table[sourceId] = trimEntries(entries)
    storage.setItem(AUTHORITY_LOG_KEY, JSON.stringify(boundSources(table)))
  } catch {
    // Diagnostics never break the chain.
  }
}
