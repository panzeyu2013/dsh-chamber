/**
 * Same-origin client core for the gateway dsh-runtime management surface
 * (design 18 §3.6/§9.3, design 17 §3): `/api/i/gateway-<id>/chamber/runtime/*`.
 * Pure module (no JSX) with injectable fetch/sleep so the node test harness
 * can cover the parsers, error classification, the action gates and the
 * settle poll.
 *
 * Design 21 §5.2 split: this file is the pure core moved OUT of the
 * settings-bridge gateway-runtime-api.ts into the sidebar package's shared
 * face. It is consumed by the settings-bridge (and later the connections
 * plugin) through `@dsh-chamber/dsh-client-ui-sidebar/shared`; the
 * render/view mapping (`remoteRuntimeStatusView` + `RemoteRuntimeStatusView`)
 * stays in settings-bridge because it carries the bridge's UI dictionary
 * keys. This file has NO locale/dictionary dependency of any kind.
 *
 * The renderer is given only the canonical chamber instance id and derives the
 * path locally — it never accepts a URL or a token (design 17 §7.2/§12
 * discipline; the desktop gateway transport injects Authorization after the
 * request has crossed the renderer boundary).
 *
 * Action failure classification:
 *   - 202/200 → accepted;
 *   - 409/400 → business rejection — the server's `error` text is ACTIONABLE
 *     copy and is passed through verbatim with its machine-readable `code`;
 *   - 401/403/5xx / network → generic classified copy (never secrets).
 *
 * Every projection here derives ONLY from fields the server actually projects
 * (status contract, design 18 §9.3): phase / restart / operationError /
 * startupBlockedReason / pending. Nothing is invented.
 */

export const REMOTE_STATUS_POLL_INTERVAL_MS = 2_000
// The shared installer has one 10-minute wall-clock budget. A legitimate slow
// install must not be reported as timed out while its background job is still
// authoritative, so the settle poll leaves a one-minute delivery margin.
export const REMOTE_STATUS_POLL_TIMEOUT_MS = 11 * 60_000
export const GATEWAY_RUNTIME_STATUS_KIND = 'dsh-chamber-gateway-runtime' as const

export interface GatewayRuntimeApiDeps {
  fetchImpl?: typeof fetch
  sleepMs?: (ms: number) => Promise<void>
  pollIntervalMs?: number
  timeoutMs?: number
  signal?: AbortSignal
}

/** Instance-scoped request owners used by the gateway runtime section. Kept
 * structural (rather than React-specific) so instance-switch cancellation is
 * covered by the pure node test harness. */
export interface RemoteRuntimeActivityOwners {
  actionController: { current: AbortController | null }
  actionInFlight: { current: boolean }
  registryController: { current: AbortController | null }
  registryInFlight: { current: boolean }
}

export function resetRemoteRuntimeActivityOwners(owners: RemoteRuntimeActivityOwners): {
  actionBusy: false
  registryBusy: false
} {
  owners.actionController.current?.abort()
  owners.actionController.current = null
  owners.actionInFlight.current = false
  owners.registryController.current?.abort()
  owners.registryController.current = null
  owners.registryInFlight.current = false
  return { actionBusy: false, registryBusy: false }
}

/** The two production callers have deliberately different terminal contracts:
 * `select` only waits for the asynchronous install job, while `apply-now`
 * must also observe the post-activation host recovery verdict from design 18
 * addendum §5.2. Keeping the expectation explicit prevents persistent
 * diagnostic history (`failure`) from turning an unrelated select into a
 * false failure. */
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
  /** Deduped bytes inside the runtime root not owned by any known category
   *  (D1-A real-byte accounting). Older servers omit it — parseDiskUsage
   *  defaults to 0. */
  unclassifiedBytes: number
  totalBytes: number
  storePruneNeeded: boolean
}

export interface RemoteRuntimeProgress {
  stage: 'download' | 'install' | 'prune' | 'smoke' | 'publish' | 'done' | (string & {})
  received?: number
  total?: number | null
}

