/**
 * session-state-protocol.ts unit tests: descriptor parsing, the
 * capability matrix (404 / 503-disabled / unversioned / 5xx+timeout /
 * forward-skew / ok), the frozen feature tuple + coverage net, and the turn/end
 * classification that closes R12 (completed counts; aborted+user does not;
 * blocked/error/max-tokens/interrupted are neutral).
 *
 * Run directly: node packages/control-plane/test/protocol/session-state-protocol.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifySessionStateProbe,
  classifyTurnEnd,
  parseSessionStateDescriptor,
  PROTOCOL_VERSION,
  SESSION_STATE_BASE_FEATURES,
  SESSION_STATE_DEGRADATION_CODES,
  SESSION_STATE_FEATURES,
  SESSION_STATE_PATH,
  SESSION_STATE_PROTOCOL_VERSION,
  SESSION_STATE_ROUTES,
  SESSION_STATE_STREAM_PATH,
  sessionStateFeatureSupport,
  sessionStateNoteKey,
  type SessionStateDiagnostics,
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
  assert.deepEqual([...SESSION_STATE_ROUTES], [
    SESSION_STATE_PATH,
    SESSION_STATE_STREAM_PATH,
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
    'session-state.host-clock',
    'session-state.dsh-events',
    'session-state.pending-graph',
    'session-state.goal',
  ]
  assert.deepEqual([...SESSION_STATE_FEATURES].sort(), [...covered].sort())
})

// ---------------------------------------------------------------------------
// Diagnostics shape（I6/I16 的加法面）
// ---------------------------------------------------------------------------

/**
 * diagnostics.dropped 的键集单一来源：P2a 保留边的容量淘汰计数
 * `goalActivations` 必须在协议声明里（gateway 发 2 键；旧端只读已知键）。
 * 类型注解就是编译期断言——协议漏声明该键时 typecheck 直接红。
 */
const DIAGNOSTICS_DROPPED_KEYS = ['goalActivations', 'sessions'] as const

function assertDiagnosticsDroppedKeys(value: Record<string, number>, label: string): void {
  assert.deepEqual(Object.keys(value).sort(), [...DIAGNOSTICS_DROPPED_KEYS], label + ': diagnostics.dropped key set drifted')
}

test('diagnostics dropped declares the additive goalActivations counter (P2a) and the tripwire can fail', () => {
  const dropped: SessionStateDiagnostics['dropped'] = {
    sessions: 1, goalActivations: 4,
  }
  assertDiagnosticsDroppedKeys(dropped, 'declared shape')
  // Negative control：同一键集闸门必须拒绝缺少 goalActivations 的旧形状 dropped。
  assert.throws(
    () => assertDiagnosticsDroppedKeys({ sessions: 1 }, 'mutant old shape'),
    /mutant old shape/,
  )
})

test('classifier: session-state.goal is OPTIONAL — its absence never degrades', () => {
  // The capability only promises the row.goal mirror (P2a). An older/newer
  // descriptor that does not advertise it is still ok: the source simply has no
  // goal facts (status quo). It must never join the required/base set.
  assert.equal(
    (SESSION_STATE_BASE_FEATURES as readonly string[]).includes('session-state.goal'),
    false,
    'session-state.goal must never be required',
  )
  const withoutGoal = SESSION_STATE_FEATURES.filter(feature => feature !== 'session-state.goal')
  const verdict = probeOk({ ...OK_DESCRIPTOR, features: withoutGoal })
  assert.equal(verdict.kind, 'ok')
  assert.deepEqual(verdict.missingFeatures, [])
  assert.equal(verdict.features.includes('session-state.goal'), false)
  // The base set alone (no optional capability at all) still classifies ok.
  const baseOnly = probeOk({ protocol: PROTOCOL_VERSION, features: [...SESSION_STATE_BASE_FEATURES], mode: 'poll', cursor: 1 })
  assert.equal(baseOnly.kind, 'ok')
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
  assert.deepEqual(sessionStateFeatureSupport(['x', 'y'], ['session-state.stream']), {
    ok: false,
    missing: ['session-state.stream'],
  })
})

// ---------------------------------------------------------------------------
// 描述符解析
// ---------------------------------------------------------------------------

test('parseSessionStateDescriptor: unknown fields ignored, invalid fields null', () => {
  const descriptor = parseSessionStateDescriptor({
    protocol: 1,
    features: ['session-state.snapshot', 42, '', null, 'session-state.stream'],
    mode: 'nonsense',
    cursor: -1,
    x_future: { anything: true },
  })
  assert.deepEqual(descriptor, {
    protocol: 1,
    features: ['session-state.snapshot', 'session-state.stream'],
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
