/**
 * chamber patch: window/document liveness triggers that force an immediate
 * connection reconnect. The push carrier has no heartbeat, so after OS
 * sleep/wake or a network change the socket can silently die (half-open)
 * without firing close/error and the loop stays "connected" forever. Triggers:
 * `online` and a visible transition after a hidden span ≥ the threshold; all
 * are gated on browser network state.
 */

export interface LivenessWindow {
  addEventListener(type: string, listener: () => void): unknown
  removeEventListener(type: string, listener: () => void): unknown
}

export interface LivenessDocument {
  visibilityState: string
  addEventListener(type: string, listener: () => void): unknown
  removeEventListener(type: string, listener: () => void): unknown
}

export interface LivenessTriggerOptions {
  restart: () => void
  windowEvents?: readonly string[]
  hiddenReconnectThresholdMs?: number
  /** Minimum gap between reconnects; overlapping/flapping triggers must not churn the loop. */
  minRestartIntervalMs?: number
  /** Browser network gate: offline triggers are ignored (the controller already
   *  suspends). Defaults to `navigator.onLine`; undefined counts as online. */
  isOnline?: () => boolean
  /**
   * Window events that BYPASS `isOnline`: a page frozen across suspend/resume can
   * miss `online` and report offline while the link is back; `reconnect()` skips
   * the suspension branch and forces one bounded attempt. Wake-class events only.
   */
  alwaysFireEvents?: readonly string[]
  now?: () => number
}

export const DEFAULT_HIDDEN_RECONNECT_THRESHOLD_MS = 30_000
// Unlike upstream, a reconnect re-baselines every open session, so short
// alt-tabs must not churn the loop: 30 s is the shortest real suspend/hide span.
/** Default minimum gap between liveness reconnects (= recovery-config `backoffMaxMs` 10_000). */
export const DEFAULT_MIN_RESTART_INTERVAL_MS = 10_000


function browserIsOnline(): boolean {
  const navigator_ = (globalThis as { navigator?: { onLine?: boolean } }).navigator
  return navigator_?.onLine !== false
}

/** Attach the triggers; returns an idempotent detach (no-op without win/doc). */
export function attachLivenessTriggers(
  win: LivenessWindow | undefined,
  doc: LivenessDocument | undefined,
  options: LivenessTriggerOptions,
): () => void {
  const { restart } = options
  const threshold = options.hiddenReconnectThresholdMs ?? DEFAULT_HIDDEN_RECONNECT_THRESHOLD_MS
  const minRestartInterval = options.minRestartIntervalMs ?? DEFAULT_MIN_RESTART_INTERVAL_MS
  const isOnline = options.isOnline ?? browserIsOnline
  const alwaysFire = new Set(options.alwaysFireEvents ?? [])
  const now = options.now ?? Date.now
  // De-dup overlapping triggers: each reconnect re-runs the handshake and re-syncs every session.
  let lastRestart = Number.NEGATIVE_INFINITY
  const fireRestart = (event?: string): void => {
    if (event === undefined || !alwaysFire.has(event)) {
      if (!isOnline()) return
    }
    const at = now()
    if (at - lastRestart < minRestartInterval) return
    lastRestart = at
    restart()
  }
  const windowEntries: Array<[string, () => void]> = []
  if (win !== undefined) {
    for (const type of options.windowEvents ?? []) {
      const onEvent = (): void => { fireRestart(type) }
      win.addEventListener(type, onEvent)
      windowEntries.push([type, onEvent])
    }
  }
  let hiddenSince: number | null = null
  let visibilityListener: (() => void) | undefined
  if (doc !== undefined) {
    visibilityListener = (): void => {
      if (doc.visibilityState === 'hidden') {
        hiddenSince = now()
        return
      }
      // Visible again: reconnect only after a long hidden span; a short alt-tab must not churn the loop.
      if (hiddenSince !== null) {
        const hiddenMs = now() - hiddenSince
        hiddenSince = null
        if (hiddenMs >= threshold) fireRestart()
      }
    }
    doc.addEventListener('visibilitychange', visibilityListener)
  }
  let detached = false
  return () => {
    if (detached) return
    detached = true
    if (win !== undefined) {
      for (const [type, listener] of windowEntries) win.removeEventListener(type, listener)
    }
    if (doc !== undefined && visibilityListener !== undefined) {
      doc.removeEventListener('visibilitychange', visibilityListener)
    }
  }
}
