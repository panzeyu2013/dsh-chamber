/**
 * Session stream-health ladder: the chamber-owned recovery arm for the
 * conversation stream that the official running-bit guard cannot see (a rapid
 * carrier-loss flurry can latch the journal stream in `openState === 'error'`
 * with the transcript frozen). Pure decision half — no React, no timers, no
 * DOM, no ctx: the seat feeds it one observation per tick and executes the
 * returned action; an unusable observation yields no action (fail-closed).
 *
 * LEVERS (`ISession` exposes neither): the stage move (`followCurrent()` re-opens
 * only when `list.current !== watched`; `open()` re-runs `doOpen()` for every
 * state but `'open'`) heals an `'error'` session in one tick but is a no-op for
 * `'open'` and for a stuck `'loading'` whose `openPromise` is pending; concrete
 * `Session.resync()` (dispose + `open()`) covers that, via a guarded slice. A
 * silent `'open'` stream is deliberately not guessed at — no applied-cursor
 * watermark, and a timer would be a blind timeout, not a decision.
 */

import { LADDER_TABLES, planLadder, streamHealthLadder } from '@dsh-chamber/dsh-stream-state'

/** Official session lifecycle state (`SessionSnapshot.openState`). */
export type SessionOpenState = 'cold' | 'loading' | 'open' | 'error'

/** What the seat can surface to the user (never an action taken for them). */
export type SessionStreamNotice = 'loading-stall' | 'loading-failed' | 'heal-failed' | 'carrier-churn'

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
   * Another listed session exists to carry the stage move. Without one `heal` is
   * never requested — the ladder degrades to the notice arm.
   */
  readonly neighborAvailable: boolean
  /**
   * The build exposes the concrete `Session.resync()` (not on `ISession`), read
   * through the probe's guarded capability check: a missing or drifting face
   * yields false, so no control is armed for a lever that cannot be seen.
   */
  readonly resyncAvailable?: boolean | undefined
  /**
   * Latest page-level carrier-churn fact for this source, or undefined. With the
   * retry patch the carrier has no terminal escape left, so a keep-failing mux
   * reopens silently and this is the only honest "stream is being reopened" signal.
   */
  readonly carrierChurn?: { readonly at: number; readonly count: number } | undefined
  /**
   * Whether the official open is STILL IN FLIGHT: the concrete `openPromise`
   * read by the probe — `true` pending, `false` when `loading` with nothing
   * pending, `undefined` when the face cannot say. Only `false` unlocks the
   * automatic rebuild; `undefined` fails closed like a missing capability.
   */
  readonly openInFlight?: boolean | undefined
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
  /** How long a carrier-churn fact keeps the "reconnecting" notice visible. */
  readonly carrierChurnMs: number
}

/**
 * The shipped defaults: the single table (`LADDER_TABLES.streamHealth`), never
 * literals here. The grace is short because an `error` state shows the user
 * nothing new — the window is already frozen.
 */
export const SESSION_STREAM_HEALTH_DEFAULTS: SessionStreamHealthConfig = LADDER_TABLES.streamHealth

/**
 * What the plan asks of the seat this tick. `'heal'` (stage move) and
 * `'auto-resync'` (per-session rebuild) are executed IMMEDIATELY and accounted
 * against the session's ledger; `'resync'` only ARMS the user control — its sole
 * invocation is the click, which the ledger does not gate (the ledger bounds the
 * AUTOMATIC arm; a human click is its own bound).
 */
export type SessionStreamHealthAction = 'none' | 'heal' | 'resync' | 'auto-resync'

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
  const record = { symptomSinceMs, progressStamp: 0, dispatches: { heal: history, 'auto-resync': history } }
  const observation = { sticky: true, symptomSinceMs, progressStamp: 0, stuckEvidence: false, escalationBlocked }
  return planLadder(streamHealthLadder(config), { session: record }, { session: observation }, now)
}

/**
 * True while this session's lever ledger permits an attempt: not inside the
 * cooldown after the last EXECUTED lever, and not past the rolling budget. Both
 * the automatic heal and the user-armed resync spend it, so this is the one
 * place the storm bound is evaluated for a SESSION rather than per arm — the plan
 * calls it before arming the resync control, the seat on the click.
 */
