/**
 * dsh runtime controller (design 18 §3.5/§3.6/§5) — main-process orchestration
 * over the M2 data plane: check (registry metadata → version list), install
 * (version-exists gate + no-op gate + single-flight → runtime installer →
 * override.pending). Reset is intentionally not executed here: main owns the
 * snapshot/journal/stop/probe transaction and this controller must never
 * directly delete authoritative recovery metadata. Pure
 * orchestration: fetchMetadata / install / store are injected so tests mock
 * every side effect. State changes are broadcast synchronously via onChanged.
 */
import type { RegistryMetadata } from './registry-metadata.ts'
import type { VersionListEntry } from './dsh-runtime-updater.ts'
import {
  SingleFlight,
  bindRuntimeInstallResolution,
  compareRuntimeVersions,
  isNoopSelection,
  buildVersionList,
  buildCachedVersionList,
  versionExists,
} from './dsh-runtime-updater.ts'
import type { ActivationIntentInput, OverrideRecord, RuntimeDiskSummary } from './dsh-runtime-store.ts'
import type { InstallOptions, InstallResult } from './runtime-installer.ts'
import { sanitizeErrorText } from './sanitize-error.ts'
import { allowedActions, transition, transitionLifecycleProjection, type RuntimePhase } from './runtime-state-machine.ts'

export type RuntimeRestoreOutcome = 'none' | 'complete' | 'half' | 'incomplete'

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

export type RuntimeMetadataHealthProjection =
  | 'unknown'
  | 'healthy'
  | 'selection-corrupt'
  | 'recovery-in-progress'
  | 'recovery-finalized'
  | 'recovery-marker-corrupt'

/** Category-only projection: never expose evidence basenames or owned paths. */
export type RuntimeMetadataComponent =
  | 'current'
  | 'override'
  | 'activation-journal'
  | 'recovery-marker'
  | 'retained-evidence'

/** Soft logical-usage ceiling for fresh downloads. Cached activation and all
 * recovery paths deliberately bypass it. RuntimeDiskSummary may double-count
 * hard-linked tree/store bytes, so this is a conservative hygiene gate rather
 * than a claim about physical free space. */
export const DEFAULT_RUNTIME_LOGICAL_DISK_LIMIT_BYTES = 10 * 1024 ** 3

export interface RuntimeState {
  /** The active runtime version (current pointer, falling back to bundled). */
  active: string | null
  bundled: string | null
  /** Where the active version comes from (§3.5/§3.6 A.1): env (DSH_CHAMBER_DSH_PATH
   *  overrides everything), user (current pointer set by a prior selection), or
   *  bundled (no pointer, no env — the app's built-in tree). */
  source: 'bundled' | 'user' | 'env'
  latest: string | null
  versions: VersionListEntry[]
  pending: string | null
  phase: RuntimePhase
  error: string | null
  targetVersion?: string | null
  sourceVersion?: string | null
  rollbackTarget?: string | null
  restoreOutcome?: RuntimeRestoreOutcome
  snapshotCount?: number
  latestSnapshotAt?: string | null
  snapshotError?: string | null
  canRetryApply?: boolean
  canRetryRestore?: boolean
  /** Authoritative main-process local-spawn gate, not inferred from phase. */
  runtimeBlocked?: boolean
  runtimeBlockedReason?: string | null
  swapAttempted?: boolean
  failure?: RuntimeFailure | null
  /** Durable F4 notice; remains visible even if the old user tree was
   * automatically reactivated after the bundled compatibility probe failed. */
  invalidationNotice?: RuntimeInvalidationNotice | null
  /** On-demand logical disk accounting; hard-linked tree/store bytes may be
   * counted in both categories (see RuntimeDiskSummary). */
  diskUsage?: RuntimeDiskSummary | null
  diskError?: string | null
  diskLimitBytes?: number
  diskLimitExceeded?: boolean | null
  explicitlyInstalledVersions?: string[]
  /** True even when an env path or an invalidation currently outranks it. */
  hasOverride?: boolean
  /** Runtime switching is intentionally read-only on unsupported platforms. */
  managementSupported?: boolean
  managementUnsupportedReason?: string | null
  /** Main-process authoritative selection-metadata health; no paths/versions. */
  metadataHealth?: RuntimeMetadataHealthProjection
  /** Affected metadata categories only; never evidence basenames or paths. */
  metadataComponents?: RuntimeMetadataComponent[]
  /** Explicit privileged capability. Renderer input can never set this bit. */
  canRecoverMetadata?: boolean
}

