/**
 * Initial module manifests: the ONLY entities the shell shares into the frozen table,
 * so fetch bundles resolve their externals against exactly this set. Keys come from
 * {@link ./platform.ts} (single source of truth with the tsdown client externals);
 * values stay shell-static imports so every bundle sees the same instance.
 *
 * Here too a word must NEVER be a host-graph plugin row (seed resolves before
 * factories, so it would materialize as an "invalid plugin"). ui-primitives and
 * ui-dockkit are deliberately not seeded — the composite's covered factory answers
 * them, and seeding would pull those packages into the main-graph eval preceding the
 * App mount. Do not restore a word here without removing its factory path too.
 *
 * alpha.1 protocol: `staticModules` is an array of `DshClientModuleManifest`s
 * ({ id, factory, meta? }), not a specifier→namespace record.
 */
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as Cordis from '@deepseek-ai/cordis'
import * as Zod from 'zod'
import * as ReactVirtual from '@tanstack/react-virtual'
import * as ClientStore from '@deepseek-ai/dsh-client-store'
import * as UiSlots from '@deepseek-ai/dsh-client-ui-slots'
import type { DshClientModuleManifest } from '@deepseek-ai/dsh-package-manifest'
import { STATIC_MODULE_MANIFEST_EXPORT, type PlatformModule } from './platform.ts'

function platform(id: string, exports: Record<string, unknown>): DshClientModuleManifest {
  return { id, factory: () => exports }
}

/**
 * Read the manifest a `staticLinked` library exports beside its ordinary exports.
 *
 * chamber deviation (C3 source-state build): upstream's `compiledModule()` REQUIRES the
 * build-time `__$dsh_client_module_manifest` export, which the chamber Vite build never
 * emits because it consumes the pinned vendor SOURCES instead of staticLinked npm libs.
 * An absent manifest therefore wraps the shell-static namespace locally (the exact
 * contract the old record table provided); a manifest that IS present is validated with
 * upstream's strictness, so a corrupted build fails loud instead of silently degrading.
 */
function compiledModule(id: string, namespace: object): DshClientModuleManifest {
  const manifest: unknown = Reflect.get(namespace, STATIC_MODULE_MANIFEST_EXPORT)
  if (manifest === undefined) return platform(id, namespace as Record<string, unknown>)
  if (typeof manifest !== 'object' || manifest === null
    || !('id' in manifest) || manifest.id !== id
    || !('factory' in manifest) || typeof manifest.factory !== 'function'
    || ('meta' in manifest && manifest.meta !== undefined && typeof manifest.meta !== 'function')) {
    throw new Error(`web boot: ${id} must be built with staticLinked before shell assembly`)
  }
  return manifest as DshClientModuleManifest
}

/**
 * Supply shared third-party identities and package-generated manifests through one protocol.
 * @returns Initial module registrations; JavaScript and metadata factories are not evaluated here.
 */
export function getStaticModules(): readonly DshClientModuleManifest[] {
  // The satisfies pin is the projection contract: a word without a static import here
  // (or vice versa) fails to compile instead of drifting into a runtime require miss.
  return Object.values({
    'react': platform('react', React),
    'react/jsx-runtime': platform('react/jsx-runtime', ReactJsxRuntime),
    'react-dom': platform('react-dom', ReactDom),
    'react-dom/client': platform('react-dom/client', ReactDomClient),
    '@deepseek-ai/cordis': platform('@deepseek-ai/cordis', Cordis),
    'zod': platform('zod', Zod),
    '@tanstack/react-virtual': platform('@tanstack/react-virtual', ReactVirtual),
    '@deepseek-ai/dsh-client-store': compiledModule('@deepseek-ai/dsh-client-store', ClientStore),
    '@deepseek-ai/dsh-client-ui-slots': compiledModule('@deepseek-ai/dsh-client-ui-slots', UiSlots),
  } satisfies Record<PlatformModule, DshClientModuleManifest>)
}
