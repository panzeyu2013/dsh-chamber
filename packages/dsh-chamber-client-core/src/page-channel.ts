/**
 * 页面级多路复用通道（design 26）——页面**唯一**的长连接。
 *
 * 背景（实测）：浏览器对同一 origin 的 HTTP/1.1 并发上限是 6，而 EventSource /
 * SSE 这类长连接在整个生命周期里都占着一个槽位。同一台机器、同一套 WebKit
 * 网络栈上：6 条 SSE 会让所有 unary 请求饿死（5 个请求 20s 内 0 个完成，
 * 连 30ms 的 POST 都发不出去）；而 16 条 WebSocket + 3 条 SSE 时，unary 全部
 * 35–69ms 完成。升级后的 socket 不占池，SSE 占。
 *
 * 于是页面只开这一条 WS，所有长连接流都是它的**逻辑订阅**：host 健康、每个实例的
 * 客户端插件图、每个 gateway 实例的会话事实镜像。实例用 `instanceId` 在通道内部
 * 定址，容量属于控制面的上游管理器（一个订阅一条上游），**与页面侧的连接数无关**。
 *
 * 流控：消费方处理完一条消息后由通道回 `ack`（按 UTF-8 字节），控制面在上游
 * 未确认字节超过窗口时暂停该订阅的上游读取——慢实例只拖慢自己，不队头阻塞别人。
 * 这就是 HTTP/2 per-stream window / SSH channel window 的同一条性质。
 *
 * 失败语义：订阅级失败只通知该订阅（`onError`），通道自己按有界阶梯重连并重新
 * 订阅；消费方据此把该来源标脏，而不是各自再排一条重连阶梯（禁止重连风暴）。
 * 每次socket 关闭都带 close code 落日志，并写进证据账本（`page-channel`）。
 */

import {
  PAGE_CHANNEL_PATH,
  pageChannelAckFrame,
  pageChannelByteLength,
  pageChannelSubscribeFrame,
  pageChannelUnsubscribeFrame,
  parsePageChannelServerMessage,
  type PageChannelFamily,
} from '@dsh-chamber/dsh-chamber-wire/page-channel'
import { recordEvidence } from './evidence-log.ts'
import { assertSingletonModule } from './singleton.ts'

// 本模块持有页面**唯一**的长连接：打包去重一旦漂移，第二份模块会再开一条 /api/page-channel，
// 而 EventSource 审计与静态 I-1 扫描都只看 EventSource/流式 reader，抓不到这条腿。
assertSingletonModule('page-channel')

// 浏览器消费方（renderer / 客户端插件）只从本包这一张面取通道常量：
// wire 包是 host↔client 的中立契约，客户端的解析入口在这里。
export { PAGE_CHANNEL_KEEPALIVE_EVENT, isPageChannelKeepaliveItem } from '@dsh-chamber/dsh-chamber-wire/page-channel'

/** 通道重连阶梯（毫秒）：稳定运行过才归零；末项之后保持末项。 */
const PAGE_CHANNEL_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const

/** 订阅级重试阶梯：上游结束/失败后由通道重订阅，消费方不排自己的阶梯。 */
const PAGE_CHANNEL_SUBSCRIPTION_RETRY_DELAYS_MS = [3_000, 5_000, 10_000, 20_000, 30_000] as const

/** 累积到这么多未确认字节就先 flush 一次 ack（否则按微任务批量确认）。 */
const PAGE_CHANNEL_ACK_FLUSH_BYTES = 64 * 1024

/**
 * 阶梯归零的稳定条件：连接/订阅至少活了这么久，上一档才算偶发失败。
 * 没有它，一个 "接受升级后立刻关闭" 的对端会让阶梯停在最快档，退避形同装饰。
 */
const PAGE_CHANNEL_STABLE_RESET_MS = 30_000

/** 每次退避的抖动上限（占基数比例）：多个页面/窗口不得在同一毫秒齐步重连。 */
const PAGE_CHANNEL_JITTER_RATIO = 0.25

/**
 * 建连期限：socket 从构造到 open 的等待上限。这是本模块**唯一**的无界等待的收口：
 * 没有它，「TCP 活着但 upgrade 响应永不到达」的连接会让 subscribe 永远发不出去，
 * 而且 socket 句柄一直占位（ensureSocket 直接返回），连 Retry 都开不出新连接。
 * 取值算术：环回控制面 WS 握手实测 1–5ms，页面「控制面不可达」的可见阈值是
 * HEALTH_ERROR_GRACE_MS = 10s；3s 比健康握手高两个数量级，又只有可见阈值的 1/3，
 * 所以挂起握手总在用户看见不可达之前自愈（退役 → 阶梯 1s → 新连接）。
 */
