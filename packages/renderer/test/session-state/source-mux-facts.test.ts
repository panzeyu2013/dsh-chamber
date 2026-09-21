/**
 * W6 无壳观察者锁（里程碑 W6；`notes/remote-state-w0-protocol.md` §3/§4）。
 *
 * 钉死四件事：① 开场帧精确（只开 $events）；② **永不发 $events/result**（瀑布只观察——
 * 回答会把等待中的审批替所有客户端结算掉）；③ 每条 true→false 边沿**恰好一次**
 * `session/follow`，分类 completed/user-stopped/neutral 与 watcher 同规；④ 读不到尾巴
 * 时降级仍武装（绝不丢真完成）。
 *
 * Run directly: node test/session-state/source-mux-facts.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  classifyTurnEndWire,
  createSourceMuxFacts,
  muxUrlFor,
  openEventsFrame,
  parseMuxFrame,
  publishSourceMuxInstrument,
  rowFromListItem,
  type MuxSocket,
} from '../../src/source-mux-facts.ts'

const SOURCE = readFileSync(fileURLToPath(new URL('../../src/source-mux-facts.ts', import.meta.url)), 'utf8')

class FakeSocket implements MuxSocket {
  sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event?: unknown) => void) | null = null
  onerror: ((event?: unknown) => void) | null = null
  send(data: string): void { this.sent.push(data) }
  close(): void { this.closed = true }
  open(): void { this.onopen?.() }
  item(value: unknown): void { this.onmessage?.({ data: JSON.stringify({ type: 'item', streamId: 'events', value }) }) }
}

function listResponse(items: unknown[]) {
  return async () => ({ ok: true, status: 200, json: async () => ({ type: 'server-response', rpcId: 'x', result: { ok: true, value: { items } } }) })
}

/** fetch 假件：按 rpcId 回显信封（envelope 校验要求 rpcId 一致）。 */
function rpcFetch(handlers: Record<string, (payload: unknown) => unknown>) {
  return async (_url: string, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { rpcId: string; method: string; payload: unknown }
    const handler = handlers[body.method]
    const value = handler === undefined ? null : handler(body.payload)
    const result = value === 'FAIL' ? { ok: false, error: { code: 'x' } } : { ok: true, value }
    return { ok: true, status: 200, json: async () => ({ type: 'server-response', rpcId: body.rpcId, result }) } as never
  }
}

test('URLs and the opening frame match the frozen protocol', () => {
  assert.equal(muxUrlFor('http://127.0.0.1:17500', 'local'), 'ws://127.0.0.1:17500/api/i/local/api/remote.mux')
  assert.equal(muxUrlFor('http://127.0.0.1:17500/', 'ssh-a'), 'ws://127.0.0.1:17500/api/i/ssh-a/api/remote.mux')
  assert.deepEqual(JSON.parse(openEventsFrame()), { type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } })
  assert.deepEqual(parseMuxFrame(JSON.stringify({ type: 'item', streamId: 's', value: { type: 'ready', clientId: 'c' } })), { kind: 'ready', streamId: 's' })
  assert.equal(parseMuxFrame('not json'), null)
  assert.equal(rowFromListItem({ sessionId: 'a', running: true, updatedAt: 5 })?.running, true)
  assert.equal(rowFromListItem({}), null)
})

test('the observer opens only $events and never answers a waterfall', async () => {
  const sockets: FakeSocket[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'local', origin: 'http://cp', onSnapshot: () => {},
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
  })
  facts.start()
  const socket = sockets[0]
  socket.open()
  assert.deepEqual(socket.sent, [openEventsFrame()])
  // 瀑布帧只观察：不得产生任何 send（尤其不得回 $events/result）。
  socket.item({ type: 'waterfall', event: 'approval/request', eventId: 'e1', request: {} })
  socket.item({ type: 'waterfall', event: 'user-questions/request', eventId: 'e2', request: {} })
  socket.item({ type: 'cancel', eventId: 'e3' })
  assert.equal(socket.sent.length, 1, 'no frame was sent in response')
  assert.equal(socket.sent.some(payload => payload.includes('result')), false)
  // 源文本里也不得出现 result 的发送（注释里的纪律声明不算）。
  const code = SOURCE.split('\n').filter(line => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//')).join('\n')
  assert.equal(code.includes("$events/result"), false)
  facts.stop()
})

