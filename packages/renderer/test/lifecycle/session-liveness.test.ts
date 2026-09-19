/**
 * 运行位活性守卫的决策契约（renderer/src/session-liveness.ts）。
 *
 * 2026-12 独立复核后重写：除了原有的门槛/限频/升级依据，另外锁住复核抓出的
 * 四类缺陷——① 配额只按整个 running 时段总量封顶会让长任务后段失明；
 * ② 上一时段的失败回执污染新时段（无依据升级）；③ 重连后的健康回执把 L3
 * 永久 latch 关；④ L2 未拿到真实返回值就消耗预算。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SESSION_LIVENESS_DEFAULTS,
  createSessionLivenessState,
  markSessionLivenessReconnect,
  markSessionLivenessReconnectNoop,
  planSessionLiveness,
  type SessionFactReconcileFacts,
  type SessionLivenessConfig,
  type SessionLivenessState,
} from '../../src/session-liveness.ts'

const CONFIG: SessionLivenessConfig = {
  ...SESSION_LIVENESS_DEFAULTS,
  refreshAfterMs: 1_000,
  refreshCoalesceMs: 500,
  maxRefreshRequests: 2,
  refreshWindowMs: 3_000,
  refreshOutcomeTimeoutMs: 5_000,
  reconnectBackoffMs: 100,
  maxReconnects: 1,
  noticeAfterMs: 200,
}

type Reconcile = SessionFactReconcileFacts

interface Harness {
  state: SessionLivenessState
  at(now: number, sessions?: Record<string, { running?: boolean }>, reconcile?: Reconcile, generation?: string, reconnectBlocked?: boolean): ReturnType<typeof planSessionLiveness>
  mark(now: number): void
  markNoop(): void
}

function harness(overrides: Partial<SessionLivenessConfig> = {}): Harness {
  const config: SessionLivenessConfig = { ...CONFIG, ...overrides }
  let state = createSessionLivenessState()
  return {
    get state() { return state },
    at(now, sessions = { a: { running: true } }, reconcile, generation, reconnectBlocked = false) {
      const plan = planSessionLiveness(state, {
        now,
        sources: {
          local: {
            sessions,
            ...(generation === undefined ? {} : { generation }),
            ...(reconcile === undefined ? {} : { reconcile }),
            ...(reconnectBlocked ? { reconnectBlocked: true } : {}),
          },
        },
      }, config)
      state = plan.state
      return plan
    },
    mark(now) { state = markSessionLivenessReconnect(state, 'local', now) },
    markNoop() { state = markSessionLivenessReconnectNoop(state, 'local') },
  }
}

test('没有 running 会话时不产生任何动作，状态保持空', () => {
  const h = harness()
  const plan = h.at(10_000, { a: { running: false } })
  assert.deepEqual(plan.actions, [])
  assert.deepEqual(plan.stalled, [])
  assert.deepEqual(plan.state.records, {})
})

test('running 未达门槛不动作；达门槛后请求一次 L1，并按 coalesce 限频', () => {
  const h = harness()
  assert.deepEqual(h.at(0).actions, [])
  assert.deepEqual(h.at(999).actions, [])
  assert.deepEqual(h.at(1_000).actions, [{ kind: 'refresh', sourceId: 'local' }])
  assert.deepEqual(h.at(1_200).actions, [], 'coalesce 窗口内不重复请求')
  assert.deepEqual(h.at(1_500).actions, [{ kind: 'refresh', sourceId: 'local' }])
})

test('配额是滚动窗口：长任务后段仍然会被探测（复核缺陷 ① 的回归锁）', () => {
  const h = harness()
  const kinds = (now: number) => h.at(now).actions.map(action => action.kind)
  assert.deepEqual(kinds(0), [], '时段起点只建记录')
  assert.deepEqual(kinds(1_000), ['refresh'])
  assert.deepEqual(kinds(1_500), ['refresh'])
  assert.deepEqual(kinds(2_000), [], '窗口内配额（2 次）用尽 ⇒ 本窗口不再发')
  assert.deepEqual(kinds(4_600), ['refresh'], '窗口滑过之后必须重新武装——否则第 4 分钟起永久失明')
  assert.deepEqual(kinds(5_100), ['refresh'])
  assert.deepEqual(kinds(5_600), [], '新窗口内配额再次用尽')
})

test('健康回执即使在长时间 running 下也不升级 reconnect（核心取舍）', () => {
  const h = harness()
  assert.deepEqual(h.at(0).actions, [])
  assert.deepEqual(h.at(1_000).actions, [{ kind: 'refresh', sourceId: 'local' }])
  const healthy = (settledAt: number): Reconcile => ({ requestedAt: settledAt, settledAt, ok: true, attempts: 1 })
  assert.deepEqual(h.at(1_050, { a: { running: true } }, healthy(1_050)).actions, [])
  for (const now of [2_000, 9_000, 60_000]) {
    const plan = h.at(now, { a: { running: true } }, healthy(now))
    assert.ok(!plan.actions.some(action => action.kind === 'reconnect' || action.kind === 'notice'),
      `健康回执下不得升级（t=${String(now)}）`)
  }
  assert.equal(h.state.records.local?.reconnectCount, 0)
})

test('失败回执 ⇒ 派发一次 L2；预算在真实执行（mark）之后才记账', () => {
  const h = harness()
  h.at(1_000)
  const failed: Reconcile = { requestedAt: 1_000, settledAt: 1_400, ok: false, attempts: 2 }
  assert.deepEqual(h.at(1_400, { a: { running: true } }, failed).actions, [{ kind: 'reconnect', sourceId: 'local' }])
  assert.equal(h.state.records.local?.reconnectCount, 0, 'no-op reconnect 不得消耗预算（复核缺陷 ④）')
  assert.deepEqual(h.at(1_450, { a: { running: true } }, failed).actions, [], '退避窗口内不重复派发')
  // 重连真实执行：预算兑现，此后再无健康回执 ⇒ 亮 L3。
  h.mark(1_450)
  assert.equal(h.state.records.local?.reconnectCount, 1)
  // 重连**之后**的新失败证据（settledAt 1_600 > lastReconnectAt 1_450）：重连前的
  // sticky 失败不算数（否则重连后一个宽限期就亮 30s 假横幅——三轮复核的 flash 复现）。
  const post = { requestedAt: 1_500, settledAt: 1_600, ok: false, attempts: 2 }
  // 1_700 这一 tick 才观测到「预算已用尽」⇒ ladderAnchorAt=1_700，宽限 200ms 后亮。
  assert.deepEqual(h.at(1_700, { a: { running: true } }, post).stalled, [], '宽限内不亮')
  const notice = h.at(1_900, { a: { running: true } }, post)
  assert.ok(notice.actions.some(action => action.kind === 'notice'), '重连后的新失败证据 + 宽限 ⇒ 亮')
  assert.deepEqual(notice.stalled, ['local'])
  // 重连前的 sticky 失败不再算证据：即使把 lastOutcomeOk 留在 false，也不凭它上膛。
  assert.deepEqual(h.state.records.local?.lastOutcomeOk, false)
})

test('L2 杠杆长期 no-op 时 L3 仍有第二条出口（否则用户永远看不到提示）', () => {
  const h = harness({ refreshOutcomeTimeoutMs: 400, maxNoopReconnects: 2 })
  h.at(0, { a: { running: true } })
  h.at(1_000)
  const failed: Reconcile = { requestedAt: 1_000, settledAt: 1_400, ok: false, attempts: 2 }
  // 两次派遣都是 no-op（App 侧 reconnectInstanceConnection 返回 false ⇒ 不 mark）。
  assert.deepEqual(h.at(1_400, { a: { running: true } }, failed).actions, [{ kind: 'reconnect', sourceId: 'local' }])
  h.markNoop()
  assert.equal(h.state.records.local?.reconnectCount, 0, 'no-op 不消耗真实预算')
  const dispatched = h.at(2_000, { a: { running: true } }, failed)
  assert.deepEqual(dispatched.actions, [{ kind: 'reconnect', sourceId: 'local' }], '退避后再次派遣')
  h.markNoop()
  // 连续 no-op 达到门槛 + 未收敛证据 ⇒ 梯子到顶的那一 tick 起算宽限，之后必须上膛
  // （此前这条路径完全不亮；且反复 no-op 派遣不得把锚点一直向前推）。
  assert.deepEqual(h.at(2_300, { a: { running: true } }, failed).stalled, [], '锚点起算 tick')
  assert.deepEqual(h.at(2_500, { a: { running: true } }, failed).stalled, ['local'])
  assert.deepEqual(h.at(2_900, { a: { running: true } }, failed).stalled, ['local'], '后续 no-op 派遣不得把横幅推没')
})

test('L3 提示可被后续健康回执撤下，之后再次静默仍能重新武装（复核缺陷 ③）', () => {
  const h = harness()
  h.at(1_000)
  const failed: Reconcile = { requestedAt: 1_000, settledAt: 1_400, ok: false, attempts: 2 }
  h.at(1_400, { a: { running: true } }, failed)
  h.mark(1_400)
  // 重连后的失败证据（settledAt 1_600 > lastReconnectAt 1_400）才作数。
  const post = { requestedAt: 1_500, settledAt: 1_600, ok: false, attempts: 2 }
  assert.deepEqual(h.at(1_700, { a: { running: true } }, post).stalled, [], '梯子到顶 tick')
  assert.deepEqual(h.at(1_900, { a: { running: true } }, post).stalled, ['local'])
  const recovered = h.at(1_950, { a: { running: true } }, { requestedAt: 1_700, settledAt: 1_950, ok: true, attempts: 1 })
  assert.deepEqual(recovered.stalled, [], '拿到健康结论即撤下横幅')
  assert.ok(!recovered.actions.some(action => action.kind === 'notice'))
})

test('unknown 回执既不健康也不升级；升级只能发生在 unknown 之后的下一次 L1 之后（有界）', () => {
  const h = harness({ refreshAfterMs: 1_000, refreshCoalesceMs: 500, refreshOutcomeTimeoutMs: 400 })
  const unknown: Reconcile = { requestedAt: 1_000, settledAt: 1_050, ok: false, attempts: 1, verdict: 'unknown' }
  h.at(0, { a: { running: true } })
  h.at(1_000) // L1 #1
  // 探针失败的当轮：不得升级（另一条载体的抖动不证明被守卫的 WS 通道坏）。
  assert.deepEqual(h.at(1_050, { a: { running: true } }, unknown).actions, [])
  assert.deepEqual(h.at(1_050, { a: { running: true } }, unknown).stalled, [])
  // 原期限（1_000 + 400）到点也绝不升级：被吸收的 unknown 之后**还没发过 L1** ⇒ 期限不
  // 生效（否则快 unknown 必然制造假 L2，2026-12 二轮独立复核的时间线仿真）。
  assert.deepEqual(h.at(1_450, { a: { running: true } }, unknown).actions, [], '未发下一次 L1 前绝不升级')
  // coalesce 到点 → L1 #2；自此期限从这次 L1 起算。
  assert.deepEqual(h.at(1_500, { a: { running: true } }, unknown).actions,
    [{ kind: 'refresh', sourceId: 'local' }])
  // 第二次 unknown 不再吸收（但这次 L1 的期限仍然生效）：持续无结论会被收口，有界。
  const unknown2: Reconcile = { requestedAt: 1_500, settledAt: 1_510, ok: false, attempts: 1, verdict: 'unknown' }
  h.at(1_510, { a: { running: true } }, unknown2)
  assert.deepEqual(h.at(1_900, { a: { running: true } }, unknown2).actions, [], '期限未到')
  assert.deepEqual(h.at(1_901, { a: { running: true } }, unknown2).actions,
    [{ kind: 'reconnect', sourceId: 'local' }])
})

test('快 unknown（L1 后立刻结算）不吞掉唯一预算：下一次 L1 的健康结论先到就不重连', () => {
  // 生产关系（coalesce 200s > 期限 190s）+ 快探针失败（502/代理重启会在一个 tick 内
  // 结算 unknown）。旧的"从 unknown 时刻顺延"仍让期限抢在下一次 L1 之前到点 ⇒ 假 L2
  // （2026-12 二轮独立复核实测：L1#1@120s → L2@330s → L1#2@360s）。
  const h = harness({ refreshAfterMs: 1_000, refreshCoalesceMs: 200, refreshOutcomeTimeoutMs: 150 })
  h.at(0, { a: { running: true } })
  h.at(1_000) // L1 #1
  const unknown: Reconcile = { requestedAt: 1_000, settledAt: 1_010, ok: false, attempts: 1, verdict: 'unknown' }
  assert.deepEqual(h.at(1_010, { a: { running: true } }, unknown).actions, [], 'unknown 当场不升级')
  // 原期限（1_150）早已过去，但还没有 unknown 之后的 L1 ⇒ 绝不重连（假 L2 就发生在这里）。
  assert.deepEqual(h.at(1_160, { a: { running: true } }, unknown).actions, [], '不许抢在下一次 L1 前面')
  // coalesce 到点先发 L1 #2，随后拿到健康结论 ⇒ 全程零重连（唯一预算不被虚耗）。
  assert.deepEqual(h.at(1_200, { a: { running: true } }, unknown).actions,
    [{ kind: 'refresh', sourceId: 'local' }])
  const healthy: Reconcile = { requestedAt: 1_200, settledAt: 1_250, ok: true, attempts: 1, verdict: 'converged' }
  h.at(1_260, { a: { running: true } }, healthy)
  assert.deepEqual(h.at(1_400, { a: { running: true } }, healthy).actions, [], '健康结论之后不得重连')
})

test('重连之后的 unknown 不得复活重连前的失败证据（假 L3 的整类形态）', () => {
  // 2026-12 三轮独立复核：unknown 会被计入「已消费回执」水位，而 lastOutcomeOk=false
  // 是刻意跨重连保留的；拿 outcomeSeenAt 当失败证据的时钟 ⇒ 重连前那次失败 + 重连后
  // 一次**没有结论**的探针 = 看起来"重连之后仍然失败" ⇒ 假横幅（复现时间线：
  // L1@1000 → stale@1005 → L2@1005 → L1@1100 → unknown@1200 → 假 notice@1310）。
  const h = harness({ refreshAfterMs: 1_000, refreshCoalesceMs: 500, refreshOutcomeTimeoutMs: 400 })
  h.at(0, { a: { running: true } })
  h.at(1_000) // L1 #1
  const stale: Reconcile = { requestedAt: 1_000, settledAt: 1_005, ok: false, attempts: 1, verdict: 'stale' }
  assert.deepEqual(h.at(1_005, { a: { running: true } }, stale).actions,
    [{ kind: 'reconnect', sourceId: 'local' }], '真实失败证据触发唯一一次重连')
  h.mark(1_005)
  assert.deepEqual(h.at(1_100, { a: { running: true } }, stale).actions,
    [{ kind: 'refresh', sourceId: 'local' }], '重连后重放一次 L1')
  const unknown: Reconcile = { requestedAt: 1_100, settledAt: 1_200, ok: false, attempts: 1, verdict: 'unknown' }
  h.at(1_200, { a: { running: true } }, unknown)
  assert.deepEqual(h.at(1_310, { a: { running: true } }, unknown).actions, [],
    'unknown 没有给出任何结论：绝不能把重连前的失败证据续到重连之后')
  assert.deepEqual(h.at(1_310, { a: { running: true } }, unknown).stalled, [])
  // 阳性对照：真正的**重连之后**失败结论仍必须提示（修完不能把 L3 一起关掉）。
  const staleAfter: Reconcile = { requestedAt: 1_100, settledAt: 1_320, ok: false, attempts: 1, verdict: 'stale' }
  assert.deepEqual(h.at(1_320, { a: { running: true } }, staleAfter).actions,
    [{ kind: 'notice', sourceId: 'local' }], '有结论的失败仍要提示')
})

test('与吸收同一 tick 发出的 L1 仍算"之前"：期限再多等一个 coalesce（边界由 <= 钉住）', () => {
  const h = harness({ refreshAfterMs: 1_000, refreshCoalesceMs: 500, refreshOutcomeTimeoutMs: 400 })
  h.at(0, { a: { running: true } })
  // 同一 tick 里既消费到 unknown（settledAt = 1_000）又发出 L1 ⇒ 两个时间戳相等。
  const unknown: Reconcile = { requestedAt: 1_000, settledAt: 1_000, ok: false, attempts: 1, verdict: 'unknown' }
  assert.deepEqual(h.at(1_000, { a: { running: true } }, unknown).actions,
    [{ kind: 'refresh', sourceId: 'local' }])
  assert.deepEqual(h.at(1_401, { a: { running: true } }, unknown).actions, [],
    '同 tick 的 L1 不改判成"之后"（改成 < 会在这里假 L2）')
  assert.deepEqual(h.at(1_500, { a: { running: true } }, unknown).actions,
    [{ kind: 'refresh', sourceId: 'local' }], 'coalesce 到点补发 L1，期限重新起算')
})

test('官方 refresh 持续坏（回执全为 unknown）不静默：期限到点升唯一一次 L2，梯子到顶后亮 L3', () => {
  // 2026-12 五轮复核新增的覆盖规则会把「refresh 失败 + 权威对我们的运行行沉默」结算成
  // `unknown`（而不是曾经的假健康 `converged`）。本测试钉住它的**下游后果**：unknown 流
  // 必须仍被等回执期限收口——否则「官方对账永久坏」会变成一条无声链路（不升级、不提示）。
  // 配额放宽到不干扰时间线：本测试锁的是「无结论也必须收口」，不是配额节拍。
  const h = harness({
    refreshAfterMs: 1_000,
    refreshCoalesceMs: 200,
    refreshOutcomeTimeoutMs: 150,
    noticeAfterMs: 10,
    maxRefreshRequests: 4,
    refreshWindowMs: 10_000,
  })
  h.at(0, { a: { running: true } })
  assert.deepEqual(h.at(1_000, { a: { running: true } }).actions,
    [{ kind: 'refresh', sourceId: 'local' }])
  const unknown: Reconcile = { requestedAt: 1_000, settledAt: 1_010, ok: false, attempts: 2, verdict: 'unknown' }
  assert.deepEqual(h.at(1_010, { a: { running: true } }, unknown).actions, [], '首次 unknown 当场不升级')
  assert.deepEqual(h.at(1_200, { a: { running: true } }, unknown).actions,
    [{ kind: 'refresh', sourceId: 'local' }], '吸收之后必须再发一次 L1（期限重新起算）')
  assert.deepEqual(h.at(1_360, { a: { running: true } }, unknown).actions,
    [{ kind: 'reconnect', sourceId: 'local' }], '期限到点仍要升级：unknown 流不得无声')
  h.mark(1_360)
  assert.deepEqual(h.at(1_370, { a: { running: true } }, unknown).actions,
    [{ kind: 'refresh', sourceId: 'local' }], '重连后重放 L1')
  // 之后只允许「继续 L1 + 最终一次 L3」：重连预算已用尽 ⇒ 不得再刷重连，
  // 且必须出现可见提示（有界收口，不无声）。扫一段窗口而不是钉死单点，避免
  // 把配额/节拍的实现细节当成契约。
  const timeline: string[] = []
  for (let now = 1_400; now <= 2_600; now += 50) {
    for (const action of h.at(now, { a: { running: true } }, unknown).actions) {
      timeline.push(`${String(now)}:${action.kind}`)
    }
  }
  assert.equal(timeline.some(entry => entry.endsWith(':reconnect')), false,
    '唯一一次重连已消费：无结论流不得变成重连风暴')
  assert.ok(timeline.some(entry => entry.endsWith(':notice')),
    '自愈预算用尽 + 仍无结论 ⇒ L3 必须可见（否则「官方对账永久坏」就是无声链路）')
})

test('另一条臂持续挡住派遣时 L3 仍有出口（blockedReconnects 计入梯子）', () => {
  // 三轮复核的 MEDIUM 缺口：App 的 S2 臂每 60s 静默重连一次 ⇒ reconnectBlocked 恒真、
  // no-op 账不增长、真实预算也不消耗 ⇒ 旧实现永远不亮横幅（模拟 20 分钟零 L2/L3）。
  const h = harness({ refreshOutcomeTimeoutMs: 400, refreshCoalesceMs: 200_000, noticeAfterMs: 200, maxNoopReconnects: 2 })
  h.at(0, { a: { running: true } })
  h.at(1_000) // L1
  assert.deepEqual(h.at(1_500, { a: { running: true } }, undefined, undefined, true).actions, [],
    '被挡住时不派遣（预算与计时都不动）')
  assert.deepEqual(h.at(1_600, { a: { running: true } }, undefined, undefined, true).actions, [],
    '连续被挡达到门槛：梯子到顶，但宽限未到')
  assert.deepEqual(h.at(1_900, { a: { running: true } }, undefined, undefined, true).actions,
    [{ kind: 'notice', sourceId: 'local' }], '宽限到点必须给出口，而不是永远静默')
  assert.deepEqual(h.at(1_900, { a: { running: true } }, undefined, undefined, true).stalled, ['local'])
})

test('共享账本挡住 L2 时不派遣：预算与等待计时都不被消耗，放开即升级', () => {
  const h = harness({ refreshOutcomeTimeoutMs: 400, refreshCoalesceMs: 200_000 })
  h.at(0, { a: { running: true } })
  h.at(1_000)
  // 期限到点本应 L2，但 App 账本说"同 tick 另一条臂刚重连/退避窗内" ⇒ 守卫不派遣。
  // 旧行为是派遣后才被 App 丢弃：守卫已经记账（lastReconnectDispatchAt 置位、等待
  // 计时清零），这条臂于是静默整个退避窗且 L1 一并停摆（2026-12 独立复核）。
  assert.deepEqual(h.at(1_500, { a: { running: true } }, undefined, undefined, true).actions, [],
    '账本挡住时绝不派遣，也不消耗预算')
  // 没记账 ⇒ 账本一放开，下一个到点的 tick 立刻派遣。
  assert.deepEqual(h.at(1_600, { a: { running: true } }).actions,
    [{ kind: 'reconnect', sourceId: 'local' }], '账本放开后仍能升级（预算未被虚耗）')
})

test('请求后无回执超时同样升级 L2（对账通道静默）', () => {
  const h = harness({ refreshOutcomeTimeoutMs: 400 })
  h.at(0)
  h.at(1_000)
  assert.deepEqual(h.at(1_300).actions, [], '期限内不升级')
  assert.deepEqual(h.at(1_400).actions, [], '边界（恰好 = 期限）不升级——判据是 > 而不是 >=')
  assert.deepEqual(h.at(1_500).actions, [{ kind: 'reconnect', sourceId: 'local' }], '超期后升级')
})

test('新时段不得消费上一时段的失败回执（复核缺陷 ②）', () => {
  const h = harness()
  h.at(1_000)
  const staleFail: Reconcile = { requestedAt: 1_000, settledAt: 1_400, ok: false, attempts: 2 }
  h.at(1_400, { a: { running: true } }, staleFail)
  h.mark(1_400)
  // 时段结束（running=false），但 producer 侧的回执仍停留在失败快照上。
  h.at(2_000, { a: { running: false } })
  // 新时段第一个 tick：旧回执不得触发任何动作。
  const plan = h.at(2_100, { b: { running: true } }, staleFail)
  assert.deepEqual(plan.actions, [], '旧时段的裁决不得升级新时段')
  assert.deepEqual(plan.stalled, [])
})

test('来源代际变化即重起算（复核缺陷：跨代际状态泄漏）', () => {
  const h = harness()
  h.at(0, { a: { running: true } })
  h.at(1_000)
  h.at(1_500)
  h.mark(1_500)
  h.at(1_700) // 亮 L3 的前置：预算已兑现
  // 同一会话 id、新 producer 代际（退役再挂载）：必须按新时段重新起算。
  const plan = h.at(1_800, { b: { running: true } }, undefined, 'generation-2')
  assert.deepEqual(plan.actions, [], '新身份不得继承旧时段配额/提示')
  assert.deepEqual(plan.stalled, [])
  assert.equal(plan.state.records.local?.reconnectCount, 0)
})

test('兄弟会话抖动不得重置长会话的时段（第二版身份模型：每会话计时）', () => {
  const h = harness()
  h.at(0, { a: { running: true } })
  h.at(100, { a: { running: true }, b: { running: true } })
  h.at(200, { a: { running: true } })
  const plan = h.at(1_000, { a: { running: true } })
  assert.deepEqual(plan.actions, [{ kind: 'refresh', sourceId: 'local' }],
    'a 的时段从 t=0 起算：b 的开始/结束（集合变化但 a 存活）不得把它重置')
})

test('同基数集合替换不得吞掉计时更新（每会话计时必须真的落账）', () => {
  const h = harness()
  h.at(0, { a: { running: true }, b: { running: true } })
  // {a,b} → {a,c}：基数不变但 c 是新会话；若记录未更新，c 的时钟会被记成旧值。
  h.at(600, { a: { running: true }, c: { running: true } })
  assert.equal(h.state.records.local?.runningSince.c, 600, 'c 的首次观测时刻必须是 600')
  assert.equal(h.state.records.local?.runningSince.b, undefined, '离开集合的 b 必须被丢弃')
  // c 自 600 起持续 running ⇒ t=1600 必须已过门槛并发出 L1（若时钟被吞掉则 age=0）。
  assert.deepEqual(h.at(1_600, { a: { running: true }, c: { running: true } }).actions,
    [{ kind: 'refresh', sourceId: 'local' }])
})

test('整组换代（与上一 tick 不相交）按新时段重起算，不继承旧配额/提示', () => {
  const h = harness({ refreshOutcomeTimeoutMs: 400 })
  h.at(0, { a: { running: true } })
  h.at(1_000)
  const failed: Reconcile = { requestedAt: 1_000, settledAt: 1_400, ok: false, attempts: 2 }
  h.at(1_400, { a: { running: true } }, failed)
  h.mark(1_400)
  // L3 = **重连后**的失败证据 + 重连后的宽限（noticeAfterMs=200）：1_400 重连、
  // 1_500 的新失败回执、1_600 起亮。
  const post = { requestedAt: 1_400, settledAt: 1_500, ok: false, attempts: 2 }
  assert.deepEqual(h.at(1_500, { a: { running: true } }, post).stalled, [], '梯子到顶 tick（宽限起算）')
  assert.deepEqual(h.at(1_700, { a: { running: true } }, post).stalled, ['local'])
  const swapped = h.at(1_800, { b: { running: true } }, post)
  assert.deepEqual(swapped.actions, [], '新会话继承旧提示/预算即为假提示')
  assert.deepEqual(swapped.stalled, [])
  assert.equal(swapped.state.records.local?.reconnectCount, 0)
})

test('健康通道不得因配额间隙亮横幅；健康回执撤下横幅后可被新的失败证据重新武装', () => {
  const h = harness({ refreshOutcomeTimeoutMs: 400 })
  h.at(0, { a: { running: true } })
  h.at(1_000)
  h.at(1_400, { a: { running: true } }, { requestedAt: 1_000, settledAt: 1_400, ok: false, attempts: 2 })
  h.mark(1_400)
  const healthyAt = (t: number): Reconcile => ({ requestedAt: t - 100, settledAt: t, ok: true, attempts: 1 })
  // 健康回执 = 通道确认恢复 ⇒ 撤下横幅；此后每一轮探测都健康时，无论探测之间
  // 隔多久（滚动窗口配额间隙），都**不得**因时间流逝亮横幅。
  for (const now of [1_500, 1_600, 2_000, 9_000, 60_000]) {
    assert.deepEqual(h.at(now, { a: { running: true } }, healthyAt(now)).stalled, [],
      `健康通道 + 配额间隙（t=${String(now)}）不得亮横幅（二轮复核缺陷 ②）`)
  }
  // 新的一次未收敛证据（失败回执）⇒ 重新武装（不能被一次健康永久 latch）。
  const failed: Reconcile = { requestedAt: 60_500, settledAt: 60_500, ok: false, attempts: 2 }
  assert.deepEqual(h.at(61_000, { a: { running: true } }, failed).stalled, ['local'])
})

test('running 结束或来源离开输入时记录与提示一并清除', () => {
  const h = harness()
  h.at(0)
  const cleared = h.at(5_000, { a: { running: false } })
  assert.deepEqual(cleared.state.records, {})
  assert.deepEqual(cleared.stalled, [])
  h.at(6_000)
  const retired = h.at(7_000)
  assert.ok(retired.state.records.local !== undefined)
  const gone = planSessionLiveness(h.state, { now: 8_000, sources: {} }, CONFIG)
  assert.deepEqual(gone.state.records, {})
})

test('每 tick 返回新状态但内容稳定（引用复用刻意不做：漏字段 = 静默丢状态）', () => {
  const h = harness()
  const first = h.at(0)
  const second = h.at(1, { a: { running: true } })
  // 引用身份不再是契约（消费点是 App 的 ref，不触发 React）；契约是内容不漂移。
  assert.deepEqual(second.state.records, first.state.records)
  assert.deepEqual(second.actions, [])
})

test('默认节拍：coalesce == 窗口/配额（把爆发式探测铺成均匀节拍）', () => {
  // 60s 版本会在 120/180/240s 用完窗口配额 → 之后 8 分钟零探测（二轮复核）；
  // 相等时平均成本不变而最坏未探测时长 = coalesce。
  assert.equal(
    SESSION_LIVENESS_DEFAULTS.refreshCoalesceMs,
    SESSION_LIVENESS_DEFAULTS.refreshWindowMs / SESSION_LIVENESS_DEFAULTS.maxRefreshRequests,
  )
})

test('生产节拍：首次对账在事实年龄 60s（陈旧位不再等 120s/200s 才被发现）', () => {
  // 事实年龄从**首次观测到 running** 的 tick 起算（不是绝对时刻）：t=0 首见、
  // 60s 门槛到点即发 L1；tick 仍是生产 30s（AGGREGATE_FALLBACK_POLL_MS）。
  // 每个 running 时段的探测总量仍由 coalesce/配额封顶，因此更短的首探不增加稳态
  // 成本，只把「丢帧 → 纠正」的可见窗口从 ~200s 级压到 60s 级（2026-12 彻底修复）。
  let state = createSessionLivenessState()
  const at = (now: number) => {
    const plan = planSessionLiveness(state, {
      now,
      sources: { local: { sessions: { a: { running: true } } } },
    }, SESSION_LIVENESS_DEFAULTS)
    state = plan.state
    return plan
  }
  assert.deepEqual(at(0).actions, [])
  assert.deepEqual(at(30_000).actions, [])
  assert.deepEqual(at(59_999).actions, [])
  assert.deepEqual(at(60_000).actions, [{ kind: 'refresh', sourceId: 'local' }],
    '门槛到点的那一个 tick 必须发对账')
})
