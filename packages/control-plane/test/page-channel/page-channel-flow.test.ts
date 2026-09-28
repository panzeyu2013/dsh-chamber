/**
 * Page-channel flow control + upstream discipline (design 26).
 *
 * Credit is what keeps one slow instance from head-of-line-blocking every other
 * subscription on the one page socket: unacked item bytes over the window pause
 * that subscription's upstream reader, an ack resumes it, and NOTHING is
 * dropped while paused. The upstream fake records pause()/resume() so the test
 * observes the exact mechanism rather than a timing coincidence; a small
 * injected window (and the frozen frame cap) keeps the case deterministic.
 *
 * Also locked here: the upstream request discipline (host / rewritten origin /
 * accept: text/event-stream / NO accept-encoding / transport headers last /
 * cookie only from authCookieFor) and the per-subscription response-headers
 * deadline.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import {
  PAGE_CHANNEL_MAX_FRAME_CHARS,
  PAGE_CHANNEL_PATH,
} from '@dsh-chamber/dsh-chamber-wire/page-channel'
import { createPageChannel, type PageChannelDeps } from '../../src/page-channel.ts'
import { SESSION_STATE_STREAM_PATH } from '../../src/session-state-protocol.ts'
import { clearAuthCookie, registerAuthCookie } from '../../src/browser-auth-cookie.ts'
import { waitFor } from '../support/utils.ts'

const quietLogger = { log: () => {}, warn: () => {}, error: () => {} }

interface PageClient {
  ws: WebSocket
  messages: any[]
  send(message: unknown): void
  waitFor(predicate: (message: any) => boolean, what: string, timeoutMs?: number): Promise<any>
  waitForType(type: string, id?: string, timeoutMs?: number): Promise<any>
}

function connectClient(url: string): Promise<PageClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const messages: any[] = []
    const client: PageClient = {
      ws,
      messages,
      send(message: unknown): void { ws.send(JSON.stringify(message)) },
      async waitFor(predicate, what, timeoutMs = 5000) {
        await waitFor(() => messages.some(predicate), timeoutMs, what)
        return messages.find(predicate)
      },
      waitForType(type: string, id?: string, timeoutMs = 5000) {
        return client.waitFor(
          message => message.type === type && (id === undefined || message.id === id),
          `page-channel ${type}${id === undefined ? '' : ' ' + id}`,
          timeoutMs,
        )
      },
    }
    ws.on('message', (data: Buffer) => { messages.push(JSON.parse(data.toString('utf8'))) })
    ws.once('open', () => resolve(client))
    ws.once('error', reject)
  })
}

interface Harness {
  channel: ReturnType<typeof createPageChannel>
  connect(): Promise<PageClient>
  close(): Promise<void>
}

async function startChannel(overrides: Partial<PageChannelDeps> = {}): Promise<Harness> {
  const channel = createPageChannel({
    logger: quietLogger,
    subscribeHealthEvents: () => () => {},
    resolveTargetFor: () => null,
    ...overrides,
  })
  const server = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket, head) => {
    channel.handleUpgrade(req as never, socket as never, head)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  return {
    channel,
    connect: () => connectClient(`ws://127.0.0.1:${port}${PAGE_CHANNEL_PATH}`),
    async close(): Promise<void> {
      channel.closeAll()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    },
  }
}

interface FakeUpstreamCall { url: URL; options: any; req: any; res: any }

/** An outbound http.request double whose SSE response exposes pause/resume. */
function fakeSseUpstream() {
  const calls: FakeUpstreamCall[] = []
  const fn: any = (url: URL, options: any) => {
    const req: any = new EventEmitter()
    req.destroyed = false
    req.destroy = () => {
      if (req.destroyed) return
      req.destroyed = true
    }
    req.end = () => {
      const res: any = new EventEmitter()
      res.statusCode = 200
      res.headers = { 'content-type': 'text/event-stream' }
      res.paused = false
      res.destroyed = false
      res.pause = () => { res.paused = true }
      res.resume = () => { res.paused = false }
      res.destroy = () => {
        if (res.destroyed) return
        res.destroyed = true
        res.emit('close')
      }
      calls.push({ url, options, req, res })
      req.emit('response', res)
    }
    return req
  }
  return { fn, calls }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('上游路由锁步：插件图字面量与 vendor EVENTS_ENDPOINT 一致，会话事实只认协议常量', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const vendor = readFileSync(join(root, 'vendor/harness-packages/@deepseek-ai/dsh-client-hmr/src/events.ts'), 'utf8')
  const source = readFileSync(join(root, 'packages/control-plane/src/page-channel.ts'), 'utf8')
  // registry mirror.dsh-client-hmr-events-endpoint 的机器化：pin 升级挪走宿主路由，这里必须红。
  assert.ok(vendor.includes("export const EVENTS_ENDPOINT = '/plugins/events'"),
    'vendor dsh-client-hmr 的 EVENTS_ENDPOINT 变了：通道的 PLUGIN_GRAPH_SSE_PATH 必须跟着改')
  assert.ok(source.includes("const PLUGIN_GRAPH_SSE_PATH = '/plugins/events'"),
    '通道的插件图上游路径必须与 vendor EVENTS_ENDPOINT 逐字节一致')
  // 会话事实路径不得再写一份字面量：前缀的唯一来源是同包的协议常量。
  assert.ok(source.includes('const SESSION_FACTS_SSE_PATH = SESSION_STATE_STREAM_PATH'),
    '会话事实上游路径只许引用 session-state-protocol 的常量')
  assert.equal(SESSION_STATE_STREAM_PATH, '/chamber/session-state/stream')
})

