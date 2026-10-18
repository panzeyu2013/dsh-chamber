/**
 * shell-ipc-update.test.ts — execution-level lock for the update IPC handlers (design 11 §4).
 *
 * Why a fake ctx instead of source-text counting: the payload-shape gate and the refusal
 * resync are the shell's OWN behavior, and a text lock cannot see an inverted branch (flipping
 * `revision === null` keeps every substring count intact while a malformed payload would fall
 * through to the controller with a revision its guard then treats as "no expectation"). The
 * staleness guard itself lives in the controller (updater.ts / update-headless.ts) and its fake
 * below emulates it, so the handler's parse -> forward -> resync path runs end to end.
 * shell-ipc-update.ts imports only node-safe modules, so the real registrar runs here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { IPC_CHANNELS } from '../../ipc-events.ts'
import { registerUpdateHandlers } from '../../shell-ipc-update.ts'
import { INVALID_CONFIRMATION_ERROR } from '../../update-confirmation.ts'
import { STALE_CONFIRMATION_ERROR } from '../../updater.ts'

type Handler = (payload: unknown) => unknown

interface Harness {
  handlers: Map<string, Handler>
  pushes: string[]
  calls: Array<[string, number | null | undefined]>
}

/** A captured-handler fake ctx: only the members registerUpdateHandlers actually touches. */
function makeHarness(options: { asyncRestart?: boolean } = {}): Harness {
  const handlers = new Map<string, Handler>()
  const pushes: string[] = []
  const calls: Array<[string, number | null | undefined]> = []
  // The controller's stale guard (mirrored semantics): only the CURRENT generation passes.
  const guard = (revision?: number | null) =>
    revision === 3
      ? { ok: true as const }
      : { ok: false as const, error: STALE_CONFIRMATION_ERROR }
  const controller = {
    async state() {
      return {
        phase: 'available', currentVersion: '1.2.3', latestVersion: '1.3.0', channel: 'stable',
        revision: 3, downloadPercent: null, releaseUrl: null, installBlockedReason: null, error: null,
      }
    },
    subscribe() { return () => {} },
    async checkNow() { return { ok: true as const } },
    async download(revision?: number | null) {
      calls.push(['download', revision])
      return guard(revision)
    },
    restartAndInstall(revision?: number | null) {
      calls.push(['restart', revision])
      return guard(revision)
    },
    ...(options.asyncRestart === true
      ? {
          async restartAndInstallAsync(revision?: number | null) {
            calls.push(['restartAsync', revision])
            return guard(revision)
          },
        }
      : {}),
  }
  const ctx = {
    MACOS_NOTIFICATION_SETTINGS_URL: 'x-apple.systempreferences:com.apple.preference.notifications',
    deps: {
      edges: {
        mainWindowAlive: () => true,
        rendererPush: (channel: string) => { pushes.push(channel); return true },
        openExternal: async () => true,
      },
      ctx: {
        updateController: controller,
        disarmUpdaterQuit: () => {},
        hostFacts: { platform: 'darwin' },
      },
      ipc: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) } },
    },
  }
  registerUpdateHandlers(ctx as never)
  return { handlers, pushes, calls }
}

test('update confirmation: malformed payloads fail closed AND resync the renderer', async () => {
  const { handlers, pushes, calls } = makeHarness()
  const download = handlers.get(IPC_CHANNELS.UPDATE_DOWNLOAD)!
  const malformed: unknown[] = [null, undefined, {}, { revision: '3' }, { revision: -1 }, { revision: 1.5 }, { revision: Number.NaN }]
  for (const bad of malformed) {
    assert.deepEqual(await download(bad), { ok: false, error: INVALID_CONFIRMATION_ERROR })
  }
  assert.equal(calls.length, 0, 'no malformed confirmation reaches the controller')
  assert.equal(pushes.length, malformed.length, 'every malformed payload re-pushes the current state')
  assert.equal(pushes.every((channel) => channel === IPC_CHANNELS.UPDATE_STATE_CHANGED), true)
})

test('update confirmation: the parsed revision is forwarded and a controller refusal resyncs', async () => {
  const { handlers, pushes, calls } = makeHarness()
  const download = handlers.get(IPC_CHANNELS.UPDATE_DOWNLOAD)!
  assert.deepEqual(await download({ revision: 2 }), { ok: false, error: STALE_CONFIRMATION_ERROR })
  assert.deepEqual(await download({ revision: 4 }), { ok: false, error: STALE_CONFIRMATION_ERROR })
  assert.deepEqual(calls, [['download', 2], ['download', 4]],
    'the handler forwards the parsed number verbatim; the controller owns the staleness guard')
  assert.equal(pushes.length, 2, 'each refusal re-pushes the current state')
  assert.deepEqual(await download({ revision: 3 }), { ok: true })
  assert.deepEqual(calls, [['download', 2], ['download', 4], ['download', 3]])
  assert.equal(pushes.length, 2, 'a success adds no artificial push')
})

test('update restart: same guard; the native async leg is preferred when present', async () => {
  const sync = makeHarness()
  const restartSync = sync.handlers.get(IPC_CHANNELS.UPDATE_RESTART)!
  assert.deepEqual(await restartSync({}), { ok: false, error: INVALID_CONFIRMATION_ERROR })
  assert.equal(sync.pushes.length, 1, 'a malformed restart payload re-pushes the current state')
  assert.deepEqual(await restartSync({ revision: 2 }), { ok: false, error: STALE_CONFIRMATION_ERROR })
  assert.deepEqual(sync.calls, [['restart', 2]])
  assert.equal(sync.pushes.length, 2, 'the refused restart re-pushes the current state')
  assert.deepEqual(await restartSync({ revision: 3 }), { ok: true })
  assert.deepEqual(sync.calls, [['restart', 2], ['restart', 3]])
  assert.equal(sync.pushes.length, 2, 'a successful restart adds no artificial push')

  const native = makeHarness({ asyncRestart: true })
  const restartNative = native.handlers.get(IPC_CHANNELS.UPDATE_RESTART)!
  assert.deepEqual(await restartNative({ revision: 3 }), { ok: true })
  assert.deepEqual(native.calls, [['restartAsync', 3]], 'the Sparkle leg wins when the flavor provides it')
  assert.equal(native.pushes.length, 0, 'a successful native restart adds no artificial push')
})

test('state / check registrations stay payload-free and reach the controller', async () => {
  const { handlers, calls } = makeHarness()
  const state = await handlers.get(IPC_CHANNELS.UPDATE_STATE)!(undefined) as { revision?: unknown }
  assert.equal(state.revision, 3)
  assert.deepEqual(await handlers.get(IPC_CHANNELS.UPDATE_CHECK)!(undefined), { ok: true })
  assert.equal(calls.length, 0, 'state/check never enter the confirmation legs')
})
