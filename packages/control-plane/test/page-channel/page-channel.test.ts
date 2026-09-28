/**
 * Page-level multiplex channel, server half (design 26) — behavior lock.
 *
 * The endpoint is ONE WebSocket per page carrying logical subscriptions. What
 * must hold, or the page silently loses its only long-lived connection:
 *  - health is control-plane-native (fake producer): ready right after wiring,
 *    each snapshot an item frame, unsubscribe releases the producer;
 *  - pluginGraph / sessionFacts are one upstream SSE per subscription, with the
 *    SSE block shape preserved (event name verbatim, default 'message',
 *    multi-line data joined with \n, comments forwarded as empty-data keepalive items);
 *  - sessionFacts is a gateway capability: a dsh-kind id must fail
 *    capability_not_found WITHOUT opening an upstream;
 *  - unsubscribe / socket close / closeAll destroy the upstream response,
 *    remove the producer subscription and never leak a half-open leg;
 *  - malformed client frames are ignored and one subscription's failure never
 *    reaches another's.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import {
  PAGE_CHANNEL_MAX_CLIENT_FRAME_CHARS,
  PAGE_CHANNEL_MAX_FRAME_CHARS,
  PAGE_CHANNEL_PATH,
  pageChannelSubscribeFrame,
} from '@dsh-chamber/dsh-chamber-wire/page-channel'
import { createPageChannel, startPageChannelHeartbeat, type PageChannelDeps } from '../../src/page-channel.ts'
import { waitFor } from '../support/utils.ts'

const quietLogger = { log: () => {}, warn: () => {}, error: () => {} }

interface PageClient {
  ws: WebSocket
  messages: any[]
  send(message: unknown): void
  waitFor(predicate: (message: any) => boolean, what: string, timeoutMs?: number): Promise<any>
  waitForType(type: string, id?: string, timeoutMs?: number): Promise<any>
  items(id?: string): any[]
}

/** The page side of the channel: records every parsed server frame in order. */
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
      items(id?: string) {
        return messages.filter(message => message.type === 'item' && (id === undefined || message.id === id))
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

/** A bare HTTP server whose only route is the page-channel upgrade. */
async function startChannel(overrides: Partial<PageChannelDeps> = {}): Promise<Harness> {
  const channel = createPageChannel({
    logger: quietLogger,
    subscribeHealthEvents: () => () => {},
    resolveTargetFor: () => null,
    ...overrides,
  })
  const server = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not_found"}')
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

/** A local SSE upstream; returns its origin plus the recorded requests. */
async function startSseUpstream(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const requests: Array<{ url: string | undefined; headers: IncomingHttpHeaders }> = []
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers })
    handler(req, res)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close(): Promise<void> {
      server.closeAllConnections?.()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    },
  }
}

// ---------------------------------------------------------------------------
// health: control-plane-native producer
// ---------------------------------------------------------------------------

