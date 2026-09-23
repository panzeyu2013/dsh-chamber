/**
 * @dsh-chamber/dsh-runtime — the shared, host-agnostic dsh runtime version
 * management core (design 18 §9.1). Pure Node 22+, no Electron/IPC/control-plane
 * dependency; the desktop main process and the gateway server adapt it through
 * the real DI seams `StartupDeps`/`ApplyDeps`/`InstallerDeps` (+ desktop-side
 * `ControllerDeps`).
 *
 * The entry is an EXPLICIT named surface, never a wholesale barrel:
 *
 * - Runtime values follow the consumer rule: every exported name has a
 *   production consumer (the workspace dead-export gate,
 *   scripts/gates/verify-no-dead-exports.mjs, judges this index). Internal
 *   helpers stay in their own modules for relative import; add a value face
 *   here only together with the production consumer that imports it.
 *   `pnpmEntryCandidates` is the current deliberate omission — its desktop
 *   consumer lands next round.
 * - Types are the ONE exception: types do not participate in the dead-export
 *   judgement, so every named type referenced by an exported runtime
 *   function/class signature (parameters and return types) and by the exported
 *   types themselves ships with them — hosts must be able to name and annotate
 *   the contract (`PnpmEntrySearch`, `DshCliEntryResolution`, `ApplyDeps`,
 *   `InstallerDeps`, the Deps/Result families). A type unrelated to any exported
 *   signature stays in its module (`RuntimeHostAdapter` is a documented sketch
 *   there, as are `WinProcessRow`, `CriticalRuntimeFile`, …).
 */
