/**
 * layout store-core unit tests (plain node:test, no dsh, no DOM): the chamber
 * layout store's sidebar-width sharing behavior — seeding from the shared
 * view-prefs store, the 150ms trailing-debounced drag persistence (real
 * vendor column geometry via the vendor source; real 150ms delay via node:test
 * mock timers), live cross-shell adoption with its guards (closed shells are
 * never re-opened, the initiating shell's echo terminates), reopen-restore
 * semantics, and the P3-nit no-op guard. `createLayoutStore` is exercised with
 * an injected environment (fake store engine + fake view-prefs store) — the
 * production wiring (stores.ts) is a thin default-environment shim over the
 * same factory.
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  createLayoutStore,
  SIDEBAR_WRITE_DEBOUNCE_MS,
} from '../src/client/store-core.ts'
import {
  clampWidth,
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  DETAILS_DEFAULT,
  DETAILS_MIN,
  DETAILS_MAX,
} from '../../../vendor/harness-packages/@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

// ---- fakes (the injected environment) ----

/**
 * Minimal engine with the real engine's semantics for this store's usage:
 * per-create fresh init(), draft-mutator update(), subscribe/getSnapshot,
 * and actions bound per instance. LayoutState is flat primitives, so a
 * shallow clone + apply is faithful to immer here.
 */
function fakeEngine<T>(decl: { init: () => T; actions: Record<string, (draft: T, ...params: unknown[]) => void> }) {
  return {
    spec: decl,
    create: () => {
      let state = decl.init()
      const listeners = new Set<() => void>()
      const notify = () => { for (const listener of [...listeners]) listener() }
      const store = {
        getSnapshot: () => state,
        subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
        update: (mutator: (draft: T) => void) => {
          const draft = { ...state }
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
  const env = {
    defineStore: fakeEngine,
    columns: { clampWidth, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX, DETAILS_DEFAULT, DETAILS_MIN, DETAILS_MAX },
    viewPrefs,
  }
  return { env, viewPrefs }
}

// ---- seeding ----

test('createLayoutStore seeds sidebar from the shared view-prefs width', () => {
  const { env } = makeEnv({ sidebarWidth: 360 })
  const instance = createLayoutStore(env).create()
  assert.equal(instance.getSnapshot().sidebar, 360)
  assert.equal(instance.getSnapshot().details, 0)
  assert.equal(instance.getSnapshot().narrow, false)
  assert.equal(instance.getSnapshot().narrowExpanded, false)
})

test('createLayoutStore seeds SIDEBAR_DEFAULT when no width was ever persisted', () => {
  const { env } = makeEnv()
  assert.equal(createLayoutStore(env).create().getSnapshot().sidebar, SIDEBAR_DEFAULT)
})

// ---- drag persistence (150ms trailing debounce) ----

test('a drag updates the store immediately and persists exactly once after the 150ms debounce', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { env, viewPrefs } = makeEnv()
    const instance = createLayoutStore(env).create()
    instance.actions.setSidebar(300)
    assert.equal(instance.getSnapshot().sidebar, 300) // the STORE value is immediate
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
    assert.equal(instance.getSnapshot().sidebar, SIDEBAR_MAX)
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
    const a = createLayoutStore(env).create()
    const b = createLayoutStore(env).create()
    assert.equal(a.getSnapshot().sidebar, 300)
    assert.equal(b.getSnapshot().sidebar, 300)
    b.actions.setSidebar(360)
    assert.equal(a.getSnapshot().sidebar, 300) // not yet — the write is still debounced
    mock.timers.tick(SIDEBAR_WRITE_DEBOUNCE_MS)
    await Promise.resolve()                    // the adoption listener defers to a microtask
    assert.equal(a.getSnapshot().sidebar, 360)
    assert.equal(b.getSnapshot().sidebar, 360)
  } finally {
    mock.timers.reset()
  }
})

test('the initiating shell does not re-adopt its own echo — and the echo write is a no-op', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { env, viewPrefs } = makeEnv({ sidebarWidth: 300 })
    const a = createLayoutStore(env).create()
    const b = createLayoutStore(env).create()
    b.actions.setSidebar(360)
    mock.timers.tick(SIDEBAR_WRITE_DEBOUNCE_MS)
    await Promise.resolve()
    assert.equal(b.getSnapshot().sidebar, 360) // b kept its own value
    assert.equal(a.getSnapshot().sidebar, 360) // a adopted it
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
    const a = createLayoutStore(env).create()
    const b = createLayoutStore(env).create()
    a.actions.toggleSidebar() // close a
    assert.equal(a.getSnapshot().sidebar, 0)
    b.actions.setSidebar(400)
    mock.timers.tick(SIDEBAR_WRITE_DEBOUNCE_MS)
    await Promise.resolve()
    assert.equal(a.getSnapshot().sidebar, 0) // stays closed
    assert.equal(b.getSnapshot().sidebar, 400)
  } finally {
    mock.timers.reset()
  }
})

// ---- reopen semantics ----

test('toggleSidebar closes to 0 and reopens to the SHARED width, not the contract default', () => {
  const { env } = makeEnv({ sidebarWidth: 340 })
  const instance = createLayoutStore(env).create()
  assert.equal(instance.getSnapshot().sidebar, 340)
  instance.actions.toggleSidebar()
  assert.equal(instance.getSnapshot().sidebar, 0)
  instance.actions.toggleSidebar()
  assert.equal(instance.getSnapshot().sidebar, 340) // the remembered shared width
})

test('toggleSidebar reopens to SIDEBAR_DEFAULT when nothing was ever persisted', () => {
  const { env } = makeEnv()
  const instance = createLayoutStore(env).create()
  instance.actions.toggleSidebar()
  assert.equal(instance.getSnapshot().sidebar, 0)
  instance.actions.toggleSidebar()
  assert.equal(instance.getSnapshot().sidebar, SIDEBAR_DEFAULT)
})

test('below the breakpoint the toggle flips narrowExpanded and never touches the width', () => {
  const { env } = makeEnv({ sidebarWidth: 340 })
  const instance = createLayoutStore(env).create()
  instance.actions.setNarrow(true)
  instance.actions.toggleSidebar()
  assert.equal(instance.getSnapshot().narrowExpanded, true)
  assert.equal(instance.getSnapshot().sidebar, 340)
  instance.actions.toggleSidebar()
  assert.equal(instance.getSnapshot().narrowExpanded, false)
  assert.equal(instance.getSnapshot().sidebar, 340)
  instance.actions.setNarrow(false)
  instance.actions.toggleSidebar()
  assert.equal(instance.getSnapshot().sidebar, 0) // wide toggle now closes
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

// ---- details actions (unchanged vendor semantics, sanity) ----

test('details actions clamp into the vendor range; open/close write default/0', () => {
  const { env } = makeEnv()
  const instance = createLayoutStore(env).create()
  instance.actions.openDetails()
  assert.equal(instance.getSnapshot().details, DETAILS_DEFAULT)
  instance.actions.setDetails(900)
  assert.equal(instance.getSnapshot().details, DETAILS_MAX)
  instance.actions.setDetails(1)
  assert.equal(instance.getSnapshot().details, DETAILS_MIN)
  instance.actions.closeDetails()
  assert.equal(instance.getSnapshot().details, 0)
})
