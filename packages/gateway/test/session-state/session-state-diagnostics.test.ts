/**
 * Watcher self-diagnostics（仪表 I6/I16）：描述符上的加法诊断字段必须
 * 真实反映「丢帧/重连/follow 失败/分类构成」，让客户端与验收仪器**看见**而不是
 * 从沉默里推断；同时它必须是纯加法——不认识它的客户端读到的东西一字不变。
 *
 * Run directly:
 *   node --import ./test/session-state/workspace-loader.mjs test/session-state/session-state-diagnostics.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROTOCOL_VERSION } from '@dsh-chamber/control-plane'
import {
  MAX_PENDING_GOAL_ACTIVATIONS,
  createChamberSessionState,
  type SessionStateObserverStatus,
} from '../../src/session-state.ts'
import { FakeRequest, FakeResponse } from '../support/utils.ts'
import { baselineItem, sessionSurfaceFor } from './harness.ts'

let activeSurface: ReturnType<typeof createChamberSessionState>

/** Session-state surface harness (shared factory). */
function surfaceFor(t: { after(fn: () => void): void }, observerOverrides: Partial<SessionStateObserverStatus> = {}) {
  return sessionSurfaceFor(t, { observerOverrides })
}

async function get(): Promise<Record<string, unknown>> {
  const req = new FakeRequest('GET', '/chamber/session-state', {})
  const res = new FakeResponse()
  const pending = activeSurface.handle(req as never, res as never, '/chamber/session-state')
  req.emit('end')
  await pending
  return res.json() as Record<string, unknown>
}

test('the descriptor carries the additive diagnostics field with the documented shape', async t => {
  const harness = surfaceFor(t, { eventsReceived: 7, baselines: 2, reconnects: 3, followReads: 4, followFailures: 1, heldWaterfalls: 1, degraded: true })
  harness.store.applyBaseline([baselineItem('s1', true, 5)], { at: 100 })
  activeSurface = harness.surface
  const body = await get()
  // 纯加法：既有字段一个不少。
  assert.equal(body.protocol, PROTOCOL_VERSION)
  assert.ok(Array.isArray(body.features))
  assert.equal(body.mode, 'sse')
  assert.ok(Array.isArray(body.sessions))
  assert.ok(body.read !== undefined)
  const diagnostics = body.diagnostics as Record<string, unknown>
  assert.equal(diagnostics.eventsReceived, 7)
  assert.equal(diagnostics.lastEventAt, 950)
  assert.equal(diagnostics.baselines, 2)
  assert.equal(diagnostics.reconnects, 3)
  assert.equal(diagnostics.followReads, 4)
  assert.equal(diagnostics.followFailures, 1)
  assert.equal(diagnostics.heldWaterfalls, 1)
  assert.equal(diagnostics.degraded, true)
  assert.deepEqual(diagnostics.turnEnds, { completed: 0, userStopped: 0, neutral: 0, unreadable: 0 })
  assert.deepEqual(diagnostics.dropped, { sessions: 0, readClients: 0, readMarks: 0, goalActivations: 0 })
  assert.equal(typeof diagnostics.cursor, 'number')
})

test('turnEnds counts each settled edge by classification (I16: one follow per edge)', async t => {
  const harness = surfaceFor(t)
  activeSurface = harness.surface
  harness.store.applyStatus('s1', true, 10)
  harness.store.applyStatus('s1', false, 20)
  harness.store.settleCompletion('s1', { at: 20, turnEnd: { kind: 'completed', cause: null, at: 20, seq: 1 }, source: 'observed', unreadable: false })
  harness.store.applyStatus('s2', true, 10)
  harness.store.applyStatus('s2', false, 20)
  harness.store.settleCompletion('s2', { at: 20, turnEnd: { kind: 'aborted', cause: 'user', at: 20, seq: 2 }, source: 'observed', unreadable: false })
  harness.store.applyStatus('s3', true, 10)
  harness.store.applyStatus('s3', false, 20)
  harness.store.settleCompletion('s3', { at: 20, turnEnd: { kind: 'blocked', cause: null, at: 20, seq: 3 }, source: 'observed', unreadable: false })
  harness.store.applyStatus('s4', true, 10)
  harness.store.applyStatus('s4', false, 20)
  harness.store.settleCompletion('s4', { at: 20, turnEnd: null, source: 'observed', unreadable: true })
  const diagnostics = (await get()).diagnostics as { turnEnds: Record<string, number> }
  assert.deepEqual(diagnostics.turnEnds, { completed: 1, userStopped: 1, neutral: 1, unreadable: 1 })
})

test('store losses stay visible in the diagnostics (dropped counters pass through)', async t => {
  const harness = surfaceFor(t)
  activeSurface = harness.surface
  const diagnostics = (await get()).diagnostics as { dropped: Record<string, number> }
  // 未注入任何溢出时全 0（既不遗漏也不臆造）。
  assert.deepEqual(diagnostics.dropped, { sessions: 0, readClients: 0, readMarks: 0, goalActivations: 0 })
  assert.ok(harness.store.status().dropped !== undefined)
})

test('the P2a retained-edge eviction counter rides diagnostics.dropped (sub-key + negative control)', async t => {
  const harness = surfaceFor(t)
  activeSurface = harness.surface
  for (let index = 0; index <= MAX_PENDING_GOAL_ACTIVATIONS; index += 1) {
    harness.store.applyGoalActivation({ sessionId: 'diag-' + String(index), goalId: 'goal-1', activation: 'armed' }, 100 + index)
  }
  const diagnostics = (await get()).diagnostics as { dropped: Record<string, number> }
  assert.deepEqual(
    Object.keys(diagnostics.dropped).sort(),
    ['goalActivations', 'readClients', 'readMarks', 'sessions'],
    'the additive P2a counter is part of the declared dropped shape',
  )
  assert.equal(diagnostics.dropped.goalActivations, 1, 'the cap eviction is visible on the wire, never silent')
  // 负控制：同一子键闸门必须拒绝三键旧形状。
  assert.throws(
    () => assert.deepEqual(
      Object.keys({ sessions: 0, readClients: 0, readMarks: 0 }).sort(),
      Object.keys(diagnostics.dropped).sort(),
      'mutant dropped without goalActivations',
    ),
    /mutant dropped without goalActivations/,
  )
})
