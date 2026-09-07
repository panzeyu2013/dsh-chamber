/**
 * Platform-singleton module-table. These are the ONLY entities the shell
 * shares into the frozen module table — fetch bundles resolve their externals
 * against exactly this set through the loader's require. Keys come from the
 * platform constant module ({@link ./platform.ts}, the single source
 * of truth with the tsdown client externals); values stay shell-static
 * imports so every bundle sees the same instance.
 *
 * ## chamber patch (2026-08, dsh rc.8 baseline alignment)
 *
 * Aligned with the official rc.8 seed: the row-capable words are gone (see
 * platform.ts for the invariant). A word here must never be a package the
 * host boot graph can emit as a plugin row — seed resolves before factories
 * in the module system, so a seed word that is also a row materializes the
 * static namespace as a loader entry and the boot fails ("invalid plugin").
 *
 * v0.1.2-alpha.1 alignment: the platform set gains the store engine word
 * `@deepseek-ai/dsh-client-store` (see platform.ts); the static import below
 * keeps the satisfies pin's two sides in lockstep.
 *
 * C3 (2026-09 性能审计, 偏差登记): `@deepseek-ai/dsh-client-ui-primitives` is
 * deliberately NOT seeded (platform.ts) — its wholesale namespace import
 * pulled the whole primitives package (markdown/highlight/block renderers and
 * their vendor stack) into the main-graph eval that precedes the App mount.
 * The word is answered by the composite's covered factory instead
 * (chamber-entry.ts COVERED_FACTORIES); the shell gates every extra-bundle
 * load behind the chamber entry evaluation (shell.ts "C3 gate"). Residual
 * edge: if the shell-side chamber prefetch fails, the create-side import
 * retry can run concurrently with extra loads — an extra requiring the word
 * in that window fails loud and degrades (retry self-heals), never silent.
 * Keeping the word here would defeat the whole change — do not restore it
 * without removing the factory path too.
 */
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as Cordis from '@deepseek-ai/cordis'
import * as ClientStore from '@deepseek-ai/dsh-client-store'
import * as UiSlots from '@deepseek-ai/dsh-client-ui-slots'
import type { PlatformModule } from './platform.ts'

/**
 * Build the static table handed to the module loader at boot.
 * @returns module specifier → exported entity (one entry per platform word).
 */
export function getStaticModules(): Record<string, unknown> {
  // The satisfies pin is the projection contract: a word added to
  // PLATFORM_MODULES without a static import here (or vice versa) fails to
  // compile instead of drifting into a runtime require miss.
  return {
    'react': React,
    'react/jsx-runtime': ReactJsxRuntime,
    'react-dom': ReactDom,
    'react-dom/client': ReactDomClient,
    '@deepseek-ai/cordis': Cordis,
    '@deepseek-ai/dsh-client-store': ClientStore,
    '@deepseek-ai/dsh-client-ui-slots': UiSlots,
  } satisfies Record<PlatformModule, unknown>
}
