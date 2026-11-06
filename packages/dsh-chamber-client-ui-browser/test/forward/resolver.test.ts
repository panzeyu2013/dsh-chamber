/**
 * ForwardFrameResolver — the ONLY behavior fork diff from upstream: mapping a
 * logical Browser target onto the exact iframe src.
 *
 * Local/direct targets keep upstream's `target.url`. An SSH source's remote
 * `127.0.0.1` target attaches the existing per-tab SSH forward lease
 * (`BrowserForwardController` + `forward-bridge.ts`) and returns main's composed
 * frameUrl; the displayed target never changes. Leaving the forwarded target or
 * disposing the page releases the consumer, and an attach failure yields
 * `undefined` so the upstream BrowserFrameState.error bar shows.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ForwardFrameResolver,
  createForwardFrameResolver,
} from '../../src/client/browser/ForwardFrameResolver.ts'
import type { BrowserTarget } from '../../src/client/browser/url.ts'
import type { BrowserForwardBridge } from '../../src/shared/forward-bridge.ts'
import { FORWARD_CONSUMER_PATTERN } from '../../src/shared/forward-bridge.ts'
import { parseBrowserSource } from '../../src/shared/source.ts'

const FINGERPRINT = 'a'.repeat(64)
const DSH = parseBrowserSource('dsh-alpha', 'ssh')!
const LOCAL = parseBrowserSource('local', 'local')!

function target(url: string): BrowserTarget {
  const kind = url.startsWith('https:') ? 'https' as const : 'http' as const
  return { kind, url, title: new URL(url).hostname }
}

interface FakeBridge {
  requests: Record<string, unknown>[]
  releases: Record<string, unknown>[]
  order: string[]
  /** Queued responses consumed in order (concurrent-resolve tests). */
  responses: unknown[]
  nextRequest: unknown
  nextRelease: unknown
  bridge: BrowserForwardBridge
}

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

function fakeBridge(): FakeBridge {
  const state: FakeBridge = {
    requests: [],
    releases: [],
    order: [],
    responses: [],
    nextRequest: { ok: true, record: record(), frameUrl: 'http://127.0.0.2:41000/' },
    nextRelease: { ok: true },
    bridge: {
      request: async (input) => {
        state.requests.push(input as unknown as Record<string, unknown>)
        state.order.push('request:' + String((input as { port: number }).port))
        return (state.responses.length === 0 ? state.nextRequest : state.responses.shift()) as never
      },
      release: async (input) => {
        state.releases.push(input as unknown as Record<string, unknown>)
        state.order.push('release:' + String((input as { id: string }).id))
        return state.nextRelease as never
      },
      list: async () => ({ ok: true, records: [] }),
      openInBrowser: async () => ({ ok: true }),
    },
  }
  return state
}

function resolver(bridge: BrowserForwardBridge | null, source = DSH): ForwardFrameResolver {
  return createForwardFrameResolver({ source, sourceFingerprint: FINGERPRINT, bridge })
}

test('forwards() marks exactly the SSH remote-loopback leg (the pending-external window)', async () => {
  const fake = fakeBridge()
  const local = resolver(fake.bridge, LOCAL)
  assert.equal(local.forwards(target('http://127.0.0.1:5173/')), false, 'the local instance never forwards')
  const ssh = resolver(fake.bridge)
  assert.equal(ssh.forwards(target('http://127.0.0.1:5173/')), true)
  assert.equal(ssh.forwards(target('https://127.0.0.1:8443/')), true)
  assert.equal(ssh.forwards(target('http://localhost:5173/')), false, 'only the literal 127.0.0.1 forwards')
  assert.equal(ssh.forwards(target('http://127.0.0.2:5173/')), false)
  assert.equal(ssh.forwards(target('https://example.com/')), false)
  const noBridge = resolver(null)
  assert.equal(noBridge.forwards(target('http://127.0.0.1:5173/')), true,
    'without the carrier the logical loopback still must not be offered to the external exit')
  await local.dispose()
  await ssh.dispose()
  await noBridge.dispose()
})

