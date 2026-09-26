/**
 * 无壳观察者锁。
 *
 * 钉死四件事：① 开场帧精确（只开 $events）；② **永不发 $events/result**（瀑布只观察——
 * 回答会把等待中的审批替所有客户端结算掉）；③ 每条 true→false 边沿**恰好一次**
 * `session/follow`，分类 completed/user-stopped/neutral 与 watcher 同规；④ 读不到尾巴
 * 时降级仍武装（绝不丢真完成）。
 *
 * Run directly: node test/session-state/source-mux-facts.test.ts
 */
import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TABLE_SNAPSHOT } from '@dsh-chamber/dsh-stream-state'
import { fileURLToPath } from 'node:url'
import {
  classifyTurnEndWire,
  createSourceMuxFacts,
  EVENTS_ENDPOINT,
  isMuxObservableSourceKind,
  MUX_PATH,
  muxUrlFor,
  openEventsFrame,
  parseMuxFrame,
  publishSourceMuxInstrument,
  rowFromListItem,
  type MuxSocket,
} from '../../src/source-mux-facts.ts'
// 可判性唯一家：退役快照必须以它判定（不得在测试里自造第二套规则）。
import { isFactsDecisionUsable } from '../../src/session-facts-source.ts'

const SOURCE = readFileSync(fileURLToPath(new URL('../../src/source-mux-facts.ts', import.meta.url)), 'utf8')

test('lockstep: the mux route and $events literals match the control-plane and api-gateway sources', () => {
  // This package cannot import either server package; the literals are pinned
  // against both source texts so a vendor rename or a fork-side edit fails loud
  // (control-plane pins the api-gateway copy in its own suite; this closes the
  // renderer leg of the triangle).
  assert.equal(MUX_PATH, '/api/remote.mux')
  assert.equal(EVENTS_ENDPOINT, '$events')
  const sources = {
    'control-plane/src/session-mux.ts': readFileSync(
      new URL('../../../control-plane/src/session-mux.ts', import.meta.url), 'utf8'),
    'dsh-api-gateway/src/stream-protocol.ts': readFileSync(
      new URL('../../../dsh-api-gateway/src/stream-protocol.ts', import.meta.url), 'utf8'),
  }
  for (const [label, source] of Object.entries(sources)) {
    assert.ok(source.includes(`export const REMOTE_STREAM_MUX_PATH = '${MUX_PATH}'`),
      label + ' must declare REMOTE_STREAM_MUX_PATH = ' + JSON.stringify(MUX_PATH))
    assert.ok(source.includes(`export const REMOTE_EVENT_STREAM_ENDPOINT = '${EVENTS_ENDPOINT}'`),
      label + ' must declare REMOTE_EVENT_STREAM_ENDPOINT = ' + JSON.stringify(EVENTS_ENDPOINT))
  }
  assert.match(sources['control-plane/src/session-mux.ts'], /REMOTE_EVENT_RESULT_ENDPOINT = '\$events\/result'/)
})

test('the observer covers every dsh-protocol source: local profile and remote instances, never gateway', () => {
  // The hook filter once said kind === 'dsh' only: the LOCAL session then had no
  // content evidence and no closed-shell fact channel at all.
  assert.equal(isMuxObservableSourceKind('local'), true)
  assert.equal(isMuxObservableSourceKind('dsh'), true)
  assert.equal(isMuxObservableSourceKind('gateway'), false)
  assert.equal(isMuxObservableSourceKind('unknown'), false)
  assert.equal(muxUrlFor('http://127.0.0.1:17500', 'local'), 'ws://127.0.0.1:17500/api/i/local/api/remote.mux')
  // The lifecycle hook must consume the predicate, not re-state a kind literal.
  const hook = readFileSync(fileURLToPath(new URL('../../src/app-hooks/use-session-facts-lifecycle.ts', import.meta.url)), 'utf8')
  assert.match(hook, /isMuxObservableSourceKind\(server\.kind\)/)
  assert.doesNotMatch(hook, /server\.kind === 'dsh'|server\.kind !== 'dsh'/)
})

test('silence is neither content nor carrier evidence: no watchdog, long-lived socket', () => {
  const source = SOURCE.replace(/\/\*[\s\S]*?\*\//gu, '')
  // ① Source-level $events silence is NOT this session's content progress (assistant
  // text travels its own session/follow stream), so the observer publishes no
  // content-stall signal at all; page evidence comes from session-content-stall.ts.
  assert.doesNotMatch(source, /contentSilenceSinceMs|contentStallElapsedMs|lastContentAt/)
  assert.doesNotMatch(source, /registerSourceContentStall/)
  // ② Nor is it carrier evidence: the measured $events logical stream delivered
  // only its ready frame for a whole socket lifetime (facts come from the unary
  // baseline), so a silence-driven replacement was pure churn — 9 replacements in
  // 8 idle minutes, each successor socket dying at exactly 45.0s. The whole
  // mechanism (dep, constant, timer, arm/clear) must stay deleted.
  for (const symbol of ['DEFAULT_FACTS_SILENCE_MS', 'silenceTimeoutMs', 'silenceTimer', 'armSilence', 'clearSilence']) {
    assert.equal(source.includes(symbol), false, symbol + ' must stay deleted')
  }
  // reconnects counts real carrier replacements only (scheduleReconnect's backoff).
  assert.equal((source.match(/reconnects \+= 1/g) ?? []).length, 1,
    'reconnects += 1 may exist only in the real-failure backoff path')
})


class FakeSocket implements MuxSocket {
  sent: string[] = []
  followOpens: Array<{ streamId: string; payload: unknown }> = []
  onFollowOpen: ((streamId: string, payload: unknown) => void) | null = null
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event?: unknown) => void) | null = null
  onerror: ((event?: unknown) => void) | null = null
  send(data: string): void {
    this.sent.push(data)
    const frame = JSON.parse(data) as { type: string; streamId: string; endpoint?: string; payload?: unknown }
    if (frame.type === 'open' && frame.endpoint === 'session/follow') {
      this.followOpens.push({ streamId: frame.streamId, payload: frame.payload })
      this.onFollowOpen?.(frame.streamId, frame.payload)
    }
  }
  close(): void { this.closed = true }
  open(): void { this.onopen?.() }
  item(value: unknown): void { this.onmessage?.({ data: JSON.stringify({ type: 'item', streamId: 'events', value }) }) }
  followItem(streamId: string, value: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'item', streamId, value }) })
  }
  followEnd(streamId: string): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'end', streamId }) })
  }
  replyFollow(index: number, value: unknown): void {
    const streamId = this.followOpens[index]?.streamId
    assert.ok(streamId, 'follow stream was not opened')
    this.followItem(streamId, value)
  }
}

/** fetch 假件：按 rpcId 回显信封（envelope 校验要求 rpcId 一致）。 */
function rpcFetch(handlers: Record<string, (payload: unknown) => unknown>) {
  return async (_url: string, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { rpcId: string; method: string; payload: unknown }
    assert.notEqual(body.method, 'session/follow', 'follow must use the MUX stream')
    const handler = handlers[body.method]
    const value = handler === undefined ? null : handler(body.payload)
    const result = value === 'FAIL' ? { ok: false, error: { code: 'x' } } : { ok: true, value }
    return { ok: true, status: 200, json: async () => ({ type: 'server-response', rpcId: body.rpcId, result }) } as never
  }
}

function followSnapshot(reason: unknown, time?: number) {
  return { type: 'snapshot', records: [{ type: 'event', event: {
    type: 'turn/end', ...(time === undefined ? {} : { time }), data: { reason },
  } }] }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  // 预算 ≈1.6s：宽限类用例的 carrierGraceMs=300（真实计时器）必须能在预算内被观察到到期，
  // 否则用例会以「产品没降级」的假象失败（100×2ms 只有 ~270ms，一比三都不够）。
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 4))
  }
  assert.fail(message)
}

/** Drain microtasks while setTimeout is mocked (setImmediate stays real). */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  await new Promise<void>(resolve => { setImmediate(resolve) })
}

function deferredRpc() {
  const lists: Array<(value: unknown) => void> = []
  const fetchImpl = async (_url: string, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { rpcId: string; method: string }
    assert.equal(body.method, 'session/list', 'follow must use the MUX stream')
    const value = await new Promise<unknown>(resolve => lists.push(resolve))
    return { ok: true, status: 200, json: async () => ({
      type: 'server-response', rpcId: body.rpcId,
      result: value === 'FAIL' ? { ok: false, error: { code: 'x' } } : { ok: true, value },
    }) } as never
  }
  return { lists, fetchImpl }
}

test('a socket ready frame cannot certify facts after a failed first baseline', async () => {
  const socket = new FakeSocket()
  const snapshots: Array<{ verdict: string }> = []
  const facts = createSourceMuxFacts({
    sourceId: 'degraded', origin: 'http://cp', onSnapshot: snapshot => snapshots.push(snapshot),
    openSocket: () => socket,
    fetchImpl: rpcFetch({ 'session/list': () => 'FAIL' }) as never,
  })
  try {
    facts.start()
    socket.open()
    socket.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => facts.status().baselineFailures === 1, 'baseline failure did not surface')
    assert.equal(facts.status().ready, false)
    assert.equal(snapshots.at(-1)?.verdict, 'degraded')
  } finally { facts.stop() }
})

