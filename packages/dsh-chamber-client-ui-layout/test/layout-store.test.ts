/**
 * layout store-core unit tests (plain node:test, no dsh, no DOM): the chamber
 * layout store's sidebar-width sharing behavior — seeding from the shared
 * view-prefs store, the 150ms trailing-debounced drag persistence (real
 * vendor column geometry via the vendor source; real 150ms delay via node:test
 * mock timers), live cross-shell adoption with its guards (closed shells are
 * never re-opened, the initiating shell's echo terminates), reopen-restore
 * semantics, the P3-nit no-op guard, and the alpha.2 root-panel actions
 * (`selectPanel`/`retainMainPanels`) plus the right-panel geometry actions.
 * `createLayoutStore` is exercised with an injected environment (fake store
 * engine + fake view-prefs store) — the production wiring (stores.ts) is a
 * thin default-environment shim over the same factory, and the explicit
 * `trackLayoutInstance` registration replaces the pre-alpha.2 `handle.create`
 * patch (the vendor baseline now overrides `create` on the shared handle).
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  collapsedOf,
  createLayoutStore,
  trackLayoutInstance,
  SIDEBAR_WRITE_DEBOUNCE_MS,
  type LayoutStoreEnvironment,
} from '../src/client/store-core.ts'
import {
  clampWidth,
  RIGHTBAR_DEFAULT_RATIO,
  RIGHTBAR_MAX_RATIO,
  RIGHTBAR_MIN,
  SIDEBAR_AUTO_COLLAPSE,
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
} from '../../../vendor/harness-packages/@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

// ---- fakes (the injected environment) ----

/**
 * Minimal engine with the real engine's semantics for this store's usage:
 * per-create fresh init(), draft-mutator update(), subscribe/getSnapshot,
 * and actions bound per instance. LayoutState is two nested plain objects, so
 * the draft clones both levels (immer's structural sharing equivalent here).
 */
function fakeEngine<T>(decl: { init: () => T; actions: Record<string, (draft: T, ...params: unknown[]) => void> }) {
  return {
    spec: decl,
    create: () => {
      let state = decl.init()
      const clone = (value: T): T => ({
        ...value,
        ...(typeof value === 'object' && value !== null && 'layoutInfo' in value
          ? { layoutInfo: { ...(value as { layoutInfo: object }).layoutInfo } }
          : {}),
      }) as T
      const listeners = new Set<() => void>()
      const notify = () => { for (const listener of [...listeners]) listener() }
      const store = {
        getSnapshot: () => state,
        subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
        update: (mutator: (draft: T) => void) => {
          const draft = clone(state)
          mutator(draft)
          state = draft
          notify()
        },
        set: (next: T) => { state = next; notify() },
      }
      const actions: Record<string, (...params: unknown[]) => void> = {}
      for (const key of Object.keys(decl.actions)) {
        const mutate = decl.actions[key]
        actions[key] = (...params: unknown[]) => { store.update((draft) => { mutate(draft, ...params) }) }
      }
      return {
        actions,
        getSnapshot: store.getSnapshot,
        subscribe: store.subscribe,
        store,
        clearPersisted: () => {},
      }
    },
  }
}

/**
 * Fake view-prefs store with the real notify semantics: updateViewPrefs
 * replaces the prefs, then notifies every subscriber synchronously (the
 * store-core adoption listener defers its own read to a microtask, exactly
 * like production). Writes are recorded for assertions.
 */
function makeViewPrefs(initial?: { sidebarWidth?: number }) {
  const listeners = new Set<() => void>()
  let prefs = {
    v: 1 as const,
    folded: {},
    ungroupedOrder: {},
    orderBy: {},
    updatedOrder: {},
    sessionUpdatedAtByAccount: {},
    seenSources: [] as string[],
    ...(initial?.sidebarWidth !== undefined ? { sidebarWidth: initial.sidebarWidth } : {}),
  }
  const written: Array<number | undefined> = []
  return {
    getViewPrefs: () => prefs,
    subscribeViewPrefs: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    updateViewPrefs: (mutator: (prev: unknown) => unknown) => {
      prefs = mutator(prefs) as typeof prefs
      for (const listener of [...listeners]) listener()
      written.push(prefs.sidebarWidth)
    },
    writeCount: () => written.length,
    writes: () => written,
  }
}

