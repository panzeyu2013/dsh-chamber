/**
 * Page-level safety net for a document-global takeover of `#root`.
 *
 * WHY. Client plugins share this document with the chamber shell, so one foreign
 * `shell.overlay` seat can zero `#root` (`style.opacity = "0"`) and mark it
 * `inert`, covering the whole window (the desktop-only account family's
 * `desktop-onboarding` overlay parked on「正在加载设置…」— design 09 §3.5 有意跳过
 * 名单③). The covered-set skip removes that row; this watcher is the page-level net
 * for a future family that re-arms the same way.
 *
 * SIGNATURE — deliberately narrow: the trigger is an INLINE `style.opacity` on the
 * page root that parses to exactly 0. `calc()`/`var()` spellings, a stylesheet or
 * class that zeroes #root, a `visibility`/`display` hide, opaque sibling overlays
 * and a replaced #root element are NOT caught. A bare `inert` hold is legitimate
 * and never touched. A stable hold reports after the grace; a writer that keeps
 * flapping zero/non-zero sub-grace is caught by the rolling window
 * (`windowMs`/`minSamples`) instead of sliding through forever — the report is the
 * net's durable half. HONEST LIMIT: a LEGITIMATE desktop onboarding (the account
 * family's own loading state) is indistinguishable from a hostile hold under this
 * signature, so the covered-set skip must be retired or this net demoted to
 * report-only IN THE SAME BATCH that re-enables that family (design 09 §3.5).
 *
 * WHAT A RELEASE DOES AND DOES NOT DO: it clears the inline opacity AND sets
 * `inert = false` (without the second write a released root stays input-dead,
 * because `inert` blocks pointer/focus for the whole subtree). It does NOT remove
 * the foreign overlay: on darwin that overlay is transparent but still covers the
 * viewport, so it may keep swallowing pointer events, and elsewhere its background
 * is opaque. `#root` inert ownership is NOT attributable from this signature — the
 * account family (skipped here) and settings-models' onboarding dialog both set it,
 * and neither combines it with a zero opacity today.
 *
 * CLOCKLESS CORE: {@link rootTakeoverStep} is a pure reducer over caller-stamped
 * observations, and every threshold lives in {@link DEFAULT_ROOT_TAKEOVER_RULE};
 * the installer owns the DOM, the monotonic clock and the release writes. One live
 * watcher per page (install is idempotent): the release budget is a PAGE budget, so
 * a second install must not mint a second one.
 */

import { monotonicNow } from './monotonic-now.ts'

interface RootTakeoverRule {
  /** A stable zero-opacity hold must persist this long before the first report. */
  graceMs: number
  /** Minimum spacing between release attempts inside one reported episode. */
  retryMs: number
  /** Lifetime release attempts per page; then the watcher only reports. */
  maxReleases: number
  /** Rolling evidence window for a writer that never holds zero long enough. */
  windowMs: number
  /** Zero observations inside `windowMs` that count as a takeover episode. */
  minSamples: number
}

export const DEFAULT_ROOT_TAKEOVER_RULE: RootTakeoverRule = {
  graceMs: 3_000, retryMs: 5_000, maxReleases: 3, windowMs: 15_000, minSamples: 3,
}

interface RootTakeoverState {
  phase: 'idle' | 'held'
  /** Episode start (0 while idle). */
  since: number
  /** Release attempts made for this page. */
  releases: number
  /** The page budget is spent: further episodes are reported, never released. */
  exhausted: boolean
  /** The current episode already produced its report. */
  reported: boolean
  /** Last report stamp (0 = never) — enforces the minimum spacing between reports. */
  reportedAt: number
  /**
   * Recent zero observations, pruned to the rolling window. Deliberately NOT
   * dropped when a non-zero sample ends an episode: a writer flapping sub-grace
   * never holds long enough for the grace, so only this window can catch it.
   */
  zeroAt: readonly number[]
}

export const ROOT_TAKEOVER_IDLE: RootTakeoverState = {
  phase: 'idle', since: 0, releases: 0, exhausted: false, reported: false, reportedAt: 0, zeroAt: [],
}

interface RootTakeoverObservation {
  /** `#root.style.opacity` as the DOM serializes it. */
  opacity: string
  /** Caller-stamped milliseconds (monotonic in production; plain numbers in tests). */
  at: number
}

/** One recovery step the installer performs for a reducer transition. */
type RootTakeoverAction = 'report' | 'release' | 'exhausted'