test('stop() retires a readable snapshot to degraded: dead-carrier rows never stay decisive', async () => {
  // 缺陷（round-2 红队坐实）：观察者 stop() 之前不发任何快照、之后 emit 又被拦，store 里
  // 会永久留着最后一份 readable 快照（stale:false / serviceable:true）——控制面状态抢先于
  // mux socket 的 close/静默 时，死载体的行仍被判定面当证据。退役必须走成"保留行 + 标不可用"。
  const socket = new FakeSocket()
  const snapshots: Array<Record<string, unknown>> = []
  const facts = createSourceMuxFacts({
    sourceId: 'retire', origin: 'http://cp', onSnapshot: snapshot => snapshots.push(snapshot as never),
    openSocket: () => socket,
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [{ sessionId: 's1', running: false, updatedAt: 7 }] }) }) as never,
  })
  facts.start()
  socket.open()
  socket.item({ type: 'ready', clientId: 'c' })
  await waitFor(() => facts.status().ready, 'initial baseline did not settle')
  const live = snapshots.at(-1)!
  assert.equal(isFactsDecisionUsable(live as never), true, 'ready 观察者的快照必须可判（前置）')
  facts.stop()
  const retired = snapshots.at(-1)!
  assert.equal(retired.stale, true, '退役快照必须标 stale')
  assert.equal(retired.serviceable, false)
  assert.equal(retired.verdict, 'degraded')
  assert.equal(isFactsDecisionUsable(retired as never), false, '退役后判定面不得再把死载体的行当证据')
  assert.deepEqual(Object.keys(retired.rows as object), ['s1'], '在场证据保留（不得清成权威空集）')
})

test('a malformed ready frame cannot certify facts and never churns the socket', async () => {
  const sockets: FakeSocket[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'bad-ready', origin: 'http://cp', onSnapshot: () => {}, reconcileIntervalMs: 20,
    openSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
  })
  try {
    facts.start()
    sockets[0]!.open()
    sockets[0]!.item({ type: 'ready' })
    await waitFor(() => facts.status().baselines === 1, 'baseline missing')
    assert.equal(facts.status().ready, false, 'ready requires a nonempty clientId')
    const baselines = facts.status().baselines
    for (let i = 0; i < 4; i += 1) {
      sockets[0]!.item({ type: 'emit', event: '' })
      await new Promise(resolve => setTimeout(resolve, 6))
    }
    // A frame that carries no event must not renew the subscription (and, with no
    // watchdog left, must not replace the carrier either): only the periodic
    // baseline keeps running on the same socket.
    await waitFor(() => facts.status().baselines >= baselines + 3, 'periodic reconcile did not continue')
    assert.equal(sockets.length, 1, 'malformed frames must not churn the socket')
    assert.equal(sockets[0]!.closed, false)
    assert.equal(facts.status().reconnects, 0)
  } finally { facts.stop() }
})

test('a silent live socket is never replaced, degraded or reconnected (long-lived carrier)', async () => {
  const sockets: FakeSocket[] = []
  const verdicts: string[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'idle', origin: 'http://cp', reconcileIntervalMs: 20,
    onSnapshot: snapshot => verdicts.push(snapshot.verdict),
    openSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
  })
  try {
    facts.start()
    sockets[0]!.open()
    sockets[0]!.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => facts.status().ready, 'initial socket did not become ready')
    const verdictsAtReady = verdicts.length
    // Three full reconcile ticks with ZERO $events frames: the old watchdog
    // replaced the socket at 45s of silence (and degraded the facts meanwhile);
    // the carrier must now live until the source retires.
    await waitFor(() => facts.status().baselines >= 4, 'three idle reconcile ticks did not run')
    assert.equal(sockets.length, 1, 'silence must not replace the socket')
    assert.equal(sockets[0]!.closed, false)
    assert.equal(facts.status().reconnects, 0, 'silence is not a reconnect')
    assert.equal(facts.status().ready, true)
    assert.equal(verdicts.slice(verdictsAtReady).includes('degraded'), false,
      'a live socket must not publish a degraded snapshot on silence')
    assert.equal(verdicts.at(-1), 'ok')
  } finally { facts.stop() }
})

test('three minutes of silence on a live socket change nothing (the retired 45s swap, soak)', async (t) => {
  // Behavioral counterpart of the harness record: the removed watchdog replaced the
  // socket at exactly 45.0s of $events silence (run13: 9 replacements in 8 idle
  // minutes). The short test above only spans ~3 reconcile ticks; this one advances
  // three MINUTES of mocked time over a socket that stays silent after `ready`.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => t.mock.timers.reset())
  const sockets: FakeSocket[] = []
  const verdicts: string[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'soak', origin: 'http://cp',
    onSnapshot: snapshot => verdicts.push(snapshot.verdict),
    openSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
  })
  try {
    facts.start()
    sockets[0]!.open()
    sockets[0]!.item({ type: 'ready', clientId: 'c' })
    await settleMicrotasks()
    assert.equal(facts.status().ready, true, 'the socket must be ready before the soak')
    const verdictsAtReady = verdicts.length
    for (let minute = 0; minute < 3; minute += 1) {
      t.mock.timers.tick(60_000)
      await settleMicrotasks()
    }
    assert.equal(sockets.length, 1, 'silence must not replace the socket - not even past 45s')
    assert.equal(sockets[0]!.closed, false, 'the long-lived socket stays open')
    assert.equal(facts.status().reconnects, 0, 'silence is never a reconnect')
    assert.equal(facts.status().ready, true)
    assert.equal(facts.status().baselines >= 4, true, 'the unary baseline keeps certifying facts over silence')
    assert.equal(verdicts.slice(verdictsAtReady).includes('degraded'), false,
      'a silent live socket must never degrade the facts')
  } finally { facts.stop() }
})

test('a carrier failure holds decidability through the grace, then degrades if no baseline lands', async () => {
  const sockets: FakeSocket[] = []
  const verdicts: string[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'carrier-loss', origin: 'http://cp', carrierGraceMs: 300,
    onSnapshot: snapshot => verdicts.push(snapshot.verdict),
    openSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
  })
  try {
    facts.start()
    sockets[0]!.open()
    sockets[0]!.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => facts.status().ready, 'initial socket did not become ready')
    // 换载体本身不是「不可判」：旧基线在宽限内仍是可判事实。静默换代退役后载体失效
    // 只来自真实故障——这里用 onclose 确认的失效，退避重连（1s）落在 300ms 宽限之外。
    sockets[0]!.onclose?.({})
    assert.equal(facts.status().ready, true)
    assert.equal(facts.status().carrierLostAt !== null, true, 'the grace must be timed from the loss')
    assert.equal(verdicts.at(-1), 'ok', 'a carrier loss must not degrade inside the grace')
    // 宽限内没有新基线 ⇒ 必须诚实降级，且退化为「不可判」而不是继续声称在场。
    await waitFor(() => facts.status().ready === false, 'no successor baseline must end the grace')
    assert.equal(verdicts.at(-1), 'degraded')
    assert.equal(facts.status().carrierLostAt, null)
    assert.equal(facts.status().staleSince !== null, true, 'unusable start must be readable')
  } finally { facts.stop() }
})

test('a late ready frame does not end the carrier grace (only a baseline or expiry does)', async () => {
  const sockets: FakeSocket[] = []
  let calls = 0
  const facts = createSourceMuxFacts({
    sourceId: 'late-ready', origin: 'http://cp', carrierGraceMs: 2_000,
    onSnapshot: () => {},
    openSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    // 首条基线成功（建立可信基线），之后永不落地：宽限必须由到期结束，而不是被 ready 帧取消。
    fetchImpl: rpcFetch({ 'session/list': () => { calls += 1; return calls === 1 ? { items: [] } : new Promise(() => {}) } }) as never,
  })
  try {
    facts.start()
    sockets[0]!.open()
    sockets[0]!.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => facts.status().ready, 'initial baseline did not make the carrier decidable')
    // 真实失效 → 退避重连在宽限内开出继任套接字。
    sockets[0]!.onclose?.({})
    await waitFor(() => facts.status().carrierLostAt !== null, 'carrier loss did not start the grace')
    await waitFor(() => sockets.length === 2, 'the backoff retry did not open a successor')
    // 新代际的 ready 帧到了，但基线没有落地：它只证明套接字腿，不许结束宽限。
    sockets[1]!.open()
    sockets[1]!.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => facts.status().ready === false, 'a ready frame extended the grace past its deadline')
    assert.equal(facts.status().staleSince !== null, true, 'the degrade must be readable')
  } finally { facts.stop() }
})

test('a failed first baseline does not poison the socket leg: the next successful baseline is decidable', async () => {
  const sockets: FakeSocket[] = []
  let calls = 0
  const facts = createSourceMuxFacts({
    sourceId: 'first-fail', origin: 'http://cp',
    onSnapshot: () => {},
    openSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    fetchImpl: rpcFetch({ 'session/list': () => { calls += 1; if (calls === 1) throw new Error('boom'); return { items: [] } } }) as never,
  })
  try {
    facts.start()
    sockets[0]!.open()
    sockets[0]!.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => facts.status().baselineFailures >= 1, 'the first baseline failure was not recorded')
    // 基线腿失败不得清掉套接字腿：下一次基线成功必须立刻可判（否则等于换条路径重现「在场但不可判」）。
    facts.reconcile()
    await waitFor(() => facts.status().ready, 'a successful baseline after a failure must be decidable')
  } finally { facts.stop() }
})