/** One injectable environment per test (fresh runtime state, no leakage). */
function makeEnv(initial?: { sidebarWidth?: number }) {
  const viewPrefs = makeViewPrefs(initial)
  // The fake engine is intentionally a minimal structural stand-in for the
  // real store engine (per-create fresh init, draft-mutator update,
  // subscribe/getSnapshot). The cast marks that boundary: it is not a full
  // EngineStoreHandle implementation, only the surface this store's factory
  // exercises.
  const env = {
    defineStore: fakeEngine,
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
    viewPrefs,
    initialViewportWidth: () => 1600,
  } as LayoutStoreEnvironment
  return { env, viewPrefs }
}

// ---- seeding ----

test('createLayoutStore seeds sidebar from the shared view-prefs width', () => {
  const { env } = makeEnv({ sidebarWidth: 360 })
  const instance = createLayoutStore(env).create()
  assert.equal(instance.getSnapshot().layoutInfo.sidebar, 360)
  assert.equal(instance.getSnapshot().layoutInfo.rightbar, null)
  assert.equal(instance.getSnapshot().layoutInfo.narrowExpanded, false)
  assert.equal(instance.getSnapshot().panelInfo.activePanelId, null)
})

test('createLayoutStore seeds SIDEBAR_DEFAULT when no width was ever persisted', () => {
  const { env } = makeEnv()
  assert.equal(createLayoutStore(env).create().getSnapshot().layoutInfo.sidebar, SIDEBAR_DEFAULT)
})

// ---- drag persistence (150ms trailing debounce) ----

test('a drag updates the store immediately and persists exactly once after the 150ms debounce', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { env, viewPrefs } = makeEnv()
    const instance = createLayoutStore(env).create()
    instance.actions.setSidebar(300)
    assert.equal(instance.getSnapshot().layoutInfo.sidebar, 300) // the STORE value is immediate
    assert.equal(viewPrefs.writeCount(), 0)           // nothing persisted yet
    mock.timers.tick(SIDEBAR_WRITE_DEBOUNCE_MS - 1)
    assert.equal(viewPrefs.writeCount(), 0)
    mock.timers.tick(1)
    assert.equal(viewPrefs.writeCount(), 1)
    assert.deepEqual(viewPrefs.writes(), [300])
  } finally {
    mock.timers.reset()
  }
})

test('rapid drags coalesce into exactly one debounced write — the last width wins', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { env, viewPrefs } = makeEnv()
    const instance = createLayoutStore(env).create()
    instance.actions.setSidebar(300)
    instance.actions.setSidebar(320)
    instance.actions.setSidebar(340)
    assert.equal(viewPrefs.writeCount(), 0)
    mock.timers.tick(SIDEBAR_WRITE_DEBOUNCE_MS)
    assert.equal(viewPrefs.writeCount(), 1)
    assert.deepEqual(viewPrefs.writes(), [340])
  } finally {
    mock.timers.reset()
  }
})

test('setSidebar clamps into the vendor range before persisting', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { env, viewPrefs } = makeEnv()
    const instance = createLayoutStore(env).create()
    instance.actions.setSidebar(500)
    assert.equal(instance.getSnapshot().layoutInfo.sidebar, SIDEBAR_MAX)
    mock.timers.tick(SIDEBAR_WRITE_DEBOUNCE_MS)
    assert.deepEqual(viewPrefs.writes(), [SIDEBAR_MAX])
    instance.actions.setSidebar(1)
    mock.timers.tick(SIDEBAR_WRITE_DEBOUNCE_MS)
    assert.deepEqual(viewPrefs.writes(), [SIDEBAR_MAX, SIDEBAR_MIN])
  } finally {
    mock.timers.reset()
  }
})

// ---- cross-shell adoption ----

test('a drag in one shell is adopted live by the other shells (cross-boot sync)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { env } = makeEnv({ sidebarWidth: 300 })
    const handle = createLayoutStore(env)
    const a = handle.create()
    const b = handle.create()
    trackLayoutInstance(env, a)
    trackLayoutInstance(env, b)
    assert.equal(a.getSnapshot().layoutInfo.sidebar, 300)
    assert.equal(b.getSnapshot().layoutInfo.sidebar, 300)
    b.actions.setSidebar(360)
    assert.equal(a.getSnapshot().layoutInfo.sidebar, 300) // not yet — the write is still debounced
    mock.timers.tick(SIDEBAR_WRITE_DEBOUNCE_MS)
    await Promise.resolve()                    // the adoption listener defers to a microtask
    assert.equal(a.getSnapshot().layoutInfo.sidebar, 360)
    assert.equal(b.getSnapshot().layoutInfo.sidebar, 360)
  } finally {
    mock.timers.reset()
  }
})

