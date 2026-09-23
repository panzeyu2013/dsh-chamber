/**
 * Gateway runtime startup transaction (design 17 §4.1 / design 18 §9.3): the
 * candidate/env probe spawns, the shared-core StartupDeps assembly, the
 * runStartupPhase driver (F4 shell-invalidation arming, env-override probe
 * gate, blocked projection), the bounded snapshot maintenance and the
 * candidate-workspace latch consulted by getDshWorkspacePath.
 *
 * The module owns exactly one piece of state — the transaction workspace latch
 * (single writer: the probe spawns). Every other input is an explicit handle:
 * the write fence, the workspace facts, the action guards' mutation gate and
 * the manager's projection-fact setters.
 */
import { join } from 'node:path'

import {
  call as dshCall,
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
  readOverride,
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

/** Host-side probe seam (moved verbatim from GatewayRuntimeManagerOptions):
 * production executes the complete shared probe list; tests inject a closed
 * ProbeResult set without opening a real dsh socket. */
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
  // The gateway passes stateDir as the shared core's baseDir; the derived
  // chamber-domain probe set reads the same root.
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
            // Shape gate (design 24 §7 C): the expected chamber host domains
            // are derived from the seed cache packages
            // actually present (partial syncs included), snapshot ONCE per
            // startup transaction (see buildStartupDeps): probe set and
            // verdict-expected set must always agree, or an exact-set drift
            // would spuriously fail a healthy activation.
            hostDomainNames,
            call: async (url, method, payload, opts) => {
              // Forward the per-call response cap (runtime-probes widens
              // settings/describe to SETTINGS_FILE_MAX_BYTES=16 MiB so a
              // legitimately large settings response never fails activation;
              // the cap is executed by the control-plane carrier here).
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

  /** Env-override activation probe (desktop parity): spawn the env
   *  workspace through the plane and run the shared activation probe set
   *  against it. Returns null when every probe passed, otherwise a
   *  sanitized failure summary. The probe engine converts transport/timeout
   *  failures into per-probe ok:false results, so the production path does
   *  not throw; only an injected `probeCandidate` seam may throw, and its
   *  callers treat that as a surfaced error (it is a test-only injection).
   *  The probe shape applies the same
   *  derived chamber-domain gate as managed-tree probes (domains expected
   *  only once their packages are synced into the seed cache), snapshot ONCE
   *  per env boot. */
  async function probeEnvOverrideRuntime(signal?: AbortSignal): Promise<string | null> {
    // Env resolution happens through resolveWorkspace(), so the
    // transactionWorkspace override must stay unset for this spawn.
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
            // This branch only runs under env override, so envPath is set;
            // the seam type requires a string, so an empty fallback is a
            // shape-only impossibility.
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
            call: async (url, method, payload, opts) => {
              // Per-call response-cap forwarding — same contract as the
              // managed-tree seam above (settings/describe 16 MiB).
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
    // Shape gate (design 24 §7 C): the probe shape is snapshot ONCE per
    // startup transaction, DERIVED from the synced seed
    // cache (the exact chamber domains present — partial syncs included). A
    // desktop sync landing mid-transaction must not flip the derived list
    // while the verdict expects the other set (probeExpectedNames) —
    // exact-set drift would spuriously fail/roll back a healthy activation.
    // The next transaction re-evaluates the cache, so a mid-transaction sync
    // applies on the following activation (bounded, fail-closed false
    // negative).
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
      // Lazy seam: the shared core resolves this AFTER a probe
      // attempt, exactly like the desktop hosts. The gateway's own probe does
      // not seed at spawn (its cache is synced by the desktop), so this still
      // returns the snapshot taken above — same source and same snapshot as
      // `hostSeedDomains` passed into the probe closure.
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
    // Persisted wall time is not uptime. Every startup/activation transaction
    // closes the prior process-health window; the first authoritative ready
    // edge after the verdict opens a new boot-qualified window.
    try {
      resetCandidateHealthWindow(baseDir, nowMs())
      writeFence.closeHealthWindow()
    } catch (error) {
      logger.warn(`gateway runtime known-good health reset failed: ${sanitizeErrorText(String(error))}`)
    }
    // F4 shell-upgrade fallback (design 18 §3.5): a shell-version mismatch
    // invalidates the persisted override and starts the builtin-switch
    // transaction. TWO fingerprints arm it:
    //  1. FRESH mismatch — the override is not yet invalidated and the
    //     journal holds nothing RESUMMABLE (missing, or the settled
    //     applied-monitoring steady state): the upgrade happened while an
    //     APPLIED override was active, so the new shell must run the
    //     snapshot + probe-gated builtin switch instead of crashing at the
    //     first startLocal ('current pointer has no matching active
    //     override'). Desktop-parity: the desktop controller arms exactly
    //     this fingerprint (main.ts "A newly observed shell-version mismatch
    //     starts F4"). Only LIVE-transaction journals (prepared/switched/
    //     restoring/…) are NOT armed: an old shell's in-flight transaction
    //     must never be re-armed under the new shell — it keeps its own
    //     journal-mismatch block / rollback-continuation semantics
    //     (runStartupPhase), and writeActivationIntent refuses anyway. An
    //     intent-phase old-shell transaction IS replaced by the fresh arm
    //     (desktop parity).
    //  2. STRANDED invalidation — pointer set + override invalidated + no
    //     resumable journal: an update rollback (installer restarts an older
    //     gateway shell against the newer shell's journal) or a crash window
    //     consumed/cleared the intent journal while the pointer still names
    //     the old tree. The stranded result makes resolveWorkspace fail loud
    //     on EVERY boot with no HTTP recovery surface (the gateway never
    //     reaches startLocal), so it must self-heal instead of
    //     crash-looping. Re-arm F4 whenever the current pointer has no
    //     ACTIVE override and nothing resumable is on disk: the snapshot +
    //     probe-gated builtin switch is exactly the transaction the
    //     interrupted invalidation never finished. A settled invalidation
    //     always leaves the pointer cleared (F4 applied) or the record
    //     reactivated (F4 rolled back), so pointer-valid + invalidatedAt-set
    //     + journal-missing uniquely identifies the stranded state — never a
    //     healthy post-F4 boot.
    if (envPath === null) {
      const record = readOverride(baseDir)
      const existingJournal = readActivationJournalState(baseDir)
      const pointerState = readCurrentPointerState(baseDir)
      const shellMismatch = record !== null
        && record.invalidatedAt == null
        && record.shellVersion !== shellVersion
      const strandedInvalidation = record !== null
        && record.invalidatedAt != null
        && pointerState.kind === 'valid'
      // Journal-present resume supersede: an interrupted F4 whose apply kept
      // failing at snapshot leaves an intent-phase
      // shell-invalidation journal PLUS a lastOutcome='snapshot-failed' /
      // swapAttempted marker — runStartupPhase blocks on the marker before
      // resuming (:421-428), and index.ts treats snapshot-failed as
      // spawn-through, but with an invalidated override + valid pointer the
      // spawn-time resolveWorkspace throws → permanent crash loop even after
      // the underlying cause (disk/DSH_HOME) clears. Clear the stale markers
      // so every boot retries the F4 apply and heals once the cause clears.
      // Gated to builtin shell-invalidation intents: version-switch /
      // rollback resume journals keep their blocked-alive + retry-apply
      // semantics.
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
      // Arming gate (desktop parity): a
      // FRESH shell mismatch arms unless a LIVE transaction journal exists
      // (prepared/switched/restoring/… phases — an old shell's in-flight
      // transaction must not be re-armed under the new shell; it keeps its
      // journal-mismatch block / rollback-continuation semantics, and
      // writeActivationIntent refuses those phases anyway). Settled and
      // intent-phase journals DO arm: missing/applied-monitoring = the
      // healthy post-commit upgrade case (the intent write queues onto the
      // monitoring journal and the startup phase converts it); an
      // intent-phase version-switch from the old shell is replaced by the
      // fresh shell-invalidation intent — exactly the desktop controller's
      // behavior (main.ts writes the F4 intent unconditionally on a fresh
      // mismatch). A STRANDED invalidation arms only when its intent journal
      // was lost (journal-missing) — with the journal present the
      // transaction simply resumes.
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
        // Fresh-transaction-supersedes (apply()/applyNowPreflight parity): a
        // stranded record may carry stale failure markers (lastOutcome
        // 'snapshot-failed' / swapAttempted) from before the interruption —
        // runStartupPhase blocks on them (:421-428) BEFORE consuming the
        // re-armed intent, which would crash-loop the gateway at startLocal
        // (snapshot-failed is not a blocked-but-alive reason in index.ts).
        // invalidate() already resets swapAttempted; clear the remaining
        // markers whenever one exists (invalidatedAt == null always writes
        // the invalidation). The chosen/resolved/invalidated* fields stay
        // intact.
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
    // persisted pending is not touched. For the gateway host this is a healthy
    // startup outcome only AFTER the env runtime has passed the activation
    // probe gate: env is the highest-priority active runtime, but it is also
    // the one selection the core NEVER probes itself (no activation
    // transaction runs for it). Desktop parity: the desktop opens an
    // env boot only when the full current-runtime probe set passes; the
    // gateway must not normalize env-override to healthy without a probe: a
    // runtime that answers the control-plane health check but lacks required
    // features would otherwise be exposed and marked healthy. Probe the env
    // runtime here; a failed probe keeps the managed dsh stopped with an
    // honest blocked verdict (resume: fix the DSH_GATEWAY_DSH_PATH target and
    // restart the gateway — the next startup transaction re-probes).
    if (startup.blockedReason === 'env-override') {
      const probeFailure = await probeEnvOverrideRuntime(signal)
      if (probeFailure !== null) {
        await plane.stopLocal()
        invalidateDiskCache()
        setStartupBlockReason('env-probe-failed')
        setOperationError(`env runtime activation probes failed: ${probeFailure}`)
        logger.error(`gateway env-override runtime activation probes failed: ${probeFailure}`)
        // Synthetic blocked reason outside the shared core's union. The
        // startupTransaction composition boundary (index.ts) treats it as a
        // terminal boot block, but it can also surface through the resume
        // paths that run startup transactions under env (retry-restore and
        // restore-pre-rollback are env-allowed data-restore continuations) —
        // those callers MUST preserve the verdict, never clear it.
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
    // A probe may leave its candidate/fallback process in `ready` even when
    // the transaction's durable verdict is blocked. Stop it before the owning
    // activation scope calls endActivation(); otherwise that open-quarantine
    // callback can reattach features and the root proxy to a probe-failed
    // runtime. snapshot-failed is the one safe exception: it is decided before
    // pointer mutation and callers intentionally restart the unchanged source.
    if (result.blockedReason !== null && result.blockedReason !== 'snapshot-failed') {
      await plane.stopLocal()
    }
    // Snapshot bounding (desktop parity): the desktop main process runs the
    // shared retention prune after every runtime startup operation; every
    // gateway snapshot-creating transaction funnels through this function
    // (boot, apply-now, restore-builtin and the automatic restart-exhausted
    // rollback), so one call here bounds them all against the 10 GiB logical
    // disk limit. It runs
    // INSIDE the activation window (single-flight) and never fails the
    // transaction — a prune error is logged and bounded at the next one.
    await maintenanceSnapshotPrune()
    return result
  }

  /**
   * Run the shared dsh-runtime bounded-maintenance routine (artifact
   * cleanup → retention state → pruneSnapshots; keepRecentUnprotected 3, the
   * same policy as the desktop owner). Fail-closed outcomes (restore marker
   * present, corrupt retention metadata) preserve every snapshot and are
   * logged, never silent. Never throws — transaction tails must not fail
   * because maintenance hiccuped.
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
