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
  SESSION_FACTS_PROTOCOL_VERSION,
  SESSION_FACTS_READ_ALL_ROUTE,
  SESSION_FACTS_READ_ROUTE,
  SESSION_FACTS_ROUTE,
  SESSION_FACTS_STREAM_ROUTE,
  applySessionFactsDelta,
  classifySessionFactsProbe,
  createSessionFactsSource,
  parseSessionFactsReadState,
  parseSessionFactsRow,
  parseSessionFactsSnapshotValue,
  parseSessionFactsSseBlock,
} from '../../src/session-facts-source.ts'
import { advanceReadMark } from '../../src/unread-store.ts'
import { sourceSessionFactsMode } from '../../src/session-facts-mode.ts'
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
    mode: 'sse' as const,
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

test('delta: host gate and mode updates ride the frame', () => {
  const base = parseSessionFactsSnapshotValue(SNAPSHOT)!
  const current = {
    verdict: 'ok' as const,
    degradation: null,
    mode: 'sse' as const,
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
    mode: 'poll',
  })
  assert.equal(outcome.next?.hostState, 'stopped')
  assert.equal(outcome.next?.serviceable, false)
  assert.equal(outcome.next?.mode, 'poll')
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

test('snapshot factory: an SSE sync frame builds the same shape as the probe and falls back to the prior mode', async () => {
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
  assert.equal(snapshot?.mode, 'sse', 'sync 帧缺 mode 时沿用上一份快照的 mode')
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
  source.stop()
})

test('2xx without protocol (unversioned) keeps the snapshot empty and does not fake a legacy row', async () => {
  let probeGets = 0
  const fetchImpl = (async () => {
    probeGets += 1
    return new Response(JSON.stringify({ oops: true }), {
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
  let emitted = 0
  source.subscribe(() => { emitted += 1 })
  source.update({ fingerprint: 'f1', connected: true })
  await waitFor(() => emitted >= 1)
  assert.equal(source.getSnapshot(), undefined, '2xx 非协议载荷 ⇒ 无快照（旧语义：unversioned 等价 undefined，绝非 legacy）')
  const settled = probeGets
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(probeGets, settled, 'unversioned 不排重探/轮询，等下一次显式 probe')
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


