/**
 * 页面级多路复用通道的服务端（design 26）。
 *
 * 为什么：浏览器对同一 origin 的 HTTP/1.1 并发上限是 6，而 SSE / EventSource 这类
 * 长连接在整个生命周期里都占一个槽位。实测（同一台机器、与 app 的 WKWebView 相同的
 * WebKit 网络栈）：6 条 SSE 会让该 origin 上所有 unary 请求饿死——5 个请求 20s 内
 * 0 个完成，连 30ms 的 POST 都发不出去；而 16 条 WebSocket + 3 条 SSE 时 16 条
 * socket 全部打开、同样的 unary 探针 35–69ms 完成。升级后的 socket 不占池，SSE 占。
 *
 * 于是页面只有这一条长连接（PAGE_CHANNEL_PATH），host 健康、每实例客户端插件图、
 * 每 gateway 实例的会话事实镜像都是它的**逻辑订阅**（`id`），实例用 `instanceId`
 * 在通道内部定址。容量属于本模块的上游管理器：一个活动订阅至多一条上游，页面侧
 * 的容量与实例数无关（O(1)）。**页面侧的长连接 HTTP 流数量必须保持 0（不变量 I-1，
 * design 26）**：任何绕过本通道的 EventSource / SSE 都会重新吃掉那 6 个槽位，把
 * unary 饿死；页面侧的运行时报警器在
 * packages/dsh-chamber-client-core/src/page-channel.ts（installPageChannelEventSourceAudit）。
 *
 * 流控：按 UTF-8 字节记账。本模块发送 item 时累加未确认字节，超过
 * PAGE_CHANNEL_CREDIT_WINDOW_BYTES 就 pause 该订阅的上游响应流，收到 ack 且未确认
 * 字节回到窗口内再 resume——慢实例只拖慢自己，绝不队头阻塞别的订阅。**item 永不
 * 丢弃**：pause 只是停读上游，不丢帧。客户端 ack 的口径是 item 的 `data` 字节数
 * （dsh-chamber-client-core/src/page-channel.ts 的 noteConsumed），所以本模块也按
 * `data` 的 UTF-8 字节数记账，两侧必须同一口径。
 *
 * 失败语义：单条订阅失败只产生该 `id` 的 error/end 帧，通道本身继续可用；错误码
 * instance_unavailable / capability_not_found / upstream_failed / upstream_timeout
 * 是**本模块发出的冻结词表**（wire 只有帧形状，码以字符串跨过它；客户端按字符串
 * 比对，只有 capability_not_found 不再重试）。客户端对未知码按订阅重连阶梯持续重试，
 * 所以词表只能收窄、绝不新增「等一下就会好」的临时码。本通道
 * **没有订阅数上限**：一条订阅对应页面的一条流，控制面的上游数 = O(活动订阅数)，
 * 这正是 design 26 D5 的设计，不设容量旋钮。error/end 与
 * unsubscribe、socket 关闭、控制面 stop() 都必须销毁该订阅的上游 request+response、
 * 摘掉监听器、退订原生生产者，绝不能把半条上游留给下一个订阅或下一次启动。
 */

import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  PAGE_CHANNEL_CREDIT_WINDOW_BYTES,
  PAGE_CHANNEL_KEEPALIVE_EVENT,
  PAGE_CHANNEL_MAX_CLIENT_FRAME_CHARS,
  PAGE_CHANNEL_MAX_FRAME_CHARS,
  pageChannelByteLength,
  pageChannelEndFrame,
  pageChannelErrorFrame,
  pageChannelItemFrame,
  pageChannelReadyFrame,
  parsePageChannelClientMessage,
  type PageChannelClientMessage,
  type PageChannelFamily,
} from '@dsh-chamber/dsh-chamber-wire/page-channel'
import { authCookieFor } from './browser-auth-cookie.ts'
import { errorMessage } from './error-text.ts'
import { parseInstanceId, tcpKeepAliveMsForUpstream } from './instance-proxy.ts'
import {
  UPSTREAM_TIMEOUT_MS,
  WS_PING_INTERVAL_MS,
  WS_PING_MISSES_BEFORE_TEARDOWN,
  type HttpRequestFactory,
} from './proxy-forward.ts'
import { SESSION_STATE_STREAM_PATH } from './session-state-protocol.ts'
import { attachSpkiPinVerifier } from './spki-pin.ts'
import type { Logger } from './types.ts'
import type { ApiRequest } from './api.ts'

/**
 * 上游插件图 SSE：dsh 宿主的 HMR 事件流（design 09 的 live-graph 同一条路由）。
 * 字面量与 vendor `@deepseek-ai/dsh-client-hmr` 的 `EVENTS_ENDPOINT` 锁步
 *（registry `mirror.dsh-client-hmr-events-endpoint`），由本目录的 flow 用例断言。
 */
const PLUGIN_GRAPH_SSE_PATH = '/plugins/events'

/**
 * 上游会话事实 SSE：gateway 能力面。**不写字面量**——路由前缀的单一来源是
 * session-state-protocol.ts 的 SESSION_STATE_STREAM_PATH（同包，重命名即跟着走）。
 */
const SESSION_FACTS_SSE_PATH = SESSION_STATE_STREAM_PATH

/** RFC 6455 close code 1012 = service restart（控制面 stop() 的关闭语义）。 */
const PAGE_CHANNEL_RESTART_CLOSE_CODE = 1012

/** 控制面原生 health 生产者推送的快照；与 /api/host/health-events 同一投影。 */
export interface PageChannelHealthSnapshot {
  status: string
  port: number | null
  error: string | null
}