test('a reconnected carrier that re-baselines inside the grace never degrades the face', async () => {
  const sockets: FakeSocket[] = []
  const verdicts: string[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'flap', origin: 'http://cp', carrierGraceMs: 2_000,
    onSnapshot: snapshot => verdicts.push(snapshot.verdict),
    openSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [{ sessionId: 's1', running: false, updatedAt: 1 }] }) }) as never,
  })
  try {
    facts.start()
    sockets[0]!.open()
    sockets[0]!.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => facts.status().ready, 'initial socket did not become ready')
    // 首连之前的那次 degraded 是诚实的（还没真相）；宽限语义说的是「有真相之后不得再逐次降级」。
    const okBefore = verdicts.lastIndexOf('ok')
    assert.notEqual(okBefore, -1, 'the initial baseline never published an ok snapshot')
    sockets[0]!.onclose?.({})
    await waitFor(() => sockets.length === 2, 'the backoff retry did not open a successor')
    // 继任者在宽限内完成握手 + 基线：对判定面是零变化（一次降级快照都不许出现）。
    sockets[1]!.open()
    sockets[1]!.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => facts.status().baselines >= 2, 'successor baseline missing')
    assert.equal(facts.status().ready, true)
    assert.equal(facts.status().carrierLostAt, null)
    assert.equal(verdicts.slice(okBefore + 1).includes('degraded'), false,
      'an idle-close flap must not publish a degraded snapshot once a baseline was trusted')
  } finally { facts.stop() }
})

test('an ended $events stream fails the carrier immediately and degrades after the grace', async () => {
  const socket = new FakeSocket()
  const verdicts: string[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ended-events', origin: 'http://cp', carrierGraceMs: 40,
    onSnapshot: snapshot => verdicts.push(snapshot.verdict),
    openSocket: () => socket,
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
  })
  try {
    facts.start()
    socket.open()
    socket.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => facts.status().ready, 'initial facts did not become ready')
    socket.onmessage?.({ data: JSON.stringify({ type: 'end', streamId: 'events' }) })
    // 逻辑流结束 = 载体立刻失败（换 socket + 退避重连），但「可判」只在宽限用尽后消失。
    assert.equal(socket.closed, true)
    assert.equal(facts.status().reconnects, 0, 'reconnect must use the scheduled backoff')
    await waitFor(() => facts.status().ready === false, 'ended stream must not hold decidability past the grace')
    assert.equal(verdicts.at(-1), 'degraded')
  } finally { facts.stop() }
})

test('continuous baseline failures never renew the carrier grace', async () => {
  const socket = new FakeSocket()
  let calls = 0
  const facts = createSourceMuxFacts({
    sourceId: 'grace-no-renew', origin: 'http://cp', carrierGraceMs: 300,
    onSnapshot: () => {},
    openSocket: () => socket,
    // 首条基线建立可信真相；此后每次 reconcile 都失败——连续失败不得把到期翻转无限推迟。
    fetchImpl: rpcFetch({ 'session/list': () => { calls += 1; return calls === 1 ? { items: [] } : 'FAIL' } }) as never,
  })
  try {
    facts.start()
    socket.open()
    socket.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => facts.status().ready, 'initial trusted baseline missing')
    // 12×25ms ≈ 300ms 宽限：失败一直继续，到期必须在失败仍在进行时生效（删除「只在第一次丢失时
    // 起表」的守卫时，每次失败都会重排计时器，下面两断言必红）。
    for (let attempt = 0; attempt < 12; attempt += 1) {
      facts.reconcile()
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.ok(facts.status().baselineFailures >= 8, 'the loop must have driven continuous baseline failures')
    assert.equal(facts.status().carrierLostAt, null, 'the grace expired and was not renewed by later failures')
    assert.equal(facts.status().ready, false, 'continuous failures must not hold decidability past the grace')
    assert.equal(facts.status().staleSince !== null, true, 'the degrade must be readable')
  } finally { facts.stop() }
})

test('a late same-connection baseline cannot overwrite a newer result', async () => {
  const socket = new FakeSocket()
  const rpc = deferredRpc()
  const snapshots: Array<{ rows: Record<string, { running: boolean }> }> = []
  const facts = createSourceMuxFacts({
    sourceId: 'ordered', origin: 'http://cp', onSnapshot: snapshot => snapshots.push(snapshot),
    reconcileIntervalMs: 25,
    openSocket: () => socket, fetchImpl: rpc.fetchImpl as never,
  })
  try {
    facts.start()
    socket.open()
    socket.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => rpc.lists.length >= 1, 'initial list not requested')
    rpc.lists[0]!({ items: [{ sessionId: 's1', running: true, updatedAt: 1 }] })
    await waitFor(() => facts.status().ready, 'initial baseline did not settle')
    await waitFor(() => rpc.lists.length >= 3, 'two periodic requests not made')
    rpc.lists[2]!({ items: [{ sessionId: 's1', running: false, updatedAt: 2 }] })
    await waitFor(() => socket.followOpens.length === 1, 'newer completion did not read tail')
    socket.replyFollow(0, { type: 'snapshot', records: [{ event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } }] })
    rpc.lists[1]!({ items: [{ sessionId: 's1', running: true, updatedAt: 1 }] })
    await new Promise(resolve => setTimeout(resolve, 2))
    assert.equal(snapshots.at(-1)?.rows.s1?.running, false)
    assert.equal(facts.status().edges, 1)
  } finally { facts.stop() }
})

