/** Durable, per-source memory for session ids whose content no longer exists. */

import type { PurgeTrackerState } from '@dsh-chamber/dsh-chamber-client-core/purged-tracker'

export const PURGED_SESSION_STATE_PREFIX = 'dsh-chamber.purged-sessions.v1'
export const PURGED_SESSION_STATE_MAX_IDS = 4096
export const LEGACY_SESSION_RECENT_GRACE_MS = 60_000

export interface LegacySessionSummaryState {
  readonly running?: boolean
  readonly blank?: boolean
  readonly updatedAt?: number
}

/** First-upgrade candidates omit active/blank/recent summaries to protect a fresh create. */
export function legacyStaleSessionCandidates(
  summaries: Readonly<Record<string, LegacySessionSummaryState>>,
  now: number,
  recentGraceMs = LEGACY_SESSION_RECENT_GRACE_MS,
): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const [id, summary] of Object.entries(summaries)) {
    const updatedAt = summary?.updatedAt
    const recent = typeof updatedAt === 'number' && Number.isFinite(updatedAt)
      && now - updatedAt < recentGraceMs
    if (id.length > 0 && id.length <= 512 && summary?.running !== true && summary?.blank !== true && !recent) {
      ids.add(id)
    }
  }
  return ids
}

/** Rows omitted by the first authority scan but protected until their state is safe to reconsider. */
export function legacyStaleSessionProtectedIds(
  summaries: Readonly<Record<string, LegacySessionSummaryState>>,
  missingFromAuthority: ReadonlySet<string>,
  now: number,
  recentGraceMs = LEGACY_SESSION_RECENT_GRACE_MS,
): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const id of missingFromAuthority) {
    const summary = summaries[id]
    if (summary === undefined) continue
    const recent = typeof summary.updatedAt === 'number' && Number.isFinite(summary.updatedAt)
      && now - summary.updatedAt < recentGraceMs
    if (summary.running === true || summary.blank === true || recent) ids.add(id)
  }
  return ids
}

/** Next one-shot authority recheck for protected rows; active/blank rows wait for a store change. */
export function legacySessionRecheckDelay(
  summaries: Readonly<Record<string, LegacySessionSummaryState>>,
  protectedIds: ReadonlySet<string>,
  now: number,
  recentGraceMs = LEGACY_SESSION_RECENT_GRACE_MS,
): number | undefined {
  let earliestDelay = Number.POSITIVE_INFINITY
  for (const id of protectedIds) {
    const summary = summaries[id]
    if (summary === undefined || summary.running === true || summary.blank === true) continue
    const updatedAt = summary.updatedAt
    const delay = typeof updatedAt === 'number' && Number.isFinite(updatedAt)
      ? updatedAt + recentGraceMs - now
      : 0
    if (delay <= 0) return 0
    earliestDelay = Math.min(earliestDelay, delay)
  }
  return Number.isFinite(earliestDelay) ? Math.min(earliestDelay, 2_147_483_647) : undefined
}

export interface PurgedSessionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  /**
   * Optional: the only way a superseded fingerprint's payload can be removed.
   * Page localStorage always provides it; a storage without it keeps the index
   * entry instead of silently orphaning the data key.
   */
  removeItem?(key: string): void
  /** Optional localStorage enumeration, used once to seed the index on first migration. */
  readonly length?: number
  key?(index: number): string | null
}

/**
 * Fingerprint index (new key): instanceId segment → recently used source
 * fingerprints, MRU first. A source re-registration mints a NEW fingerprint data
 * key while the previous incarnation's key used to leak forever (nothing ever
 * called removeItem). The index records last-used times and is itself bounded;
 * per instanceId only the current fingerprint plus the newest
 * PURGED_SESSION_FINGERPRINT_KEEP - 1 others keep their data key.
 */
export const PURGED_SESSION_STATE_INDEX_KEY = `${PURGED_SESSION_STATE_PREFIX}.index`
/** Per instanceId keep this many fingerprint data keys (the current one always included). */
export const PURGED_SESSION_FINGERPRINT_KEEP = 2
/** Index table bound: beyond this the least recently used instanceIds fall off (their data keys are never touched by it). */
export const PURGED_SESSION_INDEX_MAX_INSTANCES = 64
/** Per-instance index bound when removeItem is unavailable: nothing can be deleted, so entries stay known instead. */
const PURGED_SESSION_FINGERPRINT_INDEX_MAX = 8

function browserStorage(): PurgedSessionStorage | undefined {
  try {
    const storage = globalThis.localStorage
    return storage !== undefined && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
      ? storage
      : undefined
  } catch {
    return undefined
  }
}

