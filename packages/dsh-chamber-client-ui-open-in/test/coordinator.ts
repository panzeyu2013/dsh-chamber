/**
 * coordinator.ts unit tests (plain node:test, no dsh, no DOM): the page-wide
 * app-list probe's fail-closed contract (design 16 §6.3) — bridge-missing
 * retry (frontend-review P1-1), real-result memoization, probe-failure
 * memoization, the refresh epoch guard (a superseded in-flight probe never
 * overwrites a newer result), listener notification, and the platform/ready
 * faces. The `window` face is mocked on globalThis (the coordinator reads it
 * only inside calls, never at module top level).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetOpenInForTests,
  bridgePlatform,
  getApps,
  getOpenInApps,
  openInBridgeReady,
  refreshApps,
  subscribeOpenIn,
  type OpenInApp,
} from '../src/shared/coordinator.ts'

const FINDER: OpenInApp = { id: 'finder', remoteCapable: false, available: true }
const VSCODE: OpenInApp = { id: 'vscode', remoteCapable: true, available: true }

interface BridgeOptions {
  platform?: string | null
  apps?: () => unknown
}

/** Install the mocked window.dshChamber.openIn bridge on globalThis. */
function installBridge(options: BridgeOptions = {}): void {
  ;(globalThis as { window?: unknown }).window = {
    dshChamber: {
      platform: options.platform === undefined ? 'darwin' : options.platform,
      openIn: {
        apps: options.apps ?? (async () => [FINDER, VSCODE]),
      },
    },
  }
}

/** Remove the bridge (window present, openIn absent — the pre-hydration state). */
function clearBridge(): void {
  ;(globalThis as { window?: unknown }).window = {}
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

test('getOpenInApps starts null and stays null while the bridge is absent', async () => {
  __resetOpenInForTests()
  clearBridge()
  assert.equal(getOpenInApps(), null)
  assert.equal(openInBridgeReady(), false)
  assert.equal(await getApps(), null)
  assert.equal(getOpenInApps(), null)
})

test('a missing bridge is NOT memoized: installing it later lets the next probe retry', async () => {
  __resetOpenInForTests()
  clearBridge()
  assert.equal(await getApps(), null)
  let calls = 0
  installBridge({ apps: async () => { calls += 1; return [VSCODE] } })
  assert.deepEqual(await getApps(), [VSCODE])
  // Would be 0 if the bridge-missing null had been cached (the P1-1 regression).
  assert.equal(calls, 1)
  assert.deepEqual(getOpenInApps(), [VSCODE])
})

test('a successful probe is memoized: repeated getApps share one flight', async () => {
  __resetOpenInForTests()
  let calls = 0
  installBridge({ apps: async () => { calls += 1; return [FINDER, VSCODE] } })
  const p1 = getApps()
  const p2 = getApps()
  assert.equal(p1, p2) // the exact same promise — single flight across callers
  assert.deepEqual(await p1, [FINDER, VSCODE])
  assert.deepEqual(getOpenInApps(), [FINDER, VSCODE])
  assert.equal(calls, 1)
})

test('a probe failure is fail-closed AND memoized: the list hides, no retry loop', async () => {
  __resetOpenInForTests()
  let calls = 0
  installBridge({ apps: async () => { calls += 1; throw new Error('bridge down') } })
  assert.equal(await getApps(), null)
  assert.equal(getOpenInApps(), null)
  assert.equal(await getApps(), null) // the memoized failure — no re-probe
  assert.equal(calls, 1)
})

test('a non-array probe result is fail-closed (null) and memoized', async () => {
  __resetOpenInForTests()
  let calls = 0
  installBridge({ apps: async () => { calls += 1; return 'not-an-array' } })
  assert.equal(await getApps(), null)
  assert.equal(getOpenInApps(), null)
  assert.equal(await getApps(), null)
  assert.equal(calls, 1)
})

test('refreshApps bumps the epoch: a superseded in-flight probe never overwrites the newer result', async () => {
  __resetOpenInForTests()
  const first = deferred<unknown>()
  const second = deferred<unknown>()
  const queue = [() => first.promise, () => second.promise]
  let calls = 0
  installBridge({ apps: () => queue[calls++]() })

  let notifications = 0
  const unsubscribe = subscribeOpenIn(() => { notifications += 1 })

  const p1 = getApps()      // probe 1 captures epoch 0
  const p2 = refreshApps()  // epoch → 1; probe 2 captures epoch 1
  assert.equal(getOpenInApps(), null)

  first.resolve([FINDER])   // the stale flight lands first — must NOT write
  assert.deepEqual(await p1, null)
  assert.equal(getOpenInApps(), null)
  assert.equal(notifications, 0) // superseded writes never notify

  second.resolve([VSCODE])  // the fresh flight owns the write
  assert.deepEqual(await p2, [VSCODE])
  assert.deepEqual(getOpenInApps(), [VSCODE])
  assert.equal(notifications, 1)
  unsubscribe()
})

test('refreshApps clears the memo and re-probes (menu-open refresh)', async () => {
  __resetOpenInForTests()
  const results: OpenInApp[][] = [[FINDER], [FINDER, VSCODE]]
  let calls = 0
  installBridge({ apps: async () => results[calls++] ?? [] })
  assert.deepEqual(await getApps(), [FINDER])
  assert.deepEqual(await refreshApps(), [FINDER, VSCODE])
  assert.deepEqual(getOpenInApps(), [FINDER, VSCODE])
  assert.equal(calls, 2)
})

test('subscribeOpenIn notifies once per landed probe and unsubscribes cleanly', async () => {
  __resetOpenInForTests()
  installBridge({ apps: async () => [VSCODE] })
  let notifications = 0
  const unsubscribe = subscribeOpenIn(() => { notifications += 1 })
  await getApps()
  assert.equal(notifications, 1)
  unsubscribe()
  await refreshApps()
  assert.equal(notifications, 1) // unsubscribed — no further notifications
})

test('openInBridgeReady and bridgePlatform reflect the window face', () => {
  __resetOpenInForTests()
  clearBridge()
  assert.equal(openInBridgeReady(), false)
  assert.equal(bridgePlatform(), null)
  installBridge({ platform: 'win32' })
  assert.equal(openInBridgeReady(), true)
  assert.equal(bridgePlatform(), 'win32')
  installBridge({ platform: null })
  assert.equal(bridgePlatform(), null)
})
