/**
 * The bridge's refusal projection (design 21 §5.1/§5.2).
 *
 * The classifier and the verbatim-error projection are single-sourced in the
 * client-core face (src/shared/runtime-refusal.ts); what stays bridge-local
 * is the dictionary mapping and its wording, so this file asserts exactly that:
 * the delegation, the localized sentence with {code}, and the bridge
 * dictionaries' placeholders. No cross-package import.
 *
 * Run directly: node packages/dsh-chamber-client-ui-settings-bridge/test/runtime/restart-refusal.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bridgeRestartRefusalText,
  classifyBridgeRestartRefusal,
} from '../../src/client/restart-refusal.ts'
import { en, zh } from '../../src/locales.ts'

const BODIES: Array<[number, unknown]> = [
  [409, { error: 'managed dsh is not running (stopped); start the managed dsh first', code: 'runtime_busy' }],
  [409, { error: 'a restart is already in flight', code: 'runtime_busy' }],
  [409, { code: 'runtime_busy' }],
  [409, null],
  [400, { error: 'bad request' }],
  [503, null],
]

test('the bridge classifier is the shared classifier (delegation stays total)', () => {
  for (const [status, body] of BODIES) {
    const verdict = classifyBridgeRestartRefusal(body, status)
    assert.equal(verdict === null ? null : verdict.kind, status === 409 ? (body as { error?: unknown })?.error === 'managed dsh is not running (stopped); start the managed dsh first' ? 'not-running' : 'busy' : null, JSON.stringify(body))
  }
})

test('a 409 renders the localized sentence with {code}, never the server body as-is', () => {
  for (const [status, body] of BODIES.filter(([code]) => code === 409)) {
    const serverError = (body as { error?: unknown } | null | undefined)?.error
    for (const dictionary of [zh, en]) {
      const text = bridgeRestartRefusalText(body, status, key => dictionary[key])
      assert.notEqual(text.trim(), '')
      // The projection always carries the code (the status stands in when the body had none).
      assert.match(text, /409|runtime_busy|runtime_recovery_required/u, JSON.stringify(body))
      if (typeof serverError === 'string' && serverError !== '') {
        assert.notEqual(text, serverError, 'a 409 body is never projected verbatim')
      }
    }
    // zh carries no English server phrasing at all.
    assert.doesNotMatch(bridgeRestartRefusalText(body, status, key => zh[key]), /is not running|already in flight|managed dsh/u, JSON.stringify(body))
  }
})

test('a non-409 refusal keeps the verbatim error, else the status anchor', () => {
  assert.equal(bridgeRestartRefusalText({ error: 'bad request' }, 400, key => zh[key]), 'bad request')
  assert.equal(bridgeRestartRefusalText(null, 503, key => zh[key]), 'restart refused (503)')
})

test('both bridge dictionaries carry the refusal keys with a {code} placeholder', () => {
  for (const key of ['dshRuntimeRestartRefusedNotRunning', 'dshRuntimeRestartRefusedBusy'] as const) {
    assert.match(zh[key], /\{code\}/u, 'zh ' + key)
    assert.match(en[key], /\{code\}/u, 'en ' + key)
    assert.notEqual(zh[key].trim(), '')
    assert.notEqual(en[key].trim(), '')
  }
})
