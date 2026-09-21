/**
 * Cross-package lockstep for the gateway restart 409 projection (2026-12 audit
 * P1-2): settings-bridge keeps a bridge-local copy of the classifier because the
 * two plugins cannot share code; this test drives BOTH modules over one body
 * matrix and asserts identical verdicts, and both dictionary copies carry the
 * same placeholders in zh and en. It is the price of the duplicate — the two
 * implementations may never drift.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRuntimeRefusal, runtimeRefusalText, serverRefusalText,
} from '../../src/client/managed-restart.ts';
import { zh } from '../../src/locales.ts';
import {
  bridgeRestartRefusalText, classifyBridgeRestartRefusal,
} from '../../../dsh-chamber-client-ui-settings-bridge/src/client/restart-refusal.ts';
import { en as bridgeEn, zh as bridgeZh } from '../../../dsh-chamber-client-ui-settings-bridge/src/locales.ts';
import type { RuntimeRefusalKey } from '../../src/client/managed-restart.ts';

/** [status, body] pairs both classifiers must agree on. */
const BODIES: Array<[number, unknown]> = [
  [409, { error: 'managed dsh is not running (stopped); start the managed dsh first', code: 'runtime_busy' }],
  [409, { error: 'a restart is already in flight', code: 'runtime_busy' }],
  [409, { error: 'another runtime mutation holds the profile write lease', code: 'runtime_busy' }],
  [409, { error: 'runtime recovery is required', code: 'runtime_recovery_required' }],
  [409, { code: 'runtime_busy' }],
  [409, { error: 42 }],
  [409, null],
  [400, { error: 'bad request' }],
  [500, { error: 'gateway exploded' }],
  [503, null],
];

const tCon = (key: RuntimeRefusalKey): string => zh[key]
const tBridge = (key: 'dshRuntimeRestartRefusedNotRunning' | 'dshRuntimeRestartRefusedBusy'): string => bridgeZh[key]

test('both classifiers return the same family/code for every body', () => {
  for (const [status, body] of BODIES) {
    assert.deepEqual(
      classifyBridgeRestartRefusal(body, status),
      classifyRuntimeRefusal(body, status),
      `${status} ${JSON.stringify(body)}`,
    )
  }
})

test('a non-409 refusal keeps byte-identical text on both sides (verbatim error or status anchor)', () => {
  for (const [status, body] of BODIES.filter(([code]) => code !== 409)) {
    assert.equal(bridgeRestartRefusalText(body, status, tBridge), serverRefusalText(body, status), String(status))
  }
})

test('a 409 renders a localized sentence with {code} on both sides, never the server English', () => {
  for (const [status, body] of BODIES.filter(([code]) => code === 409)) {
    const con = runtimeRefusalText(body, status, { notRunning: 'restartRefusedNotRunning', busy: 'restartRefusedBusy' }, tCon)
    const bridge = bridgeRestartRefusalText(body, status, tBridge)
    assert.match(con, /409/u, JSON.stringify(body))
    assert.match(bridge, /409/u, JSON.stringify(body))
    assert.doesNotMatch(bridge, /restart refused|is not running|already in flight/iu, JSON.stringify(body))
    const refusal = classifyRuntimeRefusal(body, status)
    assert.equal(con.includes(refusal?.code ?? String(status)), true)
    assert.equal(bridge.includes(refusal?.code ?? String(status)), true)
  }
})

test('both dictionaries carry the refusal keys with a {code} placeholder in zh and en', () => {
  for (const key of ['dshRuntimeRestartRefusedNotRunning', 'dshRuntimeRestartRefusedBusy'] as const) {
    assert.match(bridgeZh[key], /\{code\}/u, key)
    assert.match(bridgeEn[key], /\{code\}/u, key)
    assert.notEqual(bridgeZh[key].trim(), '')
    assert.notEqual(bridgeEn[key].trim(), '')
  }
})
