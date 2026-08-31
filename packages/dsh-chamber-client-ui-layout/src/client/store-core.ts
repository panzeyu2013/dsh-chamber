/**
 * The chamber layout store's core factory (design 06 — sidebar width sharing)
 * as a PURE module: every runtime dependency (the store engine, the vendor
 * column geometry, the sidebar view-prefs store) arrives through an injected
 * `LayoutStoreEnvironment`, so the whole decision surface is testable under
 * plain node (`test/layout-store.ts`) without the vendor packages (their
 * source-only tree ships no built `lib/` for node to import). The production
 * wiring lives in `stores.ts` — it builds the default environment from the
 * real modules and re-exports `createLayoutStore`, keeping the registration
 * face (`client/index.ts` → `store: createLayoutStore`) unchanged.
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
import type { ChamberSidebarViewPrefs } from '@dsh-chamber/dsh-client-ui-sidebar/shared'

/**
 * Layout store state: panel width preferences in px (0 = closed), plus the
 * narrow-viewport pair — `narrow` mirrors AppFrame's breakpoint reading
 * (viewport < SIDEBAR_AUTO_COLLAPSE) so toggleSidebar can pick semantics, and
 * `narrowExpanded` is the manual override that re-expands the auto-collapsed
 * sidebar over the squeezed center without rewriting the width preference.
 */
export type LayoutState = { sidebar: number; details: number; narrow: boolean; narrowExpanded: boolean }

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
export type LayoutActions = {
  setSidebar: (draft: LayoutState, px: number) => void
  setDetails: (draft: LayoutState, px: number) => void
  toggleSidebar: (draft: LayoutState) => void
  setNarrow: (draft: LayoutState, narrow: boolean) => void
  openDetails: (draft: LayoutState) => void
  closeDetails: (draft: LayoutState) => void
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
  DETAILS_DEFAULT: number
  DETAILS_MIN: number
  DETAILS_MAX: number
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
 * @param env - injected environment (production uses the stores.ts default).
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(env: LayoutStoreEnvironment): EngineStoreHandle<LayoutState, LayoutActions> {
  const { defineStore, columns, viewPrefs } = env
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

  /** One listener fans out through weak references to the env's live stores. */
  const trackLayoutInstance = (instance: LayoutInstance): void => {
    runtime.instances.add(new WeakRef(instance))
    if (runtime.subscriptionInstalled) return
    runtime.subscriptionInstalled = true
    viewPrefs.subscribeViewPrefs(() => {
      queueMicrotask(() => {
        const width = viewPrefs.getViewPrefs().sidebarWidth
        if (width === undefined) return
        for (const ref of runtime.instances) {
          const currentInstance = ref.deref()
          if (currentInstance === undefined) {
            runtime.instances.delete(ref)
            continue
          }
          const current = currentInstance.getSnapshot().sidebar
          if (current === 0 || current === width) continue
          currentInstance.store.update((d) => { d.sidebar = width })
        }
      })
    })
  }

  const handle = defineStore({
    init: (): LayoutState => ({ sidebar: prefsSidebarWidth(), details: 0, narrow: false, narrowExpanded: false }),
    actions: {
      setSidebar: (d, px: number) => {
        // The STORE value is immediate: the frame renders this tick's width.
        d.sidebar = columns.clampWidth(px, columns.SIDEBAR_MIN, columns.SIDEBAR_MAX)
        // chamber fork: persist the CLAMPED drag width (drag only runs while
        // the sidebar is open, so this never writes 0/closed) — every other
        // live boot's store adopts it via the subscription below, and the
        // next page load seeds from it. The write is idempotent (same clamped
        // value), so the adoption guard breaks any echo loop. Only the
        // persistence write is trailing-debounced (scheduleSidebarWidthWrite),
        // so a drag does not run the full updateViewPrefs path per tick.
        scheduleSidebarWidthWrite(d.sidebar)
      },
      setDetails: (d, px: number) => {
        d.details = columns.clampWidth(px, columns.DETAILS_MIN, columns.DETAILS_MAX)
      },
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
      openDetails: (d) => { if (d.details === 0) d.details = columns.DETAILS_DEFAULT },
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
  // The framework has no store-instance dispose hook. A single per-env
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
