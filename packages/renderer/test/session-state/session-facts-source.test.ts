/**
 * SessionFactsSource 纯契约。
 *
 * 覆盖：粗分类全分支（404=版本事实；5xx/超时绝不是「旧网关」）、快照/增量项解析、
 * 游标幂等、serviceable、通道订阅缝的 stale/证据/生命周期语义、**源文本锁步**（对着
 * control-plane/src/session-state-protocol.ts 钉共享字面量）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  SESSION_FACTS_DISABLED_CODE,
  __resetSessionFactsGoalWarningForTests,
  SESSION_FACTS_DIAGNOSTICS_REFETCH_MAX,
  SESSION_FACTS_DIAGNOSTICS_REFETCH_MIN_MS,
  SESSION_FACTS_PROTOCOL_VERSION,
  SESSION_FACTS_ROUTE,
  applySessionFactsDelta,
  classifySessionFactsProbe,
  createSessionFactsSource,
  isFactsUsable,
  parseSessionFactsGoalFact,
  parseSessionFactsRow,
  parseSessionFactsSnapshotValue,
  type SessionFactsSubscriptionHandlers,
} from '../../src/session-facts-source.ts'
import { PAGE_CHANNEL_KEEPALIVE_EVENT } from '../../../dsh-chamber-client-core/src/page-channel.ts'
import { readEvidenceLog, resetEvidenceLogForTests } from '../../../dsh-chamber-client-core/src/evidence-log.ts'
import { noteFocus, resetPageScheduleForTests } from '../../../dsh-chamber-client-core/src/page-schedule.ts'
import { sourceSessionFactsMode } from '../../src/session-facts-mode.ts'
import { factsChannelOf } from '../../src/completion-observation.ts'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const SNAPSHOT = {
  protocol: 1,
  features: ['session-state.snapshot', 'session-state.stream', 'session-state.host-clock', 'x.future'],
  mode: 'sse',
  cursor: 7,
  host: { now: 1_700_000_000_000, serviceable: true, state: 'ready' },
  sessions: [
    {
      sessionId: 's1',
      running: false,
      pendingKind: 'approval',
      subagentCount: 2,
      updatedAt: 1_700_000_000_100,
      completedAt: 1_700_000_000_200,
      completedAtSource: 'observed',
      lastRunningAt: 1_700_000_000_150,
      lastTurnEnd: { kind: 'completed', cause: null, at: 1_700_000_000_200, seq: 9 },
    },
  ],
}

test('classify: 404 is the only version fact (legacy-gateway)', () => {
  const verdict = classifySessionFactsProbe({ kind: 'response', status: 404 })
  assert.equal(verdict.verdict, 'legacy-gateway')
  assert.equal(verdict.degradation, 'legacy-gateway')
})

test('classify: 5xx / timeout / network are unavailable — never labelled legacy', () => {
  for (const status of [500, 502, 503, 504]) {
    const verdict = classifySessionFactsProbe({ kind: 'response', status })
    assert.equal(verdict.verdict, 'degraded')
    assert.equal(verdict.degradation, 'unavailable', 'HTTP ' + status)
  }
  assert.equal(classifySessionFactsProbe({ kind: 'failure', reason: 'timeout' }).degradation, 'unavailable')
  assert.equal(classifySessionFactsProbe({ kind: 'failure', reason: 'network' }).degradation, 'unavailable')
})

test('classify: the 503 kill-switch has its own degradation code', () => {
  const body = { error: 'session_state_disabled' }
  const verdict = classifySessionFactsProbe({ kind: 'response', status: 503, body })
  assert.equal(verdict.verdict, 'degraded')
  assert.equal(verdict.degradation, 'watcher-disabled')
  // 嵌套 error.code 形态同样识别。
  assert.equal(
    classifySessionFactsProbe({ kind: 'response', status: 503, body: { error: { code: 'session_state_disabled' } } }).degradation,
    'watcher-disabled',
  )
})

test('classify: 200 without protocol is unversioned (most conservative path)', () => {
  assert.equal(classifySessionFactsProbe({ kind: 'response', status: 200, body: {} }).degradation, 'unversioned')
  assert.equal(
    classifySessionFactsProbe({ kind: 'response', status: 200, body: { protocol: 1.5 } }).degradation,
    'unversioned',
  )
})

test('classify: protocol 1 is ok; protocol 2 and mode off degrade explicitly', () => {
  const ok = classifySessionFactsProbe({ kind: 'response', status: 200, body: SNAPSHOT })
  assert.equal(ok.verdict, 'ok')
  assert.equal(ok.degradation, null)
  assert.equal(ok.mode, 'sse')
  assert.deepEqual(ok.features, SNAPSHOT.features)
  const skew = classifySessionFactsProbe({ kind: 'response', status: 200, body: { ...SNAPSHOT, protocol: 2 } })
  assert.equal(skew.verdict, 'degraded')
  assert.equal(skew.degradation, 'forward-skew')
  const off = classifySessionFactsProbe({ kind: 'response', status: 200, body: { ...SNAPSHOT, mode: 'off' } })
  assert.equal(off.verdict, 'degraded')
  assert.equal(off.degradation, 'watcher-disabled')
})

// ── F2：生产路径必须经唯一分类器（404/503 语义真实生效） ────────────────

/** 探测假件：probe 请求按序取响应（Error = carrier 失败），超出后重复最后一个。 */
function probeHarness(responses: Array<Response | Error>) {
  let calls = 0
  const fetchImpl = (async () => {
    const next = responses[Math.min(calls, responses.length - 1)]
    calls += 1
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof fetch
  return { fetchImpl, calls: () => calls }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * 延迟探测假件：每次 fetch 调用入队一个未决 Promise，由用例按序放行——世代竞态用例需要
 * 「旧代探测仍在途时新代探测已发出，再让旧代迟到」的精确时序（真实 fetch 无法钉住）。
 */
function deferredProbe() {
  const pending: Array<(response: Response) => void> = []
  let calls = 0
  const fetchImpl = (() => {
    calls += 1
    return new Promise<Response>(resolve => { pending.push(resolve) })
  }) as unknown as typeof fetch
  return {
    fetchImpl,
    calls: () => calls,
    resolve: (index: number, body: unknown) => {
      pending[index](new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    },
  }
}

function sourceOver(
  responses: Array<Response | Error>,
  over: Partial<Parameters<typeof createSessionFactsSource>[0]> = {},
) {
  const harness = probeHarness(responses)
  const source = createSessionFactsSource({
    sourceId: 'gw-verdict',
    fetchImpl: harness.fetchImpl,
    silenceMs: 0,
    pollIntervalMs: 0,
    ...over,
  })
  source.subscribe(() => {})
  source.update({ fingerprint: 'f1', connected: true })
  return { harness, source }
}

test('F2: 404 publishes the classifier legacy-gateway verdict (and drives the sidebar legacy mode)', async () => {
  const { harness, source } = sourceOver([jsonResponse(404, { error: 'not found' })], { reconnectMs: 5 })
  try {
    await waitFor(() => source.getSnapshot() !== undefined)
    const snapshot = source.getSnapshot()
    assert.equal(snapshot?.verdict, 'legacy-gateway')
    assert.equal(snapshot?.degradation, 'legacy-gateway')
    assert.equal(snapshot?.mode, null)
    assert.equal(snapshot?.stale, false, 'legacy 走有界低频重探，快照持续刷新 ⇒ 按事实不标 stale')
    assert.deepEqual(snapshot?.rows, {})
    assert.equal(sourceSessionFactsMode(snapshot), 'legacy')
    // 版本事实不拒绝重探：网关升级后必须被自动接回（有界低频，按 reconnectMs）。
    await waitFor(() => harness.calls() >= 2, 1_000)
  } finally {
    source.stop()
  }
})

test('F2: 503 + session_state_disabled publishes watcher-disabled (and drives the sidebar disabled mode)', async () => {
  const { harness, source } = sourceOver([jsonResponse(503, { error: { code: SESSION_FACTS_DISABLED_CODE } })], { reconnectMs: 5 })
  try {
    await waitFor(() => source.getSnapshot() !== undefined)
    const snapshot = source.getSnapshot()
    assert.equal(snapshot?.verdict, 'degraded')
    assert.equal(snapshot?.degradation, 'watcher-disabled')
    assert.equal(sourceSessionFactsMode(snapshot), 'disabled')
    // 服务事实不重探（与 mode:'off' 同一语义，正是唯一分类器的等价口径）。
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(harness.calls(), 1)
  } finally {
    source.stop()
  }
})

test('a disabled answer after a healthy baseline keeps the rows (never an authoritative empty set)', async () => {
  const good = {
    protocol: 1,
    features: [],
    mode: 'poll',
    cursor: 11,
    host: { state: 'ready', serviceable: true },
    sessions: [{ sessionId: 's1', running: true, updatedAt: 11 }],
  }
  let payload: unknown = good
  let status = 200
  const fetchImpl = (async () => new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-disabled-after-good',
    fetchImpl,
    pollIntervalMs: 10,
    silenceMs: 0,
    reconnectMs: 5,
  })
  source.update({ fingerprint: 'f1', connected: true })
  await waitFor(() => source.getSnapshot()?.verdict === 'ok' && source.getSnapshot()?.rows.s1 !== undefined)
  status = 503
  payload = { error: { code: SESSION_FACTS_DISABLED_CODE } }
  await waitFor(() => source.getSnapshot()?.degradation === 'watcher-disabled')
  const snapshot = source.getSnapshot()!
  // 空行集会让在场集判空 ⇒ 遗忘结算 / 清 held pending / 撤已武装行（design 19 §3.5）。
  assert.equal(snapshot.rows.s1?.sessionId, 's1', 'rows must survive a disabled answer')
  assert.equal(snapshot.serviceable, false)
  assert.equal(snapshot.stale, true)
  assert.equal(isFactsUsable(snapshot), false)
  source.stop()
})

test('F2: a plain 5xx is unavailable (never legacy) and schedules a bounded reprobe', async () => {
  const { harness, source } = sourceOver([new Response('oops', { status: 502 })], { reconnectMs: 5 })
  try {
    await waitFor(() => source.getSnapshot() !== undefined)
    assert.equal(source.getSnapshot()?.verdict, 'degraded')
    assert.equal(source.getSnapshot()?.degradation, 'unavailable')
    await waitFor(() => harness.calls() >= 2, 1_000)
  } finally {
    source.stop()
  }
})

test('F2: protocol 2 is forward-skew; mode off is watcher-disabled; both are version/service facts and never retry', async () => {
  const skew = sourceOver([jsonResponse(200, { ...SNAPSHOT, protocol: 2 })], { reconnectMs: 5 })
  try {
    await waitFor(() => skew.source.getSnapshot() !== undefined)
    assert.equal(skew.source.getSnapshot()?.verdict, 'degraded')
    assert.equal(skew.source.getSnapshot()?.degradation, 'forward-skew')
    assert.equal(skew.source.getSnapshot()?.rows.s1.sessionId, 's1', 'forward-skew 与旧行为一致地保留镜像行')
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(skew.harness.calls(), 1, '版本事实不重探')
  } finally {
    skew.source.stop()
  }

  const off = sourceOver([jsonResponse(200, { ...SNAPSHOT, mode: 'off' })], { reconnectMs: 5 })
  try {
    await waitFor(() => off.source.getSnapshot() !== undefined)
    assert.equal(off.source.getSnapshot()?.degradation, 'watcher-disabled')
    assert.equal(sourceSessionFactsMode(off.source.getSnapshot()), 'disabled')
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(off.harness.calls(), 1, '观察者关闭是服务事实，不重探')
  } finally {
    off.source.stop()
  }
})

test('F2: a transport fault after a good mirror keeps the facts and marks them stale', async () => {
  const { source } = sourceOver([
    jsonResponse(200, { ...SNAPSHOT, mode: 'poll', features: [] }),
    new Error('network down'),
  ], { pollIntervalMs: 10, reconnectMs: 5 })
  try {
    await waitFor(() => source.getSnapshot()?.rows.s1 !== undefined)
    await waitFor(() => source.getSnapshot()?.stale === true, 1_000)
    const snapshot = source.getSnapshot()
    assert.equal(snapshot?.verdict, 'ok', '传输层坏答案不擦除既有镜像事实')
    assert.equal(snapshot?.degradation, null)
    assert.equal(snapshot?.rows.s1.completedAt, 1_700_000_000_200)
    assert.equal(sourceSessionFactsMode(snapshot), 'degraded', 'stale 事实呈现为受限，绝不冒充 full')
  } finally {
    source.stop()
  }
})

test('F2: a 200 HTML fallback (unversioned) retries on the carrier backoff and recovers to ok', async () => {
  // 反代把未注册路由回落成 200 HTML/SPA 的瞬态：分类语义仍是 unversioned
  // （先发布 degraded），但 carrier 层按 reconnectMs 有界重探，下一答恢复 ok。
  const { harness, source } = sourceOver([
    new Response('<html>spa fallback</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    jsonResponse(200, { ...SNAPSHOT, mode: 'poll', features: [] }),
  ], { reconnectMs: 5 })
  try {
    await waitFor(() => source.getSnapshot()?.degradation === 'unversioned')
    assert.equal(sourceSessionFactsMode(source.getSnapshot()), 'degraded')
    await waitFor(() => source.getSnapshot()?.verdict === 'ok', 1_000)
    assert.equal(source.getSnapshot()?.degradation, null)
    assert.equal(source.getSnapshot()?.rows.s1.sessionId, 's1', '恢复后带回真实镜像行')
    assert.ok(harness.calls() >= 2, '不可解析的 2xx 必须按 reconnectMs 有界重探')
  } finally {
    source.stop()
  }
})

test('F2: an unversioned refetch re-arms the unary reprobe instead of wedging', async () => {
  let probes = 0
  const channel = channelHarness()
  const fetchImpl = (async () => {
    probes += 1
    if (probes === 1) {
      return new Response(JSON.stringify(SSE_PROBE_BODY), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('<html>spa fallback</html>', { status: 200, headers: { 'content-type': 'text/html' } })
  }) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-unversioned-refetch',
    fetchImpl,
    silenceMs: 0,
    reconnectMs: 10,
    subscribeSessionFacts: channel.option,
  })
  try {
    source.subscribe(() => {})
    source.update({ fingerprint: 'f1', connected: true })
    await waitFor(() => channel.liveCount() === 1)
    // 第一条 item 立刻要求整量重取；重取答案是 200 HTML（不可解析）。
    channel.item('resync', {})
    await waitFor(() => source.getSnapshot()?.degradation === 'unversioned', 2_000)
    // refetch 失败与 probe 共用 shouldRetryProbe：恢复动作是 unary 有界重探，不得静止降级；
    // 流载体的重建归通道，本地不得新建第二条订阅。
    await waitFor(() => probes >= 3, 2_000)
    assert.equal(channel.subscriptions.length, 1, '本地不得自排订阅重连（通道自己重订阅）')
  } finally {
    source.stop()
  }
})

test('snapshot parser: rows, host gate and unknown fields are defensive', () => {
  const parsed = parseSessionFactsSnapshotValue(SNAPSHOT)
  assert.ok(parsed !== null)
  assert.equal(parsed.hostState, 'ready')
  assert.equal(parsed.serviceable, true)
  assert.equal(parsed.cursor, 7)
  assert.equal(parsed.rows.s1.completedAt, 1_700_000_000_200)
  assert.equal(parsed.rows.s1.completedAtSource, 'observed')
  assert.equal(parsed.rows.s1.pendingKind, 'approval')
  assert.equal(parsed.rows.s1.lastTurnEnd?.kind, 'completed')
  assert.equal(parsed.rows.s1.lastTurnEnd?.seq, 9)
  const stopped = parseSessionFactsSnapshotValue({ ...SNAPSHOT, host: { now: 1, serviceable: false, state: 'stopped' } })
  assert.equal(stopped?.serviceable, false)
  assert.equal(stopped?.hostState, 'stopped')
  // 未知/坏字段绝不被当成事实。
  assert.equal(parseSessionFactsSnapshotValue({ ...SNAPSHOT, host: {} })?.hostState, 'unknown')
  assert.equal(parseSessionFactsRow({ sessionId: 'x', updatedAt: -5 })?.updatedAt, 0)
  assert.equal(parseSessionFactsRow({}), null)
})

test('goal fact parser: revision must be a safe integer >= 1 and updatedAt a safe integer >= 0', () => {
  __resetSessionFactsGoalWarningForTests()
  const good = { goalId: 'g1', revision: 3, phase: 'active', updatedAt: 0, activation: 'armed' }
  assert.deepEqual(parseSessionFactsGoalFact(good), good)
  for (const revision of [-1, 0, 1.5, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined]) {
    assert.equal(
      parseSessionFactsGoalFact({ goalId: 'g1', revision, phase: 'active' }),
      undefined,
      'revision=' + String(revision),
    )
  }
  // The phase/id rules are unchanged.
  assert.equal(parseSessionFactsGoalFact({ goalId: '', revision: 1, phase: 'active' }), undefined)
  assert.equal(parseSessionFactsGoalFact({ goalId: 'g1', revision: 1, phase: 'running' }), undefined)
  // A bad updatedAt drops only the watermark; the fact (with activation)
  // survives because absence means "no usable watermark".
  assert.deepEqual(
    parseSessionFactsGoalFact({ goalId: 'g1', revision: 1, phase: 'active', updatedAt: -1 }),
    { goalId: 'g1', revision: 1, phase: 'active' },
  )
  assert.equal(parseSessionFactsGoalFact({ goalId: 'g1', revision: 1, phase: 'active', updatedAt: 1.5 })?.updatedAt, undefined)
  assert.equal(parseSessionFactsGoalFact({ goalId: 'g1', revision: 1, phase: 'active', updatedAt: 2 ** 53 })?.updatedAt, undefined)
  // The row path collapses a bad fact to unknown (never to explicit null) and
  // leaves the key ABSENT — writing an own `goal: undefined` would make the
  // unknown indistinguishable from a present-but-broken field (Object.hasOwn).
  const row = parseSessionFactsRow({ sessionId: 's', goal: { goalId: 'g1', revision: 0, phase: 'active' } })
  assert.equal(row?.goal, undefined)
  assert.equal(Object.hasOwn(row as object, 'goal'), false)
  for (const bad of [
    { goalId: '', revision: 1, phase: 'active' },
    { goalId: 'g1', revision: 1, phase: 'running' },
    'nope',
    [],
  ]) {
    const badRow = parseSessionFactsRow({ sessionId: 's', goal: bad })
    assert.equal(Object.hasOwn(badRow as object, 'goal'), false, 'bad shape must stay sparse: ' + JSON.stringify(bad))
  }
  const knownRow = parseSessionFactsRow({ sessionId: 's', goal: { goalId: 'g1', revision: 1, phase: 'active' } })
  assert.equal(Object.hasOwn(knownRow as object, 'goal'), true, 'a known object fact is an own property')
  assert.deepEqual(knownRow?.goal, { goalId: 'g1', revision: 1, phase: 'active' })
  const none = parseSessionFactsRow({ sessionId: 's', goal: null })
  assert.equal(none?.goal, null)
  assert.equal(Object.hasOwn(none as object, 'goal'), true, 'an explicit no-goal is an own property too')
})

test('turn-end parser keeps only the known cause family (absent ≠ legacy)', () => {
  const row = parseSessionFactsRow({
    sessionId: 's',
    lastTurnEnd: { kind: 'aborted', cause: 'user', at: 5, seq: 3 },
  })
  assert.equal(row?.lastTurnEnd?.cause, 'user')
  const legacy = parseSessionFactsRow({ sessionId: 's', lastTurnEnd: { kind: 'aborted', cause: 'bogus', at: 5 } })
  assert.equal(legacy?.lastTurnEnd?.cause, undefined)
  const nullish = parseSessionFactsRow({ sessionId: 's', lastTurnEnd: { kind: 'completed', cause: null, at: 5, seq: null } })
  assert.equal(nullish?.lastTurnEnd?.cause, undefined)
  assert.equal(nullish?.lastTurnEnd?.seq, undefined)
})

test('delta: cursor monotonicity is idempotent; hints classify added/changed/removed', () => {
  const base = parseSessionFactsSnapshotValue(SNAPSHOT)!
  const current = {
    verdict: 'ok' as const,
    degradation: null,
    mode: base.mode,
    hostState: base.hostState,
    serviceable: base.serviceable,
    stale: false,
    cursor: base.cursor,
    rows: base.rows,
    lastEventAt: null,
  }
  // 更旧/相同游标 ⇒ 幂等丢弃。
  assert.deepEqual(applySessionFactsDelta(current, { cursor: 7, sessions: [] }), { next: null, refetch: false, hint: null })
  assert.deepEqual(applySessionFactsDelta(current, { cursor: 3, sessions: [] }), { next: null, refetch: false, hint: null })
  // 新增行 ⇒ added。
  const added = applySessionFactsDelta(current, { cursor: 8, sessions: [{ sessionId: 's2', running: true, updatedAt: 1 }] })
  assert.equal(added.hint, 'added')
  assert.ok(added.next !== null)
  assert.equal(Object.keys(added.next.rows).length, 2)
  // 行内容变化 ⇒ changed；游标推进。
  const changed = applySessionFactsDelta(added.next!, {
    cursor: 9,
    sessions: [{ sessionId: 's2', running: false, updatedAt: 2 }],
  })
  assert.equal(changed.hint, 'changed')
  assert.equal(changed.next?.rows.s2.running, false)
  // 删除行 ⇒ removed（同时把该行从表里拿掉）。
  const removed = applySessionFactsDelta(changed.next!, { cursor: 10, sessions: [], removedSessionIds: ['s2'] })
  assert.equal(removed.hint, 'removed')
  assert.equal(removed.next?.rows.s2, undefined)
  // 坏载荷 ⇒ refetch（收敛路径）。
  assert.deepEqual(applySessionFactsDelta(current, null), { next: null, refetch: true, hint: null })
  // 坏/缺失游标必须走重取，不得被降到 0 后当「更旧帧」静默丢弃（那会把真丢帧当成重复）。
  for (const bad of [undefined, null, '7', 1.5, -3, Number.NaN]) {
    assert.deepEqual(
      applySessionFactsDelta(current, { cursor: bad, sessions: [] }),
      { next: null, refetch: true, hint: null },
      '坏游标 ' + String(bad) + ' 必须 refetch',
    )
  }
  assert.deepEqual(applySessionFactsDelta(current, { cursor: 0, sessions: [] }), { next: null, refetch: true, hint: null }, '0 不是合法事件游标')
})

test('delta: a removedSessionIds entry for a row the client never had produces no hint and no row-set change', () => {
  const base = parseSessionFactsSnapshotValue(SNAPSHOT)!
  const current = {
    verdict: 'ok' as const,
    degradation: null,
    mode: base.mode,
    hostState: base.hostState,
    serviceable: base.serviceable,
    stale: false,
    cursor: base.cursor,
    rows: base.rows,
    lastEventAt: null,
  }
  // 未知 id 的撤回（陈旧 removed / 另一客户端的行）：没有行被删 ⇒ 不得提示。
  const unknown = applySessionFactsDelta(current, { cursor: 8, sessions: [], removedSessionIds: ['never-seen'] })
  assert.ok(unknown.next !== null, '游标照常推进（帧本身合法）')
  assert.equal(unknown.hint, null, '未知 id 不产生 removed 提示（不白触发整量重拉）')
  assert.deepEqual(Object.keys(unknown.next.rows), Object.keys(current.rows))
  // 同一个未知 id 与一次真变化同帧：提示仍是真变化的档位。
  const changed = applySessionFactsDelta(current, {
    cursor: 9,
    sessions: [{ sessionId: 's1', running: true, updatedAt: 1 }],
    removedSessionIds: ['never-seen'],
  })
  assert.equal(changed.hint, 'changed')
})

test('delta: hint priority is added > removed > changed (a mixed frame pulls once)', () => {
  const base = parseSessionFactsSnapshotValue(SNAPSHOT)!
  const current = {
    verdict: 'ok' as const,
    degradation: null,
    mode: base.mode,
    hostState: base.hostState,
    serviceable: base.serviceable,
    stale: false,
    cursor: base.cursor,
    rows: base.rows,
    lastEventAt: null,
  }
  const mixed = applySessionFactsDelta(current, {
    cursor: 9,
    sessions: [{ sessionId: 's2', running: true, updatedAt: 1 }],
    removedSessionIds: ['s1'],
  })
  assert.equal(mixed.hint, 'added',
    'design 06 §4.2 的 added > removed > changed：混合帧一次整量拉取即同时收敛新增/删除/变化')
  assert.equal(mixed.next?.rows.s2?.running, true)
  assert.equal(mixed.next?.rows.s1, undefined, '删除仍在同一帧生效')
  // 纯删除仍是 removed（分类不被优先级改写）。
  const pureRemoval = applySessionFactsDelta(mixed.next!, { cursor: 10, sessions: [], removedSessionIds: ['s2'] })
  assert.equal(pureRemoval.hint, 'removed')
})

test('firstSeenByDelta is observer-only: gateway delta/snapshot frames never write the local bit', () => {
  const base = parseSessionFactsSnapshotValue(SNAPSHOT)!
  const current = {
    verdict: 'ok' as const,
    degradation: null,
    mode: base.mode,
    hostState: base.hostState,
    serviceable: base.serviceable,
    stale: false,
    cursor: base.cursor,
    rows: base.rows,
    lastEventAt: null,
  }
  assert.equal(current.rows.s1.firstSeenByDelta, undefined, '快照帧（列表播种）不带该位')
  // d1：增量帧首建的新行也不带该位（P1：added/activity/tombstone 行不得冒充 status 事件）。
  const d1 = applySessionFactsDelta(current, {
    cursor: 8,
    sessions: [{ sessionId: 's2', running: false, updatedAt: 5 }],
  })
  assert.equal(d1.next?.rows.s2?.firstSeenByDelta, undefined, '网关增量首建的行不带该位')
  // d2：同行只改 updatedAt ⇒ 依旧不带。
  const d2 = applySessionFactsDelta(d1.next!, {
    cursor: 9,
    sessions: [{ sessionId: 's2', running: false, updatedAt: 6 }],
  })
  assert.equal(d2.next?.rows.s2?.updatedAt, 6)
  assert.equal(d2.next?.rows.s2?.firstSeenByDelta, undefined, 'd2：增量帧仍不写本地位')
  // 即便上一份快照里该行带了本地位，增量帧也只写 wire 行（该位不属于网关平面）。
  const seeded = { ...d2.next!, rows: { ...d2.next!.rows, s2: { ...d2.next!.rows.s2!, firstSeenByDelta: true } } }
  const d3 = applySessionFactsDelta(seeded, {
    cursor: 10,
    sessions: [{ sessionId: 's2', running: false, updatedAt: 7 }],
  })
  assert.equal(d3.next?.rows.s2?.firstSeenByDelta, undefined, '增量帧不保留本地位')
})

test('delta: host gate updates ride the frame', () => {
  const base = parseSessionFactsSnapshotValue(SNAPSHOT)!
  const current = {
    verdict: 'ok' as const,
    degradation: null,
    mode: base.mode,
    hostState: base.hostState,
    serviceable: true,
    stale: false,
    cursor: 7,
    rows: base.rows,
    lastEventAt: null,
  }
  const outcome = applySessionFactsDelta(current, {
    cursor: 8,
    sessions: [],
    host: { state: 'stopped', serviceable: false },
  })
  assert.equal(outcome.next?.hostState, 'stopped')
  assert.equal(outcome.next?.serviceable, false)
})

test('lockstep: our route/protocol/disabled literals are pinned to the control-plane single source', () => {
  const protocolSource = stripComments(readFileSync(
    fileURLToPath(new URL('../../../control-plane/src/session-state-protocol.ts', import.meta.url)),
    'utf8',
  ))
  // 权威模块的字面量（源文本口径；本包不能 import 它）。
  assert.ok(protocolSource.includes("export const SESSION_STATE_PATH = '/chamber/session-state'"))
  assert.ok(protocolSource.includes('SESSION_STATE_STREAM_PATH = `${SESSION_STATE_PATH}/stream`'))
  assert.ok(protocolSource.includes('export const PROTOCOL_VERSION = 1'))
  assert.ok(protocolSource.includes('session_state_disabled'))
  assert.ok(protocolSource.includes('serviceable'))
  assert.ok(protocolSource.includes('completedAtSource'))
  // 本侧常量逐字节相同（read/read-all 回执已随旧读水位退役，路由常量不再存在）。
  assert.equal(SESSION_FACTS_ROUTE, '/chamber/session-state')
  assert.equal(SESSION_FACTS_PROTOCOL_VERSION, 1)
  assert.equal(SESSION_FACTS_DISABLED_CODE, 'session_state_disabled')
})

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(condition(), 'waitFor 超时')
}

// ── 通道订阅缝：静默看门狗（OPEN 武装）与订阅生命周期 ─────────────────────

/** 网关 mode='sse' 的探测载荷：事实源自此开启通道订阅（订阅缝假件在下方）。 */
const SSE_PROBE_BODY = {
  protocol: 1,
  mode: 'sse',
  features: ['session-state.snapshot', 'session-state.stream', 'session-state.host-clock'],
  cursor: 3,
  host: { now: 1_700_000_000_000, serviceable: true, state: 'ready' },
  sessions: [],
}

/** 订阅假件的一条句柄：记录 close()，用例经它驱动 open/item/error。 */
interface FakeSubscription {
  handlers: SessionFactsSubscriptionHandlers
  closed: boolean
}

/**
 * 订阅缝假件：创建即 OPEN（通道 ready 的语义）；item/error 只投给未 close 的句柄。
 * 通道自己的重连/重订阅阶梯由真实模块拥有（page-channel 的用例锁它），本假件刻意不
 * 模拟：事实源若在本地自排第二条阶梯，用例会因此变红。
 */
function channelHarness() {
  const subscriptions: FakeSubscription[] = []
  const option = (handlers: SessionFactsSubscriptionHandlers) => {
    const record: FakeSubscription = { handlers, closed: false }
    subscriptions.push(record)
    handlers.onOpen?.()
    return { close: () => { record.closed = true } }
  }
  const live = (): FakeSubscription[] => subscriptions.filter(record => !record.closed)
  return {
    option,
    subscriptions,
    liveCount: () => live().length,
    item: (event: string, data: unknown) => {
      const text = typeof data === 'string' ? data : JSON.stringify(data)
      for (const record of live()) record.handlers.onItem(event, text)
    },
    error: (code: string, message: string) => {
      for (const record of live()) record.handlers.onError?.(code, message)
    },
  }
}

test('G2: switching from the poll delivery to the channel subscription stops the unary poll timer', async () => {
  let probes = 0
  const channel = channelHarness()
  const fetchImpl = (async () => {
    probes += 1
    const body = probes === 1 ? { ...SSE_PROBE_BODY, mode: 'poll', features: [] } : SSE_PROBE_BODY
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-poll-to-channel',
    fetchImpl,
    silenceMs: 0,
    pollIntervalMs: 10,
    reconnectMs: 5,
    subscribeSessionFacts: channel.option,
  })
  try {
    source.update({ fingerprint: 'f1', connected: true })
    // 首探 poll 档 ⇒ 轮询接管；下一次轮询探到 sse + 订阅缝 ⇒ 通道接管，旧轮询必须停。
    await waitFor(() => channel.liveCount() === 1 && source.getSnapshot()?.mode === 'sse', 3_000)
    const settled = probes
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(probes, settled, '订阅档接管后残留的轮询必须停止（通道是唯一增量面，否则同一来源有两个刷新面）')
  } finally {
    source.stop()
  }
})

test('R21: a silent subscription (OPEN, no items) is marked stale and reconciled without a local resubscribe', async () => {
  const channel = channelHarness()
  let probes = 0
  const diagnostics: string[] = []
  const staleEmissions: boolean[] = []
  const fetchImpl = (async () => {
    probes += 1
    return new Response(JSON.stringify(SSE_PROBE_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-sse-silent',
    fetchImpl,
    // 看门狗间隔 floor = 1s（silenceMs/3 与 1s 取大者）。
    silenceMs: 10,
    reconnectMs: 10,
    onDiagnostic: message => diagnostics.push(message),
    subscribeSessionFacts: channel.option,
  })
  source.subscribe(snapshot => { staleEmissions.push(snapshot?.stale === true) })
  try {
    source.update({ fingerprint: 'f1', connected: true })
    await waitFor(() => channel.liveCount() === 1)
    assert.equal(source.getSnapshot()?.stale, false)
    await waitFor(() => diagnostics.some(line => line.includes('channel silent')), 3_000)
    assert.ok(staleEmissions.includes(true), '静默收口必须先发布 stale 事实')
    // 收口路径 = 整量重取（unary）；重订阅归通道，本地不得 close/新建第二条订阅。
    await waitFor(() => probes >= 2, 2_000)
    assert.equal(channel.subscriptions.length, 1, '独立于通道的本地重连阶梯必须不存在')
    assert.equal(channel.subscriptions[0].closed, false, '看门狗不得 close 订阅（close 是终态）')
    // 之后一条 admissible success（整量帧）清 stale。
    channel.item('sync', {
      protocol: 1, mode: 'sse', features: [],
      cursor: 4, host: { state: 'ready', serviceable: true }, sessions: [],
    })
    await waitFor(() => source.getSnapshot()?.stale === false)
  } finally {
    source.stop()
  }
})

test('transport keepalives keep a quiet source fresh-but-not-stale, while still reconciling the unary authority', async () => {
  const channel = channelHarness()
  let probes = 0
  const diagnostics: string[] = []
  const staleEmissions: boolean[] = []
  const fetchImpl = (async () => {
    probes += 1
    return new Response(JSON.stringify(SSE_PROBE_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-sse-quiet',
    fetchImpl,
    // keepalive 节奏（100ms）必须快于静默窗（300ms）：生产里 gateway 每 20s 一条 keepalive、
    // 静默窗 60s，是同一条大小关系。看门狗间隔 floor = 1s。
    silenceMs: 300,
    reconnectMs: 10,
    onDiagnostic: message => diagnostics.push(message),
    subscribeSessionFacts: channel.option,
  })
  source.subscribe(snapshot => { staleEmissions.push(snapshot?.stale === true) })
  const keepalive = setInterval(() => { channel.item(PAGE_CHANNEL_KEEPALIVE_EVENT, '') }, 100)
  try {
    source.update({ fingerprint: 'f1', connected: true })
    await waitFor(() => channel.liveCount() === 1)
    // 看门狗间隔 floor = 1s：跨过一轮而无内容帧。keepalive 是传输活着的证据 ⇒ 只对账不降级。
    await waitFor(() => diagnostics.some(line => line.includes('transport alive')), 3_000)
    assert.equal(source.getSnapshot()?.stale, false, '传输仍活 ⇒ 安静的来源不得被标 stale')
    assert.equal(staleEmissions.includes(true), false, 'keepalive 窗口内不得发布 stale 事实')
    await waitFor(() => probes >= 2, 2_000)
    assert.equal(channel.subscriptions.length, 1, 'keepalive 不触发第二条订阅')
    assert.equal(channel.subscriptions[0].closed, false)
  } finally {
    clearInterval(keepalive)
    source.stop()
  }
})

test('G3: a cursor-rejected late probe must not reset the content watermark (silence reconciliation stays pending)', async () => {
  let clock = 1_000_000
  let probes = 0
  const channel = channelHarness()
  const fetchImpl = (async () => {
    probes += 1
    return new Response(JSON.stringify(SSE_PROBE_BODY), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-rejected-watermark',
    fetchImpl,
    now: () => clock,
    // 看门狗间隔 floor = 1s；静默窗 3s：时钟一推即越过静默，不需要真实等 3s。
    silenceMs: 3_000,
    pollIntervalMs: 0,
    reconnectMs: 5,
    subscribeSessionFacts: channel.option,
  })
  try {
    source.update({ fingerprint: 'f1', connected: true })
    await waitFor(() => channel.liveCount() === 1 && source.getSnapshot()?.cursor === SSE_PROBE_BODY.cursor)
    // 通道给一个更新的游标（9）＝真正的内容进度；这是静默的基准水位。
    channel.item('sync', {
      protocol: 1, mode: 'sse', features: [],
      cursor: 9, host: { state: 'ready', serviceable: true }, sessions: [],
    })
    await waitFor(() => source.getSnapshot()?.cursor === 9)
    clock += 5_000
    // 看门狗发起静默对账；probe 回的游标 3 < 9，必被游标单调门拒绝。
    await waitFor(() => probes >= 2, 3_000)
    assert.equal(source.getSnapshot()?.cursor, 9, '被拒绝的迟到快照不得回退游标/行集')
    // 若被拒绝的快照把内容水位推后，下一轮看门狗会误判「刚有内容」而不再对账；语义正确时
    // 静默对账仍在待办 ⇒ 第二轮对账 GET 必须到来（rejected ⇒ 水位不动）。
    await waitFor(() => probes >= 3, 3_000)
  } finally {
    source.stop()
  }
})

test('subscription error marks the source stale and records channel evidence without scheduling a local retry', async () => {
  const channel = channelHarness()
  let probes = 0
  const staleEmissions: boolean[] = []
  const fetchImpl = (async () => {
    probes += 1
    return new Response(JSON.stringify(SSE_PROBE_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-channel-error',
    fetchImpl,
    silenceMs: 0,
    reconnectMs: 5,
    subscribeSessionFacts: channel.option,
  })
  source.subscribe(snapshot => { staleEmissions.push(snapshot?.stale === true) })
  try {
    source.update({ fingerprint: 'f1', connected: true })
    await waitFor(() => channel.liveCount() === 1 && source.getSnapshot()?.verdict === 'ok')
    const probesBefore = probes
    resetEvidenceLogForTests()
    channel.error('channel_closed', '通道关闭 code=1006')
    // 载体级失败：事实立刻 stale（直到下一次 admissible success），但不排本地重连阶梯。
    assert.equal(source.getSnapshot()?.stale, true)
    assert.ok(staleEmissions.includes(true))
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(probes, probesBefore, '订阅错误不得触发本地重探/重连（通道自己重订阅）')
    assert.equal(channel.subscriptions.length, 1, '错误后本地不得新建第二条订阅')
    assert.equal(channel.subscriptions[0].closed, false, '错误后句柄必须留给通道重订阅')
    // 证据账本：非取消/超时的订阅错误 = channel，且 booked=true；细节指向通道 topic。
    const entries = readEvidenceLog().filter(entry => entry.owner === 'facts-stream')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].verdict, 'channel')
    assert.equal(entries[0].booked, true)
    assert.equal(entries[0].detail.topic, 'page-channel sessionFacts')
  } finally {
    source.stop()
  }
})

test('a subscription failure inside an unscheduled window is booked=false (same classifier, no second path)', async () => {
  const channel = channelHarness()
  const fetchImpl = (async () => new Response(JSON.stringify(SSE_PROBE_BODY), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-channel-unscheduled',
    fetchImpl,
    silenceMs: 0,
    reconnectMs: 5,
    subscribeSessionFacts: channel.option,
  })
  try {
    source.update({ fingerprint: 'f1', connected: true })
    await waitFor(() => channel.liveCount() === 1 && source.getSnapshot()?.verdict === 'ok')
    resetEvidenceLogForTests()
    // 页面自身没被调度（失焦/节流）：同一分类器 + hadSchedulingGap ⇒ unscheduled，不记账。
    resetPageScheduleForTests()
    noteFocus(false)
    channel.error('TimeoutError', '上游超时')
    const entries = readEvidenceLog().filter(entry => entry.owner === 'facts-stream')
    assert.equal(entries.length, 1)
    assert.equal(entries[0].verdict, 'unscheduled')
    assert.equal(entries[0].booked, false)
    // 免除的是故障记账，不是载体事实：没有活载体在推进 item，stale 仍必须立起。
    assert.equal(source.getSnapshot()?.stale, true)
  } finally {
    resetPageScheduleForTests()
    source.stop()
  }
})

test('an admissible item after a subscription error clears stale', async () => {
  const channel = channelHarness()
  const fetchImpl = (async () => new Response(JSON.stringify(SSE_PROBE_BODY), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-channel-heal',
    fetchImpl,
    silenceMs: 0,
    reconnectMs: 5,
    subscribeSessionFacts: channel.option,
  })
  try {
    source.update({ fingerprint: 'f1', connected: true })
    await waitFor(() => channel.liveCount() === 1 && source.getSnapshot()?.verdict === 'ok')
    channel.error('upstream_end', '上游结束了该订阅')
    assert.equal(source.getSnapshot()?.stale, true)
    channel.item('sync', {
      protocol: 1, mode: 'sse', features: [],
      cursor: 5, host: { state: 'ready', serviceable: true }, sessions: [],
    })
    assert.equal(source.getSnapshot()?.stale, false, '重新收到一条 admissible success 即清 stale')
    assert.equal(source.getSnapshot()?.cursor, 5)
  } finally {
    source.stop()
  }
})

test('stop() closes the channel subscription', async () => {
  const channel = channelHarness()
  const fetchImpl = (async () => new Response(JSON.stringify(SSE_PROBE_BODY), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-channel-stop',
    fetchImpl,
    silenceMs: 0,
    reconnectMs: 5,
    subscribeSessionFacts: channel.option,
  })
  source.update({ fingerprint: 'f1', connected: true })
  await waitFor(() => channel.liveCount() === 1)
  source.stop()
  assert.equal(channel.subscriptions.length, 1)
  assert.equal(channel.subscriptions[0].closed, true, 'stop() 必须 close 订阅句柄')
  assert.equal(channel.liveCount(), 0)
})

test('G4: stop() bumps the generation — a late probe from the previous incarnation publishes nothing', async () => {
  const probe = deferredProbe()
  const source = createSessionFactsSource({
    sourceId: 'gw-stop-generation',
    fetchImpl: probe.fetchImpl,
    silenceMs: 0,
    pollIntervalMs: 0,
    reconnectMs: 5,
  })
  try {
    source.update({ fingerprint: 'f1', connected: true })
    await waitFor(() => probe.calls() === 1)
    source.stop()
    assert.equal(source.getSnapshot(), undefined)
    // 同一指纹复活（生命周期钩子今日不这么做，但接口允许）：stop() 后的 stopped/connected 会被
    // update() 翻回，只有代际比较能拦住旧代在途探测的迟到结果，绝不作为新化身的事实发布。
    source.update({ fingerprint: 'f1', connected: true })
    await waitFor(() => probe.calls() === 2)
    probe.resolve(0, { ...SSE_PROBE_BODY, cursor: 99 })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(source.getSnapshot(), undefined, 'stop() 之前的旧代探测必须按代作废')
    probe.resolve(1, SSE_PROBE_BODY)
    await waitFor(() => source.getSnapshot()?.cursor === SSE_PROBE_BODY.cursor, 2_000)
  } finally {
    source.stop()
  }
})





// ── 快照构造单一工厂（probe / 通道整量帧 / refetch 同形状） ─────────────

test('snapshot factory: a channel sync item builds the same shape as the probe', async () => {
  const syncFrame = JSON.stringify({
    protocol: 1,
    mode: null,
    cursor: 9,
    host: { state: 'stopped', serviceable: false },
    sessions: [],
  })
  const channel = channelHarness()
  const fetchImpl = (async () => new Response(JSON.stringify(SSE_PROBE_BODY), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-factory',
    fetchImpl,
    silenceMs: 0,
    subscribeSessionFacts: channel.option,
  })
  try {
    source.update({ fingerprint: 'f1', connected: true })
    await waitFor(() => channel.liveCount() === 1)
    channel.item('sync', syncFrame)
    await waitFor(() => source.getSnapshot()?.cursor === 9)
    const snapshot = source.getSnapshot()
    assert.equal(snapshot?.verdict, 'ok')
    assert.equal(snapshot?.degradation, null)
    assert.equal(snapshot?.hostState, 'stopped')
    assert.equal(snapshot?.serviceable, false)
    assert.equal(snapshot?.stale, false)
    assert.deepEqual(snapshot?.rows, {})
    assert.ok((snapshot?.lastEventAt ?? 0) > 0, '工厂必须盖 lastEventAt')
  } finally {
    source.stop()
  }
})

test('snapshot factory negative: a malformed sync item refetches instead of silently clearing the snapshot', async () => {
  const channel = channelHarness()
  let probes = 0
  const fetchImpl = (async () => {
    probes += 1
    return new Response(JSON.stringify(SSE_PROBE_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-factory-bad',
    fetchImpl,
    silenceMs: 0,
    subscribeSessionFacts: channel.option,
  })
  try {
    source.update({ fingerprint: 'f1', connected: true })
    await waitFor(() => channel.liveCount() === 1 && probes === 1)
    channel.item('sync', { oops: true })
    await waitFor(() => probes >= 2, 2_000)
    assert.equal(source.getSnapshot()?.cursor, SSE_PROBE_BODY.cursor, '坏帧不得清空既有快照（走 refetch 收敛）')
  } finally {
    source.stop()
  }
})

test('snapshot hints: an identical snapshot frame does not re-hint; a changed row hints once', async () => {
  const baseRow = { sessionId: 's1', running: false, updatedAt: 11 }
  let payload: unknown = {
    protocol: 1, features: [], mode: 'poll', cursor: 11,
    host: { state: 'ready', serviceable: true }, sessions: [baseRow],
  }
  let probes = 0
  const fetchImpl = (async () => {
    probes += 1
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const hints: string[] = []
  const source = createSessionFactsSource({
    sourceId: 'gw-snapshot-hint', fetchImpl, pollIntervalMs: 10, silenceMs: 0,
  })
  source.onRowHint(hint => { hints.push(hint) })
  try {
    source.update({ fingerprint: 'f1', connected: true })
    await waitFor(() => probes >= 3 && source.getSnapshot()?.rows.s1 !== undefined)
    assert.deepEqual(hints, ['added'], '内容不变（同 verdict/rows/游标内容）的快照帧不得重复提示')
    payload = {
      protocol: 1, features: [], mode: 'poll', cursor: 12,
      host: { state: 'ready', serviceable: true },
      sessions: [{ ...baseRow, running: true }],
    }
    await waitFor(() => hints.length === 2)
    assert.equal(hints[1], 'changed')
  } finally {
    source.stop()
  }
})

// ── probe outcome → 快照（2026-12 单源化：classifier 是唯一判定 owner） ─────────
// 404 legacy 的成立面由上面的 F2 用例覆盖（verdict / degradation / mode null /
// stale false / 有界重探），这里只留 unversioned 的发布契约。

test('the wire diagnostics counter latches into the snapshot (the only listComplete source)', async () => {
  let payload: unknown = {
    protocol: 1,
    features: [],
    mode: 'poll',
    cursor: 11,
    host: { state: 'ready', serviceable: true },
    diagnostics: { baselines: 2 },
    sessions: [{ sessionId: 's1', running: true, updatedAt: 11 }],
  }
  const fetchImpl = (async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-baselines',
    fetchImpl,
    pollIntervalMs: 10,
    silenceMs: 0,
    reconnectMs: 5,
  })
  source.update({ fingerprint: 'f1', connected: true })
  await waitFor(() => source.getSnapshot()?.baselines === 2)
  // 无诊断帧沿用闩锁值：绝不回退成「未就绪」而误清臂。
  payload = {
    protocol: 1,
    features: [],
    mode: 'poll',
    cursor: 12,
    host: { state: 'ready', serviceable: true },
    sessions: [{ sessionId: 's1', running: true, updatedAt: 12 }],
  }
  await waitFor(() => source.getSnapshot()?.cursor === 12)
  assert.equal(source.getSnapshot()?.baselines, 2)
  source.stop()
})

/**
 * S4 假件：probe 回 mode='sse' 快照（baselines 由回调按第几次 probe 决定）；订阅缝用
 * channelHarness，帧由内部定时器以固定间隔推 delta 项。每条 delta 命中整量重取时都会重新
 * 走 probe，故 probe 次数就是「诊断补快照」的计数。帧游标在所有帧之间共享单调递增，避免
 * 重取后回退被当旧帧丢弃。
 */
function diagnosticsRefetchHarness(baselinesOf: (probeIndex: number) => number | undefined) {
  let probeGets = 0
  let frames = 0
  let cursor = 0
  const channel = channelHarness()
  const fetchImpl = (async () => {
    probeGets += 1
    const baselines = baselinesOf(probeGets)
    return new Response(JSON.stringify({
      protocol: 1,
      mode: 'sse',
      features: ['session-state.snapshot', 'session-state.stream'],
      // 快照游标 = 当前帧游标（真实网关语义）：T3 的单调门要求整量快照不得落后于
      // 已应用的增量，否则它会被丢弃、闩锁永远得不到更新。
      cursor,
      host: { state: 'ready', serviceable: true },
      ...(baselines === undefined ? {} : { diagnostics: { baselines } }),
      sessions: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const frameTimer = setInterval(() => {
    // 通道尚未（重新）就绪时没有订阅：帧只投给活着的句柄（与真实通道同语义）。
    if (channel.liveCount() === 0) return
    cursor += 1
    frames += 1
    channel.item('session-state', { cursor, sessions: [] })
  }, 5)
  return {
    fetchImpl,
    channel,
    stop: () => clearInterval(frameTimer),
    probeGets: () => probeGets,
    frames: () => frames,
  }
}

test('S4: a baselines latch stuck at 0 is refetched at most SESSION_FACTS_DIAGNOSTICS_REFETCH_MAX times per generation (bounded retry, no jitter)', async () => {
  const harness = diagnosticsRefetchHarness(() => undefined)
  const source = createSessionFactsSource({
    sourceId: 'gw-diag-retry-bounded',
    fetchImpl: harness.fetchImpl,
    silenceMs: 0,
    reconnectMs: 5,
    pollIntervalMs: 0,
    subscribeSessionFacts: harness.channel.option,
  })
  try {
    source.subscribe(() => {})
    source.update({ fingerprint: 'f1', connected: true })
    // 连续 0 ⇒ 有界重试：1 次首探 + 至多 MAX 次补快照。
    await waitFor(() => harness.probeGets() >= 1 + SESSION_FACTS_DIAGNOSTICS_REFETCH_MAX, 3_000)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(harness.probeGets(), 1 + SESSION_FACTS_DIAGNOSTICS_REFETCH_MAX,
      '每代恰好至多 3 次诊断补快照：连续 0 会重试，但有界、不抖动')
    assert.equal(source.getSnapshot()?.baselines, undefined, '网关始终没给诊断 ⇒ 闩锁保持 unknown')
  } finally {
    source.stop()
    harness.stop()
  }
})

test('S4: a refetch that finally reports baselines >= 1 stops the retries for that generation', async () => {
  const harness = diagnosticsRefetchHarness(probeIndex => (probeIndex === 1 ? undefined : 1))
  const source = createSessionFactsSource({
    sourceId: 'gw-diag-retry-satisfied',
    fetchImpl: harness.fetchImpl,
    silenceMs: 0,
    reconnectMs: 5,
    pollIntervalMs: 0,
    subscribeSessionFacts: harness.channel.option,
  })
  try {
    source.subscribe(() => {})
    source.update({ fingerprint: 'f1', connected: true })
    // 首探无诊断 → 首个 delta 触发一次补快照；该次拿到 1 ⇒ 停止。
    await waitFor(() => source.getSnapshot()?.baselines === 1, 3_000)
    await waitFor(() => harness.frames() >= 2, 3_000)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(harness.probeGets(), 2, '拿到 ≥1 后不再补快照（即使 delta 继续到达）')
  } finally {
    source.stop()
    harness.stop()
  }
})

test('S4/T3: an out-of-order complete snapshot can never regress the cursor or the row set', async () => {
  let probeGets = 0
  const fetchImpl = (async () => {
    probeGets += 1
    const cursor = probeGets === 1 ? 9 : 7
    return new Response(JSON.stringify({
      protocol: 1,
      mode: 'poll',
      features: [],
      cursor,
      host: { state: 'ready', serviceable: true },
      diagnostics: { baselines: 1 },
      sessions: [{ sessionId: 'p' + String(cursor), running: true, updatedAt: cursor }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-out-of-order', fetchImpl, pollIntervalMs: 0, silenceMs: 0, reconnectMs: 5,
  })
  try {
    source.update({ fingerprint: 'f1', connected: true })
    await waitFor(() => source.getSnapshot()?.cursor === 9, 3_000)
    source.reconcile()
    await waitFor(() => probeGets === 2, 3_000)
    await new Promise(resolve => setTimeout(resolve, 60))
    const snap = source.getSnapshot()
    assert.equal(snap?.cursor, 9, '旧游标的整量快照不得覆盖新游标（与 applySessionFactsDelta 的 cursor 门同规）')
    assert.deepEqual(Object.keys(snap?.rows ?? {}), ['p9'], '旧行集不得覆盖新行集')
  } finally {
    source.stop()
  }
})

test('S4/T3: a same-batch burst triggering a hung refetch is single-flight (no stacked GETs)', async () => {
  let probeGets = 0
  let releaseSecond: (() => void) | null = null
  const body = (baselines: number | undefined, cursor: number): string => JSON.stringify({
    protocol: 1,
    mode: 'sse',
    features: ['session-state.snapshot', 'session-state.stream'],
    cursor,
    host: { state: 'ready', serviceable: true },
    ...(baselines === undefined ? {} : { diagnostics: { baselines } }),
    sessions: [],
  })
  const channel = channelHarness()
  const fetchImpl = (async () => {
    probeGets += 1
    if (probeGets === 1) return new Response(body(undefined, 0), { status: 200, headers: { 'content-type': 'application/json' } })
    if (probeGets === 2) {
      await new Promise<void>(resolve => { releaseSecond = resolve })
      return new Response(body(1, 1_000), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(body(1, 1_000), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-refetch-single-flight', fetchImpl, pollIntervalMs: 0, silenceMs: 0, reconnectMs: 5,
    subscribeSessionFacts: channel.option,
  })
  try {
    source.update({ fingerprint: 'f1', connected: true })
    await waitFor(() => channel.liveCount() === 1 && probeGets === 1, 3_000)
    // 同一批五条 delta 项（旧实现每帧各发一次整量 GET ⇒ 叠发三连）。
    for (let cursor = 1; cursor <= 5; cursor += 1) {
      channel.item('session-state', { cursor, sessions: [] })
    }
    await waitFor(() => probeGets === 2, 3_000)
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(probeGets, 2, '在途整量补快照期间不得叠发（single-flight）：五条同批也只发一次')
    releaseSecond!()
    await waitFor(() => source.getSnapshot()?.baselines === 1, 3_000)
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(probeGets, 2, '闩锁拿到 ≥1 后不再补快照')
  } finally {
    source.stop()
  }
})

test('G1: a stale generation probe must not free the new generation single-flight flag', async () => {
  const probe = deferredProbe()
  const source = createSessionFactsSource({
    sourceId: 'gw-stale-generation',
    fetchImpl: probe.fetchImpl,
    silenceMs: 0,
    pollIntervalMs: 0,
    reconnectMs: 5,
  })
  try {
    source.update({ fingerprint: 'f1', connected: true })
    await waitFor(() => probe.calls() === 1)
    // 指纹翻转：旧代 probe 仍在途，新代 probe 立即发出（这两条并发是换代的正当窗口）。
    source.update({ fingerprint: 'f2', connected: true })
    await waitFor(() => probe.calls() === 2)
    // 旧代迟到：结果作废（resetForFingerprint 已清快照），其 finally 也不得清掉新代的 probing。
    probe.resolve(0, { ...SSE_PROBE_BODY, cursor: 99 })
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(source.getSnapshot(), undefined, '旧代的迟到结果绝不发布')
    source.reconcile()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(probe.calls(), 2, '新代探测在途时 reconcile 不得叠发第三条并发 unary GET')
    probe.resolve(1, SSE_PROBE_BODY)
    await waitFor(() => source.getSnapshot()?.cursor === SSE_PROBE_BODY.cursor, 2_000)
  } finally {
    source.stop()
  }
})

test('G1: a stale generation refetch must not free the new generation refetch single-flight flag', async () => {
  const probe = deferredProbe()
  const channel = channelHarness()
  const source = createSessionFactsSource({
    sourceId: 'gw-stale-generation-refetch',
    fetchImpl: probe.fetchImpl,
    silenceMs: 0,
    pollIntervalMs: 0,
    reconnectMs: 5,
    subscribeSessionFacts: channel.option,
  })
  try {
    source.update({ fingerprint: 'f1', connected: true })
    probe.resolve(0, SSE_PROBE_BODY)
    await waitFor(() => channel.liveCount() === 1)
    // 坏帧 ⇒ 旧代整量对账 R1 在途（refetchInFlight 立起）。
    channel.item('session-state', 'not json')
    await waitFor(() => probe.calls() === 2)
    // 换代：resetForFingerprint 清门并关掉旧订阅，新代 probe 发出。
    source.update({ fingerprint: 'f2', connected: true })
    await waitFor(() => probe.calls() === 3)
    probe.resolve(2, SSE_PROBE_BODY)
    await waitFor(() => channel.liveCount() === 1 && probe.calls() === 3)
    // 新代的坏帧 ⇒ 整量对账 R2 在途，单飞门再次立起。
    channel.item('resync', {})
    await waitFor(() => probe.calls() === 4)
    // 旧代 R1 迟到：其 finally 不得清掉新代 R2 的单飞门，否则第二条 resync 会叠发 R3。
    probe.resolve(1, SSE_PROBE_BODY)
    await new Promise(resolve => setTimeout(resolve, 20))
    channel.item('resync', {})
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(probe.calls(), 4, '旧代迟到不得释放新代整量对账的单飞门')
    probe.resolve(3, SSE_PROBE_BODY)
    await new Promise(resolve => setTimeout(resolve, 20))
  } finally {
    source.stop()
  }
})

test('S4/T3: exhausted diagnostics attempts re-arm after the 30s floor (bounded rounds, never permanently stuck at 0)', async () => {
  let clock = 1_000
  const harness = diagnosticsRefetchHarness(() => 0)
  const source = createSessionFactsSource({
    sourceId: 'gw-diag-rearm',
    fetchImpl: harness.fetchImpl,
    now: () => clock,
    silenceMs: 0,
    reconnectMs: 5,
    pollIntervalMs: 0,
    subscribeSessionFacts: harness.channel.option,
  })
  try {
    source.subscribe(() => {})
    source.update({ fingerprint: 'f1', connected: true })
    await waitFor(() => harness.probeGets() >= 1 + SESSION_FACTS_DIAGNOSTICS_REFETCH_MAX, 3_000)
    await new Promise(resolve => setTimeout(resolve, 100))
    const atBudget = harness.probeGets()
    assert.equal(atBudget, 1 + SESSION_FACTS_DIAGNOSTICS_REFETCH_MAX, '每代恰好一轮（至多 MAX 次）')
    // 未到 30s：不重武装（这段时间里也不再发 GET）。
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(harness.probeGets(), atBudget, '时间下限之前不得重武装')
    // 时钟推进 30s：下一轮允许（仍是至多 MAX 次的有界一轮）。
    clock += SESSION_FACTS_DIAGNOSTICS_REFETCH_MIN_MS
    await waitFor(() => harness.probeGets() >= atBudget + 1, 3_000)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.ok(harness.probeGets() <= atBudget + SESSION_FACTS_DIAGNOSTICS_REFETCH_MAX,
      '重武装的一轮同样有界：至多再 MAX 次')
    assert.equal(source.getSnapshot()?.baselines, 0, '网关始终给 0 ⇒ 闩锁保持已知未就绪（不是永久未知）')
  } finally {
    source.stop()
    harness.stop()
  }
})

test('404 after a good snapshot keeps the rows as presence evidence: unavailable legacy, never an authoritative empty set', async () => {
  const good = {
    protocol: 1,
    features: [],
    mode: 'poll',
    cursor: 11,
    host: { state: 'ready', serviceable: true },
    sessions: [
      { sessionId: 's1', running: false, updatedAt: 10, completedAt: 500, completedAtSource: 'observed' },
      { sessionId: 's2', running: true, updatedAt: 11 },
    ],
  }
  let payload: unknown = good
  let status = 200
  let probeGets = 0
  const fetchImpl = (async () => {
    probeGets += 1
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-legacy-after-good',
    fetchImpl,
    pollIntervalMs: 10,
    silenceMs: 0,
    reconnectMs: 5,
  })
  source.update({ fingerprint: 'f1', connected: true })
  await waitFor(() => source.getSnapshot()?.verdict === 'ok' && source.getSnapshot()?.rows.s1 !== undefined)
  // 曾有历史（ok 已投递过行）后转 404：这不是「首探就没有协议」。
  status = 404
  payload = { error: 'not found' }
  await waitFor(() => source.getSnapshot()?.verdict === 'legacy-gateway' && source.getSnapshot()?.stale === true)
  const legacy = source.getSnapshot()
  assert.equal(legacy?.degradation, 'legacy-gateway')
  assert.equal(legacy?.serviceable, false, '404 后行只读作未知，必须显式标不可用')
  assert.deepEqual(Object.keys(legacy?.rows ?? {}).sort(), ['s1', 's2'], '旧行是无壳来源的在场证据，404 不得清空')
  assert.equal(legacy?.rows.s1?.updatedAt, 10, '行水位不得被推进/回退')
  assert.equal(legacy?.rows.s2?.running, true)
  assert.equal(legacy?.cursor, 11, '游标保留（旧行集仍被引用）；绝不被 404 降成 0')
  assert.equal(sourceSessionFactsMode(legacy), 'legacy', '档位语义不变（legacy 可达，不是 degraded/无能力）')
  // 「未可用」不得被消费侧读成「缺席」：observeSource 的遗忘门用的是原始行键，
  // 因此可用位 false 但行集仍在 ⇒ 不触发遗忘结算、held pending 不被清。
  const channel = factsChannelOf(legacy)
  assert.equal(channel?.usable, false)
  assert.deepEqual(Object.keys(channel?.rows ?? {}).sort(), ['s1', 's2'], '保留的行必须仍是 facts 通道的在场证据')
  // 404 持续：第二次及以后不得把保留行丢成空权威集（曾有历史是持久事实）。
  const beforeSecond404 = probeGets
  await waitFor(() => probeGets > beforeSecond404, 1_000)
  assert.deepEqual(Object.keys(source.getSnapshot()?.rows ?? {}).sort(), ['s1', 's2'], '持续 404 不得在第二轮清掉保留行')
  assert.equal(source.getSnapshot()?.stale, true)
  // 网关恢复协议载荷：新快照重新成为权威行集（404→ok 自愈）。
  status = 200
  payload = {
    ...good,
    cursor: 12,
    sessions: [{ sessionId: 's1', running: false, updatedAt: 12 }],
  }
  await waitFor(() => source.getSnapshot()?.verdict === 'ok', 1_000)
  const healed = source.getSnapshot()
  assert.equal(healed?.stale, false)
  assert.equal(healed?.serviceable, true)
  assert.equal(healed?.cursor, 12)
  assert.equal(healed?.rows.s1?.updatedAt, 12)
  assert.equal(healed?.rows.s2, undefined, '健康快照是权威行集（s2 已消失）')
  source.stop()
})

test('unversioned on the very first probe answers "channel unavailable" (degraded), never legacy and never full', async () => {
  let probeGets = 0
  let payload: unknown = { oops: true }
  const fetchImpl = (async () => {
    probeGets += 1
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-unversioned',
    fetchImpl,
    pollIntervalMs: 0,
    silenceMs: 0,
    reconnectMs: 5,
  })
  source.update({ fingerprint: 'f1', connected: true })
  await waitFor(() => source.getSnapshot() !== undefined)
  const snapshot = source.getSnapshot()
  assert.equal(snapshot?.verdict, 'degraded', '2xx 非协议载荷 = 通道不可用（unknown），不是"没有事实"')
  assert.equal(snapshot?.degradation, 'unversioned')
  assert.equal(snapshot?.stale, true)
  assert.equal(snapshot?.serviceable, false)
  assert.deepEqual(snapshot?.rows, {}, '没有既有行可保留 ⇒ 空行 + 降级标注（绝不是 legacy 或 full）')
  assert.equal(sourceSessionFactsMode(snapshot), 'degraded')
  // 与 404/5xx 同一有界重探纪律：坏载荷不是终态（没有轮询、也没有显式 probe 可依赖）。
  const settled = probeGets
  await waitFor(() => probeGets > settled, 1_000)
  // 通道恢复 = 载荷恢复健康：有限时间内必须回到 ok（不需要 connected false→true
  // 或指纹变化这类外部踢一脚）。
  payload = {
    protocol: 1,
    features: [],
    mode: 'poll',
    cursor: 3,
    host: { state: 'ready', serviceable: true },
    sessions: [{ sessionId: 's1', running: true, updatedAt: 10 }],
  }
  await waitFor(() => source.getSnapshot()?.verdict === 'ok', 1_000)
  const recovered = source.getSnapshot()
  assert.equal(recovered?.degradation, null)
  assert.equal(recovered?.stale, false)
  assert.equal(recovered?.serviceable, true)
  assert.equal(recovered?.rows.s1?.running, true)
  assert.ok(probeGets >= 2, '恢复来自重探（不是轮询：pollIntervalMs=0）')
  source.stop()
})

test('2xx without protocol (unversioned) after a good snapshot is channel-unavailable: rows stay as presence evidence', async () => {
  let payload: unknown = {
    protocol: 1,
    features: [],
    mode: 'poll',
    cursor: 5,
    host: { state: 'ready', serviceable: true },
    sessions: [
      { sessionId: 's1', running: true, updatedAt: 10 },
      { sessionId: 's2', running: false, updatedAt: 11 },
    ],
  }
  const fetchImpl = (async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-unversioned-retain',
    fetchImpl,
    // 轮询刻意远大于重探：本用例只允许 scheduleProbe 驱动的自愈（若轮询兜底，
    // 回退 scheduleProbe 也不会红）。
    pollIntervalMs: 10_000,
    silenceMs: 0,
    reconnectMs: 5,
  })
  source.update({ fingerprint: 'f1', connected: true })
  await waitFor(() => source.getSnapshot()?.verdict === 'ok' && source.getSnapshot()?.rows.s1 !== undefined)
  // 协议载荷变成 2xx 非协议载荷：通道不可用（unknown），但行是**未知**不是**消失**。
  payload = { oops: true }
  // 借一次断连/重连触发这一份坏载荷（重连会清掉 10s 轮询）；此后不得再依赖
  // connected 抖动或指纹变化，只剩 scheduleProbe 这条自愈通路。
  source.update({ fingerprint: 'f1', connected: false })
  source.update({ fingerprint: 'f1', connected: true })
  await waitFor(() => source.getSnapshot()?.degradation === 'unversioned')
  const snapshot = source.getSnapshot()
  assert.equal(snapshot?.verdict, 'degraded')
  assert.equal(snapshot?.stale, true)
  assert.equal(snapshot?.serviceable, false)
  assert.deepEqual(Object.keys(snapshot?.rows ?? {}).sort(), ['s1', 's2'], '既有行必须保留（无壳来源的在场证据）')
  assert.equal(snapshot?.rows.s1?.running, true)
  assert.equal(sourceSessionFactsMode(snapshot), 'degraded')
  // 保留既有行这条出口同样排下一次探测：载荷恢复健康后必须自愈成 ok，
  // 且既有行随新快照继续可用。
  payload = {
    protocol: 1,
    features: [],
    mode: 'poll',
    cursor: 6,
    host: { state: 'ready', serviceable: true },
    sessions: [{ sessionId: 's1', running: false, updatedAt: 12 }],
  }
  await waitFor(() => source.getSnapshot()?.verdict === 'ok', 1_000)
  const healed = source.getSnapshot()
  assert.equal(healed?.degradation, null)
  assert.equal(healed?.stale, false)
  assert.equal(healed?.cursor, 6)
  assert.equal(healed?.rows.s1?.updatedAt, 12)
  assert.equal(healed?.rows.s2, undefined, '健康快照是权威行集（s2 已消失）')
  source.stop()
})
test('a protocol-2 payload still delivers a degraded forward-skew snapshot without starting delivery', async () => {
  let probeGets = 0
  const forward = {
    protocol: 2,
    mode: 'poll',
    features: [],
    cursor: 5,
    host: { state: 'ready', serviceable: true },
    sessions: [],
  }
  const fetchImpl = (async () => {
    probeGets += 1
    return new Response(JSON.stringify(forward), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-forward-skew',
    fetchImpl,
    pollIntervalMs: 10,
    silenceMs: 0,
    reconnectMs: 5,
  })
  try {
    source.update({ fingerprint: 'f1', connected: true })
    await waitFor(() => source.getSnapshot() !== undefined)
    const snapshot = source.getSnapshot()
    assert.equal(snapshot?.verdict, 'degraded')
    assert.equal(snapshot?.degradation, 'forward-skew', '协议超前必须保留降级快照（不许静默清空或折成 legacy）')
    assert.equal(snapshot?.mode, 'poll')
    assert.equal(snapshot?.hostState, 'ready')
    const settled = probeGets
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(probeGets, settled, '降级档不启动交付（不轮询）')
  } finally {
    source.stop()
  }
})

test('isFactsUsable: verdict ok + serviceable false / non-ok / undefined are all unusable', () => {
  const base = { verdict: 'ok', serviceable: true }
  assert.equal(isFactsUsable(base as never), true)
  assert.equal(
    isFactsUsable({ ...base, serviceable: false } as never),
    false,
    'host 不可服务时行只读作未知，不得推进未读/通知',
  )
  assert.equal(isFactsUsable({ ...base, verdict: 'degraded' } as never), false)
  assert.equal(isFactsUsable({ ...base, verdict: 'legacy-gateway' } as never), false)
})


