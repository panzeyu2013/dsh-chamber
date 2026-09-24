/**
 * Platform-singleton module table: the ONLY entities the shell shares into the frozen
 * table, so fetch bundles resolve their externals against exactly this set. Keys come
 * from {@link ./platform.ts} (single source of truth with the tsdown client externals);
 * values stay shell-static imports so every bundle sees the same instance.
 *
 * Here too a word must NEVER be a host-graph plugin row (seed resolves before
 * factories, so it would materialize as an "invalid plugin"). ui-primitives and
 * ui-dockkit are deliberately not seeded — the composite's covered factory answers
 * them, and seeding would pull those packages into the main-graph eval preceding the
 * App mount. Do not restore a word here without removing its factory path too.
 */
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as Cordis from '@deepseek-ai/cordis'
import * as ClientStore from '@deepseek-ai/dsh-client-store'
import * as UiSlots from '@deepseek-ai/dsh-client-ui-slots'
import type { PlatformModule } from './platform.ts'

/** Build the static table handed to the module loader at boot (one entry per word). */
export function getStaticModules(): Record<string, unknown> {
  // The satisfies pin is the projection contract: a word without a static import here
  // (or vice versa) fails to compile instead of drifting into a runtime require miss.
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