/** `GET /chamber/runtime/status` (design 18 §9.3) — verbatim projection. */
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
  /** Desktop-shaped metadata health projection (2026-12 recover-metadata
   *  parity). Absent on pre-recovery servers — UI rows stay hidden. */
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
  /** Cleanup candidates (2026-12 desktop parity): ledger entries the server
   *  would actually delete. Absent on older servers → empty (UI row hidden). */
  removableVersions: string[]
  error?: string
}

export const REMOTE_PHASES: readonly RemoteRuntimePhase[] = [
  'installing', 'pending', 'applying', 'snapshot-failed', 'swap-attempted', 'restore-blocked', 'idle',
]
export const REMOTE_SOURCES: readonly RemoteRuntimeSource[] = [
  'user-selected', 'env', 'builtin-anchor',
]
export const REMOTE_RESTART: readonly RemoteRestartOutcome[] = ['running', 'ok', 'failed']
const METADATA_HEALTHS = [
  'unknown', 'healthy', 'selection-corrupt', 'recovery-in-progress', 'recovery-finalized', 'recovery-marker-corrupt',
] as const
const METADATA_COMPONENTS: readonly string[] = [
  'current', 'override', 'activation-journal', 'recovery-marker', 'retained-evidence',
]
const GATEWAY_SOURCE_ID = /^gateway-[a-zA-Z0-9_-]{1,64}$/

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Gateway returned malformed ${label}`)
  }
  return value as Record<string, unknown>
}

function nullableString(row: Record<string, unknown>, key: string, label: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`Gateway returned malformed ${label}.${key}`)
  return value
}

function stringField(row: Record<string, unknown>, key: string, label: string): string {
  const value = nullableString(row, key, label)
  if (value === null || value === '') throw new Error(`Gateway returned malformed ${label}.${key}`)
  return value
}

function booleanField(row: Record<string, unknown>, key: string, label: string): boolean {
  const value = row[key]
  if (typeof value !== 'boolean') throw new Error(`Gateway returned malformed ${label}.${key}`)
  return value
}

function booleanOr(
  row: Record<string, unknown>,
  key: string,
  fallback: boolean,
  label: string,
): boolean {
  const value = row[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') throw new Error(`Gateway returned malformed ${label}.${key}`)
  return value
}

function nullableBoolean(row: Record<string, unknown>, key: string, label: string): boolean | null {
  const value = row[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') throw new Error(`Gateway returned malformed ${label}.${key}`)
  return value
}

function nullableNumber(row: Record<string, unknown>, key: string, label: string): number | null {
  const value = row[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Gateway returned malformed ${label}.${key}`)
  }
  return value
}

function parseFailure(value: unknown): RemoteRuntimeFailure | null {
  if (value === undefined || value === null) return null
  const row = record(value, 'runtime status.failure')
  return {
    version: stringField(row, 'version', 'runtime status.failure'),
    at: stringField(row, 'at', 'runtime status.failure'),
    reason: stringField(row, 'reason', 'runtime status.failure'),
  }
}

const DISK_NUMBER_FIELDS = [
  'versionTrees', 'versionTreeBytes', 'storeBytes', 'cacheBytes', 'installHomeBytes',
  'xdgCacheBytes', 'workBytes', 'failureBytes', 'snapshotBytes', 'preRollbackBytes',
  'restoreBackupBytes', 'totalBytes',
] as const

function parseDiskUsage(value: unknown): RemoteRuntimeDiskUsage | null {
  if (value === undefined || value === null) return null
  const row = record(value, 'runtime status.diskUsage')
  const numbers = Object.fromEntries(DISK_NUMBER_FIELDS.map((key) => {
    const parsed = nullableNumber(row, key, 'runtime status.diskUsage')
    if (parsed === null) throw new Error(`Gateway returned malformed runtime status.diskUsage.${key}`)
    return [key, parsed]
  })) as unknown as Omit<RemoteRuntimeDiskUsage, 'storePruneNeeded' | 'unclassifiedBytes'>
  // Old servers (pre-D1-A) omit unclassifiedBytes — default the bucket to 0.
  const unclassifiedBytes = nullableNumber(row, 'unclassifiedBytes', 'runtime status.diskUsage') ?? 0
  return { ...numbers, unclassifiedBytes, storePruneNeeded: booleanField(row, 'storePruneNeeded', 'runtime status.diskUsage') }
}