test('credit: unacked bytes over the window pause the upstream reader; an ack resumes it without dropping a frame', async (t) => {
  const upstream = fakeSseUpstream()
  const harness = await startChannel({
    httpRequest: upstream.fn,
    creditWindowBytes: 64,
    resolveTargetFor: () => ({ baseUrl: 'http://127.0.0.1:41000' }),
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'pg-credit', family: 'pluginGraph', instanceId: 'dsh-x' })
  await client.waitForType('ready', 'pg-credit')
  const response = upstream.calls[0].res
  assert.equal(response.paused, false, 'a fresh subscription reads its upstream')

  const payload = 'x'.repeat(100)
  response.emit('data', Buffer.from(`data: ${payload}\n\n`))
  await waitFor(() => response.paused, 5000, 'upstream pause past the credit window')
  const first = await client.waitForType('item', 'pg-credit')
  assert.equal(first.data, payload, 'the item crosses the window in full — never dropped or truncated')

  // A partial ack leaves unacked bytes above the window: the reader stays paused.
  client.send({ type: 'ack', id: 'pg-credit', bytes: 30 })
  await sleep(50)
  assert.equal(response.paused, true, 'a partial ack does not resume the reader')

  client.send({ type: 'ack', id: 'pg-credit', bytes: 70 })
  await waitFor(() => response.paused === false, 5000, 'upstream resume after the full ack')

  response.emit('data', Buffer.from('data: after-resume\n\n'))
  await client.waitFor(message => message.type === 'item' && message.data === 'after-resume', 'post-resume item')
})

test('credit: an item frame over PAGE_CHANNEL_MAX_FRAME_CHARS fails that subscription instead of sending a droppable frame', async (t) => {
  const upstream = fakeSseUpstream()
  const harness = await startChannel({
    httpRequest: upstream.fn,
    resolveTargetFor: () => ({ baseUrl: 'http://127.0.0.1:41000' }),
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'pg-large', family: 'pluginGraph', instanceId: 'dsh-x' })
  await client.waitForType('ready', 'pg-large')
  // 输入必须走**转义溢出**这条路：data 载荷本身在帧上限之内（parser 上限也是同一
  // 常量，直接塞 4MiB 只会先撞 parser），但 JSON 帧把每个 `"` 转义成 `\"`，整帧翻倍
  // 越限——这才是 emitItem 那道闸门真实可达的形状。
  upstream.calls[0].res.emit('data', Buffer.from(`data: ${'"'.repeat(2_400_000)}\n\n`))

  const failure = await client.waitForType('error', 'pg-large')
  assert.equal(failure.code, 'upstream_failed')
  assert.match(String(failure.message), /frame cap/u, '失败原因必须点名帧上限，而不是含糊的上游错误')
  assert.equal(client.messages.filter(message => message.type === 'item').length, 0, 'an over-cap frame is never emitted')
})

