/**
 * SessionAuthorityReconciler - the I/O half of the session-fact authority.
 * POLICY (running-bit truth, N=2 confirmation, exactly-once completion edge,
 * probe cadence) lives in `@dsh-chamber/dsh-stream-state`; this file reads the
 * official store projection + generation, runs the ladder's independent
 * authority read (control-plane unary `session.list`, carrier-independent of
 * the guarded WS fact channel), feeds it back into the reducer and executes
 * its effects — one confirmation read for N=2, or the tier-3 write-back
 * ("running=false", self-verified) — and publishes the App's escalation
 * snapshot. Discipline: single flight; fail-closed (seam failures → warn +
 * stuck evidence, never a throw); write-back idempotent, only ever asks false.
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
  /** Persistence seam: called exactly once per produced action; must never break the chain. */
  readonly record?: (entry: AuthorityActionLogEntry) => void
  readonly onSettled?: () => void
}

/** The authority state published in the runtime report (consumed by the App's escalation ladder). */
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

/** Bounded evidence surface of what the authority did (travelling in the runtime report). */
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

export function isRunningNonSubagentRow(row: AuthorityOfficialRow | undefined): boolean {
  return row?.running === true && row.subagent !== true
}

/** Write-back targets: authority-denied ids still claiming running (idempotent, minimal surface). */
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
  private running = false
  private disposed = false
  private readonly actionLog: AuthorityActionLogEntry[] = []

  constructor(deps: SessionAuthorityDeps) {
    this.deps = deps
  }

  /** Request one authority tick. In flight: only `requestedAt` advances (single flight). */
  request(): void {
    if (this.disposed) return
    this.requestedAt = this.deps.now()
    if (this.running) return
    this.running = true
    void this.attempt()
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
    this.running = false
  }

/** Bounded evidence ring (16 entries); one warn line + persistence seam per act. */
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

  private async attempt(): Promise<void> {
    try {
      const now = this.deps.now()
      const official = this.deps.readOfficial()
      const tick = reduceSessionAuthority(this.authority, {
        kind: 'tick',
        now,
        generation: this.deps.generation(),
        official: official.rows,
        listComplete: official.listComplete,
      }, CONFIG)
      this.authority = tick.state
      for (const effect of tick.effects) {
        if (effect.kind === 'complete') this.note(now, 'complete', effect.sessionId + (effect.notify ? '' : ' (removed)'))
      }
      const sticky = Object.values(official.rows).some(isRunningNonSubagentRow)
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
        await this.probe()
      }
      this.settledOk = this.stuckSince === undefined
    } catch (error) {
      this.deps.warn('session authority attempt failed: '
        + (error instanceof Error ? error.message : String(error)))
      this.stuckSince ??= this.deps.now()
      this.settledOk = false
    } finally {
      this.running = false
      this.settledAt = this.deps.now()
      this.deps.onSettled?.()
    }
  }

/** One probe episode: read → N=2 confirmation read when asked → write-back when confirmed. */
  private async probe(): Promise<void> {
    const first = await this.deps.readAuthority()
    if (first === undefined || !first.ok) {
      this.stuckSince ??= this.deps.now()
      this.note(this.deps.now(), 'read-failed')
      return
    }
    let effects = this.consume(first)
    if (effects.some(effect => effect.kind === 'probe')) {
      const second = await this.deps.readAuthority()
      if (second === undefined || !second.ok) {
        this.stuckSince ??= this.deps.now()
        this.note(this.deps.now(), 'read-failed', 'confirmation read')
        return
      }
      effects = effects.concat(this.consume(second))
    }
    const correct = effects.find((effect): effect is Extract<SessionAuthorityEffect, { kind: 'correct' }> =>
      effect.kind === 'correct')
    if (correct !== undefined) {
      const written = await this.deps.correct(correct.sessionIds)
      if (written) this.corrections += 1
      const result = reduceSessionAuthority(this.authority, {
        kind: 'correctionResult',
        now: this.deps.now(),
        sessionIds: correct.sessionIds,
        ok: written,
      }, CONFIG)
      this.authority = result.state
      // Chronology: the write settled first; the completion it produced is noted after it.
      this.note(this.deps.now(), written ? 'correct' : 'correct-failed', correct.sessionIds.join(','))
      for (const effect of result.effects) {
        if (effect.kind === 'complete') this.note(this.deps.now(), 'complete', effect.sessionId)
      }
      if (!written) {
        this.stuckSince ??= this.deps.now()
        return
      }
    }
    // A verdict was reached (converged, or corrected): the channel is not stuck.
    if (this.stuckSince !== undefined) this.note(this.deps.now(), 'recovered', 'authority verdict')
    this.stuckSince = undefined
    this.progressStamp += 1
  }

  private consume(read: AuthorityRead): readonly SessionAuthorityEffect[] {
    const reduction = reduceSessionAuthority(this.authority, {
      kind: 'authorityRead',
      now: this.deps.now(),
      read,
    }, CONFIG)
    this.authority = reduction.state
    return reduction.effects
  }
}
