/**
 * 未读 v2 落盘存储契约：键常量、宽松清洗、
 * v1 防御性导入（先写后删）、单调 max 合并、读水位推进、有界化 LRU、
 * client-install id、ack 请求、隐私键白名单。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLIENT_INSTALL_ID_KEY,
  CLIENT_INSTALL_ID_PATTERN,
  UNREAD_MAX_SESSIONS_PER_SOURCE,
  UNREAD_PENDING_MAX,
  UNREAD_V1_KEY,
  UNREAD_V2_KEY,
  advanceReadMark,
  createClientInstallId,
  createUnreadAckOutbox,
  createUnreadSaveCoalescer,
  loadClientInstallId,
  loadUnread,
  maxWatermark,
  mergeReadMarks,
  pruneEmptyUnreadTables,
  pruneUnreadPayload,
  sanitizeUnreadPayload,
  saveUnread,
  sendUnreadRequest,
  type UnreadStorageLike,
  type UnreadV2Payload,
} from '../../src/unread-store.ts'
import { createCompleteLedger, type PendingCompletionTable } from '../../src/complete-ledger.ts'
import { BOOT_TOKEN_KEY, createBootToken, loadBootToken, type BootTokenStorageLike } from '../../src/boot-token.ts'

/** 记录调用顺序的假 storage（迁移顺序是契约：先写后删）。 */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial))
  const calls: string[] = []
  const storage: UnreadStorageLike = {
    getItem: key => (data.has(key) ? data.get(key)! : null),
    setItem: (key, value) => { calls.push('set:' + key); data.set(key, value) },
    removeItem: key => { calls.push('remove:' + key); data.delete(key) },
  }
  return { storage, calls, data }
}

test('keys are the frozen localStorage names (v2 is the only written key)', () => {
  assert.equal(UNREAD_V2_KEY, 'dsh-chamber.unread.v2')
  assert.equal(UNREAD_V1_KEY, 'dsh-chamber.unread.v1')
  assert.equal(CLIENT_INSTALL_ID_KEY, 'dsh-chamber.client-install-id.v1')
  assert.equal(UNREAD_MAX_SESSIONS_PER_SOURCE, 500)
})

test('sanitize is lenient field-wise: bad entries are dropped, good ones survive', () => {
  const loaded = loadUnread(fakeStorage({
    [UNREAD_V2_KEY]: JSON.stringify({
      v: 2,
      read: { a: { s1: 5, s2: 'x', s3: -1 } },
      edge: { a: { s1: true, s2: false } },
      notified: { a: { s1: { complete: 5, ask: 'x' }, s2: 'nope' } },
    }),
  }).storage)
  assert.deepEqual(loaded.read, { a: { s1: 5 } })
  assert.deepEqual(loaded.edge, { a: { s1: true } })
  assert.deepEqual(loaded.notified, { a: { s1: { complete: 5 } } })
})

test('a corrupt v2 whole-payload falls through to the defensive v1 import', () => {
  const { storage, data } = fakeStorage({
    [UNREAD_V2_KEY]: '{not json',
    [UNREAD_V1_KEY]: JSON.stringify({ a: { s1: true, s2: false } }),
  })
  const loaded = loadUnread(storage)
  assert.deepEqual(loaded.edge, { a: { s1: true } })
  assert.equal(loaded.v, 2)
  assert.ok(data.has(UNREAD_V2_KEY))
  assert.ok(!data.has(UNREAD_V1_KEY))
})

test('v1 -> v2 import writes BEFORE it removes v1 (contract order)', () => {
  const { storage, calls, data } = fakeStorage({
    [UNREAD_V1_KEY]: JSON.stringify({ a: { s1: true } }),
  })
  const loaded = loadUnread(storage)
  assert.deepEqual(loaded.edge, { a: { s1: true } })
  const setIndex = calls.indexOf('set:' + UNREAD_V2_KEY)
  const removeIndex = calls.indexOf('remove:' + UNREAD_V1_KEY)
  assert.ok(setIndex !== -1 && removeIndex !== -1 && setIndex < removeIndex)
  assert.ok(data.has(UNREAD_V2_KEY))
})

