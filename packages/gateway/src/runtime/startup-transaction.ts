/**
 * Gateway runtime startup transaction: the candidate/env probe spawns, the
 * shared-core StartupDeps assembly, the runStartupPhase driver (F4
 * shell-invalidation arming, env-override probe gate, blocked projection), the
 * bounded snapshot maintenance and the candidate-workspace latch consulted by
 * getDshWorkspacePath.
 *
 * Owns one piece of state — the transaction workspace latch (single writer:
 * the probe spawns). Every other input is an explicit handle.
 */
import { join } from 'node:path'

import {
  call as dshCall,
  isLegacyHostProbeValue,
  type Logger,
} from '@dsh-chamber/control-plane'
import {
  activationProbeNamesForDomains,
  clearActivationJournal,
  clearCurrentPointer,
  cleanupStaleInstalls,
  completeInterruptedRestore,
  deleteOverride,
  evictVersions,
  invalidate,
  listValidVersionTrees,
  prepareManualRollbackData,
  PROBE_NAMES_WITHOUT_HOST_DOMAINS,
  PROBE_TEXT_KEEP_TOKENS,
  pruneRuntimeSnapshots,
  readActivationJournalState,
  readAnchorVersion,
  readCurrentPointerState,
  readOverrideState,
  recordProbePass,
  recordRuntimeFailure,
  resetCandidateHealthWindow,
  resolveSnapshotName,
  restoreSnapshot,
  runRuntimeActivationProbes,
  runStartupPhase,
  sanitizeErrorText,
  snapshotDshHome,
  writeActivationIntent,
  writeActivationJournal,
  writeCurrentPointer,
  writeOverride,
  type ActivationJournalState,
  type CurrentPointerState,
  type OverrideState,
  type ProbeResult,
  type StartupDeps,
} from '@dsh-chamber/dsh-runtime'
import { syncedHostDomainProbeNames } from '../plugins.ts'
import type { RuntimeModuleContext } from './context.ts'

/** Host-side probe seam: production executes the complete shared probe list;
 * tests inject a closed ProbeResult set without opening a real dsh socket. */
export type ProbeCandidate = (input: {
  version: string
  isBuiltin: boolean
  baseUrl: string
  dshHome: string
  signal?: AbortSignal
}) => Promise<ProbeResult[]>

export interface StartupTransactionDeps extends RuntimeModuleContext {
  logger: Logger
  stateRoot: string
  dshHome: string
  anchor: string
  shellVersion: string
  builtinVersion: string | null
  nowMs: () => number
  /** Immutable construction-time env override (DSH_GATEWAY_DSH_PATH). */
  probeCandidate?: ProbeCandidate | undefined
  waitBeforeRetry?: StartupDeps['waitBeforeRetry'] | undefined
  assertMutationIdle(): void
  hooks: {
    invalidateDiskCache(): void
    setStartupBlockReason(value: string | null): void
    setOperationError(value: string | null): void
  }
}

export interface StartupTransactionRunner {
  spawnAndProbeCandidate(version: string, isBuiltin: boolean, hostDomainNames: readonly string[], signal?: AbortSignal): Promise<ProbeResult[]>
  executeStartupTransaction(signal?: AbortSignal): Promise<Awaited<ReturnType<typeof runStartupPhase>>>
  startupTransaction(): Promise<{ blockedReason: string | null }>
  transactionWorkspace(): string | null
  setTransactionWorkspace(value: string | null): void
}

