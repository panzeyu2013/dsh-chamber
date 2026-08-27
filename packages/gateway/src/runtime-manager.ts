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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire as nodeCreateRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { call as dshCall, type Logger, type PlaneHandle } from '@dsh-chamber/control-plane'
import {
  bindRuntimeInstallResolution,
  buildVersionList,
  canonicalRegistryOrigin,
  cleanupStaleInstalls,
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
  sanitizeErrorText,
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
  try {
    const manifest = JSON.parse(readFileSync(join(anchorPath, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : null
  } catch {
    return null
  }
}
const GATEWAY_PACKAGE_VERSION: string = gatewayRequire('../package.json').version as string
const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'

/** Gateway-owned registry source persistence (owner-only 0600; design 18 §9.3). */
function registryFile(stateRoot: string): string {
  return join(stateRoot, 'registry.json')
}

function readRegistryOrigin(stateRoot: string): string {
  const file = registryFile(stateRoot)
  if (!existsSync(file)) return 'https://registry.npmjs.org'
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { origin?: unknown }
    return typeof parsed.origin === 'string' && parsed.origin !== '' ? parsed.origin : 'https://registry.npmjs.org'
  } catch {
    return 'https://registry.npmjs.org'
  }
}

function writeRegistryOrigin(stateRoot: string, origin: string): void {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  const tmp = `${registryFile(stateRoot)}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ origin }, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, registryFile(stateRoot))
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
function assertSingleOwner(stateRoot: string): void {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  const file = ownerFile(stateRoot)
  const payload = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`
  try {
    const fd = openSync(file, 'wx', 0o600)
    writeFileSync(fd, payload)
    closeSync(fd)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  // Existing owner: same process re-entry is fine; a live foreign pid fails
  // loud; a dead pid (ESRCH) is taken over with another exclusive create.
  let previousPid: number | null = null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }
    if (typeof parsed.pid === 'number') previousPid = parsed.pid
  } catch {
    previousPid = null
  }
  if (previousPid !== null && previousPid !== process.pid) {
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
}

export interface ResolvedWorkspace {
  path: string
  source: 'env' | 'override' | 'builtin'
}

export interface GatewayRuntimeManager {
  stateRoot(): string
  resolveWorkspace(): ResolvedWorkspace
  /** Candidate-tree override consulted by getDshWorkspacePath during activation. */
  transactionWorkspace: string | null
  startupTransaction(): Promise<{ blockedReason: string | null }>
  status(): RuntimeStatusProjection
  activationFacts(): { sourceVersion: string | null; sourceIsBuiltin: boolean; sourceWasKnownGood: boolean; knownGoodVersion: string | null }
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
  const builtinVersion = readBuiltinVersion(anchor) ?? 'builtin-anchor'

  assertSingleOwner(stateRoot)
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 })

  let internalSpawn = false
  let activationDepth = 0
  /** Last select/restart failure, surfaced in status (R7 review: async job
   *  failures must stay observable; cleared by the next successful action). */
  let operationError: string | null = null

  const pnpmEntry = (): string => {
    // pnpm is a real runtime dependency of @dsh-chamber/gateway; resolve from
    // the gateway package root (pnpm itself has no install scripts). NOTE:
    // pnpm's package.json `exports` hides `./bin/pnpm.cjs` (subpath not
    // exported — ERR_PACKAGE_PATH_NOT_EXPORTED), so resolve the package entry
    // (…/pnpm/package.json) and join the bin path by hand.
    return join(dirname(gatewayRequire.resolve('pnpm')), 'bin', 'pnpm.cjs')
  }

  let transactionWorkspace: string | null = null

  function versionForWorkspace(path: string): string {
    if (path === anchor) return 'builtin-anchor'
    return path.split('/').at(-1) ?? 'unknown'
  }

  /** env → override (valid tree) → builtin anchor (design 18 §9.3). */
  function resolveWorkspace(): ResolvedWorkspace {
    if (envPath !== null) return { path: envPath, source: 'env' }
    const pointer = readCurrentPointer(baseDir)
    const override = readOverride(baseDir)
    // The override branch honours invalidation (design 18 §3.5/§9.3「未失效
    // 时」+ F4): a shell upgrade invalidates the old override and the chain
    // falls back to the builtin anchor instead of re-spawning a stale tree.
    const overrideValid = override === null || !shouldInvalidate(override, shellVersion)
    if (overrideValid && pointer !== null && listValidVersionTrees(baseDir).includes(pointer)) {
      return { path: join(stateRoot, pointer), source: 'override' }
    }
    return { path: anchor, source: 'builtin' }
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
      return await runRuntimeActivationProbes({
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
    return {
      // The builtin anchor contributes its REAL semver as the snapshot source
      // (F1): apply-phase rejects a null sourceVersion as snapshot-failed, so
      // the very first install from the anchor would otherwise never switch.
      sourceVersion: pointer === null ? (readBuiltinVersion(anchor) ?? null) : pointer,
      sourceIsBuiltin: pointer === null,
      sourceWasKnownGood: pointer !== null && knownGood.includes(pointer),
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
      builtinVersion,
      activationFacts,
      snapshot: (sourceVersion) => snapshotDshHome(baseDir, dshHome, sourceVersion),
      resolveSnapshotName: (snapshotName) => resolveSnapshotName(baseDir, snapshotName),
      prepareManualRollback: (targetVersion) => prepareManualRollbackData(baseDir, dshHome, targetVersion),
      validateTarget: (version, isBuiltin) => {
        if (isBuiltin) return { ok: true as const }
        return listValidVersionTrees(baseDir).includes(version)
          ? { ok: true as const }
          : { ok: false as const, error: `no valid version tree for ${version}` }
      },
      switchPointer: (version) => {
        if (version === null) {
          try { unlinkSync(join(stateRoot, 'current')) } catch { /* absent pointer is a no-op */ }
        } else {
          writeCurrentPointer(baseDir, version)
        }
      },
      spawnAndProbe: (version, isBuiltin) => spawnAndProbeCandidate(version, isBuiltin),
      stopHost: async () => { await plane.stopLocal() },
      restore: (snapshotPath) => restoreSnapshot(baseDir, dshHome, snapshotPath),
      recordProbePass: (version) => recordProbePass(baseDir, version),
      recordFailure: (input) => recordRuntimeFailure(baseDir, input),
    }
  }

  let startupBlockReason: string | null = null

  async function startupTransaction(): Promise<{ blockedReason: string | null }> {
    activationDepth += 1
    try {
      // F4 shell-upgrade fallback (design 18 §3.5): a durable invalidation
      // means the fallback verdict already committed; only a newly observed
      // shell-version mismatch starts the shell-invalidation transaction.
      if (envPath === null) {
        const record = readOverride(baseDir)
        if (record !== null && record.invalidatedAt == null && record.shellVersion !== shellVersion) {
          writeActivationIntent(baseDir, {
            targetVersion: 'builtin-anchor',
            targetIsBuiltin: true,
            manualRollback: false,
            intentKind: 'shell-invalidation',
          })
          writeOverride(baseDir, invalidate(record, `gateway shell updated to ${shellVersion}`))
        }
      }
      const result = await runStartupPhase(buildStartupDeps())
      startupBlockReason = result.blockedReason
      if (result.blockedReason !== null) {
        logger.error(`gateway runtime startup blocked: ${result.blockedReason}`)
      }
      return { blockedReason: result.blockedReason }
    } finally {
      activationDepth -= 1
    }
  }

  // ---------------------------------------------------------------------------
  // /chamber/runtime actions (design 18 §9.3 route table)
  // ---------------------------------------------------------------------------

  function activationInProgress(): boolean {
    return activationDepth > 0
  }

  function internalSpawnActive(): boolean {
    return internalSpawn
  }

  function status(): RuntimeStatusProjection {
    const resolved = resolveWorkspace()
    const override = readOverride(baseDir)
    const pointer = readCurrentPointer(baseDir)
    return {
      activeVersion: pointer ?? versionForWorkspace(resolved.path),
      source: resolved.source === 'override' ? 'user-selected' : resolved.source === 'env' ? 'env' : 'builtin-anchor',
      phase: activationInProgress() ? 'applying'
        : startupBlockReason === 'snapshot-failed' ? 'snapshot-failed'
        : startupBlockReason === 'swap-attempted' ? 'swap-attempted'
        : startupBlockReason === 'restore-half' || startupBlockReason === 'restore-incomplete' ? 'restore-blocked'
        : 'idle',
      // Review fix: blocked startups are projected so clients can see WHY the
      // managed dsh is down and which resume route applies.
      startupBlockedReason: startupBlockReason,
      pending: envPath === null && override !== null && !shouldInvalidate(override, shellVersion) && override.pending !== null
        ? override.pending : null,
      connectionState: plane.connectionState,
      registry: readRegistryOrigin(stateRoot),
      platform: process.platform,
      mutationsAllowed: process.platform !== 'win32',
      operationError,
      // Last restart outcome (design 18 §9.3 review fix): 'running' from the
      // moment a restart is accepted until it settles; 'ok'/'failed' terminal.
      // The settings-bridge poll uses this to distinguish a post-202 entry
      // rejection (operationError set, connectionState still 'ready') from a
      // genuine success.
      restart: restartOutcome,
    }
  }

  async function listVersions(): Promise<unknown> {
    const origin = readRegistryOrigin(stateRoot)
    try {
      const meta = await fetchRegistryMetadata(DSH_PACKAGE_NAME, { origin })
      return {
        registryOrigin: meta.origin,
        versions: buildVersionList(meta, {
          active: readCurrentPointer(baseDir),
          cachedVersions: listValidVersionTrees(baseDir),
          compatibilityBaseline: null,
        }),
      }
    } catch (error) {
      return { registryOrigin: origin, versions: [], error: sanitizeErrorText(String(error)) }
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
    if (activationInProgress()) throw Object.assign(new Error('runtime activation in progress'), { code: 'runtime_busy' })
    // Review fix: runtime mutations are refused while a restart transaction is
    // in flight (the design serializes runtime ops; an up-to-10-minute install
    // must not run concurrently with the stop/respawn window).
    if (restartInFlight) throw Object.assign(new Error('a restart is in flight; runtime mutations are refused'), { code: 'runtime_busy' })
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })

    // Installed tree: the installer would refuse to overwrite a valid tree, so
    // a re-selection never reaches it. Active version → true no-op (§3.6);
    // installed-but-inactive → record the choice so apply() can arm it.
    if (listValidVersionTrees(baseDir).includes(version)) {
      if (readCurrentPointer(baseDir) !== version) {
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
          // Round-3 fix: a fresh user transaction supersedes a failed
          // snapshot — the durable lastOutcome marker must not re-block the
          // next startup (desktop parity: its install writes a fresh record).
          lastOutcome: null,
          lastError: null,
        })
      }
      operationError = null
      startupBlockReason = null // round-4: a fresh selection supersedes the in-memory block marker
      return { accepted: true, version }
    }
    activationDepth += 1
    try {
      const origin = readRegistryOrigin(stateRoot)
      const meta = await fetchRegistryMetadata(DSH_PACKAGE_NAME, { origin })
      const resolution = bindRuntimeInstallResolution(meta, version, origin)
      const result = await installRuntimeVersion({
        baseDir,
        resolution,
        pnpmEntry: pnpmEntry(),
        onProgress: () => {},
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
        // Round-3 fix: a fresh user transaction supersedes a failed snapshot.
        lastOutcome: null,
        lastError: null,
      })
      operationError = null
      startupBlockReason = null // round-4: a fresh selection supersedes the in-memory block marker
      return { accepted: true, version }
    } catch (error) {
      operationError = sanitizeRouteError(error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      activationDepth -= 1
    }
  }

  async function apply(): Promise<{ pending: boolean }> {
    if (process.platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    if (activationInProgress()) throw Object.assign(new Error('runtime activation in progress'), { code: 'runtime_busy' })
    if (restartInFlight) throw Object.assign(new Error('a restart is in flight; runtime mutations are refused'), { code: 'runtime_busy' })
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })

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
      // Round-3 fix: a fresh apply transaction supersedes a failed snapshot.
      lastOutcome: null,
      lastError: null,
    })
    startupBlockReason = null // round-4: a fresh apply supersedes the in-memory block marker
    return { pending: true }
  }

  async function rollback(version: string): Promise<{ accepted: boolean }> {
    if (process.platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    if (activationInProgress()) throw Object.assign(new Error('runtime activation in progress'), { code: 'runtime_busy' })
    if (restartInFlight) throw Object.assign(new Error('a restart is in flight; runtime mutations are refused'), { code: 'runtime_busy' })
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })

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
      // Round-3 fix: a fresh rollback transaction supersedes a failed snapshot.
      lastOutcome: null,
      lastError: null,
    })
    // Round-4 fix: a fresh transaction supersedes the in-memory blocked
    // phase marker (parity with restoreBuiltin); the durable markers above
    // are the authority — the next boot re-derives any real block.
    startupBlockReason = null
    return { accepted: true }
  }

  async function restoreBuiltin(): Promise<{ accepted: boolean }> {
    if (process.platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    if (activationInProgress()) throw Object.assign(new Error('runtime activation in progress'), { code: 'runtime_busy' })
    if (restartInFlight) throw Object.assign(new Error('a restart is in flight; runtime mutations are refused'), { code: 'runtime_busy' })
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })

    // Reset-builtin (design 18 §3.6): clear the override AND the activation
    // journal — a residual applied-monitoring journal with the pointer gone
    // would otherwise land on journal-mismatch and block the next startup.
    deleteOverride(baseDir)
    clearActivationJournal(baseDir)
    try { unlinkSync(join(stateRoot, 'current')) } catch { /* absent pointer is a no-op */ }
    // Review fix: a blocked-start state (swap-attempted / restore-half /
    // restore-incomplete) is exited by the reset — project the fresh state
    // instead of a stale blocked phase. dsh stays stopped: the operator
    // restarts the gateway service (or the builtin tree is spawned by the
    // next start); the reduced settings view offers no start route (round-3).
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
    if (activationInProgress()) throw Object.assign(new Error('runtime activation in progress; restart refused'), { code: 'runtime_busy' })
    if (restartInFlight) throw Object.assign(new Error('a restart is already in flight'), { code: 'runtime_busy' })
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
    if (activationInProgress()) throw Object.assign(new Error('runtime activation in progress'), { code: 'runtime_busy' })
    if (restartInFlight) throw Object.assign(new Error('a restart is in flight; runtime mutations are refused'), { code: 'runtime_busy' })
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })
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
    if (activationInProgress()) throw Object.assign(new Error('runtime activation in progress'), { code: 'runtime_busy' })
    if (restartInFlight) throw Object.assign(new Error('a restart is in flight; runtime mutations are refused'), { code: 'runtime_busy' })
    if (envPath !== null) throw Object.assign(new Error('runtime is pinned by DSH_GATEWAY_DSH_PATH (env always wins); version mutations are disabled'), { code: 'env_override_active' })
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
  }

  return {
    stateRoot: () => stateRoot,
    resolveWorkspace,
    get transactionWorkspace() { return transactionWorkspace },
    set transactionWorkspace(value: string | null) { transactionWorkspace = value },
    startupTransaction,
    status,
    activationFacts,
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
