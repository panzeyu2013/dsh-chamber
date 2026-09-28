/**
 * 页面级多路复用通道（design 26）的生命周期锁。两个生产消费方
 * （renderer/src/api.ts、settings-connections/src/client/control-plane.ts）
 * 现在都靠它承载 host 健康流，所以这里在模块自己的 socket 接缝上钉住：
 *   - 整个页面一条 socket，每条订阅一个 subscribe 帧；
 *   - item 原样到达 onItem，credit ack 在分发返回之后回执；
 *   - socket 断开后重连，并重新订阅仍然存活的订阅；
 *   - close() 只退订自己的句柄，最后一条关闭时 socket 也关闭；
 *   - I-1 审计记录 EventSource 构造、保留原构造器的静态面；
 *   - 静态判据覆盖任何 EventSource 引用与流式 getReader，带正控语料与文件数下限；
 *   - socket 构造失败不留孤儿订阅、最后一条关闭后不留零订阅的重连、阶梯只在稳定运行后归零。
 *
 * 模块持有单例状态，且 WebSocket 工厂与重连时钟在 import 时就被捕获，所以每个用例
 * 先装 fake `globalThis.WebSocket` 再以 cache-busting query 做一次全新的动态 import
 * （page-schedule / evidence-log 的模块状态解法再往前一步：接缝在 import 时刻）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Dirent } from 'node:fs'

import {
  readEvidenceLog,
  resetEvidenceLogForTests,
} from '../../../dsh-chamber-client-core/src/evidence-log.ts'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import { PAGE_CHANNEL_MAX_FRAME_CHARS, PAGE_CHANNEL_PATH } from '../../../dsh-chamber-wire/src/page-channel.ts'

type PageChannelModule = typeof import('../../../dsh-chamber-client-core/src/page-channel.ts')

/** 一条 fake socket：记录通道发出的每个帧，并由测试驱动其生命周期事件。 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  static reset(): void {
    FakeWebSocket.instances = []
  }

  static latest(): FakeWebSocket {
    const instance = FakeWebSocket.instances.at(-1)
    assert.ok(instance !== undefined, '通道应当已经打开了一条 socket')
    return instance
  }

  readonly url: string
  readonly sent: string[] = []
  closed = false
  onopen: (() => void) | undefined
  onmessage: ((event: { data: unknown }) => void) | undefined
  onclose: ((event: { code?: number; reason?: string }) => void) | undefined
  onerror: (() => void) | undefined

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(text: string): void {
    this.sent.push(text)
  }

  close(): void {
    this.closed = true
  }

  /** 触发模块的 open 处理器（浏览器 socket 的真实行为）。 */
  open(): void {
    this.onopen?.()
  }

  /** 投递一个文本帧。 */
  message(text: string): void {
    this.onmessage?.({ data: text })
  }

  /** socket 掉线（默认 1006 异常关闭）。 */
  drop(code = 1006): void {
    this.onclose?.({ code, reason: '' })
  }

  /** 按发送顺序解析出的客户端帧。 */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map(text => JSON.parse(text) as Record<string, unknown>)
  }
}

interface GlobalHost {
  WebSocket?: unknown
  EventSource?: unknown
  location?: unknown
}

const globalHost = globalThis as unknown as GlobalHost
const hostDescriptors = {
  WebSocket: Object.getOwnPropertyDescriptor(globalThis, 'WebSocket'),
  EventSource: Object.getOwnPropertyDescriptor(globalThis, 'EventSource'),
  location: Object.getOwnPropertyDescriptor(globalThis, 'location'),
}

function defineHostProperty(name: 'WebSocket' | 'EventSource' | 'location', value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

function installFakeWebSocket(): void {
  FakeWebSocket.reset()
  defineHostProperty('WebSocket', FakeWebSocket)
  // 通道从页面 origin 推导绝对 ws URL：node 宿主没有 location，测试按浏览器形状补上。
  defineHostProperty('location', { href: 'http://localhost:17500/', protocol: 'http:' })
}

function restoreHost(): void {
  // 这里换上的抛错替身只覆盖**用例之间的空档**：它挡不住下一个用例 installFakeWebSocket()
  // 之后才开火的老定时器（那时全局已经是 FakeWebSocket，老模块会 new 出假 socket 污染
  // instances）。所以每个用例必须在 finally 关掉自己创建的每一条订阅——这是隔离的责任方，
  // 替身只是兜底（第三轮随机顺序实测：seed 5/17 的 flake 就来自两处漏关）。
  defineHostProperty('WebSocket', class { constructor() { throw new Error('stale test module') } })
  for (const name of ['EventSource', 'location'] as const) {
    const descriptor = hostDescriptors[name]
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name)
    else Object.defineProperty(globalThis, name, descriptor)
  }
}

let moduleCounter = 0

/**
 * 每个用例一个全新的模块实例：通道单例不得跨用例泄漏。模块自己用
 * `assertSingletonModule('page-channel')` 报告打包去重漂移——用例是**故意**重复求值的，
 * 所以先清掉登记，否则每个用例都会打一行（守卫只在真实构建里才有意义）。
 */
async function loadPageChannel(): Promise<PageChannelModule> {
  const registry = (globalThis as Record<symbol, unknown>)[Symbol.for('dsh-chamber.singleton.instances')] as Record<string, boolean> | undefined
  if (registry !== undefined) delete registry['page-channel']
  moduleCounter += 1
  const specifier = '../../../dsh-chamber-client-core/src/page-channel.ts?case=' + String(moduleCounter)
  return await import(specifier) as PageChannelModule
}

