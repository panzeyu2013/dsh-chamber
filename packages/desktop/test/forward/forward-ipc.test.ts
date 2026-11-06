/**
 * Remote-browser forward IPC registrar tests (design 28 §7; W0/S1 IPC slice).
 *
 * The registrar (shell-ipc-browser.ts) is the boundary between an untrusted
 * renderer payload and the ForwardManager. What is pinned here:
 *   - the four registered channels, their wire names, and ZERO push channels
 *     ('forward:changed' stays reserved: v1 polls list());
 *   - the full rejection matrix (no source, local, dsh+http, malformed
 *     fingerprint, impossible ports, unknown scheme) — none of these may reach
 *     the manager;
 *   - the frozen argument table per method (one input object, explicit keys);
 *   - the four-step source proof, including the post-await re-proof
 *     (source_changed) and the record-ownership re-check (forward_not_owned);
 *   - the not-assembled state: channels stay registered and answer a typed
 *     forward_failed refusal instead of disappearing from the bridge surface.
 *
 * The manager's own behavior (caps, state machine, budget) is covered by
 * forward-manager.test.ts; this suite owns the IPC layer only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { IPC_CHANNELS } from '../../ipc-events.ts'
import type {
  ForwardListArgs,
  ForwardReleaseArgs,
  ForwardRequestArgs,
} from '../../remote-forward-manager.ts'
import {
  FakeForwardService,
  FINGERPRINT,
  FORWARD_ID,
  ForwardIpcHarness,
  SOURCE_ID,
  makeRecord,
} from './forward-ipc-fixture.ts'
import { isForwardListResult } from '../../../dsh-chamber-wire/src/forward.ts'

const CHANNEL = {
  request: IPC_CHANNELS.FORWARD_REQUEST,
  release: IPC_CHANNELS.FORWARD_RELEASE,
  list: IPC_CHANNELS.FORWARD_LIST,
  open: IPC_CHANNELS.FORWARD_OPEN_IN_BROWSER,
} as const

function requestPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, port: 5173, scheme: 'http', ...overrides }
}

function releasePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id: FORWARD_ID, ...overrides }
}

function listPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, ...overrides }
}

function refusal(code: string): Record<string, unknown> {
  return { ok: false, error: { code, detail: null } }
}

test('registers exactly the four forward invoke channels (names, count, zero push)', () => {
  const harness = new ForwardIpcHarness()
  harness.install(new FakeForwardService())
  assert.deepEqual([...harness.handlers.keys()].sort(), [
    'dsh-chamber:forward-list',
    'dsh-chamber:forward-open-in-browser',
    'dsh-chamber:forward-release',
    'dsh-chamber:forward-request',
  ])
  // The wire's reserved push name must never be registered in v1 (D6 poll-only).
  assert.equal(harness.handlers.has('forward:changed'), false)
  assert.equal(harness.handlers.size, 4)
})

test('request relays the frozen argument table and returns the manager result verbatim', async () => {
  const harness = new ForwardIpcHarness()
  const service = new FakeForwardService()
  harness.install(service)

  const result = await harness.invoke(CHANNEL.request, requestPayload())
  assert.deepEqual(result, service.requestResult)
  assert.deepEqual(service.calls, [{
    method: 'request',
    args: { sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, port: 5173, scheme: 'http' },
  }])

  // https is passed through, never downgraded (design 28 D10).
  await harness.invoke(CHANNEL.request, requestPayload({ port: 8443, scheme: 'https' }))
  assert.deepEqual((service.calls[1]?.args as ForwardRequestArgs).scheme, 'https')
  assert.equal((service.calls[1]?.args as ForwardRequestArgs).port, 8443)
})

test('an omitted scheme defaults to http at the boundary (one spelling for both flavors)', async () => {
  const harness = new ForwardIpcHarness()
  const service = new FakeForwardService()
  harness.install(service)
  await harness.invoke(CHANNEL.request, requestPayload({ scheme: undefined }))
  assert.deepEqual(service.calls[0]?.args, {
    sourceId: SOURCE_ID,
    sourceFingerprint: FINGERPRINT,
    port: 5173,
    scheme: 'http',
  })
})

const REJECTIONS: Array<[name: string, payload: unknown, code: string]> = [
  ['null payload', null, 'source_unknown'],
  ['array payload', [], 'source_unknown'],
  ['string payload', 'dsh-chamber:forward-request', 'source_unknown'],
  ['local source', requestPayload({ sourceId: 'local', sourceFingerprint: 'local' }), 'source_unknown'],
  ['bare registry id', requestPayload({ sourceId: 'web-1' }), 'source_unknown'],
  ['unknown source', requestPayload({ sourceId: 'dsh-missing' }), 'source_unknown'],
  ['legacy ssh prefix without incarnation', requestPayload({ sourceId: 'ssh-web-1' }), 'source_unknown'],
  ['short fingerprint', requestPayload({ sourceFingerprint: 'abc' }), 'source_unknown'],
  ['rotated fingerprint', requestPayload({ sourceFingerprint: 'b'.repeat(64) }), 'source_unknown'],
  ['non-string fingerprint', requestPayload({ sourceFingerprint: 42 }), 'source_unknown'],
  ['port 0', requestPayload({ port: 0 }), 'target_port_invalid'],
  ['port 65536', requestPayload({ port: 65536 }), 'target_port_invalid'],
  ['fractional port', requestPayload({ port: 1.5 }), 'target_port_invalid'],
  ['string port', requestPayload({ port: '5173' }), 'target_port_invalid'],
  ['missing port', requestPayload({ port: undefined }), 'target_port_invalid'],
  ['unknown scheme', requestPayload({ scheme: 'ftp' }), 'scheme_invalid'],
  ['non-string scheme', requestPayload({ scheme: 1 }), 'scheme_invalid'],
]

test('the rejection matrix never reaches the manager (design 28 §7)', async () => {
  for (const [name, payload, code] of REJECTIONS) {
    const harness = new ForwardIpcHarness()
    const service = new FakeForwardService()
    harness.install(service)
    assert.deepEqual(await harness.invoke(CHANNEL.request, payload), refusal(code), name)
    assert.deepEqual(service.calls, [], name + ': the manager must not be called')
  }
})

test('a gateway ssh source passes the source proof like a dsh source', async () => {
  const gateway = new ForwardIpcHarness()
  gateway.instances = [{ id: 'gw-1', kind: 'gateway', transport: 'ssh' }]
  gateway.addSource('gateway-gw-1', FINGERPRINT)
  const gatewayService = new FakeForwardService()
  gatewayService.requestResult = { ok: true, record: makeRecord({ sourceId: 'gateway-gw-1' }) }
  gateway.install(gatewayService)
  const result = await gateway.invoke(CHANNEL.request, requestPayload({ sourceId: 'gateway-gw-1' }))
  assert.deepEqual(result, gatewayService.requestResult)
  assert.deepEqual(gatewayService.calls, [{
    method: 'request',
    args: { sourceId: 'gateway-gw-1', sourceFingerprint: FINGERPRINT, port: 5173, scheme: 'http' },
  }])
})

test('a dsh http source is refused with the wire gate code', async () => {
  const http = new ForwardIpcHarness()
  http.instances = [{ id: 'web-2', kind: 'dsh', transport: 'http' }]
  http.addSource('dsh-web-2', FINGERPRINT)
  const httpService = new FakeForwardService()
  http.install(httpService)
  assert.deepEqual(
    await http.invoke(CHANNEL.request, requestPayload({ sourceId: 'dsh-web-2' })),
    refusal('transport_not_ssh'),
  )
  assert.deepEqual(httpService.calls, [])
})

test('a record minted for another source never crosses the IPC boundary', async () => {
  const harness = new ForwardIpcHarness()
  const service = new FakeForwardService()
  service.requestResult = { ok: true, record: makeRecord({ sourceId: 'dsh-other' }) }
  harness.install(service)
  assert.deepEqual(await harness.invoke(CHANNEL.request, requestPayload()), refusal('forward_not_owned'))

  service.requestResult = { ok: true, record: makeRecord({ sourceId: SOURCE_ID }) }
  assert.deepEqual(await harness.invoke(CHANNEL.request, requestPayload()),
    { ok: true, record: makeRecord({ sourceId: SOURCE_ID }) })
})

test('the source is re-proved across the await boundary (source_changed)', async () => {
  const harness = new ForwardIpcHarness()
  const service = new FakeForwardService()
  service.beforeResolve = () => harness.retire(SOURCE_ID)
  harness.install(service)
  assert.deepEqual(await harness.invoke(CHANNEL.request, requestPayload()), refusal('source_changed'))
  assert.equal(service.calls.length, 1, 'the manager may only be entered after a successful proof')
})

test('a v2 consumer claim is released when the source proof changes after the request', async () => {
  const harness = new ForwardIpcHarness()
  const service = new FakeForwardService()
  service.beforeResolve = () => harness.retire(SOURCE_ID)
  harness.install(service)
  const consumer = 'consumer-0123456789'
  assert.deepEqual(
    await harness.invoke(CHANNEL.request, requestPayload({ consumer })),
    refusal('source_changed'),
  )
  const releaseCall = service.calls.find(call => call.method === 'release')
  assert.ok(releaseCall, 'the orphan consumer claim must be released')
  assert.deepEqual(releaseCall.args, {
    sourceId: SOURCE_ID,
    sourceFingerprint: FINGERPRINT,
    id: FORWARD_ID,
    consumer,
  })
})

test('release: invalid ids are refused, foreign failures are relayed unchanged', async () => {
  const harness = new ForwardIpcHarness()
  const service = new FakeForwardService()
  harness.install(service)
  assert.deepEqual(await harness.invoke(CHANNEL.release, releasePayload({ id: 'nope' })),
    refusal('forward_not_found'))
  assert.deepEqual(await harness.invoke(CHANNEL.release, releasePayload({ id: 42 })),
    refusal('forward_not_found'))
  assert.deepEqual(service.calls, [])

  service.releaseResult = { ok: false, error: { code: 'forward_not_found', detail: null } }
  assert.deepEqual(await harness.invoke(CHANNEL.release, releasePayload()),
    { ok: false, error: { code: 'forward_not_found', detail: null } })
  const releaseCall = service.calls[0] as { args: ForwardReleaseArgs } | undefined
  assert.ok(releaseCall)
  assert.deepEqual(releaseCall.args.id, FORWARD_ID)
})

test('list: the snapshot relays verbatim and a foreign record is refused', async () => {
  const harness = new ForwardIpcHarness()
  const service = new FakeForwardService()
  harness.install(service)

  assert.deepEqual(await harness.invoke(CHANNEL.list, listPayload()), service.listResult)
  assert.deepEqual((service.calls[0]?.args as ForwardListArgs), {
    sourceId: SOURCE_ID,
    sourceFingerprint: FINGERPRINT,
  })

  service.listResult = {
    ok: true,
    records: [makeRecord({ sourceId: 'dsh-other' })],
    limits: { perSource: 8, global: 32, perSourceUsed: 1, globalUsed: 1 },
  }
  assert.deepEqual(await harness.invoke(CHANNEL.list, listPayload()), refusal('forward_not_owned'))

  service.listResult = { ok: false, error: { code: 'source_unknown', detail: null } }
  assert.deepEqual(await harness.invoke(CHANNEL.list, listPayload()),
    { ok: false, error: { code: 'source_unknown', detail: null } })
})

test('openInBrowser relays only the id plus the normalized path (never a URL)', async () => {
  const harness = new ForwardIpcHarness()
  const service = new FakeForwardService()
  harness.install(service)
  assert.deepEqual(await harness.invoke(CHANNEL.open, {
    sourceId: SOURCE_ID,
    sourceFingerprint: FINGERPRINT,
    id: FORWARD_ID,
    path: '/app?x=1',
  }), { ok: true })
  assert.deepEqual(service.calls, [{
    method: 'openInBrowser',
    args: { sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id: FORWARD_ID, path: '/app?x=1' },
  }])
})

test('an unassembled service keeps all four channels live and refuses honestly', async () => {
  const harness = new ForwardIpcHarness()
  harness.install(null)
  assert.equal(harness.handlers.size, 4)
  for (const channel of [CHANNEL.request, CHANNEL.release, CHANNEL.list, CHANNEL.open]) {
    assert.deepEqual(await harness.invoke(channel, {
      sourceId: SOURCE_ID,
      sourceFingerprint: FINGERPRINT,
      port: 5173,
      id: FORWARD_ID,
    }), {
      ok: false,
      error: { code: 'forward_failed', detail: 'forward ipc service is not assembled' },
    })
  }
})

test('the registered handlers are async (the IPC fence awaits every reply)', () => {
  const harness = new ForwardIpcHarness()
  harness.install(new FakeForwardService())
  for (const handler of harness.handlers.values()) {
    const pending = handler({})
    assert.ok(pending instanceof Promise, 'a non-async handler would resolve before the await-boundary proof')
    pending.catch(() => {})
  }
})

test('v2: request relays the consumer and the main-normalized path (frameUrl comes back verbatim)', async () => {
  const harness = new ForwardIpcHarness()
  const service = new FakeForwardService()
  service.requestResult = {
    ok: true,
    record: makeRecord(),
    frameUrl: 'http://127.0.0.7:5173/app?x=1',
  }
  harness.install(service)
  const CONSUMER = 'consumer-aaaaaaa1'
  const result = await harness.invoke(CHANNEL.request, requestPayload({
    consumer: CONSUMER,
    path: '/app?x=1#frag',
  }))
  assert.deepEqual(result, service.requestResult)
  assert.deepEqual(service.calls, [{
    method: 'request',
    args: {
      sourceId: SOURCE_ID,
      sourceFingerprint: FINGERPRINT,
      port: 5173,
      scheme: 'http',
      consumer: CONSUMER,
      path: '/app?x=1',
    },
  }])
})

test('v2: a malformed consumer or path never reaches the manager', async () => {
  for (const [payload, code] of [
    [requestPayload({ consumer: 'short' }), 'forward_not_owned'],
    [requestPayload({ consumer: 'has space' }), 'forward_not_owned'],
    [requestPayload({ path: 'http://evil.example/app' }), 'invalid_path'],
    [requestPayload({ path: '//evil.example' }), 'invalid_path'],
    [requestPayload({ path: '/a\u0000b' }), 'invalid_path'],
  ] as const) {
    const harness = new ForwardIpcHarness()
    const service = new FakeForwardService()
    harness.install(service)
    assert.deepEqual(await harness.invoke(CHANNEL.request, payload), refusal(code), JSON.stringify(payload))
    assert.deepEqual(service.calls, [])
  }
})

test('v2: release relays the consumer (detach) and refuses a malformed one', async () => {
  const harness = new ForwardIpcHarness()
  const service = new FakeForwardService()
  harness.install(service)
  const CONSUMER = 'consumer-bbbbbbb2'
  assert.deepEqual(await harness.invoke(CHANNEL.release, releasePayload({ consumer: CONSUMER })), { ok: true })
  assert.deepEqual(service.calls, [{
    method: 'release',
    args: { sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id: FORWARD_ID, consumer: CONSUMER },
  }])

  const bad = new ForwardIpcHarness()
  const badService = new FakeForwardService()
  bad.install(badService)
  assert.deepEqual(
    await bad.invoke(CHANNEL.release, releasePayload({ consumer: 'x' })),
    refusal('forward_not_owned'),
  )
  assert.deepEqual(badService.calls, [])
})

test('v2 W-15: the local identity answers list with the bounded frameErrors projection', async () => {
  const harness = new ForwardIpcHarness()
  const service = new FakeForwardService()
  // Local list must not enter the manager: the local leg owns no forward record.
  harness.install(service, {
    frameErrors: () => [
      { origin: 'http://127.0.0.1:44215', code: 'blocked_by_response' },
      { origin: 'https://localhost:8443', code: 'certificate_error' },
    ],
    embedding: () => ({ enabled: true }),
  })
  const result = await harness.invoke(CHANNEL.list, { sourceId: 'local', sourceFingerprint: 'local' })
  assert.deepEqual(result, {
    ok: true,
    records: [],
    limits: { perSource: 8, global: 32, perSourceUsed: 0, globalUsed: 0 },
    embedding: { enabled: true },
    frameErrors: [
      { origin: 'http://127.0.0.1:44215', code: 'blocked_by_response' },
      { origin: 'https://localhost:8443', code: 'certificate_error' },
    ],
  })
  assert.equal(isForwardListResult(result), true, 'the local list answer satisfies the wire guard')
  assert.deepEqual(service.calls, [], 'the local list never calls the forward manager')

  // An empty/bounded store omits the additive array (absent = none).
  const quiet = new ForwardIpcHarness()
  quiet.install(new FakeForwardService(), { frameErrors: () => [] })
  assert.deepEqual(await quiet.invoke(CHANNEL.list, { sourceId: 'local', sourceFingerprint: 'local' }), {
    ok: true,
    records: [],
    limits: { perSource: 8, global: 32, perSourceUsed: 0, globalUsed: 0 },
  })

  // The local identity is exact: any other fingerprint is refused as unknown.
  for (const fingerprint of ['a'.repeat(64), '', 'LOCAL', 42]) {
    assert.deepEqual(
      await harness.invoke(CHANNEL.list, { sourceId: 'local', sourceFingerprint: fingerprint }),
      refusal('source_unknown'),
      String(fingerprint),
    )
  }
})

test('v2: list relays the embedding capability verbatim', async () => {
  const harness = new ForwardIpcHarness()
  const service = new FakeForwardService()
  service.listResult = {
    ok: true,
    records: [makeRecord({ frameError: 'timeout' })],
    limits: { perSource: 8, global: 32, perSourceUsed: 1, globalUsed: 1 },
    embedding: { enabled: false, reason: 'emergency_rollback' },
  }
  harness.install(service)
  assert.deepEqual(await harness.invoke(CHANNEL.list, listPayload()), service.listResult)
})
