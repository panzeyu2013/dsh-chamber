/**
 * Session stream-health ladder (2026-12): the chamber-owned recovery arm for
 * the conversation stream that the v0.3.2-beta.3 running-bit guard could not
 * see. Pure decision half only — no React, no timers, no DOM, no ctx: the seat
 * component feeds it one observation per tick and executes the returned action.
 * `test/session-health/session-stream-health.test.ts` pins the truth table.
 *
 * THE DEFECT IT CLOSES. A rapid flurry of carrier losses while the connection
 * generation still reads ready makes the official journal stream terminal
 * (`waitForRemoteStreamRetry` throws the carrier error, `read()` wraps it as
 * `gateway/internal`), and `Session.failEventStream()` then latches
 * `openState='error'`: the published window stays on screen, nothing re-opens
 * the stream, and the only visible trace is the vendor chat view's
 * top-of-column line. The transcript looks frozen while the process keeps
 * running — reproduced headlessly with four mux socket kills 25ms apart, with
 * the exact on-screen text 「历史加载失败：api gateway: Remote stream
 * WebSocket closed（gateway/internal）」.
 *
 * THE LEVER (and its hard boundary). The public session face exposes no
 * `open()`/`resync()`, but the stage move does: `service.followCurrent()`
 * re-opens a session only when `list.current !== watched` (vendor
 * `.../client/sessions/service.ts`), and `Session.open()` re-runs `doOpen()`
 * for every state except `'open'` itself. So opening ANOTHER listed session and
 * then the target — synchronously, both in one tick — re-opens an `'error'`
 * session, and does NOTHING for an `'open'` one (its open promise is not
 * pending, but its state short-circuits) nor for a stuck `'loading'` one (its
 * `openPromise` is pending and is returned as-is). That asymmetry is why this
 * module has exactly two arms:
 *
 *  - `openState === 'error'` held past the grace ⇒ `heal` (the stage move),
 *    retried on the cooldown while the rolling budget lasts;
 *  - `openState === 'loading'` held past the stall threshold ⇒ a notice with a
 *    reload action (never an automatic reload: design 14 discipline, and the
 *    mobile tier's `session-stall.ts` ruling — an observer may offer the
 *    user the one action that works, it may not take it for them);
 *  - a ladder that is OUT of levers (no neighbor session to move the stage
 *    through, or the budget spent) ⇒ the same notice, because for that state
 *    the reload really is the only remaining recovery.
 *
 * A stream that is `'open'` but silent is deliberately NOT guessed at: without
 * an applied-cursor watermark a long tool call is indistinguishable from a
 * halted carrier, so a shape-only notice would fire on legitimate work. That
 * residual is recorded in `docs/progress/STATUS.md` together with the two
 * paths that can close it (an upstream keepalive, or the carrier-retry policy
 * patch) — never a blind timeout here.
 *
 * CLOCK DISCIPLINE (mirrors `session-liveness.ts` and the mobile stall
 * observer): every hold is "zero whenever the predicate breaks", time spent
 * with the conversation surface hidden never counts, and the whole ladder is
 * fail-closed — an observation that cannot be made produces no action.
 */

/** Official session lifecycle state (`SessionSnapshot.openState`). */
export type SessionOpenState = 'cold' | 'loading' | 'open' | 'error'

/** What the seat can surface to the user (never an action taken for them). */
export type SessionStreamNotice = 'loading-stall' | 'heal-failed' | 'carrier-churn'

/** Ladder phase held across ticks (the only state that ages). */
export type SessionStreamPhase = 'idle' | 'error-hold' | 'loading-hold' | 'healing'

/** The decision inputs — one observation per tick, nothing else is read. */
export interface SessionStreamObservation {
  /** Official `openState` of the presented session. */
  readonly openState: SessionOpenState
  /**
   * The conversation surface for this session is on screen AND the page is
   * visible. False zeroes every clock (a backgrounded page's timers are
   * suspended; an accumulated timestamp would resume stale and over-count).
   */
  readonly presented: boolean
  /**
   * Another listed session exists to carry the stage move. Without a neighbor
   * the only lever is absent, so `heal` must never be requested — the ladder
   * degrades to the notice arm instead of churning the launch path.
   */
  readonly neighborAvailable: boolean
  /**
   * Latest page-level carrier-churn fact for this source (the in-repo fork's
   * `dsh-chamber:stream-carrier-failed` event), or undefined when none arrived.
   * With the retry patch the carrier has no terminal escape left, so a
   * keep-failing mux reopens silently; this fact is the only honest "the stream
   * is being reopened" signal (design 14 §D4).
   */
  readonly carrierChurn?: { readonly at: number; readonly count: number } | undefined
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
}

/** Thresholds and budgets (tuned by the numbers in the module header). */
export interface SessionStreamHealthConfig {
  /** An `error` state must hold this long before the automatic re-open fires. */
  readonly errorGraceMs: number
  /** A `loading` state must hold this long before the reload notice appears. */
  readonly loadingStallMs: number
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
 * Defaults. The grace is short because an `error` state is not a state the
 * user can read anything new from (the window is already frozen); the loading
 * threshold sits far above the loopback/gateway p99 open latency, so it only
 * fires on a genuinely parked open.
 */
export const SESSION_STREAM_HEALTH_DEFAULTS: SessionStreamHealthConfig = {
  errorGraceMs: 8_000,
  loadingStallMs: 20_000,
  healCooldownMs: 120_000,
  healBudgetWindowMs: 600_000,
  healBudgetMax: 3,
  healSettleMs: 20_000,
  carrierChurnMs: 10_000,
}

/** What the seat must DO this tick, and what it may SHOW. */
export interface SessionStreamHealthPlan {
  readonly state: SessionStreamHealthState
  readonly action: 'none' | 'heal'
  readonly notice: SessionStreamNotice | null
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

