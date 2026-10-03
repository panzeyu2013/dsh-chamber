/**
 * 本页插件管理器动作结算边沿（插件刷新收敛的触发面）：vendor pending 谓词注入、
 * busy/enabling/相位覆盖、settled 携带动作开始时刻（restart 事实的 provenance 下限）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { InstallState } from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/manager-store.ts'
import {
  createPluginActionTracker, type PluginManagerActionSnapshot,
} from '../../src/client/plugin-action-tracker.ts'
import * as trackerModule from '../../src/client/plugin-action-tracker.ts'

const VENDOR_PENDING = new Set<InstallState['phase']>(['starting', 'running', 'cancelling', 'applying', 'unconfirmed'])
/** The truth table of vendor `isInstallPending`; the predicate is injected, never mirrored. */
const isPending = (phase: InstallState['phase']): boolean => VENDOR_PENDING.has(phase)

const ALL_PHASES: Array<InstallState['phase']> = [
  'idle', 'checking', 'starting', 'running', 'cancelling', 'applying', 'unconfirmed', 'unknown', 'done', 'failed',
]

const state = (over: Partial<PluginManagerActionSnapshot> = {}): PluginManagerActionSnapshot => ({
  busy: [],
  install: { phase: 'idle' },
  ...over,
})

test('the injected vendor predicate (plus busy/enabling) decides the in-flight bit per phase', () => {
  for (const phase of ALL_PHASES) {
    const tracker = createPluginActionTracker(isPending, () => 0)
    const transition = tracker.observe(state({ install: { phase } }))
    assert.equal(transition !== null, VENDOR_PENDING.has(phase), phase)
  }
  assert.notEqual(createPluginActionTracker(isPending, () => 0).observe(state({ busy: ['@scope/a'] })), null)
  assert.notEqual(
    createPluginActionTracker(isPending, () => 0).observe(state({ install: { phase: 'done', enabling: true } })),
    null,
  )
  // A DIFFERENT predicate changes the verdict: proof the set is not restated in this package.
  const neverPending = (): boolean => false
  assert.equal(createPluginActionTracker(neverPending, () => 0).observe(state({ install: { phase: 'running' } })), null)
})

test('the tracker reports one started/settled edge and the settled edge carries the action start', () => {
  let clock = 100
  const tracker = createPluginActionTracker(isPending, () => clock)
  assert.equal(tracker.observe(state()), null)
  clock = 200
  assert.deepEqual(tracker.observe(state({ busy: ['@scope/a'] })), { kind: 'started' })
  clock = 250
  assert.equal(tracker.observe(state({ busy: ['@scope/a'] })), null)
  clock = 300
  assert.deepEqual(tracker.observe(state()), { kind: 'settled', startedAt: 200 })
  assert.equal(tracker.observe(state()), null)
  // Install dialog: starting → done settles once, with the start of THAT action;
  // enabling the installed bundle is its own action.
  clock = 400
  assert.deepEqual(tracker.observe(state({ install: { phase: 'starting' } })), { kind: 'started' })
  clock = 500
  assert.deepEqual(tracker.observe(state({ install: { phase: 'done' } })), { kind: 'settled', startedAt: 400 })
  clock = 600
  assert.deepEqual(tracker.observe(state({ install: { phase: 'done', enabling: true } })), { kind: 'started' })
  clock = 700
  assert.deepEqual(tracker.observe(state({ install: { phase: 'done' } })), { kind: 'settled', startedAt: 600 })
})

test('the in-flight predicate is not exported (only the tracker owns the edge)', () => {
  assert.equal('pluginActionInFlight' in trackerModule, false)
})
