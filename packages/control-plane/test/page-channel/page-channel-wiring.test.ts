/**
 * Page-channel wiring through createControlPlane (design 26) — the seams the
 * unit suites cannot see:
 *  - defaultUpgrade routes /api/page-channel to the channel (after the origin
 *    fence, before the instance proxy), on a REAL control-plane HTTP server;
 *  - resolveTargetFor is delegated to the instance proxy's transport registry
 *    (a registered dsh transport is really reached upstream);
 *  - plane.stop() reaches closeAll() and closes the page socket with 1012 —
 *    an upgraded socket escapes the HTTP server's connection tracking, so a
 *    missing closeAll would leave the page's only long connection dangling.
 */

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { PAGE_CHANNEL_PATH } from '@dsh-chamber/dsh-chamber-wire/page-channel'
import { createControlPlane } from '../../src/index.ts'
import { fakeWire, tempDir, waitFor } from '../support/utils.ts'

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

async function startPlane(t: TestContext, options: { upgradeMiddleware?: (req: unknown, socket: unknown, head: unknown, ctx: unknown) => Promise<boolean> } = {}) {
  const stateDir = tempDir(t, 'dsh-cp-page-channel-')
  const wire = fakeWire()
  const plane = createControlPlane({
    port: 0,
    stateDir,
    logger: quietLogger,
    localConnectionDeps: { spawnDsh: wire.spawnDsh, probeHostIdentity: wire.probeHostIdentity },
    ...options,
  })
  await plane.start()
  let stopped = false
  t.after(async () => {
    if (stopped) return
    stopped = true
    await plane.stop()
  })
  return {
    plane,
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      await plane.stop()
    },
  }
}

test('wiring: the plane serves /api/page-channel and stop() closes the page socket with 1012', async (t) => {
  const harness = await startPlane(t)
  const client = await connectClient(`ws://127.0.0.1:${harness.plane.port}${PAGE_CHANNEL_PATH}`)
  t.after(() => client.ws.terminate())

  client.send({ type: 'subscribe', id: 'health-e2e', family: 'health' })
  await client.waitForType('ready', 'health-e2e')

  const closed = new Promise<number>(resolve => { client.ws.once('close', code => resolve(code)) })
  await harness.stop()
  // 有界等待：删掉 closeHttpServer 里的 pageChannel.closeAll() 时这条 promise 永不结算，
  // 旧写法只能靠测试文件的 120s 超时兜底（红得晚、且看不出是哪里挂住）。
  const bounded = await Promise.race([
    closed,
    new Promise<null>(resolve => { setTimeout(() => resolve(null), 2_000) }),
  ])
  assert.equal(bounded, 1012, 'closeHttpServer must reach pageChannel.closeAll()（2s 内未收到 close = 挂死）')
})

test('wiring: 半路放行的 upgrade 在 stop() 之后不得复活通道（黑盒行为锁；闩锁是纵深防御）', async (t) => {
  // 升级过的 socket 不在 HTTP server 的连接跟踪里，理论上存在一个「stop() 之后仍被放行」的
  // 同 tick 窗口；这里锁的是黑盒结论：这种放行必须失败收尾、绝不复活通道。注意它证明不了
  // accepting 闩锁被单独触发（stop() 的收尾本身就让传输消失；第三轮测试审计实测：把闩锁
  // 恒置 true 该用例仍绿）。闩锁语义由重启用例与「stop(); start(); stop()」用例从行为面
  // 锁住，闩锁本身是那个窗口的纵深防御。
  let releaseGate: () => void = () => undefined
  const gate = new Promise<void>(resolve => { releaseGate = resolve })
  const harness = await startPlane(t, { upgradeMiddleware: async () => { await gate; return false } })
  const outcomes: string[] = []
  const client = new WebSocket(`ws://127.0.0.1:${harness.plane.port}${PAGE_CHANNEL_PATH}`)
  client.once('open', () => outcomes.push('open'))
  client.once('error', () => outcomes.push('error'))
  t.after(() => client.terminate())
  // 不 await stop()：要在**服务器还听得见**、而 accepting 已经关掉的窗口里放行 middleware
  //（await 完 stop() 之后连接早被 closeAllConnections 收掉了，那样测不到 latch）。
  const stopping = harness.stop()
  releaseGate()
  await waitFor(() => outcomes.length > 0, 5_000, '半路放行的 upgrade 的结局')
  assert.equal(outcomes.includes('open'), false, '停止后的控制面不得再接受页面通道 upgrade')
  assert.ok(outcomes.includes('error'), '半路放行的 upgrade 必须以失败收尾')
  await stopping
})

test('wiring: stop() 之后的重启必须恢复服务（accepting latch 不得变成一次性闩锁）', async (t) => {
  const harness = await startPlane(t)
  await harness.stop()
  await harness.plane.start()
  const client = await connectClient(`ws://127.0.0.1:${harness.plane.port}${PAGE_CHANNEL_PATH}`)
  t.after(() => client.ws.terminate())
  client.send({ type: 'subscribe', id: 'health-restart', family: 'health' })
  await client.waitForType('ready', 'health-restart')
  await harness.plane.stop()
})

