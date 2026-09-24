/**
 * Cross-version contract matrix, cell B — OLD desktop × NEW gateway.
 *
 * The old desktop cannot be rebuilt in-repo, so the only executable evidence for
 * forward compatibility is a FROZEN CALL-SEQUENCE FIXTURE replayed against the
 * live gateway surface:
 *   support/compat/route-table-0.4.0.fixture.json
 * It records the v0.4.0-beta.1 client's routes, request bodies, expected
 * statuses, the wire key sets and the exact field paths that client parses.
 * This file replays every entry through the REAL gateway entry
 * (createChamberSurface -> /chamber/session-state*) and asserts:
 *
 *   (a) each old route still exists and answers the frozen status;
 *   (b) the old client's visible key set is unchanged — extras are additive only
 *       (the live key set equals frozenKeys + the recorded additiveKeys, so a
 *       rename / deletion / unrecorded addition is red);
 *   (c) the recorded additive fields (diagnostics, row.factAt, row.goal with its
 *       identity-bound activation) ARE present in the
 *       live response while the old parse path — reading only the fixture key
 *       set — still projects the same facts: "ignore unknown keys" is proven,
 *       not assumed (including an x_future injection at every level and the real
 *       classifySessionStateProbe on the injected body);
 *   (d) base features and full features differ by exactly the recorded additions
 *       (the feature vocabulary is frozen; a new advertised id must be appended
 *       to features.addedAfterFreeze).
 *
 * The last test is a live negative control: the very key-set tripwire used by
 * (b) must reject a renamed / deleted / extra key, so a green run cannot mean
 * "the checker happens to pass everything".
 *
 * Run directly:
 *   node --import ./test/session-state/workspace-loader.mjs test/session-state/session-state-old-desktop-matrix.test.ts
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SESSION_STATE_FEATURES } from '@dsh-chamber/control-plane'
// The session-state wire-primitive faces are importable from this package's
// source module; they are not part of the control-plane entry's consumed
// surface (the entry keeps only names with a production importer).
import {
  PROTOCOL_VERSION,
  SESSION_STATE_BASE_FEATURES,
  SESSION_STATE_ROUTES,
  classifySessionStateProbe,
  parseSessionStateDescriptor,
} from '../../../control-plane/src/session-state-protocol.ts'
import { createChamberInstalled } from '../../src/plugins-installed.ts'
import { createChamberPlugins } from '../../src/plugins.ts'
import { createChamberSurface } from '../../src/routes.ts'
import { createSessionStateStore, featuresForMode } from '../../src/session-state.ts'
import { FakeRequest, FakeResponse, stubPluginTasks } from '../support/utils.ts'
import { baselineItem, scratch, sessionSurfaceFor, silentLogger } from './harness.ts'
import { surfaceStubChannels } from '../support/chamber-surface-harness.ts'

// ---------------------------------------------------------------------------
// The frozen fixture (single source for this cell's expectations)
// ---------------------------------------------------------------------------

interface RouteExpect {
  status: number
  kind: 'json' | 'sse'
  contentType: string
  frozenKeys?: string[]
  additiveKeys?: string[]
  nested?: {
    host?: string[]
    read?: string[]
    sessionRow?: string[]
    sessionRowAdditive?: string[]
    goal?: string[]
    lastTurnEnd?: string[]
    diagnostics?: string[]
    diagnosticsDropped?: string[]
  }
  frameEnvelope?: string[]
  firstEvent?: string
  dataRoute?: string
  clientReads: string[]
}

interface RouteFixture {
  id: string
  method: string
  path: string
  request: { query: string | null; headers: Record<string, string>; body: unknown }
  expect: RouteExpect
}

interface Fixture {
  schema: string
  usage: { who: string; whenToUpdate: string; howToUpdate: string; whyFrozen: string; scope: string }
  anchor: {
    productVersion: string
    protocolVersion: number
    recordedFrom: string[]
    postFreezeAdditions: Array<{ field: string; where: string; instrument: string; oldClient: string }>
  }
  features: { clientRequired: string[]; addedAtFreeze: string[]; addedAfterFreeze: string[] }
  routesAddedAfterFreeze: string[]
  routes: RouteFixture[]
}

const fixture = JSON.parse(
  readFileSync(new URL('../../../../support/compat/route-table-0.4.0.fixture.json', import.meta.url), 'utf8'),
) as Fixture

const ROUTES_BY_ID = new Map(fixture.routes.map(route => [route.id, route] as const))

function routeById(id: string): RouteFixture {
  const route = ROUTES_BY_ID.get(id)
  assert.ok(route !== undefined, 'the fixture has no route ' + id)
  return route
}

/** The one seeded session the old client's replay observes. */
const LEGACY_SESSION = 'legacy-session-1'
const CLIENT_ID = 'dsh-chamber-mobile-legacy'

