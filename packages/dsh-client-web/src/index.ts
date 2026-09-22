/**
 * Web shell library entry. The shell's product is {@link AppWebEntry} —
 * apps/web's Vite entry runs it against #root. The boot page and fiber-state
 * projection remain internal; the static module table and its platform words
 * form the package's build-time contract.
 *
 * ## Chamber N-ctx seam (design 05 §6/§4)
 *
 * The N-ctx module-table sharing seam: `ensureWebModuleSystem` (install-or-
 * reuse the page-level module system + `__ModuleLoader__` registration sink —
 * the first-boot race guard) and the `AppWebEntryOptions.extraRows` per-instance
 * host-graph boot-row merge. The boot page is the framework-free BootPage;
 * the React loading gate lives in the ui-renderer with the application.
 * @module @deepseek-ai/dsh-client-web
 */

export { AppWebEntry, ensureWebModuleSystem, type AppWebEntryOptions, type BootSeams } from './boot.ts'
export { getStaticModules } from './seed.ts'
export { PLATFORM_MODULES, type PlatformModule } from './platform.ts'
export { STATE_LABELS, FIBER_STATE, type LoaderEntryState } from './loader-status.ts'
