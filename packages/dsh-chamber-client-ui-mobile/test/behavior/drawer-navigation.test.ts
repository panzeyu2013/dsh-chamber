/**
 * Drawer navigation close: the pure panel-row predicate and the installer
 * wiring (deferred close after the row's React onClick, presented-session
 * change, active/open gates, dispose). The official services are faked; the
 * device acceptance gate stays the end-to-end check.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  installDrawerNavigationClose,
  isPanelRowClick,
  PANEL_ROW_SLOT,
} from '../../src/client/drawer-navigation.ts'

const SIDEBAR_SELECTOR = '[data-mobile-role="sidebar"]'

class ElementDouble {
  readonly closestMap: Record<string, ElementDouble | null>
  readonly slot: ElementDouble | null
  constructor(options: {
    button?: ElementDouble | null
    sidebar?: ElementDouble | null
    slot?: ElementDouble | null
  } = {}) {
    this.closestMap = {
      button: options.button ?? null,
      [SIDEBAR_SELECTOR]: options.sidebar ?? null,
    }
    this.slot = options.slot ?? null
  }
  closest(selector: string): ElementDouble | null { return this.closestMap[selector] ?? null }
  querySelector(selector: string): ElementDouble | null {
    return selector === PANEL_ROW_SLOT ? this.slot : null
  }
}

class DocumentDouble {
  private readonly listeners = new Map<string, Array<(event: never) => void>>()
  addEventListener(type: string, handler: (event: never) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }
  removeEventListener(type: string, handler: (event: never) => void): void {
    const list = this.listeners.get(type) ?? []
    const index = list.indexOf(handler)
    if (index !== -1) list.splice(index, 1)
  }
  dispatch(type: string, event: unknown): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event as never)
  }
  listenerCount(type: string): number { return (this.listeners.get(type) ?? []).length }
}

interface SessionsStore {
  readonly list: {
    getSnapshot(): { byId: Record<string, { retainedBy?: Record<string, number> }> }
    subscribe(listener: () => void): () => void
  }
  set(next: Record<string, { retainedBy?: Record<string, number> }>): void
}

function sessionsStore(initial: Record<string, { retainedBy?: Record<string, number> }>): SessionsStore {
  let snapshot = { byId: initial }
  const listeners = new Set<() => void>()
  return {
    list: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    set: (next) => {
      snapshot = { byId: next }
      for (const listener of listeners) listener()
    },
  }
}

function withDom(run: (document: DocumentDouble) => Promise<void>): Promise<void> {
  const document = new DocumentDouble()
  const globals = globalThis as unknown as Record<string, unknown>
  const previousElement = globals.Element
  const previousDocument = globals.document
  globals.Element = ElementDouble
  globals.document = document
  return (async () => {
    try {
      await run(document)
    } finally {
      if (previousElement === undefined) delete globals.Element
      else globals.Element = previousElement
      if (previousDocument === undefined) delete globals.document
      else globals.document = previousDocument
    }
  })()
}

const tick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

test('isPanelRowClick: only a panel row inside the sidebar qualifies', async () => {
  await withDom(async () => {
    const sidebar = new ElementDouble()
    const slot = new ElementDouble()
    const row = new ElementDouble({ sidebar, slot })
    const target = new ElementDouble({ button: row })
    assert.equal(isPanelRowClick(target), true)
    // A non-panel sidebar control (new session / settings / search) has no
    // panellist outlet.
    const normal = new ElementDouble({ sidebar })
    assert.equal(isPanelRowClick(new ElementDouble({ button: normal })), false)
    // A panel-looking button outside the mobile sidebar never closes it.
    const outsideRow = new ElementDouble({ sidebar: null, slot })
    assert.equal(isPanelRowClick(new ElementDouble({ button: outsideRow })), false)
    assert.equal(isPanelRowClick(null), false)
    assert.equal(isPanelRowClick({}), false)
  })
})

test('installDrawerNavigationClose: a panel-row click closes AFTER the row activation', async () => {
  await withDom(async document => {
    let open = true
    let closes = 0
    const sidebar = new ElementDouble()
    const slot = new ElementDouble()
    const row = new ElementDouble({ sidebar, slot })
    const target = new ElementDouble({ button: row })
    const dispose = installDrawerNavigationClose({
      active: () => true,
      isOpen: () => open,
      close: () => { closes += 1 },
      sessions: sessionsStore({ a: { retainedBy: { mainView: 1 } } }),
    })
    try {
      document.dispatch('click', { target })
      assert.equal(closes, 0, 'the close is deferred to the microtask after the React click')
      await tick()
      assert.equal(closes, 1)
      // A closed drawer has nothing to close.
      open = false
      document.dispatch('click', { target })
      await tick()
      assert.equal(closes, 1)
    } finally {
      dispose()
    }
  })
})

test('installDrawerNavigationClose: presented-session changes close; status churn does not', async () => {
  await withDom(async () => {
    let closes = 0
    let open = true
    const store = sessionsStore({ a: { retainedBy: { mainView: 1 } } })
    const dispose = installDrawerNavigationClose({
      active: () => true,
      isOpen: () => open,
      close: () => { closes += 1 },
      sessions: store,
    })
    try {
      // Same presented id, new row object/status: not a navigation.
      store.set({ a: { retainedBy: { mainView: 1 } } })
      assert.equal(closes, 0)
      // A session switch.
      store.set({ b: { retainedBy: { mainView: 1 } } })
      assert.equal(closes, 1)
      // Clearing the main view (leave a panel / new blank face) is a navigation.
      store.set({})
      assert.equal(closes, 2)
      // Closed drawer: no extra closes.
      open = false
      store.set({ c: { retainedBy: { mainView: 1 } } })
      assert.equal(closes, 2)
    } finally {
      dispose()
    }
  })
})

test('installDrawerNavigationClose: non-panel controls, an outside button and a closed/inactive tier never close', async () => {
  await withDom(async document => {
    let closes = 0
    let active = true
    let open = true
    const dispose = installDrawerNavigationClose({
      active: () => active,
      isOpen: () => open,
      close: () => { closes += 1 },
      sessions: sessionsStore({ a: { retainedBy: { mainView: 1 } } }),
    })
    try {
      const sidebar = new ElementDouble()
      // A sidebar control without a panellist outlet (new session/search/menu).
      const normal = new ElementDouble({ sidebar })
      document.dispatch('click', { target: new ElementDouble({ button: normal }) })
      await tick()
      assert.equal(closes, 0, 'non-navigation sidebar controls keep the drawer open')
      // A panel-looking button outside the mobile sidebar.
      const outsideRow = new ElementDouble({ sidebar: null, slot: new ElementDouble() })
      document.dispatch('click', { target: new ElementDouble({ button: outsideRow }) })
      await tick()
      assert.equal(closes, 0, 'only the mobile sidebar is a navigation surface')
      // The tier flipped / the drawer is already closed.
      active = false
      const row = new ElementDouble({ sidebar, slot: new ElementDouble() })
      document.dispatch('click', { target: new ElementDouble({ button: row }) })
      await tick()
      assert.equal(closes, 0, 'an inactive touch tier must not touch the official sidebar')
      active = true
      open = false
      document.dispatch('click', { target: new ElementDouble({ button: row }) })
      await tick()
      assert.equal(closes, 0, 'a closed drawer has nothing to close')
    } finally {
      dispose()
    }
  })
})

test('installDrawerNavigationClose: dispose removes the click seat and the list subscription', async () => {
  await withDom(async document => {
    let closes = 0
    const store = sessionsStore({ a: { retainedBy: { mainView: 1 } } })
    const dispose = installDrawerNavigationClose({
      active: () => true,
      isOpen: () => true,
      close: () => { closes += 1 },
      sessions: store,
    })
    assert.equal(document.listenerCount('click'), 1)
    dispose()
    assert.equal(document.listenerCount('click'), 0)
    store.set({ b: { retainedBy: { mainView: 1 } } })
    const sidebar = new ElementDouble()
    const row = new ElementDouble({ sidebar, slot: new ElementDouble() })
    document.dispatch('click', { target: new ElementDouble({ button: row }) })
    await tick()
    assert.equal(closes, 0)
  })
})
