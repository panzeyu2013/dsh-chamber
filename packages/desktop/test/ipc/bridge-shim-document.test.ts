import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const shim = readFileSync(fileURLToPath(new URL('../../../../macos/Sources/DSHChamber/Resources/bridge-shim.js', import.meta.url)), 'utf8')
const TOKEN = '__DSH_CHAMBER_NATIVE_TOKEN__'

type KeyListener = (event: Record<string, unknown>) => void

interface PostedRequest {
  id: number
  documentId: string
  method: string
  payload?: unknown
}

function document(uuid: string) {
  const posted: PostedRequest[] = []
  const events: string[] = []
  /** 事件派发时刻的 posted 长度：证明「先派 sidecar-ready 事件、后开始 hydrate」。 */
  const eventPostedAt: number[] = []
  /** shim 的 console.error/warn 文案（loud 断言；不写真实 stdout 以免污染转录）。 */
  const errors: string[] = []
  const warnings: string[] = []
  const listeners = new Map<string, Set<KeyListener>>()
  const documentElement: { dataset: Record<string, string> } = { dataset: {} }
  let uuidCalls = 0
  const window = {
    // 每次调用返回新值（真实 crypto.randomUUID 语义）：revision/documentId
    // 都必须逐次变化，测试才能观察到换代。
    crypto: { randomUUID: () => `${uuid}-${uuidCalls++}` },
    webkit: { messageHandlers: { dshChamber: { postMessage: (value: PostedRequest) => posted.push(value) } } },
    dispatchEvent: (event: { type: string }) => {
      events.push(event.type)
      eventPostedAt.push(posted.length)
      return true
    },
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
    console: {
      log: () => {},
      warn: (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) },
      error: (...args: unknown[]) => { errors.push(args.map(String).join(' ')) },
    },
    setTimeout,
    clearTimeout,
  })
  const dispatch = (type: string, event: Record<string, unknown>): void => {
    for (const listener of listeners.get(type) ?? []) listener(event)
  }
  return { window, posted, events, eventPostedAt, errors, warnings, documentElement, dispatch }
}

/** vm 上下文对象的原型与宿主不同：deepStrictEqual 前先归一为纯数据。 */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

/** 微任务冲刷：promise 链（invoke → then → hydrate）逐级落地。 */
async function flush(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

/** 有界等待（真实定时器：not-ready 的 200ms 有界重试需要它）。 */
async function waitFor<T>(read: () => T | undefined, timeoutMs = 4000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('bridge-shim test: timed out waiting for a request')
    await new Promise((resolve) => { setTimeout(resolve, 20) })
  }
}

function reply(page: ReturnType<typeof document>, request: PostedRequest, result: unknown, err: string | null = null): void {
  const resolve = page.window.__dshChamberResolve as (...args: unknown[]) => void
  resolve(TOKEN, request.documentId, request.id, result, err)
}

function requests(page: ReturnType<typeof document>, method: string): PostedRequest[] {
  return page.posted.filter((request) => request.method === method)
}

function lastRequest(page: ReturnType<typeof document>, method: string): PostedRequest | undefined {
  return requests(page, method).at(-1)
}

/** 冷/热启动的 A 桥握手：info 成功（= 桥就绪 → hydrate 起点）→ 回 settings-get。 */
async function boot(
  page: ReturnType<typeof document>,
  settings: { shortcutsDocument?: string } = {},
): Promise<{ info: PostedRequest; settingsGet: PostedRequest }> {
  const info = page.posted[0]
  assert.ok(info !== undefined && info.method === 'dsh-chamber:info', '首条 invoke 必须是 info 握手')
  reply(page, info, { platform: 'darwin' })
  await flush()
  const settingsRequest = await waitFor(() => lastRequest(page, 'dsh-chamber:settings-get'))
  reply(page, settingsRequest, { settings })
  await flush()
  return { info, settingsGet: settingsRequest }
}

