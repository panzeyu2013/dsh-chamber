/**
 * Shared browser platform modules. Seeding, bundling externals, and Vite
 * aliases consume this list so their module identities cannot drift.
 * @module @deepseek-ai/dsh-client-web/src/platform
 *
 * ## chamber patch (2026-08, dsh rc.8 baseline alignment)
 *
 * The list is aligned with the official dsh 0.1.0-rc.8 platform set — the
 * three words rc.7 carried that rc.8 dropped (`dsh-client-web-react`,
 * `dsh-client-ui-attachment`, `dsh-client-schema-form`) are removed.
 *
 * The INVARIANT behind the list: a platform word must NEVER be a package the
 * host boot graph can emit as a client-plugin row. The module system resolves
 * the frozen seed table BEFORE registered factories (system.ts import()), so
 * a loader entry whose id is both a seed word and a graph row materializes
 * the static namespace — an object of component exports without an `apply`
 * method — and the boot fails with "invalid plugin … received object".
 * rc.8 gave `dsh-client-ui-attachment` a client half (it became a graph row),
 * which is exactly why rc.8 removed it from the platform set; keeping it here
 * crashes every chamber boot against an rc.8 backend (2026-08 regression).
 * `dsh-client-web-react` / `dsh-client-schema-form` went with it for the same
 * structural reason (a future dsh must not turn a shell word into a row).
 *
 * v0.1.2-alpha.1 alignment: the upstream platform set adds the store engine
 * word `@deepseek-ai/dsh-client-store` (the shared observable/store engine the
 * client ui-* packages import), adopted here in the same position. The store
 * is a shell-shared singleton like cordis — never a host-graph row.
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

/** One platform module specifier (a seed-table key). */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
