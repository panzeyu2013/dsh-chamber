import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { projectBadgeCount } from '../../src/badge-count.ts'
// 徽标推送的有界重推链：hook 本体是 React 效果簇（node 测试不可渲染），链的调度
// 语义由 use-badge-count.ts 的 createBadgePushRetry 承载（纯注入缝，fake timer 直驱）。
import { createBadgePushRetry } from '../../src/app-hooks/use-badge-count.ts'
// INV7 同拍对拍：徽标消费的 goalActive 就是侧栏唯一谓词的结果，输入用
// subagentActivityOf 归一（零依赖叶模块，直测不引入 React）。
import {
  mergeRuntimeFacts,
  runtimeReportSignature,
  sessionRowState,
  subagentActivityOf,
  type GoalFact,
  type InstanceRuntimeReport,
  type SessionRowStateFacts,
} from '@dsh-chamber/dsh-chamber-client-core'

// ---- 空集 / 缺来源：0（清除）----

test('projectBadgeCount: empty and missing inputs are zero', () => {
  assert.equal(projectBadgeCount({}), 0)
  assert.equal(projectBadgeCount(undefined), 0)
  assert.equal(projectBadgeCount({ local: {} }), 0)
})

// ---- 单来源 ----

test('projectBadgeCount: counts only armed (true) sessions, ignores false entries', () => {
  assert.equal(
    projectBadgeCount({ local: { a: true, b: false, c: true } }),
    2,
  )
  assert.equal(projectBadgeCount({ local: { a: false, b: false } }), 0)
})

// ---- 跨来源求和（每来源各算各的，同 id 会话跨来源独立）----

test('projectBadgeCount: sums across sources', () => {
  assert.equal(
    projectBadgeCount({
      local: { a: true, b: true },
      'dsh-abc123': { c: true },
      'gateway-xyz789': { d: false },
    }),
    3,
  )
})

test('projectBadgeCount: same session id on different sources counts independently', () => {
  assert.equal(
    projectBadgeCount({
      local: { s: true },
      'dsh-abc123': { s: true },
    }),
    2,
  )
})

// ---- 阅读解除 / 重跑解除的镜像（蓝点状态怎么变，计数就怎么变）----

test('projectBadgeCount: reading-disarm and re-run disarm shrink the count', () => {
  const before = projectBadgeCount({ local: { a: true, b: true } })
  assert.equal(before, 2)
  // 正在阅读 → 解除（蓝点删除该会话）→ 计数回落。
  assert.equal(projectBadgeCount({ local: { b: true } }), 1)
  // 全部解除 → 0 = 清除徽标。
  assert.equal(projectBadgeCount({ local: {} }), 0)
})

// ---- 来源退役（channel clear 删除整来源）----

test('projectBadgeCount: a retired source drops its dots from the count', () => {
  const withSource = projectBadgeCount({
    local: { a: true },
    'dsh-abc123': { x: true, y: true },
  })
  assert.equal(withSource, 3)
  assert.equal(projectBadgeCount({ local: { a: true } }), 1)
})

// ---- 子代理压制（design 06 §4.5 / design 19 §3.7）：父回合结束但后台子代理
// 仍存活（调用方归一的 subagentActivity === 'running'）的会话不是完成未读——
// 窗口内蓝点被运行环压制、complete 通知被过滤，徽标必须同样不计（否则主分支闲置
// 等子代理时 Dock 误亮）。归一在 use-badge-count（subagentActivityOf：stale 的残留
// running 降 unknown、无子代理为 none）；子代理全部结束（none）后 armed 蓝点正常浮现。

test('projectBadgeCount: an armed session whose background subagents still run is not counted', () => {
  const completed = { local: { a: true, b: true } }
  // a 的父回合已结束但 2 个后台子代理仍在干活（06 §4.5 后台模式的源行
  // running=false + runningSubagents=2，经 subagentActivityOf 归一为 running）；
  // b 真完成（none）。只计 b。
  const facts = {
    local: {
      sessions: {
        a: { subagentActivity: subagentActivityOf({ running: false, runningSubagents: 2 }, false) },
        b: { subagentActivity: subagentActivityOf({ running: false }, false) },
      },
    },
  }
  assert.equal(projectBadgeCount(completed), 2)
  assert.equal(projectBadgeCount(completed, facts), 1)
})

