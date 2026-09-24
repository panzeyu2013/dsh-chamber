/**
 * Web shell library entry. The product is {@link AppWebEntry} (apps/web's Vite entry
 * runs it against #root). N-ctx seam: `ensureWebModuleSystem` (install-or-reuse the
 * page-level module system + registration sink, the first-boot race guard) and the
 * per-instance `AppWebEntryOptions.extraRows` boot-row merge. The boot page and fiber
 * projection stay internal.
 */

export { AppWebEntry, ensureWebModuleSystem, type AppWebEntryOptions, type BootSeams } from './boot.ts'
export { getStaticModules } from './seed.ts'
export { PLATFORM_MODULES, type PlatformModule } from './platform.ts'
export { STATE_LABELS, FIBER_STATE, type LoaderEntryState } from './loader-status.ts'
