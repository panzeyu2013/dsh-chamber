/**
 * 非交互宿主腿有界队列（W4 合流修复）：状态型（setBadge）合流的语义是「只保最新」，但在飞
 * 期间到达的新值**不得**被成功后的 shift() 当成旧值丢掉——旧值已送达、新值从未派发，
 * Dock 就会停在上一次的值上（正是「数字依旧不对」的形状之一）。
 *
 * Run directly: node test/desktop-shell/node-edges-queue.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOST_INBOUND, createNodeEdges } from '../../node-edges.ts'

interface SentLeg {
  method: string
  payload: unknown
  settle: (value?: unknown) => void
  fail: (error: unknown) => void
}

function harness(): { edges: ReturnType<typeof createNodeEdges>; sent: SentLeg[] } {
  const sent: SentLeg[] = []
  const edges = createNodeEdges({
    sendEdge: (method, payload) => new Promise((resolve, reject) => {
      sent.push({ method, payload, settle: resolve, fail: reject })
    }),
    sendNotify: () => {},
    hostFacts: { mainWindowAlive: true },
    nonInteractiveRetryDelayMs: 1,
  })
  return { edges, sent }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

test('setBadge: a value arriving while a send is in flight is dispatched next, never swallowed', async () => {
  const { edges, sent } = harness()
  assert.deepEqual(edges.setBadge(1), { applied: true })
  await flush()
  assert.equal(sent.length, 1, '首送立即开始')
  assert.deepEqual(sent[0]!.payload, { count: 1 })

  // 在飞期间到达的新值：合流保最新，但必须排在已送达的旧值之后继续派发。
  edges.setBadge(2)
  sent[0]!.settle({ ok: true })
  await flush()
  assert.equal(sent.length, 2, '新值必须在在飞载荷送达后继续派发')
  assert.deepEqual(sent[1]!.payload, { count: 2 })
  sent[1]!.settle({ ok: true })
})

test('setBadge: coalescing keeps only the newest queued value while one is in flight', async () => {
  const { edges, sent } = harness()
  edges.setBadge(1)
  await flush()
  assert.equal(sent.length, 1)
  edges.setBadge(2)
  edges.setBadge(3)
  edges.setBadge(4)
  sent[0]!.settle({ ok: true })
  await flush()
  assert.equal(sent.length, 2, '同槽合流：只多派发一次')
  assert.deepEqual(sent[1]!.payload, { count: 4 }, '派发的必须是最新值')
  sent[1]!.settle({ ok: true })
})

test('setBadgeAndWait: the receipt is the real leg outcome, not an optimistic enqueue value (W4)', async () => {
  const { edges, sent } = harness()
  const receipt = edges.setBadgeAndWait(9)
  await flush()
  assert.equal(sent.length, 1)
  sent[0]!.settle({ ok: true })
  assert.deepEqual(await receipt, { applied: true })
})

test('setBadgeAndWait: an exhausted leg reports applied:false with the leg reason (W4)', async () => {
  const { edges, sent } = harness()
  const receipt = edges.setBadgeAndWait(11)
  await flush()
  sent[0]!.fail(new Error('swift-edge-ui-unavailable:setBadge:write-failed'))
  await flush()
  const outcome = await receipt
  assert.equal(outcome.applied, false, '放弃必须如实回 false（不是入队乐观值）')
  assert.match(outcome.applied === false ? outcome.reason : '', /write-failed/)
  assert.equal(edges.badgeCountApiAvailable(), true)
})

test('setBadgeAndWait: a superseded waiter is told so instead of hanging (W4)', async () => {
  const { edges, sent } = harness()
  const first = edges.setBadgeAndWait(1)
  await flush()
  const second = edges.setBadgeAndWait(2)
  const third = edges.setBadgeAndWait(3)
  assert.deepEqual(await second, { applied: false, reason: 'superseded-by-newer-count' })
  sent[0]!.settle({ ok: true })
  await flush()
  sent[1]!.settle({ ok: true })
  assert.deepEqual(await first, { applied: true })
  assert.deepEqual(await third, { applied: true })
})

test('hostFacts pushes refresh the badge API capability cache (W4)', () => {
  const sent: SentLeg[] = []
  const edges = createNodeEdges({
    sendEdge: (method, payload) => new Promise((resolve, reject) => {
      sent.push({ method, payload, settle: resolve, fail: reject })
    }),
    sendNotify: () => {},
    hostFacts: { mainWindowAlive: true, badgeCountApiAvailable: true },
  })
  assert.equal(edges.badgeCountApiAvailable(), true)
  assert.deepEqual(edges.handleHostInbound(HOST_INBOUND.hostFacts, { badgeCountApiAvailable: false }), { ok: true })
  assert.equal(edges.badgeCountApiAvailable(), false, '宿主事实推送必须刷新缓存（旧口径只认创建时种子）')
})

test('setBadge: a closed window still queues — the Dock tile is app-level, not window-level', async () => {
  const sent: SentLeg[] = []
  const edges = createNodeEdges({
    sendEdge: (method, payload) => new Promise((resolve, reject) => {
      sent.push({ method, payload, settle: resolve, fail: reject })
    }),
    sendNotify: () => {},
    hostFacts: { mainWindowAlive: false },
    nonInteractiveRetryDelayMs: 1,
  })
  // 主窗关闭后 app 仍在运行、Dock 图标仍在：清 0 写必须照常投递（旧行为按「无主窗」丢弃 ⇒
  // Dock 上的陈旧大数字永远清不掉）。回执的诚实性由宿主腿的实测读回负责。
  assert.deepEqual(edges.setBadge(0), { applied: true })
  await new Promise<void>(resolve => setTimeout(resolve, 10))
  assert.equal(sent.length, 1, '无主窗也必须投递')
  assert.deepEqual(sent[0]?.payload, { count: 0 })
  sent[0]?.settle({ applied: true })
})
