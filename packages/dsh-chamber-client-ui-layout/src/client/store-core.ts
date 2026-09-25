/**
 * Pure core factory for the chamber layout store (design 06 — sidebar width
 * sharing): every runtime dependency arrives through an injected
 * `LayoutStoreEnvironment`, so the decision surface runs under plain node;
 * production wiring: `stores.ts`.
 * Contracts: sidebar preference is seeded from — and every drag written back
 * to — the shared view-prefs store (all N-ctx boots share one width across
 * restarts; toggleSidebar re-expands to it); the STORE value is immediate and
 * only the persistence write is trailing-debounced (150ms, exactly one write
 * per drag, last wins); each live instance adopts external widths without
 * reopening a closed sidebar (unchanged value breaks the echo).
 */
import type {
  ActionsDecl,
  EngineStoreHandle,
  EngineStoreInstance,
} from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import type { ChamberSidebarViewPrefs } from '@dsh-chamber/dsh-chamber-client-core'

/** Column geometry and right-panel preference set (mirrors the vendor `LayoutInfo`). */
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

/** Root panel selection (`panelInfo`) plus frame/panel geometry (`layoutInfo`). */
export type LayoutState = {
  panelInfo: {
    /** Null selects the Conversation; global panels keep the current Session intact. */
    activePanelId: MainPanelId | null
  }
  layoutInfo: LayoutInfo
}

/** Declared twin of the actions literal; drift fails assignability at the defineStore call. */
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

/** Injectable environment; production passes the real modules, tests pass fakes. */
export interface LayoutStoreEnvironment {
  defineStore: LayoutStoreDefineStore
  columns: LayoutStoreColumns
  viewPrefs: LayoutStoreViewPrefs
  /** First-render frame width (production: `window.innerWidth`; injected so the pure module runs under plain node). */
  initialViewportWidth(): number
}

/** One page-lifetime runtime per environment: live instances (WeakRefs), subscription flag, shared write timer. */
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
 * external widths into every live instance.
 * @param env - the environment whose runtime owns the instance.
 * @param instance - the live store instance to track.
 */
export function trackLayoutInstance(env: LayoutStoreEnvironment, instance: LayoutInstance): void {
  const runtime = runtimeFor(env)
  runtime.instances.add(new WeakRef(instance))
  if (runtime.subscriptionInstalled) return
  // Subscribe BEFORE arming the flag: a throwing subscribe must not skip adoption forever.
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
        // Per-instance isolation: one throwing store update must not starve the fan-out.
        try {
          // Bypasses `setSidebar`: the width is already persisted, and no
          // geometry gesture happened (rightbarInstant untouched). Re-clamped on
          // the way IN so an older or hand-edited preference stays in range.
          currentInstance.store.update((d) => {
            d.layoutInfo.sidebar = env.columns.clampWidth(width, env.columns.SIDEBAR_MIN, env.columns.SIDEBAR_MAX)
          })
        } catch (error) {
          console.error('[dsh-chamber] layout width adoption threw:', error)
        }
      }
    })
  })
  runtime.subscriptionInstalled = true
}

/**
 * Create the layout panel store handle. Closing the sidebar forgets its drag
 * width; reopening restores the shared persisted width (chamber fork), not the
 * contract default. The right panel opens at 45% of the frame on first opening
 * and keeps that px preference across resizes and close; drag writes clamp to
 * the current frame's range; narrow toggles change only the expansion override.
 * Registered instances adopt external widths via {@link trackLayoutInstance}.
 * @param env - injected environment (production uses the stores.ts default).
 */
export function createLayoutStore(env: LayoutStoreEnvironment): EngineStoreHandle<LayoutState, LayoutActions> {
  const { defineStore, columns, viewPrefs, initialViewportWidth } = env
  const runtime = runtimeFor(env)

  /** Shared persisted sidebar width, re-clamped defensively into the vendor drag range. */
  const prefsSidebarWidth = (): number =>
    columns.clampWidth(
      viewPrefs.getViewPrefs().sidebarWidth ?? columns.SIDEBAR_DEFAULT,
      columns.SIDEBAR_MIN,
      columns.SIDEBAR_MAX,
    )

  /**
   * Trailing-debounced persistence of the drag width. The drag handle reports
   * dx every rAF tick, so the full updateViewPrefs path (prune + sanitize +
   * stringify + localStorage + notify) must not run per tick; each tick
   * reschedules a ~150ms trailing timer, so a drag settles into exactly ONE
   * write (last width wins) and a paused gesture flushes early. The STORE value
   * stays immediate. Shared per environment, so the last drag in any shell wins.
   * A drag landing on the already-persisted width skips the whole persist/notify
   * path (and cancels a stale pending write).
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
      // A global panel id replaces the Conversation in the centre; retain clears an unregistered selection.
      selectPanel: (d, panelId: MainPanelId | null) => {
        d.panelInfo.activePanelId = panelId
      },
      retainMainPanels: (d, panelIds: readonly string[]) => {
        if (d.panelInfo.activePanelId !== null && !panelIds.includes(d.panelInfo.activePanelId)) {
          d.panelInfo.activePanelId = null
        }
      },
      setSidebar: (d, px: number) => {
        // STORE value immediate: the frame renders this tick's width.
        d.layoutInfo.rightbarInstant = false
        d.layoutInfo.sidebar = columns.clampWidth(px, columns.SIDEBAR_MIN, columns.SIDEBAR_MAX)
        // Persist the CLAMPED drag width (drags only run while open, so never
        // 0/closed); idempotent, so the adoption guard breaks any echo loop.
        scheduleSidebarWidthWrite(d.layoutInfo.sidebar)
      },
      // Narrow toggles flip only the override; the width preference survives untouched.
      toggleSidebar: (d) => {
        d.layoutInfo.rightbarInstant = false
        if (d.layoutInfo.viewportWidth < columns.SIDEBAR_AUTO_COLLAPSE) d.layoutInfo.narrowExpanded = !d.layoutInfo.narrowExpanded
        // Reopening expands to the SHARED persisted width (the vendor default
        // would fight the remembered width); closing writes 0 without persisting it.
        else d.layoutInfo.sidebar = d.layoutInfo.sidebar === 0 ? prefsSidebarWidth() : 0
      },
      // Crossing the breakpoint drops the override; the wide state is the preference.
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