test('health: ready right after the producer is wired, snapshots become item frames, unsubscribe releases the producer', async (t) => {
  const producers = new Set<(snapshot: { status: string; port: number | null; error: string | null }) => void>()
  const harness = await startChannel({
    subscribeHealthEvents: listener => {
      producers.add(listener)
      return () => { producers.delete(listener) }
    },
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send(pageChannelSubscribeFrame({ type: 'subscribe', id: 'health-1', family: 'health' }))
  await client.waitForType('ready', 'health-1')
  assert.equal(producers.size, 1, 'ready is sent immediately after wiring the native producer')

  for (const listener of producers) listener({ status: 'ready', port: 17510, error: null })
  const first = await client.waitForType('item', 'health-1')
  assert.equal(first.event, 'message', 'a native snapshot carries the default SSE event name')
  assert.deepEqual(JSON.parse(first.data), { ok: true, dsh: { status: 'ready', port: 17510 } }, 'the payload mirrors /api/host/health-events')

  for (const listener of producers) listener({ status: 'stopped', port: null, error: 'exited' })
  await client.waitFor(() => client.items('health-1').length === 2, 'second health item')
  const second = client.items('health-1')[1]
  assert.deepEqual(JSON.parse(second.data), { ok: true, dsh: { status: 'stopped', port: 0, error: 'exited' } })

  client.send({ type: 'unsubscribe', id: 'health-1' })
  await waitFor(() => producers.size === 0, 5000, 'health producer unsubscribe')
  assert.equal(client.messages.filter(message => message.type === 'error').length, 0, 'a clean unsubscribe is not an error')
})

test('health: subscribe emits exactly [ready, current snapshot] with no producer transition', async (t) => {
  const harness = await startChannel({
    subscribeHealthEvents: () => () => {},
    currentHealthSnapshot: () => ({ status: 'ready', port: 17510, error: null }),
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send(pageChannelSubscribeFrame({ type: 'subscribe', id: 'health-snapshot', family: 'health' }))
  await client.waitFor(() => client.messages.length >= 2, 'ready plus the subscribe-time snapshot')
  // 节奏栅栏：给生产者/上游任何迟到的帧一个出现的窗口；没有转移时恰好两帧。
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(
    client.messages.map(message => [message.type, message.id]),
    [['ready', 'health-snapshot'], ['item', 'health-snapshot']],
    'the frame order is ready then exactly one snapshot item',
  )
  assert.equal(client.messages[1].event, 'message', 'the snapshot carries the default SSE event name')
  assert.deepEqual(
    JSON.parse(client.messages[1].data),
    { ok: true, dsh: { status: 'ready', port: 17510 } },
    'the snapshot payload is the same projection the producer pushes on transitions',
  )
})

// ---------------------------------------------------------------------------
// pluginGraph / sessionFacts: upstream SSE
// ---------------------------------------------------------------------------

test('pluginGraph: one upstream GET /plugins/events; SSE blocks become item frames verbatim', async (t) => {
  const upstream = await startSseUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write('event: graph\ndata: {"rev":1}\n\n')
    res.write('data: line-1\ndata: line-2\n\n')
    res.write(': heartbeat\n\n')
    res.write('event: graph\ndata: {"rev":2}\n\n')
  })
  t.after(() => upstream.close())
  const harness = await startChannel({
    resolveTargetFor: id => (id === 'dsh-live' ? { baseUrl: upstream.baseUrl } : null),
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'pg-1', family: 'pluginGraph', instanceId: 'dsh-live' })
  await client.waitForType('ready', 'pg-1')
  await client.waitFor(() => client.items('pg-1').length >= 4, 'four plugin-graph items')

  assert.deepEqual(client.items('pg-1').map(item => [item.event, item.data]), [
    ['graph', '{"rev":1}'],
    ['message', 'line-1\nline-2'],
    // 上游注释行 = 仍活着的证据：data 为空的 keepalive item（消费方只看续期，不当状态帧）。
    ['keepalive', ''],
    ['graph', '{"rev":2}'],
  ], 'event names are verbatim, multi-line data joins with \\n, comments become empty-data keepalive items')

  assert.equal(upstream.requests.length, 1, 'exactly one upstream per live subscription')
  assert.equal(upstream.requests[0].url, '/plugins/events')
  // 头纪律（accept-encoding/host/origin 与 auth/cookie 优先级）由 flow 用例统一锁，
  // 这里只留 SSE 形状本身，避免同一断言在三处漂移。
  assert.equal(upstream.requests[0].headers.accept, 'text/event-stream')
})

test('sessionFacts: a gateway instance streams /chamber/session-state/stream', async (t) => {
  const upstream = await startSseUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: session-state\ndata: {"revision":3}\n\n')
  })
  t.after(() => upstream.close())
  const harness = await startChannel({
    resolveTargetFor: id => (id === 'gateway-facts' ? { baseUrl: upstream.baseUrl } : null),
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'sf-1', family: 'sessionFacts', instanceId: 'gateway-facts' })
  await client.waitForType('ready', 'sf-1')
  const item = await client.waitForType('item', 'sf-1')
  assert.equal(item.event, 'session-state')
  assert.equal(item.data, '{"revision":3}')
  assert.equal(upstream.requests[0].url, '/chamber/session-state/stream')
})