function carrierOf(page: ReturnType<typeof document>) {
  return page.window.dshDesktop as {
    shortcuts: {
      get(definitions: readonly unknown[]): Promise<{ revision: string; sequence: number; status: string; error: string | null; usingDefaults: boolean; document: unknown }>
      edit(edit: unknown, revision: string): Promise<{ status: string; snapshot: { revision: string; usingDefaults: boolean; document: unknown; status: string } }>
    }
    keyboard: { closeWindow(revision: string): Promise<void> }
  }
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

test('dshDesktop.deviceInfo reads the info payload on demand (item 71, Swift flavor)', async () => {
  const page = document('2c9e6a55-1f3d-4c56-9a09-8c7f6b5d4e31')
  const resolve = page.window.__dshChamberResolve as (...args: unknown[]) => void
  // Boot hydration settles the bridge first (the carrier is already installed).
  resolve(TOKEN, page.posted[0]?.documentId, 1, { platform: 'darwin' }, null)
  await Promise.resolve()
  const carrier = page.window.dshDesktop as { deviceInfo?: () => Promise<string> }
  const deviceInfo = carrier.deviceInfo
  assert.ok(typeof deviceInfo === 'function', 'the Swift carrier must expose deviceInfo')
  const pending = deviceInfo()
  const request = page.posted.at(-1)
  assert.equal(request?.method, 'dsh-chamber:info', 'deviceInfo must reuse the info channel')
  const description = 'platform=darwin; os=26.0.1; app_arch=arm64; cpu=Apple M5 Pro; memory_gib=36.0'
  resolve(TOKEN, request?.documentId, request?.id, { deviceInfo: description }, null)
  assert.equal(await pending, description)
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

/** 合法持久文档：一个 profile 覆盖（试探 hydrate 装入 + 编辑候选合并）。 */
const PERSISTED_DOCUMENT = { schemaVersion: 2, profiles: { 'desktop:macos': { 'test.open': { code: 'KeyK', modifiers: ['meta'] } } } }
const PERSISTED_TEXT = JSON.stringify(PERSISTED_DOCUMENT)

test('hydrate 只在就绪后开始：ready 事件之后才 settings-get；未就绪时 get() 如实 loading 且 posted[0] 仍是 info', async () => {
  const page = document('6f1f6a01-1111-4a01-9c01-000000000001')
  assert.equal(page.posted[0]?.method, 'dsh-chamber:info', '首条 invoke 必须是 info 握手')
  const carrier = carrierOf(page)
  const snapshot = await carrier.shortcuts.get([])
  assert.equal(snapshot.status, 'loading', '未就绪：如实 loading，不伪造 ready（更不触发 default 写入）')
  assert.equal(requests(page, 'dsh-chamber:settings-get').length, 0, 'get() 在未就绪时不得触发 hydrate')
  const sidecarReady = page.window.__dshChamberSidecarReady as (token: string) => void
  sidecarReady(TOKEN)
  assert.deepEqual(page.events, ['dsh-chamber:sidecar-ready'])
  // 事件派发时刻 posted 只有 info：hydrate 的 settings-get 在事件之后才出现。
  assert.equal(page.eventPostedAt[0], 1, 'sidecar-ready 事件先于 hydrate 的 settings-get')
  const request = await waitFor(() => lastRequest(page, 'dsh-chamber:settings-get'))
  assert.ok(request !== undefined)
  assert.ok(page.posted.indexOf(request) > 0, 'hydrate 不改变首条握手（posted[0] 仍 info）')
  assert.equal(page.posted[0]?.method, 'dsh-chamber:info')
})

test('冷启动（info 首次成功 = 桥已就绪）也触发 hydrate：sidecar-ready 事件已随上一份文档丢失', async () => {
  const page = document('6f1f6a01-2222-4a02-9c02-000000000002')
  const { settingsGet } = await boot(page, { shortcutsDocument: PERSISTED_TEXT })
  assert.deepEqual(settingsGet.payload, null)
  const carrier = carrierOf(page)
  const snapshot = await carrier.shortcuts.get([])
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.usingDefaults, false)
  assert.deepEqual(plain(snapshot.document), PERSISTED_DOCUMENT)
})

test('重启恢复：新文档从 settings-get 装入持久文档，编辑候选合并进同一 profile', async () => {
  const page = document('6f1f6a01-3333-4a03-9c03-000000000003')
  await boot(page, { shortcutsDocument: PERSISTED_TEXT })
  const carrier = carrierOf(page)
  const snapshot = await carrier.shortcuts.get([])
  assert.equal(snapshot.status, 'ready')
  const saved = carrier.shortcuts.edit({ type: 'set', id: 'test.close', binding: null }, snapshot.revision)
  const write = await waitFor(() => lastRequest(page, 'dsh-chamber:settings-set'))
  const candidate = JSON.parse((write.payload as { patch: { shortcutsDocument: string } }).patch.shortcutsDocument)
  assert.deepEqual(candidate, {
    schemaVersion: 2,
    profiles: { 'desktop:macos': { 'test.open': { code: 'KeyK', modifiers: ['meta'] }, 'test.close': null } },
  }, '写盘载荷 = 原始 JSON 文本（合并后的完整候选文档）')
  reply(page, write, { settings: {} })
  const result = await saved
  assert.equal(result.status, 'saved')
  assert.notEqual(result.snapshot.revision, snapshot.revision)
})

test('not-ready 属于可重试分类：有界重试后成功恢复（不回落默认、不写盘）', async () => {
  const page = document('6f1f6a01-4444-4a04-9c04-000000000004')
  reply(page, page.posted[0]!, { platform: 'darwin' })
  const first = await waitFor(() => lastRequest(page, 'dsh-chamber:settings-get'))
  reply(page, first!, null, 'ipc_not_ready')
  const retried = await waitFor(() => {
    const list = requests(page, 'dsh-chamber:settings-get')
    return list.length >= 2 ? list.at(-1) : undefined
  })
  assert.notEqual(retried.id, first!.id, 'not-ready 必须发起下一次 settings-get')
  reply(page, retried, { settings: { shortcutsDocument: PERSISTED_TEXT } })
  await flush()
  const snapshot = await carrierOf(page).shortcuts.get([])
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.usingDefaults, false)
  assert.equal(page.errors.length, 0, '一次 not-ready 重试不产生 loud 错误')
})

test('not-ready 重试耗尽 → unreadable(read) + loud；编辑 write-failed 且绝不写盘', async () => {
  const page = document('6f1f6a01-5555-4a05-9c05-000000000005')
  reply(page, page.posted[0]!, { platform: 'darwin' })
  let request = await waitFor(() => lastRequest(page, 'dsh-chamber:settings-get'))
  for (let attempt = 0; attempt < 5; attempt += 1) {
    reply(page, request, null, 'ipc_not_ready')
    if (attempt === 4) break
    const seen = attempt + 2
    request = await waitFor(() => {
      const list = requests(page, 'dsh-chamber:settings-get')
      return list.length >= seen ? list.at(-1) : undefined
    })
  }
  await flush()
  assert.equal(page.errors.length, 1, '耗尽后必须 loud（一次）')
  assert.match(page.errors[0]!, /快捷键偏好读取失败/)
  const carrier = carrierOf(page)
  const snapshot = await carrier.shortcuts.get([])
  assert.equal(snapshot.status, 'unreadable')
  assert.equal(snapshot.error, 'read')
  const result = await carrier.shortcuts.edit({ type: 'set', id: 'test.open', binding: null }, snapshot.revision)
  assert.equal(result.status, 'write-failed')
  assert.equal(requests(page, 'dsh-chamber:settings-set').length, 0, '未 hydrate 的编辑绝不写盘')
})

test('invalid/future 持久文档 → unreadable（保留默认、原文不覆盖、loud）', async () => {
  const cases: Array<[string, 'invalid' | 'future']> = [
    ['not json', 'invalid'],
    [JSON.stringify({ schemaVersion: 1, profiles: [] }), 'invalid'],
    [JSON.stringify({ schemaVersion: 3, profiles: {} }), 'future'],
    // 与上游 parseShortcutDocument 同严格（P08 Round2）：顶层未知键 / 未知 profile /
    // 非法 command id / 非法 binding 字形 / v1 chord 全部判 invalid。
    [JSON.stringify({ schemaVersion: 2, profiles: {}, extra: true }), 'invalid'],
    [JSON.stringify({ schemaVersion: 2, profiles: { 'mobile:ios': {} } }), 'invalid'],
    [JSON.stringify({ schemaVersion: 2, profiles: { 'desktop:macos': [] } }), 'invalid'],
    [JSON.stringify({ schemaVersion: 2, profiles: { 'desktop:macos': { 'Bad Id': null } } }), 'invalid'],
    [JSON.stringify({ schemaVersion: 2, profiles: { 'desktop:macos': { 'test.open': { code: 'KeyK', modifiers: ['hyper'] } } } }), 'invalid'],
    [JSON.stringify({ schemaVersion: 2, profiles: { 'desktop:macos': { 'test.open': { code: 'KeyK', modifiers: [], junk: 1 } } } }), 'invalid'],
    [JSON.stringify({ schemaVersion: 1, profiles: { 'desktop:macos': { 'test.open': { code: 'KeyK', secondCode: 'KeyO', modifiers: ['meta'] } } } }), 'invalid'],
  ]
  for (const [raw, expected] of cases) {
    const page = document('6f1f6a01-6666-4a06-9c06-000000000006')
    await boot(page, { shortcutsDocument: raw })
    const carrier = carrierOf(page)
    const snapshot = await carrier.shortcuts.get([])
    assert.equal(snapshot.status, 'unreadable', raw)
    assert.equal(snapshot.error, expected, raw)
    assert.equal(snapshot.usingDefaults, true)
    assert.deepEqual(plain(snapshot.document), { schemaVersion: 1, profiles: {} }, '保留默认文档')
    assert.equal(page.errors.length, 1, '不可读必须 loud')
    const result = await carrier.shortcuts.edit({ type: 'set', id: 'test.open', binding: null }, snapshot.revision)
    assert.equal(result.status, 'write-failed')
    assert.equal(requests(page, 'dsh-chamber:settings-set').length, 0, '坏/未来文档绝不被覆盖')
  }
})

test('严格镜像上游 parseShortcutDocument：合法 null binding 仍 ready，未知键/坏字形不装入', async () => {
  const okPage = document('6f1f6a01-6667-4a07-9c07-000000000007')
  await boot(okPage, {
    shortcutsDocument: JSON.stringify({ schemaVersion: 2, profiles: { 'desktop:macos': { 'test.open': null } } }),
  })
  const okCarrier = carrierOf(okPage)
  const okSnapshot = await okCarrier.shortcuts.get([])
  assert.equal(okSnapshot.status, 'ready', '显式解绑（null）是合法文档')
  assert.deepEqual(plain(okSnapshot.document), { schemaVersion: 2, profiles: { 'desktop:macos': { 'test.open': null } } })
})

test('edit 候选写前同严格校验：坏 binding 不落盘（write-failed、零 settings-set）', async () => {
  const page = document('6f1f6a01-6669-4a09-9c09-000000000009')
  await boot(page, { shortcutsDocument: PERSISTED_TEXT })
  const carrier = carrierOf(page)
  const before = await carrier.shortcuts.get([])
  const attempts = [
    { code: 'NotAKey', modifiers: [] },
    { code: 'KeyK', modifiers: ['hyper'] },
    { code: 'KeyK', modifiers: [], junk: true },
  ]
  for (const binding of attempts) {
    const result = await carrier.shortcuts.edit({ type: 'set', id: 'test.open', binding }, before.revision)
    assert.equal(result.status, 'write-failed', JSON.stringify(binding))
  }
  assert.equal(requests(page, 'dsh-chamber:settings-set').length, 0, '非法候选绝不写盘')
})

test('并发 edit 串行化（镜像上游 serialize）：同 revision 第二笔 stale，不丢更新', async () => {
  const page = document('6f1f6a01-666a-4a0a-9c0a-00000000000a')
  await boot(page, { shortcutsDocument: PERSISTED_TEXT })
  const carrier = carrierOf(page)
  const before = await carrier.shortcuts.get([])
  const first = carrier.shortcuts.edit({ type: 'set', id: 'test.open', binding: null }, before.revision)
  const second = carrier.shortcuts.edit({ type: 'set', id: 'test.close', binding: null }, before.revision)
  const write = await waitFor(() => lastRequest(page, 'dsh-chamber:settings-set'))
  reply(page, write, { ok: true })
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.status, 'saved')
  assert.equal(secondResult.status, 'stale', '同 revision 的后到请求在队内重判为 stale，绝不覆盖已提交文档')
  assert.equal(requests(page, 'dsh-chamber:settings-set').length, 1, '串行队列只落一次盘')
  const after = await carrier.shortcuts.get([])
  assert.deepEqual(plain(after.document), {
    schemaVersion: 2,
    profiles: { 'desktop:macos': { 'test.open': null } },
  }, '已提交的第一笔不被后到请求覆盖')
})