test('status observed during a baseline forces a new reconciliation', async () => {
  const socket = new FakeSocket()
  const rpc = deferredRpc()
  const snapshots: Array<{ rows: Record<string, { running: boolean }> }> = []
  const facts = createSourceMuxFacts({
    sourceId: 'revision', origin: 'http://cp', onSnapshot: snapshot => snapshots.push(snapshot),
    // This test pins the MECHANISM (a stale sample is re-taken, never used to overwrite);
    // its cadence is bounded by design and covered by the O1 test below.
    baselineResampleMinMs: 5,
    openSocket: () => socket, fetchImpl: rpc.fetchImpl as never,
  })
  try {
    facts.start()
    socket.open()
    socket.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => rpc.lists.length === 1, 'initial list not requested')
    socket.item({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
    rpc.lists[0]!({ items: [{ sessionId: 's1', running: false, updatedAt: 1 }] })
    await waitFor(() => rpc.lists.length === 2, 'event revision did not trigger a new list')
    assert.equal(snapshots.at(-1)?.rows.s1?.running, true)
    rpc.lists[1]!({ items: [{ sessionId: 's1', running: true, updatedAt: 2 }] })
    await waitFor(() => facts.status().ready, 'reconciled list did not certify facts')
  } finally { facts.stop() }
})

test('a stale baseline is re-sampled on a bounded cadence, never recursively (O1)', async () => {
  const socket = new FakeSocket()
  const rpc = deferredRpc()
  const facts = createSourceMuxFacts({
    sourceId: 'cadence', origin: 'http://cp', onSnapshot: () => {},
    baselineResampleMinMs: 40,
    openSocket: () => socket, fetchImpl: rpc.fetchImpl as never,
  })
  try {
    facts.start()
    socket.open()
    socket.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => rpc.lists.length === 1, 'initial list not requested')
    // An event during the in-flight sample makes that sample stale. Bounded re-sampling
    // waits one cadence instead of recursing in the same tick (the old behavior fetched
    // the whole table again immediately, so an event-dense source could loop).
    socket.item({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
    rpc.lists[0]!({ items: [{ sessionId: 's1', running: false, updatedAt: 1 }] })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(rpc.lists.length, 1, 'the stale baseline must not re-sample before its cadence')
    await waitFor(() => rpc.lists.length === 2, 'the stale baseline never re-sampled')
    rpc.lists[1]!({ items: [{ sessionId: 's1', running: true, updatedAt: 2 }] })
    await waitFor(() => facts.status().ready, 'reconciled list did not certify facts')
  } finally { facts.stop() }
})
test('a stale re-sample dies with its generation (a carrier turnover re-baselines on ready)', async () => {
  const sockets: FakeSocket[] = []
  const rpc = deferredRpc()
  const facts = createSourceMuxFacts({
    sourceId: 'stale-gen', origin: 'http://cp', onSnapshot: () => {},
    // 40ms 宽限：测试关心的是死代际的重取样不得取数，宽限到期后的不可判只是顺带断言。
    reconcileIntervalMs: 20, baselineResampleMinMs: 40, carrierGraceMs: 40,
    openSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    fetchImpl: rpc.fetchImpl as never,
  })
  try {
    facts.start()
    sockets[0]!.open()
    sockets[0]!.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => rpc.lists.length === 1, 'initial list not requested')
    rpc.lists[0]!({ items: [{ sessionId: 's1', running: true, updatedAt: 1 }] })
    await waitFor(() => facts.status().baselines === 1, 'initial baseline did not certify facts')
    // A later sample goes stale while it is in flight: a bounded re-sample is scheduled...
    await waitFor(() => rpc.lists.length === 2, 'reconcile did not sample again')
    sockets[0]!.item({ type: 'emit', event: 'api-session/status', args: ['s1', false] })
    rpc.lists[1]!({ items: [{ sessionId: 's1', running: true, updatedAt: 1 }] })
    await settleMicrotasks()
    const callsWithPendingResample = rpc.lists.length
    // ...then that generation dies before the cadence elapses. The pending retry must not
    // fetch for the dead generation; the successor's ready frame owns the baseline.
    sockets[0]!.onclose?.({})
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(rpc.lists.length, callsWithPendingResample,
      'a stale re-sample must not fetch after its generation died')
    assert.equal(facts.status().ready, false, 'the dead generation is not ready')
  } finally { facts.stop() }
})
test('a tail from an earlier run cannot arm a newly running session', async () => {
  const socket = new FakeSocket()
  const rpc = deferredRpc()
  const snapshots: Array<{ rows: Record<string, { running: boolean; completedAt: number | null }> }> = []
  const facts = createSourceMuxFacts({
    sourceId: 'run', origin: 'http://cp', now: () => 1_700_000_000_000,
    onSnapshot: snapshot => snapshots.push(snapshot),
    openSocket: () => socket, fetchImpl: rpc.fetchImpl as never,
  })
  try {
    facts.start()
    socket.open()
    socket.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => rpc.lists.length === 1, 'initial list not requested')
    rpc.lists[0]!({ items: [{ sessionId: 's1', running: true, updatedAt: 1 }] })
    await waitFor(() => facts.status().ready, 'initial baseline did not settle')
    socket.item({ type: 'emit', event: 'api-session/status', args: ['s1', false] })
    await waitFor(() => socket.followOpens.length === 1, 'tail not requested')
    socket.item({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
    socket.replyFollow(0, { type: 'snapshot', records: [{ type: 'event', event: {
      type: 'turn/end', time: 1_700_000_000_000, data: { reason: { kind: 'completed' } },
    } }] })
    await waitFor(() => facts.status().pendingReads === 0, 'old tail did not finish')
    assert.deepEqual(snapshots.at(-1)?.rows.s1, { ...snapshots.at(-1)?.rows.s1, running: true, completedAt: null })
  } finally { facts.stop() }
})

test('a newer host activity watermark invalidates an older tail from an unseen rerun', async () => {
  const socket = new FakeSocket()
  const rpc = deferredRpc()
  const snapshots: Array<{ rows: Record<string, { completedAt: number | null }> }> = []
  const facts = createSourceMuxFacts({
    sourceId: 'tail-watermark', origin: 'http://cp', now: () => 1_700_000_000_500,
    onSnapshot: snapshot => snapshots.push(snapshot),
    openSocket: () => socket, fetchImpl: rpc.fetchImpl as never,
  })
  const completedTail = (time: number) => ({ type: 'snapshot', records: [{ type: 'event', event: {
    type: 'turn/end', time, data: { reason: { kind: 'completed' } },
  } }] })
  try {
    facts.start()
    socket.open()
    socket.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => rpc.lists.length === 1, 'initial list not requested')
    rpc.lists[0]!({ items: [{ sessionId: 's1', running: true, updatedAt: 100 }] })
    await waitFor(() => facts.status().ready, 'initial baseline did not settle')
    socket.item({ type: 'emit', event: 'api-session/status', args: ['s1', false] })
    await waitFor(() => socket.followOpens.length === 1, 'first tail not requested')
    // Both true and false status frames from a quick rerun were lost; only the
    // host's later updatedAt reveals that the held follow belongs to old data.
    facts.reconcile()
    await waitFor(() => rpc.lists.length === 2, 'new baseline not requested')
    rpc.lists[1]!({ items: [{ sessionId: 's1', running: false, updatedAt: 200 }] })
    await waitFor(() => socket.followOpens.length === 2, 'newer host watermark did not trigger a fresh tail')
    socket.replyFollow(0, completedTail(1_700_000_000_100))
    await new Promise(resolve => setTimeout(resolve, 2))
    assert.equal(snapshots.at(-1)?.rows.s1?.completedAt, null, 'old tail must not write after a newer host watermark')
    socket.replyFollow(1, completedTail(1_700_000_000_200))
    await waitFor(() => snapshots.at(-1)?.rows.s1?.completedAt === 1_700_000_000_200, 'fresh tail did not settle')
  } finally { facts.stop() }
})

test('periodic reconciliation finds a dropped status while the socket stays active', async () => {
  const socket = new FakeSocket()
  const snapshots: Array<{ rows: Record<string, { completedAt: number | null }> }> = []
  let running = true
  const facts = createSourceMuxFacts({
    sourceId: 'dropped', origin: 'http://cp', now: () => 1_700_000_000_000,
    reconcileIntervalMs: 20,
    onSnapshot: snapshot => snapshots.push(snapshot), openSocket: () => socket,
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [{ sessionId: 's1', running, updatedAt: 1 }] }) }) as never,
  })
  try {
    socket.onFollowOpen = streamId => socket.followItem(streamId, followSnapshot({ kind: 'completed' }, 1_700_000_000_000))
    facts.start()
    socket.open()
    socket.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => facts.status().ready, 'initial baseline did not settle')
    running = false // the status frame is dropped; keep the transport healthy
    socket.item({ type: 'cancel' })
    await waitFor(() => facts.status().edges === 1, 'periodic list did not recover the edge')
    await waitFor(() => snapshots.at(-1)?.rows.s1?.completedAt !== null, 'completion was not armed')
  } finally { facts.stop() }
})

test('two lost status frames are recovered only from a turn/end newer than the prompt', async () => {
  const socket = new FakeSocket()
  const rpc = deferredRpc()
  const snapshots: Array<{ rows: Record<string, { completedAt: number | null; completedAtSource: string | null }> }> = []
  const promptAt = 1_700_000_001_000
  const tail = (time: number, kind = 'completed') => ({ type: 'snapshot', records: [{
    type: 'event', event: { type: 'turn/end', seq: time, time, data: { reason: { kind } } },
  }] })
  const facts = createSourceMuxFacts({
    sourceId: 'lost-pair', origin: 'http://cp', now: () => promptAt + 500,
    onSnapshot: snapshot => snapshots.push(snapshot), openSocket: () => socket,
    fetchImpl: rpc.fetchImpl as never,
  })
  try {
    facts.start()
    socket.open()
    socket.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => rpc.lists.length === 1, 'initial list not requested')
    rpc.lists[0]!({ items: [{ sessionId: 's1', running: false, updatedAt: promptAt - 1_000 }] })
    await waitFor(() => facts.status().ready, 'initial baseline did not settle')

    facts.reconcile()
    await waitFor(() => rpc.lists.length === 2, 'second list not requested')
    rpc.lists[1]!({ items: [{ sessionId: 's1', running: false, updatedAt: promptAt }] })
    await waitFor(() => socket.followOpens.length === 1, 'new prompt did not start a tail probe')
    socket.replyFollow(0, tail(promptAt - 100))
    await waitFor(() => facts.status().pendingReads === 0, 'old tail did not settle')
    assert.equal(snapshots.at(-1)?.rows.s1?.completedAt, null, 'an earlier run must not be reused')
    assert.equal(facts.status().edges, 0)

    facts.reconcile()
    await waitFor(() => rpc.lists.length === 3, 'retry list not requested')
    rpc.lists[2]!({ items: [{ sessionId: 's1', running: false, updatedAt: promptAt }] })
    await waitFor(() => socket.followOpens.length === 2, 'unknown outcome was not retried')
    socket.replyFollow(1, tail(promptAt + 100))
    await waitFor(() => snapshots.at(-1)?.rows.s1?.completedAtSource === 'observed', 'new turn/end was not classified')
    assert.equal(snapshots.at(-1)?.rows.s1?.completedAt, promptAt + 100)
    assert.equal(facts.status().edges, 1)
  } finally { facts.stop() }
})

test('a later prompt clears the old completion before any new outcome is known', async () => {
  const socket = new FakeSocket()
  const snapshots: Array<{ rows: Record<string, { completedAt: number | null; completedAtSource: string | null; updatedAt: number }> }> = []
  const promptAt = 1_700_000_002_000
  let listedAt = promptAt - 1_000
  let tailTime = promptAt - 500
  const facts = createSourceMuxFacts({
    sourceId: 'stale-complete', origin: 'http://cp', now: () => promptAt + 500,
    onSnapshot: snapshot => snapshots.push(snapshot), openSocket: () => socket,
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [{ sessionId: 's1', running: false, updatedAt: listedAt }] }) }) as never,
  })
  try {
    socket.onFollowOpen = streamId => socket.followItem(streamId, followSnapshot({ kind: 'completed' }, tailTime))
    facts.start()
    socket.open()
    socket.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => facts.status().ready, 'initial baseline did not settle')
    socket.item({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
    socket.item({ type: 'emit', event: 'api-session/status', args: ['s1', false] })
    await waitFor(() => snapshots.at(-1)?.rows.s1?.completedAtSource === 'observed', 'old completion missing')

    // api-session/activity is emitted on a user prompt. The status pair for
    // this new run is lost; the previous observed completion must not survive.
    socket.item({ type: 'emit', event: 'api-session/activity', args: ['s1', promptAt + 0.5] })
    assert.equal(snapshots.at(-1)?.rows.s1?.completedAtSource, 'observed',
      'a malformed fractional activity watermark cannot revoke a completion')
    socket.item({ type: 'emit', event: 'api-session/activity', args: ['s1', promptAt] })
    assert.equal(snapshots.at(-1)?.rows.s1?.completedAt, null)
    assert.equal(snapshots.at(-1)?.rows.s1?.updatedAt, promptAt)
    listedAt = promptAt
    facts.reconcile()
    await waitFor(() => facts.status().followFailures === 1, 'old tail must remain an unknown outcome')
    assert.equal(snapshots.at(-1)?.rows.s1?.completedAt, null)
    tailTime = promptAt + 100
    facts.reconcile()
    await waitFor(() => snapshots.at(-1)?.rows.s1?.completedAt === tailTime, 'new completion not recovered')
  } finally { facts.stop() }
})