// ---------------------------------------------------------------------------
// Harness: the REAL gateway entry + the REAL session-state surface
// ---------------------------------------------------------------------------

interface GatewayHarness {
  surface: ReturnType<typeof createChamberSurface>
  store: ReturnType<typeof createSessionStateStore>
}

function gatewayFor(t: { after(fn: () => void): void }): GatewayHarness {
  const stateDir = scratch(t)
  // Shared session-state harness on the SAME stateDir the
  // chamber surface below reads (its plugin/installed fixtures live under it).
  const { surface: sessionState, store } = sessionSurfaceFor(t, { stateDir })
  const surface = createChamberSurface({
    logger: silentLogger,
    channels: surfaceStubChannels,
    plugins: createChamberPlugins(stateDir, silentLogger),
    installed: createChamberInstalled(stateDir),
    tasks: stubPluginTasks(),
    stateDir,
    sessionState,
  })
  return { surface, store }
}

/** Deterministic old-desktop state: one stopped session with an observed completion
 *  and one projected goal fact (the post-freeze additive row key the replay must
 *  keep ignoring). */
function seedOldDesktopState(store: ReturnType<typeof createSessionStateStore>): void {
  store.applyBaseline([baselineItem(LEGACY_SESSION, true, 5, {
    goal: { goalId: 'legacy-goal-1', revision: 1, phase: 'active', updatedAt: 5 },
  })], { at: 100 })
  // The process-local activation edge is bound to its exact goal id (P2a); the
  // replay below must see it round-trip on the wire row, never on another goal.
  store.applyGoalActivation({ sessionId: LEGACY_SESSION, goalId: 'legacy-goal-1', activation: 'armed' }, 105)
  store.applyStatus(LEGACY_SESSION, false, 110)
  store.settleCompletion(LEGACY_SESSION, {
    at: 110,
    turnEnd: { kind: 'completed', cause: null, at: 110, seq: 1 },
    source: 'observed',
    unreadable: false,
  })
}

/** Replay one fixture entry exactly as the old client issued it. */
async function replay(surface: ReturnType<typeof createChamberSurface>, route: RouteFixture): Promise<FakeResponse> {
  const req = new FakeRequest(route.method, route.path, route.request.headers ?? {})
  const res = new FakeResponse()
  const pending = surface.handle(req as never, res as never, route.path)
  if (route.request.body !== null && route.request.body !== undefined) {
    req.emit('data', Buffer.from(JSON.stringify(route.request.body)))
  }
  req.emit('end')
  await pending
  return res
}

// ---------------------------------------------------------------------------
// Contract helpers (the tripwires)
// ---------------------------------------------------------------------------

function keysOf(value: unknown): string[] {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []
}

/**
 * (b)'s tripwire: the live key set must equal the frozen set plus the recorded
 * additive set. A rename, a deletion or an unrecorded addition fails here.
 */
