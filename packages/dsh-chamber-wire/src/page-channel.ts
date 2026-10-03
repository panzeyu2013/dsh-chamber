/**
 * The page-channel wire contract (design 26) — ONE page-level WebSocket that
 * carries every long-lived chamber stream the page consumes: host health, the
 * per-instance client-plugin graph, and the per-instance session-facts mirror.
 *
 * WHY ONE CHANNEL. A browser caps HTTP/1.1 connections per origin at six, and a
 * long-lived EventSource/stream keeps one of those slots for its whole life.
 * Measured on this machine (Safari, the same WebKit networking stack as the
 * app's WKWebView):
 *
 *   - 6 SSEs open  -> every unary request against that origin starved: 0 of 5
 *                     completed within 20s, not even a 30ms POST;
 *   - 16 WebSockets + 3 SSEs -> all 16 sockets opened and the same unary probes
 *                     finished in 35-69ms.
 *
 * Upgraded sockets are exempt from the pool; SSEs are not. The page therefore
 * opens exactly ONE long-lived socket and addresses every stream as a logical
 * subscription (`id`), with the instance (`instanceId`) carried INSIDE the
 * channel. Capacity is a property of the control plane's upstream manager — one
 * upstream per subscription — never of a page-side count, so adding instances
 * does not consume page connection budget.
 *
 * WHY CREDIT. One socket carrying many streams needs per-stream flow control,
 * or a single slow instance head-of-line blocks every other one. The client
 * acknowledges the bytes it has finished dispatching (`ack`); the host pauses
 * that subscription's upstream reader while unacked bytes exceed
 * {@link PAGE_CHANNEL_CREDIT_WINDOW_BYTES} and resumes after the next ack. That
 * is the same property HTTP/2 gets from per-stream windows and SSH from channel
 * windows. The control-plane-native `health` family has no upstream to pause: it
 * coalesces to the latest full snapshot while the window is exhausted and sends
 * that on the next ack (a snapshot supersedes its predecessors by construction).
 * Frame types otherwise mirror the Remote mux vocabulary (design 05) so the
 * codebase keeps ONE stream protocol shape rather than two.
 */

/** WebSocket path on the control-plane origin (same-origin with the page). */
export const PAGE_CHANNEL_PATH = '/api/page-channel'

/**
 * Stream families the page may subscribe to. `health` is control-plane-native;
 * `pluginGraph` reads the target's `plugins/events` SSE; `sessionFacts` reads
 * the target's `/chamber/session-state/stream` SSE.
 */
const PAGE_CHANNEL_FAMILIES = ['health', 'pluginGraph', 'sessionFacts'] as const

/** One addressed stream family. */
export type PageChannelFamily = (typeof PAGE_CHANNEL_FAMILIES)[number]

/**
 * Per-subscription credit window, in bytes. The host stops reading a
 * subscription's upstream while `sent - acked` exceeds this, so a stalled
 * consumer throttles its own upstream and nobody else's.
 */
export const PAGE_CHANNEL_CREDIT_WINDOW_BYTES = 256 * 1024

/** A single host→client frame may not exceed this; a larger upstream event fails THAT subscription. */
export const PAGE_CHANNEL_MAX_FRAME_CHARS = 4 * 1024 * 1024

/**
 * Host-bound frame cap, deliberately split from the page-bound {@link PAGE_CHANNEL_MAX_FRAME_CHARS}:
 * the only client→host frames are subscribe / unsubscribe / ack (tens of bytes; an
 * ack carries one integer), so 4 KiB is a transport-boundary sanity bound for the
 * ws `maxPayload` and the parse guard — a capacity knob it is not. The page-bound
 * item cap stays large because a legitimate upstream event may be big.
 *
 * 超限的后果是**传输层**关闭（ws `maxPayload` 直接 1009）：同一条 socket 上的全部订阅一起
 * 重建（客户端阶梯 1s 起）。正常客户端帧远低于此，超限只可能是客户端 bug，所以这里选择
 * 「一条坏帧杀整条腿」而不是放行一个超限帧——页面侧不会因此静默：通道会重连并自动重订阅。
 */