test('an unreadable turn end stays pending classification until a later host tail is available', async () => {
  const socket = new FakeSocket()
  const snapshots: Array<{ rows: Record<string, { completedAtSource: string | null }> }> = []
  let tailAvailable = false
  let follows = 0
  const facts = createSourceMuxFacts({
    sourceId: 'tail-later', origin: 'http://cp', now: () => 1_700_000_000_000,
    reconcileIntervalMs: 25,
    onSnapshot: snapshot => snapshots.push(snapshot), openSocket: () => socket,
    followTimeoutMs: 10,
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [{ sessionId: 's1', running: false, updatedAt: 1 }] }) }) as never,
  })
  try {
    socket.onFollowOpen = streamId => {
      follows += 1
      socket.followItem(streamId, tailAvailable ? followSnapshot({ kind: 'completed' }, 1_700_000_000_000) : { type: 'snapshot', records: [] })
    }
    facts.start()
    socket.open()
    socket.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => facts.status().ready, 'initial baseline did not settle')
    socket.item({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
    socket.item({ type: 'emit', event: 'api-session/status', args: ['s1', false] })
    await waitFor(() => follows === 1, 'first tail was not read')
    await waitFor(() => snapshots.at(-1)?.rows.s1?.completedAtSource === 'reconstructed', 'unreadable fact not retained')
    tailAvailable = true
    await waitFor(() => snapshots.at(-1)?.rows.s1?.completedAtSource === 'observed', 'tail was not reclassified')
    assert.ok(follows >= 2)
  } finally { facts.stop() }
})

test('a follow snapshot without a turn end waits for a later event on the same stream', async () => {
  const socket = new FakeSocket()
  const snapshots: Array<{ rows: Record<string, { completedAtSource: string | null }> }> = []
  const facts = createSourceMuxFacts({
    sourceId: 'follow-event', origin: 'http://cp', now: () => 1_700_000_000_500,
    followTimeoutMs: 50, onSnapshot: snapshot => snapshots.push(snapshot), openSocket: () => socket,
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [{ sessionId: 's1', running: false, updatedAt: 1 }] }) }) as never,
  })
  try {
    facts.start()
    socket.open()
    socket.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => facts.status().ready, 'baseline missing')
    socket.item({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
    socket.item({ type: 'emit', event: 'api-session/status', args: ['s1', false] })
    await waitFor(() => socket.followOpens.length === 1, 'follow stream missing')
    const streamId = socket.followOpens[0]!.streamId
    socket.followItem(streamId, { type: 'snapshot', records: [] })
    assert.equal(facts.status().pendingReads, 1, 'empty snapshot must leave follow open')
    socket.followItem(streamId, { type: 'event', event: {
      type: 'turn/end', time: 1_700_000_000_100, data: { reason: { kind: 'completed' } },
    } })
    await waitFor(() => snapshots.at(-1)?.rows.s1?.completedAtSource === 'observed', 'later turn end did not settle')
    assert.equal(socket.sent.some(payload => JSON.parse(payload).type === 'cancel' && JSON.parse(payload).streamId === streamId), true)
  } finally { facts.stop() }
})

test('URLs and the opening frame match the frozen protocol', () => {
  assert.equal(muxUrlFor('http://127.0.0.1:17500', 'local'), 'ws://127.0.0.1:17500/api/i/local/api/remote.mux')
  assert.equal(muxUrlFor('http://127.0.0.1:17500/', 'ssh-a'), 'ws://127.0.0.1:17500/api/i/ssh-a/api/remote.mux')
  assert.deepEqual(JSON.parse(openEventsFrame()), { type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } })
  assert.deepEqual(parseMuxFrame(JSON.stringify({ type: 'item', streamId: 's', value: { type: 'ready', clientId: 'c' } })), { kind: 'ready', streamId: 's' })
  assert.equal(parseMuxFrame('not json'), null)
  assert.equal(rowFromListItem({ sessionId: 'a', running: true, updatedAt: 5 })?.running, true)
  assert.equal(rowFromListItem({}), null)
  assert.equal(rowFromListItem({ sessionId: 'a', updatedAt: 5 }), null)
  assert.equal(rowFromListItem({ sessionId: 'a', running: false, updatedAt: '5' }), null)
})

test('a partial or malformed baseline cannot forge a completion or certify facts', async () => {
  const socket = new FakeSocket()
  let listValue: unknown = { items: [{ sessionId: 's1', running: true, updatedAt: 1 }] }
  let follows = 0
  const snapshots: Array<{ verdict: string; rows: Record<string, { running: boolean }> }> = []
  const facts = createSourceMuxFacts({
    sourceId: 'malformed-row', origin: 'http://cp', onSnapshot: snapshot => snapshots.push(snapshot),
    openSocket: () => socket,
    fetchImpl: rpcFetch({ 'session/list': () => listValue }) as never,
    // 宽限缩短到可测但仍留足断言余量（纯负载下 40ms 会被测试自身拖过界）：一次拒绝不得让
    // 「可判」立刻消失，也不能撑过宽限。
    carrierGraceMs: 300,
  })
  try {
    socket.onFollowOpen = () => { follows += 1 }
    facts.start()
    socket.open()
    socket.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => facts.status().ready, 'initial valid baseline missing')
    listValue = { items: [
      { sessionId: 's1', running: false, updatedAt: 2 },
      { sessionId: 's2', updatedAt: 2 },
    ] }
    facts.reconcile()
    await waitFor(() => facts.status().baselineFailures === 1, 'partial list was accepted')
    // 被拒的基线一行都没应用（上面），所以旧基线在宽限内仍是最可信的事实——但失败必须可读。
    assert.equal(facts.status().baselineFailureReason !== null, true, 'a rejected baseline must leave a readable reason')
    assert.equal(facts.status().ready, true, 'one rejected re-baseline holds the grace, not the whole face')
    assert.equal(snapshots.at(-1)?.verdict, 'ok')
    assert.equal(snapshots.at(-1)?.rows.s1?.running, true, 'a partial baseline must apply no rows')
    await waitFor(() => facts.status().ready === false, 'a rejected baseline must not hold decidability past the grace')
    assert.equal(snapshots.at(-1)?.verdict, 'degraded')
    socket.item({ type: 'emit', event: 'api-session/status', args: ['s1', 'false'] })
    assert.equal(facts.status().edges, 0, 'a malformed status must not close a running edge')
    assert.equal(follows, 0)
  } finally { facts.stop() }
})

test('a carrier that never opens is failed by the handshake deadline and retried', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const sockets: FakeSocket[] = []
    const facts = createSourceMuxFacts({
      sourceId: 'local', origin: 'http://cp', onSnapshot: () => {},
      openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
      fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
    })
    try {
      facts.start()
      assert.equal(sockets.length, 1)
      assert.equal(sockets[0]?.closed, false)
      // No open/error/close ever arrives. Without a deadline the observer would sit
      // on a dead carrier with no silence evidence and no retry forever.
      mock.timers.tick(TABLE_SNAPSHOT.handshakeTimeoutMs + 1)
      assert.equal(sockets[0]?.closed, true, 'the silent carrier is closed')
      assert.equal(facts.status().ready, false)
      mock.timers.tick(2_000)
      assert.equal(sockets.length, 2, 'the deadline feeds the bounded reconnect path')
    } finally { facts.stop() }
  } finally { mock.timers.reset() }
})

test('the observer opens only $events and never answers a waterfall', async () => {
  const sockets: FakeSocket[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'local', origin: 'http://cp', onSnapshot: () => {},
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
  })
  try {
    facts.start()
    const socket = sockets[0]
    socket.open()
    assert.deepEqual(socket.sent, [openEventsFrame()])
    // 瀑布帧只观察：不得产生任何 send（尤其不得回 $events/result）。
    socket.item({ type: 'waterfall', event: 'approval/request', eventId: 'e1', request: {} })
    socket.item({ type: 'waterfall', event: 'user-questions/request', eventId: 'e2', request: {} })
    socket.item({ type: 'cancel', eventId: 'e3' })
    assert.equal(socket.sent.length, 1, 'no frame was sent in response')
    assert.equal(socket.sent.some(payload => payload.includes('result')), false)
    // 源文本里也不得出现 result 的发送（注释里的纪律声明不算）。
    const code = SOURCE.split('\n').filter(line => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//')).join('\n')
    assert.equal(code.includes("$events/result"), false)
  } finally {
    facts.stop()
  }
})