function parseProgress(value: unknown): RemoteRuntimeProgress | null {
  if (value === undefined || value === null) return null
  const row = record(value, 'runtime status.progress')
  const stage = stringField(row, 'stage', 'runtime status.progress') as RemoteRuntimeProgress['stage']
  const received = nullableNumber(row, 'received', 'runtime status.progress')
  const total = nullableNumber(row, 'total', 'runtime status.progress')
  return {
    stage,
    ...(received !== null ? { received } : {}),
    ...(row.total !== undefined ? { total } : {}),
  }
}

/** Parse a safety-relevant status enum. Missing fields retain their explicit
 * backward-compatible fallback, but a newer unknown value fails closed: an
 * old client must not turn an unrecognised busy/recovery/source state into
 * idle and enable mutations. */
function enumOr<T extends string>(
  row: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T | null,
  label: string,
): T | null {
  const value = row[key]
  if (value === null || value === undefined) return fallback
  if (typeof value !== 'string') throw new Error(`Gateway returned malformed ${label}.${key}`)
  if (!allowed.includes(value as T)) {
    throw new Error(`Gateway returned unsupported ${label}.${key}: ${value}`)
  }
  return value as T
}

/** Non-nullable enum field: the fallback is a real value, so the result is
 *  never null (phase in the status contract). */
function enumField<T extends string>(
  row: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
  label: string,
): T {
  return enumOr(row, key, allowed, fallback, label) as T
}

export function parseRemoteRuntimeStatus(value: unknown): RemoteRuntimeStatus {
  const row = record(value, 'runtime status')
  if (row.kind !== GATEWAY_RUNTIME_STATUS_KIND) {
    throw new Error('Gateway returned malformed runtime status.kind')
  }
  return {
    kind: GATEWAY_RUNTIME_STATUS_KIND,
    activeVersion: nullableString(row, 'activeVersion', 'runtime status'),
    builtinVersion: nullableString(row, 'builtinVersion', 'runtime status'),
    currentVersion: nullableString(row, 'currentVersion', 'runtime status'),
    selectedVersion: nullableString(row, 'selectedVersion', 'runtime status'),
    hasOverride: booleanOr(row, 'hasOverride', false, 'runtime status'),
    source: enumOr(row, 'source', REMOTE_SOURCES, null, 'runtime status'),
    phase: enumField(row, 'phase', REMOTE_PHASES, 'idle', 'runtime status'),
    startupBlockedReason: nullableString(row, 'startupBlockedReason', 'runtime status'),
    pending: nullableString(row, 'pending', 'runtime status'),
    connectionState: nullableString(row, 'connectionState', 'runtime status'),
    registry: nullableString(row, 'registry', 'runtime status'),
    registryError: nullableString(row, 'registryError', 'runtime status'),
    platform: nullableString(row, 'platform', 'runtime status'),
    // A gateway predating the win32 read-only gate projects no field; version
    // mutations were allowed then, so absence defaults to true — never a fake
    // block against an older server.
    mutationsAllowed: booleanOr(row, 'mutationsAllowed', true, 'runtime status'),
    operationError: nullableString(row, 'operationError', 'runtime status'),
    // Version-skew fallback: older gateways without the restart-outcome field
    // project null; the restart poll keeps its connectionState contract.
    restart: enumOr(row, 'restart', REMOTE_RESTART, null, 'runtime status'),
    restoreOutcome: nullableString(row, 'restoreOutcome', 'runtime status'),
    snapshotCount: nullableNumber(row, 'snapshotCount', 'runtime status'),
    latestSnapshotAt: nullableString(row, 'latestSnapshotAt', 'runtime status'),
    snapshotError: nullableString(row, 'snapshotError', 'runtime status'),
    restoreInProgress: nullableBoolean(row, 'restoreInProgress', 'runtime status'),
    preRollbackCount: nullableNumber(row, 'preRollbackCount', 'runtime status'),
    preRollbackLatestName: nullableString(row, 'preRollbackLatestName', 'runtime status'),
    failure: parseFailure(row.failure),
    diskUsage: parseDiskUsage(row.diskUsage),
    diskError: nullableString(row, 'diskError', 'runtime status'),
    diskLimitBytes: nullableNumber(row, 'diskLimitBytes', 'runtime status'),
    diskLimitExceeded: nullableBoolean(row, 'diskLimitExceeded', 'runtime status'),
    progress: parseProgress(row.progress),
    // Metadata health (2026-12): absent/unknown values are advisory — they
    // only control the rescue rows, so an unrecognised future status fails
    // closed to absent rather than to a mutable idle.
    metadataHealth: enumOr(row, 'metadataHealth', METADATA_HEALTHS, null, 'runtime status'),
    metadataComponents: parseMetadataComponents(row.metadataComponents),
    canRecoverMetadata: booleanOr(row, 'canRecoverMetadata', false, 'runtime status'),
  }
}

