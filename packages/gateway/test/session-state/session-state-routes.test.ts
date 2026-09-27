/**
 * Session-state routes: snapshot descriptor, method discipline and the SSE
 * stream (snapshot first frame, monotonic ids,
 * Last-Event-ID resume or snapshot fallback, backpressure-bounded queue,
 * stream cap, close handling).
 *
 * Run directly:
 *   node --import ./test/session-state/workspace-loader.mjs test/session-state/session-state-routes.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_SESSIONS, createChamberSessionState } from '../../src/session-state.ts'
import { FakeRequest, FakeResponse } from '../support/utils.ts'
import { baselineItem, delay, sessionSurfaceFor, type SessionSurfaceHarness } from './harness.ts'

type SurfaceHarness = SessionSurfaceHarness

/** Session-state surface harness (shared factory). */
function surfaceFor(t: { after(fn: () => void): void }, options: { enabled?: boolean; maxStreams?: number } = {}): SurfaceHarness {
  return sessionSurfaceFor(t, options)
}

async function json(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<FakeResponse> {
  const req = new FakeRequest(method, path, headers)
  const res = new FakeResponse()
  // The real dispatch passes pathname and query separately; FakeRequest keeps
  // the full URL, so split here exactly like the dispatcher does.
  const pending = surfaceCall(req, res, path.split('?')[0])
  if (body !== undefined) {
    req.emit('data', Buffer.from(JSON.stringify(body)))
  }
  req.emit('end')
  await pending
  return res
}

let activeSurface: ReturnType<typeof createChamberSessionState>
function surfaceCall(req: FakeRequest, res: FakeResponse, path: string): Promise<boolean> {
  return activeSurface.handle(req as never, res as never, path)
}

interface SseEvent {
  id: number | null
  event: string
  data: unknown
}

function sseEvents(res: FakeResponse): SseEvent[] {
  return res.body
    .split('\n\n')
    .map(block => block.trim())
    .filter(block => block.length > 0 && !block.startsWith(':'))
    .map(block => {
      const lines = block.split('\n')
      const id = lines.find(line => line.startsWith('id: '))
      const event = lines.find(line => line.startsWith('event: '))
      const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
      return {
        id: id === undefined ? null : Number(id.slice(4)),
        event: event === undefined ? 'message' : event.slice(7),
        data: data.length === 0 ? null : JSON.parse(data),
      }
    })
}

async function openStream(harness: SurfaceHarness, headers: Record<string, string> = {}): Promise<{ req: FakeRequest; res: FakeResponse }> {
  activeSurface = harness.surface
  const req = new FakeRequest('GET', '/chamber/session-state/stream', headers)
  const res = new FakeResponse()
  await harness.surface.handle(req as never, res as never, '/chamber/session-state/stream')
  return { req, res }
}

// ---------------------------------------------------------------------------
// Snapshot descriptor
// ---------------------------------------------------------------------------

test('GET snapshot answers the frozen descriptor and the whitelisted rows', async t => {
  const harness = surfaceFor(t)
  harness.store.applyBaseline([baselineItem('s1', true, 5)], { at: 100 })
  activeSurface = harness.surface
  const res = await json('GET', '/chamber/session-state')
  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.protocol, 1)
  assert.equal(body.mode, 'sse')
  // 7 = the frozen 6 plus the OPTIONAL post-freeze session-state.goal
  // capability (P2a); the row below carries no goal key, so the additive field
  // stays absent while unknown.
  assert.equal(body.features.length, 7)
  assert.equal(body.features.includes('session-state.goal'), true)
  assert.equal(body.host.serviceable, true)
  assert.equal(body.host.state, 'ready')
  assert.equal(body.sessions.length, 1)
  assert.deepEqual(Object.keys(body.sessions[0]).sort(), [
    'completedAt', 'completedAtSource', 'factAt', 'lastRunningAt', 'lastTurnEnd', 'pendingKind',
    'running', 'sessionId', 'subagentCount', 'updatedAt',
  ])
  // I5：factAt 是观察者刷新该行事实的 host 域毫秒（基线后 = 观察时刻，不是 0）。
  assert.ok(typeof body.sessions[0].factAt === 'number')
})

