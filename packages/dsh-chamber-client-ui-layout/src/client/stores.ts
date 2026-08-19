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
 */
import { defineStore, type EngineStoreHandle, type EngineStoreInstance } from '@deepseek-ai/dsh-client-runtime/client'
import {
  clampWidth, DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'
import { getViewPrefs, subscribeViewPrefs, updateViewPrefs } from '@dsh-chamber/dsh-client-ui-sidebar/shared'

/**
 * Layout store state: panel width preferences in px (0 = closed), plus the
 * narrow-viewport pair — `narrow` mirrors AppFrame's breakpoint reading
 * (viewport < SIDEBAR_AUTO_COLLAPSE) so toggleSidebar can pick semantics, and
 * `narrowExpanded` is the manual override that re-expands the auto-collapsed
 * sidebar over the squeezed center without rewriting the width preference.
 */
type LayoutState = { sidebar: number; details: number; narrow: boolean; narrowExpanded: boolean }

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type LayoutActions = {
  setSidebar: (draft: LayoutState, px: number) => void
  setDetails: (draft: LayoutState, px: number) => void
  toggleSidebar: (draft: LayoutState) => void
  setNarrow: (draft: LayoutState, narrow: boolean) => void
  openDetails: (draft: LayoutState) => void
  closeDetails: (draft: LayoutState) => void
}

type LayoutInstance = EngineStoreInstance<LayoutState, LayoutActions>
const layoutInstances = new Set<WeakRef<LayoutInstance>>()
let viewPrefsSubscriptionInstalled = false

/** One page-lifetime listener fans out through weak references to live stores. */
function trackLayoutInstance(instance: LayoutInstance): void {
  layoutInstances.add(new WeakRef(instance))
  if (viewPrefsSubscriptionInstalled) return
  viewPrefsSubscriptionInstalled = true
  subscribeViewPrefs(() => {
    queueMicrotask(() => {
      const width = getViewPrefs().sidebarWidth
      if (width === undefined) return
      for (const ref of layoutInstances) {
        const currentInstance = ref.deref()
        if (currentInstance === undefined) {
          layoutInstances.delete(ref)
          continue
        }
        const current = currentInstance.getSnapshot().sidebar
        if (current === 0 || current === width) continue
        currentInstance.store.update((d) => { d.sidebar = width })
      }
    })
  })
}

/**
 * The shared persisted sidebar width preference, clamped into the vendor drag
 * range. The prefs value is already sanitized+clamped on every write
 * (view-prefs sanitizePrefs); the re-clamp is defensive, exactly like the
 * vendor's computeColumns re-clamps preferences that cross the store boundary.
 */
function prefsSidebarWidth(): number {
  return clampWidth(getViewPrefs().sidebarWidth ?? SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX)
}

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
 * Module-level on purpose (consistent with the view-prefs store it writes
 * to): the shared chunk keeps one module instance across every boot, so drags
 * in different shells share one timer and the last drag wins — exactly as the
 * shared prefs store itself resolves.
 */
const SIDEBAR_WRITE_DEBOUNCE_MS = 150
let sidebarWriteTimer: ReturnType<typeof setTimeout> | undefined
function scheduleSidebarWidthWrite(width: number): void {
  if (sidebarWriteTimer !== undefined) clearTimeout(sidebarWriteTimer)
  sidebarWriteTimer = setTimeout(() => {
    sidebarWriteTimer = undefined
    updateViewPrefs(prev => ({ ...prev, sidebarWidth: width }))
  }, SIDEBAR_WRITE_DEBOUNCE_MS)
}

/**
 * Create the layout panel store handle. The preference IS the width, so
 * closing a panel forgets its drag width — reopening restores the contract
 * default. Actions are the complete write set: drag writes clamp
 * into the panel's contract range and never cross the open/closed line;
 * open/close transitions write 0 / the default explicitly. Below the
 * auto-collapse breakpoint (AppFrame feeds setNarrow) the sidebar toggle
 * flips the narrowExpanded override instead of the preference.
 *
 * Chamber fork: the sidebar preference is seeded from — and every drag
 * written back to — the shared view-prefs store, so all N-ctx boots share one
 * width and it survives restarts; `toggleSidebar` re-expands to that shared
 * width instead of the contract default; and each minted store instance
 * subscribes to view-prefs changes to adopt external width changes.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions> {
  const handle = defineStore({
    init: (): LayoutState => ({ sidebar: prefsSidebarWidth(), details: 0, narrow: false, narrowExpanded: false }),
    actions: {
      setSidebar: (d, px: number) => {
        // The STORE value is immediate: the frame renders this tick's width.
        d.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX)
        // chamber fork: persist the CLAMPED drag width (drag only runs while
        // the sidebar is open, so this never writes 0/closed) — every other
        // live boot's store adopts it via the subscription below, and the
        // next page load seeds from it. The write is idempotent (same clamped
        // value), so the adoption guard breaks any echo loop. Only the
        // persistence write is trailing-debounced (scheduleSidebarWidthWrite),
        // so a drag does not run the full updateViewPrefs path per tick.
        scheduleSidebarWidthWrite(d.sidebar)
      },
      setDetails: (d, px: number) => { d.details = clampWidth(px, DETAILS_MIN, DETAILS_MAX) },
      // Narrow toggles flip only the override: the width preference survives
      // untouched, so re-widening restores the pre-squeeze layout.
      toggleSidebar: (d) => {
        if (d.narrow) d.narrowExpanded = !d.narrowExpanded
        // chamber fork: reopening expands to the SHARED persisted width (the
        // vendor contract default would fight a user's remembered width);
        // closing writes 0 without persisting it — the width preference only
        // ever records an OPEN drag.
        else d.sidebar = d.sidebar === 0 ? prefsSidebarWidth() : 0
      },
      // Crossing the breakpoint in either direction drops the override: the
      // narrow default is auto-collapsed, the wide state is the preference.
      setNarrow: (d, narrow: boolean) => {
        if (d.narrow === narrow) return
        d.narrow = narrow
        d.narrowExpanded = false
      },
      openDetails: (d) => { if (d.details === 0) d.details = DETAILS_DEFAULT },
      closeDetails: (d) => { d.details = 0 },
    },
  })
  // chamber fork: adopt external width changes into every live instance. The
  // subscription is deferred to a microtask so it runs AFTER the initiating
  // action's own store commit — reading a fresh snapshot makes the
  // "unchanged" guard reliable (a synchronous listener would observe the
  // pre-commit state of the shell whose drag just wrote the prefs and
  // re-adopt its own value through a nested engine write). Guarded:
  // - `sidebar === 0` (closed) is never re-opened by another shell's drag;
  // - unchanged values skip (the initiating shell's own echo, and repeat
  //   drags over the same width, terminate here — no write loops);
  // - the adoption write itself never calls updateViewPrefs, so it cannot
  //   re-trigger this subscription.
  // The framework has no store-instance dispose hook. A single module-level
  // listener therefore fans out through WeakRefs: released shells are not
  // retained, and dead refs are pruned on the next preference update.
  const baseCreate = handle.create
  handle.create = (scopeKey?: string) => {
    const instance = baseCreate(scopeKey)
    trackLayoutInstance(instance)
    return instance
  }
  return handle
}
