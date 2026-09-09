/**
 * The chamber layout store's core factory (design 06 — sidebar width sharing)
 * as a PURE module: every runtime dependency (the store engine, the vendor
 * column geometry, the sidebar view-prefs store) arrives through an injected
 * `LayoutStoreEnvironment`, so the whole decision surface is testable under
 * plain node (`test/layout-store.test.ts`) without the vendor ENGINE/store
 * packages (their source-only tree ships no built `lib/` for node to import).
 * The one vendor dependency the tests DO import directly is the pure
 * `columns.ts` geometry module, used as the real injected face to lock the
 * clamp ranges against the upstream constants. The production wiring lives in
 * `stores.ts` — it builds the default environment from the real modules and
 * re-exports `createLayoutStore`, keeping the registration face
 * (`client/index.ts` → `store: createLayoutStore`) unchanged.
 *
 * Baseline: upstream `dsh-v0.1.5-alpha.2` `ui-layout/src/client/stores.ts` —
 * nested `LayoutState` (`panelInfo` + `layoutInfo`), eight actions including
 * `selectPanel`/`retainMainPanels`, and the eager root instance the frame's
 * `AppFrame` reads (`PropsStore<ReturnType<typeof createLayoutStore>>`).
 *
 * Behavior notes (identical to the pre-injection fork):
 * - the sidebar preference is seeded from — and every drag written back to —
 *   the shared view-prefs store, so all N-ctx boots share one width and it
 *   survives restarts; `toggleSidebar` re-expands to that shared width;
 * - the STORE value is immediate (the frame renders this tick's width); ONLY
 *   the persistence write is trailing-debounced (150ms), so a drag does not
 *   run the full updateViewPrefs path per tick and settles into exactly one
 *   write (last width wins);
 * - every live store instance subscribes to view-prefs changes and adopts
 *   external widths (guarded: a closed sidebar is never re-opened, and
 *   unchanged values — the initiating shell's own echo — terminate the
 *   adoption, so no write loops).
 */
import type {
  ActionsDecl,
  EngineStoreHandle,
  EngineStoreInstance,
} from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import type { ChamberSidebarViewPrefs } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'

/**
 * Column geometry and the right-panel preference set (mirrors the vendor
 * `stores.ts` `LayoutInfo`): panel width preferences in px plus the frame
 * measurement and the right panel's reported presentation.
 */
export type LayoutInfo = {
  /** Sidebar width preference in px (0 = closed). */
  sidebar: number
  /** Last positive frame measurement; window width bootstraps the first render. */
  viewportWidth: number
  /** Narrow-viewport manual re-expand override. */
  narrowExpanded: boolean
  /** Saved right panel width in px, or null before its first opening. */
  rightbar: number | null
  /** Whether the right panel is drawn at all, in either presentation. */
  rightbarShown: boolean
  /** Whether the normal panel width reserves a grid track (including fullscreen). */
  rightbarTrack: boolean
  /** Reported fullscreen presentation; hides the outer resize handle. */
  rightbarFullscreen: boolean
  /** Suppress transitions for a fullscreen exit until another geometry action. */
  rightbarInstant: boolean
}

/**
 * Layout store state: the root panel selection (`panelInfo`, read through the
 * `usePanelInfo` global hook) and the frame/panel geometry (`layoutInfo`).
 */