test('one true->false edge opens exactly one follow and completed arms the row', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  const follows: unknown[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-a', origin: 'http://cp', now: () => 900, onSnapshot: s => snapshots.push(s),
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [{ sessionId: 's1', running: false, updatedAt: 100 }] }) }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    sockets[0].onFollowOpen = (streamId, payload) => { follows.push(payload); sockets[0].followItem(streamId, followSnapshot({ kind: 'completed' })) }
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: true } })
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: false } })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(follows.length, 1, 'exactly one follow per edge')
    assert.equal(facts.status().edges, 1)
    // A duplicate false (no new running edge) must not open a second follow.
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: false } })
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(follows.length, 1)
    const last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    const row = last.rows['s1']
    assert.equal(row?.completedAt, 900)
    // 本 fixture 的记录没有 host time ⇒ 观察者戳 + reconstructed 降级；
    // host 时间的 observed 路径由下方 B5 用例钉住。
    assert.equal(row?.completedAtSource, 'reconstructed')
    assert.deepEqual(row?.lastTurnEnd, { kind: 'completed', at: 0 })
  } finally {
    facts.stop()
  }
})

test('a user stop and a neutral ending never arm; an unreadable tail degrades and arms', async () => {
  for (const [label, tail, expectArmed] of [
    ['aborted+user', { kind: 'aborted', cause: 'user' }, false],
    ['blocked', { kind: 'blocked' }, false],
    ['unreadable', 'FAIL', true],
    // 无 turn/end（拿到了快照但读不出确定性尾巴）⇒ 与 gateway followTurnEndOnce 同规：武装。
    // 判 neutral 会让「跨缺口完成」在唯一证据缺失时静默丢失（B1 的同一失效模式）。
    ['no-turn-end', 'EMPTY', true],
  ] as const) {
    const sockets: FakeSocket[] = []
    const snapshots: unknown[] = []
    const facts = createSourceMuxFacts({
      sourceId: 'local', origin: 'http://cp', now: () => 1_000, onSnapshot: s => snapshots.push(s),
      followTimeoutMs: 5,
      openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
      fetchImpl: rpcFetch({ 'session/list': () => ({ items: [{ sessionId: 's1', running: false, updatedAt: 50 }] }) }) as never,
    })
    try {
      facts.start()
      sockets[0].open()
      sockets[0].onFollowOpen = streamId => {
        if (tail === 'FAIL') sockets[0].followEnd(streamId)
        else sockets[0].followItem(streamId, tail === 'EMPTY' ? { type: 'snapshot', records: [] } : followSnapshot(tail))
      }
      await new Promise(resolve => setTimeout(resolve, 5))
      sockets[0].item({ type: 'ready', clientId: 'c' })
      sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: true } })
      sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: false } })
      await waitFor(() => facts.status().pendingReads === 0, 'follow stream did not settle')
      const last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
      const row = last.rows['s1']
      assert.equal(row?.completedAt !== null && row?.completedAt !== undefined, expectArmed, label)
      if (tail !== 'FAIL' && tail !== 'EMPTY') assert.deepEqual(row?.lastTurnEnd, { ...tail, at: 0 }, label)
      if (tail === 'FAIL' || tail === 'EMPTY') {
        // 两种「读不到确定性尾巴」都要计数：否则分不清「没完成」与「观察者读不到」。
        assert.equal(facts.status().followFailures, 1, label + '：读不出尾巴必须计数')
        assert.equal(row?.completedAtDomain, 'observer', label + '：降级戳是观察者域')
        assert.equal(row?.completedAtSource, 'reconstructed', label + '：降级戳不得冒充 observed')
      }
    } finally {
      facts.stop()
    }
  }
})

test('classifyTurnEndWire mirrors the watcher rules, and stop() is idempotent', () => {
  assert.equal(classifyTurnEndWire({ kind: 'completed' }), 'completed')
  assert.equal(classifyTurnEndWire({ kind: 'aborted', cause: 'user' }), 'user-stopped')
  assert.equal(classifyTurnEndWire({ kind: 'aborted', cause: 'parent' }), 'neutral')
  assert.equal(classifyTurnEndWire({ kind: 'error' }), 'neutral')
  assert.equal(classifyTurnEndWire(null), 'neutral')
  const sockets: FakeSocket[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'local', origin: 'http://cp', onSnapshot: () => {},
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
  })
  facts.start()
  facts.stop()
  facts.stop()
  assert.equal(sockets[0].closed, true)
})

/**
 * 观察者的**失败必须可观测**：否则「观察者坏了」与「这段时间没有
 * 完成」长得一模一样——正是这类假绿让判据形同虚设。
 */
test('baseline, follow and socket failures are counted, not swallowed', async () => {
  const sockets: FakeSocket[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-b', origin: 'http://cp', now: () => 777, onSnapshot: () => {},
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({ 'session/list': () => 'FAIL' }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    sockets[0].onFollowOpen = streamId => sockets[0].followEnd(streamId)
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    assert.ok(facts.status().baselineFailures >= 1, '基线失败必须计数（不能静默）')
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: true } })
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: false } })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(facts.status().followFailures, 1, '尾巴读失败是降级武装路径，必须可数')
    sockets[0].onerror?.({})
    assert.equal(facts.status().socketErrors, 1, '套接字错误与 close 分开计数')
  } finally {
    facts.stop()
  }
})

/** 重连退避：源长时间不可达时不得变成每秒一次的重试洪流（1s 起、翻倍、封顶 30s、稳定 30s 复位）。 */
test('a real carrier failure reconnects through the bounded exponential backoff', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const sockets: FakeSocket[] = []
    let listOk = false
    const facts = createSourceMuxFacts({
      sourceId: 'ssh-c', origin: 'http://cp', onSnapshot: () => {},
      openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
      // 无值列表 ⇒ 来源不可信（ready() 为假）：退避只由真失败驱动，断言测的就是退避本身。
      fetchImpl: rpcFetch({ 'session/list': () => (listOk ? { items: [] } : null) }) as never,
    })
    try {
      facts.start()
      // ① 首次失败等 1s 基线（固定 100ms 轮询会在此暴露）。
      sockets[0].onclose?.({})
      mock.timers.tick(250)
      assert.equal(facts.status().reconnects, 0, '首次重连延迟 1s，250ms 内不得重连（固定 100ms 轮询会在此暴露）')
      assert.equal(sockets.length, 1)
      mock.timers.tick(800)
      assert.equal(sockets.length, 2, 'a dead carrier must still be replaced (real failure, not silence)')
      assert.equal(facts.status().reconnects, 1)
      assert.equal(sockets[0].closed, true)
      // ② 每次真失败翻倍，封顶 30s：不多不少在延迟点换代。
      const delays = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
      for (const delay of delays) {
        const before: number = sockets.length
        sockets[before - 1].open() // 清掉连接期限；不送 ready ⇒ 稳定复位不参与本段
        sockets[before - 1].onclose?.({})
        mock.timers.tick(delay - 1)
        assert.equal(sockets.length, before, `${delay}ms 退避内不得提前重连`)
        mock.timers.tick(1)
        assert.equal(sockets.length, before + 1, `${delay}ms 到点必须换掉死载波`)
        assert.equal(facts.status().reconnects, before, '每次换代恰记一次重连')
      }
      // ③ 可信且连续 ready 满 30s ⇒ 退避复位到 1s（而不是停在封顶值）。
      listOk = true
      const stable = sockets[sockets.length - 1]
      stable.open()
      stable.item({ type: 'ready', clientId: 'c' })
      await new Promise(resolve => setImmediate(resolve))
      mock.timers.tick(30_000)
      const beforeReset = sockets.length
      stable.onclose?.({})
      mock.timers.tick(999)
      assert.equal(sockets.length, beforeReset, '稳定 30s 后退避复位为 1s：999ms 内不得重连')
      mock.timers.tick(1)
      assert.equal(sockets.length, beforeReset + 1, '复位后的真失败等 1s 基线')
    } finally {
      facts.stop()
    }
  } finally {
    mock.timers.reset()
  }
})