test('projectBadgeCount: suppression is per session and per source', () => {
  const completed = {
    local: { a: true, b: true },
    'dsh-abc123': { x: true, y: true },
  }
  const facts = {
    local: { sessions: { a: { subagentActivity: subagentActivityOf({ runningSubagents: 1 }, false) } } },
    // x 有事实行且子代理存活 → 压制；y 无事实行 → 无压制信息不臆测，照计。
    'dsh-abc123': { sessions: { x: { subagentActivity: subagentActivityOf({ runningSubagents: 1 }, false) } } },
    // 无运行时事实通道快照的来源（gateway-xyz789）整体照常计入。
  }
  assert.equal(projectBadgeCount(completed, facts), 2) // b + y
  assert.equal(
    projectBadgeCount(completed, { ...facts, 'gateway-xyz789': { sessions: { z: { subagentActivity: subagentActivityOf({ runningSubagents: 3 }, false) } } } }),
    2, // b + y（z 未武装，无关）
  )
})

test('projectBadgeCount: armed dot counts again once all subagents finished (or the arg is omitted)', () => {
  const completed = { local: { a: true } }
  const whileRunning = { local: { sessions: { a: { subagentActivity: subagentActivityOf({ runningSubagents: 1 }, false) } } } }
  assert.equal(projectBadgeCount(completed, whileRunning), 0)
  // 子代理全部结束：稀疏计数归零 → 归一为 none → 蓝点正常浮现。
  const finished = { local: { sessions: { a: { subagentActivity: subagentActivityOf({ running: false }, false) } } } }
  assert.equal(projectBadgeCount(completed, finished), 1)
  // 无运行时事实参数 = 不压制（无压制通道的调用点不臆测）。
  assert.equal(projectBadgeCount(completed), 1)
})

test('projectBadgeCount: suppressed rows are still armed (count returns without re-arming work)', () => {
  // 同一武装账本在「子代理运行 → 结束」间的计数 0 → 1，状态机无任何变化：
  // 纯投影在行事实变化时自行收敛。
  const completed = { local: { a: true } }
  const reports = [
    { local: { sessions: { a: { subagentActivity: subagentActivityOf({ runningSubagents: 3 }, false) } } } },
    { local: { sessions: { a: { subagentActivity: subagentActivityOf({ runningSubagents: 1 }, false) } } } },
    { local: { sessions: { a: { subagentActivity: subagentActivityOf({}, false) } } } },
  ]
  assert.deepEqual(reports.map(report => projectBadgeCount(completed, report)), [0, 0, 1])
})

test('projectBadgeCount: an explicit zero runningSubagents row is NOT suppressed', () => {
  // 生产投影是稀疏的——derive.ts 只在 >0 时写 runningSubagents 键，显式 0 行
  // 不可达；但实现的 `?? 0` 兜底把 0 语义定为「无子代理存活 = 不压制」，此
  // 用例钉住该文档语义，防未来改判（0 必须照常计入）。
  const completed = { local: { a: true } }
  const none = { local: { sessions: { a: { subagentActivity: subagentActivityOf({ runningSubagents: 0 }, false) } } } }
  assert.equal(subagentActivityOf({ runningSubagents: 0 }, false), 'none')
  assert.equal(projectBadgeCount(completed, none), 1)
  const unknown = { local: { sessions: { a: { subagentActivity: 'unknown' as const } } } }
  assert.equal(projectBadgeCount(completed, unknown), 1)
})

// ---- 合并投影（裁决 14）：vendor-only completed 必须计入，
// 否则会出现「侧栏蓝点/待办有、Dock 徽标无」的诚实分叉。

test('projectBadgeCount: a vendor-armed completion counts even with no ledger entry', () => {
  const facts = { local: { sessions: { a: { completed: true } } } }
  assert.equal(projectBadgeCount(undefined, facts), 1)
  assert.equal(projectBadgeCount({}, facts), 1)
})