test('A 桥 info 全败：shortcuts 落 unreadable(read) 而非永久 loading（不覆盖任何文档）', async () => {
  const page = document('6f1f6a01-6668-4a08-9c08-000000000008')
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const request = page.posted[attempt]
    assert.equal(request?.method, 'dsh-chamber:info', '仅 info 握手重试，不得先发 hydrate 请求')
    reply(page, request!, null, 'bridge not ready')
    // 让下一轮 50ms 重试排上（最后一次不再重试）。
    if (attempt < 10) await new Promise(resolve => setTimeout(resolve, 70))
  }
  await flush()
  const carrier = carrierOf(page)
  const snapshot = await carrier.shortcuts.get([])
  assert.equal(snapshot.status, 'unreadable')
  assert.equal(snapshot.error, 'read')
  assert.equal(requests(page, 'dsh-chamber:settings-get').length, 0, 'info 不可用时不发 settings-get')
})

test('写失败（{error} 结果）→ write-failed 且不提交内存（文档/usingDefaults/revision 都不动）', async () => {
  const page = document('6f1f6a01-7777-4a07-9c07-000000000007')
  await boot(page, { shortcutsDocument: PERSISTED_TEXT })
  const carrier = carrierOf(page)
  const before = await carrier.shortcuts.get([])
  const saving = carrier.shortcuts.edit({ type: 'set', id: 'test.close', binding: null }, before.revision)
  const write = await waitFor(() => lastRequest(page, 'dsh-chamber:settings-set'))
  reply(page, write, { error: 'settings persist failed' })
  const result = await saving
  assert.equal(result.status, 'write-failed')
  assert.match(page.errors.join('\n'), /快捷键偏好写入失败/)
  assert.equal(page.errors.length, 1)
  assert.deepEqual(result.snapshot.document, before.document, '失败不提交候选文档')
  assert.equal(result.snapshot.usingDefaults, false)
  const after = await carrier.shortcuts.get([])
  assert.deepEqual(after.document, before.document, '内存文档保持旧值（上次接受的文档）')
})

