/**
 * Same-origin client for the gateway dsh-runtime management surface
 * (design 18 §3.6/§9.3, design 17 §3): `/api/i/gateway-<id>/chamber/runtime/*`.
 * Pure module (no JSX) with injectable fetch/sleep so the node test harness
 * can cover the status-view mapping, error classification and the settle poll.
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
 * `remoteRuntimeStatusView` derives ONLY from fields the server actually
 * projects (status contract, design 18 §9.3): phase / restart / operationError
 * / startupBlockedReason / pending. Nothing is invented.
 */
import type { SettingsBridgeKey } from '../locales.ts'

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
}

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
  error?: string
}

const REMOTE_PHASES: readonly RemoteRuntimePhase[] = [
  'installing', 'pending', 'applying', 'snapshot-failed', 'swap-attempted', 'restore-blocked', 'idle',
]
const REMOTE_SOURCES: readonly RemoteRuntimeSource[] = [
  'user-selected', 'env', 'builtin-anchor',
]
const REMOTE_RESTART: readonly RemoteRestartOutcome[] = ['running', 'ok', 'failed']
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
  })) as unknown as Omit<RemoteRuntimeDiskUsage, 'storePruneNeeded'>
  return { ...numbers, storePruneNeeded: booleanField(row, 'storePruneNeeded', 'runtime status.diskUsage') }
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