/** One remembered fingerprint of one instanceId. */
interface PurgedSessionIndexEntry {
  /** Encoded fingerprint segment, exactly as it appears in the data key. */
  fingerprint: string
  /** Epoch ms of the last load/save that touched this fingerprint. */
  usedAt: number
}

/** New index key payload: instanceId segment → MRU-first fingerprints. */
interface PurgedSessionIndex {
  v: 1
  instances: Record<string, PurgedSessionIndexEntry[]>
}

export function purgedSessionStateKey(instanceId: string, sourceFingerprint: string): string {
  return dataKey(encodeURIComponent(instanceId), encodeURIComponent(sourceFingerprint))
}

function dataKey(instanceSegment: string, fingerprintSegment: string): string {
  return `${PURGED_SESSION_STATE_PREFIX}:${instanceSegment}:${fingerprintSegment}`
}

/** Split a data key back into its encoded segments (undefined for the index key or foreign keys). */
function parseDataKey(key: string): { instanceSegment: string; fingerprintSegment: string } | undefined {
  const prefix = `${PURGED_SESSION_STATE_PREFIX}:`
  if (!key.startsWith(prefix)) return undefined
  const rest = key.slice(prefix.length)
  const separator = rest.indexOf(':')
  if (separator <= 0 || separator === rest.length - 1) return undefined
  const instanceSegment = rest.slice(0, separator)
  const fingerprintSegment = rest.slice(separator + 1)
  if (fingerprintSegment.includes(':')) return undefined
  return { instanceSegment, fingerprintSegment }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const id of value) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 512 || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids.slice(-PURGED_SESSION_STATE_MAX_IDS)
}

export function parsePurgedSessionState(raw: string | null): PurgeTrackerState | undefined {
  if (raw === null) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    if (record.v !== 1) return undefined
    return {
      purgedIds: cleanIds(record.purgedIds),
      knownSessionIds: cleanIds(record.knownSessionIds),
    }
  } catch {
    return undefined
  }
}

// ---- fingerprint index: load updates, save evicts ----

function parseIndex(raw: string | null): PurgedSessionIndex | undefined {
  if (raw === null || raw === '') return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value) || value.v !== 1 || !isRecord(value.instances)) return undefined
    const instances: Record<string, PurgedSessionIndexEntry[]> = {}
    for (const [instanceSegment, entries] of Object.entries(value.instances)) {
      if (!Array.isArray(entries)) continue
      const clean: PurgedSessionIndexEntry[] = []
      for (const entry of entries) {
        if (!isRecord(entry) || typeof entry.fingerprint !== 'string' || entry.fingerprint.length === 0) continue
        const usedAt = typeof entry.usedAt === 'number' && Number.isFinite(entry.usedAt) ? entry.usedAt : 0
        clean.push({ fingerprint: entry.fingerprint, usedAt })
      }
      instances[instanceSegment] = clean
    }
    return { v: 1, instances }
  } catch {
    return undefined
  }
}

function readIndex(storage: PurgedSessionStorage): PurgedSessionIndex | undefined {
  try { return parseIndex(storage.getItem(PURGED_SESSION_STATE_INDEX_KEY)) } catch { return undefined }
}

function writeIndex(storage: PurgedSessionStorage, index: PurgedSessionIndex): void {
  try {
    storage.setItem(PURGED_SESSION_STATE_INDEX_KEY, JSON.stringify(index))
  } catch {
    // soft: an unusable index must never break the purge chain
  }
}

/** Existing data keys, enumerated once to seed the index on first migration. */
function discoveredDataKeys(storage: PurgedSessionStorage): Array<{ instanceSegment: string; fingerprintSegment: string }> {
  const found: Array<{ instanceSegment: string; fingerprintSegment: string }> = []
  const readKey = storage.key
  const length = storage.length
  if (typeof length !== 'number' || typeof readKey !== 'function') return found
  for (let index = 0; index < length; index += 1) {
    let name: string | null
    try { name = readKey.call(storage, index) } catch { continue }
    if (typeof name !== 'string') continue
    const parsed = parseDataKey(name)
    if (parsed === undefined) continue
    if (!found.some(entry => entry.instanceSegment === parsed.instanceSegment && entry.fingerprintSegment === parsed.fingerprintSegment)) {
      found.push(parsed)
    }
  }
  return found
}

/** Delete one superseded data key; false when removal is unavailable/failed (the entry stays in the index). */
function removeSupersededDataKey(storage: PurgedSessionStorage, instanceSegment: string, fingerprintSegment: string): boolean {
  if (typeof storage.removeItem !== 'function') return false
  try {
    storage.removeItem.call(storage, dataKey(instanceSegment, fingerprintSegment))
    return true
  } catch {
    return false
  }
}

