/**
 * Cross-version contract matrix: desktop client × gateway server across the
 * three version cells (plan §10 契约（CI）「桌面客户端 × 网关服务端的三档版本矩阵」
 * + R17/R18 forward-skew; protocol-compat-blueprint §1.3/§2).
 *
 * A version mismatch must never be a hard failure on either side:
 *   cell A  new client × OLD gateway  → the route set is absent (404) ⇒
 *           legacy-gateway, the client keeps its previous behaviour;
 *   cell B  same version              → full surface, verdict ok;
 *   cell C  server NEWER than client  → forward-skew: unknown feature ids and
 *           additive descriptor fields are ignored, never misread as legacy;
 *   cell D  server OLDER/degraded     → the advertised feature set shrinks
 *           (poll mode drops event-only ids; off mode advertises none) and the
 *           client degrades instead of assuming the capability.
 *
 * The server half (descriptor shape, exact-prefix routing, additive tolerance)
 * is exercised against the REAL surface; the client half is the protocol
 * module's pure classifier (the same one the desktop ships).
 *
 * Run directly:
 *   node --import ./test/session-state/workspace-loader.mjs test/session-state/session-state-version-matrix.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionStateHostInfo, SessionStateMode } from '@dsh-chamber/control-plane'
import {
  PROTOCOL_VERSION,
  SESSION_STATE_BASE_FEATURES,
  SESSION_STATE_FEATURES,
  classifySessionStateProbe,
  sessionStateFeatureSupport,
} from '@dsh-chamber/control-plane'
import {
  createChamberSessionState,
  createSessionStateStore,
  featuresForMode,
} from '../../src/session-state.ts'
import { FakeRequest, FakeResponse } from '../support/utils.ts'
import { scratch, silentLogger } from './harness.ts'

let activeSurface: ReturnType<typeof createChamberSessionState>

function surfaceFor(t: { after(fn: () => void): void }, mode: SessionStateMode = 'sse') {
  const store = createSessionStateStore({ stateDir: scratch(t), logger: silentLogger, now: () => 1_000 })
  let currentMode: SessionStateMode = mode
  const host: SessionStateHostInfo = { now: 1_000, serviceable: true, state: 'ready' }
  const surface = createChamberSessionState({
    logger: silentLogger,
    store,
    observer: { status: () => ({ mode: currentMode }), hostInfo: () => host } as never,
    enabled: true,
    now: () => 1_000,
    keepaliveMs: 30,
  })
  t.after(() => surface.closeAllStreams())
  return { surface, store, setMode: (value: SessionStateMode) => { currentMode = value } }
}

async function call(method: string, path: string, body?: unknown): Promise<FakeResponse> {
  const req = new FakeRequest(method, path, {})
  const res = new FakeResponse()
  const pending = activeSurface.handle(req as never, res as never, path.split('?')[0])
  if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
  await pending
  return res
}

// ---------------------------------------------------------------------------
// cell A — new client × old gateway
// ---------------------------------------------------------------------------

test('cell A: an absent route set classifies as legacy-gateway, never as a failure', () => {
  const absent = classifySessionStateProbe({ kind: 'response', status: 404 })
  assert.equal(absent.kind, 'legacy-gateway')
  assert.equal(absent.degradation, 'legacy-gateway')
  // The distinction that keeps a transient outage from being read as "old server".
  const timedOut = classifySessionStateProbe({ kind: 'error', error: 'timeout' })
  assert.notEqual(timedOut.kind, 'legacy-gateway')
  const flaky = classifySessionStateProbe({ kind: 'response', status: 502 })
  assert.notEqual(flaky.kind, 'legacy-gateway')
  // The gateway claims the prefix exactly: a lookalike path stays unclaimed, so
  // an old client's own routes are never shadowed by this surface.
  assert.equal(typeof SESSION_STATE_FEATURES.length, 'number')
})

test('cell A: the surface does not claim lookalike prefixes (exact-prefix routing)', async t => {
  const harness = surfaceFor(t)
  activeSurface = harness.surface
  const lookalike = await call('GET', '/chamber/session-stateevil')
  assert.equal(lookalike.status, 404)
  const nested = await call('GET', '/chamber/session-state/other')
  assert.equal(nested.status, 404)
  // The real descriptor route still answers (the surface IS claimed).
  const real = await call('GET', '/chamber/session-state')
  assert.equal(real.status, 200)
})

// ---------------------------------------------------------------------------
// cell B — same version
// ---------------------------------------------------------------------------

test('cell B: the real descriptor classifies ok and advertises the base set', async t => {
  const harness = surfaceFor(t)
  activeSurface = harness.surface
  const res = await call('GET', '/chamber/session-state')
  const body = res.json() as { protocol: number; features: string[]; mode: string }
  assert.equal(body.protocol, PROTOCOL_VERSION)
  const verdict = classifySessionStateProbe({ kind: 'response', status: 200, body })
  assert.equal(verdict.kind, 'ok')
  assert.deepEqual(verdict.missingFeatures, [])
  assert.deepEqual(sessionStateFeatureSupport(body.features), { ok: true, missing: [] })
})

// ---------------------------------------------------------------------------
// cell C — server newer than client (forward skew)
// ---------------------------------------------------------------------------

test('cell C: a newer protocol or an unknown required feature is forward-skew, not legacy', () => {
  const newerProtocol = classifySessionStateProbe({
    kind: 'response',
    status: 200,
    body: { protocol: PROTOCOL_VERSION + 1, features: [...SESSION_STATE_FEATURES], mode: 'sse', cursor: 0 },
  })
  assert.equal(newerProtocol.kind, 'forward-skew')
  // Additive features a client does not know must be ignorable…
  const additive = classifySessionStateProbe({
    kind: 'response',
    status: 200,
    body: { protocol: PROTOCOL_VERSION, features: [...SESSION_STATE_FEATURES, 'session-state.brand-new'], mode: 'sse', cursor: 0 },
  })
  assert.equal(additive.kind, 'ok', 'unknown advertised ids are additive, never fatal')
  // …while a MISSING required one is the honest forward-skew shape.
  const missingBase = classifySessionStateProbe({
    kind: 'response',
    status: 200,
    body: { protocol: PROTOCOL_VERSION, features: ['session-state.snapshot'], mode: 'sse', cursor: 0 },
  })
  assert.equal(missingBase.kind, 'forward-skew')
  assert.deepEqual(missingBase.missingFeatures, SESSION_STATE_BASE_FEATURES.filter(f => f !== 'session-state.snapshot'))
  // The server side is additive too: every base feature stays advertised and all
  // ids are dotted namespaced strings (no enum ordinal that could renumber).
  assert.deepEqual(SESSION_STATE_FEATURES.filter(f => SESSION_STATE_BASE_FEATURES.includes(f)).length, SESSION_STATE_BASE_FEATURES.length)
  for (const feature of SESSION_STATE_FEATURES) assert.match(feature, /^session-state\.[a-z0-9-]+$/)
})

// ---------------------------------------------------------------------------
// cell D — server older / degraded (feature set shrinks)
// ---------------------------------------------------------------------------

test('cell D: poll mode drops the event-only ids and off mode advertises none', () => {
  const sse = featuresForMode('sse')
  const poll = featuresForMode('poll')
  const off = featuresForMode('off')
  assert.deepEqual(off, [])
  assert.ok(poll.length < sse.length)
  assert.equal(poll.includes('session-state.dsh-events'), false)
  assert.equal(poll.includes('session-state.pending-graph'), false)
  assert.equal(sse.includes('session-state.dsh-events'), true)
  // A client that needs live events sees the capability gap and must degrade.
  const needsEvents = sessionStateFeatureSupport(poll, ['session-state.dsh-events'])
  assert.equal(needsEvents.ok, false)
  assert.deepEqual(needsEvents.missing, ['session-state.dsh-events'])
  // The base set is still satisfied in poll mode: the mirror stays usable.
  assert.equal(sessionStateFeatureSupport(poll).ok, true)
  // …and the surface reports the degraded mode instead of the sse feature set.
  const modeOff = classifySessionStateProbe({
    kind: 'response',
    status: 200,
    body: { protocol: PROTOCOL_VERSION, features: [], mode: 'off', cursor: 0 },
  })
  assert.equal(modeOff.kind, 'disabled')
})

// ---------------------------------------------------------------------------
// additive tolerance (both directions)
// ---------------------------------------------------------------------------

test('unknown request fields and query params are ignored, wrong types are not', async t => {
  const harness = surfaceFor(t)
  harness.store.applyBaseline([{ sessionId: 's1', running: false, updatedAt: 5 }], { at: 100 })
  activeSurface = harness.surface
  // Unknown fields from a NEWER client must not break an older server.
  const extra = await call('POST', '/chamber/session-state/read', {
    clientId: 'client-1', sessionId: 's1', readThrough: 90, somethingNew: { nested: true },
  })
  assert.equal(extra.status, 200)
  assert.equal((extra.json() as { readThrough: number }).readThrough, 90)
  const extraQuery = await call('GET', '/chamber/session-state?clientId=client-1&somethingNew=1')
  assert.equal(extraQuery.status, 200)
  // A wrong type on a KNOWN field stays a loud 400 (strict at the boundary).
  const wrong = await call('POST', '/chamber/session-state/read', { clientId: 'client-1', sessionId: 's1', readThrough: '90' })
  assert.equal(wrong.status, 400)
  const wrongAll = await call('POST', '/chamber/session-state/read-all', { clientId: 'client-1', through: 1.5 })
  assert.equal(wrongAll.status, 400)
})
