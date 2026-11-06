/**
 * Forward-controller unit tests (design 28 §16.5, plan §4.3, L1): the tab
 * occurrence lease — consumer minting/passthrough, attach-first ordering,
 * same-record renew, failed-attach keeps the old page, late-settle release after
 * dispose, and idempotent cleanup. The transport is a fake promise, no DOM/timers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BrowserForwardController,
  mintForwardConsumer,
} from '../../src/shared/browser-controller.ts'
import type { ForwardRequestInput, ForwardReleaseInput } from '../../src/shared/forward-bridge.ts'
import { FORWARD_CONSUMER_PATTERN } from '../../src/shared/forward-bridge.ts'
import { parseBrowserSource } from '../../src/shared/source.ts'

const DSH = parseBrowserSource('dsh-alpha', 'ssh')!
const LOCAL = parseBrowserSource('local', 'local')!
const FINGERPRINT = 'a'.repeat(64)

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fwd-0123456789abcdef',
    remotePort: 5173,
    localPort: 41000,
    scheme: 'http',
    aliasHost: '127.0.0.2',
    state: 'bound',
    stale: false,
    ...overrides,
  }
}

interface FakeTransport {
  requests: ForwardRequestInput[]
  releases: ForwardReleaseInput[]
  order: string[]
  nextRequest: unknown
  nextRelease: unknown
  requestThrows: boolean
  releaseThrows: boolean
  /** When set, request waits for this promise before answering. */
  hold: { promise: Promise<void>; release: () => void } | null
  transport: {
    request(input: ForwardRequestInput): Promise<unknown>
    release(input: ForwardReleaseInput): Promise<unknown>
  }
}

function fakeTransport(): FakeTransport {
  const state: FakeTransport = {
    requests: [],
    releases: [],
    order: [],
    nextRequest: { ok: true, record: record(), frameUrl: 'http://127.0.0.2:41000/' },
    nextRelease: { ok: true },
    requestThrows: false,
    releaseThrows: false,
    hold: null,
    transport: {
      request: async (input) => {
        state.requests.push(input)
        state.order.push('request:' + input.port)
        if (state.hold !== null) await state.hold.promise
        if (state.requestThrows) throw new Error('bridge gone')
        return state.nextRequest
      },
      release: async (input) => {
        state.releases.push(input)
        state.order.push('release:' + input.id)
        if (state.releaseThrows) throw new Error('bridge gone')
        return state.nextRelease
      },
    },
  }
  return state
}

function controller(
  fake: FakeTransport,
  overrides: { source?: typeof DSH; transport?: FakeTransport['transport'] | null; mintConsumer?: () => string } = {},
): BrowserForwardController {
  return new BrowserForwardController({
    source: overrides.source ?? DSH,
    sourceFingerprint: FINGERPRINT,
    transport: overrides.transport === undefined ? fake.transport : overrides.transport,
    ...(overrides.mintConsumer === undefined ? {} : { mintConsumer: overrides.mintConsumer }),
  })
}

const ATTACH = { port: 5173, scheme: 'http' as const, path: '/app?x=1' }

test('the minted consumer matches the wire grammar', () => {
  const first = mintForwardConsumer()
  const second = mintForwardConsumer()
  assert.match(first, FORWARD_CONSUMER_PATTERN)
  assert.match(second, FORWARD_CONSUMER_PATTERN)
  assert.notEqual(first, second)
})

test('attach sends the consumer + path and exposes the bound record + frameUrl', async () => {
  const fake = fakeTransport()
  const lease = controller(fake, { mintConsumer: () => 'test-consumer-0001' })
  const outcome = await lease.attach(ATTACH)
  assert.equal(outcome.ok, true)
  if (!outcome.ok) assert.fail('attach must succeed')
  assert.equal(outcome.frameUrl, 'http://127.0.0.2:41000/')
  assert.equal(outcome.record.remotePort, 5173)
  assert.deepEqual(fake.requests, [{
    sourceId: 'dsh-alpha',
    sourceFingerprint: FINGERPRINT,
    port: 5173,
    scheme: 'http',
    consumer: 'test-consumer-0001',
    path: '/app?x=1',
  }])
  assert.deepEqual(lease.attachedRecordIds, ['fwd-0123456789abcdef'])
  assert.equal(lease.currentRecordId, 'fwd-0123456789abcdef')
  assert.deepEqual(fake.releases, [])
})

test('attach-first: the new record is requested BEFORE the old one is detached', async () => {
  const fake = fakeTransport()
  const lease = controller(fake)
  await lease.attach(ATTACH)
  fake.nextRequest = {
    ok: true,
    record: record({ id: 'fwd-aaaaaaaaaaaaaaaa', targetPort: 8080, remotePort: 8080, localPort: 41001 }),
    frameUrl: 'http://127.0.0.2:41001/',
  }
  const outcome = await lease.attach({ port: 8080, scheme: 'http', path: '/' })
  assert.equal(outcome.ok, true)
  assert.deepEqual(fake.order, [
    'request:5173',
    'request:8080',
    'release:fwd-0123456789abcdef',
  ])
  assert.equal(fake.releases[0].consumer, lease.consumer)
  assert.deepEqual(lease.attachedRecordIds, ['fwd-aaaaaaaaaaaaaaaa'])
  assert.equal(lease.currentRecordId, 'fwd-aaaaaaaaaaaaaaaa')
})

