/**
 * ForwardFrameResolver — the carrier's ONLY behavior fork diff: mapping a logical
 * Browser target onto the native guest target (design 28 v3 §2.10/§3).
 *
 * Local / non-loopback targets resolve to the direct URL. An SSH source's remote
 * loopback target attaches the per-tab SSH forward lease
 * (`BrowserForwardController` + `forward-bridge.ts`) and answers a forward
 * recordRef — main loads the alias itself, the bar/history keep the logical URL,
 * and the external exit uses the composed alias URL. A refused attach yields
 * `undefined` (upstream failure bar). Leaving the target / disposing releases the
 * consumer.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createForwardFrameResolver } from '../../src/client/browser/ForwardFrameResolver.ts'
import type { BrowserTarget } from '../../src/client/browser/url.ts'
import type { BrowserForwardBridge, ForwardRequestResult } from '../../src/shared/forward-bridge.ts'
import { FORWARD_CONSUMER_PATTERN } from '../../src/shared/forward-bridge.ts'
import { parseBrowserSource } from '../../src/shared/source.ts'

const FINGERPRINT = 'a'.repeat(64)
const DSH = parseBrowserSource('dsh-alpha', 'ssh')!
const LOCAL = parseBrowserSource('local', 'local')!

function target(url: string): BrowserTarget {
  return { kind: url.startsWith('https:') ? 'https' : 'http', url, title: new URL(url).hostname }
}

function boundRecord(port: number): ForwardRequestResult {
  return {
    ok: true,
    record: {
      id: 'fwd-0123456789abcdef', remotePort: port, localPort: 41000, scheme: 'http',
      aliasHost: '127.0.0.9', state: 'bound', stale: false,
    },
    frameUrl: 'http://127.0.0.9:41000/',
  }
}

/** Fake forward bridge that records every call. */
function fakeBridge(answer?: (port: number) => ForwardRequestResult) {
  const calls: { request: unknown[]; release: unknown[] } = { request: [], release: [] }
  const bridge: BrowserForwardBridge = {
    async request(input) { calls.request.push(input); return answer?.(input.port) ?? boundRecord(input.port) },
    async release(input) { calls.release.push(input); return { ok: true } },
    async list() { return { ok: true, records: [] } },
    async openInBrowser() { return { ok: true } },
  }
  return { bridge, calls }
}

test('local source never forwards: every target resolves direct', async () => {
  const { bridge, calls } = fakeBridge()
  const resolver = createForwardFrameResolver({ source: LOCAL, sourceFingerprint: 'local', bridge })
  assert.deepEqual(await resolver.resolve(target('http://127.0.0.1:3000/a?b=1')), { kind: 'direct', url: 'http://127.0.0.1:3000/a?b=1' })
  assert.deepEqual(await resolver.resolve(target('https://example.com/x')), { kind: 'direct', url: 'https://example.com/x' })
  assert.equal(calls.request.length, 0)
  await resolver.dispose()
})

test('ssh source: remote loopback attaches the lease and answers a forward recordRef', async () => {
  const { bridge, calls } = fakeBridge()
  const resolver = createForwardFrameResolver({ source: DSH, sourceFingerprint: FINGERPRINT, bridge })
  const ref = await resolver.resolve(target('http://127.0.0.1:8080/ui?tab=2'))
  assert.deepEqual(ref, {
    kind: 'forward',
    recordId: 'fwd-0123456789abcdef',
    path: '/ui?tab=2',
    externalUrl: 'http://127.0.0.9:41000/ui?tab=2',
  })
  assert.equal(calls.request.length, 1)
  const request = calls.request[0] as { port: number; scheme: string; path: string; consumer?: string; sourceId: string }
  assert.equal(request.port, 8080)
  assert.equal(request.scheme, 'http')
  assert.equal(request.path, '/ui?tab=2')
  assert.equal(request.sourceId, 'dsh-alpha')
  assert.match(request.consumer ?? '', FORWARD_CONSUMER_PATTERN)
  await resolver.dispose()
  assert.equal(calls.release.length, 1)
})

test('ssh source: localhost is the same remote loopback target', async () => {
  const { bridge, calls } = fakeBridge()
  const resolver = createForwardFrameResolver({ source: DSH, sourceFingerprint: FINGERPRINT, bridge })
  const ref = await resolver.resolve(target('https://localhost:9443/'))
  assert.equal(ref?.kind, 'forward')
  assert.equal((calls.request[0] as { port: number }).port, 9443)
  assert.equal((calls.request[0] as { scheme: string }).scheme, 'https')
  await resolver.dispose()
})

