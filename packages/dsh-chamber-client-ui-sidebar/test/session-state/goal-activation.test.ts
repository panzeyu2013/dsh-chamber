/**
 * Goal activation tracker state machine (design 19 §3.2.2).
 *
 * Locks: the defensive event parser over the FROZEN nested wire
 * (`{ sessionId, goal?: { id, revision, activation } }` — the real vendor
 * payload), the goal-absent "no current goal" clear, the event goal.id binding
 * (never land an edge on another goal; retain it across every later projection
 * until the projection names its goal — P2b rule, unified in F14), the
 * event-only source discipline (NEVER goals/get — that lookup resumes cold
 * sessions), the bounded subscription retry over a throwing/absent
 * ctx.get('remote'), the resolved-value sync() contract, the trigger matrix
 * (running both directions / goal projection change / connection/reset),
 * generation cleanup + re-subscription, and disposal. F6 additions: a
 * non-throwing `$on` that returns no disposer is a SUCCESSFUL registration
 * (never retried/duplicated, warned once) and the per-generation listener guard
 * drops late deliveries of the dead generation / after dispose.
 *
 * Run directly: node test/session-state/goal-activation.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  createGoalActivationTracker, GOAL_ACTIVATION_EVENT, MAX_ACTIVATION_CACHE, parseGoalActivationEvent,
  type GoalActivationTrackerDeps,
} from '../../src/client/goal-activation.ts'
import type { GoalFact } from '../../src/shared/session-row-state.ts'
import type { InstanceRuntimeReport } from '../../src/shared/aggregate-store.ts'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const goalA: GoalFact = { goalId: 'gA', revision: 1, phase: 'active' }
const goalB: GoalFact = { goalId: 'gB', revision: 1, phase: 'active' }

function report(rows: Record<string, { running?: boolean; goal?: GoalFact | null }>): InstanceRuntimeReport {
  const sessions: InstanceRuntimeReport['sessions'] = {}
  for (const id of Object.keys(rows)) {
    const row = rows[id] ?? {}
    sessions[id] = {
      running: row.running === true,
      ...(row.goal === undefined ? {} : { goal: row.goal }),
    }
  }
  return { sessions }
}

function createTimers() {
  let nextId = 1
  const pending = new Map<number, { callback: () => void }>()
  const delays: number[] = []
  return {
    setTimeout(callback: () => void, delay: number): unknown {
      const id = nextId
      nextId += 1
      delays.push(delay)
      pending.set(id, { callback })
      return id
    },
    clearTimeout(handle: unknown): void {
      pending.delete(handle as number)
    },
    runNext(): boolean {
      const first = [...pending.keys()].sort((a, b) => a - b)[0]
      if (first === undefined) return false
      const entry = pending.get(first)
      pending.delete(first)
      entry?.callback()
      return true
    },
    pendingCount(): number {
      return pending.size
    },
    delays,
  }
}

function createRemote() {
  const listeners = new Set<(...args: unknown[]) => void>()
  let unsubscribed = 0
  return {
    $on(event: string, listener: (...args: unknown[]) => void): () => void {
      assert.equal(event, GOAL_ACTIVATION_EVENT)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        unsubscribed += 1
      }
    },
    emit(...args: unknown[]): void {
      for (const listener of [...listeners]) listener(...args)
    },
    count(): number {
      return listeners.size
    },
    unsubscribes(): number {
      return unsubscribed
    },
  }
}

function createHarness(over: Partial<GoalActivationTrackerDeps> = {}) {
  const timers = createTimers()
  const warns: string[] = []
  let syncCalls = 0
  const deps: GoalActivationTrackerDeps = {
    getRemote: () => undefined,
    sync: () => { syncCalls += 1 },
    warn: (message) => { warns.push(message) },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    maxSubscriptionAttempts: 3,
    retryBaseMs: 100,
    ...over,
  }
  return { timers, warns, deps, syncCalls: () => syncCalls }
}

test('parseGoalActivationEvent accepts the object/positional shapes and rejects anything else', () => {
  assert.deepEqual(parseGoalActivationEvent({ sessionId: 's1', activation: 'armed' }), { sessionId: 's1', activation: 'armed' })
  assert.deepEqual(parseGoalActivationEvent({ id: 's1', activation: 'disarmed' }), { sessionId: 's1', activation: 'disarmed' })
  assert.deepEqual(parseGoalActivationEvent('s1', 'armed'), { sessionId: 's1', activation: 'armed' })
  // Boolean aliases (the upstream wire shape is not pinned in this repository).
  assert.deepEqual(parseGoalActivationEvent({ sessionId: 's1', armed: true }), { sessionId: 's1', activation: 'armed' })
  assert.deepEqual(parseGoalActivationEvent({ sessionId: 's1', armed: false }), { sessionId: 's1', activation: 'disarmed' })
  assert.deepEqual(parseGoalActivationEvent({ sessionId: 's1', active: false }), { sessionId: 's1', activation: 'disarmed' })
  // Rejections: no session id, no/unknown activation, wrong container.
  assert.equal(parseGoalActivationEvent({ activation: 'armed' }), undefined)
  assert.equal(parseGoalActivationEvent({ sessionId: 's1', activation: 'on' }), undefined)
  assert.equal(parseGoalActivationEvent({ sessionId: '', activation: 'armed' }), undefined)
  assert.equal(parseGoalActivationEvent(null), undefined)
  assert.equal(parseGoalActivationEvent([{ sessionId: 's1', activation: 'armed' }]), undefined)
  assert.equal(parseGoalActivationEvent('s1', 'bogus'), undefined)
})

test('parseGoalActivationEvent reads the frozen nested payload, the no-goal form and keeps the aliases as fallback', () => {
  // 冻结 wire（vendor packages/goal/goal/src/types.ts:75-87）：
  // { sessionId, goal?: { id, revision, activation } } —— goal 是主来源。
  assert.deepEqual(
    parseGoalActivationEvent({ sessionId: 's1', goal: { id: 'g1', revision: 2, activation: 'armed' } }),
    { sessionId: 's1', activation: 'armed', goalId: 'g1' },
  )
  assert.deepEqual(
    parseGoalActivationEvent({ sessionId: 's1', goal: { id: 'g1', revision: 2, activation: 'disarmed' } }),
    { sessionId: 's1', activation: 'disarmed', goalId: 'g1' },
  )
  // id 缺失 = 未绑定边（镜像 P2b 的宽松），值照收。
  assert.deepEqual(
    parseGoalActivationEvent({ sessionId: 's1', goal: { activation: 'armed' } }),
    { sessionId: 's1', activation: 'armed' },
  )
  // goal 缺席（含显式 undefined）= 宿主当前无 goal（明确 null，不是 malformed）。
  assert.deepEqual(parseGoalActivationEvent({ sessionId: 's1' }), { sessionId: 's1', activation: null })
  assert.deepEqual(parseGoalActivationEvent({ sessionId: 's1', goal: undefined }), { sessionId: 's1', activation: null })
  // goal 形状漂移（显式 null / 非对象 / 未知词）= 丢弃，绝不猜。
  for (const bad of [
    { sessionId: 's1', goal: null },
    { sessionId: 's1', goal: 'armed' },
    { sessionId: 's1', goal: [{ activation: 'armed' }] },
    { sessionId: 's1', goal: { id: 'g1', activation: 'maybe' } },
    { sessionId: 's1', goal: { id: 'g1', activation: 'ARMED' } },
  ]) {
    assert.equal(parseGoalActivationEvent(bad), undefined, JSON.stringify(bad))
  }
  // 无 goal 键时顶层别名仍兜底（历史/测试形）。
  assert.deepEqual(parseGoalActivationEvent({ sessionId: 's1', activation: 'armed' }), { sessionId: 's1', activation: 'armed' })
  assert.deepEqual(parseGoalActivationEvent({ sessionId: 's1', armed: false }), { sessionId: 's1', activation: 'disarmed' })
})

test('bounded retry: a throwing/absent remote is retried, then goes inert with one warning', () => {
  const h = createHarness({
    getRemote: () => { throw new Error('service not ready') },
    maxSubscriptionAttempts: 3,
    retryBaseMs: 100,
  })
  const tracker = createGoalActivationTracker(h.deps)
  tracker.start()
  assert.equal(tracker.subscriptionAttempts(), 1)
  assert.equal(h.timers.pendingCount(), 1)
  assert.equal(h.timers.runNext(), true)
  assert.equal(tracker.subscriptionAttempts(), 2)
  assert.equal(h.timers.runNext(), true)
  assert.equal(tracker.subscriptionAttempts(), 3)
  assert.equal(tracker.refreshCount(), 0)
  assert.equal(h.timers.runNext(), false, 'the bound is final — no unbounded polling')
  assert.deepEqual(h.timers.delays, [100, 200])
  assert.equal(h.warns.length, 1)
  assert.match(h.warns[0] ?? '', /unknown-hold/)
  assert.match(h.warns[0] ?? '', /goals\/get is never called/)
  // An inert tracker is a safe no-op.
  tracker.dispose()
})

test('subscription recovers when the remote becomes readable and scans the last observation', () => {
  const remote = createRemote()
  let attempts = 0
  const h = createHarness({
    getRemote: () => {
      attempts += 1
      if (attempts === 1) throw new Error('not provided yet')
      return remote
    },
  })
  const tracker = createGoalActivationTracker(h.deps)
  tracker.observe(report({ s1: { goal: goalA } }), new Map([['s1', goalA]]))
  tracker.start()
  assert.equal(remote.count(), 0)
  assert.equal(h.timers.runNext(), true)
  assert.equal(remote.count(), 1, 'subscribed after the retry')
  assert.equal(tracker.subscriptionAttempts(), 2)
  assert.equal(tracker.refreshCount(), 2, 'ready-time re-scan runs against the last observed facts')
  remote.emit({ sessionId: 's1', activation: 'armed' })
  assert.equal(tracker.activationOf('s1'), 'armed')
  tracker.dispose()
})

test('activation-changed: cached value lands, identical deliveries never re-sync, changes do', () => {
  const remote = createRemote()
  const h = createHarness({ getRemote: () => remote })
  const tracker = createGoalActivationTracker(h.deps)
  tracker.start()
  assert.equal(remote.count(), 1)
  assert.equal(h.syncCalls(), 0, 'subscribing alone must not re-report')
  remote.emit({ sessionId: 's1', activation: 'armed' })
  assert.equal(tracker.activationOf('s1'), 'armed')
  assert.equal(h.syncCalls(), 1, 'a resolved-value change MUST re-report (identity dedupe)')
  remote.emit({ sessionId: 's1', activation: 'armed' })
  assert.equal(h.syncCalls(), 1, 'no churn for an identical delivery')
  remote.emit('s1', 'disarmed')
  assert.equal(tracker.activationOf('s1'), 'disarmed')
  assert.equal(h.syncCalls(), 2)
  remote.emit({ sessionId: 's2', armed: true })
  assert.equal(tracker.activationOf('s2'), 'armed')
  assert.equal(h.syncCalls(), 3)
  assert.deepEqual([...tracker.snapshot().entries()].sort(), [['s1', 'disarmed'], ['s2', 'armed']])
  // Malformed deliveries warn once and never fabricate a value.
  remote.emit({ sessionId: 's3', activation: 'bogus' })
  remote.emit({ nothing: true })
  assert.equal(h.syncCalls(), 3)
  assert.equal(h.warns.length, 1)
  assert.equal(tracker.activationOf('s3'), undefined)
  tracker.dispose()
})

test('connection/reset clears the generation cache and re-reports exactly when values existed', () => {
  const remote = createRemote()
  const h = createHarness({ getRemote: () => remote })
  const tracker = createGoalActivationTracker(h.deps)
  tracker.start()
  remote.emit({ sessionId: 's1', activation: 'armed' })
  assert.equal(h.syncCalls(), 1)
  tracker.reset()
  assert.equal(tracker.activationOf('s1'), undefined)
  assert.equal(h.syncCalls(), 2, 'the unknown regression must reach the App identity')
  tracker.reset()
  assert.equal(h.syncCalls(), 2, 'an empty reset is a no-op')
  remote.emit({ sessionId: 's1', activation: 'armed' })
  assert.equal(tracker.activationOf('s1'), 'armed')
  assert.equal(h.syncCalls(), 3, 'the tracker re-learns after the generation reset')
  tracker.dispose()
})

test('a goal-absent delivery clears the cached edge and re-reports the unknown regression (real wire)', () => {
  const remote = createRemote()
  const h = createHarness({ getRemote: () => remote })
  const tracker = createGoalActivationTracker(h.deps)
  tracker.start()
  tracker.observe(report({ s1: { goal: goalA } }), new Map([['s1', goalA]]))
  remote.emit({ sessionId: 's1', goal: { id: goalA.goalId, revision: 1, activation: 'armed' } })
  assert.equal(tracker.activationOf('s1'), 'armed')
  assert.equal(h.syncCalls(), 1)
  // goal 缺席 = 宿主明确无 goal：清该会话缓存并重报（App 身份签名必须看见 unknown 回归）。
  remote.emit({ sessionId: 's1' })
  assert.equal(tracker.activationOf('s1'), undefined)
  assert.equal(h.syncCalls(), 2)
  // 空缓存上的重复 no-goal 事件无变化 ⇒ 不重报（anti-churn）。
  remote.emit({ sessionId: 's1' })
  assert.equal(tracker.activationOf('s1'), undefined)
  assert.equal(h.syncCalls(), 2)
  tracker.dispose()
})

test('an event goal.id binds the edge: never another goal, retained across later projections (P2b rule)', () => {
  const remote = createRemote()
  const h = createHarness({ getRemote: () => remote })
  const tracker = createGoalActivationTracker(h.deps)
  tracker.start()
  tracker.observe(report({ s1: { goal: goalA } }), new Map([['s1', goalA]]))
  // 事件带 gB、投影还停在 gA：不得落到 gA 行上，边保留待基线。
  remote.emit({ sessionId: 's1', goal: { id: goalB.goalId, revision: 1, activation: 'armed' } })
  assert.equal(h.syncCalls(), 1)
  assert.equal(tracker.activationOf('s1'), undefined, 'the gB edge is withheld from the gA row')
  // running 变化触发重扫：投影仍停在 gA ⇒ 这是投影滞后而不是基线矛盾，边保留。
  tracker.observe(report({ s1: { running: true, goal: goalA } }), new Map([['s1', goalA]]))
  assert.equal(tracker.activationOf('s1'), undefined)
  // 基线追上 gB：同一次 observe 内 scan 匹配、值可合并（无需再发事件）。
  tracker.observe(report({ s1: { running: true, goal: goalB } }), new Map([['s1', goalB]]))
  assert.equal(tracker.activationOf('s1'), 'armed')
  // 第三个 goalId（投影越过绑定目标与其等待中的旧目标）：F14 统一为保留待匹配，
  // 不再 drop——绑定守卫让 gC 期间不可合并，边本身留着等基线回到 gB。
  const goalC: GoalFact = { goalId: 'gC', revision: 1, phase: 'active' }
  tracker.observe(report({ s1: { running: true, goal: goalC } }), new Map([['s1', goalC]]))
  assert.equal(tracker.activationOf('s1'), undefined, '第三个 goalId 期间边保留但不可合并')
  tracker.observe(report({ s1: { running: true, goal: goalB } }), new Map([['s1', goalB]]))
  assert.equal(tracker.activationOf('s1'), 'armed', '投影回到匹配 id 时保留边应用（旧行为已 drop）')

  // 新事件覆盖旧边：绑定 gC 的事件在投影还停在 gB 时到达 ⇒ gB 旧边被替换。
  remote.emit({ sessionId: 's1', goal: { id: goalC.goalId, revision: 1, activation: 'disarmed' } })
  tracker.observe(report({ s1: { running: false, goal: goalB } }), new Map([['s1', goalB]]))
  assert.equal(tracker.activationOf('s1'), undefined, '新边绑定 gC ⇒ 投影 gB 不得复用旧 gB 值')
  tracker.observe(report({ s1: { running: false, goal: goalC } }), new Map([['s1', goalC]]))
  assert.equal(tracker.activationOf('s1'), 'disarmed', '新事件的值随 gC 基线落地')
  tracker.dispose()
})

test('a reset drops the dead generation subscription and re-subscribes with a fresh bounded budget', () => {
  const remote1 = createRemote()
  const remote2 = createRemote()
  let current: unknown = remote1
  const resetListeners: Array<() => void> = []
  let resetUnsubscribed = 0
  const h = createHarness({
    getRemote: () => current,
    onConnectionReset: (listener) => {
      resetListeners.push(listener)
      return () => {
        resetListeners.length = 0
        resetUnsubscribed += 1
      }
    },
  })
  const tracker = createGoalActivationTracker(h.deps)
  tracker.start()
  assert.equal(remote1.count(), 1)
  remote1.emit({ sessionId: 's1', goal: { id: goalA.goalId, revision: 1, activation: 'armed' } })
  assert.equal(tracker.activationOf('s1'), 'armed')
  const syncsBeforeReset = h.syncCalls()
  // 换代：remote 服务换成新化身，connection/reset 宣告旧代死亡。
  current = remote2
  resetListeners[0]?.()
  assert.equal(remote1.unsubscribes(), 1, 'the dead generation subscription is dropped')
  assert.equal(remote1.count(), 0)
  assert.equal(remote2.count(), 1, 'the new generation is subscribed in the same reset')
  assert.equal(tracker.subscriptionAttempts(), 1, 'the new generation gets a fresh budget, not the old count')
  assert.equal(h.syncCalls(), syncsBeforeReset + 1, 'the cleared cache re-reports')
  assert.equal(tracker.activationOf('s1'), undefined)
  // 旧代迟到事件无效（监听器已摘），新代事件照常生效。
  remote1.emit({ sessionId: 's1', goal: { id: goalA.goalId, revision: 1, activation: 'armed' } })
  assert.equal(tracker.activationOf('s1'), undefined)
  remote2.emit({ sessionId: 's1', goal: { id: goalA.goalId, revision: 1, activation: 'disarmed' } })
  assert.equal(tracker.activationOf('s1'), 'disarmed')
  tracker.dispose()
  assert.equal(resetUnsubscribed, 1)
})

test('a reset re-arms an exhausted retry budget when the remote comes back with the new generation', () => {
  const remote = createRemote()
  let readable = false
  const resetListeners: Array<() => void> = []
  const h = createHarness({
    getRemote: () => {
      if (!readable) throw new Error('service gone with the generation')
      return remote
    },
    maxSubscriptionAttempts: 2,
    onConnectionReset: (listener) => {
      resetListeners.push(listener)
      return () => {}
    },
  })
  const tracker = createGoalActivationTracker(h.deps)
  tracker.start()
  assert.equal(tracker.subscriptionAttempts(), 1)
  assert.equal(h.timers.runNext(), true)
  assert.equal(tracker.subscriptionAttempts(), 2)
  assert.equal(h.timers.runNext(), false, 'budget exhausted — inert')
  assert.equal(h.warns.length, 1)
  // 新代里服务重新可读：reset 必须按新预算重订阅（否则整代永久 unknown）。
  readable = true
  resetListeners[0]?.()
  assert.equal(tracker.subscriptionAttempts(), 1)
  assert.equal(remote.count(), 1)
  remote.emit({ sessionId: 's1', goal: { id: goalA.goalId, revision: 1, activation: 'armed' } })
  assert.equal(tracker.activationOf('s1'), 'armed')
  tracker.dispose()
})

test('start() subscribes to connection/reset through the injected seam', () => {
  const remote = createRemote()
  const listeners: Array<() => void> = []
  let resetUnsubscribed = 0
  const h = createHarness({
    getRemote: () => remote,
    onConnectionReset: (listener) => {
      listeners.push(listener)
      return () => {
        listeners.length = 0
        resetUnsubscribed += 1
      }
    },
  })
  const tracker = createGoalActivationTracker(h.deps)
  tracker.start()
  tracker.start()
  assert.equal(remote.count(), 1, 'start() is idempotent')
  assert.equal(listeners.length, 1)
  remote.emit({ sessionId: 's1', activation: 'armed' })
  listeners[0]?.()
  assert.equal(tracker.activationOf('s1'), undefined)
  assert.equal(h.syncCalls(), 2)
  tracker.dispose()
  assert.equal(resetUnsubscribed, 1)
})

test('observe: refresh triggers are running changes (both directions) and goal projection changes', () => {
  const h = createHarness()
  const tracker = createGoalActivationTracker(h.deps)
  const goalsA = new Map<string, GoalFact | null>([['s1', goalA]])
  tracker.observe(report({ s1: { running: false, goal: goalA } }), goalsA)
  assert.equal(tracker.refreshCount(), 1, 'the first pass scans')
  tracker.observe(report({ s1: { running: false, goal: goalA } }), goalsA)
  assert.equal(tracker.refreshCount(), 1, 'an identical pass does not re-scan')
  tracker.observe(report({ s1: { running: true, goal: goalA } }), goalsA)
  assert.equal(tracker.refreshCount(), 2, 'false -> true is a trigger')
  tracker.observe(report({ s1: { running: false, goal: goalA } }), goalsA)
  assert.equal(tracker.refreshCount(), 3, 'true -> false is a trigger')
  const goalA2: GoalFact = { ...goalA, revision: 2 }
  tracker.observe(report({ s1: { running: false, goal: goalA2 } }), new Map([['s1', goalA2]]))
  assert.equal(tracker.refreshCount(), 4, 'a goal projection change is a trigger')
  tracker.observe(report({ s1: { running: false, goal: goalB } }), new Map([['s1', goalB]]))
  assert.equal(tracker.refreshCount(), 5, 'a goalId change is a trigger too')
  tracker.observe(report({}), new Map())
  assert.equal(tracker.refreshCount(), 6, 'a vanished session is a change')
  tracker.observe(report({}), new Map())
  assert.equal(tracker.refreshCount(), 6)
  tracker.dispose()
})

test('the scan withholds a different goalId / drops explicit null / vanished session; unknown keeps last-known', () => {
  const remote = createRemote()
  const h = createHarness({ getRemote: () => remote })
  const tracker = createGoalActivationTracker(h.deps)
  tracker.start()
  tracker.observe(report({ s1: { goal: goalA } }), new Map([['s1', goalA]]))
  remote.emit({ sessionId: 's1', activation: 'armed' })
  assert.equal(tracker.activationOf('s1'), 'armed')
  // Same goal, revision bump: the switch is still the same goal's switch.
  const goalA2: GoalFact = { ...goalA, revision: 2 }
  tracker.observe(report({ s1: { goal: goalA2 } }), new Map([['s1', goalA2]]))
  assert.equal(tracker.activationOf('s1'), 'armed')
  // Unknown goal fact: last-known retention keeps the cache.
  tracker.observe(report({ s1: {} }), new Map())
  assert.equal(tracker.activationOf('s1'), 'armed')
  // A DIFFERENT goal never inherits the previous goal's switch; F14: the entry
  // is retained (not dropped), so moving back to gA re-applies it.
  tracker.observe(report({ s1: { goal: goalB } }), new Map([['s1', goalB]]))
  assert.equal(tracker.activationOf('s1'), undefined)
  tracker.observe(report({ s1: { goal: goalA } }), new Map([['s1', goalA]]))
  assert.equal(tracker.activationOf('s1'), 'armed', 'different-goal projection only withholds; the edge is retained')
  // Explicit null (no goal) drops it.
  remote.emit({ sessionId: 's1', activation: 'armed' })
  tracker.observe(report({ s1: { goal: null } }), new Map([['s1', null]]))
  assert.equal(tracker.activationOf('s1'), undefined)
  // The session leaving the report drops it (bounded map).
  remote.emit({ sessionId: 's1', activation: 'armed' })
  assert.equal(tracker.activationOf('s1'), 'armed')
  tracker.observe(report({}), new Map())
  assert.equal(tracker.activationOf('s1'), undefined)
  tracker.dispose()
})

test('the tracker never reads goals (R3: goals/get resumes cold sessions)', () => {
  const TRACKER = read('../../src/client/goal-activation.ts')
  // The ONLY remote surface touched is $on (the subscription seam): no goals
  // service member access exists anywhere in the read path.
  assert.doesNotMatch(TRACKER, /\.goals\b/)
  assert.match(TRACKER, /\$on\(GOAL_ACTIVATION_EVENT/)
  const INDEX = read('../../src/client/index.ts')
  assert.doesNotMatch(INDEX, /\.goals\b/)
  // The feature must not have extended the plugin inject list.
  const inject = INDEX.match(/export const inject = \[[^\]]*\]/)?.[0] ?? ''
  assert.ok(inject.includes("'sessions'"), 'inject is still the declared sidebar list')
  assert.ok(!inject.includes('remote'), 'remote is accessed through ctx.get, never injected')
})

test('dispose withdraws the subscription, cancels the retry timer and ignores late deliveries', () => {
  const remote = createRemote()
  const h = createHarness({ getRemote: () => remote })
  const tracker = createGoalActivationTracker(h.deps)
  tracker.start()
  remote.emit({ sessionId: 's1', activation: 'armed' })
  tracker.dispose()
  assert.equal(remote.count(), 0)
  assert.equal(remote.unsubscribes(), 1)
  assert.equal(tracker.activationOf('s1'), undefined)
  remote.emit({ sessionId: 's1', activation: 'armed' })
  assert.equal(h.syncCalls(), 1, 'late deliveries after dispose never re-report')
  // The pending retry timer path is cancelled too.
  const h2 = createHarness({ getRemote: () => undefined, maxSubscriptionAttempts: 5 })
  const tracker2 = createGoalActivationTracker(h2.deps)
  tracker2.start()
  assert.equal(h2.timers.pendingCount(), 1)
  tracker2.dispose()
  assert.equal(h2.timers.pendingCount(), 0)
  assert.equal(h2.timers.runNext(), false)
})

/**
 * F11 回归用远端：`$on` 返回的 disposer **抛错**（但先把监听器摘掉再抛，便于
 * 断言「确实调用了」）。dispose 若不隔离，这个异常会从 index.ts effect cleanup
 * 首行冒出去，跳过 sessionFacts/退订/producer.clear。
 */
