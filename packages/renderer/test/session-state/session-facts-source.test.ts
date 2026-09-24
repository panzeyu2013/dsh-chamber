/**
 * SessionFactsSource 纯契约。
 *
 * 覆盖：粗分类全分支（404=版本事实；5xx/超时绝不是「旧网关」）、快照/增量/SSE
 * 帧解析、游标幂等、read 透传、serviceable、**源文本锁步**（对着
 * control-plane/src/session-state-protocol.ts 钉共享字面量）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  SESSION_FACTS_DISABLED_CODE,
  __resetSessionFactsGoalWarningForTests,
  SESSION_FACTS_PROTOCOL_VERSION,
  SESSION_FACTS_READ_ALL_ROUTE,
  SESSION_FACTS_READ_ROUTE,
  SESSION_FACTS_ROUTE,
  SESSION_FACTS_STREAM_ROUTE,
  applySessionFactsDelta,
  classifySessionFactsProbe,
  createSessionFactsSource,
  isFactsUsable,
  parseSessionFactsGoalFact,
  parseSessionFactsReadState,
  parseSessionFactsRow,
  parseSessionFactsSnapshotValue,
  parseSessionFactsSseBlock,
} from '../../src/session-facts-source.ts'
import { advanceReadMark } from '../../src/unread-store.ts'
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
  read: { clientId: 'client-a', marks: { s1: 1_700_000_000_150 }, floor: 42 },
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
  source.stop()
})

test('F2: 503 + session_state_disabled publishes watcher-disabled (and drives the sidebar disabled mode)', async () => {
  const { harness, source } = sourceOver([jsonResponse(503, { error: { code: SESSION_FACTS_DISABLED_CODE } })], { reconnectMs: 5 })
  await waitFor(() => source.getSnapshot() !== undefined)
  const snapshot = source.getSnapshot()
  assert.equal(snapshot?.verdict, 'degraded')
  assert.equal(snapshot?.degradation, 'watcher-disabled')
  assert.equal(sourceSessionFactsMode(snapshot), 'disabled')
  // 服务事实不重探（与 mode:'off' 同一语义，正是唯一分类器的等价口径）。
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(harness.calls(), 1)
  source.stop()
})

test('F2: a plain 5xx is unavailable (never legacy) and schedules a bounded reprobe', async () => {
  const { harness, source } = sourceOver([new Response('oops', { status: 502 })], { reconnectMs: 5 })
  await waitFor(() => source.getSnapshot() !== undefined)
  assert.equal(source.getSnapshot()?.verdict, 'degraded')
  assert.equal(source.getSnapshot()?.degradation, 'unavailable')
  await waitFor(() => harness.calls() >= 2, 1_000)
  source.stop()
})

test('F2: protocol 2 is forward-skew; mode off is watcher-disabled; both are version/service facts and never retry', async () => {
  const skew = sourceOver([jsonResponse(200, { ...SNAPSHOT, protocol: 2 })], { reconnectMs: 5 })
  await waitFor(() => skew.source.getSnapshot() !== undefined)
  assert.equal(skew.source.getSnapshot()?.verdict, 'degraded')
  assert.equal(skew.source.getSnapshot()?.degradation, 'forward-skew')
  assert.equal(skew.source.getSnapshot()?.rows.s1.sessionId, 's1', 'forward-skew 与旧行为一致地保留镜像行')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(skew.harness.calls(), 1, '版本事实不重探')
  skew.source.stop()

  const off = sourceOver([jsonResponse(200, { ...SNAPSHOT, mode: 'off' })], { reconnectMs: 5 })
  await waitFor(() => off.source.getSnapshot() !== undefined)
  assert.equal(off.source.getSnapshot()?.degradation, 'watcher-disabled')
  assert.equal(sourceSessionFactsMode(off.source.getSnapshot()), 'disabled')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(off.harness.calls(), 1, '观察者关闭是服务事实，不重探')
  off.source.stop()
})

test('F2: a transport fault after a good mirror keeps the facts and marks them stale', async () => {
  const { source } = sourceOver([
    jsonResponse(200, { ...SNAPSHOT, mode: 'poll', features: [] }),
    new Error('network down'),
  ], { pollIntervalMs: 10, reconnectMs: 5 })
  await waitFor(() => source.getSnapshot()?.rows.s1 !== undefined)
  await waitFor(() => source.getSnapshot()?.stale === true, 1_000)
  const snapshot = source.getSnapshot()
  assert.equal(snapshot?.verdict, 'ok', '传输层坏答案不擦除既有镜像事实')
  assert.equal(snapshot?.degradation, null)
  assert.equal(snapshot?.rows.s1.completedAt, 1_700_000_000_200)
  assert.equal(sourceSessionFactsMode(snapshot), 'degraded', 'stale 事实呈现为受限，绝不冒充 full')
  source.stop()
})

test('F2: a 200 HTML fallback (unversioned) retries on the carrier backoff and recovers to ok', async () => {
  // 反代把未注册路由回落成 200 HTML/SPA 的瞬态：分类语义仍是 unversioned
  // （先发布 degraded），但 carrier 层按 reconnectMs 有界重探，下一答恢复 ok。
  const { harness, source } = sourceOver([
    new Response('<html>spa fallback</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    jsonResponse(200, { ...SNAPSHOT, mode: 'poll', features: [] }),
  ], { reconnectMs: 5 })
  await waitFor(() => source.getSnapshot()?.degradation === 'unversioned')
  assert.equal(sourceSessionFactsMode(source.getSnapshot()), 'degraded')
  await waitFor(() => source.getSnapshot()?.verdict === 'ok', 1_000)
  assert.equal(source.getSnapshot()?.degradation, null)
  assert.equal(source.getSnapshot()?.rows.s1.sessionId, 's1', '恢复后带回真实镜像行')
  assert.ok(harness.calls() >= 2, '不可解析的 2xx 必须按 reconnectMs 有界重探')
  source.stop()
})

test('F2: an unversioned refetch re-arms the stream instead of wedging', async () => {
  let streams = 0
  let probes = 0
  const fetchImpl = (async (url: unknown) => {
    const text = String(url)
    if (text.endsWith(SESSION_FACTS_STREAM_ROUTE)) {
      streams += 1
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // 第一条流立刻要求整量重取；重取答案是 200 HTML（不可解析）。
          if (streams === 1) controller.enqueue(new TextEncoder().encode('event: resync\ndata: {}\n\n'))
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
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
    streamConnectTimeoutMs: 60_000,
    reconnectMs: 10,
  })
  source.subscribe(() => {})
  source.update({ fingerprint: 'f1', connected: true })
  await waitFor(() => streams >= 1)
  await waitFor(() => source.getSnapshot()?.degradation === 'unversioned', 2_000)
  // 与 probe 共用 shouldRetryProbe：refetch 的恢复动作是重连流，不得静止降级。
  await waitFor(() => streams >= 2, 2_000)
  source.stop()
})

test('snapshot parser: rows, host gate, read state and unknown fields are defensive', () => {
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
  assert.deepEqual(parsed.read?.marks, { s1: 1_700_000_000_150 })
  assert.equal(parsed.read?.floor, 42)
  const stopped = parseSessionFactsSnapshotValue({ ...SNAPSHOT, host: { now: 1, serviceable: false, state: 'stopped' } })
  assert.equal(stopped?.serviceable, false)
  assert.equal(stopped?.hostState, 'stopped')
  // 未知/坏字段绝不被当成事实。
  assert.equal(parseSessionFactsSnapshotValue({ ...SNAPSHOT, host: {} })?.hostState, 'unknown')
  assert.equal(parseSessionFactsRow({ sessionId: 'x', updatedAt: -5 })?.updatedAt, 0)
  assert.equal(parseSessionFactsRow({}), null)
  assert.equal(parseSessionFactsReadState(null), null)
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
    read: base.read,
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
  // 行内容变化 ⇒ changed；游标推进；read 随帧透传。
  const changed = applySessionFactsDelta(added.next!, {
    cursor: 9,
    sessions: [{ sessionId: 's2', running: false, updatedAt: 2 }],
    read: { clientId: 'client-b', marks: { s2: 2 }, floor: 0 },
  })
  assert.equal(changed.hint, 'changed')
  assert.equal(changed.next?.rows.s2.running, false)
  assert.deepEqual(changed.next?.read?.marks, { s2: 2 })
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
    read: null,
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

test('SSE frame parser: data/id/event; comment-only heartbeat returns null', () => {
  assert.deepEqual(
    parseSessionFactsSseBlock('event: session-state\nid: 12\ndata: {"cursor":12}'),
    { event: 'session-state', id: 12, data: '{"cursor":12}' },
  )
  assert.deepEqual(parseSessionFactsSseBlock('data: line1\ndata: line2'), { event: '', id: null, data: 'line1\nline2' })
  assert.equal(parseSessionFactsSseBlock(': keepalive'), null)
  assert.equal(parseSessionFactsSseBlock('event: sync'), null)
})

test('lockstep: our route/protocol/disabled literals are pinned to the control-plane single source', () => {
  const protocolSource = stripComments(readFileSync(
    fileURLToPath(new URL('../../../control-plane/src/session-state-protocol.ts', import.meta.url)),
    'utf8',
  ))
  // 权威模块的字面量（源文本口径；本包不能 import 它）。
  assert.ok(protocolSource.includes("export const SESSION_STATE_PATH = '/chamber/session-state'"))
  assert.ok(protocolSource.includes('SESSION_STATE_STREAM_PATH = `${SESSION_STATE_PATH}/stream`'))
  assert.ok(protocolSource.includes('SESSION_STATE_READ_PATH = `${SESSION_STATE_PATH}/read`'))
  assert.ok(protocolSource.includes('SESSION_STATE_READ_ALL_PATH = `${SESSION_STATE_PATH}/read-all`'))
  assert.ok(protocolSource.includes('export const PROTOCOL_VERSION = 1'))
  assert.ok(protocolSource.includes('session_state_disabled'))
  assert.ok(protocolSource.includes('serviceable'))
  assert.ok(protocolSource.includes('completedAtSource'))
  // 本侧常量逐字节相同。
  assert.equal(SESSION_FACTS_ROUTE, '/chamber/session-state')
  assert.equal(SESSION_FACTS_STREAM_ROUTE, '/chamber/session-state/stream')
  assert.equal(SESSION_FACTS_READ_ROUTE, '/chamber/session-state/read')
  assert.equal(SESSION_FACTS_READ_ALL_ROUTE, '/chamber/session-state/read-all')
  assert.equal(SESSION_FACTS_PROTOCOL_VERSION, 1)
  assert.equal(SESSION_FACTS_DISABLED_CODE, 'session_state_disabled')
})

// ── ack 失败重放（恢复钩子 = 既有 facts 帧到达点） ─────────────────────

/** 假件：GET 回合法快照；POST 可编程失败；服务端按单调 max 合并水位。 */
function r22Harness(options: { ackFailures?: number; ackStatus?: number } = {}) {
  const gets: string[] = []
  const acks: Array<{ url: string; body: Record<string, unknown> }> = []
  const server = new Map<string, number>()
  let ackFailures = options.ackFailures ?? 0
  const fetchImpl = (async (url: unknown, init?: unknown) => {
    const request = (init ?? {}) as RequestInit
    const text = String(url)
    if (request.method === 'POST') {
      const body = JSON.parse(String(request.body)) as Record<string, unknown>
      acks.push({ url: text, body })
      if (ackFailures > 0) {
        ackFailures -= 1
        return new Response('{}', { status: options.ackStatus ?? 503 })
      }
      // 服务端单调 max 合并（mergeReadMark / markAllRead floor 的等价物）。
      if (typeof body.sessionId === 'string') {
        server.set(body.sessionId, Math.max(server.get(body.sessionId) ?? 0, Number(body.readThrough)))
      } else {
        server.set('__floor__', Math.max(server.get('__floor__') ?? 0, Number(body.through)))
      }
      return new Response('{"ok":true}', { status: 200 })
    }
    gets.push(text)
    return new Response(JSON.stringify({
      protocol: 1,
      mode: 'poll',
      features: [],
      cursor: 1,
      host: { state: 'ready', serviceable: true },
      sessions: [{ sessionId: 's1', running: false, updatedAt: 100 }],
      read: { clientId: 'client-a', marks: {}, floor: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetchImpl, gets, acks, server }
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(condition(), 'waitFor 超时')
}

test('R22: a failed read ack is replayed on the next facts snapshot (existing channel-alive hook)', async () => {
  const harness = r22Harness({ ackFailures: 1, ackStatus: 503 })
  const source = createSessionFactsSource({
    sourceId: 'gw-a',
    fetchImpl: harness.fetchImpl,
    pollIntervalMs: 10,
    silenceMs: 0,
  })
  source.subscribe(() => {})
  source.update({ fingerprint: 'f1', connected: true })
  await waitFor(() => harness.gets.length >= 1)
  source.ackRead('client-a', 's1', 42)
  await waitFor(() => harness.acks.length >= 1)
  assert.equal(harness.acks[0].url, '/api/i/gw-a/chamber/session-state/read')
  assert.deepEqual(harness.acks[0].body, { clientId: 'client-a', sessionId: 's1', readThrough: 42 })
  // 下一次 poll 快照到达 = 既有的「通道恢复」信号 ⇒ 重放。
  await waitFor(() => harness.acks.length >= 2)
  assert.deepEqual(harness.acks[1].body, harness.acks[0].body, '重放同值（服务端 max ⇒ 幂等）')
  assert.equal(harness.server.get('s1'), 42, '服务端只升不降')
  // 2xx 出队后：后续快照不得再重放。
  await waitFor(() => harness.gets.length >= 4)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(harness.acks.length, 2, '成功出队后不得重复上行')
  source.stop()
})

test('R22: a failed read-all floor replays on recovery and never regresses the server', async () => {
  const harness = r22Harness({ ackFailures: 1, ackStatus: 500 })
  const source = createSessionFactsSource({
    sourceId: 'gw-b',
    fetchImpl: harness.fetchImpl,
    pollIntervalMs: 10,
    silenceMs: 0,
  })
  source.subscribe(() => {})
  source.update({ fingerprint: 'f1', connected: true })
  await waitFor(() => harness.gets.length >= 1)
  source.ackAllRead('client-a', 77)
  await waitFor(() => harness.acks.length >= 1)
  assert.equal(harness.acks[0].url, '/api/i/gw-b/chamber/session-state/read-all')
  await waitFor(() => harness.acks.length >= 2)
  assert.deepEqual(harness.acks[1].body, { clientId: 'client-a', through: 77 })
  assert.equal(harness.server.get('__floor__'), 77, '同值重放不改变 floor')
  source.stop()
})

test('R22: a hung ack POST never blocks snapshot delivery or the synchronous ack call', async () => {
  const harness = r22Harness()
  let hung = 0
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      hung += 1
      // 最坏的离线悬挂：永不结算。
      return await new Promise<Response>(() => {})
    }
    return harness.fetchImpl(url, init)
  }) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-c',
    fetchImpl,
    pollIntervalMs: 10,
    silenceMs: 0,
  })
  const snapshots: Array<unknown> = []
  source.subscribe(snapshot => snapshots.push(snapshot))
  source.update({ fingerprint: 'f1', connected: true })
  await waitFor(() => snapshots.length >= 1)
  assert.equal(source.ackRead('client-a', 's1', 42), undefined, 'ackRead 同步返回：读推进不等待网络')
  assert.ok(hung >= 1)
  // 待发表里有未决条目时，快照通道照常推进到第 3 帧（poll 不被阻塞）。
  await waitFor(() => snapshots.length >= 3)
  assert.notEqual(source.getSnapshot(), undefined, '读推进/快照投递不因待发表阻塞')
  // 本地读水位推进是纯本地动作，不依赖任何队列。
  assert.equal(advanceReadMark(undefined, 42), 42)
  assert.equal(source.getSnapshot()?.rows.s1.updatedAt, 100)
  source.stop()
})