async function waitFor(condition: () => boolean, description: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) assert.fail('等待超时：' + description)
    await new Promise(resolve => { setTimeout(resolve, 10) })
  }
}

test('第一条订阅打开唯一的页面 socket 并发出 subscribe 帧', async () => {
  installFakeWebSocket()
  try {
    const mod = await loadPageChannel()
    const sub = mod.subscribePageChannel({ family: 'health', onItem: () => undefined })
    assert.equal(FakeWebSocket.instances.length, 1, '整个页面只打开一条通道 socket')
    const socket = FakeWebSocket.latest()
    assert.equal(socket.url, 'ws://localhost:17500' + PAGE_CHANNEL_PATH, '页面 origin 推导出的绝对 ws URL')
    assert.deepEqual(socket.frames(), [], 'socket 未就绪前不发订阅帧')
    socket.open()
    assert.deepEqual(socket.frames(), [{ type: 'subscribe', id: '1', family: 'health' }])
    sub.close()
  } finally {
    restoreHost()
  }
})

test('item 帧原样到达 onItem，credit ack 在分发返回之后回执', async () => {
  installFakeWebSocket()
  try {
    const mod = await loadPageChannel()
    const data = '{"dsh":{"status":"ready"},"健康":true}'
    const received: Array<{ event: string; data: string }> = []
    let ackAtDispatch = false
    const sub = mod.subscribePageChannel({
      family: 'health',
      onItem: (event, itemData) => {
        received.push({ event, data: itemData })
        ackAtDispatch = FakeWebSocket.latest().frames().some(frame => frame.type === 'ack')
      },
    })
    const socket = FakeWebSocket.latest()
    socket.open()
    socket.message(JSON.stringify({ type: 'item', id: '1', event: 'health', data }))
    assert.deepEqual(received, [{ event: 'health', data }])
    assert.equal(ackAtDispatch, false, 'ack 必须在 onItem 返回之后才发出')
    await waitFor(() => socket.frames().some(frame => frame.type === 'ack'), 'credit ack')
    assert.deepEqual(socket.frames().filter(frame => frame.type === 'ack'),
      [{ type: 'ack', id: '1', bytes: Buffer.byteLength(data, 'utf8') }],
      'credit 按 UTF-8 字节计，不是 UTF-16 code unit')
    sub.close()
  } finally {
    restoreHost()
  }
})

test('socket 关闭后重连并重新订阅仍然存活的订阅', async () => {
  installFakeWebSocket()
  try {
    const mod = await loadPageChannel()
    const received: string[] = []
    const sub = mod.subscribePageChannel({
      family: 'health',
      onItem: (_event, data) => { received.push(data) },
    })
    const first = FakeWebSocket.latest()
    first.open()
    assert.deepEqual(first.frames(), [{ type: 'subscribe', id: '1', family: 'health' }])
    first.drop(1006)
    await waitFor(() => FakeWebSocket.instances.length === 2, '重连的新 socket')
    const second = FakeWebSocket.latest()
    assert.equal(second.closed, false)
    second.open()
    assert.deepEqual(second.frames(), [{ type: 'subscribe', id: '1', family: 'health' }],
      '通道重连后订阅必须重新发出，消费方不排自己的阶梯')
    second.message(JSON.stringify({ type: 'item', id: '1', event: 'health', data: 'again' }))
    await waitFor(() => received.length === 1, '重连后的 item')
    assert.deepEqual(received, ['again'])
    sub.close()
  } finally {
    restoreHost()
  }
})

test('close() 只退订自己的订阅，最后一条关闭 socket', async () => {
  installFakeWebSocket()
  try {
    const mod = await loadPageChannel()
    const first = mod.subscribePageChannel({ family: 'health', onItem: () => undefined })
    const second = mod.subscribePageChannel({ family: 'health', onItem: () => undefined })
    assert.equal(FakeWebSocket.instances.length, 1, '第二条订阅复用同一条 socket')
    const socket = FakeWebSocket.latest()
    socket.open()
    assert.deepEqual(socket.frames(), [
      { type: 'subscribe', id: '1', family: 'health' },
      { type: 'subscribe', id: '2', family: 'health' },
    ])
    first.close()
    assert.deepEqual(socket.frames().at(-1), { type: 'unsubscribe', id: '1' })
    assert.equal(socket.closed, false, '仍有订阅时通道保持打开')
    second.close()
    assert.deepEqual(socket.frames().at(-1), { type: 'unsubscribe', id: '2' })
    assert.equal(socket.closed, true, '最后一条订阅关闭时 socket 也关闭')
  } finally {
    restoreHost()
  }
})