function createThrowingUnsubscribeRemote() {
  const listeners = new Set<(...args: unknown[]) => void>()
  let unsubscribeCalls = 0
  return {
    $on(event: string, listener: (...args: unknown[]) => void): () => void {
      assert.equal(event, GOAL_ACTIVATION_EVENT)
      listeners.add(listener)
      return () => {
        unsubscribeCalls += 1
        listeners.delete(listener)
        throw new Error('disposer exploded')
      }
    },
    emit(...args: unknown[]): void {
      for (const listener of [...listeners]) listener(...args)
    },
    count(): number {
      return listeners.size
    },
    unsubscribes(): number {
      return unsubscribeCalls
    },
  }
}

/**
 * F6 回归用远端：`$on` 登记成功但**不返回** disposer（返回 undefined）。监听器
 * 客观留在远端，摘不掉——这正是必须靠 generation / disposed 守卫的场景。
 */
function createDisposerlessRemote() {
  const listeners = new Set<(...args: unknown[]) => void>()
  let subscribeCalls = 0
  return {
    $on(event: string, listener: (...args: unknown[]) => void): undefined {
      assert.equal(event, GOAL_ACTIVATION_EVENT)
      subscribeCalls += 1
      listeners.add(listener)
      return undefined
    },
    emit(...args: unknown[]): void {
      for (const listener of [...listeners]) listener(...args)
    },
    count(): number {
      return listeners.size
    },
    calls(): number {
      return subscribeCalls
    },
  }
}

