/**
 * chamberForward adapter — the wire→launcher translation lockstep (design 28,
 * W0/S1 slice).
 *
 * The adapter under test is the ONLY page-level translation between the trusted
 * preload namespace (`window.dshChamber.forward`, wire vocabulary: `record` /
 * `records`, seven states, a closed snake_case error table, `{ok:false,
 * error:{code,detail}}`) and the remote-browser launcher (three states, eleven
 * kebab-case codes, `{ok:false, code}`). v2 additive fields are driven too:
 * consumer/path passthrough, frameUrl projection and the per-record frameError
 * diagnostic. The v2 list paper fields are retired with the iframe carrier and
 * the wire (design 28 v3 §3): the suite asserts they never reappear.
 *
 * Evidence shape:
 *  - behavioural: every wire state and error code is DRIVEN from the wire source
 *    through a fake page host, and the translated envelope is re-parsed by the
 *    launcher's own guards (imported from its source, test face only);
 *  - lockstep: the wire state/code/record-key tables and the launcher's
 *    state/failure vocabularies are read from the two sources, so a wire or
 *    launcher change fails HERE instead of silently dropping a row;
 *  - wiring: the composite installs the adapter before the deferred roster
 *    mounts, and neither file adds a page global.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { installChamberBrowser, installChamberForward } from '../../src/chamber-forward-adapter.ts'
import type { ChamberForwardBridge } from '../../src/chamber-forward-adapter.ts'
import {
  asBrowserForwardBridge,
  parseForwardAck,
  parseForwardListResult,
  parseForwardRecord,
  parseForwardRequestResult,
} from '../../../dsh-chamber-client-ui-browser/src/shared/forward-bridge.ts'
import { REQUIRED_BROWSER_INVOKES } from '../../../dsh-chamber-client-ui-browser/src/client/browser/BrowserBridge.ts'

const WIRE_SOURCE = readFileSync(
  new URL('../../../dsh-chamber-wire/src/forward.ts', import.meta.url), 'utf8')
const LAUNCHER_SOURCE = readFileSync(
  new URL('../../../dsh-chamber-client-ui-browser/src/shared/forward-bridge.ts', import.meta.url), 'utf8')
const ADAPTER_SOURCE = readFileSync(
  new URL('../../src/chamber-forward-adapter.ts', import.meta.url), 'utf8')
const ENTRY_SOURCE = readFileSync(
  new URL('../../src/chamber-entry.ts', import.meta.url), 'utf8')

/** The wire states, read from the wire source (order preserved). */
const WIRE_STATES = quotedBlock(WIRE_SOURCE, 'export const FORWARD_STATES = \\[', '\\] as const')
/** The wire error codes, read from the wire source (order preserved). */
const WIRE_CODES = quotedBlock(WIRE_SOURCE, 'export const FORWARD_ERROR_CODES = \\[', '\\] as const')
/** The wire frame-failure classifications, read from the wire source. */
const WIRE_FRAME_ERRORS = quotedBlock(WIRE_SOURCE, 'export const FORWARD_FRAME_ERRORS = \\[', '\\] as const')
/** The wire contract version, read from the wire source (v2 = design 28 §16). */
const WIRE_VERSION = (() => {
  const match = /export const FORWARD_WIRE_VERSION = (\d+)/u.exec(WIRE_SOURCE)
  assert.ok(match !== null, 'the wire version literal moved; re-read the wire source')
  return Number(match[1])
})()

/** The review-visible expected fold: every wire state → one launcher bucket. */
const EXPECTED_STATE_FOLD: Readonly<Record<string, string>> = {
  requested: 'binding',
  starting: 'binding',
  bound: 'bound',
  reconnecting: 'binding',
  closing: 'binding',
  closed: 'binding',
  error: 'error',
}

/** The review-visible expected fold: every wire code → one launcher code. */
const EXPECTED_CODE_FOLD: Readonly<Record<string, string>> = {
  source_unknown: 'not-found',
  source_not_dsh: 'forbidden-source',
  transport_not_ssh: 'forbidden-source',
  source_changed: 'stale',
  browser_disabled: 'confirm-declined',
  confirmation_declined: 'confirm-declined',
  confirmation_late: 'stale',
  target_port_invalid: 'invalid-port',
  target_port_reserved: 'invalid-port',
  scheme_invalid: 'unknown',
  too_many_for_source: 'limit',
  too_many_global: 'limit',
  namespace_unavailable: 'unavailable',
  alias_exhausted: 'unavailable',
  port_exhausted: 'bind-failed',
  local_bind_failed: 'bind-failed',
  auth_failed: 'spawn-failed',
  forward_failed: 'spawn-failed',
  forward_not_found: 'not-found',
  forward_not_owned: 'forbidden-source',
  forward_not_bound: 'stale',
  forward_stale: 'stale',
  invalid_path: 'unknown',
  rate_limited: 'limit',
  open_failed: 'unavailable',
  release_timeout: 'release-timeout',
}