test('a failing v1 -> v2 write keeps v1 for a later attempt', () => {
  const data = new Map<string, string>([[UNREAD_V1_KEY, JSON.stringify({ a: { s1: true } })]])
  const storage: UnreadStorageLike = {
    getItem: key => data.get(key) ?? null,
    setItem: () => { throw new Error('quota') },
    removeItem: key => { data.delete(key) },
  }
  const loaded = loadUnread(storage)
  assert.deepEqual(loaded.edge, { a: { s1: true } })
  assert.ok(data.has(UNREAD_V1_KEY))
})

test('a valid v2 load clears a leftover v1 key and never re-imports', () => {
  const { storage, data } = fakeStorage({
    [UNREAD_V2_KEY]: JSON.stringify({ v: 2, read: { a: { s1: 9 } }, edge: {}, notified: {} }),
    [UNREAD_V1_KEY]: JSON.stringify({ b: { s9: true } }),
  })
  const loaded = loadUnread(storage)
  assert.deepEqual(loaded.read, { a: { s1: 9 } })
  assert.ok(!data.has(UNREAD_V1_KEY))
})

test('saveUnread prunes empty tables and never throws', () => {
  const { storage, data } = fakeStorage()
  assert.equal(saveUnread(storage, { v: 2, read: {}, edge: {}, notified: {} }), true)
  assert.equal(
    data.get(UNREAD_V2_KEY),
    JSON.stringify({ v: 2, read: {}, edge: {}, notified: {}, pending: {}, outcomes: {} }),
    'saveUnread 自动带上新表（v5 §3.1）',
  )
  const throwing: UnreadStorageLike = {
    getItem: () => null,
    setItem: () => { throw new Error('private mode') },
    removeItem: () => undefined,
  }
  assert.equal(saveUnread(throwing, { v: 2, read: {}, edge: {}, notified: {} }), false)
})

// ── immediate 落盘合并（OPT P1 热路径：同一 tick 多次 immediate → 一次全量写盘） ──

/** 手动控时的 defer：把合并窗口的微任务收集起来按需冲（不依赖宿主事件循环时序）。 */
function deferredQueue() {
  const queued: Array<() => void> = []
  return {
    defer: (run: () => void): void => { queued.push(run) },
    drain: (): void => { for (const run of queued.splice(0)) run() },
  }
}

test('P1: same-tick immediate requests coalesce into ONE save of the latest authoritative state', () => {
  const { storage, calls, data } = fakeStorage()
  let payload: UnreadV2Payload = { v: 2, read: { a: { s1: 1 } }, edge: {}, notified: {} }
  const queue = deferredQueue()
  const saves = createUnreadSaveCoalescer(() => { saveUnread(storage, payload) }, queue.defer)
  // 一波 reconcile 的 voided/dropped/flushed：同一 tick 三次 immediate。
  saves.request()
  payload = { ...payload, notified: { a: { s1: { complete: 2 } } } }
  saves.request()
  payload = { ...payload, pending: { a: { s1: { at: 3 } } } }
  saves.request()
  assert.deepEqual(calls, [], '合并窗口内不写盘（同一 tick 三次 request 尚未落盘）')
  assert.equal(saves.pending(), true, '待办合并窗口可见')
  queue.drain()
  assert.deepEqual(calls, ['set:' + UNREAD_V2_KEY], '同一 tick 三次 immediate 只落一次盘')
  // 合并落盘读的是**最新**权威内存：先到的 durable 变更不会被后到的覆盖丢。
  assert.deepEqual(JSON.parse(data.get(UNREAD_V2_KEY)!), {
    v: 2,
    read: { a: { s1: 1 } },
    edge: {},
    notified: { a: { s1: { complete: 2 } } },
    pending: { a: { s1: { at: 3 } } },
    outcomes: {},
  })
  // 合并窗口不吞后续 tick 的变更：下一次 request 开新窗口、再落一次。
  saves.request()
  queue.drain()
  assert.deepEqual(calls, ['set:' + UNREAD_V2_KEY, 'set:' + UNREAD_V2_KEY], '下一 tick 重新合并并落盘')
})