test('F6: a non-function $on return is a successful registration — no retry, no duplicate, warn-once', () => {
  const remote = createDisposerlessRemote()
  const h = createHarness({ getRemote: () => remote })
  const tracker = createGoalActivationTracker(h.deps)
  tracker.start()
  assert.equal(tracker.subscriptionAttempts(), 1)
  assert.equal(remote.calls(), 1, 'the listener is registered exactly once')
  assert.equal(remote.count(), 1)
  assert.equal(h.timers.pendingCount(), 0, 'a registered $on must never schedule a retry (it would duplicate the listener)')
  assert.equal(h.warns.length, 1, 'the missing disposer is diagnosed exactly once')
  assert.match(h.warns[0] ?? '', /unsubscribe handle/)
  // 登记后的监听器照常进状态机（不抛 = 登记成功，值必须可用）。
  remote.emit({ sessionId: 's1', goal: { id: goalA.goalId, revision: 1, activation: 'armed' } })
  assert.equal(tracker.activationOf('s1'), 'armed')
  // start() 幂等；即使换代重订阅也只认新代的登记。
  tracker.start()
  assert.equal(remote.calls(), 1)
  tracker.dispose()
})

test('F6: with no disposer, the generation guard drops the dead generation late deliveries', () => {
  const remote1 = createDisposerlessRemote()
  const remote2 = createDisposerlessRemote()
  let current: unknown = remote1
  const resetListeners: Array<() => void> = []
  const h = createHarness({
    getRemote: () => current,
    onConnectionReset: (listener) => {
      resetListeners.push(listener)
      return () => {}
    },
  })
  const tracker = createGoalActivationTracker(h.deps)
  tracker.start()
  assert.equal(remote1.count(), 1)
  remote1.emit({ sessionId: 's1', goal: { id: goalA.goalId, revision: 1, activation: 'armed' } })
  assert.equal(tracker.activationOf('s1'), 'armed')
  const syncsBeforeReset = h.syncCalls()
  // 换代：remote 服务换成新化身，旧 remote 的监听器摘不掉（$on 未返回 disposer）。
  current = remote2
  resetListeners[0]?.()
  assert.equal(remote2.count(), 1, 'the new generation is subscribed in the same reset')
  assert.equal(tracker.activationOf('s1'), undefined, 'the dead generation cache is cleared')
  assert.equal(h.syncCalls(), syncsBeforeReset + 1, 'the cleared cache re-reports once')
  assert.equal(h.warns.length, 1, 'the disposer warning is tracker-lifetime once, not per generation')
  // 旧代迟到事件：监听器客观还在远端上，必须被 generation 守卫丢弃。
  remote1.emit({ sessionId: 's1', goal: { id: goalA.goalId, revision: 1, activation: 'armed' } })
  assert.equal(tracker.activationOf('s1'), undefined, 'a dead-generation late edge never lands in the new generation')
  assert.equal(h.syncCalls(), syncsBeforeReset + 1, 'and it never re-reports')
  remote2.emit({ sessionId: 's1', goal: { id: goalA.goalId, revision: 1, activation: 'disarmed' } })
  assert.equal(tracker.activationOf('s1'), 'disarmed', 'the current generation keeps working')
  tracker.dispose()
})

