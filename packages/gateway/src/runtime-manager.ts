/**
 * Gateway dsh runtime version management (design 18 §9.3): composes the
 * shared `@dsh-chamber/dsh-runtime` core through its StartupDeps/ApplyDeps/
 * InstallerDeps seams (RuntimeHostAdapter remains a documented sketch).
 *
 * Storage layout (design 18 §9.3 + design 17 §10): the shared core appends
 * `dsh-runtime` under its `baseDir`, so the gateway passes `stateDir` as
 * baseDir — version trees / current pointer / override / journal / snapshots
 * land in `<stateDir>/dsh-runtime/`, exactly like desktop's `<userData>/
 * dsh-runtime/`. The gateway's own files (registry.json / owner.json) live in
 * the same directory (stateRoot == runtimeDirPath(stateDir)).
 *
 * - Resolution chain: DSH_GATEWAY_DSH_PATH (env, always highest) → override
 *   (valid tree) → builtin anchor (`--dsh-path` / findDshWorkspace).
 * - Startup transaction (design 17 §2.1 step 4) runs BEFORE the first
 *   startLocal(): cleanup → eviction → restore completion → (pending)
 *   snapshot → pointer switch → spawn candidate → probe gate → verdict.
 * - The `/chamber/runtime` controller consumes this manager; it stays mounted
 *   while dsh is down (not ready-gated) so restart/applying progress stays
 *   pollable (design 18 §9.3 mounting discipline).
 *
 * Single-process invariant: one gateway per stateDir. The owner record is
 * created with O_EXCL (`wx`): a concurrent second gateway fails loud on
 * EEXIST instead of racing a read-check-write window.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire as nodeCreateRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { call as dshCall, type Logger, type PlaneHandle } from '@dsh-chamber/control-plane'
import {
  bindRuntimeInstallResolution,
  buildCachedVersionList,
  buildVersionList,
  canonicalRegistryOrigin,
  cleanupStaleInstalls,
  clearCurrentPointer,
  clearActivationJournal,
  compareRuntimeVersions,
  completeInterruptedRestore,
  deleteOverride,
  downloadVerifiedRegistryTarball,
  evictVersions,
  fetchRegistryMetadata,
  disposeRuntimeInstaller,
  installRuntimeVersion,
  invalidate,
  isSafeVersion,
  latestKnownGood,
  listKnownGoodVersions,
  listValidVersionTrees,
  prepareManualRollbackData,
  readActivationJournalState,
  readCurrentPointer,
  readCurrentPointerState,
  readOverride,
  readOverrideState,
  recordExplicitInstall,
  recordProbePass,
  recordRuntimeFailure,
  restoreSnapshot,
  resolveSnapshotName,
  runRuntimeActivationProbes,
  runStartupPhase,
  runtimeDiskSummary,
  runtimeFailureSummary,
  sanitizeErrorText,
  snapshotSummary,
  shouldInvalidate,
  snapshotDshHome,
  writeActivationIntent,
  writeActivationJournal,
  writeCurrentPointer,
  writeOverride,
  type ActivationIntentKind,
  type ActivationJournal,
  type ActivationJournalState,
  type CurrentPointerState,
  type OverrideRecord,
  type OverrideState,
  type ProbeResult,
  type RuntimeStatusProjection,
  type RuntimeDiskSummary,
  type RuntimeInstallProgress,
  type StartupDeps,
} from '@dsh-chamber/dsh-runtime'
import { sanitizeRouteError } from './sanitize-route-error.ts'
import type { GatewayConfig } from './config.ts'

const gatewayRequire = nodeCreateRequire(import.meta.url)

/**
 * The builtin anchor's real semver (design 18 §9.3 F1): apply-phase snapshots
 * the switching-from source under a semver name, so the anchor workspace must
 * contribute its @deepseek-ai/dsh package version — exactly like desktop's
 * bundledVersion. Unreadable/missing → null (fail-loud at apply time, never a
 * fake snapshot).
 */
export function readBuiltinVersion(anchorPath: string): string | null {
  const candidates = [
    join(anchorPath, 'package.json'),
    join(anchorPath, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(anchorPath, 'apps', 'cli', 'package.json'),
  ]
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as {
        version?: unknown
        dependencies?: Record<string, unknown>
      }
      const version = candidate === candidates[0]
        ? manifest.dependencies?.[DSH_PACKAGE_NAME]
        : manifest.version
      if (typeof version === 'string' && isSafeVersion(version)) return version
    } catch {
      // Try the installed-package manifest after a workspace-root miss. A
      // complete miss remains null and is projected/refused honestly.
    }
  }
  return null
}
const GATEWAY_PACKAGE_VERSION: string = gatewayRequire('../package.json').version as string
const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'
const DEFAULT_REGISTRY_ORIGIN = 'https://registry.npmjs.org'
const GATEWAY_RUNTIME_LOGICAL_DISK_LIMIT_BYTES = 10 * 1024 ** 3
export const GATEWAY_RUNTIME_STATUS_KIND = 'dsh-chamber-gateway-runtime' as const

/** Gateway-owned registry source persistence (owner-only 0600; design 18 §9.3). */
function registryFile(stateRoot: string): string {
  return join(stateRoot, 'registry.json')
}

