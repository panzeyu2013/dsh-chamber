/**
 * Connections-card runtime gates (design 21 §5.1/§6.3/§6.8 r1): the RESTART
 * gate, the PROBE projection and the 409 refusal localization, all as pure
 * projections of managed-restart.ts — plain node:test, no dsh, no React.
 *
 * WHY this file exists: the card's restart button was gated on the TUNNEL
 * phase only while the core route (/chamber/runtime/restart, runtime-routes.ts)
 * accepts `ready`/`degraded` and nothing else — in a stopped/error/
 * restart-exhausted runtime the click was a guaranteed 409 whose English
 * `body.error` was then shown verbatim. The same probe, on a failed read, kept
 * the previous entry, so a stale `stopped` kept the「启动实例」action alive
 * forever (another guaranteed 409). Both gates are pinned here.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyRuntimeProbe,
  classifyGatewayReadFence,
  classifyRuntimeRefusal,
  gatewayReadFenceText,
  runtimeBlocksRestart,
  runtimeRefusalText,
  serverRefusalText,
} from '../src/client/managed-restart.ts'
import { en, zh } from '../src/locales.ts'

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

/* ------------------------------------------------------------------ */
/* 2. The probe projection: an unavailable probe DELETES the entry      */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* 3. 409 refusals: classified, then localized                         */
/* ------------------------------------------------------------------ */

test('classifyRuntimeRefusal: the not-running refusal is distinguished from every busy refusal', () => {
  // runtime-routes.ts /restart: `managed dsh is not running (<state>); start the
  // managed dsh …` (code runtime_busy — the code alone cannot tell them apart).
  assert.deepEqual(
    classifyRuntimeRefusal({ error: 'managed dsh is not running (stopped); start the managed dsh (start applies to stopped/error/restart-exhausted) or retry the interrupted apply/restore', code: 'runtime_busy' }, 409),
    { kind: 'not-running', code: 'runtime_busy' },
  )
  for (const error of [
    'a restart is already in flight',
    'another runtime mutation is in flight',
    'managed dsh is running (ready); start applies to stopped/error/restart-exhausted',
    'runtime recovery interrupted-apply is required; resume via the matching retry route',
  ]) {
    assert.equal(classifyRuntimeRefusal({ error, code: 'runtime_busy' }, 409)?.kind, 'busy', error)
  }
  assert.deepEqual(classifyRuntimeRefusal({ error: 'x', code: 'runtime_recovery_required' }, 409),
    { kind: 'busy', code: 'runtime_recovery_required' },
    'a recovery-required 409 is a busy refusal, never the not-running one')
})

test('classifyRuntimeRefusal: every 409 is classified (never null), a non-409 is not', () => {
  assert.deepEqual(classifyRuntimeRefusal(null, 409), { kind: 'busy', code: null },
    'a body-less 409 still has to be localized — null here would leak the raw status text')
  assert.deepEqual(classifyRuntimeRefusal({ code: 'runtime_busy' }, 409), { kind: 'busy', code: 'runtime_busy' })
  assert.deepEqual(classifyRuntimeRefusal({ code: 42 }, 409), { kind: 'busy', code: null },
    'a non-string code is not a code')
  assert.equal(classifyRuntimeRefusal({ error: 'boom', code: 'runtime_busy' }, 400), null)
  assert.equal(classifyRuntimeRefusal({ error: 'boom' }, 500), null)
})

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

  // Non-409 refusals keep the verbatim projection (English copy is a registered
  // deviation, design 21 §5.2) — never the 409 copy.
  assert.equal(runtimeRefusalText({ error: 'version is required' }, 400, keys, t), 'version is required')
  assert.equal(runtimeRefusalText(null, 400, keys, t), serverRefusalText(null, 400))
})

/* ------------------------------------------------------------------ */
/* 4. The READ-side fence (design 21 §6.2 读/写面共享栅栏, 2026-12 接线) */
/* ------------------------------------------------------------------ */

/** The gateway's fence refusal on GET /chamber/plugins/installed (routes.ts). */
const fenceBody = {
  error: 'managed profile write in flight (plugin mutation); the installed projection is fenced — retry after the task settles',
  code: 'runtime_busy',
}

test('classifyGatewayReadFence: only the 409 fence family is classified, with the server code', () => {
  // The SAME 409 classifier as the runtime actions — one taxonomy, not two.
  assert.deepEqual(classifyGatewayReadFence(fenceBody, 409), { code: 'runtime_busy' })
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
  assert.notEqual(text, serverRefusalText(fenceBody, 409))
  assert.notEqual(text, serverRefusalText(null, 409))

  // zh + en in sync at the copy level too.
  assert.match(en.gatewayReadFencedBusy, /\{code\}/u)
  assert.match(en.gatewayReadFencedBusy, /is changing plugins/u)
  assert.match(en.gatewayReadFencedBusy, /Refresh/u)
})
