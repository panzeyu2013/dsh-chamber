/**
 * Per-source open-in adapter unit tests (design 20 §5): the dual-pool
 * selection, the per-entry channel routing, the boot-level icon cache and the
 * persisted choice. Pure node:test — the pools, the local catalog factory, the
 * RPC carrier and the preload bridge are all injected.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createOpenInSourceAdapter, type OpenInChoiceStore, type OpenInMainPool } from '../src/client/source-adapter.ts'
import type { LocalCatalog, OpenInAppRpcCall } from '../src/client/local-catalog.ts'
import { parseOpenInSource, type OpenInApp } from '../src/shared/capabilities.ts'
import type { OpenInBridgeSurface, Translate } from '../src/shared/coordinator.ts'

const FINDER: OpenInApp = { id: 'finder', displayKind: 'file-manager', remoteCapable: false, available: true }
const VSCODE: OpenInApp = { id: 'vscode', displayKind: 'vscode', remoteCapable: true, available: true }
const GHOST_VSCODE: OpenInApp = { id: 'vscode', displayKind: 'vscode', remoteCapable: true, available: false }

const t: Translate = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)

/** The production carrier is never exercised here: the catalog is injected. */
const carrier: OpenInAppRpcCall = async () => {
  throw new Error('the injected catalog must answer; the carrier is not under test here')
}

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
  const emit = (): void => { for (const listener of [...listeners]) listener() }
  return {
    store: {
      get: () => value,
      set: (next) => {
        value = next
        emit()
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set(next) {
      value = next
      emit()
    },
  }
}

interface CatalogCalls {
  load: number
  launch: Array<{ id: string; path: string }>
  icons: string[]
  factories: number
}

/** A local catalog double whose icons answer from a table (null = no icon). */
function fakeCatalog(
  entries: readonly OpenInApp[],
  icons: Readonly<Record<string, string | null>> = {},
): { catalog: LocalCatalog; calls: CatalogCalls } {
  const calls: CatalogCalls = { load: 0, launch: [], icons: [], factories: 0 }
  return {
    calls,
    catalog: {
      async load() {
        calls.load += 1
        return [...entries]
      },
      async icon(appId) {
        calls.icons.push(appId)
        return icons[appId] ?? null
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

test('adapter / local: the instance catalog is created for a local source and merged with the main pool', async () => {
  const main = mainPool([VSCODE])
  const { catalog, calls } = fakeCatalog([FINDER, VSCODE], { finder: 'data:image/png;base64,FINDER' })
  const adapter = createOpenInSourceAdapter({
    source: parseOpenInSource('local', 'local')!,
    sourceFingerprint: 'local',
    translate: t,
    rpc: carrier,
    mainPool: main.pool,
    choice: choiceStore().store,
    createLocal: () => {
      calls.factories += 1
      return catalog
    },
  })
  await settle()
  assert.equal(calls.factories, 1)
  assert.equal(calls.load, 1)
  const model = adapter.getViewModel()
  // The available main override owns vscode (IPC); finder stays local.
  assert.deepEqual(model.entries.map(entry => `${entry.id}:${entry.channel}`), ['finder:local', 'vscode:main'])
  adapter.dispose()
})

test('adapter / local: icons are fetched once per id and served from the boot cache', async () => {
  const main = mainPool([])
  const { catalog, calls } = fakeCatalog([FINDER, VSCODE], { finder: 'data:image/png;base64,FINDER' })
  const adapter = createOpenInSourceAdapter({
    source: parseOpenInSource('local', 'local')!,
    sourceFingerprint: 'local',
    translate: t,
    rpc: carrier,
    mainPool: main.pool,
    choice: choiceStore().store,
    createLocal: () => catalog,
  })
  await settle()
  assert.deepEqual(calls.icons.sort(), ['finder', 'vscode'])
  assert.equal(adapter.iconUrl('finder'), 'data:image/png;base64,FINDER')
  assert.equal(adapter.iconUrl('vscode'), null, 'a host without artwork caches the absence')

  await adapter.refresh()
  assert.deepEqual(calls.icons.sort(), ['finder', 'vscode'],
    'a refresh must not re-request icons the boot cache already answered')
  adapter.dispose()
})

test('adapter / local: local launches call the host domain, main launches ride the IPC proof', async () => {
  const main = mainPool([VSCODE])
  const { catalog, calls } = fakeCatalog([FINDER])
  const opened: Array<{ args: string[] }> = []
  const adapter = createOpenInSourceAdapter({
    source: parseOpenInSource('local', 'local')!,
    sourceFingerprint: 'local',
    translate: t,
    rpc: carrier,
    mainPool: main.pool,
    choice: choiceStore().store,
    createLocal: () => catalog,
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

test('adapter / local: a missing carrier means no local catalog (and a structured launch failure)', async () => {
  const main = mainPool([])
  const { catalog, calls } = fakeCatalog([FINDER])
  const adapter = createOpenInSourceAdapter({
    source: parseOpenInSource('local', 'local')!,
    sourceFingerprint: 'local',
    translate: t,
    mainPool: main.pool,
    choice: choiceStore().store,
    createLocal: () => catalog,
  })
  await settle()
  assert.equal(calls.factories, 0, 'without a carrier the local catalog is never built')
  assert.equal(adapter.getViewModel().visible, false)
  const entry = { id: 'finder', channel: 'local' as const, displayKind: 'file-manager', remoteCapable: false, order: 0 }
  assert.deepEqual(await adapter.launch(entry, '/ws'), { ok: false, error: 'catalogUnavailable' })
  adapter.dispose()
})

test('adapter / local: a missing or malformed bridge is a loud structured failure', async () => {
  const main = mainPool([VSCODE])
  const base = {
    source: parseOpenInSource('local', 'local')!,
    sourceFingerprint: 'local',
    translate: t,
    rpc: carrier,
    mainPool: main.pool,
    choice: choiceStore().store,
    createLocal: () => fakeCatalog([]).catalog,
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

test('adapter / remote ssh: no local catalog is created even when a carrier exists', async () => {
  const main = mainPool([FINDER, VSCODE])
  const { catalog, calls } = fakeCatalog([])
  const adapter = createOpenInSourceAdapter({
    source: parseOpenInSource('dsh-edge-west', 'ssh')!,
    sourceFingerprint: 'a'.repeat(64),
    translate: t,
    rpc: carrier,
    mainPool: main.pool,
    choice: choiceStore().store,
    createLocal: () => catalog,
  })
  await settle()
  assert.equal(calls.factories, 0, 'the instance catalog exists for LOCAL sources only')
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
    rpc: carrier,
    mainPool: main.pool,
    choice: choiceStore().store,
    createLocal: () => fakeCatalog([FINDER]).catalog,
  })
  await settle()
  assert.equal(adapter.getViewModel().visible, false)
  adapter.dispose()
})

test('adapter / an unavailable main override falls back to the local entry', async () => {
  const main = mainPool([GHOST_VSCODE])
  const { catalog } = fakeCatalog([VSCODE])
  const adapter = createOpenInSourceAdapter({
    source: parseOpenInSource('local', 'local')!,
    sourceFingerprint: 'local',
    translate: t,
    rpc: carrier,
    mainPool: main.pool,
    choice: choiceStore().store,
    createLocal: () => catalog,
  })
  await settle()
  assert.deepEqual(adapter.getViewModel().entries.map(entry => `${entry.id}:${entry.channel}`), ['vscode:local'])
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
    rpc: carrier,
    mainPool: main.pool,
    choice: choice.store,
    createLocal: () => catalog,
  })
  await settle()
  let notified = 0
  const unsubscribe = adapter.subscribe(() => { notified += 1 })
  await adapter.refresh()
  assert.equal(calls.load, 2, 'refresh re-reads the instance catalog')
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
