/**
 * 通知落盘存储契约（notification-store.ts，唯一持续写入的键
 * dsh-chamber.notifications.v1 = { v:1, notifiedRuns, pending, outcomes }）。
 *
 * 覆盖：键常量、v1 load/save 往返、v4 → v1 一次性迁移（只取通知三表，read/edge 丢弃，
 * v4/v2/v5/client-install-id 迁移后删除）、v2 → v1（notified/notifiedCompletionSeq →
 * 身份哨兵）、宽松清洗（坏 pending 项只丢字段不丢整条 / 非法 outcomes 水位丢弃 /
 * 非法身份串剥掉）、有界化剪枝、immediate 落盘合并器、隐私键白名单。
 *
 * 完成未读的旧持久面（read 水位 / edge 账本 / v5 影子 / 读回执 / client-install id）
 * 已整体退役：官方 uiSession.sessionStatus.completionUnread 是唯一权威，App 只补一条
 * 内存修正臂（client-core completion-arm.ts）。本模块只为通知 durable 三表服务。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LEGACY_CLIENT_INSTALL_ID_KEY,
  LEGACY_UNREAD_V2_KEY,
  LEGACY_UNREAD_V4_KEY,
  LEGACY_UNREAD_V5_KEY,
  NOTIFICATION_MAX_SESSIONS_PER_SOURCE,
  NOTIFICATIONS_V1_KEY,
  createNotificationSaveCoalescer,
  emptyNotificationPayload,
  loadNotifications,
  notificationOutcomeTable,
  notificationPendingTable,
  pruneEmptyNotificationTables,
  pruneNotificationPayload,
  sanitizeNotificationPayload,
  saveNotifications,
  type NotificationPayload,
  type NotificationStorageLike,
} from '../../src/notification-store.ts'
import { LEGACY_NOTIFIED_RUN_ID } from '../../src/notification-identity.ts'

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial))
  const calls: string[] = []
  const storage: NotificationStorageLike = {
    getItem: key => (data.has(key) ? data.get(key)! : null),
    setItem: (key, value) => { calls.push('set:' + key); data.set(key, value) },
    removeItem: key => { calls.push('remove:' + key); data.delete(key) },
  }
  return { storage, calls, data }
}

test('keys are the frozen localStorage names (v1 authoritative; v4/v2 the one-shot migration sources)', () => {
  assert.equal(NOTIFICATIONS_V1_KEY, 'dsh-chamber.notifications.v1')
  assert.equal(LEGACY_UNREAD_V4_KEY, 'dsh-chamber.unread.v4')
  assert.equal(LEGACY_UNREAD_V2_KEY, 'dsh-chamber.unread.v2')
  assert.equal(LEGACY_UNREAD_V5_KEY, 'dsh-chamber.unread.v5')
  assert.equal(LEGACY_CLIENT_INSTALL_ID_KEY, 'dsh-chamber.client-install-id.v1')
  assert.equal(NOTIFICATION_MAX_SESSIONS_PER_SOURCE, 500)
})

test('load/save round-trip the v1 payload (pending/outcomes helpers read the same tables)', () => {
  const { storage } = fakeStorage()
  const payload: NotificationPayload = {
    v: 1,
    notifiedRuns: { a: { s1: 'host:turn%2F7' } },
    pending: { a: { s1: { at: 100, watermark: 5, goalId: 'g1', completionSeq: 7, deferred: 'subagent-busy' } } },
    outcomes: { a: { g1: 10 } },
  }
  assert.equal(saveNotifications(storage, payload), true)
  const loaded = loadNotifications(storage)
  assert.deepEqual(loaded, payload, 'the durable three tables survive a save → load round-trip')
  assert.deepEqual(notificationPendingTable(loaded), payload.pending)
  assert.deepEqual(notificationOutcomeTable(loaded), payload.outcomes)
  // 缺字段的宽容读（sanitize 会先补空表；helper 自身也对缺字段兜底）。
  const sparse = { v: 1, notifiedRuns: {} } as NotificationPayload
  assert.deepEqual(notificationPendingTable(sparse), {})
  assert.deepEqual(notificationOutcomeTable(sparse), {})
})

test('save prunes empty source tables and never throws (undefined/throwing storage degrade)', () => {
  const { storage, data } = fakeStorage()
  assert.equal(saveNotifications(storage, {
    v: 1,
    notifiedRuns: { a: {}, b: { s1: 'host:turn%2F1' } },
    pending: { a: {} },
    outcomes: { a: {} },
  }), true)
  assert.deepEqual(JSON.parse(data.get(NOTIFICATIONS_V1_KEY)!), {
    v: 1,
    notifiedRuns: { b: { s1: 'host:turn%2F1' } },
    pending: {},
    outcomes: {},
  }, '空来源表在序列化前剪除（载荷最小、无噪声键）')
  const throwing: NotificationStorageLike = {
    getItem: () => null,
    setItem: () => { throw new Error('private mode') },
    removeItem: () => undefined,
  }
  assert.equal(saveNotifications(throwing, emptyNotificationPayload()), false, '写盘失败只降级为内存态，绝不抛')
  assert.equal(saveNotifications(undefined, emptyNotificationPayload()), false)
  assert.deepEqual(loadNotifications(undefined), emptyNotificationPayload())
})

test('a v4 payload migrates to v1 one-shot: only the notification tables survive; every old key is removed', () => {
  const { storage, calls, data } = fakeStorage({
    [LEGACY_UNREAD_V4_KEY]: JSON.stringify({
      v: 4,
      read: { a: { s1: 9 } },
      edge: { a: { s1: true } },
      notifiedRuns: { a: { s1: 'host:turn%2F7' } },
      pending: { a: { s1: { at: 100, watermark: 5, goalId: 'g1', deferred: 'subagent-busy' } } },
      outcomes: { a: { g1: 10 } },
    }),
    [LEGACY_UNREAD_V2_KEY]: JSON.stringify({ v: 2, read: { a: { s1: 1 } }, edge: {}, notified: {} }),
    [LEGACY_UNREAD_V5_KEY]: JSON.stringify({ v: 5, read: { a: { s1: 1 } }, edge: {} }),
    [LEGACY_CLIENT_INSTALL_ID_KEY]: JSON.stringify({ v: 1, id: 'client-abc', createdAt: 1 }),
  })
  const loaded = loadNotifications(storage)
  assert.deepEqual(loaded, {
    v: 1,
    notifiedRuns: { a: { s1: 'host:turn%2F7' } },
    pending: { a: { s1: { at: 100, watermark: 5, goalId: 'g1', deferred: 'subagent-busy' } } },
    outcomes: { a: { g1: 10 } },
  }, 'read/edge 是退役面，不搬进通知载荷')
  assert.equal('read' in loaded, false)
  assert.equal('edge' in loaded, false)
  // v1 写成功之后才删旧键；四个旧键（含只写不读的 v5 影子与 client-install id）都必须清掉。
  assert.deepEqual(JSON.parse(data.get(NOTIFICATIONS_V1_KEY)!), loaded, '迁移即写 v1')
  const setIndex = calls.indexOf('set:' + NOTIFICATIONS_V1_KEY)
  for (const key of [LEGACY_UNREAD_V4_KEY, LEGACY_UNREAD_V2_KEY, LEGACY_UNREAD_V5_KEY, LEGACY_CLIENT_INSTALL_ID_KEY]) {
    assert.ok(!data.has(key), key + ' 迁移后必须被删除')
    const removeIndex = calls.indexOf('remove:' + key)
    assert.ok(removeIndex !== -1 && setIndex < removeIndex, key + ' 在 v1 写成功之后才删除')
  }
})

test('a failing v4 → v1 write keeps the old journal for a later attempt', () => {
  const data = new Map<string, string>([[LEGACY_UNREAD_V4_KEY, JSON.stringify({
    v: 4,
    read: { a: { s1: 9 } },
    edge: {},
    notifiedRuns: { a: { s1: 'host:turn%2F7' } },
    pending: {},
    outcomes: {},
  })]])
  const storage: NotificationStorageLike = {
    getItem: key => data.get(key) ?? null,
    setItem: () => { throw new Error('quota') },
    removeItem: key => { data.delete(key) },
  }
  const loaded = loadNotifications(storage)
  assert.deepEqual(loaded.notifiedRuns, { a: { s1: 'host:turn%2F7' } })
  assert.ok(data.has(LEGACY_UNREAD_V4_KEY), '写入失败 ⇒ 旧日志保留，下一轮再迁移')
})

test('a corrupt v4 payload falls back to the v2 migration source, never to removed read/edge keys', () => {
  const { storage, data } = fakeStorage({
    [LEGACY_UNREAD_V4_KEY]: '{not json',
    [LEGACY_UNREAD_V2_KEY]: JSON.stringify({ v: 2, read: { a: { s1: 9 } }, edge: { a: { s1: true } }, notified: {} }),
    'dsh-chamber.unread.v3': JSON.stringify({ v: 3, read: { a: { s1: 1 } }, edge: {} }),
    'dsh-chamber.unread.v1': JSON.stringify({ a: { s1: true } }),
  })
  const loaded = loadNotifications(storage)
  assert.deepEqual(loaded, emptyNotificationPayload(), '退役键与坏 v4 都不得造出通知面；v2 迁移只搬通知三表')
  assert.deepEqual(JSON.parse(data.get(NOTIFICATIONS_V1_KEY)!), emptyNotificationPayload(), 'v2 迁移成功即写 v1')
  assert.ok(!data.has(LEGACY_UNREAD_V2_KEY), '迁移来源在 v1 写成功后删除')
  assert.ok(!data.has(LEGACY_UNREAD_V4_KEY), '不可解析的 v4 随同一次迁移清理（不再有读取价值）')
})

test('a v2 payload migrates to v1: notified/notifiedCompletionSeq become identity sentinels; pending/outcomes carry over', () => {
  const { storage, data } = fakeStorage({
    [LEGACY_UNREAD_V2_KEY]: JSON.stringify({
      v: 2,
      read: { a: { s1: 9 } },
      edge: { a: { s1: true } },
      notified: { a: { s1: { complete: 5 }, s2: { ask: 3 } } },
      notifiedCompletionSeq: { a: { s1: 7, s4: 8 } },
      notifiedRuns: { a: { s3: 'host:turn%2F3' } },
      pending: { a: { s1: { at: 100, watermark: 5, goalId: 'g1', deferred: 'subagent-busy' } } },
      outcomes: { a: { g1: 5 } },
    }),
  })
  const loaded = loadNotifications(storage)
  assert.deepEqual(loaded.notifiedRuns, {
    a: {
      // 只有 completion 已通知的会话拿哨兵：legacy ask/request 水位从不代表一次完成。
      s1: LEGACY_NOTIFIED_RUN_ID,
      s3: 'host:turn%2F3',
      s4: LEGACY_NOTIFIED_RUN_ID,
    },
  }, 'notified.complete 与 notifiedCompletionSeq 都是 completion 证据；真实身份原样保留')
  assert.deepEqual(loaded.pending, { a: { s1: { at: 100, watermark: 5, goalId: 'g1', deferred: 'subagent-busy' } } })
  assert.deepEqual(loaded.outcomes, { a: { g1: 5 } })
  const onDisk = JSON.parse(data.get(NOTIFICATIONS_V1_KEY)!) as Record<string, unknown>
  assert.equal('notified' in onDisk, false, '被替换的旧表不写回')
  assert.equal('notifiedCompletionSeq' in onDisk, false)
  assert.equal('read' in onDisk, false)
  assert.equal('edge' in onDisk, false)
  assert.ok(!data.has(LEGACY_UNREAD_V2_KEY))
})

test('a v1 key with a wrong version or corrupt JSON is ignored, never partially trusted', () => {
  const wrongVersion = fakeStorage({ [NOTIFICATIONS_V1_KEY]: JSON.stringify({ v: 2, notifiedRuns: { a: { s1: 'host:turn%2F1' } } }) })
  assert.deepEqual(loadNotifications(wrongVersion.storage), emptyNotificationPayload())
  const corrupt = fakeStorage({ [NOTIFICATIONS_V1_KEY]: '{not json' })
  assert.deepEqual(loadNotifications(corrupt.storage), emptyNotificationPayload())
  const nonRecord = fakeStorage({ [NOTIFICATIONS_V1_KEY]: JSON.stringify([1, 2, 3]) })
  assert.deepEqual(loadNotifications(nonRecord.storage), emptyNotificationPayload())
})

test('sanitize is lenient field-wise: corrupt identities are stripped, bad pending entries keep their legal fields', () => {
  const loaded = loadNotifications(fakeStorage({
    [NOTIFICATIONS_V1_KEY]: JSON.stringify({
      v: 1,
      notifiedRuns: {
        a: {
          good: 'host:turn%2F7',
          badEncoded: 'host:%',
          truncated: 'chamber:fp:0:s1',
          nonNumeric: 'chamber:fp:x:s1:1',
          oversize: 'x'.repeat(300),
          sentinel: LEGACY_NOTIFIED_RUN_ID,
          nonString: 42,
          empty: '',
        },
        b: 'not-a-table',
        c: { s1: 'chamber:fp:0:s1:1' },
      },
      pending: {
        a: {
          s1: { at: 100, watermark: 5, goalId: 'g1', completionSeq: 4242, deferred: 'subagent-busy' },
          // 非法只丢字段，整条保留（at 是 pending 的身份）。
          s2: { at: 100, watermark: 'x', goalId: '', completionSeq: -1, deferred: 'bogus' },
          // at 不成立 ⇒ 整条丢弃。
          s3: { watermark: 5 },
          s4: 7,
        },
        b: 'nope',
      },
      outcomes: { a: { g1: 10, g2: 'x', g3: -1 }, b: 'nope' },
    }),
  }).storage)
  assert.deepEqual(loaded.notifiedRuns, {
    a: { good: 'host:turn%2F7', sentinel: LEGACY_NOTIFIED_RUN_ID },
    c: { s1: 'chamber:fp:0:s1:1' },
  }, '坏身份串绝不到达投影（URIError / 伪造比较）')
  assert.deepEqual(loaded.pending, {
    a: {
      s1: { at: 100, watermark: 5, goalId: 'g1', completionSeq: 4242, deferred: 'subagent-busy' },
      s2: { at: 100 },
    },
  }, '坏 pending 项只丢字段不丢整条；at 不成立的整条丢弃')
  assert.deepEqual(loaded.outcomes, { a: { g1: 10 } }, '非法 outcomes 水位丢弃，合法项保留')
})

test('a payload missing pending/outcomes is sanitized to empty (loud, never throws)', () => {
  const sanitized = sanitizeNotificationPayload({ v: 1, notifiedRuns: { a: { s1: 'host:turn%2F1' } } })
  assert.deepEqual(sanitized, {
    v: 1,
    notifiedRuns: { a: { s1: 'host:turn%2F1' } },
    pending: {},
    outcomes: {},
  })
  assert.deepEqual(sanitizeNotificationPayload(null), emptyNotificationPayload())
  assert.deepEqual(sanitizeNotificationPayload('nope'), emptyNotificationPayload())
})

test('bounded pruning: per-source identity/pending tables keep the newest tail; outcomes keep the highest watermarks', () => {
  const payload: NotificationPayload = {
    v: 1,
    notifiedRuns: { a: { s1: 'host:turn%2F1', s2: 'host:turn%2F5', s3: 'host:turn%2F3' } },
    pending: { a: { s1: { at: 1 }, s2: { at: 2 }, s3: { at: 3 } } },
    outcomes: { a: { g1: 1, g2: 9, g3: 5 } },
  }
  const pruned = pruneNotificationPayload(payload, 2)
  assert.deepEqual(Object.keys(pruned.notifiedRuns.a).sort(), ['s2', 's3'], '身份表按插入序保留最近 N 条')
  assert.deepEqual(Object.keys(pruned.pending!.a).sort(), ['s2', 's3'], 'pending 表同规')
  assert.deepEqual(Object.keys(pruned.outcomes!.a).sort(), ['g2', 'g3'], 'outcomes 按水位 LRU 保留上限条')
  assert.equal(pruned.notifiedRuns.a.s3, 'host:turn%2F3', 'Tail 保留的是原值（不是伪造身份）')
  assert.deepEqual(pruneNotificationPayload(payload, 0), emptyNotificationPayload(), '非正上限 = 清空')
  // 上限内的表原样拷贝。
  const small = pruneNotificationPayload({ v: 1, notifiedRuns: { a: { s1: 'host:turn%2F1' } }, pending: {}, outcomes: {} }, 5)
  assert.deepEqual(small.notifiedRuns, { a: { s1: 'host:turn%2F1' } })
})

test('pruneEmptyNotificationTables drops empty source rows but keeps the three top-level tables', () => {
  assert.deepEqual(pruneEmptyNotificationTables({
    v: 1,
    notifiedRuns: { a: {}, b: { s1: 'host:turn%2F1' } },
    pending: { a: {} },
    outcomes: { a: {} },
  }), {
    v: 1,
    notifiedRuns: { b: { s1: 'host:turn%2F1' } },
    pending: {},
    outcomes: {},
  })
})

test('privacy whitelist: the serialized v1 payload carries ids, watermarks and timestamps only', () => {
  const { storage, data } = fakeStorage()
  saveNotifications(storage, {
    v: 1,
    notifiedRuns: { 'gateway-a': { s1: 'host:turn%2F7' } },
    pending: { 'gateway-a': { s1: { watermark: 5, goalId: 'goal-1', at: 1_700_000_000_000 } } },
    outcomes: { 'gateway-a': { 'goal-1': 5 } },
  })
  const raw = data.get(NOTIFICATIONS_V1_KEY)!
  for (const forbidden of ['title', 'cwd', 'content', 'prompt', 'message', 'body', 'objective', 'blockedReason']) {
    assert.ok(!raw.includes(forbidden), 'payload must not carry ' + forbidden)
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>
  assert.deepEqual(Object.keys(parsed).sort(), ['notifiedRuns', 'outcomes', 'pending', 'v'],
    '顶层只有通知三表 + v（退役的 read/edge 键不得复活）')
})

// ── immediate 落盘合并（热路径：同一 tick 多次 immediate ⇒ 一次全量写盘） ─────

/** 手动控时的 defer：把合并窗口的微任务收集起来按需冲（不依赖宿主事件循环时序）。 */
function deferredQueue() {
  const queued: Array<() => void> = []
  return {
    defer: (run: () => void): void => { queued.push(run) },
    drain: (): void => { for (const run of queued.splice(0)) run() },
  }
}