test('projectBadgeCount: the union never double-counts one session', () => {
  const ledger = { local: { a: true } }
  const facts = { local: { sessions: { a: { completed: true } } } }
  assert.equal(projectBadgeCount(ledger, facts), 1)
})

test('projectBadgeCount: vendor-only rows obey the same subagent suppression', () => {
  const facts = {
    local: { sessions: { a: { completed: true, subagentActivity: subagentActivityOf({ runningSubagents: 2 }, false) }, b: { completed: true } } },
  }
  assert.equal(projectBadgeCount({}, facts), 1, 'only b is a finished completion')
})

test('projectBadgeCount: an explicit false vendor flag does not arm', () => {
  const facts = { local: { sessions: { a: { completed: false } } } }
  assert.equal(projectBadgeCount({ local: {} }, facts), 0)
})

// ---- goal 呈现门（design 19 §3.2.1/§3.2.5）：目标相位 active（含
// activation unknown）期间被压制的完成不得点亮 Dock：呈现面看不到的蓝点，徽标
// 也不能计数。goalActive 由 use-badge-count 用 sidebar 的唯一谓词预计算传入
// （badge-count 保持零 import）。

test('projectBadgeCount: an active goal suppresses the armed completion (v5 §4)', () => {
  const completed = { local: { a: true, b: true } }
  const facts = {
    local: {
      sessions: {
        a: { goalActive: true },
        b: { goalActive: false },
      },
    },
  }
  assert.equal(projectBadgeCount(completed), 2, 'no suppression information = no suppression')
  assert.equal(projectBadgeCount(completed, facts), 1)
  // vendor-only 完成（无蓝点账本条目）同样受 goal 门压制。
  assert.equal(projectBadgeCount({}, { local: { sessions: { a: { completed: true, goalActive: true } } } }), 0)
  // goalActive 缺席（该来源没有 goal 通路 / goal unknown）= 无压制信息，照常计入。
  assert.equal(projectBadgeCount({ local: { a: true } }, { local: { sessions: { a: {} } } }), 1)
})

test('projectBadgeCount: goal suppression is per session and per source', () => {
  const completed = { local: { a: true }, 'dsh-abc': { x: true, y: true } }
  const facts = {
    local: { sessions: { a: { goalActive: true } } },
    'dsh-abc': { sessions: { x: { goalActive: true } } },
  }
  assert.equal(projectBadgeCount(completed, facts), 1, 'only the goal-free y is visible')
})

test('projectBadgeCount: a stale source never suppresses through the sparse count (stale guard)', () => {
  const completed = { local: { a: true } }
  // 断连来源的残留计数不是「正在干活」的证据：归一（subagentActivityOf）把同一源行
  // 在 stale 下报成 unknown，徽标只对 running 压制 → unknown 照常计入。
  const staleRow = { running: false, runningSubagents: 2 }
  assert.equal(subagentActivityOf(staleRow, true), 'unknown')
  const stale = { local: { sessions: { a: { subagentActivity: subagentActivityOf(staleRow, true) } } } }
  assert.equal(projectBadgeCount(completed, stale), 1)
  // 在线来源的同一残留计数归一为 running，仍压制。
  assert.equal(subagentActivityOf(staleRow, false), 'running')
  const live = { local: { sessions: { a: { subagentActivity: subagentActivityOf(staleRow, false) } } } }
  assert.equal(projectBadgeCount(completed, live), 0)
})

test('projectBadgeCount: a stale source keeps the goal presentation gate', () => {
  // stale 只把子代理残留计数降为 unknown；goal 呈现门按相位（active 即压制），
  // 断连不自愈——归一后的 stale 行仍带 goalActive: true，不因 unknown 而重现。
  const staleActivity = subagentActivityOf({ runningSubagents: 2 }, true)
  assert.equal(staleActivity, 'unknown')
  const staleActive = { local: { sessions: { a: { completed: true, goalActive: true, subagentActivity: staleActivity } } } }
  assert.equal(projectBadgeCount({ local: { a: true } }, staleActive), 0)
  const staleGoalFree = { local: { sessions: { a: { completed: true, goalActive: false, subagentActivity: staleActivity } } } }
  assert.equal(projectBadgeCount({ local: { a: true } }, staleGoalFree), 1)
})

