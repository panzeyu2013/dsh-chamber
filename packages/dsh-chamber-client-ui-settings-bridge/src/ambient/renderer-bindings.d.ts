/**
 * Local declaration for the renderer's internal React bindings module
 * (`@deepseek-ai/dsh-client-ui-renderer/src/client/bindings.tsx`).
 *
 * The bridge consumes exactly ONE factory from that module — the official
 * `observableHook` (2026-09-11 upstream-alignment A3) — while the module itself
 * is renderer-internal machinery: it also creates the three renderer React
 * contexts (host / root binding / scope binding) at load and reads the host and
 * binding faces declared in `ui-slots/src/renderer.ts`. Those interlocking
 * faces are not mirrored here; the specifier is mapped through this package's
 * tsconfig `paths` (same pattern as the connections-section mirror), and at
 * runtime vite resolves it into the real vendor source
 * (`packages/renderer/vite.config.mjs` `deepseekSource`: every
 * `@deepseek-ai/<pkg>/src/*` specifier maps into the vendor tree, so the module
 * rides the one shared chunk the bridge’s renderer imports already belong to).
 * 2026-09-11 review-fix F4d: this package imports ONLY `bindings.tsx`; the
 * sibling `bind` module it deep-imports belongs to the vendor module’s own edge
 * (`bindings.tsx` imports `./bind.ts`), and no ambient declaration for it exists
 * here because nothing in this package imports it.
 *
 * MIRROR WARNING: this face mirrors the REAL factory (WeakMap-cached
 * `bindSnapshotSelector(source)` per source). If upstream changes that
 * signature, this declaration and the `bridge-outlet.tsx` import MUST move
 * together.
 */
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Bind one observable source to an identity-stable selector Hook.
 * @param source - observable source.
 * @returns cached selector Hook.
 */
export function observableHook<T>(source: HostObservable<T>): SnapshotSelectorHook<T>
