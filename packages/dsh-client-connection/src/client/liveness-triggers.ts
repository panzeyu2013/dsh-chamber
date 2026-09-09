/**
 * chamber patch (design 14 D4, extension — sleep/wake stuck-deep-diving fix):
 * window/document liveness triggers that force an immediate connection
 * reconnect.
 *
 * ## Why
 *
 * The push carrier (currently the api-gateway `/api/remote.mux` WebSocket;
 * previously the `events.mux` / `events.host` downlinks) has no client-side
 * heartbeat: after an OS sleep/wake or a network change the socket can
 * silently die (half-open TCP, flushed loopback state) WITHOUT ever firing
 * close/error — the generation loop then stays "connected" forever while
 * receiving nothing. The session UI freezes on its last known state (a stuck
 * "Deep diving..." row) although the backend keeps processing and the message
 * POST (a fresh HTTP connection) succeeds. A reconnect is the recovery: it
 * aborts the current generation immediately, the loop re-runs the readiness
 * handshake, the host replays baselines and the runtime re-syncs session state
 * (the stuck running bit converges).
 *
 * The chamber shell already reconnects on OS wake (`dsh-chamber:system-resume`,
 * design 14 D4). This module adds the fallbacks that cover wake/network cases
 * where that event is missed or never fires:
 *  - `online` — the network (e.g. Wi-Fi re-association after wake) returned;
 *  - the document becoming visible again after a hidden span of at least
 *    `hiddenReconnectThresholdMs` — covers hide-to-tray / long-backgrounded
 *    recovery (short alt-tabs never reconnect).
 *
 * All triggers share one `reconnect` and are gated on the browser's network
 * state (a reconnect while offline is pointless — the controller's own
 * `setNetworkAvailable` suspension covers that). Upstream `reconnect()` is
 * idempotent and aborts the in-flight generation in place, so overlapping
 * triggers are harmless.
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
  /** The shared reconnect (the connection controller's native `reconnect()`). */
  restart: () => void
  /** Window events that force an immediate reconnect (system-resume, online). */
  windowEvents?: readonly string[]
  /** A hidden span at least this long forces a reconnect when the page becomes visible again. */
  hiddenReconnectThresholdMs?: number
  /**
   * Minimum gap between reconnects: overlapping triggers (resume + online on
   * one wake, or `online` flapping) must not churn the loop in a burst.
   * Defaults to {@link DEFAULT_MIN_RESTART_INTERVAL_MS} — the pump's own
   * slowest reconnect step — so ambient bursts never reconnect faster than the
   * loop's native retry cadence could.
   */
  minRestartIntervalMs?: number
  /**
   * Browser network gate: a trigger is ignored while offline (the controller's
   * own `setNetworkAvailable(false)` suspension already covers that state, and
   * a reconnect would only abort the generation for nothing). Defaults to
   * `navigator.onLine`; `undefined` (non-browser) counts as online.
   */
  isOnline?: () => boolean
  /** Injectable clock (tests). */
  now?: () => number
}

export const DEFAULT_HIDDEN_RECONNECT_THRESHOLD_MS = 30_000
// Deliberate divergence note: OpenChamber reconnects on EVERY visible
// transition, but a dsh reconnect re-baselines every open session
// (conversation rebuild), so short alt-tabs must not churn the loop. 30s is
// the shortest plausible OS suspend/hide-to-tray span: any hidden interval
// shorter than that is an alt-tab, longer is a real sleep/background that
// warrants a fresh connection. This is the one heuristic without an
// industry-standard anchor; the value is tunable via
// `hiddenReconnectThresholdMs`.
/**
 * Default minimum gap between liveness reconnects. Equals the recovery-config
 * schema default `backoffMaxMs` (10_000, see `../recovery-config.ts`) — the
 * pump's own slowest retry step — so a trigger burst can never churn the loop
 * faster than its native backoff cadence would.
 */
export const DEFAULT_MIN_RESTART_INTERVAL_MS = 10_000

/** Browser network state, `undefined`/absent navigator counts as online. */
function browserIsOnline(): boolean {
  const navigator_ = (globalThis as { navigator?: { onLine?: boolean } }).navigator
  return navigator_?.onLine !== false
}

/**
 * Attach the liveness triggers. Returns a detach function (idempotent).
 * `win`/`doc` may be undefined in non-browser contexts — the no-op result.
 */
export function attachLivenessTriggers(
  win: LivenessWindow | undefined,
  doc: LivenessDocument | undefined,
  options: LivenessTriggerOptions,
): () => void {
  const { restart } = options
  const threshold = options.hiddenReconnectThresholdMs ?? DEFAULT_HIDDEN_RECONNECT_THRESHOLD_MS
  const minRestartInterval = options.minRestartIntervalMs ?? DEFAULT_MIN_RESTART_INTERVAL_MS
  const isOnline = options.isOnline ?? browserIsOnline
  const now = options.now ?? Date.now
  // De-dup overlapping triggers (system-resume + online on one wake, `online`
  // flapping): a reconnect more often than every minRestartInterval is never
  // useful — each reconnect re-runs the handshake and re-syncs every open
  // session, so bursts must collapse into one.
  let lastRestart = Number.NEGATIVE_INFINITY
  const fireRestart = (): void => {
    if (!isOnline()) return
    const at = now()
    if (at - lastRestart < minRestartInterval) return
    lastRestart = at
    restart()
  }
  const windowEntries: Array<[string, () => void]> = []
  if (win !== undefined) {
    for (const type of options.windowEvents ?? []) {
      const onEvent = (): void => { fireRestart() }
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
      // Visible again: reconnect only after a long hidden span (sleep,
      // hide-to-tray, backgrounded) — a short alt-tab must not churn the loop.
      // The hidden clock clears on ANY visible transition, so a stray visible
      // event (impossible in a real browser without a preceding hide) can
      // never trigger a late restart.
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
