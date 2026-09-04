/**
 * Local declaration for the chamberBridge shared face
 * (packages/dsh-client-ui-sidebar/src/shared): the renderer-published
 * multi-source projection (design 05 §3). This package resolves the specifier
 * to THIS file via tsconfig paths — the sidebar package's own sources are
 * never compiled here; at runtime vite's shared chunk keeps one instance.
 *
 * MIRROR WARNING: keep in sync with the REAL ChamberServerAggregate /
 * chamberBridge members (aggregate-store.ts) — this package reads roster
 * identity/connectivity plus the client-plugin diagnostic projection.
 */

/** One server row as published by the renderer App layer (aligned with the
 *  REAL aggregate-store.ts ChamberServerAggregate — 2026 review T2: the old
 *  mirror carried a phantom `hint` and missed workspaces / aggregate / runtime). */
export interface ChamberServerAggregate {
  /** 'local' | '<target-kind>-<id>' (`ssh-` remains a legacy dsh id). */
  id: string
  /** Opaque authoritative lifecycle proof for this exact source incarnation. */
  sourceFingerprint: string
  kind: 'local' | 'dsh' | 'gateway'
  transport: 'local' | 'ssh' | 'http'
  rawId?: string
  label: string
  /** Local: dsh ready; remote: tunnel phase ready. */
  connected: boolean
  /** Status text (ready/connecting/… projection). */
  phase: string
  workspaces: Array<{
    id: string
    title: string
    /** True only for the synthetic trailing ungrouped bucket. */
    ungrouped?: boolean
    sessions: { id: string; title: string; running?: boolean; updatedAt?: number; blank?: boolean }[]
  }>
  /** True when the per-instance aggregate snapshot has actually landed. */
  aggregateReady?: boolean
  /** Snapshot-fetch error text from the last per-instance pull. */
  aggregateError?: string
  /** Runtime facts from the source's own ctx (design 06 §4). */
  runtime?: {
    current?: string
    sessions: Record<string, {
      running?: boolean
      completed?: boolean
      pending?: 'approval' | 'plan-review' | 'question'
      runningSubagents?: number
    }>
  }
  /** Live dsh version (0.1.2: host.describe was deleted; the local instance
   *  version comes from the desktop bridge, remote stays hidden). */
  dshVersion?: string
  /** Renderer-local client-plugin boot health for this source. */
  pluginDiagnostic?: {
    state: PluginGraphDiagnosticState
    message?: string
    pluginId?: string
    updatedAt: number
  }
  updatedAt: number
}

/** One source's client-plugin runtime-loading outcome (design 09 §3.5) —
 *  mirror of the REAL PluginGraphDiagnosticState (aggregate-store.ts). */
export type PluginGraphDiagnosticState =
  | 'ok'
  | 'not-injected'
  | 'graph-unreachable'
  | 'bundle-load-failed'
  | 'restart-required'
  | 'instance-version-conflict'

/** Outcome of one host-graph channel recheck (design 09 §3.5 recheck
 *  contract) — mirror of the REAL PluginGraphRecheckOutcome
 *  (plugin-graph-recheck.ts). */
export type PluginGraphRecheckOutcome =
  | 'reported-ok'
  | 'reported-not-injected'
  | 'reported-graph-unreachable'
  | 'unchanged'
  | 'skipped'

/** True for the diagnostics that describe the host-graph CHANNEL at the last
 *  shell boot (self-heal candidates) — never for boot-fact classes. Mirror of
 *  the REAL isChannelClassDiagnostic (plugin-graph-recheck.ts). */
export function isChannelClassDiagnostic(state: PluginGraphDiagnosticState | undefined): boolean

/** Re-check one source's host boot-graph channel and write the verdict back
 *  through chamberBridge when the verdict STATE differs from the recorded
 *  diagnostic. Mirror of the REAL recheckPluginGraphDiagnostic
 *  (plugin-graph-recheck.ts) — this ambient face is a COMPATIBLE SUBSET of
 *  the real signature `(sourceId, deps?: PluginGraphRecheckDeps)`; a real
 *  signature change would not surface as a settings-bridge type error. */
export function recheckPluginGraphDiagnostic(sourceId: string): Promise<PluginGraphRecheckOutcome>

/** The renderer-shared chamberBridge singleton (non-authoritative projection). */
export const chamberBridge: {
  getServers(): ChamberServerAggregate[]
  subscribe(listener: () => void): () => void
} = undefined as never

/**
 * MIRROR WARNING (gateway dsh-runtime face, design 21 §5.2 split): the pure
 * gateway runtime core + the restart poll moved INTO the sidebar package
 * shared face (packages/dsh-chamber-client-ui-sidebar/src/shared/
 * gateway-runtime.ts + gateway-runtime-poll.ts, exported through
 * `@dsh-chamber/dsh-client-ui-sidebar/shared`). The rewired runtime client
 * imports that face, so the declarations below mirror the REAL shared exports
 * this package consumes — keep them in sync with the shared sources (the
 * sidebar test/gateway-runtime-mirror.test.ts locks this ambient to the real
 * export set). The status VIEW mapping (remoteRuntimeStatusView /
 * RemoteRuntimeStatusView) stays LOCAL to this package's
 * src/client/gateway-runtime-api.ts (SettingsBridgeKey-keyed) and is not part
 * of the shared face.
 */

