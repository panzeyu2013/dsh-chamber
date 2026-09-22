/**
 * session-state-protocol.ts unit tests: descriptor parsing, the
 * capability matrix (404 / 503-disabled / unversioned / 5xx+timeout /
 * forward-skew / ok), the frozen feature tuple + coverage net, read-mark
 * monotonic max merge and source-wide effective max, and the turn/end
 * classification that closes R12 (completed counts; aborted+user does not;
 * blocked/error/max-tokens/interrupted are neutral).
 *
 * Run directly: node packages/control-plane/test/protocol/session-state-protocol.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clampReadThrough,
  classifySessionStateProbe,
  classifyTurnEnd,
  effectiveReadMark,
  mergeReadMark,
  parseSessionStateDescriptor,
  PROTOCOL_VERSION,
  SESSION_STATE_BASE_FEATURES,
  SESSION_STATE_DEGRADATION_CODES,
  SESSION_STATE_FEATURES,
  SESSION_STATE_PATH,
  SESSION_STATE_PROTOCOL_VERSION,
  SESSION_STATE_READ_ALL_PATH,
  SESSION_STATE_READ_PATH,
  SESSION_STATE_ROUTES,
  SESSION_STATE_STREAM_PATH,
  sessionStateFeatureSupport,
  sessionStateNoteKey,
  type SessionStateFeature,
  type SessionTurnEnd,
  type SessionTurnEndCause,
  type SessionTurnEndKind,
} from '../../src/session-state-protocol.ts'

const OK_DESCRIPTOR = {
  protocol: PROTOCOL_VERSION,
  features: [...SESSION_STATE_FEATURES],
  mode: 'sse',
  cursor: 41,
  host: { now: 1_760_000_000_000 },
}

const probeOk = (body: unknown) => classifySessionStateProbe({ kind: 'response', status: 200, body })

const turnEnd = (kind: SessionTurnEndKind, cause: SessionTurnEndCause | null = null): SessionTurnEnd =>
  ({ kind, cause, at: 10, seq: 3 })

// ---------------------------------------------------------------------------
// 常量 / 冻结元组
// ---------------------------------------------------------------------------

test('protocol version + route set are the frozen single source', () => {
  assert.equal(PROTOCOL_VERSION, 1)
  assert.equal(SESSION_STATE_PROTOCOL_VERSION, PROTOCOL_VERSION)
  assert.equal(SESSION_STATE_PATH, '/chamber/session-state')
  assert.equal(SESSION_STATE_STREAM_PATH, '/chamber/session-state/stream')
  assert.equal(SESSION_STATE_READ_PATH, '/chamber/session-state/read')
  assert.equal(SESSION_STATE_READ_ALL_PATH, '/chamber/session-state/read-all')
  assert.deepEqual([...SESSION_STATE_ROUTES], [
    SESSION_STATE_PATH,
    SESSION_STATE_STREAM_PATH,
    SESSION_STATE_READ_PATH,
    SESSION_STATE_READ_ALL_PATH,
  ])
})

test('feature ids are unique dotted-lowercase ids and cover the base set', () => {
  assert.equal(new Set(SESSION_STATE_FEATURES).size, SESSION_STATE_FEATURES.length)
  for (const feature of SESSION_STATE_FEATURES) {
    assert.match(feature, /^session-state\.[a-z0-9]+(-[a-z0-9]+)*$/, feature)
  }
  for (const required of SESSION_STATE_BASE_FEATURES) {
    assert.ok(SESSION_STATE_FEATURES.includes(required), required)
  }
  assert.equal(new Set(SESSION_STATE_DEGRADATION_CODES).size, SESSION_STATE_DEGRADATION_CODES.length)
})

/**
 * Coverage net (R10): every advertised feature
 * is referenced here. Growing SESSION_STATE_FEATURES without touching this
 * list fails the test on purpose — a capability may never be advertised
 * without a conscious place in the contract tests.
 */
test('feature coverage net: every advertised feature is consciously listed', () => {
  const covered: readonly SessionStateFeature[] = [
    'session-state.snapshot',
    'session-state.stream',
    'session-state.last-event-id',
    'session-state.read',
    'session-state.read-all',
    'session-state.host-clock',
    'session-state.dsh-events',
    'session-state.pending-graph',
  ]
  assert.deepEqual([...SESSION_STATE_FEATURES].sort(), [...covered].sort())
})

// ---------------------------------------------------------------------------
// 能力判定矩阵
// ---------------------------------------------------------------------------

test('classifier: 404 is the ONLY version fact (legacy-gateway)', () => {
  const verdict = classifySessionStateProbe({ kind: 'response', status: 404 })
  assert.equal(verdict.kind, 'legacy-gateway')
  assert.equal(verdict.degradation, 'legacy-gateway')
  assert.equal(verdict.status, 404)
  assert.deepEqual(verdict.features, [])
  assert.deepEqual(verdict.missingFeatures, [])
})