/**
 * One observation of the page root → next state + actions. A zero-opacity episode
 * reports once it either held for `graceMs` or accumulated `minSamples` inside
 * `windowMs` (a flapping writer); the first report also releases, later releases
 * are spaced by `retryMs`, and the page budget ends in a single `exhausted`
 * action. A later episode still reports (evidence) but never releases again, and
 * reports are spaced by `retryMs` so a flapping writer cannot spam the incident ring.
 */
export function rootTakeoverStep(
  state: RootTakeoverState,
  observation: RootTakeoverObservation,
): { state: RootTakeoverState; actions: RootTakeoverAction[] } {
  const rule = DEFAULT_ROOT_TAKEOVER_RULE
  const zero = isZeroOpacity(observation.opacity)
  // The window counts EPISODES, not samples: one continuous hold that keeps rewriting
  // the attribute is not flapping evidence (it must wait for the grace like any stable
  // hold), while a writer that clears and re-zeroes keeps starting new episodes.
  const startsEpisode = zero && state.phase === 'idle'
  const zeroAt = startsEpisode
    ? [...state.zeroAt.filter(at => observation.at - at < rule.windowMs), observation.at]
    : state.zeroAt.filter(at => observation.at - at < rule.windowMs)
  if (!zero) {
    // A non-zero sample ends the EPISODE but not the rolling evidence window.
    return { state: { ...state, phase: 'idle', since: 0, reported: false, zeroAt }, actions: [] }
  }
  const current = state.phase === 'idle'
    ? { ...state, phase: 'held' as const, since: observation.at, reported: false }
    : state
  const elapsed = observation.at - current.since
  if (!current.reported) {
    const graceFired = elapsed >= rule.graceMs
    // A writer that never holds zero for the grace can still fill the window.
    const windowFired = zeroAt.length >= rule.minSamples
    const cooled = current.reportedAt === 0 || observation.at - current.reportedAt >= rule.retryMs
    if ((!graceFired && !windowFired) || !cooled) return { state: { ...current, zeroAt }, actions: [] }
    const spent = current.exhausted || current.releases >= rule.maxReleases
    return {
      state: {
        ...current, zeroAt: [], since: observation.at, reported: true, reportedAt: observation.at,
        exhausted: spent, releases: spent ? current.releases : current.releases + 1,
      },
      actions: spent ? ['report'] : ['report', 'release'],
    }
  }
  if (current.exhausted) return { state: { ...current, zeroAt }, actions: [] }
  if (elapsed < rule.retryMs) return { state: { ...current, zeroAt }, actions: [] }
  if (current.releases >= rule.maxReleases) {
    return { state: { ...current, zeroAt, since: observation.at, exhausted: true }, actions: ['exhausted'] }
  }
  return { state: { ...current, zeroAt, since: observation.at, releases: current.releases + 1 }, actions: ['release'] }
}

/**
 * Zero as the pinned writer serializes it. `parseFloat`, deliberately not `Number`:
 * `Number('')` is 0, so an UNSET attribute would read as a hijack — while a style
 * assignment the CSSOM rejects leaves the previous value in place, so the laxer
 * parses ('0px', '0%') only ever see a hostile DOM, never the detection path.
 */
function isZeroOpacity(opacity: string): boolean {
  const value = Number.parseFloat(opacity)
  return Number.isFinite(value) && value === 0
}

/** What the report seam receives (page wiring: console.error + incident entry). */
export interface RootTakeoverFacts {
  /** Milliseconds since the zero-opacity episode began. */
  heldMs: number
  /** The opacity value the hijack left (context for the incident entry). */
  opacity: string
  /** Whether the root was inert at detection (read before the release rewrites it). */
  inert: boolean
  /** `held`: the grace elapsed; `flapping`: the rolling window filled first. */
  trigger: 'held' | 'flapping'
  /** Whether this report also released the hold (false = spent budget, or a rejected write). */
  released: boolean
  /** True when a release was attempted and the style write threw — NOT a spent budget. */
  releaseFailed: boolean
  /** 1-based release attempt for this page (the lifetime budget). */
  releaseAttempt: number
}

interface RootTakeoverWatchOptions {
  /** Episode reporter; the only knob, because it is the only production caller input. */
  report: (facts: RootTakeoverFacts) => void
}

/** One live watcher per page; install after a dispose is allowed again. */
let installed = false

