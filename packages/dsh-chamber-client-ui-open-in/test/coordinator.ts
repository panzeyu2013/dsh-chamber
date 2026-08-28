import assert from 'node:assert/strict'
import test from 'node:test'
import type { OpenInApp } from '../src/shared/capabilities.ts'

const validApps: OpenInApp[] = [
  { id: 'finder', displayKind: 'file-manager', remoteCapable: false, available: true },
  { id: 'vscode', displayKind: 'vscode', remoteCapable: true, available: true },
]

let importNonce = 0

async function freshCoordinator() {
  importNonce += 1
  return import(`../src/shared/coordinator.ts?test=${importNonce}`)
}

function setBridge(apps: () => Promise<unknown>): void {
  Object.assign(globalThis, {
    window: {
      dshChamber: {
        platform: 'darwin',
        openIn: {
          apps,
          open: async () => ({ ok: true as const }),
        },
      },
    },
  })
}

test('getApps does not memoize a bridge-missing preload race', async () => {
  const coordinator = await freshCoordinator()
  Object.assign(globalThis, { window: {} })
  assert.equal(await coordinator.getApps(), null)

  let calls = 0
  setBridge(async () => {
    calls += 1
    return validApps
  })
  assert.deepEqual(await coordinator.getApps(), validApps)
  assert.equal(calls, 1)
})

test('getApps is single-flight and validates every capability entry', async () => {
  const coordinator = await freshCoordinator()
  let resolveProbe!: (value: unknown) => void
  const probe = new Promise<unknown>((resolve) => { resolveProbe = resolve })
  let calls = 0
  setBridge(() => {
    calls += 1
    return probe
  })

  const first = coordinator.getApps()
  const second = coordinator.getApps()
  assert.equal(first, second)
  assert.equal(calls, 1)
  resolveProbe([
    validApps[0],
    { ...validApps[1], remoteCapable: 'true' },
    validApps[1],
  ])
  assert.deepEqual(await first, validApps)
  assert.deepEqual(coordinator.getOpenInApps(), validApps)
})

test('refreshApps prevents a superseded probe from overwriting the fresh result', async () => {
  const coordinator = await freshCoordinator()
  let resolveOld!: (value: unknown) => void
  let resolveFresh!: (value: unknown) => void
  const oldProbe = new Promise<unknown>((resolve) => { resolveOld = resolve })
  const freshProbe = new Promise<unknown>((resolve) => { resolveFresh = resolve })
  let calls = 0
  setBridge(() => {
    calls += 1
    return calls === 1 ? oldProbe : freshProbe
  })

  const oldFlight = coordinator.getApps()
  const freshFlight = coordinator.refreshApps()
  resolveOld(validApps)
  assert.equal(await oldFlight, null)

  const freshApps = [{ ...validApps[1], id: 'future', displayKind: 'future' }]
  resolveFresh(freshApps)
  assert.deepEqual(await freshFlight, freshApps)
  assert.deepEqual(coordinator.getOpenInApps(), freshApps)
})

test('a transient first IPC rejection recovers inside the bounded shared flight', async () => {
  const coordinator = await freshCoordinator()
  let calls = 0
  const delays: number[] = []
  setBridge(async () => {
    calls += 1
    if (calls === 1) throw new Error('ipc failed')
    return validApps
  })

  assert.deepEqual(await coordinator.getApps({ wait: async ms => { delays.push(ms) } }), validApps)
  assert.equal(calls, 2)
  assert.deepEqual(delays, [coordinator.OPEN_IN_APP_PROBE_RETRY_MS])
  assert.deepEqual(await coordinator.getApps(), validApps, 'the recovered result is memoized')
  assert.equal(calls, 2)
})

test('a persistently failing app probe stops at the retry limit and stays fail-closed', async () => {
  const coordinator = await freshCoordinator()
  let calls = 0
  const delays: number[] = []
  setBridge(async () => {
    calls += 1
    throw new Error('ipc remains unavailable')
  })

  assert.equal(await coordinator.getApps({ wait: async ms => { delays.push(ms) } }), null)
  assert.equal(calls, coordinator.OPEN_IN_APP_PROBE_RETRY_LIMIT)
  assert.deepEqual(
    delays,
    Array.from(
      { length: coordinator.OPEN_IN_APP_PROBE_RETRY_LIMIT - 1 },
      () => coordinator.OPEN_IN_APP_PROBE_RETRY_MS,
    ),
  )
  assert.equal(await coordinator.getApps(), null, 'final exhaustion is memoized, not an unbounded retry loop')
  assert.equal(calls, coordinator.OPEN_IN_APP_PROBE_RETRY_LIMIT)
})