test('F6: after dispose even an unremovable listener processes nothing', () => {
  const remote = createDisposerlessRemote()
  const h = createHarness({ getRemote: () => remote })
  const tracker = createGoalActivationTracker(h.deps)
  tracker.start()
  remote.emit({ sessionId: 's1', goal: { id: goalA.goalId, revision: 1, activation: 'armed' } })
  assert.equal(tracker.activationOf('s1'), 'armed')
  const syncsBeforeDispose = h.syncCalls()
  tracker.dispose()
  remote.emit({ sessionId: 's2', goal: { id: goalB.goalId, revision: 1, activation: 'armed' } })
  assert.equal(tracker.activationOf('s2'), undefined, 'late deliveries after dispose are ignored')
  assert.equal(h.syncCalls(), syncsBeforeDispose, 'no re-report after dispose')
  assert.equal(remote.count(), 1, 'the listener objectively remains — the disposed guard is the only line of defence')
})

test('F11: dispose swallows a throwing disposer and still runs the connection/reset unsubscribe', () => {
  const remote = createThrowingUnsubscribeRemote()
  let resetUnsubscribes = 0
  const h = createHarness({
    getRemote: () => remote,
    onConnectionReset: () => () => {
      resetUnsubscribes += 1
      throw new Error('reset disposer exploded too')
    },
  })
  const tracker = createGoalActivationTracker(h.deps)
  tracker.start()
  remote.emit({ sessionId: 's1', goal: { id: goalA.goalId, revision: 1, activation: 'armed' } })
  assert.equal(tracker.activationOf('s1'), 'armed')
  // 首行 dispose 抛出会跳过 index.ts effect cleanup 的其余步骤：这里必须全吞。
  assert.doesNotThrow(() => { tracker.dispose() })
  assert.equal(remote.unsubscribes(), 1, 'the throwing disposer was actually invoked')
  assert.equal(resetUnsubscribes, 1, 'the NEXT disposer still runs after the first threw')
  assert.equal(h.warns.length, 1, 'failures warn exactly once per tracker lifetime')
  assert.match(h.warns[0] ?? '', /dispose/)
  assert.match(h.warns[0] ?? '', /goal\/activation-changed unsubscribe/)
  // 抛出不得跳过缓存清空 / disposed 守卫。
  assert.equal(tracker.activationOf('s1'), undefined, 'the activation cache is cleared despite the throw')
  remote.emit({ sessionId: 's1', goal: { id: goalA.goalId, revision: 1, activation: 'armed' } })
  assert.equal(tracker.activationOf('s1'), undefined, 'late deliveries after a throwing dispose are ignored')
  assert.doesNotThrow(() => { tracker.dispose() }, 'dispose stays idempotent after a failed cleanup')
  assert.equal(resetUnsubscribes, 1)
})