export function sessionStreamLeversAvailable(
  state: SessionStreamHealthState,
  now: number,
  config: SessionStreamHealthConfig = SESSION_STREAM_HEALTH_DEFAULTS,
): boolean {
  // Back-dating the symptom to the grace makes the first tier due, so the
  // answer is the ledger alone (the cooldown and the rolling budget).
  return planHealthEngine(state, now, config, now - config.errorGraceMs, false).actions.length > 0
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
    // silently drop the button exactly then. `sinceHeal >= healSettleMs` while
    // still in `error` proves the executed heal did not settle; recovery marks
    // the episode (`recoveredSinceHeal`) so a fresh error cannot inherit this
    // clock, and a negative delta (clock step) must NOT latch.
    if (state.recoveredSinceHeal !== true
        && sinceHeal !== undefined && sinceHeal >= config.healSettleMs) latched = true

    // One engine call answers grace + cooldown + budget + executability; its `exhausted` is what the notice projection reads.
    const engine = planHealthEngine(state, now, config, since, !observation.neighborAvailable)
    const inBudget = engine.exhausted.length === 0
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

    // The stage move needs a CURRENT, LISTED target plus another listed session
    // to carry the detour. A target it must refuse (an address-only subagent
    // selection) still has the per-session resync, so ARM that user control
    // instead of degrading to a bare reload. NOT ledger-gated, symmetric with the
    // loading arm: the ledger bounds the AUTOMATIC arms, and gating the visible
    // control on a spent budget would remove the only exit that keeps the page.
    // `resyncAvailable` still gates it.
    const resyncArmed = held >= config.errorGraceMs
      && observation.resyncAvailable === true

    // No usable lever (no neighbor, no resync face, budget spent or cooling):
    // report once the hold has outlived a repair attempt, never on the first frames.
    const hopeless = held >= config.errorGraceMs + config.healSettleMs
      && observation.resyncAvailable !== true
      && (!inBudget || !observation.neighborAvailable)
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
      action: resyncArmed ? 'resync' : 'none',
      // The chip renders its action row only when a notice is present, so an
      // armed-but-silent resync would never be clickable and the reload fallback
      // would never appear — hence the same notice as the exhausted-levers path.
      notice: latched || hopeless || resyncArmed ? 'heal-failed' : null,
    }
  }

  if (observation.openState === 'loading') {
    const continued = state.phase === 'loading-hold'
    const since = continued ? state.since : now
    const stalled = now - since >= config.loadingStallMs
    // The re-open's loading dwell must not take back an action the user was already offered (same rule as `markSessionStreamHeal`); the latch rides along.
    const latched = state.healFailedLatched === true
    const levers = sessionStreamLeversAvailable(state, now, config)
    // The AUTOMATIC arm needs BOTH the concrete capability and POSITIVE evidence
    // that no open is in flight — `undefined` (face cannot say) and `true` (open
    // awaited) both fail closed, so a slow-but-working Host is never interrupted;
    // the same ledger as the stage move bounds the retries.
    const auto = stalled && observation.resyncAvailable === true
      && observation.openInFlight === false && levers
    // The user's control: offered while the stall holds and the concrete face
    // exists. NOT ledger-gated (see the action type) — a human click must remain
    // possible even after the automatic budget is spent.
    const armed = stalled && !auto && observation.resyncAvailable === true
    return {
      state: {
        phase: 'loading-hold',
        since,
        healStamps,
        ...(state.lastHealAt === undefined ? {} : { lastHealAt: state.lastHealAt }),
        ...(latched ? { healFailedLatched: true } : {}),
        ...(state.recoveredSinceHeal === undefined ? {} : { recoveredSinceHeal: state.recoveredSinceHeal }),
      },
      action: auto ? 'auto-resync' : armed ? 'resync' : 'none',
      // A dwell that outlived every recovery attempt reads as a FAILURE, not as a
      // load in progress. A latched 'heal-failed' still wins before the threshold.
      notice: stalled
        ? (now - since >= config.loadingFailedMs ? 'loading-failed' : 'loading-stall')
        : (latched ? 'heal-failed' : null),
    }
  }

  // 'open'/'cold': the stream is alive (or never asked for a window) — clear
  // every clock and the notice. The heal budget survives recovery so a flapping
  // source cannot be healed once per recovery forever. 'open' is NOT proof that
  // events flow: with the fork pacing carrier failures, a recent churn fact is
  // the user's only signal that the stream is reopening.
  const churn = observation.carrierChurn
  const churning = churn !== undefined && churn.count > 0 && now - churn.at <= config.carrierChurnMs
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
    notice: churning ? 'carrier-churn' : null,
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
  | 'streamHealth.carrierChurn'

const SESSION_STREAM_NOTICE_KEYS: Record<SessionStreamNotice, SessionStreamNoticeKey> = {
  'loading-stall': 'streamHealth.loadingStall',
  'loading-failed': 'streamHealth.loadingFailed',
  'heal-failed': 'streamHealth.healFailed',
  'carrier-churn': 'streamHealth.carrierChurn',
}

export function sessionStreamNoticeKey(notice: SessionStreamNotice): SessionStreamNoticeKey {
  // Total BY TYPE: a future notice member cannot build the Record above without
  // a build failure, so it can never silently render as 'heal-failed'.
  return SESSION_STREAM_NOTICE_KEYS[notice]
}