test('写请求 reject（桥拒绝）→ write-failed 且不提交内存', async () => {
  const page = document('6f1f6a01-8888-4a08-9c08-000000000008')
  await boot(page, { shortcutsDocument: PERSISTED_TEXT })
  const carrier = carrierOf(page)
  const before = await carrier.shortcuts.get([])
  const saving = carrier.shortcuts.edit({ type: 'set', id: 'test.close', binding: null }, before.revision)
  const write = await waitFor(() => lastRequest(page, 'dsh-chamber:settings-set'))
  reply(page, write, null, 'ipc_not_ready')
  const result = await saving
  assert.equal(result.status, 'write-failed')
  const after = await carrier.shortcuts.get([])
  assert.deepEqual(after.document, before.document)
})

test('dshDesktop.shortcuts is a real session transaction; closeWindow is honest about the missing channel', async () => {
  const page = document('93b1c2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d')
  await boot(page)
  const carrier = carrierOf(page)
  const snapshot = await carrier.shortcuts.get([])
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.usingDefaults, true)
  const saving = carrier.shortcuts.edit({ type: 'set', id: 'test.open', binding: null }, snapshot.revision)
  const write = await waitFor(() => lastRequest(page, 'dsh-chamber:settings-set'))
  assert.deepEqual(JSON.parse((write.payload as { patch: { shortcutsDocument: string } }).patch.shortcutsDocument),
    { schemaVersion: 2, profiles: { 'desktop:macos': { 'test.open': null } } })
  reply(page, write, { settings: {} })
  const saved = await saving
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