test('F11: a non-function onConnectionReset return is swallowed at dispose (warn-once, cleanup continues)', () => {
  const remote = createRemote()
  const h = createHarness({
    getRemote: () => remote,
    // 声明是 () => void，但运行期坏/旧实现可能返回任意非函数值；dispose 不得把它
    // 当真函数调用（否则 TypeError 从 cleanup 首行冒出）。
    onConnectionReset: () => 'not-a-disposer' as unknown as () => void,
  })
  const tracker = createGoalActivationTracker(h.deps)
  tracker.start()
  remote.emit({ sessionId: 's1', activation: 'armed' })
  assert.equal(tracker.activationOf('s1'), 'armed')
  assert.doesNotThrow(() => { tracker.dispose() })
  assert.equal(h.warns.length, 1, 'the non-function disposer is diagnosed exactly once')
  assert.match(h.warns[0] ?? '', /connection\/reset unsubscribe/)
  assert.match(h.warns[0] ?? '', /dispose/)
  assert.equal(remote.unsubscribes(), 1, 'the other cleanup step still ran')
  assert.equal(remote.count(), 0)
  assert.equal(tracker.activationOf('s1'), undefined)
  assert.doesNotThrow(() => { tracker.dispose() })
})

test('F11: dispose still cancels a pending retry timer when the reset disposer throws', () => {
  let resetUnsubscribes = 0
  const h = createHarness({
    getRemote: () => { throw new Error('service not ready') },
    maxSubscriptionAttempts: 5,
    onConnectionReset: () => () => {
      resetUnsubscribes += 1
      throw new Error('reset disposer exploded')
    },
  })
  const tracker = createGoalActivationTracker(h.deps)
  tracker.start()
  assert.equal(h.timers.pendingCount(), 1, 'the bounded retry is armed')
  assert.doesNotThrow(() => { tracker.dispose() })
  assert.equal(resetUnsubscribes, 1)
  assert.equal(h.timers.pendingCount(), 0, 'the retry timer is cancelled despite the throwing disposer')
  assert.equal(h.timers.runNext(), false, 'a disposed tracker never retries')
  assert.equal(h.warns.length, 1)
})