test('I-1 审计：EventSource 构造被记账，原构造器的返回值与静态成员都不变', async () => {
  installFakeWebSocket()
  try {
    resetEvidenceLogForTests()
    const constructed: string[] = []
    class OriginalEventSource {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSED = 2
      readonly url: string
      constructor(url: string) { this.url = url; constructed.push(url) }
    }
    defineHostProperty('EventSource', OriginalEventSource)
    const mod = await loadPageChannel()
    assert.equal(mod.installPageChannelEventSourceAudit(), true, '装了要如实返回生效')
    const Audited = globalHost.EventSource as typeof OriginalEventSource
    const instance = new Audited('/api/legacy-stream')
    assert.equal(instance.url, '/api/legacy-stream', '审计必须委托原构造器，不吞不改返回值')
    assert.deepEqual(constructed, ['/api/legacy-stream'])
    // 类式替身能看见静态面：只改 .prototype 的实现会把 CONNECTING/OPEN/CLOSED 变成 undefined。
    assert.equal(Audited.OPEN, 1, '静态成员必须沿原型链仍可解析')
    assert.equal(Audited.CLOSED, 2)
    // 页面自身的构建违规不是来源观测：落账必须 booked=false（否则账本读起来像来源出过一次
    // 通道事实），但仍然入账 + warn，违规在审计面上可听可见。
    const violations = readEvidenceLog().filter(entry =>
      entry.owner === 'page-channel' && entry.detail.kind === 'eventsource-constructed')
    assert.equal(violations.length, 1, '构造一次记账一条')
    assert.equal(violations[0]?.booked, false, '页面构建违规不是来源事实：booked=false')
    assert.equal(violations[0]?.detail.url, '/api/legacy-stream')
  } finally {
    restoreHost()
  }
})

test('socket 构造器抛错不得逃进调用方，也不得留下无人认领的订阅', async () => {
  installFakeWebSocket()
  class FlakyWebSocket extends FakeWebSocket {
    static thrown = false
    constructor(url: string) {
      if (!FlakyWebSocket.thrown) { FlakyWebSocket.thrown = true; throw new Error('boom') }
      super(url)
    }
  }
  defineHostProperty('WebSocket', FlakyWebSocket)
  try {
    const mod = await loadPageChannel()
    const errors: string[] = []
    const first = mod.subscribePageChannel({
      family: 'health', onItem: () => undefined, onError: code => errors.push(code),
    })
    // 消费方回调一律异步到达（subscribe 返回前已置位的失败经微任务投递）：
    // 句柄形态的消费方只有拿到返回值才能绑 onerror，同步通知会丢掉唯一一条。
    await waitFor(() => errors.length === 1, '构造失败的异步通知', 1_000)
    assert.deepEqual(errors, ['channel_unavailable'], '构造失败按通道不可用如实通知，绝不把异常抛给调用方的 effect')
    first.close()
    const second = mod.subscribePageChannel({ family: 'health', onItem: () => undefined })
    await waitFor(() => FakeWebSocket.instances.length === 1, '第二次订阅打开 socket', 3_000)
    const socket = FakeWebSocket.latest()
    socket.open()
    assert.deepEqual(socket.frames(), [{ type: 'subscribe', id: '2', family: 'health' }],
      '只有第二条订阅出现在这条 socket 上：第一条（构造失败的那次）不得变成孤儿')
    second.close()
  } finally {
    restoreHost()
  }
})

