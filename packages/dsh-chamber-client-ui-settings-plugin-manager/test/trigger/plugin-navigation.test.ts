/**
 * pluginNavigation provider (`plugin-navigation.ts`): openList/openBundle queue a page
 * target and surface the settings dialog. Either consumer may arrive late (both peers
 * are deferred chunks), so a queued request must never be dropped or thrown.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPluginNavigation, type PluginNavigationTarget,
} from '../../src/client/plugin-navigation.ts'

test('the provider exposes exactly openList and openBundle', () => {
  const navigation = createPluginNavigation({ openSection: () => true })
  assert.deepEqual(Object.keys(navigation.provider).sort(), ['openBundle', 'openList'])
})

test('a request before the page store exists applies on attach', () => {
  const opens: string[] = []
  const navigation = createPluginNavigation({
    openSection: () => { opens.push('open'); return true },
  })
  navigation.provider.openList()
  assert.deepEqual(opens, ['open'], 'the dialog half is requested even before the store binds')
  const targets: PluginNavigationTarget[] = []
  const detach = navigation.attach((target) => { targets.push(target) })
  assert.deepEqual(targets, ['list'])
  navigation.provider.openBundle('@deepseek-ai/plugin')
  assert.deepEqual(targets, ['list', { kind: 'package', name: '@deepseek-ai/plugin' }])
  detach()
  navigation.provider.openList()
  assert.equal(targets.length, 2, 'a detached store receives nothing; the target queues again')
})

test('an absent seat keeps the open queued until retryOpen flushes it once', () => {
  let present = false
  let opens = 0
  const navigation = createPluginNavigation({
    openSection: () => { if (present) opens += 1; return present },
  })
  navigation.provider.openList()
  assert.equal(opens, 0)
  present = true
  navigation.retryOpen()
  assert.equal(opens, 1)
  navigation.retryOpen()
  assert.equal(opens, 1, 'a flushed open is not repeated')
})

test('a later successful request clears a previously queued open', () => {
  let present = false
  let opens = 0
  const navigation = createPluginNavigation({
    openSection: () => { if (present) opens += 1; return present },
  })
  navigation.provider.openList()
  assert.equal(opens, 0)
  present = true
  navigation.provider.openList()
  assert.equal(opens, 1)
  navigation.retryOpen()
  assert.equal(opens, 1, 'the queued open was cleared by the successful request')
})

test('the latest target wins while the store is absent', () => {
  const navigation = createPluginNavigation({ openSection: () => true })
  navigation.provider.openBundle('first')
  navigation.provider.openList()
  const targets: PluginNavigationTarget[] = []
  navigation.attach((target) => { targets.push(target) })
  assert.deepEqual(targets, ['list'])
})