test('ssh source: a non-loopback host stays direct', async () => {
  const { bridge, calls } = fakeBridge()
  const resolver = createForwardFrameResolver({ source: DSH, sourceFingerprint: FINGERPRINT, bridge })
  assert.deepEqual(await resolver.resolve(target('https://dsh.example.com/app')), { kind: 'direct', url: 'https://dsh.example.com/app' })
  assert.equal(calls.request.length, 0)
  await resolver.dispose()
})

test('a refused attach yields undefined (upstream failure bar) and no recordRef', async () => {
  const { bridge } = fakeBridge(() => ({ ok: false, code: 'limit' }))
  const resolver = createForwardFrameResolver({ source: DSH, sourceFingerprint: FINGERPRINT, bridge })
  assert.equal(await resolver.resolve(target('http://127.0.0.1:5173/')), undefined)
  await resolver.dispose()
})

test('a page without the forward bridge leaves remote loopback unresolved', async () => {
  const resolver = createForwardFrameResolver({ source: DSH, sourceFingerprint: FINGERPRINT, bridge: null })
  assert.equal(await resolver.resolve(target('http://127.0.0.1:5173/')), undefined)
  await resolver.dispose()
})

test('leaving a forwarded target releases that consumer before the direct load', async () => {
  const { bridge, calls } = fakeBridge()
  const resolver = createForwardFrameResolver({ source: DSH, sourceFingerprint: FINGERPRINT, bridge })
  assert.equal((await resolver.resolve(target('http://127.0.0.1:8080/')))?.kind, 'forward')
  assert.deepEqual(await resolver.resolve(target('https://example.com/')), { kind: 'direct', url: 'https://example.com/' })
  assert.equal(calls.release.length, 1)
  await resolver.dispose()
  assert.equal(calls.release.length, 1)
})

test('D6: a may-forward source answers IPv6 loopback with the failure bar, never direct', async () => {
  const { bridge, calls } = fakeBridge()
  const resolver = createForwardFrameResolver({ source: DSH, sourceFingerprint: FINGERPRINT, bridge })
  // Every expanded ::1 spelling normalizes to [::1]; the mapped 127.0.0.1 form
  // is [::ffff:7f00:1]. None is a forward target and none may load THIS machine's
  // loopback directly.
  for (const url of ['http://[::1]:8080/', 'http://[0:0:0:0:0:0:0:1]/', 'http://[::ffff:127.0.0.1]:8080/']) {
    assert.equal(await resolver.resolve(target(url)), undefined, url + ' must not resolve direct')
  }
  assert.equal(calls.request.length, 0, 'an IPv6 loopback is not a forward target either')
  await resolver.dispose()
})

test('D6: a local source still loads its own IPv6 loopback directly', async () => {
  const resolver = createForwardFrameResolver({ source: LOCAL, sourceFingerprint: 'local', bridge: null })
  assert.deepEqual(await resolver.resolve(target('http://[::1]:3000/a')), { kind: 'direct', url: 'http://[::1]:3000/a' })
  await resolver.dispose()
})

test('MA1: forward path/query are encoded into the Swift normalizePath character set', async () => {
  const { bridge, calls } = fakeBridge()
  const resolver = createForwardFrameResolver({ source: DSH, sourceFingerprint: FINGERPRINT, bridge })
  // Swift source of truth = macos/Sources/DSHChamber/BrowserGuestPolicy.swift
  // normalizePath / isValidPercentEncodedComponent (D3): accepted set =
  // [A-Za-z0-9] + -._~!$&'()*+,;=:@/ (query also allows "?") with "%" only as a
  // strict %HH escape. The WHATWG URL parser leaves [ ] | ^ { } and friends
  // literal, so the renderer must re-encode them or main rejects invalidPayload.
  const cases: readonly [string, string][] = [
    ['http://127.0.0.1:8080/a[b]/c', '/a%5Bb%5D/c'],
    ['http://127.0.0.1:8080/a|b', '/a%7Cb'],
    ['http://127.0.0.1:8080/x?q=a^{b}', '/x?q=a%5E%7Bb%7D'],
    ['http://127.0.0.1:8080/a=b?c=d', '/a=b?c=d'],
    ['http://127.0.0.1:8080/100%', '/100%25'],
    ['http://127.0.0.1:8080/a%20b', '/a%20b'],
    ['http://127.0.0.1:8080/a?q=%zz', '/a?q=%25zz'],
  ]
  for (const [url] of cases) await resolver.resolve(target(url))
  assert.deepEqual(calls.request.map((request) => (request as { path: string }).path), cases.map(([, expected]) => expected))
  await resolver.dispose()
})

