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
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createRequire as nodeCreateRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { call as dshCall, type Logger, type PlaneHandle } from '@dsh-chamber/control-plane'
import { hasSyncedHostSeed } from './plugins.ts'
import {
  bindRuntimeInstallResolution,
  assertRuntimeRootNoFollow,
  atomicWriteRuntimeFileNoFollow,
  buildCachedVersionList,
  buildVersionList,
  canonicalRegistryOrigin,
  cleanupStaleInstalls,
  clearCurrentPointer,
  clearActivationJournal,
  compareRuntimeVersions,
  completeInterruptedRestore,
  createRuntimeFileExclusiveNoFollow,
  deleteOverride,
  downloadVerifiedRegistryTarball,
  evictVersions,
  ensureRuntimeRootNoFollow,
  fetchRegistryMetadata,
  disposeRuntimeInstaller,
  installRuntimeVersion,
  invalidate,
  isSafeVersion,
  latestKnownGood,
  listKnownGoodVersions,
  listValidVersionTrees,
  noteBoot,
  planRestartExhaustedRollback,
  promoteDueCandidates,
  quarantineRuntimeFileNoFollow,
  prepareManualRollbackData,
  readActivationJournalState,
  readCurrentPointer,
  readCurrentPointerState,
  readOverride,
  readOverrideState,
  readPrivateFileNoFollow,
  recordExplicitInstall,
  PROBE_NAMES_WITHOUT_HOST_DOMAINS,
  recordProbePass,
  recordRuntimeFailure,
  removeKnownGoodCandidate,
  removeRuntimeFileNoFollow,
  resetCandidateHealthWindow,
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
  type RuntimeFileIdentity,
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
function registryFile(baseDir: string): string {
  return join(baseDir, 'dsh-runtime', 'registry.json')
}

function registryCorruptEvidence(baseDir: string): string[] {
  const stateRoot = assertRuntimeRootNoFollow(baseDir)
  try {
    const evidence = readdirSync(stateRoot)
      .filter(name => name.startsWith('registry.json.corrupt-'))
      .sort()
    assertRuntimeRootNoFollow(baseDir)
    return evidence
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function quarantineCorruptRegistry(
  baseDir: string,
  reason: string,
  expectedIdentity?: RuntimeFileIdentity,
): never {
  const file = registryFile(baseDir)
  const destination = `${file}.corrupt-${Date.now()}-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    quarantineRuntimeFileNoFollow(baseDir, file, destination, {
      ...(expectedIdentity === undefined ? {} : { expectedIdentity }),
    })
  } catch (error) {
    throw new Error(`gateway runtime registry configuration is corrupt (${reason}) and could not be quarantined: ${sanitizeErrorText(String(error))}`)
  }
  throw new Error(`gateway runtime registry configuration is corrupt (${reason}); original bytes preserved as ${basename(destination)}`)
}

function readRegistryOrigin(baseDir: string): string {
  assertRuntimeRootNoFollow(baseDir)
  const file = registryFile(baseDir)
  const read = readPrivateFileNoFollow(file, 16 * 1024)
  if (read.kind === 'missing') {
    const evidence = registryCorruptEvidence(baseDir)
    if (evidence.length > 0) {
      throw new Error(`gateway runtime registry configuration remains quarantined (${evidence.at(-1)}); set a valid registry origin to recover`)
    }
    return DEFAULT_REGISTRY_ORIGIN
  }
  if (read.kind === 'unsafe') {
    return quarantineCorruptRegistry(baseDir, 'not a bounded single-link regular file')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(read.raw) as unknown
  } catch {
    return quarantineCorruptRegistry(baseDir, 'invalid JSON', read.identity)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return quarantineCorruptRegistry(baseDir, 'invalid document shape', read.identity)
  }
  const origin = (parsed as Record<string, unknown>).origin
  if (typeof origin !== 'string' || canonicalRegistryOrigin(origin) !== origin) {
    return quarantineCorruptRegistry(baseDir, 'origin is missing or non-canonical', read.identity)
  }
  return origin
}

function writeRegistryOrigin(baseDir: string, origin: string): void {
  atomicWriteRuntimeFileNoFollow(
    baseDir,
    registryFile(baseDir),
    `${JSON.stringify({ origin }, null, 2)}\n`,
  )
}

function ownerFile(stateRoot: string): string {
  return join(stateRoot, 'owner.json')
}

/**
 * Fail-loud single-process guard (design 18 §9.3): one gateway per stateDir.
 * O_EXCL exclusive create closes the read-check-write TOCTOU — a concurrent
 * second owner gets EEXIST; a stale owner whose pid is dead is taken over.
 * A takeover that cannot prove the exact moved bytes and the exact fresh
 * token fails loud. Unique stale evidence is benign and may remain after an
 * ambiguous durability failure.
 */
const processRuntimeOwnerLeases = new Set<string>()

interface RuntimeOwnerLease {
  leaseKey: string
  file: string
  token: string
  payload: string
  identity: RuntimeFileIdentity
}

function verifyFreshRuntimeOwner(file: string, payload: string): RuntimeFileIdentity {
  const proof = readPrivateFileNoFollow(file, 16 * 1024, { tightenMode: false })
  if (proof.kind !== 'valid' || proof.raw !== payload) {
    throw new Error('gateway runtime owner final proof failed; refusing writer authority')
  }
  return proof.identity
}

function restoreMovedRuntimeOwner(file: string, stale: string, movedRaw: string, movedIdentity: RuntimeFileIdentity): void {
  try {
    const current = readPrivateFileNoFollow(file, 16 * 1024, { tightenMode: false })
    if (current.kind !== 'missing') return
    quarantineRuntimeFileNoFollow(dirname(dirname(file)), stale, file, { expectedIdentity: movedIdentity })
    const restored = readPrivateFileNoFollow(file, 16 * 1024, { tightenMode: false })
    if (restored.kind !== 'valid' || restored.raw !== movedRaw) {
      throw new Error('restored owner bytes do not match')
    }
  } catch {
    // Fail-closed: the contender never enters. Exact stale/fresh evidence is
    // retained for the current owner or operator; an unproved restore must
    // never overwrite a third contender.
  }
}

function assertSingleOwner(baseDir: string, beforeStaleRename?: () => void): RuntimeOwnerLease {
  const stateRoot = assertRuntimeRootNoFollow(baseDir)
  const leaseKey = resolve(stateRoot)
  if (processRuntimeOwnerLeases.has(leaseKey)) {
    throw new Error('this process already owns the gateway runtime stateDir; refusing a second manager')
  }
  const file = ownerFile(stateRoot)
  const token = randomBytes(24).toString('hex')
  const payload = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token })}\n`
  try {
    createRuntimeFileExclusiveNoFollow(baseDir, file, payload)
    const identity = verifyFreshRuntimeOwner(file, payload)
    processRuntimeOwnerLeases.add(leaseKey)
    return { leaseKey, file, token, payload, identity }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  // The on-disk record is also authoritative: a same-pid owner is rejected
  // below (covering duplicate loaded copies of this module), a live foreign
  // pid fails loud, and only a dead foreign pid (ESRCH) is taken over.
  let previousPid: number
  const ownerRead = readPrivateFileNoFollow(file, 16 * 1024)
  if (ownerRead.kind !== 'valid') {
    throw new Error('gateway runtime owner record is unsafe or unreadable; refusing to take over without a proven-dead pid')
  }
  try {
    const parsed = JSON.parse(ownerRead.raw) as { pid?: unknown }
    if (typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) {
      throw new Error('invalid pid')
    }
    previousPid = parsed.pid
  } catch {
    throw new Error('gateway runtime owner record is corrupt; refusing to take over without a proven-dead pid')
  }
  if (previousPid === process.pid) {
    // The on-disk record is a second, independent guard. Reject even when a
    // duplicate module/bundle has its own in-memory lease Set; otherwise two
    // managers in one Node process can both write the tree and either dispose
    // can unlink the other's owner record.
    throw new Error(`this process (pid ${process.pid}) already owns the gateway runtime stateDir; refusing a second manager`)
  }
  try {
    process.kill(previousPid, 0)
    throw new Error(`another gateway process (pid ${previousPid}) owns this stateDir; dsh-runtime has no cross-process lock — refusing to start`)
  } catch (error) {
    if (error instanceof Error && error.message.includes('another gateway process')) throw error
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      throw new Error(`another gateway process (pid ${previousPid}) owns this stateDir; dsh-runtime has no cross-process lock — refusing to start`)
    }
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    // ESRCH: previous owner is gone — take over below.
  }
  // Atomic takeover: rename the stale record out of the way FIRST — whoever
  // renames wins, and a second taker's rename fails ENOENT (fail-loud) instead
  // of racing an unlink that could remove the winner's fresh file.
  const stale = `${file}.stale-${process.pid}-${randomBytes(8).toString('hex')}`
  let movedIdentity: RuntimeFileIdentity
  try {
    movedIdentity = quarantineRuntimeFileNoFollow(baseDir, file, stale, {
      expectedIdentity: ownerRead.identity,
      ...(beforeStaleRename === undefined ? {} : { beforeRename: beforeStaleRename }),
    })
  } catch (error) {
    const displaced = readPrivateFileNoFollow(stale, 16 * 1024, { tightenMode: false })
    if (displaced.kind === 'valid') {
      restoreMovedRuntimeOwner(file, stale, displaced.raw, displaced.identity)
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('another gateway process is starting concurrently against this stateDir; refusing to start')
    }
    throw new Error(`gateway runtime stale owner could not be durably claimed: ${sanitizeErrorText(String(error))}`)
  }
  const moved = readPrivateFileNoFollow(stale, 16 * 1024, { tightenMode: false })
  if (moved.kind !== 'valid' || moved.raw !== ownerRead.raw
    || moved.identity.dev !== movedIdentity.dev || moved.identity.ino !== movedIdentity.ino) {
    if (moved.kind === 'valid') restoreMovedRuntimeOwner(file, stale, moved.raw, moved.identity)
    throw new Error('another gateway process replaced the owner during stale takeover; refusing to start')
  }

  let freshIdentity: RuntimeFileIdentity
  try {
    createRuntimeFileExclusiveNoFollow(baseDir, file, payload)
    freshIdentity = verifyFreshRuntimeOwner(file, payload)
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
  try {
    removeRuntimeFileNoFollow(baseDir, stale, { expectedIdentity: moved.identity })
  } catch {
    // Unique stale evidence is non-authoritative. Retain it when cleanup
    // durability is ambiguous; fresh owner authority was already proven.
  }
  processRuntimeOwnerLeases.add(leaseKey)
  return { leaseKey, file, token, payload, identity: freshIdentity }
}

function releaseSingleOwner(baseDir: string, lease: RuntimeOwnerLease): void {
  const current = readPrivateFileNoFollow(lease.file, 16 * 1024, { tightenMode: false })
  if (current.kind !== 'valid' || current.raw !== lease.payload) {
    throw new Error('gateway runtime owner token no longer matches; refusing to release another owner')
  }
  let token: unknown
  try { token = (JSON.parse(current.raw) as { token?: unknown }).token } catch { token = null }
  if (token !== lease.token) {
    throw new Error('gateway runtime owner token no longer matches; refusing to release another owner')
  }
  removeRuntimeFileNoFollow(baseDir, lease.file, { expectedIdentity: current.identity })
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
  /** Sticky public-exposure fence. Unlike activationInProgress(), this remains
   * true after an unsafe blocked verdict so recovery routes stay reachable
   * without allowing the probe-failed runtime to serve users. */
  exposureQuarantined(): boolean
  internalSpawnActive(): boolean
  /** Feed authoritative local-host state edges into the sustained-health
   * monitor. Candidate edges are ignored while activation is quarantined. */
  observeLocalState(status: string): void
  listVersions(): Promise<unknown>
  select(version: string): Promise<{ accepted: boolean; version: string }>
  apply(): Promise<{ pending: boolean }>
  /** Immediately apply the pending/staged version switch inside the current
   * session (design 18 addendum · apply-now): stop → activation transaction →
   * resume. 202 semantics — the caller receives `{ accepted: true }`
   * synchronously and the outcome is projected via status(). */
  applyNow(): Promise<{ accepted: boolean }>
  /** Synchronous apply-now gate (review fix): every manager refusal
   * (platform / busy / env / target resolution / tree validation / no-op)
   * runs here so the route answers a 409/403 BEFORE any 202 can go out —
   * a preflight throw must never be swallowed into a fake 202 whose status
   * never settles. Returns the resolved target version. */
  applyNowPreflight(): string
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
  /** True while an apply-now transaction is running (route gate + status). */
  applyNowInFlight(): boolean
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
    signal?: AbortSignal
  }) => Promise<ProbeResult[]>
  /** Registry fetch seam for deterministic offline/cache tests. */
  fetchMetadata?: typeof fetchRegistryMetadata
  /** Delayed-verdict seam; production keeps the shared two-second delay. */
  waitBeforeRetry?: StartupDeps['waitBeforeRetry']
  /** Sustained-health clock/scheduler seams. Production uses wall clock plus
   * an unref'ed hourly tick; tests can advance the full 24h policy exactly. */
  nowMs?: () => number
  scheduleKnownGoodPromotion?: (callback: () => void) => () => void
  /** Platform adapter seam. Production omits this and uses process.platform;
   * tests use it to prove Windows stays entirely outside POSIX writer paths. */
  platform?: NodeJS.Platform
  /** Deterministic stale-takeover race seam; production callers omit it. */
  ownerTakeoverBeforeRename?: () => void
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
  const platform = options.platform ?? process.platform
  // Windows is an explicitly read-only projection. Do not even enter the
  // POSIX O_NOFOLLOW/O_DIRECTORY writer primitives: Node does not expose
  // equivalent open flags there and a read-only manager must still start.
  const stateRoot = platform === 'win32'
    ? join(baseDir, 'dsh-runtime')
    : ensureRuntimeRootNoFollow(baseDir)
  const dshHome = join(baseDir, 'dsh-home')
  const anchor = config.plane.dshWorkspacePath
  const envPath = process.env.DSH_GATEWAY_DSH_PATH?.trim() || null
  const shellVersion = GATEWAY_PACKAGE_VERSION
  const builtinVersion = readBuiltinVersion(anchor)
  const nowMs = options.nowMs ?? Date.now

  const ownerLease = platform === 'win32'
    ? null
    : assertSingleOwner(baseDir, options.ownerTakeoverBeforeRename)

  let internalSpawn = false
  let activationDepth = 0
  let installInFlight = false
  /** Synchronous edge latch for Design 18 F7. It is armed before the
   * detached rollback promise yields, so repeated restart-exhausted
   * notifications cannot enqueue two writers. */
  let restartExhaustedRollbackInFlight = false
  /** Lifecycle writer barrier. Every public mutation is tracked through its
   * complete promise (including post-installer metadata writes), while the
   * abort signal reaches candidate probes/install children. dispose() retains
   * owner.json until both sets are demonstrably quiescent. */
  let disposed = false
  const lifecycleAbort = new AbortController()
  const activeOperations = new Set<Promise<unknown>>()
  let disposePromise: Promise<void> | null = null
  let localHealthWindowOpen = false
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
    // Bundled shape first (design 18 §9.2 D1): the installer's local
    // (default) path unpacks the gateway tarball and NEVER installs gateway
    // dependencies, so `gatewayRequire.resolve('pnpm')` below cannot hit a
    // real node_modules tree there. scripts/build.mjs copies the pinned pnpm
    // into dist/pnpm (dereferenced); prefer it whenever the build carried it
    // (desktop parity: extraResources). NOTE: dist/pnpm sits next to this
    // bundled module, so derive the path with fileURLToPath — path.dirname
    // over a file:// URL would mangle the path.
    const bundledPnpm = join(dirname(fileURLToPath(import.meta.url)), 'pnpm', 'bin', 'pnpm.cjs')
    if (existsSync(bundledPnpm)) return bundledPnpm
    // Dev / npm-installed shape: pnpm is a real runtime dependency of
    // @dsh-chamber/gateway; resolve from the gateway package root (pnpm itself
    // has no install scripts). NOTE: pnpm's package.json `exports` hides
    // `./bin/pnpm.cjs` (subpath not exported — ERR_PACKAGE_PATH_NOT_EXPORTED),
    // so resolve the package entry (…/pnpm/package.json) and join the bin path
    // by hand.
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
    // Disposal is a permanent quarantine for this manager. A rollback probe
    // may honestly finish after the lifecycle abort, but its endActivation()
    // must never publish a false "open" edge while the final stop proof is
    // still pending (or after an unsafe disposal retained ownership).
    if (activationDepth === 0 && !disposed) notifyActivationQuarantine(false)
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
    if (platform === 'win32') {
      return { path: anchor, version: builtinVersion, source: 'builtin' }
    }
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

  async function spawnAndProbeCandidate(version: string, isBuiltin: boolean, hostDomains: boolean, signal?: AbortSignal): Promise<ProbeResult[]> {
    const target = isBuiltin ? anchor : join(stateRoot, version)
    transactionWorkspace = target
    internalSpawn = true
    try {
      await plane.startLocal()
      const port = plane.getLocalDshPort()
      if (port === null || !Number.isInteger(port)) throw new Error('managed dsh did not reach readiness for runtime probes')
      const baseUrl = `http://127.0.0.1:${port}`
      return options.probeCandidate !== undefined
        ? await options.probeCandidate({ version, isBuiltin, baseUrl, dshHome, signal })
        : await runRuntimeActivationProbes({
            baseUrl,
            dshHome,
            signal,
            // 2026-12 Phase 3 shape gate: a gateway whose seed cache holds no
            // synced chamber host packages hosts a plain dsh — the activation
            // probe skips the chamber host domains until a desktop syncs.
            // The shape is snapshot ONCE per startup transaction (see
            // buildStartupDeps): probe set and verdict-expected set must
            // always agree, or an exact-set drift would spuriously fail a
            // healthy activation.
            hostDomains,
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
    if (platform === 'win32') {
      return {
        sourceVersion: builtinVersion,
        sourceIsBuiltin: true,
        sourceWasKnownGood: true,
        knownGoodVersion: null,
      }
    }
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
    // 2026-12 Phase 3 shape gate: the probe shape is snapshot ONCE per
    // startup transaction. A desktop sync landing mid-transaction must not
    // flip one side (hostDomains) while the verdict expects the other set
    // (probeExpectedNames) — exact-set drift would spuriously fail/roll back
    // a healthy activation. The next transaction re-evaluates the cache, so
    // a mid-transaction sync applies on the following activation (bounded,
    // fail-closed false negative).
    const hostSeedSynced = hasSyncedHostSeed(config.plane.stateDir)
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
      spawnAndProbe: (version, isBuiltin, signal) => spawnAndProbeCandidate(version, isBuiltin, hostSeedSynced, signal),
      probeExpectedNames: hostSeedSynced ? undefined : PROBE_NAMES_WITHOUT_HOST_DOMAINS,
      stopHost: async () => { await plane.stopLocal() },
      restore: (snapshotPath) => restoreSnapshot(baseDir, dshHome, snapshotPath),
      recordProbePass: (version) => recordProbePass(baseDir, version),
      recordFailure: (input) => recordRuntimeFailure(baseDir, input),
      ...(options.waitBeforeRetry !== undefined ? { waitBeforeRetry: options.waitBeforeRetry } : {}),
    }
  }

  let startupBlockReason: string | null = null

  async function executeStartupTransaction(signal: AbortSignal = lifecycleAbort.signal): Promise<Awaited<ReturnType<typeof runStartupPhase>>> {
    // Persisted wall time is not uptime. Every startup/activation transaction
    // closes the prior process-health window; the first authoritative ready
    // edge after the verdict opens a new boot-qualified window.
    try {
      resetCandidateHealthWindow(baseDir, nowMs())
      localHealthWindowOpen = false
    } catch (error) {
      logger.warn(`gateway runtime known-good health reset failed: ${sanitizeErrorText(String(error))}`)
    }
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
    const startup = await runStartupPhase(buildStartupDeps(), signal)
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
    // A probe may leave its candidate/fallback process in `ready` even when
    // the transaction's durable verdict is blocked. Stop it before the owning
    // activation scope calls endActivation(); otherwise that open-quarantine
    // callback can reattach features and the root proxy to a probe-failed
    // runtime. snapshot-failed is the one safe exception: it is decided before
    // pointer mutation and callers intentionally restart the unchanged source.
    if (result.blockedReason !== null && result.blockedReason !== 'snapshot-failed') {
      await plane.stopLocal()
    }
    return result
  }

  async function startupTransaction(): Promise<{ blockedReason: string | null }> {
    assertMutationIdle()
    if (platform === 'win32') {
      startupBlockReason = null
      return { blockedReason: null }
    }
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
    // `disposed` is intentionally sticky: once lifecycle quiescence starts,
    // this manager can never expose or start the managed runtime again. This
    // also keeps exposure closed when a rollback probe ends before dispose()'s
    // final stopLocal() barrier.
    return disposed || activationDepth > 0
  }

  function exposureQuarantined(): boolean {
    // Snapshot failure happens before the pointer is touched; callers may
    // safely restart the unchanged source after the activation window closes.
    // Every other startup block is an unresolved recovery/authority verdict
    // and must remain quarantined until a retry transaction clears it.
    return activationInProgress()
      || (startupBlockReason !== null && startupBlockReason !== 'snapshot-failed')
  }

  function mutationInProgress(): boolean {
    return activationInProgress() || installInFlight || restartInFlight || applyNowInFlight
      || restartExhaustedRollbackInFlight
  }

  function persistedPendingVersion(): string | null {
    if (envPath !== null || platform === 'win32') return null
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
    if (disposed) throw Object.assign(new Error('gateway runtime manager is disposing'), { code: 'runtime_disposed' })
    if (activationInProgress()) throw Object.assign(new Error('runtime activation in progress'), { code: 'runtime_busy' })
    if (installInFlight) throw Object.assign(new Error('a runtime install is in flight; runtime mutations are refused'), { code: 'runtime_busy' })
    if (restartInFlight) throw Object.assign(new Error('a restart is in flight; runtime mutations are refused'), { code: 'runtime_busy' })
    // Review fix: apply-now is a full writer fence from the moment it is
    // accepted (applyNowInFlight=true) — before that the fence only existed
    // via activationDepth, which is a timing coincidence, not a contract.
    if (applyNowInFlight) throw Object.assign(new Error('an apply-now transaction is in flight; runtime mutations are refused'), { code: 'runtime_busy' })
    if (restartExhaustedRollbackInFlight) {
      throw Object.assign(new Error('an automatic restart-exhausted rollback is in flight; runtime mutations are refused'), { code: 'runtime_busy' })
    }
  }

  function assertManagerReadable(): void {
    if (disposed) {
      throw Object.assign(new Error('gateway runtime manager is disposed'), { code: 'runtime_disposed' })
    }
  }

  function internalSpawnActive(): boolean {
    return internalSpawn
  }

  /**
   * Design 18 F7 is emitted by the control-plane restart loop, not by a
   * runtime route. Arm a synchronous latch, then join the manager's existing
   * writer epoch before re-reading every durable/host authority. The initial
   * microtask is intentional: restartLocal() can synchronously publish its
   * terminal edge before the public restart promise has reached
   * trackOperation().
   */
  function scheduleRestartExhaustedRollback(): void {
    if (disposed || platform === 'win32' || envPath !== null || restartExhaustedRollbackInFlight
      || plane.connectionState !== 'restart-exhausted') return

    // Fast-path non-triggering sources before arming the writer latch. The
    // durable state is still re-read after joining prior operations below;
    // this check only guarantees builtin/env restart exhaustion remains a
    // pure host-lifecycle fact with no runtime mutation epoch at all.
    try {
      const observed = resolveWorkspace()
      if (observed.source !== 'override' || observed.version === null) return
    } catch (error) {
      logger.warn(`gateway runtime restart-exhausted observation failed: ${sanitizeErrorText(String(error))}`)
      return
    }

    restartExhaustedRollbackInFlight = true
    let operation!: Promise<void>
    let rollbackDurablyLatched = false
    operation = (async () => {
      await Promise.resolve()

      // A settling writer may enqueue another tracked tail. Drain all OTHER
      // operations to a fixed point while the F7 latch refuses new mutations;
      // exclude this operation itself to avoid a self-wait deadlock.
      while (true) {
        const blockers = [...activeOperations].filter(candidate => candidate !== operation)
        if (blockers.length === 0) break
        await Promise.allSettled(blockers)
      }

      // Authority may have changed while an already-accepted writer settled.
      // F7 is legal only for the still-active override at an authoritative
      // restart-exhausted terminal state; builtin/env never mutate metadata.
      if (disposed || lifecycleAbort.signal.aborted || envPath !== null
        || plane.connectionState !== 'restart-exhausted') return
      const active = resolveWorkspace()
      if (active.source !== 'override' || active.version === null) return

      const failedVersion = active.version
      const plan = planRestartExhaustedRollback({
        restartExhausted: true,
        activeIsOverride: true,
        failedVersion,
        journalState: readActivationJournalState(baseDir),
        now: () => new Date(nowMs()),
      })
      if (plan.status === 'not-triggered') return

      if (plan.status === 'planned') {
        // Exactly-once/crash-recovery latch: this durable rollback-needed
        // record MUST precede candidate mutation, host stop, pointer switch,
        // or DSH_HOME restore. Preserve a concurrently queued next intent so
        // shared startup can re-arm it only after reaching a safe fallback.
        writeActivationJournal(baseDir, {
          ...plan.journal,
          nextIntent: plan.deferredIntent,
        })
      }
      // `already-in-recovery` is itself durable proof; `planned` reaches here
      // only after the write above succeeded. The catch path must not stop a
      // host if creating the F7 latch failed — the shared planner explicitly
      // forbids every rollback side effect before durable rollback-needed.
      rollbackDurablyLatched = true

      restartOutcome = 'failed'
      operationError = `dsh v${failedVersion} exhausted managed restarts; automatic rollback in progress`

      let result: Awaited<ReturnType<typeof runStartupPhase>>
      beginActivation()
      try {
        // A version that exhausted the authoritative host restart policy can
        // no longer earn known-good promotion, even if the following restore
        // itself needs an operator retry.
        removeKnownGoodCandidate(baseDir, failedVersion)
        result = await executeStartupTransaction(lifecycleAbort.signal)
      } finally {
        endActivation()
        invalidateDiskCache()
      }

      if (result.applyOutcome === null) {
        operationError = sanitizeRouteError(
          `restart-exhausted rollback did not complete${result.blockedReason === null ? '' : `: ${result.blockedReason}`}`,
        )
        return
      }

      operationError = sanitizeRouteError(
        result.applyOutcome.error
          ?? (result.applyOutcome.status === 'rolled-back'
            ? `dsh v${failedVersion} exhausted managed restarts and was automatically rolled back`
            : `restart-exhausted rollback ended with ${result.applyOutcome.status}`),
      )

      // Candidate/fallback probes may leave a process alive, but the normal
      // host/exposure lifecycle is re-synchronized only after quarantine has
      // closed. A dispose that raced the probe permanently suppresses this
      // recovery start; dispose's final stop is the ownership-release proof.
      if (!disposed && result.blockedReason === null) {
        await plane.startLocal()
        if (!disposed) plane.refreshLocalExposure()
      }
    })().catch(async (error) => {
      if (!disposed) {
        operationError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
        logger.error(`gateway runtime restart-exhausted rollback failed: ${sanitizeErrorText(String(error))}`)
        if (rollbackDurablyLatched) {
          try {
            await plane.stopLocal()
          } catch (stopError) {
            logger.warn(`gateway runtime restart-exhausted stop failed: ${sanitizeErrorText(String(stopError))}`)
          }
        }
      }
    }).finally(() => {
      restartExhaustedRollbackInFlight = false
    })
    trackOperation(operation)
  }

  function observeLocalState(status: string): void {
    if (disposed || platform === 'win32' || activationInProgress()) return
    if (status !== 'ready') {
      if (localHealthWindowOpen) {
        localHealthWindowOpen = false
        try {
          resetCandidateHealthWindow(baseDir, nowMs())
        } catch (error) {
          logger.warn(`gateway runtime known-good health reset failed: ${sanitizeErrorText(String(error))}`)
        }
      }
      if (status === 'restart-exhausted') scheduleRestartExhaustedRollback()
      return
    }
    if (localHealthWindowOpen) return
    localHealthWindowOpen = true
    try {
      const active = resolveWorkspace()
      if (active.source === 'override' && active.version !== null) {
        noteBoot(baseDir, active.version, nowMs())
        promoteDueCandidates(baseDir, nowMs())
      }
    } catch (error) {
      logger.warn(`gateway runtime known-good boot observation failed: ${sanitizeErrorText(String(error))}`)
    }
  }

  // Promotion is based on a live in-process interval, never elapsed offline
  // wall time. observeLocalState closes the window on every unhealthy edge.
  const runKnownGoodPromotion = () => {
    if (disposed || platform === 'win32' || !localHealthWindowOpen || !plane.localProcessAlive) return
    try {
      promoteDueCandidates(baseDir, nowMs())
    } catch (error) {
      logger.warn(`gateway runtime known-good promotion failed: ${sanitizeErrorText(String(error))}`)
    }
  }
  let cancelKnownGoodPromotion: () => void = () => {}
  try {
    if (platform !== 'win32') {
      cancelKnownGoodPromotion = options.scheduleKnownGoodPromotion !== undefined
        ? options.scheduleKnownGoodPromotion(runKnownGoodPromotion)
        : (() => {
            const timer = setInterval(runKnownGoodPromotion, 60 * 60 * 1_000)
            timer.unref()
            return () => { clearInterval(timer) }
          })()
    }
  } catch (error) {
    // A scheduler may retain the callback and then throw before returning its
    // cancel handle. Permanently fence this abandoned closure before releasing
    // owner authority; any later queued tick becomes a pure no-op.
    disposed = true
    lifecycleAbort.abort()
    if (ownerLease !== null) {
      try {
        releaseSingleOwner(baseDir, ownerLease)
        processRuntimeOwnerLeases.delete(ownerLease.leaseKey)
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], 'gateway runtime construction failed and owner could not be released')
      }
    }
    throw error
  }

  async function status(): Promise<GatewayRuntimeStatus> {
    assertManagerReadable()
    if (platform === 'win32') {
      const resolved = resolveWorkspace()
      return {
        kind: GATEWAY_RUNTIME_STATUS_KIND,
        activeVersion: resolved.version,
        builtinVersion,
        currentVersion: null,
        selectedVersion: null,
        hasOverride: false,
        source: resolved.source === 'env' ? 'env' : 'builtin-anchor',
        phase: 'idle',
        startupBlockedReason: null,
        pending: null,
        connectionState: plane.connectionState,
        registry: DEFAULT_REGISTRY_ORIGIN,
        registryError: null,
        platform,
        mutationsAllowed: false,
        operationError,
        restart: restartOutcome,
        restoreOutcome: null,
        snapshotCount: null,
        latestSnapshotAt: null,
        snapshotError: null,
        restoreInProgress: null,
        preRollbackCount: null,
        preRollbackLatestName: null,
        failure: null,
        diskUsage: null,
        diskError: null,
        diskLimitBytes: GATEWAY_RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
        diskLimitExceeded: null,
        progress: null,
      }
    }
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
      registry = readRegistryOrigin(baseDir)
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
      // apply-now remains applying through its post-quarantine recovery and
      // outcome-projection tail. activationDepth alone opens a false idle/ready
      // poll window after the probe verdict but before startLocal/error state
      // has settled.
      phase: activationInProgress() || applyNowInFlight || restartExhaustedRollbackInFlight ? 'applying'
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
      platform,
      mutationsAllowed: true,
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
    assertManagerReadable()
    const origin = platform === 'win32' ? DEFAULT_REGISTRY_ORIGIN : readRegistryOrigin(baseDir)
    const cachedVersions = platform === 'win32' ? [] : listValidVersionTrees(baseDir)
    let active: string | null = null
    try { active = resolveWorkspace().version } catch { /* status carries the loud selection error */ }
    try {
      const meta = await (options.fetchMetadata ?? fetchRegistryMetadata)(DSH_PACKAGE_NAME, {
        origin,
        signal: lifecycleAbort.signal,
      })
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
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
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
      const origin = readRegistryOrigin(baseDir)
      const meta = await (options.fetchMetadata ?? fetchRegistryMetadata)(DSH_PACKAGE_NAME, {
        origin,
        signal: lifecycleAbort.signal,
      })
      const resolution = bindRuntimeInstallResolution(meta, version, origin)
      const result = await installRuntimeVersion({
        baseDir,
        resolution,
        pnpmEntry: pnpmEntry(),
        signal: lifecycleAbort.signal,
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
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
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
    // The downgrade formula uses the EFFECTIVE active version (pointer ??
    // builtin anchor), exactly like the desktop controller's activeVersion():
    // a builtin-active downgrade is still a real data rollback (manualRollback
    // arms the pre-rollback stash + target-data restore, design 18 §3.7), not
    // a plain switch. The raw pointer would silently narrow that semantic.
    const current = currentPointerVersion() ?? builtinVersion
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
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })
    assertNoPending()

    if (!listValidVersionTrees(baseDir).includes(version)) {
      throw Object.assign(new Error(`no valid version tree for ${version}`), { code: 'invalid_target' })
    }
    // Direction guard (fail-loud): rollback is the DOWNGRADE path only — a
    // same-as-active or newer target is select+apply's job, and accepting it
    // here would journal a manualRollback intent with upgrade semantics (the
    // UI regression this guard closes: the API/dashboard misusing rollback for
    // an upgrade). The comparison uses the EFFECTIVE active version (pointer
    // ?? builtin anchor), the same formula as apply()/applyNowPreflight() and
    // the desktop controller's activeVersion(): a builtin-active downgrade to
    // an installed tree is a legitimate manual rollback (data restore, design
    // 18 §3.7) and stays accepted. `current === null` (no pointer AND no
    // readable builtin version — a broken anchor) is refused: there is no
    // active version to be older than, and switching to an installed tree is
    // a plain select+apply.
    const current = currentPointerVersion() ?? builtinVersion
    if (current === null || compareRuntimeVersions(version, current) !== -1) {
      throw Object.assign(
        new Error(current === null
          ? 'rollback requires an active installed runtime version to roll back from; use select+apply to switch'
          : `rollback target is not older than the active runtime (v${current}); use select+apply to switch to a newer version`),
        { code: 'invalid_target' },
      )
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
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
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
    if (!disposed && (result.blockedReason === null || result.blockedReason === 'snapshot-failed')) {
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
  let applyNowInFlight = false
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

  /**
   * Synchronous apply-now preflight (review R3/R5): every manager gate that
   * can refuse the action runs here, synchronously, so the route can answer a
   * 409/403 BEFORE any 202 goes out — a preflight throw must never be
   * swallowed into a fake 202 whose status never settles (F3).
   *
   * Order: platform → assertMutationIdle (incl. applyNowInFlight) → env →
   * fail-closed metadata/state gates (P2 review fix: corrupt activation
   * journal / in-memory startup block / managed dsh not ready — each mirrors a
   * route-level refusal so a DIRECT manager call refuses identically) → target
   * resolution (ordinary pending, else a NON-invalidated staged chosenVersion;
   * both empty → no_selection) → installed-tree validation → no-op rejection
   * (target already active with no in-flight transaction to continue) → F2 arm
   * of the pending switch when only a selection is staged (journal-first,
   * apply() ordering; manualRollback mirrors apply() :1084).
   *
   * Returns the resolved target version.
   */
  function applyNowPreflight(): string {
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })

    // P2-1 (review fix): a corrupt activation journal must fail closed BEFORE
    // any 202/stop can go out. The startup transaction cannot read it either
    // (runStartupPhase answers journal-corrupt), so proceeding would stop a
    // healthy managed dsh and leave it down. Recovery is the retry/restore
    // surface, never apply-now.
    if (readActivationJournalState(baseDir).kind === 'corrupt') {
      throw Object.assign(new Error('runtime activation journal is corrupt; apply-now refused (recovery required)'), { code: 'runtime_busy' })
    }
    // Direct-call parity with the route's recovery gate: an in-memory startup
    // block (snapshot-failed / swap-attempted / restore-half / restore-
    // incomplete / corrupt metadata) refuses apply-now identically when the
    // manager is called directly, not only through /chamber/runtime/apply-now.
    if (startupBlockReason !== null) {
      throw Object.assign(new Error(`runtime recovery ${startupBlockReason} is required; only the matching retry and restore-builtin are allowed`), { code: 'runtime_recovery_required' })
    }
    // Direct-call parity with the route's connection gate: a managed dsh that
    // never reached ready cannot be switched in-session (mirrors /restart).
    if (plane.connectionState !== 'ready' && plane.connectionState !== 'degraded') {
      throw Object.assign(new Error(`managed dsh is not running (${plane.connectionState}); restore the builtin or retry the interrupted apply/restore before applying now`), { code: 'runtime_busy' })
    }

    // F2: the target is the ordinary pending version when one exists, else the
    // staged chosenVersion (a selectedOnly selection with no pending yet).
    // Both empty → no_selection (never a no-op dsh stop/start cycle). An
    // invalidated record (gateway upgrade, shellVersion mismatch) keeps its
    // chosenVersion but is NOT a valid target — the selection gate must filter
    // it HERE, not at the route's status projection, whose selectedVersion
    // field does not see the invalidation (review R3/R5: a status-based
    // no_selection gate mis-let the stale choice through to a fake 202).
    let target = ordinaryPendingVersion()
    if (target === null) {
      const record = readOverride(baseDir)
      if (record === null || record.chosenVersion === null || shouldInvalidate(record, shellVersion)) {
        throw Object.assign(new Error('no runtime version selected or pending'), { code: 'no_selection' })
      }
      target = record.chosenVersion
    }
    if (!listValidVersionTrees(baseDir).includes(target)) {
      throw Object.assign(new Error(`no valid version tree for ${target}`), { code: 'invalid_target' })
    }

    // No-op rejection: the target is already the active runtime and no
    // transaction is in flight — applying again would run a pointless
    // stop → snapshot → spawn → probe cycle. P2-2 (review fix): the exception
    // was too wide — applied-monitoring (no nextIntent) is the durable end
    // state of every successful apply (pending=null, chosen==active), and the
    // old gate let apply-now through to that empty stop/start loop on the
    // ALREADY-ACTIVE version. Only the crash-continuation phases (prepared /
    // switched / manual-restoring / manual-restored / rollback-needed /
    // restoring / restore-complete / fallback-builtin) still pass — those are
    // real interrupted transactions that apply-now must continue. An
    // applied-monitoring journal WITH nextIntent needs no special case: its
    // nextIntent arms a pending that differs from current, so target !==
    // current above and the transaction proceeds naturally.
    // Effective active version (pointer ?? builtin anchor) — same formula as
    // apply()/rollback() and the desktop controller: a builtin-active staged
    // downgrade arms a real manualRollback below, not a plain switch.
    const current = currentPointerVersion() ?? builtinVersion
    if (target === current) {
      const journal = readActivationJournalState(baseDir)
      if (journal.kind === 'missing'
        || (journal.kind === 'valid'
          && (journal.journal.phase === 'intent' || journal.journal.phase === 'applied-monitoring'))) {
        throw Object.assign(new Error(`dsh v${target} is already the active runtime; apply-now has nothing to do`), { code: 'noop_target' })
      }
    }

    // F2 (continuation): when only the selection is staged (no pending yet),
    // arm the pending switch journal-first — the exact apply() ordering — so
    // runStartupPhase sees effectivePending === targetVersion. assertNoPending
    // is deliberately NOT used: a pending/selection existing is the semantic
    // premise of apply-now.
    if (persistedPendingVersion() === null) {
      const record: OverrideRecord = readOverride(baseDir) ?? {
        shellVersion,
        chosenVersion: null,
        resolvedVersion: null,
        pending: null,
        swapAttempted: false,
      }
      clearStaleIntent()
      try {
        writeActivationIntent(baseDir, {
          targetVersion: target,
          targetIsBuiltin: false,
          // Review fix: mirror apply() :1084's downgrade-aware formula instead
          // of a hardcoded false — a staged downgrade (chosen < current) arms
          // a real manual rollback intent so runStartupPhase prepares the
          // pre-rollback stash, exactly like a rollback()-armed switch.
          manualRollback: current !== null && compareRuntimeVersions(target, current) === -1,
          intentKind: 'version-switch',
        })
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: 'runtime_busy' })
      }
      writeOverride(baseDir, {
        ...record,
        shellVersion,
        chosenVersion: target,
        resolvedVersion: target,
        pending: target,
        swapAttempted: false,
        selectedOnly: false,
        // Round-3 fix: a fresh apply-now transaction supersedes a failed
        // snapshot's durable lastOutcome marker (desktop parity).
        lastOutcome: null,
        lastError: null,
      })
      // Round-4 fix: a fresh transaction supersedes the in-memory blocked
      // phase marker; the durable writes above are the authority.
      startupBlockReason = null
      operationError = null
      restartOutcome = null
    }
    return target
  }

  /**
   * Immediately apply the pending/staged version switch inside the current
   * session (design 18 addendum · apply-now, §5.1): the version-switch twin of
   * restoreBuiltin — durable intent → quiesce DSH_HOME → snapshot → atomic
   * pointer switch → spawn candidate → full probe gate → verdict/rollback.
   * 202 semantics (F3): the caller receives `{ accepted: true }` synchronously;
   * the async job's outcome is projected into status() (operationError /
   * startupBlockReason), never only into the log. Every synchronous refusal
   * happens in applyNowPreflight() BEFORE applyNowInFlight is armed — the
   * route answers 409/403 from the preflight and never sends a fake 202.
   */
  async function applyNow(): Promise<{ accepted: boolean }> {
    // The preflight arms the pending switch (F2) when only a selection is
    // staged; the transaction body below relies on that persisted pending —
    // runStartupPhase derives effectivePending === targetVersion from the
    // override/journal, so `target` needs no separate plumbing into it.
    const target = applyNowPreflight()
    applyNowInFlight = true
    const job = (async () => {
      // P0 (review fix): the recovery segment (startLocal + exposure resync)
      // and the F3 projection run AFTER endActivation() closes the quarantine
      // window — restoreBuiltin order (mirror restoreBuiltin :1180-1192). The
      // OLD placement ran the recovery startLocal INSIDE
      // beginActivation()…endActivation(), where index.ts's canStartLocal gate
      // (activationInProgress() && !internalSpawnActive() → connection_busy)
      // refuses every non-internal spawn → every production apply-now recovery
      // threw connection_busy and the operationError was overwritten with the
      // misleading 'dsh runtime activation in progress'.
      let result: Awaited<ReturnType<typeof runStartupPhase>> | null = null
      try {
        // P2-4 (review fix): a new transaction supersedes any stale projection
        // from a previous select/restart/apply-now the moment it is accepted —
        // the 202 window must not keep echoing the last failure's text.
        operationError = null
        beginActivation()
        try {
          await plane.stopLocal()
          result = await executeStartupTransaction(lifecycleAbort.signal)
        } finally {
          endActivation()
          invalidateDiskCache()
        }
        // P2-5 (review fix): stop()/dispose() during the in-flight job must
        // never let the recovery startLocal resurrect the managed dsh.
        if (disposed) return
        if (result.blockedReason === null || result.blockedReason === 'snapshot-failed') {
          await plane.startLocal()
          plane.refreshLocalExposure()
        }
        // F3: the 202 job's failure must project into manager state (restart
        // parity) — the settings poll reads these fields, not the log. Hard
        // recovery/metadata blocks stay stopped and pollable (restoreBuiltin
        // :1180-1192 semantics); executeStartupTransaction already projected
        // startupBlockReason = result.blockedReason.
        if (result.applyOutcome?.status !== 'applied') {
          operationError = sanitizeRouteError(result.applyOutcome?.error ?? result.blockedReason ?? 'runtime apply-now did not commit')
        } else {
          operationError = null
        }
      } catch (error) {
        operationError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
      } finally {
        applyNowInFlight = false
      }
    })()
    trackOperation(job)
    return { accepted: true }
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
    if (!disposed && result.blockedReason === null) {
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
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
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
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
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
    assertManagerReadable()
    return { origin: platform === 'win32' ? DEFAULT_REGISTRY_ORIGIN : readRegistryOrigin(baseDir) }
  }

  async function setRegistry(origin: string): Promise<{ origin: string }> {
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); registry mutation is disabled'), { code: 'env_override_active' })
    assertNoPending()
    const canonical = canonicalRegistryOrigin(origin)
    if (canonical === null) throw Object.assign(new Error('invalid registry origin'), { code: 'bad_registry_origin' })
    writeRegistryOrigin(baseDir, canonical)
    return { origin: canonical }
  }

  function trackOperation<T>(operation: Promise<T>): Promise<T> {
    activeOperations.add(operation)
    void operation.then(
      () => { activeOperations.delete(operation) },
      () => { activeOperations.delete(operation) },
    )
    return operation
  }

  async function drainOperations(): Promise<void> {
    // A settling operation can enqueue its detached apply-now job before its
    // own promise resolves, so drain to a fixed point rather than one snapshot.
    while (activeOperations.size > 0) {
      await Promise.allSettled([...activeOperations])
    }
  }

  function dispose(): Promise<void> {
    if (disposePromise !== null) return disposePromise
    disposed = true
    notifyActivationQuarantine(true)
    try {
      cancelKnownGoodPromotion()
    } catch (error) {
      // The callback itself is fenced by `disposed`, so a scheduler adapter
      // cancellation failure cannot retain runtime writer authority or skip
      // the real abort/drain/final-stop proof.
      logger.warn(`gateway runtime known-good scheduler cancellation failed: ${sanitizeErrorText(String(error))}`)
    }
    lifecycleAbort.abort()
    disposePromise = (async () => {
      // Epoch-fence any startLocal() that is currently waiting for readiness.
      // A later rollback probe is allowed to finish honestly; the second stop
      // below is the final process-quiescence proof.
      try {
        await plane.stopLocal()
      } catch (error) {
        logger.warn(`gateway runtime initial stop failed during disposal: ${sanitizeErrorText(String(error))}`)
      }

      let installerError: unknown = null
      try {
        await disposeRuntimeInstaller()
      } catch (error) {
        installerError = error
        logger.warn(`gateway runtime installer disposal failed: ${sanitizeErrorText(String(error))}`)
      }

      await drainOperations()

      // Abort can intentionally hand an already-started rollback probe a fresh
      // signal. Stop once more after every writer settles so no recovery spawn
      // survives ownership release.
      let finalStopError: unknown = null
      try {
        await plane.stopLocal()
      } catch (error) {
        finalStopError = error
      }

      if (installerError !== null || finalStopError !== null) {
        const reasons = [installerError, finalStopError].filter((error): error is {} => error !== null)
        throw new AggregateError(reasons, 'gateway runtime writers could not be proven quiescent; owner retained')
      }

      if (ownerLease !== null) {
        releaseSingleOwner(baseDir, ownerLease)
        processRuntimeOwnerLeases.delete(ownerLease.leaseKey)
      }
    })()
    return disposePromise
  }

  return {
    stateRoot: () => stateRoot,
    resolveWorkspace: () => {
      assertManagerReadable()
      return resolveWorkspace()
    },
    get transactionWorkspace() { return transactionWorkspace },
    set transactionWorkspace(value: string | null) { transactionWorkspace = value },
    startupTransaction: () => trackOperation(startupTransaction()),
    status,
    activationFacts: () => {
      assertManagerReadable()
      return activationFacts()
    },
    mutationInProgress,
    activationInProgress,
    exposureQuarantined,
    internalSpawnActive,
    observeLocalState,
    listVersions,
    select: (version) => trackOperation(select(version)),
    apply: () => trackOperation(apply()),
    applyNow,
    applyNowPreflight,
    rollback: (version) => trackOperation(rollback(version)),
    restoreBuiltin: () => trackOperation(restoreBuiltin()),
    retryApply: () => trackOperation(retryApply()),
    retryRestore: () => trackOperation(retryRestore()),
    restart: () => trackOperation(restart()),
    restartInFlight: () => restartInFlight,
    applyNowInFlight: () => applyNowInFlight,
    getRegistry,
    setRegistry: (origin) => trackOperation(setRegistry(origin)),
    dispose,
  }
}
