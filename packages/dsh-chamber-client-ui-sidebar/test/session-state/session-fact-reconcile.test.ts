/**
 * 对账链契约（dsh-chamber-client-ui-sidebar/src/shared/session-fact-reconcile.ts）。
 *
 * 锁五件事：
 *  1. **权威判定**：官方 `refreshList()` 对拉取失败照常 resolve —— 「promise 解决」
 *     不算成功，只有 `verify`  seam 确认拿到权威结论才结算 ok:true（这是守卫允许
 *     升级 L2/L3 的唯一依据，2026-12 独立复核抓出的致命缺陷的回归锁）；
 *  2. 单飞（在途重复请求只推进 requestedAt）、有界重试、结算回执；
 *  3. 单次尝试的硬超时（悬挂的 refresh/verify 不得永久卡死单飞链）；
 *  4. seam 缺失的永久失败语义（WARN 一次、不重试）；
 *  5. dispose：取消在途超时与排期重试，且晚到的结算不得回调 onSettled；
 *  6. **权威判定规则本身**（sessionFactsConverged 纯函数）：子代理行与权威缺失行
 *     不作证、只有权威明确说「没在跑」才判未收敛（假升级＝reconnect 风暴，保守优先）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SessionFactReconciler,
  sessionFactsConverged,
  type SessionFactVerdict,
} from '../../src/shared/session-fact-reconcile.ts'

interface Scheduled { run: () => void; ms: number }

function harness(options: {
  refresh: () => Promise<unknown> | undefined
  verify?: () => Promise<SessionFactVerdict>
  scheduleImpl?: (run: () => void, ms: number) => unknown
  maxAttempts?: number
  retryMs?: number
  attemptTimeoutMs?: number
  verifyTimeoutMs?: number
}) {
  const warnings: string[] = []
  const scheduled: Scheduled[] = []
  const settled: number[] = []
  const cancelled: unknown[] = []
  const reconciler = new SessionFactReconciler({
    refresh: options.refresh,
    ...(options.verify === undefined ? {} : { verify: options.verify }),
    now: () => 1_000,
    warn: (message) => { warnings.push(message) },
    onSettled: () => { settled.push(1) },
    schedule: options.scheduleImpl ?? ((run, ms) => {
      const entry = { run, ms }
      scheduled.push(entry)
      return entry
    }),
    cancel: (handle) => { cancelled.push(handle) },
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.retryMs === undefined ? {} : { retryMs: options.retryMs }),
    ...(options.attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs: options.attemptTimeoutMs }),
    ...(options.verifyTimeoutMs === undefined ? {} : { verifyTimeoutMs: options.verifyTimeoutMs }),
  })
  return { reconciler, warnings, scheduled, settled, cancelled }
}

const tick = (): Promise<void> => new Promise(resolve => { setImmediate(resolve) })
const alwaysTrue = async (): Promise<SessionFactVerdict> => 'converged'

test('refresh 解决 + verify 为真才结算 ok:true（权威判定）', async () => {
  const h = harness({ refresh: () => Promise.resolve(undefined), verify: alwaysTrue })
  assert.equal(h.reconciler.snapshot(), undefined, '未请求前没有回执')
  h.reconciler.request()
  await tick()
  const snapshot = h.reconciler.snapshot()
  assert.deepEqual(snapshot, { requestedAt: 1_000, settledAt: 1_000, ok: true, attempts: 1, verdict: 'converged' })
  assert.deepEqual(h.settled, [1], '结算后回调一次（生产端据此 sync()）')
})

test('refresh 解决但权威正面证伪（stale）⇒ ok:false（官方「失败也 resolve」的回归锁）', async () => {
  const h = harness({
    refresh: () => Promise.resolve({ ok: false, error: { code: 'transport' } }),
    verify: async (): Promise<SessionFactVerdict> => 'stale',
    maxAttempts: 1,
  })
  h.reconciler.request()
  await tick()
  const snapshot = h.reconciler.snapshot()
  assert.equal(snapshot?.ok, false, '权威证伪必须记失败——否则 L2/L3 永不触发')
  assert.equal(snapshot?.verdict, 'stale')
  assert.equal(snapshot?.settledAt, 1_000)
})

test('辅助探针失败（unknown）⇒ 既非健康也不重试（不制造假升级）', async () => {
  const h = harness({
    refresh: () => Promise.resolve(undefined),
    verify: async (): Promise<SessionFactVerdict> => 'unknown',
  })
  h.reconciler.request()
  await tick()
  const snapshot = h.reconciler.snapshot()
  assert.equal(snapshot?.ok, false)
  assert.equal(snapshot?.verdict, 'unknown')
  assert.equal(snapshot?.attempts, 1, 'unknown 不重试（同一窗口再跑一遍只是重复两轮 refresh+探针）')
  assert.equal(h.scheduled.filter(entry => entry.ms === 1_500).length, 0)
})

test('refresh 快而 verify 慢：两个相位各有独立预算（慢宿主不得被误判为未收敛）', async () => {
  // refresh 立即返回；verify 花 30ms（> attemptTimeoutMs=20ms，< verifyTimeoutMs=100ms）。
  const h = harness({
    refresh: () => Promise.resolve(undefined),
    verify: async (): Promise<SessionFactVerdict> => {
      await new Promise(resolve => { setTimeout(resolve, 30) })
      return 'converged'
    },
    maxAttempts: 1,
    attemptTimeoutMs: 20,
    verifyTimeoutMs: 100,
  })
  h.reconciler.request()
  await new Promise(resolve => { setTimeout(resolve, 80) })
  const snapshot = h.reconciler.snapshot()
  assert.equal(snapshot?.ok, true, 'verify 相位必须有自己的预算（共用 20s 会把慢宿主判成失败）')
  assert.equal(snapshot?.verdict, 'converged')
})

test('verify 缺失或抛错 ⇒ ok:false（绝不把「没校验」当成功）', async () => {
  const missing = harness({ refresh: () => Promise.resolve(undefined), maxAttempts: 1 })
  missing.reconciler.request()
  await tick()
  assert.equal(missing.reconciler.snapshot()?.ok, false)
  const throwing = harness({
    refresh: () => Promise.resolve(undefined),
    verify: async (): Promise<SessionFactVerdict> => { throw new Error('probe down') },
    maxAttempts: 1,
  })
  throwing.reconciler.request()
  await tick()
  assert.equal(throwing.reconciler.snapshot()?.ok, false)
})

test('失败后按注入的调度重试，第二次（refresh+verify 都过）才 ok:true', async () => {
  let calls = 0
  const h = harness({
    refresh: () => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(undefined)
    },
    verify: alwaysTrue,
  })
  h.reconciler.request()
  await tick()
  const retry = h.scheduled.filter(entry => entry.ms === 1_500)
  assert.equal(retry.length, 1, '第一次失败后排一次重试（另有一个尝试超时定时器）')
  retry[0]!.run()
  await tick()
  const snapshot = h.reconciler.snapshot()
  assert.equal(snapshot?.ok, true)
  assert.equal(snapshot?.attempts, 2)
  assert.equal(h.warnings.length, 1, '每次失败各一行有界告警')
})

test('重试用尽 ⇒ ok:false（守卫据此升级 L2），且不再排期', async () => {
  const h = harness({ refresh: () => Promise.reject(new Error('dead')), verify: alwaysTrue, maxAttempts: 2 })
  h.reconciler.request()
  await tick()
  h.scheduled.filter(entry => entry.ms === 1_500)[0]!.run()
  await tick()
  const snapshot = h.reconciler.snapshot()
  assert.equal(snapshot?.ok, false)
  assert.equal(snapshot?.attempts, 2)
  assert.equal(h.scheduled.filter(entry => entry.ms === 1_500).length, 1, '只排一次重试')
})

test('单次尝试硬超时：悬挂的 refresh 按失败结算，链不被永久卡死', async () => {
  const h = harness({ refresh: () => new Promise(() => {}), verify: alwaysTrue, maxAttempts: 1, attemptTimeoutMs: 500 })
  h.reconciler.request()
  await tick()
  assert.equal(h.reconciler.snapshot()?.settledAt, undefined, '超时前仍在途')
  const timeout = h.scheduled.find(entry => entry.ms === 500)
  assert.notEqual(timeout, undefined, '尝试超时必须被排期')
  timeout!.run()
  await tick()
  assert.equal(h.reconciler.snapshot()?.ok, false)
  assert.equal(h.reconciler.snapshot()?.settledAt, 1_000)
})

test('refresh seam 缺失是永久失败：WARN 一次、不重试、回执 ok:false', async () => {
  const h = harness({ refresh: () => undefined, verify: alwaysTrue })
  h.reconciler.request()
  await tick()
  assert.equal(h.scheduled.length, 0)
  assert.equal(h.warnings.length, 1)
  assert.equal(h.reconciler.snapshot()?.ok, false)
  h.reconciler.request()
  await tick()
  assert.equal(h.warnings.length, 1, '同一 seam 缺失只告警一次')
  assert.equal(h.scheduled.length, 0)
})

test('单飞：在途期间的重复请求只推进 requestedAt，不叠加第二条链', async () => {
  let resolveFirst: ((value: unknown) => void) | undefined
  let calls = 0
  const h = harness({
    refresh: () => {
      calls += 1
      return new Promise((resolve) => { resolveFirst = resolve })
    },
    verify: alwaysTrue,
  })
  h.reconciler.request()
  h.reconciler.request()
  assert.equal(calls, 1, '只有一条在途链')
  resolveFirst?.(undefined)
  await tick()
  const snapshot = h.reconciler.snapshot()
  assert.equal(snapshot?.requestedAt, 1_000, 'requestedAt 取最后一次请求时刻')
  assert.equal(snapshot?.attempts, 1)
})

test('dispose：取消已排期的重试与在途超时，且晚到的结算不得回调 onSettled', async () => {
  let resolveLate: ((value: unknown) => void) | undefined
  const h = harness({
    refresh: () => new Promise((resolve) => { resolveLate = resolve }),
    verify: alwaysTrue,
  })
  h.reconciler.request()
  h.reconciler.dispose()
  assert.ok(h.cancelled.length >= 1, 'dispose 必须取消在途尝试的超时定时器')
  resolveLate?.(undefined)
  await tick()
  assert.deepEqual(h.settled, [], 'dispose 后结算不得再回调 onSettled')
})

test('nextSettledAt：冻结时钟下连续两次结算仍单调推进（水位比较不得吞掉后一次）', async () => {
  // 守卫只认「结算时刻严格大于上次消费水位」的回执；同一毫秒的第二次结算若不 +1，
  // 就会被当成旧回执丢弃（守卫永远看不到结论）。此前的用例只执行到这条路径，
  // 没有断言单调性（2026-12 独立复核）。
  const h = harness({ refresh: () => Promise.resolve(undefined), verify: alwaysTrue })
  h.reconciler.request()
  await tick()
  assert.equal(h.reconciler.snapshot()?.settledAt, 1_000, '冻结时钟下第一次结算取 now')
  h.reconciler.request()
  await tick()
  assert.equal(h.reconciler.snapshot()?.settledAt, 1_001,
    '同毫秒的第二次结算必须 +1，否则水位比较会吞掉它')
})

test('权威判定：官方与权威一致（都 running）⇒ 收敛（长工具/长推理不得升级）', () => {
  assert.equal(sessionFactsConverged(
    { a: { running: true }, b: { running: false } },
    [{ sessionId: 'a', running: true }, { sessionId: 'b', running: false }],
  ), true)
})

test('权威判定：官方位卡住而权威说已结束 ⇒ 未收敛（允许升级 L2/L3）', () => {
  assert.equal(sessionFactsConverged(
    { a: { running: true } },
    [{ sessionId: 'a', running: false }],
  ), false)
})

test('权威判定：子代理行不作证（权威快照刻意过滤它们 ⇒ 否则永远假升级）', () => {
  assert.equal(sessionFactsConverged(
    { child: { running: true, origin: 'subagent' } },
    [],
  ), true)
})

test('权威判定：权威快照里缺失的行不作证（已归档/被过滤/未知）', () => {
  assert.equal(sessionFactsConverged({ ghost: { running: true } }, []), true)
})

test('权威判定：官方空闲 ⇒ 收敛（无判定对象）', () => {
  assert.equal(sessionFactsConverged({ a: { running: false } }, []), true)
  assert.equal(sessionFactsConverged({}, [{ sessionId: 'a', running: false }]), true)
})

test('生产形状 deps（不注入 schedule/cancel）：成功结算不得被 attempt 超时定时器改写（二轮复核 critical 回归）', async () => {
  // 生产装配只传 refresh/verify/now/warn/onSettled。此前默认 schedule=setTimeout
  // 而 cancel 恒为 undefined ⇒ 超时定时器永不取消，在成功结算后开火把它改写成
  // ok:false（并再排一轮重试）：健康的通道上必然出现假失败回执 ⇒ 假 L2 + 假横幅。
  let refreshCalls = 0
  let settledCount = 0
  const reconciler = new SessionFactReconciler({
    refresh: () => { refreshCalls += 1; return Promise.resolve(undefined) },
    verify: async (): Promise<SessionFactVerdict> => 'converged',
    now: () => Date.now(),
    warn: () => undefined,
    onSettled: () => { settledCount += 1 },
    attemptTimeoutMs: 20,
    retryMs: 5,
  })
  reconciler.request()
  await new Promise(resolve => { setTimeout(resolve, 80) })
  const snapshot = reconciler.snapshot()
  assert.equal(snapshot?.ok, true, '真实定时器下终态必须是成功')
  assert.equal(snapshot?.settledAt !== undefined, true)
  assert.equal(settledCount, 1, 'onSettled 恰一次（超时定时器不得再触发结算）')
  assert.equal(refreshCalls, 1, '不得因假超时多跑一轮尝试')
  assert.equal(reconciler.snapshot()?.ok, true, '等待更久也不得翻转')
  reconciler.dispose()
})

test('dispose 后仍在飞的 refresh continuation 不得再武装 verify 相位或调用探针（teardown 无副作用）', async () => {
  let resolveLate: ((value: unknown) => void) | undefined
  let verifyCalls = 0
  const h = harness({
    refresh: () => new Promise((resolve) => { resolveLate = resolve }),
    verify: async (): Promise<SessionFactVerdict> => { verifyCalls += 1; return 'converged' },
  })
  h.reconciler.request()
  await tick()
  const scheduledBefore = [...h.scheduled]
  h.reconciler.dispose()
  resolveLate?.(undefined)
  await tick()
  assert.equal(verifyCalls, 0, 'dispose 之后不得再调用权威探针')
  assert.equal(h.scheduled.length, scheduledBefore.length, 'dispose 之后不得再排新的相位定时器')
  assert.deepEqual(h.settled, [], 'dispose 之后不得回调 onSettled')
})

test('verify 相位超时结算为 unknown（辅助探针不归还 ≠ 权威证伪）', async () => {
  const h = harness({
    refresh: () => Promise.resolve(undefined),
    verify: () => new Promise(() => {}),
    maxAttempts: 1,
    verifyTimeoutMs: 500,
  })
  h.reconciler.request()
  await tick()
  const verifyTimer = [...h.scheduled].reverse().find(entry => entry.ms === 500)
  assert.notEqual(verifyTimer, undefined, 'verify 相位必须有自己的定时器')
  verifyTimer!.run()
  await tick()
  const snapshot = h.reconciler.snapshot()
  assert.equal(snapshot?.ok, false)
  assert.equal(snapshot?.verdict, 'unknown',
    '探针超时与被守卫的 WS 通道无关 ⇒ unknown（不清等待、不立即升级）')
})

test('dispose 之后排期的重试不再执行', async () => {
  let calls = 0
  const h = harness({
    refresh: () => {
      calls += 1
      return Promise.reject(new Error('boom'))
    },
    verify: alwaysTrue,
  })
  h.reconciler.request()
  await tick()
  h.reconciler.dispose()
  h.scheduled.filter(entry => entry.ms === 1_500)[0]?.run()
  await tick()
  assert.equal(calls, 1)
})