function registryCorruptEvidence(stateRoot: string): string[] {
  try {
    return readdirSync(stateRoot)
      .filter(name => name.startsWith('registry.json.corrupt-'))
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function quarantineCorruptRegistry(stateRoot: string, reason: string): never {
  const file = registryFile(stateRoot)
  let suffix = `${Date.now()}-${process.pid}`
  let destination = `${file}.corrupt-${suffix}`
  for (let attempt = 1; existsSync(destination); attempt += 1) {
    suffix = `${Date.now()}-${process.pid}-${attempt}`
    destination = `${file}.corrupt-${suffix}`
  }
  try {
    renameSync(file, destination)
    // `registry.json` itself is untrusted authority input. A symlink or a
    // multiply-linked file is preserved by renaming the directory entry, but
    // must never be chmodded afterwards: chmod follows symlinks and a hard
    // link would mutate an inode outside the runtime-owned evidence tree.
    const quarantined = lstatSync(destination)
    if (quarantined.isFile() && !quarantined.isSymbolicLink() && quarantined.nlink === 1) {
      chmodSync(destination, 0o600)
    }
  } catch (error) {
    throw new Error(`gateway runtime registry configuration is corrupt (${reason}) and could not be quarantined: ${sanitizeErrorText(String(error))}`)
  }
  throw new Error(`gateway runtime registry configuration is corrupt (${reason}); original bytes preserved as ${basename(destination)}`)
}

function readRegistryOrigin(stateRoot: string): string {
  const file = registryFile(stateRoot)
  let info
  try {
    info = lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const evidence = registryCorruptEvidence(stateRoot)
    if (evidence.length > 0) {
      throw new Error(`gateway runtime registry configuration remains quarantined (${evidence.at(-1)}); set a valid registry origin to recover`)
    }
    return DEFAULT_REGISTRY_ORIGIN
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    return quarantineCorruptRegistry(stateRoot, 'not a single-link regular file')
  }
  if (info.size > 16 * 1024) return quarantineCorruptRegistry(stateRoot, 'file exceeds 16 KiB')
  try { chmodSync(file, 0o600) } catch (error) {
    throw new Error(`gateway runtime registry permissions could not be tightened: ${sanitizeErrorText(String(error))}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return quarantineCorruptRegistry(stateRoot, 'invalid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return quarantineCorruptRegistry(stateRoot, 'invalid document shape')
  }
  const origin = (parsed as Record<string, unknown>).origin
  if (typeof origin !== 'string' || canonicalRegistryOrigin(origin) !== origin) {
    return quarantineCorruptRegistry(stateRoot, 'origin is missing or non-canonical')
  }
  return origin
}

function writeRegistryOrigin(stateRoot: string, origin: string): void {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  const file = registryFile(stateRoot)
  let tmp = ''
  let fd: number | null = null
  for (let attempt = 0; attempt < 100; attempt += 1) {
    tmp = `${file}.tmp-${process.pid}-${Date.now()}-${attempt}`
    try {
      fd = openSync(tmp, 'wx', 0o600)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  if (fd === null) throw new Error('could not create an exclusive gateway registry temporary file')
  try {
    writeFileSync(fd, `${JSON.stringify({ origin }, null, 2)}\n`)
    closeSync(fd)
    fd = null
    renameSync(tmp, file)
    chmodSync(file, 0o600)
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* already closed */ }
    }
    try { unlinkSync(tmp) } catch { /* no temporary residue */ }
    throw error
  }
}

function ownerFile(stateRoot: string): string {
  return join(stateRoot, 'owner.json')
}

/**
 * Fail-loud single-process guard (design 18 §9.3): one gateway per stateDir.
 * O_EXCL exclusive create closes the read-check-write TOCTOU — a concurrent
 * second owner gets EEXIST; a stale owner whose pid is dead is taken over.
 * A takeover that cannot rewrite the record fails loud; the renamed
 * `owner.json.stale` residue is benign — the next takeover's renameSync
 * atomically replaces it.
 */
const processRuntimeOwnerLeases = new Set<string>()

function assertSingleOwner(stateRoot: string): string {
  const leaseKey = resolve(stateRoot)
  if (processRuntimeOwnerLeases.has(leaseKey)) {
    throw new Error('this process already owns the gateway runtime stateDir; refusing a second manager')
  }
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  const file = ownerFile(stateRoot)
  const payload = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`
  try {
    const fd = openSync(file, 'wx', 0o600)
    writeFileSync(fd, payload)
    closeSync(fd)
    processRuntimeOwnerLeases.add(leaseKey)
    return leaseKey
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  // The on-disk record is also authoritative: a same-pid owner is rejected
  // below (covering duplicate loaded copies of this module), a live foreign
  // pid fails loud, and only a dead foreign pid (ESRCH) is taken over.
  let previousPid: number | null = null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }
    if (typeof parsed.pid === 'number') previousPid = parsed.pid
  } catch {
    previousPid = null
  }
  if (previousPid === process.pid) {
    // The on-disk record is a second, independent guard. Reject even when a
    // duplicate module/bundle has its own in-memory lease Set; otherwise two
    // managers in one Node process can both write the tree and either dispose
    // can unlink the other's owner record.
    throw new Error(`this process (pid ${process.pid}) already owns the gateway runtime stateDir; refusing a second manager`)
  }
  if (previousPid !== null) {
    try {
      process.kill(previousPid, 0)
      throw new Error(`another gateway process (pid ${previousPid}) owns this stateDir; dsh-runtime has no cross-process lock — refusing to start`)
    } catch (error) {
      if (error instanceof Error && error.message.includes('another gateway process')) throw error
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        throw new Error(`another gateway process (pid ${previousPid}) owns this stateDir; dsh-runtime has no cross-process lock — refusing to start`)
      }
      // ESRCH: previous owner is gone — take over below.
    }
  }
  // Atomic takeover: rename the stale record out of the way FIRST — whoever
  // renames wins, and a second taker's rename fails ENOENT (fail-loud) instead
  // of racing an unlink that could remove the winner's fresh file.
  const stale = `${file}.stale`
  try {
    renameSync(file, stale)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('another gateway process is starting concurrently against this stateDir; refusing to start')
    }
    throw error
  }
  try {
    const fd = openSync(file, 'wx', 0o600)
    writeFileSync(fd, payload)
    closeSync(fd)
    try { unlinkSync(stale) } catch { /* already gone */ }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('another gateway process is starting concurrently against this stateDir; refusing to start')
    }
    // Fail loud (review fix): a takeover that cannot rewrite the owner record
    // must NOT continue without any owner record — that would silently disable
    // the single-process guard for this stateDir (a concurrent second gateway
    // could then run against the same stateRoot).
    throw new Error(`gateway runtime owner record could not be rewritten: ${sanitizeErrorText(String(error))}`)
  }
  processRuntimeOwnerLeases.add(leaseKey)
  return leaseKey
}

export interface ResolvedWorkspace {
  path: string
  /** Exact version read from the effective workspace/tree, or null when an
   * external env workspace does not expose a readable exact manifest. */
  version: string | null
  source: 'env' | 'override' | 'builtin'
}

export type GatewayRuntimeStatus = RuntimeStatusProjection & {
  kind: typeof GATEWAY_RUNTIME_STATUS_KIND
  activeVersion: string | null
  builtinVersion: string | null
  currentVersion: string | null
  selectedVersion: string | null
  hasOverride: boolean
  source: 'user-selected' | 'env' | 'builtin-anchor' | null
  phase: 'installing' | 'pending' | 'applying' | 'snapshot-failed' | 'swap-attempted' | 'restore-blocked' | 'idle'
  startupBlockedReason: string | null
  pending: string | null
  connectionState: string
  registry: string | null
  registryError: string | null
  platform: NodeJS.Platform
  mutationsAllowed: boolean
  operationError: string | null
  restart: 'ok' | 'failed' | 'running' | null
  restoreOutcome: string | null
  snapshotCount: number | null
  latestSnapshotAt: string | null
  snapshotError: string | null
  restoreInProgress: boolean | null
  preRollbackCount: number | null
  preRollbackLatestName: string | null
  failure: { version: string; at: string; reason: string } | null
  diskUsage: RuntimeDiskSummary | null
  diskError: string | null
  diskLimitBytes: number
  diskLimitExceeded: boolean | null
  progress: RuntimeInstallProgress | null
}

