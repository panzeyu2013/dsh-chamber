import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const shim = readFileSync(fileURLToPath(new URL('../../../../macos/Sources/DSHChamber/Resources/bridge-shim.js', import.meta.url)), 'utf8')
const TOKEN = '__DSH_CHAMBER_NATIVE_TOKEN__'

type KeyListener = (event: Record<string, unknown>) => void

function document(uuid: string) {
  const posted: Array<{ id: number; documentId: string; method: string }> = []
  const events: string[] = []
  const listeners = new Map<string, Set<KeyListener>>()
  const documentElement: { dataset: Record<string, string> } = { dataset: {} }
  let uuidCalls = 0
  const window = {
    // 每次调用返回新值（真实 crypto.randomUUID 语义）：revision/documentId
    // 都必须逐次变化，测试才能观察到换代。
    crypto: { randomUUID: () => `${uuid}-${uuidCalls++}` },
    webkit: { messageHandlers: { dshChamber: { postMessage: (value: typeof posted[number]) => posted.push(value) } } },
    dispatchEvent: (event: { type: string }) => { events.push(event.type); return true },
    addEventListener: (type: string, listener: KeyListener) => {
      let set = listeners.get(type)
      if (set === undefined) { set = new Set(); listeners.set(type, set) }
      set.add(listener)
    },
    removeEventListener: (type: string, listener: KeyListener) => { listeners.get(type)?.delete(listener) },
  } as Record<string, unknown>
  const documentStub = {
    documentElement,
    addEventListener: () => {},
  }
  runInNewContext(shim, {
    window,
    document: documentStub,
    navigator: { platform: 'MacIntel' },
    Event: class { readonly type: string; constructor(type: string) { this.type = type } },
    console,
    setTimeout,
  })
  const dispatch = (type: string, event: Record<string, unknown>): void => {
    for (const listener of listeners.get(type) ?? []) listener(event)
  }
  return { window, posted, events, documentElement, dispatch }
}

/** 一次 keydown 事实（KeyboardEvent 子集；无 modifier 时 getModifierState 恒 false）。 */
function key(code: string, keyValue: string, modifiers: { meta?: boolean } = {}) {
  return {
    key: keyValue,
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: modifiers.meta === true,
    repeat: false,
    isComposing: false,
    getModifierState: () => false,
  }
}

test('a late reply from a prior document cannot settle a reused request id', async () => {
  const old = document('eaf2edfe-7318-46c8-96b9-e9ff421e63d9')
  const fresh = document('f93f9692-6b76-4dd7-b84d-2d42513199d6')
  assert.equal(old.posted[0]?.id, 1)
  assert.equal(fresh.posted[0]?.id, 1)
  assert.notEqual(old.posted[0]?.documentId, fresh.posted[0]?.documentId)
  const resolve = fresh.window.__dshChamberResolve as (...args: unknown[]) => void
  resolve(TOKEN, old.posted[0]?.documentId, 1, { platform: 'wrong' }, null)
  await Promise.resolve()
  assert.equal(fresh.window.dshChamber, undefined)
  resolve(TOKEN, fresh.posted[0]?.documentId, 1, { platform: 'darwin' }, null)
  await Promise.resolve()
  assert.equal((fresh.window.dshChamber as unknown as { platform?: string })?.platform, 'darwin')
})

test('sidecar reset rejects pending invokes and ready announces a new handshake', async () => {
  const page = document('b4d4af79-427b-4d15-af44-3f92d7b6cb9e')
  const resolve = page.window.__dshChamberResolve as (...args: unknown[]) => void
  resolve(TOKEN, page.posted[0]?.documentId, 1, { platform: 'darwin' }, null)
  await Promise.resolve()
  const ready = (page.window.dshChamber as { notifications: { ready(): Promise<unknown> } }).notifications.ready()
  assert.equal(page.posted.at(-1)?.method, 'dsh-chamber:notifications-ready')
  const reset = page.window.__dshChamberBridgeReset as (token: string) => void
  reset(TOKEN)
  await assert.rejects(ready, /bridge not ready/)
  const sidecarReady = page.window.__dshChamberSidecarReady as (token: string) => void
  sidecarReady(TOKEN)
  assert.deepEqual(page.events, ['dsh-chamber:sidecar-ready'])
})