/** 一个实例定址到的上游目标；与 InstanceProxy.resolveTargetFor 的返回形状同构。 */
export interface PageChannelTarget {
  baseUrl: string
  /** 该目标所属传输的注册 id（'dsh:<id>' / 'gateway:<id>'；`local` 从不注册，
   *  所以缺省）。它正是 InstanceProxy.revokeTransportTraffic 收到的同一个字符串，
   *  通道用它把「传输被替换」的通知落到自己的订阅上。 */
  connectionId?: string
  headers?: Record<string, string>
  tls?: { spkiPin?: string }
  authority?: string
}

/** createPageChannel 的依赖面。 */
export interface PageChannelDeps {
  logger: Logger
  /** 控制面原生 health 事件扇出；返回退订函数。 */
  subscribeHealthEvents(listener: (snapshot: PageChannelHealthSnapshot) => void): () => void
  /** health 订阅建立时的当前快照（订阅即快照，与退役的 /api/host/health-events
   *  同一语义：只订阅未来的转移会漏掉订阅前已经发生的状态，页面会停在过期状态
   *  直到下一次转移）。缺省则不推初始快照（只有测试会这样传）。 */
  currentHealthSnapshot?: () => PageChannelHealthSnapshot
  /** 把一个 `local` / `dsh-<id>` / `gateway-<id>` 实例 id 解析成上游目标；
   *  不可用时返回 null（绝不写响应——通道侧没有可写的 HTTP 响应）。 */
  resolveTargetFor(instanceId: string): PageChannelTarget | null
  /** 测试注入面：出站请求工厂（默认按目标协议选 node:http/https），生产中不传。 */
  httpRequest?: HttpRequestFactory
  /** 测试注入面：信用窗口字节数（默认 PAGE_CHANNEL_CREDIT_WINDOW_BYTES），生产中不传。 */
  creditWindowBytes?: number
  /** 测试注入面：上游响应头等待上限（默认代理既有的 UPSTREAM_TIMEOUT_MS）。
   *  订阅是长连接，只在上游「接受请求但迟迟不给响应头」时才需要判定失败。 */
  upstreamHeadersTimeoutMs?: number
  /** 测试注入面：WS 心跳 cadence（默认 WS_PING_INTERVAL_MS = 30s）。 */
  wsPingIntervalMs?: number
  /** 测试注入面：心跳未回应几拍后终止 socket（默认 WS_PING_MISSES_BEFORE_TEARDOWN = 1）。 */
  wsPingMissesBeforeTeardown?: number
}

/** 通道的只读计数（会计可见性；绝不是一个容量旋钮）。 */
export interface PageChannelStats {
  /** 活动页面 socket 数。 */
  sockets: number
  /** 全部 socket 上的活动订阅数。 */
  subscriptions: number
  /** 活动上游连接数 = 非 health 的订阅数（pluginGraph/sessionFacts 每订阅恰好一条，
   *  health 是控制面原生生产者、没有上游）。 */
  upstreams: number
}

/** 页面级通道句柄。 */
export interface PageChannel {
  /** 测试注入面：把一条**已经是 ws 形状**的 socket 直接挂进通道。生产路径只有
   *  handleUpgrade（真实握手 + 真实 ws）；幽灵条目这类只在非标准宿主上出现的时序
   *  要有这条缝才能被用例覆盖。 */
  attachSocket(ws: WebSocket): void

  /** 接管一条升级请求；调用方（index.ts defaultUpgrade）已完成 origin 围栏与路径匹配。 */
  handleUpgrade(req: ApiRequest, socket: Duplex, head: Buffer): void
  /** 传输被替换/注销：失败该 connectionId 上的每条订阅（instance_unavailable）并销毁
   *  它的上游。通道自己开的 http.request 不在实例代理的 traffic 表里，所以替换隧道时
   *  必须由代理显式通知，否则旧化身会继续给页面推事实。 */
  revokeConnection(connectionId: string): void
  /** 只读计数，供诊断面观察。 */
  stats(): PageChannelStats
  /** 控制面停止：以 1012 关闭每一条活动 socket，并销毁其全部上游与生产者订阅。 */
  closeAll(): void
}

/**
 * 通道级心跳（RFC 6455 ping/pong，ws 库原生帧）。为什么需要：页面 socket 是
 * WebSocket，测试证明升级后的 socket 不占浏览器 6 个 HTTP 槽，但**半开**的页面腿
 * （OS 睡眠/唤醒、NAT 掉线）不会触发本地 'error'/'close'，它会一直持有上游、生产者
 * 监听器与信用缓冲。ws 服务端的 ping 由对端协议栈自动回 pong，无需应用层配合。
 *
 * 判据与 proxy-forward.ts 的 WS_PING_INTERVAL_MS / WS_PING_MISSES_BEFORE_TEARDOWN
 * 同一套：30s 一拍、漏一个完整拍（对端没有 pong）即判死——pong 往返是 loopback，
 * 整拍没有回应不是调度噪声。onDead 由调用方负责 terminate（terminate 会走正常的
 * 'close' 收尾路径，清掉订阅与上游）。
 *
 * `schedule` 是测试注入面：单测用假调度器手动驱动拍子，不依赖真实计时。
 */
export interface PageChannelHeartbeatTarget {
  ping(): void
  terminate(): void
  on(event: 'pong', listener: () => void): unknown
  /** 可选：真实 ws 提供，stop() 用它摘掉 pong 监听；桩表面可省略。 */
  removeListener?(event: 'pong', listener: () => void): unknown
}

export interface PageChannelHeartbeatOptions {
  intervalMs: number
  missesBeforeTeardown: number
  onDead: () => void
  schedule?: (tick: () => void, intervalMs: number) => { clear(): void }
}

