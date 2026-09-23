/**
 * Gateway runtime version actions (design 18 §9.3 route table): selection
 * ledger (select/apply/rollback/cleanup), registry version list, builtin
 * restore and the apply-now session switch.
 *
 * The module owns no mutable state: it re-reads the durable core metadata per
 * call and receives the manager's action guards, write fence, resolution
 * facts, startup-transaction driver and projection setters as explicit
 * handles. Win32 read-only refusals and every refusal code/message are
 * preserved verbatim.
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
  readOverride,
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
  envPinnedRefusal,
  recoveryRetryRequiredRefusal,
  refusalError,
} from '../runtime-refusals.ts'
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

  /** Cleanup candidates for the settings UI (desktop parity): the
   *  explicit-install ledger minus everything the deletion-point protection
   *  set would refuse (current/pending/chosen/known-good/failure evidence).
   *  Fail-closed: any read trouble projects an empty list — the cleanup route
   *  stays authoritative and re-validates. */
  function removableCleanupVersions(): string[] {
    if (platform === 'win32') return []
    try {
      return listExplicitlyInstalledVersions(baseDir)
        .filter((version) => !isProtectedVersion(baseDir, version, { ignoreExplicitInstall: true }))
        .sort((a, b) => compareRuntimeVersions(b, a) ?? 0)
    } catch {
      return []
    }
  }

  async function listVersions(): Promise<unknown> {
    writeFence.assertManagerReadable()
    const origin = platform === 'win32' ? DEFAULT_REGISTRY_ORIGIN : readRegistryOrigin(baseDir)
    const cachedVersions = platform === 'win32' ? [] : listValidVersionTrees(baseDir)
    let active: string | null = null
    try { active = facts.resolveWorkspace().version } catch { /* status carries the loud selection error */ }
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
        removableVersions: removableCleanupVersions(),
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
        removableVersions: removableCleanupVersions(),
        error: sanitizeErrorText(String(error)),
      }
    }
  }

  /** A fresh user selection cancels any STALE intent journal (e.g. a prior
   * rollback's intent whose target no longer matches the selection). Only an
   * 'intent'-phase journal is cleared — an in-flight transaction
   * (prepared/applying/monitoring) keeps its evidence; writeActivationIntent
   * supersedes intent-phase journals and queues nextIntent onto
   * applied-monitoring ones (rollback → re-select → apply must not strand a
   * mismatched journal that FATAL-blocks the next boot). */
  function clearStaleIntent(): void {
    const state = readActivationJournalState(baseDir)
    if (state.kind === 'valid' && state.journal.phase === 'intent') {
      clearActivationJournal(baseDir)
    }
  }

  /** Consume an app-update invalidation stamp when the user makes a FRESH
   * selection under the CURRENT shell. `shouldInvalidate` reads the ACTIVE
   * `invalidatedAt`/`invalidatedReason` pair, so carrying it into a new record
   * makes that selection born-invalidated: pending
   * is then permanently ignored by effectivePending/persistedPendingVersion,
   * apply-now refuses it as `no_selection`, and the leftover intent journal
   * next to the still-stamped record is classified `selection-corrupt` by the
   * semantic-mismatch detector — the runtime can never switch again.
   *
   * Desktop parity: dsh-runtime-controller.ts writes a clean literal record on
   * install, so the desktop's post-update re-selection does take effect. The
   * `lastInvalidated*` fields are deliberately KEPT (design 18 F4:
   * they are the durable user-visible "original selection retained" history and
   * must survive); only the active stamp is cleared.
   *
   * Deliberately mirrors runtime-startup.ts's F4 reactivation (the core's other
   * clear-the-stamp site): null the active pair rather than dropping the keys,
   * and fold the stamp into `lastInvalidated*` first so a record carrying a
   * stamp but no history does not lose its only "when/why" evidence.
   * `lastInvalidationRecovered` is intentionally NOT set: it means "F4
   * automatically restored the previous tree after a failed builtin probe"
   * (the desktop reads it for that message), which a user re-selection is not. */
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
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw refusalError(envPinnedRefusal('version mutations'))
    assertNoPending()

    // The version selector always places the active version first. Selecting
    // the builtin anchor's version is therefore a true no-op even though it is
    // not an installed version tree and must never trigger a registry fetch.
    if (facts.resolveWorkspace().version === version) {
      setOperationError(null)
      setRestartOutcome(null)
      setStartOutcome(null)
      return { accepted: true, version }
    }
    const currentAtSelection = facts.currentPointerVersion()

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
          ...reactivateSelection(previous),
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
          // A fresh user transaction supersedes a failed snapshot — the
          // durable lastOutcome marker must not re-block the next startup
          // (desktop parity: its install writes a fresh record).
          lastOutcome: null,
          lastError: null,
        })
      }
      setOperationError(null)
      setRestartOutcome(null)
      setStartOutcome(null)
      return { accepted: true, version }
    }
    // Install is a writer single-flight, but NOT an activation quarantine:
    // the current dsh/proxy/features remain authoritative and serviceable for
    // the entire download/pnpm window. Only a later startup/apply transaction
    // may close exposure while probing the candidate.
    writeFence.setInstallInFlight(true)
    try {
      // Design 18's 10 GiB limit gates NEW downloads only. Cached selection,
      // rollback and recovery remain available above the soft ceiling.
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
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw refusalError(envPinnedRefusal('version mutations'))
    assertNoPending()

    const record: OverrideRecord = readOverride(baseDir) ?? {
      shellVersion,
      chosenVersion: null,
      resolvedVersion: null,
      pending: null,
      swapAttempted: false,
    }
    if (record.chosenVersion === null) throw Object.assign(new Error('no runtime version selected'), { code: 'no_selection' })
    // Symmetric with applyNowPreflight's no_selection gate: a record invalidated
    // by an app update must NOT be armed. Writing pending on it would return an
    // honest-looking 200 for a switch that effectivePending/persistedPendingVersion
    // then ignore forever, and the stranded intent journal beside the still-
    // stamped record is what the metadata health detector later reports as
    // selection-corrupt. The user must re-select under the current shell first
    // (select() consumes the stamp) — F4 deliberately does not trust a choice
    // made by the previous shell.
    if (shouldInvalidate(record, shellVersion)) {
      throw Object.assign(
        new Error('the stored runtime selection was invalidated by a gateway update; re-select the version before applying it'),
        { code: 'no_selection' },
      )
    }
    // The activation intent must agree with the pending target —
    // a stale intent journal (e.g. from an earlier rollback) would otherwise
    // FATAL-block the next boot on journal-mismatch. writeActivationIntent
    // replaces intent-phase journals and queues onto applied-monitoring ones
    // (desktop parity); an in-flight transaction refuses honestly (409).
    // The downgrade formula uses the EFFECTIVE active version (pointer ??
    // builtin anchor), exactly like the desktop controller's activeVersion():
    // a builtin-active downgrade is still a real data rollback (manualRollback
    // arms the pre-rollback stash + target-data restore, design 18 §3.7), not
    // a plain switch. The raw pointer would silently narrow that semantic.
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
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw refusalError(envPinnedRefusal('version mutations'))
    assertNoPending()

    if (!listValidVersionTrees(baseDir).includes(version)) {
      throw Object.assign(new Error(`no valid version tree for ${version}`), { code: 'invalid_target' })
    }
    // Direction guard (fail-loud): rollback is the DOWNGRADE path only — a
    // same-as-active or newer target is select+apply's job, and accepting it
    // here would journal a manualRollback intent with upgrade semantics (the
    // API/dashboard must not misuse rollback for an upgrade). The comparison
    // uses the EFFECTIVE active version (pointer
    // ?? builtin anchor), the same formula as apply()/applyNowPreflight() and
    // the desktop controller's activeVersion(): a builtin-active downgrade to
    // an installed tree is a legitimate manual rollback (data restore, design
    // 18 §3.7) and stays accepted. `current === null` (no pointer AND no
    // readable builtin version — a broken anchor) is refused: there is no
    // active version to be older than, and switching to an installed tree is
    // a plain select+apply.
    const current = facts.currentPointerVersion() ?? builtinVersion
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
    // Journal FIRST, then the override: a crash between
    // the two writes must not strand a pending override without its
    // manualRollback intent — the intent is the durable record of the
    // transaction's kind; the override only arms it.
    writeActivationIntent(baseDir, {
      targetVersion: version,
      targetIsBuiltin: false,
      manualRollback: true,
      intentKind: 'version-switch' as ActivationIntentKind,
    })
    // A manual rollback is likewise a FRESH user choice under the current
    // shell, so it consumes an app-update stamp exactly like select() does —
    // without this, arming the rollback would write a pending that
    // effectivePending/persistedPendingVersion ignore, stranding the same
    // journal-next-to-a-stamped-record state that reads as selection-corrupt.
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
    // A fresh transaction supersedes the in-memory blocked phase marker
    // (parity with restoreBuiltin); the durable markers above
    // are the authority — the next boot re-derives any real block.
    setStartupBlockReason(null)
    setOperationError(null)
    setRestartOutcome(null)
    setStartOutcome(null)
    return { accepted: true }
  }

  /** User-authorized cleanup of one explicitly retained version tree
   *  (desktop-parity route): mirrors desktop RUNTIME_CLEANUP_VERSION — ledger
   *  membership is required (never an arbitrary tree), the shared core
   *  re-reads the complete protection set at the deletion point, the durable
   *  store-prune marker is consumed by runStorePruneIfNeeded, and a success
   *  supersedes a stale operation error (desktop resets the disk-gate error
   *  phase the same way). */
  async function cleanupVersion(version: string): Promise<{ version: string; removed: boolean }> {
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw refusalError(envPinnedRefusal('version mutations'))
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
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw refusalError(envPinnedRefusal('version mutations'))
    // Desktop parity: reset-builtin without an override is a pointless
    // stop → snapshot → probe cycle (the anchor is already authoritative and
    // there is nothing to clear) — the desktop only offers the action when
    // hasOverride, and a no-override API call must not manufacture downtime.
    const overrideState = readOverrideState(baseDir)
    if (overrideState.kind === 'missing') {
      throw Object.assign(new Error('no override exists — the runtime is already on the builtin anchor; nothing to restore'), { code: 'runtime_no_override' })
    }
    // Desktop parity: reset-builtin only applies to a
    // HEALTHY or ordinary-pending selection. Inside an interrupted apply
    // (durable swapAttempted / lastOutcome snapshot-failed), an interrupted
    // data restore (restore marker), a corrupt override, or any armed memory
    // block, the shared core re-blocks an armed reset intent — running this
    // transaction would stop the managed dsh for nothing and leave the armed
    // reset intent behind, hijacking the later retry-apply/retry-restore
    // semantics. Refuse BEFORE any stop or intent write; the desktop never
    // offers reset-builtin in these states either (only the matching retry
    // and recover-metadata).
    const durable = overrideState.kind === 'valid' ? overrideState.record : null
    const journalState = readActivationJournalState(baseDir)
    const pointerState = readCurrentPointerState(baseDir)
    const recoveryReason = getStartupBlockReason() !== null
      ? getStartupBlockReason()
      : journalState.kind === 'corrupt'
        ? 'journal-corrupt'
        : pointerState.kind === 'corrupt'
          ? 'current-corrupt'
          : overrideState.kind === 'corrupt'
            ? 'override-corrupt'
            : durable !== null && (durable.swapAttempted === true || durable.lastOutcome === 'snapshot-failed')
              ? durable.swapAttempted === true ? 'swap-attempted' : 'snapshot-failed'
              : restoreMarkerAuthorityStatus(baseDir) !== 'missing'
                ? 'restore-half'
                : null
    if (recoveryReason !== null) {
      // Same code/message as start()/applyNowPreflight/profileWriteRefusal
      // (recoveryRetryRequiredRefusal).
      throw refusalError(recoveryRetryRequiredRefusal(recoveryReason))
    }

    // Reset-builtin is an activation transaction, not metadata deletion:
    // durable intent → quiesce DSH_HOME → snapshot → atomic pointer clear →
    // full probe gate. Shared startup code deletes the override/journal only
    // after the builtin probe passes; every failure preserves rollback and
    // recovery evidence.
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

    // Candidate/fallback probes normally leave a host alive. Snapshot failure
    // never spawns, so explicitly resume the untouched source after releasing
    // the activation gate. Hard recovery/metadata blocks intentionally stay
    // stopped and pollable.
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
   * Synchronous apply-now preflight: every manager gate that can refuse the
   * action runs here, synchronously, so the route can answer a 409/403 BEFORE
   * any 202 goes out — a preflight throw must never be swallowed into a fake
   * 202 whose status never settles.
   *
   * Order: platform → assertMutationIdle (incl. applyNowInFlight) → env →
   * fail-closed metadata/state gates (corrupt activation
   * journal / in-memory startup block / managed dsh not ready — each mirrors a
   * route-level refusal so a DIRECT manager call refuses identically) → target
   * resolution (ordinary pending, else a NON-invalidated staged chosenVersion;
   * both empty → no_selection) → installed-tree validation → no-op rejection
   * (target already active with no in-flight transaction to continue) → arm of
   * the pending switch when only a selection is staged (journal-first,
   * apply() ordering; manualRollback mirrors apply() :1084).
   *
   * Returns the resolved target version.
   */
  function applyNowPreflight(): string {
    if (platform === 'win32') throw Object.assign(new Error('windows runtime mutations are read-only'), { code: 'platform_read_only' })
    assertMutationIdle()
    if (envPath !== null) throw refusalError(envPinnedRefusal('version mutations'))

    // A corrupt activation journal must fail closed BEFORE
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
    const blockReason = getStartupBlockReason()
    if (blockReason !== null) {
      throw refusalError(recoveryRetryRequiredRefusal(blockReason))
    }
    // Direct-call parity with the route's connection gate: a managed dsh that
    // never reached ready cannot be switched in-session (mirrors /restart).
    if (plane.connectionState !== 'ready' && plane.connectionState !== 'degraded') {
      // Same code/message as the route /apply-now pre-gate
      // (applyNowNotRunningRefusal).
      throw refusalError(applyNowNotRunningRefusal(plane.connectionState))
    }

    // The target is the ordinary pending version when one exists, else the
    // staged chosenVersion (a selectedOnly selection with no pending yet).
    // Both empty → no_selection (never a no-op dsh stop/start cycle). An
    // invalidated record (gateway upgrade, shellVersion mismatch) keeps its
    // chosenVersion but is NOT a valid target — the selection gate must filter
    // it HERE, not at the route's status projection, whose selectedVersion
    // field does not see the invalidation (a status-based no_selection gate
    // would let the stale choice through to a fake 202).
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
    // stop → snapshot → spawn → probe cycle. The exception was too wide —
    // applied-monitoring (no nextIntent) is the durable end state of every
    // successful apply (pending=null, chosen==active), and apply-now must not
    // run that empty stop/start loop on the ALREADY-ACTIVE version. Only the
    // crash-continuation phases (prepared /
    // switched / manual-restoring / manual-restored / rollback-needed /
    // restoring / restore-complete / fallback-builtin) still pass — those are
    // real interrupted transactions that apply-now must continue. An
    // applied-monitoring journal WITH nextIntent needs no special case: its
    // nextIntent arms a pending that differs from current, so target !==
    // current above and the transaction proceeds naturally.
    // Effective active version (pointer ?? builtin anchor) — same formula as
    // apply()/rollback() and the desktop controller: a builtin-active staged
    // downgrade arms a real manualRollback below, not a plain switch.
    const current = facts.currentPointerVersion() ?? builtinVersion
    if (target === current) {
      const journal = readActivationJournalState(baseDir)
      if (journal.kind === 'missing'
        || (journal.kind === 'valid'
          && (journal.journal.phase === 'intent' || journal.journal.phase === 'applied-monitoring'))) {
        throw Object.assign(new Error(`dsh v${target} is already the active runtime; apply-now has nothing to do`), { code: 'noop_target' })
      }
    }

    // When only the selection is staged (no pending yet),
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
          // Mirror apply() :1084's downgrade-aware formula instead of a
          // hardcoded false — a staged downgrade (chosen < current) arms
          // a real manual rollback intent so runStartupPhase prepares the
          // pre-rollback stash, exactly like a rollback()-armed switch.
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
        // A fresh apply-now transaction supersedes a failed snapshot's durable
        // lastOutcome marker (desktop parity).
        lastOutcome: null,
        lastError: null,
      })
      // A fresh transaction supersedes the in-memory blocked phase marker; the
      // durable writes above are the authority.
      setStartupBlockReason(null)
      setOperationError(null)
      setRestartOutcome(null)
      setStartOutcome(null)
    }
    return target
  }

  /**
   * Immediately apply the pending/staged version switch inside the current
   * session (design 18 addendum · apply-now, §5.1): the version-switch twin of
   * restoreBuiltin — durable intent → quiesce DSH_HOME → snapshot → atomic
   * pointer switch → spawn candidate → full probe gate → verdict/rollback.
   * 202 semantics: the caller receives `{ accepted: true }` synchronously;
   * the async job's outcome is projected into status() (operationError /
   * startupBlockReason), never only into the log. Every synchronous refusal
   * happens in applyNowPreflight() BEFORE applyNowInFlight is armed — the
   * route answers 409/403 from the preflight and never sends a fake 202.
   */
  async function applyNow(): Promise<{ accepted: boolean }> {
    // The preflight arms the pending switch when only a selection is staged;
    // the transaction body below relies on that persisted pending —
    // runStartupPhase derives effectivePending === targetVersion from the
    // override/journal, so `target` needs no separate plumbing into it.
    // `target` is intentionally not bound: the preflight arms the persisted
    // pending and the transaction derives the target from override/journal.
    applyNowPreflight()
    writeFence.setApplyNowInFlight(true)
    const job = (async () => {
      // The recovery segment (startLocal + exposure resync) and the outcome
      // projection run AFTER endActivation() closes the quarantine window —
      // restoreBuiltin order (mirror restoreBuiltin :1180-1192). Running the
      // recovery startLocal INSIDE beginActivation()…endActivation() would hit
      // index.ts's canStartLocal gate (activationInProgress() &&
      // !internalSpawnActive() → connection_busy), which refuses every
      // non-internal spawn, and the operationError would be overwritten with
      // the misleading 'dsh runtime activation in progress'.
      let result: Awaited<ReturnType<typeof runStartupPhase>> | null = null
      try {
        // A new transaction supersedes any stale projection from a previous
        // select/restart/apply-now the moment it is accepted —
        // the 202 window must not keep echoing the last failure's text.
        setOperationError(null)
        writeFence.beginActivation()
        try {
          await plane.stopLocal()
          result = await startup.executeStartupTransaction(writeFence.abortSignal)
        } finally {
          writeFence.endActivation()
          invalidateDiskCache()
        }
        // stop()/dispose() during the in-flight job must never let the
        // recovery startLocal resurrect the managed dsh.
        if (writeFence.isDisposed()) return
        if (result.blockedReason === null || result.blockedReason === 'snapshot-failed') {
          await plane.startLocal()
          plane.refreshLocalExposure()
        }
        // The 202 job's failure must project into manager state (restart
        // parity) — the settings poll reads these fields, not the log. Hard
        // recovery/metadata blocks stay stopped and pollable (restoreBuiltin
        // :1180-1192 semantics); executeStartupTransaction already projected
        // startupBlockReason = result.blockedReason.
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