test('MA3: resolutions are serialized per tab occurrence (attach-first ordering)', async () => {
  const events: string[] = []
  let openFirst: (() => void) | undefined
  const bridge: BrowserForwardBridge = {
    async request(input) {
      events.push('request:' + String(input.port))
      if (input.port === 7001) await new Promise<void>((resolve) => { openFirst = resolve })
      return boundRecord(input.port)
    },
    async release() { events.push('release'); return { ok: true } },
    async list() { return { ok: true, records: [] } },
    async openInBrowser() { return { ok: true } },
  }
  const resolver = createForwardFrameResolver({ source: DSH, sourceFingerprint: FINGERPRINT, bridge })
  const first = resolver.resolve(target('http://127.0.0.1:7001/a'))
  const second = resolver.resolve(target('http://127.0.0.1:7002/b'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['request:7001'], 'the second resolution waits for the first to settle')
  assert.notEqual(openFirst, undefined)
  const open = openFirst as () => void
  open()
  const [firstRef, secondRef] = await Promise.all([first, second])
  assert.equal(firstRef?.kind, 'forward')
  assert.equal(secondRef?.kind, 'forward')
  assert.deepEqual(events.slice(0, 2), ['request:7001', 'request:7002'], 'requests never overlap')
  await resolver.dispose()
})

test('MA3: one consumer identity per tab occurrence, distinct across tabs', async () => {
  const { bridge, calls } = fakeBridge()
  const first = createForwardFrameResolver({ source: DSH, sourceFingerprint: FINGERPRINT, bridge })
  const second = createForwardFrameResolver({ source: DSH, sourceFingerprint: FINGERPRINT, bridge })
  await first.resolve(target('http://127.0.0.1:7001/a'))
  await first.resolve(target('http://127.0.0.1:7002/b'))
  await second.resolve(target('http://127.0.0.1:7003/c'))
  const consumers = calls.request.map((request) => (request as { consumer?: string }).consumer ?? '')
  assert.equal(consumers.length, 3)
  assert.equal(consumers[0], consumers[1], 'the same occurrence renews with its own consumer')
  assert.notEqual(consumers[0], consumers[2], 'another tab occurrence mints its own consumer')
  for (const consumer of consumers) assert.match(consumer, FORWARD_CONSUMER_PATTERN)
  await first.dispose()
  await second.dispose()
})

test('MA3: resolver.dispose is idempotent and refuses later resolutions', async () => {
  const { bridge, calls } = fakeBridge()
  const resolver = createForwardFrameResolver({ source: DSH, sourceFingerprint: FINGERPRINT, bridge })
  assert.equal((await resolver.resolve(target('http://127.0.0.1:8080/')))?.kind, 'forward')
  await resolver.dispose()
  await resolver.dispose()
  assert.equal(calls.release.length, 1, 'the held record is released exactly once')
  assert.equal(await resolver.resolve(target('http://127.0.0.1:8080/')), undefined, 'a disposed resolver never attaches again')
  assert.equal(calls.request.length, 1)
})

test('D6 tail-dot: localhost. and 127.0.0.1. are the remote loopback target', async () => {
  const { bridge, calls } = fakeBridge()
  const resolver = createForwardFrameResolver({ source: DSH, sourceFingerprint: FINGERPRINT, bridge })
  // Swift canonicalHost strips trailing dots before the loopback decision, so the
  // renderer must normalize the FQDN root spelling too, or the SSH forward leg
  // would be skipped and the remote loopback would load as a direct URL.
  assert.equal((await resolver.resolve(target('http://localhost.:3000/x')))?.kind, 'forward')
  assert.equal((await resolver.resolve(target('http://127.0.0.1.:8080/')))?.kind, 'forward')
  assert.deepEqual(calls.request.map((request) => (request as { port: number }).port), [3000, 8080])
  await resolver.dispose()
})

test('D6 tail-dot: a local source still loads its normalized loopback directly', async () => {
  const resolver = createForwardFrameResolver({ source: LOCAL, sourceFingerprint: 'local', bridge: null })
  assert.deepEqual(await resolver.resolve(target('http://localhost.:3000/a')),
    { kind: 'direct', url: 'http://localhost.:3000/a' })
  await resolver.dispose()
})