/** Every wire field the adapter reads (the rest are main/manager facts). */
const READ_WIRE_FIELDS = ['id', 'targetPort', 'localPort', 'scheme', 'aliasHost', 'state', 'stale', 'error', 'frameError']

/** The launcher's declared failure set, read from its source. */
const LAUNCHER_CODES = quotedBlock(
  LAUNCHER_SOURCE, 'const FAILURE_CODES: ReadonlySet<string> = new Set<ForwardFailureCode>\\(\\[', '\\]\\)')
/** The launcher's declared state union, read from its source. */
const LAUNCHER_STATES = (() => {
  const match = /export type ForwardState = ([^\n]+)/u.exec(LAUNCHER_SOURCE)
  assert.ok(match !== null, 'the launcher ForwardState union moved; re-read its source')
  return [...match[1].matchAll(/'([a-z-]+)'/gu)].map((entry) => entry[1])
})()

function quotedBlock(source: string, startPattern: string, endPattern: string): string[] {
  const block = new RegExp(startPattern + '([\\s\\S]*?)' + endPattern, 'u').exec(source)
  assert.ok(block !== null, 'source anchor not found: ' + startPattern)
  return [...block[1].matchAll(/'([a-z_-]+)'/gu)].map((entry) => entry[1])
}

function fakeCtx(): { provided: Map<string, unknown>; ctx: { provide(name: string, value: unknown): void } } {
  const provided = new Map<string, unknown>()
  return {
    provided,
    ctx: {
      provide: (name: string, value: unknown) => {
        provided.set(name, value)
      },
    },
  }
}

function scopeWith(forward: unknown): unknown {
  return { dshChamber: { forward } }
}

type ForwardCall = (input: unknown) => Promise<unknown>

interface MutableHost {
  next: unknown
  host: {
    request: ForwardCall
    release: ForwardCall
    list: ForwardCall
    openInBrowser: ForwardCall
  }
}

function mutableHost(): MutableHost {
  const state: MutableHost = {
    next: { ok: true },
    host: {
      request: async () => state.next,
      release: async () => state.next,
      list: async () => state.next,
      openInBrowser: async () => state.next,
    },
  }
  return state
}

/** Install against a fake page and return the provided bridge. */
function installedBridge(forward: unknown): { bridge: ChamberForwardBridge; provided: Map<string, unknown> } {
  const { provided, ctx } = fakeCtx()
  assert.equal(installChamberForward(ctx, scopeWith(forward)), true, 'a four-call forward namespace must install')
  const bridge = provided.get('chamberForward')
  assert.notEqual(bridge, undefined, 'the service must be provided under the launcher-probed name')
  return { bridge: bridge as ChamberForwardBridge, provided }
}

/** One full wire record (all wire fields present; extra fields must be ignored). */
function wireRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fwd-0123456789abcdef',
    sourceId: 'dsh-alpha',
    namespace: 7,
    aliasHost: '127.0.0.2',
    localPort: 41_000,
    scheme: 'http',
    targetHost: '127.0.0.1',
    targetPort: 5173,
    state: 'bound',
    stale: false,
    error: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    boundAt: 1_700_000_000_050,
    frameError: null,
    ...overrides,
  }
}

function listArgs(): { sourceId: string; sourceFingerprint: string } {
  return { sourceId: 'dsh-alpha', sourceFingerprint: 'a'.repeat(64) }
}

function limits(): Record<string, number> {
  return { perSource: 8, global: 32, perSourceUsed: 1, globalUsed: 1 }
}

// ── Install / no-bridge ─────────────────────────────────────────────────────────

test('a page without a trusted forward namespace installs NOTHING (honest no-bridge)', () => {
  const scopes: unknown[] = [
    undefined,
    null,
    42,
    'window',
    {},
    { dshChamber: null },
    { dshChamber: {} },
    { dshChamber: { forward: null } },
    { dshChamber: { forward: {} } },
    { dshChamber: { forward: { request: () => {}, release: () => {}, list: () => {} } } },
    { dshChamber: { forward: { request: 1, release: () => {}, list: () => {}, openInBrowser: () => {} } } },
  ]
  for (const scope of scopes) {
    const { provided, ctx } = fakeCtx()
    assert.equal(installChamberForward(ctx, scope), false, 'scope must not install: ' + JSON.stringify(scope))
    assert.equal(provided.size, 0, 'no service may be provided without a real carrier')
  }
})