test('sessionFacts: a non-gateway instance fails capability_not_found without opening an upstream', async (t) => {
  let resolved = 0
  const harness = await startChannel({
    resolveTargetFor: () => {
      resolved += 1
      return { baseUrl: 'http://127.0.0.1:1' }
    },
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'sf-dsh', family: 'sessionFacts', instanceId: 'dsh-x' })
  const failure = await client.waitForType('error', 'sf-dsh')
  assert.equal(failure.code, 'capability_not_found')
  assert.equal(resolved, 0, 'a capability miss is decided before target resolution')

  // The channel itself stays usable: another subscription still opens normally.
  client.send({ type: 'subscribe', id: 'health-after', family: 'health' })
  await client.waitForType('ready', 'health-after')
})

test('pluginGraph: an unresolvable instance answers instance_unavailable and the channel keeps working', async (t) => {
  const harness = await startChannel({ resolveTargetFor: () => null })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'pg-missing', family: 'pluginGraph', instanceId: 'dsh-missing' })
  const failure = await client.waitForType('error', 'pg-missing')
  assert.equal(failure.code, 'instance_unavailable')

  client.send({ type: 'subscribe', id: 'health-2', family: 'health' })
  await client.waitForType('ready', 'health-2')
})

test('an upstream answering non-200 fails that subscription with upstream_failed', async (t) => {
  const upstream = await startSseUpstream((_req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain' })
    res.end('unavailable')
  })
  t.after(() => upstream.close())
  const harness = await startChannel({ resolveTargetFor: () => ({ baseUrl: upstream.baseUrl }) })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'pg-503', family: 'pluginGraph', instanceId: 'dsh-x' })
  const failure = await client.waitForType('error', 'pg-503')
  assert.equal(failure.code, 'upstream_failed')
  assert.match(failure.message, /503/)
  assert.equal(client.items('pg-503').length, 0)
})

test('a 200 with a non-SSE content-type fails the subscription before ready instead of black-holing it', async (t) => {
  const upstream = await startSseUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><body>SPA fallback</body></html>')
  })
  t.after(() => upstream.close())
  const harness = await startChannel({ resolveTargetFor: () => ({ baseUrl: upstream.baseUrl }) })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'pg-html', family: 'pluginGraph', instanceId: 'dsh-x' })
  const failure = await client.waitForType('error', 'pg-html')
  assert.equal(failure.code, 'upstream_failed')
  assert.match(failure.message, /text\/html/)
  assert.equal(client.messages.filter(message => message.type === 'ready' && message.id === 'pg-html').length, 0, 'the content-type check runs before ready')
})

test('a 200 without a content-type stays tolerated (SSE is assumed)', async (t) => {
  const upstream = await startSseUpstream((_req, res) => {
    // writeHead without content-type: Node adds none, so the channel must assume SSE.
    res.writeHead(200)
    res.write('event: graph\ndata: {"rev":9}\n\n')
  })
  t.after(() => upstream.close())
  const harness = await startChannel({ resolveTargetFor: () => ({ baseUrl: upstream.baseUrl }) })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'pg-no-ct', family: 'pluginGraph', instanceId: 'dsh-x' })
  await client.waitForType('ready', 'pg-no-ct')
  const item = await client.waitForType('item', 'pg-no-ct')
  assert.equal(item.event, 'graph')
})

