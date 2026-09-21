/**
 * Trailing frame coalescer (chamber 2026-09 renderer-crash round).
 *
 * WHY THIS EXISTS. Renderer hot paths drive "sample the DOM after a mutation,
 * but at most once per frame" loops. The per-frame shape is exactly the JS entry
 * the WebContent process was executing when it died (Apple symbolication:
 * \`JSRequestAnimationFrameCallback::invoke\` → OSR entry → JSC code-block
 * replacement trap), and during the boot window those loops run for tens of
 * seconds while every source shell compiles. Coalescing the storm into a bounded
 * sample rate with a guaranteed trailing sample keeps the semantics the callers
 * need (the LAST state is always observed) while cutting the work by ~6-10x.
 *
 * The scheduler is injected so the contract is unit-testable in plain node:
 * \`scheduleFrame\` models requestAnimationFrame, \`scheduleDelay\` models the
 * trailing timer. Dependency-free, no DOM, no React.
 */

export interface FrameCoalescerOptions {
  /** Run one sample. Must be cheap; it runs inside a frame callback. */
  readonly sample: () => void
  /** Minimum spacing between two samples (ms). 0 = one sample per frame. */
  readonly minIntervalMs: number
  /** Monotone clock (defaults to Date.now). */
  readonly now?: () => number
  /** Frame scheduler (defaults to requestAnimationFrame, else a 16ms timer). */
  readonly scheduleFrame?: (run: () => void) => void
  /** Trailing-timer scheduler (defaults to setTimeout). */
  readonly scheduleDelay?: (run: () => void, ms: number) => void
}

export interface FrameCoalescer {
  /** Request a sample (a trailing one is guaranteed). Idempotent per window. */
  request(): void
  /** Drop any scheduled sample; the coalescer stops until the next request. */
  cancel(): void
}

/**
 * One request in flight at a time: the first request after an idle gap runs on
 * the next frame, requests arriving inside \`minIntervalMs\` of the last sample
 * collapse into a single trailing run.
 */
export function createFrameCoalescer(options: FrameCoalescerOptions): FrameCoalescer {
  const now = options.now ?? ((): number => Date.now())
  const scheduleFrame =
    options.scheduleFrame ??
    ((run: () => void): void => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => run())
      else setTimeout(run, 16)
    })
  const scheduleDelay = options.scheduleDelay ?? ((run: () => void, ms: number): void => void setTimeout(run, ms))
  let lastSampleAt: number | null = null
  let pending: { cancel?: () => void } | null = null

  const run = (): void => {
    pending = null
    lastSampleAt = now()
    options.sample()
  }
  const request = (): void => {
    if (pending !== null) return
    const at = now()
    const remaining = lastSampleAt === null ? 0 : options.minIntervalMs - (at - lastSampleAt)
    if (remaining <= 0) {
      let scheduled = true
      pending = {
        cancel: () => {
          scheduled = false
        },
      }
      scheduleFrame(() => {
        if (scheduled) run()
      })
      return
    }
    let scheduled = true
    pending = {
      cancel: () => {
        scheduled = false
      },
    }
    scheduleDelay(() => {
      if (scheduled) run()
    }, remaining)
  }
  return {
    request,
    cancel(): void {
      pending?.cancel?.()
      pending = null
    },
  }
}