test('hostile page getters are a no-bridge, never a throw', () => {
  const hostileChamber = {
    get dshChamber(): never {
      throw new Error('boom')
    },
  }
  const hostileForward = {
    dshChamber: {
      get forward(): never {
        throw new Error('boom')
      },
    },
  }
  for (const scope of [hostileChamber, hostileForward]) {
    const { provided, ctx } = fakeCtx()
    assert.equal(installChamberForward(ctx, scope), false)
    assert.equal(provided.size, 0)
  }
})

test('a four-call namespace installs the launcher-shaped bridge under chamberForward', () => {
  const { bridge, provided } = installedBridge(mutableHost().host)
  assert.deepEqual([...provided.keys()], ['chamberForward'])
  assert.notEqual(asBrowserForwardBridge(bridge), null, 'the launcher structural probe must accept the bridge')
  for (const method of ['request', 'release', 'list', 'openInBrowser']) {
    assert.equal(typeof (bridge as unknown as Record<string, unknown>)[method], 'function')
  }
})

test('install adds no page global (the single page namespace stays window.dshChamber)', () => {
  const scope = scopeWith(mutableHost().host) as Record<string, unknown>
  const before = Object.keys(scope)
  const { ctx } = fakeCtx()
  assert.equal(installChamberForward(ctx, scope), true)
  assert.deepEqual(Object.keys(scope), before, 'install must not write on the page scope')
  assert.equal(scope.chamberForward, undefined)
  for (const source of [ADAPTER_SOURCE, ENTRY_SOURCE]) {
    assert.doesNotMatch(source, /(?:globalThis|window)\.chamberForward\s*=/u, 'no page-level chamberForward global')
  }
})

// ── Wire states → launcher states ──────────────────────────────────────────────

test('all seven wire states fold into the three launcher states and stay launcher-valid', async () => {
  assert.deepEqual([...WIRE_STATES].sort(), Object.keys(EXPECTED_STATE_FOLD).sort(),
    'the wire state table changed — re-review the state fold before updating the adapter')
  const state = mutableHost()
  state.next = {
    ok: true,
    records: WIRE_STATES.map((wireState) => wireRecord({
      id: 'fwd-' + wireState,
      state: wireState,
      stale: wireState === 'reconnecting',
      error: wireState === 'error' ? { code: 'forward_stale', detail: null } : null,
    })),
    limits: { perSource: 8, global: 32, perSourceUsed: 1, globalUsed: 1 },
  }
  const { bridge } = installedBridge(state.host)
  const result = await bridge.list(listArgs())
  if (!result.ok) assert.fail('the translated list must be ok')
  assert.deepEqual(result.records.map((record) => record.state), WIRE_STATES.map((wireState) => EXPECTED_STATE_FOLD[wireState]))
  assert.equal(result.records.find((record) => record.id === 'fwd-reconnecting')?.stale, true,
    'a reconnecting record stays stale (the launcher offers reopen, never open)')
  for (const record of result.records) {
    assert.deepEqual(parseForwardRecord(record), record, 'each translated row must survive the launcher own guard')
  }
  assert.equal(parseForwardListResult(result).ok, true)
})

test('the three launcher states are exactly the ones translated (both directions)', () => {
  assert.deepEqual([...new Set(Object.values(EXPECTED_STATE_FOLD))].sort(), [...LAUNCHER_STATES].sort(),
    'the launcher state union changed — re-review the fold')
  assert.deepEqual([...LAUNCHER_STATES].sort(), ['binding', 'bound', 'error'])
})

// ── Wire error codes → launcher codes ──────────────────────────────────────────

test('every wire error code folds to its launcher code (driven from the wire source)', async () => {
  assert.deepEqual([...WIRE_CODES].sort(), Object.keys(EXPECTED_CODE_FOLD).sort(),
    'the wire error table changed — re-review the code fold before updating the adapter')
  const state = mutableHost()
  const { bridge } = installedBridge(state.host)
  for (const code of WIRE_CODES) {
    state.next = { ok: false, error: { code, detail: null } }
    assert.deepEqual(await bridge.list(listArgs()), { ok: false, code: EXPECTED_CODE_FOLD[code] }, 'wire code ' + code)
  }
  assert.deepEqual([...new Set(Object.values(EXPECTED_CODE_FOLD))].sort(), [...LAUNCHER_CODES].sort(),
    'the launcher failure set changed — re-review the fold')
})