test('an upstream that ends sends end (not error) and releases the subscription', async (t) => {
  const upstream = await startSseUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: one\n\n')
    res.end()
  })
  t.after(() => upstream.close())
  const harness = await startChannel({ resolveTargetFor: () => ({ baseUrl: upstream.baseUrl }) })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'pg-end', family: 'pluginGraph', instanceId: 'dsh-x' })
  await client.waitForType('item', 'pg-end')
  await client.waitForType('end', 'pg-end')
  assert.equal(client.messages.filter(message => message.type === 'error').length, 0)
  // 「releases the subscription」必须是可断言的：订阅表、生产者监听与上游都要收掉。
  await waitFor(() => harness.channel.stats().subscriptions === 0, 1_000, 'end 之后订阅计数归零')
})

// ---------------------------------------------------------------------------
// teardown: unsubscribe / socket close / closeAll
// ---------------------------------------------------------------------------

test('unsubscribe destroys the upstream response and stops forwarding', async (t) => {
  let closed = 0
  const upstream = await startSseUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: first\n\n')
    res.on('close', () => { closed += 1 })
  })
  t.after(() => upstream.close())
  const harness = await startChannel({ resolveTargetFor: () => ({ baseUrl: upstream.baseUrl }) })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'pg-unsub', family: 'pluginGraph', instanceId: 'dsh-x' })
  await client.waitForType('item', 'pg-unsub')
  client.send({ type: 'unsubscribe', id: 'pg-unsub' })
  await waitFor(() => closed > 0, 5000, 'upstream response destroy')
  const seen = client.items('pg-unsub').length
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(client.items('pg-unsub').length, seen, 'no frames after unsubscribe')
})

test('a socket close destroys every upstream and every producer subscription', async (t) => {
  let upstreamClosed = 0
  const upstream = await startSseUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders()
    res.on('close', () => { upstreamClosed += 1 })
  })
  t.after(() => upstream.close())
  const producers = new Set<(snapshot: { status: string; port: number | null; error: string | null }) => void>()
  const harness = await startChannel({
    subscribeHealthEvents: listener => {
      producers.add(listener)
      return () => { producers.delete(listener) }
    },
    resolveTargetFor: () => ({ baseUrl: upstream.baseUrl }),
  })
  t.after(() => harness.close())
  const client = await harness.connect()

  client.send({ type: 'subscribe', id: 'health-close', family: 'health' })
  client.send({ type: 'subscribe', id: 'pg-close', family: 'pluginGraph', instanceId: 'dsh-x' })
  await client.waitForType('ready', 'health-close')
  await client.waitForType('ready', 'pg-close')
  assert.equal(producers.size, 1)

  client.ws.close()
  await waitFor(() => producers.size === 0 && upstreamClosed > 0, 5000, 'socket-close teardown')
})

test('closeAll closes every live socket with 1012 and destroys its upstreams', async (t) => {
  let upstreamClosed = 0
  const upstream = await startSseUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders()
    res.on('close', () => { upstreamClosed += 1 })
  })
  t.after(() => upstream.close())
  const producers = new Set<(snapshot: { status: string; port: number | null; error: string | null }) => void>()
  const harness = await startChannel({
    subscribeHealthEvents: listener => {
      producers.add(listener)
      return () => { producers.delete(listener) }
    },
    resolveTargetFor: () => ({ baseUrl: upstream.baseUrl }),
  })
  t.after(() => harness.close())
  const healthClient = await harness.connect()
  const graphClient = await harness.connect()

  healthClient.send({ type: 'subscribe', id: 'health-shutdown', family: 'health' })
  graphClient.send({ type: 'subscribe', id: 'pg-shutdown', family: 'pluginGraph', instanceId: 'dsh-x' })
  await healthClient.waitForType('ready', 'health-shutdown')
  await graphClient.waitForType('ready', 'pg-shutdown')

  const healthClose = new Promise<number>(resolve => { healthClient.ws.once('close', code => resolve(code)) })
  const graphClose = new Promise<number>(resolve => { graphClient.ws.once('close', code => resolve(code)) })
  harness.channel.closeAll()

  assert.equal(await healthClose, 1012, 'closeAll uses the service-restart close code')
  assert.equal(await graphClose, 1012)
  assert.equal(producers.size, 0, 'the native producer subscription is released')
  assert.equal(upstreamClosed, 1, 'the upstream response is destroyed')
})

