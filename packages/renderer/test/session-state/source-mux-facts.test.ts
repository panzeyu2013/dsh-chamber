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

test('the mux silence watchdog is carrier recovery only, never content evidence', () => {
  const source = SOURCE.replace(/\/\*[\s\S]*?\*\//gu, '')
  // Source-level $events silence is NOT this session's content progress (assistant
  // text travels its own session/follow stream), so the observer publishes no
  // content-stall signal at all; page evidence comes from session-content-stall.ts.
  assert.doesNotMatch(source, /contentSilenceSinceMs|contentStallElapsedMs|lastContentAt/)
  assert.match(source, /reconnects \+= 1/, 'the watchdog still performs carrier recovery')
  assert.doesNotMatch(source, /registerSourceContentStall/)
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.fail(message)
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

test('a socket ready frame cannot certify facts after a failed baseline', async () => {
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

test('a malformed ready frame cannot certify facts or renew event liveness', async () => {
  const sockets: FakeSocket[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'bad-ready', origin: 'http://cp', onSnapshot: () => {}, silenceTimeoutMs: 20,
    openSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
  })
  try {
    facts.start()
    sockets[0]!.open()
    sockets[0]!.item({ type: 'ready' })
    await waitFor(() => facts.status().baselines === 1, 'baseline missing')
    assert.equal(facts.status().ready, false, 'ready requires a nonempty clientId')
    for (let i = 0; i < 4; i += 1) {
      sockets[0]!.item({ type: 'emit', event: '' })
      await new Promise(resolve => setTimeout(resolve, 6))
    }
    await waitFor(() => sockets.length === 2, 'malformed event frames renewed a dead subscription')
  } finally { facts.stop() }
})

test('replacing a live socket degrades facts before the successor opens', async () => {
  const sockets: FakeSocket[] = []
  const verdicts: string[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'replacing', origin: 'http://cp', silenceTimeoutMs: 20,
    onSnapshot: snapshot => verdicts.push(snapshot.verdict),
    openSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
  })
  try {
    facts.start()
    sockets[0]!.open()
    sockets[0]!.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => facts.status().ready, 'initial socket did not become ready')
    await waitFor(() => sockets.length === 2, 'silence did not replace the socket')
    assert.equal(facts.status().ready, false)
    assert.equal(verdicts.at(-1), 'degraded')
  } finally { facts.stop() }
})

test('an ended $events stream degrades immediately even when its socket stays open', async () => {
  const socket = new FakeSocket()
  const verdicts: string[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ended-events', origin: 'http://cp', onSnapshot: snapshot => verdicts.push(snapshot.verdict),
    openSocket: () => socket,
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
  })
  try {
    facts.start()
    socket.open()
    socket.item({ type: 'ready', clientId: 'c' })
    await waitFor(() => facts.status().ready, 'initial facts did not become ready')
    socket.onmessage?.({ data: JSON.stringify({ type: 'end', streamId: 'events' }) })
    assert.equal(facts.status().ready, false)
    assert.equal(verdicts.at(-1), 'degraded')
    assert.equal(socket.closed, true)
    assert.equal(facts.status().reconnects, 0, 'reconnect must use the scheduled backoff')
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
    reconcileIntervalMs: 20, silenceTimeoutMs: 1_000,
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
    assert.equal(facts.status().ready, false)
    assert.equal(snapshots.at(-1)?.verdict, 'degraded')
    assert.equal(snapshots.at(-1)?.rows.s1?.running, true, 'a partial baseline must apply no rows')
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

/** 重连退避：源长时间不可达时不得变成每秒一次的重试洪流（首次延迟即为 1s）。 */
test('reconnect uses an exponential backoff instead of a fixed 1s hammer', async () => {
  const sockets: FakeSocket[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-c', origin: 'http://cp', onSnapshot: () => {},
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
  })
  try {
    facts.start()
    sockets[0].onclose?.({})
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(facts.status().reconnects, 0, '首次重连延迟 1s，250ms 内不得重连（固定 100ms 轮询会在此暴露）')
  } finally {
    facts.stop()
  }
})

/** 仪器：每个来源的状态可由外部读取（函数视图，不产生周期性对象）。 */
test('the per-source instrument exposes the live status', () => {
  const host: Record<string, unknown> = {}
  publishSourceMuxInstrument('ssh-d', () => ({ ready: true, edges: 2, lastEventAt: 5, pendingReads: 0, pendingClassifications: 0, reconnects: 0, baselines: 1, baselineFailures: 0, followFailures: 0, socketErrors: 0 }), host)
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
    openSocket: () => socket, reconcileIntervalMs: 1_000, silenceTimeoutMs: 1_000,
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
    openSocket: () => socket, reconcileIntervalMs: 1_000, silenceTimeoutMs: 1_000,
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
    fetchImpl: rpc.fetchImpl as never, reconcileIntervalMs: 1_000, silenceTimeoutMs: 1_000,
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
    reconcileIntervalMs: 1_000, silenceTimeoutMs: 1_000,
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

/** $events 开场不重放 status ⇒ 重订阅后的基线是跨缺口完成的唯一证据。 */
test('B1: a true->false baseline edge after resubscription reads the tail and arms', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  const follows: unknown[] = []
  let running = true
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-b1', origin: 'http://cp', now: () => 2_000, onSnapshot: s => snapshots.push(s),
    silenceTimeoutMs: 25,
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
    // 缺口：静默窗内会话完成；$events 不重放 status，只有下一次基线能看见。
    running = false
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.ok(sockets.length >= 2, 'silence must resubscribe (R21)')
    sockets.at(-1)!.open()
    answer(sockets.at(-1)!)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(follows.length, 1, 'a baseline true->false edge must open exactly one follow')
    assert.equal(facts.status().edges, 1, 'the baseline edge must count like a status edge')
    const last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.notEqual(last.rows['s1']?.completedAt ?? null, null, 'the gap completion must arm completedAt')
  } finally {
    facts.stop()
  }
})

/** 重连/静默重基线不得用空完成字段覆盖已武装的完成。 */
test('B2: a re-baseline never clobbers an armed completion', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  let listCall = 0
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-b2', origin: 'http://cp', now: () => 900, onSnapshot: s => snapshots.push(s),
    silenceTimeoutMs: 25,
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
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.ok(sockets.length >= 2, 'silence must resubscribe (the re-baseline path)')
    sockets.at(-1)!.open()
    await new Promise(resolve => setTimeout(resolve, 10))
    const after = (snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }).rows['s1']
    assert.equal(after?.completedAt, armedAt, 'the baseline must not wipe the armed completion')
    assert.equal(after?.completedAtSource, armed?.completedAtSource)
    assert.deepEqual(after?.lastTurnEnd, armed?.lastTurnEnd)
    assert.equal(after?.updatedAt, 5, 'updatedAt merges by max, never backwards')
  } finally {
    facts.stop()
  }
})


