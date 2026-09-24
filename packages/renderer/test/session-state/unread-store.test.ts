/**
 * 未读 v2 落盘存储契约：键常量、宽松清洗、v2 是唯一读取键、
 * 单调 max 合并、读水位推进、有界化 LRU、client-install id、ack 请求、
 * 隐私键白名单。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLIENT_INSTALL_ID_KEY,
  CLIENT_INSTALL_ID_PATTERN,
  UNREAD_MAX_SESSIONS_PER_SOURCE,
  UNREAD_PENDING_MAX,
  UNREAD_V2_KEY,
  advanceReadMark,
  createClientInstallId,
  createUnreadAckOutbox,
  loadClientInstallId,
  loadUnread,
  maxWatermark,
  mergeReadMarks,
  pruneUnreadPayload,
  saveUnread,
  sendUnreadRequest,
  type UnreadStorageLike,
  type UnreadV2Payload,
} from '../../src/unread-store.ts'

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial))
  const storage: UnreadStorageLike = {
    getItem: key => (data.has(key) ? data.get(key)! : null),
    setItem: (key, value) => { data.set(key, value) },
    removeItem: key => { data.delete(key) },
  }
  return { storage, data }
}

test('keys are the frozen localStorage names (v2 is the only written key)', () => {
  assert.equal(UNREAD_V2_KEY, 'dsh-chamber.unread.v2')
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

test('v2 is the only read key: a legacy v1 payload is never imported', () => {
  // v1 从来没有写入者（unread-store.ts 头注）：防御性导入已删除。这条锁防止
  // 有人把"兼容旧键"当成迁移承诺重新加回来——v1 数据即使存在也必须被忽略。
  const corrupt = fakeStorage({
    [UNREAD_V2_KEY]: '{not json',
    'dsh-chamber.unread.v1': JSON.stringify({ a: { s1: true, s2: false } }),
  })
  const loadedCorrupt = loadUnread(corrupt.storage)
  assert.deepEqual(loadedCorrupt.edge, {}, 'a corrupt v2 must not fall back to v1')
  assert.deepEqual(loadedCorrupt.read, {})
  const v1Only = fakeStorage({ 'dsh-chamber.unread.v1': JSON.stringify({ a: { s1: true } }) })
  assert.deepEqual(loadUnread(v1Only.storage).edge, {}, 'a v1-only install starts empty')
})

test('saveUnread prunes empty tables and never throws', () => {
  const { storage, data } = fakeStorage()
  assert.equal(saveUnread(storage, { v: 2, read: {}, edge: {}, notified: {} }), true)
  assert.equal(data.get(UNREAD_V2_KEY), JSON.stringify({ v: 2, read: {}, edge: {}, notified: {} }))
  const throwing: UnreadStorageLike = {
    getItem: () => null,
    setItem: () => { throw new Error('private mode') },
    removeItem: () => undefined,
  }
  assert.equal(saveUnread(throwing, { v: 2, read: {}, edge: {}, notified: {} }), false)
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
  assert.deepEqual(pruneUnreadPayload(payload, 0), { v: 2, read: {}, edge: {}, notified: {} })
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

test('privacy whitelist: the serialized payload carries ids and watermarks only', () => {
  const { storage, data } = fakeStorage()
  saveUnread(storage, {
    v: 2,
    read: { 'gateway-a': { s1: 5 } },
    edge: { 'gateway-a': { s1: true } },
    notified: { 'gateway-a': { s1: { complete: 5 } } },
  })
  const raw = data.get(UNREAD_V2_KEY)!
  for (const forbidden of ['title', 'cwd', 'content', 'prompt', 'message', 'body']) {
    assert.ok(!raw.includes(forbidden), 'payload must not carry ' + forbidden)
  }
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