export const PAGE_CHANNEL_MAX_CLIENT_FRAME_CHARS = 4 * 1024

/**
 * Liveness-only item event name: an upstream SSE comment/keepalive line (`:`),
 * forwarded as an item with an EMPTY data string. Consumers must treat it as
 * "this subscription is still alive" and never apply it as a state frame; it is
 * credit-acked like any item (0 bytes). It exists because a quiet-but-healthy
 * upstream (the gateway sends `: keepalive` every 20s) would otherwise look
 * silent to a consumer-side watchdog and be reported as stale. It does NOT
 * suppress reconciliation: the facts consumer still re-reads its unary
 * authority every silence window (keepalive refreshes liveness, not content).
 */
export const PAGE_CHANNEL_KEEPALIVE_EVENT = 'keepalive'

/**
 * Client -> host: open one logical subscription. `health` is control-plane-wide and carries
 * no instance; every other family addresses exactly one instance — so for them a missing
 * `instanceId` is unrepresentable in the type instead of a server-side rejection.
 */
export type PageChannelSubscribe =
  | {
    readonly type: 'subscribe'
    readonly id: string
    readonly family: 'health'
  }
  | {
    readonly type: 'subscribe'
    readonly id: string
    readonly family: Exclude<PageChannelFamily, 'health'>
    readonly instanceId: string
  }

/** Client -> host: close one logical subscription. */
export interface PageChannelUnsubscribe {
  readonly type: 'unsubscribe'
  readonly id: string
}

/** Client -> host: credit — bytes dispatched by the consumer of `id`. */
export interface PageChannelAck {
  readonly type: 'ack'
  readonly id: string
  readonly bytes: number
}

/** Every message the page sends on the channel. */
export type PageChannelClientMessage = PageChannelSubscribe | PageChannelUnsubscribe | PageChannelAck

/** Host -> client: the upstream is open; items may follow. */
export interface PageChannelReady {
  readonly type: 'ready'
  readonly id: string
}

/** Host -> client: one upstream event (SSE event name + data, both verbatim). */
export interface PageChannelItem {
  readonly type: 'item'
  readonly id: string
  readonly event: string
  readonly data: string
}

/** Host -> client: this subscription failed; the channel itself stays usable. */
export interface PageChannelError {
  readonly type: 'error'
  readonly id: string
  readonly code: string
  readonly message: string
}

/** Host -> client: this subscription ended (upstream closed); the client may resubscribe. */
export interface PageChannelEnd {
  readonly type: 'end'
  readonly id: string
}

/** Every message the host sends on the channel. */
export type PageChannelServerMessage = PageChannelReady | PageChannelItem | PageChannelError | PageChannelEnd

/**
 * 一条 item 是否是 keepalive（传输活性）而不是状态帧。**两个条件都要满足**：只按名字判会
 * 把一条恰好叫 `keepalive` 的真实上游事件吞掉，而协议生成的 keepalive 的 data 恒为空串。
 * @param event - item 的事件名。
 * @param data - item 的数据（协议生成的 keepalive 为空串）。
 * @returns 是否是协议生成的 keepalive item。
 */
export function isPageChannelKeepaliveItem(event: string, data: string): boolean {
  return event === PAGE_CHANNEL_KEEPALIVE_EVENT && data === ''
}

/** UTF-8 byte length of one frame payload — BOTH sides must measure credit the same way. */
export function pageChannelByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

const FAMILY_SET: ReadonlySet<string> = new Set(PAGE_CHANNEL_FAMILIES)

