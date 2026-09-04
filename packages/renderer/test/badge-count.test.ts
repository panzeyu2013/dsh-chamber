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