/** 仪器：每个来源的状态可由外部读取（函数视图，不产生周期性对象）。 */
test('the per-source instrument exposes the live status', () => {
  const host: Record<string, unknown> = {}
  publishSourceMuxInstrument('ssh-d', () => ({
    ready: true, edges: 2, lastEventAt: 5, pendingReads: 0, pendingClassifications: 0,
    reconnects: 0, baselines: 1, baselineFailures: 0, followFailures: 0, socketErrors: 0,
    carrierLostAt: null, staleSince: null, baselineFailureReason: null, baselineResamples: 0,
    lastTrustedBaselineAt: 5, rows: 3,
  }), host)
  const registry = host.__dshChamberSourceMux as Record<string, () => { edges: number }>
  assert.equal(registry['ssh-d']().edges, 2)
})
/** 成功信封不等于可信列表；缺 items 不能伪装成零会话。 */
test('a value-less session/list response remains degraded', async () => {
  const sockets: FakeSocket[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-shape', origin: 'http://cp', onSnapshot: () => {},
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({ 'session/list': () => null }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(facts.status().baselines, 0)
    assert.equal(facts.status().baselineFailures, 1)
    assert.equal(facts.status().ready, false)
  } finally {
    facts.stop()
  }
})

test('two complete baseline absences retire a row without forging a completion', async () => {
  const socket = new FakeSocket()
  const snapshots: Array<{ rows: Record<string, { running: boolean }> }> = []
  let items: unknown[] = [{ sessionId: 's1', running: true, updatedAt: 1 }]
  const facts = createSourceMuxFacts({
    sourceId: 'baseline-removal', origin: 'http://cp', onSnapshot: snapshot => snapshots.push(snapshot),
    openSocket: () => socket, reconcileIntervalMs: 1_000,
    fetchImpl: rpcFetch({ 'session/list': () => ({ items }) }) as never,
  })
  try {
    facts.start()
    socket.open()
    socket.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => facts.status().ready, 'initial baseline missing')
    assert.equal(snapshots.at(-1)?.rows.s1?.running, true)
    items = []
    facts.reconcile()
    await waitFor(() => facts.status().baselines === 2, 'first absence missing')
    assert.equal(snapshots.at(-1)?.rows.s1?.running, true, 'one absence is not a deletion verdict')
    facts.reconcile()
    await waitFor(() => facts.status().baselines === 3, 'second absence missing')
    assert.equal(snapshots.at(-1)?.rows.s1, undefined)
    assert.equal(facts.status().edges, 0)
    assert.equal(socket.followOpens.length, 0, 'deletion is not completion')
  } finally { facts.stop() }
})

test('a live session event resets the baseline absence count', async () => {
  const socket = new FakeSocket()
  const snapshots: Array<{ rows: Record<string, { running: boolean }> }> = []
  let items: unknown[] = [{ sessionId: 's1', running: true, updatedAt: 1 }]
  const facts = createSourceMuxFacts({
    sourceId: 'absence-reset', origin: 'http://cp', onSnapshot: snapshot => snapshots.push(snapshot),
    openSocket: () => socket, reconcileIntervalMs: 1_000,
    fetchImpl: rpcFetch({ 'session/list': () => ({ items }) }) as never,
  })
  try {
    facts.start()
    socket.open()
    socket.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => facts.status().ready, 'initial baseline missing')
    items = []
    facts.reconcile()
    await waitFor(() => facts.status().baselines === 2, 'first absence missing')
    socket.item({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
    facts.reconcile()
    await waitFor(() => facts.status().baselines === 3, 'post-event baseline missing')
    assert.equal(snapshots.at(-1)?.rows.s1?.running, true)
  } finally { facts.stop() }
})

test('stop/start discards an old follow reply before the new subscription can use its session id', async () => {
  const sockets: FakeSocket[] = []
  const rpc = deferredRpc()
  const snapshots: Array<{ rows: Record<string, { completedAt: number | null }> }> = []
  const facts = createSourceMuxFacts({
    sourceId: 'restart', origin: 'http://cp', onSnapshot: snapshot => snapshots.push(snapshot),
    openSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    fetchImpl: rpc.fetchImpl as never, reconcileIntervalMs: 1_000,
  })
  try {
    facts.start()
    sockets[0]!.open()
    sockets[0]!.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => rpc.lists.length === 1, 'first list missing')
    rpc.lists[0]!({ items: [{ sessionId: 's1', running: true, updatedAt: 1 }] })
    await waitFor(() => facts.status().ready, 'first baseline missing')
    sockets[0]!.item({ type: 'emit', event: 'api-session/status', args: ['s1', false] })
    await waitFor(() => sockets[0]!.followOpens.length === 1, 'old tail read missing')
    facts.stop()
    assert.equal(facts.status().pendingReads, 0)
    facts.start()
    sockets[1]!.open()
    sockets[1]!.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => rpc.lists.length === 2, 'new list missing')
    rpc.lists[1]!({ items: [{ sessionId: 's1', running: false, updatedAt: 1 }] })
    await waitFor(() => facts.status().ready, 'new baseline missing')
    sockets[0]!.replyFollow(0, { type: 'snapshot', records: [{ event: { type: 'turn/end', time: 1_700_000_000_000,
      data: { reason: { kind: 'completed' } } } }] })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(snapshots.at(-1)?.rows.s1?.completedAt, null)
    assert.equal(facts.status().pendingReads, 0, 'the old reply cannot decrement the new lifetime counter')
  } finally { facts.stop() }
})

test('a tail arriving during baseline-confirmed absence cannot turn deletion into completion', async () => {
  const socket = new FakeSocket()
  const rpc = deferredRpc()
  const snapshots: Array<{ rows: Record<string, { completedAt: number | null }> }> = []
  const facts = createSourceMuxFacts({
    sourceId: 'absence-tail', origin: 'http://cp', onSnapshot: snapshot => snapshots.push(snapshot),
    openSocket: () => socket, fetchImpl: rpc.fetchImpl as never,
    reconcileIntervalMs: 1_000,
  })
  try {
    facts.start()
    socket.open()
    socket.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => rpc.lists.length === 1, 'initial list missing')
    rpc.lists[0]!({ items: [{ sessionId: 's1', running: true, updatedAt: 1 }] })
    await waitFor(() => facts.status().ready, 'initial baseline missing')
    socket.item({ type: 'emit', event: 'api-session/status', args: ['s1', false] })
    await waitFor(() => socket.followOpens.length === 1, 'tail read missing')
    facts.reconcile()
    await waitFor(() => rpc.lists.length === 2, 'absence list missing')
    rpc.lists[1]!({ items: [] })
    await waitFor(() => facts.status().baselines === 2, 'first absence missing')
    socket.replyFollow(0, { type: 'snapshot', records: [{ event: { type: 'turn/end', time: 1_700_000_000_000,
      data: { reason: { kind: 'completed' } } } }] })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(snapshots.at(-1)?.rows.s1?.completedAt, null)
    facts.reconcile()
    await waitFor(() => rpc.lists.length === 3, 'confirmation list missing')
    rpc.lists[2]!({ items: [] })
    await waitFor(() => facts.status().baselines === 3, 'second absence missing')
    assert.equal(snapshots.at(-1)?.rows.s1, undefined)
  } finally { facts.stop() }
})

/**
 * 形状以当前冻结协议 (control-plane/src/session-mux.ts) 为准。
 */

/** $events 开场不重放 status ⇒ 换代/静默缺口后的基线是跨缺口完成的唯一证据。 */
test('B1: a true->false baseline edge after a silent gap reads the tail and arms', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  const follows: unknown[] = []
  let running = true
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-b1', origin: 'http://cp', now: () => 2_000, onSnapshot: s => snapshots.push(s),
    reconcileIntervalMs: 20,
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [{ sessionId: 's1', running, updatedAt: 100 }] }) }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    const answer = (socket: FakeSocket) => { socket.onFollowOpen = (_streamId, payload) => { follows.push(payload); socket.replyFollow(socket.followOpens.length - 1, followSnapshot({ kind: 'completed' })) } }
    answer(sockets[0])
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    // 缺口：会话完成，但 $events 不重放 status（本机实测连 emit 都没有），只有
    // 下一次周期基线能看见——修复来自基线，不是换代。
    running = false
    await waitFor(() => facts.status().edges === 1, 'the periodic baseline never saw the completion')
    assert.equal(follows.length, 1, 'a baseline true->false edge must open exactly one follow')
    assert.equal(sockets.length, 1, 'the gap must be healed by the baseline, not by replacing the carrier')
    const last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.notEqual(last.rows['s1']?.completedAt ?? null, null, 'the gap completion must arm completedAt')
  } finally {
    facts.stop()
  }
})

/** 周期重基线不得用空完成字段覆盖已武装的完成。 */
test('B2: a re-baseline never clobbers an armed completion', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  let listCall = 0
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-b2', origin: 'http://cp', now: () => 900, onSnapshot: s => snapshots.push(s),
    reconcileIntervalMs: 20,
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({
      // 第二次基线带更旧的 updatedAt 与 rowFromListItem 的空完成字段。
      'session/list': () => { listCall += 1; return { items: [{ sessionId: 's1', running: false, updatedAt: listCall === 1 ? 5 : 0 }] } },
    }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    sockets[0].onFollowOpen = streamId => sockets[0].followItem(streamId, followSnapshot({ kind: 'completed' }))
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: true } })
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: false } })
    await new Promise(resolve => setTimeout(resolve, 10))
    const armed = (snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }).rows['s1']
    const armedAt = armed?.completedAt
    assert.notEqual(armedAt ?? null, null, 'precondition: the status edge armed the completion')
    // 静默窗内发生周期重基线（updatedAt 更旧）：空完成字段不得覆盖已武装的完成。
    await waitFor(() => listCall >= 3, 'the periodic re-baseline never ran')
    const after = (snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }).rows['s1']
    assert.equal(after?.completedAt, armedAt, 'the baseline must not wipe the armed completion')
    assert.equal(after?.completedAtSource, armed?.completedAtSource)
    assert.deepEqual(after?.lastTurnEnd, armed?.lastTurnEnd)
    assert.equal(after?.updatedAt, 5, 'updatedAt merges by max, never backwards')
    assert.equal(sockets.length, 1, 'the re-baseline must not replace the carrier')
  } finally {
    facts.stop()
  }
})


