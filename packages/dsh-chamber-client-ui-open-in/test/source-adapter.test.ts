/**
 * Per-source open-in adapter unit tests (Batch 3 Phase 2, plan §5.2): the
 * dual-pool selection, the base-path remapping, the per-entry channel routing
 * and the persisted choice. Pure node:test — the pools, the catalog factory and
 * the preload bridge are all injected.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createOpenInSourceAdapter, type OpenInChoiceStore, type OpenInMainPool } from '../src/client/source-adapter.ts'
import type { OfficialCatalog } from '../src/client/official-catalog.ts'
import { parseOpenInSource, type OpenInApp } from '../src/shared/capabilities.ts'
import type { OpenInBridgeSurface, Translate } from '../src/shared/coordinator.ts'

const FINDER: OpenInApp = { id: 'finder', displayKind: 'file-manager', remoteCapable: false, available: true }
const VSCODE: OpenInApp = { id: 'vscode', displayKind: 'vscode', remoteCapable: true, available: true }
const GHOST_VSCODE: OpenInApp = { id: 'vscode', displayKind: 'vscode', remoteCapable: true, available: false }

const t: Translate = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)

function mainPool(initial: readonly OpenInApp[] | null): { pool: OpenInMainPool; set(next: readonly OpenInApp[] | null): void; refreshes(): number } {
  let apps = initial
  let refreshes = 0
  const listeners = new Set<() => void>()
  return {
    pool: {
      get: () => apps,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      refresh: async () => { refreshes += 1 },
    },
    set(next) {
      apps = next
      for (const listener of [...listeners]) listener()
    },
    refreshes: () => refreshes,
  }
}

function choiceStore(initial = ''): { store: OpenInChoiceStore; set(next: string): void } {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    store: {
      get: () => value,
      set: (next) => {
        value = next
        for (const listener of [...listeners]) listener()
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set(next) {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

interface CatalogCalls {
  load: number
  launch: Array<{ id: string; path: string }>
  iconUrl: string[]
  factories: string[]
}

function fakeCatalog(entries: readonly OpenInApp[]): { catalog: OfficialCatalog; calls: CatalogCalls } {
  const calls: CatalogCalls = { load: 0, launch: [], iconUrl: [], factories: [] }
  return {
    calls,
    catalog: {
      async load() {
        calls.load += 1
        return [...entries]
      },
      iconUrl(appId) {
        calls.iconUrl.push(appId)
        return `http://proxy/api/i/ssh-x/open-in-app/icon/${appId}`
      },
      async launch(appId, path) {
        calls.launch.push({ id: appId, path })
      },
    },
  }
}

type OpenInBridge = NonNullable<NonNullable<OpenInBridgeSurface['dshChamber']>['openIn']>
type OpenInBridgeRoot = NonNullable<OpenInBridgeSurface['dshChamber']>

function bridge(openImpl: OpenInBridge['open']): OpenInBridgeRoot {
  return { openIn: { apps: async () => [], open: openImpl } }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

test('adapter / local: official catalog is created with the entry base path and merged with the main pool', async () => {
  const main = mainPool([VSCODE])
  const { catalog, calls } = fakeCatalog([FINDER, VSCODE])
  const adapter = createOpenInSourceAdapter({
    source: parseOpenInSource('local', 'local')!,
    sourceFingerprint: 'local',
    translate: t,
    basePath: '/api/i/local',
    mainPool: main.pool,
    choice: choiceStore().store,
    createCatalog: options => {
      calls.factories.push(options.basePath)
      return catalog
    },
  })
  await settle()
  assert.deepEqual(calls.factories, ['/api/i/local'])
  assert.equal(calls.load, 1)
  const model = adapter.getViewModel()
  // The available main override owns vscode (IPC); finder stays official.
  assert.deepEqual(model.entries.map(entry => `${entry.id}:${entry.channel}`), ['finder:official', 'vscode:main'])
  assert.equal(adapter.iconUrl('finder'), 'http://proxy/api/i/ssh-x/open-in-app/icon/finder')
  assert.deepEqual(calls.iconUrl, ['finder'])
  adapter.dispose()
})

test('adapter / local: official launches POST to the instance route, main launches ride the IPC proof', async () => {
  const main = mainPool([VSCODE])
  const { catalog, calls } = fakeCatalog([FINDER])
  const opened: Array<{ args: string[] }> = []
  const adapter = createOpenInSourceAdapter({
    source: parseOpenInSource('local', 'local')!,
    sourceFingerprint: 'local',
    translate: t,
    basePath: '/api/i/local',
    mainPool: main.pool,
    choice: choiceStore().store,
    createCatalog: () => catalog,
    bridge: () => bridge(async (...args: string[]) => {
      opened.push({ args })
      return { ok: true }
    }),
  })
  await settle()
  const [finder, vscode] = adapter.getViewModel().entries
  assert.deepEqual(await adapter.launch(finder!, '/home/user/ws'), { ok: true })
  assert.deepEqual(calls.launch, [{ id: 'finder', path: '/home/user/ws' }])
  assert.deepEqual(await adapter.launch(vscode!, '/home/user/ws'), { ok: true })
  assert.deepEqual(opened, [{ args: ['vscode', 'local', '/home/user/ws', 'local'] }])
  adapter.dispose()
})

test('adapter / local: a missing or malformed bridge is a loud structured failure', async () => {
  const main = mainPool([VSCODE])
  const { catalog } = fakeCatalog([])
  const base = {
    source: parseOpenInSource('local', 'local')!,
    sourceFingerprint: 'local',
    translate: t,
    basePath: '/api/i/local',
    mainPool: main.pool,
    choice: choiceStore().store,
    createCatalog: () => catalog,
  }
  const missing = createOpenInSourceAdapter({ ...base, bridge: () => undefined })
  await settle()
  assert.deepEqual(await missing.launch(missing.getViewModel().entries[0]!, '/ws'), { ok: false, error: 'bridgeUnavailable' })
  missing.dispose()

  const malformed = createOpenInSourceAdapter({ ...base, bridge: () => bridge(async () => ({ nope: true })) })
  await settle()
  assert.deepEqual(await malformed.launch(malformed.getViewModel().entries[0]!, '/ws'), { ok: false, error: 'invalidResponse' })
  malformed.dispose()
})

test('adapter / remote ssh: no official catalog is created; only the main remote-capable entry remains', async () => {
  const main = mainPool([FINDER, VSCODE])
  let factories = 0
  const adapter = createOpenInSourceAdapter({
    source: parseOpenInSource('dsh-edge-west', 'ssh')!,
    sourceFingerprint: 'a'.repeat(64),
    translate: t,
    basePath: '/api/i/edge-west',
    mainPool: main.pool,
    choice: choiceStore().store,
    createCatalog: () => {
      factories += 1
      return fakeCatalog([]).catalog
    },
  })
  await settle()
  assert.equal(factories, 0, 'the official channel exists for LOCAL sources only')
  assert.deepEqual(adapter.getViewModel().entries.map(entry => `${entry.id}:${entry.channel}`), ['vscode:main'])
  assert.equal(adapter.iconUrl('vscode'), null)
  adapter.dispose()
})

test('adapter / http transport: nothing renders', async () => {
  const main = mainPool([VSCODE])
  const adapter = createOpenInSourceAdapter({
    source: parseOpenInSource('dsh-direct', 'http')!,
    sourceFingerprint: 'b'.repeat(64),
    translate: t,
    basePath: '/api/i/direct',
    mainPool: main.pool,
    choice: choiceStore().store,
    createCatalog: () => fakeCatalog([FINDER]).catalog,
  })
  await settle()
  assert.equal(adapter.getViewModel().visible, false)
  adapter.dispose()
})

test('adapter / an unavailable main override falls back to the official entry', async () => {
  const main = mainPool([GHOST_VSCODE])
  const { catalog } = fakeCatalog([VSCODE])
  const adapter = createOpenInSourceAdapter({
    source: parseOpenInSource('local', 'local')!,
    sourceFingerprint: 'local',
    translate: t,
    basePath: '/api/i/local',
    mainPool: main.pool,
    choice: choiceStore().store,
    createCatalog: () => catalog,
  })
  await settle()
  assert.deepEqual(adapter.getViewModel().entries.map(entry => `${entry.id}:${entry.channel}`), ['vscode:official'])
  adapter.dispose()
})

test('adapter / refresh re-probes both pools; subscribe fans out pool and choice changes; dispose stops it', async () => {
  const main = mainPool([VSCODE])
  const { catalog, calls } = fakeCatalog([FINDER])
  const choice = choiceStore()
  const adapter = createOpenInSourceAdapter({
    source: parseOpenInSource('local', 'local')!,
    sourceFingerprint: 'local',
    translate: t,
    basePath: '/api/i/local',
    mainPool: main.pool,
    choice: choice.store,
    createCatalog: () => catalog,
  })
  await settle()
  let notified = 0
  const unsubscribe = adapter.subscribe(() => { notified += 1 })
  await adapter.refresh()
  assert.equal(calls.load, 2, 'refresh re-reads the official catalog')
  assert.equal(main.refreshes(), 2, 'refresh re-probes the main pool (initial + explicit)')
  main.set([VSCODE, FINDER])
  assert.ok(notified >= 1)
  const before = notified
  adapter.choose('finder')
  assert.equal(adapter.getChoice(), 'finder')
  assert.ok(notified > before, 'the persisted choice notifies subscribers')
  unsubscribe()
  adapter.dispose()
  const after = notified
  main.set(null)
  choice.set('vscode')
  assert.equal(notified, after, 'dispose releases every subscription')
})
