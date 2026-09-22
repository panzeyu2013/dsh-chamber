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
 * THE LEVERS (and their hard boundaries). The `ISession` CONTRACT exposes no
 * `open()`/`resync()`, but two concrete levers exist:
 *
 *  - the stage move: `service.followCurrent()` re-opens a session only when
 *    `list.current !== watched` (vendor `.../client/sessions/service.ts`), and
 *    `Session.open()` re-runs `doOpen()` for every state except `'open'`
 *    itself. So opening ANOTHER listed session and then the target —
 *    synchronously, both in one tick — re-opens an `'error'` session, and does
 *    NOTHING for an `'open'` one (its open promise is not pending, but its
 *    state short-circuits) nor for a stuck `'loading'` one (its `openPromise`
 *    is pending and is returned as-is);
 *  - the concrete per-session `Session.resync()` (2026-12): dispose the current
 *    event stream and `open()` again — exactly the re-subscribe a parked
 *    `'loading'` open needs, and the one thing the stage move cannot do for it.
 *    It is NOT on the contract, so the probe reaches it through a guarded
 *    structural slice (`session-stream-health-probe.ts`).
 *
 *  - the SAME per-session rebuild also has an EVIDENCE-GATED AUTOMATIC arm
 *    (2026-09-21, user ruling "entering a session must converge, never a silent
 *    spinner"): when the concrete face reports NO OPEN IN FLIGHT (`openPromise`
 *    null while `openState === 'loading'`), nothing is being waited on — and the
 *    pinned `doOpen()` can settle there with NO retry trigger at all (its
 *    generation moved mid-open, or it rethrew a non-RemoteFailure, while
 *    `followCurrent()` re-opens only on a stage move). Re-issuing is then the
 *    only cure AND it interrupts nothing, so the ladder may request it itself,
 *    bounded by the same per-session ledger. While an open IS in flight nothing
 *    automatic touches it (a genuinely slow Host keeps its widened budget); the
 *    user's control stays offered either way, because a human click is not the
 *    storm the ledger exists to bound.
 *
 * That asymmetry is why this module has three arms:
 *
 *  - `openState === 'error'` held past the grace ⇒ `heal` (the stage move),
 *    retried on the cooldown while the rolling budget lasts;
 *  - a heal judged failed (grace + settle) ⇒ the reload notice **latches**
 *    while the retries continue (C2, 2026-09): before the latch the user had to
 *    wait out the whole rolling budget (~296 s) before seeing the one action
 *    that works, and the chip showed "recovering…" over a repair that had
 *    already been judged. The judgment is taken from the **settle clock**
 *    (`lastHealAt + healSettleMs`), not from the 'healing' phase: the re-open
 *    itself reports `loading` synchronously (vendor `doOpen()`) and a hidden
 *    stretch zeroes the phase, so a phase-gated latch missed the button in the
 *    common interleavings; the latch then rides through loading dwells and is
 *    cleared only by recovery (which also ends the episode: the next error gets
 *    its own grace instead of inheriting this heal's settle clock);
 *  - `openState === 'loading'` held past the stall threshold ⇒ a notice with a
 *    reload action (never an automatic reload: design 14 discipline, and the
 *    mobile tier's `session-stall.ts` ruling — an observer may offer the
 *    user the one action that works, it may not take it for them) AND, while
 *    the session still has lever budget and the build exposes the concrete
 *    face, the armed `resync` control that rebuilds THIS session's stream
 *    without dropping the page;
 *  - a ladder that is OUT of levers (no neighbor session to move the stage
 *    through, or the budget spent) ⇒ the same notice, because for that state
 *    the reload really is the only remaining recovery.
 *
 * A stream that is `'open'` but silent is deliberately NOT guessed at: without
 * an applied-cursor watermark a long tool call is indistinguishable from a
 * halted carrier, so a shape-only notice would fire on legitimate work. The
 * `resync` control is deliberately scoped out of that arm for the same reason:
 * this module has no observable "no progress" signal to condition it on, and a
 * timer here would be a blind timeout, not a decision. That residual is
 * recorded in `docs/progress/STATUS.md` together with the two paths that can
 * close it (an upstream keepalive, or the carrier-retry policy patch) — never a
 * blind timeout here.
 *
 * CLOCK DISCIPLINE (mirrors `session-liveness.ts` and the mobile stall
 * observer): every hold is "zero whenever the predicate breaks" and the whole
 * ladder is fail-closed — an observation that cannot be made produces no
 * action. A hidden surface produces no notice and no heal, and its hold does
 * not accumulate; the settle clock is the deliberate exception, because it
 * measures an EXECUTED heal against wall time — a repair that failed while the
 * surface was hidden is announced by the first visible `error` tick (2026-09
 * review; callers must not read "hidden never counts" as "hidden time never
 * decides").
 *
 * THE RESYNC ARM'S STORM BOUND (2026-12, revised 2026-09-21): the plan ARMS the
 * control; the seat's click is the only path that executes it, and the click is
 * deliberately NOT ledger-gated (the ledger bounds the automatic arms, a human
 * click is its own bound — see the seat's `resync` face). The plan therefore
 * never rebuilds the stream once per tick; only spam-clicking the visible control
 * can repeat the call, which the seat serializes (double-click guard).
 */

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
   * The concrete session face exposes this build's per-session stream rebuild
   * (`Session.resync()` — NOT on the `ISession` contract). The seat reads it
   * with the probe's guarded capability check, so a missing or drifting face
   * yields `false`, and the ladder then behaves exactly as it did before this
   * lever existed (fail-closed: no control is armed for a lever we cannot see).
   */
  readonly resyncAvailable?: boolean | undefined
  /**
   * Latest page-level carrier-churn fact for this source (the in-repo fork's
   * `dsh-chamber:stream-carrier-failed` event), or undefined when none arrived.
   * With the retry patch the carrier has no terminal escape left, so a
   * keep-failing mux reopens silently; this fact is the only honest "the stream
   * is being reopened" signal (design 14 §D4).
   */
  readonly carrierChurn?: { readonly at: number; readonly count: number } | undefined
  /**
   * Whether the official open is STILL IN FLIGHT: the concrete `Session.openPromise`
   * read by the probe's guarded slice (`true` while an open is pending, `false`
   * when the state is `loading` with nothing pending, `undefined` when this build's
   * face cannot say). Only `false` — positive evidence that no request is being
   * waited on — unlocks the automatic rebuild; `undefined` fails closed exactly
   * like a missing capability (2026-09-21).
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
   * A heal was executed AND judged failed without settling the error (C2,
   * 2026-09): from then on the notice carries the reload action while the
   * automatic retries keep running. Before this latch the user had to wait out
   * the whole rolling budget (~296 s) before the one action that works was
   * offered at all. Cleared **only** by an observed recovery (`open`/`cold`):
   * the re-open reports `loading` synchronously and a hidden stretch zeroes the
   * phase, so a `loading` dwell deliberately retains the latch (module header).
   */
  readonly healFailedLatched?: boolean
  /**
   * The stream was observed 'open'/'cold' after the heal that `lastHealAt`
   * points at (2026-09 review). `lastHealAt` deliberately survives recovery so
   * the cooldown is not reset by a flapping source — but a settle-clock latch
   * must not read that old clock as "this episode's repair failed": the next
   * error would show the reload notice before the ladder even tried again.
   */
  readonly recoveredSinceHeal?: boolean
}

/** Thresholds and budgets (tuned by the numbers in the module header). */
export interface SessionStreamHealthConfig {
  /** An `error` state must hold this long before the automatic re-open fires. */
  readonly errorGraceMs: number
  /** A `loading` state must hold this long before the reload notice appears. */
  readonly loadingStallMs: number
  /**
   * A `loading` dwell past this bound is announced as a FAILURE ("content not
   * loaded"), never as an ongoing load: the user must not read an eternal
   * spinner, and the recovery levers keep running underneath the notice.
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
 * Defaults. The grace is short because an `error` state is not a state the
 * user can read anything new from (the window is already frozen); the loading
 * threshold sits far above the loopback/gateway p99 open latency, so it only
 * fires on a genuinely parked open.
 */
export const SESSION_STREAM_HEALTH_DEFAULTS: SessionStreamHealthConfig = {
  errorGraceMs: 8_000,
  loadingStallMs: 20_000,
  loadingFailedMs: 90_000,
  healCooldownMs: 120_000,
  healBudgetWindowMs: 600_000,
  healBudgetMax: 3,
  healSettleMs: 20_000,
  carrierChurnMs: 10_000,
}

/**
 * What the plan asks of the seat this tick.
 *
 * - `'heal'` (stage move) and `'auto-resync'` (per-session rebuild) are executed
 *   by the seat IMMEDIATELY and accounted against the session's ledger;
 * - `'resync'` only ARMS the user control — the click is that path's sole
 *   invocation, and it is never gated by the ledger (the ledger bounds the
 *   AUTOMATIC arm; a human click is its own bound).
 */
export type SessionStreamHealthAction = 'none' | 'heal' | 'resync' | 'auto-resync'

/** What the seat must DO this tick, and what it may SHOW. */
export interface SessionStreamHealthPlan {
  readonly state: SessionStreamHealthState
  readonly action: SessionStreamHealthAction
  readonly notice: SessionStreamNotice | null
}

/**
 * True while this session's lever ledger still permits an attempt: not inside
 * the cooldown after the last EXECUTED lever, and not past the rolling budget.
 * Both the automatic heal and the user-armed resync spend the same ledger, so
 * this is the one place the storm bound is evaluated for a SESSION rather than
 * per arm — the plan calls it before arming the resync control, and the seat
 * calls it again on the click (2026-12).
 *
 * @param state - the session's ladder state (pruned internally).
 * @param now - current time (epoch ms).
 * @param config - thresholds; defaults to the shipped set.
 * @returns true when a lever may be attempted right now.
 */
export function sessionStreamLeversAvailable(
  state: SessionStreamHealthState,
  now: number,
  config: SessionStreamHealthConfig = SESSION_STREAM_HEALTH_DEFAULTS,
): boolean {
  const sinceHeal = state.lastHealAt === undefined ? undefined : now - state.lastHealAt
  const cooling = sinceHeal !== undefined && sinceHeal >= 0 && sinceHeal < config.healCooldownMs
  const inBudget = state.healStamps.filter(stamp => now - stamp < config.healBudgetWindowMs).length < config.healBudgetMax
  return !cooling && inBudget
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
    // C2 (2026-09): once a heal has been judged failed, the notice carrying the
    // ONE action that works stays up while the automatic retries continue.
    let latched = state.healFailedLatched === true

    // A wall clock that jumped BACKWARDS (NTP step, VM resume, manual change)
    // must never latch 'healing' forever with no notice and no retry: a negative
    // delta counts as settled, which sends the ladder back to the hold where the
    // cooldown decides the next attempt. Same rule for the cooldown below.
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
      // Judge it: the repair did not take. Fall back to the hold so the cooldown
      // (or the exhausted budget, below) paces the next attempt.
      phase = 'error-hold'
      since = now
      held = 0
    }

    // C2 (2026-09 review): the judgment hangs off the SETTLE CLOCK, not off the
    // 'healing' phase. The lever re-opens the session and vendor `Session.doOpen()`
    // writes `openState = 'loading'` SYNCHRONOUSLY before its first await, so a
    // loading observation (or a hidden stretch, which zeroes the phase) routinely
    // interrupts the error hold — gating the latch on `phase === 'healing'`
    // silently dropped the button in exactly those cases (probe: 28s → >128s, and
    // a flapping re-open never latched at all). What proves the executed heal did
    // not settle is `sinceHeal >= healSettleMs` while the state is still `error`;
    // a recovery marks the episode as recovered (`recoveredSinceHeal`, while the
    // cooldown anchor survives for the flapping bound), so a fresh error cannot
    // inherit this heal's clock. A backwards wall clock (negative delta) must NOT
    // latch: a clock step is not evidence that the repair failed.
    if (state.recoveredSinceHeal !== true
        && sinceHeal !== undefined && sinceHeal >= config.healSettleMs) latched = true

    const cooling = sinceHeal !== undefined && sinceHeal >= 0 && sinceHeal < config.healCooldownMs
    const inBudget = healStamps.length < config.healBudgetMax
    if (held >= config.errorGraceMs && !cooling && inBudget && observation.neighborAvailable) {
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

    // 2026-09 review: the stage move needs a CURRENT, LISTED target plus another
    // listed session to carry the detour. A target it must refuse (an address-only
    // subagent selection) still has the concrete per-session resync, so ARM that
    // user control instead of degrading to a bare reload. Same ledger, and still
    // user-executed: the plan never calls it, only the chip's click does.
    // NOT ledger-gated (2026-09-21 ruling, symmetric with the loading arm): the
    // ledger bounds the AUTOMATIC arms; this control is executed by the user's
    // click, so gating its visibility on a spent budget removed the only exit that
    // keeps the page (an error state with no neighbour has no stage move either).
    // `resyncAvailable` — the capability — still gates it.
    const resyncArmed = held >= config.errorGraceMs
      && observation.resyncAvailable === true

    // No usable lever (no neighbor and no resync face, budget spent, or cooling):
    // say so once the hold has clearly outlived a repair attempt — never on the
    // first frames, where an in-flight open can still resolve the state on its own.
    // Without the resync face the only remaining exits are a stage move (needs a
    // neighbour AND budget) and the full reload, so an exhausted budget or a
    // missing neighbour is what makes the hold hopeless then.
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
        // settle clock (probe: a recovery at +10s made +29s announce a failure this
        // episode never attempted). `markSessionStreamHeal` clears it for real when
        // a fresh heal of this episode runs.
        ...(state.recoveredSinceHeal === undefined ? {} : { recoveredSinceHeal: state.recoveredSinceHeal }),
      },
      action: resyncArmed ? 'resync' : 'none',
      // 2026-09 review BLOCKER: the chip renders its action row only when a notice
      // is present, so an armed-but-silent resync would never be clickable AND the
      // reload fallback would never appear — the user would sit on "recovering".
      // An armed manual lever is exactly the "no automatic repair happened" case,
      // so it carries the same notice as the exhausted-levers path.
      notice: latched || hopeless || resyncArmed ? 'heal-failed' : null,
    }
  }

  if (observation.openState === 'loading') {
    const continued = state.phase === 'loading-hold'
    const since = continued ? state.since : now
    const stalled = now - since >= config.loadingStallMs
    // C2: the re-open's own loading dwell must not take back an action the user
    // was already offered (the same rule `markSessionStreamHeal` states). The
    // latch rides along; a genuine stall keeps its own, more specific label.
    const latched = state.healFailedLatched === true
    const levers = sessionStreamLeversAvailable(state, now, config)
    // The AUTOMATIC arm (2026-09-21, user ruling): it needs BOTH the concrete
    // capability and POSITIVE evidence that no open is in flight. `undefined` (a
    // face that cannot say) and `true` (an open being awaited) both fail closed,
    // so a slow-but-working Host is never interrupted; the same ledger as the
    // stage move bounds the retries.
    const auto = stalled && observation.resyncAvailable === true
      && observation.openInFlight === false && levers
    // The user's own control: offered while the stall holds and the concrete face
    // exists. NOT gated by the ledger (see the action type) — the ledger bounds
    // the automatic arm, and a human click must remain possible even after the
    // automatic budget is spent, or the session would have no manual exit left.
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
      // A dwell that outlived every recovery attempt must read as a FAILURE, not
      // as a load still in progress: "content not loaded" plus the actions. The
      // latched heal-failed label still wins before the stall threshold.
      notice: stalled
        ? (now - since >= config.loadingFailedMs ? 'loading-failed' : 'loading-stall')
        : (latched ? 'heal-failed' : null),
    }
  }

  // 'open' / 'cold': the stream is alive (or never asked for a window): clear
  // every clock and the notice. The heal budget survives recovery so a flapping
  // source cannot be healed once per recovery forever.
  // chamber (design 14 §D4): 'open' is no longer proof that events flow — the
  // gateway fork paces carrier failures instead of failing terminally, so a
  // recent churn fact is the user's only signal that the stream is reopening.
  const churn = observation.carrierChurn
  const churning = churn !== undefined && churn.count > 0 && now - churn.at <= config.carrierChurnMs
  return {
    state: {
      phase: 'idle',
      since: 0,
      healStamps,
      // The cooldown anchor survives recovery (the flapping bound), but the
      // EPISODE does not: mark it so the next error cannot inherit this heal's
      // settle clock (2026-09 review). A fresh heal drops the marker again.
      ...(state.lastHealAt === undefined
        ? {}
        : { lastHealAt: state.lastHealAt, recoveredSinceHeal: true }),
    },
    action: 'none',
    notice: churning ? 'carrier-churn' : null,
  }
}

/**
 * Account one EXECUTED lever — the automatic stage move OR the user-clicked
 * resync: stamps it and moves the settle clock, so the same session cannot
 * spend the ledger again inside {@link SessionStreamHealthConfig.healCooldownMs}.
 * @param state - state from the plan that requested the heal (or, for the
 * user-armed resync, the seat's per-session state at click time).
 * @param now - execution time (epoch ms).
 * @returns the next state (the caller stores it in its ref).
 */
export function markSessionStreamHeal(state: SessionStreamHealthState, now: number): SessionStreamHealthState {
  return {
    phase: 'healing',
    since: now,
    healStamps: [...state.healStamps, now],
    lastHealAt: now,
    // C2: the latch is a user-visible contract, not a phase — a retry in flight
    // must not hide the reload action the user was already offered.
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
  // Total BY TYPE (2026-09-21 review): the old if-chain ended in a fallback, so a
  // future notice member would silently render as 'heal-failed'. The Record above
  // cannot be built with a member missing — the build fails instead.
  return SESSION_STREAM_NOTICE_KEYS[notice]
}