function assertFrozenKeySet(label: string, actual: readonly string[], expected: readonly string[]): void {
  assert.deepEqual(
    [...actual].sort(),
    [...expected].sort(),
    label + ': key set changed — a key was renamed, deleted or added without a fixture entry (see support/compat/route-table-0.4.0.fixture.json usage header)',
  )
}

/** (c)'s old parser: read ONLY the fixture's frozen keys; unknown keys are never touched. */
function pick(source: unknown, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return result
  for (const key of keys) result[key] = (source as Record<string, unknown>)[key]
  return result
}

function legacySnapshotRead(body: Record<string, unknown>, route: RouteFixture): Record<string, unknown> {
  const nested = route.expect.nested ?? {}
  const projection: Record<string, unknown> = {}
  for (const key of route.expect.frozenKeys ?? []) projection[key] = body[key]
  projection.host = pick(body.host, nested.host ?? [])
  projection.sessions = Array.isArray(body.sessions)
    ? body.sessions.map(row => {
        // The old parser rebuilds lastTurnEnd from its known fields (a raw object
        // copy would smuggle unknown sub-keys through the "ignore unknown" path).
        const projected = pick(row, nested.sessionRow ?? [])
        const turnEnd = (row as Record<string, unknown>).lastTurnEnd
        if (turnEnd !== null && turnEnd !== undefined) {
          projected.lastTurnEnd = pick(turnEnd, nested.lastTurnEnd ?? [])
        }
        return projected
      })
    : []
  projection.read = pick(body.read, nested.read ?? [])
  return projection
}

/** Resolve one dotted fixture path ("sessions[].lastTurnEnd.kind"); [] = missing. */
function resolves(value: unknown, path: string): boolean {
  let current: unknown[] = [value]
  for (const segment of path.split('.')) {
    const array = segment.endsWith('[]')
    const key = array ? segment.slice(0, -2) : segment
    const next: unknown[] = []
    for (const item of current) {
      if (item === null || typeof item !== 'object') continue
      const child = (item as Record<string, unknown>)[key]
      if (child === undefined) continue
      if (array) {
        if (!Array.isArray(child)) return false
        next.push(...child)
      } else {
        next.push(child)
      }
    }
    if (next.length === 0) return false
    current = next
  }
  return current.length > 0
}

function assertClientReads(value: unknown, route: RouteFixture, label: string): void {
  for (const path of route.expect.clientReads) {
    assert.ok(resolves(value, path), label + ': the old client read path no longer resolves: ' + path)
  }
}