export {
  HOST_DOMAIN_PROBE_NAMES,
  PROBE_NAMES_WITHOUT_HOST_DOMAINS,
  REQUIRED_ACTIVATION_PROBES,
  activationProbeNamesForDomains,
  decideVerdict,
  rollbackTarget,
  shouldAutoRollback,
} from './activation-gate.ts'
export type {
  ActivationVerdict,
  ProbeResult,
  RollbackTargetOptions,
} from './activation-gate.ts'
export {
  readAnchorVersion,
} from './anchor-version.ts'
export {
  applyPendingVersion,
  beginDelayedRollback,
} from './apply-phase.ts'
export type {
  ApplyDeps,
  ApplyFailureKind,
  ApplyOptions,
  ApplyOutcome,
  ApplyRetryAction,
  ApplyStatus,
  ManualRollbackPreparation,
} from './apply-phase.ts'
export {
  createCoalescedRefresher,
} from './coalesced-refresh.ts'
export type {
  CoalescedRefreshRequestOptions,
  CoalescedRefresherOptions,
} from './coalesced-refresh.ts'
export {
  isDshWorkspace,
  resolveDshCliEntry,
} from './dsh-cli-entry.ts'
export type {
  DshCliEntryResolution,
} from './dsh-cli-entry.ts'
export {
  RUNTIME_LOGICAL_DISK_LIMIT_BYTES,
  activationJournalPath,
  cleanupExplicitRuntimeVersion,
  cleanupStaleInstalls,
  clearActivationJournal,
  clearCurrentPointer,
  clearRuntimeFailure,
  clearStorePruneRequest,
  currentPointerPath,
  deleteOverride,
  evictVersions,
  isProtectedVersion,
  listExplicitlyInstalledVersions,
  listKnownGoodVersionsState,
  listRuntimeFailures,
  listValidVersionTrees,
  markKnownGood,
  overridePath,
  queueActivationIntent,
  readActivationJournalState,
  readCurrentPointerState,
  readOverrideState,
  readStorePruneRequest,
  recordExplicitInstall,
  recordRuntimeFailure,
  runtimeDiskSummaryAsync,
  runtimeFailureSummary,
  runtimeSnapshotRetentionState,
  validateVersionTree,
  writeActivationIntent,
  writeActivationJournal,
  writeCurrentPointer,
  writeOverride,
} from './dsh-runtime-store.ts'
export type {
  ActivationIntentInput,
  ActivationIntentKind,
  ActivationJournal,
  ActivationJournalIntent,
  ActivationJournalPhase,
  ActivationJournalState,
  CurrentPointerState,
  ExplicitRuntimeCleanupResult,
  KnownGoodVersionsState,
  OverrideRecord,
  OverrideState,
  RestoreOutcomeRecord,
  RuntimeDiskSummary,
  RuntimeDiskWalkOptions,
  RuntimeFailureInput,
  RuntimeFailureRecord,
  RuntimeFailureSummary,
  RuntimeSnapshotRetentionState,
  StorePruneRequest,
  VersionTreeValidation,
} from './dsh-runtime-store.ts'
export {
  SingleFlight,
  bindRuntimeInstallResolution,
  buildCachedVersionList,
  buildVersionList,
  compareRuntimeVersions,
  isNoopSelection,
  isVersionDowngrade,
  versionExists,
} from './dsh-runtime-updater.ts'
export type {
  RuntimeInstallResolution,
  VersionListEntry,
} from './dsh-runtime-updater.ts'
export {
  noteBoot,
  promoteDueCandidates,
  recordProbePass,
  removeKnownGoodCandidate,
  resetCandidateHealthWindow,
} from './known-good-monitor.ts'
export type {
  HealthPolicy,
} from './known-good-monitor.ts'
export {
  projectMetadataHealthFacts,
  projectMetadataRecoveryGate,
} from './metadata-health-projection.ts'
export type {
  MetadataHealthProjectionFacts,
  MetadataRecoveryGateDecision,
  RuntimeMetadataComponent,
} from './metadata-health-projection.ts'
export {
  effectivePending,
  invalidate,
  shouldInvalidate,
} from './override-lifecycle.ts'
export {
  PrivateNoFollowOpenError,
  assertRuntimeRootNoFollow,
  atomicWriteRuntimeFileNoFollow,
  classifyPrivateFileNoFollow,
  createPrivateDirectoryNoFollow,
  createRuntimeFileExclusiveNoFollow,
  ensurePrivateDirectoryNoFollow,
  ensureRuntimeRootNoFollow,
  ensureRuntimeSubdirectoryNoFollow,
  openPrivateNoFollowReadAsync,
  openPrivateNoFollowSync,
  quarantineRuntimeFileNoFollow,
  readPrivateFileNoFollow,
  removeRuntimeFileNoFollow,
  syncPrivateDirectoryNoFollow,
  syncPrivateFileNoFollow,
} from './private-fs.ts'
export type {
  NoFollowConstantsLike,
  NoFollowOpenKind,
  NoFollowOpenOptions,
  PrivateFileRead,
  PrivateFileReadOptions,
  PrivateFsDurabilityDeps,
  PrivateFsQuarantineDeps,
  PrivateFsRemoveDeps,
  PrivateNoFollowOpenPhase,
  RuntimeFileIdentity,
} from './private-fs.ts'
export {
  createIntegrityVerifier,
  isSupportedIntegrity,
} from './registry-integrity.ts'
export {
  fetchRegistryMetadata,
  fetchRegistryResponse,
} from './registry-metadata.ts'
export type {
  RegistryMetadata,
  RegistryRequestOptions,
  RegistryVersionInfo,
} from './registry-metadata.ts'
export {
  DEFAULT_REGISTRY_ORIGIN,
  canonicalRegistryOrigin,
  isAllowedRegistryUrl,
  registryRedirectOrigins,
} from './registry-url.ts'
export {
  planRestartExhaustedRollback,
} from './restart-exhausted-rollback.ts'
export type {
  RestartExhaustedNotTriggeredReason,
  RestartExhaustedRollbackPlan,
  RestartExhaustedRollbackPlanOptions,
} from './restart-exhausted-rollback.ts'
export {
  INSTALL_ENV_WHITELIST,
  RuntimeInstallerSupervisor,
  disposeRuntimeInstaller,
  downloadVerifiedRegistryTarball,
  installRuntimeVersion,
  isRuntimeInstallerWriterSafetyError,
  pruneRuntimeStore,
  sanitizeInstallerOutput,
  verifyRuntimeTreeCriticalFiles,
} from './runtime-installer.ts'
export type {
  InstallOptions,
  InstallResult,
  InstallerDeps,
  PruneResult,
  PruneRuntimeStoreOptions,
  RunOptions,
  RunResult,
  RuntimeInstallProgress,
  RuntimeInstallerDisposalDeps,
  SmokeContext,
} from './runtime-installer.ts'
export {
  detectRuntimeMetadataHealth,
  inspectCorruptMetadataRecoveryMarker,
  recoverRuntimeMetadata,
  rescueCorruptMetadataRecoveryMarker,
} from './runtime-metadata-recovery.ts'
export type {
  CorruptMetadataRecoveryMarkerCapability,
  PriorRecoveryMarkerEvidence,
  RecoverRuntimeMetadataOptions,
  RecoverRuntimeMetadataResult,
  ResumeRuntimeMetadataRecoveryOptions,
  ResumeRuntimeMetadataRecoveryResult,
  RuntimeMetadataHealth,
  RuntimeMetadataHealthStatus,
  RuntimeMetadataProbeOutcome,
  RuntimeMetadataRecoveryCheckpoint,
  RuntimeMetadataRecoveryCopyConstraint,
  RuntimeMetadataRecoveryOperations,
  RuntimeMetadataRecoveryPhase,
  RuntimeMetadataRecoveryRecord,
  RuntimeMetadataRecoveryRenameKind,
  RuntimeMetadataRecoveryState,
  RuntimeMetadataRecoveryStorageKind,
  RuntimeMetadataRestoreOutcome,
} from './runtime-metadata-recovery.ts'
export {
  RuntimeOperationFence,
} from './runtime-operation-fence.ts'
export type {
  OperationLease,
} from './runtime-operation-fence.ts'
export {
  PROBE_TEXT_KEEP_TOKENS,
  runRuntimeActivationProbes,
} from './runtime-probes.ts'
export type {
  RuntimeProbeCall,
  RuntimeProbeOptions,
  RuntimeProbeRpcOptions,
  RuntimeProbeWarn,
} from './runtime-probes.ts'
export {
  FATAL_STARTUP_BLOCK_REASONS,
  runDelayedRollback,
  runStartupPhase,
  shouldProbeEnvWithDormantCorruptSelection,
} from './runtime-startup.ts'
export type {
  StartupActivationFacts,
  StartupBlockedReason,
  StartupDeps,
  StartupMetadataHealthStatus,
  StartupResult,
} from './runtime-startup.ts'
export {
  allowedActions,
  transition,
  transitionLifecycleProjection,
} from './runtime-state-machine.ts'
export type {
  RuntimeAction,
  RuntimeEvent,
  RuntimePhase,
} from './runtime-state-machine.ts'
export {
  sanitizeErrorText,
} from './sanitize-error.ts'
export {
  completeInterruptedRestore,
  listPreRollbackStashes,
  prepareManualRollbackData,
  pruneRuntimeSnapshots,
  resolveSnapshotName,
  restoreMarkerAuthorityStatus,
  restorePreRollback,
  restoreSnapshot,
  snapshotDshHome,
  snapshotPaths,
  snapshotSummary,
} from './snapshot-store.ts'
export type {
  CopyFn,
  ManualRollbackData,
  RestoreBackupCleanupStatus,
  RestoreHooks,
  RestoreMarker,
  RestoreMarkerAuthorityStatus,
  RestoreOutcome,
  RestorePhase,
  RuntimeSnapshotPruneResult,
  SnapshotArtifactCleanupResult,
  SnapshotPaths,
  SnapshotSummary,
} from './snapshot-store.ts'
export {
  EXACT_SEMVER,
  assertSafeVersion,
  compareSemverAsc,
  isSafeVersion,
} from './version-safety.ts'
export type {
  RuntimeStatusProjection,
} from './runtime-host-adapter.ts'
export {
  resolvePnpmEntry,
} from './pnpm-entry.ts'
export type {
  PnpmEntrySearch,
} from './pnpm-entry.ts'
export {
  ALLOW_BUILDS,
  DENY_BUILDS,
  renderAllowBuildsBlock,
} from './allow-builds.mjs'
export {
  pruneRuntimeArtifacts,
} from './prune-runtime.mjs'
