/**
 * Per-source open-in adapter unit tests (design 20 §5): the rendered-set merge
 * (the page's machine catalog + the page-wide main pool), the per-entry channel
 * routing and the persisted choice. Pure node:test — the pools and the preload
 * bridge are injected; the machine catalog is the page service the shell builds
 * (`machine-catalog.test.ts` covers its caching).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createOpenInSourceAdapter, type OpenInChoiceStore, type OpenInMainPool } from '../src/client/source-adapter.ts'
import type { MachineCatalog } from '../src/client/machine-catalog.ts'
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

interface MachineCalls {
  refreshes: number
  launches: Array<{ id: string; path: string }>
  unsubscribed: number
}

/** The injected page service double (the shell's real one is in machine-catalog.ts). */
function fakeMachine(
  entries: readonly OpenInApp[] | null,
  icons: Readonly<Record<string, string | null>> = {},
): { machine: MachineCatalog; calls: MachineCalls; setEntries(next: readonly OpenInApp[] | null): void } {
  const calls: MachineCalls = { refreshes: 0, launches: [], unsubscribed: 0 }
  let current = entries
  const listeners = new Set<() => void>()
  return {
    calls,
    machine: {
      entries: () => current,
      iconUrl: appId => (appId in icons ? icons[appId]! : null),
      refresh: async () => { calls.refreshes += 1 },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          calls.unsubscribed += 1
          listeners.delete(listener)
        }
      },
      launch: async (appId, path) => { calls.launches.push({ id: appId, path }) },
    },
    setEntries(next) {
      current = next
      for (const listener of [...listeners]) listener()
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

test('adapter: the machine catalog is merged with the main pool for a local source', async () => {
  const main = mainPool([VSCODE])
  const { machine, calls } = fakeMachine([FINDER, VSCODE], { finder: 'data:image/png;base64,FINDER' })
  const adapter = createOpenInSourceAdapter({
    source: parseOpenInSource('local', 'local')!,
    sourceFingerprint: 'local',
    translate: t,
    machineCatalog: machine,
    mainPool: main.pool,
    choice: choiceStore().store,
  })
  await settle()
  assert.equal(calls.refreshes, 1, 'the adapter probes the page catalog on boot')
  const model = adapter.getViewModel()
  // The available main override owns vscode (IPC); finder stays local.
  assert.deepEqual(model.entries.map(entry => `${entry.id}:${entry.channel}`), ['finder:local', 'vscode:main'])
  assert.equal(adapter.iconUrl('finder'), 'data:image/png;base64,FINDER')
  adapter.dispose()
})

test('adapter / remote ssh: the machine catalog still supplies the mark for the main entry', async () => {
  // The machine fact is what a remote source needs: its own instance cannot
  // serve a catalog, and the only app it may launch is the machine's VS Code.
  const main = mainPool([FINDER, VSCODE])
  const { machine } = fakeMachine([FINDER, VSCODE], { vscode: 'data:image/png;base64,VSCODE' })
  const adapter = createOpenInSourceAdapter({
    source: parseOpenInSource('dsh-edge-west', 'ssh')!,
    sourceFingerprint: 'a'.repeat(64),
    translate: t,
    machineCatalog: machine,
    mainPool: main.pool,
    choice: choiceStore().store,
  })
  await settle()
  assert.deepEqual(adapter.getViewModel().entries.map(entry => `${entry.id}:${entry.channel}`), ['vscode:main'],
    'the machine pool is filtered by the source, never merged into it')
  assert.equal(adapter.iconUrl('vscode'), 'data:image/png;base64,VSCODE',
    'the remote entry draws the machine-resolved icon, not a bundled snapshot')
  adapter.dispose()
})

test('adapter: local launches call the host domain, main launches ride the IPC proof', async () => {
  const main = mainPool([VSCODE])
  const { machine, calls } = fakeMachine([FINDER])
  const opened: Array<{ args: string[] }> = []
  const adapter = createOpenInSourceAdapter({
    source: parseOpenInSource('local', 'local')!,
    sourceFingerprint: 'local',
    translate: t,
    machineCatalog: machine,
    mainPool: main.pool,
    choice: choiceStore().store,
    bridge: () => bridge(async (...args: string[]) => {
      opened.push({ args })
      return { ok: true }
    }),
  })
  await settle()
  const [finder, vscode] = adapter.getViewModel().entries
  assert.deepEqual(await adapter.launch(finder!, '/home/user/ws'), { ok: true })
  assert.deepEqual(calls.launches, [{ id: 'finder', path: '/home/user/ws' }])
  assert.deepEqual(await adapter.launch(vscode!, '/home/user/ws'), { ok: true })
  assert.deepEqual(opened, [{ args: ['vscode', 'local', '/home/user/ws', 'local'] }])
  adapter.dispose()
})

test('adapter: a page without a machine reader keeps the local pool empty', async () => {
  const main = mainPool([])
  const adapter = createOpenInSourceAdapter({
    source: parseOpenInSource('local', 'local')!,
    sourceFingerprint: 'local',
    translate: t,
    mainPool: main.pool,
    choice: choiceStore().store,
  })
  await settle()
  assert.equal(adapter.getViewModel().visible, false)
  assert.equal(adapter.iconUrl('finder'), null)
  const entry = { id: 'finder', channel: 'local' as const, displayKind: 'file-manager', remoteCapable: false, order: 0 }
  assert.deepEqual(await adapter.launch(entry, '/ws'), { ok: false, error: 'catalogUnavailable' })
  adapter.dispose()
})

test('adapter: a missing or malformed bridge is a loud structured failure', async () => {
  const main = mainPool([VSCODE])
  const { machine } = fakeMachine([])
  const base = {
    source: parseOpenInSource('local', 'local')!,
    sourceFingerprint: 'local',
    translate: t,
    machineCatalog: machine,
    mainPool: main.pool,
    choice: choiceStore().store,
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

test('adapter / http transport: nothing renders', async () => {
  const main = mainPool([VSCODE])
  const { machine } = fakeMachine([FINDER])
  const adapter = createOpenInSourceAdapter({
    source: parseOpenInSource('dsh-direct', 'http')!,
    sourceFingerprint: 'b'.repeat(64),
    translate: t,
    machineCatalog: machine,
    mainPool: main.pool,
    choice: choiceStore().store,
  })
  await settle()
  assert.equal(adapter.getViewModel().visible, false)
  adapter.dispose()
})

test('adapter: an unavailable main override falls back to the machine entry', async () => {
  const main = mainPool([GHOST_VSCODE])
  const { machine } = fakeMachine([VSCODE])
  const adapter = createOpenInSourceAdapter({
    source: parseOpenInSource('local', 'local')!,
    sourceFingerprint: 'local',
    translate: t,
    machineCatalog: machine,
    mainPool: main.pool,
    choice: choiceStore().store,
  })
  await settle()
  assert.deepEqual(adapter.getViewModel().entries.map(entry => `${entry.id}:${entry.channel}`), ['vscode:local'])
  adapter.dispose()
})

test('adapter / refresh re-probes both pools; subscribe fans out pool, machine and choice changes; dispose stops it', async () => {
  const main = mainPool([VSCODE])
  const { machine, calls, setEntries } = fakeMachine([FINDER])
  const choice = choiceStore()
  const adapter = createOpenInSourceAdapter({
    source: parseOpenInSource('local', 'local')!,
    sourceFingerprint: 'local',
    translate: t,
    machineCatalog: machine,
    mainPool: main.pool,
    choice: choice.store,
  })
  await settle()
  let notified = 0
  const unsubscribe = adapter.subscribe(() => { notified += 1 })
  await adapter.refresh()
  assert.equal(calls.refreshes, 2, 'refresh re-probes the machine catalog (boot + explicit)')
  assert.equal(main.refreshes(), 2, 'refresh re-probes the main pool (initial + explicit)')
  main.set([VSCODE, FINDER])
  assert.ok(notified >= 1)
  const afterMain = notified
  setEntries([FINDER, VSCODE])
  assert.ok(notified > afterMain, 'the machine catalog notifies subscribers')
  const before = notified
  adapter.choose('finder')
  assert.equal(adapter.getChoice(), 'finder')
  assert.ok(notified > before, 'the persisted choice notifies subscribers')
  unsubscribe()
  adapter.dispose()
  assert.equal(calls.unsubscribed, 1, 'dispose releases the machine subscription')
  const after = notified
  main.set(null)
  setEntries(null)
  choice.set('vscode')
  assert.equal(notified, after, 'dispose releases every subscription')
})
