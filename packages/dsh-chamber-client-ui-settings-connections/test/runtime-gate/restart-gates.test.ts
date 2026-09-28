/**
 * Gateway restart surface tests (design 21 §5.1/§5.3/§6.3/§6.8 r1):
 * managed-restart.ts result/refusal classification plus the connections-card
 * RESTART gate / PROBE projection / 409 localization built on it. Plain node:test,
 * no dsh, no React — the poll errors under test are the English strings thrown by
 * the client-core pollGatewayReady (gateway-runtime-poll.ts); the unlocalized copy
 * is the accepted projection (design 21 §7).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRestartError, serverRefusalText, applyRuntimeProbe, classifyGatewayReadFence, classifyRuntimeRefusal, gatewayReadFenceText, runtimeBlocksRestart, runtimeRefusalText } from '../../src/client/managed-restart.ts';
import { classifyRuntimeRefusal as coreClassifyRuntimeRefusal, serverRefusalText as coreServerRefusalText } from '@dsh-chamber/dsh-chamber-client-core';
import { en, zh } from '../../src/locales.ts';
import { FENCE_BODY } from '../support/fixtures.ts';

test('classifyRestartError: the poll timeout is accepted-timeout with an empty detail', () => {
  const result = classifyRestartError(new Error('restart accepted but the gateway did not reach ready in time'))
  assert.deepEqual(result, { kind: 'accepted-timeout', detail: '' })
})

test('classifyRestartError: a poll failure is failed with the trimmed thrown message as detail', () => {
  const result = classifyRestartError(new Error('restart failed: spawn probe timed out'))
  assert.deepEqual(result, { kind: 'failed', detail: 'restart failed: spawn probe timed out' })
})

test('classifyRestartError: whitespace around a thrown message is trimmed', () => {
  const result = classifyRestartError(new Error('  restart failed: boom  '))
  assert.deepEqual(result, { kind: 'failed', detail: 'restart failed: boom' })
})

test('classifyRestartError: a non-Error throw input is failed with its stringified value', () => {
  assert.deepEqual(classifyRestartError('boom'), { kind: 'failed', detail: 'boom' })
  assert.deepEqual(classifyRestartError(undefined), { kind: 'failed', detail: 'undefined' })
})

test('serverRefusalText / classifyRuntimeRefusal are the single-sourced core re-exports (no rule copy)', () => {
  // Absolute behavior (body table, code shapes, word boundaries) is owned by
  // sidebar test/shared/runtime-refusal.test.ts. This file only pins that the two
  // names are the core objects themselves: a local re-implementation — which would
  // silently drift from the route table — fails this identity check at once.
  assert.equal(serverRefusalText, coreServerRefusalText)
  assert.equal(classifyRuntimeRefusal, coreClassifyRuntimeRefusal)
})

/* ------------------------------------------------------------------ */
/* 1. The restart gate mirrors the core route                          */
/* ------------------------------------------------------------------ */

test('runtimeBlocksRestart: only ready/degraded pass, an absent probe never blocks', () => {
  // The route gate accepts exactly these two (runtime-routes.ts /restart).
  assert.equal(runtimeBlocksRestart('ready'), false)
  assert.equal(runtimeBlocksRestart('degraded'), false)
  // Terminal states: the recovery surface is /chamber/runtime/start.
  for (const state of ['stopped', 'error', 'restart-exhausted']) {
    assert.equal(runtimeBlocksRestart(state), true, state)
  }
  // Transitional states are refused by the same route gate — they are not a
  // "maybe": the click would 409.
  for (const state of ['starting', 'connecting', 'restarting']) {
    assert.equal(runtimeBlocksRestart(state), true, state)
  }
  // An unanswered probe (never probed, or the answer was discarded) must not
  // disable anything: a missing probe never hides a healthy source.
  assert.equal(runtimeBlocksRestart(undefined), false)
  assert.equal(runtimeBlocksRestart(null), false)
  assert.equal(runtimeBlocksRestart(''), false)
})

/* ---- 2. The probe projection: an unavailable probe DELETES the entry ---- */

test('applyRuntimeProbe: a known state writes the entry, an unchanged state keeps the same object', () => {
  const start: Record<string, string | undefined> = {}
  const probed = applyRuntimeProbe(start, 'a', 'stopped')
  assert.deepEqual(probed, { a: 'stopped' })
  assert.notEqual(probed, start, 'a new state must produce a new object (React re-render)')
  assert.equal(applyRuntimeProbe(probed, 'a', 'stopped'), probed, 'a same-value probe must not re-render')
  assert.deepEqual(applyRuntimeProbe(probed, 'b', 'ready'), { a: 'stopped', b: 'ready' },
    'per-card entries never alias another card')
})

