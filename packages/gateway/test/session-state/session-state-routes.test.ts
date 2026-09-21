/**
 * Session-state routes: snapshot descriptor, method discipline, read/read-all
 * upserts and the SSE stream (snapshot first frame, monotonic ids,
 * Last-Event-ID resume or snapshot fallback, backpressure-bounded queue,
 * stream cap, close handling) - plan W1 / WS-B; blueprint section 6.
 *
 * Run directly:
 *   node --import ./test/session-state/workspace-loader.mjs test/session-state/session-state-routes.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createChamberSessionState } from '../../src/session-state.ts'
import { FakeRequest, FakeResponse } from '../support/utils.ts'
import { baselineItem, delay, sessionSurfaceFor, type SessionSurfaceHarness } from './harness.ts'

type SurfaceHarness = SessionSurfaceHarness

/** Session-state surface harness (shared factory; 2026-12 audit F40). */
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
  const res = await json('GET', '/chamber/session-state?clientId=install-1')
  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.protocol, 1)
  assert.equal(body.mode, 'sse')
  assert.equal(body.features.length, 8)
  assert.equal(body.host.serviceable, true)
  assert.equal(body.host.state, 'ready')
  assert.equal(body.read.clientId, 'install-1')
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
  assert.equal((await json('GET', '/chamber/session-state/read')).status, 405)
  assert.equal((await json('GET', '/chamber/session-state/stream/extra')).status, 404)
  assert.equal((await json('GET', '/chamber/session-state/other')).status, 404)
  assert.equal((await json('GET', '/chamber/session-state?clientId=bad%20id')).status, 400)
})

test('the disabled switch answers 503 session_state_disabled on every route', async t => {
  const harness = surfaceFor(t, { enabled: false })
  activeSurface = harness.surface
  for (const [method, path] of [['GET', '/chamber/session-state'], ['GET', '/chamber/session-state/stream'], ['POST', '/chamber/session-state/read'], ['POST', '/chamber/session-state/read-all']]) {
    const res = await json(method, path)
    assert.equal(res.status, 503)
    assert.equal(res.json().error, 'session_state_disabled')
  }
})

// ---------------------------------------------------------------------------
// read / read-all
// ---------------------------------------------------------------------------

test('POST read is idempotent, monotonic and reports unknown sessions as unstored', async t => {
  const harness = surfaceFor(t)
  harness.store.applyBaseline([baselineItem('s1', false, 5)], { at: 100 })
  activeSurface = harness.surface
  const first = await json('POST', '/chamber/session-state/read', { clientId: 'install-1', sessionId: 's1', readThrough: 90 })
  assert.deepEqual(first.json(), { ok: true, clientId: 'install-1', sessionId: 's1', readThrough: 90, changed: true, stored: true })
  const repeat = await json('POST', '/chamber/session-state/read', { clientId: 'install-1', sessionId: 's1', readThrough: 90 })
  assert.equal(repeat.json().changed, false)
  const lower = await json('POST', '/chamber/session-state/read', { clientId: 'install-1', sessionId: 's1', readThrough: 1 })
  assert.equal(lower.json().readThrough, 90, 'read marks only rise')
  const unknown = await json('POST', '/chamber/session-state/read', { clientId: 'install-1', sessionId: 'ghost', readThrough: 1 })
  assert.equal(unknown.json().stored, false)
  const bad = await json('POST', '/chamber/session-state/read', { clientId: 'install-1', sessionId: 's1' })
  assert.equal(bad.status, 400)
})

test('read tolerates unknown body fields and query params (newer client, older server)', async t => {
  // Moved from the deleted session-state-version-matrix.test.ts (2026-12 trim):
  // additive tolerance is what keeps a newer client usable against this server.
  const harness = surfaceFor(t)
  harness.store.applyBaseline([baselineItem('s1', false, 5)], { at: 100 })
  activeSurface = harness.surface
  const extra = await json('POST', '/chamber/session-state/read', {
    clientId: 'install-1', sessionId: 's1', readThrough: 90, somethingNew: { nested: true },
  })
  assert.equal(extra.status, 200)
  assert.equal(extra.json().readThrough, 90)
  const extraQuery = await json('GET', '/chamber/session-state?clientId=install-1&somethingNew=1')
  assert.equal(extraQuery.status, 200)
})

test('POST read-all stores the source floor and requires the client through', async t => {
  const harness = surfaceFor(t)
  harness.store.applyBaseline([baselineItem('s1', false, 40)], { at: 100 })
  activeSurface = harness.surface
  const ok = await json('POST', '/chamber/session-state/read-all', { clientId: 'phone', through: 50 })
  assert.equal(ok.status, 200)
  assert.equal(ok.json().through, 50)
  assert.equal(harness.store.readStateFor(null).floor, 50)
  const repeat = await json('POST', '/chamber/session-state/read-all', { clientId: 'phone', through: 50 })
  assert.equal(repeat.json().changed, false)
  const missing = await json('POST', '/chamber/session-state/read-all', { clientId: 'phone' })
  assert.equal(missing.status, 400, 'the server never computes now (plan section 4/R13)')
})
test('a client clock ahead of the host cannot buy a future read mark (plan §10 skew)', async t => {
  // The host clock in this harness is 1_000. A desktop whose own clock runs an
  // hour ahead would send readThrough = now + 3_600_000; without the host-domain
  // clamp that mark would suppress every completion landing in that hour —
  // i.e. lose true unread, which the §10 fault-injection row forbids.
  const harness = surfaceFor(t)
  harness.store.applyBaseline([baselineItem('s1', false, 900)], { at: 100 })
  activeSurface = harness.surface
  const skewed = await json('POST', '/chamber/session-state/read', { clientId: 'skewed', sessionId: 's1', readThrough: 1_000 + 3_600_000 })
  assert.equal(skewed.status, 200)
  assert.equal(skewed.json().readThrough, 1_000, 'clamped to the host acceptance time')
  assert.equal(harness.store.readStateFor('skewed').marks['s1'], 1_000)
  // A completion 30 minutes later is still above the clamped mark: the client
  // re-arms normally instead of staying dark for an hour.
  harness.store.applyActivity('s1', 1_000 + 1_800_000, 1_000 + 1_800_000)
  const row = harness.store.snapshotFor('skewed', 'sse', harness.store.host()).sessions.find(r => r.sessionId === 's1')
  assert.equal(row?.updatedAt, 1_000 + 1_800_000)
  assert.ok((row?.updatedAt ?? 0) > harness.store.readStateFor('skewed').marks['s1'], 'the later watermark wins over the clamped mark')
  // read-all is clamped identically.
  const all = await json('POST', '/chamber/session-state/read-all', { clientId: 'skewed', through: 1_000 + 7_200_000 })
  assert.equal(all.json().through, 1_000)
})

test('an oversized read body is 413 and the request socket is destroyed', async t => {
  const harness = surfaceFor(t)
  activeSurface = harness.surface
  const req = new FakeRequest('POST', '/chamber/session-state/read')
  const res = new FakeResponse()
  const pending = harness.surface.handle(req as never, res as never, '/chamber/session-state/read')
  req.emit('data', Buffer.alloc(17 * 1024, 0x61))
  await pending
  assert.equal(res.status, 413)
  assert.equal(res.json().error, 'body_too_large')
  assert.equal(req.destroyed, true)
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