test('最后一条订阅关闭后：待命的重连定时器被显式撤掉，且不得再打开 socket', async () => {
  installFakeWebSocket()
  // 定时器接缝：`deps.setTimeout/clearTimeout` 在调用时解析全局，所以这里包一层就能
  // 观察到「撤掉的是哪条定时器」——只断言「没再开 socket」会被回调里的零订阅再检查兜住，
  // 从而证明不了 clearTimeout 那一行（审计实测：删掉它用例仍绿）。
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const scheduled: unknown[] = []
  const cleared = new Set<unknown>()
  try {
    ;(globalThis as { setTimeout: unknown }).setTimeout = ((handler: () => void, ms: number) => {
      const handle = realSetTimeout(handler, ms)
      scheduled.push(handle)
      return handle
    }) as never
    ;(globalThis as { clearTimeout: unknown }).clearTimeout = ((handle: unknown) => {
      cleared.add(handle)
      realClearTimeout(handle as ReturnType<typeof realSetTimeout>)
    }) as never
    const mod = await loadPageChannel()
    const sub = mod.subscribePageChannel({ family: 'health', onItem: () => undefined })
    const socket = FakeWebSocket.latest()
    socket.open()
    socket.drop(1006)
    const ladder = scheduled.at(-1)
    assert.notEqual(ladder, undefined, '断线必须排一条重连阶梯定时器')
    sub.close()
    assert.equal(cleared.has(ladder), true,
      '最后一条关闭必须**显式**撤掉待命的重连定时器（回调里的零订阅再检查是二道保险，不能替代它）')
    await new Promise(resolve => { realSetTimeout(resolve, 1_600) })
    assert.equal(FakeWebSocket.instances.length, 1, '关闭后不得再有 socket 被重连出来（零订阅的长连接是纯泄漏）')
  } finally {
    ;(globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout
    ;(globalThis as { clearTimeout: unknown }).clearTimeout = realClearTimeout
    restoreHost()
  }
})

test('阶梯只在稳定运行后归零：accept-then-close 的对端不得把重连停在最快档', async () => {
  installFakeWebSocket()
  try {
    const mod = await loadPageChannel()
    const sub = mod.subscribePageChannel({ family: 'health', onItem: () => undefined })
    FakeWebSocket.latest().open()
    const firstDrop = Date.now()
    FakeWebSocket.latest().drop(1006)
    await waitFor(() => FakeWebSocket.instances.length === 2, '第一次重连', 2_500)
    const secondAt = Date.now()
    FakeWebSocket.latest().open()
    FakeWebSocket.latest().drop(1006)
    const secondDrop = Date.now()
    await waitFor(() => FakeWebSocket.instances.length === 3, '第二次重连', 4_000)
    const thirdAt = Date.now()
    assert.ok(secondAt - firstDrop >= 900, '第一档是 1s 级：' + String(secondAt - firstDrop) + 'ms')
    assert.ok(thirdAt - secondDrop >= 1_800,
      '没有稳定运行的连接必须升档，第二次至少 2s 级：' + String(thirdAt - secondDrop) + 'ms')
    sub.close()
  } finally {
    restoreHost()
  }
})

test('握手期限：期限内没有 open 的 socket 被主动退役并按阶梯重连，不假设宿主派发 close', async () => {
  installFakeWebSocket()
  try {
    const mod = await loadPageChannel()
    const errors: string[] = []
    const sub = mod.subscribePageChannel({
      family: 'health',
      onItem: () => undefined,
      onError: code => { errors.push(code) },
    })
    const stuck = FakeWebSocket.latest()
    assert.deepEqual(stuck.frames(), [], '握手未完成前一个帧都不发')
    // 不调用 stuck.drop()：宿主不为 abort 掉的 CONNECTING socket 派发 close，
    // 有界性必须来自通道自己（这里同时验证了退役 → 阶梯 → 新连接 → 重新订阅）。
    await waitFor(() => stuck.closed, '建连期限到期后关闭未握手的 socket', 5_000)
    assert.deepEqual(errors, [], '握手超时不冒充订阅失败（可见性由消费方看门狗负责）')
    await waitFor(() => FakeWebSocket.instances.length === 2, '阶梯重连开出新 socket', 4_000)
    FakeWebSocket.latest().open()
    const frames = FakeWebSocket.latest().frames()
    assert.equal(frames.length, 1)
    assert.equal(frames[0]?.type, 'subscribe')
    assert.equal(frames[0]?.family, 'health')
    sub.close()
  } finally {
    restoreHost()
  }
})

test('onItem 抛错仍然确认信用，且不影响同一条 socket 上的其他订阅', async () => {
  installFakeWebSocket()
  try {
    const mod = await loadPageChannel()
    const received: string[] = []
    const subA = mod.subscribePageChannel({
      family: 'pluginGraph', instanceId: 'dsh-a', onItem: () => { throw new Error('consumer bug') },
    })
    const subB = mod.subscribePageChannel({
      family: 'pluginGraph', instanceId: 'dsh-b', onItem: (event, data) => received.push(event + ':' + data),
    })
    const socket = FakeWebSocket.latest()
    socket.open()
    socket.message(JSON.stringify({ type: 'item', id: '1', event: 'graph', data: 'abc' }))
    socket.message(JSON.stringify({ type: 'item', id: '2', event: 'graph', data: 'xyz' }))
    await new Promise(resolve => { setTimeout(resolve, 10) })
    assert.ok(socket.frames().some(frame => frame.type === 'ack' && frame.id === '1' && frame.bytes === 3),
      '抛错的处理器必须照样回执，否则信用窗口被永久卡住')
    assert.deepEqual(received, ['graph:xyz'], '兄弟订阅不受影响')
    subA.close(); subB.close()
  } finally {
    restoreHost()
  }
})

test('重连只重新订阅仍然存活的订阅', async () => {
  installFakeWebSocket()
  try {
    const mod = await loadPageChannel()
    const subA = mod.subscribePageChannel({ family: 'pluginGraph', instanceId: 'dsh-a', onItem: () => undefined })
    const subB = mod.subscribePageChannel({ family: 'pluginGraph', instanceId: 'dsh-b', onItem: () => undefined })
    FakeWebSocket.latest().open()
    subB.close()
    FakeWebSocket.latest().drop(1006)
    await waitFor(() => FakeWebSocket.instances.length === 2, '重连', 2_500)
    const socket = FakeWebSocket.latest()
    socket.open()
    assert.deepEqual(socket.frames(), [{ type: 'subscribe', id: '1', family: 'pluginGraph', instanceId: 'dsh-a' }],
      '已关闭的订阅不得复活')
    subA.close()
  } finally {
    restoreHost()
  }
})

test('服务端非法帧被忽略，socket 仍然可用', async () => {
  installFakeWebSocket()
  try {
    const mod = await loadPageChannel()
    const received: string[] = []
    const sub = mod.subscribePageChannel({ family: 'health', onItem: (_event, data) => received.push(data) })
    const socket = FakeWebSocket.latest()
    socket.open()
    socket.message('{not json')
    socket.message(JSON.stringify({ type: 'nope', id: '1' }))
    socket.message(JSON.stringify({ type: 'item', id: '1', event: 'message', data: '{"ok":true}' }))
    assert.deepEqual(received, ['{"ok":true}'], '坏帧之后通道仍然照常投递')
    sub.close()
  } finally {
    restoreHost()
  }
})

test('capability_not_found 不重试；瞬时错误按阶梯重订阅', async () => {
  installFakeWebSocket()
  try {
    const mod = await loadPageChannel()
    const sub = mod.subscribePageChannel({ family: 'sessionFacts', instanceId: 'dsh-x', onItem: () => undefined })
    const socket = FakeWebSocket.latest()
    socket.open()
    socket.message(JSON.stringify({ type: 'error', id: '1', code: 'capability_not_found', message: 'non-gateway' }))
    // 缺席窗必须显著长于「阶梯第一档 3s + ≤25% 抖动」= 3.75s：3.4s 时坏实现只有约
    // 一半概率被抓到（审计实测 5 次 3 红 2 绿），回归检出不能靠掷硬币。
    await new Promise(resolve => { setTimeout(resolve, 5_600) })
    const subscribes = () => socket.frames().filter(frame => frame.type === 'subscribe').length
    assert.equal(subscribes(), 1, '永久性错配不得每 30s 重试一次')
    socket.message(JSON.stringify({ type: 'error', id: '1', code: 'upstream_failed', message: 'boom' }))
    await waitFor(() => subscribes() === 2, '瞬时错误重订阅', 4_500)
    sub.close()
  } finally {
    restoreHost()
  }
})

test('页面 origin 为 https 时通道派生 wss://（同一 origin，不得硬编码 ws）', async () => {
  installFakeWebSocket()
  let sub: { close(): void } | undefined
  try {
    defineHostProperty('location', { href: 'https://chamber.example/', protocol: 'https:' })
    const mod = await loadPageChannel()
    sub = mod.subscribePageChannel({ family: 'health', onItem: () => undefined })
    const url = FakeWebSocket.latest().url
    assert.ok(url.startsWith('wss://chamber.example'), 'https 页面必须得到 wss://，实际 ' + url)
    assert.ok(url.endsWith(PAGE_CHANNEL_PATH), '路径仍是唯一的页面通道端点')
  } finally {
    // 句柄必须在 finally 关：遗弃的模块会继续按阶梯 `new` 全局 WebSocket，而下一个用例
    // 装回 FakeWebSocket —— 跨用例污染在声明顺序下不可见，随机顺序下会撕掉别的用例
    //（第三轮 flake 实证：seed 5/17）。
    sub?.close()
    restoreHost()
  }
})

test('ready 才触发 onOpen：socket 打开与 item 都不算，重连后的新 ready 再触发一次', async () => {
  installFakeWebSocket()
  try {
    const mod = await loadPageChannel()
    let opens = 0
    const sub = mod.subscribePageChannel({
      family: 'health', onItem: () => undefined, onOpen: () => { opens += 1 },
    })
    const socket = FakeWebSocket.latest()
    socket.open()
    assert.equal(opens, 0, 'socket 握手完成不等于 ready')
    socket.message(JSON.stringify({ type: 'item', id: '1', event: 'message', data: 'x' }))
    assert.equal(opens, 0, 'item 不触发 onOpen')
    socket.message(JSON.stringify({ type: 'ready', id: '1' }))
    assert.equal(opens, 1, 'ready 恰好触发一次')
    socket.drop(1006)
    await waitFor(() => FakeWebSocket.instances.length === 2, '重连 socket', 3_000)
    const next = FakeWebSocket.latest()
    next.open()
    await waitFor(() => next.frames().some(frame => frame.type === 'subscribe'), '重连后重订阅', 1_000)
    next.message(JSON.stringify({ type: 'ready', id: '1' }))
    assert.equal(opens, 2, '重连后的新 ready 再触发一次')
    sub.close()
  } finally {
    restoreHost()
  }
})

test('超过帧上限的 host→client 帧整帧丢弃，订阅保持可用', async () => {
  installFakeWebSocket()
  try {
    const mod = await loadPageChannel()
    const items: string[] = []
    const sub = mod.subscribePageChannel({
      family: 'health', onItem: (_event, data) => { items.push(data) },
    })
    const socket = FakeWebSocket.latest()
    socket.open()
    socket.message(JSON.stringify({ type: 'ready', id: '1' }))
    // 超限帧必须整帧丢弃：半吞会把它当状态应用，静默黑洞则让消费方永远等不到这一条。
    socket.message(JSON.stringify({
      type: 'item', id: '1', event: 'message', data: 'x'.repeat(PAGE_CHANNEL_MAX_FRAME_CHARS + 1),
    }))
    socket.message(JSON.stringify({ type: 'item', id: '1', event: 'message', data: 'after' }))
    await waitFor(() => items.includes('after'), '超限帧之后的正常 item 仍要派发', 1_000)
    assert.deepEqual(items, ['after'], '超限帧整帧丢弃，绝不半吞或当状态应用')
    sub.close()
  } finally {
    restoreHost()
  }
})

test('已退役 socket 迟到的 close 不得取消当前 socket 的建连期限（挂起腿仍有界）', async () => {
  installFakeWebSocket()
  try {
    const mod = await loadPageChannel()
    const first = mod.subscribePageChannel({ family: 'health', onItem: () => undefined })
    const stale = FakeWebSocket.latest()
    first.close()
    assert.equal(stale.closed, true, '最后一条订阅关闭会关掉这条 socket')
    const second = mod.subscribePageChannel({ family: 'health', onItem: () => undefined })
    const current = FakeWebSocket.latest()
    assert.notEqual(current, stale)
    // 宿主把 abort 掉的 CONNECTING socket 的 close 事件迟到地派发出来：
    // 它属于**旧腿**，绝不能取消当前腿的 3s 建连期限。
    stale.drop(1006)
    await waitFor(() => current.closed, '当前腿仍被建连期限退役', 5_000)
    second.close()
  } finally {
    restoreHost()
  }
})

test('消费方回调一律异步到达：subscribe() 返回之前不得回调', async () => {
  Reflect.deleteProperty(globalThis, 'WebSocket')
  Reflect.deleteProperty(globalThis, 'location')
  let sub: { close(): void } | undefined
  try {
    const mod = await loadPageChannel()
    const errors: string[] = []
    sub = mod.subscribePageChannel({ family: 'health', onItem: () => undefined, onError: code => errors.push(code) })
    assert.deepEqual(errors, [], '调用方还没拿到句柄，回调不得先跑')
    await waitFor(() => errors.length === 1, '微任务投递的 channel_unavailable', 1_000)
  } finally {
    sub?.close()
    restoreHost()
  }
})

test('keepalive 判据是「名字 + 空 data」：带数据的同名事件不得被吞', async () => {
  const mod = await loadPageChannel()
  assert.equal(mod.isPageChannelKeepaliveItem('keepalive', ''), true)
  assert.equal(mod.isPageChannelKeepaliveItem('keepalive', '{"kind":"graph"}'), false,
    '只有协议生成的空 data keepalive 才是传输活性，真实事件不能被误吞')
  assert.equal(mod.isPageChannelKeepaliveItem('graph', ''), false)
  // 三个消费方必须用同一判据，不得各自只比名字。
  for (const file of [
    'packages/renderer/src/shell.ts',
    'packages/renderer/src/session-facts-source.ts',
    'packages/dsh-chamber-client-core/src/control-plane-client.ts',
  ]) {
    const source = stripComments(await readFile(join(REPO_ROOT, file), 'utf8'))
    assert.match(source, /isPageChannelKeepaliveItem\(/u, file + ' 必须用共享判据过滤 keepalive')
  }
})

test('消费方在 onItem 里关闭订阅：unsubscribe 之后不得再回执该订阅', async () => {
  installFakeWebSocket()
  try {
    const mod = await loadPageChannel()
    const big = 'x'.repeat(70 * 1024)
    const subA = mod.subscribePageChannel({
      family: 'pluginGraph', instanceId: 'dsh-a', onItem: () => { subA.close() },
    })
    const subB = mod.subscribePageChannel({ family: 'pluginGraph', instanceId: 'dsh-b', onItem: () => undefined })
    const socket = FakeWebSocket.latest()
    socket.open()
    socket.message(JSON.stringify({ type: 'item', id: '1', event: 'graph', data: big }))
    await new Promise(resolve => { setTimeout(resolve, 10) })
    const frames = socket.frames()
    assert.ok(frames.some(frame => frame.type === 'unsubscribe' && frame.id === '1'), '关闭必须发出 unsubscribe')
    assert.equal(frames.some(frame => frame.type === 'ack' && frame.id === '1'), false,
      '已关闭的订阅不得再回执（unsubscribe 之后的 ack 是协议噪声）')
    assert.ok(frames.some(frame => frame.type === 'subscribe' && frame.id === '2'), '兄弟订阅仍在')
    subB.close()
  } finally {
    restoreHost()
  }
})

test('socket 关闭时在 onError 里同步新建的订阅不得被同一轮关闭波及（快照迭代）', async () => {
  installFakeWebSocket()
  // 句柄声明在 try **外面**：finally 里要能关掉它们（块作用域里声明的 const 在 finally
  // 不可见——那会让 finally 自己抛 ReferenceError，反而把 leak 留在场上）。
  let first: { close(): void } | undefined
  let rebuiltHandle: { close(): void } | undefined
  try {
    const mod = await loadPageChannel()
    const events: string[] = []
    let rebuilt = false
    first = mod.subscribePageChannel({
      family: 'health',
      onItem: () => undefined,
      onError: code => {
        events.push('s1:' + code)
        if (rebuilt) return
        rebuilt = true
        // 真实形态：消费方在错误回调里**同步**重建句柄/重订阅。边遍历边回调的旧实现会让
        // 这个新订阅被这条旧 socket 的关闭波到，收到一条假的 channel_closed；重建型消费方
        // 更会同步扇出（一条关闭 → 无限条通知）。
        rebuiltHandle = mod.subscribePageChannel({
          family: 'health',
          onItem: () => undefined,
          onError: code2 => events.push('s2:' + code2),
        })
      },
    })
    const socket = FakeWebSocket.latest()
    socket.open()
    await waitFor(() => socket.frames().some(frame => frame.type === 'subscribe'), '首条订阅', 1_000)
    socket.drop()
    await waitFor(() => events.length >= 1, '关闭通知', 1_000)
    assert.deepEqual(events, ['s1:channel_closed'], '新建的订阅绝不继承旧 socket 的关闭')
    assert.equal(FakeWebSocket.instances.length, 2, '重建的订阅拿到自己的 socket')
  } finally {
    // 重建的订阅也必须关：它留在订阅表里就会一直排阶梯，把跨用例的假 socket 污染给下一个用例。
    rebuiltHandle?.close()
    first?.close()
    restoreHost()
  }
})

test('socket 关闭时在 onError 里关掉兄弟订阅：被关掉的那条不再收到本轮 channel_closed', async () => {
  installFakeWebSocket()
  try {
    const mod = await loadPageChannel()
    const events: string[] = []
    let sibling: { close(): void } | undefined
    const a = mod.subscribePageChannel({
      family: 'health',
      onItem: () => undefined,
      onError: code => {
        events.push('a:' + code)
        // 消费者在同步回调里关掉别的订阅（状态重建的常见形态）；快照迭代必须复查 closed，
        // 否则这条已经拆掉的订阅还会收到一条本轮关闭通知（延迟路径本来就复查了）。
        sibling?.close()
      },
    })
    const b = mod.subscribePageChannel({ family: 'health', onItem: () => undefined, onError: code => events.push('b:' + code) })
    sibling = b
    const socket = FakeWebSocket.latest()
    socket.open()
    await waitFor(() => socket.frames().filter(frame => frame.type === 'subscribe').length >= 2, '两条订阅', 1_000)
    socket.drop()
    await waitFor(() => events.length >= 1, '关闭通知', 1_000)
    await new Promise(resolve => { setTimeout(resolve, 20) })
    assert.deepEqual(events, ['a:channel_closed'], '被同步关掉的兄弟订阅不再收到本轮关闭通知')
    a.close()
    b.close()
  } finally {
    restoreHost()
  }
})

test('宿主没有页面 origin 时：每条订阅只收到一次 channel_unavailable，且一个重连定时器都不排', async () => {
  Reflect.deleteProperty(globalThis, 'WebSocket')
  Reflect.deleteProperty(globalThis, 'location')
  // 「永久属性不重播」的**机制**是这条路径一个阶梯都不排，而不是「时间窗里看不到重播」：
  // 旧的 1.6s 空转断言在变异（unavailablePermanent 恒 false）下照样绿（第三轮测试审计实测）。
  // 这里直接观察定时器接缝：不得出现任何 ≥1s 的定时器（阶梯首档 1s、建连期限 3s）。
  const realSetTimeout = globalThis.setTimeout
  const delays: number[] = []
  let sub: { close(): void } | undefined
  let secondSub: { close(): void } | undefined
  try {
    ;(globalThis as { setTimeout: unknown }).setTimeout = ((handler: () => void, ms?: number) => {
      delays.push(ms ?? 0)
      return realSetTimeout(handler, ms)
    }) as never
    const mod = await loadPageChannel()
    const first: string[] = []
    sub = mod.subscribePageChannel({ family: 'health', onItem: () => undefined, onError: code => first.push(code) })
    await waitFor(() => first.length === 1, '第一条订阅的 channel_unavailable（异步投递）', 1_000)
    assert.deepEqual(first, ['channel_unavailable'])
    const second: string[] = []
    secondSub = mod.subscribePageChannel({ family: 'health', onItem: () => undefined, onError: code => second.push(code) })
    await waitFor(() => second.length === 1, '第二条订阅的 channel_unavailable（异步投递）', 1_000)
    assert.deepEqual(second, ['channel_unavailable'], '新订阅各自通知一次')
    assert.deepEqual(delays.filter(ms => ms >= 1_000), [], '永久属性路径绝不排重连阶梯/建连期限')
    await new Promise(resolve => { realSetTimeout(resolve, 200) })
    assert.equal(first.length, 1, '也不得跨轮次重播（这条路径根本没有轮次）')
  } finally {
    ;(globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout
    sub?.close()
    secondSub?.close()
    restoreHost()
  }
})

test('可恢复的构造失败每轮重连重新告知一次（阶梯 1s）', async () => {
  // 每次构造都抛 = 可恢复类失败（CSP/瞬时故障）。消费方的 unary 兜底（App 的 /health 回读）
  // 只能靠这条 onError 触发，所以每轮重连都要给它一次机会——否则健康状态停在旧值到永远。
  class DeadWebSocket {
    static readonly OPEN = 1
    constructor(_url: string) { throw new Error('csp blocked') }
  }
  defineHostProperty('WebSocket', DeadWebSocket)
  defineHostProperty('location', { href: 'http://localhost:17500/', protocol: 'http:' })
  try {
    const mod = await loadPageChannel()
    const errors: string[] = []
    const sub = mod.subscribePageChannel({ family: 'health', onItem: () => undefined, onError: code => errors.push(code) })
    await waitFor(() => errors.length === 1, '第一轮 channel_unavailable', 1_000)
    await waitFor(() => errors.length === 2, '第二轮重连后的 channel_unavailable（阶梯 1s）', 3_000)
    assert.deepEqual(errors, ['channel_unavailable', 'channel_unavailable'],
      '同一轮内只告知一次；下一轮重连再告知一次')
    sub.close()
  } finally {
    restoreHost()
  }
})

test('页面入口用锚定赋值安装 I-1 运行时审计（压缩产物守卫可判定）', async () => {
  const source = stripComments(await readFile(join(REPO_ROOT, 'packages/renderer/src/main.tsx'), 'utf8'))
  assert.match(source,
    /\.__chamberPageChannelAuditInstalled\s*=\s*\n\s*installPageChannelEventSourceAudit\(\)/u,
    '入口必须以锚点属性名承接安装结果，否则压缩后裸调用会被改名、产物里查不到')
})

test('关闭码分类：意外断开记 booked=true，控制面主动重启/正常收尾记 booked=false', async () => {
  installFakeWebSocket()
  try {
    resetEvidenceLogForTests()
    const mod = await loadPageChannel()
    const sub = mod.subscribePageChannel({ family: 'health', onItem: () => undefined, onError: () => undefined })
    const socket = FakeWebSocket.latest()
    socket.open()
    socket.drop(1006)
    const abnormal = readEvidenceLog().filter(entry => entry.owner === 'page-channel' && entry.detail.kind === 'socket-close')
    assert.equal(abnormal.length, 1)
    assert.equal(abnormal[0]?.verdict, 'channel', '1006 异常断开是关于来源的证据')
    assert.equal(abnormal[0]?.booked, true)
    // 控制面主动关停（1012）：可预期收尾，不得在账本里留下假故障。
    await waitFor(() => FakeWebSocket.instances.length === 2, '第二次 socket', 3_000)
    const second = FakeWebSocket.latest()
    second.open()
    second.drop(1012)
    const closes = readEvidenceLog().filter(entry => entry.owner === 'page-channel' && entry.detail.kind === 'socket-close')
    assert.equal(closes.length, 2)
    assert.equal(closes[1]?.verdict, 'superseded')
    assert.equal(closes[1]?.booked, false)
    sub.close()
  } finally {
    restoreHost()
  }
})

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function collectTsFiles(dir: string, out: string[]): Promise<void> {
  for (const entry of await readDirSafe(dir)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await collectTsFiles(path, out)
    else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) out.push(path)
  }
}

async function collectSourceFiles(): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readDirSafe(join(REPO_ROOT, 'packages'))) {
    if (entry.isDirectory()) await collectTsFiles(join(REPO_ROOT, 'packages', entry.name, 'src'), files)
  }
  return files
}