/** Enum field with a version-skew pass-through: an unknown value from a newer
 *  gateway is returned as-is (the status view treats unknown phases as idle)
 *  instead of failing the whole section. */
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
  // `allowed` is documented for the reader; unknown values pass through so a
  // newer gateway's enum additions never fail the whole section.
  void allowed
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
  }
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
  return {
    registryOrigin: stringField(row, 'registryOrigin', 'runtime versions'),
    versions,
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
  init: { method: 'GET' | 'POST' | 'PUT'; body?: unknown },
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
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<RemoteRuntimeStatus> {
  const { status, body } = await request(
    deps.fetchImpl ?? fetch,
    runtimePath(chamberInstanceId, 'status'),
    { method: 'GET' },
  )
  if (status === 200) return parseRemoteRuntimeStatus(body)
  throw classifiedError(status, body, 'runtime status')
}

export async function fetchRemoteRuntimeVersions(
  chamberInstanceId: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<RemoteVersions> {
  const { status, body } = await request(
    deps.fetchImpl ?? fetch,
    runtimePath(chamberInstanceId, 'versions'),
    { method: 'GET' },
  )
  if (status === 200) return parseRemoteVersions(body)
  throw classifiedError(status, body, 'runtime versions')
}

export type RemoteRuntimeAction =
  | { kind: 'select'; version: string }
  | { kind: 'apply' }
  | { kind: 'rollback'; version: string }
  | { kind: 'restore-builtin' }
  | { kind: 'retry-apply' }
  | { kind: 'retry-restore' }

export interface RemoteRuntimeActionResult {
  accepted: true
  status: number
}

function actionSuffix(action: RemoteRuntimeAction): string {
  switch (action.kind) {
    case 'select': return 'select'
    case 'apply': return 'apply'
    case 'rollback': return 'rollback'
    case 'restore-builtin': return 'restore-builtin'
    case 'retry-apply': return 'retry-apply'
    case 'retry-restore': return 'retry-restore'
  }
}

export async function remoteRuntimeAction(
  chamberInstanceId: string,
  action: RemoteRuntimeAction,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<RemoteRuntimeActionResult> {
  const body = action.kind === 'select' || action.kind === 'rollback'
    ? { version: action.version }
    : undefined
  const { status, body: payload } = await request(
    deps.fetchImpl ?? fetch,
    runtimePath(chamberInstanceId, actionSuffix(action)),
    { method: 'POST', ...(body !== undefined ? { body } : {}) },
  )
  if (status === 200 || status === 202) return { accepted: true, status }
  if (status === 409 || status === 400) throw rejectionError(status, payload)
  throw classifiedError(status, payload, `runtime action ${action.kind}`)
}

export async function remoteRuntimeSetRegistry(
  chamberInstanceId: string,
  origin: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<{ origin: string }> {
  const { status, body } = await request(
    deps.fetchImpl ?? fetch,
    runtimePath(chamberInstanceId, 'registry'),
    { method: 'PUT', body: { origin } },
  )
  if (status === 200) {
    const row = record(body, 'runtime registry')
    return { origin: stringField(row, 'origin', 'runtime registry') }
  }
  if (status === 400 || status === 409) throw rejectionError(status, body)
  throw classifiedError(status, body, 'runtime registry')
}

/** Render three-state projection of the remote status (design 18 §3.6
 *  status/文案口径 via the §9.3 status contract):
 *   - busy    = phase installing/applying or restart running;
 *   - failed  = operationError (failed async job) or terminal restart failed;
 *   - blocked = startupBlockedReason / restore-blocked / swap-attempted /
 *               snapshot-failed (blocked startup keeps the surface alive);
 *   - idle    = otherwise.
 * `titleKey` is a settings-bridge dictionary key; `params` feeds `t()`; a
 *  non-null `detail` is the server's verbatim copy to append. */
export interface RemoteRuntimeStatusView {
  kind: 'idle' | 'busy' | 'failed' | 'blocked'
  titleKey: SettingsBridgeKey
  params: Record<string, unknown> | undefined
  detail: string | null
}

export interface RemoteRuntimeActionGates {
  mutationDisabled: boolean
  restoreBuiltinDisabled: boolean
  restartDisabled: boolean
}

/** Pure UI mirror of the gateway's authoritative mutation fences. Pending
 * permits only restore-builtin; installing/applying/restart-in-flight permit
 * no runtime action. Restart remains a source-independent process refresh. */
export function remoteRuntimeActionGates(
  status: RemoteRuntimeStatus | null,
  clientBusy = false,
): RemoteRuntimeActionGates {
  if (status === null) {
    return { mutationDisabled: true, restoreBuiltinDisabled: true, restartDisabled: true }
  }
  const taskBusy = clientBusy
    || status.phase === 'installing'
    || status.phase === 'applying'
    || status.restart === 'running'
  const versionBaseBlocked = taskBusy || !status.mutationsAllowed || status.source === 'env'
  const pending = status.phase === 'pending'
  return {
    mutationDisabled: versionBaseBlocked || pending,
    restoreBuiltinDisabled: versionBaseBlocked,
    restartDisabled: taskBusy || pending
      || (status.connectionState !== 'ready' && status.connectionState !== 'degraded'),
  }
}

const BLOCKED_PHASES: ReadonlySet<RemoteRuntimePhase> = new Set([
  'snapshot-failed', 'swap-attempted', 'restore-blocked',
])

export function remoteRuntimeStatusView(status: RemoteRuntimeStatus): RemoteRuntimeStatusView {
  // Busy outranks everything: an in-flight apply/restart is the live state even
  // when a stale failure record lingers.
  if (status.phase === 'installing' || status.phase === 'applying' || status.restart === 'running') {
    return status.restart === 'running'
      ? { kind: 'busy', titleKey: 'dshRuntimeRemoteStatusRestarting', params: undefined, detail: null }
      : status.phase === 'installing'
        ? { kind: 'busy', titleKey: 'dshRuntimeProgressInstalling', params: undefined, detail: null }
      : { kind: 'busy', titleKey: 'dshRuntimeRemoteStatusApplying', params: { version: status.pending ?? '—' }, detail: null }
  }
  // Terminal restart failure or a failed async job surfaces with the server's
  // operationError copy (a restart that never reached ready must never render
  // as success).
  if (status.restart === 'failed' || (status.operationError !== null && status.operationError !== '')) {
    return {
      kind: 'failed',
      titleKey: 'dshRuntimeRemoteStatusFailed',
      params: { error: status.operationError ?? '—' },
      detail: null,
    }
  }
  // Blocked startup (design 18 §9.3: the runtime surface stays pollable while
  // the managed dsh is down). The phase names the resume route; the raw reason
  // (swap-attempted / restore-half / restore-incomplete / snapshot-failed /
  // journal-corrupt / journal-mismatch) is appended verbatim.
  if (BLOCKED_PHASES.has(status.phase) || (status.startupBlockedReason !== null && status.startupBlockedReason !== '')) {
    const titleKey = status.phase === 'swap-attempted'
      ? 'dshRuntimeRemoteStatusSwapAttempted'
      : status.phase === 'snapshot-failed'
        ? 'dshRuntimeRemoteStatusSnapshotFailed'
        : status.phase === 'restore-blocked'
          ? 'dshRuntimeRemoteStatusRestoreBlocked'
          : 'dshRuntimeRemoteStatusBlocked'
    return { kind: 'blocked', titleKey, params: undefined, detail: status.startupBlockedReason }
  }
  if (status.phase === 'pending') {
    return { kind: 'idle', titleKey: 'dshRuntimeStatusPending', params: { version: status.pending ?? '—' }, detail: null }
  }
  return { kind: 'idle', titleKey: 'dshRuntimeRemoteStatusIdle', params: undefined, detail: null }
}

/** Poll `status` after a 202 action until the job settles — phase left
 *  'installing'/'applying' AND restart left 'running' — or fails/timeouts honestly.
 *  A terminal failure (restart failed / operationError set at settle) rejects
 *  with the server's copy; a timeout rejects with an honest timeout message.
 *  Interval/timeout are parameters (defaults 2s / 11min, matching the shared
 *  installer's 10-minute deadline plus a delivery margin). */
export async function pollRemoteRuntimeUntilSettled(
  chamberInstanceId: string,
  deps: GatewayRuntimeApiDeps = {},
): Promise<RemoteRuntimeStatus> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleepMs ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  const pollIntervalMs = deps.pollIntervalMs ?? REMOTE_STATUS_POLL_INTERVAL_MS
  const timeoutMs = deps.timeoutMs ?? REMOTE_STATUS_POLL_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await fetchRemoteRuntimeStatus(chamberInstanceId, { fetchImpl })
    if (status.phase !== 'installing' && status.phase !== 'applying' && status.restart !== 'running') {
      if (status.restart === 'failed') {
        throw new RemoteRuntimeApiError(`runtime action failed: ${status.operationError ?? 'unknown runtime failure'}`, 200)
      }
      if (status.operationError !== null && status.operationError !== '') {
        throw new RemoteRuntimeApiError(`runtime action failed: ${status.operationError}`, 200)
      }
      return status
    }
    await sleep(pollIntervalMs)
  }
  throw new RemoteRuntimeApiError('runtime action accepted but the gateway did not settle in time', null)
}