// ---------------------------------------------------------------------------
// robustness
// ---------------------------------------------------------------------------

test('malformed client frames are ignored, logged, and the socket stays usable', async (t) => {
  const warnings: string[] = []
  const harness = await startChannel({
    logger: { log: () => {}, warn: message => { warnings.push(String(message)) }, error: () => {} },
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.ws.send('not json at all')
  client.ws.send('{}')
  client.ws.send(JSON.stringify({ type: 'subscribe', id: '', family: 'health' }))
  client.ws.send(JSON.stringify({ type: 'subscribe', id: 'x', family: 'nope' }))
  client.ws.send(JSON.stringify({ type: 'subscribe', id: 'x', family: 'pluginGraph' }))
  // 类型混淆：`String(['pluginGraph'])` 会通过集合检查，但族比较是 ===，数组会让订阅滑进
  // SSE 分支并绕过 sessionFacts 的 gateway /chamber 围栏（capability_not_found）。
  client.ws.send(JSON.stringify({ type: 'subscribe', id: 'crafted', family: ['pluginGraph'], instanceId: 'dsh-x' }))
  client.ws.send(JSON.stringify({ type: 'subscribe', id: 'crafted2', family: { toString: () => 'pluginGraph' }, instanceId: 'dsh-x' }))
  client.ws.send(JSON.stringify({ type: 'ack', id: 'x', bytes: -1 }))
  client.ws.send(JSON.stringify({ type: 'unknown' }))
  client.ws.send(Buffer.from('binary-frame'))
  // 精确条数（9 条畸形帧各一条；二进制帧按设计不记）：`some(...)` 会让一个静默接受某种
  // 形状（例如负数 ack）的解析器照样通过。
  const ignored = () => warnings.filter(message => message.includes('ignored malformed client frame'))
  await waitFor(() => ignored().length === 9, 1_000, '9 条畸形帧各留一条 warn')
  assert.equal(ignored().length, 9, '每条畸形帧恰好一条 warn，不多不少')
  assert.equal(client.messages.length, 0, 'no frame is answered before a valid subscribe')

  client.send({ type: 'subscribe', id: 'health-ok', family: 'health' })
  await client.waitForType('ready', 'health-ok')
})

test('attachSocket：注册监听器时同步 close 的非标准宿主不留幽灵条目与心跳孤儿', async (t) => {
  const harness = await startChannel()
  t.after(() => harness.close())
  // 非标准 ws 宿主：`on()` 注册即派发。真实 ws 的 on() 从不同步回调，所以这两条时序
  // 只能靠这条注入缝覆盖；它们都是「幽灵」类：进表了却没有任何路径能删掉。
  const syncCloseHost = (trigger: 'close' | 'pong') => {
    const fake = {
      readyState: 1,
      on(event: string, fn: (...args: unknown[]) => void) {
        // 非标准宿主：注册即派发。参数必须与真实 ws 一致（close 带 code + reason Buffer），
        // 否则触发的不是这条时序，而是 close 回调自己的异常（走了 attach 的 catch 路径）。
        if (event === trigger) fn(1006, Buffer.alloc(0))
        return fake
      },
      ping() {},
      close() {},
      terminate() {},
      send() {},
    }
    return fake
  }

  // 变体 1：close 监听器注册时同步关闭 → teardown 先跑完，attach 不得再进表。
  harness.channel.attachSocket(syncCloseHost('close') as never)
  assert.deepEqual(harness.channel.stats(), { sockets: 0, subscriptions: 0, upstreams: 0 },
    '同步关闭的 socket 不得进 liveSockets（stats 永远虚高的幽灵条目）')
  harness.channel.closeAll()
  assert.equal(harness.channel.stats().sockets, 0, '幽灵条目连 closeAll 都删不掉，必须根本不存在')

  // 变体 2（同一时序的定时器面）：心跳在 close 监听器**之前**启动，所以同步 close 时
  // 已经有一条活的心跳；收尾必须把它停干净，不能留下永远 ping 下去的 unref 定时器。
  const intervals = new Set<unknown>()
  const cleared: unknown[] = []
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = ((handler: () => void, ms: number) => {
    const id = realSetInterval(handler, ms)
    intervals.add(id)
    return id
  }) as never
  globalThis.clearInterval = ((id: unknown) => {
    cleared.push(id)
    realClearInterval(id as never)
  }) as never
  try {
    harness.channel.attachSocket(syncCloseHost('close') as never)
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
  assert.equal(harness.channel.stats().sockets, 0, '同步关闭的 socket 同样不得进表')
  assert.ok(intervals.size >= 1, '这一轮确实启动了心跳（否则本变体没有意义）')
  for (const id of intervals) assert.ok(cleared.includes(id), '心跳定时器必须被清掉（不留永久 ping 的孤儿）')
})

test('one subscription failing never disturbs another on the same socket', async (t) => {
  const bad = await startSseUpstream((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('boom')
  })
  const good = await startSseUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: alive\n\n')
  })
  t.after(() => bad.close())
  t.after(() => good.close())
  const harness = await startChannel({
    resolveTargetFor: id => ({ baseUrl: id === 'dsh-bad' ? bad.baseUrl : good.baseUrl }),
  })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  client.send({ type: 'subscribe', id: 'pg-bad', family: 'pluginGraph', instanceId: 'dsh-bad' })
  client.send({ type: 'subscribe', id: 'pg-good', family: 'pluginGraph', instanceId: 'dsh-good' })
  await client.waitForType('ready', 'pg-good')
  await client.waitForType('item', 'pg-good')
  assert.equal(client.messages.filter(message => message.type === 'item' && message.id === 'pg-bad').length, 0)
  const failures = client.messages.filter(message => message.type === 'error' && message.id === 'pg-bad')
  assert.equal(failures.length, 1)
})

test('stats reports live accounting only: one upstream per non-health subscription, no capacity latch', async (t) => {
  const upstream = await startSseUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: alive\n\n')
  })
  t.after(() => upstream.close())
  const harness = await startChannel({ resolveTargetFor: () => ({ baseUrl: upstream.baseUrl }) })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())

  assert.deepEqual(harness.channel.stats(), { sockets: 1, subscriptions: 0, upstreams: 0 })
  client.send({ type: 'subscribe', id: 'health-stats', family: 'health' })
  client.send({ type: 'subscribe', id: 'pg-stats', family: 'pluginGraph', instanceId: 'dsh-x' })
  await client.waitForType('ready', 'pg-stats')
  assert.deepEqual(harness.channel.stats(), { sockets: 1, subscriptions: 2, upstreams: 1 })

  client.send({ type: 'unsubscribe', id: 'health-stats' })
  await waitFor(() => harness.channel.stats().subscriptions === 1, 5000, 'subscription accounting after unsubscribe')
  assert.deepEqual(harness.channel.stats(), { sockets: 1, subscriptions: 1, upstreams: 1 })

  client.ws.close()
  await waitFor(() => harness.channel.stats().sockets === 0, 5000, 'socket accounting after close')
  assert.deepEqual(harness.channel.stats(), { sockets: 0, subscriptions: 0, upstreams: 0 })
})

