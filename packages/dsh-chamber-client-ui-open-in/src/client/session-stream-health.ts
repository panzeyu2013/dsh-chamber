/**
 * Session stream-health ladder: the chamber-owned recovery arm for the
 * conversation stream that the official running-bit guard cannot see (a rapid
 * carrier-loss flurry can latch the journal stream in `openState === 'error'`
 * with the transcript frozen). Pure decision half — no React, no timers, no
 * DOM, no ctx: the seat feeds it one observation per tick and executes the
 * returned action; an unusable observation yields no action (fail-closed).
 *
 * THE DEFECT IT CLOSES. A rapid flurry of carrier losses while the connection
 * generation still reads ready makes the official journal stream terminal
 * (`waitForRemoteStreamRetry` throws the carrier error, `read()` wraps it as
 * `gateway/internal`), and `Session.failEventStream()` then latches
 * `openState='error'`: the published window stays on screen, nothing re-opens
 * the stream, and the only visible trace is the vendor chat view's
 * top-of-column line. The transcript looks frozen while the process keeps
 * running.
 *
 * THE LEVERS (and their hard boundaries). The `ISession` CONTRACT exposes no
 * `open()`/`resync()`, but the rc.2 client opens a session in two ways, neither
 * of them contract-visible:
 *
 *  - `ISessions.retain(target, { source })` presents a session by attaching that
 *    generation's shared `Session.open()` attempt
 *    (`reference.attachOpening(...)`, vendor `.../client/sessions/service.ts`),
 *    and `Session.open()` re-runs `doOpen()` for every state except `'open'`
 *    itself. This is the view-owner path: the official ui-workspace service
 *    retains the presented target with source `'mainView'` and releases the
 *    reference it replaced, which is why the probe reads "on stage" from the
 *    row's `retainedBy.mainView` count instead of a chamber-side `current`
 *    mirror.
 *  - the concrete per-session `Session.resync()`: dispose the current event
 *    stream and `open()` again — the re-subscribe an `'error'` session and a
 *    parked `'loading'` open both need, and the lever this ladder executes.
 *    It is NOT on the contract, so the probe reaches it through a guarded
 *    structural slice (`session-stream-health-probe.ts`).
 *
 * A target the official main view does not retain has no lever here: the page's
 * bounded delivery resync owns that shape (the `healRoute` evidence).
 *
 *  - The renderer's page-level recovery owner performs any evidence-gated
 *    automatic rebuild and escalates through its own bounded tiers (resync →
 *    instance reboot → document reload); the host's opening machine owns the
 *    hanging-opening verdict. This header policy only REPORTS.
 *
 * That asymmetry is why this header policy has ONE action (the automatic heal):
 *
 *  - `openState === 'error'` held past the grace ⇒ `heal` (the automatic
 *    per-session resync), retried on the cooldown while the rolling budget
 *    lasts;
 *  - a heal judged failed (grace + settle) ⇒ the reload notice **latches**
 *    while the retries continue: waiting out the whole rolling budget (~296 s)
 *    would hide the one action that works, and the chip would show
 *    "recovering…" over a repair that has already been judged. The judgment is
 *    taken from the **settle clock**
 *    (`lastHealAt + healSettleMs`), not from the 'healing' phase: the re-open
 *    itself reports `loading` synchronously (vendor `doOpen()`) and a hidden
 *    stretch zeroes the phase, so a phase-gated latch would miss the notice in
 *    the common interleavings; the latch then rides through loading dwells and is
 *    cleared only by recovery (which also ends the episode: the next error gets
 *    its own grace instead of inheriting this heal's settle clock);
 *  - `openState === 'loading'` held past the stall threshold ⇒ the
 *    'loading-stall' notice, then 'loading-failed': visibility only. The manual
 *    rebuild/reload controls were retired (user ruling): upstream has no such
 *    control and every recovery is automatic (the host's opening machine; the
 *    page's bounded tiers; the error arm's heal below);
 *  - the SAME loading notice lands the moment the stream-forensics evidence
 *    says this opening is terminal (`openingFailure`): the fact proves the
 *    opening died, so no page timer may decide when it is shown. It only
 *    REPORTS: an evidence-proven dead opening is still never re-issued
 *    automatically;
 *  - a ladder that is OUT of levers (no concrete resync face, or the budget
 *    spent) ⇒ the same notice, so the state is named even though this header
 *    has no action to offer.
 *
 * A stream that is `'open'` but silent is deliberately NOT guessed at: without
 * an applied-cursor watermark a long tool call is indistinguishable from a
 * halted carrier, so a shape-only notice would fire on legitimate work. The
 * loading/error notices are deliberately scoped out of that arm for the same reason:
 * this module has no observable "no progress" signal to condition it on, and a
 * timer here would be a blind timeout, not a decision. That residual is
 * recorded in `docs/progress/STATUS.md` together with the two paths that can
 * close it (an upstream keepalive, or the carrier-retry policy patch) — never a
 * blind timeout here.
 *
 * CLOCK DISCIPLINE (mirrors the authority ladder and the mobile stall
 * observer): every hold is "zero whenever the predicate breaks" and the whole
 * ladder is fail-closed — an observation that cannot be made produces no
 * action. A hidden surface produces no notice and no heal, and its hold does
 * not accumulate; the settle clock is the deliberate exception, because it
 * measures an EXECUTED heal against wall time — a repair that failed while the
 * surface was hidden is announced by the first visible `error` tick (callers
 * must not read "hidden never counts" as "hidden time never decides").
 *
 * The seat executes the plan's single action (`heal`); nothing here is
 * user-triggered.
 */

