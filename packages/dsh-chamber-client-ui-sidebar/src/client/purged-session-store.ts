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
}

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

export function purgedSessionStateKey(instanceId: string, sourceFingerprint: string): string {
  return `${PURGED_SESSION_STATE_PREFIX}:${encodeURIComponent(instanceId)}:${encodeURIComponent(sourceFingerprint)}`
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

/** Storage failures are a soft degradation; stale rows remain handled in this page lifetime. */
export function createPurgedSessionStore(
  instanceId: string,
  sourceFingerprint: string,
  storage: PurgedSessionStorage | undefined = browserStorage(),
): { load: () => PurgeTrackerState | undefined; save: (state: PurgeTrackerState) => void } {
  const key = purgedSessionStateKey(instanceId, sourceFingerprint)
  return {
    load: () => {
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
    },
  }
}