test('host-down still answers 200 with serviceable false and keeps the rows', async t => {
  const harness = surfaceFor(t)
  harness.store.applyBaseline([baselineItem('s1', true, 5)], { at: 100 })
  harness.setHost({ now: 200, serviceable: false, state: 'stopped' })
  activeSurface = harness.surface
  const res = await json('GET', '/chamber/session-state')
  assert.equal(res.status, 200, 'host-down must never look like an old gateway (404) or a broken one (5xx)')
  assert.equal(res.json().host.serviceable, false)
  assert.equal(res.json().sessions.length, 1)
})

test('poll mode advertises the reduced feature set and off mode advertises none', async t => {
  const harness = surfaceFor(t)
  harness.setMode('poll')
  activeSurface = harness.surface
  const body = (await json('GET', '/chamber/session-state')).json()
  assert.equal(body.mode, 'poll')
  assert.equal(body.features.includes('session-state.dsh-events'), false)
  assert.equal(body.features.includes('session-state.pending-graph'), false)
  assert.equal(body.features.includes('session-state.snapshot'), true)
  // session-state.goal is NOT event-only: session/list exists in poll mode.
  assert.equal(body.features.includes('session-state.goal'), true)
  // The base set stays satisfied in poll mode: the mirror stays usable.
  for (const feature of ['session-state.snapshot', 'session-state.host-clock']) {
    assert.equal(body.features.includes(feature), true)
  }
  // Server OLDER/degraded (protocol cell D): off mode advertises no capability
  // at all, so the client degrades instead of assuming it.
  harness.setMode('off')
  const off = (await json('GET', '/chamber/session-state')).json()
  assert.equal(off.mode, 'off')
  assert.deepEqual(off.features, [])
})

test('method discipline and unknown subpaths', async t => {
  const harness = surfaceFor(t)
  activeSurface = harness.surface
  assert.equal((await json('POST', '/chamber/session-state')).status, 405)
  assert.equal((await json('GET', '/chamber/session-state/read')).status, 404, 'the retired read route is not claimed')
  assert.equal((await json('GET', '/chamber/session-state/stream/extra')).status, 404)
  assert.equal((await json('GET', '/chamber/session-state/other')).status, 404)
})

test('the disabled switch answers 503 session_state_disabled on every route', async t => {
  const harness = surfaceFor(t, { enabled: false })
  activeSurface = harness.surface
  for (const [method, path] of [['GET', '/chamber/session-state'], ['GET', '/chamber/session-state/stream']]) {
    const res = await json(method, path)
    assert.equal(res.status, 503)
    assert.equal(res.json().error, 'session_state_disabled')
  }
})

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

test('the stream opens with a snapshot frame and pushes monotonic delta ids', async t => {
  const harness = surfaceFor(t)
  harness.store.applyBaseline([baselineItem('s1', true, 5)], { at: 100 })
  const { res } = await openStream(harness)
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'text/event-stream')
  assert.equal(res.headers['cache-control'], 'no-store')
  const first = sseEvents(res)
  assert.equal(first.length, 1)
  assert.equal(first[0].event, 'snapshot')
  assert.equal(first[0].id, harness.store.status().cursor)
  assert.equal((first[0].data as { protocol: number }).protocol, 1)
  harness.store.applyPending('s1', 'approval', 110)
  harness.store.applyPending('s1', 'question', 120)
  const events = sseEvents(res)
  assert.equal(events.length, 3)
  assert.equal(events[1].event, 'delta')
  assert.equal(events[2].id, events[1].id! + 1, 'ids are strictly monotonic')
})

test('an SSE delta carries the goal fact with its identity-bound activation', async t => {
  const harness = surfaceFor(t)
  harness.store.applyBaseline([baselineItem('s1', false, 5, {
    goal: { goalId: 'g1', revision: 1, phase: 'active', updatedAt: 5 },
  })], { at: 100 })
  const { res } = await openStream(harness)
  assert.equal(sseEvents(res)[0].event, 'snapshot')
  // The activation edge for the matching goal commits a delta whose row carries
  // the whole goal fact — not just an activation-only fragment.
  harness.store.applyGoalActivation({ sessionId: 's1', goalId: 'g1', activation: 'armed' }, 110)
  const events = sseEvents(res)
  assert.equal(events.length, 2)
  assert.equal(events[1].event, 'delta')
  const sessions = (events[1].data as { sessions: Array<Record<string, unknown>> }).sessions
  assert.equal(sessions.length, 1)
  assert.deepEqual(sessions[0].goal, {
    goalId: 'g1', revision: 1, phase: 'active', updatedAt: 5, activation: 'armed',
  })
  // The snapshot route agrees (same projection source).
  activeSurface = harness.surface
  const snapshot = (await json('GET', '/chamber/session-state')).json()
  assert.deepEqual(snapshot.sessions[0].goal, sessions[0].goal)
})

