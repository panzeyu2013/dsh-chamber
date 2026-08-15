/**
 * permission-row-controller.ts unit tests (plain node:test, no dsh, no DOM):
 * describe → ready with decoded options, missing namespace → unavailable,
 * describe failure → error, select writes with the descriptor revision and
 * accepts the response, select blocked when unwritable/absent, stale
 * responses never publish (generation guard), dispose silences publication.
 * The schema-envelope decode is stubbed here (real decode is data-driven and
 * verified against the live host).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PermissionPresetSettingsController,
  refreshPermissionIfLoaded,
  type PermissionSettingsApi,
  type PermissionSettingsState,
  type PermissionViewDecoder,
} from '../src/client/bridge-rows/permission-row-controller.ts'
import type { PermissionNamespaceView } from '../src/client/bridge-rows/permission-decode.ts'

const VIEW = (overrides: Partial<PermissionNamespaceView> = {}): PermissionNamespaceView => ({
  ns: 'permission',
  revision: 7,
  value: { defaultPreset: 'safe' },
  schema: {},
  ...overrides,
})

const OPTIONS = [
  { id: 'safe', label: 'Safe' },
  { id: 'danger-full-access', label: 'Full access' },
]

const DECODE: PermissionViewDecoder = (view) => ({
  currentValue: (view.value as { defaultPreset: string }).defaultPreset,
  options: OPTIONS,
})

type DescribeResult = Awaited<ReturnType<PermissionSettingsApi['settings']['describe']>>
type MutateResult = Awaited<ReturnType<PermissionSettingsApi['settings']['mutate']>>

/** Controllable fake settings wire face. */
class FakeApi implements PermissionSettingsApi {
  settings: PermissionSettingsApi['settings'] = {
    describe: async () => ({ result: { ok: true, value: { namespaces: [VIEW()], writable: true } } }),
    mutate: async () => ({ result: { ok: true, value: VIEW({ revision: 8, value: { defaultPreset: 'safe' } }) } }),
  }

  describeQueue: Array<() => Promise<DescribeResult>> = []
  mutateQueue: Array<(payload: Record<string, unknown>) => Promise<MutateResult>> = []

  constructor() {
    this.settings = {
      describe: async () => { throw new Error('no describe stub') },
      mutate: async () => { throw new Error('no mutate stub') },
    }
  }

  describeOnce(handler: () => Promise<DescribeResult>): void {
    this.describeQueue.push(handler)
  }

  mutateOnce(handler: (payload: Record<string, unknown>) => Promise<MutateResult>): void {
    this.mutateQueue.push(handler)
  }

  /** Override the live handlers with the queued stubs (first call consumes). */
  install(): void {
    this.settings = {
      describe: async () => {
        const next = this.describeQueue.shift()
        if (next === undefined) throw new Error('unexpected describe call')
        return next()
      },
      mutate: async (payload) => {
        const next = this.mutateQueue.shift()
        if (next === undefined) throw new Error('unexpected mutate call')
        return next(payload)
      },
    }
  }
}

function snapshot(controller: PermissionPresetSettingsController): PermissionSettingsState {
  return controller.store.getSnapshot()
}

test('load resolves the namespace into ready options', async () => {
  const api = new FakeApi()
  api.describeOnce(async () => ({ result: { ok: true, value: { namespaces: [VIEW()], writable: true } } }))
  api.install()
  const controller = new PermissionPresetSettingsController(api, DECODE)
  await controller.load()
  assert.equal(snapshot(controller).status, 'ready')
  assert.equal(snapshot(controller).currentValue, 'safe')
  assert.equal(snapshot(controller).options.length, 2)
  assert.equal(snapshot(controller).revision, 7)
  assert.equal(snapshot(controller).writable, true)
})

test('missing namespace publishes unavailable', async () => {
  const api = new FakeApi()
  api.describeOnce(async () => ({ result: { ok: true, value: { namespaces: [], writable: true } } }))
  api.install()
  const controller = new PermissionPresetSettingsController(api, DECODE)
  await controller.load()
  assert.equal(snapshot(controller).status, 'unavailable')
  assert.equal(snapshot(controller).writable, false)
})

test('describe failure publishes error', async () => {
  const api = new FakeApi()
  api.describeOnce(async () => ({ result: { ok: false, error: { message: 'boom' } } }))
  api.install()
  const controller = new PermissionPresetSettingsController(api, DECODE)
  await controller.load()
  assert.equal(snapshot(controller).status, 'error')
  assert.equal(snapshot(controller).error, 'boom')
})

test('decode rejection publishes error', async () => {
  const api = new FakeApi()
  api.describeOnce(async () => ({ result: { ok: true, value: { namespaces: [VIEW()], writable: true } } }))
  api.install()
  const controller = new PermissionPresetSettingsController(api, () => {
    throw new Error('no defaultPreset in schema')
  })
  await controller.load()
  assert.equal(snapshot(controller).status, 'error')
  assert.equal(snapshot(controller).error, 'no defaultPreset in schema')
})

