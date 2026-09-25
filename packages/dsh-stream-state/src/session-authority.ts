/**
 * SessionFactAuthority - the SINGLE owner of "is this session actually running".
 *
 * P1 of the session-fact authority refactor.
 *
 * WHY THIS EXISTS. The official store's \`running\` bit is delivered only by an emit-type
 * mux event with no retransmission, so losing one frame (or a silently half-dead carrier)
 * leaves it stuck at true forever - the sidebar never sees the running->idle edge and the
 * completion notification is never armed ("silent completion"). The chamber cannot fix the
 * upstream emitter; it CAN own a single reconciliation of that bit against independent
 * authority reads and write the conclusion back through the official store's public write
 * path. This module is that reconciliation, as a pure reducer.
 *
 * WHAT IT OWNS (and what it deliberately does not):
 *  - truth: per-session episode identity, official running, authority denials (N=2),
 *    correction in flight, and EXACTLY ONE completion edge per running episode;
 *  - it does NOT own cadence or escalation: when to probe, when to reconnect and when to
 *    surface a stall belong to the one ladder engine (ladder.ts). The reducer only asks
 *    for the immediate confirmation read that N=2 needs.
 *
 * PURITY (enforced by the package test manifest): zero imports, no clock reads, no DOM.
 * Every time arrives on the observation; every threshold arrives via config.
 */

/** The official store's per-session projection - the bit that can go stale. */
export interface AuthorityOfficialRow {
  readonly running: boolean
  /** Subagent-origin rows are outside the fact channel: never reconciled, corrected or
   * notified - a parent's completion is the user-visible event. */
  readonly subagent?: boolean
}

/**
 * Completeness proof of one independent read. `none` means the host returned no
 * completeness marker, so ABSENCE of an id is NOT evidence (I5); an explicit `false` row
 * remains a denial because the row itself is evidence. The asOfSeq/cursor kinds are the
 * upstream contract (design 14 §D4 / design 17 §10.7).
 */
export type AuthorityReadProof =
  | { readonly kind: 'none' }
  | { readonly kind: 'asOfSeq'; readonly asOfSeq: number }
  | { readonly kind: 'cursor'; readonly cursor: string }

/**
 * One independent authority read (chamber's own unary `session.list`, NOT the official
 * refresh). Only a read WITH a completeness proof may treat absence as a denial; an
 * unproven read denies solely by an explicit `false` row.
 */
export interface AuthorityRead {
  /** false = the read itself failed: no evidence at all (neither confirm nor deny). */
  readonly ok: boolean
  /** How the read proved completeness; `none` = absence is not evidence. */
  readonly proof: AuthorityReadProof
  readonly rows: Readonly<Record<string, boolean>>
}

/** The reducer's whole configuration: the confirmation depth (N in N=2). */
export interface SessionAuthorityConfig {
  /** Independent reads that must agree before a stop may be written back. */
  readonly confirmReads: number
}

/** One running episode. Created on the first tick that sees official running=true. */
export interface SessionAuthorityRecord {
  /** Identity of this running episode, unique for the lifetime of the reducer. */
  readonly episodeId: number
  /** First tick of this running episode (the ladder's symptom age). */
  readonly since: number
  /** Consecutive independent reads that denied running. */
  readonly deniedReads: number
  /** Exact write command in flight; a result from another command cannot settle it. */
  readonly correctionTicket?: number | undefined
  readonly lastReadAt?: number
}

/** A read/write command is bound to the episodes that existed when it was issued. */
export interface SessionAuthorityTicket {
  readonly id: number
  readonly generation: string
  readonly episodes: Readonly<Record<string, number>>
}

export interface SessionAuthorityState {
  /** Registry fingerprint; a change resets every episode (generation fence). */
  readonly generation: string
  /** Monotonic identity source, retained across generation resets. */
  readonly nextId: number
  readonly sessions: Readonly<Record<string, SessionAuthorityRecord>>
  /** The only read allowed to report back; a newer request supersedes an older one. */
  readonly pendingRead?: SessionAuthorityTicket | undefined
}