test('P1: the default defer is a MICROTASK — it lands before a 0ms task, far earlier than the 1s throttle', async () => {
  const order: string[] = []
  const saves = createUnreadSaveCoalescer(() => { order.push('save') })
  saves.request()
  saves.request()
  setTimeout(() => { order.push('timer') }, 0)
  await tick()
  assert.deepEqual(order, ['save', 'timer'], '微任务落盘先于 0ms 任务，且同一 tick 两次 request 只落一次')
})

test('P1: critical-path flush lands synchronously, cancels the pending microtask, and never double-writes', async () => {
  const { storage, calls, data } = fakeStorage()
  let payload: UnreadV2Payload = { v: 2, read: { a: { s1: 1 } }, edge: {}, notified: {} }
  const queue = deferredQueue()
  const saves = createUnreadSaveCoalescer(() => { saveUnread(storage, payload) }, queue.defer)
  saves.request()
  saves.request()
  // pagehide / visibilitychange-hidden / unmount：同步落盘（最新状态）并取消待办。
  payload = { ...payload, read: { a: { s1: 9 } } }
  saves.flush()
  assert.deepEqual(calls, ['set:' + UNREAD_V2_KEY], '关键路径同步落盘一次')
  assert.equal(saves.pending(), false, 'flush 取消待办')
  assert.deepEqual(JSON.parse(data.get(UNREAD_V2_KEY)!).read, { a: { s1: 9 } }, '写的是 flush 时刻的最新状态')
  await Promise.resolve()
  assert.deepEqual(calls, ['set:' + UNREAD_V2_KEY], '被取消的微任务不得二次写盘')
  // 无待办也照常落盘（1s 节流窗口内可能仍有脏状态要落）。
  saves.flush()
  assert.equal(calls.length, 2, 'flush 不依赖待办：关键路径永远能落盘')
  saves.request()
  saves.cancel()
  queue.drain()
  assert.equal(calls.length, 2, 'cancel 丢弃待办且不写盘')
})

test('read marks merge monotonically (max) and never regress on an older remote', () => {
  const local = { s1: 10, s2: 20 }
  assert.deepEqual(mergeReadMarks(local, { s1: 5, s2: 30, s3: 1 }), { s1: 10, s2: 30, s3: 1 })
  assert.equal(mergeReadMarks(local, undefined), local)
  assert.deepEqual(mergeReadMarks(local, { s1: 5 }), local)
  assert.deepEqual(mergeReadMarks(local, { s1: 5, s2: -3 }), local)
})

test('advanceReadMark is strictly > and 0/undefined safe', () => {
  assert.equal(advanceReadMark(undefined, 7), 7)
  assert.equal(advanceReadMark(7, 7), 7)
  assert.equal(advanceReadMark(7, 6), 7)
  assert.equal(advanceReadMark(7, undefined), 7)
  assert.equal(advanceReadMark(7, 0), 7)
  assert.equal(advanceReadMark(undefined, 0), undefined)
})

test('maxWatermark takes max(updatedAt, completedAt) across the table', () => {
  assert.equal(maxWatermark({ a: { updatedAt: 5, completedAt: 9 }, b: { updatedAt: 12 } }), 12)
  assert.equal(maxWatermark({ a: { completedAt: null } }), 0)
  assert.equal(maxWatermark({}), 0)
})

test('bounded LRU: per-source read keeps the highest watermarks only', () => {
  const payload: UnreadV2Payload = {
    v: 2,
    read: { a: { s1: 1, s2: 5, s3: 3 } },
    edge: { a: { s1: true, s2: true, s3: true } },
    notified: { a: { s1: { complete: 1 }, s2: { complete: 5 }, s3: { complete: 3 } } },
  }
  const pruned = pruneUnreadPayload(payload, 2)
  assert.deepEqual(Object.keys(pruned.read.a).sort(), ['s2', 's3'])
  assert.deepEqual(Object.keys(pruned.edge.a).sort(), ['s2', 's3'])
  assert.deepEqual(Object.keys(pruned.notified.a).sort(), ['s2', 's3'])
  assert.deepEqual(pruneUnreadPayload(payload, 0), { v: 2, read: {}, edge: {}, notified: {}, pending: {}, outcomes: {} })
})