test('R22: the source-level queue honors the injected bound and reports overflow', async () => {
  const diagnostics: string[] = []
  const harness = r22Harness({ ackFailures: 99, ackStatus: 503 })
  const source = createSessionFactsSource({
    sourceId: 'gw-d',
    fetchImpl: harness.fetchImpl,
    pollIntervalMs: 10,
    silenceMs: 0,
    ackQueueMax: 1,
    onDiagnostic: (message, error) => diagnostics.push(message + ' ' + String(error)),
  })
  source.update({ fingerprint: 'f1', connected: true })
  await waitFor(() => harness.gets.length >= 1)
  source.ackRead('client-a', 's1', 1)
  source.ackRead('client-a', 's2', 1)
  await waitFor(() => diagnostics.some(line => line.includes('overflow')))
  assert.ok(diagnostics.some(line => line.includes('overflow')), '上限淘汰必须经诊断可见')
  source.stop()
})

// ── SSE 收口：建连 deadline 与「请求发起即武装」的静默看门狗 ───────────────

const SSE_PROBE_BODY = {
  protocol: 1,
  mode: 'sse',
  features: ['session-state.snapshot', 'session-state.stream', 'session-state.host-clock'],
  cursor: 3,
  host: { now: 1_700_000_000_000, serviceable: true, state: 'ready' },
  sessions: [],
  read: { clientId: 'client-a', marks: {}, floor: 0 },
}

