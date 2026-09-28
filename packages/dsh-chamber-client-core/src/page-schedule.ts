/**
 * The page's own scheduling record (design 14 §D4 的证据有效性层).
 *
 * WebKit throttles (and can suspend) a WKWebView whose window is occluded or
 * unfocused while \`document.visibilityState\` still reports \`visible\` — so a wall-clock
 * deadline inside the page can expire while the page never got a turn to run. Every
 * chamber liveness deadline asks this module first: if the page was demonstrably not
 * scheduled inside the observation window, the deadline is NOT evidence about the
 * source (\`dsh-stream-state/evidence.ts\` classifies it as \`unscheduled\`).
 *
 * Evidence sources, in priority order:
 *  1. the shell's hostFacts push (\`focused\`/\`webViewLoading\` — the native truth about the
 *     window, not the page's own guess);
 *  2. \`document.visibilityState\`;
 *  3. a \`requestAnimationFrame\` heartbeat: rAF does not run while the page is throttled,
 *     so a gap in ticks is direct evidence of a scheduling gap.
 *
 * Framework-free and storage-free. Non-DOM hosts (tests, node) drive it through
 * \`notePageTick/noteFocus/noteVisibility\`; the rAF loop installs only when a DOM exists.
 */

/** A rAF gap at or above this is a scheduling gap, not jitter (60fps ⇒ ~16ms). */
export const PAGE_SCHEDULE_GAP_MS = 1_000

export interface PageScheduleSnapshot {
  /** Last rAF tick observed by this module (ms, \`Date.now()\` clock), null before the first. */
  readonly lastTickAt: number | null
  /** Last gap detected on resume (null when no gap has been seen since the last reset). */
  readonly lastGap: { readonly from: number; readonly to: number } | null
  /** Native window focus fact pushed by the shell (undefined = the shell never said). */
  readonly focused: boolean | undefined
  /** \`document.visibilityState === 'visible'\` (true when there is no document). */
  readonly visible: boolean
  /** Shell fact: the webview is loading/reloading. */
  readonly loading: boolean | undefined
}

interface ScheduleState {
  lastTickAt: number | null
  lastGap: { from: number; to: number } | null
  focused: boolean | undefined
  visible: boolean
  loading: boolean | undefined
  installed: boolean
}

const state: ScheduleState = {
  lastTickAt: null,
  lastGap: null,
  focused: undefined,
  visible: true,
  loading: undefined,
  installed: false,
}

/** One rAF tick. Records a gap when the previous tick is older than the threshold. */
export function notePageTick(now: number = Date.now(), gapMs: number = PAGE_SCHEDULE_GAP_MS): void {
  const previous = state.lastTickAt
  state.lastTickAt = now
  if (previous !== null && now - previous >= gapMs) state.lastGap = { from: previous, to: now }
}

/** Shell hostFacts push (\`focused\`/webViewLoading). */
export function noteFocus(focused: boolean | undefined = undefined, loading: boolean | undefined = undefined): void {
  if (focused !== undefined) state.focused = focused
  if (loading !== undefined) state.loading = loading
}

/** \`document.visibilitychange\`. */
export function noteVisibility(visible: boolean): void {
  state.visible = visible
}

export function pageScheduleSnapshot(): PageScheduleSnapshot {
  return {
    lastTickAt: state.lastTickAt,
    lastGap: state.lastGap === null ? null : { ...state.lastGap },
    focused: state.focused,
    visible: state.visible,
    loading: state.loading,
  }
}

/**
 * Was the page demonstrably NOT scheduled inside \`[from, to]\`? Conservative: only
 * returns true on positive evidence (unfocused window, hidden document, or a tick
 * gap overlapping the window). An unknown state answers \`false\` — an unproven gap must
 * never excuse a real source failure.
 */
export function hadSchedulingGap(from: number, to: number, now: number = Date.now()): boolean {
  if (state.visible === false) {
    // The document is hidden now; only claim the window if some of it is in the gap
    // (we cannot date the visibility change, so treat a hidden document as evidence
    // for any window that ends at/after the last tick).
    return state.lastTickAt === null || to >= state.lastTickAt
  }
  const gap = state.lastGap
  if (gap !== null && gap.from <= to && gap.to >= from) return true
  if (state.lastTickAt !== null) {
    // No tick inside the window at all: the page was silent across it.
    if (state.lastTickAt < to - PAGE_SCHEDULE_GAP_MS && now >= to) return true
  } else if (state.focused === false) {
    return true
  }
  return state.focused === false && to >= now - PAGE_SCHEDULE_GAP_MS
}

/** Test seam: forget everything (never used in production paths). */
export function resetPageScheduleForTests(): void {
  state.lastTickAt = null
  state.lastGap = null
  state.focused = undefined
  state.visible = true
  state.loading = undefined
}

/**
 * Install the rAF heartbeat + visibility listener (idempotent, no-op without a DOM).
 * Returns a disposer; the App calls this once at boot.
 */
export function startPageScheduleProbe(): () => void {
  if (state.installed) return () => {}
  const global = globalThis as {
    requestAnimationFrame?: (cb: (t: number) => void) => number
    document?: {
      visibilityState?: string
      hasFocus?: () => boolean
      addEventListener?: (t: string, l: () => void) => void
      removeEventListener?: (t: string, l: () => void) => void
    }
  }
  const raf = global.requestAnimationFrame
  if (typeof raf !== 'function') return () => {}
  state.installed = true
  const doc = global.document
  if (doc?.visibilityState !== undefined) state.visible = doc.visibilityState === 'visible'
  const windowLike = globalThis as { addEventListener?: (t: string, l: () => void) => void, removeEventListener?: (t: string, l: () => void) => void }
  const loop = (): void => {
    notePageTick()
    // \`document.hasFocus()\` is the page-visible half of the shell's \`focused\` fact — no
    // bridge plumbing needed, and it is false exactly while the window is not key.
    const hasFocus = typeof doc?.hasFocus === 'function' ? doc.hasFocus() : undefined
    if (hasFocus !== undefined) noteFocus(hasFocus)
    raf(loop)
  }
  raf(loop)
  const onVisibility = (): void => { noteVisibility(global.document?.visibilityState === 'visible') }
  const onFocus = (): void => { noteFocus(true) }
  const onBlur = (): void => { noteFocus(false) }
  doc?.addEventListener?.('visibilitychange', onVisibility)
  windowLike.addEventListener?.('focus', onFocus)
  windowLike.addEventListener?.('blur', onBlur)
  return () => {
    state.installed = false
    doc?.removeEventListener?.('visibilitychange', onVisibility)
    windowLike.removeEventListener?.('focus', onFocus)
    windowLike.removeEventListener?.('blur', onBlur)
  }
}
