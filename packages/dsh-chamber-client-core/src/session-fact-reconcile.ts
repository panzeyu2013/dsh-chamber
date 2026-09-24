/**
 * SessionAuthorityReconciler - the I/O half of the session-fact authority.
 *
 * ## What this module does
 *
 * The POLICY lives in `@dsh-chamber/dsh-stream-state`: `reduceSessionAuthority` owns the
 * running-bit truth, the N=2 confirmation and the exactly-once completion edge, and
 * `ladder.ts` owns the probe cadence. This file only does what a host must do:
 *
 *   1. read the official store projection and the source generation;
 *   2. run the probe ladder and, when it dispatches, perform an independent authority
 *      read (the control-plane unary `session.list`, a carrier independent of the
 *      guarded WS fact channel);
 *   3. feed the read back into the reducer and execute its effects: one confirmation
 *      read for N=2, or the tier-3 write-back through the official store's public
 *      write path (only "running=false", self-verified);
 *   4. publish the authority snapshot the App's escalation ladder consumes
 *      (`runningSince` / `stuckSince` / `progressStamp`).
 *
 * The probe's carrier is the independent unary read; the official refresh resolves on
 * failure (vendor `refreshList()`), so it cannot serve as a second verdict carrier.
 *
 * ## Discipline
 * - single flight: requests received in flight coalesce into one fresh attempt;
 * - fail-closed: every seam failure is a `warn` + stuck evidence, never a throw;
 * - the write-back is idempotent and self-verified; the reducer only ever asks for false.
 */
import {
  LADDER_TABLES,
  initialSessionAuthorityState,
  planLadder,
  reduceSessionAuthority,
  sessionAuthorityProbeLadder,
  type AuthorityOfficialRow,
  type AuthorityRead,
  type LadderObservation,
  type LadderRecord,
  type SessionAuthorityEffect,
  type SessionAuthorityState,
} from '@dsh-chamber/dsh-stream-state'

/** The official store projection read each tick. */
export interface AuthorityOfficialRead {
  /** Every listed session; subagent rows are exported but never reconciled. */
  readonly rows: Readonly<Record<string, AuthorityOfficialRow>>
  /** Official list arrival phase; false = a missing row is not evidence. */
  readonly listComplete: boolean
}

export interface SessionAuthorityDeps {
  readonly now: () => number
  /** Registry fingerprint; a change resets every episode (generation fence). */
  readonly generation: () => string
  readonly readOfficial: () => AuthorityOfficialRead
  /** undefined = transport failure (no verdict this round). */
  readonly readAuthority: () => Promise<AuthorityRead | undefined>
  /** Tier-3 write-back: official `handleSessionStatus(id, false)` + self-verification. */
  readonly correct: (sessionIds: readonly string[]) => Promise<boolean>
  readonly warn: (message: string) => void
  /**
   * P5 persistence seam: called exactly once per produced action, so a real-machine
   * incident can be reconstructed after a reload. Must never break the chain.
   */
  readonly record?: (entry: AuthorityActionLogEntry) => void
  readonly onSettled?: () => void
}

/**
 * The authority state published in the runtime report (single projection consumed by
 * the App's escalation ladder; replaced `SessionFactReconcileSnapshot`).
 */
export interface SessionAuthoritySnapshot {
  readonly requestedAt: number
  /** Missing = an attempt is in flight. */
  readonly settledAt?: number
  /** true = the last settled attempt had no stuck evidence. */
  readonly ok: boolean
  /** Earliest episode start among currently running rows (symptom age). */
  readonly runningSince?: number
  /** First probe/correction failure not yet cleared by a healthy verdict. */
  readonly stuckSince?: number
  /** Monotonic; a healthy verdict advances it and resets the escalation streak. */
  readonly progressStamp: number
  /** Diagnostic counters (bounded by the per-episode probe quota). */
  readonly probes: number
  readonly corrections: number
  /** Most recent actions (bounded ring, oldest first). */
  readonly recent: readonly AuthorityActionLogEntry[]
}

/**
 * Evidence surface: what the authority actually did, in bounded form. It travels
 * in the runtime report (and each act also emits one warn line, bounded by the probe
 * ladder's quota) so a real-machine incident can answer "did L1 fire / did the bit
 * drop" without a debugger. A file-backed surface remains host work (STATUS).
 */
export interface AuthorityActionLogEntry {
  readonly at: number
  readonly kind: 'probe' | 'read-failed' | 'correct' | 'correct-failed' | 'complete' | 'recovered'
  readonly detail?: string
}

/** The ladder's observation key: one reconciler instance == one source. */
const LADDER_KEY = 'source'

const CONFIG = { confirmReads: 2 } as const