const PAGE_CHANNEL_OPEN_DEADLINE_MS = 3_000

/** 通道 socket 的最小面（可注入，测试用；浏览器实现是 WebSocket 的一个子集）。 */
export interface PageChannelSocket {
  send(text: string): void
  close(): void
  onopen?: (() => void) | undefined
  onmessage?: ((event: { data: unknown }) => void) | undefined
  onclose?: ((event: { code?: number; reason?: string }) => void) | undefined
  onerror?: (() => void) | undefined
}

export interface PageChannelSubscriptionOptions {
  readonly family: PageChannelFamily
  /** `health` 之外必须给：通道据此在控制面定址到具体实例。 */
  readonly instanceId?: string
  /** 一条上游事件（SSE 的 event 名与 data 原样）。按到达顺序串行调用。 */
  onItem(event: string, data: string): void
  /** 本订阅（重新）就绪，之后的 item 属于新的一段。 */
  onOpen?(): void
  /** 本订阅失败：上游结束、上游报错、或通道断开。通道会自行重订阅。 */
  onError?(code: string, message: string): void
  /** 诊断行（默认 console.warn `[page-channel] …`）。 */
  onDiagnostic?(message: string): void
}

/** 一条逻辑订阅的句柄。`close()` 只影响这一条。 */
export interface PageChannelSubscription {
  close(): void
}