/** Keep the instance table bounded: LRU instanceIds fall off the index (never their data keys). */
function boundInstanceTable(index: PurgedSessionIndex, protectedInstance: string): void {
  const instanceSegments = Object.keys(index.instances)
  if (instanceSegments.length <= PURGED_SESSION_INDEX_MAX_INSTANCES) return
  const lastUsed = (instanceSegment: string): number => index.instances[instanceSegment]?.[0]?.usedAt ?? 0
  const byRecency = instanceSegments.slice().sort((a, b) => lastUsed(b) - lastUsed(a))
  const kept = new Set<string>([protectedInstance])
  for (const instanceSegment of byRecency) {
    if (kept.size >= PURGED_SESSION_INDEX_MAX_INSTANCES) break
    kept.add(instanceSegment)
  }
  const next: Record<string, PurgedSessionIndexEntry[]> = {}
  for (const instanceSegment of instanceSegments) {
    const entries = index.instances[instanceSegment]
    if (kept.has(instanceSegment) && entries !== undefined) next[instanceSegment] = entries
  }
  index.instances = next
}

/**
 * Record the current fingerprint as most recently used and collect superseded
 * keys of the SAME instanceId. The current fingerprint is never removed, other
 * instanceIds are never inspected, and only entries that lost the per-instance
 * recency race are deleted (their data key goes with them).
 * On first migration (index absent or corrupt) the index is seeded from the
 * existing data keys FIRST, then eviction runs against that seed.
 */
function touchFingerprintIndex(
  storage: PurgedSessionStorage,
  instanceSegment: string,
  fingerprintSegment: string,
  now: number,
): PurgedSessionIndex {
  let index = readIndex(storage)
  if (index === undefined) {
    index = { v: 1, instances: {} }
    for (const discovered of discoveredDataKeys(storage)) {
      const bucket = index.instances[discovered.instanceSegment] ?? []
      bucket.push({ fingerprint: discovered.fingerprintSegment, usedAt: 0 })
      index.instances[discovered.instanceSegment] = bucket
    }
  }
  const previous = index.instances[instanceSegment] ?? []
  // MRU order: the current fingerprint moves to the front and stamps usedAt, so
  // equal millisecond timestamps can never reorder the list.
  const ordered: PurgedSessionIndexEntry[] = [
    { fingerprint: fingerprintSegment, usedAt: now },
    ...previous.filter(entry => entry.fingerprint !== fingerprintSegment),
  ]
  const retained: PurgedSessionIndexEntry[] = []
  for (const entry of ordered) {
    if (retained.length < PURGED_SESSION_FINGERPRINT_KEEP) {
      retained.push(entry)
      continue
    }
    if (!removeSupersededDataKey(storage, instanceSegment, entry.fingerprint)) retained.push(entry)
  }
  index.instances[instanceSegment] = retained.slice(0, PURGED_SESSION_FINGERPRINT_INDEX_MAX)
  boundInstanceTable(index, instanceSegment)
  return index
}

/** Storage failures are a soft degradation; stale rows remain handled in this page lifetime. */
export function createPurgedSessionStore(
  instanceId: string,
  sourceFingerprint: string,
  storage: PurgedSessionStorage | undefined = browserStorage(),
): { load: () => PurgeTrackerState | undefined; save: (state: PurgeTrackerState) => void } {
  const instanceSegment = encodeURIComponent(instanceId)
  const fingerprintSegment = encodeURIComponent(sourceFingerprint)
  const key = purgedSessionStateKey(instanceId, sourceFingerprint)
  /** load 更新索引（当前指纹记为最近使用）；save 写盘后同样更新并淘汰被取代的旧键。 */
  const touchIndex = (): void => {
    if (storage === undefined) return
    try {
      writeIndex(storage, touchFingerprintIndex(storage, instanceSegment, fingerprintSegment, Date.now()))
    } catch {
      // soft: index bookkeeping never throws into the purge chain
    }
  }
  return {
    load: () => {
      // 首次迁移先建索引再看淘汰；已存在的索引只更新当前指纹的最近使用时间。
      touchIndex()
      try { return parsePurgedSessionState(storage?.getItem(key) ?? null) } catch { return undefined }
    },
    save: (state) => {
      if (storage === undefined) return
      const payload = {
        v: 1,
        purgedIds: cleanIds(state.purgedIds),
        knownSessionIds: cleanIds(state.knownSessionIds),
      }
      try { storage.setItem(key, JSON.stringify(payload)) } catch { /* quota/private mode: memory still works */ }
      // 数据键写盘后淘汰：删除被更新指纹取代的旧键（当前键永不在淘汰集里）。
      touchIndex()
    },
  }
}