/** The probe cadence is a property of the one table, not of this module. */
const PROBE_LADDER = sessionAuthorityProbeLadder(LADDER_TABLES.authority)

/**
 * Write-back targets: only ids that are BOTH authority-denied and still claiming
 * running in the store (idempotent, minimal write surface). Empty = already converged.
 */
export function writeBackTargets(
  denied: ReadonlySet<string>,
  official: Readonly<Record<string, Partial<AuthorityOfficialRow> | undefined>>,
): string[] {
  return [...denied].filter(sessionId => official[sessionId]?.running === true)
}

export class SessionAuthorityReconciler {
  private readonly deps: SessionAuthorityDeps
  private authority: SessionAuthorityState = initialSessionAuthorityState()
  private probeRecords: Readonly<Record<string, LadderRecord>> = {}
  private requestedAt: number | undefined
  private settledAt: number | undefined
  private settledOk = false
  private stuckSince: number | undefined
  private progressStamp = 0
  private probes = 0
  private corrections = 0
  private requestVersion = 0
  private running = false
  private disposed = false
  private readonly actionLog: AuthorityActionLogEntry[] = []

  constructor(deps: SessionAuthorityDeps) {
    this.deps = deps
  }

  /** Request one authority tick. In flight: schedule one fresh pass after this one. */
  request(): void {
    if (this.disposed) return
    this.requestedAt = this.deps.now()
    this.settledAt = undefined
    this.requestVersion += 1
    if (this.running) return
    this.running = true
    void this.drain()
  }

  snapshot(): SessionAuthoritySnapshot | undefined {
    if (this.requestedAt === undefined) return undefined
    const runningSince = this.earliestRunningSince()
    return {
      requestedAt: this.requestedAt,
      ...(this.settledAt === undefined ? {} : { settledAt: this.settledAt }),
      ok: this.settledAt === undefined ? false : this.settledOk,
      ...(runningSince === undefined ? {} : { runningSince }),
      ...(this.stuckSince === undefined ? {} : { stuckSince: this.stuckSince }),
      progressStamp: this.progressStamp,
      probes: this.probes,
      corrections: this.corrections,
      recent: [...this.actionLog],
    }
  }

  dispose(): void {
    this.disposed = true
  }

  /**
   * Bounded evidence ring (16 entries); each act also emits one bounded warn line and
   * is handed to the host's persistence seam (exactly once, in production order).
   */
  private note(at: number, kind: AuthorityActionLogEntry['kind'], detail?: string): void {
    const entry: AuthorityActionLogEntry = { at, kind, ...(detail === undefined ? {} : { detail }) }
    this.actionLog.push(entry)
    if (this.actionLog.length > 16) this.actionLog.shift()
    this.deps.warn('authority action ' + kind + ' at ' + String(at) + (detail === undefined ? '' : ': ' + detail))
    try {
      this.deps.record?.(entry)
    } catch {
      // A diagnostics sink must never break the authority chain.
    }
  }

  private earliestRunningSince(): number | undefined {
    const starts = Object.values(this.authority.sessions).map(record => record.since)
    return starts.length === 0 ? undefined : Math.min(...starts)
  }

  private async drain(): Promise<void> {
    while (!this.disposed) {
      const version = this.requestVersion
      await this.attempt()
      if (this.disposed || version !== this.requestVersion) continue
      this.settledAt = this.deps.now()
      try {
        this.deps.onSettled?.()
      } catch (error) {
        this.deps.warn('session authority onSettled failed: '
          + (error instanceof Error ? error.message : String(error)))
      }
      if (version === this.requestVersion) break
    }
    this.running = false
  }

  private currentGeneration(expected: string): boolean {
    if (this.disposed) return false
    if (this.deps.generation() === expected) return true
    this.request()
    return false
  }