test('the row-cap eviction reaches an SSE client as a removal delta (no phantom row)', async t => {
  const harness = surfaceFor(t)
  const items = Array.from({ length: MAX_SESSIONS + 1 }, (_, index) => baselineItem('cap-' + String(index), false, index + 1))
  harness.store.applyBaseline(items, { at: 100 })
  const { res } = await openStream(harness)
  assert.equal(sseEvents(res)[0].event, 'snapshot')
  assert.equal((sseEvents(res)[0].data as { sessions: unknown[] }).sessions.length, MAX_SESSIONS + 1)
  // 容量淘汰发生在持久化冲刷时：客户端已见过 cap-0 的 upsert，必须再收到 removed。
  await harness.store.flush()
  const events = sseEvents(res)
  assert.equal(events.length, 2)
  assert.equal(events[1].event, 'delta')
  const data = events[1].data as { sessions: unknown[]; removedSessionIds: string[] }
  assert.deepEqual(data.sessions, [], 'the eviction is a removal, not a re-upsert')
  assert.deepEqual(data.removedSessionIds, ['cap-0'])
  assert.equal(harness.store.status().sessions, MAX_SESSIONS)
  assert.equal(harness.store.status().dropped.sessions, 1)
  activeSurface = harness.surface
  const snapshot = (await json('GET', '/chamber/session-state')).json()
  assert.equal(snapshot.sessions.length, MAX_SESSIONS)
  assert.equal(snapshot.sessions.some((row: { sessionId: string }) => row.sessionId === 'cap-0'), false)
})

test('Last-Event-ID resumes from the ring without a snapshot', async t => {
  const harness = surfaceFor(t)
  harness.store.applyBaseline([baselineItem('s1', true, 5)], { at: 100 })
  harness.store.applyPending('s1', 'approval', 110)
  const cursor = harness.store.status().cursor
  const { res } = await openStream(harness, { 'last-event-id': String(cursor - 1) })
  const events = sseEvents(res)
  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'delta', 'a satisfiable cursor never re-sends the snapshot')
  assert.equal(events[0].id, cursor)
})

test('an expired or future Last-Event-ID falls back to a snapshot', async t => {
  const harness = surfaceFor(t)
  harness.store.applyBaseline([baselineItem('s1', true, 5)], { at: 100 })
  for (let index = 0; index < 1_100; index += 1) harness.store.applyActivity('s1', 6 + index, 200 + index)
  const expired = await openStream(harness, { 'last-event-id': '1' })
  assert.equal(sseEvents(expired.res)[0].event, 'snapshot', 'a cursor outside the ring is not satisfiable')
  const future = await openStream(harness, { 'last-event-id': String(harness.store.status().cursor + 10) })
  assert.equal(sseEvents(future.res)[0].event, 'snapshot', 'an ahead cursor (observer restart) falls back too')
})

test('a closed stream unsubscribes and closeAllStreams is idempotent', async t => {
  const harness = surfaceFor(t)
  harness.store.applyBaseline([baselineItem('s1', true, 5)], { at: 100 })
  const { req, res } = await openStream(harness)
  void req
  const before = res.body
  res.emit('close')
  harness.store.applyPending('s1', 'approval', 110)
  assert.equal(res.body, before, 'a closed stream receives no further frames')
  harness.surface.closeAllStreams()
  harness.surface.closeAllStreams()
  harness.store.applyPending('s1', 'question', 120)
  assert.equal(res.body, before)
})

test('the concurrent stream cap answers 503 resource_exhausted', async t => {
  const harness = surfaceFor(t, { maxStreams: 2 })
  await openStream(harness)
  await openStream(harness)
  const third = await openStream(harness)
  assert.equal(third.res.status, 503)
  assert.equal(third.res.json().error, 'resource_exhausted')
})

test('keepalive comments carry no id (heartbeats never advance a resume cursor)', async t => {
  const harness = surfaceFor(t)
  const { res } = await openStream(harness)
  await delay(70)
  assert.equal(res.body.includes(': keepalive'), true)
  assert.equal(res.body.includes('id: :'), false)
  assert.equal(sseEvents(res).length, 1, 'keepalives are comments, not events')
})
