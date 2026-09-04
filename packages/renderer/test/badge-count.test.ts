import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectBadgeCount } from '../src/badge-count.ts'

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
// 仍存活（runningSubagents > 0）的会话不是完成未读——窗口内蓝点被运行环压制、
// complete 通知被过滤，徽标必须同样不计（否则主分支闲置等子代理时 Dock 误亮）。
// 压制信息来自最新运行时事实行；子代理全部结束后 armed 蓝点正常浮现计入。

test('projectBadgeCount: an armed session whose background subagents still run is not counted', () => {
  const completed = { local: { a: true, b: true } }
  // a 的父回合已结束但 2 个后台子代理仍在干活（06 §4.5 后台模式，running=false
  // + runningSubagents 稀疏行）；b 真完成。只计 b。
  const facts = {
    local: {
      sessions: {
        a: { running: false, runningSubagents: 2 },
        b: { running: false },
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
    local: { sessions: { a: { runningSubagents: 1 } } },
    // x 有事实行且子代理存活 → 压制；y 无事实行 → 无压制信息不臆测，照计。
    'dsh-abc123': { sessions: { x: { runningSubagents: 1 } } },
    // 无运行时事实通道快照的来源（gateway-xyz789）整体照旧计入。
  }
  assert.equal(projectBadgeCount(completed, facts), 2) // b + y
  assert.equal(
    projectBadgeCount(completed, { ...facts, 'gateway-xyz789': { sessions: { z: { runningSubagents: 3 } } } }),
    2, // b + y（z 未武装，无关）
  )
})

test('projectBadgeCount: armed dot counts again once all subagents finished (or the arg is omitted)', () => {
  const completed = { local: { a: true } }
  const whileRunning = { local: { sessions: { a: { runningSubagents: 1 } } } }
  assert.equal(projectBadgeCount(completed, whileRunning), 0)
  // 子代理全部结束：runningSubagents 从行上消失（稀疏）→ 蓝点正常浮现。
  const finished = { local: { sessions: { a: { running: false } } } }
  assert.equal(projectBadgeCount(completed, finished), 1)
  // 无运行时事实参数 = 旧语义（无压制通道的调用点不臆测）。
  assert.equal(projectBadgeCount(completed), 1)
})

test('projectBadgeCount: suppressed rows are still armed (count returns without re-arming work)', () => {
  // 同一武装账本在「子代理运行 → 结束」间的计数 0 → 1，状态机无任何变化：
  // 纯投影在行事实变化时自行收敛。
  const completed = { local: { a: true } }
  const reports = [
    { local: { sessions: { a: { runningSubagents: 3 } } } },
    { local: { sessions: { a: { runningSubagents: 1 } } } },
    { local: { sessions: { a: {} } } },
  ]
  assert.deepEqual(reports.map(report => projectBadgeCount(completed, report)), [0, 0, 1])
})
