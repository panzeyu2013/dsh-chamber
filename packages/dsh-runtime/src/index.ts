/**
 * @dsh-chamber/dsh-runtime — the shared, host-agnostic dsh runtime version
 * management core (design 18 §9.1). Pure Node 22+, no Electron/IPC/control-plane
 * dependency; the desktop main process and the gateway server adapt it through
 * the real DI seams `StartupDeps`/`ApplyDeps`/`InstallerDeps` (+ desktop-side
 * `ControllerDeps`) — `RuntimeHostAdapter` is a documented sketch, not the
 * production adaptation mechanism.
 */
export * from './activation-gate.ts'
export * from './apply-phase.ts'
export * from './dsh-runtime-store.ts'
export * from './dsh-runtime-updater.ts'
export * from './known-good-monitor.ts'
export * from './override-lifecycle.ts'
export * from './registry-integrity.ts'
export * from './registry-metadata.ts'
export * from './registry-url.ts'
export * from './restart-exhausted-rollback.ts'
export * from './runtime-installer.ts'
export * from './runtime-metadata-recovery.ts'
export * from './runtime-operation-fence.ts'
export * from './runtime-probes.ts'
export * from './runtime-startup.ts'
export * from './runtime-state-machine.ts'
export * from './sanitize-error.ts'
export * from './snapshot-store.ts'
export * from './version-safety.ts'
export { ALLOW_BUILDS } from './allow-builds.mjs'
export { PRUNE_DIR_NAMES, PRUNE_FILE_PATTERNS, pruneRuntimeArtifacts } from './prune-runtime.mjs'
export * from './runtime-host-adapter.ts'