// ---- F6 回归：stale-only 上报的去重链（签名 → 合并 → 徽标压制守卫）----
// use-bridge-subscriptions 用 runtimeReportSignature 去重运行时上报；签名不含
// report.stale 时「行不变、仅 stale 翻转」被吞，App 保留 live report，
// mergeRuntimeFacts 的 stale OR 失效——断连来源的残留子代理计数被当成 live，
// 蓝点被错误压制（计数 0）。本用例用同一组纯函数把这条链端到端钉住。

test('F6: a stale-only flip survives the runtime-report dedupe and keeps the badge honest', () => {
  const liveChannel: InstanceRuntimeReport = { sessions: { a: { running: false, runningSubagents: 2 } } }
  const staleChannel: InstanceRuntimeReport = { ...liveChannel, stale: true }
  // ①去重门必须看见翻转（签名相同的话下一条压根不会被提交，stale 永远不会到合并层）。
  assert.notEqual(runtimeReportSignature(liveChannel), runtimeReportSignature(staleChannel))
  // ②提交后的合并报告带 stale：残留子代理计数降为 unknown → 蓝点不再被压制。
  const merged = mergeRuntimeFacts(staleChannel, { a: true })
  assert.equal(merged?.stale, true)
  assert.equal(merged?.sessions.a?.subagentActivity, 'unknown')
  // 徽标侧只消费归一三值（use-badge-count 的 subagentActivityOf(row, stale)），
  // 这里用同一映射把 merge 后的报告折成压制输入；不再直传 stale/稀疏计数本身。
  const badgeFacts = (report: InstanceRuntimeReport) => ({
    local: { sessions: { a: { subagentActivity: subagentActivityOf(report.sessions.a, report.stale) } } },
  })
  assert.equal(projectBadgeCount({ local: { a: true } }, badgeFacts(merged!)), 1)
  // ③对照：未提交新 report（App 仍持 live）时同一账本被错误压制 —— F6 的可见后果。
  assert.equal(projectBadgeCount({ local: { a: true } }, badgeFacts(liveChannel)), 0)
})

test('projectBadgeCount agrees with sessionRowState on the completed row across goal/subagent/stale (INV7)', () => {
  const goals: Array<GoalFact | null | undefined> = [
    undefined,
    null,
    { goalId: 'g', revision: 1, phase: 'active' },
    { goalId: 'g', revision: 1, phase: 'active', activation: 'armed' },
    { goalId: 'g', revision: 1, phase: 'active', activation: 'disarmed' },
    { goalId: 'g', revision: 1, phase: 'complete' },
    { goalId: 'g', revision: 1, phase: 'paused' },
  ]
  for (const goal of goals) {
    for (const runningSubagents of [undefined, 1] as const) {
      for (const stale of [undefined, true] as const) {
        const rowFacts: SessionRowStateFacts = {
          running: false,
          completed: true,
          ...(runningSubagents === undefined ? {} : { runningSubagents }),
          ...(stale === undefined ? {} : { stale }),
          ...(goal === undefined ? {} : { goal }),
        }
        const row = sessionRowState(rowFacts)
        const badge = projectBadgeCount({ src: { s1: true } }, {
          src: {
            sessions: {
              s1: {
                completed: true,
                goalActive: row.goalActive,
                subagentActivity: subagentActivityOf(rowFacts, rowFacts.stale),
              },
            },
          },
        })
        assert.equal(
          badge,
          row.completedVisible ? 1 : 0,
          'badge/row diverged for goal=' + JSON.stringify(goal)
            + ' subagents=' + String(runningSubagents) + ' stale=' + String(stale),
        )
      }
    }
  }
})