test('every mapped launcher code is accepted by the launcher guards', () => {
  for (const code of LAUNCHER_CODES) {
    assert.deepEqual(parseForwardAck({ ok: false, code }), { ok: false, code })
  }
  assert.equal(LAUNCHER_CODES.length, 11)
})

test('an unknown / missing / hostile error code collapses to unknown (never a dropped list)', async () => {
  const state = mutableHost()
  const { bridge } = installedBridge(state.host)
  const cases: unknown[] = [
    { ok: false, error: { code: 'a_future_code', detail: 'from a newer main' } },
    { ok: false, error: { code: '', detail: null } },
    { ok: false, error: null },
    { ok: false },
    { ok: false, error: { get code(): never { throw new Error('boom') }, detail: null } },
    null,
    'not-an-envelope',
    {},
  ]
  for (const failure of cases) {
    state.next = failure
    assert.deepEqual(await bridge.list(listArgs()), { ok: false, code: 'unknown' }, 'case ' + String(failure))
  }
})

// ── Envelope translation for the four calls ────────────────────────────────────

test('request translates the record field names (targetPort → remotePort) and the error tail', async () => {
  const state = mutableHost()
  const { bridge } = installedBridge(state.host)
  state.next = { ok: true, record: wireRecord({ targetPort: 8080, localPort: 41_111 }) }
  const result = await bridge.request({ ...listArgs(), port: 8080, scheme: 'https' })
  if (!result.ok) assert.fail('a valid wire record must translate')
  assert.equal(result.record.remotePort, 8080)
  assert.equal(result.record.localPort, 41_111)
  assert.deepEqual(parseForwardRequestResult(result), result)
  assert.equal('targetPort' in result.record, false, 'the launcher vocabulary has no targetPort')

  state.next = { ok: false, error: { code: 'too_many_for_source', detail: null } }
  assert.deepEqual(await bridge.request({ ...listArgs(), port: 8080 }), { ok: false, code: 'limit' })

  state.next = { ok: true, record: wireRecord({ aliasHost: '127.0.0.1' }) }
  assert.deepEqual(await bridge.request({ ...listArgs(), port: 8080 }), { ok: false, code: 'unknown' },
    'a wire record with an illegal alias must not become a row')
})

test('release and openInBrowser translate acks and failures', async () => {
  const state = mutableHost()
  const { bridge } = installedBridge(state.host)
  state.next = { ok: true }
  assert.deepEqual(await bridge.release({ ...listArgs(), id: 'fwd-0123456789abcdef' }), { ok: true })
  assert.deepEqual(await bridge.openInBrowser({ ...listArgs(), id: 'fwd-0123456789abcdef', path: '/' }), { ok: true })
  state.next = { ok: false, error: { code: 'forward_not_owned', detail: null } }
  assert.deepEqual(await bridge.release({ ...listArgs(), id: 'fwd-0123456789abcdef' }), { ok: false, code: 'forbidden-source' })
  state.next = { ok: false, error: { code: 'open_failed', detail: 'shell rejected' } }
  assert.deepEqual(await bridge.openInBrowser({ ...listArgs(), id: 'fwd-0123456789abcdef' }), { ok: false, code: 'unavailable' })
  state.next = { ok: 'true' }
  assert.deepEqual(await bridge.openInBrowser({ ...listArgs(), id: 'fwd-0123456789abcdef' }), { ok: false, code: 'unknown' })
})

test('a rejected invoke is infrastructure, not a forward code: unavailable on all four calls', async () => {
  const host = {
    request: async (): Promise<unknown> => { throw new Error('channel gone') },
    release: async (): Promise<unknown> => { throw new Error('channel gone') },
    list: async (): Promise<unknown> => { throw new Error('channel gone') },
    openInBrowser: async (): Promise<unknown> => { throw new Error('channel gone') },
  }
  const { bridge } = installedBridge(host)
  assert.deepEqual(await bridge.list(listArgs()), { ok: false, code: 'unavailable' })
  assert.deepEqual(await bridge.request({ ...listArgs(), port: 5173 }), { ok: false, code: 'unavailable' })
  assert.deepEqual(await bridge.release({ ...listArgs(), id: 'fwd-0123456789abcdef' }), { ok: false, code: 'unavailable' })
  assert.deepEqual(await bridge.openInBrowser({ ...listArgs(), id: 'fwd-0123456789abcdef' }), { ok: false, code: 'unavailable' })
})