/** Same-origin client timeouts/kind for the gateway dsh-runtime surface
 *  (design 18 §9.3; the shared installer's 10-minute budget + delivery
 *  margin). Values match gateway-runtime.ts exactly. */
export const REMOTE_STATUS_POLL_INTERVAL_MS: number
export const REMOTE_STATUS_POLL_TIMEOUT_MS: number
export const GATEWAY_RUNTIME_STATUS_KIND: 'dsh-chamber-gateway-runtime'

export interface GatewayRuntimeApiDeps {
  fetchImpl?: typeof fetch
  sleepMs?: (ms: number) => Promise<void>
  pollIntervalMs?: number
  timeoutMs?: number
  signal?: AbortSignal
}

/** Gateway restart readiness polling deps (gateway-runtime-poll.ts). */
export interface GatewayPollDeps {
  fetchImpl?: typeof fetch
  sleepMs?: (ms: number) => Promise<void>
  timeoutMs?: number
  pollIntervalMs?: number
}

/** Instance-scoped request owners used by the gateway runtime section (kept
 *  structural so instance-switch cancellation is node-testable). */
export interface RemoteRuntimeActivityOwners {
  actionController: { current: AbortController | null }
  actionInFlight: { current: boolean }
  registryController: { current: AbortController | null }
  registryInFlight: { current: boolean }
}

/** Abort both request owners; returns the visible idle flags for the newly
 *  selected instance. */
export function resetRemoteRuntimeActivityOwners(owners: RemoteRuntimeActivityOwners): {
  actionBusy: false
  registryBusy: false
}

/** The two production callers have deliberately different terminal contracts:
 *  `select` only waits for the asynchronous install job, while `apply-now`
 *  must also observe the post-activation host recovery verdict. */
export type RemoteRuntimeSettleExpectation = 'select' | 'apply-now'

export type RemoteRuntimePhase =
  | 'installing'
  | 'pending'
  | 'applying'
  | 'snapshot-failed'
  | 'swap-attempted'
  | 'restore-blocked'
  | 'idle'
export type RemoteRuntimeSource = 'user-selected' | 'env' | 'builtin-anchor'
export type RemoteRestartOutcome = 'running' | 'ok' | 'failed'

export interface RemoteRuntimeFailure {
  version: string
  at: string
  reason: string
}

export interface RemoteRuntimeDiskUsage {
  versionTrees: number
  versionTreeBytes: number
  storeBytes: number
  cacheBytes: number
  installHomeBytes: number
  xdgCacheBytes: number
  workBytes: number
  failureBytes: number
  snapshotBytes: number
  preRollbackBytes: number
  restoreBackupBytes: number
  /** Unclassified residue bucket (D1-A real-byte accounting): entries under
   *  the runtime root that fall outside every known category. Required on the
   *  shared face — parseDiskUsage defaults it to 0 for older servers. */
  unclassifiedBytes: number
  totalBytes: number
  storePruneNeeded: boolean
}

export interface RemoteRuntimeProgress {
  stage: 'download' | 'install' | 'prune' | 'smoke' | 'publish' | 'done' | (string & {})
  received?: number
  total?: number | null
}

/** `GET /chamber/runtime/status` (design 18 §9.3) — verbatim projection
 *  (30 fields). */
export interface RemoteRuntimeStatus {
  kind: typeof GATEWAY_RUNTIME_STATUS_KIND
  activeVersion: string | null
  builtinVersion: string | null
  currentVersion: string | null
  selectedVersion: string | null
  hasOverride: boolean
  source: RemoteRuntimeSource | null
  phase: RemoteRuntimePhase
  startupBlockedReason: string | null
  pending: string | null
  connectionState: string | null
  registry: string | null
  registryError: string | null
  platform: string | null
  mutationsAllowed: boolean
  operationError: string | null
  restart: RemoteRestartOutcome | null
  restoreOutcome: string | null
  snapshotCount: number | null
  latestSnapshotAt: string | null
  snapshotError: string | null
  restoreInProgress: boolean | null
  preRollbackCount: number | null
  preRollbackLatestName: string | null
  failure: RemoteRuntimeFailure | null
  diskUsage: RemoteRuntimeDiskUsage | null
  diskError: string | null
  diskLimitBytes: number | null
  diskLimitExceeded: boolean | null
  progress: RemoteRuntimeProgress | null
  /** Desktop-shaped metadata health projection (recover-metadata parity):
   *  absent on pre-recovery servers — UI rows stay hidden. */
  metadataHealth?: 'unknown' | 'healthy' | 'selection-corrupt' | 'recovery-in-progress' | 'recovery-finalized' | 'recovery-marker-corrupt' | null
  metadataComponents?: string[]
  canRecoverMetadata?: boolean
}

