/**
 * Native notification delivery journal. An observed completion is durable here
 * until the host acknowledges display or makes an explicit policy decision.
 * The record contains only identities and watermarks, never notification copy.
 */
import type { SessionRunId } from '@dsh-chamber/dsh-stream-state'
import { isSessionRunId, notificationRunId } from './notification-identity.ts'
import type { UnreadStorageLike } from './unread-store.ts'
import { isWatermark } from './watermark.ts'

export const NOTIFICATION_OUTBOX_KEY = 'dsh-chamber.notification-outbox.v2'
/** The pre-spine journal: drained once into v2, never written again (D1 migration). */
const LEGACY_NOTIFICATION_OUTBOX_KEY = 'dsh-chamber.notification-outbox.v1'
export const NOTIFICATION_OUTBOX_LIMIT = 500
/** Independent additive key: { hostKey -> canonical run id } for completion aliases. */
const COMPLETION_ALIAS_KEY = 'dsh-chamber.notification-outbox.aliases.v1'
/** Two channels may report one completion a little apart; outside this it is a new event. */
const COMPLETION_ALIAS_WINDOW_MS = 60_000
const COMPLETION_ALIAS_LIMIT = 200
const MAX_RETRY_DELAY_MS = 60_000
export type DeliveryOutcome = 'shown' | 'suppressed' | 'retryable' | 'permanent'

export interface NotificationIntent {
  sourceId: string
  sourceFingerprint: string
  sessionId: string
  kind: 'complete' | 'ask' | 'request'
  watermark?: number
  /** Host session event sequence, independent of millisecond read watermarks. */
  completionSeq?: number
  /** The identity spine; enqueue resolves it when the caller cannot (host seq > watermark). */
  runId?: SessionRunId
  /** Host-domain `updatedAt` this edge observed (ordering anchor for the runtime
   *  completion marker; never used as a read watermark). */
  hostObservedAt?: number
}

export interface PendingNotification extends NotificationIntent {
  /** Resolved by enqueue(); the journal key and the native eventKey derive from it. */
  runId: SessionRunId
  key: string
  attempts: number
  nextAttemptAt: number
  blocked: boolean
}

/**
 * The facts-channel evidence for ONE observed completion. `hostUpdatedAt` is the
 * host `updatedAt` the facts row carried - the SAME field (and domain) the runtime
 * edge stored as {@link NotificationIntent.hostObservedAt}. It is required so a
 * caller cannot silently associate the content watermark with the runtime anchor:
 * for one completion the two differ (completedAt is normally later), and the
 * cross-domain comparison refused the same run's facts frame, letting the
 * projection mint a second delivery key for one completion.
 */
export interface ObservedCompletion {
  /** Content watermark: complete = max(completedAt, updatedAt) (host domain). */
  readonly watermark: number
  /** Host session event sequence, when the facts channel carried one. */
  readonly completionSeq?: number
  /** Host `updatedAt` of the facts row: the runtime edge's own ordering field. */
  readonly hostUpdatedAt: number
}

/** One renderer-to-native attempt; the event key remains stable across retries. */
export interface NotificationAttempt {
  readonly key: string
  readonly id: number
}

export interface NotificationSettlement {
  /** False means a superseded or forgotten attempt reported after ownership moved. */
  readonly accepted: boolean
  /** Present only for a shown or policy-suppressed delivery. */
  readonly delivered: PendingNotification | null
}

type StoredRow = Omit<PendingNotification, 'runId' | 'key'> & { runId?: SessionRunId; key?: string }

function validStoredRow(value: unknown): value is StoredRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Partial<StoredRow>
  return (row.key === undefined || (typeof row.key === 'string' && row.key.length > 0 && row.key.length <= 1_024))
    && (row.runId === undefined || isSessionRunId(row.runId))
    && typeof row.sourceId === 'string' && row.sourceId.length > 0
    && typeof row.sourceFingerprint === 'string' && row.sourceFingerprint.length > 0
    && typeof row.sessionId === 'string' && row.sessionId.length > 0
    && (row.kind === 'complete' || row.kind === 'ask' || row.kind === 'request')
    && (row.watermark === undefined || isWatermark(row.watermark))
    && (row.completionSeq === undefined || isWatermark(row.completionSeq))
    && (row.hostObservedAt === undefined || isWatermark(row.hostObservedAt))
    && typeof row.attempts === 'number' && Number.isSafeInteger(row.attempts) && row.attempts >= 0
    && typeof row.nextAttemptAt === 'number' && Number.isSafeInteger(row.nextAttemptAt) && row.nextAttemptAt >= 0
    && typeof row.blocked === 'boolean'
}