function parseJson(text: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('page channel: message is not JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('page channel: message is not an object')
  }
  return value as Record<string, unknown>
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

/**
 * Parse one host-bound text frame.
 * @param text - complete WebSocket text message.
 * @returns the validated client message.
 */
export function parsePageChannelClientMessage(text: string): PageChannelClientMessage {
  if (text.length > PAGE_CHANNEL_MAX_CLIENT_FRAME_CHARS) throw new Error('page channel: client frame too large')
  const value = parseJson(text)
  if (value.type === 'subscribe') {
    // family 必须是**字符串**本身：`String(value.family)` 会让 ['pluginGraph'] 这类单元素
    // 数组通过集合检查，而返回值仍是数组——服务端用 === 比较族，于是它既不匹配 health 也
    // 不匹配 sessionFacts，直接滑进 SSE 分支并绕过 gateway 的 /chamber 能力围栏。
    if (!validId(value.id) || typeof value.family !== 'string' || !FAMILY_SET.has(value.family)) {
      throw new Error('page channel: invalid subscribe')
    }
    const instanceId = value.instanceId
    if (instanceId !== undefined && !validId(instanceId)) throw new Error('page channel: invalid instanceId')
    if (value.family === 'health') {
      if (instanceId !== undefined) throw new Error('page channel: health takes no instanceId')
      return { type: 'subscribe', id: value.id as string, family: 'health' }
    }
    if (instanceId === undefined) {
      throw new Error('page channel: instanceId is required for ' + String(value.family))
    }
    return {
      type: 'subscribe',
      id: value.id as string,
      family: value.family as Exclude<PageChannelFamily, 'health'>,
      instanceId: instanceId as string,
    }
  }
  if (value.type === 'unsubscribe') {
    if (!validId(value.id)) throw new Error('page channel: invalid unsubscribe')
    return { type: 'unsubscribe', id: value.id }
  }
  if (value.type === 'ack') {
    if (!validId(value.id) || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0) {
      throw new Error('page channel: invalid ack')
    }
    return { type: 'ack', id: value.id, bytes: value.bytes as number }
  }
  throw new Error('page channel: unknown client message type')
}

/**
 * Parse one page-bound text frame.
 * @param text - complete WebSocket text message.
 * @returns the validated server message.
 */
export function parsePageChannelServerMessage(text: string): PageChannelServerMessage {
  if (text.length > PAGE_CHANNEL_MAX_FRAME_CHARS) throw new Error('page channel: server frame too large')
  const value = parseJson(text)
  if (!validId(value.id)) throw new Error('page channel: invalid id')
  if (value.type === 'ready') return { type: 'ready', id: value.id }
  if (value.type === 'end') return { type: 'end', id: value.id }
  if (value.type === 'item') {
    if (typeof value.event !== 'string' || typeof value.data !== 'string') {
      throw new Error('page channel: invalid item')
    }
    return { type: 'item', id: value.id, event: value.event, data: value.data }
  }
  if (value.type === 'error') {
    if (typeof value.code !== 'string' || typeof value.message !== 'string') {
      throw new Error('page channel: invalid error')
    }
    return { type: 'error', id: value.id, code: value.code, message: value.message }
  }
  throw new Error('page channel: unknown server message type')
}

/** Build one host-bound subscribe frame. */
export function pageChannelSubscribeFrame(message: PageChannelSubscribe): PageChannelSubscribe {
  return message
}

/** Build one host-bound unsubscribe frame. */
export function pageChannelUnsubscribeFrame(id: string): PageChannelUnsubscribe {
  return { type: 'unsubscribe', id }
}

/** Build one host-bound credit frame. */
export function pageChannelAckFrame(id: string, bytes: number): PageChannelAck {
  return { type: 'ack', id, bytes }
}

/** Build one page-bound ready frame. */
export function pageChannelReadyFrame(id: string): PageChannelReady {
  return { type: 'ready', id }
}

/** Build one page-bound item frame. */
export function pageChannelItemFrame(id: string, event: string, data: string): PageChannelItem {
  return { type: 'item', id, event, data }
}

/** Build one page-bound error frame. */
export function pageChannelErrorFrame(id: string, code: string, message: string): PageChannelError {
  return { type: 'error', id, code, message }
}

/** Build one page-bound end frame. */
export function pageChannelEndFrame(id: string): PageChannelEnd {
  return { type: 'end', id }
}