test('the initiating shell does not re-adopt its own echo — and the echo write is a no-op', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { env, viewPrefs } = makeEnv({ sidebarWidth: 300 })
    const handle = createLayoutStore(env)
    const a = handle.create()
    const b = handle.create()
    trackLayoutInstance(env, a)
    trackLayoutInstance(env, b)
    b.actions.setSidebar(360)
    mock.timers.tick(SIDEBAR_WRITE_DEBOUNCE_MS)
    await Promise.resolve()
    assert.equal(b.getSnapshot().layoutInfo.sidebar, 360) // b kept its own value
    assert.equal(a.getSnapshot().layoutInfo.sidebar, 360) // a adopted it
    // b drags back onto the now-persisted width: the no-op guard skips the
    // persist/notify cycle instead of re-running updateViewPrefs.
    b.actions.setSidebar(360)
    mock.timers.tick(SIDEBAR_WRITE_DEBOUNCE_MS)
    assert.equal(viewPrefs.writeCount(), 1)
  } finally {
    mock.timers.reset()
  }
})

test('a closed shell is never re-opened by another shell\'s drag', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { env } = makeEnv({ sidebarWidth: 300 })
    const handle = createLayoutStore(env)
    const a = handle.create()
    const b = handle.create()
    trackLayoutInstance(env, a)
    trackLayoutInstance(env, b)
    a.actions.toggleSidebar() // close a
    assert.equal(a.getSnapshot().layoutInfo.sidebar, 0)
    b.actions.setSidebar(400)
    mock.timers.tick(SIDEBAR_WRITE_DEBOUNCE_MS)
    await Promise.resolve()
    assert.equal(a.getSnapshot().layoutInfo.sidebar, 0) // stays closed
    assert.equal(b.getSnapshot().layoutInfo.sidebar, 400)
  } finally {
    mock.timers.reset()
  }
})

test('an untracked instance is never adopted into (registration is explicit)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { env } = makeEnv({ sidebarWidth: 300 })
    const handle = createLayoutStore(env)
    const tracked = handle.create()
    const untracked = handle.create()
    trackLayoutInstance(env, tracked)
    untracked.actions.setSidebar(360)
    mock.timers.tick(SIDEBAR_WRITE_DEBOUNCE_MS)
    await Promise.resolve()
    assert.equal(tracked.getSnapshot().layoutInfo.sidebar, 360, 'tracked instance adopted the write')
    assert.equal(untracked.getSnapshot().layoutInfo.sidebar, 360, 'writer keeps its own value')
    // The writer was never registered: a later external write still reaches
    // only the tracked instance.
    env.viewPrefs.updateViewPrefs(prev => ({ ...prev, sidebarWidth: 320 }))
    await Promise.resolve()
    assert.equal(tracked.getSnapshot().layoutInfo.sidebar, 320)
    assert.equal(untracked.getSnapshot().layoutInfo.sidebar, 360)
  } finally {
    mock.timers.reset()
  }
})

// ---- reopen semantics ----

test('toggleSidebar closes to 0 and reopens to the SHARED width, not the contract default', () => {
  const { env } = makeEnv({ sidebarWidth: 340 })
  const instance = createLayoutStore(env).create()
  assert.equal(instance.getSnapshot().layoutInfo.sidebar, 340)
  instance.actions.toggleSidebar()
  assert.equal(instance.getSnapshot().layoutInfo.sidebar, 0)
  instance.actions.toggleSidebar()
  assert.equal(instance.getSnapshot().layoutInfo.sidebar, 340) // the remembered shared width
})

test('toggleSidebar reopens to SIDEBAR_DEFAULT when nothing was ever persisted', () => {
  const { env } = makeEnv()
  const instance = createLayoutStore(env).create()
  instance.actions.toggleSidebar()
  assert.equal(instance.getSnapshot().layoutInfo.sidebar, 0)
  instance.actions.toggleSidebar()
  assert.equal(instance.getSnapshot().layoutInfo.sidebar, SIDEBAR_DEFAULT)
})