/**
 * The host-domain completion key shared by every channel that can observe the same
 * completion. The completion sequence is the strongest discriminator; the host
 * `updatedAt` is the fallback when the facts channel never carried a sequence.
 * Returns undefined when the intent carries neither (no correlation possible).
 */
function hostKeyOf(intent: NotificationIntent): string | undefined {
  if (intent.kind !== 'complete') return undefined
  const discriminator = intent.completionSeq !== undefined ? 'seq:' + String(intent.completionSeq)
    : intent.hostObservedAt !== undefined ? 'at:' + String(intent.hostObservedAt)
      : undefined
  if (discriminator === undefined) return undefined
  return JSON.stringify([intent.sourceId, intent.sourceFingerprint, intent.sessionId, discriminator])
}

interface CompletionAlias { readonly hostKey: string; readonly runId: SessionRunId; readonly at: number }

function readAliases(storage: UnreadStorageLike | undefined): CompletionAlias[] {
  try {
    const raw = storage?.getItem(COMPLETION_ALIAS_KEY)
    if (raw === null || raw === undefined) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((row): row is CompletionAlias => row !== null && typeof row === 'object'
      && typeof (row as CompletionAlias).hostKey === 'string'
      && typeof (row as CompletionAlias).at === 'number' && Number.isSafeInteger((row as CompletionAlias).at)
      && isSessionRunId((row as CompletionAlias).runId)).slice(-COMPLETION_ALIAS_LIMIT)
  } catch { return [] }
}

function keyFor(intent: NotificationIntent & { runId: SessionRunId }): string {
  // JSON array encoding prevents separator collisions between arbitrary ids; the
  // run identity replaces the old (watermark | host-seq) discriminator.
  return JSON.stringify([intent.sourceId, intent.sourceFingerprint, intent.sessionId, intent.kind, intent.runId])
}

function readStored(storage: UnreadStorageLike | undefined, key: string): StoredRow[] {
  try {
    const raw = storage?.getItem(key)
    if (raw === null || raw === undefined) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(validStoredRow).slice(-NOTIFICATION_OUTBOX_LIMIT)
  } catch { return [] }
}

/** Rebuild one stored row: the run identity is derived when the row predates the spine. */
function normalizeStored(row: StoredRow): PendingNotification {
  // The stored identity is authoritative. Re-deriving an anonymous ask/request after
  // a page reload minted a NEW id, re-keyed a pending entry and decoupled it from the
  // receipt the host may already hold.
  const runId = row.runId !== undefined && isSessionRunId(row.runId) ? row.runId : notificationRunId(row)
  const resolved = { ...row, runId } as PendingNotification
  return { ...resolved, key: keyFor(resolved) }
}

/**
 * v2 is the only written key. A pre-spine v1 journal is ADOPTED once (delivered as
 * usual, never silently dropped) and removed only after v2 is persisted; an entry
 * that already exists in v2 is not duplicated.
 */
function load(storage: UnreadStorageLike | undefined): { pending: PendingNotification[]; legacy: PendingNotification[] } {
  const current = readStored(storage, NOTIFICATION_OUTBOX_KEY).map(normalizeStored)
  const keys = new Set(current.map(entry => entry.key))
  const legacy = readStored(storage, LEGACY_NOTIFICATION_OUTBOX_KEY)
    .map(normalizeStored).filter(entry => !keys.has(entry.key))
  return { pending: current, legacy }
}

