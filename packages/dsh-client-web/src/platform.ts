/**
 * Shared browser platform modules. Seeding, bundling externals, and Vite
 * aliases consume this list so their module identities cannot drift.
 * @module @deepseek-ai/dsh-client-web/src/platform
 *
 * ## chamber patch (dsh rc.8 baseline alignment + C3 性能审计, 2026-09)
 *
 * INVARIANT: a platform word must NEVER be a package the host boot graph can
 * emit as a client-plugin row. The module system resolves the frozen seed
 * table BEFORE registered factories (system.ts import()), so a loader entry
 * whose id is both a seed word and a graph row materializes the static
 * namespace — an object of component exports without an `apply` method — and
 * the boot fails with "invalid plugin … received object". That is exactly why
 * rc.8 dropped `dsh-client-ui-attachment` (it gained a client half);
 * `dsh-client-web-react` / `dsh-client-schema-form` went with it for the same
 * structural reason. `@deepseek-ai/dsh-client-store` stays a shell-shared
 * singleton like cordis — never a host-graph row.
 *
 * C3 (2026-09 性能审计, 偏差登记): `@deepseek-ai/dsh-client-ui-primitives` is
 * REMOVED here while upstream tsdown.client.ts still externalizes it — its
 * wholesale namespace import (seed.ts) forced the whole primitives package
 * (markdown / highlight / block renderers) into the main-graph eval that
 * precedes the App mount. The word is answered by the composite's covered
 * factory (chamber-entry.ts COVERED_FACTORIES), with the ordering guarantee
 * that the chamber entry evaluates BEFORE any extra bundle loads (renderer
 * shell.ts "C3 gate", host-graph.ts `awaitBeforeLoad`); the residual
 * prefetch-failure race degrades loud. Every other word stays seed-answered.
 * A future upstream PLATFORM_MODULES change must be mirrored here (and in
 * seed.ts) consciously. The alpha.2 word `@deepseek-ai/dsh-client-ui-dockkit`
 * is answered by the composite's covered factory instead of this seed, for the
 * same chunk-budget reason as ui-primitives: seeding it pulls the docking kit
 * into the main-graph eval that precedes the App mount. It is a pure library
 * (no `dsh.client`), so the "a platform word must never be a host-graph row"
 * invariant is unaffected; see chamber-entry.ts / chamber-covered.ts.
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
] as const

/** Client-bundle specifiers whose factories the parser preloads before the shell starts. */
export const PRELOADED_CLIENT_EXTERNALS = [
] as const

/** One platform module specifier (a seed-table key). */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