test('the local instance loads the target URL directly and never asks main', async () => {
  const fake = fakeBridge()
  const lease = resolver(fake.bridge, LOCAL)
  assert.equal(await lease.resolve(target('http://127.0.0.1:5173/app')), 'http://127.0.0.1:5173/app')
  assert.equal(await lease.resolve(target('http://localhost:3000/')), 'http://localhost:3000/')
  assert.equal(await lease.resolve(target('https://docs.example/')), 'https://docs.example/')
  assert.equal(fake.requests.length, 0)
  assert.equal(fake.releases.length, 0)
  await lease.dispose()
})

test('an SSH source forwards a remote 127.0.0.1 target and returns main frameUrl', async () => {
  const fake = fakeBridge()
  const lease = resolver(fake.bridge)
  const src = await lease.resolve(target('http://127.0.0.1:5173/app?x=1'))
  assert.equal(src, 'http://127.0.0.2:41000/')
  assert.equal(fake.requests.length, 1)
  const request = fake.requests[0] as Record<string, unknown>
  assert.equal(request.sourceId, 'dsh-alpha')
  assert.equal(request.sourceFingerprint, FINGERPRINT)
  assert.equal(request.port, 5173)
  assert.equal(request.scheme, 'http')
  assert.equal(request.path, '/app?x=1')
  assert.match(String(request.consumer), FORWARD_CONSUMER_PATTERN)
  await lease.dispose()
})

test('https loopback keeps the scheme and the explicit port', async () => {
  const fake = fakeBridge()
  fake.nextRequest = { ok: true, record: record({ scheme: 'https', localPort: 42000 }), frameUrl: 'https://127.0.0.2:42000/app' }
  const lease = resolver(fake.bridge)
  assert.equal(await lease.resolve(target('https://127.0.0.1:8443/app')), 'https://127.0.0.2:42000/app')
  const request = fake.requests[0] as Record<string, unknown>
  assert.equal(request.scheme, 'https')
  assert.equal(request.port, 8443)
  await lease.dispose()
})

test('a non-127 SSH target loads directly and releases a held forward first', async () => {
  const fake = fakeBridge()
  const lease = resolver(fake.bridge)
  await lease.resolve(target('http://127.0.0.1:5173/'))
  assert.equal(fake.requests.length, 1)
  const direct = await lease.resolve(target('http://localhost:3000/'))
  assert.equal(direct, 'http://localhost:3000/')
  assert.equal(fake.releases.length, 1, 'leaving the forwarded target releases its consumer')
  assert.match(String(fake.releases[0].consumer), FORWARD_CONSUMER_PATTERN)
  // A loopback spelling other than the literal 127.0.0.1 stays direct (upstream URL).
  const other = await lease.resolve(target('http://127.0.0.2:8080/'))
  assert.equal(other, 'http://127.0.0.2:8080/')
  assert.equal(fake.requests.length, 1)
  await lease.dispose()
})

test('an attach refusal yields undefined (the upstream failure bar) and keeps no lease', async () => {
  const fake = fakeBridge()
  fake.nextRequest = { ok: false, code: 'limit' }
  const lease = resolver(fake.bridge)
  assert.equal(await lease.resolve(target('http://127.0.0.1:5173/')), undefined)
  assert.equal(fake.releases.length, 0, 'a refused request created no record to release')
  // A direct target afterwards has nothing to detach.
  assert.equal(await lease.resolve(target('https://example.com/')), 'https://example.com/')
  assert.equal(fake.releases.length, 0)
  await lease.dispose()
})

test('a bound record without a composed frameUrl fails and releases the claim', async () => {
  const fake = fakeBridge()
  fake.nextRequest = { ok: true, record: record({ id: 'fwd-aaaaaaaaaaaaaaaa' }) }
  const lease = resolver(fake.bridge)
  assert.equal(await lease.resolve(target('http://127.0.0.1:5173/')), undefined)
  assert.equal(fake.releases.length, 1)
  assert.equal(fake.releases[0].id, 'fwd-aaaaaaaaaaaaaaaa')
  await lease.dispose()
})