export interface RuntimeLifecycleProjection {
  phase?: RuntimePhase
  error?: string | null
  targetVersion?: string | null
  sourceVersion?: string | null
  rollbackTarget?: string | null
  restoreOutcome?: RuntimeRestoreOutcome
  snapshotCount?: number
  latestSnapshotAt?: string | null
  snapshotError?: string | null
  canRetryApply?: boolean
  canRetryRestore?: boolean
  runtimeBlocked?: boolean
  runtimeBlockedReason?: string | null
  swapAttempted?: boolean
  failure?: RuntimeFailure | null
  diskUsage?: RuntimeDiskSummary | null
  diskError?: string | null
  diskLimitBytes?: number
  diskLimitExceeded?: boolean | null
  explicitlyInstalledVersions?: string[]
  metadataHealth?: RuntimeMetadataHealthProjection
  metadataComponents?: RuntimeMetadataComponent[]
  canRecoverMetadata?: boolean
}

export interface ControllerDeps {
  fetchMetadata: (packageName: string, origin: string) => Promise<RegistryMetadata>
  install: (opts: InstallOptions) => Promise<InstallResult>
  store: {
    readOverride: (baseDir: string) => OverrideRecord | null
    writeOverride: (baseDir: string, record: OverrideRecord) => void
    readCurrentPointer: (baseDir: string) => string | null
    listVersionTrees: (baseDir: string) => string[]
    deleteOverride: (baseDir: string) => void
    clearCurrentPointer: (baseDir: string) => void
    /** Cached rollback is allowed only for a complete platform-matching tree. */
    validateVersionTree?: (baseDir: string, version: string) => { ok: boolean; error?: string }
    recordFailure?: (baseDir: string, failure: RuntimeFailure) => void
    recordExplicitInstall?: (baseDir: string, version: string) => void
    /** Full logical accounting used to fail closed before a fresh download. */
    runtimeDiskSummary?: (baseDir: string) => RuntimeDiskSummary
    /** Persist the activation intent before override.pending is published. */
    writeActivationIntent: (baseDir: string, input: ActivationIntentInput) => void
    /** Explicit reset clears any safe intent/monitoring journal selected by main. */
    clearActivationJournal: (baseDir: string) => void
  }
  /** The chamber shell version recorded in override records (§3.5 invalidation). */
  shellVersion: string
}

export interface ControllerOptions {
  baseDir: string
  bundledVersion: string | null
  packageName: string
  registryOrigin: string
  /** Optional live registry-origin getter (§3.6 A.4 每操作现读)；缺省时用
   *  `registryOrigin`（启动冻结语义）。main.ts 传 `() => chamberSettings.registryOrigin`。 */
  getRegistryOrigin?: () => string
  /** The version resolved from DSH_CHAMBER_DSH_PATH, or null when env is not set
   *  (§3.5 env 来源)。 */
  envVersion?: string | null
  /** Presence is authoritative even when the env tree's manifest is unreadable. */
  envOverrideActive?: boolean
  /** Unix is the design-18 mutation target; unsupported platforms remain read-only. */
  managementSupported?: boolean
  managementUnsupportedReason?: string | null
  pnpmEntry: string
  compatibilityBaseline: string | null
  /** Fresh-download soft limit. Cached activation/recovery never use it. */
  logicalDiskLimitBytes?: number
  deps: ControllerDeps
}

export class DshRuntimeController {
  private readonly baseDir: string
  private readonly bundledVersion: string | null
  private readonly packageName: string
  private readonly registryOrigin: string
  private readonly getRegistryOrigin: () => string
  private readonly envVersion: string | null
  private readonly envOverrideActive: boolean
  private readonly managementSupported: boolean
  private readonly managementUnsupportedReason: string | null
  private readonly pnpmEntry: string
  private readonly compatibilityBaseline: string | null
  private readonly logicalDiskLimitBytes: number
  private readonly deps: ControllerDeps
  private readonly flight = new SingleFlight()
  private readonly listeners = new Set<(s: RuntimeState) => void>()
  private lastMeta: RegistryMetadata | null = null
  private phase: RuntimePhase = 'idle'
  private error: string | null = null
  private lifecycle: Omit<RuntimeLifecycleProjection, 'phase' | 'error'> = {
    targetVersion: null,
    sourceVersion: null,
    rollbackTarget: null,
    restoreOutcome: 'none',
    snapshotError: null,
    canRetryApply: false,
    canRetryRestore: false,
    runtimeBlocked: true,
    runtimeBlockedReason: '正在确认 dsh 运行时安全状态',
    swapAttempted: false,
    failure: null,
    metadataHealth: 'unknown',
    metadataComponents: [],
    canRecoverMetadata: false,
  }