export interface GatewayRuntimeManager {
  stateRoot(): string
  resolveWorkspace(): ResolvedWorkspace
  /** Candidate-tree override consulted by getDshWorkspacePath during activation. */
  transactionWorkspace: string | null
  startupTransaction(): Promise<{ blockedReason: string | null }>
  status(): Promise<GatewayRuntimeStatus>
  activationFacts(): { sourceVersion: string | null; sourceIsBuiltin: boolean; sourceWasKnownGood: boolean; knownGoodVersion: string | null }
  /** All runtime writers are single-flight, but only activation transactions
   * quarantine the already-running dsh from proxy/feature exposure. */
  mutationInProgress(): boolean
  activationInProgress(): boolean
  internalSpawnActive(): boolean
  listVersions(): Promise<unknown>
  select(version: string): Promise<{ accepted: boolean; version: string }>
  apply(): Promise<{ pending: boolean }>
  rollback(version: string): Promise<{ accepted: boolean }>
  restoreBuiltin(): Promise<{ accepted: boolean }>
  /** Resume an interrupted pointer switch (swap-attempted) by re-running the
   * startup transaction; brings the managed dsh up on a clean verdict. */
  retryApply(): Promise<{ accepted: boolean; blockedReason: string | null }>
  /** Resume an interrupted snapshot restore (restore-half / restore-incomplete)
   * by re-running the startup transaction; brings the managed dsh up on a
   * clean verdict. */
  retryRestore(): Promise<{ accepted: boolean; blockedReason: string | null }>
  restart(): Promise<void>
  restartInFlight(): boolean
  getRegistry(): { origin: string }
  setRegistry(origin: string): Promise<{ origin: string }>
  dispose(): Promise<void>
}

export interface GatewayRuntimeManagerOptions {
  config: GatewayConfig
  plane: PlaneHandle
  logger: Logger
  /** Host-side probe seam. Production executes the complete shared probe
   * list; tests may inject the resulting closed ProbeResult set without
   * opening a real dsh socket. The activation decision remains shared-core. */
  probeCandidate?: (input: {
    version: string
    isBuiltin: boolean
    baseUrl: string
    dshHome: string
  }) => Promise<ProbeResult[]>
  /** Registry fetch seam for deterministic offline/cache tests. */
  fetchMetadata?: typeof fetchRegistryMetadata
  /** Delayed-verdict seam; production keeps the shared two-second delay. */
  waitBeforeRetry?: StartupDeps['waitBeforeRetry']
  /** Host composition hook: detach dsh-derived consumers as soon as an
   * activation quarantine opens, and explicitly resync them after the verdict.
   * Candidate ready edges can otherwise be consumed before the probe decides. */
  onActivationQuarantineChange?: (active: boolean) => void
}