// ---- 有界重推链（design 19 §3.7 / M4）：连续失败、取代与卸载 -----------------

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createBadgeTimers() {
  let nextId = 1
  const pending = new Map<number, () => void>()
  return {
    setTimer(callback: () => void, _ms: number): unknown {
      const id = nextId
      nextId += 1
      pending.set(id, () => {
        pending.delete(id)
        callback()
      })
      return id
    },
    clearTimer(handle: unknown): void {
      pending.delete(handle as number)
    },
    runNext(): boolean {
      const id = [...pending.keys()].sort((a, b) => a - b)[0]
      if (id === undefined) return false
      pending.get(id)?.()
      return true
    },
    pendingCount(): number {
      return pending.size
    },
  }
}

/** 让 push 的 reject 回调（微任务）跑完。 */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function createChain(options: {
  push?: (count: number) => Promise<unknown> | undefined
  timers: ReturnType<typeof createBadgeTimers>
  errors?: unknown[]
}) {
  return createBadgePushRetry({
    push: options.push ?? (() => undefined),
    setTimer: options.timers.setTimer,
    clearTimer: options.timers.clearTimer,
    warn: error => { options.errors?.push(error) },
  })
}

test('badge retry chain: consecutive rejections retry once each, then warn at exhaustion', async () => {
  const timers = createBadgeTimers()
  const calls: Array<{ count: number; pending: Deferred }> = []
  const errors: unknown[] = []
  const chain = createChain({
    timers,
    errors,
    push: count => {
      const pending = deferred()
      calls.push({ count, pending })
      return pending.promise
    },
  })
  chain.start(7, 1, 40)
  assert.deepEqual(calls.map(call => call.count), [7])
  assert.equal(timers.pendingCount(), 0, 'a push in flight has no timer yet')
  calls[0]!.pending.reject(new Error('ipc-1'))
  await settle()
  assert.equal(timers.pendingCount(), 1, 'the first rejection schedules exactly one retry timer')
  assert.equal(timers.runNext(), true)
  assert.deepEqual(calls.map(call => call.count), [7, 7])
  calls[1]!.pending.reject(new Error('ipc-2'))
  await settle()
  assert.equal(timers.pendingCount(), 0, 'attemptsLeft 0 = exhausted, no further timer')
  assert.equal(errors.length, 1, 'exhaustion warns exactly once')
  assert.equal(timers.runNext(), false)
})

test('badge retry chain: a newer start clears the pending timer and supersedes the in-flight chain', async () => {
  const timers = createBadgeTimers()
  const calls: Array<{ count: number; pending: Deferred }> = []
  const chain = createChain({
    timers,
    push: count => {
      const pending = deferred()
      calls.push({ count, pending })
      return pending.promise
    },
  })
  chain.start(1, 3, 40)
  const superseded = calls[0]!.pending
  // 旧链还在途时 effect 重跑（计数变化）：start 换代并清 pending。
  chain.start(2, 3, 40)
  assert.deepEqual(calls.map(call => call.count), [1, 2])
  superseded.reject(new Error('late rejection of the superseded chain'))
  await settle()
  assert.equal(timers.pendingCount(), 0, 'a superseded chain can never arm a timer')
  // 活链自己失败才排 timer，且链上只有一条。
  calls[1]!.pending.reject(new Error('ipc'))
  await settle()
  assert.equal(timers.pendingCount(), 1)
  assert.equal(timers.runNext(), true)
  assert.deepEqual(calls.map(call => call.count), [1, 2, 2])
})

test('badge retry chain: cancel clears the pending timer and stops an in-flight rejection (unmount)', async () => {
  const timers = createBadgeTimers()
  const calls: Array<{ count: number; pending: Deferred }> = []
  const chain = createChain({
    timers,
    push: count => {
      const pending = deferred()
      calls.push({ count, pending })
      return pending.promise
    },
  })
  chain.start(5, 3, 40)
  calls[0]!.pending.reject(new Error('ipc'))
  await settle()
  assert.equal(timers.pendingCount(), 1)
  chain.cancel()
  assert.equal(timers.pendingCount(), 0, 'unmount clears the pending retry timer')
  assert.equal(timers.runNext(), false)
  // 卸载后到达的 reject 不得再排 timer。
  chain.start(6, 3, 40)
  const late = calls[1]!.pending
  chain.cancel()
  late.reject(new Error('after unmount'))
  await settle()
  assert.equal(timers.pendingCount(), 0)
  // cancel 后重新 start（StrictMode 重挂）仍工作；成功不重推。
  chain.start(8, 1, 40)
  calls[2]!.pending.resolve()
  await settle()
  assert.deepEqual(calls.map(call => call.count), [5, 6, 8])
  assert.equal(timers.pendingCount(), 0)
})