function assertSnapshotContract(body: Record<string, unknown>, route: RouteFixture): void {
  const nested = route.expect.nested ?? {}
  const frozen = route.expect.frozenKeys ?? []
  const additive = route.expect.additiveKeys ?? []
  for (const key of additive) assert.ok(!frozen.includes(key), route.id + ': additive key ' + key + ' is also frozen')
  assertFrozenKeySet(route.id + ' top-level', keysOf(body), [...frozen, ...additive])
  assertFrozenKeySet(route.id + '.host', keysOf(body.host), nested.host ?? [])
  assertFrozenKeySet(route.id + '.read', keysOf(body.read), nested.read ?? [])
  const sessions = Array.isArray(body.sessions) ? body.sessions : []
  assert.equal(sessions.length, 1, route.id + ': the replay seed must yield exactly one session row')
  assertFrozenKeySet(
    route.id + '.sessions[]',
    keysOf(sessions[0]),
    [...(nested.sessionRow ?? []), ...(nested.sessionRowAdditive ?? [])],
  )
  const row = sessions[0] as Record<string, unknown>
  assert.notEqual(row.lastTurnEnd, null, route.id + ': the seeded row must carry a lastTurnEnd')
  assertFrozenKeySet(route.id + '.sessions[].lastTurnEnd', keysOf(row.lastTurnEnd), nested.lastTurnEnd ?? [])
  if (nested.goal !== undefined) {
    assert.notEqual(row.goal, null, route.id + ': the seeded row must carry a goal fact')
    assertFrozenKeySet(route.id + '.sessions[].goal', keysOf(row.goal), nested.goal)
    // The recorded activation must really round-trip: dropping the process-local
    // edge (or mis-binding it) leaves the key absent and reds the key-set check
    // above; this pins the value and its identity as well.
    const goal = row.goal as Record<string, unknown>
    assert.equal(goal.goalId, 'legacy-goal-1')
    assert.equal(goal.activation, 'armed', route.id + ': the bound activation must ride the wire row')
  }
  // The nested additive counters are diagnosed too: a nested key rename /
  // deletion inside the additive diagnostics object must red the same way a
  // top-level change does (the old client never enters the object at all).
  if (nested.diagnostics !== undefined) {
    const diagnostics = body.diagnostics as Record<string, unknown>
    assert.ok(diagnostics !== undefined && diagnostics !== null, route.id + ': recorded additive key diagnostics is missing')
    assertFrozenKeySet(route.id + '.diagnostics', keysOf(diagnostics), nested.diagnostics)
    assertFrozenKeySet(route.id + '.diagnostics.dropped', keysOf(diagnostics.dropped), nested.diagnosticsDropped ?? [])
  }
  // Descriptor vocabulary: protocol 1, sse mode advertises the frozen full set,
  // and the old client's base set stays inside it.
  assert.equal(body.protocol, PROTOCOL_VERSION)
  assert.equal(body.mode, 'sse')
  assert.deepEqual([...(body.features as string[])].sort(), [...SESSION_STATE_FEATURES].sort())
  for (const feature of SESSION_STATE_BASE_FEATURES) {
    assert.ok((body.features as string[]).includes(feature), route.id + ': base feature dropped: ' + feature)
  }
}

/** (c): the old projection of the frozen key set, before and after unknown-key injection. */
function assertOldClientProjection(projection: Record<string, unknown>): void {
  assert.equal(projection.protocol, PROTOCOL_VERSION)
  assert.deepEqual(projection.features, [...SESSION_STATE_FEATURES])
  assert.equal(projection.mode, 'sse')
  assert.equal(typeof projection.cursor, 'number')
  assert.deepEqual(projection.host, { now: 1_000, serviceable: true, state: 'ready' })
  assert.deepEqual(projection.sessions, [{
    sessionId: LEGACY_SESSION,
    running: false,
    pendingKind: null,
    subagentCount: 0,
    updatedAt: 5,
    completedAt: 110,
    completedAtSource: 'observed',
    lastRunningAt: 100,
    lastTurnEnd: { kind: 'completed', cause: null, at: 110, seq: 1 },
  }])
  assert.deepEqual(projection.read, { clientId: null, marks: {}, floor: 0 })
}

interface InjectedSnapshot {
  [key: string]: unknown
  host: Record<string, unknown>
  sessions: Array<Record<string, unknown> & { lastTurnEnd: Record<string, unknown> }>
}

function assertUnknownKeysIgnored(body: Record<string, unknown>, route: RouteFixture, projection: Record<string, unknown>): void {
  // The live response DOES carry the recorded post-freeze additions, so the
  // ignore test below is not vacuous.
  assert.ok(body.diagnostics !== undefined, route.id + ': recorded additive key diagnostics is missing')
  const diagnostics = body.diagnostics as Record<string, unknown>
  assert.ok(diagnostics.dropped !== undefined && diagnostics.dropped !== null, route.id + ': diagnostics.dropped is missing')
  assert.ok(
    Object.prototype.hasOwnProperty.call(diagnostics.dropped, 'goalActivations'),
    route.id + ': the recorded nested diagnostics.dropped.goalActivations counter is missing',
  )
  const rows = body.sessions as Array<Record<string, unknown>>
  assert.ok(rows[0].factAt !== undefined, route.id + ': recorded additive row key factAt is missing')
  // ...and the old parse path (fixture key set) neither carries nor reads them.
  assert.equal(Object.prototype.hasOwnProperty.call(projection, 'diagnostics'), false)
  assert.equal(Object.prototype.hasOwnProperty.call((projection.sessions as Array<Record<string, unknown>>)[0], 'factAt'), false)
  // R1 injection: an unknown key at every level leaves the projection and the
  // production descriptor parser/classifier untouched.
  const injected = JSON.parse(JSON.stringify(body)) as InjectedSnapshot
  injected.x_future = { nested: true }
  injected.host.x_future = 1
  injected.sessions[0].x_future = 'ignored'
  injected.sessions[0].lastTurnEnd.x_future = 'ignored'
  assert.deepEqual(legacySnapshotRead(injected, route), projection)
  assert.equal(classifySessionStateProbe({ kind: 'response', status: 200, body: injected }).kind, 'ok')
  assert.equal(parseSessionStateDescriptor(injected)?.protocol, PROTOCOL_VERSION)
}

