/**
 * Gateway-side session-state watcher: a READ-ONLY mirror of dsh session facts
 * over the control-plane mux client: per-session state machine with a monotonic
 * cursor, one snapshot at <stateDir>/session-state/state.json, and the two
 * /chamber/session-state routes inside the /chamber/* auth gate.
 *
 * It never writes to dsh, never answers a waterfall on its own (the mux holds the
 * frame until ANOTHER downstream client attaches AND the grace elapses), and never
 * stores title/cwd/message/approval payloads. A completion = the status true->false
 * edge plus ONE follow read of turn/end.reason: completed arms completedAt; an
 * unreadable tail arms unread with completedAtSource='reconstructed' (never a
 * notifiable completion, and it retains its identity for a later baseline retry);
 * restart-recovered rows also arm completedAtSource='reconstructed'; snapshots persist
 * on a 1s debounce/shutdown/flush in a bounded delta ring that a restart invalidates
 * (no JSONL). */

import type { Logger } from '@dsh-chamber/control-plane'
import type { ChamberSessionState, SessionStateStore } from './session-state-types.ts'

import { createSessionStateStore } from './session-state/store.ts'
export {
  MAX_PENDING_GOAL_ACTIVATIONS, MAX_SESSIONS, PERSIST_DEBOUNCE_MS, SESSION_STATE_DIR_NAME,
  SESSION_STATE_FILE_NAME, SESSION_STATE_SCHEMA_VERSION, SSE_RING_MAX, createSessionStateStore,
} from './session-state/store.ts'

import { normalizeHostState } from './session-state/features.ts'
export { featuresForMode, normalizeHostState } from './session-state/features.ts'

import { createSessionStateObserver } from './session-state/observer.ts'
export {
  DEFAULT_EVENT_SILENCE_MS, DEFAULT_POLL_MS, DEFAULT_RECONCILE_MS, DEFAULT_TICK_MS,
  createSessionStateObserver,
} from './session-state/observer.ts'

import { createChamberSessionState } from './session-state/sse.ts'
export {
  MAX_SSE_PENDING_FRAMES, MAX_SSE_STREAMS, SSE_KEEPALIVE_MS, createChamberSessionState,
} from './session-state/sse.ts'

export type {
  ChamberSessionState, ChamberSessionStateDeps, CompletionEdge, SessionStateObserver,
  SessionStateObserverDeps, SessionStateObserverStatus, SessionStateStore, SessionStateStoreDeps,
  SessionStateStoreStatus,
} from './session-state-types.ts'

export interface SessionStateServiceDeps {
  stateDir: string
  logger: Logger
  /** Config kill switch (DSH_GATEWAY_SESSION_STATE=0 / sessionState:false). */
  enabled: boolean
  getLocalDshPort(): number | null
  /** Plane connectionState string (runtime-manager / control-plane). */
  getConnectionState(): string
  /** The exposure gate (never observe a quarantined candidate tree). */
  canExposeLocal(): boolean
  /** gateway-proxy.getDiagnostics().activeStreams > 0 (the delegate gate). */
  otherMuxClientsConnected(): boolean
}

export interface SessionStateService {
  readonly surface: ChamberSessionState
  readonly store: SessionStateStore
  start(): void
  /** Host-edge pause (keeps the routes serving the last snapshot). */
  stop(): void
  /** Gateway shutdown: close SSE -> stop the observer -> flush the snapshot. */
  shutdown(): Promise<void>
}

/**
 * Assemble store + observer + routes. start/stop follow the host readiness edge;
 * shutdown is the gateway stop path and must run BEFORE the gateway store closes.
 */
export function createSessionStateService(deps: SessionStateServiceDeps): SessionStateService {
  const baseUrl = (): string | null => {
    const port = deps.getLocalDshPort()
    if (port === null || !deps.canExposeLocal()) return null
    const state = normalizeHostState(deps.getConnectionState())
    if (state !== 'ready' && state !== 'degraded') return null
    return 'http://127.0.0.1:' + port
  }
  const store = createSessionStateStore({ stateDir: deps.stateDir, logger: deps.logger })
  const observer = createSessionStateObserver({
    logger: deps.logger,
    store,
    getBaseUrl: baseUrl,
    getHostState: () => normalizeHostState(deps.getConnectionState()),
    otherMuxClientsAttached: deps.otherMuxClientsConnected,
  })
  const surface = createChamberSessionState({
    logger: deps.logger,
    store,
    observer,
    enabled: deps.enabled,
  })
  if (!deps.enabled) store.setMode('off')
  return {
    surface,
    store,
    start(): void {
      if (!deps.enabled) return
      observer.start()
    },
    stop(): void {
      if (!deps.enabled) return
      observer.stop()
      store.setMode('poll')
    },
    async shutdown(): Promise<void> {
      surface.closeAllStreams()
      observer.stop()
      if (deps.enabled) store.setMode('poll')
      await store.flush()
      store.dispose()
    },
  }
}
