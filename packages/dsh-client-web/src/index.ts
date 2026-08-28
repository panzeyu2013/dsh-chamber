/**
 * Web shell library entry. The shell's product is {@link AppWebEntry} —
 * apps/web's Vite entry runs it against #root. The boot page and fiber-state
 * projection remain internal; the static module table and its platform words
 * form the package's build-time contract.
 *
 * ## chamber patch (dsh-chamber connection manager, design 05 §3.6/§4)
 *
 * The N-ctx module-table sharing seam: `ensureWebModuleSystem` (install-or-
 * reuse the page-level module system + `__ModuleLoader__` registration sink —
 * the first-boot race fix) and the `AppWebEntryOptions.extraRows` per-instance
 * host-graph boot-row merge. The boot page is the rc.8 framework-free BootPage
 * (the React loading gate moved to the ui-renderer with the application).
 * @module @deepseek-ai/dsh-client-web
 */

export { AppWebEntry, ensureWebModuleSystem, type AppWebEntryOptions, type BootSeams } from './boot.ts'
export type { ChamberBootContext } from './chamber-context.ts'
export { getStaticModules } from './seed.ts'
export { PLATFORM_MODULES, type PlatformModule } from './platform.ts'
export { STATE_LABELS, FIBER_STATE, type LoaderEntryState } from './loader-status.ts'