  constructor(opts: ControllerOptions) {
    this.baseDir = opts.baseDir
    this.bundledVersion = opts.bundledVersion
    this.packageName = opts.packageName
    this.registryOrigin = opts.registryOrigin
    this.getRegistryOrigin = opts.getRegistryOrigin ?? (() => this.registryOrigin)
    this.envVersion = opts.envVersion ?? null
    this.envOverrideActive = opts.envOverrideActive ?? opts.envVersion != null
    this.managementSupported = opts.managementSupported ?? true
    this.managementUnsupportedReason = this.managementSupported
      ? null
      : sanitizeErrorText(opts.managementUnsupportedReason ?? '当前平台暂不支持 dsh 运行时管理')
    this.pnpmEntry = opts.pnpmEntry
    this.compatibilityBaseline = opts.compatibilityBaseline
    this.logicalDiskLimitBytes = opts.logicalDiskLimitBytes ?? DEFAULT_RUNTIME_LOGICAL_DISK_LIMIT_BYTES
    if (!Number.isSafeInteger(this.logicalDiskLimitBytes) || this.logicalDiskLimitBytes <= 0) {
      throw new Error('logicalDiskLimitBytes 必须是正安全整数')
    }
    this.deps = opts.deps
    this.lifecycle = {
      ...this.lifecycle,
      diskLimitBytes: this.logicalDiskLimitBytes,
      diskLimitExceeded: null,
    }
  }

  private activeVersion(): string | null {
    if (this.envOverrideActive) return this.envVersion;
    const override = this.deps.store.readOverride(this.baseDir)
    const invalidated = override !== null && (
      override.shellVersion !== this.deps.shellVersion
      || (override as OverrideRecord & { invalidatedAt?: string | null }).invalidatedAt != null
    )
    const pointer = invalidated || override === null ? null : this.deps.store.readCurrentPointer(this.baseDir)
    if (pointer !== null && this.isUsableTree(pointer)) return pointer
    return this.bundledVersion
  }

  private isUsableTree(version: string): boolean {
    const validate = this.deps.store.validateVersionTree
    return validate === undefined || validate(this.baseDir, version).ok
  }

  private cachedVersions(): string[] {
    return this.deps.store.listVersionTrees(this.baseDir).filter(version => this.isUsableTree(version))
  }

  private refreshMetadataOrigin(): void {
    if (this.lastMeta !== null && this.lastMeta.origin !== this.getRegistryOrigin()) this.lastMeta = null
  }

  private emit(): void {
    const state = this.getState()
    for (const cb of this.listeners) {
      try {
        cb(state)
      } catch (error) {
        // A renderer/window listener is observational. It must never strand
        // check in `checking` or leak the install single-flight lock.
        console.error('[dsh-runtime-controller] state listener failed:', error)
      }
    }
  }

  getState(): RuntimeState {
    this.refreshMetadataOrigin()
    const override = this.deps.store.readOverride(this.baseDir)
    const active = this.activeVersion()
    const pointer = this.deps.store.readCurrentPointer(this.baseDir)
    const effectiveUserPointer = !this.envOverrideActive
      && override !== null
      && override.shellVersion === this.deps.shellVersion
      && (override as OverrideRecord & { invalidatedAt?: string | null }).invalidatedAt == null
      && pointer !== null
      && this.isUsableTree(pointer)
    const source: RuntimeState['source'] = this.envOverrideActive
      ? 'env'
      : effectiveUserPointer
        ? 'user'
        : 'bundled'
    const cachedVersions = this.cachedVersions()
    // F11 offline cached rollback: no registry metadata → list the local trees.
    const versions = this.lastMeta === null
      ? buildCachedVersionList(cachedVersions, active)
      : buildVersionList(this.lastMeta, {
          active,
          cachedVersions,
          compatibilityBaseline: this.compatibilityBaseline,
        })
    const invalidationNotice: RuntimeInvalidationNotice | null = override?.lastInvalidatedAt != null
      && override.lastInvalidatedReason != null
      ? {
          at: override.lastInvalidatedAt,
          reason: sanitizeErrorText(override.lastInvalidatedReason),
          fromVersion: override.lastInvalidatedFromVersion ?? null,
          recovered: override.lastInvalidationRecovered === true,
        }
      : null
    return {
      active,
      bundled: this.bundledVersion,
      source,
      latest: this.lastMeta?.latest ?? null,
      versions,
      pending: !this.envOverrideActive && override !== null
        && override.shellVersion === this.deps.shellVersion
        && override.invalidatedAt == null
        ? override.pending
        : null,
      phase: this.phase,
      error: this.error,
      ...this.lifecycle,
      targetVersion: this.lifecycle.targetVersion ?? override?.pending ?? null,
      swapAttempted: this.lifecycle.swapAttempted === true || override?.swapAttempted === true,
      hasOverride: override !== null,
      invalidationNotice,
      managementSupported: this.managementSupported,
      managementUnsupportedReason: this.managementUnsupportedReason,
    }
  }