test('client-install id: persisted id wins, absent/corrupt regenerates and persists', () => {
  const existing = fakeStorage({
    [CLIENT_INSTALL_ID_KEY]: JSON.stringify({ v: 1, id: 'client-abc', createdAt: 1 }),
  })
  assert.equal(loadClientInstallId(existing.storage), 'client-abc')
  const fresh = fakeStorage()
  const generated: string[] = []
  const id = loadClientInstallId(fresh.storage, () => { generated.push('x'); return 'generated-id-1' })
  assert.equal(id, 'generated-id-1')
  assert.equal(generated.length, 1)
  assert.match(fresh.data.get(CLIENT_INSTALL_ID_KEY)!, /generated-id-1/)
  const corrupt = fakeStorage({ [CLIENT_INSTALL_ID_KEY]: JSON.stringify({ v: 1, id: 'bad id!' }) })
  assert.equal(loadClientInstallId(corrupt.storage, () => 'fixed-id'), 'fixed-id')
  const throwing: UnreadStorageLike = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
    removeItem: () => undefined,
  }
  assert.equal(loadClientInstallId(throwing, () => 'memory-id'), 'memory-id')
  assert.match(createClientInstallId(), CLIENT_INSTALL_ID_PATTERN)
})

test('privacy whitelist: the serialized payload carries ids, watermarks and timestamps only', () => {
  const { storage, data } = fakeStorage()
  saveUnread(storage, {
    v: 2,
    read: { 'gateway-a': { s1: 5 } },
    edge: { 'gateway-a': { s1: true } },
    notified: { 'gateway-a': { s1: { complete: 5 } } },
    pending: { 'gateway-a': { s1: { watermark: 5, goalId: 'goal-1', at: 1_700_000_000_000 } } },
    outcomes: { 'gateway-a': { 'goal-1': 5 } },
  })
  const raw = data.get(UNREAD_V2_KEY)!
  for (const forbidden of ['title', 'cwd', 'content', 'prompt', 'message', 'body', 'objective', 'blockedReason']) {
    assert.ok(!raw.includes(forbidden), 'payload must not carry ' + forbidden)
  }
  // 键白名单：顶层只有五张表 + v；行内条目只允许 kind/水位/时间戳/id 字段
  // （sourceId/sessionId/goalId 是动态键，由上面的 forbidden 子串检查兜底）。
  const parsed = JSON.parse(raw) as Record<string, unknown>
  assert.deepEqual(Object.keys(parsed).sort(), ['edge', 'notified', 'outcomes', 'pending', 'read', 'v'])
  const unknownEntryKeys: string[] = []
  // 叶子条目键（source 表 → session 行 → 条目对象）。
  const checkLeafKeys = (table: unknown, allowed: readonly string[]): void => {
    if (typeof table !== 'object' || table === null) return
    for (const sessions of Object.values(table as Record<string, unknown>)) {
      if (typeof sessions !== 'object' || sessions === null) continue
      for (const entry of Object.values(sessions as Record<string, unknown>)) {
        if (typeof entry !== 'object' || entry === null) continue
        for (const key of Object.keys(entry as Record<string, unknown>)) {
          if (!allowed.includes(key)) unknownEntryKeys.push(key)
        }
      }
    }
  }
  checkLeafKeys(parsed.notified, ['complete', 'ask', 'request'])
  checkLeafKeys(parsed.pending, ['watermark', 'goalId', 'deferred', 'at'])
  assert.deepEqual(unknownEntryKeys, [], '未知键 ⇒ 可能是正文泄漏')
})

// ── 有界待发 ack 队列（失败重放） ──────────────────────────────────────────

/** 冲一个宏任务，让 outbox 的 fire-and-forget 上行结算。 */
function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/** 最小响应假件（只用到 ok/status，真实 Response 的 body 无意义）。 */
function ackResponse(status: number): Response {
  return new Response('{}', { status })
}