/** 真失败换代后，被换掉的旧 socket 的 onclose 不得再改状态或调度重连。 */
test('B3: a superseded socket cannot reschedule or mutate state', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const sockets: FakeSocket[] = []
    const snapshots: unknown[] = []
    const facts = createSourceMuxFacts({
      sourceId: 'ssh-b3', origin: 'http://cp', onSnapshot: s => snapshots.push(s),
      openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
      fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
    })
    try {
      facts.start()
      sockets[0].open()
      sockets[0].item({ type: 'ready', clientId: 'c' })
      await settleMicrotasks()
      assert.equal(facts.status().ready, true)

      // 真失败（onerror）仍换代：1s 有界退避后建新 socket。
      sockets[0].onerror?.({})
      assert.equal(sockets[0].closed, true, 'the failed carrier is closed')
      mock.timers.tick(1_001)
      assert.equal(sockets.length, 2, 'a real failure still replaces the carrier')
      const superseded = sockets[0]
      const fresh = sockets[1]
      fresh.open()
      fresh.item({ type: 'ready', clientId: 'c' })
      await settleMicrotasks()
      assert.equal(facts.status().ready, true)
      assert.equal(facts.status().reconnects, 1)

      // 旧 socket 的 close 属于旧代际：不得降级、不得再排一次重连。
      superseded.onclose?.({})
      await settleMicrotasks()
      assert.equal((snapshots.at(-1) as { verdict: string }).verdict, 'ok', 'a superseded close must not degrade the live generation')
      // 自激窗：若旧 close 调度了换代（退避已翻倍到 2s），5s 内会出现第三条 socket。
      mock.timers.tick(5_000)
      assert.equal(sockets.length, 2, 'no self-excited reconnect loop')
      assert.equal(facts.status().reconnects, 1, 'only the real failure replaced the carrier')
      assert.equal((snapshots.at(-1) as { verdict: string }).verdict, 'ok')
    } finally {
      facts.stop()
    }
  } finally {
    mock.timers.reset()
  }
})

/** 状态事件必须为未知会话建档；added/activity/removed 必须被消费。 */
test('B4: status opens an unknown row; added/activity/removed are handled', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-b4', origin: 'http://cp', now: () => 400, onSnapshot: s => snapshots.push(s),
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    sockets[0].onFollowOpen = streamId => sockets[0].followItem(streamId, followSnapshot({ kind: 'completed' }))
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    // 冻结 wire 形：args = [sessionId, running]（对象形只用于测试）。
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: ['s1', false] })
    await new Promise(resolve => setTimeout(resolve, 10))
    let last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.notEqual(last.rows['s1'], undefined, 'status must open a row the baseline never saw')
    assert.equal(last.rows['s1']?.completedAt, 400, 'the followed edge must arm the new row')
    assert.equal(facts.status().edges, 1)
    // activity：host 水位只升不降。
    sockets[0].item({ type: 'emit', event: 'api-session/activity', args: ['s1', 12_345] })
    sockets[0].item({ type: 'emit', event: 'api-session/activity', args: ['s1', 12_000] })
    await new Promise(resolve => setTimeout(resolve, 5))
    last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.equal(last.rows['s1']?.updatedAt, 12_345)
    // added：新会话建行。
    sockets[0].item({ type: 'emit', event: 'api-session/added', args: [{ sessionId: 's2', running: true, updatedAt: 7 }] })
    await new Promise(resolve => setTimeout(resolve, 5))
    last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.equal(last.rows['s2']?.running, true)
    // removed：从 rows（与 running 记忆）移除。
    sockets[0].item({ type: 'emit', event: 'api-session/removed', args: ['s1'] })
    await new Promise(resolve => setTimeout(resolve, 5))
    last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.equal(last.rows['s1'], undefined, 'removed must prune the row')
    assert.equal(last.rows['s2']?.running, true)
  } finally {
    facts.stop()
  }
})

/** 完成时间优先取 host turn/end.time；拿不到时观察者戳必须诚实标 reconstructed。 */
test('B5: completedAt prefers the host turn/end time; a client stamp is reconstructed', async () => {
  const HOST_TIME = 1_700_000_000_000
  const run = async (tail: unknown) => {
    const sockets: FakeSocket[] = []
    const snapshots: unknown[] = []
    const follows: unknown[] = []
    const facts = createSourceMuxFacts({
      sourceId: 'ssh-b5', origin: 'http://cp', now: () => 5_000, onSnapshot: s => snapshots.push(s),
      openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
      fetchImpl: rpcFetch({ 'session/list': () => ({ items: [{ sessionId: 's1', running: false, updatedAt: 1 }] }) }) as never,
    })
    try {
      facts.start()
      sockets[0].open()
      sockets[0].onFollowOpen = (streamId, payload) => { follows.push(payload); sockets[0].followItem(streamId, tail) }
      await new Promise(resolve => setTimeout(resolve, 5))
      sockets[0].item({ type: 'ready', clientId: 'c' })
      sockets[0].item({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
      sockets[0].item({ type: 'emit', event: 'api-session/status', args: ['s1', false] })
      await new Promise(resolve => setTimeout(resolve, 10))
      const row = (snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }).rows['s1']
      return { row, follows }
    } finally {
      facts.stop()
    }
  }
  // 冻结 wire：snapshot.records[].event 携带 SessionEvent.time（host epoch ms）。
  const withHost = await run({ type: 'snapshot', records: [
    { type: 'event', event: { type: 'turn/end', seq: 7, time: HOST_TIME, data: { reason: { kind: 'completed' } } } },
  ] })
  assert.deepEqual(withHost.follows[0], { args: { request: { address: { kind: 'session', sessionId: 's1' }, maxMessages: 8 } } }, 'session/follow payload must match the frozen Remote shape')
  assert.equal(withHost.row?.completedAt, HOST_TIME, 'host time must win over the observer clock')
  assert.equal(withHost.row?.completedAtSource, 'observed')
  assert.equal(withHost.row?.completedAtDomain, 'host')
  assert.deepEqual(withHost.row?.lastTurnEnd, { kind: 'completed', at: HOST_TIME, seq: 7 })
  // 无 host 时间：观察者戳 + reconstructed（不是 host 域观测，App 因此不发通知）。
  const withoutHost = await run({ type: 'snapshot', records: [
    { type: 'event', event: { type: 'turn/end', seq: 8, data: { reason: { kind: 'completed' } } } },
  ] })
  assert.equal(withoutHost.row?.completedAt, 5_000)
  assert.equal(withoutHost.row?.completedAtSource, 'reconstructed')
  assert.equal(withoutHost.row?.completedAtDomain, 'observer')
})

/** 半死隧道下 unary 必须按 deadline 失败并计数，不得永久挂起。 */
test('B7: baseline and follow rpc deadlines surface as failures instead of hanging', async () => {
  const sockets: FakeSocket[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-b7', origin: 'http://cp', onSnapshot: () => {},
    baselineTimeoutMs: 30, followTimeoutMs: 20,
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    // 半死隧道：请求永不回包（不 resolve 也不 reject）。
    fetchImpl: (() => new Promise(() => {})) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.ok(facts.status().baselineFailures >= 1, 'a hung session/list must hit the baseline deadline')
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: true } })
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: { sessionId: 's1', running: false } })
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(facts.status().followFailures, 1, 'a hung session/follow must degrade within its deadline')
    assert.equal(facts.status().pendingReads, 0, 'a timed-out read must not leak a pending read')
    assert.equal(sockets[0].sent.some(payload => JSON.parse(payload).type === 'cancel'), true,
      'a timed-out follow stream must be cancelled')
  } finally {
    facts.stop()
  }
})

/** stop() 后在途基线不得再 emit。 */
test('B10: a baseline resolving after stop() must not emit', async () => {
  const snapshots: unknown[] = []
  let releaseList: (() => void) | null = null
  const gate = new Promise<void>(resolve => { releaseList = resolve })
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-b10', origin: 'http://cp', onSnapshot: s => snapshots.push(s),
    openSocket: () => new FakeSocket(),
    fetchImpl: ((_url: string, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { rpcId: string }
      return gate.then(() => ({
        ok: true, status: 200,
        json: async () => ({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { items: [] } } }),
      }))
    }) as never,
  })
  facts.start()
  const beforeStop = snapshots.length
  facts.stop()
  releaseList!()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(snapshots.length, beforeStop, 'a baseline landing after stop() must not emit')
})

/** stop() 必须摘下本源仪器项（否则退役观察者看起来仍在跑）。 */
test('B10: stop() unpublishes the per-source instrument', () => {
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-b10-instrument', origin: 'http://cp', onSnapshot: () => {},
    openSocket: () => new FakeSocket(),
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
  })
  facts.start()
  const registry = (globalThis as { __dshChamberSourceMux?: Record<string, unknown> }).__dshChamberSourceMux
  assert.notEqual(registry?.['ssh-b10-instrument'], undefined, 'precondition: start() publishes')
  facts.stop()
  assert.equal(registry?.['ssh-b10-instrument'], undefined, 'stop() must remove the instrument entry')
})