  /** Main-process startup/rollback orchestration publishes every material
   * lifecycle branch through the same renderer projection. */
  setLifecycle(patch: RuntimeLifecycleProjection): RuntimeState {
    if (patch.phase !== undefined) {
      const projected = transitionLifecycleProjection(this.phase, patch.phase)
      // Reject the whole stale projection, not merely its phase: rollback
      // copy/error/capability fields from an illegal edge must not contaminate
      // a concurrent checking/installing state.
      if (projected !== patch.phase) return this.getState()
      this.phase = projected
    }
    if (patch.error !== undefined) this.error = patch.error === null ? null : sanitizeErrorText(patch.error)
    const { phase: _phase, error: _error, runtimeBlockedReason, ...rest } = patch
    this.lifecycle = {
      ...this.lifecycle,
      ...rest,
      ...(runtimeBlockedReason === undefined
        ? {}
        : { runtimeBlockedReason: runtimeBlockedReason === null ? null : sanitizeErrorText(runtimeBlockedReason) }),
    }
    this.emit()
    return this.getState()
  }

  onChanged(cb: (s: RuntimeState) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  async check(): Promise<RuntimeState> {
    if (!this.managementSupported) return this.getState()
    if (!allowedActions(this.phase).includes('check')) {
      return this.getState()
    }
    const checking = transition(this.phase, { type: 'check' })
    if (checking === this.phase) return this.getState()
    this.phase = checking
    this.error = null
    this.emit()
    try {
      const origin = this.getRegistryOrigin()
      this.lastMeta = await this.deps.fetchMetadata(this.packageName, origin)
      if (this.lastMeta.origin !== origin) throw new Error('registry metadata source mismatch')
      const active = this.activeVersion()
      this.phase = transition(this.phase, { type: 'check-done', available: this.lastMeta.latest !== null
        && (active === null || compareRuntimeVersions(this.lastMeta.latest, active) === 1)
      })
    } catch (err) {
      this.error = sanitizeErrorText(err instanceof Error ? err.message : String(err))
      this.phase = transition(this.phase, { type: 'error' })
    }
    this.emit()
    return this.getState()
  }

  async install(version: string): Promise<RuntimeState> {
    if (!this.managementSupported) return this.getState()
    if (this.envOverrideActive) {
      this.error = 'DSH_CHAMBER_DSH_PATH 生效时不能切换持久化运行时'
      this.phase = transition(this.phase, { type: 'error' })
      this.emit()
      return this.getState()
    }
    if (!allowedActions(this.phase).includes('install')) {
      return this.getState()
    }
    // Pending terminal gate (§3.6): a pending override is a swap awaiting the
    // next startup — installing a DIFFERENT version now would overwrite it, so
    // reject until [恢复内建] clears the pending. Enforced in the controller,
    // not just the UI (AGENTS.md core-logic enforcement).
    const pendingOverride = this.deps.store.readOverride(this.baseDir)?.pending ?? null
    if (pendingOverride !== null) {
      // A pending activation is a terminal gate. A forged/late renderer call
      // must not overwrite the authoritative pending phase with a generic
      // error state (which would also expose actions that are forbidden while
      // the swap is unresolved).
      return this.getState()
    }
    const active = this.activeVersion()
    // No-op guard: choosing the already-active version is a no-op (§3.6).
    if (isNoopSelection(version, active)) return this.getState()
    // F11 offline cached rollback: a locally-cached tree skips the registry
    // existence gate (and the fresh install) — switching to it is a pointer
    // swap at next startup, already installed.
    this.refreshMetadataOrigin()
    const cached = this.cachedVersions().includes(version)
    // The quota guards only a NEW download/install. A cached rollback/switch
    // and every recovery path remain available even above the soft ceiling.
    if (!cached && this.deps.store.runtimeDiskSummary !== undefined) {
      let disk: RuntimeDiskSummary
      try {
        disk = this.deps.store.runtimeDiskSummary(this.baseDir)
      } catch (err) {
        const detail = sanitizeErrorText(err instanceof Error ? err.message : String(err))
        this.error = `无法确认 dsh 运行时磁盘占用；拒绝开始新安装：${detail}`
        this.phase = transition(this.phase, { type: 'error' })
        this.lifecycle = {
          ...this.lifecycle,
          diskUsage: null,
          diskError: detail,
          diskLimitBytes: this.logicalDiskLimitBytes,
          diskLimitExceeded: null,
        }
        this.emit()
        return this.getState()
      }
      const exceeded = disk.totalBytes >= this.logicalDiskLimitBytes
      this.lifecycle = {
        ...this.lifecycle,
        diskUsage: disk,
        diskError: null,
        diskLimitBytes: this.logicalDiskLimitBytes,
        diskLimitExceeded: exceeded,
      }
      if (exceeded) {
        this.error = `dsh 运行时逻辑磁盘占用已达到 ${this.logicalDiskLimitBytes} 字节软上限；请先清理不再使用的版本`
        this.phase = transition(this.phase, { type: 'error' })
        this.emit()
        return this.getState()
      }
    }
    // Version-existence gate: only real registry versions with a tarball may
    // be freshly installed (§3.4/§5); cached trees bypass it.
    if (!cached && (this.lastMeta === null || !versionExists(this.lastMeta, version))) {
      this.error = `版本不存在或不可安装：${version}`
      this.phase = transition(this.phase, { type: 'error' })
      this.emit()
      return this.getState()
    }
    // Single-flight over the whole install window (§3.6).
    if (!this.flight.tryBegin()) return this.getState()
    const installing = transition(this.phase, { type: 'install-confirm' })
    if (installing === this.phase) {
      this.flight.end()
      return this.getState()
    }
    this.phase = installing
    this.error = null
    this.lifecycle = {
      targetVersion: version,
      sourceVersion: active,
      rollbackTarget: null,
      restoreOutcome: 'none',
      snapshotCount: this.lifecycle.snapshotCount,
      latestSnapshotAt: this.lifecycle.latestSnapshotAt,
      snapshotError: null,
      canRetryApply: false,
      canRetryRestore: false,
      runtimeBlocked: false,
      runtimeBlockedReason: null,
      swapAttempted: false,
      failure: null,
      diskUsage: this.lifecycle.diskUsage,
      diskError: this.lifecycle.diskError,
      diskLimitBytes: this.logicalDiskLimitBytes,
      diskLimitExceeded: this.lifecycle.diskLimitExceeded,
      explicitlyInstalledVersions: this.lifecycle.explicitlyInstalledVersions,
      metadataHealth: this.lifecycle.metadataHealth,
      metadataComponents: this.lifecycle.metadataComponents,
      canRecoverMetadata: false,
    }
    this.emit()
    try {
      let resolvedVersion: string
      if (cached) {
        // Already-installed tree: no fetch/install — the version IS resolved.
        resolvedVersion = version
      } else {
        const origin = this.getRegistryOrigin()
        const resolution = bindRuntimeInstallResolution(this.lastMeta!, version, origin)
        const result = await this.deps.install({
          baseDir: this.baseDir,
          resolution,
          pnpmEntry: this.pnpmEntry,
        })
        resolvedVersion = result.resolvedVersion
      }
      const record: OverrideRecord = {
        shellVersion: this.deps.shellVersion,
        chosenVersion: version,
        resolvedVersion,
        pending: version,
        swapAttempted: false,
      }
      // Tree validation/retention must commit before publishing a pending
      // activation. If this fails, no broken pending record is left behind.
      this.deps.store.recordExplicitInstall?.(this.baseDir, resolvedVersion)
      this.deps.store.writeActivationIntent(this.baseDir, {
        targetVersion: resolvedVersion,
        manualRollback: active !== null && compareRuntimeVersions(resolvedVersion, active) === -1,
        intentKind: 'version-switch',
      })
      this.deps.store.writeOverride(this.baseDir, record)
      this.phase = transition(this.phase, { type: 'install-done' })
    } catch (err) {
      this.error = sanitizeErrorText(err instanceof Error ? err.message : String(err))
      this.phase = transition(this.phase, { type: 'error' })
      const failure = { version, at: new Date().toISOString(), reason: this.error }
      this.lifecycle = { ...this.lifecycle, failure }
      try {
        this.deps.store.recordFailure?.(this.baseDir, failure)
      } catch {
        // The primary install error remains authoritative; persistence is
        // diagnostic and must not mask it.
      }
    } finally {
      this.flight.end()
    }
    this.emit()
    return this.getState()
  }

  resetBuiltin(): RuntimeState {
    if (!this.managementSupported || this.envOverrideActive || this.flight.inFlight
      || this.phase === 'checking' || this.phase === 'installing' || this.phase === 'downloading') {
      return this.getState()
    }
    this.error = '恢复内建必须由主进程运行时事务协调器执行'
    this.emit()
    return this.getState()
  }
}