test('R22 send classification: network/5xx/408/429 retryable, other non-2xx permanent', async () => {
  const send = async (status: number | 'network') => {
    const fetchImpl = (async () => {
      if (status === 'network') throw new Error('offline')
      return ackResponse(status)
    }) as unknown as typeof fetch
    return sendUnreadRequest(fetchImpl, '/read', { clientId: 'c' })
  }
  assert.equal((await send(200)).outcome, 'ok')
  for (const status of [500, 502, 503, 504, 408, 429]) {
    assert.equal((await send(status)).outcome, 'retryable', 'HTTP ' + status + ' 必须可重放')
  }
  for (const status of [400, 401, 403, 404, 405, 413]) {
    assert.equal((await send(status)).outcome, 'permanent', 'HTTP ' + status + ' 重放不可能成功')
  }
  const network = await send('network')
  assert.equal(network.outcome, 'retryable')
  assert.ok(network.error !== undefined)
})

test('R22 outbox: a failed ack stays pending, a recovery replay delivers it, success dequeues', async () => {
  const posts: Array<{ url: string; body: unknown }> = []
  let status = 503
  const fetchImpl = (async (url: unknown, init?: unknown) => {
    posts.push({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) })
    return ackResponse(status)
  }) as unknown as typeof fetch
  const outbox = createUnreadAckOutbox({ fetchImpl })
  outbox.post('gateway-a', 'read', '/api/i/gateway-a/chamber/session-state/read', {
    clientId: 'c',
    sessionId: 's1',
    readThrough: 42,
  })
  await tick()
  assert.equal(outbox.size(), 1, '5xx ⇒ 待发（不再静默丢账）')
  assert.deepEqual(outbox.pending()[0].payload, { clientId: 'c', sessionId: 's1', readThrough: 42 })
  status = 200
  assert.equal(await outbox.replay(), 1, '恢复重放投递 1 条')
  assert.equal(posts.length, 2)
  assert.deepEqual(posts[1], posts[0], '重放与首次上行逐字节相同（服务端 max ⇒ 安全）')
  assert.equal(outbox.size(), 0, '2xx ⇒ 出队')
  assert.equal(await outbox.replay(), 0, '空队列重放不发任何请求')
  assert.equal(posts.length, 2)
})

test('R22 outbox: same-key coalescing keeps the highest watermark (max server ⇒ lossless)', async () => {
  // 服务端单调 max 仿真：等价 mergeReadMark / markAllRead 的 floor 合并。
  const server = new Map<string, number>()
  const fetchImpl = (async (_url: unknown, init?: unknown) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { sessionId: string; readThrough: number }
    server.set(body.sessionId, Math.max(server.get(body.sessionId) ?? 0, body.readThrough))
    return ackResponse(500)
  }) as unknown as typeof fetch
  const outbox = createUnreadAckOutbox({ fetchImpl })
  outbox.post('gateway-a', 'read', '/read', { clientId: 'c', sessionId: 's1', readThrough: 5 })
  outbox.post('gateway-a', 'read', '/read', { clientId: 'c', sessionId: 's1', readThrough: 9 })
  outbox.post('gateway-a', 'read', '/read', { clientId: 'c', sessionId: 's1', readThrough: 7 })
  await tick()
  const pending = outbox.pending()
  assert.equal(pending.length, 1, '同键三条只留一条')
  assert.equal(pending[0].watermark, 9, '留下的必须是最高水位（旧值被 max 支配）')
  assert.equal(server.get('s1'), 9, '服务端 max 合并：5/9/7 三次写入后仍是 9（落后值不改变结果）')
})

test('R22 outbox: read-all has its own key and coalesces on the source floor', async () => {
  const fetchImpl = (async () => ackResponse(503)) as unknown as typeof fetch
  const outbox = createUnreadAckOutbox({ fetchImpl })
  outbox.post('gateway-a', 'read-all', '/read-all', { clientId: 'c', through: 5 })
  outbox.post('gateway-a', 'read-all', '/read-all', { clientId: 'c', through: 12 })
  outbox.post('gateway-a', 'read', '/read', { clientId: 'c', sessionId: 's1', readThrough: 12 })
  await tick()
  assert.deepEqual(outbox.pending().map(entry => entry.method), ['read-all', 'read'], 'read-all 与 read 各自成键')
  assert.equal(outbox.pending()[0].watermark, 12, 'read-all 同键取最高 floor')
})

