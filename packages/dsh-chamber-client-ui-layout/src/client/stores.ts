/**
 * Production wiring for the root layout store (design 06 — sidebar width
 * sharing): the factory only, because a module-level handle would pin the
 * store's identity across plugin reloads; `client/index.ts` mints ONE instance
 * eagerly and shares it with the registration.
 * The vendor store keeps the preference per boot, so this fork seeds `sidebar`
 * from the chamber page-wide view-prefs store (one in-memory store shared by
 * every boot, persisted under one localStorage key), writes every drag back
 * into it, and has every live instance subscribe so width changes propagate
 * live. Only the sidebar width is shared: the right panel preference and the
 * narrow override stay per-boot transient. Factory logic: `store-core.ts`.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import {
  clampWidth, RIGHTBAR_DEFAULT_RATIO, RIGHTBAR_MAX_RATIO, RIGHTBAR_MIN,
  SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'
import { getViewPrefs, subscribeViewPrefs, updateViewPrefs } from '@dsh-chamber/dsh-chamber-client-core'
import {
  createLayoutStore as createStore,
  trackLayoutInstance as trackInstance,
  type LayoutActions,
  type LayoutState,
  type LayoutStoreEnvironment,
} from './store-core.ts'

/** Production environment: the real engine, vendor columns contract and shared view-prefs store. */
const defaultEnvironment: LayoutStoreEnvironment = {
  defineStore,
  columns: {
    clampWidth,
    SIDEBAR_DEFAULT,
    SIDEBAR_MIN,
    SIDEBAR_MAX,
    SIDEBAR_AUTO_COLLAPSE,
    RIGHTBAR_MIN,
    RIGHTBAR_MAX_RATIO,
    RIGHTBAR_DEFAULT_RATIO,
  },
  viewPrefs: { getViewPrefs, subscribeViewPrefs, updateViewPrefs },
  initialViewportWidth: () => window.innerWidth,
}

/** Create the layout store handle (behavior contract in store-core.ts); `env` is injectable for tests. */
export function createLayoutStore(
  env: LayoutStoreEnvironment = defaultEnvironment,
): EngineStoreHandle<LayoutState, LayoutActions> {
  return createStore(env)
}

/**
 * Register the minted root instance with the production environment so a drag
 * in any shell propagates to every live boot.
 * @param instance - the root store instance minted by `client/index.ts`.
 */
export function trackLayoutInstance(instance: Parameters<typeof trackInstance>[1]): void {
  trackInstance(defaultEnvironment, instance)
}