test('below the breakpoint the toggle flips narrowExpanded and never touches the width', () => {
  const { env } = makeEnv({ sidebarWidth: 340 })
  const instance = createLayoutStore(env).create()
  instance.actions.setViewportWidth(SIDEBAR_AUTO_COLLAPSE - 1)
  instance.actions.toggleSidebar()
  assert.equal(instance.getSnapshot().layoutInfo.narrowExpanded, true)
  assert.equal(instance.getSnapshot().layoutInfo.sidebar, 340)
  instance.actions.toggleSidebar()
  assert.equal(instance.getSnapshot().layoutInfo.narrowExpanded, false)
  assert.equal(instance.getSnapshot().layoutInfo.sidebar, 340)
  instance.actions.setViewportWidth(SIDEBAR_AUTO_COLLAPSE)
  instance.actions.toggleSidebar()
  assert.equal(instance.getSnapshot().layoutInfo.sidebar, 0) // wide toggle now closes
})

test('setViewportWidth drops the narrow override only when the breakpoint is crossed', () => {
  const { env } = makeEnv()
  const instance = createLayoutStore(env).create()
  instance.actions.setViewportWidth(SIDEBAR_AUTO_COLLAPSE - 1)
  instance.actions.toggleSidebar()
  assert.equal(instance.getSnapshot().layoutInfo.narrowExpanded, true)
  // Same side of the breakpoint: the override survives.
  instance.actions.setViewportWidth(SIDEBAR_AUTO_COLLAPSE - 10)
  assert.equal(instance.getSnapshot().layoutInfo.narrowExpanded, true)
  // Crossing the breakpoint clears it.
  instance.actions.setViewportWidth(SIDEBAR_AUTO_COLLAPSE + 10)
  assert.equal(instance.getSnapshot().layoutInfo.narrowExpanded, false)
})

// ---- root main-panel selection (alpha.2) ----

test('selectPanel writes the active panel id and retainMainPanels clears an unregistered one', () => {
  const { env } = makeEnv()
  const instance = createLayoutStore(env).create()
  instance.actions.selectPanel('workflow' as never)
  assert.equal(instance.getSnapshot().panelInfo.activePanelId, 'workflow')
  instance.actions.retainMainPanels(['conversation'])
  assert.equal(instance.getSnapshot().panelInfo.activePanelId, null, 'unregistered panel cleared')
  instance.actions.selectPanel('conversation' as never)
  instance.actions.retainMainPanels(['conversation', 'workflow'])
  assert.equal(instance.getSnapshot().panelInfo.activePanelId, 'conversation', 'registered panel retained')
  instance.actions.selectPanel(null)
  assert.equal(instance.getSnapshot().panelInfo.activePanelId, null)
  // retainMainPanels never resurrects a selection.
  instance.actions.retainMainPanels(['conversation'])
  assert.equal(instance.getSnapshot().panelInfo.activePanelId, null)
})

// ---- right-panel geometry (alpha.2) ----

test('rightbar actions clamp into the vendor range; open/close report presentation', () => {
  const { env } = makeEnv()
  const instance = createLayoutStore(env).create()
  instance.actions.setViewportWidth(1600)
  instance.actions.openRightbar(true, false)
  assert.equal(instance.getSnapshot().layoutInfo.rightbar, Math.round(1600 * RIGHTBAR_DEFAULT_RATIO))
  assert.equal(instance.getSnapshot().layoutInfo.rightbarShown, true)
  assert.equal(instance.getSnapshot().layoutInfo.rightbarTrack, true)
  instance.actions.setRightbar(9999)
  assert.equal(instance.getSnapshot().layoutInfo.rightbar, Math.round(1600 * RIGHTBAR_MAX_RATIO))
  instance.actions.setRightbar(1)
  assert.equal(instance.getSnapshot().layoutInfo.rightbar, RIGHTBAR_MIN)
  instance.actions.closeRightbar()
  assert.equal(instance.getSnapshot().layoutInfo.rightbarShown, false)
  assert.equal(instance.getSnapshot().layoutInfo.rightbarTrack, false)
  // The px preference survives the close (upstream contract).
  assert.equal(instance.getSnapshot().layoutInfo.rightbar, RIGHTBAR_MIN)
})