import { LADDER_TABLES, planLadder, streamHealthLadder } from '@dsh-chamber/dsh-stream-state'
import type { SessionOpeningFailure } from './session-stream-health-probe.ts'

/** Official session lifecycle state (`SessionSnapshot.openState`). */
export type SessionOpenState = 'cold' | 'loading' | 'open' | 'error'

/** What the seat can surface to the user (never an action taken for them). */
export type SessionStreamNotice = 'loading-stall' | 'loading-failed' | 'heal-failed'

/** Ladder phase held across ticks (the only state that ages). */
export type SessionStreamPhase = 'idle' | 'error-hold' | 'loading-hold' | 'healing'

/** The decision inputs — one observation per tick, nothing else is read. */
export interface SessionStreamObservation {
  /** Official `openState` of the presented session. */
  readonly openState: SessionOpenState
  /**
   * On screen AND page visible. False zeroes every clock: backgrounded timers
   * are suspended and an accumulated timestamp would resume stale and over-count.
   */
  readonly presented: boolean
  /**
   * The target is the currently PRESENTED session (the official main view
   * retains it), so the header owns its automatic error heal. Without that
   * positive fact `heal` is never requested — the page's bounded resync owns
   * the error instead.
   */
  readonly healRoute: boolean
  /**
   * The build exposes the concrete `Session.resync()` (not on `ISession`), read
   * through the probe's guarded capability check: a missing or drifting face
   * yields false, so the automatic engine is blocked for a lever that cannot be seen.
   */
  readonly resyncAvailable?: boolean | undefined
  /**
   * Terminal opening evidence for the PRESENTED session, read from the page
   * stream-forensics ledger. PRESENCE is the whole fact: the fork already judged
   * this opening dead, so the loading arm shows the failure notice NOW and only
   * arms the user's rebuild control — the automatic arm is not for this state.
   */
  readonly openingFailure?: SessionOpeningFailure | undefined
}

/** Rolling state the seat keeps in a ref and hands back on the next tick. */
export interface SessionStreamHealthState {
  readonly phase: SessionStreamPhase
  /** Epoch ms the current phase began (0 while idle). */
  readonly since: number
  /** Executed heals inside the budget window, oldest first. */
  readonly healStamps: readonly number[]
  /** Epoch ms of the last EXECUTED heal (repair-settle clock). */
  readonly lastHealAt?: number
  /**
   * A heal was executed AND judged failed without settling the error: the notice
   * carries the reload action while automatic retries keep running. Cleared ONLY
   * by an observed recovery (`open`/`cold`) — a `loading` dwell deliberately
   * retains the latch, because the re-open reports `loading` synchronously and a
   * hidden stretch zeroes the phase.
   */
  readonly healFailedLatched?: boolean
  /**
   * The stream was observed `open`/`cold` after the heal `lastHealAt` points at.
   * That anchor deliberately survives recovery (a flapping source must not reset
   * the cooldown), so this marker stops the latch from reading the old settle
   * clock as this episode's failure.
   */
  readonly recoveredSinceHeal?: boolean
}

