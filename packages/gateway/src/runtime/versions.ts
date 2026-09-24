/**
 * Gateway runtime version actions: selection ledger
 * (select/apply/rollback/cleanup), registry version list, builtin restore and
 * the apply-now session switch.
 *
 * Owns no mutable state: re-reads the durable core metadata per call; guards,
 * write fence, resolution facts, startup driver and projection setters arrive
 * as explicit handles. Refusal codes/messages are preserved verbatim.
 */
import {
  bindRuntimeInstallResolution,
  buildCachedVersionList,
  buildVersionList,
  cleanupExplicitRuntimeVersion,
  clearActivationJournal,
  compareRuntimeVersions,
  DEFAULT_REGISTRY_ORIGIN,
  downloadVerifiedRegistryTarball,
  fetchRegistryMetadata,
  installRuntimeVersion,
  isProtectedVersion,
  isSafeVersion,
  isVersionDowngrade,
  listExplicitlyInstalledVersions,
  listValidVersionTrees,
  readActivationJournalState,
  readCurrentPointerState,
  readOverrideState,
  recordExplicitInstall,
  restoreMarkerAuthorityStatus,
  runStartupPhase,
  sanitizeErrorText,
  shouldInvalidate,
  writeActivationIntent,
  writeOverride,
  type ActivationIntentKind,
  type OverrideRecord,
  type RuntimeInstallProgress,
} from '@dsh-chamber/dsh-runtime'
import type { RuntimeDiskProjection } from '../runtime-disk-projection.ts'
import {
  applyNowNotRunningRefusal,
  recoveryRetryRequiredRefusal,
  refusalError,
} from '../runtime-refusals.ts'
import { refuseOnEnvPinned, refuseRuntimeMutationOnWindows, readOverrideForDecision } from './guards.ts'
import { sanitizeRouteError } from '../sanitize-route-error.ts'
import { readRegistryOrigin } from './registry-source.ts'
import type { StartupTransactionRunner } from './startup-transaction.ts'
import type { RuntimeModuleContext } from './context.ts'

export interface RuntimeVersionActionsDeps extends RuntimeModuleContext {
  shellVersion: string
  builtinVersion: string | null
  diskLimitBytes: number
  dshPackageName: string
  fetchMetadata: typeof fetchRegistryMetadata | undefined
  pnpmEntry(): string
  diskCacheProjection: RuntimeDiskProjection
  assertMutationIdle(): void
  assertNoPending(): void
  ordinaryPendingVersion(): string | null
  persistedPendingVersion(): string | null
  getStartupBlockReason(): string | null
  startup: StartupTransactionRunner
  hooks: {
    invalidateDiskCache(): void
    runStorePruneIfNeeded(): Promise<void>
    setStartupBlockReason(value: string | null): void
    setOperationError(value: string | null): void
    setRestartOutcome(value: 'ok' | 'failed' | 'running' | null): void
    setStartOutcome(value: 'ok' | 'failed' | 'running' | null): void
    setInstallProgress(value: RuntimeInstallProgress | null): void
  }
}

export interface RuntimeVersionActions {
  listVersions(): Promise<unknown>
  select(version: string): Promise<{ accepted: boolean; version: string }>
  apply(): Promise<{ pending: boolean }>
  applyNowPreflight(): string
  applyNow(): Promise<{ accepted: boolean }>
  rollback(version: string): Promise<{ accepted: boolean }>
  cleanupVersion(version: string): Promise<{ version: string; removed: boolean }>
  restoreBuiltin(): Promise<{ accepted: boolean }>
}

