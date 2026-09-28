/**
 * SessionAuthorityReconciler - the I/O half of the session-fact authority.
 *
 * POLICY (running-bit truth, N=2 confirmation, exactly-once completion edge,
 * probe cadence) lives in `@dsh-chamber/dsh-stream-state`; this file reads the
 * official store projection + generation, runs the ladder's independent
 * authority read (control-plane unary `session.list`, carrier-independent of
 * the guarded WS fact channel), feeds it back into the reducer and executes
 * its effects — one confirmation read for N=2, or the tier-3 write-back
 * ("running=false", self-verified) — and publishes the App's escalation
 * snapshot. Discipline: single flight (requests received in flight coalesce
 * into one fresh attempt); fail-closed (seam failures → warn + stuck evidence,
 * never a throw); write-back idempotent, only ever asks false.
 */
import {
  LADDER_TABLES,
  classifyObservation,
  initialSessionAuthorityState,
  isAdmissible,
  planLadder,
  reduceSessionAuthority,
  sessionAuthorityProbeLadder,
  withDeadline,
  type AuthorityOfficialRow,
  type AuthorityRead,
  type LadderObservation,
  type LadderRecord,
  type Scheduler,
  type SessionAuthorityEffect,
  type SessionAuthorityState,
} from '@dsh-chamber/dsh-stream-state'
import { hadSchedulingGap } from './page-schedule.ts'
import { recordEvidence } from './evidence-log.ts'

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
  /** Budget for one authority read; expiry = degraded round (no verdict). Defaults to 5s (I-11). */
  readonly readDeadlineMs?: number
  /** Timer seam for the read budget; the I/O half defaults to the ambient scheduler. */
  readonly scheduler?: Scheduler
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

/** I-11: one authority read may not freeze the ladder (the unary client's own budget is 5s). */
const AUTHORITY_READ_DEADLINE_MS = 5_000

/** The I/O half may use ambient timers; policy stays in the pure package. */
const AMBIENT_SCHEDULER: Scheduler = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

/** The probe cadence is a property of the one table, not of this module. */
const PROBE_LADDER = sessionAuthorityProbeLadder(LADDER_TABLES.authority)

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

  /**
   * One authority read under a hard budget (I-11). The unary client already bounds its own
   * fetch; this fence also covers a seam that never settles (the official store's single-flight
   * hang is upstream's, but it must degrade this round, not freeze the ladder forever).
   */
  private async readBounded(): Promise<{ read: AuthorityRead | undefined; timedOut: boolean; skipped: boolean }> {
    const budget = this.deps.readDeadlineMs ?? AUTHORITY_READ_DEADLINE_MS
    // At most one re-issue when the deadline expired inside an unscheduled window
    // (WebKit throttling an unfocused/occluded page): that deadline is not a fact
    // about the source. Only a deadline the page was awake for is booked (design 14 §D4).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const startedAt = this.deps.now()
      const outcome = await withDeadline(this.deps.readAuthority(), {
        ms: budget,
        scheduler: this.deps.scheduler ?? AMBIENT_SCHEDULER,
        onExpire: () => undefined,
      })
      if (outcome.settled !== 'deadline') return { read: outcome.value, timedOut: false, skipped: false }
      const windowMs = this.deps.now() - startedAt
      const verdict = classifyObservation({
        outcome: 'error',
        errorName: 'TimeoutError',
        schedulingGap: hadSchedulingGap(startedAt, this.deps.now()),
      })
      if (!isAdmissible(verdict)) {
        recordEvidence('authority-read', verdict, { budgetMs: budget, windowMs, attempt }, false)
        this.deps.warn('session authority read deadline during an unscheduled window ('
          + String(budget) + 'ms) — re-reading while the page is awake')
        continue
      }
      recordEvidence('authority-read', verdict, { budgetMs: budget, windowMs, attempt }, true)
      this.deps.warn('session authority read deadline exceeded (' + String(budget) + 'ms) — no verdict this round')
      return { read: undefined, timedOut: true, skipped: false }
    }
    // Both windows were unscheduled: there is no valid observation either way, so this
    // round books neither a deadline nor a success (the ladder's own no-read path owns
    // the consequence, and the evidence ledger shows why).
    this.deps.warn('session authority read skipped: the page was not scheduled in either window')
    // `skipped` 把「两次都未调度」与「读缝自己没给出值」分开：后者仍是失败证据，前者不是判定。
    return { read: undefined, timedOut: false, skipped: true }
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
   * One probe episode: an authority read → the reducer's N=2 confirmation read when
   * it asks for one → the write-back once the denial is confirmed.
   */
  private async probe(generation: string): Promise<boolean> {
    const requested = reduceSessionAuthority(this.authority, { kind: 'readRequested' }, CONFIG)
    this.authority = requested.state
    let nextRead = requested.effects.find((effect): effect is Extract<SessionAuthorityEffect, { kind: 'probe' }> =>
      effect.kind === 'probe')
    const corrections: Extract<SessionAuthorityEffect, { kind: 'correct' }>[] = []
    let failed = false
    let skippedRound = false
    let confirmation = false
    while (nextRead !== undefined) {
      let read: AuthorityRead | undefined
      let readTimedOut = false
      let readSkipped = false
      try {
        const bounded = await this.readBounded()
        read = bounded.read
        readTimedOut = bounded.timedOut
        readSkipped = bounded.skipped
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
      if (read === undefined && readSkipped) {
        // 两次都未调度（`readBounded` 的末路）：账本已记 `booked=false`，本轮既不是失败也不是恢复
        // ——未调度的窗口不携带来源事实（design 14 §D4）。收轮但**不提前退出**：同一轮前一次读
        // 已签发的 correct 仍要结算（写回失败照旧走 correct-failed/stuckSince）——提前 return 会
        // 把 corrections 丢在循环里，reducer 的 correctionTicket 永不结算，之后每轮读都命
        // 中「ticket 未结算」分支，tier-3 写回对该会话永久静默。收轮只表示本轮到此为止：
        // 不动 stuckSince/progressStamp，也不落 read-failed（旧形态把「没有有效观测」读成
        // 「读失败」，既把误报送进权威梯子，又会让下面的 !failed 分支把真 stuck 误清成 recovered）。
        skippedRound = true
        break
      }
      if (read === undefined || !read.ok) {
        failed = true
        this.stuckSince ??= this.deps.now()
        this.note(this.deps.now(), 'read-failed',
          readTimedOut ? 'read deadline exceeded' : (confirmation ? 'confirmation read' : undefined))
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
    if (!failed && !skippedRound) {
      // A verdict was reached (converged, or corrected): the channel is not stuck.
      if (this.stuckSince !== undefined) this.note(this.deps.now(), 'recovered', 'authority verdict')
      this.stuckSince = undefined
      this.progressStamp += 1
    }
    return true
  }
}