interface SseFrame {
  id: number | null
  event: string
  data: unknown
  envelope: string[]
}

function firstSseFrame(res: FakeResponse): SseFrame {
  const block = res.body
    .split('\n\n')
    .map(part => part.trim())
    .find(part => part.length > 0 && !part.startsWith(':'))
  assert.ok(block !== undefined, 'the SSE stream produced no data frame')
  const fields = new Map<string, string>()
  for (const line of (block as string).split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    fields.set(line.slice(0, colon), line.slice(colon + 1).replace(/^ /, ''))
  }
  const data = fields.get('data')
  assert.ok(data !== undefined, 'the SSE first frame carries no data field')
  const rawId = fields.get('id')
  return {
    id: rawId === undefined ? null : Number(rawId),
    event: fields.get('event') ?? 'message',
    data: JSON.parse(data as string),
    envelope: [...fields.keys()].sort(),
  }
}

// ---------------------------------------------------------------------------
// Fixture sanity + (d) vocabulary freeze
// ---------------------------------------------------------------------------

test('cell B: the frozen v0.4.0-beta.1 fixture pins the vocabulary and the route table', () => {
  for (const key of ['who', 'whenToUpdate', 'howToUpdate', 'whyFrozen'] as const) {
    assert.ok(fixture.usage[key].length > 40, 'fixture usage.' + key + ' must explain the frozen discipline')
  }
  assert.equal(fixture.schema, 'dsh-chamber.session-state-route-table/v1')
  assert.equal(fixture.anchor.protocolVersion, PROTOCOL_VERSION)
  assert.equal(fixture.anchor.productVersion, '0.4.0-beta.1')
  // (d) the base set is exactly the old client's required set...
  assert.deepEqual([...SESSION_STATE_BASE_FEATURES].sort(), [...fixture.features.clientRequired].sort())
  // ...and full minus base is exactly the recorded additions: a new advertised
  // id must be appended to features.addedAfterFreeze, never slipped in.
  const added = SESSION_STATE_FEATURES.filter(feature => !SESSION_STATE_BASE_FEATURES.includes(feature)).sort()
  assert.deepEqual(added, [...fixture.features.addedAtFreeze, ...fixture.features.addedAfterFreeze].sort())
  assert.equal(new Set(SESSION_STATE_FEATURES).size, SESSION_STATE_FEATURES.length, 'no duplicate feature ids')
  for (const feature of SESSION_STATE_FEATURES) assert.match(feature, /^session-state\.[a-z0-9-]+$/)
  // Every additive key is recorded in the anchor's additions log.
  const recordedAdditions = new Set(fixture.anchor.postFreezeAdditions.map(entry => entry.field))
  for (const route of fixture.routes) {
    for (const key of route.expect.additiveKeys ?? []) {
      assert.ok(recordedAdditions.has(key), route.id + ': additive key ' + key + ' is missing from anchor.postFreezeAdditions')
    }
  }
  // Nested post-freeze additions use the same log with their dotted field path
  // and a dedicated nested key list. The P2a retained-edge cap counter is the
  // first one; a nested rename/deletion without touching this list must be
  // impossible to land silently.
  const nested = routeById('snapshot').expect.nested ?? {}
  assert.ok(
    recordedAdditions.has('diagnostics.dropped.goalActivations'),
    'the nested diagnostics.dropped.goalActivations addition is missing from anchor.postFreezeAdditions',
  )
  assert.ok((nested.diagnostics ?? []).includes('dropped'), 'the nested diagnostics list must record the dropped object')
  assert.ok(
    (nested.diagnosticsDropped ?? []).includes('goalActivations'),
    'the nested diagnosticsDropped list must record goalActivations',
  )
  // Route-table freeze: the live claimed table is the old table plus consciously
  // appended post-freeze routes (the old client keeps calling only the old four).
  const liveRoutes = [...SESSION_STATE_ROUTES].sort()
  const recordedRoutes = [...fixture.routes.map(route => route.path), ...fixture.routesAddedAfterFreeze].sort()
  assert.deepEqual(liveRoutes, recordedRoutes, 'live route table changed: append the new path to routesAddedAfterFreeze (never edit a frozen entry)')
  // The old client's base set stays usable in the degraded poll shape too.
  for (const feature of SESSION_STATE_BASE_FEATURES) assert.ok(featuresForMode('poll').includes(feature))
  // session-state.goal is OPTIONAL and NOT event-only: the read-only
  // session/list baseline exists in poll mode too, so the capability is
  // advertised in both live and degraded shapes (never in off).
  assert.ok(featuresForMode('poll').includes('session-state.goal'))
  assert.ok(featuresForMode('sse').includes('session-state.goal'))
  assert.equal(featuresForMode('off').includes('session-state.goal'), false)
})