test('classifier: 503 session_state_disabled is disabled (not legacy, not unavailable)', () => {
  for (const body of [
    { error: 'session_state_disabled' },
    { code: 'session_state_disabled' },
    { error: { code: 'session_state_disabled' } },
  ]) {
    const verdict = classifySessionStateProbe({ kind: 'response', status: 503, body })
    assert.equal(verdict.kind, 'disabled', JSON.stringify(body))
    assert.equal(verdict.degradation, 'watcher-disabled')
  }
  const plain503 = classifySessionStateProbe({ kind: 'response', status: 503, body: {} })
  assert.equal(plain503.kind, 'unavailable')
  // The second kill-switch shape:
  // 200 + mode:'off' is still "disabled", never forward-skew / ok.
  const modeOff = probeOk({ protocol: 1, features: [], mode: 'off', cursor: 0 })
  assert.equal(modeOff.kind, 'disabled')
  assert.equal(modeOff.degradation, 'watcher-disabled')
  assert.equal(modeOff.detail, 'mode')
  assert.equal(modeOff.mode, 'off')
})

test('classifier: 5xx / non-404 4xx / transport failure are unavailable, never legacy', () => {
  for (const status of [500, 502, 504, 401, 403, 405]) {
    const verdict = classifySessionStateProbe({ kind: 'response', status })
    assert.equal(verdict.kind, 'unavailable', String(status))
    assert.equal(verdict.degradation, 'unavailable')
    assert.equal(verdict.status, status)
  }
  for (const reason of ['timeout', 'network'] as const) {
    const verdict = classifySessionStateProbe({ kind: 'failure', reason })
    assert.equal(verdict.kind, 'unavailable')
    assert.equal(verdict.status, null)
    assert.equal(verdict.detail, reason)
  }
})

test('classifier: 2xx without a usable protocol field is unversioned', () => {
  for (const body of [{}, { protocol: 0 }, { protocol: '1' }, { protocol: 1.5 }, 'not-json', 42, null]) {
    const verdict = probeOk(body)
    assert.equal(verdict.kind, 'unversioned', JSON.stringify(body))
    assert.equal(verdict.degradation, 'unversioned')
  }
  const bodyOnly = parseSessionStateDescriptor({ features: ['session-state.snapshot'] })
  assert.equal(bodyOnly?.protocol, null)
})

test('classifier: a full descriptor is ok with parsed mode/cursor', () => {
  const verdict = probeOk(OK_DESCRIPTOR)
  assert.equal(verdict.kind, 'ok')
  assert.equal(verdict.protocol, PROTOCOL_VERSION)
  assert.equal(verdict.mode, 'sse')
  assert.equal(verdict.degradation, null)
  assert.equal(verdict.detail, null)
  assert.deepEqual(verdict.missingFeatures, [])
  assert.deepEqual([...verdict.features], [...SESSION_STATE_FEATURES])
})

test('classifier: protocol > supported is forward-skew and keeps working facts', () => {
  const verdict = probeOk({ ...OK_DESCRIPTOR, protocol: PROTOCOL_VERSION + 1, cursor: 7 })
  assert.equal(verdict.kind, 'forward-skew')
  assert.equal(verdict.protocol, 2)
  assert.equal(verdict.detail, 'protocol')
  assert.deepEqual(verdict.missingFeatures, [])
  assert.deepEqual([...verdict.features], [...SESSION_STATE_FEATURES])
})

test('classifier: a missing required feature is forward-skew with the exact missing set', () => {
  const snapshotOnly = {
    protocol: PROTOCOL_VERSION,
    features: ['session-state.snapshot'],
    mode: 'sse',
    cursor: 1,
  }
  const verdict = probeOk(snapshotOnly)
  assert.equal(verdict.kind, 'forward-skew')
  assert.equal(verdict.detail, 'features')
  assert.deepEqual(verdict.missingFeatures, ['session-state.host-clock'])
})

test('classifier: unknown feature ids are ignored, never degrade (compat rule R2)', () => {
  const verdict = probeOk({
    ...OK_DESCRIPTOR,
    features: [...SESSION_STATE_FEATURES, 'session-state.future-thing', 'not-even-dotted'],
  })
  assert.equal(verdict.kind, 'ok')
  assert.deepEqual([...verdict.features], [...SESSION_STATE_FEATURES])
})

test('classifier: the required-feature set is injectable', () => {
  const verdict = classifySessionStateProbe(
    { kind: 'response', status: 200, body: { protocol: 1, features: [...SESSION_STATE_BASE_FEATURES] } },
    ['session-state.stream'],
  )
  assert.equal(verdict.kind, 'forward-skew')
  assert.deepEqual(verdict.missingFeatures, ['session-state.stream'])
})

test('sessionStateFeatureSupport: unknown advertised ids do not count as support', () => {
  assert.deepEqual(sessionStateFeatureSupport([...SESSION_STATE_FEATURES]), { ok: true, missing: [] })
  assert.deepEqual(sessionStateFeatureSupport(['x', 'y'], ['session-state.read']), {
    ok: false,
    missing: ['session-state.read'],
  })
})