test('a failed request keeps the old page and detaches nothing', async () => {
  const fake = fakeTransport()
  const lease = controller(fake)
  await lease.attach(ATTACH)
  fake.nextRequest = { ok: false, code: 'limit' }
  const outcome = await lease.attach({ port: 8080, scheme: 'http', path: '/' })
  assert.deepEqual(outcome, { ok: false, code: 'limit' })
  assert.equal(lease.currentRecordId, 'fwd-0123456789abcdef', 'the old lease is untouched')
  assert.deepEqual(fake.releases, [])
})

test('a same-record attach renews without detaching (idempotent)', async () => {
  const fake = fakeTransport()
  const lease = controller(fake)
  await lease.attach(ATTACH)
  const outcome = await lease.attach({ port: 5173, scheme: 'http', path: '/other' })
  assert.equal(outcome.ok, true)
  assert.equal(fake.releases.length, 0)
  assert.equal(fake.requests.length, 2)
  assert.equal(fake.requests[1].path, '/other')
})

test('a record that never bound is released immediately and the old page stays', async () => {
  const fake = fakeTransport()
  const lease = controller(fake)
  await lease.attach(ATTACH)
  fake.nextRequest = {
    ok: true,
    record: record({ id: 'fwd-bbbbbbbbbbbbbbbb', state: 'error', error: 'spawn-failed' }),
  }
  const outcome = await lease.attach({ port: 8080, scheme: 'http', path: '/' })
  assert.deepEqual(outcome, { ok: false, code: 'spawn-failed' })
  assert.deepEqual(fake.releases.map((entry) => entry.id), ['fwd-bbbbbbbbbbbbbbbb'])
  assert.equal(fake.releases[0].consumer, lease.consumer)
  assert.equal(lease.currentRecordId, 'fwd-0123456789abcdef')
})

test('a bound record without a composed frameUrl is a failed attach', async () => {
  const fake = fakeTransport()
  const lease = controller(fake)
  fake.nextRequest = { ok: true, record: record({ id: 'fwd-cccccccccccccccc' }) }
  const outcome = await lease.attach(ATTACH)
  assert.deepEqual(outcome, { ok: false, code: 'unknown' })
  assert.deepEqual(fake.releases.map((entry) => entry.id), ['fwd-cccccccccccccccc'])
  assert.equal(lease.currentRecordId, null)
})

test('dispose releases every claim once and is idempotent', async () => {
  const fake = fakeTransport()
  const lease = controller(fake)
  await lease.attach(ATTACH)
  await lease.dispose()
  await lease.dispose()
  assert.equal(fake.releases.length, 1)
  assert.equal(fake.releases[0].consumer, lease.consumer)
  assert.deepEqual(lease.attachedRecordIds, [])
  assert.equal(lease.isDisposed, true)
  assert.deepEqual(await lease.attach({ port: 6000, scheme: 'http', path: '/' }), { ok: false, code: 'aborted' })
})

test('a request that settles AFTER dispose is released immediately (late-settle guard)', async () => {
  const fake = fakeTransport()
  let releaseHold: () => void = () => {}
  fake.hold = { promise: new Promise((resolve) => { releaseHold = () => resolve() }), release: () => {} }
  const lease = controller(fake)
  const pending = lease.attach(ATTACH)
  await lease.dispose()
  releaseHold()
  const outcome = await pending
  assert.deepEqual(outcome, { ok: false, code: 'aborted' })
  assert.equal(lease.isDisposed, true)
  assert.deepEqual(fake.releases.map((entry) => entry.id), ['fwd-0123456789abcdef'])
  assert.equal(fake.releases[0].consumer, lease.consumer)
})

test('detachCurrent releases only this consumer and clears the current page', async () => {
  const fake = fakeTransport()
  const lease = controller(fake)
  await lease.attach(ATTACH)
  assert.equal(await lease.detachCurrent(), null)
  assert.equal(lease.currentRecordId, null)
  assert.equal(await lease.detachCurrent(), null, 'a second detach is a no-op')
  assert.equal(fake.releases.length, 1)
  assert.equal(fake.releases[0].consumer, lease.consumer)
})

test('a dead transport maps to unavailable on both calls; a non-ssh source is refused', async () => {
  const fake = fakeTransport()
  fake.requestThrows = true
  fake.releaseThrows = true
  const lease = controller(fake)
  assert.deepEqual(await lease.attach(ATTACH), { ok: false, code: 'unavailable' })

  fake.requestThrows = false
  const second = controller(fake)
  await second.attach(ATTACH)
  fake.releaseThrows = true
  assert.equal(await second.detachCurrent(), 'unavailable')

  const local = controller(fake, { source: LOCAL })
  assert.deepEqual(await local.attach(ATTACH), { ok: false, code: 'forbidden-source' })
  const noCarrier = controller(fake, { transport: null })
  assert.deepEqual(await noCarrier.attach(ATTACH), { ok: false, code: 'unavailable' })
})

test('the consumer minting seam is used and an invalid id fails closed', () => {
  const fake = fakeTransport()
  assert.equal(controller(fake, { mintConsumer: () => 'valid-consumer-01' }).consumer, 'valid-consumer-01')
  assert.throws(() => controller(fake, { mintConsumer: () => 'short' }), RangeError)
})