export function createNotificationOutbox(storage?: UnreadStorageLike, now: () => number = Date.now) {
  const loaded = load(storage)
  const pending = new Map<string, PendingNotification>(loaded.pending.map(item => [item.key, item]))
  for (const entry of loaded.legacy) pending.set(entry.key, entry)
  if (loaded.legacy.length > 0) {
    try {
      storage?.setItem(NOTIFICATION_OUTBOX_KEY, JSON.stringify([...pending.values()]))
      storage?.removeItem(LEGACY_NOTIFICATION_OUTBOX_KEY)
    } catch { /* v1 stays for the next boot; the adopted entries still deliver */ }
  }
  const aliases = new Map<string, CompletionAlias>(
    readAliases(storage).map(alias => [alias.hostKey, alias]),
  )
  const persistAliases = (): void => {
    try {
      const rows = [...aliases.values()].sort((a, b) => a.at - b.at).slice(-COMPLETION_ALIAS_LIMIT)
      storage?.setItem(COMPLETION_ALIAS_KEY, JSON.stringify(rows))
    } catch { /* the alias table is an optimization; delivery continues in memory */ }
  }
  /** The canonical id for a host completion already delivered, while the window holds. */
  const aliasFor = (hostKey: string): SessionRunId | undefined => {
    const alias = aliases.get(hostKey)
    if (alias === undefined) return undefined
    if (now() - alias.at > COMPLETION_ALIAS_WINDOW_MS) {
      // Out of the correlation window: the same host key is a NEW event. Dropping the
      // stale mapping keeps the failure direction duplication, never loss.
      aliases.delete(hostKey)
      persistAliases()
      return undefined
    }
    return alias.runId
  }
  /** First notified id wins and never churns while the window holds. */
  const rememberAlias = (hostKey: string | undefined, runId: SessionRunId): void => {
    if (hostKey === undefined || aliases.has(hostKey)) return
    aliases.set(hostKey, { hostKey, runId, at: now() })
    persistAliases()
  }
  const inFlight = new Map<string, number>()
  let nextAttemptId = 1
  const dueAt = (entry: PendingNotification, at: number): number =>
    entry.nextAttemptAt - at > MAX_RETRY_DELAY_MS ? at : entry.nextAttemptAt
  const persist = (): void => {
    try { storage?.setItem(NOTIFICATION_OUTBOX_KEY, JSON.stringify([...pending.values()])) } catch { /* in-memory delivery continues */ }
  }
  return {
    enqueue(intent: NotificationIntent): PendingNotification | null {
      const hostKey = hostKeyOf(intent)
      // Alias rewrite BEFORE key derivation: one completion seen through another
      // identity family resolves to the first-notified run id, so the existing key
      // and the durable native receipt suppress the second banner by themselves.
      // The host completion SEQUENCE is a strong identity: an intent carrying it (and
      // any explicit id next to it) keeps its own key by notificationRunId precedence.
      // The fallback host-time key is channel-agnostic, so a recorded alias must win
      // there: the runtime edge carries its own producer id for the SAME completion.
      const canonical = hostKey === undefined || intent.completionSeq !== undefined
        ? undefined
        : aliasFor(hostKey)
      const resolved: NotificationIntent & { runId: SessionRunId } = {
        ...intent,
        runId: canonical ?? notificationRunId(intent),
      }
      if (resolved.watermark === undefined && resolved.completionSeq === undefined) {
        // Replayed runtime edges after a renderer reload resolve to the journal's ORIGINAL
        // run id and retain its native eventKey; a new completion has its own id and
        // creates its own event. Identity is the only run key here.
        const prior = [...pending.values()].find(entry => entry.sourceId === resolved.sourceId
          && entry.sourceFingerprint === resolved.sourceFingerprint && entry.sessionId === resolved.sessionId
          && entry.kind === resolved.kind && entry.watermark === undefined
          // A blocked entry can never deliver (due() skips it): answering a later
          // run's edge with it silently swallows that run's completion.
          && entry.completionSeq === undefined && !entry.blocked
          // Identity is the run key: a REPLAYED edge resolves to the journal's run id
          // and returns its original entry; a new completion or a new question has its
          // own id and must create its own event/key (sharing one let the durable
          // receipt drop the real second event).
          && entry.runId === resolved.runId)
        if (prior !== undefined) { rememberAlias(hostKey, prior.runId); return prior }
      }
      const key = keyFor(resolved)
      const existing = pending.get(key)
      if (existing !== undefined) { rememberAlias(hostKey, existing.runId); return existing }
      if (pending.size >= NOTIFICATION_OUTBOX_LIMIT) {
        // A permanent failure is terminal diagnostic history, not a retrying
        // delivery. Keep recent failures but let a later completion enter the
        // bounded journal instead of making notification delivery die forever.
        const oldestBlocked = [...pending].find(([, entry]) => entry.blocked)?.[0]
        if (oldestBlocked === undefined) return null
        pending.delete(oldestBlocked)
      }
      const entry: PendingNotification = { ...resolved, key, attempts: 0, nextAttemptAt: now(), blocked: false }
      pending.set(key, entry)
      persist()
      rememberAlias(hostKey, entry.runId)
      return entry
    },
    /**
     * Associate one facts completion with a runtime edge still awaiting delivery,
     * and answer whether a pending entry already claims it.
     *
     * ONE predicate answers BOTH questions (stamping the evidence, and gating the
     * facts projection): the retired pair of comparators was free to disagree, which
     * is how one completion acquired two delivery keys. A live unwatermarked edge is
     * stamped when it is provably the same run; an already-classified or permanently
     * failed edge answers only for its OWN identity.
     */
    associateCompletion(sourceId: string, fingerprint: string, sessionId: string,
                        observed: ObservedCompletion): boolean {
      for (const [key, entry] of pending) {
        if (entry.sourceId !== sourceId || entry.sourceFingerprint !== fingerprint
            || entry.sessionId !== sessionId || entry.kind !== 'complete') continue
        if (entry.watermark !== undefined || entry.blocked) {
          // Handled already (or terminally failed): it claims this completion only
          // through its OWN identity. An unwatermarked blocked entry never absorbs a
          // later run - only an agreeing host sequence can identify its run.
          if (entry.watermark === observed.watermark) return true
          if (entry.completionSeq !== undefined && observed.completionSeq !== undefined
              && entry.completionSeq === observed.completionSeq) return true
          continue
        }
        // SAME-DOMAIN fence: the runtime edge anchored on the host `updatedAt` it
        // observed, and the facts row carries that same field. The content watermark
        // (max(completedAt, updatedAt)) is NOT that field: comparing the two refused the
        // SAME run's facts frame, and the projection then minted a second run id for
        // one completion. A facts row that postdates the edge's own host state still
        // belongs to a NEWER run and must not attach.
        if (entry.hostObservedAt !== undefined && observed.hostUpdatedAt > entry.hostObservedAt) continue
        // A carried host sequence that disagrees is a different run, whatever the
        // two host times say (a clock step can make a newer run look older).
        if (entry.completionSeq !== undefined && observed.completionSeq !== undefined
            && entry.completionSeq !== observed.completionSeq) continue
        pending.set(key, {
          ...entry,
          watermark: observed.watermark,
          ...(observed.completionSeq === undefined ? {} : { completionSeq: observed.completionSeq }),
        })
        persist()
        return true
      }
      return false
    },
    due(at = now()): PendingNotification[] {
      return [...pending.values()].filter(entry => !entry.blocked && !inFlight.has(entry.key) && dueAt(entry, at) <= at)
    },
    nextDueAt(): number | null {
      const at = now()
      let earliest: number | null = null
      for (const entry of pending.values()) {
        if (entry.blocked || inFlight.has(entry.key)) continue
        const due = dueAt(entry, at)
        earliest = earliest === null ? due : Math.min(earliest, due)
      }
      return earliest
    },
    begin(key: string): NotificationAttempt | null {
      if (!pending.has(key) || inFlight.has(key)) return null
      const attempt = { key, id: nextAttemptId++ }
      inFlight.set(key, attempt.id)
      return attempt
    },
    settle(attempt: NotificationAttempt, outcome: DeliveryOutcome): NotificationSettlement {
      if (inFlight.get(attempt.key) !== attempt.id) return { accepted: false, delivered: null }
      inFlight.delete(attempt.key)
      const entry = pending.get(attempt.key)
      if (entry === undefined) return { accepted: false, delivered: null }
      if (outcome === 'shown' || outcome === 'suppressed') {
        pending.delete(attempt.key)
        persist()
        return { accepted: true, delivered: entry }
      }
      const attempts = entry.attempts + 1
      const permanent = outcome === 'permanent'
      pending.set(attempt.key, {
        ...entry, attempts,
        blocked: permanent,
        // (A terminal failure stays blocked: associateCompletion never stamps a blocked entry, so
        // it can never absorb a later run's host watermark.)
        nextAttemptAt: now() + Math.min(MAX_RETRY_DELAY_MS, 6_000 * 2 ** Math.min(attempts - 1, 4)),
      })
      persist()
      return { accepted: true, delivered: null }
    },
    forgetSource(sourceId: string): void {
      for (const [key, entry] of pending) {
        if (entry.sourceId !== sourceId) continue
        pending.delete(key)
        inFlight.delete(key)
      }
      persist()
    },
    forget(key: string): void {
      if (!pending.delete(key)) return
      inFlight.delete(key)
      persist()
    },
    pruneSources(live: ReadonlySet<string>): void {
      let changed = false
      for (const [key, entry] of pending) {
        if (live.has(entry.sourceId)) continue
        pending.delete(key)
        inFlight.delete(key)
        changed = true
      }
      if (changed) persist()
    },
    entries(): readonly PendingNotification[] { return [...pending.values()] },
  }
}

export type NotificationOutbox = ReturnType<typeof createNotificationOutbox>