interface ChannelDeps {
  readonly openSocket?: (url: string) => PageChannelSocket
  readonly now: () => number
  readonly setTimeout: (handler: () => void, ms: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
  readonly warn: (message: string) => void
  /** 抖动随机源（默认 Math.random）：只影响退避毫秒数，不影响任何协议语义。 */
  readonly random: () => number
  /** 页面通道的绝对 ws(s) URL；非浏览器宿主返回 null（通道不可用）。 */
  readonly url: () => string | null
}

interface SubscriptionRecord {
  readonly id: string
  readonly options: PageChannelSubscriptionOptions
  retryIndex: number
  retryTimer: unknown
  pendingAck: number
  ackScheduled: boolean
  /** 本次通道连接里是否已经发过 subscribe。 */
  subscribed: boolean
  /** 本段订阅就绪的时刻；阶梯归零要等它稳定够久。 */
  readyAt: number | undefined
  /** 本轮不可用是否已经通知过（宿主机永久没有 WebSocket/origin 时不得反复打扰消费方）。 */
  notifiedUnavailable: boolean
  /** 非法组合（非 health 族缺 instanceId）是否已经通知过。 */
  notifiedInvalid: boolean
  closed: boolean
}

const defaultDeps = (): ChannelDeps => ({
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
  warn: message => { console.warn('[page-channel] ' + message) },
  random: () => Math.random(),
  url: () => {
    const location = (globalThis as { location?: { href?: string; protocol?: string } }).location
    // 非浏览器宿主（node 测试、SSR）没有页面 origin：返回 null 表示通道不可用，
    // 绝不退化成一条相对 URL 让 WebSocket 构造器抛 Invalid URL。
    if (location?.href === undefined) return null
    const base = new URL(location.href)
    base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
    base.pathname = PAGE_CHANNEL_PATH
    base.search = ''
    base.hash = ''
    return base.toString()
  },
  ...(typeof WebSocket === 'function'
    ? { openSocket: (url: string) => new WebSocket(url) as unknown as PageChannelSocket }
    : {}),
})

let deps: ChannelDeps = defaultDeps()
let socket: PageChannelSocket | undefined
let socketOpen = false
let reconnectIndex = 0
let reconnectTimer: unknown
let socketOpenedAt: number | undefined
let openDeadlineTimer: unknown
let generation = 0
let nextId = 1
const subscriptions = new Map<string, SubscriptionRecord>()
let eventSourceAuditInstalled = false

function notifyError(record: SubscriptionRecord, code: string, message: string): void {
  if (record.options.onDiagnostic !== undefined) {
    try {
      record.options.onDiagnostic(code + ': ' + message)
    } catch (error) {
      deps.warn('onDiagnostic 抛错：' + String(error))
    }
  }
  try {
    record.options.onError?.(code, message)
  } catch (error) {
    deps.warn('onError 抛错：' + String(error))
  }
}

/**
 * 在 subscribe() 返回之前就发生的失败，一律经微任务投递。句柄形态的消费方
 *（control-plane-client.subscribeHostHealth）只有拿到返回值才能绑 onerror，同步通知会在
 * 那之前丢掉第一条——而对没有 WebSocket/origin 的宿主，那也是唯一一条。去重标记仍然同步
 * 置位，异步只是把**投递**推到调用方栈展开之后。
 */
function notifyErrorDeferred(record: SubscriptionRecord, code: string, message: string): void {
  queueMicrotask(() => {
    if (record.closed) return
    notifyError(record, code, message)
  })
}

function sendFrame(frame: unknown): boolean {
  if (socket === undefined || !socketOpen) return false
  try {
    socket.send(JSON.stringify(frame))
    return true
  } catch (error) {
    deps.warn('发送失败：' + String(error))
    return false
  }
}

function flushAck(record: SubscriptionRecord): void {
  record.ackScheduled = false
  const bytes = record.pendingAck
  record.pendingAck = 0
  // 已关闭的订阅不再回执：unsubscribe 之后的 ack 是协议噪声（服务端已拆掉该订阅）。
  if (bytes === 0 || record.closed) return
  sendFrame(pageChannelAckFrame(record.id, bytes))
}

function noteConsumed(record: SubscriptionRecord, bytes: number): void {
  record.pendingAck += bytes
  // 累积到一个阈值就立刻确认，否则按微任务批量确认：既不让窗口被暂停空等，也不逐条发小帧。
  if (record.pendingAck >= PAGE_CHANNEL_ACK_FLUSH_BYTES) {
    flushAck(record)
    return
  }
  if (record.ackScheduled) return
  record.ackScheduled = true
  queueMicrotask(() => { if (!record.closed) flushAck(record) })
}

/** 订阅失败/结束时的簿记：只有稳定运行过的订阅才把重试阶梯归零。 */
function noteSubscriptionFailure(record: SubscriptionRecord): void {
  if (record.readyAt !== undefined && deps.now() - record.readyAt >= PAGE_CHANNEL_STABLE_RESET_MS) {
    record.retryIndex = 0
  }
  record.readyAt = undefined
  record.subscribed = false
}

function scheduleSubReconnect(record: SubscriptionRecord): void {
  if (record.closed) return
  if (record.retryTimer !== undefined) return
  const ladder = PAGE_CHANNEL_SUBSCRIPTION_RETRY_DELAYS_MS
  const base = ladder[Math.min(record.retryIndex, ladder.length - 1)]
  const delay = base + Math.floor(deps.random() * base * PAGE_CHANNEL_JITTER_RATIO)
  record.retryIndex += 1
  record.retryTimer = deps.setTimeout(() => {
    record.retryTimer = undefined
    if (record.closed) return
    if (!socketOpen) return
    record.subscribed = subscribeFrameOf(record)
  }, delay)
}

/**
 * 组一组订阅帧。`health` 是控制面级、不带实例；其余族缺 instanceId 是调用方错误——
 * 这种订阅**永远无法成立**，所以按不可用如实通知一次（记 capability_not_found，即
 * 本协议唯一的永久性错配语义），绝不把半成品帧发给控制面换一个必然的拒绝。
 */
function subscribeFrameOf(record: SubscriptionRecord): boolean {
  const { family, instanceId } = record.options
  if (family === 'health') {
    return sendFrame(pageChannelSubscribeFrame({ type: 'subscribe', id: record.id, family: 'health' }))
  }
  if (instanceId === undefined) {
    if (!record.notifiedInvalid) {
      record.notifiedInvalid = true
      notifyErrorDeferred(record, 'capability_not_found',
        'instanceId is required for the ' + family + ' family')
    }
    return false
  }
  return sendFrame(pageChannelSubscribeFrame({ type: 'subscribe', id: record.id, family, instanceId }))
}

function handleMessage(text: string): void {
  let message
  try {
    message = parsePageChannelServerMessage(text)
  } catch (error) {
    deps.warn('收到非法帧：' + String(error))
    return
  }
  const record = subscriptions.get(message.id)
  if (record === undefined) return
  if (message.type === 'ready') {
    record.readyAt = deps.now()
    try {
      record.options.onOpen?.()
    } catch (error) {
      deps.warn('onOpen 抛错：' + String(error))
    }
    return
  }
  if (message.type === 'item') {
    try {
      record.options.onItem(message.event, message.data)
    } catch (error) {
      deps.warn('onItem 抛错（该订阅：' + record.options.family + '/' + (record.options.instanceId ?? '-') + '）：' + String(error))
    }
    noteConsumed(record, pageChannelByteLength(message.data))
    return
  }
  if (message.type === 'error') {
    noteSubscriptionFailure(record)
    notifyError(record, message.code, message.message)
    // capability_not_found 是永久性错配（例如对 non-gateway 目标订阅 sessionFacts）：
    // 重试只会把同一件不可能的事重复 30s 一次；其余错误码都按瞬态重试。
    if (message.code !== 'capability_not_found') scheduleSubReconnect(record)
    return
  }
  noteSubscriptionFailure(record)
  notifyError(record, 'upstream_end', '上游结束了该订阅')
  scheduleSubReconnect(record)
}

/**
 * 宿主不具备通道条件（无 WebSocket / 无页面 origin，`permanent=true`），或 socket 构造失败
 * （`permanent=false`，仍排阶梯）：如实通知每条订阅，不静默悬挂。去重粒度是**每轮重连尝试**
 * ——可恢复的失败每轮重新告知一次（消费方的 unary 兜底借此保持新鲜），宿主的永久属性不重播
 * （每轮结果相同，反复 onError 只会在消费方那里变成噪声）。
 */
// 防御性标志：当前流程里永久路径（无 WebSocket/origin）**不排阶梯**，所以它的读取
// （阶梯轮次是否重置 notifiedUnavailable）只在「先判定永久、之后又重新获得宿主能力、
// 且那条 socket 在 open 前就关闭」的绕行路径上可达；正常路径上永久属性天然只通知一次。
// 它不承担承重职责，也不该被当成「永久属性不重播」的证明——那个性质由「不排阶梯」保证。
let unavailablePermanent = false

function failUnavailable(reason: string, permanent = false): void {
  deps.warn(reason + '，页面通道不可用')
  unavailablePermanent = permanent
  // 同样的快照纪律：通知虽然走微任务，但迭代期间订阅表仍可能被别处改动。
  for (const record of [...subscriptions.values()]) {
    if (record.notifiedUnavailable) continue
    record.notifiedUnavailable = true
    notifyErrorDeferred(record, 'channel_unavailable', reason)
  }
}

function scheduleSocketReconnect(reason: string): void {
  if (reconnectTimer !== undefined) return
  if (subscriptions.size === 0) return
  const ladder = PAGE_CHANNEL_RECONNECT_DELAYS_MS
  const base = ladder[Math.min(reconnectIndex, ladder.length - 1)]
  reconnectIndex += 1
  const delay = base + Math.floor(deps.random() * base * PAGE_CHANNEL_JITTER_RATIO)
  deps.warn('通道断开（' + reason + '），第 ' + String(reconnectIndex) + ' 次重连，' + String(delay) + 'ms 后开始')
  reconnectTimer = deps.setTimeout(() => {
    reconnectTimer = undefined
    if (subscriptions.size === 0) return
    // 可恢复的失败（构造器抛错：CSP/瞬时故障）每轮重新告知一次——消费方的 unary 兜底
    // 借此保持新鲜，否则页面健康状态会停在旧值到永远。宿主的永久属性（没有 WebSocket/
    // origin）不重播：那种失败每轮的结果都一样，只会在消费方那里变成纯噪声。
    if (!unavailablePermanent) for (const record of subscriptions.values()) record.notifiedUnavailable = false
    ensureSocket()
  }, delay)
}

function openSocketNow(): void {
  if (deps.openSocket === undefined) {
    failUnavailable('本宿主没有 WebSocket', true)
    return
  }
  const url = deps.url()
  if (url === null) {
    failUnavailable('本宿主没有页面 origin（无 location）', true)
    return
  }
  generation += 1
  socketOpen = false
  let current: PageChannelSocket
  try {
    current = deps.openSocket(url)
  } catch (error) {
    // 构造器可能抛（CSP、非法 URL）：不能让它逃进调用方的 effect。如实通知一次
    // （消费方据此走 unary 兜底），同时仍排阶梯——原因也可能是瞬态的。
    const reason = '打开通道 socket 失败：' + String(error)
    deps.warn(reason)
    failUnavailable(reason)
    scheduleSocketReconnect('socket 构造失败')
    return
  }
  socket = current
  /** 握手期限内未 open ⇒ 主动退役这条 CONNECTING socket 并走同一条阶梯。 */
  openDeadlineTimer = deps.setTimeout(() => {
    openDeadlineTimer = undefined
    if (socket !== current) return
    deps.warn('通道 socket 在 ' + String(PAGE_CHANNEL_OPEN_DEADLINE_MS) + 'ms 内未完成握手，关闭并按阶梯重连')
    // 先摘引用再 close：不假设宿主一定为 abort 掉的 CONNECTING socket 派发 close
    // （真实浏览器会；这一步让有界性不依赖宿主行为）。此路径**不**通知消费方：没有任何
    // 订阅失败，可见性由消费方自己的看门狗负责（App 的健康遮罩、事实镜像的静默窗）。
    socket = undefined
    socketOpen = false
    socketOpenedAt = undefined
    for (const record of subscriptions.values()) record.subscribed = false
    try {
      current.close()
    } catch (error) {
      deps.warn('关闭未握手的通道失败：' + String(error))
    }
    scheduleSocketReconnect('握手期限到期')
  }, PAGE_CHANNEL_OPEN_DEADLINE_MS)
  current.onopen = () => {
    if (socket !== current) return
    if (openDeadlineTimer !== undefined) {
      deps.clearTimeout(openDeadlineTimer)
      openDeadlineTimer = undefined
    }
    socketOpen = true
    socketOpenedAt = deps.now()
    unavailablePermanent = false
    for (const record of [...subscriptions.values()]) {
      record.notifiedUnavailable = false
      if (record.retryTimer !== undefined) {
        deps.clearTimeout(record.retryTimer)
        record.retryTimer = undefined
      }
      record.subscribed = subscribeFrameOf(record)
    }
  }
  current.onmessage = event => {
    if (socket !== current) return
    if (typeof event.data !== 'string') return
    handleMessage(event.data)
  }
  current.onerror = () => {
    if (socket !== current) return
    deps.warn('通道 socket error')
  }
  current.onclose = event => {
    // 守卫必须在清定时器**之前**：已退役的旧 socket 迟到的 close 不得取消
    // 当前 socket 的建连期限（否则新腿的挂起就再也没有边界了）。
    if (socket !== current) return
    if (openDeadlineTimer !== undefined) {
      deps.clearTimeout(openDeadlineTimer)
      openDeadlineTimer = undefined
    }
    socketOpen = false
    socket = undefined
    // 只有稳定活过一段时间的连接才把阶梯归零：accept-then-close 的坏对端不能停在最快档。
    if (socketOpenedAt !== undefined && deps.now() - socketOpenedAt >= PAGE_CHANNEL_STABLE_RESET_MS) {
      reconnectIndex = 0
    }
    socketOpenedAt = undefined
    const code = event?.code ?? 0
    const reason = event?.reason ?? ''
    deps.warn('通道关闭 code=' + String(code) + (reason === '' ? '' : ' reason=' + reason))
    // 只有**意外**关闭才是关于来源的证据：1000 正常、1001 页面离开（unload/切页）、
    // 1012 控制面主动重启/关停都是可预期的收尾，记成 booked=false（superseded），
    // 否则每次控制面重启都会在账本里留下一条假故障。
    const expectedClose = code === 1000 || code === 1001 || code === 1012
    recordEvidence('page-channel', expectedClose ? 'superseded' : 'channel', {
      kind: 'socket-close', code, reason, generation,
    }, !expectedClose)
    // 快照迭代（与服务端同一纪律）：onError 是消费方代码，它可能在回调里**同步**新建
    // 订阅（状态重建/重订阅）——边遍历边回调会让新订阅被这条旧 socket 的关闭波到，收到
    // 一条假的 channel_closed；重建型消费方还会因此同步扇出（一条关闭 → 无限条通知）。
    for (const record of [...subscriptions.values()]) {
      // 消费者的 onError 可能在同步回调里关掉**别的**订阅：已关闭的记录不再收到本轮的
      // channel_closed（延迟通知路径同样复查 closed，两边语义必须一致）。
      if (record.closed) continue
      // 与 error/end 同一套簿记：稳定运行过的订阅在这里也把阶梯归零，否则一次通道断开
      // 会把已经跑稳的订阅留在高档位（下次上游错误要等 30s 而不是 3s）。
      noteSubscriptionFailure(record)
      // 信用是**每条订阅在本次连接内**的记账：旧连接的未确认字节不得冲到新连接上（服务端
      // 会把超发的 ack 夹到 0，只会少算未确认量，但那是凭空的信用记录）。这是**防御性**清零：
      // 当前事件序下 ack 微任务总在本任务（close 事件）之前跑完，删掉这两行观察不到差异
      // （第三轮对抗审计的变异结论），它只保证「不依赖那个时序」这件事本身。
      record.pendingAck = 0
      record.ackScheduled = false
      notifyError(record, 'channel_closed', '通道关闭 code=' + String(code))
    }
    scheduleSocketReconnect('code=' + String(code))
  }
}

function ensureSocket(): void {
  if (socket !== undefined) return
  openSocketNow()
}

/**
 * 订阅一条页面上游流。第一条订阅打开通道，最后一条关闭它。
 * @param options - 订阅参数与回调。
 * @returns 只影响本订阅的句柄。
 */
export function subscribePageChannel(options: PageChannelSubscriptionOptions): PageChannelSubscription {
  const id = String(nextId)
  nextId += 1
  const record: SubscriptionRecord = {
    id,
    options,
    retryIndex: 0,
    retryTimer: undefined,
    pendingAck: 0,
    ackScheduled: false,
    subscribed: false,
    readyAt: undefined,
    notifiedUnavailable: false,
    notifiedInvalid: false,
    closed: false,
  }
  subscriptions.set(id, record)
  ensureSocket()
  if (socketOpen) record.subscribed = subscribeFrameOf(record)
  return {
    close: () => {
      if (record.closed) return
      record.closed = true
      subscriptions.delete(id)
      if (record.retryTimer !== undefined) {
        deps.clearTimeout(record.retryTimer)
        record.retryTimer = undefined
      }
      if (record.subscribed) sendFrame(pageChannelUnsubscribeFrame(id))
      if (subscriptions.size === 0) {
        // 最后一条关闭后不得再有"无人认领"的 socket：待命的重连定时器也必须撤掉，
        // 否则它到点会开出一条零订阅的长连接，而这正是本模块要消灭的东西。
        if (reconnectTimer !== undefined) {
          deps.clearTimeout(reconnectTimer)
          reconnectTimer = undefined
        }
        reconnectIndex = 0
        if (openDeadlineTimer !== undefined) {
          deps.clearTimeout(openDeadlineTimer)
          openDeadlineTimer = undefined
        }
      }
      if (subscriptions.size === 0 && socket !== undefined) {
        const current = socket
        socket = undefined
        socketOpen = false
        try {
          current.close()
        } catch (error) {
          deps.warn('关闭通道失败：' + String(error))
        }
      }
    },
  }
}

/**
 * I-1 的运行时报警器：页面里任何 `new EventSource(...)` 都会占掉 HTTP 池的一个槽位，
 * 与"页面只有一条长连接"的不变量冲突。安装后只记账与告警，不改变行为。
 * @returns 审计当前是否生效；入口用锚定赋值把它记为标记，压缩产物守卫据此判定。
 */
export function installPageChannelEventSourceAudit(): boolean {
  if (eventSourceAuditInstalled) return true
  const globalHost = globalThis as { EventSource?: unknown }
  const Original = globalHost.EventSource as (new (url: string) => unknown) | undefined
  if (typeof Original !== 'function') return false
  const OriginalConstructor: new (url: string) => unknown = Original
  eventSourceAuditInstalled = true
  function AuditedEventSource(this: unknown, url: string): unknown {
    // booked=false：这是页面自身的构建违规（I-1），不是一次来源观测；落成 booked 的
    // 'channel' 会被账本读成「来源出过一次通道事实」。warn 仍然让它可听可见。
    recordEvidence('page-channel', 'channel', { kind: 'eventsource-constructed', url: String(url) }, false)
    deps.warn('I-1 违规：页面构造了 EventSource(' + String(url) + ')，长连接必须走 page-channel 订阅')
    return new OriginalConstructor(url)
  }
  // 原型链接回原构造器：CONNECTING/OPEN/CLOSED 等静态成员仍可解析，行为面不变。
  AuditedEventSource.prototype = OriginalConstructor.prototype
  Object.setPrototypeOf(AuditedEventSource, OriginalConstructor)
  globalHost.EventSource = AuditedEventSource as unknown as typeof EventSource
  return true
}