test('an oversized client frame is rejected at the transport boundary with close code 1009', async (t) => {
  const harness = await startChannel()
  t.after(() => harness.close())
  const client = await harness.connect()
  assert.ok(PAGE_CHANNEL_MAX_CLIENT_FRAME_CHARS < PAGE_CHANNEL_MAX_FRAME_CHARS, 'the client frame cap is the small one')

  const closed = new Promise<number>(resolve => { client.ws.once('close', code => resolve(code)) })
  client.ws.send('x'.repeat(PAGE_CHANNEL_MAX_CLIENT_FRAME_CHARS + 1))
  const code = await Promise.race([closed, new Promise<number>(resolve => { const timer = setTimeout(() => resolve(-1), 5000); timer.unref?.() })])
  assert.equal(code, 1009, 'ws maxPayload is PAGE_CHANNEL_MAX_CLIENT_FRAME_CHARS, not the host->client item cap')
})

// ---------------------------------------------------------------------------
// liveness: the native ws ping/pong heartbeat
// ---------------------------------------------------------------------------

test('heartbeat: one pong-less cycle tears the socket down and clears the interval', () => {
  let pings = 0
  let dead = 0
  let cleared = 0
  let tick: () => void = () => {}
  const stop = startPageChannelHeartbeat(
    { ping() { pings += 1 }, terminate() {}, on() {}, removeListener() {} },
    {
      intervalMs: 30_000,
      missesBeforeTeardown: 1,
      onDead: () => { dead += 1 },
      schedule: next => { tick = next; return { clear: () => { cleared += 1 } } },
    },
  )
  assert.equal(pings, 1, 'the first cycle pings without counting a miss (no pong is outstanding yet)')
  tick()
  assert.equal(dead, 1, 'one full cycle without a pong is death: the round-trip is loopback, not scheduler noise')
  assert.equal(cleared, 1, 'the interval is cleared the moment the socket is judged dead')
  assert.equal(pings, 1, 'no ping is sent after the teardown')
  tick()
  assert.equal(dead, 1, 'a cleared heartbeat is inert')
  stop()
  assert.equal(cleared, 1, 'stop is idempotent and never double-clears')
})