test('upstream_timeout: no response headers within the per-subscription deadline destroys the request', async (t) => {
  const requests: any[] = []
  const fn: any = () => {
    const req: any = new EventEmitter()
    req.destroyed = false
    req.end = () => {}
    req.destroy = () => {
      if (req.destroyed) return
      req.destroyed = true
      req.emit('error', new Error('aborted'))
    }
    requests.push(req)
    return req
  }
  const harness = await startChannel({
    httpRequest: fn,
    upstreamHeadersTimeoutMs: 40,
    resolveTargetFor: () => ({ baseUrl: 'http://127.0.0.1:41000' }),
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'pg-slow', family: 'pluginGraph', instanceId: 'dsh-x' })
  const failure = await client.waitForType('error', 'pg-slow', 5000)
  assert.equal(failure.code, 'upstream_timeout')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].destroyed, true, 'the timed-out upstream request is destroyed')
})

test('upstream headers: host/rewritten origin/accept, no accept-encoding, transport headers last, cookie only from authCookieFor', async (t) => {
  const upstream = fakeSseUpstream()
  const baseUrl = 'http://127.0.0.1:41000'
  const harness = await startChannel({
    httpRequest: upstream.fn,
    resolveTargetFor: () => ({
      baseUrl,
      headers: { authorization: 'Bearer transport-token', cookie: 'gw=1' },
    }),
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  registerAuthCookie(baseUrl, 'auth=1')
  t.after(() => clearAuthCookie(baseUrl))

  client.send({ type: 'subscribe', id: 'pg-headers', family: 'pluginGraph', instanceId: 'gateway-x' })
  await client.waitForType('ready', 'pg-headers')
  const headers = upstream.calls[0].options.headers
  assert.equal(upstream.calls[0].url.href, `${baseUrl}/plugins/events`)
  assert.equal(headers.host, '127.0.0.1:41000')
  assert.equal(headers.origin, baseUrl, 'Origin is rewritten to the target origin')
  assert.equal(headers.accept, 'text/event-stream')
  assert.equal(headers['accept-encoding'], undefined, 'a long-lived SSE leg never negotiates compression')
  assert.equal(headers.authorization, 'Bearer transport-token', 'per-transport headers ride last')
  assert.equal(headers.cookie, 'auth=1', 'the browser-auth cookie is the only cookie source and wins, as in instance-proxy')

  client.send({ type: 'unsubscribe', id: 'pg-headers' })
  clearAuthCookie(baseUrl)
  client.send({ type: 'subscribe', id: 'pg-headers-2', family: 'pluginGraph', instanceId: 'gateway-x' })
  await client.waitForType('ready', 'pg-headers-2')
  assert.equal(upstream.calls[1].options.headers.cookie, 'gw=1', 'without a browser-auth cookie the transport cookie is all that rides')
})

test('transport headers cannot override the SSE identity/host discipline (only authorization/cookie pass)', async (t) => {
  const upstream = fakeSseUpstream()
  const baseUrl = 'http://127.0.0.1:41000'
  const harness = await startChannel({
    httpRequest: upstream.fn,
    resolveTargetFor: () => ({
      baseUrl,
      // 敌意/陈旧传输头：registerTransport 会校验白名单，但通道自己的纵深防御
      // （与 proxy-forward.ts forwardHttp 同形）必须让它们一条都进不去。
      headers: {
        authorization: 'Bearer transport-token',
        cookie: 'gw=1',
        'accept-encoding': 'gzip',
        host: 'evil.example',
        origin: 'http://evil.example',
        accept: 'text/html',
      },
    }),
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'pg-hostile', family: 'pluginGraph', instanceId: 'gateway-x' })
  await client.waitForType('ready', 'pg-hostile')
  const headers = upstream.calls[0].options.headers
  assert.equal(headers.host, '127.0.0.1:41000', 'the target authority wins over a transport host')
  assert.equal(headers.origin, baseUrl, 'Origin stays the rewritten target origin')
  assert.equal(headers.accept, 'text/event-stream', 'a transport accept cannot downgrade the SSE identity')
  assert.equal(headers['accept-encoding'], undefined, 'a transport accept-encoding can never re-introduce compression')
  assert.equal(headers.authorization, 'Bearer transport-token', 'the sanctioned authorization still rides last')
  assert.equal(headers.cookie, 'gw=1', 'the sanctioned cookie still rides last')
})

test('an unterminated data line over the frame cap fails the subscription and destroys the upstream', async (t) => {
  const upstream = fakeSseUpstream()
  const harness = await startChannel({
    httpRequest: upstream.fn,
    resolveTargetFor: () => ({ baseUrl: 'http://127.0.0.1:41000' }),
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'pg-unterminated', family: 'pluginGraph', instanceId: 'dsh-x' })
  await client.waitForType('ready', 'pg-unterminated')
  const response = upstream.calls[0].res
  // 一条没有换行的巨行只在 parser 的 buffer 里增长：成帧检查（JSON.stringify 之后）
  // 根本看不到它，所以边界必须在 parser 内。
  response.emit('data', Buffer.from(`data: ${'y'.repeat(PAGE_CHANNEL_MAX_FRAME_CHARS)}`))

  const failure = await client.waitForType('error', 'pg-unterminated')
  assert.equal(failure.code, 'upstream_failed')
  assert.ok(failure.message.includes(String(PAGE_CHANNEL_MAX_FRAME_CHARS)), 'the failure names the frame cap')
  assert.equal(response.destroyed, true, 'the offending upstream is destroyed')
  assert.equal(client.messages.filter(message => message.type === 'item').length, 0)
})

test('a multi-line event whose data lines accumulate over the frame cap fails the subscription', async (t) => {
  const upstream = fakeSseUpstream()
  const harness = await startChannel({
    httpRequest: upstream.fn,
    resolveTargetFor: () => ({ baseUrl: 'http://127.0.0.1:41000' }),
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'pg-multiline', family: 'pluginGraph', instanceId: 'dsh-x' })
  await client.waitForType('ready', 'pg-multiline')
  const response = upstream.calls[0].res
  // 每条 data 行都是完整行（buffer 被立即消费），累积只发生在 pending data 行里：
  // 五条 1MB 的行超过 4MiB 上限。
  const line = Buffer.from(`data: ${'z'.repeat(1_000_000)}\n`)
  for (let index = 0; index < 5; index += 1) response.emit('data', line)

  const failure = await client.waitForType('error', 'pg-multiline')
  assert.equal(failure.code, 'upstream_failed')
  assert.ok(failure.message.includes(String(PAGE_CHANNEL_MAX_FRAME_CHARS)), 'the failure names the frame cap')
  assert.equal(response.destroyed, true, 'the offending upstream is destroyed')
})

test('a gateway authority override becomes the Host header', async (t) => {
  const upstream = fakeSseUpstream()
  const harness = await startChannel({
    httpRequest: upstream.fn,
    resolveTargetFor: () => ({ baseUrl: 'http://127.0.0.1:41000', authority: '127.0.0.1:4444' }),
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'pg-authority', family: 'pluginGraph', instanceId: 'gateway-tunnel' })
  await client.waitForType('ready', 'pg-authority')
  assert.equal(upstream.calls[0].options.headers.host, '127.0.0.1:4444')
  assert.equal(upstream.calls[0].options.headers.origin, 'http://127.0.0.1:4444')
})

test('SSE 行终止符与分块：CRLF、裸 CR、跨块多字节字符都按 WHATWG 语义成帧', async (t) => {
  const upstream = fakeSseUpstream()
  const harness = await startChannel({
    httpRequest: upstream.fn,
    resolveTargetFor: () => ({ baseUrl: 'http://127.0.0.1:41000' }),
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'pg-frames', family: 'pluginGraph', instanceId: 'dsh-x' })
  await client.waitForType('ready', 'pg-frames')
  const response = upstream.calls[0].res
  // 多字节字符与 CRLF 一起被 TCP 分块切开：第一块停在「中」的 UTF-8 中间。
  response.emit('data', Buffer.from('event: graph\r\ndata: {"note":"中', 'utf8'))
  response.emit('data', Buffer.from('文"}\r\n\r\ndata: second\r\n\r\n', 'utf8'))
  await client.waitFor(message => message.type === 'item' && message.data === '{"note":"中文"}', 'split multi-byte item')
  const items = client.messages.filter(message => message.type === 'item')
  assert.deepEqual(items.map(message => [message.event, message.data]),
    [['graph', '{"note":"中文"}'], ['message', 'second']],
    '跨块 CRLF 与多字节字符必须逐字成帧，且空行分帧后事件名复位')

  // 裸 CR 也是行终止符（WHATWG）：旧实现只认 \n，会在这种上游上永远吐不出 item。
  response.emit('data', Buffer.from('data: bare-cr\r\r', 'utf8'))
  await client.waitFor(message => message.type === 'item' && message.data === 'bare-cr', 'lone-CR terminated event')

  // 分块边界正好落在 CRLF 的 \r 与 \n 之间：那两字节仍是同一个终止符，绝不能被当成
  // 「裸 CR 收尾 + 下一块开头是空行」——那会丢掉事件名、把多行 data 拆成两条事件。
  response.emit('data', Buffer.from('event: split-cr\r', 'utf8'))
  response.emit('data', Buffer.from('\ndata: one\r\n\r\n', 'utf8'))
  await client.waitFor(message => message.type === 'item' && message.data === 'one', 'CR-split item')
  response.emit('data', Buffer.from('data: a\r', 'utf8'))
  response.emit('data', Buffer.from('\ndata: b\r\n\r\n', 'utf8'))
  await client.waitFor(message => message.type === 'item' && message.data === 'a\nb', 'CR-split multi-line data')
  const split = client.messages.filter(message => message.type === 'item').slice(-2)
  assert.deepEqual(split.map(message => [message.event, message.data]),
    [['split-cr', 'one'], ['message', 'a\nb']],
    '跨块 CRLF 必须是一个终止符：事件名保留、多行 data 合并为一条事件')
})

test('health: 生产者同步回调绝不越过 ready（帧序恒为 [ready, 快照, ...后续转移]）', async (t) => {
  const snapshot = { status: 'ready', port: 1234, error: null }
  const harness = await startChannel({
    // 同步回调：fan-out 实现没有异步义务，契约必须由通道自己保证。
    subscribeHealthEvents: listener => { listener(snapshot); return () => {} },
    currentHealthSnapshot: () => snapshot,
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'h-sync', family: 'health' })
  await client.waitForType('ready', 'h-sync')
  await client.waitFor(message => message.type === 'item' && message.id === 'h-sync', 'snapshot item')
  assert.deepEqual(client.messages.filter(message => message.id === 'h-sync').map(message => message.type),
    ['ready', 'item'],
    '同步转移不得先于 ready；有快照读取面时只发最新一条（整量投影，中间态被取代不算丢）')

  // 同步连发多条：只保留**最后**一条（整量投影，中间态被后一条完全取代）。
  let latest: { status: string; port: number | null; error: string | null } | undefined
  const burst = await startChannel({
    subscribeHealthEvents: listener => {
      for (const port of [1, 2, 3]) { latest = { status: 'ready', port, error: null }; listener(latest) }
      return () => {}
    },
  })
  t.after(() => burst.close())
  const burstClient = await burst.connect()
  t.after(() => burstClient.ws.close())
  burstClient.send({ type: 'subscribe', id: 'h-burst', family: 'health' })
  await burstClient.waitForType('ready', 'h-burst')
  await burstClient.waitFor(
    message => message.type === 'item' && String(message.data).includes('"port":3'), 'burst 最新快照')
  // 一次订阅里只该出现 ready + 一条 item（没有快照读取面时用同步期最后一条补发）。
  await new Promise(resolve => { setTimeout(resolve, 30) })
  assert.deepEqual(burstClient.messages.filter(message => message.id === 'h-burst').map(message => message.type),
    ['ready', 'item'],
    '同步连发 N 条只补发最后一条，绝不补成一串中间态')
})

test('logger 抛错不得打断流：attach/subscribe/ready/item/closeAll 照常', async (t) => {
  const upstream = fakeSseUpstream()
  const harness = await startChannel({
    httpRequest: upstream.fn,
    resolveTargetFor: () => ({ baseUrl: 'http://127.0.0.1:41000' }),
    // 外部 logger（文件/IPC sink）抛错绝不能在 'data' 回调里变成未捕获异常把控制面带崩。
    logger: {
      log: () => { throw new Error('log sink down') },
      warn: () => { throw new Error('warn sink down') },
    } as never,
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'pg-log', family: 'pluginGraph', instanceId: 'dsh-x' })
  await client.waitForType('ready', 'pg-log')
  upstream.calls[0].res.emit('data', Buffer.from('data: survived\n\n'))
  await client.waitFor(message => message.type === 'item' && message.data === 'survived', 'item with a throwing logger')
  harness.channel.closeAll()
  await client.waitFor(() => client.ws.readyState === 3, 'socket closed despite the throwing logger')
})

test('SSE 保活注释夹在 data 行之间：不切碎事件、不复制事件、按序透传', async (t) => {
  const upstream = fakeSseUpstream()
  const harness = await startChannel({
    httpRequest: upstream.fn,
    resolveTargetFor: () => ({ baseUrl: 'http://127.0.0.1:41000' }),
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'pg-keepalive', family: 'pluginGraph', instanceId: 'dsh-x' })
  await client.waitForType('ready', 'pg-keepalive')
  upstream.calls[0].res.emit('data', Buffer.from('data: a\n: keepalive\ndata: b\n\n'))
  await client.waitFor(message => message.type === 'item' && message.event === 'keepalive', 'keepalive item')
  await client.waitFor(message => message.type === 'item' && message.data === 'a\nb', 'joined multi-line data')
  const items = client.messages.filter(message => message.type === 'item')
  assert.deepEqual(items.map(message => [message.event, message.data]),
    [['keepalive', ''], ['message', 'a\nb']],
    '注释只贡献一条 keepalive item，data 行照旧用 \\n 连接')
})

test('信用窗口的真实边界：一个读取块里的多条事件全部按序发出，窗口只停止之后的读取', async (t) => {
  const upstream = fakeSseUpstream()
  const harness = await startChannel({
    httpRequest: upstream.fn,
    creditWindowBytes: 32,
    resolveTargetFor: () => ({ baseUrl: 'http://127.0.0.1:41000' }),
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'pg-burst', family: 'pluginGraph', instanceId: 'dsh-x' })
  await client.waitForType('ready', 'pg-burst')
  const count = 40
  const burst = Array.from({ length: count }, (_value, index) => `data: item-${String(index)}\n\n`).join('')
  upstream.calls[0].res.emit('data', Buffer.from(burst))
  await client.waitFor(
    () => client.messages.filter(message => message.type === 'item').length === count,
    'all burst items',
    5000,
  )
  assert.deepEqual(
    client.messages.filter(message => message.type === 'item').map(message => message.data),
    Array.from({ length: count }, (_value, index) => `item-${String(index)}`),
    '窗口暂停的是之后的读取，不是当前块——已解析的事件必须逐条按序发出、不丢不重',
  )
  assert.equal(upstream.calls[0].res.paused, true, '超过窗口后该订阅的上游确实被暂停')
})