export function createStartupTransactionRunner(deps: StartupTransactionDeps): StartupTransactionRunner {
  const {
    plane,
    logger,
    baseDir,
    stateRoot,
    dshHome,
    anchor,
    platform,
    shellVersion,
    builtinVersion,
    nowMs,
    envPath,
    probeCandidate,
    waitBeforeRetry,
    facts,
    writeFence,
    assertMutationIdle,
  } = deps
  const { invalidateDiskCache, setStartupBlockReason, setOperationError } = deps.hooks
  // The gateway passes stateDir as the shared core's baseDir.
  const stateDir = baseDir

  let transactionWorkspace: string | null = null

  async function spawnAndProbeCandidate(version: string, isBuiltin: boolean, hostDomainNames: readonly string[], signal?: AbortSignal): Promise<ProbeResult[]> {
    const target = isBuiltin ? anchor : join(stateRoot, version)
    transactionWorkspace = target
    writeFence.beginInternalSpawn()
    try {
      await plane.startLocal()
      const port = plane.getLocalDshPort()
      if (port === null || !Number.isInteger(port)) throw new Error('managed dsh did not reach readiness for runtime probes')
      const baseUrl = `http://127.0.0.1:${port}`
      return probeCandidate !== undefined
        ? await probeCandidate({ version, isBuiltin, baseUrl, dshHome, signal })
        : await runRuntimeActivationProbes({
            baseUrl,
            dshHome,
            signal,
            // Expected chamber host domains, snapshot ONCE per transaction from
            // the seed cache packages present: probe set and verdict-expected set
            // must agree, or exact-set drift fails a healthy activation.
            hostDomainNames,
            // The legacy identity-method fallback must never be silent: a
            // legacy answer proves this tree predates session/canOpenWorkspacePath.
            warn: line => logger.warn(sanitizeErrorText(line, PROBE_TEXT_KEEP_TOKENS)),
            legacyShape: isLegacyHostProbeValue,
            call: async (url, method, payload, opts) => {
              // Forward the per-call response cap (settings/describe widen to 16 MiB).
              const response = await dshCall(url, method, payload, {
                signal: opts?.signal,
                timeoutMs: opts?.timeoutMs,
                ...(opts?.maxResponseBytes === undefined ? {} : { maxResponseBytes: opts.maxResponseBytes }),
              })
              return { result: response.result }
            },
          })
    } finally {
      writeFence.endInternalSpawn()
      transactionWorkspace = null
    }
  }

  /** Env-override activation probe: spawn the env workspace through the plane
   *  and run the shared activation probe set. Returns null when every probe
   *  passed, else a sanitized failure summary. The engine converts transport/
   *  timeout failures into per-probe ok:false, so only the injected test seam
   *  throws. Same chamber-domain gate as managed-tree probes, once per env boot. */
  async function probeEnvOverrideRuntime(signal?: AbortSignal): Promise<string | null> {
    // Env resolution goes through resolveWorkspace(), so the transactionWorkspace
    // override must stay unset for this spawn.
    transactionWorkspace = null
    writeFence.beginInternalSpawn()
    try {
      try {
        await plane.startLocal()
      } catch (error) {
        return `managed dsh did not reach readiness for env runtime probes: ${sanitizeErrorText(String(error))}`
      }
      const port = plane.getLocalDshPort()
      if (port === null || !Number.isInteger(port)) {
        return 'managed dsh did not publish a probe port for the env runtime'
      }
      const baseUrl = `http://127.0.0.1:${port}`
      const probes = probeCandidate !== undefined
        ? await probeCandidate({
            // Env override is active here, so envPath is set; '' is shape-only.
            version: envPath ?? '',
            isBuiltin: false,
            baseUrl,
            dshHome,
            signal,
          })
        : await runRuntimeActivationProbes({
            baseUrl,
            dshHome,
            signal,
            hostDomainNames: syncedHostDomainProbeNames(stateDir),
            // Same never-silent legacy fallback contract as the managed-tree probe.
            warn: line => logger.warn(sanitizeErrorText(line, PROBE_TEXT_KEEP_TOKENS)),
            legacyShape: isLegacyHostProbeValue,
            call: async (url, method, payload, opts) => {
              // Per-call response-cap forwarding, same as the managed-tree seam.
              const response = await dshCall(url, method, payload, {
                signal: opts?.signal,
                timeoutMs: opts?.timeoutMs,
                ...(opts?.maxResponseBytes === undefined ? {} : { maxResponseBytes: opts.maxResponseBytes }),
              })
              return { result: response.result }
            },
          })
      const failed = probes.filter(probe => !probe.ok)
      return failed.length === 0
        ? null
        : failed.map(probe => `${probe.name}${probe.error === undefined ? '' : `: ${sanitizeErrorText(probe.error, PROBE_TEXT_KEEP_TOKENS)}`}`).join('; ')
    } finally {
      writeFence.endInternalSpawn()
    }
  }

  function buildStartupDeps(): StartupDeps {
    // The probe shape is snapshot ONCE per startup transaction, DERIVED from the
    // synced seed cache (partial syncs included): probeExpectedNames must expect
    // the same set, or exact-set drift spuriously fails a healthy activation. A
    // sync landing mid-transaction applies on the following activation (bounded,
    // fail-closed false negative).
    const hostSeedDomains = syncedHostDomainProbeNames(stateDir)
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
      builtinVersion: facts.requireBuiltinVersion(),
      activationFacts: () => facts.activationFacts(),
      snapshot: (sourceVersion) => snapshotDshHome(baseDir, dshHome, sourceVersion),
      resolveSnapshotName: (snapshotName) => resolveSnapshotName(baseDir, snapshotName),
      prepareManualRollback: (targetVersion) => prepareManualRollbackData(baseDir, dshHome, targetVersion),
      validateTarget: (version, isBuiltin) => {
        if (isBuiltin) {
          return version === builtinVersion && readAnchorVersion(anchor) === builtinVersion
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
      spawnAndProbe: (version, isBuiltin, signal) => spawnAndProbeCandidate(version, isBuiltin, hostSeedDomains, signal),
      // Lazy seam resolved AFTER a probe attempt; the gateway's own probe does
      // not seed at spawn, so this returns the same snapshot as `hostSeedDomains`.
      probeExpectedNames: () => (hostSeedDomains.length === 0
        ? PROBE_NAMES_WITHOUT_HOST_DOMAINS
        : activationProbeNamesForDomains(hostSeedDomains)),
      stopHost: async () => { await plane.stopLocal() },
      restore: (snapshotPath) => restoreSnapshot(baseDir, dshHome, snapshotPath),
      recordProbePass: (version) => recordProbePass(baseDir, version),
      recordFailure: (input) => recordRuntimeFailure(baseDir, input),
      ...(waitBeforeRetry !== undefined ? { waitBeforeRetry } : {}),
    }
  }

  async function executeStartupTransaction(signal: AbortSignal = writeFence.abortSignal): Promise<Awaited<ReturnType<typeof runStartupPhase>>> {
    // Persisted wall time is not uptime: every transaction closes the prior
    // process-health window; a new boot-qualified one opens at the ready edge.
    try {
      resetCandidateHealthWindow(baseDir, nowMs())
      writeFence.closeHealthWindow()
    } catch (error) {
      logger.warn(`gateway runtime known-good health reset failed: ${sanitizeErrorText(String(error))}`)
    }
    // F4 shell-upgrade fallback: a shell-version mismatch invalidates the
    // persisted override and starts the builtin-switch transaction. Two
    // fingerprints arm it:
    //  1. FRESH mismatch — override not yet invalidated, journal holds nothing
    //     RESUMMABLE (missing or settled applied-monitoring): an upgrade ran
    //     while an APPLIED override was active, so the snapshot + probe-gated
    //     builtin switch must run instead of crashing at the first startLocal.
    //     LIVE journals (prepared/switched/restoring/…) are NOT armed — they
    //     keep their own journal-mismatch / rollback-continuation semantics.
    //  2. STRANDED invalidation — pointer set + invalidated override + no
    //     resumable journal: a rollback or crash consumed the journal while
    //     the pointer still names the old tree, so resolveWorkspace fails loud
    //     on EVERY boot with no HTTP recovery surface — re-arm F4 and self-heal.
    //     A settled invalidation clears the pointer or reactivates the record,
    //     so pointer-valid + invalidatedAt-set + journal-missing is unique.
    if (envPath === null) {
      const overrideState = readOverrideState(baseDir)
      const existingJournal = readActivationJournalState(baseDir)
      const pointerState = readCurrentPointerState(baseDir)
      // Corrupt/unknown override metadata proves neither stamp, so skip the F4
      // pre-arm rather than deriving "no override" from unreadable bytes.
      const overrideFactsReadable = overrideState.kind !== 'corrupt' && overrideState.kind !== 'unknown'
      if (!overrideFactsReadable) {
        logger.warn('gateway runtime override metadata is ' + overrideState.kind + '; F4 pre-arm skipped (startup phase blocks on the same state)')
      }
      const record = overrideState.kind === 'valid' ? overrideState.record : null
      const shellMismatch = record !== null
        && record.invalidatedAt == null
        && record.shellVersion !== shellVersion
      const strandedInvalidation = record !== null
        && record.invalidatedAt != null
        && pointerState.kind === 'valid'
      // Journal-present resume supersede: a failed F4 apply leaves an intent-phase
      // shell-invalidation journal PLUS a stale lastOutcome='snapshot-failed' /
      // swapAttempted marker. runStartupPhase blocks on the marker while the
      // spawn-time resolveWorkspace throws → permanent crash loop even after the
      // cause clears. Clear the markers so every boot retries and heals; gated to
      // shell-invalidation intents — other journals keep blocked-alive retries.
      if (record !== null
        && (record.lastOutcome === 'snapshot-failed' || record.swapAttempted || record.lastError !== null)
        && existingJournal.kind === 'valid'
        && existingJournal.journal.phase === 'intent'
        && existingJournal.journal.targetIsBuiltin
        && existingJournal.journal.intentKind === 'shell-invalidation') {
        writeOverride(baseDir, {
          ...record,
          swapAttempted: false,
          lastOutcome: null,
          lastError: null,
        })
      }
      // Arming gate: a FRESH mismatch arms unless a LIVE transaction journal
      // exists (prepared/switched/restoring/… — an old shell's in-flight
      // transaction must not be re-armed and writeActivationIntent refuses
      // those phases anyway); missing/applied-monitoring journals DO arm. A
      // STRANDED invalidation arms only when its journal was lost — with the
      // journal present the transaction simply resumes.
      const journalLiveTransaction = existingJournal.kind === 'valid'
        && existingJournal.journal.phase !== 'applied-monitoring'
        && existingJournal.journal.phase !== 'intent'
      if ((shellMismatch && !journalLiveTransaction)
        || (strandedInvalidation && existingJournal.kind === 'missing')) {
        writeActivationIntent(baseDir, {
          targetVersion: facts.requireBuiltinVersion(),
          targetIsBuiltin: true,
          manualRollback: false,
          intentKind: 'shell-invalidation',
        })
        // Fresh-transaction-supersedes: a stranded record may carry stale
        // failure markers that runStartupPhase blocks on BEFORE consuming the
        // re-armed intent (crash loop). invalidate() already resets
        // swapAttempted; clear the rest, keeping chosen/resolved/invalidated*.
        if (record.invalidatedAt == null
          || record.swapAttempted
          || record.lastOutcome !== null
          || record.lastError !== null) {
          const superseded = record.invalidatedAt == null
            ? invalidate(record, `gateway shell updated to ${shellVersion}`)
            : record
          writeOverride(baseDir, {
            ...superseded,
            swapAttempted: false,
            lastOutcome: null,
            lastError: null,
          })
        }
      }
    }
    const startup = await runStartupPhase(buildStartupDeps(), signal)
    // The shared core reports `env-override` as a deliberate bypass marker so
    // persisted pending is not touched. The gateway treats it as healthy only
    // AFTER the env runtime passes the activation probe gate: env is the one
    // selection the core NEVER probes itself, and a runtime that answers the
    // health check but lacks required features must not be exposed as healthy. A
    // failed probe keeps the managed dsh stopped with an honest blocked verdict.
    if (startup.blockedReason === 'env-override') {
      const probeFailure = await probeEnvOverrideRuntime(signal)
      if (probeFailure !== null) {
        await plane.stopLocal()
        invalidateDiskCache()
        setStartupBlockReason('env-probe-failed')
        setOperationError(`env runtime activation probes failed: ${probeFailure}`)
        logger.error(`gateway env-override runtime activation probes failed: ${probeFailure}`)
        // Synthetic blocked reason outside the shared core's union: it can
        // surface through env-allowed data-restore continuations too, and those
        // callers MUST preserve the verdict, never clear it.
        return {
          ...startup,
          blockedReason: 'env-probe-failed',
        } as unknown as Awaited<ReturnType<typeof runStartupPhase>>
      }
    }
    const result = startup.blockedReason === 'env-override'
      ? { ...startup, blockedReason: null }
      : startup
    invalidateDiskCache()
    setStartupBlockReason(result.blockedReason)
    if (result.blockedReason !== null) {
      logger.error(`gateway runtime startup blocked: ${result.blockedReason}`)
    }
    // A probe may leave its candidate process `ready` even when the verdict is
    // blocked; stop it before endActivation(), or the open-quarantine callback
    // reattaches features to a probe-failed runtime (snapshot-failed excepted).
    if (result.blockedReason !== null && result.blockedReason !== 'snapshot-failed') {
      await plane.stopLocal()
    }
    // Every snapshot-creating transaction funnels through this function (boot,
    // apply-now, restore-builtin, restart-exhausted rollback), so one prune here
    // bounds them all. Runs INSIDE the activation window and never fails.
    await maintenanceSnapshotPrune()
    return result
  }

  /**
   * Run the shared bounded-maintenance routine (artifact cleanup → retention
   * state → pruneSnapshots; keepRecentUnprotected 3). Fail-closed outcomes
   * preserve every snapshot and are logged; never throws — transaction tails
   * must not fail because maintenance hiccuped.
   */
  async function maintenanceSnapshotPrune(): Promise<void> {
    try {
      const maintenance = await pruneRuntimeSnapshots(baseDir, dshHome, 3)
      if (maintenance.removedSnapshots.length > 0
        || maintenance.artifactCleanup.removedTemporaryEntries.length > 0
        || maintenance.artifactCleanup.removedRestoreBackups.length > 0) {
        logger.log(
          `gateway runtime snapshot maintenance removed ${maintenance.removedSnapshots.length} snapshot(s), ${maintenance.artifactCleanup.removedTemporaryEntries.length} temporary entr${maintenance.artifactCleanup.removedTemporaryEntries.length === 1 ? 'y' : 'ies'} and ${maintenance.artifactCleanup.removedRestoreBackups.length} restore backup(s)`,
        )
      }
      if (maintenance.artifactCleanup.restoreBackupCleanup !== 'completed') {
        logger.warn(`gateway runtime restore-backup cleanup skipped: ${maintenance.artifactCleanup.restoreBackupCleanup}`)
      } else if (maintenance.skippedReason === 'retention-corrupt') {
        logger.warn('gateway runtime snapshot retention metadata is corrupt; snapshots preserved (fail closed)')
      }
    } catch (error) {
      logger.warn(`gateway runtime snapshot maintenance failed (bounded at the next transaction): ${sanitizeErrorText(String(error))}`)
    }
  }

  async function startupTransaction(): Promise<{ blockedReason: string | null }> {
    assertMutationIdle()
    if (platform === 'win32') {
      setStartupBlockReason(null)
      return { blockedReason: null }
    }
    writeFence.beginActivation()
    try {
      return { blockedReason: (await executeStartupTransaction()).blockedReason }
    } finally {
      writeFence.endActivation()
    }
  }

  return {
    spawnAndProbeCandidate,
    executeStartupTransaction,
    startupTransaction,
    transactionWorkspace: () => transactionWorkspace,
    setTransactionWorkspace: (value) => { transactionWorkspace = value },
  }
}