test('heartbeat: a ponging socket survives cycles, stop clears the interval and further ticks are inert', () => {
  let pings = 0
  let dead = 0
  let cleared = 0
  let tick: () => void = () => {}
  let pong: () => void = () => {}
  const stop = startPageChannelHeartbeat(
    {
      ping() { pings += 1 },
      terminate() {},
      on(_event, listener) { pong = listener },
      removeListener() {},
    },
    {
      intervalMs: 30_000,
      missesBeforeTeardown: 1,
      onDead: () => { dead += 1 },
      schedule: next => { tick = next; return { clear: () => { cleared += 1 } } },
    },
  )
  for (let cycle = 0; cycle < 5; cycle += 1) {
    pong()
    tick()
  }
  assert.equal(pings, 6, 'every cycle pings while the client answers')
  assert.equal(dead, 0, 'a ponging socket is never torn down')
  stop()
  assert.equal(cleared, 1, 'stop clears the interval')
  tick()
  assert.equal(pings, 6, 'no ping after stop')
})

test('heartbeat: a well-behaved real client auto-pongs and stays open across many tiny cycles', async (t) => {
  const harness = await startChannel({ wsPingIntervalMs: 20, wsPingMissesBeforeTeardown: 1 })
  t.after(() => harness.close())
  const client = await harness.connect()
  t.after(() => client.ws.close())
  // 真客户端能观测到 ping 帧：不数它的话，这段在「心跳根本没挂上」时也会绿。
  let pings = 0
  client.ws.on('ping', () => { pings += 1 })

  client.send({ type: 'subscribe', id: 'health-hb', family: 'health' })
  await client.waitForType('ready', 'health-hb')
  // 20ms 一拍：200ms ≈ 10 拍，远多于「漏一拍即死」的判定窗口。
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.ok(pings >= 5, '心跳必须真的在 ping（收到 ' + String(pings) + ' 条）')
  assert.equal(client.ws.readyState, WebSocket.OPEN, 'the ws client pongs natively, so the heartbeat never fires')
  assert.equal(client.messages.filter(message => message.type === 'error').length, 0)

  // 心跳之后 socket 仍然可用（terminate 没有误杀）。
  client.send({ type: 'subscribe', id: 'health-hb-2', family: 'health' })
  await client.waitForType('ready', 'health-hb-2')
})