test('REGRESSION(B4-1): the activation cache is capped with LRU eviction, warn-once and a diagnostic count', () => {
  // 反例：连续 ghost sessionId 事件（从不出现在任何 report，因此 scan 永远删不到它们）
  // 会让 activations Map 无界增长（探针到 5000）。上限与 P2a 同量级（2000）。
  const remote = createRemote()
  const h = createHarness({ getRemote: () => remote })
  const tracker = createGoalActivationTracker(h.deps)
  tracker.start()
  const ghostId = (index: number): string => 'ghost-' + String(index).padStart(5, '0')
  for (let index = 0; index < MAX_ACTIVATION_CACHE; index += 1) {
    remote.emit({ sessionId: ghostId(index), activation: 'armed' })
  }
  assert.equal(tracker.snapshot().size, MAX_ACTIVATION_CACHE, '未超限前全部保留')
  assert.equal(tracker.evictedCount(), 0)

  // 第 MAX+1 个新 id：淘汰最旧键，缓存仍以 MAX 为界。
  remote.emit({ sessionId: ghostId(MAX_ACTIVATION_CACHE), activation: 'armed' })
  assert.equal(tracker.snapshot().size, MAX_ACTIVATION_CACHE, '超限后仍以 MAX 为界（回退即红：无界增长）')
  assert.equal(tracker.snapshot().has(ghostId(0)), false, '最旧键被淘汰（FIFO/LRU 的老端）')
  assert.equal(tracker.snapshot().has(ghostId(MAX_ACTIVATION_CACHE)), true, '新键保留')
  assert.equal(tracker.evictedCount(), 1, '淘汰有诊断计数（never silent）')
  assert.equal(h.warns.length, 1, '上限诊断 warn-once，不是每次淘汰都刷屏')
  assert.match(h.warns[0] ?? '', /reached its cap/)

  // LRU：更新一个旧键（值变化）把它移到最新端，下一轮溢出淘汰的应是它之后的最旧键。
  remote.emit({ sessionId: ghostId(1), activation: 'disarmed' })
  remote.emit({ sessionId: ghostId(MAX_ACTIVATION_CACHE + 1), activation: 'armed' })
  assert.equal(tracker.snapshot().size, MAX_ACTIVATION_CACHE)
  assert.equal(tracker.snapshot().has(ghostId(1)), true, '刚更新过的旧键按 LRU 保留')
  assert.equal(tracker.snapshot().has(ghostId(2)), false, '淘汰的是最久未更新的键')
  assert.equal(tracker.evictedCount(), 2)
  assert.equal(h.warns.length, 1, 'warn-once 仍只一条')
  tracker.dispose()
})
