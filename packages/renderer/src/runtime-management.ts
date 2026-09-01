/**
 * Page-wide dsh runtime-management projection (design 18 §3.6).
 *
 * This module is deliberately browser-framework-free. It is the shared
 * contract used by the settings runtime block and the connections local-card
 * spawn gate, and it can be exercised with plain node:test. The main process
 * remains authoritative for every transition and action; this layer only
 * projects that state into visible actions/status and owns the single renderer
 * subscription to the preload bridge.
 */

export type RuntimePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'pending'
  | 'applying'
  | 'applied'
  | 'rollback'
  | 'snapshot-failed'
  | 'failed'
  | 'error'

export type RuntimeRestoreOutcome = 'none' | 'complete' | 'half' | 'incomplete'

export interface RuntimeVersionEntry {
  version: string
  latest: boolean
  cached: boolean
  belowBaseline: boolean
}

export interface RuntimeFailure {
  version: string
  at: string
  reason: string
}

export interface RuntimeInvalidationNotice {
  at: string
  reason: string
  fromVersion: string | null
  recovered: boolean
}

export type RuntimeMetadataHealth =
  | 'unknown'
  | 'healthy'
  | 'selection-corrupt'
  | 'recovery-in-progress'
  | 'recovery-finalized'
  | 'recovery-marker-corrupt'

export type RuntimeMetadataComponent =
  | 'current'
  | 'override'
  | 'activation-journal'
  | 'recovery-marker'
  | 'retained-evidence'

