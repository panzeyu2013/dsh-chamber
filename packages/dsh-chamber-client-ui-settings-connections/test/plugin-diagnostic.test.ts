/**
 * pluginDiagnosticText / pluginDiagnosticTone unit tests — the consumer-side
 * severity decision for client-plugin runtime diagnostics (design 09 §3.5):
 * `instance-version-conflict` is informational (the page reuses the
 * first-loaded plugin revision and nothing in-app can switch it), every other
 * non-ok state is a problem. The card shows detail only for problems; the
 * plugin dialog always shows the full detail. Mirror of the action-hint.test.ts
 * style: plain node:test, no dsh, no React.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pluginDiagnosticText, pluginDiagnosticTone, type PluginDiagnostic } from '../src/client/plugin-diagnostic.ts'

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
