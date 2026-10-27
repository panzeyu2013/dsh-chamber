/**
 * The per-instance transport runtime state. Every field is written by exactly one
 * owner inside transport-manager (link health, probe, lifecycle); the registry module
 * reads phase/serviceActive and clears retired entries, so the type lives in its own
 * leaf instead of the manager (B2-0).
 */
import type { SpawnedProcess, TransportLogEntry, TransportPhase } from './transport-provider.ts'
import type { LinkHealthState } from './transport-health.ts'
export interface InstanceState {
  phase: TransportPhase
  localPort: number | null
  child: SpawnedProcess | null
  childExited: boolean
  authFailed: boolean
  retryAttempt: number
  requiresUserAction: boolean
  /** Class of the terminal failure behind requiresUserAction ('auth' = transport/
   *  credential-level, 'endpoint' = instance-level terminal probe failure — the
   *  transport reached the destination and the answer rejected the connection);
   *  null otherwise. Projected so an endpoint failure never masquerades as SSH
   *  auth failure. */
  userActionKind: 'auth' | 'endpoint' | null
  serviceActive: boolean | null
  logSummary: string
  reconnectTimer: ReturnType<typeof setTimeout> | null
  readyLoop: AbortController | null
  logs: TransportLogEntry[]
  /** Monotonic transport attempt counter: stale startTransport invocations and
   *  delayed exits of replaced children are recognized and ignored. */
  tunnelEpoch: number
  /** Monotonic exec-generation counter, incremented on disconnect: execs started
   *  before it are stale and never write state (removed-and-reused id, kind
   *  switch, field-edit restart). */
  execEpoch: number
  /** In-flight provider exec children of THIS instance, SIGTERMed by disconnect
   *  (a disconnect cancels the execs it owns) plus the global set on dispose. */
  execChildren: Set<SpawnedProcess>
  /** Pending ready-state re-verification timer (armed on ready, canceled on
   *  leaving ready — see LINK_POLICY.healthyProbeIntervalMs). */
  readyProbeTimer: ReturnType<typeof setTimeout> | null
  /** Down -> reconnect grace: keeps phase ready while health=down. */
  downGraceTimer: ReturnType<typeof setTimeout> | null
  /** Hard end of the grace window (downGraceMs + the probing provider's budget):
   *  an in-flight probe may extend the timer up to here, never beyond. */
  downGraceDeadlineAt: number
  /** Cancels the in-flight endpoint verification of THIS transport generation
   *  (disconnect/retarget or the probe deadline). */
  probeAbort: AbortController | null
  /** Epoch-ms of the last link event (ready edge or health transition): the
   *  heartbeat picks the tight watch cadence while it is fresh. */
  lastLinkEventAt: number
  /** A forced probe arrived while verifyInFlight; run one more after it settles. */
  pendingForcedProbe: boolean
  /** One in-flight ready-state re-verification per instance (single-flight:
   *  the periodic heartbeat and a user-initiated reverify never overlap). */
  verifyInFlight: boolean
  /** Epoch-ms of the last completed ready-state re-verification (0 = none);
   *  the user-initiated quiet window reads it. */
  lastVerifyAt: number
  /** A local -L bind race (ExitOnForwardFailure). Re-allocated without burning a retry. */
  portBindFailed: boolean
  /** Bound the bind-race re-allocation loop; after this, normal retry/error takes over. */
  portBindRetries: number
  /** Ready-state link health; reset for every fresh transport attempt. */
  link: LinkHealthState
  /** Increments on every entry into ready (initial or recovery); page reset key. */
  linkEpoch: number
}