test('one true->false edge opens exactly one follow and completed arms the row', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  const follows: unknown[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-a', origin: 'http://cp', now: () => 900, onSnapshot: s => snapshots.push(s),
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({
      'session/list': () => ({ items: [{ sessionId: 's1', running: false, updatedAt: 100 }] }),
      'session/follow': payload => { follows.push(payload); return { snapshot: { tail: { turn: { reason: { kind: 'completed' } } } } } },
    }) as never,
  })
  facts.start()
  sockets[0].open()
  await new Promise(resolve => setTimeout(resolve, 5))
  sockets[0].item({ type: 'ready', clientId: 'c' })
  sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: true } })
  sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: false } })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(follows.length, 1, 'exactly one follow per edge')
  assert.equal(facts.status().edges, 1)
  // A duplicate false (no new running edge) must not open a second follow.
  sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: false } })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(follows.length, 1)
  const last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
  const row = last.rows['s1']
  assert.equal(row?.completedAt, 900)
  // B5：本 fixture 的 tail 是 legacy 形、没有 host time ⇒ 观察者戳 + reconstructed 降级；
  // host 时间的 observed 路径由新增的 B5 用例钉住。
  assert.equal(row?.completedAtSource, 'reconstructed')
  assert.deepEqual(row?.lastTurnEnd, { kind: 'completed' })
  facts.stop()
})

test('a user stop and a neutral ending never arm; an unreadable tail degrades and arms', async () => {
  for (const [label, tail, expectArmed] of [
    ['aborted+user', { kind: 'aborted', cause: 'user' }, false],
    ['blocked', { kind: 'blocked' }, false],
    ['unreadable', 'FAIL', true],
    // 无 turn/end（拿到了快照但读不出确定性尾巴）⇒ 与 gateway followTurnEndOnce 同规：武装。
    // 判 neutral 会让「跨缺口完成」在唯一证据缺失时静默丢失（B1 的同一失效模式）。
    ['no-turn-end', 'EMPTY', true],
  ] as const) {
    const sockets: FakeSocket[] = []
    const snapshots: unknown[] = []
    const facts = createSourceMuxFacts({
      sourceId: 'local', origin: 'http://cp', now: () => 1_000, onSnapshot: s => snapshots.push(s),
      openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
      fetchImpl: rpcFetch({
        'session/list': () => ({ items: [{ sessionId: 's1', running: false, updatedAt: 50 }] }),
        'session/follow': () => (tail === 'FAIL' ? 'FAIL' : tail === 'EMPTY' ? {} : { snapshot: { tail: { turn: { reason: tail } } } }),
      }) as never,
    })
    facts.start()
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: true } })
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: false } })
    await new Promise(resolve => setTimeout(resolve, 10))
    const last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    const row = last.rows['s1']
    assert.equal(row?.completedAt !== null && row?.completedAt !== undefined, expectArmed, label)
    if (tail !== 'FAIL' && tail !== 'EMPTY') assert.deepEqual(row?.lastTurnEnd, tail, label)
    if (tail === 'FAIL' || tail === 'EMPTY') {
      // 两种「读不到确定性尾巴」都要计数：否则验收分不清「没完成」与「观察者读不到」。
      assert.equal(facts.status().followFailures, 1, label + '：读不出尾巴必须计数')
      assert.equal(row?.completedAtDomain, 'observer', label + '：降级戳是观察者域')
      assert.equal(row?.completedAtSource, 'reconstructed', label + '：降级戳不得冒充 observed')
    }
    facts.stop()
  }
})

test('classifyTurnEndWire mirrors the watcher rules, and stop() is idempotent', () => {
  assert.equal(classifyTurnEndWire({ kind: 'completed' }), 'completed')
  assert.equal(classifyTurnEndWire({ kind: 'aborted', cause: 'user' }), 'user-stopped')
  assert.equal(classifyTurnEndWire({ kind: 'aborted', cause: 'parent' }), 'neutral')
  assert.equal(classifyTurnEndWire({ kind: 'error' }), 'neutral')
  assert.equal(classifyTurnEndWire(null), 'neutral')
  const sockets: FakeSocket[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'local', origin: 'http://cp', onSnapshot: () => {},
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
  })
  facts.start()
  facts.stop()
  facts.stop()
  assert.equal(sockets[0].closed, true)
})

/**
 * 观察者的**失败必须可观测**（2026-12 复审残留）：否则「观察者坏了」与「这段时间没有
 * 完成」在验收上长得一模一样——正是这类假绿让 W6 的判据形同虚设。
 */