/** What the executor must do. Every effect is idempotent from the reducer's side. */
export type SessionAuthorityEffect =
  /** Read the independent authority again for these ids (N=2 confirmation). */
  | { readonly kind: 'probe'; readonly sessionIds: readonly string[]; readonly ticket: SessionAuthorityTicket }
  /** Write "running=false" into the official store for these authority-denied ids. */
  | { readonly kind: 'correct'; readonly sessionIds: readonly string[]; readonly ticket: SessionAuthorityTicket }
  /** Diagnostic running-bit episode end. Notification classification belongs to
   * the facts projection and native delivery journal, not this reducer. */
  | {
      readonly kind: 'episodeEnded'
      readonly sessionId: string
      readonly at: number
      readonly cause: 'official-stop' | 'list-removal' | 'correction'
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
      /** Start (or supersede) an independent read for the current episodes. */
      readonly kind: 'readRequested'
    }
  | {
      /** The result of one independent authority read. */
      readonly kind: 'authorityRead'
      readonly now: number
      readonly ticket: SessionAuthorityTicket
      readonly read: AuthorityRead
    }
  | {
      /** The result of a \`correct\` effect (always an official-store write of false). */
      readonly kind: 'correctionResult'
      readonly now: number
      readonly ticket: SessionAuthorityTicket
      readonly ok: boolean
    }

export interface SessionAuthorityReduction {
  readonly state: SessionAuthorityState
  readonly effects: readonly SessionAuthorityEffect[]
  /** Present only for an accepted authority read; ids without a verdict remain stuck evidence. */
  readonly unresolved?: readonly string[]
}

/** Deterministic effect ordering (tick effects are completion edges only). */
function effectOrderKey(effect: SessionAuthorityEffect): string {
  return effect.kind === 'episodeEnded' ? effect.sessionId : effect.sessionIds.join(',')
}

export function initialSessionAuthorityState(generation = ''): SessionAuthorityState {
  return { generation, nextId: 1, sessions: {} }
}

function sorted(ids: readonly string[]): string[] {
  return [...ids].sort()
}

function ticketFor(
  state: SessionAuthorityState,
  ids: readonly string[],
  id: number,
): SessionAuthorityTicket {
  const episodes: Record<string, number> = {}
  for (const sessionId of sorted(ids)) {
    const record = state.sessions[sessionId]
    if (record !== undefined) episodes[sessionId] = record.episodeId
  }
  return { id, generation: state.generation, episodes }
}

function currentTicket(state: SessionAuthorityState, ticket: SessionAuthorityTicket): boolean {
  return ticket.generation === state.generation
}

/** Reduce one observation (tick / authority read / correction result) into the new state
 * and the effects to execute, in deterministic order. */