// ── Record validation ─────────────────────────────────────────────────────────

test('malformed records are dropped one by one; the list keeps the valid rows', async () => {
  const state = mutableHost()
  const { bridge } = installedBridge(state.host)
  const hostileRecord = wireRecord({ id: 'fwd-hostile' })
  Object.defineProperty(hostileRecord, 'aliasHost', {
    enumerable: true,
    get(): never {
      throw new Error('boom')
    },
  })
  state.next = {
    ok: true,
    records: [
      wireRecord({ id: 'fwd-good' }),
      wireRecord({ id: 'fwd-bad-alias-1', aliasHost: '127.0.0.1' }),
      wireRecord({ id: 'fwd-bad-alias-0', aliasHost: '127.0.0.0' }),
      wireRecord({ id: 'fwd-bad-alias-255', aliasHost: '127.0.0.255' }),
      wireRecord({ id: 'fwd-bad-alias-other', aliasHost: '127.1.1.1' }),
      wireRecord({ id: 'fwd-bad-target-port', targetPort: 0 }),
      wireRecord({ id: 'fwd-bad-target-port-high', targetPort: 65_536 }),
      wireRecord({ id: 'fwd-bad-target-port-frac', targetPort: 1.5 }),
      wireRecord({ id: 'fwd-bad-local-port', localPort: 1023 }),
      wireRecord({ id: 'fwd-bad-scheme', scheme: 'ftp' }),
      wireRecord({ id: 'fwd-bad-state', state: 'unknown-state' }),
      wireRecord({ id: 'fwd-bad-stale', stale: 'no' }),
      wireRecord({ id: '' }),
      wireRecord({ id: 'fwd-error-without-error', state: 'error', error: null }),
      wireRecord({ id: 'fwd-bound-with-error', state: 'bound', error: { code: 'forward_stale', detail: null } }),
      wireRecord({ id: 'fwd-bad-detail', state: 'error', error: { code: 'forward_stale', detail: 7 } }),
      hostileRecord,
      null,
      42,
      'not-a-record',
    ],
    limits: { perSource: 8, global: 32, perSourceUsed: 1, globalUsed: 1 },
  }
  const result = await bridge.list(listArgs())
  if (!result.ok) assert.fail('a list with some bad rows must still be ok')
  assert.deepEqual(result.records.map((record) => record.id), ['fwd-good'])
})

test('records are de-duplicated by id (a repeated poll cannot double a row)', async () => {
  const state = mutableHost()
  const { bridge } = installedBridge(state.host)
  state.next = { ok: true, records: [wireRecord(), wireRecord({ targetPort: 6000 })] }
  const result = await bridge.list(listArgs())
  if (!result.ok) assert.fail('list must be ok')
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].remotePort, 5173, 'the first occurrence wins, like the launcher own guard')
})