test('R22 outbox: the pending table is bounded and evicts oldest keys with a diagnostic', async () => {
  const fetchImpl = (async () => ackResponse(502)) as unknown as typeof fetch
  const errors: string[] = []
  const outbox = createUnreadAckOutbox({ fetchImpl, maxPending: 2, onError: error => errors.push(String(error)) })
  for (const sessionId of ['s1', 's2', 's3']) {
    outbox.post('gateway-a', 'read', '/read', { clientId: 'c', sessionId, readThrough: 1 })
  }
  await tick()
  assert.equal(outbox.size(), 2, '上限是硬的')
  assert.deepEqual(
    outbox.pending().map(entry => entry.payload.sessionId),
    ['s2', 's3'],
    'FIFO 淘汰：最久入队的 s1 先被丢',
  )
  assert.ok(errors.some(message => message.includes('overflow')), '淘汰必须可见，不许静默')
  assert.equal(UNREAD_PENDING_MAX, 64, '默认上限是钉住的常量')
})

test('R22 outbox: a permanent 4xx dequeues with a diagnostic instead of poisoning the queue', async () => {
  const posts: string[] = []
  const fetchImpl = (async (url: unknown) => {
    posts.push(String(url))
    return ackResponse(400)
  }) as unknown as typeof fetch
  const errors: string[] = []
  const outbox = createUnreadAckOutbox({ fetchImpl, onError: error => errors.push(String(error)) })
  outbox.post('gateway-a', 'read-all', '/read-all', { clientId: 'c', through: 7 })
  await tick()
  assert.equal(outbox.size(), 0, '400 重放不可能成功 ⇒ 立即出队')
  assert.equal(await outbox.replay(), 0)
  assert.equal(posts.length, 1, '不得无限重试')
  assert.ok(errors.some(message => message.includes('400')))
})

test('R22 outbox: a late success never dequeues a newer in-flight watermark', async () => {
  const resolvers: Array<(value: Response) => void> = []
  const fetchImpl = (async () => new Promise<Response>(resolve => { resolvers.push(resolve) })) as unknown as typeof fetch
  const outbox = createUnreadAckOutbox({ fetchImpl })
  outbox.post('gateway-a', 'read', '/read', { clientId: 'c', sessionId: 's1', readThrough: 5 })
  outbox.post('gateway-a', 'read', '/read', { clientId: 'c', sessionId: 's1', readThrough: 9 })
  assert.equal(resolvers.length, 2)
  resolvers[0](ackResponse(200))
  await tick()
  assert.equal(outbox.size(), 1, '旧值 5 的成功不得把同键的新值 9 删掉')
  assert.equal(outbox.pending()[0].watermark, 9)
  resolvers[1](ackResponse(200))
  await tick()
  assert.equal(outbox.size(), 0)
})

test('R22 outbox: post() is synchronous and never throws, even when fetch throws synchronously', async () => {
  const fetchImpl = (() => { throw new Error('boom') }) as unknown as typeof fetch
  const errors: string[] = []
  const outbox = createUnreadAckOutbox({ fetchImpl, onError: error => errors.push(String(error)) })
  assert.equal(
    outbox.post('gateway-a', 'read', '/read', { clientId: 'c', sessionId: 's1', readThrough: 3 }),
    undefined,
    'post 同步返回：读推进不等待网络',
  )
  await tick()
  assert.equal(outbox.size(), 1, '同步抛也算通道失败 ⇒ 进待发表')
  assert.ok(errors.some(message => message.includes('boom')))
})

// ── goal-aware v5 §3.1：pending / outcomes 增量（sanitize / prune / 隐私） ────