test('openRightbar on a narrow frame clears the narrow re-expand override', () => {
  const { env } = makeEnv()
  const instance = createLayoutStore(env).create()
  instance.actions.setViewportWidth(SIDEBAR_AUTO_COLLAPSE - 1)
  instance.actions.toggleSidebar()
  assert.equal(instance.getSnapshot().layoutInfo.narrowExpanded, true)
  instance.actions.openRightbar(false, true)
  assert.equal(instance.getSnapshot().layoutInfo.narrowExpanded, false)
  assert.equal(instance.getSnapshot().layoutInfo.rightbarFullscreen, true)
})

// ---- P3 nit: no-op guard on the persistence write ----

test('a drag onto the already-persisted width skips persist/notify entirely', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { env, viewPrefs } = makeEnv({ sidebarWidth: 300 })
    const instance = createLayoutStore(env).create()
    instance.actions.setSidebar(300) // same as the persisted width
    mock.timers.tick(SIDEBAR_WRITE_DEBOUNCE_MS)
    assert.equal(viewPrefs.writeCount(), 0)
    assert.equal(viewPrefs.getViewPrefs().sidebarWidth, 300)
  } finally {
    mock.timers.reset()
  }
})

test('the no-op guard cancels a stale pending write when the drag returns to the persisted width', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { env, viewPrefs } = makeEnv({ sidebarWidth: 300 })
    const instance = createLayoutStore(env).create()
    instance.actions.setSidebar(350) // pending write scheduled
    instance.actions.setSidebar(300) // back to the persisted width → guard cancels the stale write
    mock.timers.tick(SIDEBAR_WRITE_DEBOUNCE_MS)
    assert.equal(viewPrefs.writeCount(), 0)
    assert.equal(viewPrefs.getViewPrefs().sidebarWidth, 300)
  } finally {
    mock.timers.reset()
  }
})

// ---- AppFrame collapsed derivation (shared by layoutFacts + the mobile plugin) ----

test('collapsedOf mirrors AppFrame: wide uses the preference, narrow the override', () => {
  const state = (layoutInfo: {
    sidebar: number
    viewportWidth: number
    narrowExpanded: boolean
  }) => ({
    panelInfo: { activePanelId: null },
    layoutInfo: {
      ...layoutInfo,
      rightbar: null,
      rightbarShown: false,
      rightbarTrack: false,
      rightbarFullscreen: false,
      rightbarInstant: false,
    },
  })
  // Wide: the sidebar preference decides; narrowExpanded is meaningless.
  assert.equal(collapsedOf(state({ sidebar: 0, viewportWidth: 1600, narrowExpanded: false }), SIDEBAR_AUTO_COLLAPSE), true)
  assert.equal(collapsedOf(state({ sidebar: 280, viewportWidth: 1600, narrowExpanded: false }), SIDEBAR_AUTO_COLLAPSE), false)
  assert.equal(collapsedOf(state({ sidebar: 0, viewportWidth: 1600, narrowExpanded: true }), SIDEBAR_AUTO_COLLAPSE), true)
  // Narrow: auto-collapsed unless the manual override re-expands.
  assert.equal(collapsedOf(state({ sidebar: 280, viewportWidth: SIDEBAR_AUTO_COLLAPSE - 1, narrowExpanded: false }), SIDEBAR_AUTO_COLLAPSE), true)
  assert.equal(collapsedOf(state({ sidebar: 0, viewportWidth: SIDEBAR_AUTO_COLLAPSE - 1, narrowExpanded: true }), SIDEBAR_AUTO_COLLAPSE), false)
  // Breakpoint boundary: exactly SIDEBAR_AUTO_COLLAPSE is WIDE.
  assert.equal(collapsedOf(state({ sidebar: 280, viewportWidth: SIDEBAR_AUTO_COLLAPSE, narrowExpanded: true }), SIDEBAR_AUTO_COLLAPSE), false)
})

test('one throwing instance does not starve the adoption fan-out', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { env } = makeEnv({ sidebarWidth: 300 })
    const handle = createLayoutStore(env)
    const broken = handle.create()
    const healthy = handle.create()
    trackLayoutInstance(env, broken)
    trackLayoutInstance(env, healthy)
    // Make the FIRST tracked instance throw on the adoption write.
    broken.store.update = () => { throw new Error('store update exploded') }
    healthy.actions.setSidebar(360)
    mock.timers.tick(SIDEBAR_WRITE_DEBOUNCE_MS)
    await Promise.resolve()
    assert.equal(healthy.getSnapshot().layoutInfo.sidebar, 360, 'writer keeps its own value')
  } finally {
    mock.timers.reset()
  }
})