// ---------------------------------------------------------------------------
// (a)(b)(c) replay every frozen old-client call
// ---------------------------------------------------------------------------

for (const route of fixture.routes) {
  test('cell B: old desktop ' + route.method + ' ' + route.path + ' answers ' + String(route.expect.status), async t => {
    const harness = gatewayFor(t)
    seedOldDesktopState(harness.store)
    const res = await replay(harness.surface, route)
    // (a) the route still exists and answers the frozen status.
    assert.equal(res.status, route.expect.status, route.id + ': status drifted')
    assert.ok(String(res.getHeader('content-type') ?? '').startsWith(route.expect.contentType), route.id + ': content-type drifted')
    assert.equal(res.headersSent, true)
    if (route.id === 'snapshot') {
      const body = res.json() as Record<string, unknown>
      assertSnapshotContract(body, route)
      assertClientReads(body, route, route.id)
      const projection = legacySnapshotRead(body, route)
      assertOldClientProjection(projection)
      assertUnknownKeysIgnored(body, route, projection)
    } else if (route.id === 'stream') {
      const frame = firstSseFrame(res)
      assert.equal(frame.event, route.expect.firstEvent, route.id + ': first event drifted')
      assertFrozenKeySet(route.id + ' frame envelope', frame.envelope, route.expect.frameEnvelope ?? [])
      assert.equal(typeof frame.id, 'number', route.id + ': the snapshot frame must carry a numeric id')
      assertClientReads(frame, route, route.id)
      const dataRoute = routeById(route.expect.dataRoute ?? 'snapshot')
      const data = frame.data as Record<string, unknown>
      assertSnapshotContract(data, dataRoute)
      assert.equal(frame.id, data.cursor, route.id + ': the frame id must equal the snapshot cursor')
      const projection = legacySnapshotRead(data, dataRoute)
      assertOldClientProjection(projection)
      assertUnknownKeysIgnored(data, dataRoute, projection)
    } else if (route.id === 'read') {
      const body = res.json() as Record<string, unknown>
      assertFrozenKeySet(route.id, keysOf(body), [...(route.expect.frozenKeys ?? []), ...(route.expect.additiveKeys ?? [])])
      assert.equal(body.ok, true)
      assert.equal(body.clientId, CLIENT_ID)
      assert.equal(body.sessionId, LEGACY_SESSION)
      assert.equal(body.readThrough, 90)
      assert.equal(body.changed, true)
      assert.equal(body.stored, true)
      // Fire-and-forget in the old client (fixture clientReads = []): the frozen
      // contract is the status plus the exact response key set above.
      assert.equal(route.expect.clientReads.length, 0, route.id + ': the fixture must record the fire-and-forget read path')
    } else if (route.id === 'read-all') {
      const body = res.json() as Record<string, unknown>
      assertFrozenKeySet(route.id, keysOf(body), [...(route.expect.frozenKeys ?? []), ...(route.expect.additiveKeys ?? [])])
      assert.equal(body.ok, true)
      assert.equal(body.clientId, CLIENT_ID)
      assert.equal(body.through, 110)
      assert.equal(body.floor, 110)
      assert.equal(body.changed, true)
      assert.equal(body.updated, 1)
      assert.equal(route.expect.clientReads.length, 0, route.id + ': the fixture must record the fire-and-forget read path')
    } else {
      assert.fail(
        'the fixture route ' + route.id + ' has no cell-B assertion: add one when appending the route '
        + '(append-only; see support/compat/route-table-0.4.0.fixture.json usage header)',
      )
    }
  })
}