  private async attempt(): Promise<void> {
    let generation: string | undefined
    try {
      const now = this.deps.now()
      generation = this.deps.generation()
      const official = this.deps.readOfficial()
      if (this.authority.generation !== generation) {
        this.probeRecords = {}
        this.stuckSince = undefined
      }
      const tick = reduceSessionAuthority(this.authority, {
        kind: 'tick',
        now,
        generation,
        official: official.rows,
        listComplete: official.listComplete,
      }, CONFIG)
      this.authority = tick.state
      for (const effect of tick.effects) {
        if (effect.kind === 'episodeEnded') this.note(now, 'complete', effect.sessionId + ' (' + effect.cause + ')')
      }
      // The reducer retains episodes while the official list is incomplete;
      // the ladder must consume that same projection, not a second raw-row view.
      const sticky = Object.keys(this.authority.sessions).length > 0
      if (!sticky && this.stuckSince !== undefined) this.note(now, 'recovered', 'symptom gone')
      if (!sticky) this.stuckSince = undefined
      const runningSince = this.earliestRunningSince()
      const observation: LadderObservation = {
        sticky,
        symptomSinceMs: runningSince ?? now,
        progressStamp: this.progressStamp,
        stuckEvidence: this.stuckSince !== undefined,
        escalationBlocked: false,
      }
      const plan = planLadder(PROBE_LADDER, this.probeRecords, { [LADDER_KEY]: observation }, now)
      this.probeRecords = plan.records
      if (sticky && plan.actions.some(action => action.tier === 'probe')) {
        this.probes += 1
        this.note(now, 'probe')
        if (!await this.probe(generation)) return
      }
      if (this.currentGeneration(generation)) this.settledOk = this.stuckSince === undefined
    } catch (error) {
      if (generation !== undefined && !this.currentGeneration(generation)) return
      if (this.disposed) return
      this.deps.warn('session authority attempt failed: '
        + (error instanceof Error ? error.message : String(error)))
      this.stuckSince ??= this.deps.now()
      this.settledOk = false
    }
  }

  /**
   * One probe episode: an authority read, the reducer's N=2 confirmation read when it
   * asks for one, then the write-back when the denial is confirmed.
   */
  private async probe(generation: string): Promise<boolean> {
    const requested = reduceSessionAuthority(this.authority, { kind: 'readRequested' }, CONFIG)
    this.authority = requested.state
    let nextRead = requested.effects.find((effect): effect is Extract<SessionAuthorityEffect, { kind: 'probe' }> =>
      effect.kind === 'probe')
    const corrections: Extract<SessionAuthorityEffect, { kind: 'correct' }>[] = []
    let failed = false
    let confirmation = false
    while (nextRead !== undefined) {
      let read: AuthorityRead | undefined
      try {
        read = await this.deps.readAuthority()
      } catch (error) {
        this.deps.warn('session authority read failed: '
          + (error instanceof Error ? error.message : String(error)))
      }
      if (!this.currentGeneration(generation)) return false
      const reduction = reduceSessionAuthority(this.authority, {
        kind: 'authorityRead',
        now: this.deps.now(),
        ticket: nextRead.ticket,
        read: read ?? { ok: false, proof: { kind: 'none' }, rows: {} },
      }, CONFIG)
      this.authority = reduction.state
      if (read === undefined || !read.ok) {
        failed = true
        this.stuckSince ??= this.deps.now()
        this.note(this.deps.now(), 'read-failed', confirmation ? 'confirmation read' : undefined)
        break
      }
      if (reduction.unresolved === undefined || reduction.unresolved.length > 0) {
        failed = true
        this.stuckSince ??= this.deps.now()
        this.note(this.deps.now(), 'read-failed',
          reduction.unresolved === undefined
            ? 'obsolete authority read'
            : 'incomplete authority verdict: ' + reduction.unresolved.join(','))
      }
      corrections.push(...reduction.effects.filter((effect): effect is Extract<SessionAuthorityEffect, { kind: 'correct' }> =>
        effect.kind === 'correct'))
      nextRead = reduction.effects.find((effect): effect is Extract<SessionAuthorityEffect, { kind: 'probe' }> =>
        effect.kind === 'probe')
      confirmation = true
    }
    for (const correct of corrections) {
      if (!this.currentGeneration(generation)) return false
      let written = false
      try {
        written = await this.deps.correct(correct.sessionIds)
      } catch (error) {
        this.deps.warn('session authority correction failed: '
          + (error instanceof Error ? error.message : String(error)))
      }
      if (!this.currentGeneration(generation)) return false
      if (written) this.corrections += 1
      const result = reduceSessionAuthority(this.authority, {
        kind: 'correctionResult',
        now: this.deps.now(),
        ticket: correct.ticket,
        ok: written,
      }, CONFIG)
      this.authority = result.state
      // Chronology: the write settled first; its diagnostic episode end follows.
      this.note(this.deps.now(), written ? 'correct' : 'correct-failed', correct.sessionIds.join(','))
      for (const effect of result.effects) {
        if (effect.kind === 'episodeEnded') this.note(this.deps.now(), 'complete', effect.sessionId + ' (' + effect.cause + ')')
      }
      if (!written) {
        this.stuckSince ??= this.deps.now()
        failed = true
      }
    }
    if (!failed) {
      // A verdict was reached (converged, or corrected): the channel is not stuck.
      if (this.stuckSince !== undefined) this.note(this.deps.now(), 'recovered', 'authority verdict')
      this.stuckSince = undefined
      this.progressStamp += 1
    }
    return true
  }
}