export function createGatewayRuntimeManager(options: GatewayRuntimeManagerOptions): GatewayRuntimeManager {
  const { config, plane, logger } = options
  // baseDir feeds the shared core (which appends `dsh-runtime`); stateRoot is
  // that same directory, used for gateway-owned files and tree paths.
  const baseDir = config.plane.stateDir
  const stateRoot = join(baseDir, 'dsh-runtime')
  const dshHome = join(baseDir, 'dsh-home')
  const anchor = config.plane.dshWorkspacePath
  const envPath = process.env.DSH_GATEWAY_DSH_PATH?.trim() || null
  const shellVersion = GATEWAY_PACKAGE_VERSION
  const builtinVersion = readBuiltinVersion(anchor)

  const ownerLeaseKey = assertSingleOwner(stateRoot)
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })

  let internalSpawn = false
  let activationDepth = 0
  let installInFlight = false
  /** Last select/restart failure, surfaced in status (R7 review: async job
   *  failures must stay observable; cleared by the next successful action). */
  let operationError: string | null = null
  let installProgress: RuntimeInstallProgress | null = null
  const DISK_CACHE_TTL_MS = 30_000
  let diskCache: {
    checkedAt: number
    usage: RuntimeDiskSummary | null
    error: string | null
  } | null = null

  function invalidateDiskCache(): void {
    diskCache = null
  }

  function diskProjection(force = false): { usage: RuntimeDiskSummary | null; error: string | null } {
    const now = Date.now()
    if (!force && diskCache !== null && now - diskCache.checkedAt < DISK_CACHE_TTL_MS) {
      return { usage: diskCache.usage, error: diskCache.error }
    }
    try {
      const usage = runtimeDiskSummary(baseDir, dshHome)
      diskCache = { checkedAt: now, usage, error: null }
    } catch (error) {
      diskCache = {
        checkedAt: now,
        usage: null,
        error: sanitizeRouteError(error instanceof Error ? error.message : String(error)),
      }
    }
    return { usage: diskCache.usage, error: diskCache.error }
  }

  const pnpmEntry = (): string => {
    // pnpm is a real runtime dependency of @dsh-chamber/gateway; resolve from
    // the gateway package root (pnpm itself has no install scripts). NOTE:
    // pnpm's package.json `exports` hides `./bin/pnpm.cjs` (subpath not
    // exported — ERR_PACKAGE_PATH_NOT_EXPORTED), so resolve the package entry
    // (…/pnpm/package.json) and join the bin path by hand.
    return join(dirname(gatewayRequire.resolve('pnpm')), 'bin', 'pnpm.cjs')
  }

  let transactionWorkspace: string | null = null

  function notifyActivationQuarantine(active: boolean): void {
    try {
      options.onActivationQuarantineChange?.(active)
    } catch (error) {
      // Runtime safety must not be rolled back because an optional derived
      // feature consumer failed to resync. The gateway lifecycle logs and can
      // retry attachment on the next authoritative local-state transition.
      logger.warn(`gateway runtime activation resync failed: ${sanitizeErrorText(String(error))}`)
    }
  }

  function beginActivation(): void {
    activationDepth += 1
    if (activationDepth === 1) notifyActivationQuarantine(true)
  }

  function endActivation(): void {
    if (activationDepth <= 0) throw new Error('gateway runtime activation gate underflow')
    activationDepth -= 1
    if (activationDepth === 0) notifyActivationQuarantine(false)
  }

  function requireBuiltinVersion(): string {
    const actual = readBuiltinVersion(anchor)
    if (builtinVersion === null || actual !== builtinVersion) {
      throw new Error('gateway builtin dsh anchor does not expose a stable exact @deepseek-ai/dsh version')
    }
    return builtinVersion
  }

  /** env → matching active override/current → builtin anchor (design 18
   * §3.5/§9.3). Corrupt or contradictory selection metadata is never treated
   * as an absent override; callers fail loud instead of spawning builtin over
   * user-migrated DSH_HOME without a transaction. */
  function resolveWorkspace(): ResolvedWorkspace {
    if (envPath !== null) return { path: envPath, version: readBuiltinVersion(envPath), source: 'env' }
    const pointerState = readCurrentPointerState(baseDir)
    const overrideState = readOverrideState(baseDir)
    if (pointerState.kind === 'corrupt') throw new Error('gateway runtime current pointer is corrupt')
    if (overrideState.kind === 'corrupt') throw new Error('gateway runtime override metadata is corrupt')
    const pointer = pointerState.kind === 'valid' ? pointerState.version : null
    const override = overrideState.kind === 'valid' ? overrideState.record : null
    const overrideActive = override !== null && !shouldInvalidate(override, shellVersion)
    if (overrideActive && pointer !== null) {
      if (!listValidVersionTrees(baseDir).includes(pointer)) {
        throw new Error(`gateway runtime current tree ${pointer} is invalid`)
      }
      return { path: join(stateRoot, pointer), version: pointer, source: 'override' }
    }
    if (pointer !== null) {
      throw new Error('gateway runtime current pointer has no matching active override')
    }
    if (overrideActive) {
      // Gateway select and apply are separate actions. `selectedOnly` is the
      // crash-durable proof that a valid cached/installed choice is merely
      // staged while builtin remains active. Absence/false stays fail-closed:
      // an applied user override whose current pointer disappeared must never
      // silently boot builtin over potentially migrated DSH_HOME.
      const stagedSelection = override.selectedOnly === true
        && override.pending === null
        && override.chosenVersion !== null
        && override.resolvedVersion !== null
        && override.swapAttempted === false
        && override.lastOutcome == null
      const builtinIsAuthoritative = stagedSelection
        || override.pending !== null
        || override.chosenVersion === null
        || override.resolvedVersion === null
        || override.lastOutcome === 'rolled-back'
        || override.lastOutcome === 'failed'
      if (!builtinIsAuthoritative) {
        throw new Error('gateway user runtime override is missing its authoritative current pointer')
      }
    }
    return { path: anchor, version: builtinVersion, source: 'builtin' }
  }

  async function spawnAndProbeCandidate(version: string, isBuiltin: boolean): Promise<ProbeResult[]> {
    const target = isBuiltin ? anchor : join(stateRoot, version)
    transactionWorkspace = target
    internalSpawn = true
    try {
      await plane.startLocal()
      const port = plane.getLocalDshPort()
      if (port === null || !Number.isInteger(port)) throw new Error('managed dsh did not reach readiness for runtime probes')
      const baseUrl = `http://127.0.0.1:${port}`
      return options.probeCandidate !== undefined
        ? await options.probeCandidate({ version, isBuiltin, baseUrl, dshHome })
        : await runRuntimeActivationProbes({
            baseUrl,
            dshHome,
            call: async (url, method, payload, opts) => {
              const response = await dshCall(url, method, payload, { signal: opts?.signal, timeoutMs: opts?.timeoutMs })
              return { result: response.result }
            },
          })
    } finally {
      internalSpawn = false
      transactionWorkspace = null
    }
  }

  function activationFacts(): { sourceVersion: string | null; sourceIsBuiltin: boolean; sourceWasKnownGood: boolean; knownGoodVersion: string | null } {
    const pointer = readCurrentPointer(baseDir)
    const knownGood = listKnownGoodVersions(baseDir)
    const record = readOverride(baseDir)
    return {
      // The builtin anchor contributes its REAL semver as the snapshot source
      // (F1): apply-phase rejects a null sourceVersion as snapshot-failed, so
      // the very first install from the anchor would otherwise never switch.
      sourceVersion: pointer === null ? builtinVersion : pointer,
      sourceIsBuiltin: pointer === null,
      sourceWasKnownGood: pointer === null || knownGood.includes(pointer)
        || (record?.lastOutcome === 'applied' && record.resolvedVersion === pointer),
      knownGoodVersion: latestKnownGood(baseDir, pointer),
    }
  }

  function buildStartupDeps(): StartupDeps {
    return {
      cleanupStaleInstalls: () => cleanupStaleInstalls(baseDir),
      evict: () => evictVersions(baseDir),
      completeInterruptedRestore: () => completeInterruptedRestore(baseDir, dshHome),
      readOverrideState: (): OverrideState => readOverrideState(baseDir),
      writeOverride: (record) => writeOverride(baseDir, record),
      deleteOverride: () => deleteOverride(baseDir),
      readCurrentPointerState: (): CurrentPointerState => readCurrentPointerState(baseDir),
      readActivationJournal: (): ActivationJournalState => readActivationJournalState(baseDir),
      writeActivationJournal: (journal) => writeActivationJournal(baseDir, journal),
      clearActivationJournal: () => clearActivationJournal(baseDir),
      envOverrideActive: () => envPath !== null,
      shellVersion,
      builtinVersion: requireBuiltinVersion(),
      activationFacts,
      snapshot: (sourceVersion) => snapshotDshHome(baseDir, dshHome, sourceVersion),
      resolveSnapshotName: (snapshotName) => resolveSnapshotName(baseDir, snapshotName),
      prepareManualRollback: (targetVersion) => prepareManualRollbackData(baseDir, dshHome, targetVersion),
      validateTarget: (version, isBuiltin) => {
        if (isBuiltin) {
          return version === builtinVersion && readBuiltinVersion(anchor) === builtinVersion
            ? { ok: true as const }
            : { ok: false as const, error: 'builtin anchor manifest does not match the activation target' }
        }
        return listValidVersionTrees(baseDir).includes(version)
          ? { ok: true as const }
          : { ok: false as const, error: `no valid version tree for ${version}` }
      },
      switchPointer: (version) => {
        if (version === null) {
          clearCurrentPointer(baseDir)
        } else {
          writeCurrentPointer(baseDir, version)
        }
      },
      spawnAndProbe: (version, isBuiltin) => spawnAndProbeCandidate(version, isBuiltin),
      stopHost: async () => { await plane.stopLocal() },
      restore: (snapshotPath) => restoreSnapshot(baseDir, dshHome, snapshotPath),
      recordProbePass: (version) => recordProbePass(baseDir, version),
      recordFailure: (input) => recordRuntimeFailure(baseDir, input),
      ...(options.waitBeforeRetry !== undefined ? { waitBeforeRetry: options.waitBeforeRetry } : {}),
    }
  }

  let startupBlockReason: string | null = null

  async function executeStartupTransaction(): Promise<Awaited<ReturnType<typeof runStartupPhase>>> {
    // F4 shell-upgrade fallback (design 18 §3.5): a durable invalidation
    // means the fallback verdict already committed; only a newly observed
    // shell-version mismatch starts the shell-invalidation transaction.
    if (envPath === null) {
      const record = readOverride(baseDir)
      const existingJournal = readActivationJournalState(baseDir)
      if (record !== null && record.invalidatedAt == null && record.shellVersion !== shellVersion
        && existingJournal.kind === 'missing') {
        writeActivationIntent(baseDir, {
          targetVersion: requireBuiltinVersion(),
          targetIsBuiltin: true,
          manualRollback: false,
          intentKind: 'shell-invalidation',
        })
        writeOverride(baseDir, invalidate(record, `gateway shell updated to ${shellVersion}`))
      }
    }
    const startup = await runStartupPhase(buildStartupDeps())
    // The shared core reports `env-override` as a deliberate bypass marker so
    // persisted pending is not touched. For the gateway host this is a healthy
    // startup outcome: env is the highest-priority active runtime, not a block
    // and not an error banner/log entry.
    const result = startup.blockedReason === 'env-override'
      ? { ...startup, blockedReason: null }
      : startup
    invalidateDiskCache()
    startupBlockReason = result.blockedReason
    if (result.blockedReason !== null) {
      logger.error(`gateway runtime startup blocked: ${result.blockedReason}`)
    }
    return result
  }

  async function startupTransaction(): Promise<{ blockedReason: string | null }> {
    assertMutationIdle()
    beginActivation()
    try {
      return { blockedReason: (await executeStartupTransaction()).blockedReason }
    } finally {
      endActivation()
    }
  }

  // ---------------------------------------------------------------------------
  // /chamber/runtime actions (design 18 §9.3 route table)
  // ---------------------------------------------------------------------------

  function activationInProgress(): boolean {
    return activationDepth > 0
  }

  function mutationInProgress(): boolean {
    return activationInProgress() || installInFlight || restartInFlight
  }

  function persistedPendingVersion(): string | null {
    if (envPath !== null) return null
    const state = readOverrideState(baseDir)
    if (state.kind === 'corrupt') throw new Error('gateway runtime override metadata is corrupt')
    if (state.kind !== 'valid' || shouldInvalidate(state.record, shellVersion) || state.record.pending === null) return null
    return state.record.pending
  }

  function ordinaryPendingVersion(): string | null {
    const pending = persistedPendingVersion()
    if (pending === null) return null
    const state = readOverrideState(baseDir)
    if (state.kind !== 'valid') return null
    // These are explicit recovery phases with their own Design 18 actions,
    // not the normal installed/pending terminal state.
    if (state.record.swapAttempted === true || state.record.lastOutcome === 'snapshot-failed'
      || startupBlockReason === 'swap-attempted' || startupBlockReason === 'snapshot-failed'
      || startupBlockReason === 'restore-half' || startupBlockReason === 'restore-incomplete') return null
    return pending
  }

  function assertNoOrdinaryPending(): void {
    const pending = ordinaryPendingVersion()
    if (pending !== null) {
      throw Object.assign(new Error(`runtime version ${pending} is pending; only restore-builtin is allowed until the next startup`), {
        code: 'runtime_pending',
      })
    }
  }

  function assertNoPending(): void {
    const pending = persistedPendingVersion()
    if (pending !== null) {
      throw Object.assign(new Error(`runtime version ${pending} is pending; only restore-builtin is allowed until the next startup`), {
        code: 'runtime_pending',
      })
    }
  }

  function assertMutationIdle(): void {
    if (activationInProgress()) throw Object.assign(new Error('runtime activation in progress'), { code: 'runtime_busy' })
    if (installInFlight) throw Object.assign(new Error('a runtime install is in flight; runtime mutations are refused'), { code: 'runtime_busy' })
    if (restartInFlight) throw Object.assign(new Error('a restart is in flight; runtime mutations are refused'), { code: 'runtime_busy' })
  }

  function internalSpawnActive(): boolean {
    return internalSpawn
  }

  async function status(): Promise<GatewayRuntimeStatus> {
    const overrideState = readOverrideState(baseDir)
    const pointerState = readCurrentPointerState(baseDir)
    const override = overrideState.kind === 'valid' ? overrideState.record : null
    const pointer = pointerState.kind === 'valid' ? pointerState.version : null
    let resolved: ResolvedWorkspace | null = null
    let resolutionError: string | null = null
    try {
      resolved = resolveWorkspace()
    } catch (error) {
      resolutionError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
    }
    let registry: string | null = null
    let registryError: string | null = null
    try {
      registry = readRegistryOrigin(stateRoot)
    } catch (error) {
      registryError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
    }
    let snapshotCount: number | null = null
    let latestSnapshotAt: string | null = null
    let restoreInProgress: boolean | null = null
    let preRollbackCount: number | null = null
    let preRollbackLatestName: string | null = null
    let snapshotError: string | null = null
    try {
      const snapshots = await snapshotSummary(baseDir)
      snapshotCount = snapshots.count
      latestSnapshotAt = snapshots.latestAt
      restoreInProgress = snapshots.restoreInProgress
      preRollbackCount = snapshots.preRollbackCount
      preRollbackLatestName = snapshots.latestStashName
    } catch (error) {
      snapshotError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
    }
    if (startupBlockReason === 'snapshot-failed' && snapshotError === null) {
      snapshotError = override?.lastError ?? 'runtime data snapshot failed'
    }
    const failures = runtimeFailureSummary(baseDir)
    const failure = failures.latest === null ? null : {
      version: failures.latest.version,
      at: failures.latest.lastFailedAt,
      reason: failures.latest.error,
    }
    // Full logical accounting is a synchronous tree walk. Cache it so the
    // authenticated 3s UI poll and gateway identity probes never turn status
    // into a hot 10 GiB filesystem walk; mutations invalidate the cache.
    const { usage: diskUsage, error: diskError } = diskProjection()
    const effectiveBlockedReason = startupBlockReason ?? resolutionError
    const effectivePending = envPath === null && override !== null && !shouldInvalidate(override, shellVersion) && override.pending !== null
      ? override.pending : null
    const ordinaryPending = effectivePending !== null
      && override?.swapAttempted !== true
      && override?.lastOutcome !== 'snapshot-failed'
      && startupBlockReason !== 'swap-attempted'
      && startupBlockReason !== 'snapshot-failed'
      && startupBlockReason !== 'restore-half'
      && startupBlockReason !== 'restore-incomplete'
    return {
      kind: GATEWAY_RUNTIME_STATUS_KIND,
      activeVersion: resolved?.version ?? null,
      builtinVersion,
      currentVersion: pointer,
      selectedVersion: override?.chosenVersion ?? null,
      hasOverride: overrideState.kind !== 'missing',
      source: resolved === null
        ? null
        : resolved.source === 'override'
          ? 'user-selected'
          : resolved.source === 'env'
            ? 'env'
            : 'builtin-anchor',
      phase: activationInProgress() ? 'applying'
        : installInFlight ? 'installing'
        : startupBlockReason === 'snapshot-failed' ? 'snapshot-failed'
        : startupBlockReason === 'swap-attempted' ? 'swap-attempted'
        : startupBlockReason === 'restore-half' || startupBlockReason === 'restore-incomplete' ? 'restore-blocked'
        : ordinaryPending ? 'pending'
        : 'idle',
      // Review fix: blocked startups are projected so clients can see WHY the
      // managed dsh is down and which resume route applies.
      startupBlockedReason: effectiveBlockedReason,
      pending: effectivePending,
      connectionState: plane.connectionState,
      registry,
      registryError,
      platform: process.platform,
      mutationsAllowed: process.platform !== 'win32',
      operationError,
      // Last restart outcome (design 18 §9.3 review fix): 'running' from the
      // moment a restart is accepted until it settles; 'ok'/'failed' terminal.
      // The settings-bridge poll uses this to distinguish a post-202 entry
      // rejection (operationError set, connectionState still 'ready') from a
      // genuine success.
      restart: restartOutcome,
      restoreOutcome: override?.restoreOutcome ?? null,
      snapshotCount,
      latestSnapshotAt,
      snapshotError,
      restoreInProgress,
      preRollbackCount,
      preRollbackLatestName,
      failure,
      diskUsage,
      diskError,
      diskLimitBytes: GATEWAY_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
      diskLimitExceeded: diskUsage === null
        ? null
        : diskUsage.totalBytes >= GATEWAY_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
      progress: installProgress,
    }
  }

  async function listVersions(): Promise<unknown> {
    const origin = readRegistryOrigin(stateRoot)
    const cachedVersions = listValidVersionTrees(baseDir)
    let active: string | null = null
    try { active = resolveWorkspace().version } catch { /* status carries the loud selection error */ }
    try {
      const meta = await (options.fetchMetadata ?? fetchRegistryMetadata)(DSH_PACKAGE_NAME, { origin })
      return {
        registryOrigin: meta.origin,
        versions: buildVersionList(meta, {
          active,
          cachedVersions,
          compatibilityBaseline: null,
        }),
      }
    } catch (error) {
      const versions = buildCachedVersionList(cachedVersions, active).map(entry => (
        entry.version === active && !cachedVersions.includes(entry.version)
          ? { ...entry, cached: false }
          : entry
      ))
      return {
        registryOrigin: origin,
        versions,
        error: sanitizeErrorText(String(error)),
      }
    }
  }

  /** A fresh user selection cancels any STALE intent journal (e.g. a prior
   * rollback's intent whose target no longer matches the selection). Only an
   * 'intent'-phase journal is cleared — an in-flight transaction
   * (prepared/applying/monitoring) keeps its evidence; writeActivationIntent
   * supersedes intent-phase journals and queues nextIntent onto
   * applied-monitoring ones (round-4 fix: rollback → re-select → apply must
   * not strand a mismatched journal that FATAL-blocks the next boot). */
  function clearStaleIntent(): void {
    const state = readActivationJournalState(baseDir)
    if (state.kind === 'valid' && state.journal.phase === 'intent') {
      clearActivationJournal(baseDir)
    }
  }

  function currentPointerVersion(): string | null {
    return readCurrentPointer(baseDir)
  }

  async function select(version: string): Promise<{ accepted: boolean; version: string }> {
    if (process.platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })
    assertNoPending()

    // The version selector always places the active version first. Selecting
    // the builtin anchor's version is therefore a true no-op even though it is
    // not an installed version tree and must never trigger a registry fetch.
    if (resolveWorkspace().version === version) {
      operationError = null
      restartOutcome = null
      return { accepted: true, version }
    }
    const currentAtSelection = currentPointerVersion()

    // Installed tree: the installer would refuse to overwrite a valid tree, so
    // a re-selection never reaches it. Active version → true no-op (§3.6);
    // installed-but-inactive → record the choice so apply() can arm it.
    if (listValidVersionTrees(baseDir).includes(version)) {
      if (currentAtSelection !== version) {
        const previous: OverrideRecord = readOverride(baseDir) ?? {
          shellVersion,
          chosenVersion: null,
          resolvedVersion: null,
          pending: null,
          swapAttempted: false,
        }
        clearStaleIntent()
        writeOverride(baseDir, {
          ...previous,
          shellVersion,
          chosenVersion: version,
          resolvedVersion: version,
          pending: null,
          swapAttempted: false,
          // Only a builtin-active selection can prove that a missing current
          // pointer is expected. When v1 is active and v2 is merely staged,
          // selectedOnly MUST remain false so losing v1's pointer still
          // quarantines DSH_HOME instead of silently falling back to builtin.
          selectedOnly: currentAtSelection === null,
          // Round-3 fix: a fresh user transaction supersedes a failed
          // snapshot — the durable lastOutcome marker must not re-block the
          // next startup (desktop parity: its install writes a fresh record).
          lastOutcome: null,
          lastError: null,
        })
      }
      operationError = null
      restartOutcome = null
      return { accepted: true, version }
    }
    // Install is a writer single-flight, but NOT an activation quarantine:
    // the current dsh/proxy/features remain authoritative and serviceable for
    // the entire download/pnpm window. Only a later startup/apply transaction
    // may close exposure while probing the candidate.
    installInFlight = true
    try {
      // Design 18's 10 GiB limit gates NEW downloads only. Cached selection,
      // rollback and recovery remain available above the soft ceiling.
      const disk = diskProjection(true)
      if (disk.error !== null || disk.usage === null) {
        throw Object.assign(new Error(`cannot confirm gateway runtime disk usage; refusing a new install: ${disk.error ?? 'unknown accounting failure'}`), {
          code: 'runtime_disk_unavailable',
        })
      }
      if (disk.usage.totalBytes >= GATEWAY_RUNTIME_LOGICAL_DISK_LIMIT_BYTES) {
        throw Object.assign(new Error(`gateway runtime logical disk usage reached the ${GATEWAY_RUNTIME_LOGICAL_DISK_LIMIT_BYTES}-byte soft limit; remove an unused version before installing`), {
          code: 'runtime_disk_limit',
        })
      }
      const origin = readRegistryOrigin(stateRoot)
      const meta = await (options.fetchMetadata ?? fetchRegistryMetadata)(DSH_PACKAGE_NAME, { origin })
      const resolution = bindRuntimeInstallResolution(meta, version, origin)
      const result = await installRuntimeVersion({
        baseDir,
        resolution,
        pnpmEntry: pnpmEntry(),
        onProgress: (progress) => { installProgress = progress.stage === 'done' ? null : progress },
        deps: {
          // Empty env: the installer applies its own scrub + HOME/XDG/
          // NPM_CONFIG_USERCONFIG injection; gateway secrets never reach the
          // pnpm child (design 18 §4/§6, S19).
          node: () => ({ file: process.execPath, args: [], env: {} }),
          download: async (res, destination, opts) => {
            await downloadVerifiedRegistryTarball(res, destination, {
              signal: opts.signal,
              onProgress: opts.onProgress,
            })
          },
        },
      })
      // select records the choice WITHOUT pending (design 18 §9.3): apply()
      // is the separate action that arms the next-startup switch.
      recordExplicitInstall(baseDir, version)
      const previous: OverrideRecord = readOverride(baseDir) ?? {
        shellVersion,
        chosenVersion: null,
        resolvedVersion: null,
        pending: null,
        swapAttempted: false,
      }
      clearStaleIntent()
      writeOverride(baseDir, {
        ...previous,
        shellVersion,
        chosenVersion: version,
        resolvedVersion: result.resolvedVersion,
        pending: null,
        swapAttempted: false,
        selectedOnly: currentAtSelection === null,
        // Round-3 fix: a fresh user transaction supersedes a failed snapshot.
        lastOutcome: null,
        lastError: null,
      })
      operationError = null
      restartOutcome = null
      invalidateDiskCache()
      return { accepted: true, version }
    } catch (error) {
      operationError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      installProgress = null
      invalidateDiskCache()
      installInFlight = false
    }
  }

  async function apply(): Promise<{ pending: boolean }> {
    if (process.platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })
    assertNoPending()

    const record: OverrideRecord = readOverride(baseDir) ?? {
      shellVersion,
      chosenVersion: null,
      resolvedVersion: null,
      pending: null,
      swapAttempted: false,
    }
    if (record.chosenVersion === null) throw Object.assign(new Error('no runtime version selected'), { code: 'no_selection' })
    // Round-4 fix: the activation intent must agree with the pending target —
    // a stale intent journal (e.g. from an earlier rollback) would otherwise
    // FATAL-block the next boot on journal-mismatch. writeActivationIntent
    // replaces intent-phase journals and queues onto applied-monitoring ones
    // (desktop parity); an in-flight transaction refuses honestly (409).
    const current = currentPointerVersion()
    try {
      writeActivationIntent(baseDir, {
        targetVersion: record.chosenVersion,
        targetIsBuiltin: false,
        manualRollback: current !== null && compareRuntimeVersions(record.chosenVersion, current) === -1,
        intentKind: 'version-switch',
      })
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: 'runtime_busy' })
    }
    writeOverride(baseDir, {
      ...record,
      shellVersion,
      pending: record.chosenVersion,
      swapAttempted: false,
      selectedOnly: false,
      // Round-3 fix: a fresh apply transaction supersedes a failed snapshot.
      lastOutcome: null,
      lastError: null,
    })
    startupBlockReason = null // round-4: a fresh apply supersedes the in-memory block marker
    operationError = null
    restartOutcome = null
    return { pending: true }
  }

  async function rollback(version: string): Promise<{ accepted: boolean }> {
    if (process.platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })
    assertNoPending()

    if (!listValidVersionTrees(baseDir).includes(version)) {
      throw Object.assign(new Error(`no valid version tree for ${version}`), { code: 'invalid_target' })
    }
    // Manual rollback (design 18 §3.7): journal a manualRollback intent and
    // arm the pending switch — the startup transaction's prepareManualRollback
    // dep performs the pre-rollback stash and records it in the journal (an
    // eager stash here would be orphaned and double the work).
    const record: OverrideRecord = readOverride(baseDir) ?? {
      shellVersion,
      chosenVersion: null,
      resolvedVersion: null,
      pending: null,
      swapAttempted: false,
    }
    // Journal FIRST, then the override (round-4 order fix): a crash between
    // the two writes must not strand a pending override without its
    // manualRollback intent — the intent is the durable record of the
    // transaction's kind; the override only arms it.
    writeActivationIntent(baseDir, {
      targetVersion: version,
      targetIsBuiltin: false,
      manualRollback: true,
      intentKind: 'version-switch' as ActivationIntentKind,
    })
    writeOverride(baseDir, {
      ...record,
      shellVersion,
      chosenVersion: version,
      pending: version,
      swapAttempted: false,
      selectedOnly: false,
      // Round-3 fix: a fresh rollback transaction supersedes a failed snapshot.
      lastOutcome: null,
      lastError: null,
    })
    // Round-4 fix: a fresh transaction supersedes the in-memory blocked
    // phase marker (parity with restoreBuiltin); the durable markers above
    // are the authority — the next boot re-derives any real block.
    startupBlockReason = null
    operationError = null
    restartOutcome = null
    return { accepted: true }
  }

  async function restoreBuiltin(): Promise<{ accepted: boolean }> {
    if (process.platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })

    // Reset-builtin is an activation transaction, not metadata deletion:
    // durable intent → quiesce DSH_HOME → snapshot → atomic pointer clear →
    // full probe gate. Shared startup code deletes the override/journal only
    // after the builtin probe passes; every failure preserves rollback and
    // recovery evidence.
    const targetVersion = requireBuiltinVersion()
    let result: Awaited<ReturnType<typeof runStartupPhase>>
    beginActivation()
    try {
      writeActivationIntent(baseDir, {
        targetVersion,
        targetIsBuiltin: true,
        manualRollback: false,
        intentKind: 'reset-builtin',
      })
      startupBlockReason = null
      await plane.stopLocal()
      result = await executeStartupTransaction()
    } catch (error) {
      operationError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      endActivation()
      invalidateDiskCache()
    }

    // Candidate/fallback probes normally leave a host alive. Snapshot failure
    // never spawns, so explicitly resume the untouched source after releasing
    // the activation gate. Hard recovery/metadata blocks intentionally stay
    // stopped and pollable.
    if (result.blockedReason === null || result.blockedReason === 'snapshot-failed') {
      try {
        await plane.startLocal()
        plane.refreshLocalExposure()
      } catch (error) {
        operationError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
        throw error
      }
    }

    if (result.applyOutcome?.status !== 'applied') {
      const reason = result.applyOutcome?.error
        ?? (result.applyOutcome?.status === 'rolled-back'
          ? 'builtin activation failed; the previous runtime and data were restored'
          : result.blockedReason ?? 'builtin activation did not commit')
      operationError = sanitizeRouteError(reason)
      throw Object.assign(new Error(reason), { code: 'runtime_activation_failed' })
    }
    startupBlockReason = null
    operationError = null
    restartOutcome = null
    return { accepted: true }
  }

  let restartInFlight = false
  /** Last restart outcome, projected in status() (review fix): the settings
   * poll must be able to distinguish a post-202 entry rejection from success
   * even when connectionState has already returned to 'ready'. */
  let restartOutcome: 'ok' | 'failed' | 'running' | null = null

  async function restart(): Promise<void> {
    assertMutationIdle()
    assertNoPending()
    restartInFlight = true
    restartOutcome = 'running'
    try {
      await plane.restartLocal()
      // CONTRACT (design 18 §9.3): resolve ≠ success — restartLocal() also
      // resolves from restart-exhausted / error / stopped (the shared window
      // or a concurrent stop); project that honestly instead of a false 'ok'
      // (review fix: the settings poll must not show「已重启」for a restart
      // that never reached ready).
      const connectionState = plane.connectionState
      // Whitelist (round-3 fix): restartLocal() resolves from
      // restart-exhausted / error / stopped AND can bail on an epoch bump
      // while 'restarting' is still the live state — every non-ready settle
      // is a failure; only ready/degraded (process alive) count as success.
      if (connectionState !== 'ready' && connectionState !== 'degraded') {
        const message = `dsh restart did not reach ready (${connectionState})`
        operationError = message
        restartOutcome = 'failed'
        throw new Error(message)
      }
      operationError = null
      restartOutcome = 'ok'
    } catch (error) {
      if (restartOutcome !== 'failed') {
        operationError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
        restartOutcome = 'failed'
      }
      throw error
    } finally {
      restartInFlight = false
    }
  }

  /** Shared tail of retry-apply / retry-restore: re-run the startup
   * transaction and, on a clean verdict, bring the managed dsh up — the same
   * pairing the gateway start() path performs after the first transaction.
   * NOTE: if the transaction is clean but startLocal() then throws, the
   * retry target marker was already cleared pre-transaction, so the same
   * retry route answers 409 no_retry_target — recovery is a gateway restart;
   * the state stays honest (operationError set, connectionState not ready). */
  async function resumeAfterBlockedStartup(): Promise<{ blockedReason: string | null }> {
    const result = await startupTransaction()
    if (result.blockedReason === null) {
      try {
        await plane.startLocal()
        plane.refreshLocalExposure()
      } catch (error) {
        operationError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
        throw error
      }
    }
    return result
  }

  async function retryApply(): Promise<{ accepted: boolean; blockedReason: string | null }> {
    if (process.platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })
    assertNoOrdinaryPending()
    const record = readOverride(baseDir)
    const interrupted = record !== null && (record.swapAttempted === true || record.lastOutcome === 'snapshot-failed')
    if (!interrupted) {
      throw Object.assign(new Error('no interrupted apply to retry (swap-attempted or snapshot-failed)'), { code: 'no_retry_target' })
    }
    // Mirror the desktop retry-apply (design 18 §3.6): clear the interrupted-
    // switch markers, then re-run the startup transaction so the pending switch
    // proceeds (snapshot → pointer switch → spawn → probe gate). snapshot-failed
    // is included (review fix): the gateway must have a NON-destructive recovery
    // from a snapshot failure, exactly like the desktop's canRetryApply.
    writeOverride(baseDir, { ...record!, swapAttempted: false, lastOutcome: null, lastError: null })
    const result = await resumeAfterBlockedStartup()
    if (result.blockedReason === null) operationError = null
    return { accepted: true, blockedReason: result.blockedReason }
  }

  async function retryRestore(): Promise<{ accepted: boolean; blockedReason: string | null }> {
    if (process.platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })
    assertNoOrdinaryPending()
    if (startupBlockReason !== 'restore-half' && startupBlockReason !== 'restore-incomplete') {
      throw Object.assign(new Error('no interrupted restore to retry'), { code: 'no_retry_target' })
    }
    // The startup transaction itself performs the restore completion (its
    // completeInterruptedRestore dep); re-running it continues the durable
    // journal instead of starting a fresh snapshot.
    return { accepted: true, blockedReason: (await resumeAfterBlockedStartup()).blockedReason }
  }

  function getRegistry(): { origin: string } {
    return { origin: readRegistryOrigin(stateRoot) }
  }

  async function setRegistry(origin: string): Promise<{ origin: string }> {
    if (process.platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); registry mutation is disabled'), { code: 'env_override_active' })
    assertNoPending()
    const canonical = canonicalRegistryOrigin(origin)
    if (canonical === null) throw Object.assign(new Error('invalid registry origin'), { code: 'bad_registry_origin' })
    writeRegistryOrigin(stateRoot, canonical)
    return { origin: canonical }
  }

  async function dispose(): Promise<void> {
    // Reap install children (design 17 §2.1 stop order / S17): a pnpm child
    // left behind would make the next startup's cleanupStaleInstalls refuse
    // to clean a live writer and block boot. The caller MUST await this —
    // disposal only completes once the installer children are reaped.
    try {
      await disposeRuntimeInstaller()
    } catch (error) {
      logger.warn(`gateway runtime installer disposal failed: ${sanitizeErrorText(String(error))}`)
    }
    try { unlinkSync(ownerFile(stateRoot)) } catch { /* no record */ }
    processRuntimeOwnerLeases.delete(ownerLeaseKey)
  }

  return {
    stateRoot: () => stateRoot,
    resolveWorkspace,
    get transactionWorkspace() { return transactionWorkspace },
    set transactionWorkspace(value: string | null) { transactionWorkspace = value },
    startupTransaction,
    status,
    activationFacts,
    mutationInProgress,
    activationInProgress,
    internalSpawnActive,
    listVersions,
    select,
    apply,
    rollback,
    restoreBuiltin,
    retryApply,
    retryRestore,
    restart,
    restartInFlight: () => restartInFlight,
    getRegistry,
    setRegistry,
    dispose,
  }
}