/**
 * SSE 假件：probe GET 立即回一份 sse 快照把流带起来；stream GET 按场景选择
 * 「永不回响应头」（半死隧道：fetch 永不落定）或「回响应头但永不产出帧」（静默载体）。
 */
function sseStreamHarness(behavior: 'never-headers' | 'silent-body') {
  const streams: Array<{ url: string; aborted: () => boolean }> = []
  const probeGets: string[] = []
  const fetchImpl = (async (url: unknown, init?: unknown) => {
    const text = String(url)
    if (text.endsWith(SESSION_FACTS_STREAM_ROUTE)) {
      const signal = ((init ?? {}) as RequestInit).signal as AbortSignal
      streams.push({ url: text, aborted: () => signal.aborted })
      if (behavior === 'never-headers') {
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        })
      }
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    probeGets.push(text)
    return new Response(JSON.stringify(SSE_PROBE_BODY), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, streams, probeGets }
}

test('R21: a stream whose response headers never arrive hits the connect deadline and is retried', async () => {
  const harness = sseStreamHarness('never-headers')
  const diagnostics: string[] = []
  const source = createSessionFactsSource({
    sourceId: 'gw-sse-wedge',
    fetchImpl: harness.fetchImpl,
    silenceMs: 0,
    streamConnectTimeoutMs: 20,
    reconnectMs: 10,
    onDiagnostic: message => diagnostics.push(message),
  })
  source.subscribe(() => {})
  source.update({ fingerprint: 'f1', connected: true })
  await waitFor(() => harness.streams.length >= 1)
  // 关键回归：没有 deadline 时这条流永久停在 in-flight（第二个请求永不出现）。
  await waitFor(() => harness.streams.length >= 2, 2_000)
  assert.ok(harness.streams[0].aborted(), '建连超时必须 abort 在途 stream')
  assert.ok(
    diagnostics.some(line => line.includes('connect timed out')),
    '建连超时必须响亮诊断（不许静默楔死）',
  )
  assert.equal(source.getSnapshot()?.stale, true, '收口后事实必须标 stale')
  source.stop()
  const settled = harness.streams.length
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(harness.streams.length, settled, 'stop 必须清掉重连定时器（不得再起新流）')
  assert.ok(harness.streams[settled - 1].aborted(), 'stop 必须 abort 在途流')
})

test('R21: a silent stream (headers arrived, no frames) is re-subscribed by the watchdog armed at request start', async () => {
  const harness = sseStreamHarness('silent-body')
  const diagnostics: string[] = []
  const source = createSessionFactsSource({
    sourceId: 'gw-sse-silent',
    fetchImpl: harness.fetchImpl,
    // 看门狗间隔 floor = 1s；建连 deadline 远大于它 ⇒ 静默臂先收口。
    silenceMs: 10,
    streamConnectTimeoutMs: 60_000,
    reconnectMs: 10,
    onDiagnostic: message => diagnostics.push(message),
  })
  source.subscribe(() => {})
  source.update({ fingerprint: 'f1', connected: true })
  await waitFor(() => harness.streams.length >= 1)
  await waitFor(() => diagnostics.some(line => line.includes('stream silent')), 3_000)
  assert.ok(harness.streams[0].aborted(), '静默收口必须关掉旧流')
  // 收口路径 = 整量重取（probe GET）+ 重订阅：都必须在有限时间内发生。
  await waitFor(() => harness.probeGets.length >= 2, 2_000)
  await waitFor(() => harness.streams.length >= 2, 2_000)
  source.stop()
})

// ── 快照构造单一工厂（probe / SSE sync 帧 / refetch 同形状） ─────────────

test('snapshot factory: an SSE sync frame builds the same shape as the probe', async () => {
  const syncFrame = JSON.stringify({
    protocol: 1,
    mode: null,
    cursor: 9,
    host: { state: 'stopped', serviceable: false },
    sessions: [],
  })
  const fetchImpl = (async (url: unknown) => {
    const text = String(url)
    if (text.endsWith(SESSION_FACTS_STREAM_ROUTE)) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: sync\ndata: ' + syncFrame + '\n\n'))
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response(JSON.stringify(SSE_PROBE_BODY), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-factory',
    fetchImpl,
    silenceMs: 0,
    streamConnectTimeoutMs: 60_000,
  })
  source.update({ fingerprint: 'f1', connected: true })
  await waitFor(() => source.getSnapshot()?.cursor === 9)
  const snapshot = source.getSnapshot()
  assert.equal(snapshot?.verdict, 'ok')
  assert.equal(snapshot?.degradation, null)
  assert.equal(snapshot?.hostState, 'stopped')
  assert.equal(snapshot?.serviceable, false)
  assert.equal(snapshot?.stale, false)
  assert.deepEqual(snapshot?.rows, {})
  assert.ok((snapshot?.lastEventAt ?? 0) > 0, '工厂必须盖 lastEventAt')
  source.stop()
})

test('snapshot factory negative: a malformed sync frame refetches instead of silently clearing the snapshot', async () => {
  const probeGets: string[] = []
  let streams = 0
  const fetchImpl = (async (url: unknown) => {
    const text = String(url)
    if (text.endsWith(SESSION_FACTS_STREAM_ROUTE)) {
      streams += 1
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // 只有第一条流发坏帧；重取后的第二条流保持静默，避免测试内无限重取。
          if (streams === 1) controller.enqueue(new TextEncoder().encode('event: sync\ndata: {"oops":true}\n\n'))
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    probeGets.push(text)
    return new Response(JSON.stringify(SSE_PROBE_BODY), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-factory-bad',
    fetchImpl,
    silenceMs: 0,
    streamConnectTimeoutMs: 60_000,
  })
  source.update({ fingerprint: 'f1', connected: true })
  await waitFor(() => probeGets.length >= 1)
  await waitFor(() => probeGets.length >= 2, 2_000)
  assert.equal(source.getSnapshot()?.cursor, SSE_PROBE_BODY.cursor, '坏帧不得清空既有快照（走 refetch 收敛）')
  source.stop()
})

// ── probe outcome → 快照（2026-12 单源化：classifier 是唯一判定 owner） ─────────
// 404 legacy 的成立面由上面的 F2 用例覆盖（verdict / degradation / mode null /
// stale false / 有界重探），这里只留 unversioned 的发布契约。

test('404 producer: the probe delivers an EMPTY legacy snapshot (not undefined) so mode legacy is reachable', async () => {
  let probeGets = 0
  const fetchImpl = (async () => {
    probeGets += 1
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  const source = createSessionFactsSource({
    sourceId: 'gw-legacy-producer',
    fetchImpl,
    pollIntervalMs: 0,
    silenceMs: 0,
    reconnectMs: 5,
  })
  source.update({ fingerprint: 'f1', connected: true })
  await waitFor(() => source.getSnapshot() !== undefined)
  const snapshot = source.getSnapshot()
  assert.equal(snapshot?.verdict, 'legacy-gateway', '404 是版本事实，不是"没有事实"')
  assert.equal(snapshot?.degradation, 'legacy-gateway')
  assert.equal(snapshot?.mode, null)
  assert.deepEqual(snapshot?.rows, {}, 'legacy 快照是空行（事实），不是猜出来的行')
  assert.equal(snapshot?.stale, false)
  assert.equal(sourceSessionFactsMode(snapshot), 'legacy', '侧栏 legacy 档位此前因 404 折 undefined 恒不可达')
  // 网关可能升级：legacy 走有界低频重探，而不是停摆。
  await waitFor(() => probeGets >= 2, 1_000)
  // 且它**从未**见过协议行 ⇒ 重探仍是空权威快照（不得滑进「曾有历史」出口
  // 去伪造 stale/保留行）。
  const repeated = source.getSnapshot()
  assert.equal(repeated?.stale, false, '没有历史行的 404 每次都交给空权威快照')
  assert.deepEqual(repeated?.rows, {})
  assert.equal(repeated?.cursor, 0)
  assert.equal(repeated?.serviceable, false)
  source.stop()
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
    read: { clientId: 'client-a', marks: { s1: 400 }, floor: 7 },
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
  assert.deepEqual(legacy?.read, good.read, 'read 权威状态同样保留')
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
    read: { clientId: 'client-a', marks: { s1: 500 }, floor: 7 },
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
    read: { clientId: null, marks: {}, floor: 0 },
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
    read: { clientId: null, marks: {}, floor: 0 },
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
  source.stop()
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