function parseMetadataComponents(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('Gateway returned malformed runtime status.metadataComponents')
  for (const entry of value) {
    if (typeof entry !== 'string' || !METADATA_COMPONENTS.includes(entry)) {
      throw new Error('Gateway returned malformed runtime status.metadataComponents')
    }
  }
  return value as string[]
}

export function parseRemoteVersions(value: unknown): RemoteVersions {
  const row = record(value, 'runtime versions')
  if (!Array.isArray(row.versions)) throw new Error('Gateway returned malformed runtime versions.versions')
  const versions = row.versions.map((entry) => {
    const item = record(entry, 'runtime version entry')
    return {
      version: stringField(item, 'version', 'runtime version entry'),
      latest: booleanField(item, 'latest', 'runtime version entry'),
      cached: booleanField(item, 'cached', 'runtime version entry'),
      belowBaseline: booleanField(item, 'belowBaseline', 'runtime version entry'),
    }
  })
  const error = nullableString(row, 'error', 'runtime versions')
  // Cleanup candidates (2026-12): a pre-cleanup server projects no field →
  // empty list (UI row hidden); a malformed present field fails closed.
  const removable = row.removableVersions
  if (removable === undefined || removable === null) {
    return {
      registryOrigin: stringField(row, 'registryOrigin', 'runtime versions'),
      versions,
      removableVersions: [],
      ...(error !== null ? { error } : {}),
    }
  }
  if (!Array.isArray(removable)) throw new Error('Gateway returned malformed runtime versions.removableVersions')
  for (const entry of removable) {
    if (typeof entry !== 'string' || entry === '') {
      throw new Error('Gateway returned malformed runtime versions.removableVersions')
    }
  }
  return {
    registryOrigin: stringField(row, 'registryOrigin', 'runtime versions'),
    versions,
    removableVersions: removable as string[],
    ...(error !== null ? { error } : {}),
  }
}

/** Thrown for every remote runtime failure; `status` is the HTTP status when
 *  known (null for network errors), `code` the server's machine-readable code
 *  when one was projected. */
export class RemoteRuntimeApiError extends Error {
  readonly status: number | null
  readonly code: string | undefined

  constructor(message: string, status: number | null, code?: string) {
    super(message)
    this.name = 'RemoteRuntimeApiError'
    this.status = status
    this.code = code
  }
}

function readErrorPayload(body: unknown): { error: string | null; code: string | undefined } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { error: null, code: undefined }
  }
  const row = body as Record<string, unknown>
  return {
    error: typeof row.error === 'string' && row.error !== '' ? row.error : null,
    code: typeof row.code === 'string' ? row.code : undefined,
  }
}