export interface RemoteVersionEntry {
  version: string
  latest: boolean
  cached: boolean
  belowBaseline: boolean
}

/** `GET /chamber/runtime/versions` — the server's VersionListEntry list. */
export interface RemoteVersions {
  registryOrigin: string
  versions: RemoteVersionEntry[]
  /** Cleanup candidates (desktop parity): ledger entries the server would
   *  actually delete. Absent on older servers → empty (UI row hidden). */
  removableVersions: string[]
  error?: string
}

/** Known-enum arrays (exported by the shared core for the settings-bridge
 *  view mapping's fail-closed known-phase/source/restart guards). */
export const REMOTE_PHASES: readonly RemoteRuntimePhase[]
export const REMOTE_SOURCES: readonly RemoteRuntimeSource[]
export const REMOTE_RESTART: readonly RemoteRestartOutcome[]

/** Thrown for every remote runtime failure; `status` is the HTTP status when
 *  known (null for network errors), `code` the server's machine-readable code
 *  when one was projected. */
export class RemoteRuntimeApiError extends Error {
  readonly status: number | null
  readonly code: string | undefined

  constructor(message: string, status: number | null, code?: string)
}

export type RemoteRuntimeAction =
  | { kind: 'select'; version: string }
  | { kind: 'apply' }
  | { kind: 'rollback'; version: string }
  | { kind: 'cleanup-version'; version: string }
  | { kind: 'restore-pre-rollback'; stashName: string }
  | { kind: 'recover-metadata' }
  | { kind: 'restore-builtin' }
  | { kind: 'retry-apply' }
  | { kind: 'retry-restore' }
  | { kind: 'apply-now' }

export interface RemoteRuntimeActionResult {
  accepted: true
  status: number
}

export interface RemoteRuntimeActionGates {
  mutationDisabled: boolean
  restoreBuiltinDisabled: boolean
  retryApplyDisabled: boolean
  retryRestoreDisabled: boolean
  restartDisabled: boolean
  /** Apply-now (design 18 addendum §5.1/§6.1): the pending immediate-switch
   *  action mirrors the route's synchronous refusals — a plain pending with a
   *  live instance is enabled; busy tasks, recovery phases, env sources,
   *  read-only platforms and non-ready/degraded connection states disable it. */
  applyNowDisabled: boolean
}

/** Fetch + parse `GET /chamber/runtime/status` over the per-instance chamber
 *  proxy (the renderer never accepts a URL or a token — the desktop gateway
 *  transport injects Authorization after the request crossed the renderer
 *  boundary, design 17 §7.2/§12). */
export function fetchRemoteRuntimeStatus(
  chamberInstanceId: string,
  deps?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<RemoteRuntimeStatus>

export function fetchRemoteRuntimeVersions(
  chamberInstanceId: string,
  deps?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<RemoteVersions>

/** POST one runtime action (select/apply/rollback/restore-builtin/
 *  retry-apply/retry-restore/apply-now); 200/202 → accepted, 409/400 →
 *  rejection with the server's actionable `error` passed through verbatim,
 *  401/403/5xx/network → classified copy (never secrets). */
export function remoteRuntimeAction(
  chamberInstanceId: string,
  action: RemoteRuntimeAction,
  deps?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<RemoteRuntimeActionResult>

/** PUT the registry origin. */
export function remoteRuntimeSetRegistry(
  chamberInstanceId: string,
  origin: string,
  deps?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<{ origin: string }>

/** Pure UI mirror of the gateway's authoritative mutation fences (shared
 *  core; the settings-bridge runtime section consumes it from shared). */
export function remoteRuntimeActionGates(
  status: RemoteRuntimeStatus | null,
  clientBusy?: boolean,
): RemoteRuntimeActionGates

/** Poll `status` after a 202 action until the requested job settles
 *  (`select` = install contract; `apply-now` = post-activation recovery
 *  verdict). Interval/timeout are parameters (defaults 2s / 11min). */
export function pollRemoteRuntimeUntilSettled(
  chamberInstanceId: string,
  expectation: RemoteRuntimeSettleExpectation,
  deps?: GatewayRuntimeApiDeps,
): Promise<RemoteRuntimeStatus>

/** Parse the status payload (shared core). */
export function parseRemoteRuntimeStatus(value: unknown): RemoteRuntimeStatus

/** Parse the versions payload (shared core). */
export function parseRemoteVersions(value: unknown): RemoteVersions

/** Gateway restart readiness poll (design 18 §9.3: restart is 202 + status
 *  polling; shared core, gateway-runtime-poll.ts). Resolves once the
 *  connection is ready/degraded with a clean restart outcome; rejects on
 *  terminal states, config errors (fail fast) and timeout. */
export function pollGatewayReady(
  chamberInstanceId: string,
  signal?: AbortSignal,
  deps?: GatewayPollDeps,
): Promise<void>