test('coalescer: same-tick requests merge into ONE save of the latest authoritative state', () => {
  const { storage, calls, data } = fakeStorage()
  let payload: NotificationPayload = { v: 1, notifiedRuns: {}, pending: {}, outcomes: {} }
  const queue = deferredQueue()
  const saves = createNotificationSaveCoalescer(() => { saveNotifications(storage, payload) }, queue.defer)
  saves.request()
  payload = { ...payload, notifiedRuns: { a: { s1: 'host:turn%2F2' } } }
  saves.request()
  payload = { ...payload, pending: { a: { s1: { at: 3 } } } }
  saves.request()
  assert.deepEqual(calls, [], '合并窗口内不写盘')
  assert.equal(saves.pending(), true, '待办合并窗口可见')
  queue.drain()
  assert.deepEqual(calls, ['set:' + NOTIFICATIONS_V1_KEY], '同一 tick 三次 request 只落一次盘')
  assert.deepEqual(JSON.parse(data.get(NOTIFICATIONS_V1_KEY)!), {
    v: 1,
    notifiedRuns: { a: { s1: 'host:turn%2F2' } },
    pending: { a: { s1: { at: 3 } } },
    outcomes: {},
  }, '合并落盘读的是最新权威内存：先到的 durable 变更不被后到的覆盖丢')
  saves.request()
  queue.drain()
  assert.deepEqual(calls, ['set:' + NOTIFICATIONS_V1_KEY, 'set:' + NOTIFICATIONS_V1_KEY], '合并窗口不吞后续 tick 的变更')
})