/** Thresholds and budgets; the shipped set is the single shared table. */
export interface SessionStreamHealthConfig {
  /** An `error` state must hold this long before the automatic re-open fires. */
  readonly errorGraceMs: number
  /** A `loading` state must hold this long before the reload notice appears. */
  readonly loadingStallMs: number
  /**
   * A `loading` dwell past this bound is announced as a FAILURE ("content not
   * loaded"), never as an ongoing load: the user must not read an eternal
   * spinner, while the recovery levers keep running underneath.
   */
  readonly loadingFailedMs: number
  /** Quiet period after an executed heal before another one may fire. */
  readonly healCooldownMs: number
  /** Rolling window for {@link SessionStreamHealthConfig.healBudgetMax}. */
  readonly healBudgetWindowMs: number
  /** Heals allowed per session within the window (storm bound). */
  readonly healBudgetMax: number
  /** How long a heal is given to change the state before it counts as failed. */
  readonly healSettleMs: number
}

/**
 * The shipped defaults: the single table (`LADDER_TABLES.streamHealth`), never
 * literals here. The grace is short because an `error` state shows the user
 * nothing new — the window is already frozen.
 */
export const SESSION_STREAM_HEALTH_DEFAULTS: SessionStreamHealthConfig = LADDER_TABLES.streamHealth

/**
 * What the plan asks of the seat this tick. `'heal'` (the automatic
 * per-session resync) is executed by the seat and accounted against the ledger;
 * `'none'` means the plan only reports a notice. There is deliberately no
 * user-triggered action: upstream has no such control, and every escalation
 * (host opening machine, page-level tiers) is automatic.
 */
export type SessionStreamHealthAction = 'none' | 'heal'

/** What the seat must DO this tick, and what it may SHOW. */
export interface SessionStreamHealthPlan {
  readonly state: SessionStreamHealthState
  readonly action: SessionStreamHealthAction
  readonly notice: SessionStreamNotice | null
}

/** One engine tick: the session's executed levers ARE the record's dispatch
 *  history, and the engine owns grace + cooldown + budget + evidence. */
function planHealthEngine(
  state: SessionStreamHealthState,
  now: number,
  config: SessionStreamHealthConfig,
  symptomSinceMs: number,
  escalationBlocked: boolean,
) {
  // The engine reads the cooldown anchor from the history tail and the budget
  // from every entry inside the window. A backwards clock leaves stamps in the
  // future: they still spend budget, so a window-edge sentinel rides the tail.
  const stamps = state.healStamps
  const anchor = state.lastHealAt !== undefined && state.lastHealAt <= now ? state.lastHealAt : undefined
  const tail = anchor ?? (stamps.length === 0 ? undefined : now - Math.max(config.healBudgetWindowMs, config.healCooldownMs))
  const history = anchor === undefined
    ? (tail === undefined ? [] : [...stamps, tail])
    : [...stamps.filter(stamp => stamp !== anchor), anchor]
  const record = { symptomSinceMs, progressStamp: 0, dispatches: { heal: history } }
  const observation = { sticky: true, symptomSinceMs, progressStamp: 0, stuckEvidence: false, escalationBlocked }
  return planLadder(streamHealthLadder(config), { session: record }, { session: observation }, now)
}

/** A state that holds nothing (used for the initial value and after recovery). */
export function createSessionStreamHealthState(): SessionStreamHealthState {
  return { phase: 'idle', since: 0, healStamps: [] }
}