test('dshDesktop carrier exists at documentStart with the platform mark', () => {
  const page = document('0f2f2f9c-6d63-4b5f-8c1a-1b7f9e8a4d21')
  const carrier = page.window.dshDesktop as {
    protocolVersion: number
    keyboard: { subscribe(l: KeyListener): () => void }
    shortcuts: { get(definitions: readonly unknown[]): Promise<{ revision: string }> }
  }
  assert.equal(carrier.protocolVersion, 1)
  assert.equal(typeof carrier.keyboard.subscribe, 'function')
  assert.equal(typeof carrier.shortcuts.get, 'function')
  assert.equal(page.documentElement.dataset.platform, 'darwin')
  const descriptor = Object.getOwnPropertyDescriptor(page.window, 'dshDesktop')
  assert.equal(descriptor?.configurable, false)
})

test('dshDesktop.keyboard delivers normalized DOM keydown with the shortcuts revision', async () => {
  const page = document('71c9d4e5-2a3b-4c5d-8e9f-0a1b2c3d4e5f')
  const carrier = page.window.dshDesktop as {
    keyboard: { subscribe(l: (input: Record<string, unknown>) => void): () => void }
    shortcuts: { get(definitions: readonly unknown[]): Promise<{ revision: string }> }
  }
  const snapshot = await carrier.shortcuts.get([])
  const received: Array<Record<string, unknown>> = []
  const off = carrier.keyboard.subscribe((input) => received.push(input))
  page.dispatch('keydown', key('KeyK', 'k', { meta: true }))
  assert.equal(received.length, 1)
  assert.equal(received[0].revision, snapshot.revision)
  assert.equal(received[0].kind, 'keyboard')
  assert.equal(received[0].frameName, '')
  assert.equal(received[0].code, 'KeyK')
  assert.equal(received[0].meta, true)
  // chord：keyup 只维护 held 状态，第二键的 keydown 带 secondCode。
  page.dispatch('keydown', key('KeyO', 'o', { meta: true }))
  assert.equal(received.length, 2)
  assert.equal(received[1].code, 'KeyK')
  assert.equal(received[1].secondCode, 'KeyO')
  page.dispatch('keyup', key('KeyO', 'o'))
  page.dispatch('keyup', key('KeyK', 'k'))
  off()
  page.dispatch('keydown', key('KeyK', 'k', { meta: true }))
  assert.equal(received.length, 2, '退订后不得再投递')
})

test('dshDesktop.shortcuts is a real session transaction; closeWindow is honest about the missing channel', async () => {
  const page = document('93b1c2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d')
  const carrier = page.window.dshDesktop as {
    keyboard: { closeWindow(revision: string): Promise<void> }
    shortcuts: {
      get(definitions: readonly unknown[]): Promise<{ revision: string; usingDefaults: boolean }>
      edit(edit: unknown, revision: string): Promise<{ status: string; snapshot: { revision: string; usingDefaults: boolean } }>
    }
  }
  const snapshot = await carrier.shortcuts.get([])
  assert.equal(snapshot.usingDefaults, true)
  const saved = await carrier.shortcuts.edit({ type: 'set', id: 'test.open', binding: null }, snapshot.revision)
  assert.equal(saved.status, 'saved')
  assert.equal(saved.snapshot.usingDefaults, false)
  assert.notEqual(saved.snapshot.revision, snapshot.revision)
  const stale = await carrier.shortcuts.edit({ type: 'reset-all' }, snapshot.revision)
  assert.equal(stale.status, 'stale')
  await assert.rejects(carrier.keyboard.closeWindow(saved.snapshot.revision),
    /native close channel/, '当前 revision 的关窗请求必须 loud（A 桥无 close 通道）')
  await assert.doesNotReject(carrier.keyboard.closeWindow('00000000-0000-4000-8000-000000000000'),
    '过期 revision 的关窗是静默 no-op（upstream 语义）')
})