// ---------------------------------------------------------------------------
// 描述符解析
// ---------------------------------------------------------------------------

test('parseSessionStateDescriptor: unknown fields ignored, invalid fields null', () => {
  const descriptor = parseSessionStateDescriptor({
    protocol: 1,
    features: ['session-state.snapshot', 42, '', null, 'session-state.read'],
    mode: 'nonsense',
    cursor: -1,
    x_future: { anything: true },
  })
  assert.deepEqual(descriptor, {
    protocol: 1,
    features: ['session-state.snapshot', 'session-state.read'],
    mode: null,
    cursor: null,
  })
  assert.equal(parseSessionStateDescriptor([1, 2]), null)
})

// ---------------------------------------------------------------------------
// 用户可见键
// ---------------------------------------------------------------------------

test('sessionStateNoteKey: ok is silent; every degraded kind has a unique non-empty key', () => {
  assert.equal(sessionStateNoteKey('ok'), null)
  const keys = new Set<string>()
  for (const kind of ['legacy-gateway', 'disabled', 'unversioned', 'unavailable', 'forward-skew'] as const) {
    const key = sessionStateNoteKey(kind)
    assert.ok(typeof key === 'string' && key.length > 0, kind)
    keys.add(key)
  }
  assert.equal(keys.size, 5)
})

// ---------------------------------------------------------------------------
// 读标记
// ---------------------------------------------------------------------------

test('mergeReadMark: monotonic max, idempotent, invalid values treated as absent', () => {
  assert.equal(mergeReadMark(undefined, 5), 5)
  assert.equal(mergeReadMark(null, 5), 5)
  assert.equal(mergeReadMark(5, 3), 5)
  assert.equal(mergeReadMark(5, 5), 5)
  assert.equal(mergeReadMark(7, Number.NaN), 7)
  assert.equal(mergeReadMark(7, -1), 7)
  assert.equal(mergeReadMark(0, 1.5), 0)
  assert.equal(mergeReadMark(Number.NaN, 2), 2)
})

test('effectiveReadMark: source-wide max over every client plus the floor', () => {
  assert.equal(effectiveReadMark([], 0), 0)
  assert.equal(effectiveReadMark([1, 9, 3, null, undefined], 5), 9)
  assert.equal(effectiveReadMark([], 7), 7)
  assert.equal(effectiveReadMark([2, 4]), 4)
  assert.equal(effectiveReadMark([2, 4], -5), 4)
  assert.equal(effectiveReadMark([Number.NaN, 1.5], 0), 0)
  function* marks() { yield 12; yield 3 }
  assert.equal(effectiveReadMark(marks(), 1), 12)
})

// ---------------------------------------------------------------------------
// turn/end 分类（R12）
// ---------------------------------------------------------------------------

test('classifyTurnEnd: completed counts as a completion', () => {
  assert.equal(classifyTurnEnd(turnEnd('completed')), 'completed')
})

test('classifyTurnEnd: aborted+user is a user stop (never unread)', () => {
  assert.equal(classifyTurnEnd(turnEnd('aborted', 'user')), 'user-stopped')
})

test('classifyTurnEnd: blocked/error/max-tokens/interrupted are neutral', () => {
  for (const kind of ['blocked', 'error', 'max-tokens', 'interrupted'] as const) {
    assert.equal(classifyTurnEnd(turnEnd(kind)), 'neutral', kind)
  }
})

test('classifyTurnEnd: aborted for any non-user cause is neutral', () => {
  for (const cause of ['parent', 'hook', 'disposed', 'legacy'] as const) {
    assert.equal(classifyTurnEnd(turnEnd('aborted', cause)), 'neutral', cause)
  }
  assert.equal(classifyTurnEnd(turnEnd('aborted', null)), 'neutral')
})

test('classifyTurnEnd: an absent fact is neutral', () => {
  assert.equal(classifyTurnEnd(null), 'neutral')
  assert.equal(classifyTurnEnd(undefined), 'neutral')
})

test('clampReadThrough keeps read marks in the host domain (clock skew)', () => {
  const hostNow = 1_700_000_000_000
  // A legitimate mark at or below the host clock is untouched.
  assert.equal(clampReadThrough(hostNow - 60_000, hostNow), hostNow - 60_000)
  assert.equal(clampReadThrough(hostNow, hostNow), hostNow)
  assert.equal(clampReadThrough(0, hostNow), 0)
  // A desktop clock running an hour ahead cannot buy a future mark: without the
  // clamp it would suppress every completion in that hour (lost true unread).
  assert.equal(clampReadThrough(hostNow + 3_600_000, hostNow), hostNow)
  // An unusable acceptance time yields 0 (nothing is stored in a future domain).
  assert.equal(clampReadThrough(5, Number.NaN), 0)
  assert.equal(clampReadThrough(5, -1), 0)
})
