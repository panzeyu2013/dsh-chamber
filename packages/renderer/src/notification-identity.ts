/**
 * The ONE notification-run identity resolver (D1/I1).
 *
 * Every consumer that needs to say "this delivery belongs to run X" - the outbox
 * key, the complete ledger, the facts projection - calls this function, so a run
 * cannot acquire two ids. Precedence: an explicit run id > the host's turn seq
 * (host family) > the chamber namespace keyed by the observed watermark episode.
 * The two families never compare or merge (see dsh-stream-state/run-id).
 */
import { chamberRunId, hostRunId, parseChamberRunId, type SessionRunId } from '@dsh-chamber/dsh-stream-state'
import { isWatermark } from './watermark.ts'

/** The decoded host key of a `host:<key>` id, or null when it is malformed. */
function hostKey(runId: SessionRunId): string | null {
  if (!runId.startsWith('host:')) return null
  const encoded = runId.slice('host:'.length)
  if (encoded.length === 0) return null
  try {
    const decoded = decodeURIComponent(encoded)
    // Canonical round-trip only: a corrupt `host:%` throws, a non-canonical
    // encoding (`%2f` vs `%2F`) is rejected instead of becoming a second id.
    return encodeURIComponent(decoded) === encoded ? decoded : null
  } catch {
    return null
  }
}

/** The numeric turn of a `host:turn/<n>` identity, or undefined for another shape. */
function hostTurnNumber(runId: SessionRunId): number | undefined {
  const key = hostKey(runId)
  if (key === null) return undefined
  const match = /^turn\/(\d+)$/u.exec(key)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : undefined
}

/**
 * The restore boundary for a persisted run identity: a chamber id must parse, a
 * host id must decode canonically, and the v4 sentinel is the one allowed
 * non-run value. Anything else (truncated JSON survivor, hand-edited storage) is
 * rejected at load time so a corrupt string cannot reach the projection.
 */
export function isSessionRunId(value: unknown): value is SessionRunId {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return false
  if (value === LEGACY_NOTIFIED_RUN_ID) return true
  if (value.startsWith('chamber:')) {
    const parts = parseChamberRunId(value)
    if (parts === null || parts.generation < 0 || parts.episode < 0) return false
    // Canonical round-trip per component: `s%31` parses equal to `s1`, so a
    // corrupt stored id could otherwise suppress the live run it looks like.
    return value.slice('chamber:'.length).split(':').every(part => {
      try {
        return encodeURIComponent(decodeURIComponent(part)) === part
      } catch {
        return false
      }
    })
  }
  if (value.startsWith('host:')) return hostKey(value) !== null
  return false
}

/**
 * True when `next` cannot be a NEWER run than `previous` inside the same family
 * (identity equality, a chamber episode that did not advance, or a host turn that
 * did not advance). A stale/regressed observation must not mint a fresh identity
 * and notify again - the monotonicity the old watermark table used to provide,
 * now derived from the persisted identity itself.
 */
export function isStaleRunIdentity(previous: SessionRunId, next: SessionRunId): boolean {
  if (previous === next) return true
  const previousParts = parseChamberRunId(previous)
  const nextParts = parseChamberRunId(next)
  // Only the SAME producer lifetime has ordered episodes. A different generation
  // is a remount: its episode 1 is a genuinely new run, not a regression - folding
  // generations together here would silently suppress that run's notification.
  if (previousParts !== null && nextParts !== null
      && previousParts.generation === nextParts.generation
      && previousParts.sourceFingerprint === nextParts.sourceFingerprint
      && previousParts.sessionId === nextParts.sessionId) {
    return nextParts.episode <= previousParts.episode
  }
  const previousTurn = hostTurnNumber(previous)
  const nextTurn = hostTurnNumber(next)
  if (previousTurn !== undefined && nextTurn !== undefined) return nextTurn <= previousTurn
  return false
}

/**
 * The v4 migration sentinel stored in the identity table for a session that was
 * already notified before the identity spine existed. The projection ADOPTS the
 * live run id without notifying when it sees the sentinel, so it exists only
 * until that session's first facts snapshot (or its prune when it leaves the
 * list). It is never compared as a run id.
 */
export const LEGACY_NOTIFIED_RUN_ID = 'legacy:notified'

export interface NotificationIdentityInput {
  readonly sourceFingerprint: string
  readonly sessionId: string
  /** Event kind; ask/request cannot reuse an anonymous identity across events. */
  readonly kind?: 'complete' | 'ask' | 'request'
  readonly runId?: SessionRunId
  readonly completionSeq?: number
  readonly watermark?: number
}

/**
 * Page-lifetime nonce for events that carry no host-domain discriminator (an ask
 * or request observed while facts are unusable). The ms clock makes it distinct
 * across page loads, and the counter distinguishes events inside one page.
 */
const LOCAL_EVENT_GENERATION = Date.now() * 1_000
let localEventSequence = 0

export function notificationRunId(input: NotificationIdentityInput): SessionRunId {
  if (input.runId !== undefined && input.runId.length > 0) return input.runId
  if (typeof input.completionSeq === 'number' && Number.isSafeInteger(input.completionSeq)
      && input.completionSeq >= 0) {
    return hostRunId('turn/' + String(input.completionSeq))
  }
  // A question/approval is a NEW event every time, never a re-observation. The
  // content watermark (last user prompt) does NOT advance for a second approval or
  // question in the same run, so using it as the episode made two real prompts share
  // one outbox key and one durable receipt: the second was silently dropped. Ask and
  // request therefore get the per-event nonce unconditionally.
  if (input.kind === 'ask' || input.kind === 'request') {
    localEventSequence += 1
    return chamberRunId({
      sourceFingerprint: input.sourceFingerprint,
      generation: LOCAL_EVENT_GENERATION,
      sessionId: input.sessionId,
      episode: localEventSequence,
    })
  }
  if (isWatermark(input.watermark)) {
    return chamberRunId({
      sourceFingerprint: input.sourceFingerprint,
      generation: 0,
      sessionId: input.sessionId,
      episode: input.watermark,
    })
  }
  return chamberRunId({
    sourceFingerprint: input.sourceFingerprint,
    generation: 0,
    sessionId: input.sessionId,
    episode: 0,
  })
}