export interface RuntimeDiskUsage {
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

/** Non-secret state projected by the desktop runtime controller. */
export interface RuntimeState {
  active: string | null
  bundled: string | null
  source: 'bundled' | 'user' | 'env'
  latest: string | null
  versions: RuntimeVersionEntry[]
  pending: string | null
  phase: RuntimePhase
  error: string | null
  /** Live control-plane connection state (ready/degraded/…) projected by main.
   *  Absent (older main) means no connectionState gate is enforced. */
  connectionState?: string
  /** Version being installed/applied when it differs from active/pending. */
  targetVersion?: string | null
  /** Version active before the pending swap. */
  sourceVersion?: string | null
  /** Runtime selected by the automatic/manual rollback path. */
  rollbackTarget?: string | null
  /** Data-restore result is tracked independently from the runtime-tree result. */
  restoreOutcome?: RuntimeRestoreOutcome
  snapshotCount?: number
  latestSnapshotAt?: string | null
  snapshotError?: string | null
  /** Number of safe pre-rollback stashes; absence/0 means none exist. */
  preRollbackCount?: number
  /** Newest safe stash basename (never a userData path). */
  preRollbackLatestName?: string | null
  /** Explicit main-process capabilities; absence/false means no visible retry. */
  canRetryApply?: boolean
  canRetryRestore?: boolean
  /** Authoritative privileged-process local-spawn gate and safe public reason. */
  runtimeBlocked?: boolean
  runtimeBlockedReason?: string | null
  swapAttempted?: boolean
  failure?: RuntimeFailure | null
  /** Persistent shell-update fallback/reactivation record. */
  invalidationNotice?: RuntimeInvalidationNotice | null
  diskUsage?: RuntimeDiskUsage | null
  diskError?: string | null
  diskLimitBytes?: number
  diskLimitExceeded?: boolean | null
  explicitlyInstalledVersions?: string[]
  /** Persisted override exists even if env/bundled currently wins. */
  hasOverride?: boolean
  /** False means version management is a read-only projection on this platform. */
  managementSupported?: boolean
  managementUnsupportedReason?: string | null
  metadataHealth?: RuntimeMetadataHealth
  /** Category-only evidence projection; never a filesystem basename/path. */
  metadataComponents?: RuntimeMetadataComponent[]
  canRecoverMetadata?: boolean
  /** Live install progress (design 18 M4 bar): download bytes + stage
   * milestones while an install runs; null when idle. */
  progress?: RuntimeInstallProgress | null
}

/** Mirror of the main-process RuntimeInstallProgress (write-only projection;
 * the renderer never sends progress back). */
export interface RuntimeInstallProgress {
  stage: 'download' | 'install' | 'prune' | 'smoke' | 'publish' | 'done'
  received?: number
  total?: number | null
}

export interface RuntimeSurface {
  state(): Promise<RuntimeState>
  check(): Promise<RuntimeState>
  install(version: string): Promise<RuntimeState>
  resetBuiltin(): Promise<RuntimeState>
  /** Apply the pending version in the current session (design 18 addendum
   *  §2.1): runs the existing activation transaction immediately instead of
   *  waiting for the next launch. Main gates + native confirmation apply. */
  applyNow(): Promise<RuntimeState>
  retryApply(): Promise<RuntimeState>
  retryRestore(): Promise<RuntimeState>
  /** No renderer-controlled path/version input is accepted. */
  recoverMetadata(): Promise<RuntimeState>
  cleanupVersion(version: string): Promise<RuntimeState>
  /** Restore the newest pre-rollback stash over DSH_HOME (main-validated name). */
  restorePreRollback(stashName: string): Promise<RuntimeState>
  /** Transactional managed-dsh restart (design 18 §3.6 项 8): refreshes mounted
   *  plugins; the pointer/version tree is untouched. */
  restart(): Promise<RuntimeState>
  onChanged(callback: (state: RuntimeState) => void): () => void
}

export type RuntimeAction =
  | 'check'
  | 'select-version'
  | 'install'
  | 'apply-now'
  | 'reset-builtin'
  | 'retry-apply'
  | 'retry-restore'
  | 'cleanup-version'
  | 'recover-metadata'
  | 'restore-pre-rollback'
  | 'restart-dsh'

/**
 * The strict visible-action matrix. Busy phases expose no mutation; pending
 * exposes the immediate-apply action plus the reset escape hatch, applying
 * exposes only the escape hatch required by design 18. Retry actions are
 * added separately from explicit controller capability bits.
 */
const BASE_ACTIONS: Record<RuntimePhase, readonly RuntimeAction[]> = {
  idle: ['check', 'restore-pre-rollback', 'select-version', 'install', 'cleanup-version', 'reset-builtin', 'restart-dsh'],
  checking: [],
  available: ['check', 'select-version', 'install', 'cleanup-version', 'reset-builtin', 'restart-dsh'],
  downloading: [],
  installing: [],
  pending: ['apply-now', 'reset-builtin'],
  applying: ['reset-builtin'],
  applied: ['check', 'select-version', 'install', 'cleanup-version', 'reset-builtin', 'restart-dsh'],
  rollback: ['check', 'restore-pre-rollback', 'select-version', 'install', 'cleanup-version', 'reset-builtin', 'restart-dsh'],
  'snapshot-failed': ['reset-builtin'],
  failed: ['check', 'restore-pre-rollback', 'select-version', 'install', 'cleanup-version', 'reset-builtin', 'restart-dsh'],
  error: ['check', 'select-version', 'install', 'cleanup-version', 'reset-builtin', 'restart-dsh'],
}

/** Restart-dsh gate (design 18 §3.6 项 8): usable only in a non-busy,
 *  non-pending/non-applying/non-installing state; the transactional control-plane restart is
 *  single-flight and re-seeds mounted plugins on every spawn. */
export function runtimeRestartAllowed(state: RuntimeState | null): boolean {
  if (state === null) return false
  return runtimeAllowedActions(state).includes('restart-dsh')
}

export function runtimeAllowedActions(state: RuntimeState | null): readonly RuntimeAction[] {
  if (state === null) return []
  const canRetryRestore = state.canRetryRestore === true
    && (state.phase === 'rollback' || state.phase === 'failed')
  // Unsupported platforms may still need to finish a crash-interrupted data
  // restore. That recovery action is deliberately narrower than version-tree
  // management and remains the sole escape hatch.
  if (state.managementSupported === false) return canRetryRestore ? ['retry-restore'] : []
  if (state.runtimeBlocked === true) {
    // An interrupted DSH_HOME restore must complete before selection metadata
    // can be archived. A retryable 'half' restore is therefore the sole
    // visible action when present. A permanent 'incomplete' restore (the
    // journaled snapshot is missing or untrustworthy — no retry can ever
    // succeed) keeps the retry button but no longer hides the terminal
    // recover-metadata escape.
    const permanentIncomplete = state.restoreOutcome === 'incomplete'
    if (canRetryRestore && !permanentIncomplete) return ['retry-restore']
    const metadataRecoveryEligible = state.canRecoverMetadata === true
      && (state.metadataHealth === 'selection-corrupt'
        || state.metadataHealth === 'recovery-in-progress'
        || state.metadataHealth === 'recovery-marker-corrupt')
      && (state.phase === 'idle' || state.phase === 'failed')
      && state.source !== 'env'
    if (metadataRecoveryEligible) {
      return permanentIncomplete && canRetryRestore
        ? ['retry-restore', 'recover-metadata']
        : ['recover-metadata']
    }
    if (canRetryRestore) return ['retry-restore']
    const actions: RuntimeAction[] = []
    if ((state.phase === 'snapshot-failed' || state.phase === 'failed') && state.canRetryApply === true) {
      actions.push('retry-apply')
    }
    if (state.phase === 'applying' && state.source !== 'env' && state.hasOverride === true) {
      actions.push('reset-builtin')
    }
    return actions
  }
  // An env-selected tree outranks every persisted override. Read-only checks
  // remain useful and an interrupted data restore must remain recoverable;
  // version selection/reset/apply would otherwise be misleading.
  if (state.source === 'env') {
    const actions: RuntimeAction[] = (BASE_ACTIONS[state.phase] ?? []).includes('check') ? ['check'] : []
    if (canRetryRestore) {
      actions.unshift('retry-restore')
    }
    return actions
  }
  // Unknown phases fail closed to the empty set instead of throwing through
  // the app ErrorBoundary (a TypeError here used to kill the whole shell).
  const actions = [...(BASE_ACTIONS[state.phase] ?? [])]
  // reset-builtin 只在确实存在 override 时有意义（main 对 hasOverride !== true
  // 一律拒绝，UI 不得显示 main 会 no-op 的动作）。pending/applying/snapshot-failed
  // 是持久化事务的逃生口（正常必有 pending override），但显式 hasOverride:false
  // （override 被外部删除）时同样不得显示必然 no-op 的按钮；其余相位无 override
  // 时移除该按钮——包括 error/failed/rollback/applied，而不只是 idle/available。
  // apply-now 与 reset-builtin 同构：它同样依赖持久化 pending 事务，main 侧 F5
  // 门（apply-now-gate 的 no-pending）在无 durable pending 时一律拒绝；显式
  // hasOverride:false 时 UI 必须同样隐藏，否则出现 UI 显示而 main 拒绝的
  // UI⊄main 方向违例（与 reset-builtin 的 hasOverride 过滤对称）。
  if (state.hasOverride === false
    || (state.phase !== 'pending' && state.phase !== 'applying' && state.phase !== 'snapshot-failed'
      && !(state.hasOverride ?? state.source === 'user'))) {
    const resetIndex = actions.indexOf('reset-builtin')
    if (resetIndex >= 0) actions.splice(resetIndex, 1)
    // apply-now 只出现在 pending 相位；此过滤对非 pending 相位是无操作，但保持
    // 与 reset-builtin 同一处、同一条件的对称性。
    const applyNowIndex = actions.indexOf('apply-now')
    if (applyNowIndex >= 0) actions.splice(applyNowIndex, 1)
  }
  if ((state.phase === 'snapshot-failed' || state.phase === 'failed') && state.canRetryApply === true) {
    actions.unshift('retry-apply')
  }
  if (canRetryRestore) {
    actions.unshift('retry-restore')
  }
  // Apply-now connectionState mirror (P2-A, UI⊄main fix): the main-side gate
  // (apply-now-gate.ts) refuses every connectionState outside ready/degraded —
  // a local dsh that is stopped/crashed would make main silently no-op while
  // the durable pending remains. Only apply-now is gated: reset-builtin is the
  // persistent-transaction escape hatch and stays visible regardless of
  // connection state. Absence (older main without the projection) never gates.
  if (state.connectionState !== undefined
    && state.connectionState !== 'ready'
    && state.connectionState !== 'degraded') {
    const applyNowIndex = actions.indexOf('apply-now')
    if (applyNowIndex >= 0) actions.splice(applyNowIndex, 1)
  }
  return actions
}

export type RuntimeStatusKind =
  | 'not-checked'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'pending'
  | 'applying'
  | 'applied'
  | 'rollback'
  | 'rollback-complete'
  | 'rollback-half'
  | 'restore-incomplete'
  | 'swap-attempted'
  | 'snapshot-failed'
  | 'failed'
  | 'error'

export interface RuntimeStatusProjection {
  kind: RuntimeStatusKind
  version: string | null
  detail: string | null
}

function operationVersion(state: RuntimeState, chosen: string | null): string | null {
  return state.targetVersion ?? state.pending ?? chosen ?? state.active
}

/** Pure state -> status/copy-token projection used by the complete UI matrix. */
export function projectRuntimeStatus(
  state: RuntimeState | null,
  chosen: string | null = null,
): RuntimeStatusProjection {
  if (state === null) return { kind: 'not-checked', version: null, detail: null }
  const version = operationVersion(state, chosen)
  // Main projects a persisted swap-attempted marker as the failed terminal
  // state. Do not let stale history override a later live checking/installing
  // phase after the user takes another action.
  if (state.swapAttempted === true && state.phase === 'failed') {
    return { kind: 'swap-attempted', version, detail: state.error }
  }
  switch (state.phase) {
    case 'idle':
      // Cached versions can exist before registry metadata has been fetched;
      // their presence alone does not justify an "up to date" claim.
      return { kind: state.latest !== null ? 'idle' : 'not-checked', version: state.active, detail: null }
    case 'checking':
      return { kind: 'checking', version: state.active, detail: null }
    case 'available':
      return { kind: 'available', version: state.latest ?? version, detail: null }
    case 'downloading':
      return { kind: 'downloading', version, detail: null }
    case 'installing':
      return { kind: 'installing', version, detail: null }
    case 'pending':
      return { kind: 'pending', version, detail: null }
    case 'applying':
      return { kind: 'applying', version, detail: null }
    case 'applied':
      return { kind: 'applied', version: state.active ?? version, detail: null }
    case 'rollback':
      if (state.restoreOutcome === 'complete') {
        return { kind: 'rollback-complete', version: state.rollbackTarget ?? state.active, detail: null }
      }
      if (state.restoreOutcome === 'half') {
        return { kind: 'rollback-half', version: state.rollbackTarget ?? state.active, detail: state.error }
      }
      if (state.restoreOutcome === 'incomplete') {
        return { kind: 'restore-incomplete', version: state.rollbackTarget ?? state.active, detail: state.error }
      }
      return { kind: 'rollback', version: state.rollbackTarget ?? state.active, detail: state.error }
    case 'snapshot-failed':
      return { kind: 'snapshot-failed', version, detail: state.snapshotError ?? state.error }
    case 'failed':
      if (state.restoreOutcome === 'half') {
        return { kind: 'rollback-half', version: state.rollbackTarget ?? state.active, detail: state.error }
      }
      if (state.restoreOutcome === 'incomplete') {
        return { kind: 'restore-incomplete', version: state.rollbackTarget ?? state.active, detail: state.error }
      }
      return { kind: 'failed', version: state.rollbackTarget ?? state.active, detail: state.error }
    case 'error':
      return { kind: 'error', version, detail: state.error }
  }
}

export type RuntimeSnapshotKind = 'unknown' | 'ready' | 'failed' | 'restore-half' | 'restore-incomplete'

export interface RuntimeSnapshotProjection {
  kind: RuntimeSnapshotKind
  count: number | null
  latestAt: string | null
  detail: string | null
}

export function projectRuntimeSnapshot(state: RuntimeState | null): RuntimeSnapshotProjection {
  if (state === null) return { kind: 'unknown', count: null, latestAt: null, detail: null }
  if (state.phase === 'snapshot-failed' || state.snapshotError != null) {
    return { kind: 'failed', count: state.snapshotCount ?? null, latestAt: state.latestSnapshotAt ?? null, detail: state.snapshotError ?? state.error }
  }
  if (state.restoreOutcome === 'half') {
    return { kind: 'restore-half', count: state.snapshotCount ?? null, latestAt: state.latestSnapshotAt ?? null, detail: state.error }
  }
  if (state.restoreOutcome === 'incomplete') {
    return { kind: 'restore-incomplete', count: state.snapshotCount ?? null, latestAt: state.latestSnapshotAt ?? null, detail: state.error }
  }
  if (state.snapshotCount !== undefined) {
    return { kind: 'ready', count: state.snapshotCount, latestAt: state.latestSnapshotAt ?? null, detail: null }
  }
  return { kind: 'unknown', count: null, latestAt: null, detail: null }
}

/** Stable compact formatter for the settings disk-accounting projection. */
export function formatRuntimeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  if (unit === 0) return `${Math.floor(value)} ${units[unit]}`
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

interface ParsedSemver {
  core: [string, string, string]
  prerelease: string[]
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

function parseSemver(value: string): ParsedSemver | null {
  const match = SEMVER.exec(value)
  if (match === null) return null
  return {
    core: [match[1]!, match[2]!, match[3]!],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function compareNumericIdentifier(a: string, b: string): -1 | 0 | 1 {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  return a === b ? 0 : a < b ? -1 : 1
}

/** SemVer 2.0 precedence; build metadata is deliberately ignored. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (left === null || right === null) return null
  for (let index = 0; index < 3; index += 1) {
    const compared = compareNumericIdentifier(left.core[index]!, right.core[index]!)
    if (compared !== 0) return compared
  }
  const leftPre = left.prerelease
  const rightPre = right.prerelease
  if (leftPre.length === 0 || rightPre.length === 0) {
    if (leftPre.length === rightPre.length) return 0
    return leftPre.length === 0 ? 1 : -1
  }
  const common = Math.min(leftPre.length, rightPre.length)
  for (let index = 0; index < common; index += 1) {
    const x = leftPre[index]!
    const y = rightPre[index]!
    if (x === y) continue
    const xNumeric = /^\d+$/u.test(x)
    const yNumeric = /^\d+$/u.test(y)
    if (xNumeric && yNumeric) return compareNumericIdentifier(x, y)
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    return x < y ? -1 : 1
  }
  if (leftPre.length === rightPre.length) return 0
  return leftPre.length < rightPre.length ? -1 : 1
}

export function isSemverGreater(a: string, b: string): boolean {
  return compareSemver(a, b) === 1
}

/**
 * Preserve a still-valid explicit user choice. Before the user chooses, the
 * picker preselects the ACTIVE version — the dropdown always reflects what is
 * actually running, and the action button arms only after the user changes the
 * selection (2026-10 user decision, refined: the default state has no override,
 * so the active version IS the bundled one — "default follows the built-in").
 * When no active version exists yet, the bundled (built-in) version is the
 * safe default over the registry recommendation. The registry recommendation
 * is the last fallback before the list order.
 */
export function preferredRuntimeVersion(
  current: string | null,
  versions: readonly RuntimeVersionEntry[],
  latest: string | null,
  active: string | null,
  bundled: string | null = null,
): string | null {
  const available = new Set(versions.map((entry) => entry.version))
  if (current !== null && available.has(current)) return current
  if (active !== null && available.has(active)) return active
  if (bundled !== null && available.has(bundled)) return bundled
  if (latest !== null && available.has(latest)) return latest
  return versions[0]?.version ?? null
}

export type RuntimeSelectionDirection = 'none' | 'current' | 'upgrade' | 'rollback'

/** UI label direction; no active version is an install/forward action, never a rollback. */
export function runtimeSelectionDirection(
  selected: string | null,
  active: string | null,
): RuntimeSelectionDirection {
  if (selected === null) return 'none'
  if (selected === active) return 'current'
  if (active === null) return 'upgrade'
  return compareSemver(selected, active) === -1 ? 'rollback' : 'upgrade'
}

type Listener = () => void
type Timer = ReturnType<typeof setTimeout>

export interface RuntimeStoreOptions {
  resolveSurface: () => RuntimeSurface | null
  schedule?: (callback: () => void, delayMs: number) => Timer
  cancel?: (timer: Timer) => void
  retryDelayMs?: number
  retryAttempts?: number
}

/**
 * Single page-wide external store. It subscribes before querying state, so a
 * push that races hydration always wins; the last React subscriber tears down
 * the IPC listener and invalidates late query results.
 */
export class RuntimeStateStore {
  private readonly options: RuntimeStoreOptions
  private current: RuntimeState | null = null
  private readonly listeners = new Set<Listener>()
  private unsubscribeBridge: (() => void) | null = null
  private retryTimer: Timer | null = null
  private epoch = 0
  private revision = 0
  private readonly schedule: (callback: () => void, delayMs: number) => Timer
  private readonly cancel: (timer: Timer) => void
  private readonly retryDelayMs: number
  private readonly retryAttempts: number

  constructor(options: RuntimeStoreOptions) {
    this.options = options
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.cancel = options.cancel ?? ((timer) => clearTimeout(timer))
    this.retryDelayMs = options.retryDelayMs ?? 100
    this.retryAttempts = options.retryAttempts ?? 20
  }

  readonly getSnapshot = (): RuntimeState | null => this.current

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    // A later subscriber also re-arms a retry chain that previously expired.
    if (this.unsubscribeBridge === null && this.retryTimer === null) this.tryAttach(0)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.detach()
    }
  }

  private publish(state: RuntimeState): void {
    this.current = state
    for (const listener of this.listeners) listener()
  }

  private tryAttach(attempt: number): void {
    if (this.listeners.size === 0 || this.unsubscribeBridge !== null || this.retryTimer !== null) return
    const surface = this.options.resolveSurface()
    if (surface === null) {
      this.scheduleAttach(attempt)
      return
    }

    const epoch = ++this.epoch
    const hydrationRevision = this.revision
    let initialState: Promise<RuntimeState>
    try {
      this.unsubscribeBridge = surface.onChanged((state) => {
        if (epoch !== this.epoch || this.listeners.size === 0) return
        this.revision += 1
        this.publish(state)
      })
      initialState = surface.state()
    } catch {
      this.retryFailedAttachment(epoch, attempt)
      return
    }
    void initialState.then((state) => {
      if (epoch !== this.epoch || this.listeners.size === 0 || this.revision !== hydrationRevision) return
      this.revision += 1
      this.publish(state)
    }).catch(() => {
      // A transient invoke failure must not leave a permanently blank store.
      // If a push already landed, it is authoritative and no retry is needed.
      if (epoch === this.epoch && this.listeners.size > 0 && this.revision === hydrationRevision) {
        this.retryFailedAttachment(epoch, attempt)
      }
    })
  }

  private retryFailedAttachment(epoch: number, attempt: number): void {
    if (epoch !== this.epoch) return
    this.epoch += 1
    const unsubscribe = this.unsubscribeBridge
    this.unsubscribeBridge = null
    try {
      unsubscribe?.()
    } catch {
      // A broken teardown cannot be allowed to suppress the fresh retry.
    }
    this.scheduleAttach(attempt)
  }

  private scheduleAttach(attempt: number): void {
    if (attempt >= this.retryAttempts || this.listeners.size === 0 || this.retryTimer !== null) return
    this.retryTimer = this.schedule(() => {
      this.retryTimer = null
      this.tryAttach(attempt + 1)
    }, this.retryDelayMs)
  }

  private detach(): void {
    this.epoch += 1
    if (this.retryTimer !== null) {
      this.cancel(this.retryTimer)
      this.retryTimer = null
    }
    const unsubscribe = this.unsubscribeBridge
    this.unsubscribeBridge = null
    try {
      unsubscribe?.()
    } catch {
      // React cleanup must remain non-throwing even if a bridge misbehaves.
    } finally {
      // A remount must never render a stale terminal state while the fresh
      // query/subscription is being established.
      this.current = null
    }
  }
}

export function currentRuntimeSurface(): RuntimeSurface | null {
  return typeof window !== 'undefined' ? window.dshChamber?.runtime ?? null : null
}

const pageRuntimeStore = new RuntimeStateStore({ resolveSurface: currentRuntimeSurface })

export const getRuntimeState = pageRuntimeStore.getSnapshot
export const subscribeRuntimeState = pageRuntimeStore.subscribe

/** Fail closed during bridge hydration and every phase with unsafe DSH_HOME. */
export function runtimeBlocksLocalStart(state: RuntimeState | null, surfacePresent: boolean): boolean {
  return surfacePresent && (
    state === null
    || state.runtimeBlocked === true
    || state.phase === 'applying'
    || state.canRetryRestore === true
    || state.restoreOutcome === 'half'
    || state.restoreOutcome === 'incomplete'
  )
}