test('the projection reads exactly the wire record fields (rename lockstep)', () => {
  const match = /isForwardRecord\(value: unknown\): value is ForwardRecord \{[\s\S]*?hasOnlyKeys\(value, \[[\s\S]*?\], \[([\s\S]*?)\]\)/u.exec(WIRE_SOURCE)
  assert.ok(match !== null, 'the wire record guard moved; re-read its key list')
  const required = /hasOnlyKeys\(value, \[([\s\S]*?)\],/u.exec(WIRE_SOURCE)
  assert.ok(required !== null, 'the wire record required-key list moved')
  const wireFields = [
    ...[...required[1].matchAll(/'([A-Za-z]+)'/gu)].map((entry) => entry[1]),
    ...[...match[1].matchAll(/'([A-Za-z]+)'/gu)].map((entry) => entry[1]),
  ]
  for (const field of READ_WIRE_FIELDS) {
    assert.ok(wireFields.includes(field), 'the wire record no longer declares ' + field)
  }
  assert.ok(wireFields.includes('frameError'), 'the v2 additive record field must stay in the wire guard')
})

// ── Wire v2 additive projection ────────────────────────────────────────────────

test('the wire contract version is 2 (design 28 §16 additive batch)', () => {
  assert.equal(WIRE_VERSION, 2, 'the wire bumped its version; re-review every additive field below')
})

test('every wire frame-failure classification projects unchanged into the launcher row', async () => {
  assert.deepEqual([...WIRE_FRAME_ERRORS].sort(), ['blocked_by_response', 'certificate_error', 'load_failed', 'timeout'])
  const state = mutableHost()
  const { bridge } = installedBridge(state.host)
  for (const frameError of WIRE_FRAME_ERRORS) {
    state.next = { ok: true, records: [wireRecord({ frameError })], limits: limits() }
    const result = await bridge.list(listArgs())
    if (!result.ok) assert.fail('the translated list must be ok for ' + frameError)
    assert.equal(result.records[0].frameError, frameError)
    assert.deepEqual(parseForwardRecord(result.records[0]), result.records[0], 'the launcher guard accepts the projected row')
  }
  // An unknown future token is dropped, not a dropped row: forward compatibility.
  state.next = { ok: true, records: [wireRecord({ frameError: 'future_classification' })], limits: limits() }
  const future = await bridge.list(listArgs())
  if (!future.ok) assert.fail('a future frameError must not drop the record')
  assert.equal(future.records.length, 1)
  assert.equal('frameError' in future.records[0], false)
})

test('request projects the main-composed frameUrl and drops a malformed one', async () => {
  const state = mutableHost()
  const { bridge } = installedBridge(state.host)
  state.next = { ok: true, record: wireRecord(), frameUrl: 'http://127.0.0.2:41000/app?x=1' }
  const attached = await bridge.request({ ...listArgs(), port: 5173 })
  if (!attached.ok) assert.fail('the attach must translate')
  assert.equal(attached.frameUrl, 'http://127.0.0.2:41000/app?x=1')
  assert.equal(parseForwardRequestResult(attached).ok, true)

  state.next = { ok: true, record: wireRecord(), frameUrl: 'javascript:alert(1)' }
  const malformed = await bridge.request({ ...listArgs(), port: 5173 })
  if (!malformed.ok) assert.fail('the record survives a malformed frameUrl')
  assert.equal(malformed.frameUrl, undefined, 'a malformed frameUrl never enters the launcher')
  assert.deepEqual(parseForwardRequestResult(malformed), malformed)
})

test('v2 W-15: the local identity crosses the bridge verbatim (payload keys unchanged)', async () => {
  const calls: Array<{ method: string; input: unknown }> = []
  const host = {
    request: async () => ({ ok: true }),
    release: async () => ({ ok: true }),
    list: async (input: unknown) => {
      calls.push({ method: 'list', input })
      return { ok: true, records: [] }
    },
    openInBrowser: async () => ({ ok: true }),
  }
  const { bridge } = installedBridge(host)
  await bridge.list({ sourceId: 'local', sourceFingerprint: 'local' })
  assert.deepEqual(calls, [{ method: 'list', input: { sourceId: 'local', sourceFingerprint: 'local' } }])
  // The wire keeps the local list arm; the v2 list paper fields are retired with
  // the iframe carrier and the wire (design 28 v3 §3), so neither source may
  // reintroduce them.
  assert.ok(WIRE_SOURCE.includes('FORWARD_LOCAL_SOURCE_ID'))
  assert.equal(WIRE_SOURCE.includes('readonly frameErrors?:'), false)
  assert.equal(ADAPTER_SOURCE.includes('LauncherForwardFrameErrorEntry'), false)
})

test('the renderer-minted consumer and relative path cross the bridge verbatim', async () => {
  const calls: { method: string; input: unknown }[] = []
  const host = {
    request: async (input: unknown) => {
      calls.push({ method: 'request', input })
      return { ok: true, record: wireRecord(), frameUrl: 'http://127.0.0.2:41000/' }
    },
    release: async (input: unknown) => {
      calls.push({ method: 'release', input })
      return { ok: true }
    },
    list: async () => ({ ok: true, records: [] }),
    openInBrowser: async () => ({ ok: true }),
  }
  const { bridge } = installedBridge(host)
  const args = { sourceId: 'dsh-alpha', sourceFingerprint: 'a'.repeat(64) }
  await bridge.request({ ...args, port: 5173, scheme: 'http', consumer: 'consumer-0001', path: '/app?x=1' })
  await bridge.release({ ...args, id: 'fwd-0123456789abcdef', consumer: 'consumer-0001' })
  assert.deepEqual(calls[0], {
    method: 'request',
    input: { ...args, port: 5173, scheme: 'http', consumer: 'consumer-0001', path: '/app?x=1' },
  })
  assert.deepEqual(calls[1], {
    method: 'release',
    input: { ...args, id: 'fwd-0123456789abcdef', consumer: 'consumer-0001' },
  })
})

// ── Composite wiring ─────────────────────────────────────────────────────────

test('the composite installs the forward and browser adapters BEFORE the deferred roster mounts', () => {
  assert.match(ENTRY_SOURCE, /import \{[^}]*\binstallChamberForward\b[^}]*\} from '\.\/chamber-forward-adapter\.ts'/u)
  const installAt = ENTRY_SOURCE.indexOf('installChamberForward(ctx)')
  const browserAt = ENTRY_SOURCE.indexOf('installChamberBrowser(ctx)')
  const deferredAt = ENTRY_SOURCE.indexOf('void registerDeferred(')
  assert.ok(installAt > 0, 'chamber-entry must install the forward adapter')
  assert.ok(browserAt > 0, 'chamber-entry must install the browser guest adapter')
  assert.ok(deferredAt > installAt && deferredAt > browserAt, 'both services must exist before any deferred chunk mounts')
})