test('pending/outcomes sanitize field-wise: bad fields drop, valid entries survive', () => {
  const loaded = loadUnread(fakeStorage({
    [UNREAD_V2_KEY]: JSON.stringify({
      v: 2,
      read: {},
      edge: {},
      notified: {},
      pending: {
        a: {
          good: { watermark: 5, goalId: 'g1', at: 100 },
          badWatermark: { watermark: 'x', goalId: 'g1', at: 100 },
          badGoal: { watermark: 5, goalId: '', at: 100 },
          badAt: { watermark: 5, goalId: 'g1', at: 'nope' },
          notAnObject: 7,
        },
      },
      outcomes: { a: { g1: 10, g2: 'x', g3: -1 } },
    }),
  }).storage)
  assert.deepEqual(loaded.pending, {
    a: {
      good: { watermark: 5, goalId: 'g1', at: 100 },
      badWatermark: { goalId: 'g1', at: 100 },
      badGoal: { watermark: 5, at: 100 },
    },
  })
  assert.deepEqual(loaded.outcomes, { a: { g1: 10 } })
})

test('REGRESSION(F5 阻断项 1): pending.deferred survives the saveUnread → loadUnread round-trip', () => {
  // 反例：goal unknown + busy 完成 → pending{deferred} 落盘 → 同页 reload（boot same）
  // → sanitize 只重建 at/watermark/goalId，丢 deferred → App 经 unreadPendingTable 回读后
  // 释放标记消失：busy 结束零 emit、pending 永久留存（goal null/paused 时 #3 静默 drop）。
  const { storage } = fakeStorage()
  const payload: UnreadV2Payload = {
    v: 2,
    read: { a: { s1: 7 } },
    edge: {},
    notified: { a: { s1: { complete: 7 } } },
    pending: {
      a: {
        s1: { at: 1_000, watermark: 7, goalId: 'g1', deferred: 'subagent-busy' },
        s2: { at: 2_000 },
      },
    },
    outcomes: { a: { g1: 7 } },
  }
  assert.equal(saveUnread(storage, payload), true)
  const loaded = loadUnread(storage)
  assert.deepEqual(loaded.pending, {
    a: {
      s1: { at: 1_000, watermark: 7, goalId: 'g1', deferred: 'subagent-busy' },
      s2: { at: 2_000 },
    },
  }, 'deferred 是 durable 身份：落盘 → 回读必须原样保留')
  // 二次往返同样稳定（写盘不吞标记）。
  assert.equal(saveUnread(storage, loaded), true)
  assert.equal(loadUnread(storage).pending?.a?.s1?.deferred, 'subagent-busy')
})

test('REGRESSION(F5 阻断项 1): an invalid pending.deferred drops only the field, never the entry', () => {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(value => String(value)).join(' ')) }
  try {
    const loaded = loadUnread(fakeStorage({
      [UNREAD_V2_KEY]: JSON.stringify({
        v: 2, read: {}, edge: {}, notified: {},
        pending: { a: { bad: { at: 3, deferred: 'nope' }, good: { at: 4, deferred: 'subagent-busy' } } },
      }),
    }).storage)
    assert.deepEqual(loaded.pending, { a: { bad: { at: 3 }, good: { at: 4, deferred: 'subagent-busy' } } },
      '非法 deferred 值只丢字段；at 成立时整条保留')
    assert.ok(warnings.some(message => message.includes('invalid deferred')), warnings.join(' | '))
  } finally {
    console.warn = original
  }
})

test('REGRESSION(A3-2): sanitizeUnreadPayload and createCompleteLedger agree on an invalid deferred (field-level)', () => {
  // 同一份**原始**载荷（未经清洗）分别经两条加载路径（未读 v2 清洗 / complete 账本
  // 卫生）必须给出同一结果：非法 deferred 只丢字段、条目保留（A3-2 的口径对齐）。
  const raw = {
    a: { bad: { at: 3, deferred: 'nope' }, good: { at: 4, deferred: 'subagent-busy' } },
  } as unknown as PendingCompletionTable
  const sanitized = sanitizeUnreadPayload({ v: 2, read: {}, edge: {}, notified: {}, pending: raw })
  assert.deepEqual(sanitized.pending, { a: { bad: { at: 3 }, good: { at: 4, deferred: 'subagent-busy' } } })
  const ledger = createCompleteLedger({}, { pending: raw, now: 10 })
  assert.deepEqual(ledger.pendingEntry('a', 'bad'), sanitized.pending?.a?.bad, '账本路径不得整条丢弃（与 sanitize 同口径）')
  assert.deepEqual(ledger.pendingEntry('a', 'good'), sanitized.pending?.a?.good)
  assert.equal(ledger.pendingEntry('a', 'good')?.deferred, 'subagent-busy')
})