  // Clocks only run while the surface is really on screen: anything else means
  // "we cannot know", and the fail-closed answer to that is idle. The EVENT
  // LEDGER survives the hidden stretch on purpose (2026-12 review): the cooldown
  // and the rolling budget are this module's only storm bound, and hide-to-tray
  // is a first-class flow here — resetting them would hand the user a fresh
  // budget of stage moves per visibility toggle, each of which materializes
  // another session window.
  if (!observation.presented) {
    return {
      state: { phase: 'idle', since: 0, healStamps, ...(state.lastHealAt === undefined ? {} : { lastHealAt: state.lastHealAt }) },
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

    // A wall clock that jumped BACKWARDS (NTP step, VM resume, manual change)
    // must never latch 'healing' forever with no notice and no retry: a negative
    // delta counts as settled, which sends the ladder back to the hold where the
    // cooldown decides the next attempt. Same rule for the cooldown below.
    const sinceHeal = state.lastHealAt === undefined ? undefined : now - state.lastHealAt

    if (phase === 'healing') {
      const judging = sinceHeal !== undefined && sinceHeal >= 0 && sinceHeal < config.healSettleMs
      if (judging) {
        return { state: { ...state, phase, since, healStamps }, action: 'none', notice: null }
      }
      // Judge it: the repair did not take. Fall back to the hold so the cooldown
      // (or the exhausted budget, below) decides what happens next — a single
      // failed heal never latches a notice while an automatic retry is pending.
      phase = 'error-hold'
      since = now
      held = 0
    }

    const cooling = sinceHeal !== undefined && sinceHeal >= 0 && sinceHeal < config.healCooldownMs
    const inBudget = healStamps.length < config.healBudgetMax
    if (held >= config.errorGraceMs && !cooling && inBudget && observation.neighborAvailable) {
      // The seat executes the heal and marks it; 'since' restarts at execution.
      return {
        state: { phase: 'healing', since: now, healStamps, ...(state.lastHealAt === undefined ? {} : { lastHealAt: state.lastHealAt }) },
        action: 'heal',
        notice: null,
      }
    }

    // No usable lever (no neighbor, budget spent, or cooling): say so once the
    // hold has clearly outlived a repair attempt — never on the first frames,
    // where an in-flight open can still resolve the state on its own.
    const hopeless = held >= config.errorGraceMs + config.healSettleMs && (!observation.neighborAvailable || !inBudget)
    return { state: { phase, since, healStamps, ...(state.lastHealAt === undefined ? {} : { lastHealAt: state.lastHealAt }) }, action: 'none', notice: hopeless ? 'heal-failed' : null }
  }

  if (observation.openState === 'loading') {
    const continued = state.phase === 'loading-hold'
    const since = continued ? state.since : now
    const stalled = now - since >= config.loadingStallMs
    return {
      state: { phase: 'loading-hold', since, healStamps, ...(state.lastHealAt === undefined ? {} : { lastHealAt: state.lastHealAt }) },
      action: 'none',
      notice: stalled ? 'loading-stall' : null,
    }
  }

  // 'open' / 'cold': the stream is alive (or never asked for a window): clear
  // every clock and the notice. The heal budget survives recovery so a flapping
  // source cannot be healed once per recovery forever.
  //
  // chamber (design 14 §D4): 'open' is no longer proof that events flow — the
  // gateway fork paces carrier failures instead of failing terminally, so a
  // recent churn fact is the user's only signal that the stream is reopening.
  const churn = observation.carrierChurn
  const churning = churn !== undefined && churn.count > 0 && now - churn.at <= config.carrierChurnMs
  return {
    state: { phase: 'idle', since: 0, healStamps, ...(state.lastHealAt === undefined ? {} : { lastHealAt: state.lastHealAt }) },
    action: 'none',
    notice: churning ? 'carrier-churn' : null,
  }
}

/**
 * Account one EXECUTED heal: stamps it and moves the settle clock, so the same
 * session cannot be healed again inside {@link SessionStreamHealthConfig.healCooldownMs}.
 * @param state - state from the plan that requested the heal.
 * @param now - execution time (epoch ms).
 * @returns the next state (the caller stores it in its ref).
 */
export function markSessionStreamHeal(state: SessionStreamHealthState, now: number): SessionStreamHealthState {
  return { phase: 'healing', since: now, healStamps: [...state.healStamps, now], lastHealAt: now }
}

/** The notice's own label key (the seat's single copy lookup). */
export function sessionStreamNoticeKey(notice: SessionStreamNotice):
  | 'streamHealth.loadingStall'
  | 'streamHealth.healFailed'
  | 'streamHealth.carrierChurn' {
  if (notice === 'loading-stall') return 'streamHealth.loadingStall'
  return notice === 'carrier-churn' ? 'streamHealth.carrierChurn' : 'streamHealth.healFailed'
}