test('wiring: 已启动状态下再次 start() 是 no-op，绝不关掉活着的页面 socket', async (t) => {
  // 「任何 server 收尾都 closeAll()」的安全前提：start() 在 server !== null 时早退，
  // 所以候选 server 的收尾路径永远不可能碰到活服务器的 socket。这条前提必须被锁住。
  const harness = await startPlane(t)
  const port = harness.plane.port
  const client = await connectClient(`ws://127.0.0.1:${harness.plane.port}${PAGE_CHANNEL_PATH}`)
  t.after(() => client.ws.terminate())
  client.send({ type: 'subscribe', id: 'health-a', family: 'health' })
  await client.waitForType('ready', 'health-a')

  await harness.plane.start()
  assert.equal(client.ws.readyState, WebSocket.OPEN, '重复 start() 不得动活 socket')
  // 端口断言抓「早退守卫被删」这类变异：漏掉守卫时 start() 会另起一个 candidate，本地
  // 断言（socket 还活着/还能 subscribe）可能照样过，但 plane.port 会漂到新端口、旧 server
  // 变成孤儿（第三轮测试审计：只靠断言全过、只有进程不退出能察觉）。
  assert.equal(harness.plane.port, port, '重复 start() 必须原地不动，不得另起监听')
  client.send({ type: 'subscribe', id: 'health-b', family: 'health' })
  await client.waitForType('ready', 'health-b')

  await harness.stop()
})

test('wiring: 同一拍内 stop(); start(); stop() —— 最后一次是 stop 时必须保持停止', async (t) => {
  const harness = await startPlane(t)
  // 第二个 stop 合并进第一个 stop，但**每次调用都必须推进 epoch**：否则排队等第一个
  // stop 结算的 start 会照样复活，最后一次调用是 stop 而控制面停在 RUNNING。
  await Promise.all([harness.plane.stop(), harness.plane.start(), harness.plane.stop()])
  assert.equal(harness.plane.port, null, '排队中的 start 不得在 stop 结算后复活控制面')
})

test('wiring: pluginGraph resolves through the registered instance transport and streams its SSE', async (t) => {
  const requests: Array<{ url: string | undefined; headers: Record<string, any> }> = []
  const upstream = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('event: graph\ndata: {"rev":7}\n\n')
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const upstreamPort = (upstream.address() as AddressInfo).port
  t.after(async () => {
    upstream.closeAllConnections?.()
    await new Promise<void>(resolve => { upstream.close(() => resolve()) })
  })

  const harness = await startPlane(t)
  harness.plane.registerInstanceTransport('dsh:e2e', `http://127.0.0.1:${upstreamPort}`)
  const client = await connectClient(`ws://127.0.0.1:${harness.plane.port}${PAGE_CHANNEL_PATH}`)
  t.after(() => client.ws.terminate())

  client.send({ type: 'subscribe', id: 'pg-e2e', family: 'pluginGraph', instanceId: 'dsh-e2e' })
  await client.waitForType('ready', 'pg-e2e')
  const item = await client.waitForType('item', 'pg-e2e')
  assert.equal(item.event, 'graph')
  assert.equal(item.data, '{"rev":7}')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/plugins/events', 'the page channel addresses the instance route, not /api/i/*')
  assert.equal(requests[0].headers['accept-encoding'], undefined)

  await harness.stop()
})

/** A real SSE upstream that records requests and how many responses were destroyed. */
async function startFactsUpstream() {
  const requests: string[] = []
  let closes = 0
  const server = createServer((req, res) => {
    requests.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${String(requests.length)}\n\n`)
    res.on('close', () => { closes += 1 })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    baseUrl: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    requests,
    get closes(): number { return closes },
    async close(): Promise<void> {
      server.closeAllConnections?.()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    },
  }
}

test('wiring: a revoked/replaced transport fails only its own subscriptions and a fresh subscribe resolves the new transport', async (t) => {
  const revoked = await startFactsUpstream()
  const kept = await startFactsUpstream()
  t.after(() => revoked.close())
  t.after(() => kept.close())
  const harness = await startPlane(t)
  harness.plane.registerInstanceTransport('dsh:rev', revoked.baseUrl)
  harness.plane.registerInstanceTransport('dsh:keep', kept.baseUrl)
  const client = await connectClient(`ws://127.0.0.1:${String(harness.plane.port)}${PAGE_CHANNEL_PATH}`)
  t.after(() => client.ws.terminate())

  client.send({ type: 'subscribe', id: 'pg-rev', family: 'pluginGraph', instanceId: 'dsh-rev' })
  client.send({ type: 'subscribe', id: 'pg-keep', family: 'pluginGraph', instanceId: 'dsh-keep' })
  await client.waitForType('item', 'pg-rev')
  await client.waitForType('item', 'pg-keep')

  // 注销 = 隧道消失：实例代理必须把通道自己开的上游（不在它的 traffic 表里）一起收掉。
  harness.plane.unregisterInstanceTransport('dsh:rev')
  const failure = await client.waitForType('error', 'pg-rev')
  assert.equal(failure.code, 'instance_unavailable')
  assert.match(failure.message, /replaced or removed/)
  await waitFor(() => revoked.closes > 0, 5000, 'the revoked upstream is destroyed')
  assert.equal(
    client.messages.filter(message => message.type === 'error' && message.id === 'pg-keep').length,
    0,
    'a subscription on another transport is untouched',
  )

  // 同一 id 重新注册（传输被替换）后，新订阅必须解析到新传输并打开一条新上游。
  harness.plane.registerInstanceTransport('dsh:rev', revoked.baseUrl)
  client.send({ type: 'subscribe', id: 'pg-rev-2', family: 'pluginGraph', instanceId: 'dsh-rev' })
  await client.waitForType('ready', 'pg-rev-2')
  await client.waitForType('item', 'pg-rev-2')
  assert.ok(revoked.requests.length >= 2, 'the fresh subscription opened a new upstream')

  // 替换（registerTransport 覆盖同一 connectionId）走同一条 revoke 路径：旧订阅必须失败。
  harness.plane.registerInstanceTransport('dsh:rev', kept.baseUrl)
  const replaced = await client.waitForType('error', 'pg-rev-2')
  assert.equal(replaced.code, 'instance_unavailable')
  assert.match(replaced.message, /replaced or removed/)

  await harness.stop()
})