test('badge retry chain: an absent bridge face never schedules a retry and never warns', async () => {
  const timers = createBadgeTimers()
  const chain = createChain({ timers, push: () => undefined })
  chain.start(0, 3, 40)
  await settle()
  assert.equal(timers.pendingCount(), 0)
})

test('badge retry chain: start reports whether it dispatched (the count-change gate may only commit on true)', async () => {
  const timers = createBadgeTimers()
  const calls: number[] = []
  const live = createChain({ timers, push: count => { calls.push(count); return Promise.resolve() } })
  assert.equal(live.start(0, 3, 40), true,
    'a dispatched push returns true — the hook commits pushedCountRef only on this value')
  assert.deepEqual(calls, [0])
  // 缺桥 / 版本偏斜（window.dshChamber.badge 缺失或没有 set）：push 返回 undefined，
  // 没有可重试的调用 ⇒ start 必须返回 false（调用方不得提交计数，下一次 effect 用同一计数重试）。
  const absent = createChain({ timers, push: () => undefined })
  assert.equal(absent.start(0, 3, 40), false, 'an absent bridge must not be reported as dispatched')
  assert.equal(absent.start(0, 3, 40), false, 'and the same count may be re-attempted until it dispatches')
  await settle()
  assert.equal(timers.pendingCount(), 0, 'nothing dispatched = no retry timer to arm')
})

/**
 * (h) 计数变化闸是 effect 内联逻辑，本包没有 React 渲染 harness（不为此引入第二套运行时）：
 * 用源码语义锁钉住「同计数不得二次 push」与「缺桥/版本偏斜时首推不被闸吞」。变异删掉
 * `pushedCountRef.current === count` 闸、或把提交改成无条件，本用例即红。
 */
test('badge count-change gate: same-count effects never re-push and a failed dispatch never commits', () => {
  const hook = readFileSync(
    fileURLToPath(new URL('../../src/app-hooks/use-badge-count.ts', import.meta.url)), 'utf8')
  const effect = hook.slice(hook.indexOf('const count = projectBadgeCount('), hook.indexOf('// 桥迟到的兜底'))
  assert.ok(effect.length > 0, 'the count projection effect must exist')
  const publishAt = effect.indexOf('publishBadgeCount(count)')
  // ① 闸：与上次真正推出去的计数相同 ⇒ 直接返回（runtimeFacts/completedBySource 换身份 4.8Hz 重推）。
  const gateAt = effect.indexOf('if (pushedCountRef.current === count) return')
  assert.notEqual(gateAt, -1, 'the count-change gate must exist (same count must not re-push)')
  // ② 提交：只有 start 真的派发（true）才提交；缺桥/版本偏斜（push 返回 undefined ⇒ start false）不提交，
  //    下一次 effect 用同一计数重试 —— 首个计数（含重载复位的 0）永不丢。
  const startAt = effect.indexOf('if (badgeRetry.start(count, retryLimit, retryMs)) pushedCountRef.current = count')
  assert.notEqual(startAt, -1, 'the commit must be conditional on start() returning true')
  assert.ok(publishAt !== -1 && publishAt < gateAt && gateAt < startAt,
    'order: publish the readback value, gate the duplicate, then dispatch')
  const commits = effect.match(/pushedCountRef\.current = count/g) ?? []
  assert.equal(commits.length, 1, 'the gate is committed exactly once, only behind the dispatched boolean')
  // ③ 桥面缺失/版本偏斜的 push 实现返回 undefined（typeof 守卫），start 因此对首推返回 false。
  assert.match(hook, /if \(badge === undefined \|\| typeof badge\.set !== 'function'\) return undefined/,
    'the push seam must degrade an absent/skewed bridge face to undefined, never throw')
})
