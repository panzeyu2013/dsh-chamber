/**
 * pluginDiagnosticText / pluginDiagnosticTone / bannerProjection unit tests —
 * the consumer-side severity decision for client-plugin runtime diagnostics
 * (design 09 §3.5): `instance-version-conflict` is informational (the page
 * reuses the first-loaded plugin revision and nothing in-app can switch it),
 * every other non-ok state is a problem. The card shows detail only for
 * problems; the plugin dialog always shows the full detail. bannerProjection
 * (plan 24 B1.4) de-duplicates the banner: title = short state name, detail
 * = message ?? pluginId ?? null — the triple repetition of state + pluginId
 * + message never reaches the screen. Mirror of the action-hint.test.ts
 * style: plain node:test, no dsh, no React.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bannerProjection, pluginDiagnosticText, pluginDiagnosticTone, type PluginDiagnostic } from '../src/client/plugin-diagnostic.ts'

/** Identity translator: the key itself is the observable contract. */
const t = (key: string): string => key

test('pluginDiagnosticTone: instance-version-conflict is informational, never a problem', () => {
  assert.equal(pluginDiagnosticTone('instance-version-conflict'), 'info')
  assert.equal(pluginDiagnosticTone('ok'), 'ok')
  for (const state of ['not-injected', 'graph-unreachable', 'bundle-load-failed', 'restart-required'] as const) {
    assert.equal(pluginDiagnosticTone(state), 'problem', state)
  }
})

test('pluginDiagnosticText: maps every state to its own locale key', () => {
  const expected: Readonly<Record<PluginDiagnostic['state'], string>> = {
    'ok': 'pluginDiagnosticOk',
    'not-injected': 'pluginDiagnosticNotInjected',
    'graph-unreachable': 'pluginDiagnosticGraphUnreachable',
    'bundle-load-failed': 'pluginDiagnosticBundleFailed',
    'restart-required': 'pluginDiagnosticRestartRequired',
    'instance-version-conflict': 'pluginDiagnosticInstanceVersionConflict',
  }
  for (const [state, key] of Object.entries(expected) as [PluginDiagnostic['state'], string][]) {
    assert.equal(pluginDiagnosticText(state, t), key)
  }
})

test('bannerProjection: the message is the single detail — the pluginId is never duplicated beside it', () => {
  const diagnostic: PluginDiagnostic = {
    state: 'bundle-load-failed',
    pluginId: '@deepseek-ai/dsh-demo',
    message: 'the bundle import was rejected',
  }
  assert.deepEqual(bannerProjection(diagnostic, t), {
    title: 'pluginDiagnosticBundleFailed',
    detail: 'the bundle import was rejected',
  })
})

test('bannerProjection: the pluginId stands in only when there is no message', () => {
  assert.deepEqual(bannerProjection({ state: 'bundle-load-failed', pluginId: '@deepseek-ai/dsh-demo' }, t), {
    title: 'pluginDiagnosticBundleFailed',
    detail: '@deepseek-ai/dsh-demo',
  })
  // An empty-string message counts as absent — never an empty detail line.
  assert.deepEqual(bannerProjection({ state: 'not-injected', pluginId: '@deepseek-ai/dsh-demo', message: '' }, t), {
    title: 'pluginDiagnosticNotInjected',
    detail: '@deepseek-ai/dsh-demo',
  })
})

test('bannerProjection: neither message nor pluginId → the bare state name, detail null', () => {
  assert.deepEqual(bannerProjection({ state: 'restart-required' }, t), {
    title: 'pluginDiagnosticRestartRequired',
    detail: null,
  })
})