export type LayoutState = {
  panelInfo: {
    /** Null selects the Conversation; global panels keep the current Session intact. */
    activePanelId: MainPanelId | null
  }
  layoutInfo: LayoutInfo
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
export type LayoutActions = {
  selectPanel: (draft: LayoutState, panelId: MainPanelId | null) => void
  retainMainPanels: (draft: LayoutState, panelIds: readonly string[]) => void
  setSidebar: (draft: LayoutState, px: number) => void
  toggleSidebar: (draft: LayoutState) => void
  setViewportWidth: (draft: LayoutState, width: number) => void
  setRightbar: (draft: LayoutState, px: number) => void
  openRightbar: (draft: LayoutState, track: boolean, fullscreen: boolean) => void
  closeRightbar: (draft: LayoutState) => void
}

export type LayoutInstance = EngineStoreInstance<LayoutState, LayoutActions>

/** The store-engine factory face (mirrors the ambient `defineStore`). */
export interface LayoutStoreDefineStore {
  <T, A extends ActionsDecl<T>>(
    decl: { init: () => T; persist?: string; actions: A & ActionsDecl<T> },
  ): EngineStoreHandle<T, A>
}

/** The vendor column geometry the store clamps with (columns.ts face). */
export interface LayoutStoreColumns {
  clampWidth(px: number, min: number, max: number): number
  SIDEBAR_DEFAULT: number
  SIDEBAR_MIN: number
  SIDEBAR_MAX: number
  SIDEBAR_AUTO_COLLAPSE: number
  RIGHTBAR_MIN: number
  RIGHTBAR_MAX_RATIO: number
  RIGHTBAR_DEFAULT_RATIO: number
}

/** The sidebar view-prefs store face the fork seeds from / writes back to. */
export interface LayoutStoreViewPrefs {
  getViewPrefs(): ChamberSidebarViewPrefs
  subscribeViewPrefs(listener: () => void): () => void
  updateViewPrefs(mutator: (prev: ChamberSidebarViewPrefs) => ChamberSidebarViewPrefs): void
}

/**
 * Injectable environment. Production (stores.ts) passes the real modules;
 * tests pass fakes — the factory logic is identical either way.
 */
export interface LayoutStoreEnvironment {
  defineStore: LayoutStoreDefineStore
  columns: LayoutStoreColumns
  viewPrefs: LayoutStoreViewPrefs
  /** First-render frame width (production: `window.innerWidth`; the vendor
   *  baseline reads the global directly, this fork injects it so the pure
   *  module stays runnable under plain node). */
  initialViewportWidth(): number
}

/** One page-lifetime runtime per environment: live instances (WeakRefs), the
 *  once-per-env subscription flag, and the shared trailing-write timer. */
interface LayoutStoreRuntime {
  instances: Set<WeakRef<LayoutInstance>>
  subscriptionInstalled: boolean
  writeTimer: ReturnType<typeof setTimeout> | undefined
}

/** Trailing debounce for the persistence write (drag → ONE updateViewPrefs). */
export const SIDEBAR_WRITE_DEBOUNCE_MS = 150

const runtimes = new WeakMap<LayoutStoreEnvironment, LayoutStoreRuntime>()

function runtimeFor(env: LayoutStoreEnvironment): LayoutStoreRuntime {
  let runtime = runtimes.get(env)
  if (runtime === undefined) {
    runtime = { instances: new Set(), subscriptionInstalled: false, writeTimer: undefined }
    runtimes.set(env, runtime)
  }
  return runtime
}

/**
 * Register one live store instance with its environment and, once per
 * environment, install the shared view-prefs subscription that adopts
 * external width changes into every live instance.
 *
 * The vendor baseline mints the root instance eagerly inside `apply` and
 * shares it with the registration (`store: { ...handle, create: () => instance }`),
 * so the fork's assembly calls this explicitly — the pre-alpha.2 `handle.create`
 * patch no longer runs (upstream overrides `create` on the shared handle).
 * @param env - the environment whose runtime owns the instance.
 * @param instance - the live store instance to track.
 */
export function trackLayoutInstance(env: LayoutStoreEnvironment, instance: LayoutInstance): void {
  const runtime = runtimeFor(env)
  runtime.instances.add(new WeakRef(instance))
  if (runtime.subscriptionInstalled) return
  // Subscribe BEFORE arming the flag: a throwing subscribe would otherwise
  // leave the flag set and permanently skip the once-per-env adoption.
  env.viewPrefs.subscribeViewPrefs(() => {
    queueMicrotask(() => {
      const width = env.viewPrefs.getViewPrefs().sidebarWidth
      if (width === undefined) return
      for (const ref of runtime.instances) {
        const currentInstance = ref.deref()
        if (currentInstance === undefined) {
          runtime.instances.delete(ref)
          continue
        }
        const current = currentInstance.getSnapshot().layoutInfo.sidebar
        if (current === 0 || current === width) continue
        currentInstance.store.update((d) => { d.layoutInfo.sidebar = width })
      }
    })
  })
  runtime.subscriptionInstalled = true
}

/**
 * Create the layout panel store handle. For the sidebar the preference IS the
 * width, so closing it forgets its drag width — reopening restores the shared
 * persisted width (chamber fork) instead of the contract default. The right
 * panel initializes at 45% of the frame on first opening and keeps that px
 * preference across resizes and close. Drag writes clamp to the current
 * frame's range. Narrow sidebar toggles change only the expansion override;
 * opening the right panel clears that override.
 *
 * Chamber fork: the sidebar preference is seeded from — and every drag
 * written back to — the shared view-prefs store, so all N-ctx boots share one
 * width and it survives restarts; each registered instance adopts external
 * width changes through {@link trackLayoutInstance}.
 * @param env - injected environment (production uses the stores.ts default).
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(env: LayoutStoreEnvironment): EngineStoreHandle<LayoutState, LayoutActions> {
  const { defineStore, columns, viewPrefs, initialViewportWidth } = env
  const runtime = runtimeFor(env)

  /**
   * The shared persisted sidebar width preference, clamped into the vendor drag
   * range. The prefs value is already sanitized+clamped on every write
   * (view-prefs sanitizePrefs); the re-clamp is defensive, exactly like the
   * vendor's computeColumns re-clamps preferences that cross the store boundary.
   */
  const prefsSidebarWidth = (): number =>
    columns.clampWidth(
      viewPrefs.getViewPrefs().sidebarWidth ?? columns.SIDEBAR_DEFAULT,
      columns.SIDEBAR_MIN,
      columns.SIDEBAR_MAX,
    )

  /**
   * Chamber fork: trailing-debounced persistence of the drag width into the
   * shared view-prefs store. The vendor frame's drag handle reports dx every
   * rAF tick (~60/s), so the full updateViewPrefs path (prune + sanitize +
   * JSON.stringify + localStorage.setItem + notify every shell subscriber) must
   * not run per tick. The STORE value stays immediate — setSidebar commits the
   * clamped width synchronously and the frame renders from it this tick — and
   * ONLY this persistence write is debounced: each tick reschedules a ~150ms
   * trailing timer, so a drag settles into exactly ONE write (the last width
   * wins) and a paused gesture flushes early. A drag cut short inside the
   * window (app quit <150ms after the last tick) loses only that one
   * intermediate width — accepted trade-off, the next drag re-establishes it.
   * Shared per environment (production: one module instance across every boot),
   * so drags in different shells share one timer and the last drag wins —
   * exactly as the shared prefs store itself resolves.
   *
   * P3-nit no-op guard (2026-09): a drag landing on the ALREADY-persisted
   * width skips the whole persist/notify path — no redundant
   * updateViewPrefs cycle (e.g. the initiating shell's own echo after
   * adoption, or a drag that returns to the stored width). A still-pending
   * older write is stale in that case (the final width is the persisted one),
   * so it is cancelled too.
   */
  const scheduleSidebarWidthWrite = (width: number): void => {
    if (viewPrefs.getViewPrefs().sidebarWidth === width) {
      if (runtime.writeTimer !== undefined) {
        clearTimeout(runtime.writeTimer)
        runtime.writeTimer = undefined
      }
      return
    }
    if (runtime.writeTimer !== undefined) clearTimeout(runtime.writeTimer)
    runtime.writeTimer = setTimeout(() => {
      runtime.writeTimer = undefined
      viewPrefs.updateViewPrefs(prev => ({ ...prev, sidebarWidth: width }))
    }, SIDEBAR_WRITE_DEBOUNCE_MS)
  }

  const handle = defineStore({
    init: (): LayoutState => ({
      panelInfo: { activePanelId: null },
      layoutInfo: {
        sidebar: prefsSidebarWidth(),
        viewportWidth: initialViewportWidth(),
        narrowExpanded: false,
        rightbar: null,
        rightbarShown: false,
        rightbarTrack: false,
        rightbarFullscreen: false,
        rightbarInstant: false,
      },
    }),
    actions: {
      // Upstream baseline: a global panel id replaces the Conversation in the
      // centre; retainMainPanels clears a selection whose key unregistered.
      selectPanel: (d, panelId: MainPanelId | null) => {
        d.panelInfo.activePanelId = panelId
      },
      retainMainPanels: (d, panelIds: readonly string[]) => {
        if (d.panelInfo.activePanelId !== null && !panelIds.includes(d.panelInfo.activePanelId)) {
          d.panelInfo.activePanelId = null
        }
      },
      setSidebar: (d, px: number) => {
        // The STORE value is immediate: the frame renders this tick's width.
        d.layoutInfo.rightbarInstant = false
        d.layoutInfo.sidebar = columns.clampWidth(px, columns.SIDEBAR_MIN, columns.SIDEBAR_MAX)
        // chamber fork: persist the CLAMPED drag width (drag only runs while
        // the sidebar is open, so this never writes 0/closed) — every other
        // live boot's store adopts it via the subscription below, and the
        // next page load seeds from it. The write is idempotent (same clamped
        // value), so the adoption guard breaks any echo loop. Only the
        // persistence write is trailing-debounced (scheduleSidebarWidthWrite),
        // so a drag does not run the full updateViewPrefs path per tick.
        scheduleSidebarWidthWrite(d.layoutInfo.sidebar)
      },
      // Narrow toggles flip only the override: the width preference survives
      // untouched, so re-widening restores the pre-squeeze layout.
      toggleSidebar: (d) => {
        d.layoutInfo.rightbarInstant = false
        if (d.layoutInfo.viewportWidth < columns.SIDEBAR_AUTO_COLLAPSE) d.layoutInfo.narrowExpanded = !d.layoutInfo.narrowExpanded
        // chamber fork: reopening expands to the SHARED persisted width (the
        // vendor contract default would fight a user's remembered width);
        // closing writes 0 without persisting it — the width preference only
        // ever records an OPEN drag.
        else d.layoutInfo.sidebar = d.layoutInfo.sidebar === 0 ? prefsSidebarWidth() : 0
      },
      // Crossing the breakpoint in either direction drops the override: the
      // narrow default is auto-collapsed, the wide state is the preference.
      setViewportWidth: (d, width: number) => {
        if (d.layoutInfo.viewportWidth === width) return
        d.layoutInfo.rightbarInstant = false
        if ((d.layoutInfo.viewportWidth < columns.SIDEBAR_AUTO_COLLAPSE) !== (width < columns.SIDEBAR_AUTO_COLLAPSE)) {
          d.layoutInfo.narrowExpanded = false
        }
        d.layoutInfo.viewportWidth = width
      },
      setRightbar: (d, px: number) => {
        d.layoutInfo.rightbarInstant = false
        d.layoutInfo.rightbar = columns.clampWidth(
          px,
          columns.RIGHTBAR_MIN,
          Math.max(columns.RIGHTBAR_MIN, d.layoutInfo.viewportWidth * columns.RIGHTBAR_MAX_RATIO),
        )
      },
      openRightbar: (d, track: boolean, fullscreen: boolean) => {
        if (!d.layoutInfo.rightbarShown || d.layoutInfo.rightbarTrack !== track || d.layoutInfo.rightbarFullscreen !== fullscreen) {
          d.layoutInfo.rightbarInstant = d.layoutInfo.rightbarFullscreen && !fullscreen
        }
        if (!d.layoutInfo.rightbarShown && d.layoutInfo.viewportWidth < columns.SIDEBAR_AUTO_COLLAPSE) d.layoutInfo.narrowExpanded = false
        d.layoutInfo.rightbar ??= Math.max(
          columns.RIGHTBAR_MIN,
          Math.round(d.layoutInfo.viewportWidth * columns.RIGHTBAR_DEFAULT_RATIO),
        )
        d.layoutInfo.rightbarShown = true
        d.layoutInfo.rightbarTrack = track
        d.layoutInfo.rightbarFullscreen = fullscreen
      },
      closeRightbar: (d) => {
        if (d.layoutInfo.rightbarShown) d.layoutInfo.rightbarInstant = d.layoutInfo.rightbarFullscreen
        d.layoutInfo.rightbarShown = false
        d.layoutInfo.rightbarTrack = false
        d.layoutInfo.rightbarFullscreen = false
      },
    },
  })
  return handle
}