/**
 * Install the watcher and return its disposer. A second install while one is live
 * is a no-op (the page budget and the single observer must not be duplicated); with
 * no document, or no `#root`, there is nothing to watch and the call is a no-op too.
 */
export function installRootTakeoverWatch(options: RootTakeoverWatchOptions): () => void {
  if (installed) return () => {}
  const target = defaultTarget()
  if (target === null) return () => {}
  installed = true
  let state: RootTakeoverState = ROOT_TAKEOVER_IDLE
  let handle: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const sample = (): void => {
    if (disposed) return
    const previous = state
    const at = monotonicNow()
    const observation: RootTakeoverObservation = { opacity: String(target.style.opacity ?? ''), at }
    const step = rootTakeoverStep(previous, observation)
    state = step.state
    if (step.actions.length > 0) {
      const heldMs = Math.max(0, at - (previous.phase === 'held' ? previous.since : at))
      // The facts describe the hijack AS DETECTED; they must be read before the
      // release below rewrites both attributes.
      const observedInert = target.inert === true
      // Releases run BEFORE the report so the facts never claim a write that threw.
      // The reducer's attempt count is independent of the write outcome on purpose:
      // the budget bounds ATTEMPTS, so a DOM that rejects every write still ends in
      // `exhausted` after three tries instead of being retried forever.
      let released = false
      let releaseFailed = false
      if (step.actions.includes('release')) {
        // The net never breaks the path it observes, but a rejected write must stay
        // distinguishable from a spent budget.
        try { release(target); released = true } catch { releaseFailed = true }
      }
      const facts: RootTakeoverFacts = {
        heldMs,
        opacity: observation.opacity,
        inert: observedInert,
        trigger: heldMs < DEFAULT_ROOT_TAKEOVER_RULE.graceMs ? 'flapping' : 'held',
        released,
        releaseFailed,
        releaseAttempt: state.releases,
      }
      for (const action of step.actions) {
        switch (action) {
          case 'release': break // already performed above, before the report
          case 'report':
            try { options.report(facts) } catch { /* ditto */ }
            break
          case 'exhausted':
            console.error(
              'page root takeover persists after ' + String(DEFAULT_ROOT_TAKEOVER_RULE.maxReleases) + ' releases; '
              + 'giving up on automatic recovery — a foreign client plugin is holding #root '
              + '(design 09 §3.5 有意跳过名单③).',
            )
            break
        }
      }
    }
    schedule()
  }

  const schedule = (): void => {
    // The disposer can run from inside the report callback (the only re-entrant
    // window): a disposed watcher must neither sample nor re-arm.
    if (disposed) return
    if (handle !== undefined) { clearTimeout(handle); handle = undefined }
    // An exhausted page still schedules for an UNREPORTED episode: the report is
    // evidence and must not depend on a second attribute write arriving.
    if (state.phase !== 'held' || (state.exhausted && state.reported)) return
    const rule = DEFAULT_ROOT_TAKEOVER_RULE
    const now = monotonicNow()
    const elapsed = now - state.since
    // The FIRST report needs both its trigger (grace, or the window via a mutation)
    // and an open cooldown. When the grace lands inside a live cooldown the wake-up
    // must wait for the cooldown — `graceMs - elapsed` alone is 0 there and would
    // re-arm at 0ms until the cooldown ends (a busy loop on a hijacked page).
    const cooldownLeft = state.reportedAt === 0 ? 0 : rule.retryMs - (now - state.reportedAt)
    const wait = state.reported ? rule.retryMs - elapsed : Math.max(rule.graceMs - elapsed, cooldownLeft)
    handle = setTimeout(sample, Math.max(0, wait))
  }

  const unsubscribe = defaultObserve(target, sample)
  sample()
  return () => {
    if (disposed) return
    disposed = true
    installed = false
    unsubscribe()
    if (handle !== undefined) { clearTimeout(handle); handle = undefined }
  }
}

function defaultTarget(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return document.getElementById('root')
}

function defaultObserve(target: HTMLElement, onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined') return () => {}
  const observer = new MutationObserver(onChange)
  observer.observe(target, { attributes: true, attributeFilter: ['style', 'inert'] })
  return () => observer.disconnect()
}

function release(target: HTMLElement): void {
  // `inert` is a reflected IDL attribute: setting it false removes the content
  // attribute. Ownership is not attributable from the signature (see the header),
  // but a takeover that leaves #root inert keeps the whole app input-dead, so the
  // release restores both halves of the observed signature.
  target.style.opacity = ''
  target.inert = false
}