/** 启动一条 socket 的心跳；返回幂等的 stop（清掉定时器与 pong 监听）。 */
export function startPageChannelHeartbeat(target: PageChannelHeartbeatTarget, options: PageChannelHeartbeatOptions): () => void {
  const schedule = options.schedule ?? ((tick, intervalMs) => {
    const timer = setInterval(tick, intervalMs)
    timer.unref?.()
    return { clear: () => { clearInterval(timer) } }
  })
  let stopped = false
  let outstanding = false
  let ponged = false
  let misses = 0
  const onPong = (): void => { ponged = true }
  target.on('pong', onPong)
  const tick = (): void => {
    if (stopped) return
    if (outstanding) {
      if (ponged) misses = 0
      else misses += 1
      ponged = false
    }
    if (misses >= options.missesBeforeTeardown) {
      stop()
      options.onDead()
      return
    }
    try {
      target.ping()
      outstanding = true
    } catch {
      // 发送失败本身就是死腿的直接证据（与 ws-heartbeat 同一处理）。
      stop()
      options.onDead()
    }
  }
  const handle = schedule(tick, options.intervalMs)
  function stop(): void {
    if (stopped) return
    stopped = true
    handle.clear()
    target.removeListener?.('pong', onPong)
  }
  // 第一拍立即发（与 ws-heartbeat.ts 同一理由）：健康的对端在第一个 interval 之前
  // 就有机会证明自己，而且「漏一拍」的窗口从 attach 起算，不是从 30s 后才起算。
  tick()
  return stop
}

/** 一条订阅上已经发出的 item 的上游状态。 */
interface SubscriptionState {
  readonly id: string
  readonly socketState: PageSocketState
  readonly family: PageChannelFamily
  /** true = 已从 id 表摘除；此后的任何回调都不得再发帧、再碰上游。 */
  closed: boolean
  /** 已发送但未被 ack 确认的 item `data` UTF-8 字节数（与客户端同一口径）。 */
  unacked: number
  /** 上游响应流是否已因超过信用窗口而暂停。 */
  paused: boolean
  /** 定址到的传输注册 id（health 为 null）；传输被替换时据此挑选要失败的订阅。 */
  connectionId: string | null
  response: IncomingMessage | null
  headersTimer: ReturnType<typeof setTimeout> | null
  producerUnsubscribe: (() => void) | null
  /** 摘掉本订阅自己的监听器并销毁两条腿（幂等；响应到达前只关 request）。 */
  disposeUpstream: (() => void) | null
}

/** 一条页面 socket 及其全部逻辑订阅。 */
interface PageSocketState {
  readonly ws: WebSocket
  readonly subscriptions: Map<string, SubscriptionState>
  closed: boolean
  /** 心跳停止句柄；socket 收尾时必须清掉。 */
  stopHeartbeat: (() => void) | null
}

/** 一个已解析的 SSE 事件（默认事件名 message，多行 data 用 \n 连接）。 */
interface SseEvent {
  event: string
  data: string
}

/**
 * 逐行增量解析 SSE 字节流（WHATWG EventSource 的最小子集）：以空行分帧，
 * `event:` 取事件名，多个 `data:` 用 \n 连接；注释行（`:` 开头）与 `id:`/`retry:`
 * 字段不产生 item。流结束时未以空行结束的尾块按规范丢弃（不合成半帧）。
 *
 * `maxChars` 是未成帧累积量的硬边界（buffer + 已收 data 行）：超过就抛错，由上层的
 * onData 失败该订阅并销毁上游——没有这条边界，一个永不换行的畸形成员就能把控制面
 * 内存吃光，而 emitItem 的成帧检查要到 JSON.stringify 之后才会看见它。
 */
function createSseParser(maxChars: number): { push(chunk: Buffer): SseEvent[]; end(): void } {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let eventName = ''
  let dataLines: string[] = []
  // 已累积的 data 行字符数（含行间 \n）：与 buffer 一起构成「尚未成帧的字节数」，
  // 增量维护，避免每行重扫全部 data 行。
  let dataChars = 0
  function assertWithinCap(): void {
    if (buffer.length + dataChars > maxChars) {
      throw new Error(`upstream SSE event exceeds the ${String(maxChars)}-char frame cap`)
    }
  }
  function dispatch(): SseEvent | null {
    if (dataLines.length === 0) {
      eventName = ''
      return null
    }
    const event: SseEvent = { event: eventName === '' ? 'message' : eventName, data: dataLines.join('\n') }
    eventName = ''
    dataLines = []
    dataChars = 0
    return event
  }
  function consumeLine(line: string): SseEvent | null {
    if (line === '') return dispatch()
    // 注释行（`: keepalive` 等）不产生状态帧，但它是上游仍活着的直接证据：
    // 作为 data 为空的 keepalive item 转发，消费方的静默看门狗据此续期，
    // 不会把「安静但健康」的上游误判成降级（gateway 每 20s 一条）。
    if (line.startsWith(':')) return { event: PAGE_CHANNEL_KEEPALIVE_EVENT, data: '' }
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') eventName = value
    else if (field === 'data') {
      dataLines.push(value)
      dataChars += value.length + 1
      // 边界必须在这里判：一条没有换行的巨行只会在 buffer 里增长，而很多条完整的
      // data 行只在 dataLines 里增长——两处都无界就等于让一个上游事件把通道内存
      // 撑爆（emitItem 的成帧检查发生在 JSON.stringify 之后，晚了整整一倍）。
      assertWithinCap()
    }
    return null
  }
  // 上一行进终止符是块尾的 `\r`：下一块若以 `\n` 开头，那是同一个 CRLF 的后半，要吃掉。
  let pendingCrLfTail = false
  /**
   * 取下一整行，按 WHATWG 语义把 `\r\n` / `\r` / `\n` 都当行终止符。块尾的 `\r`
   * **立即**当终止符（浏览器就是这样：能看见的数据先成行），若后继块以 `\n` 开头则
   * 把它当同一 CRLF 的后半吃掉。等下一块才判会让「最后一行的 \r 之后再无数据」
   * 这种流永远吐不出最后一行。返回 null 表示还没有完整的一行。
   */
  function takeLine(): string | null {
    if (pendingCrLfTail) {
      // 还没有新数据：标记必须留到下一块。同一轮 push 里 buffer 已经空时若把它清掉，
      // 跨块的 CRLF 就会被当成两个终止符——事件名丢失、多行 data 被切成两条事件。
      if (buffer.length === 0) return null
      pendingCrLfTail = false
      if (buffer.startsWith('\n')) buffer = buffer.slice(1)
    }
    for (let index = 0; index < buffer.length; index += 1) {
      const char = buffer[index]
      if (char === '\n') {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        return line
      }
      if (char !== '\r') continue
      const line = buffer.slice(0, index)
      if (index + 1 >= buffer.length) {
        buffer = ''
        pendingCrLfTail = true
        return line
      }
      buffer = buffer.slice(buffer[index + 1] === '\n' ? index + 2 : index + 1)
      return line
    }
    return null
  }
  return {
    push(chunk: Buffer): SseEvent[] {
      buffer += decoder.write(chunk)
      assertWithinCap()
      const events: SseEvent[] = []
      let line = takeLine()
      while (line !== null) {
        const event = consumeLine(line)
        if (event !== null) events.push(event)
        line = takeLine()
      }
      return events
    },
    end(): void {
      // 只冲解码器尾巴；不完整的尾块没有空行定界，按 SSE 规范丢弃。
      buffer += decoder.end()
    },
  }
}

