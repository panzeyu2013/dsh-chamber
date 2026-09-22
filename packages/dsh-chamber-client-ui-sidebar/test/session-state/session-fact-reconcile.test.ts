/**
 * 对账链契约（dsh-chamber-client-ui-sidebar/src/shared/session-fact-reconcile.ts）。
 * 锁以下契约：
 *  1. **权威判定**：官方 `refreshList()` 对拉取失败照常 resolve —— 「promise 解决」
 *     不算成功，只有 `verify`  seam 确认拿到权威结论才结算 ok:true（这是守卫允许
 *     升级 L2/L3 的唯一依据，）；
 *  2. 单飞（在途重复请求只推进 requestedAt）、有界重试、结算回执；
 *  3. 单次尝试的硬超时（悬挂的 refresh/verify 不得永久卡死单飞链）；
 *  4. seam 缺失的永久失败语义（WARN 一次、不重试）；
 *  5. dispose：取消在途超时与排期重试，且晚到的结算不得回调 onSettled；
 *  6. **权威判定规则本身**（纯函数）：`deniedRunningIds`（只有权威明确说「没在跑」才
 *     证伪）/ `hasReconcilableRunning`（tier-1.5）/ `uncoveredRunningIds` +

 *     `decideAfterFirstAuthorityRead`（**未覆盖的 running 行 = 无结论**，与 refresh 相位的
 *     成败无关——官方 refresh 的失败会 resolve，观察不到；五轮复核 HIGH）；
 *  7. **写回 seam**（）：只在 verify 判 stale 时
 *     调用；成功（自校验通过）⇒ 结算 ok:true + corrected:true（守卫不据此升级），
 *     失败/抛错/缺失 ⇒ 仍按 stale（允许升级）；converged/unknown 绝不写入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import {
  SessionFactReconciler,
  SESSION_FACT_RECONCILE_DEFAULTS,
  confirmDeniedRunningIds,
  decideAfterFirstAuthorityRead,
  deniedRunningIds,
  hasReconcilableRunning,
  uncoveredRunningIds,
  writeBackTargets,
  type SessionFactVerdict,
} from '../../src/shared/session-fact-reconcile.ts'

interface Scheduled { run: () => void; ms: number }

function harness(options: {
  refresh: () => Promise<unknown> | undefined
  verify?: () => Promise<SessionFactVerdict>
  correct?: () => Promise<boolean> | boolean
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
    ...(options.correct === undefined ? {} : { correct: options.correct }),
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
    // refresh 被拒也进权威相位（）：用权威「证伪且无法写回」制造一次
    // 可重试失败，第二次权威确认才收敛。
    verify: async (): Promise<SessionFactVerdict> => (calls === 1 ? 'stale' : 'converged'),
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
  // refresh 恒被拒（走权威相位），权威恒证伪且无写回 seam ⇒ 每次都按可重试失败结算。
  const h = harness({
    refresh: () => Promise.reject(new Error('dead')),
    verify: async (): Promise<SessionFactVerdict> => 'stale',
    maxAttempts: 2,
  })
  h.reconciler.request()
  await tick()
  h.scheduled.filter(entry => entry.ms === 1_500)[0]!.run()
  await tick()
  const snapshot = h.reconciler.snapshot()
  assert.equal(snapshot?.ok, false)
  assert.equal(snapshot?.attempts, 2)
  assert.equal(h.scheduled.filter(entry => entry.ms === 1_500).length, 1, '只排一次重试')
})

test('悬挂的 refresh 不卡死链：先进权威相位；探针无结论才按 unknown 结算', async () => {
  const h = harness({
    refresh: () => new Promise(() => {}),
    verify: async (): Promise<SessionFactVerdict> => 'unknown',
    maxAttempts: 1,
    attemptTimeoutMs: 500,
  })
  h.reconciler.request()
  await tick()
  assert.equal(h.reconciler.snapshot()?.settledAt, undefined, '超时前仍在途')
  const refreshTimeout = h.scheduled.find(entry => entry.ms === 500)
  assert.notEqual(refreshTimeout, undefined, 'refresh 相位超时必须被排期')
  refreshTimeout!.run()
  assert.equal(h.reconciler.snapshot()?.settledAt, undefined,
    'refresh 超时不得直接结算 —— 权威相位（另一条载体）已经接手')
  assert.notEqual(
    [...h.scheduled].reverse().find(entry => entry.ms === SESSION_FACT_RECONCILE_DEFAULTS.verifyTimeoutMs),
    undefined,
    '权威相位必须重新武装自己的预算（悬挂探针由它收口）',
  )
  await tick()
  const snapshot = h.reconciler.snapshot()
  assert.equal(snapshot?.ok, false)
  assert.equal(snapshot?.verdict, 'unknown', '探针无结论 ⇒ unknown（不升级、不清等待）')
  assert.equal(snapshot?.settledAt, 1_000)
  assert.ok(
    h.warnings.some(message => message.includes('refresh phase timed out')),
    '不收敛时 refresh 失败必须并入回执错误文本（诊断不看 console 也能定位）',
  )
})

test('单飞悬挂（refresh 永不结算）下写回仍可达：权威证伪并纠正 ⇒ converged + corrected', async () => {
  // 而 design 14 声称「单飞悬挂时写回仍能纠正事实」。本测试把该断言钉死。
  let corrected = 0
  const h = harness({
    refresh: () => new Promise(() => {}),
    verify: async (): Promise<SessionFactVerdict> => 'stale',
    correct: () => { corrected += 1; return true },
    maxAttempts: 1,
    attemptTimeoutMs: 500,
    verifyTimeoutMs: 700,
  })
  h.reconciler.request()
  await tick()
  h.scheduled.find(entry => entry.ms === 500)!.run()
  await tick()
  const snapshot = h.reconciler.snapshot()
  assert.equal(snapshot?.ok, true, 'refresh 悬挂不得阻止权威相位给出结论')
  assert.equal(snapshot?.verdict, 'converged')
  assert.equal(snapshot?.corrected, true)
  assert.equal(corrected, 1)
})

test('refresh 被拒（非 carrier 折叠的异常）仍进权威相位：写回成功即 converged + corrected', async () => {
  const h = harness({
    refresh: () => Promise.reject(new Error('boom')),
    verify: async (): Promise<SessionFactVerdict> => 'stale',
    correct: () => true,
    maxAttempts: 1,
  })
  h.reconciler.request()
  await tick()
  const snapshot = h.reconciler.snapshot()
  assert.equal(snapshot?.ok, true, '另一条载体能裁决时，refresh 异常不应把事实判成「拿不到结论」')
  assert.equal(snapshot?.verdict, 'converged')
  assert.equal(snapshot?.corrected, true)
  assert.equal(snapshot?.attempts, 1, '不得因此排重试')
  assert.equal(
    h.warnings.filter(message => message.includes('authority phase')).length,
    1,
    'refresh 已坏而权威相位仍收敛时必须留一行有界告警（静默降级会掩盖持续损坏的官方通道）',
  )
})

test('refresh 在权威相位在飞时结算/被拒，不得并发开第二轮（authorityStarted 栅栏）', async () => {
  let verifyCalls = 0
  let correctCalls = 0
  let rejectRefresh: ((error: Error) => void) | undefined
  let settleVerify: ((verdict: SessionFactVerdict) => void) | undefined
  const h = harness({
    refresh: () => new Promise<never>((_, reject) => { rejectRefresh = reject }),
    // 第一次权威相位悬挂在 verify 上（在飞），此时 refresh 才被拒 —— 没有栅栏就会并发开。
    verify: (): Promise<SessionFactVerdict> => {
      verifyCalls += 1
      return new Promise<SessionFactVerdict>(resolve => { settleVerify = resolve })
    },
    correct: () => { correctCalls += 1; return true },
    maxAttempts: 1,
    attemptTimeoutMs: 500,
    verifyTimeoutMs: 700,
  })
  h.reconciler.request()
  await tick()
  h.scheduled.find(entry => entry.ms === 500)!.run()
  await tick()
  assert.equal(verifyCalls, 1, 'refresh 相位超时应进入权威相位')
  rejectRefresh!(new Error('late rejection'))
  await tick()
  assert.equal(verifyCalls, 1, '在飞的权威相位不得被晚到的 refresh 结算再开一轮')
  settleVerify!('stale')
  await tick()
  assert.equal(correctCalls, 1, '写回只跑一次')
  const snapshot = h.reconciler.snapshot()
  assert.equal(snapshot?.ok, true)
  assert.equal(snapshot?.corrected, true)
})


test('相位计时器结算后，晚到的 stale 不得再触发写回（attemptSettled 栅栏）', async () => {
  let correctCalls = 0
  let settleVerify: ((verdict: SessionFactVerdict) => void) | undefined
  const h = harness({
    refresh: () => Promise.resolve(undefined),
    verify: () => new Promise<SessionFactVerdict>(resolve => { settleVerify = resolve }),
    correct: () => { correctCalls += 1; return true },
    maxAttempts: 1,
    verifyTimeoutMs: 700,
  })
  h.reconciler.request()
  await tick()
  assert.notEqual(settleVerify, undefined, '权威相位应已武装探针')
  const verifyTimer = h.scheduled.find(entry => entry.ms === 700)
  assert.notEqual(verifyTimer, undefined, 'verify 相位预算必须被排期')
  verifyTimer!.run()
  await tick()
  assert.equal(h.reconciler.snapshot()?.verdict, 'unknown', '超时按 unknown 结算')
  settleVerify!('stale')
  await tick()
  await tick()
  assert.equal(correctCalls, 0, '回执已发布后不得再写回官方 store（2026-12 五轮复核）')
  assert.equal(h.reconciler.snapshot()?.verdict, 'unknown', '回执不得被晚到的探针结论改写')
})

test('dispose 在权威相位在飞时：不写回、不结算、不回调', async () => {
  let correctCalls = 0
  let settleVerify: ((verdict: SessionFactVerdict) => void) | undefined
  const h = harness({
    refresh: () => Promise.resolve(undefined),
    verify: () => new Promise<SessionFactVerdict>(resolve => { settleVerify = resolve }),
    correct: () => { correctCalls += 1; return true },
    maxAttempts: 1,
  })
  h.reconciler.request()
  await tick()
  h.reconciler.dispose()
  settleVerify!('stale')
  await tick()
  await tick()
  assert.equal(correctCalls, 0, 'teardown 后不得有副作用（写回会改官方 store）')
  assert.equal(h.settled.length, 0, 'teardown 后不得回调 onSettled')
})

test('decideAfterFirstAuthorityRead：正面证伪走 N=2；「权威沉默」无条件不算健康', () => {
  assert.equal(
    decideAfterFirstAuthorityRead({ denied: new Set(['x']), uncovered: new Set() }),
    'needs-second-probe',
    '正面证伪必须第二读确认（N=2）才允许写回/升级',
  )
  assert.equal(
    decideAfterFirstAuthorityRead({ denied: new Set(['x']), uncovered: new Set(['x']) }),
    'needs-second-probe',
    '有证伪时优先走 N=2',
  )
  // ）：官方 refresh 的**主流**失败形态是 resolve 成 ok:false，
  // 「refresh 是否失败」在 reconciliation 侧不可观察 ⇒ 未覆盖必须**无条件**判无结论，
  // 否则「官方对账没落地 + 权威缺席行」会被回执成 ok:true、升级阶梯被永久关掉。
  assert.equal(
    decideAfterFirstAuthorityRead({ denied: new Set(), uncovered: new Set(['ghost']) }),
    'unknown',
    '权威对我们的 running 行沉默 ⇒ 无结论（与 refresh 相位成败无关）',
  )
  assert.equal(
    decideAfterFirstAuthorityRead({ denied: new Set(), uncovered: new Set() }),
    'converged',
    '每个 running 行都被权威读覆盖且无证伪 ⇒ 健康',
  )
})

test('uncoveredRunningIds：store 说 running 而权威读没有该 id ⇒ 沉默（不是正面覆盖）', () => {
  const official = {
    covered: { running: true },
    missing: { running: true },
    sub: { running: true, origin: 'subagent' },
    idle: { running: false },
  }
  assert.deepEqual(
    [...uncoveredRunningIds(official, [{ sessionId: 'covered', running: true }])],
    ['missing'],
    '子代理行与非 running 行不算；被覆盖的 id 不算',
  )
  assert.equal(
    uncoveredRunningIds({ a: { running: true } }, [{ sessionId: 'a', running: false }]).size,
    0,
    '被权威读覆盖（哪怕说没在跑）不是沉默 —— 那是「正面证伪」的输入',
  )
  assert.equal(uncoveredRunningIds({ a: { running: true } }, []).size, 1, '空权威读 ⇒ 全部沉默')
})

// ---- 判定纯函数的行为锁（
//      「N=2 退化成 1 次」「写回范围错成全部 running 行」这类语义回退抓不到）----

test('hasReconcilableRunning：只有非子代理的 running 行才需要对账（tier-1.5 省一次 host 读）', () => {
  assert.equal(hasReconcilableRunning({}), false)
  assert.equal(hasReconcilableRunning({ a: { running: false } }), false)
  assert.equal(hasReconcilableRunning({ a: { running: true, origin: 'subagent' } }), false,
    '子代理行由父 turn 的 running 门代表，单独作证会造成假对账')
  assert.equal(hasReconcilableRunning({ a: { running: true }, b: { running: true, origin: 'subagent' } }), true)
})

test('confirmDeniedRunningIds：只有两次独立读数都证伪的 id 才算确认（N=2）', () => {
  const confirmed = confirmDeniedRunningIds(new Set(['a', 'b']), new Set(['b', 'c']))
  assert.deepEqual([...confirmed], ['b'], '单次读数不得写回/升级（一次不完整列表即假证伪）')
  assert.equal(confirmDeniedRunningIds(new Set(['a']), new Set(['b'])).size, 0,
    '不一致 ⇒ 空集（调用方按 unknown 结算，不写回、不升级）')
  assert.equal(confirmDeniedRunningIds(new Set(), new Set(['a'])).size, 0)
})

test('writeBackTargets：写回范围 = 已确认证伪 ∩ 此刻仍 claiming running（幂等、最小写面）', () => {
  const targets = writeBackTargets(new Set(['stuck', 'natural', 'gone']), {
    stuck: { running: true },
    natural: { running: false },
  })
  assert.deepEqual(targets, ['stuck'],
    '自然收敛的 id 不动；store 里已消失的 id 不动；绝不扩大到其他 running 行')
  assert.deepEqual(writeBackTargets(new Set(['stuck']), { other: { running: true } }), [],
    '写回只针对已确认证伪的 id —— 别的 running 行哪怕在 store 里也不许被写成 false')
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
  // 没有断言单调性（）。
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
  const official = { a: { running: true }, b: { running: false } }
  const rows = [{ sessionId: 'a', running: true }, { sessionId: 'b', running: false }]
  assert.equal(deniedRunningIds(official, rows).size, 0, '无正面证伪')
  assert.equal(uncoveredRunningIds(official, rows).size, 0, '每个 running 行都被权威覆盖')
  assert.equal(decideAfterFirstAuthorityRead({
    denied: deniedRunningIds(official, rows),
    uncovered: uncoveredRunningIds(official, rows),
  }), 'converged')
})

test('权威判定：官方位卡住而权威说已结束 ⇒ 正面证伪（允许写回/升级 L2/L3）', () => {
  const official = { a: { running: true } }
  const rows = [{ sessionId: 'a', running: false }]
  assert.deepEqual([...deniedRunningIds(official, rows)], ['a'])
  assert.equal(uncoveredRunningIds(official, rows).size, 0, '被覆盖（哪怕说没在跑）不算沉默')
  assert.equal(decideAfterFirstAuthorityRead({
    denied: deniedRunningIds(official, rows),
    uncovered: uncoveredRunningIds(official, rows),
  }), 'needs-second-probe', '必须第二读确认（N=2）')
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

// ---- tier-3 写回（）----

test('写回 seam：权威正面证伪而契约内纠正不了 ⇒ 写回成功按 converged 结算（corrected 标记）', async () => {
  let written = 0
  const h = harness({
    refresh: () => Promise.resolve(undefined),
    verify: async (): Promise<SessionFactVerdict> => 'stale',
    correct: () => { written += 1; return true },
    maxAttempts: 1,
  })
  h.reconciler.request()
  await tick()
  const snapshot = h.reconciler.snapshot()
  assert.equal(snapshot?.ok, true, '写回成功 = 拿到了权威结论（守卫不得据此升级）')
  assert.equal(snapshot?.verdict, 'converged')
  assert.equal(snapshot?.corrected, true, '回执必须标明本次结论由写回达成')
  assert.equal(snapshot?.attempts, 1, '写回成功即收工，不再重试')
  assert.deepEqual(h.settled, [1], '结算回调照常一次（生产端据此重发事实）')
  assert.equal(written, 1)
})

test('写回失败或抛错 ⇒ 仍按 stale 结算（绝不把没纠正记成健康）', async () => {
  const refused = harness({
    refresh: () => Promise.resolve(undefined),
    verify: async (): Promise<SessionFactVerdict> => 'stale',
    correct: () => false,
    maxAttempts: 1,
  })
  refused.reconciler.request()
  await tick()
  assert.equal(refused.reconciler.snapshot()?.ok, false)
  assert.equal(refused.reconciler.snapshot()?.verdict, 'stale')
  assert.equal(refused.reconciler.snapshot()?.corrected, undefined)

  const threw = harness({
    refresh: () => Promise.resolve(undefined),
    verify: async (): Promise<SessionFactVerdict> => 'stale',
    correct: () => { throw new Error('store refused the write-back') },
    maxAttempts: 1,
  })
  threw.reconciler.request()
  await tick()
  assert.equal(threw.reconciler.snapshot()?.ok, false)
  assert.equal(threw.reconciler.snapshot()?.verdict, 'stale')
  assert.equal(
    threw.warnings.filter(message => message.includes('write-back')).length,
    1,
    '写回失败必须留一行有界告警（绝不静默）',
  )
})

test('写回 seam 只在 stale 时调用：converged / unknown 一律不得写入官方 store', async () => {
  let written = 0
  const converged = harness({
    refresh: () => Promise.resolve(undefined),
    verify: async (): Promise<SessionFactVerdict> => 'converged',
    correct: () => { written += 1; return true },
  })
  converged.reconciler.request()
  await tick()
  const unknown = harness({
    refresh: () => Promise.resolve(undefined),
    verify: async (): Promise<SessionFactVerdict> => 'unknown',
    correct: () => { written += 1; return true },
  })
  unknown.reconciler.request()
  await tick()
  assert.equal(written, 0, '只有权威正面证伪（stale）才允许写回')
})

test('正面证伪集：只有权威显式 false 且非子代理的官方 running 行入集', () => {
  const denied = deniedRunningIds(
    {
      a: { running: true },
      b: { running: true, origin: 'subagent' },
      c: { running: true },
      ghost: { running: true },
      idle: { running: false },
    },
    [
      { sessionId: 'a', running: false },
      { sessionId: 'b', running: false },
      { sessionId: 'c', running: true },
      { sessionId: 'idle', running: false },
    ],
  )
  assert.deepEqual([...denied], ['a'], '子代理/权威说 running/官方空闲都不入集')
  assert.equal(deniedRunningIds({ a: { running: true } }, []).size, 0, '权威缺失不作证')
  assert.equal(
    deniedRunningIds({ a: { running: false } }, [{ sessionId: 'a', running: false }]).size,
    0,
    '官方空闲不是证伪',
  )
})

// 生产接线锁（原 session-fact-reconcile-wiring.test.ts 的唯一 fail-closed 部分）：写回
// 只允许把 running 压成 false，且相位结算后的晚到结果不得再改官方 store。
test('生产接线：producer 接上 correct，写回只写 false，相位栅栏在结算与写回之前', () => {
  const plugin = stripComments(readFileSync(
    fileURLToPath(new URL('../../src/client/index.ts', import.meta.url)), 'utf8'))
  assert.match(plugin, /correct: writeBackDeniedRunning,/, 'producer 必须把 correct 接进对账链')
  assert.match(plugin, /service\.handleSessionStatus\(id, false\)/)
  assert.doesNotMatch(plugin, /handleSessionStatus\([^)]*true[^)]*\)/,
    '权威证伪只允许把 running 压成 false；写 true 会伪造「在跑」')
  assert.match(plugin, /typeof service\.handleSessionStatus !== 'function'/, '写回前必须有方法面能力守卫')
  const reconcile = stripComments(readFileSync(
    fileURLToPath(new URL('../../src/shared/session-fact-reconcile.ts', import.meta.url)), 'utf8'))
  const fenceAt = reconcile.indexOf('if (this.disposed || attemptSettled) return')
  //  the verdict branches moved into the package (decideAfterAuthorityProbe), so the
  // decision no longer has an inline `if (verdict === 'converged')` to anchor on. The
  // INVARIANT is unchanged - the fence must still precede the settle/write-back decision -
  // so the anchor is now the call that makes that decision.
  const decisionAt = reconcile.indexOf('decideAfterAuthorityProbe(verdict,')
  assert.ok(fenceAt >= 0 && decisionAt > fenceAt,
    'attemptSettled/disposed 栅栏必须排在收敛结算与写回之前，否则晚到的 verify 会改官方 store')
})

// 生产接线锁（原 session-fact-reconcile-wiring.test.ts，）：行为已由
// 纯函数单测覆盖，这里补回「生产真的调了它」的源码栅栏。
test('round-3 restore: tier-1.5 gate, N=2 intersection and the write-back self-check are wired', () => {
  const plugin = stripComments(readFileSync(
    fileURLToPath(new URL('../../src/client/index.ts', import.meta.url)), 'utf8'))
  assert.match(plugin, /if \(!hasReconcilableRunning\(readStoreRunning\(\)\)\) return 'converged'/,
    'no reconcilable running row converges without paying a host read')
  assert.match(plugin, /const first = await probeDeniedRunning\(\)/)
  assert.match(plugin, /const second = await probeDeniedRunning\(\)/)
  assert.match(plugin, /const confirmed = confirmDeniedRunningIds\(first\.denied, second\.denied\)/,
    'only the intersection of two independent reads may write back or upgrade')
  assert.match(plugin, /if \(confirmed\.size === 0\) return 'unknown'/)
  assert.match(plugin, /await new Promise\(resolve => \{ setTimeout\(resolve, 0\) \}\)/, 'the self-check waits one macrotask')
  assert.match(plugin, /if \(targets\.every\(id => after\[id\]\?\.running !== true\)\) return true/,
    'the self-check compares the write targets, not "no running row anywhere"')
  assert.match(plugin, /for \(let attempt = 0; attempt < 2; attempt \+= 1\) \{/, 'one retry when the projection lags a tick')
  assert.match(plugin, /let verifySeq = 0/, 'the denied set carries a verify round sequence')
  assert.match(plugin, /if \(denied\.seq !== verifySeq\) return false/, 'only the current verify round may write back')
  assert.match(plugin, /const targets = writeBackTargets\(denied\.ids, readStoreRunning\(\)\)/)
  assert.match(plugin, /if \(targets\.length === 0\) return true/, 'a naturally converged round is not an upgrade')
  assert.ok(
    plugin.indexOf('writeBackTargets(denied.ids') < plugin.indexOf("typeof service.handleSessionStatus !== 'function'"),
    'the target decision must precede the capability guard, or a build without the method misjudges convergence',
  )
})
