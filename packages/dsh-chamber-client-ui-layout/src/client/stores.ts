/**
 * The root entry's transient layout store: panel geometry as plain widths in
 * px (0 = closed). Module level exports the factory only — a module-level
 * handle would pin the store's identity in the module
 * cache (a de-facto singleton surviving plugin reloads). register() receives
 * the factory (exclusive use: the framework instantiates per entry), AppFrame
 * derives its PropsStore share from the return type, and the service face
 * receives the bound actions through the registration's inject hook.
 *
 * CHAMBER FORK (design 06 — sidebar width sharing): the vendor store is a
 * per-boot unpersisted preference, so a drag in one shell was invisible in
 * the others and every restart reset to SIDEBAR_DEFAULT. This fork seeds
 * `sidebar` from the chamber sidebar package's page-wide view-prefs store
 * (`@dsh-chamber/dsh-client-ui-sidebar/shared` — ONE in-memory store shared
 * by every boot over the vite shared chunk, persisted under one versioned
 * localStorage key), writes every drag back into it, and has every live
 * instance subscribe to it so width changes propagate across boots live.
 * Only the sidebar width is shared/persisted: details, narrow and the
 * narrowExpanded override stay per-boot transient (the vendor contract).
 *
 * THIS FILE is the production WIRING (the default injected environment); the
 * factory logic itself lives in `store-core.ts` as a pure, dependency-
 * injected module so `test/layout-store.ts` can run it under plain node.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import {
  clampWidth, DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'
import { getViewPrefs, subscribeViewPrefs, updateViewPrefs } from '@dsh-chamber/dsh-client-ui-sidebar/shared'
import {
  createLayoutStore as createStore,
  type LayoutActions,
  type LayoutState,
  type LayoutStoreEnvironment,
} from './store-core.ts'

/** The production environment: the real engine, the vendor columns contract
 *  and the real sidebar view-prefs store (shared across every boot). */
const defaultEnvironment: LayoutStoreEnvironment = {
  defineStore,
  columns: {
    clampWidth,
    SIDEBAR_DEFAULT,
    SIDEBAR_MIN,
    SIDEBAR_MAX,
    DETAILS_DEFAULT,
    DETAILS_MIN,
    DETAILS_MAX,
  },
  viewPrefs: { getViewPrefs, subscribeViewPrefs, updateViewPrefs },
}

/**
 * Create the layout panel store handle (see store-core.ts for the full
 * behavior contract). `env` is injectable for tests; production calls with no
 * argument and gets the real modules above.
 */
export function createLayoutStore(
  env: LayoutStoreEnvironment = defaultEnvironment,
): EngineStoreHandle<LayoutState, LayoutActions> {
  return createStore(env)
}