/** One tick of the ladder: pure, total, and safe to call with any observation. */
export function planSessionStreamHealth(
  state: SessionStreamHealthState,
  observation: SessionStreamObservation,
  now: number,
  config: SessionStreamHealthConfig = SESSION_STREAM_HEALTH_DEFAULTS,
): SessionStreamHealthPlan {
  // The budget window is pruned on every step, presented or not (the ledger is
  // what it is regardless of what the user is looking at).
  const healStamps = state.healStamps.filter(stamp => now - stamp < config.healBudgetWindowMs)

  // Clocks run only while the surface is really on screen: anything else is "we
  // cannot know", and the fail-closed answer is idle. The EVENT LEDGER survives
  // the hidden stretch on purpose: the cooldown and rolling budget are the only
  // storm bound, and hide-to-tray must not hand the user a fresh budget of stage
  // moves per visibility toggle.
  if (!observation.presented) {
    return {
      state: {
        phase: 'idle',
        since: 0,
        healStamps,
        ...(state.lastHealAt === undefined ? {} : { lastHealAt: state.lastHealAt }),
        ...(state.healFailedLatched === undefined ? {} : { healFailedLatched: state.healFailedLatched }),
        ...(state.recoveredSinceHeal === undefined ? {} : { recoveredSinceHeal: state.recoveredSinceHeal }),
      },
      action: 'none',
      notice: null,
    }
  }

  if (observation.openState === 'error') {
    // Keep the hold across ticks; a heal already in its settle window stays in
    // 'healing' so the failure notice cannot appear before the repair is judged.
    const continued = state.phase === 'error-hold' || state.phase === 'healing'
    let phase: SessionStreamPhase = continued ? state.phase : 'error-hold'
    let since = continued ? state.since : now
    let held = now - since
    // Once a heal has been judged failed, the notice carrying the
    // ONE action that works stays up while the automatic retries continue.
    let latched = state.healFailedLatched === true

    // A wall clock that jumped BACKWARDS (NTP step, VM resume) must never latch
    // 'healing' forever with no notice and no retry: a negative delta counts as
    // settled and returns the ladder to the hold where the cooldown decides.
    const sinceHeal = state.lastHealAt === undefined ? undefined : now - state.lastHealAt

    if (phase === 'healing') {
      const judging = sinceHeal !== undefined && sinceHeal >= 0 && sinceHeal < config.healSettleMs
      if (judging) {
        return {
          state: { ...state, phase, since, healStamps, ...(latched ? { healFailedLatched: true } : {}) },
          action: 'none',
          notice: latched ? 'heal-failed' : null,
        }
      }
      // The repair did not take: fall back to the hold so the cooldown (or the exhausted budget) paces the next attempt.
      phase = 'error-hold'
      since = now
      held = 0
    }

    // The judgment hangs off the SETTLE CLOCK, not the 'healing' phase: vendor
    // `doOpen()` writes `openState = 'loading'` SYNCHRONOUSLY before its first
    // await, so a loading observation (or a hidden stretch, which zeroes the
    // phase) routinely interrupts the error hold — a phase-gated latch would
    // silently drop the notice exactly then. `sinceHeal >= healSettleMs` while
    // still in `error` proves the executed heal did not settle; recovery marks
    // the episode (`recoveredSinceHeal`) so a fresh error cannot inherit this
    // clock, and a negative delta (clock step) must NOT latch.
    if (state.recoveredSinceHeal !== true
        && sinceHeal !== undefined && sinceHeal >= config.healSettleMs) latched = true

    // One engine call answers grace + cooldown + budget + executability; its `exhausted` is what the notice projection reads.
    // The automatic heal executes the concrete resync, so BOTH the presented target
    // (`healRoute`) and the reachable face (`resyncAvailable`) are prerequisites;
    // without them the tier is blocked and the page's delivery resync owns the error.
    const engine = planHealthEngine(
      state, now, config, since,
      !observation.healRoute || observation.resyncAvailable !== true,
    )
    if (engine.actions.some(action => action.tier === 'heal')) {
      // The seat executes the heal and marks it; 'since' restarts at execution.
      return {
        state: {
          phase: 'healing',
          since: now,
          healStamps,
          ...(state.lastHealAt === undefined ? {} : { lastHealAt: state.lastHealAt }),
          ...(latched ? { healFailedLatched: true } : {}),
        },
        action: 'heal',
        notice: latched ? 'heal-failed' : null,
      }
    }

    // The automatic arm is exhausted or cooling here. No manual lever replaces
    // it (user ruling): the page's own bounded ladder escalates (resync →
    // instance reboot → document reload) while this notice reports the state.
    // The arm threshold still times the notice exactly as it did when it also
    // opened the control; only the control is gone.
    const armReached = held >= config.errorGraceMs
      && observation.resyncAvailable === true
    const hopeless = held >= config.errorGraceMs + config.healSettleMs
      && observation.resyncAvailable !== true
    return {
      state: {
        phase,
        since,
        healStamps,
        ...(state.lastHealAt === undefined ? {} : { lastHealAt: state.lastHealAt }),
        ...(latched ? { healFailedLatched: true } : {}),
        // Carry the episode marker: the gate above read it, and dropping it here
        // would let the NEXT error tick falsely latch off the previous episode's
        // settle clock. `markSessionStreamHeal` clears it when a fresh heal runs.
        ...(state.recoveredSinceHeal === undefined ? {} : { recoveredSinceHeal: state.recoveredSinceHeal }),
      },
      action: 'none',
      // The latch, the no-lever state and the reached arm threshold all report;
      // only an arm still inside its grace stays silent (the ladder retries it).
      notice: latched || hopeless || armReached ? 'heal-failed' : null,
    }
  }

  if (observation.openState === 'loading') {
    const continued = state.phase === 'loading-hold'
    const since = continued ? state.since : now
    // Evidence first: a terminal opening outcome is a failure the moment it is
    // observed, never after a page timer. It does not restart the hold, so the
    // timer thresholds keep ageing underneath if the evidence is retired.
    const failed = observation.openingFailure !== undefined
    const stalled = failed || now - since >= config.loadingStallMs
    // The re-open's loading dwell must not take back an action the user was already offered (same rule as `markSessionStreamHeal`); the latch rides along.
    const latched = state.healFailedLatched === true
    // The host's opening machine and the page's own bounded ladder own every
    // loading rebuild; this plan only reports the dwell (and the terminal fact).
    return {
      state: {
        phase: 'loading-hold',
        since,
        healStamps,
        ...(state.lastHealAt === undefined ? {} : { lastHealAt: state.lastHealAt }),
        ...(latched ? { healFailedLatched: true } : {}),
        ...(state.recoveredSinceHeal === undefined ? {} : { recoveredSinceHeal: state.recoveredSinceHeal }),
      },
      action: 'none',
      // A proven-dead opening reads as a FAILURE immediately; otherwise a dwell
      // that outlived every recovery attempt does. A latched 'heal-failed' still
      // wins before the threshold.
      notice: failed
        ? 'loading-failed'
        : stalled
          ? (now - since >= config.loadingFailedMs ? 'loading-failed' : 'loading-stall')
          : (latched ? 'heal-failed' : null),
    }
  }

  // 'open'/'cold': the stream is alive (or never asked for a window) — clear
  // every clock and the notice. The heal budget survives recovery so a flapping
  // source cannot be healed once per recovery forever. 'open' is NOT proof that
  // events flow, but with the retry patch pacing carrier failures the reopening
  // is silent by design (the reconnecting notice was retired).
  return {
    state: {
      phase: 'idle',
      since: 0,
      healStamps,
      // The cooldown anchor survives recovery (the flapping bound), but the
      // EPISODE does not: a fresh error must not inherit this heal's settle clock.
      ...(state.lastHealAt === undefined
        ? {}
        : { lastHealAt: state.lastHealAt, recoveredSinceHeal: true }),
    },
    action: 'none',
    notice: null,
  }
}

