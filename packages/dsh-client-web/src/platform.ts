/**
 * Shared browser platform modules: seeding, bundling externals and Vite aliases consume this list so identities cannot drift.
 *
 * INVARIANT: a platform word must NEVER be a package the host boot graph can emit as a
 * client-plugin row — the module system resolves the seed table BEFORE registered
 * factories, so an id that is both materializes the static namespace (no `apply`) and
 * fails the boot with "invalid plugin". ui-attachment / web-react / schema-form are
 * excluded for that reason; client-store stays a shell-shared singleton like cordis.
 * ui-primitives and ui-dockkit are answered by the composite's covered factory instead
 * of this seed; every other word stays seed-answered, and an upstream PLATFORM_MODULES
 * change must be mirrored here and in seed.ts.
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
] as const

/** One platform module specifier (a seed-table key). */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