/** Generic classified copy for 401/403/5xx and unknown statuses (no secrets). */
function classifiedError(status: number, body: unknown, surface: string): RemoteRuntimeApiError {
  const { error, code } = readErrorPayload(body)
  const detail = error !== null ? `: ${error}` : ''
  if (status === 401) {
    return new RemoteRuntimeApiError(`${surface} unauthorized (401) — check the gateway connection`, status, code)
  }
  if (status === 403) {
    return new RemoteRuntimeApiError(`${surface} refused (403)${detail}`, status, code)
  }
  if (status === 404) {
    return new RemoteRuntimeApiError(`${surface} unavailable (404) — the gateway does not expose /chamber/runtime`, status, code)
  }
  if (status >= 500) {
    return new RemoteRuntimeApiError(`${surface} service error (${status})${detail}`, status, code)
  }
  return new RemoteRuntimeApiError(`${surface} failed (HTTP ${status})${detail}`, status, code)
}

/** Business rejection (409/400): the server's `error` is actionable copy and
 *  is passed through verbatim with its code (design 18 §9.3 refusal table). */
function rejectionError(status: number, body: unknown): RemoteRuntimeApiError {
  const { error, code } = readErrorPayload(body)
  return new RemoteRuntimeApiError(error ?? `runtime request refused (${status})`, status, code)
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  init: { method: 'GET' | 'POST' | 'PUT'; body?: unknown; signal?: AbortSignal },
): Promise<{ status: number; body: unknown }> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: init.method,
      headers: {
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      cache: 'no-store',
      credentials: 'same-origin',
      ...(init.signal !== undefined ? { signal: init.signal } : {}),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new RemoteRuntimeApiError(`cannot reach the gateway runtime surface: ${message}`, null)
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  return { status: response.status, body }
}

function runtimePath(chamberInstanceId: string, suffix: string): string {
  if (!GATEWAY_SOURCE_ID.test(chamberInstanceId)) {
    throw new Error(`Invalid gateway chamber instance id ${JSON.stringify(chamberInstanceId)}`)
  }
  return `/api/i/${chamberInstanceId}/chamber/runtime/${suffix}`
}