test('select writes the preset with the descriptor revision and accepts the response', async () => {
  const api = new FakeApi()
  api.describeOnce(async () => ({ result: { ok: true, value: { namespaces: [VIEW()], writable: true } } }))
  api.mutateOnce(async (payload) => {
    assert.deepEqual(payload, {
      ns: 'permission',
      ops: [{ op: 'set', path: ['defaultPreset'], value: 'danger-full-access' }],
      expectedRevision: 7,
    })
    return { result: { ok: true, value: VIEW({ revision: 8, value: { defaultPreset: 'danger-full-access' } }) } }
  })
  api.install()
  const controller = new PermissionPresetSettingsController(api, DECODE)
  await controller.load()
  await controller.select('danger-full-access')
  assert.equal(snapshot(controller).status, 'ready')
  assert.equal(snapshot(controller).currentValue, 'danger-full-access')
  assert.equal(snapshot(controller).revision, 8)
})

test('select is blocked while unwritable', async () => {
  const api = new FakeApi()
  api.describeOnce(async () => ({ result: { ok: true, value: { namespaces: [VIEW()], writable: false } } }))
  api.install()
  const controller = new PermissionPresetSettingsController(api, DECODE)
  await controller.load()
  await controller.select('danger-full-access')
  assert.equal(snapshot(controller).status, 'ready')
  assert.equal(snapshot(controller).currentValue, 'safe')
})

test('select is blocked without a resolved view', async () => {
  const api = new FakeApi()
  api.describeOnce(async () => ({ result: { ok: true, value: { namespaces: [], writable: true } } }))
  api.install()
  const controller = new PermissionPresetSettingsController(api, DECODE)
  await controller.load()
  assert.equal(snapshot(controller).status, 'unavailable')
  await controller.select('safe')
  assert.equal(snapshot(controller).status, 'unavailable')
})

test('select failure publishes error', async () => {
  const api = new FakeApi()
  api.describeOnce(async () => ({ result: { ok: true, value: { namespaces: [VIEW()], writable: true } } }))
  api.mutateOnce(async () => ({ result: { ok: false, error: { message: 'revision conflict' } } }))
  api.install()
  const controller = new PermissionPresetSettingsController(api, DECODE)
  await controller.load()
  await controller.select('safe')
  assert.equal(snapshot(controller).status, 'error')
  assert.equal(snapshot(controller).error, 'revision conflict')
})

test('select publishes a saving intermediate status until the write settles', async () => {
  const api = new FakeApi()
  api.describeOnce(async () => ({ result: { ok: true, value: { namespaces: [VIEW()], writable: true } } }))
  let release: (() => void) | undefined
  api.mutateOnce(() => new Promise((resolve) => {
    release = () => resolve({ result: { ok: true, value: VIEW({ revision: 8, value: { defaultPreset: 'safe' } }) } })
  }))
  api.install()
  const controller = new PermissionPresetSettingsController(api, DECODE)
  await controller.load()
  const pending = controller.select('safe')
  assert.equal(snapshot(controller).status, 'saving')
  release?.()
  await pending
  assert.equal(snapshot(controller).status, 'ready')
  assert.equal(snapshot(controller).revision, 8)
})

test('a stale select response never publishes (latest write wins)', async () => {
  const api = new FakeApi()
  api.describeOnce(async () => ({ result: { ok: true, value: { namespaces: [VIEW()], writable: true } } }))
  let releaseFirst: (() => void) | undefined
  api.mutateOnce(() => new Promise((resolve) => {
    releaseFirst = () => resolve({ result: { ok: true, value: VIEW({ revision: 8, value: { defaultPreset: 'safe' } }) } })
  }))
  api.mutateOnce(async () => ({ result: { ok: true, value: VIEW({ revision: 9, value: { defaultPreset: 'danger-full-access' } }) } }))
  api.install()
  const controller = new PermissionPresetSettingsController(api, DECODE)
  await controller.load()
  const first = controller.select('safe')
  const second = controller.select('danger-full-access')
  await second
  assert.equal(snapshot(controller).revision, 9)
  assert.equal(snapshot(controller).currentValue, 'danger-full-access')
  releaseFirst?.()
  await first
  assert.equal(snapshot(controller).revision, 9, 'the stale first write must not overwrite the newer one')
})

test('a stale load response never publishes (latest request wins)', async () => {
  const api = new FakeApi()
  let release: (() => void) | undefined
  api.describeOnce(() => new Promise((resolve) => {
    release = () => resolve({ result: { ok: true, value: { namespaces: [VIEW({ revision: 1 })], writable: true } } })
  }))
  api.describeOnce(async () => ({ result: { ok: true, value: { namespaces: [VIEW({ revision: 2 })], writable: true } } }))
  api.install()
  const controller = new PermissionPresetSettingsController(api, DECODE)
  const first = controller.load()
  const second = controller.load()
  await second
  assert.equal(snapshot(controller).revision, 2)
  release?.()
  await first
  assert.equal(snapshot(controller).revision, 2, 'the stale first response must not overwrite the newer read')
})

test('dispose stops in-flight responses from publishing', async () => {
  const api = new FakeApi()
  let release: (() => void) | undefined
  api.describeOnce(() => new Promise((resolve) => {
    release = () => resolve({ result: { ok: true, value: { namespaces: [VIEW()], writable: true } } })
  }))
  api.install()
  const controller = new PermissionPresetSettingsController(api, DECODE)
  const pending = controller.load()
  controller.dispose()
  release?.()
  await pending
  assert.equal(snapshot(controller).status, 'loading', 'a disposed controller publishes nothing')
})

test('refreshIfLoaded skips an untouched row', () => {
  const api = new FakeApi()
  const controller = new PermissionPresetSettingsController(api, DECODE)
  refreshPermissionIfLoaded(controller)
  assert.equal(snapshot(controller).status, 'idle')
})