export function reduceSessionAuthority(
  state: SessionAuthorityState,
  observation: SessionAuthorityObservation,
  config: SessionAuthorityConfig,
): SessionAuthorityReduction {
  if (observation.kind === 'tick') {
    const changedGeneration = state.generation !== observation.generation
    const previous = changedGeneration ? {} : state.sessions
    const sessions: Record<string, SessionAuthorityRecord> = {}
    const effects: SessionAuthorityEffect[] = []
    let nextId = state.nextId
    for (const sessionId of sorted(Object.keys(observation.official))) {
      const row = observation.official[sessionId]!
      if (row.subagent === true) continue
      if (row.running) {
        sessions[sessionId] = previous[sessionId] ?? {
          episodeId: nextId++,
          since: observation.now,
          deniedReads: 0,
        }
        continue
      }
      // Explicit running=false: the episode ended on the official edge.
      if (previous[sessionId] !== undefined) {
        effects.push({ kind: 'episodeEnded', sessionId, at: observation.now, cause: 'official-stop' })
      }
    }
    // Sessions that left the list entirely: only a COMPLETE official list may say so.
    for (const [sessionId, record] of Object.entries(previous)) {
      if (observation.official[sessionId] !== undefined || sessions[sessionId] !== undefined) continue
      if (!observation.listComplete) {
        sessions[sessionId] = record
        continue
      }
      effects.push({ kind: 'episodeEnded', sessionId, at: observation.now, cause: 'list-removal' })
    }
    return {
      state: {
        generation: observation.generation,
        nextId,
        sessions,
        ...(changedGeneration ? {} : state.pendingRead === undefined ? {} : { pendingRead: state.pendingRead }),
      },
      effects: effects.sort((a, b) => effectOrderKey(a).localeCompare(effectOrderKey(b))),
    }
  }

  if (observation.kind === 'readRequested') {
    const sessionIds = sorted(Object.keys(state.sessions))
    if (sessionIds.length === 0) return { state, effects: [] }
    const ticket = ticketFor(state, sessionIds, state.nextId)
    return {
      state: { ...state, nextId: state.nextId + 1, pendingRead: ticket },
      effects: [{ kind: 'probe', sessionIds, ticket }],
    }
  }

  if (observation.kind === 'authorityRead') {
    if (!currentTicket(state, observation.ticket)
      || state.pendingRead?.id !== observation.ticket.id) return { state, effects: [] }
    const withoutPending: SessionAuthorityState = { ...state, pendingRead: undefined }
    const activeIds = Object.entries(observation.ticket.episodes)
      .filter(([sessionId, episodeId]) => state.sessions[sessionId]?.episodeId === episodeId)
      .map(([sessionId]) => sessionId)
    if (!observation.read.ok) {
      return { state: withoutPending, effects: [], unresolved: sorted(activeIds) }
    }
    const sessions: Record<string, SessionAuthorityRecord> = { ...state.sessions }
    const confirm: string[] = []
    const correct: string[] = []
    const unresolved: string[] = []
    for (const [sessionId, episodeId] of Object.entries(observation.ticket.episodes)) {
      const record = state.sessions[sessionId]
      if (record === undefined || record.episodeId !== episodeId) continue
      const value = observation.read.rows[sessionId]
      const provenComplete = observation.read.proof.kind !== 'none'
      const denied = value !== undefined
        ? value === false
        : provenComplete
      const known = value !== undefined || provenComplete
      if (!known) {
        unresolved.push(sessionId)
        continue
      }
      if (!denied) {
        // The authority says it IS running: the bit converged, nothing to correct.
        if (record.deniedReads !== 0 || record.correctionTicket !== undefined) {
          sessions[sessionId] = {
            ...record, deniedReads: 0, correctionTicket: undefined, lastReadAt: observation.now,
          }
        }
        continue
      }
      const deniedReads = record.deniedReads + 1
      if (record.correctionTicket !== undefined) {
        sessions[sessionId] = { ...record, deniedReads, lastReadAt: observation.now }
        continue
      }
      if (deniedReads >= config.confirmReads) {
        correct.push(sessionId)
      } else {
        sessions[sessionId] = { ...record, deniedReads, lastReadAt: observation.now }
        confirm.push(sessionId)
      }
    }
    const effects: SessionAuthorityEffect[] = []
    let nextId = state.nextId
    if (correct.length > 0) {
      const ticket = ticketFor(state, correct, nextId++)
      for (const sessionId of correct) {
        sessions[sessionId] = {
          ...sessions[sessionId]!, deniedReads: state.sessions[sessionId]!.deniedReads + 1,
          correctionTicket: ticket.id, lastReadAt: observation.now,
        }
      }
      effects.push({ kind: 'correct', sessionIds: sorted(correct), ticket })
    }
    let pendingRead: SessionAuthorityTicket | undefined
    if (confirm.length > 0) {
      pendingRead = ticketFor(state, confirm, nextId++)
      effects.push({ kind: 'probe', sessionIds: sorted(confirm), ticket: pendingRead })
    }
    return { state: { ...withoutPending, nextId, sessions, pendingRead }, effects, unresolved: sorted(unresolved) }
  }

  // correctionResult: the executor wrote "false" into the official store.
  if (!currentTicket(state, observation.ticket)) return { state, effects: [] }
  const sessions: Record<string, SessionAuthorityRecord> = { ...state.sessions }
  const effects: SessionAuthorityEffect[] = []
  for (const sessionId of sorted(Object.keys(observation.ticket.episodes))) {
    const record = sessions[sessionId]
    if (record === undefined
      || record.episodeId !== observation.ticket.episodes[sessionId]
      || record.correctionTicket !== observation.ticket.id) continue
    if (!observation.ok) {
      // The write (or its self-verification) failed: this round may not claim a
      // correction. Reset the denials so a later probe must confirm again.
      sessions[sessionId] = { ...record, deniedReads: 0, correctionTicket: undefined }
      continue
    }
    // The authority denied it and the store accepted the write: the episode ended.
    delete sessions[sessionId]
    effects.push({ kind: 'episodeEnded', sessionId, at: observation.now, cause: 'correction' })
  }
  return { state: { ...state, sessions }, effects }
}