test('a page without the forward carrier cannot forward a remote loopback target', async () => {
  const lease = resolver(null)
  assert.equal(await lease.resolve(target('http://127.0.0.1:5173/')), undefined)
  await lease.dispose()
})

test('dispose releases the current consumer once; repeated calls are safe', async () => {
  const fake = fakeBridge()
  const lease = resolver(fake.bridge)
  await lease.resolve(target('http://127.0.0.1:5173/'))
  await lease.dispose()
  await lease.dispose()
  assert.equal(fake.releases.length, 1)
  assert.equal(fake.releases[0].consumer, (fake.requests[0] as Record<string, unknown>).consumer)
})

test('same record renews without a release; a new record is attach-first', async () => {
  const fake = fakeBridge()
  const lease = resolver(fake.bridge)
  await lease.resolve(target('http://127.0.0.1:5173/a'))
  await lease.resolve(target('http://127.0.0.1:5173/b'))
  assert.equal(fake.requests.length, 2)
  assert.equal(fake.releases.length, 0, 'the same record id renews in place')

  fake.nextRequest = {
    ok: true,
    record: record({ id: 'fwd-bbbbbbbbbbbbbbbb', remotePort: 8080, localPort: 41001 }),
    frameUrl: 'http://127.0.0.2:41001/',
  }
  await lease.resolve(target('http://127.0.0.1:8080/'))
  assert.deepEqual(fake.order, [
    'request:5173',
    'request:5173',
    'request:8080',
    'release:fwd-0123456789abcdef',
  ])
  await lease.dispose()
  assert.equal(fake.releases.length, 2)
})

test('concurrent resolves serialize (deterministic attach-first order)', async () => {
  const fake = fakeBridge()
  fake.responses = [
    { ok: true, record: record(), frameUrl: 'http://127.0.0.2:41000/' },
    {
      ok: true,
      record: record({ id: 'fwd-cccccccccccccccc', remotePort: 8080, localPort: 41002 }),
      frameUrl: 'http://127.0.0.2:41002/',
    },
  ]
  const lease = resolver(fake.bridge)
  const first = lease.resolve(target('http://127.0.0.1:5173/'))
  const second = lease.resolve(target('http://127.0.0.1:8080/'))
  assert.deepEqual(await Promise.all([first, second]), ['http://127.0.0.2:41000/', 'http://127.0.0.2:41002/'])
  assert.deepEqual(fake.order, [
    'request:5173',
    'request:8080',
    'release:fwd-0123456789abcdef',
  ])
  await lease.dispose()
})

test('one resolver per tab keeps one consumer for every lease; tabs differ', async () => {
  const fake = fakeBridge()
  const first = resolver(fake.bridge)
  const second = resolver(fake.bridge)
  await first.resolve(target('http://127.0.0.1:5173/'))
  fake.nextRequest = {
    ok: true,
    record: record({ id: 'fwd-dddddddddddddddd', remotePort: 9000, localPort: 41003 }),
    frameUrl: 'http://127.0.0.2:41003/',
  }
  await second.resolve(target('http://127.0.0.1:9000/'))
  const [firstConsumer, secondConsumer] = fake.requests.map((entry) => entry.consumer)
  assert.match(String(firstConsumer), FORWARD_CONSUMER_PATTERN)
  assert.match(String(secondConsumer), FORWARD_CONSUMER_PATTERN)
  assert.notEqual(firstConsumer, secondConsumer, 'a second tab occurrence mints its own consumer')
  // The same tab keeps its consumer identity across record changes.
  fake.nextRequest = {
    ok: true,
    record: record({ id: 'fwd-eeeeeeeeeeeeeeee', remotePort: 9100, localPort: 41004 }),
    frameUrl: 'http://127.0.0.2:41004/',
  }
  await first.resolve(target('http://127.0.0.1:9100/'))
  assert.equal(fake.requests[2].consumer, firstConsumer)
  await first.dispose()
  await second.dispose()
})