test('coalescer: the default defer is a MICROTASK — it lands before a 0ms task', async () => {
  const order: string[] = []
  const saves = createNotificationSaveCoalescer(() => { order.push('save') })
  saves.request()
  saves.request()
  setTimeout(() => { order.push('timer') }, 0)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(order, ['save', 'timer'], '微任务落盘先于 0ms 任务，且同一 tick 两次 request 只落一次')
})

test('coalescer: critical-path flush lands synchronously, cancels the pending microtask, and never double-writes', async () => {
  const { storage, calls } = fakeStorage()
  let payload: NotificationPayload = { v: 1, notifiedRuns: {}, pending: {}, outcomes: {} }
  const queue = deferredQueue()
  const saves = createNotificationSaveCoalescer(() => { saveNotifications(storage, payload) }, queue.defer)
  saves.request()
  saves.request()
  payload = { ...payload, outcomes: { a: { g1: 9 } } }
  saves.flush()
  assert.deepEqual(calls, ['set:' + NOTIFICATIONS_V1_KEY], '关键路径同步落盘一次')
  assert.equal(saves.pending(), false, 'flush 取消待办')
  queue.drain()
  await Promise.resolve()
  assert.deepEqual(calls, ['set:' + NOTIFICATIONS_V1_KEY], '被取消的微任务不得二次写盘')
  saves.flush()
  assert.equal(calls.length, 2, 'flush 不依赖待办：关键路径永远能落盘')
  saves.request()
  saves.cancel()
  queue.drain()
  assert.equal(calls.length, 2, 'cancel 丢弃待办且不写盘')
})