/** health 快照 → 与 /api/host/health-events 完全同形的 data 负载（消费方可复用投影解析）。 */
function healthPayload(snapshot: PageChannelHealthSnapshot): string {
  return JSON.stringify({
    ok: true,
    dsh: { status: snapshot.status, port: snapshot.port ?? 0, error: snapshot.error ?? undefined },
  })
}

/** createPageChannel：一条 WS 承载多个逻辑订阅的服务端。 */
export function createPageChannel(deps: PageChannelDeps): PageChannel {
  // 日志绝不得打断流：logger 是外部 sink（可能带文件/IPC），一条日志抛错不能在
  // 'data'/'response' 回调里变成未捕获异常、把整个控制面带崩。
  const logger = {
    log: (message: string): void => { try { deps.logger.log(message) } catch { /* 日志绝不打断流 */ } },
    warn: (message: string): void => { try { deps.logger.warn(message) } catch { /* 日志绝不打断流 */ } },
  }
  const creditWindowBytes = deps.creditWindowBytes ?? PAGE_CHANNEL_CREDIT_WINDOW_BYTES
  const headersTimeoutMs = deps.upstreamHeadersTimeoutMs ?? UPSTREAM_TIMEOUT_MS
  const wsPingIntervalMs = deps.wsPingIntervalMs ?? WS_PING_INTERVAL_MS
  const wsPingMissesBeforeTeardown = deps.wsPingMissesBeforeTeardown ?? WS_PING_MISSES_BEFORE_TEARDOWN
  const liveSockets = new Set<PageSocketState>()
  // maxPayload：客户端帧只有 subscribe/unsubscribe/ack（几十字节），用**客户端帧上限**
  // 做传输层边界；超过时 ws 直接以 1009 关闭，超大/畸形帧不进解析器（wire 的
  // parsePageChannelClientMessage 有同一判据，这里是它在传输层的对应物）。host→client
  // 的 item 上限是另一个量级，绝不能拿它当入站边界。
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: PAGE_CHANNEL_MAX_CLIENT_FRAME_CHARS })

  /** 发送一段已序列化的文本；返回是否真的交给了传输层（socket 已消失时绝不让异常冒泡）。 */
  function sendText(state: PageSocketState, text: string): boolean {
    if (state.closed) return false
    try {
      state.ws.send(text)
      return true
    } catch (error) {
      logger.warn(`page-channel: send failed: ${errorMessage(error)}`)
      return false
    }
  }

  /** 发送一帧契约对象。 */
  function sendFrame(state: PageSocketState, frame: unknown): void {
    sendText(state, JSON.stringify(frame))
  }

  function destroyQuietly(stream: { destroy(error?: Error): unknown }): void {
    try {
      stream.destroy()
    } catch { /* 已经关闭 */ }
  }

  function clearHeadersTimer(sub: SubscriptionState): void {
    if (sub.headersTimer === null) return
    clearTimeout(sub.headersTimer)
    sub.headersTimer = null
  }

  /** 从 id 表摘除并把这条订阅的上游/生产者彻底收尾。 */
  function teardownSubscription(sub: SubscriptionState): void {
    if (sub.closed) return
    sub.closed = true
    sub.socketState.subscriptions.delete(sub.id)
    clearHeadersTimer(sub)
    const unsubscribe = sub.producerUnsubscribe
    sub.producerUnsubscribe = null
    if (unsubscribe !== null) {
      try {
        unsubscribe()
      } catch { /* 生产者清理与订阅清理互相隔离 */ }
    }
    const dispose = sub.disposeUpstream
    sub.disposeUpstream = null
    if (dispose !== null) {
      try {
        dispose()
      } catch { /* 上游清理绝不冒泡 */ }
    }
  }

  /** 订阅级失败：先给该 id 发 error 帧，再彻底收尾；通道与别的订阅不受影响。 */
  function failSubscription(sub: SubscriptionState, code: string, message: string): void {
    if (sub.closed) return
    try {
      logger.warn(`page-channel: subscription ${sub.id} (${sub.family}) failed: ${code}: ${message}`)
    } catch { /* 日志绝不打断收尾 */ }
    sendFrame(sub.socketState, pageChannelErrorFrame(sub.id, code, message))
    teardownSubscription(sub)
  }

  /** 上游正常结束：发 end 帧（客户端据此重订阅），再彻底收尾。 */
  function endSubscription(sub: SubscriptionState): void {
    if (sub.closed) return
    sendFrame(sub.socketState, pageChannelEndFrame(sub.id))
    teardownSubscription(sub)
  }

  /** 转发一个上游事件并按 item 的 data 字节数记账；超窗则暂停该订阅的上游读取。 */
  function emitItem(sub: SubscriptionState, event: string, data: string): void {
    if (sub.closed) return
    const text = JSON.stringify(pageChannelItemFrame(sub.id, event, data))
    // 与客户端 parsePageChannelServerMessage 同一判据（UTF-16 长度）：超过上限的帧
    // 客户端会整帧拒收，所以这里直接让该订阅失败，绝不发一条对方必丢的帧。
    if (text.length > PAGE_CHANNEL_MAX_FRAME_CHARS) {
      failSubscription(sub, 'upstream_failed', `upstream event exceeds the ${String(PAGE_CHANNEL_MAX_FRAME_CHARS)}-char frame cap`)
      return
    }
    // 没交给传输层就不记账：客户端根本收不到这条，也就永远不会 ack；记账会让该订阅一直停在
    // 「超窗暂停」上直到 socket 关闭（模块头的「item 永不丢弃」只对成功发送成立）。
    if (!sendText(sub.socketState, text)) return
    sub.unacked += pageChannelByteLength(data)
    if (!sub.paused && sub.unacked > creditWindowBytes) {
      sub.paused = true
      // 日志要如实：health 是控制面原生生产者，没有上游可停读，窗口对它只是记账；
      // 上游订阅也可能还没拿到响应（有头无体窗口），那时 stop reading 是空操作。
      const pauseScope = sub.family === 'health'
        ? 'native producer, accounting only'
        : sub.response === null ? 'upstream response not attached yet' : 'upstream reader paused'
      logger.log('page-channel: subscription ' + sub.id + ' credit window reached (unacked='
        + String(sub.unacked) + ', ' + pauseScope + ')')
      const response = sub.response
      if (response !== null) {
        try {
          response.pause()
        } catch { /* 上游已经结束 */ }
      }
    }
  }

  /** host 健康：控制面原生生产者，不涉及上游连接；接上生产者即 ready。 */
  function startHealthProducer(sub: SubscriptionState): void {
    // 生产者可能在 subscribeHealthEvents 期间**同步**回调（fan-out 实现没有义务异步）。
    // 那一条必须等 ready 之后才发，否则消费方先收到 item 再收到 ready，破坏
    // [ready, 当前快照, ...后续转移] 的帧序契约。同步期间只保留**最后**一条：快照是整量
    // 投影，中间态被后一条完全取代，所以丢中间态不丢事实。
    let pendingSnapshot: PageChannelHealthSnapshot | undefined
    let accepting = false
    const deliver = (snapshot: PageChannelHealthSnapshot): void => {
      try {
        emitItem(sub, 'message', healthPayload(snapshot))
      } catch (error) {
        failSubscription(sub, 'upstream_failed', `health producer failed: ${errorMessage(error)}`)
      }
    }
    const listener = (snapshot: PageChannelHealthSnapshot): void => {
      if (sub.closed) return
      if (!accepting) { pendingSnapshot = snapshot; return }
      deliver(snapshot)
    }
    let unsubscribe: (() => void) | null = null
    try {
      unsubscribe = deps.subscribeHealthEvents(listener)
    } catch (error) {
      failSubscription(sub, 'upstream_failed', `health producer subscription failed: ${errorMessage(error)}`)
      return
    }
    // 生产者若同步回调并已让订阅失败，退订不能漏。
    if (sub.closed) {
      try {
        unsubscribe()
      } catch { /* 已经退订 */ }
      return
    }
    sub.producerUnsubscribe = unsubscribe
    logger.log('page-channel: subscription ' + sub.id + ' ready (health)')
    sendFrame(sub.socketState, pageChannelReadyFrame(sub.id))
    accepting = true
    // 订阅即快照（与退役的 /api/host/health-events 同一语义）：只订阅未来的转移会
    // 漏掉订阅前已经发生的状态，页面会一直停在过期快照上直到下一次转移。放在 ready
    // 之后，消费方拿到的帧序恒定是 [ready, 当前快照 item, ...后续转移]。
    if (deps.currentHealthSnapshot !== undefined) {
      try {
        deliver(deps.currentHealthSnapshot())
      } catch (error) {
        failSubscription(sub, 'upstream_failed', `health snapshot read failed: ${errorMessage(error)}`)
        return
      }
    } else if (pendingSnapshot !== undefined) {
      // 测试注入面没有快照读取面：同步期间的那条转移就是最新状态，ready 之后补发。
      deliver(pendingSnapshot)
    }
  }

  /**
   * 上游请求头纪律（与实例代理同一形状）：
   * - `host` = target.authority ?? URL authority（ssh 隧道后的 gateway 必须呈现远端
   *   权威，否则它的 Host 围栏拒绝）；
   * - `origin` 重写成目标自身 origin（同源代理的诚实形状，否则实例的信任围栏
   *   会把控制面 origin 判成跨源）；
   * - `accept: text/event-stream`，且**绝不带 accept-encoding**（长连接必须 identity，
   *   否则 gzip 中间层会把事件攒在压缩缓冲里）；
   * - 传输层注入头（target.headers）最后落盘且只放行 authorization/cookie（与
   *   proxy-forward.ts forwardHttp 的注入过滤同一道纵深防御：registerTransport 已
   *   校验白名单，但通道不依赖上游校验，host/origin/accept-encoding 绝不能由传输记录
   *   覆写——那等于让隧道声明自己的身份与压缩纪律）；浏览器 auth cookie 只来自
   *   authCookieFor（本地实例的唯一凭据来源，与实例代理一致压过 transport cookie）。
   */
  function upstreamHeadersFor(url: URL, target: PageChannelTarget): Record<string, string> {
    const authority = target.authority ?? url.host
    const headers: Record<string, string> = {
      host: authority,
      accept: 'text/event-stream',
      origin: `${url.protocol}//${authority}`,
    }
    if (target.headers !== undefined) {
      for (const [name, value] of Object.entries(target.headers)) {
        const lower = name.toLowerCase()
        if (lower !== 'authorization' && lower !== 'cookie') continue
        headers[lower] = value
      }
    }
    const cookie = authCookieFor(target.baseUrl)
    if (cookie !== undefined) headers.cookie = cookie
    return headers
  }

  /** 打开一条 SSE 上游订阅（pluginGraph / sessionFacts）。 */
  function openSseUpstream(sub: SubscriptionState, instanceId: string): void {
    // sessionFacts 是 gateway 能力面：非 gateway 实例根本没有 /chamber 命名空间，
    // 与实例代理 targetsChamberNamespace 的判定同一语义（capability_not_found）。
    if (sub.family === 'sessionFacts' && parseInstanceId(instanceId) !== 'gateway') {
      failSubscription(sub, 'capability_not_found', 'the dsh target does not expose gateway capabilities')
      return
    }
    const target = deps.resolveTargetFor(instanceId)
    if (target === null) {
      failSubscription(sub, 'instance_unavailable', 'no transport is available for this instance')
      return
    }
    // 记下解析出的**同一个** connectionId（InstanceProxy 的注册映射给出）：传输被
    // 替换/注销时，代理用这个字符串通知本通道，本订阅据此失败。
    sub.connectionId = target.connectionId ?? null
    const path = sub.family === 'pluginGraph' ? PLUGIN_GRAPH_SSE_PATH : SESSION_FACTS_SSE_PATH
    let url: URL
    try {
      url = new URL(`${target.baseUrl}${path}`)
    } catch {
      failSubscription(sub, 'upstream_failed', 'the instance target is not a valid URL')
      return
    }
    const tlsPin = url.protocol === 'https:' ? target.tls?.spkiPin : undefined
    const requestFactory = deps.httpRequest ?? (url.protocol === 'https:' ? httpsRequest : httpRequest)
    let request: ClientRequest
    try {
      request = requestFactory(url, {
        method: 'GET',
        headers: upstreamHeadersFor(url, target),
        // 固定 pin 时由 pin 取代 CA 信任，且必须 agent:false 让 secureConnect 每次触发。
        ...(tlsPin === undefined ? {} : { rejectUnauthorized: false, agent: false }),
      })
    } catch (error) {
      failSubscription(sub, 'upstream_failed', `upstream request could not be created: ${errorMessage(error)}`)
      return
    }
    const keepAliveMs = tcpKeepAliveMsForUpstream(target.baseUrl)

    let dispatched = false
    const dispatchRequest = (): void => {
      if (dispatched || sub.closed || request.destroyed) return
      dispatched = true
      try {
        request.end()
      } catch (error) {
        request.destroy(error instanceof Error ? error : new Error(String(error)))
      }
    }

    /** 摘掉 request 侧监听器后仍留一个空保险：destroy 的迟到 error 不得变成未处理事件。 */
    const disposeRequest = (): void => {
      request.removeListener('response', onResponse)
      request.removeListener('error', onRequestError)
      request.on('error', () => {})
      destroyQuietly(request)
    }

    const onResponse = (response: IncomingMessage): void => {
      clearHeadersTimer(sub)
      if (sub.closed) {
        destroyQuietly(response)
        return
      }
      const status = response.statusCode ?? 0
      if (status !== 200) {
        destroyQuietly(response)
        failSubscription(sub, 'upstream_failed', `upstream answered ${String(status)} instead of 200`)
        return
      }
      // 200 不等于 SSE：SPA fallback / 网关错误页也会回答 200 text/html。只认状态码的
      // 话这会变成一条黑洞订阅（发出 ready 后永远安静），pluginGraph 又没有消费者
      // 看门狗，页面只能停在过期图上。缺 content-type 时容忍，有就必须是
      // text/event-stream（大小写不敏感、忽略参数）。
      const rawContentType = response.headers['content-type']
      const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType
      if (contentType !== undefined && !contentType.trim().toLowerCase().startsWith('text/event-stream')) {
        destroyQuietly(response)
        failSubscription(sub, 'upstream_failed', `upstream answered 200 with content-type ${JSON.stringify(contentType)} instead of text/event-stream`)
        return
      }
      sub.response = response
      // 非 loopback 直连腿补 OS 级 keepalive：ssh 隧道有自己的 keepalive，直连没有，
      // 半开连接会让订阅无声冻结（与实例代理 tcpKeepAliveMsForUpstream 同一判据）。
      if (keepAliveMs !== undefined) {
        try {
          (response.socket as Socket | undefined)?.setKeepAlive(true, keepAliveMs)
        } catch { /* 测试替身没有真实 socket */ }
      }
      const parser = createSseParser(PAGE_CHANNEL_MAX_FRAME_CHARS)
      const onData = (chunk: Buffer): void => {
        if (sub.closed) return
        let events: SseEvent[]
        try {
          events = parser.push(chunk)
        } catch (error) {
          // 解析器抛错（畸形帧 / 超过未成帧上限）原先被静默吞掉并继续读：那会把一个
          // 已经坏掉的上游伪装成「安静但健康」的流。现在失败该订阅（failSubscription
          // 会留 warn 日志并经收尾销毁上游），通道与别的订阅照常。
          failSubscription(sub, 'upstream_failed', `upstream SSE parse failed: ${errorMessage(error)}`)
          return
        }
        for (const event of events) {
          if (sub.closed) return
          emitItem(sub, event.event, event.data)
        }
      }
      const onEnd = (): void => {
        if (sub.closed) return
        parser.end()
        endSubscription(sub)
      }
      const onStreamError = (error: Error): void => {
        if (sub.closed) return
        failSubscription(sub, 'upstream_failed', `upstream stream failed: ${errorMessage(error)}`)
      }
      const onStreamClose = (): void => {
        if (sub.closed) return
        // 对端没有 end 就关闭（RST / 隧道断开）：按结束处理，让客户端重订阅。
        endSubscription(sub)
      }
      response.on('data', onData)
      response.on('end', onEnd)
      response.on('error', onStreamError)
      response.on('close', onStreamClose)
      sub.disposeUpstream = () => {
        response.removeListener('data', onData)
        response.removeListener('end', onEnd)
        response.removeListener('error', onStreamError)
        response.removeListener('close', onStreamClose)
        response.on('error', () => {})
        destroyQuietly(response)
        disposeRequest()
      }
      logger.log('page-channel: subscription ' + sub.id + ' ready (' + sub.family + ', upstream HTTP 200)')
      sendFrame(sub.socketState, pageChannelReadyFrame(sub.id))
    }

    const onRequestError = (error: Error): void => {
      clearHeadersTimer(sub)
      if (sub.closed) return
      failSubscription(sub, 'upstream_failed', `upstream request failed: ${errorMessage(error)}`)
    }

    // 响应到达前只有 request 两条腿可关；响应到达后 onResponse 会换成两条腿都管的收尾。
    sub.disposeUpstream = disposeRequest
    request.on('response', onResponse)
    request.on('error', onRequestError)
    request.on('socket', (socket: Socket) => {
      if (keepAliveMs !== undefined) {
        try {
          socket.setKeepAlive(true, keepAliveMs)
        } catch { /* 测试替身没有真实 socket */ }
      }
    })
    sub.headersTimer = setTimeout(() => {
      if (sub.closed) return
      failSubscription(sub, 'upstream_timeout', `upstream did not answer within ${String(headersTimeoutMs)}ms`)
    }, headersTimeoutMs)
    sub.headersTimer.unref?.()
    // 固定 pin 时 headers 必须在 secureConnect 验过 peer key 之后才发（headers 直到
    // end() 才入队），因此 dispatch 被 pin 门挡住，与实例代理 forwardUpgrade 同一纪律。
    if (tlsPin !== undefined) attachSpkiPinVerifier(request, tlsPin, dispatchRequest)
    else dispatchRequest()
  }

  /** 注册一条订阅并打开它的上游；同 id 重复 subscribe 用新订阅覆盖旧订阅。 */
  function openSubscription(state: PageSocketState, id: string, family: PageChannelFamily, instanceId: string | undefined): void {
    if (state.closed) return
    const previous = state.subscriptions.get(id)
    if (previous !== undefined) teardownSubscription(previous)
    // 没有订阅数上限：一条订阅对应页面的一条流，上游数 = O(活动订阅数)（design 26 D5）。
    // 这里曾有一个 resource_exhausted 的容量闸门，它把「第 N+1 条流」变成永远重试的
    // 静默降级——容量属于控制面的上游管理器，不是一个需要闸门的稀缺资源。
    const sub: SubscriptionState = {
      id,
      socketState: state,
      family,
      closed: false,
      unacked: 0,
      paused: false,
      connectionId: null,
      response: null,
      headersTimer: null,
      producerUnsubscribe: null,
      disposeUpstream: null,
    }
    state.subscriptions.set(id, sub)
    logger.log('page-channel: subscribe ' + id + ' family=' + family
      + (instanceId === undefined ? '' : ' instanceId=' + instanceId))
    try {
      if (family === 'health') startHealthProducer(sub)
      else openSseUpstream(sub, instanceId ?? '')
    } catch (error) {
      // 一条订阅的启动异常绝不能波及同 socket 的别的订阅。
      failSubscription(sub, 'upstream_failed', `subscription setup failed: ${errorMessage(error)}`)
    }
  }

  /** 处理一条客户端文本帧；非法帧忽略，单条订阅的失败绝不外溢。 */
  function handleClientFrame(state: PageSocketState, text: string): void {
    let message: PageChannelClientMessage
    try {
      message = parsePageChannelClientMessage(text)
    } catch (error) {
      // 畸形帧（非 JSON / 形状不符 / 超长）忽略、不回帧；但必须留一行日志，否则
      // 客户端侧的一个帧构造 bug 在服务端完全不可见（「没有任何反应」是最难查的形态）。
      logger.warn(`page-channel: ignored malformed client frame: ${errorMessage(error)}`)
      return
    }
    if (message.type === 'subscribe') {
      openSubscription(state, message.id, message.family,
        message.family === 'health' ? undefined : message.instanceId)
      return
    }
    if (message.type === 'unsubscribe') {
      const sub = state.subscriptions.get(message.id)
      if (sub !== undefined) teardownSubscription(sub)
      return
    }
    const sub = state.subscriptions.get(message.id)
    if (sub === undefined) return
    sub.unacked = Math.max(0, sub.unacked - message.bytes)
    if (sub.paused && sub.unacked <= creditWindowBytes) {
      sub.paused = false
      logger.log('page-channel: subscription ' + sub.id + ' resumed after ack (unacked=' + String(sub.unacked) + ')')
      try {
        sub.response?.resume()
      } catch { /* 上游已经结束 */ }
    }
  }

  /** socket 消失（对端关闭 / closeAll / 网络断开 / 心跳判死）：销毁它的全部订阅与上游。 */
  function teardownSocket(state: PageSocketState): void {
    // 先摘集合再判 closed：宿主在 attach 注册监听器时**同步**派发 close 会先跑到这里，
    // 若这里因 closed 早退，随后 attach 再 add 就成了 closeAll 也删不掉的幽灵条目
    // （stats().sockets 永远虚高、socket 与订阅被永久持有）。
    liveSockets.delete(state)
    if (state.closed) return
    state.closed = true
    // 心跳定时器必须在这里停：它是唯一逃出订阅表的活动臂，漏停就是一条判死 socket
    // 永远 ping 下去（closeAll 也走这条路，所以 stop() 同样清得干净）。
    state.stopHeartbeat?.()
    state.stopHeartbeat = null
    for (const sub of [...state.subscriptions.values()]) teardownSubscription(sub)
    state.subscriptions.clear()
  }

  function attachSocket(ws: WebSocket): void {
    const state: PageSocketState = { ws, subscriptions: new Map(), closed: false, stopHeartbeat: null }
    // 监听器与心跳**全部挂好之后**才进 liveSockets：中间任何一步抛错都必须 leave no trace——
    // 一条没有任何 close 监听器的死 socket 一旦进了表就再也删不掉（stats 永远虚高、
    // ws/订阅被永久持有）。
    try {
      // 半开腿（OS 睡眠/唤醒、NAT 掉线）不会触发本地 'error'/'close'：没有心跳时它会
      // 一直持有上游、生产者监听器与信用缓冲。ping 由对端协议栈自动回 pong，不需要
      // 应用层配合；漏一拍就判死并 terminate（走正常 'close' 收尾路径）。
      state.stopHeartbeat = startPageChannelHeartbeat(ws, {
        intervalMs: wsPingIntervalMs,
        missesBeforeTeardown: wsPingMissesBeforeTeardown,
        onDead: () => {
          logger.warn(`page-channel: page socket missed ${String(wsPingMissesBeforeTeardown)} ping cycle(s); terminating`)
          try {
            ws.terminate()
          } catch { /* 已经关闭 */ }
        },
      })
      // 现场可观测：一条页面 socket 的生平（attach/subscribe/ready/pause/close）都留日志，
      // 出现「时好时坏」时可直接分辨是页面没连、订阅没成、还是上游/信用停读。
      logger.log('page-channel: page socket attached')
      ws.on('message', (raw: Buffer, isBinary: boolean) => {
        if (isBinary || state.closed) return
        let text: string
        try {
          text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
        } catch {
          return
        }
        try {
          handleClientFrame(state, text)
        } catch (error) {
          // 消息处理器的最后一道保险：任何意外都不得冒泡成未处理异常。
          logger.warn(`page-channel: frame handler failed: ${errorMessage(error)}`)
        }
      })
      ws.on('error', error => {
        logger.warn(`page-channel: socket error: ${errorMessage(error)}`)
      })
      ws.on('close', (code: number, reason: Buffer) => {
        logger.log('page-channel: page socket closed code=' + String(code)
          + ' subscriptions=' + String(state.subscriptions.size)
          + (reason.length === 0 ? '' : ' reason=' + reason.toString('utf8')))
        teardownSocket(state)
      })
    } catch (error) {
      // 挂监听器/起心跳中途失败：清干净并终止，绝不把半成品登记进 liveSockets。
      state.closed = true
      state.stopHeartbeat?.()
      state.stopHeartbeat = null
      try {
        ws.terminate()
      } catch { /* 已经关闭 */ }
      logger.warn(`page-channel: attach failed: ${errorMessage(error)}`)
      return
    }
    // 同步 close 的宿主在这里已经是 closed（监听器注册期间就派发了 close）：不能进表——
    // 幽灵条目 = closeAll 也删不掉的假 stats 与永久持有的订阅。收尾再清一次心跳是
    // 纵深防御：当前注册顺序下 teardown 总能停掉它，但不要让正确性依赖注册顺序。
    if (state.closed) {
      state.stopHeartbeat?.()
      state.stopHeartbeat = null
      return
    }
    liveSockets.add(state)
  }

  /** 传输被替换/注销：失败该 connectionId 上的每条订阅并销毁其上游。
   *  客户端的订阅重连阶梯会重新 subscribe，那时 resolveTargetFor 已解析到新传输。 */
  function revokeConnection(connectionId: string): void {
    let revoked = 0
    for (const state of [...liveSockets]) {
      for (const sub of [...state.subscriptions.values()]) {
        if (sub.connectionId !== connectionId) continue
        revoked += 1
        failSubscription(sub, 'instance_unavailable', `the instance transport ${connectionId} was replaced or removed`)
      }
    }
    if (revoked > 0) {
      logger.log(`page-channel: transport ${connectionId} revoked ${String(revoked)} subscription(s)`)
    }
  }

  return {
    /** 测试注入面：把一条**已经是 ws 形状**的 socket 直接挂进通道（生产路径只有
     *  handleUpgrade：真实握手 + 真实 ws）。幽灵条目这类只在非标准宿主上出现的时序
     *  要有这条缝才能被用例覆盖。 */
    attachSocket,

    handleUpgrade(req: ApiRequest, socket: Duplex, head: Buffer): void {
      try {
        wss.handleUpgrade(req as never, socket as never, head, (ws: WebSocket) => { attachSocket(ws) })
      } catch (error) {
        logger.warn(`page-channel: upgrade failed: ${errorMessage(error)}`)
        try {
          socket.destroy()
        } catch { /* 已经关闭 */ }
      }
    },

    revokeConnection,

    stats(): PageChannelStats {
      let subscriptions = 0
      let upstreams = 0
      for (const state of liveSockets) {
        subscriptions += state.subscriptions.size
        for (const sub of state.subscriptions.values()) {
          if (sub.family !== 'health') upstreams += 1
        }
      }
      return { sockets: liveSockets.size, subscriptions, upstreams }
    },

    closeAll(): void {
      for (const state of [...liveSockets]) {
        try {
          state.ws.close(PAGE_CHANNEL_RESTART_CLOSE_CODE, 'control plane shutting down')
        } catch { /* 已经关闭 */ }
        teardownSocket(state)
        // close 握手是尽力而为：对端不回帧也不能拖住控制面 stop()。
        const terminate = setTimeout(() => {
          try {
            state.ws.terminate()
          } catch { /* 已经关闭 */ }
        }, 250)
        terminate.unref?.()
      }
    },
  }
}