test('⑧ the adapter browser invoke probe is locked to the launcher invoke single source', () => {
  // The adapter cannot import the launcher at runtime (deferred chunk + the
  // module's documented runtime-import-free property), so the local literal is
  // pinned to the launcher's exported constant instead of drifting silently.
  // The launcher's full six-name face is REQUIRED_BROWSER_INVOKES + the
  // documented optional sixth 'keymap' (BrowserBridge.ts:187); the adapter
  // requires it because the shipped v3 Swift shim always exposes it.
  const match = /const BROWSER_INVOKES = \[([^\]]*)\] as const/u.exec(ADAPTER_SOURCE)
  assert.ok(match !== null, 'the adapter browser invoke list moved; re-read the adapter')
  const adapterList = match[1]
    .split(',')
    .map(item => item.trim().replace(/^['"]|['"]$/gu, ''))
    .filter(Boolean)
  assert.deepEqual(adapterList, [...REQUIRED_BROWSER_INVOKES, 'keymap'],
    'the adapter probe must equal the launcher single source (five required + keymap)')
})

test('the browser package is a deferred covered row (the launcher half, never the root apply)', () => {
  assert.match(
    ENTRY_SOURCE,
    /\['@dsh-chamber\/dsh-chamber-client-ui-browser', \(\) => import\('@dsh-chamber\/dsh-chamber-client-ui-browser\/client'\)\]/u,
  )
  assert.doesNotMatch(ENTRY_SOURCE, /import \* as .*dsh-chamber-client-ui-browser/u,
    'the package must stay a deferred chunk (no static namespace import)')
})
// ── E2d: effective keymap enumeration for the shell KeyboardBridge ────────────

test('shortcut combos map the catalog + fixed catalog with platform primary', async () => {
  const { shortcutCombo, shortcutCombosFromSnapshots } = await import('../../src/chamber-forward-adapter.ts')
  // macOS: Command is primary, literal Control stays separate.
  assert.deepEqual(shortcutCombo({ code: 'KeyT', modifiers: ['meta'] }, 'macos'),
    { code: 'KeyT', primary: true, alt: false, shift: false, control: false })
  assert.deepEqual(shortcutCombo({ code: 'KeyK', modifiers: ['meta', 'shift', 'control'] }, 'macos'),
    { code: 'KeyK', primary: true, alt: false, shift: true, control: true })
  // Other platforms: Control is primary.
  assert.deepEqual(shortcutCombo({ code: 'KeyT', modifiers: ['control'] }, 'windows'),
    { code: 'KeyT', primary: true, alt: false, shift: false, control: false })
  assert.equal(shortcutCombo({ modifiers: ['meta'] }, 'macos'), null)

  const shortcuts = {
    platform: 'macos',
    catalog: { getSnapshot: () => [
      { id: 'browser.new', binding: { code: 'KeyT', modifiers: ['meta'] } },
      // config override is already folded into the catalog by the registry.
      { id: 'sidebar.toggle', binding: { code: 'KeyB', modifiers: ['meta', 'alt'] } },
      { id: 'unbound', binding: null },
    ] },
    config: { getSnapshot: () => ({ status: 'ready' }), subscribe: () => () => {} },
    fixedCatalog: { getSnapshot: () => [
      { id: 'shortcuts.stop', bindings: [{ code: 'Escape', modifiers: [] }] },
    ] },
  }
  assert.deepEqual(shortcutCombosFromSnapshots(shortcuts), [
    { code: 'KeyT', primary: true, alt: false, shift: false, control: false },
    { code: 'KeyB', primary: true, alt: true, shift: false, control: false },
    { code: 'Escape', primary: false, alt: false, shift: false, control: false },
  ])
  // Unreadable snapshots are fail-safe (empty, never a thrown install).
  assert.deepEqual(shortcutCombosFromSnapshots({ platform: 'macos', catalog: { getSnapshot: () => { throw new Error('x') } } }), [])
  assert.deepEqual(shortcutCombosFromSnapshots({}), [])
})

function fakeBrowserSurface() {
  const listeners: Record<string, ((value: unknown) => void) | undefined> = {}
  const noop = async () => ({ ok: true })
  return {
    listeners,
    surface: {
      acquire: noop, release: noop, navigate: noop, command: noop, frame: noop, keymap: noop,
      events: {
        state: (fn: (value: unknown) => void) => { listeners.state = fn; return () => {} },
        openRequested: (fn: (value: unknown) => void) => { listeners.openRequested = fn; return () => {} },
        input: (fn: (value: unknown) => void) => { listeners.input = fn; return () => {} },
        forwardNeeded: (fn: (value: unknown) => void) => { listeners.forwardNeeded = fn; return () => {} },
      },
    },
  }
}

function installBrowserOverFakePage() {
  const fake = fakeBrowserSurface()
  const dispatched: KeyboardEvent[] = []
  const element = { dispatchEvent: (event: KeyboardEvent) => { dispatched.push(event); return true } }
  const page = { dshChamber: { browser: fake.surface }, document: { querySelector: () => element } }
  const provided: unknown[] = []
  const installed = installChamberBrowser({ provide: (_name: string, value: unknown) => { provided.push(value) }, get: () => undefined }, page)
  return { installed, listeners: fake.listeners, dispatched }
}

class FakeKeyboardEvent {
  readonly type: string
  readonly init: Record<string, unknown>
  constructor(type: string, init: Record<string, unknown>) { this.type = type; this.init = init }
}

function withFakeKeyboardEvent(run: () => void): void {
  const original = (globalThis as { KeyboardEvent?: unknown }).KeyboardEvent
  ;(globalThis as { KeyboardEvent?: unknown }).KeyboardEvent = FakeKeyboardEvent
  try { run() } finally { ;(globalThis as { KeyboardEvent?: unknown }).KeyboardEvent = original }
}

test('guest key replay uses the canonical modifier array (input contract)', () => {
  const { installed, listeners, dispatched } = installBrowserOverFakePage()
  assert.equal(installed, true, 'a six-invoke + four-push surface must install')
  withFakeKeyboardEvent(() => {
    listeners.input?.({ tabId: 'tab-1', code: 'KeyT', modifiers: ['meta', 'shift'] })
  })
  assert.equal(dispatched.length, 1)
  const init = (dispatched[0] as unknown as { init: Record<string, unknown> }).init
  assert.equal(init.metaKey, true)
  assert.equal(init.shiftKey, true)
  assert.equal(init.ctrlKey, false)
})

test('guest key replay accepts the legacy boolean shape (primary maps to the primary modifier)', () => {
  const { listeners, dispatched } = installBrowserOverFakePage()
  withFakeKeyboardEvent(() => {
    listeners.input?.({ tabId: 'tab-1', code: 'KeyW', primary: true, alt: true, repeat: true })
  })
  const init = (dispatched[0] as unknown as { init: Record<string, unknown> }).init
  assert.equal(init.metaKey, true)
  assert.equal(init.altKey, true)
  assert.equal(init.repeat, true, 'repeat survives both shapes')
})

test('guest key replay prefers the canonical array over legacy booleans', () => {
  const { listeners, dispatched } = installBrowserOverFakePage()
  withFakeKeyboardEvent(() => {
    listeners.input?.({ tabId: 'tab-1', code: 'KeyB', modifiers: ['alt'], primary: true, shift: true })
  })
  const init = (dispatched[0] as unknown as { init: Record<string, unknown> }).init
  assert.equal(init.altKey, true)
  assert.equal(init.metaKey, false, 'canonical array wins; legacy primary is ignored')
  assert.equal(init.shiftKey, false, 'legacy shift is ignored too')
})

test('guest key replay ignores unknown or mis-cased modifier tokens', () => {
  const { listeners, dispatched } = installBrowserOverFakePage()
  withFakeKeyboardEvent(() => {
    listeners.input?.({ tabId: 'tab-1', code: 'KeyX', modifiers: ['Control', 'meta', 'bogus'] })
  })
  const init = (dispatched[0] as unknown as { init: Record<string, unknown> }).init
  assert.equal(init.ctrlKey, false, 'mis-cased control is not the canonical token')
  assert.equal(init.metaKey, true)
})
