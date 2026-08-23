/**
 * dsh runtime controller (design 16 §3.5/§3.6/§5) — main-process orchestration
 * over the M2 data plane: check (registry metadata → version list), install
 * (version-exists gate + no-op gate + single-flight → runtime installer →
 * override.pending), resetBuiltin (delete override → fallback chain). Pure
 * orchestration: fetchMetadata / install / store are injected so tests mock
 * every side effect. State changes are broadcast synchronously via onChanged.
 */
import { rmSync } from 'node:fs'
import type { RegistryMetadata } from './registry-metadata.ts'
import type { VersionListEntry } from './dsh-runtime-updater.ts'
import { SingleFlight, isNoopSelection, buildVersionList, buildCachedVersionList, versionExists } from './dsh-runtime-updater.ts'
import type { OverrideRecord } from './dsh-runtime-store.ts'
import { overridePath, readCurrentPointer, readOverride, writeOverride, listVersionTrees } from './dsh-runtime-store.ts'
import type { InstallOptions, InstallResult } from './runtime-installer.ts'
import { sanitizeErrorText } from './sanitize-error.ts'

export type RuntimePhase = 'idle' | 'checking' | 'available' | 'installing' | 'pending' | 'error'

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
  pnpmEntry: string
  compatibilityBaseline: string | null
  deps: ControllerDeps
}

function defaultDeleteOverride(baseDir: string): void {
  rmSync(overridePath(baseDir), { force: true })
}

export class DshRuntimeController {
  private readonly baseDir: string
  private readonly bundledVersion: string | null
  private readonly packageName: string
  private readonly registryOrigin: string
  private readonly getRegistryOrigin: () => string
  private readonly envVersion: string | null
  private readonly pnpmEntry: string
  private readonly compatibilityBaseline: string | null
  private readonly deps: ControllerDeps
  private readonly flight = new SingleFlight()
  private readonly listeners = new Set<(s: RuntimeState) => void>()
  private lastMeta: RegistryMetadata | null = null
  private phase: RuntimePhase = 'idle'
  private error: string | null = null

  constructor(opts: ControllerOptions) {
    this.baseDir = opts.baseDir
    this.bundledVersion = opts.bundledVersion
    this.packageName = opts.packageName
    this.registryOrigin = opts.registryOrigin
    this.getRegistryOrigin = opts.getRegistryOrigin ?? (() => this.registryOrigin)
    this.envVersion = opts.envVersion ?? null
    this.pnpmEntry = opts.pnpmEntry
    this.compatibilityBaseline = opts.compatibilityBaseline
    this.deps = {
      ...opts.deps,
      store: {
        ...opts.deps.store,
        deleteOverride: opts.deps.store.deleteOverride ?? defaultDeleteOverride,
      },
    }
  }

  private activeVersion(): string | null {
    if (this.envVersion !== null) return this.envVersion;
    return this.deps.store.readCurrentPointer(this.baseDir) ?? this.bundledVersion
  }

  private emit(): void {
    const state = this.getState()
    for (const cb of this.listeners) cb(state)
  }

  getState(): RuntimeState {
    const override = this.deps.store.readOverride(this.baseDir)
    const active = this.activeVersion()
    const pointer = this.deps.store.readCurrentPointer(this.baseDir)
    const source: RuntimeState['source'] = this.envVersion !== null
      ? 'env'
      : pointer !== null
        ? 'user'
        : 'bundled'
    const cachedVersions = this.deps.store.listVersionTrees(this.baseDir)
    // F11 offline cached rollback: no registry metadata → list the local trees.
    const versions = this.lastMeta === null
      ? buildCachedVersionList(cachedVersions, active)
      : buildVersionList(this.lastMeta, {
          active,
          cachedVersions,
          compatibilityBaseline: this.compatibilityBaseline,
        })
    return {
      active,
      bundled: this.bundledVersion,
      source,
      latest: this.lastMeta?.latest ?? null,
      versions,
      pending: override?.pending ?? null,
      phase: this.phase,
      error: this.error,
    }
  }

  onChanged(cb: (s: RuntimeState) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  async check(): Promise<RuntimeState> {
    this.phase = 'checking'
    this.error = null
    this.emit()
    try {
      this.lastMeta = await this.deps.fetchMetadata(this.packageName, this.getRegistryOrigin())
      this.phase = this.lastMeta.latest !== null && this.lastMeta.latest !== this.activeVersion() ? 'available' : 'idle'
    } catch (err) {
      this.error = sanitizeErrorText(err instanceof Error ? err.message : String(err))
      this.phase = 'error'
    }
    this.emit()
    return this.getState()
  }

  async install(version: string): Promise<RuntimeState> {
    // Pending terminal gate (§3.6): a pending override is a swap awaiting the
    // next startup — installing a DIFFERENT version now would overwrite it, so
    // reject until [恢复内建] clears the pending. Enforced in the controller,
    // not just the UI (AGENTS.md core-logic enforcement).
    const pendingOverride = this.deps.store.readOverride(this.baseDir)?.pending ?? null
    if (pendingOverride !== null) {
      this.error = `已有待切换版本 ${pendingOverride}（下次启动生效），先「恢复内建」再换版本`
      this.phase = 'error'
      this.emit()
      return this.getState()
    }
    const active = this.activeVersion()
    // No-op guard: choosing the already-active version is a no-op (§3.6).
    if (isNoopSelection(version, active)) return this.getState()
    // F11 offline cached rollback: a locally-cached tree skips the registry
    // existence gate (and the fresh install) — switching to it is a pointer
    // swap at next startup, already installed.
    const cached = this.deps.store.listVersionTrees(this.baseDir).includes(version)
    // Version-existence gate: only real registry versions with a tarball may
    // be freshly installed (§3.4/§5); cached trees bypass it.
    if (!cached && (this.lastMeta === null || !versionExists(this.lastMeta, version))) {
      this.error = `版本不存在或不可安装：${version}`
      this.phase = 'error'
      this.emit()
      return this.getState()
    }
    // Single-flight over the whole install window (§3.6).
    if (!this.flight.tryBegin()) return this.getState()
    this.phase = 'installing'
    this.error = null
    this.emit()
    try {
      let resolvedVersion: string
      if (cached) {
        // Already-installed tree: no fetch/install — the version IS resolved.
        resolvedVersion = version
      } else {
        const result = await this.deps.install({
          baseDir: this.baseDir,
          version,
          registryOrigin: this.getRegistryOrigin(),
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
      this.deps.store.writeOverride(this.baseDir, record)
      this.phase = 'pending'
    } catch (err) {
      this.error = sanitizeErrorText(err instanceof Error ? err.message : String(err))
      this.phase = 'error'
    } finally {
      this.flight.end()
    }
    this.emit()
    return this.getState()
  }

  resetBuiltin(): RuntimeState {
    this.deps.store.deleteOverride(this.baseDir)
    this.error = null
    this.phase = 'idle'
    this.emit()
    return this.getState()
  }
}
