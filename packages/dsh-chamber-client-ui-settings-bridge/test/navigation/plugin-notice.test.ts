/**
 * 设置面板 header 的插件刷新事实条投影（design 15 §6）：只收可在此动作的插件集事实
 *（restart / 挂载失败），通道类、跨实例冲突与 ok 都不渲染；每条事实一个动作。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pluginNotice } from '../../src/client/plugin-notice.ts'

test('pluginNotice maps the actionable plugin-set facts and ignores the rest', () => {
  assert.deepEqual(
    pluginNotice({ state: 'restart-required', pluginId: '@scope/a', updatedAt: 1 }),
    { kind: 'restart', action: 'reload', pluginId: '@scope/a' },
  )
  // The writer's message is only a load-failure cause; restart carries locale copy.
  assert.deepEqual(
    pluginNotice({ state: 'bundle-load-failed', message: 'boom', updatedAt: 1 }),
    { kind: 'load-failed', action: 'retry', message: 'boom' },
  )
  // Cross-instance drift is a boot fact with no in-place action: its surface is the
  // connections page's per-instance diagnostic line, never this strip.
  assert.equal(
    pluginNotice({ state: 'instance-version-conflict', pluginId: '@scope/a', message: 'm', updatedAt: 1 }),
    undefined,
  )
  assert.equal(pluginNotice({ state: 'ok', updatedAt: 1 }), undefined)
  assert.equal(pluginNotice({ state: 'not-injected', updatedAt: 1 }), undefined)
  assert.equal(pluginNotice({ state: 'graph-unreachable', updatedAt: 1 }), undefined)
  assert.equal(pluginNotice(undefined), undefined)
})