// design 26 §D5 不变量：页面同源 HTTP/1.1 并发上限是 6，每条长活 SSE 永久占一个槽位，
// 第 6 条会把所有 unary 请求饿死在池子里（实测 20s 内 0 个完成）。页面长活流因此只允许
// 走唯一的 page-channel WebSocket。
//
// 判据刻意比「匹配 `new EventSource(`」强：**任何** EventSource 引用（限定名、别名、
// 字符串键 `globalThis['EventSource']`）都算违例；同样禁掉**流式 getReader**——那正是迁移
// 从 session-facts 删掉的第二种长活 HTTP 流写法，只禁 EventSource 会给它留一条重开路径。
const EVENT_SOURCE_ALLOWLIST = 'packages/dsh-chamber-client-core/src/page-channel.ts'
const READER_ALLOWLIST = [
  // 有界的一次性响应体读取（404 体探测 / 就绪体读取），不是长活流。
  'packages/dsh-chamber-client-core/src/instance-api.ts',
  'packages/control-plane/src/dsh-client.ts',
  'packages/gateway/src/warmup.ts',
]

function matchesEventSourceReference(code: string): boolean {
  return /\bEventSource\b|\[\s*['"]EventSource['"]\s*\]/u.test(code)
}

function matchesStreamingReader(code: string): boolean {
  return /\bgetReader\s*\(/u.test(code)
}

// 判据的正控：没有它，正则写坏/被改窄时扫描会「全绿空转」。
test('I-1 判据本身有效：正控语料逐条命中、纯注释不与误报', () => {
  const forbidden = [
    "new EventSource('/api/stream')",
    "new window.EventSource('/api/stream')",
    "globalThis['EventSource']('/api/stream')",
    'const ES = EventSource; new ES(1)',
    'const reader = response.body.getReader()',
    'await res.body?.getReader()',
  ]
  for (const line of forbidden) {
    assert.equal(matchesEventSourceReference(line) || matchesStreamingReader(line), true,
      '判据必须命中：' + line)
    assert.equal(matchesEventSourceReference(stripComments(line)), /EventSource/u.test(line),
      '注释剥离后仍要按真实引用判定：' + line)
  }
  assert.equal(matchesEventSourceReference(stripComments('// 长活流只能用通道，不得再用 EventSource')), false,
    '注释不得误报')
  assert.equal(matchesStreamingReader(stripComments('// getReader() 在这里只是说明文字')), false,
    '注释里的 getReader 不得误报')
  // 正则字面量里的 `/` 不得把该行后面的真代码一起抹掉：旧剥离器把它当行注释起点，整行截断
  // → 反向源锁（这里就是）假绿。这三条是那个洞的钉子。
  const regexAware = [
    "const s = raw.replace(/\\//g, '-'); const r = response.body.getReader()",
    'const re = /[/]/g; await res.body.getReader()',
    "const q = /^'([^']*)'$/u; new EventSource('/api/x')",
    // 第三条审计发现的第二类洞：`) ] }`/标识符之后的正则若含 `[`，位里最早的那支 `/` 会被
    // 当除号，类内的 `//`/`/*` 就成了注释起点（`/*` 更是吃到 EOF）。窄判据（无空白 + 含字符类）
    // 按正则处理，这三条钉子必须仍然看见后面的真引用。
    'if (ok) /[//]/.test(s); const r = response.body.getReader()',
    'if (ok) /[/*]/.test(s); await res.body.getReader()',
    "function f() {} /[//]/.test(s); new EventSource('/api/x')",
  ]
  for (const line of regexAware) {
    const stripped = stripComments(line)
    assert.equal(matchesEventSourceReference(stripped) || matchesStreamingReader(stripped), true,
      '正则字面量之后的真引用必须仍然可见：' + line)
  }
  // 反面：识别正则不能把剥离整体关掉——正则**之后**的注释仍须被剥掉。
  assert.equal(matchesStreamingReader(stripComments("const s = raw.replace(/\\//g, '-'); // getReader()")), false,
    '正则之后的注释仍不得误报')
})

test('I-1：shipped 源码中不存在 EventSource 引用与流式 getReader（页面长活 HTTP 流 = 0）', async () => {
  const files = await collectSourceFiles()
  // 下限：扫不到文件（目录改名/被清空）时不得静默当成「零违例」。
  assert.ok(files.length >= 400, '扫描面必须覆盖全部 packages/*/src，当前只有 ' + String(files.length) + ' 个文件')
  const violations: string[] = []
  for (const file of files) {
    const rel = relative(REPO_ROOT, file)
    const code = stripComments(await readFile(file, 'utf8'))
    code.split('\n').forEach((line, index) => {
      const eventSourceHit = matchesEventSourceReference(line) && rel !== EVENT_SOURCE_ALLOWLIST
      const readerHit = matchesStreamingReader(line) && !READER_ALLOWLIST.includes(rel)
      if (eventSourceHit || readerHit) violations.push(rel + ':' + String(index + 1) + ': ' + line.trim())
    })
  }
  assert.deepEqual(violations, [],
    'I-1 违例（页面长活 HTTP 流必须为 0）：\n' + violations.join('\n'))
})
