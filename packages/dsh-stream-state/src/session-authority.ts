/**
 * SessionFactAuthority - the SINGLE owner of "is this session actually running".
 *
 * The official store's `running` bit arrives only on an emit-type mux event with no
 * retransmission, so one lost frame (or a silently half-dead carrier) can leave it stuck
 * at true forever. This module is the chamber's one reconciliation of that bit against
 * independent authority reads, written back through the store's public write path.
 *
 * WHAT IT OWNS: per-session episode identity, official running, authority denials (N=2),
 * correction in flight, and EXACTLY ONE completion edge per running episode. Cadence and
 * escalation belong to the ladder engine (ladder.ts).
 *
 * PURITY: zero imports, no clock reads, no DOM.
 */

/** The official store's per-session projection - the bit that can go stale. */
export interface AuthorityOfficialRow {
  readonly running: boolean
  /** Vendor \`completed\` flag when the caller projects it. */
  readonly completed?: boolean
  /** Subagent-origin rows are outside the fact channel: never reconciled, corrected or
   * notified - a parent's completion is the user-visible event. */
  readonly subagent?: boolean
}

/**
 * One independent authority read (chamber's own unary `session.list`). `complete` = the
 * read returned a complete list, so ABSENCE of an id is a denial; an incomplete read can
 * only deny by an explicit `false`.
 */
export interface AuthorityRead {
  /** false = the read itself failed: no evidence at all (neither confirm nor deny). */
  readonly ok: boolean
  /** true = a complete list; absence is evidence of "not running". */
  readonly complete: boolean
  readonly rows: Readonly<Record<string, boolean>>
}

/** The reducer's whole configuration: the confirmation depth (N in N=2). */
export interface SessionAuthorityConfig {
  /** Independent reads that must agree before a stop may be written back. */
  readonly confirmReads: number
}

/** One running episode. Created on the first tick that sees official running=true. */
export interface SessionAuthorityRecord {
  /** First tick of this running episode (the ladder's symptom age). */
  readonly since: number
  /** Consecutive independent reads that denied running. */
  readonly deniedReads: number
  /** A \`correct\` effect is in flight; no second one may be emitted meanwhile. */
  readonly correctionPending: boolean
  readonly lastReadAt?: number
}

export interface SessionAuthorityState {
  /** Registry fingerprint; a change resets every episode (generation fence). */
  readonly generation: string
  readonly sessions: Readonly<Record<string, SessionAuthorityRecord>>
}

/** What the executor must do. Every effect is idempotent from the reducer's side. */
export type SessionAuthorityEffect =
  /** Read the independent authority again for these ids (N=2 confirmation). */
  | { readonly kind: 'probe'; readonly sessionIds: readonly string[] }
  /** Write "running=false" into the official store for these authority-denied ids. */
  | { readonly kind: 'correct'; readonly sessionIds: readonly string[] }
  /** The episode ended: exactly once per episode. notify=false for list removals. */
  | {
      readonly kind: 'complete'
      readonly sessionId: string
      readonly at: number
      readonly notify: boolean
    }

export type SessionAuthorityObservation =
  | {
      /** The executor's periodic tick with the official store's current projection. */
      readonly kind: 'tick'
      readonly now: number
      readonly generation: string
      /** Every listed session (running and not running); absence = not listed. */
      readonly official: Readonly<Record<string, AuthorityOfficialRow>>
      /** Official list arrival phase; false = absence is NOT evidence. */
      readonly listComplete: boolean
    }
  | {
      /** The result of one independent authority read. */
      readonly kind: 'authorityRead'
      readonly now: number
      readonly read: AuthorityRead
    }
  | {
      /** The result of a \`correct\` effect (always an official-store write of false). */
      readonly kind: 'correctionResult'
      readonly now: number
      readonly sessionIds: readonly string[]
      readonly ok: boolean
    }

export interface SessionAuthorityReduction {
  readonly state: SessionAuthorityState
  readonly effects: readonly SessionAuthorityEffect[]
}

/** Deterministic effect ordering (tick effects are completion edges only). */
function effectOrderKey(effect: SessionAuthorityEffect): string {
  return effect.kind === 'complete' ? effect.sessionId : effect.sessionIds.join(',')
}

export function initialSessionAuthorityState(generation = ''): SessionAuthorityState {
  return { generation, sessions: {} }
}