/** connect() 换代后，旧 socket 的 onclose 不得再改状态或调度重连。 */
test('B3: a superseded socket cannot reschedule or mutate state', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-b3', origin: 'http://cp', onSnapshot: s => snapshots.push(s),
    silenceTimeoutMs: 200,
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items: [] }) }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    sockets[0].item({ type: 'ready', clientId: 'c' })
    await new Promise(resolve => setTimeout(resolve, 260))
    // 静默重订阅：connect() 换掉旧 socket（旧 socket 仍会收到自己的 close）。
    assert.equal(sockets.length, 2, 'the silence window must have resubscribed')
    const superseded = sockets[0]
    const fresh = sockets[1]
    fresh.open()
    fresh.item({ type: 'ready', clientId: 'c' })
    await new Promise(resolve => setTimeout(resolve, 5))
    superseded.onclose?.({})
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal((snapshots.at(-1) as { verdict: string }).verdict, 'ok', 'a superseded close must not degrade the live generation')
    assert.equal(facts.status().reconnects, 1, 'only the silence resubscribe happened so far')
    // 自激窗：若旧 close 调度了 1s 重连，1.2s 内会再建一条 socket（喂帧保持本代际静默窗不触发）。
    for (let i = 0; i < 30; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 40))
      sockets.at(-1)?.item({ type: 'cancel', eventId: 'keep-alive' })
    }
    assert.equal(sockets.length, 2, 'no self-excited reconnect loop')
    assert.equal((snapshots.at(-1) as { verdict: string }).verdict, 'ok')
  } finally {
    facts.stop()
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