/**
 * Account one EXECUTED lever — the automatic stage move or the user-clicked
 * resync: stamp it and move the settle clock, so the same session cannot spend
 * the ledger again inside {@link SessionStreamHealthConfig.healCooldownMs}.
 */
export function markSessionStreamHeal(state: SessionStreamHealthState, now: number): SessionStreamHealthState {
  return {
    phase: 'healing',
    since: now,
    healStamps: [...state.healStamps, now],
    lastHealAt: now,
    // The latch is a user-visible contract, not a phase: a retry in flight must not hide the action the user was already offered.
    ...(state.healFailedLatched === undefined ? {} : { healFailedLatched: state.healFailedLatched }),
  }
}

/** The notice's own label key (the seat's single copy lookup). */
type SessionStreamNoticeKey =
  | 'streamHealth.loadingStall'
  | 'streamHealth.loadingFailed'
  | 'streamHealth.healFailed'

const SESSION_STREAM_NOTICE_KEYS: Record<SessionStreamNotice, SessionStreamNoticeKey> = {
  'loading-stall': 'streamHealth.loadingStall',
  'loading-failed': 'streamHealth.loadingFailed',
  'heal-failed': 'streamHealth.healFailed',
}

export function sessionStreamNoticeKey(notice: SessionStreamNotice): SessionStreamNoticeKey {
  // Total BY TYPE: a future notice member cannot build the Record above without
  // a build failure, so it can never silently render as 'heal-failed'.
  return SESSION_STREAM_NOTICE_KEYS[notice]
}