test('applyRuntimeProbe: an unavailable probe (null) DELETES the entry instead of keeping a stale value', () => {
  const stale: Record<string, string | undefined> = { a: 'stopped', b: 'ready' }
  const cleared = applyRuntimeProbe(stale, 'a', null)
  assert.deepEqual(cleared, { b: 'ready' },
    'a failed probe must clear the card: a stale stopped/error kept「启动实例」alive and every click 409ed')
  assert.notEqual(cleared, stale)
  assert.equal(applyRuntimeProbe(cleared, 'a', null), cleared,
    'deleting a missing entry is a no-op (same object, no re-render)')
  assert.equal(applyRuntimeProbe({}, 'a', null).a, undefined)
})

/* ---- 3. 409 refusals: classified, then localized ---- */

test('runtimeRefusalText: a 409 becomes localized copy with the code; every other status stays verbatim', () => {
  const keys = { notRunning: 'restartRefusedNotRunning', busy: 'restartRefusedBusy' } as const
  const dictionary: Record<string, string> = {
    restartRefusedNotRunning: '重启被拒绝：托管 dsh 未在运行（409 {code}）——请改用「启动实例」',
    restartRefusedBusy: '重启被拒绝：运行时正忙或正在恢复（409 {code}），请稍后重试',
  }
  const t = (key: string): string => dictionary[key] ?? key

  const notRunning = runtimeRefusalText(
    { error: 'managed dsh is not running (stopped); start the managed dsh', code: 'runtime_busy' }, 409, keys, t)
  assert.equal(notRunning, '重启被拒绝：托管 dsh 未在运行（409 runtime_busy）——请改用「启动实例」')

  const busy = runtimeRefusalText({ error: 'a restart is already in flight', code: 'runtime_busy' }, 409, keys, t)
  assert.equal(busy, '重启被拒绝：运行时正忙或正在恢复（409 runtime_busy），请稍后重试')

  const noCode = runtimeRefusalText(null, 409, keys, t)
  assert.equal(noCode, '重启被拒绝：运行时正忙或正在恢复（409 409），请稍后重试',
    'a body-less 409 still renders localized copy (the status stands in for the missing code)')

  // Non-409 refusals keep the verbatim projection (English copy is the accepted
  // projection, design 21 §7) — never the 409 copy.
  assert.equal(runtimeRefusalText({ error: 'version is required' }, 400, keys, t), 'version is required')
  assert.equal(runtimeRefusalText(null, 400, keys, t), serverRefusalText(null, 400))
})

/* ---- 4. The READ-side fence (design 21 §6.2 读/写面共享栅栏) ---- */

test('classifyGatewayReadFence: only the 409 fence family is classified, with the server code', () => {
  // The SAME 409 classifier as the runtime actions — one taxonomy, not two.
  assert.deepEqual(classifyGatewayReadFence(FENCE_BODY, 409), { code: 'runtime_busy' })
  assert.deepEqual(classifyGatewayReadFence(null, 409), { code: null },
    'a body-less 409 is still the fence: the read is busy, not failed')
  assert.deepEqual(classifyGatewayReadFence({ code: 42 }, 409), { code: null },
    'a non-string code is not a code')
  // Every non-409 stays a READ error for the caller: an unreachable gateway, a
  // 500/profile_corrupt or a proxy 503 must never render as the busy copy.
  for (const status of [400, 401, 403, 404, 500, 503]) {
    assert.equal(classifyGatewayReadFence({ error: 'boom', code: 'quarantined' }, status), null, String(status))
  }
})

test('gatewayReadFenceText: the fence key with {code}, the status standing in when the body carried none', () => {
  const key = 'gatewayReadFencedBusy' as const
  const t = (k: typeof key): string => zh[k]

  const text = gatewayReadFenceText('runtime_busy', 409, key, t)
  assert.equal(text, zh.gatewayReadFencedBusy.replace('{code}', 'runtime_busy'))
  assert.match(text, /实例正在变更插件/u, 'the copy names the cause (the instance is changing plugins)')
  assert.match(text, /刷新/u, 'and the recovery (the dialog\'s Refresh)')

  // No code in the body → the numeric status, never a blank slot.
  assert.equal(gatewayReadFenceText(null, 409, key, t), zh.gatewayReadFencedBusy.replace('{code}', '409'))
  assert.equal(gatewayReadFenceText(null, 409, key, t).includes('{code}'), false)
  // The fence copy is its own key: never the profile banners (the codes the
  // read maps to), never the verbatim English server text serverRefusalText
  // renders for every other status.
  assert.notEqual(text, zh.profileAbsentBanner)
  assert.notEqual(text, zh.profileCorruptBanner)
  assert.notEqual(text, serverRefusalText(FENCE_BODY, 409))
  assert.notEqual(text, serverRefusalText(null, 409))

  // zh + en in sync at the copy level too.
  assert.match(en.gatewayReadFencedBusy, /\{code\}/u)
  assert.match(en.gatewayReadFencedBusy, /is changing plugins/u)
  assert.match(en.gatewayReadFencedBusy, /Refresh/u)
})