// ---------------------------------------------------------------------------
// Live negative control: the tripwire itself must be able to fail
// ---------------------------------------------------------------------------

test('cell B negative control: the frozen key-set tripwire reds on rename, deletion and unrecorded addition', () => {
  const route = routeById('snapshot')
  const recorded = [...(route.expect.frozenKeys ?? []), ...(route.expect.additiveKeys ?? [])].sort()
  assertFrozenKeySet('control: the recorded set passes', recorded, recorded)
  const renamed = recorded.map(key => (key === 'protocol' ? 'protocolVersion' : key)).sort()
  assert.throws(() => assertFrozenKeySet('mutant rename', renamed, recorded), /mutant rename/)
  const deleted = recorded.filter(key => key !== 'host')
  assert.throws(() => assertFrozenKeySet('mutant deletion', deleted, recorded), /mutant deletion/)
  const added = [...recorded, 'x_future'].sort()
  assert.throws(() => assertFrozenKeySet('mutant addition', added, recorded), /mutant addition/)
  // The nested goal key table is live too: a missing activation (the field the
  // matrix now seeds and asserts) must red.
  const goalKeys = route.expect.nested?.goal ?? []
  assert.ok(goalKeys.includes('activation'), 'the fixture must record the nested activation key')
  assert.throws(
    () => assertFrozenKeySet('mutant goal-without-activation', goalKeys.filter(key => key !== 'activation'), goalKeys),
    /mutant goal-without-activation/,
  )
  // The nested additive counter table is live too: a deleted / renamed
  // goalActivations key inside diagnostics.dropped must red.
  const droppedKeys = route.expect.nested?.diagnosticsDropped ?? []
  assert.ok(droppedKeys.includes('goalActivations'), 'the fixture must record the nested dropped goalActivations key')
  assert.throws(
    () => assertFrozenKeySet('mutant dropped-without-goalActivations', droppedKeys.filter(key => key !== 'goalActivations'), droppedKeys),
    /mutant dropped-without-goalActivations/,
  )
  assert.throws(
    () => assertFrozenKeySet(
      'mutant diagnostics-dropped-renamed',
      [...droppedKeys.filter(key => key !== 'goalActivations'), 'goalActivation'],
      droppedKeys,
    ),
    /mutant diagnostics-dropped-renamed/,
  )
  // The client-read resolver is live too: a renamed key stops resolving.
  assert.equal(resolves({ protocol: 1 }, 'protocol'), true)
  assert.equal(resolves({ protocolVersion: 1 }, 'protocol'), false)
})