export function createRuntimeVersionActions(deps: RuntimeVersionActionsDeps): RuntimeVersionActions {
  const {
    plane,
    platform,
    baseDir,
    shellVersion,
    builtinVersion,
    envPath,
    diskLimitBytes,
    dshPackageName,
    fetchMetadata,
    pnpmEntry,
    diskCacheProjection,
    facts,
    writeFence,
    assertMutationIdle,
    assertNoPending,
    ordinaryPendingVersion,
    persistedPendingVersion,
    getStartupBlockReason,
    startup,
  } = deps
  const {
    invalidateDiskCache,
    runStorePruneIfNeeded,
    setStartupBlockReason,
    setOperationError,
    setRestartOutcome,
    setStartOutcome,
    setInstallProgress,
  } = deps.hooks

  /** Cleanup candidates for the settings UI: the explicit-install ledger minus
   *  everything the deletion-point protection set would refuse. Fail-closed: a
   *  read failure reports through `error` and projects an empty list. */
  function removableCleanupVersions(): { versions: string[]; error: string | null } {
    if (platform === 'win32') return { versions: [], error: null }
    try {
      return {
        versions: listExplicitlyInstalledVersions(baseDir)
          .filter((version) => !isProtectedVersion(baseDir, version, { ignoreExplicitInstall: true }))
          .sort((a, b) => compareRuntimeVersions(b, a) ?? 0),
        error: null,
      }
    } catch (error) {
      return { versions: [], error: sanitizeErrorText(String(error)) }
    }
  }

  async function listVersions(): Promise<unknown> {
    writeFence.assertManagerReadable()
    const origin = platform === 'win32' ? DEFAULT_REGISTRY_ORIGIN : readRegistryOrigin(baseDir)
    const cachedVersions = platform === 'win32' ? [] : listValidVersionTrees(baseDir)
    // Resolved once per listing: the removable candidates and their read failure
    // ride every response branch, including the registry-error branch.
    const removable = removableCleanupVersions()
    let active: string | null = null
    try { active = facts.resolveWorkspace().version } catch { /* status projects the selection error */ }
    try {
      const meta = await (fetchMetadata ?? fetchRegistryMetadata)(dshPackageName, {
        origin,
        signal: writeFence.abortSignal,
      })
      return {
        registryOrigin: meta.origin,
        versions: buildVersionList(meta, {
          active,
          cachedVersions,
          compatibilityBaseline: null,
        }),
        removableVersions: removable.versions,
        removableVersionsError: removable.error,
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
        removableVersions: removable.versions,
        removableVersionsError: removable.error,
        error: sanitizeErrorText(String(error)),
      }
    }
  }

  /** A fresh user selection cancels a STALE intent-phase journal (whose target
   *  no longer matches); an in-flight transaction keeps its evidence. */
  function clearStaleIntent(): void {
    const state = readActivationJournalState(baseDir)
    if (state.kind === 'valid' && state.journal.phase === 'intent') {
      clearActivationJournal(baseDir)
    }
  }

  /** Consume an app-update invalidation stamp when the user makes a FRESH
   *  selection under the CURRENT shell. Carrying the stamp into the new record
   *  would make it born-invalidated (pending ignored, apply-now refuses
   *  `no_selection`, the leftover journal reads as selection-corrupt) — the
   *  runtime could never switch again. Null the active pair rather than dropping
   *  the keys, and fold it into `lastInvalidated*` first: those durable fields
   *  are kept, and `lastInvalidationRecovered` stays unset (it means F4
   *  automatically restored the previous tree after a failed builtin probe). */
  function reactivateSelection(record: OverrideRecord): OverrideRecord {
    if (record.invalidatedAt == null && record.invalidatedReason == null) return record
    const invalidatedAt = record.invalidatedAt ?? null
    const invalidatedReason = record.invalidatedReason ?? null
    return {
      ...record,
      invalidatedAt: null,
      invalidatedReason: null,
      lastInvalidatedAt: record.lastInvalidatedAt ?? invalidatedAt ?? new Date().toISOString(),
      lastInvalidatedReason: record.lastInvalidatedReason ?? invalidatedReason ?? 'shell-version-changed',
      lastInvalidatedFromVersion: record.lastInvalidatedFromVersion
        ?? record.resolvedVersion
        ?? record.chosenVersion,
    }
  }

  async function select(version: string): Promise<{ accepted: boolean; version: string }> {
    refuseRuntimeMutationOnWindows(platform)
    assertMutationIdle()
    refuseOnEnvPinned(envPath, 'version mutations')
    assertNoPending()

    // The selector lists the active version first, so selecting the builtin
    // anchor's version is a true no-op and must never fetch the registry.
    if (facts.resolveWorkspace().version === version) {
      setOperationError(null)
      setRestartOutcome(null)
      setStartOutcome(null)
      return { accepted: true, version }
    }
    const currentAtSelection = facts.currentPointerVersion()

    // Installed tree: re-selecting it never reinstalls. Active version → true
    // no-op; installed-but-inactive → record the choice so apply() can arm it.
    if (listValidVersionTrees(baseDir).includes(version)) {
      if (currentAtSelection !== version) {
        const previous: OverrideRecord = readOverrideForDecision(baseDir) ?? {
          shellVersion,
          chosenVersion: null,
          resolvedVersion: null,
          pending: null,
          swapAttempted: false,
        }
        clearStaleIntent()
        writeOverride(baseDir, {
          ...reactivateSelection(previous),
          shellVersion,
          chosenVersion: version,
          resolvedVersion: version,
          pending: null,
          swapAttempted: false,
          // Only a builtin-active selection proves a missing current pointer is
          // expected; when v1 is active and v2 merely staged, selectedOnly MUST
          // stay false so losing v1's pointer quarantines DSH_HOME.
          selectedOnly: currentAtSelection === null,
          // A fresh user transaction supersedes a failed snapshot.
          lastOutcome: null,
          lastError: null,
        })
      }
      setOperationError(null)
      setRestartOutcome(null)
      setStartOutcome(null)
      return { accepted: true, version }
    }
    // Install is a writer single-flight, NOT an activation quarantine: the
    // current runtime stays serviceable; only the startup/apply transaction
    // may close exposure while probing the candidate.
    writeFence.setInstallInFlight(true)
    try {
      // The disk limit gates NEW downloads only; cached selection/rollback stay available.
      const disk = await diskCacheProjection.projection(true)
      if (disk.error !== null || disk.usage === null) {
        throw Object.assign(new Error(`cannot confirm gateway runtime disk usage; refusing a new install: ${disk.error ?? 'unknown accounting failure'}`), {
          code: 'runtime_disk_unavailable',
        })
      }
      if (disk.usage.totalBytes >= diskLimitBytes) {
        throw Object.assign(new Error(`gateway runtime logical disk usage reached the ${diskLimitBytes}-byte soft limit; remove an unused version before installing`), {
          code: 'runtime_disk_limit',
        })
      }
      const origin = readRegistryOrigin(baseDir)
      const meta = await (fetchMetadata ?? fetchRegistryMetadata)(dshPackageName, {
        origin,
        signal: writeFence.abortSignal,
      })
      const resolution = bindRuntimeInstallResolution(meta, version, origin)
      const result = await installRuntimeVersion({
        baseDir,
        resolution,
        pnpmEntry: pnpmEntry(),
        signal: writeFence.abortSignal,
        onProgress: (progress) => { setInstallProgress(progress.stage === 'done' ? null : progress) },
        deps: {
          // Empty env: the installer applies its own scrub + HOME/XDG injection; secrets never reach pnpm.
          node: () => ({ file: process.execPath, args: [], env: {} }),
          download: async (res, destination, opts) => {
            await downloadVerifiedRegistryTarball(res, destination, {
              signal: opts.signal,
              onProgress: opts.onProgress,
            })
          },
        },
      })
      // select records the choice WITHOUT pending; apply() arms the switch.
      recordExplicitInstall(baseDir, version)
      const previous: OverrideRecord = readOverrideForDecision(baseDir) ?? {
        shellVersion,
        chosenVersion: null,
        resolvedVersion: null,
        pending: null,
        swapAttempted: false,
      }
      clearStaleIntent()
      writeOverride(baseDir, {
        ...reactivateSelection(previous),
        shellVersion,
        chosenVersion: version,
        resolvedVersion: result.resolvedVersion,
        pending: null,
        swapAttempted: false,
        selectedOnly: currentAtSelection === null,
        // A fresh user transaction supersedes a failed snapshot.
        lastOutcome: null,
        lastError: null,
      })
      setOperationError(null)
      setRestartOutcome(null)
      setStartOutcome(null)
      invalidateDiskCache()
      return { accepted: true, version }
    } catch (error) {
      setOperationError(sanitizeRouteError(error instanceof Error ? error.message : String(error)))
      throw error
    } finally {
      setInstallProgress(null)
      invalidateDiskCache()
      writeFence.setInstallInFlight(false)
    }
  }

  async function apply(): Promise<{ pending: boolean }> {
    refuseRuntimeMutationOnWindows(platform)
    assertMutationIdle()
    refuseOnEnvPinned(envPath, 'version mutations')
    assertNoPending()

    const record: OverrideRecord = readOverrideForDecision(baseDir) ?? {
      shellVersion,
      chosenVersion: null,
      resolvedVersion: null,
      pending: null,
      swapAttempted: false,
    }
    if (record.chosenVersion === null) throw Object.assign(new Error('no runtime version selected'), { code: 'no_selection' })
    // An app-update-invalidated record must NOT be armed: writing pending would
    // return an honest-looking 200 for a switch that effectivePending ignores
    // forever (and reads as selection-corrupt). Re-select under the current
    // shell first — F4 does not trust a choice made by the previous shell.
    if (shouldInvalidate(record, shellVersion)) {
      throw Object.assign(
        new Error('the stored runtime selection was invalidated by a gateway update; re-select the version before applying it'),
        { code: 'no_selection' },
      )
    }
    // The activation intent must agree with the pending target; a stale intent
    // journal would FATAL-block the next boot on journal-mismatch (an in-flight
    // transaction refuses honestly, 409). The downgrade formula uses the
    // EFFECTIVE active version (pointer ?? builtin anchor): a builtin-active
    // downgrade is a real data rollback (it arms the pre-rollback stash), not a
    // plain switch — the raw pointer would narrow that semantic.
    const current = facts.currentPointerVersion() ?? builtinVersion
    try {
      writeActivationIntent(baseDir, {
        targetVersion: record.chosenVersion,
        targetIsBuiltin: false,
        manualRollback: isVersionDowngrade(record.chosenVersion, current),
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
      // A fresh apply transaction supersedes a failed snapshot.
      lastOutcome: null,
      lastError: null,
    })
    setStartupBlockReason(null) // a fresh apply supersedes the in-memory block marker
    setOperationError(null)
    setRestartOutcome(null)
    setStartOutcome(null)
    return { pending: true }
  }

  async function rollback(version: string): Promise<{ accepted: boolean }> {
    refuseRuntimeMutationOnWindows(platform)
    assertMutationIdle()
    refuseOnEnvPinned(envPath, 'version mutations')
    assertNoPending()

    if (!listValidVersionTrees(baseDir).includes(version)) {
      throw Object.assign(new Error(`no valid version tree for ${version}`), { code: 'invalid_target' })
    }
    // Direction guard (fail-loud): rollback is the DOWNGRADE path only; a
    // same-as-active or newer target is select+apply's job and would journal a
    // manualRollback intent with upgrade semantics. The comparison uses the
    // EFFECTIVE active version (pointer ?? builtin anchor), so a builtin-active
    // downgrade is legitimate; a null current (broken anchor) is refused.
    const current = facts.currentPointerVersion() ?? builtinVersion
    if (current === null || compareRuntimeVersions(version, current) !== -1) {
      throw Object.assign(
        new Error(current === null
          ? 'rollback requires an active installed runtime version to roll back from; use select+apply to switch'
          : `rollback target is not older than the active runtime (v${current}); use select+apply to switch to a newer version`),
        { code: 'invalid_target' },
      )
    }
    // Journal a manualRollback intent and arm the pending switch: the startup
    // transaction performs the pre-rollback stash (an eager one would be orphaned).
    const record: OverrideRecord = readOverrideForDecision(baseDir) ?? {
      shellVersion,
      chosenVersion: null,
      resolvedVersion: null,
      pending: null,
      swapAttempted: false,
    }
    // Journal FIRST, then the override: a crash between the writes must not
    // strand a pending override without its intent (the intent is the durable
    // record of the transaction's kind; the override only arms it).
    writeActivationIntent(baseDir, {
      targetVersion: version,
      targetIsBuiltin: false,
      manualRollback: true,
      intentKind: 'version-switch' as ActivationIntentKind,
    })
    // A manual rollback is likewise a FRESH user choice, so it consumes an
    // app-update stamp exactly like select(): otherwise it arms a pending that
    // effectivePending ignores, stranding the selection-corrupt state.
    writeOverride(baseDir, {
      ...reactivateSelection(record),
      shellVersion,
      chosenVersion: version,
      pending: version,
      swapAttempted: false,
      selectedOnly: false,
      // A fresh rollback transaction supersedes a failed snapshot.
      lastOutcome: null,
      lastError: null,
    })
    // A fresh transaction supersedes the in-memory blocked phase marker; the
    // durable markers above are the authority — the next boot re-derives blocks.
    setStartupBlockReason(null)
    setOperationError(null)
    setRestartOutcome(null)
    setStartOutcome(null)
    return { accepted: true }
  }

  /** User-authorized cleanup of one explicitly retained version tree. Ledger
   *  membership is required (never an arbitrary tree); the shared core re-reads
   *  the protection set at the deletion point and a success clears the error. */
  async function cleanupVersion(version: string): Promise<{ version: string; removed: boolean }> {
    refuseRuntimeMutationOnWindows(platform)
    assertMutationIdle()
    refuseOnEnvPinned(envPath, 'version mutations')
    assertNoPending()
    if (getStartupBlockReason() !== null) {
      throw Object.assign(new Error(`runtime recovery ${getStartupBlockReason()} is required before cleanup`), { code: 'runtime_recovery_required' })
    }
    const safe = isSafeVersion(version) ? version.trim() : ''
    if (safe === '' || !listExplicitlyInstalledVersions(baseDir).includes(safe)) {
      throw Object.assign(new Error(`no explicitly installed version tree for ${version}`), { code: 'invalid_target' })
    }
    const result = cleanupExplicitRuntimeVersion(baseDir, safe)
    if (result.stillProtected) {
      throw Object.assign(
        new Error(`dsh ${safe} is still protected (active/pending/known-good/recovery/failure evidence); cleanup refused`),
        { code: 'version_still_protected' },
      )
    }
    invalidateDiskCache()
    await runStorePruneIfNeeded()
    setOperationError(null)
    return { version: safe, removed: result.removed }
  }

  async function restoreBuiltin(): Promise<{ accepted: boolean }> {
    refuseRuntimeMutationOnWindows(platform)
    assertMutationIdle()
    refuseOnEnvPinned(envPath, 'version mutations')
    // Reset-builtin without an override is a pointless stop → snapshot → probe
    // cycle (the anchor is already authoritative); refuse instead of manufacturing downtime.
    const overrideState = readOverrideState(baseDir)
    if (overrideState.kind === 'missing') {
      throw Object.assign(new Error('no override exists — the runtime is already on the builtin anchor; nothing to restore'), { code: 'runtime_no_override' })
    }
    // Reset-builtin only applies to a HEALTHY or ordinary-pending selection.
    // In an interrupted apply / data restore, a corrupt override or an armed
    // memory block, running it would stop the managed dsh for nothing and leave
    // an armed reset intent that hijacks the later retry-* semantics — refuse
    // BEFORE any stop or intent write.
    const durable = overrideState.kind === 'valid' ? overrideState.record : null
    const journalState = readActivationJournalState(baseDir)
    const pointerState = readCurrentPointerState(baseDir)
    const recoveryReason = getStartupBlockReason() !== null
      ? getStartupBlockReason()
      : journalState.kind === 'corrupt'
        ? 'journal-corrupt'
        : pointerState.kind === 'corrupt' || pointerState.kind === 'unknown'
          ? 'current-corrupt'
          : overrideState.kind === 'corrupt' || overrideState.kind === 'unknown'
            ? 'override-corrupt'
            : durable !== null && (durable.swapAttempted === true || durable.lastOutcome === 'snapshot-failed')
              ? durable.swapAttempted === true ? 'swap-attempted' : 'snapshot-failed'
              : restoreMarkerAuthorityStatus(baseDir) !== 'missing'
                ? 'restore-half'
                : null
    if (recoveryReason !== null) {
      // Same code/message as every other recovery gate (recoveryRetryRequiredRefusal).
      throw refusalError(recoveryRetryRequiredRefusal(recoveryReason))
    }

    // An activation transaction, not metadata deletion: durable intent →
    // quiesce DSH_HOME → snapshot → atomic pointer clear → full probe gate. The
    // override/journal are deleted only after the probe passes.
    const targetVersion = facts.requireBuiltinVersion()
    let result: Awaited<ReturnType<typeof runStartupPhase>>
    writeFence.beginActivation()
    try {
      writeActivationIntent(baseDir, {
        targetVersion,
        targetIsBuiltin: true,
        manualRollback: false,
        intentKind: 'reset-builtin',
      })
      await plane.stopLocal()
      result = await startup.executeStartupTransaction()
    } catch (error) {
      setOperationError(sanitizeRouteError(error instanceof Error ? error.message : String(error)))
      throw error
    } finally {
      writeFence.endActivation()
      invalidateDiskCache()
    }

    // Probes normally leave a host alive; snapshot failure never spawns, so
    // resume the untouched source. Hard blocks intentionally stay stopped.
    if (!writeFence.isDisposed() && (result.blockedReason === null || result.blockedReason === 'snapshot-failed')) {
      try {
        await plane.startLocal()
        plane.refreshLocalExposure()
      } catch (error) {
        setOperationError(sanitizeRouteError(error instanceof Error ? error.message : String(error)))
        throw error
      }
    }

    if (result.applyOutcome?.status !== 'applied') {
      const reason = result.applyOutcome?.error
        ?? (result.applyOutcome?.status === 'rolled-back'
          ? 'builtin activation failed; the previous runtime and data were restored'
          : result.blockedReason ?? 'builtin activation did not commit')
      setOperationError(sanitizeRouteError(reason))
      throw Object.assign(new Error(reason), { code: 'runtime_activation_failed' })
    }
    setStartupBlockReason(null)
    setOperationError(null)
    setRestartOutcome(null)
    setStartOutcome(null)
    return { accepted: true }
  }

  /**
   * Synchronous apply-now preflight: every refusing gate runs here so the route
   * can answer 409/403 BEFORE any 202 goes out; a preflight throw must never
   * become a fake 202 whose status never settles.
   *
   * Order: platform → mutation gate → env → fail-closed metadata/state gates →
   * target resolution (ordinary pending, else a NON-invalidated staged
   * chosenVersion, else no_selection) → installed-tree validation → no-op
   * rejection → arm the pending switch. Returns the resolved target version.
   */
  function applyNowPreflight(): string {
    refuseRuntimeMutationOnWindows(platform)
    assertMutationIdle()
    refuseOnEnvPinned(envPath, 'version mutations')

    // A corrupt activation journal must fail closed BEFORE any 202/stop: the
    // transaction cannot read it either, so proceeding would stop a healthy
    // managed dsh and leave it down. Recovery is the retry/restore surface.
    if (readActivationJournalState(baseDir).kind === 'corrupt') {
      throw Object.assign(new Error('runtime activation journal is corrupt; apply-now refused (recovery required)'), { code: 'runtime_busy' })
    }
    // Direct-call parity with the route's recovery gate: an in-memory startup
    // block refuses identically when the manager is called directly.
    const blockReason = getStartupBlockReason()
    if (blockReason !== null) {
      throw refusalError(recoveryRetryRequiredRefusal(blockReason))
    }
    // Direct-call parity with the route's connection gate: a managed dsh that
    // never reached ready cannot be switched in-session.
    if (plane.connectionState !== 'ready' && plane.connectionState !== 'degraded') {
      // Same code/message as the route's /apply-now pre-gate.
      throw refusalError(applyNowNotRunningRefusal(plane.connectionState))
    }

    // Target = ordinary pending, else the staged chosenVersion (a selectedOnly
    // selection with no pending yet); both empty → no_selection (never a no-op
    // stop/start cycle). An invalidated record keeps its chosenVersion but is
    // NOT a valid target — filter it HERE, since the status projection's
    // selectedVersion does not see the invalidation.
    let target = ordinaryPendingVersion()
    if (target === null) {
      const record = readOverrideForDecision(baseDir)
      if (record === null || record.chosenVersion === null || shouldInvalidate(record, shellVersion)) {
        throw Object.assign(new Error('no runtime version selected or pending'), { code: 'no_selection' })
      }
      target = record.chosenVersion
    }
    if (!listValidVersionTrees(baseDir).includes(target)) {
      throw Object.assign(new Error(`no valid version tree for ${target}`), { code: 'invalid_target' })
    }

    // No-op rejection: target already active and nothing in flight — applying
    // again would run a pointless stop → snapshot → spawn → probe cycle. Only
    // crash-continuation phases pass (interrupted transactions to continue);
    // applied-monitoring with nextIntent arms a different pending.
    // Effective active version (pointer ?? builtin anchor), same formula as
    // apply()/rollback(): a builtin-active staged downgrade arms a real rollback.
    const current = facts.currentPointerVersion() ?? builtinVersion
    if (target === current) {
      const journal = readActivationJournalState(baseDir)
      if (journal.kind === 'missing'
        || (journal.kind === 'valid'
          && (journal.journal.phase === 'intent' || journal.journal.phase === 'applied-monitoring'))) {
        throw Object.assign(new Error(`dsh v${target} is already the active runtime; apply-now has nothing to do`), { code: 'noop_target' })
      }
    }

    // When only the selection is staged, arm the pending switch journal-first
    // (apply() ordering) so runStartupPhase sees effectivePending === target.
    // assertNoPending is deliberately NOT used: a pending is apply-now's premise.
    if (persistedPendingVersion() === null) {
      const record: OverrideRecord = readOverrideForDecision(baseDir) ?? {
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
          // Downgrade-aware (mirrors apply()): a staged downgrade arms a real
          // manual rollback so runStartupPhase prepares the pre-rollback stash.
          manualRollback: isVersionDowngrade(target, current),
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
        // A fresh apply-now transaction supersedes a failed snapshot.
        lastOutcome: null,
        lastError: null,
      })
      // The durable writes above supersede the in-memory block marker.
      setStartupBlockReason(null)
      setOperationError(null)
      setRestartOutcome(null)
      setStartOutcome(null)
    }
    return target
  }

  /**
   * Apply the pending/staged version switch in the current session: durable
   * intent → quiesce DSH_HOME → snapshot → pointer switch → spawn candidate →
   * probe gate → verdict/rollback. `{ accepted: true }` returns synchronously
   * (202); the async outcome is projected into status(), never only into the
   * log. Every synchronous refusal happens in applyNowPreflight() first.
   */
  async function applyNow(): Promise<{ accepted: boolean }> {
    // The preflight arms the persisted pending; the transaction body below
    // derives the target from override/journal, so its return value is
    // intentionally not bound.
    applyNowPreflight()
    writeFence.setApplyNowInFlight(true)
    const job = (async () => {
      // The recovery segment (startLocal + exposure resync) and the outcome
      // projection run AFTER endActivation() closes the quarantine window;
      // running startLocal inside it would hit the canStartLocal gate
      // (connection_busy) and overwrite operationError with a misleading value.
      let result: Awaited<ReturnType<typeof runStartupPhase>> | null = null
      try {
        // A new transaction supersedes any stale projection the moment it is
        // accepted — the 202 window must not keep echoing the last failure.
        setOperationError(null)
        writeFence.beginActivation()
        try {
          await plane.stopLocal()
          result = await startup.executeStartupTransaction(writeFence.abortSignal)
        } finally {
          writeFence.endActivation()
          invalidateDiskCache()
        }
        // stop()/dispose() must never let the recovery startLocal resurrect the dsh.
        if (writeFence.isDisposed()) return
        if (result.blockedReason === null || result.blockedReason === 'snapshot-failed') {
          await plane.startLocal()
          plane.refreshLocalExposure()
        }
        // The 202 job's failure must project into manager state — the settings
        // poll reads these fields. Hard blocks stay stopped and pollable.
        if (result.applyOutcome?.status !== 'applied') {
          setOperationError(sanitizeRouteError(result.applyOutcome?.error ?? result.blockedReason ?? 'runtime apply-now did not commit'))
        } else {
          setOperationError(null)
        }
      } catch (error) {
        setOperationError(sanitizeRouteError(error instanceof Error ? error.message : String(error)))
      } finally {
        writeFence.setApplyNowInFlight(false)
      }
    })()
    writeFence.trackOperation(job)
    return { accepted: true }
  }  return { listVersions, select, apply, applyNowPreflight, applyNow, rollback, cleanupVersion, restoreBuiltin }
}