test('missing/corrupt pending/outcomes degrade to empty loudly and never throw', () => {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(value => String(value)).join(' ')) }
  try {
    const missing = loadUnread(fakeStorage({
      [UNREAD_V2_KEY]: JSON.stringify({ v: 2, read: {}, edge: {}, notified: {} }),
    }).storage)
    assert.deepEqual(missing.pending, {})
    assert.deepEqual(missing.outcomes, {})
    assert.ok(warnings.some(message => message.includes('pending')), warnings.join(' | '))
    assert.ok(warnings.some(message => message.includes('outcomes')), warnings.join(' | '))
    warnings.length = 0
    const corrupt = loadUnread(fakeStorage({
      [UNREAD_V2_KEY]: JSON.stringify({ v: 2, read: {}, edge: {}, notified: {}, pending: 'nope', outcomes: 42 }),
    }).storage)
    assert.deepEqual(corrupt.pending, {})
    assert.deepEqual(corrupt.outcomes, {})
    assert.equal(warnings.length, 2)
  } finally {
    console.warn = original
  }
})

test('bounded LRU covers the new tables: pending aligns with read, outcomes keep the highest', () => {
  const payload: UnreadV2Payload = {
    v: 2,
    read: { a: { s1: 1, s2: 5, s3: 3 } },
    edge: { a: { s1: true, s2: true, s3: true } },
    notified: { a: { s1: { complete: 1 }, s2: { complete: 5 }, s3: { complete: 3 } } },
    pending: { a: { s1: { at: 1 }, s2: { at: 2 }, s3: { at: 3 }, s4: { at: 4 } } },
    outcomes: { a: { g1: 1, g2: 9, g3: 5 } },
  }
  const pruned = pruneUnreadPayload(payload, 2)
  assert.deepEqual(Object.keys(pruned.read.a).sort(), ['s2', 's3'])
  assert.deepEqual(Object.keys(pruned.pending!.a).sort(), ['s2', 's3'], 'pending 与 read 同界')
  assert.deepEqual(Object.keys(pruned.outcomes!.a).sort(), ['g2', 'g3'], 'outcomes 按水位保留最高')
  assert.deepEqual(pruneEmptyUnreadTables(pruned).pending!.a, pruned.pending!.a)
})

// ── boot token（sessionStorage 页代；v5 §3.5 / R2-E） ───────────────────────

test('boot token: the first load writes fresh, a reload reads the same token back', () => {
  const { storage, data } = fakeStorage()
  const created: string[] = []
  const first = loadBootToken(storage, () => { created.push('x'); return 'page-token-1' })
  assert.deepEqual(first, { token: 'page-token-1', verdict: 'fresh' })
  assert.equal(created.length, 1)
  assert.equal(data.get(BOOT_TOKEN_KEY), 'page-token-1', '首帧写入 sessionStorage')
  const second = loadBootToken(storage, () => { throw new Error('reload must not rotate the token') })
  assert.deepEqual(second, { token: 'page-token-1', verdict: 'same' })
})

test('boot token: absent/corrupt/throwing storage degrades to fresh and never throws', () => {
  const absent = fakeStorage()
  assert.deepEqual(loadBootToken(absent.storage, () => 't1'), { token: 't1', verdict: 'fresh' })
  const corrupt = fakeStorage({ [BOOT_TOKEN_KEY]: '' })
  assert.deepEqual(loadBootToken(corrupt.storage, () => 't2'), { token: 't2', verdict: 'fresh' })
  const throwing: BootTokenStorageLike = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
  }
  assert.deepEqual(loadBootToken(throwing, () => 't3'), { token: 't3', verdict: 'fresh' })
  assert.deepEqual(loadBootToken(undefined, () => 't4'), { token: 't4', verdict: 'fresh' })
  assert.match(createBootToken(), /^[0-9a-f-]{8,}$/i, 'randomUUID/hex 形态，never-throw')
})