function sorted(ids: readonly string[]): string[] {
  return [...ids].sort()
}

/** Reduce one observation (tick / authority read / correction result) into the new state
 * and the effects to execute, in deterministic order. */
export function reduceSessionAuthority(
  state: SessionAuthorityState,
  observation: SessionAuthorityObservation,
  config: SessionAuthorityConfig,
): SessionAuthorityReduction {
  if (observation.kind === 'tick') {
    const base = state.generation === observation.generation
      ? state
      : initialSessionAuthorityState(observation.generation)
    const sessions: Record<string, SessionAuthorityRecord> = {}
    const effects: SessionAuthorityEffect[] = []
    const previous = base.sessions
    for (const [sessionId, row] of Object.entries(observation.official)) {
      if (row.subagent === true) continue
      if (row.running) {
        sessions[sessionId] = previous[sessionId] ?? {
          since: observation.now,
          deniedReads: 0,
          correctionPending: false,
        }
        continue
      }
      // Explicit running=false: the episode ended on the official edge.
      if (previous[sessionId] !== undefined) {
        effects.push({ kind: 'complete', sessionId, at: observation.now, notify: true })
      }
    }
    // Sessions that left the list entirely: only a COMPLETE official list may say so.
    for (const [sessionId, record] of Object.entries(previous)) {
      if (observation.official[sessionId] !== undefined || sessions[sessionId] !== undefined) continue
      if (!observation.listComplete) {
        sessions[sessionId] = record
        continue
      }
      effects.push({ kind: 'complete', sessionId, at: observation.now, notify: false })
    }
    return {
      state: { generation: observation.generation, sessions },
      effects: effects.sort((a, b) => effectOrderKey(a).localeCompare(effectOrderKey(b))),
    }
  }

  if (observation.kind === 'authorityRead') {
    if (!observation.read.ok) return { state, effects: [] }
    const sessions: Record<string, SessionAuthorityRecord> = { ...state.sessions }
    const confirm: string[] = []
    const correct: string[] = []
    for (const [sessionId, record] of Object.entries(state.sessions)) {
      const value = observation.read.rows[sessionId]
      const denied = value !== undefined
        ? value === false
        : observation.read.complete
      const known = value !== undefined || observation.read.complete
      if (!known) continue
      if (!denied) {
        // The authority says it IS running: the bit converged, nothing to correct.
        if (record.deniedReads !== 0) {
          sessions[sessionId] = { ...record, deniedReads: 0, lastReadAt: observation.now }
        }
        continue
      }
      const deniedReads = record.deniedReads + 1
      if (record.correctionPending) {
        sessions[sessionId] = { ...record, deniedReads, lastReadAt: observation.now }
        continue
      }
      if (deniedReads >= config.confirmReads) {
        sessions[sessionId] = {
          ...record,
          deniedReads,
          correctionPending: true,
          lastReadAt: observation.now,
        }
        correct.push(sessionId)
      } else {
        sessions[sessionId] = { ...record, deniedReads, lastReadAt: observation.now }
        confirm.push(sessionId)
      }
    }
    const effects: SessionAuthorityEffect[] = []
    if (correct.length > 0) effects.push({ kind: 'correct', sessionIds: sorted(correct) })
    if (confirm.length > 0) effects.push({ kind: 'probe', sessionIds: sorted(confirm) })
    return { state: { generation: state.generation, sessions }, effects }
  }

  // correctionResult: the executor wrote "false" into the official store.
  if (observation.sessionIds.length === 0) return { state, effects: [] }
  const sessions: Record<string, SessionAuthorityRecord> = { ...state.sessions }
  const effects: SessionAuthorityEffect[] = []
  for (const sessionId of sorted(observation.sessionIds)) {
    const record = sessions[sessionId]
    // Only a result for a correction THIS episode still has in flight may settle it: a
    // generation reset or completed episode drops the marker, so a late write is ignored.
    if (record === undefined || !record.correctionPending) continue
    if (!observation.ok) {
      // The write (or its self-verification) failed: reset the denials so a later probe must confirm again.
      sessions[sessionId] = { ...record, deniedReads: 0, correctionPending: false }
      continue
    }
    // The authority denied it and the store accepted the write: the episode ended.
    delete sessions[sessionId]
    effects.push({ kind: 'complete', sessionId, at: observation.now, notify: true })
  }
  return { state: { generation: state.generation, sessions }, effects }
}