test('baseline, follow and socket failures are counted, not swallowed', async () => {
  const sockets: FakeSocket[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-b', origin: 'http://cp', now: () => 777, onSnapshot: () => {},
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({
      'session/list': () => 'FAIL',
      'session/follow': () => 'FAIL',
    }) as never,
  })
  facts.start()
  sockets[0].open()
  await new Promise(resolve => setTimeout(resolve, 5))
  sockets[0].item({ type: 'ready', clientId: 'c' })
  assert.ok(facts.status().baselineFailures >= 1, '基线失败必须计数（不能静默）')
  sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: true } })
  sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: false } })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(facts.status().followFailures, 1, '尾巴读失败是降级武装路径，必须可数')
  sockets[0].onerror?.({})
  assert.equal(facts.status().socketErrors, 1, '套接字错误与 close 分开计数')
  facts.stop()
})

/** 重连退避：源长时间不可达时不得变成每秒一次的重试洪流（首次延迟即为 1s）。 */
test('reconnect uses an exponential backoff instead of a fixed 1s hammer', async () => {
  const sockets: FakeSocket[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-c', origin: 'http://cp', onSnapshot: () => {},
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
  })
  facts.start()
  sockets[0].onclose?.({})
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(facts.status().reconnects, 0, '首次重连延迟 1s，250ms 内不得重连（固定 100ms 轮询会在此暴露）')
  facts.stop()
})

/** 仪器：每个来源的状态可由验收侧读取（函数视图，不产生周期性对象）。 */
test('the per-source instrument exposes the live status', () => {
  const host: Record<string, unknown> = {}
  publishSourceMuxInstrument('ssh-d', () => ({ ready: true, edges: 2, lastEventAt: 5, pendingReads: 0, reconnects: 0, baselines: 1, baselineFailures: 0, followFailures: 0, socketErrors: 0 }), host)
  const registry = host.__dshChamberSourceMux as Record<string, () => { edges: number }>
  assert.equal(registry['ssh-d']().edges, 2)
})
/** 基线形状防御：session/list 的 value 缺失（或没有 items）是空基线，不是崩溃。 */
test('a value-less session/list response is an empty baseline, not a crash', async () => {
  const sockets: FakeSocket[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-shape', origin: 'http://cp', onSnapshot: () => {},
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({ 'session/list': () => null }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(facts.status().baselines >= 1, 'a value-less list is still a countable baseline')
    assert.equal(facts.status().baselineFailures, 0)
  } finally {
    facts.stop()
  }
})

/**
 * ── 审计 B 复现锁（2026-12）──────────────────────────────────────────────────
 * 每条用例在修复前必须失败（红），修复后转绿；形状以当前冻结协议
 * (notes/remote-state-w0-protocol.md §3、control-plane/src/session-mux.ts) 为准。
 */

/** B1：$events 开场不重放 status ⇒ 重订阅后的基线是跨缺口完成的唯一证据。 */
test('B1: a true->false baseline edge after resubscription reads the tail and arms', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  const follows: unknown[] = []
  let running = true
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-b1', origin: 'http://cp', now: () => 2_000, onSnapshot: s => snapshots.push(s),
    silenceTimeoutMs: 25,
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({
      'session/list': () => ({ items: [{ sessionId: 's1', running, updatedAt: 100 }] }),
      'session/follow': payload => { follows.push(payload); return { snapshot: { tail: { turn: { reason: { kind: 'completed' } } } } } },
    }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    // 缺口：静默窗内会话完成；$events 不重放 status，只有下一次基线能看见。
    running = false
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.ok(sockets.length >= 2, 'silence must resubscribe (R21)')
    sockets.at(-1)!.open()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(follows.length, 1, 'a baseline true->false edge must open exactly one follow')
    assert.equal(facts.status().edges, 1, 'the baseline edge must count like a status edge')
    const last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.notEqual(last.rows['s1']?.completedAt ?? null, null, 'the gap completion must arm completedAt')
  } finally {
    facts.stop()
  }
})

/** B2：重连/静默重基线不得用空完成字段覆盖已武装的完成。 */
test('B2: a re-baseline never clobbers an armed completion', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  let listCall = 0
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-b2', origin: 'http://cp', now: () => 900, onSnapshot: s => snapshots.push(s),
    silenceTimeoutMs: 25,
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({
      // 第二次基线带更旧的 updatedAt 与 rowFromListItem 的空完成字段。
      'session/list': () => { listCall += 1; return { items: [{ sessionId: 's1', running: false, updatedAt: listCall === 1 ? 5 : 0 }] } },
      'session/follow': () => ({ snapshot: { tail: { turn: { reason: { kind: 'completed' } } } } }),
    }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: true } })
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: false } })
    await new Promise(resolve => setTimeout(resolve, 10))
    const armed = (snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }).rows['s1']
    const armedAt = armed?.completedAt
    assert.notEqual(armedAt ?? null, null, 'precondition: the status edge armed the completion')
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.ok(sockets.length >= 2, 'silence must resubscribe (the re-baseline path)')
    sockets.at(-1)!.open()
    await new Promise(resolve => setTimeout(resolve, 10))
    const after = (snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }).rows['s1']
    assert.equal(after?.completedAt, armedAt, 'the baseline must not wipe the armed completion')
    assert.equal(after?.completedAtSource, armed?.completedAtSource)
    assert.deepEqual(after?.lastTurnEnd, armed?.lastTurnEnd)
    assert.equal(after?.updatedAt, 5, 'updatedAt merges by max, never backwards')
  } finally {
    facts.stop()
  }
})