export async function fetchRemoteRuntimeStatus(
  chamberInstanceId: string,
  deps: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<RemoteRuntimeStatus> {
  const { status, body } = await request(
    deps.fetchImpl ?? fetch,
    runtimePath(chamberInstanceId, 'status'),
    { method: 'GET', ...(deps.signal !== undefined ? { signal: deps.signal } : {}) },
  )
  if (status === 200) return parseRemoteRuntimeStatus(body)
  throw classifiedError(status, body, 'runtime status')
}

export async function fetchRemoteRuntimeVersions(
  chamberInstanceId: string,
  deps: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<RemoteVersions> {
  const { status, body } = await request(
    deps.fetchImpl ?? fetch,
    runtimePath(chamberInstanceId, 'versions'),
    { method: 'GET', ...(deps.signal !== undefined ? { signal: deps.signal } : {}) },
  )
  if (status === 200) return parseRemoteVersions(body)
  throw classifiedError(status, body, 'runtime versions')
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

function actionSuffix(action: RemoteRuntimeAction): string {
  switch (action.kind) {
    case 'select': return 'select'
    case 'apply': return 'apply'
    case 'rollback': return 'rollback'
    case 'cleanup-version': return 'cleanup-version'
    case 'restore-pre-rollback': return 'restore-pre-rollback'
    case 'recover-metadata': return 'recover-metadata'
    case 'restore-builtin': return 'restore-builtin'
    case 'retry-apply': return 'retry-apply'
    case 'retry-restore': return 'retry-restore'
    case 'apply-now': return 'apply-now'
  }
}

export async function remoteRuntimeAction(
  chamberInstanceId: string,
  action: RemoteRuntimeAction,
  deps: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<RemoteRuntimeActionResult> {
  const body = action.kind === 'select' || action.kind === 'rollback' || action.kind === 'cleanup-version'
    ? { version: action.version }
    : action.kind === 'restore-pre-rollback'
      ? { stashName: action.stashName }
      : undefined
  const { status, body: payload } = await request(
    deps.fetchImpl ?? fetch,
    runtimePath(chamberInstanceId, actionSuffix(action)),
    { method: 'POST', ...(body !== undefined ? { body } : {}), ...(deps.signal !== undefined ? { signal: deps.signal } : {}) },
  )
  if (status === 200 || status === 202) return { accepted: true, status }
  if (status === 409 || status === 400) throw rejectionError(status, payload)
  throw classifiedError(status, payload, `runtime action ${action.kind}`)
}

export async function remoteRuntimeSetRegistry(
  chamberInstanceId: string,
  origin: string,
  deps: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ origin: string }> {
  const { status, body } = await request(
    deps.fetchImpl ?? fetch,
    runtimePath(chamberInstanceId, 'registry'),
    { method: 'PUT', body: { origin }, ...(deps.signal !== undefined ? { signal: deps.signal } : {}) },
  )
  if (status === 200) {
    const row = record(body, 'runtime registry')
    return { origin: stringField(row, 'origin', 'runtime registry') }
  }
  if (status === 400 || status === 409) throw rejectionError(status, body)
  throw classifiedError(status, body, 'runtime registry')
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

/** Pure UI mirror of the gateway's authoritative mutation fences. Pending
 * permits only restore-builtin. A durable recovery phase permits only its
 * exact retry plus restore-builtin; ordinary mutations and restart remain
 * locked. Installing/applying/restart-in-flight permit no runtime action. */
export function remoteRuntimeActionGates(
  status: RemoteRuntimeStatus | null,
  clientBusy = false,
): RemoteRuntimeActionGates {
  if (status === null) {
    return {
      mutationDisabled: true,
      restoreBuiltinDisabled: true,
      retryApplyDisabled: true,
      retryRestoreDisabled: true,
      restartDisabled: true,
      applyNowDisabled: true,
    }
  }
  // Defense in depth for callers constructing a status object without the
  // wire parser: unknown future enums are never interpreted as an idle,
  // mutable state.
  const knownPhase = (REMOTE_PHASES as readonly string[]).includes(status.phase)
  const knownSource = status.source === null || (REMOTE_SOURCES as readonly string[]).includes(status.source)
  const knownRestart = status.restart === null || (REMOTE_RESTART as readonly string[]).includes(status.restart)
  const unsupported = !knownPhase || !knownSource || !knownRestart
  const taskBusy = clientBusy || unsupported
    || status.phase === 'installing'
    || status.phase === 'applying'
    || status.restart === 'running'
  const versionBaseBlocked = taskBusy || !status.mutationsAllowed || status.source === 'env'
  const applyRecovery = status.phase === 'swap-attempted' || status.phase === 'snapshot-failed'
  const restoreRecovery = status.phase === 'restore-blocked'
  const recovery = applyRecovery || restoreRecovery
  // Recovery phase wins over a lingering pending value, matching the route's
  // explicit-recovery precedence (design 18 §9.3).
  const pending = !recovery && (status.phase === 'pending' || status.pending !== null)
  return {
    mutationDisabled: versionBaseBlocked || pending || recovery,
    restoreBuiltinDisabled: versionBaseBlocked,
    retryApplyDisabled: versionBaseBlocked || !applyRecovery,
    retryRestoreDisabled: versionBaseBlocked || !restoreRecovery,
    restartDisabled: taskBusy || pending || recovery
      || (status.connectionState !== 'ready' && status.connectionState !== 'degraded'),
    // The route refuses apply-now with 409 connection_busy while the managed
    // dsh is not live; the UI mirrors the same ready/degraded check as
    // restart (design 18 addendum §5.1).
    applyNowDisabled: versionBaseBlocked || !pending
      || (status.connectionState !== 'ready' && status.connectionState !== 'degraded'),
  }
}

/** Poll `status` after a 202 action until the requested job settles.
 *
 * `select` preserves the install contract: once the generic busy markers have
 * cleared, only the action's operation/restart outcome can fail the poll.
 * Historical activation diagnostics are deliberately ignored.
 *
 * `apply-now` follows design 18 addendum §5.2: leaving `applying` is not by
 * itself success because the manager closes activation quarantine before its
 * recovery `startLocal()` finishes. Success additionally requires a live
 * ready/degraded connection and no current operation/startup block;
 * half/incomplete (or an unknown non-success) restore outcome is terminal
 * failure. Historical `failure` records are diagnostics, not the outcome of
 * this accepted action. The poll keeps waiting through the honest
 * stopped/starting recovery window.
 *
 * Interval/timeout are parameters (defaults 2s / 11min, matching the shared
 * installer's 10-minute deadline plus a delivery margin). */
export async function pollRemoteRuntimeUntilSettled(
  chamberInstanceId: string,
  expectation: RemoteRuntimeSettleExpectation,
  deps: GatewayRuntimeApiDeps = {},
): Promise<RemoteRuntimeStatus> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleepMs ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  const pollIntervalMs = deps.pollIntervalMs ?? REMOTE_STATUS_POLL_INTERVAL_MS
  const timeoutMs = deps.timeoutMs ?? REMOTE_STATUS_POLL_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, Math.max(0, timeoutMs))
  const cancel = (): void => controller.abort()
  if (deps.signal?.aborted === true) cancel()
  else deps.signal?.addEventListener('abort', cancel, { once: true })

  const wait = async (): Promise<void> => {
    if (controller.signal.aborted) {
      throw new RemoteRuntimeApiError('runtime action polling was cancelled', null, 'aborted')
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(new RemoteRuntimeApiError('runtime action polling was cancelled', null, 'aborted'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
      const finish = (): void => {
        controller.signal.removeEventListener('abort', onAbort)
      }
      void sleep(pollIntervalMs).then(
        () => { finish(); resolve() },
        (error) => { finish(); reject(error) },
      )
    })
  }

  try {
    while (Date.now() < deadline) {
      const status = await fetchRemoteRuntimeStatus(chamberInstanceId, { fetchImpl, signal: controller.signal })
      if (status.phase !== 'installing' && status.phase !== 'applying' && status.restart !== 'running') {
        if (expectation === 'apply-now') {
          const failure = status.startupBlockedReason !== null && status.startupBlockedReason !== ''
            ? status.startupBlockedReason
            : status.operationError !== null && status.operationError !== ''
              ? status.operationError
              : status.restoreOutcome !== null
                && status.restoreOutcome !== 'none'
                && status.restoreOutcome !== 'complete'
                ? `runtime restore ended with ${status.restoreOutcome}`
                : null
          if (failure !== null) {
            throw new RemoteRuntimeApiError(`runtime action failed: ${failure}`, 200)
          }
          if (status.connectionState !== 'ready' && status.connectionState !== 'degraded') {
            await wait()
            continue
          }
          return status
        }
        if (status.restart === 'failed') {
          throw new RemoteRuntimeApiError(`runtime action failed: ${status.operationError ?? 'unknown runtime failure'}`, 200)
        }
        if (status.operationError !== null && status.operationError !== '') {
          throw new RemoteRuntimeApiError(`runtime action failed: ${status.operationError}`, 200)
        }
        return status
      }
      await wait()
    }
  } catch (error) {
    if (timedOut) {
      throw new RemoteRuntimeApiError('runtime action accepted but the gateway did not settle in time', null)
    }
    if (deps.signal?.aborted === true) {
      throw new RemoteRuntimeApiError('runtime action polling was cancelled', null, 'aborted')
    }
    throw error
  } finally {
    clearTimeout(timeout)
    deps.signal?.removeEventListener('abort', cancel)
  }
  throw new RemoteRuntimeApiError('runtime action accepted but the gateway did not settle in time', null)
}

