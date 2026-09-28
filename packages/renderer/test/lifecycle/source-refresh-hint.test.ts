/**
 * 行刷新提示的可见性 + 四拒 + 1s floor 契约。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SOURCE_REFRESH_HINT_FLOOR_MS, shouldDispatchRefreshHint } from '../../src/source-refresh-hint.ts'

function input(overrides = {}) {
  return { connected: true, unverified: false, inFlight: false, visible: true, lastHintAt: undefined, now: 10_000, ...overrides }
}

test('the floor is the documented 1s', () => {
  assert.equal(SOURCE_REFRESH_HINT_FLOOR_MS, 1_000)
})

test('a connected, verified, idle source passes the first hint', () => {
  assert.equal(shouldDispatchRefreshHint(input()), true)
})

test('disconnected / unverified / in-flight each reject', () => {
  assert.equal(shouldDispatchRefreshHint(input({ connected: false })), false)
  assert.equal(shouldDispatchRefreshHint(input({ unverified: true })), false)
  assert.equal(shouldDispatchRefreshHint(input({ inFlight: true })), false)
})

test('a hidden page rejects and a visible page passes (absent defaults to the conservative true)', () => {
  assert.equal(shouldDispatchRefreshHint(input({ visible: false })), false)
  assert.equal(shouldDispatchRefreshHint(input({ visible: false, lastHintAt: 9_000 })), false,
    'visibility is a rejection, not a floor input')
  assert.equal(shouldDispatchRefreshHint(input({ visible: true })), true)
  assert.equal(shouldDispatchRefreshHint(input({ visible: undefined })), true, '缺省按 true 保守')
})

test('the floor boundary is inclusive and a skewed clock never passes', () => {
  assert.equal(shouldDispatchRefreshHint(input({ lastHintAt: 9_000 })), true)
  assert.equal(shouldDispatchRefreshHint(input({ lastHintAt: 9_001 })), false)
  assert.equal(shouldDispatchRefreshHint(input({ lastHintAt: 10_000 })), false)
  assert.equal(shouldDispatchRefreshHint(input({ lastHintAt: 20_000 })), false)
  assert.equal(shouldDispatchRefreshHint(input({ lastHintAt: 9_000 }), 500), true)
  assert.equal(shouldDispatchRefreshHint(input({ lastHintAt: 9_800 }), 500), false)
})