/** B3：connect() 换代后，旧 socket 的 onclose 不得再改状态或调度重连。 */
test('B3: a superseded socket cannot reschedule or mutate state', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-b3', origin: 'http://cp', onSnapshot: s => snapshots.push(s),
    silenceTimeoutMs: 200,
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    sockets[0].item({ type: 'ready', clientId: 'c' })
    await new Promise(resolve => setTimeout(resolve, 260))
    // 静默重订阅：connect() 换掉旧 socket（旧 socket 仍会收到自己的 close）。
    assert.equal(sockets.length, 2, 'the silence window must have resubscribed')
    const superseded = sockets[0]
    const fresh = sockets[1]
    fresh.open()
    fresh.item({ type: 'ready', clientId: 'c' })
    await new Promise(resolve => setTimeout(resolve, 5))
    superseded.onclose?.({})
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal((snapshots.at(-1) as { verdict: string }).verdict, 'ok', 'a superseded close must not degrade the live generation')
    assert.equal(facts.status().reconnects, 1, 'only the silence resubscribe happened so far')
    // 自激窗：若旧 close 调度了 1s 重连，1.2s 内会再建一条 socket（喂帧保持本代际静默窗不触发）。
    for (let i = 0; i < 30; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 40))
      sockets.at(-1)?.item({ type: 'cancel', eventId: 'keep-alive' })
    }
    assert.equal(sockets.length, 2, 'no self-excited reconnect loop')
    assert.equal((snapshots.at(-1) as { verdict: string }).verdict, 'ok')
  } finally {
    facts.stop()
  }
})

/** B4：状态事件必须为未知会话建档；added/activity/removed 必须被消费。 */
test('B4: status opens an unknown row; added/activity/removed are handled', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-b4', origin: 'http://cp', now: () => 400, onSnapshot: s => snapshots.push(s),
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({
      'session/list': () => ({ items: [] }),
      'session/follow': () => ({ snapshot: { tail: { turn: { reason: { kind: 'completed' } } } } }),
    }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    // 冻结 wire 形：args = [sessionId, running]（W0 §3；对象形是历史/测试形）。
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: ['s1', false] })
    await new Promise(resolve => setTimeout(resolve, 10))
    let last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.notEqual(last.rows['s1'], undefined, 'status must open a row the baseline never saw')
    assert.equal(last.rows['s1']?.completedAt, 400, 'the followed edge must arm the new row')
    assert.equal(facts.status().edges, 1)
    // activity：host 水位只升不降。
    sockets[0].item({ type: 'emit', event: 'api-session/activity', args: ['s1', 12_345] })
    sockets[0].item({ type: 'emit', event: 'api-session/activity', args: ['s1', 12_000] })
    await new Promise(resolve => setTimeout(resolve, 5))
    last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.equal(last.rows['s1']?.updatedAt, 12_345)
    // added：新会话建行。
    sockets[0].item({ type: 'emit', event: 'api-session/added', args: [{ sessionId: 's2', running: true, updatedAt: 7 }] })
    await new Promise(resolve => setTimeout(resolve, 5))
    last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.equal(last.rows['s2']?.running, true)
    // removed：从 rows（与 running 记忆）移除。
    sockets[0].item({ type: 'emit', event: 'api-session/removed', args: ['s1'] })
    await new Promise(resolve => setTimeout(resolve, 5))
    last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.equal(last.rows['s1'], undefined, 'removed must prune the row')
    assert.equal(last.rows['s2']?.running, true)
  } finally {
    facts.stop()
  }
})

/** B5：完成时间优先取 host turn/end.time；拿不到时观察者戳必须诚实标 reconstructed。 */
test('B5: completedAt prefers the host turn/end time; a client stamp is reconstructed', async () => {
  const HOST_TIME = 1_700_000_000_000
  const run = async (tail: unknown) => {
    const sockets: FakeSocket[] = []
    const snapshots: unknown[] = []
    const follows: unknown[] = []
    const facts = createSourceMuxFacts({
      sourceId: 'ssh-b5', origin: 'http://cp', now: () => 5_000, onSnapshot: s => snapshots.push(s),
      openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
      fetchImpl: rpcFetch({
        'session/list': () => ({ items: [{ sessionId: 's1', running: false, updatedAt: 1 }] }),
        'session/follow': payload => { follows.push(payload); return tail },
      }) as never,
    })
    try {
      facts.start()
      sockets[0].open()
      await new Promise(resolve => setTimeout(resolve, 5))
      sockets[0].item({ type: 'ready', clientId: 'c' })
      sockets[0].item({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
      sockets[0].item({ type: 'emit', event: 'api-session/status', args: ['s1', false] })
      await new Promise(resolve => setTimeout(resolve, 10))
      const row = (snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }).rows['s1']
      return { row, follows }
    } finally {
      facts.stop()
    }
  }
  // 冻结 wire：snapshot.records[].event 携带 SessionEvent.time（host epoch ms）。
  const withHost = await run({ type: 'snapshot', records: [
    { type: 'event', event: { type: 'turn/end', seq: 7, time: HOST_TIME, data: { reason: { kind: 'completed' } } } },
  ] })
  assert.deepEqual(withHost.follows[0], { args: { request: { address: { kind: 'session', sessionId: 's1' }, maxMessages: 8 } } }, 'session/follow payload must match the frozen Remote shape')
  assert.equal(withHost.row?.completedAt, HOST_TIME, 'host time must win over the observer clock')
  assert.equal(withHost.row?.completedAtSource, 'observed')
  assert.equal(withHost.row?.completedAtDomain, 'host')
  assert.deepEqual(withHost.row?.lastTurnEnd, { kind: 'completed', at: HOST_TIME, seq: 7 })
  // 无 host 时间：观察者戳 + reconstructed（不是 host 域观测，App 因此不发通知）。
  const withoutHost = await run({ type: 'snapshot', records: [
    { type: 'event', event: { type: 'turn/end', seq: 8, data: { reason: { kind: 'completed' } } } },
  ] })
  assert.equal(withoutHost.row?.completedAt, 5_000)
  assert.equal(withoutHost.row?.completedAtSource, 'reconstructed')
  assert.equal(withoutHost.row?.completedAtDomain, 'observer')
})

/** B7：半死隧道下 unary 必须按 deadline 失败并计数，不得永久挂起。 */
test('B7: baseline and follow rpc deadlines surface as failures instead of hanging', async () => {
  const sockets: FakeSocket[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-b7', origin: 'http://cp', onSnapshot: () => {},
    baselineTimeoutMs: 30, followTimeoutMs: 20,
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    // 半死隧道：请求永不回包（不 resolve 也不 reject）。
    fetchImpl: (() => new Promise(() => {})) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.ok(facts.status().baselineFailures >= 1, 'a hung session/list must hit the baseline deadline')
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: true } })
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: false } })
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(facts.status().followFailures, 1, 'a hung session/follow must degrade within its deadline')
    assert.equal(facts.status().pendingReads, 0, 'a timed-out read must not leak a pending read')
  } finally {
    facts.stop()
  }
})

/** B10：stop() 后在途基线不得再 emit。 */
test('B10: a baseline resolving after stop() must not emit', async () => {
  const snapshots: unknown[] = []
  let releaseList: (() => void) | null = null
  const gate = new Promise<void>(resolve => { releaseList = resolve })
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-b10', origin: 'http://cp', onSnapshot: s => snapshots.push(s),
    openSocket: () => new FakeSocket(),
    fetchImpl: ((_url: string, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { rpcId: string }
      return gate.then(() => ({
        ok: true, status: 200,
        json: async () => ({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { items: [] } } }),
      }))
    }) as never,
  })
  facts.start()
  const beforeStop = snapshots.length
  facts.stop()
  releaseList!()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(snapshots.length, beforeStop, 'a baseline landing after stop() must not emit')
})

/** B10：stop() 必须摘下本源仪器项（否则退役观察者看起来仍在跑）。 */
test('B10: stop() unpublishes the per-source instrument', () => {
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-b10-instrument', origin: 'http://cp', onSnapshot: () => {},
    openSocket: () => new FakeSocket(),
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
  })
  facts.start()
  const registry = (globalThis as { __dshChamberSourceMux?: Record<string, unknown> }).__dshChamberSourceMux
  assert.notEqual(registry?.['ssh-b10-instrument'], undefined, 'precondition: start() publishes')
  facts.stop()
  assert.equal(registry?.['ssh-b10-instrument'], undefined, 'stop() must remove the instrument entry')
})

